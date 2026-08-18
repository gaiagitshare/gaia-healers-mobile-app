/**
 * GHL membership adapter — the first real source.
 *
 * It reads GHL's Payments subscriptions and turns each one into a membership
 * proposal. It writes nothing itself: every proposal goes through the same
 * validator Admin uses, and whether it reaches the ledger is decided by the
 * source's state in the registry, not by this file.
 *
 * The whole adapter is a mapping function. That is the point of B1 — ordering,
 * idempotency, identity, precedence and audit all live in the pipeline, so a
 * new source is only ever "what does this system's record mean in Gaia terms".
 *
 * It maps by PRICE ID and nothing else. Never the amount: Next Level bills the
 * same $97/month as Silver, and 16 live subscriptions would be swept into the
 * wrong tier by any rule that looked at money.
 */

import { tierFromBillingIds } from '../config.js';
import { reconcile } from '../proposals.js';
import { membershipFromSubscriptions } from '../resolver.js';

/**
 * GHL/Stripe subscription status → Gaia membership status.
 *
 * An exact map, deliberately. An unrecognised status must not be guessed into
 * "active" — it becomes a skipped subscription that shows up in the report,
 * which is how we find out GHL added a state we have never seen.
 */
const STATUS_MAP = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'cancelled',      // Stripe spelling
  cancelled: 'cancelled',
  incomplete: 'none',
  incomplete_expired: 'expired',
  ended: 'expired',
  expired: 'expired',
  paused: 'past_due',
};

