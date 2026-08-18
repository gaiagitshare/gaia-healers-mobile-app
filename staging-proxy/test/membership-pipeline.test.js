/**
 * The ingestion pipeline — proposals, precedence, shadow mode and the two
 * source semantics.
 *
 * The whole point of this phase is that a future GHL or Shopify adapter needs
 * no new machinery, so every one of these tests runs entirely synthetically:
 * no external system, no credentials, no network. If these pass, an adapter is
 * a mapping function and nothing more.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ingest, reconcile, proposalsFor, overrideActive } from '../membership/proposals.js';
import { setSourceState, sourceSummary, getSource } from '../membership/sources.js';
import { linkIdentity, resolveIdentity, takeUnresolved } from '../membership/identity.js';
import { assignMembership, grantEntitlement, setOverride } from '../membership/admin-ops.js';
import { MEMBERSHIP_BILLING, tierFromBillingIds } from '../membership/config.js';
import { resolveMemberAccess } from '../membership/resolver.js';

const NOW = new Date('2026-08-18T12:00:00Z');
const later = (mins) => new Date(NOW.getTime() + mins * 60000);

const fresh = () => ({ version: 2, contacts: {}, processedWebhookIds: [], auditLog: [] });

/** A store with one known contact and GHL memberships switched to shadow. */
function seeded({ ghlState = 'shadow' } = {}) {
  const store = fresh();
  assignMembership(store, 'c1', { key: 'silver', status: 'active' }, { now: NOW });
  setSourceState(store, 'ghl_membership', ghlState, { now: NOW });
  return store;
}

const ghlMembership = (over = {}) => ({
  source: 'ghl_membership',
  intentType: 'membership',
  contactId: 'c1',
  sourceEventId: `ghl-${Math.abs(Math.round(Date.parse(over.occurredAt || NOW.toISOString()) / 1000))}-${over.tag || 'a'}`,
  occurredAt: later(10).toISOString(),
  intent: { key: 'gold', status: 'active', billing_cycle: 'monthly' },
  evidence: { id: 'sub_123' },
  ...over,
});

// ── admin is an adapter ─────────────────────────────────────────────────────
test('an admin assignment travels the pipeline and is recorded as a proposal', () => {
  const store = fresh();
  assignMembership(store, 'c1', { key: 'gold', status: 'active' }, { now: NOW });
  const proposals = proposalsFor(store);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].source, 'admin');
  assert.equal(proposals[0].state, 'applied');
  assert.equal(proposals[0].resource, 'membership');
  assert.equal(store.contacts.c1.membership.key, 'gold');
});

test('an active adapter produces exactly the ledger shape admin produces', () => {
  const viaAdmin = fresh();
  grantEntitlement(viaAdmin, 'c1', { type: 'course_access', key: 'offer-9', value: { name: 'X' } }, { now: NOW });

  const viaAdapter = fresh();
  setSourceState(viaAdapter, 'ghl_course', 'active', { now: NOW });
  ingest(viaAdapter, {
    source: 'ghl_course', intentType: 'entitlement', contactId: 'c1',
    sourceEventId: 'hook-1', occurredAt: NOW.toISOString(),
    intent: { type: 'course_access', key: 'offer-9', value: { name: 'X' }, status: 'active', source: 'manual', starts_at: NOW.toISOString() },
  }, { now: NOW });

  const strip = (record) => (record.entitlements || []).map((e) => ({
    type: e.type, key: e.key, value: e.value, status: e.status, source: e.source,
  }));
  assert.deepEqual(strip(viaAdapter.contacts.c1), strip(viaAdmin.contacts.c1),
    'one apply path means an adapter cannot produce a shape admin never produces');
});

// ── idempotency, ordering ───────────────────────────────────────────────────
test('a duplicate proposal is rejected, not reapplied', () => {
  const store = seeded({ ghlState: 'active' });
  const first = ingest(store, ghlMembership(), { now: NOW });
  assert.equal(first.applied, true);
  const second = ingest(store, ghlMembership(), { now: NOW });
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'duplicate_source_event');
  assert.equal(store.contacts.c1.membership.key, 'gold', 'still exactly one application');
});

