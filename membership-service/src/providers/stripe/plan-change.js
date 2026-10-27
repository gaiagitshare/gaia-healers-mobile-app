/**
 * Plan changes on Stripe (owner decision 2026-10-26; docs/membership/INTEGRATIONS.md §6).
 * Exported through adapter.js. Never reads process.env: the Stripe client, the
 * environment (for the launch gate) and the clock are passed in.
 *
 *   previewPlanChange    what the member pays now and when the change takes effect.
 *                        Upgrade: Stripe's invoice preview (always_invoice) -> 2 requests
 *                        (GET subscription, POST /v1/invoices/create_preview).
 *                        Period-end change: no Stripe call (nothing is charged now).
 *   changePlan           upgrade: 2 requests (GET subscription, POST subscription item
 *                        update with always_invoice + pending_if_incomplete); nothing is
 *                        granted here, the verified invoice.paid webhook applies it.
 *                        Downgrade / interval switch: 3 requests (GET subscription,
 *                        POST subscription_schedules from_subscription, POST its phases:
 *                        current price until the period end, then the new price, no
 *                        proration, end_behavior=release).
 *   cancelScheduledChange 1 request (POST subscription_schedules/:id/release): the
 *                        subscription stays on the current price, nothing else changes.
 *
 * Why a Stripe subscription schedule (and not a Gaia job at renewal): Stripe switches
 * the price atomically with the renewal invoice, so no Gaia timer has to win a race
 * against Stripe's invoice creation, and an interval switch keeps its billing date (an
 * immediate price update to another interval would reset the billing cycle and charge
 * at once). The renewal's customer.subscription.updated webhook, already handled in
 * order and idempotently, applies the change.
 *
 * Every Stripe POST carries a key derived from the Gaia change row (gaia-change-<id>…),
 * so a member's retry under the same Idempotency-Key resumes the same Stripe request.
 */
import crypto from 'node:crypto';
import { withTransaction } from '../../db.js';
import { audit } from '../../audit.js';
import { fail, MembershipError } from '../../errors.js';
import { planChangeEligibility } from '../../billing-guard.js';
import { newBillingAllowed } from '../../launch.js';
import { classifyChange, pendingChangeFor, changeView, planNames, subscriptionEvent, endChangeInTx, PENDING_STATUSES } from '../../plan-changes.js';

const enc = encodeURIComponent;
const PREVIEW_MAX_AGE_S = 15 * 60;
const ABANDONED_AFTER_MS = 24 * 3600 * 1000;
const sec = (d) => Math.floor(d.getTime() / 1000);
const ts = (s) => (s == null ? null : new Date(Number(s) * 1000));
const idOf = (x) => (x && typeof x === 'object' ? x.id : x);
const checkKey = (k) => { if (typeof k !== 'string' || k.length < 8 || k.length > 200) fail('INVALID_INPUT', 'idempotencyKey must be 8-200 characters'); return k; };
const httpsOrNull = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.toString() : null; } catch { return null; } };

/** The subscription (with its plan) and the target price, both checked. */
async function load(db, personId, subscriptionId, { planKey, interval }) {
  if (!['month', 'year'].includes(interval)) fail('INVALID_INPUT', 'interval must be month or year');
  const sub = (await db.query(
    `SELECT s.*, v.plan_id, v.monthly_coin_grant, p.key AS plan_key, p.name AS plan_name, p.rank, p.owner_type
       FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
      WHERE s.id = $1 AND s.person_id = $2`, [subscriptionId, personId])).rows[0];
  if (!sub) fail('NOT_FOUND', 'subscription not found');
  const target = (await db.query(
    `SELECT pvp.id AS price_id, pvp.amount_cents, pvp.currency, v.id AS plan_version_id, v.plan_id, p.key AS plan_key, p.name AS plan_name, p.rank
       FROM plans p JOIN LATERAL (SELECT * FROM plan_versions WHERE plan_id = p.id AND status = 'published' AND NOT is_legacy ORDER BY version DESC LIMIT 1) v ON true
       JOIN plan_version_prices pvp ON pvp.plan_version_id = v.id AND pvp.billing_interval = $2
      WHERE p.key = $1 AND p.owner_type = 'gaia' AND p.status = 'active' AND pvp.amount_cents > 0`, [String(planKey || ''), interval])).rows[0];
  if (!target) fail('NOT_FOUND', 'plan not on sale');
  return { sub, target };
}

