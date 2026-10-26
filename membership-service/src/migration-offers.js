/**
 * Controlled legacy -> new tier migration (spec §11; architecture C).
 *
 *   offered -> accepted -> checkout_started -> subscribed -> completed
 *          \-> declined / withdrawn (any time before subscribed)
 *
 * - An offer is an invitation, never a deadline, and only for a legacy row that
 *   is mapped, live and not under review.
 * - The new Stripe subscription does not bill until the legacy one is paid
 *   through, plus the sweetener (default 2 months free).
 * - Code NEVER cancels the GHL / PayPal subscription. Staff cancel it by hand
 *   and confirm here; until then the offer stays "subscribed" and an alert
 *   fires well before the new subscription starts billing.
 */
import { withTransaction } from './db.js';
import { audit } from './audit.js';
import { fail } from './errors.js';
import { legacyRowsFor, legacyBlock } from './billing-guard.js';

export const CANCEL_CONFIRM_LEAD_DAYS = 7;     // alert this long before billing starts if GHL is not yet cancelled

function addMonths(d, n) {
  const x = new Date(d);
  const day = x.getUTCDate();
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n);
  x.setUTCDate(Math.min(day, new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate()));
  return x;
}

/** When the new subscription may start charging: after the legacy one is paid through, plus the sweetener. */
export function billingStartsAt(legacy, offer, now = new Date()) {
  if (!legacy.paid_through_estimate) return null;            // unknown paid-through: never guess (would risk double billing)
  const base = new Date(Math.max(now.getTime(), new Date(legacy.paid_through_estimate).getTime()));
  return addMonths(base, offer.sweetener_months);
}

