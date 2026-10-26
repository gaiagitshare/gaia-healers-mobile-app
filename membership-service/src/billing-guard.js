/**
 * Duplicate-billing guard (architecture C: legacy memberships stay billed by GHL).
 *
 * Before Gaia starts ANY new recurring Gaia subscription, it asks: does this
 * person already pay for a membership somewhere? The answer is a status, never a
 * side effect. Nothing here cancels, pauses or changes a GHL / PayPal / Stripe
 * subscription, a price, a tag or course access.
 *
 *   ok                    nothing paid elsewhere; a new checkout may start
 *   already_subscribed    holds this Gaia plan already
 *   change_plan_required  holds another Gaia tier: change that subscription, never a second one
 *   migration_required    a live, mapped legacy GHL membership (any tier): only the
 *                         controlled migration flow (migration-offers.js) may proceed
 *   review_required       something unknown or ambiguous (unmapped price, unknown
 *                         status, stale payments, needs-review flag, legacy mirror
 *                         not loaded or out of date): a human decides first
 *
 * Unknown is never treated as inactive: only a status GHL itself reports as ended
 * (and that nobody flagged for review) clears a legacy row.
 */

export const LEGACY_ENDED_STATUSES = new Set(['canceled', 'cancelled', 'expired', 'incomplete_expired', 'ended', 'completed']);
export const GAIA_LIVE_STATUSES = ['incomplete', 'trialing', 'active', 'past_due', 'paused'];
export const DEFAULT_MIRROR_MAX_AGE_MS = 36 * 3600 * 1000;

const ended = (s) => LEGACY_ENDED_STATUSES.has(String(s || '').trim().toLowerCase());

/** Legacy mirror rows that belong to the person: by person id, or by any of their GHL contact ids (rows not linked yet). */
export async function legacyRowsFor(db, personId) {
  return (await db.query(
    `SELECT l.* FROM legacy_memberships l
      WHERE l.person_id = $1
         OR l.external_contact_id IN (SELECT external_id FROM person_identities WHERE person_id = $1 AND platform = 'ghl' AND kind = 'contact')
      ORDER BY l.first_seen_at`, [personId])).rows;
}

/** Why a legacy row blocks a new subscription, or null if it does not. */
export function legacyBlock(row) {
  const reasons = [];
  if (row.review_state === 'needs_review') reasons.push(...(row.review_reasons?.length ? row.review_reasons : ['flagged_for_review']));
  if (ended(row.reported_status) && !reasons.length) return null;            // GHL itself says it ended
  if (row.mapping !== 'mapped') reasons.push(row.mapping === 'ambiguous' ? 'ambiguous_price' : 'unmapped_price');
  if (row.stale_suspected) reasons.push('no_recent_payment');
  const live = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'scheduled', 'incomplete']);
  if (!ended(row.reported_status) && !live.has(String(row.reported_status).toLowerCase())) reasons.push('unknown_status');
  return { kind: reasons.length ? 'review_required' : 'migration_required', reasons: [...new Set(reasons)], legacyMembershipId: row.id, tier: row.tier, provider: row.payment_provider };
}

async function mirrorState(db, now, maxAgeMs) {
  const r = (await db.query('SELECT count(*)::int AS n, max(last_seen_at) AS last FROM legacy_memberships')).rows[0];
  if (!r.n) return 'legacy_mirror_not_loaded';
  if (maxAgeMs != null && now - new Date(r.last) > maxAgeMs) return 'legacy_mirror_out_of_date';
  return null;
}

/**
 * May `personId` start a new recurring subscription to `planVersionId`?
 * opts.migrationOfferId: the accepted offer that is allowed to replace exactly one legacy membership.
 * opts.mirrorMaxAgeMs: legacy mirror freshness requirement (default 36 h; null disables the age check, never the empty check).
 */
