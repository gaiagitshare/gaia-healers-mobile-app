/**
 * Membership webhook events → canonical ledger membership.
 *
 * Two defects this module exists to fix, both found while writing the Phase 4
 * build specification:
 *
 *  1. The receiver wrote only the legacy `record.tier`, which the Phase 1
 *     resolver deliberately ignores. A membership event was accepted, ordered,
 *     stored — and changed nothing a member could see.
 *  2. Membership actions were classified by loose substring matching, so
 *     `membership_ended` matched no revoke keyword and was read as a GRANT.
 *     An expiry would have handed out access.
 *
 * So membership event types are now an explicit map. Anything not in it is
 * unknown and fails safe; nothing defaults to granting.
 */

import {
  normalizeMembershipKey, tierFromBillingIds, MEMBERSHIP_SOURCES,
} from './config.js';

/**
 * Exact event type → what it does. Substring matching is deliberately not used
 * here: "ended" contains no revoke keyword, and guessing cost us a defect once.
 */
export const MEMBERSHIP_EVENT_ACTIONS = {
  // begins or continues a membership
  membership_activated: 'activate',
  membership_active: 'activate',
  membership_changed: 'activate',
  membership_updated: 'activate',
  membership_upgraded: 'activate',
  membership_downgraded: 'activate',
  membership_renewed: 'activate',
  membership_trial_started: 'activate',
  membership_trialing: 'activate',
  membership_past_due: 'activate',
  tier_activated: 'activate',
  tier_changed: 'activate',
  membership_granted: 'activate',
  membership_created: 'activate',
  membership_started: 'activate',
  membership_tier_granted: 'activate',
  membership_tier_updated: 'activate',

  // ends one — every word an operator might reasonably choose
  membership_cancelled: 'end',
  membership_canceled: 'end',
  membership_expired: 'end',
  membership_ended: 'end',
  membership_removed: 'end',
  membership_revoked: 'end',
  membership_lapsed: 'end',
  membership_deactivated: 'end',
  tier_removed: 'end',
  tier_cancelled: 'end',
  membership_tier_removed: 'end',
  membership_tier_revoked: 'end',
};

/**
 * The status an event implies when the payload does not assert one.
 *
 * The activate/end split alone is too coarse: it would flatten a trial and a
 * failed payment into "active", and an expiry into "cancelled". Those are
 * different things to a member and to support, so the event type carries its
 * own default.
 */
export const MEMBERSHIP_EVENT_DEFAULT_STATUS = {
  membership_trialing: 'trialing',
  membership_trial_started: 'trialing',
  membership_past_due: 'past_due',
  membership_expired: 'expired',
  membership_lapsed: 'expired',
  membership_ended: 'expired',
};

/** Normalize a raw event type the way the receiver already does. */
export const normalizeEventType = (value) =>
  String(value || '').trim().toLowerCase().replace(/[\s.-]+/g, '_');

/**
 * 'activate' | 'end' | null.
 * null means "this looks like a membership event but we do not know what it
 * does" — the caller must reject it rather than assume.
 */
export function classifyMembershipEvent(rawType) {
  const key = normalizeEventType(rawType);
  return MEMBERSHIP_EVENT_ACTIONS[key] || null;
}

/** Statuses a payload may assert, mapped to the frozen Phase 1 vocabulary. */
const STATUS_ALIASES = {
  active: 'active', activated: 'active',
  trialing: 'trialing', trial: 'trialing', trialling: 'trialing',
  past_due: 'past_due', pastdue: 'past_due', payment_failed: 'past_due',
  cancelled: 'cancelled', canceled: 'cancelled',
  expired: 'expired', ended: 'expired', lapsed: 'expired',
  none: 'none',
};

const firstDefined = (...values) => values.find((v) => v != null && v !== '');

/**
 * Read the tier from a payload without ever coercing an object to a string.
 *
 * `membership` may be a bare string ("gold") or the nested object the build
 * sheet documents ({key: "gold"}). String(object) yields "[object Object]",
 * which would silently become an unknown tier — so the shape is checked.
 */