/**
 * Local rules, in order: only Gaia-owned Stripe subscriptions; legacy -> migration;
 * the duplicate-billing guard; the subscription must be active, not cancelling, with
 * no pending change; then the launch gate. Returns { status: 'ok', kind, timing } or a status answer.
 */
async function eligibility(pool, personId, sub, target, { env, guard, now }) {
  if (sub.owner_type !== 'gaia') return { status: 'not_changeable', reason: 'not_a_gaia_plan' };
  if (sub.source === 'legacy_import') return { status: 'migration_required', reasons: ['legacy_subscription'] };
  if (sub.provider !== 'stripe' || !sub.provider_subscription_id) return { status: 'not_changeable', reason: 'not_billed_by_stripe' };
  const guardAnswer = await planChangeEligibility(pool, personId, sub, { now, ...guard });
  if (guardAnswer.status !== 'ok') return guardAnswer;
  if (sub.status !== 'active') return { status: 'not_changeable', reason: 'subscription_not_active' };
  if (sub.cancel_at) return { status: 'not_changeable', reason: 'cancel_scheduled' };
  const kind = classifyChange({ planId: sub.plan_id, interval: sub.billing_interval, rank: sub.rank }, { planId: target.plan_id, interval: target.interval, rank: target.rank });
  if (!kind) return { status: 'already_subscribed', subscriptionId: sub.id };
  const pending = await pendingChangeFor(pool, sub.id);
  if (pending) return { status: 'change_pending', changeId: pending.id };
  const gate = await newBillingAllowed(pool, personId, { env, purpose: 'plan_change' });
  if (!gate.allowed) return { status: 'not_available', reason: gate.reason, stage: gate.stage };
  return { status: 'ok', ...kind };
}

/** The Stripe subscription must be the one Gaia recorded, for this person, on the recorded price, with nothing pending. */
async function stripeSubscription(pool, stripe, personId, sub) {
  const s = await stripe.get(`/v1/subscriptions/${enc(sub.provider_subscription_id)}`);
  if (s?.id !== sub.provider_subscription_id) fail('PROVIDER_UNAVAILABLE', 'stripe answered for a different subscription');
  const customer = (await pool.query("SELECT 1 FROM person_identities WHERE person_id = $1 AND platform = 'stripe' AND kind = 'customer' AND external_id = $2", [personId, idOf(s.customer)])).rowCount > 0;
  const items = s.items?.data || [];
  const ref = items.length === 1 ? (await pool.query(
    `SELECT p.plan_version_id, p.billing_interval FROM provider_price_refs r JOIN plan_version_prices p ON p.id = r.plan_version_price_id
      WHERE r.provider = 'stripe' AND r.external_price_id = $1 AND r.livemode = $2`, [idOf(items[0].price), stripe.livemode])).rows[0] : null;
  if (!customer || !ref || ref.plan_version_id !== sub.plan_version_id || ref.billing_interval !== sub.billing_interval) {
    return { answer: { status: 'review_required', reasons: ['stripe_subscription_mismatch'] } };
  }
  if (s.status !== 'active') return { answer: { status: 'not_changeable', reason: 'subscription_not_active' } };
  if (s.cancel_at_period_end || s.cancel_at) return { answer: { status: 'not_changeable', reason: 'cancel_scheduled' } };
  if (s.schedule || s.pending_update) return { answer: { status: 'change_pending', reason: s.schedule ? 'stripe_schedule_exists' : 'stripe_pending_update' } };
  return { s, item: items[0], currentPrice: idOf(items[0].price) };
}

const sides = (sub, target) => ({
  from: { planKey: sub.plan_key, planName: sub.plan_name, interval: sub.billing_interval },
  to: { planKey: target.plan_key, planName: target.plan_name, interval: target.interval, priceCents: target.amount_cents, currency: target.currency },
});