test('a stale proposal cannot undo a newer one', () => {
  const store = seeded({ ghlState: 'active' });
  ingest(store, ghlMembership({ occurredAt: later(60).toISOString(), tag: 'new' }), { now: NOW });
  const stale = ingest(store, ghlMembership({
    occurredAt: later(5).toISOString(), tag: 'old',
    intent: { key: 'free', status: 'active', billing_cycle: 'none' },
  }), { now: NOW });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, 'stale_timestamp');
  assert.equal(store.contacts.c1.membership.key, 'gold');
});

// ── identity ────────────────────────────────────────────────────────────────
test('an unknown identity becomes unresolved and is kept whole for replay', () => {
  const store = seeded({ ghlState: 'active' });
  const result = ingest(store, {
    ...ghlMembership(), contactId: null,
    identity: { shopify_customer_id: 'cust-999' },
  }, { now: NOW });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'unknown_identity');
  assert.equal(store.unresolved.length, 1);
  assert.equal(store.unresolved[0].claim.shopify_customer_id, 'cust-999');
  assert.ok(store.unresolved[0].proposal, 'the whole proposal is kept, so a later link can replay it');
});

test('an ambiguous email resolves to nobody and names its candidates', () => {
  const store = seeded({ ghlState: 'active' });
  assignMembership(store, 'c2', { key: 'free' }, { now: NOW });
  linkIdentity(store, 'c1', { email: 'shared@example.test', verified: true }, NOW);
  linkIdentity(store, 'c2', { email: 'shared@example.test', verified: true }, NOW);

  const result = ingest(store, { ...ghlMembership(), contactId: null, identity: { email: 'shared@example.test' } }, { now: NOW });
  assert.equal(result.reason, 'ambiguous_identity');
  assert.deepEqual(result.proposal.candidates.sort(), ['c1', 'c2']);
  assert.equal(store.contacts.c1.membership.key, 'silver', 'nobody was guessed at');
});

test('an unverified email match is held for confirmation, never applied', () => {
  const store = seeded({ ghlState: 'active' });
  linkIdentity(store, 'c1', { email: 'maybe@example.test', verified: false, source: 'shopify' }, NOW);
  const result = ingest(store, { ...ghlMembership(), contactId: null, identity: { email: 'maybe@example.test' } }, { now: NOW });
  assert.equal(result.reason, 'identity_needs_confirmation');
  assert.deepEqual(result.proposal.candidates, ['c1']);
  assert.equal(store.contacts.c1.membership.key, 'silver');
});

test('an exact external id resolves, and one id can never point at two people', () => {
  const store = seeded({ ghlState: 'active' });
  assignMembership(store, 'c2', { key: 'free' }, { now: NOW });
  linkIdentity(store, 'c1', { field: 'shopify_customer_id', value: 'cust-1' }, NOW);

  assert.equal(resolveIdentity(store, { shopify_customer_id: 'cust-1' }).contactId, 'c1');
  const clash = linkIdentity(store, 'c2', { field: 'shopify_customer_id', value: 'cust-1' }, NOW);
  assert.equal(clash.ok, false);
  assert.equal(clash.reason, 'identity_already_linked');
});

test('linking an unresolved entry takes it off the queue', () => {
  const store = seeded({ ghlState: 'active' });
  ingest(store, { ...ghlMembership(), contactId: null, identity: { shopify_customer_id: 'cust-7' } }, { now: NOW });
  assert.equal(store.unresolved.length, 1);
  const entry = takeUnresolved(store, store.unresolved[0].id);
  assert.ok(entry);
  assert.equal(store.unresolved.length, 0);
});

// ── precedence ──────────────────────────────────────────────────────────────
test('a manual override outranks a billing proposal until it expires', () => {
  const store = seeded({ ghlState: 'active' });
  assignMembership(store, 'c1', { key: 'diamond', status: 'active' }, { now: NOW });
  setOverride(store, 'c1', { until: later(60 * 24).toISOString(), reason: 'comped for the retreat' }, { now: NOW });

  const blocked = ingest(store, ghlMembership({ tag: 'b' }), { now: NOW });
  assert.equal(blocked.applied, false);
  assert.equal(blocked.reason, 'manual_override_in_effect');
  assert.equal(store.contacts.c1.membership.key, 'diamond', 'the comp survives the sweep');

  // and once it lapses, billing is believed again
  const after = new Date(NOW.getTime() + 60 * 60 * 25 * 1000);
  const applied = ingest(store, ghlMembership({ tag: 'c', occurredAt: after.toISOString() }), { now: after });
  assert.equal(applied.applied, true);
  assert.equal(store.contacts.c1.membership.key, 'gold');
});

