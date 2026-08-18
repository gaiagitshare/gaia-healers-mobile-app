/**
 * The GHL membership adapter.
 *
 * Synthetic throughout, using subscription payloads shaped exactly like the
 * ones the live Payments API returns. The adapter is only a mapping function,
 * so these tests are about what a GHL record MEANS — the pipeline's own
 * behaviour is covered elsewhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { subscriptionToProposal, contactProposals, sweep, fetchSubscriptions, STATUS_MAP } from '../membership/adapters/ghl-membership.js';
import { resolveMemberAccess } from '../membership/resolver.js';
import { setSourceState, getSource } from '../membership/sources.js';
import { assignMembership } from '../membership/admin-ops.js';
import { MEMBERSHIP_BILLING } from '../membership/config.js';

const NOW = new Date('2026-08-18T12:00:00Z');
const fresh = () => ({ version: 2, contacts: {}, processedWebhookIds: [], auditLog: [] });

/** Shaped like a real /payments/subscriptions record. */
const sub = (over = {}) => ({
  _id: over._id || 'sub-mongo-1',
  subscriptionId: over.subscriptionId || 'sub_stripe_1',
  contactId: over.contactId || 'contact-1',
  contactEmail: 'someone@example.test',
  status: over.status || 'active',
  amount: over.amount ?? 97,
  paymentProviderType: 'stripe',
  subscriptionStartDate: '2026-06-01T10:00:00.000Z',
  updatedAt: over.updatedAt || '2026-08-01T10:00:00.000Z',
  recurringProduct: over.recurringProduct !== undefined ? over.recurringProduct : {
    product: { _id: MEMBERSHIP_BILLING.silver.ghlProductId },
    price: { _id: over.priceId || MEMBERSHIP_BILLING.silver.monthlyPriceId, recurring: { interval: 'month' } },
  },
  lineItemDetails: { productId: 'funnel-product-id-not-authoritative' },
  ...over,
});

// ── mapping ─────────────────────────────────────────────────────────────────
test('a canonical subscription maps to the right tier and cycle', () => {
  const monthly = subscriptionToProposal(sub());
  assert.equal(monthly.match.key, 'silver');
  assert.equal(monthly.proposal.intent.key, 'silver');
  assert.equal(monthly.proposal.intent.billing_cycle, 'monthly');
  assert.equal(monthly.proposal.intent.source, 'ghl_subscription');

  const annual = subscriptionToProposal(sub({ priceId: MEMBERSHIP_BILLING.silver.annualPriceId }));
  assert.equal(annual.proposal.intent.billing_cycle, 'annual', 'the price id is what distinguishes the cycle');

  const diamond = subscriptionToProposal(sub({
    recurringProduct: {
      product: { _id: MEMBERSHIP_BILLING.diamond.ghlProductId },
      price: { _id: MEMBERSHIP_BILLING.diamond.monthlyPriceId },
    },
  }));
  assert.equal(diamond.match.key, 'diamond');
});

test('the Next Level $97 subscription is skipped, not mapped to Silver', () => {
  const nextLevel = subscriptionToProposal(sub({
    amount: 97,
    recurringProduct: {
      product: { _id: '67bb407aee6d11417bd8f459' },
      price: { _id: '67bb407aee6d11a5f3d8f45c', recurring: { interval: 'month' } },
    },
  }));
  assert.equal(nextLevel.proposal, undefined);
  assert.equal(nextLevel.skip, 'not_a_gaia_product',
    'same price point, different product — identity decides, never the amount');
});

test('the funnel line-item product id is never used to resolve a tier', () => {
  const noRecurring = subscriptionToProposal(sub({ recurringProduct: null }));
  assert.equal(noRecurring.skip, 'no_billing_ids',
    'lineItemDetails.productId is present but must not resolve anything — it cannot tell monthly from annual');
});

test('subscription status maps exactly, and an unknown status is skipped', () => {
  assert.equal(subscriptionToProposal(sub({ status: 'trialing' })).proposal.intent.status, 'trialing');
  assert.equal(subscriptionToProposal(sub({ status: 'canceled' })).proposal.intent.status, 'cancelled');
  assert.equal(subscriptionToProposal(sub({ status: 'incomplete_expired' })).proposal.intent.status, 'expired');
  assert.equal(subscriptionToProposal(sub({ status: 'past_due' })).proposal.intent.status, 'past_due');

  const invented = subscriptionToProposal(sub({ status: 'quantum_superposition' }));
  assert.equal(invented.proposal, undefined);
  assert.match(invented.skip, /^unknown_status/, 'a new GHL state surfaces in the report, it is not guessed into active');
});