export function readTier(body) {
  const candidates = [body?.tier, body?.membershipTier, body?.membership_key, body?.membership];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate === 'string') {
      const key = normalizeMembershipKey(candidate);
      if (key) return key;
      continue;
    }
    if (typeof candidate === 'object') {
      const key = normalizeMembershipKey(candidate.key ?? candidate.tier ?? candidate.name);
      if (key) return key;
    }
  }
  return null;
}

function readStatus(body, action, rawType) {
  const nested = (body?.membership && typeof body.membership === 'object') ? body.membership : {};
  const raw = firstDefined(body?.status, body?.membershipStatus, body?.membership_status, nested.status);
  const mapped = raw != null ? STATUS_ALIASES[String(raw).trim().toLowerCase()] : null;
  if (mapped) return mapped;
  // No asserted status: the event type's own default, then the action.
  const byType = MEMBERSHIP_EVENT_DEFAULT_STATUS[normalizeEventType(rawType)];
  if (byType) return byType;
  return action === 'end' ? 'cancelled' : 'active';
}

function readCycle(body) {
  const nested = (body?.membership && typeof body.membership === 'object') ? body.membership : {};
  const raw = firstDefined(body?.billingCycle, body?.billing_cycle, nested.billing_cycle, nested.billingCycle);
  const value = String(raw ?? '').trim().toLowerCase();
  if (['monthly', 'month'].includes(value)) return 'monthly';
  if (['annual', 'annually', 'year', 'yearly'].includes(value)) return 'annual';
  if (value === 'none') return 'none';
  return null;
}

/**
 * Build the canonical membership record for an accepted event.
 *
 * Billing identity outranks the payload's own claim: if a priceId maps to
 * Silver while the body says "gold", the id wins and the disagreement is
 * reported. Names and amounts are never consulted.
 *
 * Returns { membership, notes } or { error }.
 */
export function membershipFromEvent(body, { action, rawType = '', now = new Date() } = {}) {
  if (!action) return { error: 'unknown_membership_event_type' };

  const notes = [];
  const claimedTier = readTier(body);

  // Ids may sit at the top level or inside a nested membership object.
  const nested = (body?.membership && typeof body.membership === 'object') ? body.membership : {};
  const billingIds = [
    body?.priceId, body?.price_id, body?.productId, body?.product_id,
    nested.priceId, nested.productId,
  ].filter(Boolean).map(String);

  const byId = tierFromBillingIds(billingIds);
  let key = claimedTier;
  let cycle = readCycle(body);

  if (byId) {
    if (claimedTier && claimedTier !== byId.key) {
      notes.push(`payload claimed tier "${claimedTier}" but billing id ${byId.matchedId} identifies "${byId.key}" — id wins`);
    }
    key = byId.key;
    if (byId.cycle && byId.cycle !== 'none') cycle = byId.cycle;
  } else if (billingIds.length) {
    notes.push('billing ids present but none is canonical; falling back to the declared tier');
  }

  if (!key) return { error: 'membership_tier_missing_or_unrecognised' };

  const sourceRaw = String(firstDefined(body?.source, nested.source) || '').trim();
  const source = MEMBERSHIP_SOURCES.includes(sourceRaw)
    ? sourceRaw
    : (byId ? 'ghl_subscription' : 'manual');

  const evidence = firstDefined(
    body?.evidenceId, body?.evidence_id, body?.subscriptionId, body?.subscription_id,
    nested.evidence_id, byId?.matchedId,
  );

  const membership = {
    key,
    status: readStatus(body, action, rawType),
    billing_cycle: cycle || 'none',
    started_at: firstDefined(body?.startedAt, body?.started_at, nested.started_at) || null,
    renews_at: firstDefined(body?.renewsAt, body?.renews_at, nested.renews_at) || null,
    ends_at: firstDefined(body?.endsAt, body?.ends_at, nested.ends_at) || null,
    source,
    evidence_id: evidence ? String(evidence) : null,
  };

  // An ending membership with no explicit end date ended now — otherwise the
  // resolver cannot tell a cancellation from a live membership.
  if (action === 'end' && !membership.ends_at) {
    membership.ends_at = now.toISOString();
    notes.push('no endsAt supplied; recorded the event time');
  }

  return { membership, notes };
}