test('an operator can still act through an override they placed', () => {
  const store = seeded({ ghlState: 'active' });
  assignMembership(store, 'c1', { key: 'diamond' }, { now: NOW });
  setOverride(store, 'c1', { until: later(60 * 24).toISOString(), reason: 'comp' }, { now: NOW });
  const result = assignMembership(store, 'c1', { key: 'gold' }, { now: later(1) });
  assert.equal(result.ok, true, 'admin is not locked out by its own override');
  assert.equal(store.contacts.c1.membership.key, 'gold');
  assert.ok(overrideActive(store.contacts.c1.membership, later(2)), 'and the override still stands');
});

test('advisory evidence never displaces authoritative evidence', () => {
  const store = seeded({ ghlState: 'active' });
  const result = ingest(store, {
    ...ghlMembership({ tag: 'adv' }), confidence: 'advisory',
  }, { now: NOW });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'advisory_cannot_override_authoritative');
  assert.equal(store.contacts.c1.membership.key, 'silver');
});

// ── the two source semantics ────────────────────────────────────────────────
test('a snapshot sweep treats absence as an ending', () => {
  const store = fresh();
  setSourceState(store, 'ghl_membership', 'active', { now: NOW });
  // two members arrive from the snapshot source
  for (const id of ['c1', 'c2']) {
    ingest(store, {
      source: 'ghl_membership', intentType: 'membership', contactId: id,
      sourceEventId: `seed-${id}`, occurredAt: NOW.toISOString(),
      intent: { key: 'silver', status: 'active', billing_cycle: 'monthly', source: 'ghl_membership' },
    }, { now: NOW });
  }
  assert.equal(store.contacts.c2.membership.status, 'active');

  // the next sweep only sees c1
  const run = reconcile(store, {
    source: 'ghl_membership',
    observed: [{
      intentType: 'membership', contactId: 'c1', sourceEventId: 'sweep-c1',
      occurredAt: later(30).toISOString(),
      intent: { key: 'silver', status: 'active', billing_cycle: 'monthly', source: 'ghl_membership' },
    }],
    now: later(30),
  });
  assert.equal(run.ok, true);
  assert.equal(run.absences, 1);
  assert.equal(store.contacts.c2.membership.status, 'cancelled', 'gone from an authoritative set means gone');
  assert.equal(store.contacts.c1.membership.status, 'active');
});

test('a push source never has absence inferred for it', () => {
  const store = fresh();
  setSourceState(store, 'ghl_course', 'active', { now: NOW });
  ingest(store, {
    source: 'ghl_course', intentType: 'entitlement', contactId: 'c1',
    sourceEventId: 'course-1', occurredAt: NOW.toISOString(),
    intent: { type: 'course_access', key: 'offer-1', status: 'active' },
  }, { now: NOW });

  const run = reconcile(store, { source: 'ghl_course', observed: [], now: later(30) });
  assert.equal(run.ok, false);
  assert.equal(run.reason, 'absence_not_meaningful_for_event_source',
    'a webhook that never arrived looks exactly like one that was never sent');
  assert.equal(store.contacts.c1.entitlements[0].status, 'active', 'silence took nothing away');
});

test('a snapshot only ends memberships it is itself the source of', () => {
  const store = fresh();
  assignMembership(store, 'manual-1', { key: 'diamond', status: 'active' }, { now: NOW });
  setSourceState(store, 'ghl_membership', 'active', { now: NOW });
  const run = reconcile(store, { source: 'ghl_membership', observed: [], now: later(30) });
  assert.equal(run.absences, 0);
  assert.equal(store.contacts['manual-1'].membership.status, 'active',
    'a GHL sweep has nothing to say about a membership GHL never granted');
});

// ── shadow mode ─────────────────────────────────────────────────────────────
test('a shadow proposal changes nothing and reports exactly what it would change', () => {
  const store = seeded({ ghlState: 'shadow' });
  const before = JSON.stringify(store.contacts.c1);

  const result = ingest(store, ghlMembership(), { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.shadow, true);
  assert.equal(result.proposal.state, 'shadow');

  assert.equal(JSON.stringify(store.contacts.c1), before, 'not one byte of the member changed');
  const diff = result.proposal.diff;
  assert.equal(diff.changed, true);
  assert.equal(diff.from.key, 'silver');
  assert.equal(diff.to.key, 'gold');

  const kept = proposalsFor(store, { source: 'ghl_membership' });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].state, 'shadow');
});