export async function previewPlanChange({ pool, stripe, guard = {}, env = {}, ensurePrice }, personId, subscriptionId, { planKey, interval, now = new Date() } = {}) {
  const { sub, target } = await load(pool, personId, subscriptionId, { planKey, interval });
  target.interval = interval;
  const e = await eligibility(pool, personId, sub, target, { env, guard, now });
  if (e.status !== 'ok') return e;
  const base = { status: 'ok', kind: e.kind, timing: e.timing, subscriptionId: sub.id, ...sides(sub, target) };
  if (e.timing === 'period_end') {
    return { ...base, amountDueNowCents: 0, currency: target.currency, effectiveAt: sub.current_period_end, keepsCurrentUntil: sub.current_period_end };
  }
  const st = await stripeSubscription(pool, stripe, personId, sub);
  if (st.answer) return st.answer;
  const { priceId } = await ensurePrice(target.price_id);
  const prorationDate = sec(now);
  const inv = await stripe.post('/v1/invoices/create_preview', {
    customer: idOf(st.s.customer), subscription: sub.provider_subscription_id,
    subscription_details: { items: [{ id: st.item.id, price: priceId, quantity: 1 }], proration_behavior: 'always_invoice', proration_date: prorationDate },
  }, { idempotencyKey: `gaia-change-preview-${sub.id}-${target.price_id}-${prorationDate}` });
  if (!Number.isSafeInteger(inv?.amount_due) || inv.amount_due < 0) fail('PROVIDER_UNAVAILABLE', 'stripe returned no invoice preview');
  return { ...base, amountDueNowCents: inv.amount_due, currency: String(inv.currency || target.currency).toUpperCase(), effectiveAt: null, prorationDate };
}

const hashOf = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

async function viewOf(db, row) {
  return changeView(row, await planNames(db, [row.to_plan_version_id]));
}

/**
 * Start a plan change. Returns { status: 'ok', outcome: 'payment_required' | 'processing' | 'scheduled', change }
 * or a status answer (migration_required, review_required, not_available, change_pending, ...).
 */
export async function changePlan({ pool, stripe, guard = {}, env = {}, ensurePrice }, personId, subscriptionId, { planKey, interval, prorationDate, idempotencyKey, actor, now = new Date() } = {}) {
  checkKey(idempotencyKey);
  const who = actor || { actorType: 'person', actorId: personId };
  const { sub, target } = await load(pool, personId, subscriptionId, { planKey, interval });
  target.interval = interval;
  const requestHash = hashOf({ planKey: target.plan_key, interval });
  let row = (await pool.query('SELECT * FROM subscription_changes WHERE subscription_id = $1 AND idempotency_key = $2', [sub.id, idempotencyKey])).rows[0];
  if (row && row.request_hash !== requestHash) fail('CONFLICT', 'idempotency key reused for a different plan change');
  if (row && row.status !== 'requested') return { status: row.status === 'failed' ? 'failed' : 'ok', outcome: outcomeOf(row), change: await viewOf(pool, row), replayed: true };

  let st;
  if (!row) {
    // A change whose Stripe step never finished is abandoned after 24 h (an upgrade's pending update has expired by then).
    await pool.query(`UPDATE subscription_changes SET status = 'failed', end_reason = 'abandoned', ended_at = $2, updated_at = $2
                       WHERE subscription_id = $1 AND status = 'requested' AND created_at < $3`, [sub.id, now, new Date(now.getTime() - ABANDONED_AFTER_MS)]);
    const e = await eligibility(pool, personId, sub, target, { env, guard, now });
    if (e.status !== 'ok') return e;
    if (e.timing === 'after_payment' && prorationDate !== undefined && prorationDate !== null) {
      const pd = Number(prorationDate);
      if (!Number.isSafeInteger(pd) || pd > sec(now) + 60) fail('INVALID_INPUT', 'prorationDate must be the preview\'s value');
      if (pd < sec(now) - PREVIEW_MAX_AGE_S) return { status: 'preview_expired' };
    }
    st = await stripeSubscription(pool, stripe, personId, sub);
    if (st.answer) return st.answer;
    await ensurePrice(target.price_id);
    try {
      row = await withTransaction(pool, async (c) => {
        const r = (await c.query(
          `INSERT INTO subscription_changes (subscription_id, person_id, kind, timing, from_plan_version_id, from_interval, to_plan_version_id, to_interval, to_price_id,
                                             idempotency_key, request_hash, requested_by, request_id, created_at, updated_at, effective_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $15) RETURNING *`,
          [sub.id, personId, e.kind, e.timing, sub.plan_version_id, sub.billing_interval, target.plan_version_id, interval, target.price_id,
            idempotencyKey, requestHash, `${who.actorType}:${who.actorId}`, who.requestId || null, now, e.timing === 'period_end' ? sub.current_period_end : null])).rows[0];
        await subscriptionEvent(c, { subscriptionId: sub.id, status: sub.status, reason: 'change_requested', at: now,
          details: { changeId: r.id, kind: e.kind, timing: e.timing, toPlanVersion: target.plan_version_id, interval } });
        await audit(c, { ...who, action: 'subscription.change_requested', entityType: 'subscription_change', entityId: r.id,
          before: { planVersionId: sub.plan_version_id, interval: sub.billing_interval }, after: { planVersionId: target.plan_version_id, interval, kind: e.kind, timing: e.timing },
          reason: e.timing === 'after_payment' ? 'member upgrade: higher tier after the prorated payment' : 'member change at the period end, no proration' });
        return r;
      });
    } catch (err) {
      if (err.code === '23505') return { status: 'change_pending' };
      throw err;
    }
  } else {
    // Resuming our own row (checked when it was created): Stripe may already show this change's
    // schedule or pending update, and the keyed POSTs below replay Stripe's first answer.
    st = await rawSubscription(stripe, sub);
  }

  const { priceId } = await ensurePrice(target.price_id);
  try {
    return row.timing === 'after_payment'
      ? await upgrade(pool, stripe, row, st, priceId, { prorationDate, who, now })
      : await schedule(pool, stripe, row, st, priceId, { who, now });
  } catch (err) {
    // Not connected / network: the row stays `requested` and the same key resumes it. A definite refusal ends it.
    if (err instanceof MembershipError && err.code !== 'PROVIDER_UNAVAILABLE') {
      await withTransaction(pool, (c) => endChangeInTx(c, row, { status: 'failed', reason: 'stripe_refused:' + (err.details?.providerCode || err.code), at: now, actor: who }));
    }
    throw err;
  }
}

