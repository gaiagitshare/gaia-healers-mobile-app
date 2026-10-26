/**
 * Subscription lifecycle (spec §10, §17).
 *
 *   incomplete -> trialing | active | expired | canceled     (no paid access before payment is confirmed)
 *   trialing   -> active | past_due | paused | canceled | expired
 *   active     -> active (renewal) | past_due | paused | canceled | expired
 *   past_due   -> active | past_due | paused | canceled | expired   (access only until grace_until)
 *   paused     -> active | canceled | expired
 *   canceled, expired: terminal
 *
 * Every change writes a subscription_events row; history is never rewritten.
 * Provider-driven changes carry the provider's own timestamp and an older one
 * than the newest applied is ignored (duplicate / out-of-order webhooks).
 */
import { withTransaction } from './db.js';
import { audit } from './audit.js';
import { fail } from './errors.js';

export const TRANSITIONS = Object.freeze({
  incomplete: ['trialing', 'active', 'expired', 'canceled'],
  trialing: ['active', 'past_due', 'paused', 'canceled', 'expired'],
  active: ['active', 'past_due', 'paused', 'canceled', 'expired'],
  past_due: ['active', 'past_due', 'paused', 'canceled', 'expired'],
  paused: ['active', 'canceled', 'expired'],
  canceled: [],
  expired: [],
});

export const DEFAULT_GRACE_DAYS = 7;   // configurable per call; spec says "configurable grace period"
/** An `active` subscription past its period end (renewal never recorded) keeps access this long, then not. */
export const PERIOD_END_LEEWAY_MS = 3 * 86400000;
const TERMINAL = new Set(['canceled', 'expired']);

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/** Does this subscription row grant access at `now`? Pure; used by the entitlement service. */
export function grantsAccess(s, now = new Date()) {
  const t = now.getTime();
  if (s.cancel_at && new Date(s.cancel_at).getTime() <= t) return false;
  if (s.status === 'active') return !s.current_period_end || new Date(s.current_period_end).getTime() + PERIOD_END_LEEWAY_MS > t;
  if (s.status === 'trialing') return Boolean(s.trial_end) && new Date(s.trial_end).getTime() > t;
  if (s.status === 'past_due') return Boolean(s.grace_until) && new Date(s.grace_until).getTime() > t;
  return false;
}

export async function createSubscription(pool, {
  personId, planVersionId, interval, provider = 'simulated', providerSubscriptionId = null,
  status = 'incomplete', source = 'new', trialEnd = null, periodStart = null, periodEnd = null, providerStateAt = null,
}, actor) {
  return withTransaction(pool, (c) => createSubscriptionInTx(c, {
    personId, planVersionId, interval, provider, providerSubscriptionId, status, source, trialEnd, periodStart, periodEnd, providerStateAt }, actor));
}

/** Same as createSubscription, inside the caller's transaction (webhook processor). */
export async function createSubscriptionInTx(c, {
  personId, planVersionId, interval, provider = 'simulated', providerSubscriptionId = null,
  status = 'incomplete', source = 'new', trialEnd = null, periodStart = null, periodEnd = null, providerStateAt = null,
}, actor = { actorType: 'provider', actorId: provider }, { observedFromProvider = false } = {}) {
  // Gaia-created subscriptions start incomplete / trialing / active. One first seen
  // at a provider is recorded in whatever state the provider reports.
  const allowed = observedFromProvider ? Object.keys(TRANSITIONS) : ['incomplete', 'trialing', 'active'];
  if (!allowed.includes(status)) fail('INVALID_INPUT', 'a subscription starts incomplete, trialing or active');
  {
    const v = (await c.query('SELECT status, is_legacy FROM plan_versions WHERE id = $1', [planVersionId])).rows[0];
    if (!v) fail('NOT_FOUND', 'plan version not found');
    // Legacy versions are only ever assigned by an explicit legacy import; retired ones are not sold.
    if (v.status !== 'published' && !(source === 'legacy_import' && v.status === 'retired')) fail('PLAN_ARCHIVED', 'plan version is not on sale');
    if (v.is_legacy && source !== 'legacy_import') fail('FORBIDDEN', 'legacy versions are not sold to new subscribers');
    const price = (await c.query('SELECT 1 FROM plan_version_prices WHERE plan_version_id = $1 AND billing_interval = $2', [planVersionId, interval])).rowCount;
    if (!price) fail('INVALID_INPUT', 'plan version has no price for interval ' + interval);
    const s = (await c.query(
      `INSERT INTO subscriptions (person_id, plan_version_id, billing_interval, status, provider, provider_subscription_id, provider_state_at,
                                  source, trial_end, current_period_start, current_period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (provider, provider_subscription_id) DO NOTHING RETURNING id`,
      [personId, planVersionId, interval, status, provider, providerSubscriptionId, providerStateAt, source, trialEnd, periodStart, periodEnd])).rows[0];
    if (!s) fail('CONFLICT', 'provider subscription already recorded');
    await c.query('INSERT INTO subscription_events (subscription_id, from_status, to_status, reason) VALUES ($1, NULL, $2, $3)', [s.id, status, 'created']);
    await audit(c, { ...actor, action: 'subscription.create', entityType: 'subscription', entityId: s.id, after: { planVersionId, interval, status, provider, source } });
    return s.id;
  }
}