test('a whole shadow sweep leaves the ledger byte-identical', () => {
  const store = seeded({ ghlState: 'shadow' });
  grantEntitlement(store, 'c1', { type: 'course_access', key: 'offer-2' }, { now: NOW });
  const before = JSON.stringify(store.contacts);

  reconcile(store, {
    source: 'ghl_membership',
    observed: [
      { intentType: 'membership', contactId: 'c1', sourceEventId: 's1', occurredAt: later(30).toISOString(),
        intent: { key: 'diamond', status: 'active', billing_cycle: 'annual' } },
    ],
    now: later(30),
  });
  assert.equal(JSON.stringify(store.contacts), before);
  assert.equal(getSource(store, 'ghl_membership').counters.shadow, 1);
});

test('a disabled source is refused outright', () => {
  const store = seeded({ ghlState: 'disabled' });
  const result = ingest(store, ghlMembership(), { now: NOW });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'source_disabled');
});

test('external sources ship disabled and admin cannot be switched off', () => {
  const store = fresh();
  const summary = sourceSummary(store);
  const byKey = Object.fromEntries(summary.map((s) => [s.key, s]));
  assert.equal(byKey.admin.state, 'active');
  assert.equal(byKey.admin.locked, true);
  for (const key of ['ghl_membership', 'ghl_course', 'shopify', 'vendor']) {
    assert.equal(byKey[key].state, 'disabled', `${key} must not be connected by this phase`);
  }
  assert.equal(byKey.ghl_membership.mode, 'snapshot');
  assert.equal(byKey.ghl_course.mode, 'event', 'GHL exposes no API to read courses back');
  assert.equal(setSourceState(store, 'admin', 'disabled').ok, false);
});

// ── failing safe ────────────────────────────────────────────────────────────
test('an unknown external product or price fails safe', () => {
  assert.equal(tierFromBillingIds(['prod_not_ours', 'price_not_ours']), null);
  const store = seeded({ ghlState: 'active' });
  const result = ingest(store, { ...ghlMembership({ tag: 'x' }), intent: { key: 'platinum', status: 'active' } }, { now: NOW });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'unknown_plan_key');
});

test('the Next Level $97 subscription can never become Silver', () => {
  // Proven against live data during the integration audit: Next Level bills
  // $97/month, exactly Silver's monthly price, on product 67bb407a…. Any rule
  // keying off amount or name would sweep 16 subscriptions into Silver.
  const nextLevelProduct = '67bb407aee6d11417bd8f459';
  const nextLevelPrice = '67bb407aee6d11a5f3d8f45c';
  assert.equal(tierFromBillingIds([nextLevelPrice, nextLevelProduct]), null);

  const silver = tierFromBillingIds([MEMBERSHIP_BILLING.silver.monthlyPriceId]);
  assert.equal(silver.key, 'silver');
  assert.equal(silver.cycle, 'monthly');

  const resolved = resolveMemberAccess({
    subscriptions: [{ id: 'sub-nl', status: 'active', priceId: nextLevelPrice, entityId: nextLevelProduct, amount: 97 }],
    now: NOW,
  });
  assert.equal(resolved.membership.key, null, 'the same price point is not the same product');
  assert.equal(resolved.meta.unmapped_subscriptions.length, 1);
});

test('a fixture id can never be written through the pipeline', () => {
  const store = seeded({ ghlState: 'active' });
  const result = ingest(store, { ...ghlMembership({ tag: 'f' }), contactId: 'fixture-gold-annual' }, { now: NOW });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'fixture_contact');
});

test('every applied proposal leaves an audit entry naming its source', () => {
  const store = seeded({ ghlState: 'active' });
  ingest(store, ghlMembership({ tag: 'audit' }), { now: NOW });
  const entry = (store.auditLog || []).filter((e) => e.source === 'ghl_membership').pop();
  assert.ok(entry, 'the source is on the record, not just "changed"');
  assert.equal(entry.action, 'membership.assign');
  assert.equal(entry.detail.from.key, 'silver');
  assert.equal(entry.detail.to.key, 'gold');
});