export async function checkoutEligibility(db, personId, planVersionId, { now = new Date(), mirrorMaxAgeMs = DEFAULT_MIRROR_MAX_AGE_MS, migrationOfferId = null } = {}) {
  const target = (await db.query(
    `SELECT v.id, v.plan_id, p.owner_type, p.practitioner_id FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE v.id = $1`, [planVersionId])).rows[0];
  if (!target) return { status: 'review_required', reasons: ['unknown_plan_version'] };

  // 1. Gaia-side subscriptions in the same domain (Gaia tiers compete with Gaia tiers; a practitioner's plan with that practitioner's).
  const subs = (await db.query(
    `SELECT s.id, s.status, s.source, v.plan_id FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
      WHERE s.person_id = $1 AND s.status = ANY($2) AND p.owner_type = $3 AND p.practitioner_id IS NOT DISTINCT FROM $4`,
    [personId, GAIA_LIVE_STATUSES, target.owner_type, target.practitioner_id])).rows;
  const same = subs.find((s) => s.plan_id === target.plan_id && s.source !== 'legacy_import');
  if (same) return { status: 'already_subscribed', subscriptionId: same.id };
  const otherTier = subs.find((s) => s.source !== 'legacy_import');
  if (otherTier) return { status: 'change_plan_required', subscriptionId: otherTier.id };
  const importedLegacy = subs.filter((s) => s.source === 'legacy_import');

  // Legacy GHL memberships are Gaia memberships; they do not block a practitioner's own plan.
  if (target.owner_type !== 'gaia') return { status: 'ok' };

  // 2. The legacy mirror must be loaded (and recent) before anyone can be told "nothing paid elsewhere".
  const mirror = await mirrorState(db, now, mirrorMaxAgeMs);
  if (mirror) return { status: 'review_required', reasons: [mirror] };

  // 3. Legacy memberships, any tier.
  let offer = null;
  if (migrationOfferId) {
    offer = (await db.query("SELECT * FROM migration_offers WHERE id = $1 AND person_id = $2 AND status IN ('accepted', 'checkout_started')", [migrationOfferId, personId])).rows[0] || null;
    if (!offer) return { status: 'review_required', reasons: ['migration_offer_not_accepted'] };
    if (offer.target_plan_version_id !== planVersionId) return { status: 'review_required', reasons: ['migration_offer_for_another_plan'] };
  }
  const blocks = (await legacyRowsFor(db, personId)).map(legacyBlock).filter(Boolean);
  const review = blocks.filter((b) => b.kind === 'review_required');
  if (review.length) return { status: 'review_required', reasons: [...new Set(review.flatMap((b) => b.reasons))], legacy: review };
  const remaining = blocks.filter((b) => !offer || b.legacyMembershipId !== offer.legacy_membership_id);
  if (remaining.length) return { status: 'migration_required', legacy: remaining };
  if (importedLegacy.length && !offer) return { status: 'migration_required', legacy: importedLegacy.map((s) => ({ subscriptionId: s.id })) };
  return offer ? { status: 'ok', migrationOfferId: offer.id } : { status: 'ok' };
}

/**
 * May the live Gaia subscription `subscription` (a row with plan_id, status, source,
 * provider, owner_type, cancel_at) of `personId` move to another plan? The plan-change
 * counterpart of checkoutEligibility: the same "never billed twice, unknown is never
 * inactive" rules, answered as a status, never a side effect.
 *
 *   ok                    nothing else is billing this person
 *   migration_required    a legacy subscription (imported) or a live GHL legacy membership:
 *                         legacy members never change plan, they migrate
 *   review_required       the legacy mirror is missing / out of date, a legacy row needs a
 *                         human, or more than one live Gaia subscription exists
 */
export async function planChangeEligibility(db, personId, subscription, { now = new Date(), mirrorMaxAgeMs = DEFAULT_MIRROR_MAX_AGE_MS } = {}) {
  if (subscription.source === 'legacy_import') return { status: 'migration_required', reasons: ['legacy_subscription'] };
  const others = (await db.query(
    `SELECT s.id FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
      WHERE s.person_id = $1 AND s.id <> $2 AND s.status = ANY($3) AND p.owner_type = 'gaia'`, [personId, subscription.id, GAIA_LIVE_STATUSES])).rows;
  if (others.length) return { status: 'review_required', reasons: ['multiple_live_subscriptions'] };
  const mirror = await mirrorState(db, now, mirrorMaxAgeMs);
  if (mirror) return { status: 'review_required', reasons: [mirror] };
  const blocks = (await legacyRowsFor(db, personId)).map(legacyBlock).filter(Boolean);
  const review = blocks.filter((b) => b.kind === 'review_required');
  if (review.length) return { status: 'review_required', reasons: [...new Set(review.flatMap((b) => b.reasons))], legacy: review };
  if (blocks.length) return { status: 'migration_required', legacy: blocks };
  return { status: 'ok' };
}