test('a cancelled subscription carries an end date, a live one does not', () => {
  assert.equal(subscriptionToProposal(sub({ status: 'active' })).proposal.intent.ends_at, null);
  assert.ok(subscriptionToProposal(sub({ status: 'canceled' })).proposal.intent.ends_at);
});

test('the proposal carries a source timestamp so ordering never degrades to arrival', () => {
  const p = subscriptionToProposal(sub({ updatedAt: '2026-08-02T09:00:00.000Z' })).proposal;
  assert.equal(p.occurredAt, '2026-08-02T09:00:00.000Z');
  assert.match(p.sourceEventId, /^ghl-sub-sub-mongo-1-/, 'idempotent per subscription per change');
});

test('identity is the GHL contact id, which is already the ledger key', () => {
  const p = subscriptionToProposal(sub({ contactId: 'abc123' })).proposal;
  assert.equal(p.contactId, 'abc123');
  assert.equal(p.identity.ghl_contact_id, 'abc123');
});

// ── sweeping ────────────────────────────────────────────────────────────────
test('a shadow sweep changes nothing and reports every diff', () => {
  const store = fresh();
  // The ledger record predates GHL's own last update, which is the ordinary
  // case: nobody has touched this member by hand since the subscription moved.
  assignMembership(store, 'contact-1', { key: 'free', status: 'active' },
    { now: new Date('2026-07-01T00:00:00Z') });
  setSourceState(store, 'ghl_membership', 'shadow', { now: NOW });
  const before = JSON.stringify(store.contacts);

  const run = sweep(store, [
    sub({ contactId: 'contact-1' }),
    sub({ _id: 'sub-2', contactId: 'contact-2', priceId: MEMBERSHIP_BILLING.silver.annualPriceId }),
  ], { now: NOW });

  assert.equal(run.mapped, 2);
  assert.equal(run.shadow, 2);
  assert.equal(run.applied, 0);
  assert.equal(JSON.stringify(store.contacts), before, 'not one byte changed');

  const diff = run.results[0].proposal.diff;
  assert.equal(diff.from.key, 'free');
  assert.equal(diff.to.key, 'silver');
  assert.equal(diff.changed, true);
});

test('a sweep separates what it mapped from what it skipped', () => {
  const store = fresh();
  setSourceState(store, 'ghl_membership', 'shadow', { now: NOW });
  const run = sweep(store, [
    sub(),
    sub({ _id: 's2', recurringProduct: { product: { _id: '67bb407aee6d11417bd8f459' }, price: { _id: '67bb407aee6d11a5f3d8f45c' } } }),
    sub({ _id: 's3', recurringProduct: null }),
  ], { now: NOW });
  assert.equal(run.total, 3);
  assert.equal(run.mapped, 1);
  assert.equal(run.skipped, 2);
  assert.deepEqual(run.skippedReasons, { not_a_gaia_product: 1, no_billing_ids: 1 });
});

test('an unmapped subscription can never trigger an absence ending', () => {
  const store = fresh();
  setSourceState(store, 'ghl_membership', 'active', { now: NOW });
  // a member the sweep established
  sweep(store, [sub({ contactId: 'contact-1' })], { now: NOW });
  assert.equal(store.contacts['contact-1'].membership.key, 'silver');

  // the next sweep sees only Next Level records — nothing of ours
  const later = new Date(NOW.getTime() + 3600000);
  const run = sweep(store, [
    sub({ _id: 'nl', contactId: 'contact-9', recurringProduct: { product: { _id: '67bb407aee6d11417bd8f459' }, price: { _id: '67bb407aee6d11a5f3d8f45c' } } }),
  ], { now: later });

  assert.equal(run.mapped, 0);
  assert.equal(store.contacts['contact-1'].membership.status, 'cancelled',
    'a genuinely empty Gaia set does end the membership it established');
  assert.equal(run.absences, 1);
});

test('re-running an unchanged sweep is idempotent', () => {
  const store = fresh();
  setSourceState(store, 'ghl_membership', 'active', { now: NOW });
  const first = sweep(store, [sub()], { now: NOW });
  assert.equal(first.applied, 1);
  const second = sweep(store, [sub()], { now: NOW });
  assert.equal(second.applied, 0, 'the same subscription at the same version applies once');
  assert.equal(second.results[0].reason, 'duplicate_source_event');
});

test('a disabled source sweeps nothing at all', () => {
  const store = fresh();
  const run = sweep(store, [sub()], { now: NOW });
  assert.equal(run.ok, false);
  assert.equal(run.reason, 'source_disabled');
  assert.deepEqual(Object.keys(store.contacts), []);
});

