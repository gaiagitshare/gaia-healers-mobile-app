/**
 * Plan changes: the Gaia side (owner decision 2026-10-26, docs/membership/INTEGRATIONS.md §6).
 *
 *   upgrade (higher tier, same interval)      timing after_payment: Stripe invoices the
 *       prorated difference at once (always_invoice, pending_if_incomplete). The higher
 *       tier, its entitlements and the coin allowance difference are applied ONLY by the
 *       verified invoice.paid webhook for that invoice (applyUpgradeInTx), never by the
 *       API response. A failed or 3DS payment leaves the member on the current tier;
 *       Stripe's pending update expires on its own (pending_update_expired).
 *   downgrade, annual <-> monthly switch      timing period_end: a Stripe subscription
 *       schedule switches the price at the renewal (no proration, no refund). The member
 *       keeps the paid tier until then; the customer.subscription.updated webhook of the
 *       renewal applies it (markScheduledAppliedInTx). Cancelling releases the schedule.
 *
 * One pending change per subscription (subscription_changes_one_pending). Every step
 * writes a subscription_events row and an audit row with a reason. The Stripe calls
 * live in providers/stripe/plan-change.js; this module only touches the database.
 */
import { audit } from './audit.js';
import { creditUpgradeAllowance } from './coins.js';
import { cycleStart } from './jobs/allowance.js';

export const PENDING_STATUSES = Object.freeze(['requested', 'pending_payment', 'scheduled']);
const PROVIDER = { actorType: 'provider', actorId: 'stripe' };

/**
 * What kind of change is this? Decided on the server only, from the catalogue ranks.
 * Any interval switch happens at the period end (even with a tier change), a higher
 * tier on the same interval is an upgrade, anything else a downgrade. null: no change.
 */
export function classifyChange(from, to) {
  if (from.planId === to.planId && from.interval === to.interval) return null;
  if (from.interval !== to.interval) return { kind: 'interval_switch', timing: 'period_end' };
  if (to.rank > from.rank) return { kind: 'upgrade', timing: 'after_payment' };
  return { kind: 'downgrade', timing: 'period_end' };
}

export async function pendingChangeFor(c, subscriptionId) {
  return (await c.query(`SELECT * FROM subscription_changes WHERE subscription_id = $1 AND status = ANY($2)`, [subscriptionId, PENDING_STATUSES])).rows[0] || null;
}

/** Member-safe view of a change (no provider ids). */
export function changeView(row, plans = {}) {
  if (!row) return null;
  const to = plans[row.to_plan_version_id] || {};
  return {
    id: row.id, kind: row.kind, timing: row.timing, status: row.status,
    toPlan: to.key || null, toPlanName: to.name || null, toInterval: row.to_interval,
    effectiveAt: row.effective_at, amountDueCents: row.amount_due_cents, currency: row.currency,
    paymentRequired: row.status === 'pending_payment' && row.payment_required === true,
    paymentUrl: row.status === 'pending_payment' && row.payment_required === true ? row.payment_url : null,
    canCancel: row.status === 'scheduled',
    createdAt: row.created_at, appliedAt: row.applied_at, endedAt: row.ended_at, endReason: row.end_reason,
  };
}

/** Plan key/name per plan version id, for changeView. */
export async function planNames(db, versionIds) {
  if (!versionIds.length) return {};
  const r = await db.query('SELECT v.id, p.key, p.name FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE v.id = ANY($1)', [versionIds]);
  return Object.fromEntries(r.rows.map((x) => [x.id, { key: x.key, name: x.name }]));
}

export async function subscriptionEvent(c, { subscriptionId, status, reason, details, webhookEventId = null, at = new Date() }) {
  await c.query('INSERT INTO subscription_events (subscription_id, from_status, to_status, reason, webhook_event_id, details, occurred_at) VALUES ($1, $2, $2, $3, $4, $5, $6)',
    [subscriptionId, status, reason, webhookEventId, JSON.stringify(details || {}), at]);
}

/** End a pending change (canceled / expired / failed), with history and audit. Returns false if it was not pending any more. */
export async function endChangeInTx(c, change, { status, reason, at = new Date(), actor = PROVIDER, webhookEventId = null }) {
  const u = await c.query(`UPDATE subscription_changes SET status = $2, end_reason = $3, ended_at = $4, updated_at = $4
                            WHERE id = $1 AND status = ANY($5) RETURNING *`, [change.id, status, reason, at, PENDING_STATUSES]);
  if (!u.rowCount) return false;
  const sub = (await c.query('SELECT status FROM subscriptions WHERE id = $1', [change.subscription_id])).rows[0];
  await subscriptionEvent(c, { subscriptionId: change.subscription_id, status: sub.status, reason: 'change_' + status, webhookEventId, at,
    details: { changeId: change.id, kind: change.kind, endReason: reason } });
  await audit(c, { ...actor, action: 'subscription.change_' + status, entityType: 'subscription_change', entityId: change.id,
    before: { status: change.status }, after: { status, endReason: reason }, reason });
  return true;
}

