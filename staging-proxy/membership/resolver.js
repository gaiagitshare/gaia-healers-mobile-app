/**
 * Membership resolver — turns a ledger record (plus whatever live evidence the
 * caller already had) into the resolved read model the app renders.
 *
 * Two rules govern everything here:
 *
 *  1. Membership comes from billing identity or an explicit ledger record.
 *     Never from a tag, never from a product name, never from an amount.
 *  2. Uncertainty is reported, not resolved. "We could not reach the source"
 *     and "this was revoked" are different answers and must look different.
 */

import {
  MEMBERSHIP_PRESENTATION, MEMBERSHIP_POLICY, ENTITLEMENT_TYPES,
  LEDGER_STALE_AFTER_MS,
  normalizeMembershipKey, tierFromBillingIds, isLegacyMembershipTag, nextMembershipKey,
} from './config.js';
import { normalizeMembership, normalizeEntitlement } from './ledger.js';

const ID_LIKE = /^(prod_[A-Za-z0-9]+|price_[A-Za-z0-9]+|[0-9a-f]{24})$/;

/** Every id-shaped string anywhere in a subscription payload. */
function billingIdsFromSubscription(subscription) {
  const found = new Set();
  const walk = (node, depth = 0) => {
    if (node == null || depth > 6) return;
    if (typeof node === 'string') {
      const value = node.trim();
      if (ID_LIKE.test(value)) found.add(value);
      return;
    }
    if (Array.isArray(node)) { node.forEach((item) => walk(item, depth + 1)); return; }
    if (typeof node === 'object') { Object.values(node).forEach((item) => walk(item, depth + 1)); }
  };
  walk(subscription);
  return [...found];
}

const SUBSCRIPTION_STATUS_MAP = {
  active: 'active',
  trialing: 'trialing',
  trial: 'trialing',
  past_due: 'past_due',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  incomplete_expired: 'expired',
  expired: 'expired',
};

const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * Resolve membership from subscription evidence.
 *
 * Only canonical billing ids count. A subscription whose product we cannot
 * identify is reported as unmapped rather than guessed at — five legacy PayPal
 * subscriptions in this location are exactly that case, and mapping them to
 * Silver because they happen to cost $97 would be inventing a customer right.
 */
function membershipFromSubscriptions(subscriptions = [], { now = new Date() } = {}) {
  const candidates = [];
  const unmapped = [];
  for (const subscription of (Array.isArray(subscriptions) ? subscriptions : [])) {
    const rawStatus = String(subscription?.status || '').trim().toLowerCase();
    const status = SUBSCRIPTION_STATUS_MAP[rawStatus] || 'none';
    const ids = billingIdsFromSubscription(subscription);
    const match = tierFromBillingIds(ids);
    const evidenceId = String(subscription?._id || subscription?.subscriptionId || subscription?.id || '') || null;
    if (!match) {
      unmapped.push({ evidence_id: evidenceId, status, reason: 'no canonical billing id on this subscription' });
      continue;
    }
    candidates.push({
      key: match.key,
      cycle: match.cycle,
      matchedId: match.matchedId,
      status,
      evidence_id: evidenceId,
      at: Date.parse(subscription?.updatedAt || subscription?.createdAt || '') || 0,
      started_at: subscription?.subscriptionStartDate || subscription?.createdAt || null,
      renews_at: subscription?.currentPeriodEnd || subscription?.nextBillingDate || null,
      ends_at: subscription?.canceledAt || subscription?.endedAt || null,
    });
  }

  // A live subscription always outranks a dead one; otherwise most recent wins.
  candidates.sort((a, b) => {
    const liveA = LIVE_STATUSES.has(a.status) ? 1 : 0;
    const liveB = LIVE_STATUSES.has(b.status) ? 1 : 0;
    if (liveA !== liveB) return liveB - liveA;
    return b.at - a.at;
  });

  const chosen = candidates[0] || null;
  const liveKeys = [...new Set(candidates.filter((c) => LIVE_STATUSES.has(c.status)).map((c) => c.key))];
  if (!chosen) return { membership: null, unmapped, conflict: false, candidates: [] };

  return {
    membership: normalizeMembership({
      key: chosen.key,
      status: chosen.status,
      billing_cycle: chosen.cycle,
      started_at: chosen.started_at,
      renews_at: chosen.renews_at,
      ends_at: chosen.ends_at,
      source: 'ghl_subscription',
      evidence_id: chosen.evidence_id,
    }, { now }),
    matchedId: chosen.matchedId,
    unmapped,
    conflict: liveKeys.length > 1,
    candidates: [...new Set(candidates.map((c) => c.key))],
  };
}

const NO_MEMBERSHIP = {
  key: null, status: 'none', billing_cycle: 'none',
  started_at: null, renews_at: null, ends_at: null, source: null, evidence_id: null,
};

function decorate(membership) {
  const key = normalizeMembershipKey(membership?.key);
  const presentation = key ? MEMBERSHIP_PRESENTATION[key] : null;
  return {
    ...membership,
    label: presentation?.label || null,
    subtitle: presentation?.subtitle || null,
  };
}