test('paging stops when a short page arrives', async () => {
  const pages = [Array.from({ length: 100 }, (_, i) => sub({ _id: `a${i}` })), [sub({ _id: 'b1' })]];
  let calls = 0;
  const all = await fetchSubscriptions(async ({ offset }) => { calls += 1; return pages[offset / 100] || []; });
  assert.equal(all.length, 101);
  assert.equal(calls, 2);
});

test('every status GHL is known to emit has an explicit mapping', () => {
  for (const observed of ['active', 'trialing', 'canceled', 'incomplete_expired', 'past_due']) {
    assert.ok(STATUS_MAP[observed], `${observed} was seen in live data and must map`);
  }
});

test('an older GHL record never overrides a newer operator decision', () => {
  // Found while writing these tests, and worth pinning: ordering compares the
  // subscription's own updatedAt against whatever last wrote the resource. An
  // operator acting today outranks a subscription that last changed weeks ago,
  // so a sweep cannot quietly undo this morning's correction. In shadow this
  // shows as a rejection rather than a diff, which is the honest answer —
  // it is what the active adapter would also do.
  const store = fresh();
  assignMembership(store, 'contact-1', { key: 'diamond', status: 'active' }, { now: NOW });
  setSourceState(store, 'ghl_membership', 'active', { now: NOW });

  const run = sweep(store, [sub({ contactId: 'contact-1', updatedAt: '2026-08-01T10:00:00.000Z' })], { now: NOW });
  assert.equal(run.applied, 0);
  assert.equal(run.results[0].reason, 'stale_timestamp');
  assert.equal(store.contacts['contact-1'].membership.key, 'diamond');

  // and a subscription that genuinely changed later is believed
  const fresher = new Date('2026-08-19T00:00:00Z');
  const second = sweep(store, [sub({ contactId: 'contact-1', updatedAt: fresher.toISOString() })], { now: fresher });
  assert.equal(second.applied, 1);
  assert.equal(store.contacts['contact-1'].membership.key, 'silver');
});

test('a contact with several subscriptions yields ONE proposal, live outranking dead', () => {
  // The live account has a contact with an active Diamond and two cancelled
  // Diamonds created the same day. Per-subscription proposals would race, and
  // whichever GHL touched last would win — today that is the active one, but
  // only by luck. Collapsing per contact removes the coin flip entirely.
  const contact = 'multi-1';
  const list = [
    sub({ _id: 'live', contactId: contact, status: 'active', updatedAt: '2026-03-19T10:47:39.520Z',
      recurringProduct: { product: { _id: MEMBERSHIP_BILLING.diamond.ghlProductId }, price: { _id: MEMBERSHIP_BILLING.diamond.monthlyPriceId } } }),
    sub({ _id: 'dead1', contactId: contact, status: 'canceled', updatedAt: '2026-09-01T00:00:00.000Z',
      recurringProduct: { product: { _id: MEMBERSHIP_BILLING.diamond.ghlProductId }, price: { _id: MEMBERSHIP_BILLING.diamond.monthlyPriceId } } }),
  ];

  const proposals = contactProposals(list);
  assert.equal(proposals.length, 1, 'one member, one membership');
  assert.equal(proposals[0].intent.status, 'active',
    'a cancelled record touched more recently must not cancel a live member');
  assert.equal(proposals[0].evidence.subscriptionsConsidered, 2);

  const store = fresh();
  setSourceState(store, 'ghl_membership', 'active', { now: NOW });
  sweep(store, list, { now: NOW });
  assert.equal(store.contacts[contact].membership.status, 'active');
  assert.equal(store.contacts[contact].membership.key, 'diamond');
});

test('the adapter and the live member read agree by construction', () => {
  // Both call membershipFromSubscriptions, so they cannot drift apart. This is
  // the property controlled activation depends on: what the sweep writes is
  // exactly what the member was already seeing.
  const list = [
    sub({ _id: 'a', contactId: 'c', status: 'canceled', updatedAt: '2026-08-05T00:00:00Z' }),
    sub({ _id: 'b', contactId: 'c', status: 'active', updatedAt: '2026-08-01T00:00:00Z',
      priceId: MEMBERSHIP_BILLING.silver.annualPriceId }),
  ];
  const proposed = contactProposals(list)[0].intent;
  const seen = resolveMemberAccess({ subscriptions: list, now: NOW }).membership;
  assert.equal(proposed.key, seen.key);
  assert.equal(proposed.status, seen.status);
  assert.equal(proposed.billing_cycle, seen.billing_cycle);
});
