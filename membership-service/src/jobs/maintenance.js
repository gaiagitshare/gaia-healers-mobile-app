/**
 * Subscription maintenance and stale holds.
 *
 * Access already ends on time without this job (grantsAccess() checks grace,
 * trial end and cancel dates on every read). The job records the end in the
 * subscription itself, but ONLY for subscriptions Gaia owns (provider 'manual'
 * or 'simulated'). For Stripe / GHL / partner subscriptions the provider is the
 * billing truth: its own events end them; here they are only counted so an
 * operator can see a provider that went quiet.
 */
import { transition } from '../subscriptions.js';
import { releaseExpiredHolds } from '../coins.js';

const ACTOR = { actorType: 'system', actorId: 'job:subscription-maintenance' };
const OWNED = ['manual', 'simulated'];

export async function runSubscriptionMaintenance(pool, { now = new Date(), limit = 500 } = {}) {
  const due = (await pool.query(
    `SELECT id, provider, status,
            CASE WHEN cancel_at IS NOT NULL AND cancel_at <= $1 THEN 'canceled'
                 WHEN status = 'past_due' AND grace_until <= $1 THEN 'expired'
                 WHEN status = 'trialing' AND trial_end <= $1 THEN 'expired' END AS target,
            CASE WHEN cancel_at IS NOT NULL AND cancel_at <= $1 THEN 'scheduled_cancel_reached'
                 WHEN status = 'past_due' THEN 'grace_elapsed' ELSE 'trial_ended_unpaid' END AS reason
       FROM subscriptions
      WHERE status NOT IN ('canceled', 'expired')
        AND ((cancel_at IS NOT NULL AND cancel_at <= $1) OR (status = 'past_due' AND grace_until <= $1) OR (status = 'trialing' AND trial_end <= $1))
      ORDER BY id LIMIT $2`, [now, limit])).rows;
  const out = { ended: 0, providerOwnedOverdue: 0 };
  for (const s of due) {
    if (!OWNED.includes(s.provider)) { out.providerOwnedOverdue++; continue; }
    const r = await transition(pool, s.id, s.target, { reason: s.reason, now }, ACTOR);
    if (r.applied) out.ended++;
  }
  return out;
}

export async function runHoldCleanup(pool, { now = new Date(), limit = 100 } = {}) {
  return { released: await releaseExpiredHolds(pool, { now, limit }) };
}