/** Statuses that mean the member currently holds the tier. */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * The billing ids GHL puts on a subscription.
 *
 * `recurringProduct` is the authoritative pair; `lineItemDetails.productId` is
 * a different id (the funnel's product) and is deliberately NOT used to resolve
 * a tier — it does not identify the price, so it cannot tell monthly from
 * annual.
 */
function billingIds(subscription) {
  return [
    subscription?.recurringProduct?.price?._id,
    subscription?.recurringProduct?.product?._id,
  ].filter(Boolean);
}

/**
 * The moment this subscription last changed, according to GHL.
 *
 * `updatedAt` is the closest thing the Payments API gives us to an event time.
 * It is a source timestamp, so ordering can compare it against other source
 * timestamps rather than degrading to arrival time.
 */
function occurredAt(subscription) {
  return subscription?.updatedAt || subscription?.subscriptionStartDate || subscription?.createdAt || null;
}

/**
 * Turn one subscription into a proposal, or explain why it is not ours.
 *
 * Returns { skip: reason } for anything unmapped. An unmapped subscription is
 * a normal, expected outcome — Next Level, the legacy CRM product and agency
 * billing all live in the same account.
 */
export function subscriptionToProposal(subscription, { source = 'ghl_membership' } = {}) {
  const ids = billingIds(subscription);
  if (!ids.length) return { skip: 'no_billing_ids', subscription };

  const match = tierFromBillingIds(ids);
  if (!match) return { skip: 'not_a_gaia_product', subscription, ids };

  const status = STATUS_MAP[String(subscription.status || '').toLowerCase()];
  if (!status) return { skip: `unknown_status:${subscription.status}`, subscription };

  const contactId = String(subscription.contactId || '').trim();
  const when = occurredAt(subscription);

  return {
    proposal: {
      source,
      intentType: 'membership',
      // GHL contact id is the ledger key, so identity resolves exactly. The
      // email is carried too so an operator can confirm a link if it ever
      // needs one.
      contactId: contactId || null,
      identity: { ghl_contact_id: contactId, email: subscription.contactEmail || null },
      sourceEventId: `ghl-sub-${subscription._id}-${when || 'nodate'}`,
      sourceEntityId: subscription._id || subscription.subscriptionId || null,
      occurredAt: when,
      confidence: 'authoritative',
      intent: {
        key: match.key,
        status,
        billing_cycle: match.cycle || 'none',
        started_at: subscription.subscriptionStartDate || subscription.createdAt || null,
        renews_at: null,
        ends_at: LIVE_STATUSES.has(status) ? null : (subscription.updatedAt || null),
        source: 'ghl_subscription',
        evidence_id: subscription.subscriptionId || subscription._id || null,
      },
      evidence: {
        id: subscription.subscriptionId || subscription._id || null,
        matchedBillingId: match.matchedId,
        provider: subscription.paymentProviderType || null,
      },
      note: `${match.key} ${match.cycle} from GHL subscription`,
    },
    match,
    status,
    live: LIVE_STATUSES.has(status),
  };
}

/**
 * One proposal per CONTACT, not per subscription.
 *
 * A member can hold several subscription records — the live audit found one
 * contact with three, an active Diamond alongside two cancelled ones from the
 * same day. Emitting a proposal per record makes them race, and the winner is
 * decided by whichever GHL touched last. That happens to be the active one
 * today; it is luck, not design, and the day it flips a paying member gets
 * cancelled.
 *
 * So the adapter collapses a contact's subscriptions the same way the live
 * resolver already does — a live subscription outranks a dead one, then most
 * recent wins — by calling the very same function. The adapter and the member
 * read can then never disagree about what a set of subscriptions means, which
 * is exactly the property activation depends on.
 */
export function contactProposals(subscriptions, { source = 'ghl_membership' } = {}) {
  const byContact = new Map();
  for (const subscription of subscriptions) {
    const contactId = String(subscription?.contactId || '').trim();
    if (!contactId) continue;
    if (!byContact.has(contactId)) byContact.set(contactId, []);
    byContact.get(contactId).push(subscription);
  }

  const proposals = [];
  for (const [contactId, list] of byContact) {
    const resolved = membershipFromSubscriptions(list);
    if (!resolved.membership?.key) continue;   // nothing canonical for this contact

    // The record the chosen membership came from, for evidence and timing.
    const chosen = list.find((s) => String(s._id || s.subscriptionId || '') === String(resolved.membership.evidence_id))
      || list[0];
    const when = occurredAt(chosen);

    proposals.push({
      source,
      intentType: 'membership',
      contactId,
      identity: { ghl_contact_id: contactId, email: chosen?.contactEmail || null },
      sourceEventId: `ghl-member-${contactId}-${when || 'nodate'}`,
      sourceEntityId: resolved.membership.evidence_id || null,
      occurredAt: when,
      confidence: 'authoritative',
      intent: { ...resolved.membership },
      evidence: {
        id: resolved.membership.evidence_id,
        matchedBillingId: resolved.matchedId || null,
        subscriptionsConsidered: list.length,
      },
      note: `${resolved.membership.key} ${resolved.membership.billing_cycle} from ${list.length} GHL subscription(s)`,
      conflict: resolved.conflict,
    });
  }
  return proposals;
}

/**
 * Read every subscription for the location.
 *
 * `fetchPage` is injected so this is testable without a network and so the
 * caller owns credentials — the adapter never reads an environment variable.
 */
export async function fetchSubscriptions(fetchPage, { pageSize = 100, maxPages = 40 } = {}) {
  const all = [];
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await fetchPage({ limit: pageSize, offset: page * pageSize });
    const list = Array.isArray(batch) ? batch : (batch?.data || []);
    all.push(...list);
    if (list.length < pageSize) break;
  }
  return all;
}

/**
 * Run a sweep.
 *
 * Whether anything is written is decided entirely by the source's state:
 * `shadow` records the diffs and changes nothing, `active` applies. This
 * function does not know the difference, which is exactly why shadow mode
 * cannot drift from the real behaviour.
 *
 * Absence semantics matter here. The sweep only claims completeness over the
 * subscriptions it could map, so `scope` is limited accordingly — an unmapped
 * Next Level subscription must never look like a Gaia membership that vanished.
 */
export function sweep(store, subscriptions, { now = new Date(), source = 'ghl_membership' } = {}) {
  const converted = subscriptions.map((s) => subscriptionToProposal(s, { source }));
  const usable = converted.filter((c) => c.proposal);
  const skipped = converted.filter((c) => c.skip);

  const run = reconcile(store, {
    source,
    observed: contactProposals(subscriptions, { source }),
    scope: 'membership',
    now,
    actor: 'ghl-membership-sweep',
  });

  return {
    ...run,
    total: subscriptions.length,
    mapped: usable.length,
    contacts: contactProposals(subscriptions, { source }).length,
    skipped: skipped.length,
    skippedReasons: skipped.reduce((acc, s) => {
      const key = s.skip.split(':')[0];
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    converted,
  };
}

export { STATUS_MAP, LIVE_STATUSES, billingIds, occurredAt };