/**
 * The prorated upgrade invoice is paid (verified invoice.paid webhook): move the
 * subscription to the higher plan, credit this cycle's allowance difference (only
 * when this cycle's allowance was already granted from the old plan; otherwise the
 * monthly job grants the new plan's full allowance), and mark the change applied.
 * Idempotent: a change that is no longer pending is left alone.
 */
export async function applyUpgradeInTx(c, change, { at, webhookEventId = null }) {
  const s = (await c.query('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [change.subscription_id])).rows[0];
  const cur = (await c.query('SELECT status FROM subscription_changes WHERE id = $1 FOR UPDATE', [change.id])).rows[0];
  if (!cur || !['requested', 'pending_payment'].includes(cur.status)) return { applied: false };
  if (s.plan_version_id !== change.to_plan_version_id || s.billing_interval !== change.to_interval) {
    await c.query(`UPDATE subscriptions SET plan_version_id = $2, billing_interval = $3, updated_at = $4,
                          provider_state_at = GREATEST(COALESCE(provider_state_at, $4), $4) WHERE id = $1`,
      [s.id, change.to_plan_version_id, change.to_interval, at]);
    await subscriptionEvent(c, { subscriptionId: s.id, status: s.status, reason: 'plan_changed', webhookEventId, at,
      details: { changeId: change.id, kind: change.kind, fromPlanVersion: s.plan_version_id, toPlanVersion: change.to_plan_version_id, interval: change.to_interval } });
  }
  const grants = (await c.query('SELECT id, monthly_coin_grant FROM plan_versions WHERE id = ANY($1)', [[change.from_plan_version_id, change.to_plan_version_id]])).rows;
  const g = (id) => grants.find((x) => x.id === id)?.monthly_coin_grant || 0;
  const diff = g(change.to_plan_version_id) - g(change.from_plan_version_id);
  let coins = 0;
  if (diff > 0) {
    const start = cycleStart(s.current_period_start || s.created_at, at);
    const grantedThisCycle = (await c.query(`SELECT 1 FROM coin_operations o JOIN coin_wallets w ON w.id = o.wallet_id
                                               WHERE w.person_id = $1 AND o.idempotency_key = $2`, [s.person_id, `grant:${s.id}:${start.toISOString()}`])).rowCount > 0;
    if (grantedThisCycle) {
      await creditUpgradeAllowance(c, { personId: s.person_id, coins: diff, changeId: change.id, actor: PROVIDER });
      coins = diff;
    }
  }
  await c.query(`UPDATE subscription_changes SET status = 'applied', paid_at = COALESCE(paid_at, $2), applied_at = $2, coins_granted = $3, updated_at = $2 WHERE id = $1`,
    [change.id, at, coins]);
  await audit(c, { ...PROVIDER, action: 'subscription.change_applied', entityType: 'subscription_change', entityId: change.id,
    before: { status: cur.status, planVersionId: s.plan_version_id }, after: { status: 'applied', planVersionId: change.to_plan_version_id, interval: change.to_interval, coinsGranted: coins },
    reason: 'upgrade invoice paid (verified webhook)' });
  return { applied: true, coins };
}

/** The renewal moved the Stripe item to the scheduled price: the scheduled change is applied. */
export async function markScheduledAppliedInTx(c, change, { at, webhookEventId = null }) {
  const u = await c.query(`UPDATE subscription_changes SET status = 'applied', applied_at = $2, updated_at = $2 WHERE id = $1 AND status = 'scheduled' RETURNING id`, [change.id, at]);
  if (!u.rowCount) return false;
  await audit(c, { ...PROVIDER, action: 'subscription.change_applied', entityType: 'subscription_change', entityId: change.id,
    before: { status: 'scheduled' }, after: { status: 'applied', planVersionId: change.to_plan_version_id, interval: change.to_interval },
    reason: 'scheduled change reached its period end (verified webhook)' });
  return true;
}

/** The pending upgrade for this invoice, if any: by invoice id, else (id not recorded yet) by the target Stripe price on its lines. */
export async function upgradeForInvoice(c, subscriptionId, invoiceId, linePriceIds, livemode) {
  const ch = (await c.query(`SELECT * FROM subscription_changes WHERE subscription_id = $1 AND timing = 'after_payment' AND status IN ('requested', 'pending_payment')`, [subscriptionId])).rows[0];
  if (!ch) return null;
  if (ch.provider_invoice_id) return ch.provider_invoice_id === invoiceId ? ch : null;
  const target = (await c.query(`SELECT external_price_id FROM provider_price_refs WHERE plan_version_price_id = $1 AND provider = 'stripe' AND livemode = $2`, [ch.to_price_id, Boolean(livemode)])).rows[0]?.external_price_id;
  return target && linePriceIds.includes(target) ? ch : null;
}