/**
 * Resolve the full member read model.
 *
 * `record`        — the contact's ledger record (may be null)
 * `subscriptions` — live subscription evidence the caller already fetched
 * `tags`          — GHL tags, used ONLY for diagnostics and legacy reporting
 * `sourceError`   — true when an upstream read failed for this request
 */
function resolveMemberAccess({
  record = null,
  subscriptions = [],
  tags = [],
  sourceError = false,
  now = new Date(),
  staleAfterMs = LEDGER_STALE_AFTER_MS,
} = {}) {
  const notes = [];

  // ── membership ────────────────────────────────────────────────────────────
  let membership = NO_MEMBERSHIP;
  let resolvedBy = 'none';
  let conflict = false;
  let unmappedSubscriptions = [];

  const fromSubs = membershipFromSubscriptions(subscriptions, { now });
  unmappedSubscriptions = fromSubs.unmapped;
  if (fromSubs.membership && fromSubs.membership.key) {
    membership = fromSubs.membership;
    resolvedBy = 'billing_id';
    conflict = fromSubs.conflict;
  } else if (record?.membership) {
    // An explicit ledger membership (onboarding, manual grant, fixture).
    const stored = normalizeMembership(record.membership, { now });
    if (stored?.key) { membership = stored; resolvedBy = `ledger:${stored.source}`; }
  }

  if (unmappedSubscriptions.length) {
    notes.push(`${unmappedSubscriptions.length} subscription(s) carry no canonical billing id and were not mapped to a tier`);
  }

  // Legacy tier tags are reported, never honoured.
  const legacyTierTags = (Array.isArray(tags) ? tags : [])
    .map((t) => String(t || '').trim())
    .filter((t) => isLegacyMembershipTag(t));
  if (legacyTierTags.length && !membership.key) {
    notes.push('legacy membership tags present but ignored: they are not billing evidence');
  }

  // ── entitlements ──────────────────────────────────────────────────────────
  const rawEntitlements = Array.isArray(record?.entitlements) ? record.entitlements : [];
  const normalized = rawEntitlements
    .map((item) => normalizeEntitlement(item, { now }))
    .filter(Boolean);

  const quarantined = normalized.filter((item) => item.unknown_type);
  const entitlements = normalized.filter((item) => !item.unknown_type);
  if (quarantined.length) {
    notes.push(`${quarantined.length} entitlement(s) of unknown type were withheld from rendering`);
  }

  // ── sections (presentation metadata only) ─────────────────────────────────
  const activeByType = new Map();
  for (const entitlement of entitlements) {
    if (entitlement.status !== 'active') continue;
    activeByType.set(entitlement.type, (activeByType.get(entitlement.type) || 0) + 1);
  }
  const sections = [...activeByType.entries()]
    .map(([type, count]) => {
      const meta = ENTITLEMENT_TYPES[type];
      return {
        type,
        title: meta.title,
        summary: `${count} ${meta.unit}${count === 1 ? '' : 's'}`,
        order: meta.order,
      };
    })
    .sort((a, b) => a.order - b.order);

  // ── upgrade path ──────────────────────────────────────────────────────────
  const nextKey = nextMembershipKey(membership.key || 'free');
  const gains = [];
  if (nextKey) {
    const current = MEMBERSHIP_POLICY[membership.key || 'free'] || {};
    const next = MEMBERSHIP_POLICY[nextKey] || {};
    for (const field of Object.keys(next)) {
      if (JSON.stringify(next[field]) !== JSON.stringify(current[field]) && next[field] != null) {
        gains.push({ type: field, from: current[field] ?? null, to: next[field] });
      }
    }
  }

  // ── freshness ─────────────────────────────────────────────────────────────
  const observedTimes = entitlements
    .map((item) => Date.parse(item.observed_at || '') || 0)
    .filter(Boolean);
  const ledgerObservedAt = observedTimes.length ? new Date(Math.max(...observedTimes)).toISOString() : null;
  const ageMs = ledgerObservedAt ? now.getTime() - Date.parse(ledgerObservedAt) : null;
  const stale = Boolean(ledgerObservedAt && ageMs > staleAfterMs);
  if (stale) notes.push('ledger observation is older than the freshness window');
  if (sourceError) notes.push('an upstream source was unavailable for this request; access shown is the last known state, not a revocation');

  return {
    membership: decorate(membership),
    entitlements,
    sections,
    upgrade: nextKey ? { next_key: nextKey, gains } : null,
    meta: {
      degraded: Boolean(stale || sourceError),
      stale,
      resolved_from: 'ledger',
      membership_resolved_by: resolvedBy,
      ledger_observed_at: ledgerObservedAt,
      membership_conflict: conflict,
      legacy_membership_tags: legacyTierTags,
      unmapped_subscriptions: unmappedSubscriptions,
      quarantined_entitlements: quarantined.map((item) => ({ type: item.type, key: item.key })),
      notes,
    },
  };
}

export {
  resolveMemberAccess,
  membershipFromSubscriptions,
  billingIdsFromSubscription,
  NO_MEMBERSHIP,
};