export async function createOffer(pool, { legacyMembershipId, targetPlanVersionId, targetInterval, sweetenerMonths = 2 }, offeredBy) {
  if (!offeredBy) fail('INVALID_INPUT', 'offeredBy is required');
  return withTransaction(pool, async (c) => {
    const l = (await c.query('SELECT * FROM legacy_memberships WHERE id = $1 FOR UPDATE', [legacyMembershipId])).rows[0];
    if (!l) fail('NOT_FOUND', 'legacy membership not found');
    if (!l.person_id) fail('CONFLICT', 'legacy membership is not linked to a person yet');
    const b = legacyBlock(l);
    if (!b) fail('CONFLICT', 'legacy membership has ended; nothing to migrate');
    if (b.kind !== 'migration_required') fail('CONFLICT', 'legacy membership needs review before any offer', { reasons: b.reasons });
    const v = (await c.query(
      `SELECT v.id FROM plan_versions v JOIN plans p ON p.id = v.plan_id
        WHERE v.id = $1 AND v.status = 'published' AND NOT v.is_legacy AND p.owner_type = 'gaia' AND p.status = 'active'`, [targetPlanVersionId])).rows[0];
    if (!v) fail('PLAN_ARCHIVED', 'target is not a Gaia plan version on sale');
    const price = (await c.query('SELECT 1 FROM plan_version_prices WHERE plan_version_id = $1 AND billing_interval = $2', [targetPlanVersionId, targetInterval])).rowCount;
    if (!price) fail('INVALID_INPUT', 'target has no price for ' + targetInterval);
    let o;
    try {
      o = (await c.query(
        `INSERT INTO migration_offers (person_id, legacy_membership_id, target_plan_version_id, target_interval, sweetener_months, offered_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [l.person_id, l.id, targetPlanVersionId, targetInterval, sweetenerMonths, offeredBy])).rows[0];
    } catch (e) { if (e.code === '23505') fail('CONFLICT', 'an open offer already exists for this legacy membership'); throw e; }
    await audit(c, { actorType: 'admin', actorId: offeredBy, action: 'migration_offer.create', entityType: 'migration_offer', entityId: o.id,
      after: { legacyMembershipId, tier: l.tier, provider: l.payment_provider, targetPlanVersionId, targetInterval, sweetenerMonths } });
    return o;
  });
}

async function move(pool, offerId, from, to, actor, extra = {}, check) {
  return withTransaction(pool, async (c) => {
    const o = (await c.query('SELECT * FROM migration_offers WHERE id = $1 FOR UPDATE', [offerId])).rows[0];
    if (!o) fail('NOT_FOUND', 'offer not found');
    if (o.status === to) return { offer: o, replayed: true };
    if (!from.includes(o.status)) fail('CONFLICT', `offer is ${o.status}`);
    if (check) await check(c, o);
    const sets = Object.keys(extra).map((k, i) => `${k} = $${i + 3}`);
    const u = (await c.query(`UPDATE migration_offers SET status = $2, updated_at = now()${sets.length ? ', ' + sets.join(', ') : ''} WHERE id = $1 RETURNING *`,
      [offerId, to, ...Object.values(extra)])).rows[0];
    await audit(c, { ...actor, action: 'migration_offer.' + to, entityType: 'migration_offer', entityId: offerId, before: { status: o.status }, after: { status: to, ...extra } });
    return { offer: u, replayed: false };
  });
}

/** The member accepts (only the member it was offered to). */
export const acceptOffer = (pool, offerId, personId) => move(pool, offerId, ['offered'], 'accepted', { actorType: 'person', actorId: personId }, { accepted_at: new Date() },
  async (c, o) => { if (o.person_id !== personId) fail('NOT_FOUND', 'offer not found'); });
export const declineOffer = (pool, offerId, personId) => move(pool, offerId, ['offered', 'accepted'], 'declined', { actorType: 'person', actorId: personId }, {},
  async (c, o) => { if (o.person_id !== personId) fail('NOT_FOUND', 'offer not found'); });
export const withdrawOffer = (pool, offerId, staff) => move(pool, offerId, ['offered', 'accepted', 'checkout_started'], 'withdrawn', { actorType: 'admin', actorId: staff });

/** Called by the checkout path once Stripe Checkout exists (records when billing will start). */
export const markCheckoutStarted = (db, offerId, billingStarts) => move(db, offerId, ['accepted', 'checkout_started'], 'checkout_started',
  { actorType: 'system', actorId: 'migration-checkout' }, { billing_starts_at: billingStarts });

/** Called from the Stripe webhook (inside its transaction) when the new subscription is recorded. */
export async function linkSubscriptionInTx(c, offerId, subscriptionId) {
  const o = (await c.query('SELECT * FROM migration_offers WHERE id = $1 FOR UPDATE', [offerId])).rows[0];
  if (!o || o.status === 'subscribed' || o.status === 'completed') return false;
  if (o.status !== 'checkout_started') return false;
  await c.query("UPDATE migration_offers SET status = 'subscribed', subscription_id = $2, updated_at = now() WHERE id = $1", [offerId, subscriptionId]);
  await c.query("UPDATE subscriptions SET source = 'migration_offer' WHERE id = $1", [subscriptionId]);
  await audit(c, { actorType: 'provider', actorId: 'stripe', action: 'migration_offer.subscribed', entityType: 'migration_offer', entityId: offerId, after: { subscriptionId } });
  return true;
}

/** Staff cancelled the GHL / PayPal subscription by hand and confirm it here. */
export const confirmLegacyCancelled = (pool, offerId, staff) => move(pool, offerId, ['subscribed'], 'completed', { actorType: 'admin', actorId: staff },
  { legacy_cancel_confirmed_by: staff, legacy_cancel_confirmed_at: new Date() });

/**
 * Offers whose new subscription exists but whose legacy billing nobody has
 * confirmed cancelled. `alert` fires for those whose billing starts within the
 * lead time (or already started: then BOTH may be charging - urgent).
 */
export async function pendingLegacyCancellations(db, { now = new Date(), leadDays = CANCEL_CONFIRM_LEAD_DAYS, alert = async () => {} } = {}) {
  const rows = (await db.query(
    `SELECT o.id, o.billing_starts_at, l.tier, l.payment_provider, l.reported_status
       FROM migration_offers o JOIN legacy_memberships l ON l.id = o.legacy_membership_id
      WHERE o.status = 'subscribed' ORDER BY o.billing_starts_at`)).rows;
  const due = rows.filter((r) => !r.billing_starts_at || new Date(r.billing_starts_at) - now <= leadDays * 86400000);
  for (const r of due) {
    await alert({ kind: new Date(r.billing_starts_at) <= now ? 'double_billing_possible' : 'legacy_cancel_due', offerId: r.id, billingStartsAt: r.billing_starts_at, tier: r.tier, provider: r.payment_provider });
  }
  return { pending: rows.length, alerted: due.length };
}

/** Everything the person could migrate, for an admin view (read-only). */
export async function migrationCandidates(db, personId) {
  return (await legacyRowsFor(db, personId)).map((l) => ({ legacyMembershipId: l.id, tier: l.tier, provider: l.payment_provider, status: l.reported_status, block: legacyBlock(l) }));
}