/**
 * Move a subscription to `to` in its own transaction.
 * Returns { applied, stale?, from, to }.
 */
export async function transition(pool, subscriptionId, to, opts = {}, actor) {
  return withTransaction(pool, (c) => transitionInTx(c, subscriptionId, to, opts, actor));
}

/** Same as transition, inside the caller's transaction. */
export async function transitionInTx(c, subscriptionId, to, opts = {}, actor = { actorType: 'system', actorId: 'system' }) {
  {
    const s = (await c.query('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [subscriptionId])).rows[0];
    if (!s) fail('NOT_FOUND', 'subscription not found');
    const { reason = 'update', now = new Date(), providerStateAt = null, periodStart, periodEnd, cancelAt, graceDays = DEFAULT_GRACE_DAYS, webhookEventId = null } = opts;
    if (providerStateAt && s.provider_state_at && new Date(providerStateAt) < new Date(s.provider_state_at)) {
      return { applied: false, stale: true, from: s.status, to };
    }
    // Same state again (a replayed or same-second duplicate event): nothing to do, no history row.
    const samePeriod = (periodEnd == null || +new Date(periodEnd) === +new Date(s.current_period_end))
      && (cancelAt === undefined || +new Date(cancelAt || 0) === +new Date(s.cancel_at || 0));
    if (to === s.status && (TERMINAL.has(to) || samePeriod)) return { applied: false, noop: true, from: s.status, to };
    if (!canTransition(s.status, to)) fail('INVALID_TRANSITION', `cannot move a ${s.status} subscription to ${to}`, { from: s.status, to });
    const grace = to === 'past_due'
      ? (s.status === 'past_due' && s.grace_until ? s.grace_until : new Date(now.getTime() + graceDays * 86400000))
      : null;
    const ended = to === 'canceled' || to === 'expired';
    const u = (await c.query(
      `UPDATE subscriptions SET status = $2, grace_until = $3,
              current_period_start = COALESCE($4, current_period_start), current_period_end = COALESCE($5, current_period_end),
              cancel_at = CASE WHEN $6::boolean THEN $7 ELSE cancel_at END,
              canceled_at = CASE WHEN $2 = 'canceled' THEN COALESCE(canceled_at, $8) ELSE canceled_at END,
              ended_at = CASE WHEN $9 THEN COALESCE(ended_at, $8) ELSE ended_at END,
              provider_state_at = COALESCE($10, provider_state_at), updated_at = $8
        WHERE id = $1 RETURNING *`,
      [subscriptionId, to, grace, periodStart ?? null, periodEnd ?? null, cancelAt !== undefined, cancelAt ?? null, now, ended, providerStateAt])).rows[0];
    await c.query(
      'INSERT INTO subscription_events (subscription_id, from_status, to_status, reason, webhook_event_id, details, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [subscriptionId, s.status, to, reason, webhookEventId, JSON.stringify({ graceUntil: grace, periodEnd: u.current_period_end, cancelAt: u.cancel_at }), now]);
    await audit(c, { ...actor, action: 'subscription.transition', entityType: 'subscription', entityId: subscriptionId, before: { status: s.status }, after: { status: to, reason } });
    return { applied: true, from: s.status, to, subscription: u };
  }
}

/** Click-to-cancel, step 1: the exact access-end date shown before confirming (spec §15). */
export async function cancelPreview(db, subscriptionId) {
  const s = (await db.query('SELECT status, current_period_end, trial_end FROM subscriptions WHERE id = $1', [subscriptionId])).rows[0];
  if (!s) fail('NOT_FOUND', 'subscription not found');
  if (s.status === 'canceled' || s.status === 'expired') fail('CONFLICT', 'subscription already ended');
  const accessEndsAt = s.status === 'trialing' ? s.trial_end : s.current_period_end;
  return { accessEndsAt: accessEndsAt || new Date() };
}

/** Click-to-cancel, step 2: schedule the end at the previewed date; access continues until then. */
export async function scheduleCancel(pool, subscriptionId, { accessEndsAt, now = new Date() }, actor) {
  return withTransaction(pool, async (c) => {
    const s = (await c.query('SELECT status FROM subscriptions WHERE id = $1 FOR UPDATE', [subscriptionId])).rows[0];
    if (!s) fail('NOT_FOUND', 'subscription not found');
    if (s.status === 'canceled' || s.status === 'expired') fail('CONFLICT', 'subscription already ended');
    await c.query('UPDATE subscriptions SET cancel_at = $2, updated_at = $3 WHERE id = $1', [subscriptionId, accessEndsAt, now]);
    await c.query("INSERT INTO subscription_events (subscription_id, from_status, to_status, reason, details, occurred_at) VALUES ($1, $2, $2, 'cancel_scheduled', $3, $4)",
      [subscriptionId, s.status, JSON.stringify({ cancelAt: accessEndsAt }), now]);
    await audit(c, { ...actor, action: 'subscription.cancel_scheduled', entityType: 'subscription', entityId: subscriptionId, after: { cancelAt: accessEndsAt } });
  });
}