async function rawSubscription(stripe, sub) {
  const s = await stripe.get(`/v1/subscriptions/${enc(sub.provider_subscription_id)}`);
  const item = s?.items?.data?.[0];
  if (!item) fail('PROVIDER_UNAVAILABLE', 'stripe returned no subscription item');
  return { s, item, currentPrice: idOf(item.price) };
}

function outcomeOf(row) {
  if (row.status === 'scheduled') return 'scheduled';
  if (row.status === 'pending_payment') return row.payment_required ? 'payment_required' : 'processing';
  return row.status;
}

async function upgrade(pool, stripe, row, st, priceId, { prorationDate, who, now }) {
  const r = await stripe.post(`/v1/subscriptions/${enc(st.s.id)}`, {
    items: [{ id: st.item.id, price: priceId, quantity: 1 }],
    proration_behavior: 'always_invoice', payment_behavior: 'pending_if_incomplete',
    ...(prorationDate ? { proration_date: Number(prorationDate) } : {}),
    expand: ['latest_invoice'],
  }, { idempotencyKey: `gaia-change-${row.id}` });
  if (r?.id !== st.s.id) fail('PROVIDER_UNAVAILABLE', 'stripe answered for a different subscription');
  const inv = typeof r.latest_invoice === 'object' ? r.latest_invoice : null;
  const paymentRequired = Boolean(r.pending_update) || (inv && inv.status !== 'paid');
  const u = await withTransaction(pool, async (c) => {
    const x = (await c.query(`UPDATE subscription_changes SET status = 'pending_payment', provider_invoice_id = $2, amount_due_cents = $3, currency = $4,
                                     payment_required = $5, payment_url = $6, updated_at = $7
                               WHERE id = $1 AND status = 'requested' RETURNING *`,
      [row.id, inv?.id || null, Number.isSafeInteger(inv?.amount_due) ? inv.amount_due : null, inv?.currency ? String(inv.currency).toUpperCase() : null,
        paymentRequired, paymentRequired ? httpsOrNull(inv?.hosted_invoice_url) : null, now])).rows[0];
    if (x) {
      await audit(c, { ...who, action: 'subscription.change_invoiced', entityType: 'subscription_change', entityId: row.id,
        after: { status: 'pending_payment', paymentRequired, invoice: inv?.id || null }, reason: 'prorated upgrade invoiced; tier applied only by the paid-invoice webhook' });
    }
    return x || (await c.query('SELECT * FROM subscription_changes WHERE id = $1', [row.id])).rows[0];
  });
  return { status: 'ok', outcome: outcomeOf(u), change: await viewOf(pool, u) };
}

async function schedule(pool, stripe, row, st, priceId, { who, now }) {
  const created = await stripe.post('/v1/subscription_schedules', { from_subscription: st.s.id }, { idempotencyKey: `gaia-change-${row.id}-schedule` });
  const ph0 = created?.phases?.[0];
  if (!created?.id || !ph0?.start_date || !ph0?.end_date) fail('PROVIDER_UNAVAILABLE', 'stripe returned no subscription schedule');
  await pool.query('UPDATE subscription_changes SET provider_schedule_id = $2, updated_at = $3 WHERE id = $1 AND provider_schedule_id IS NULL', [row.id, created.id, now]);
  const curItems = (ph0.items || []).map((i) => ({ price: idOf(i.price), quantity: i.quantity ?? 1 }));
  const upd = await stripe.post(`/v1/subscription_schedules/${enc(created.id)}`, {
    end_behavior: 'release', proration_behavior: 'none',
    phases: [
      { items: curItems.length ? curItems : [{ price: st.currentPrice, quantity: 1 }], start_date: ph0.start_date, end_date: ph0.end_date, proration_behavior: 'none' },
      { items: [{ price: priceId, quantity: 1 }], iterations: 1, proration_behavior: 'none' },
    ],
    metadata: { gaia_change_id: row.id, gaia_subscription_id: row.subscription_id },
  }, { idempotencyKey: `gaia-change-${row.id}-phases` });
  const effective = ts(upd?.phases?.[0]?.end_date ?? ph0.end_date);
  const nextPrice = idOf(upd?.phases?.[1]?.items?.[0]?.price);
  if (nextPrice !== priceId) fail('PROVIDER_UNAVAILABLE', 'stripe did not record the scheduled price');
  const u = await withTransaction(pool, async (c) => {
    const x = (await c.query(`UPDATE subscription_changes SET status = 'scheduled', effective_at = $2, amount_due_cents = 0, provider_schedule_id = $3, updated_at = $4
                               WHERE id = $1 AND status = 'requested' RETURNING *`, [row.id, effective, created.id, now])).rows[0];
    if (x) {
      await subscriptionEvent(c, { subscriptionId: row.subscription_id, status: 'active', reason: 'change_scheduled', at: now,
        details: { changeId: row.id, kind: row.kind, effectiveAt: effective } });
      await audit(c, { ...who, action: 'subscription.change_scheduled', entityType: 'subscription_change', entityId: row.id,
        after: { status: 'scheduled', effectiveAt: effective, toPlanVersionId: row.to_plan_version_id, interval: row.to_interval }, reason: 'takes effect at the period end; no proration, no refund' });
    }
    return x || (await c.query('SELECT * FROM subscription_changes WHERE id = $1', [row.id])).rows[0];
  });
  return { status: 'ok', outcome: outcomeOf(u), change: await viewOf(pool, u) };
}

/** "Keep my current plan": release the schedule; the member stays on the current price. Replays under the same key. */
export async function cancelScheduledChange({ pool, stripe }, personId, subscriptionId, { idempotencyKey, actor, now = new Date() } = {}) {
  checkKey(idempotencyKey);
  const who = actor || { actorType: 'person', actorId: personId };
  const sub = (await pool.query('SELECT id, status FROM subscriptions WHERE id = $1 AND person_id = $2', [subscriptionId, personId])).rows[0];
  if (!sub) fail('NOT_FOUND', 'subscription not found');
  const done = (await pool.query("SELECT * FROM subscription_changes WHERE subscription_id = $1 AND cancel_key = $2", [sub.id, idempotencyKey])).rows[0];
  if (done && done.status === 'canceled') return { status: 'ok', change: await viewOf(pool, done), replayed: true };
  const ch = (await pool.query("SELECT * FROM subscription_changes WHERE subscription_id = $1 AND status = ANY($2)", [sub.id, PENDING_STATUSES])).rows[0];
  if (!ch) return { status: 'no_pending_change' };
  if (ch.status !== 'scheduled') return { status: 'not_cancellable', reason: ch.status === 'pending_payment' ? 'awaiting_payment_expires_on_its_own' : 'change_in_progress', change: await viewOf(pool, ch) };
  await pool.query('UPDATE subscription_changes SET cancel_key = COALESCE(cancel_key, $2) WHERE id = $1', [ch.id, idempotencyKey]);
  const r = await stripe.post(`/v1/subscription_schedules/${enc(ch.provider_schedule_id)}/release`, {}, { idempotencyKey: `gaia-change-${ch.id}-release` });
  if (r?.id !== ch.provider_schedule_id || r.status !== 'released') fail('PROVIDER_UNAVAILABLE', 'stripe did not release the schedule');
  await withTransaction(pool, (c) => endChangeInTx(c, ch, { status: 'canceled', reason: 'member_kept_current_plan', at: now, actor: who }));
  const after = (await pool.query('SELECT * FROM subscription_changes WHERE id = $1', [ch.id])).rows[0];
  return { status: 'ok', change: await viewOf(pool, after) };
}
