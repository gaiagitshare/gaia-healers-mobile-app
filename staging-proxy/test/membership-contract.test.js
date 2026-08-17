/**
 * Membership Phase 1 contract tests.
 *
 * These encode the rules the read model must never break — above all that a
 * legacy tag, a product name or a price can never become paid access. Run with:
 *   node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MEMBERSHIP_KEYS, MEMBERSHIP_BILLING, UNRESOLVED_BILLING_IDS,
  normalizeMembershipKey, tierFromBillingIds, isDeprecatedBillingId,
} from '../membership/config.js';
import {
  normalizeMembership, normalizeEntitlement, migrateStore, migrateContactRecord,
  upsertEntitlement, setMembership, emptyContactRecord,
} from '../membership/ledger.js';
import { resolveMemberAccess } from '../membership/resolver.js';
import { buildFixtures } from '../membership/fixtures.js';

const NOW = new Date('2026-08-17T18:00:00Z');
const now = NOW;
const here = path.dirname(fileURLToPath(import.meta.url));

const fixtures = buildFixtures({ now: NOW.getTime() });
const resolveFixture = (id, extra = {}) => resolveMemberAccess({
  record: fixtures.store.contacts[id],
  subscriptions: fixtures.subscriptionsByContact[id],
  tags: fixtures.store.contacts[id]?.tags || [],
  now: NOW,
  ...extra,
});

const subscriptionWith = (fields) => ({ _id: 'sub_test', status: 'active', updatedAt: NOW.toISOString(), ...fields });

// ── 1. canonical keys ───────────────────────────────────────────────────────
test('1. all four canonical membership keys serialize correctly', () => {
  assert.deepEqual(MEMBERSHIP_KEYS, ['free', 'silver', 'gold', 'diamond']);
  for (const key of MEMBERSHIP_KEYS) {
    const membership = normalizeMembership({ key, status: 'active', source: 'fixture' }, { now });
    assert.equal(membership.key, key);
    assert.equal(membership.status, 'active');
  }
});

// ── 2. unknown keys ─────────────────────────────────────────────────────────
test('2. unknown membership keys never silently promote', () => {
  for (const bogus of ['bronze', 'platinum', 'GOLD ', 'gold-plus', '', null, 'admin']) {
    const membership = normalizeMembership({ key: bogus, status: 'active', source: 'manual' }, { now });
    if (bogus === 'GOLD ') { assert.equal(membership.key, 'gold'); continue; } // trimmed/lowercased is fine
    assert.equal(membership.key, null, `${bogus} must not become a tier`);
    assert.equal(membership.status, 'none');
  }
  assert.equal(normalizeMembershipKey('platinum'), null);
  assert.equal(normalizeMembershipKey('bronze'), null);
});

// ── 3. THE mandatory one ────────────────────────────────────────────────────
test('3. legacy ahc-gold-active alone does NOT produce Gold membership', () => {
  const resolved = resolveMemberAccess({
    record: { contactId: 'c1', entitlements: [] },
    subscriptions: [],
    tags: ['ahc-gold-active', 'ahc-gold-trial'],
    now,
  });
  assert.equal(resolved.membership.key, null);
  assert.equal(resolved.membership.status, 'none');
  assert.deepEqual(resolved.meta.legacy_membership_tags, ['ahc-gold-active', 'ahc-gold-trial']);
  assert.ok(resolved.meta.notes.some((n) => /legacy membership tags present but ignored/.test(n)));
});

test('4. legacy ahc-silver-active alone does NOT produce Silver billing membership', () => {
  const resolved = resolveMemberAccess({
    record: null, subscriptions: [], tags: ['ahc-silver-active', 'membership_silver'], now,
  });
  assert.equal(resolved.membership.key, null);
  assert.equal(resolved.membership.status, 'none');
});

// ── 5. authoritative billing ────────────────────────────────────────────────
test('5. canonical subscription ids produce the correct membership key and cycle', () => {
  for (const [key, map] of Object.entries(MEMBERSHIP_BILLING)) {
    const monthly = resolveMemberAccess({
      subscriptions: [subscriptionWith({ priceId: map.monthlyPriceId })], now,
    });
    assert.equal(monthly.membership.key, key);
    assert.equal(monthly.membership.billing_cycle, 'monthly');
    assert.equal(monthly.meta.membership_resolved_by, 'billing_id');

    const annual = resolveMemberAccess({
      subscriptions: [subscriptionWith({ priceId: map.annualPriceId })], now,
    });
    assert.equal(annual.membership.key, key);
    assert.equal(annual.membership.billing_cycle, 'annual');

    const stripe = resolveMemberAccess({
      subscriptions: [subscriptionWith({ nested: { deep: { id: map.stripeMonthlyPriceId } } })], now,
    });
    assert.equal(stripe.membership.key, key, 'stripe ids must resolve too');
  }
});

// ── 6/7. Free requires explicit evidence ────────────────────────────────────
test('6. Free membership requires explicit Free evidence', () => {
  const resolved = resolveFixture('fixture-free');
  assert.equal(resolved.membership.key, 'free');
  assert.equal(resolved.membership.status, 'active');
  assert.match(resolved.meta.membership_resolved_by, /^ledger:/);
});

test('7. an arbitrary contact does NOT become Free', () => {
  const bare = resolveMemberAccess({ record: emptyContactRecord('contact-123'), subscriptions: [], tags: [], now });
  assert.equal(bare.membership.key, null);
  assert.equal(bare.membership.status, 'none');

  const noMembership = resolveFixture('fixture-no-membership');
  assert.equal(noMembership.membership.key, null, 'no-membership fixture must not become Free');
  assert.equal(noMembership.membership.status, 'none');
});

// ── 8-12. rights are independent ────────────────────────────────────────────
test('8. lifetime course stays active after membership cancellation', () => {
  const resolved = resolveFixture('fixture-cancelled-gold');
  assert.equal(resolved.membership.status, 'cancelled');
  const course = resolved.entitlements.find((e) => e.type === 'course_access');
  assert.equal(course.status, 'active', 'a paid lifetime course outlives the subscription');
  assert.equal(course.expires_at, null);
});

test('9. a revoked course stays revoked even when the tier would include it', () => {
  const resolved = resolveFixture('fixture-revoked-course');
  assert.equal(resolved.membership.key, 'silver');
  const course = resolved.entitlements.find((e) => e.type === 'course_access');
  assert.equal(course.status, 'revoked');
  assert.ok(!resolved.sections.some((s) => s.type === 'course_access'),
    'a revoked course must not be counted as available access');
});

test('10. device ownership survives membership cancellation', () => {
  const record = {
    contactId: 'c-dev',
    membership: { key: 'gold', status: 'cancelled', ends_at: '2026-08-07T00:00:00Z', source: 'manual' },
    entitlements: [{
      type: 'device_owner', key: 'biowell-3', status: 'active', source: 'fixture',
      starts_at: '2025-01-01T00:00:00Z', expires_at: null, observed_at: NOW.toISOString(),
    }],
  };
  const resolved = resolveMemberAccess({ record, subscriptions: [], now });
  assert.equal(resolved.membership.status, 'cancelled');
  assert.equal(resolved.entitlements.find((e) => e.type === 'device_owner').status, 'active');
});

test('11. expired device software does not revoke device ownership', () => {
  const resolved = resolveFixture('fixture-expired-entitlement');
  const owner = resolved.entitlements.find((e) => e.type === 'device_owner');
  const software = resolved.entitlements.find((e) => e.type === 'device_software');
  assert.equal(owner.status, 'active');
  assert.equal(software.status, 'expired', 'past expiry is computed, not trusted from the record');
});

test('12. an event ticket is independent of membership', () => {
  const record = {
    contactId: 'c-ticket', membership: null,
    entitlements: [{
      type: 'event_ticket', key: 'evt-1', value: { name: 'Elevate' }, status: 'active',
      source: 'fixture', expires_at: null, observed_at: NOW.toISOString(),
    }],
  };
  const resolved = resolveMemberAccess({ record, subscriptions: [], now });
  assert.equal(resolved.membership.key, null, 'no membership');
  assert.equal(resolved.entitlements[0].status, 'active', 'ticket still valid');
});

// ── 18/19. degraded and stale ───────────────────────────────────────────────
test('18. meta.degraded and meta.stale behave correctly', () => {
  const fresh = resolveFixture('fixture-gold-annual');
  assert.equal(fresh.meta.stale, false);
  assert.equal(fresh.meta.degraded, false);

  const stale = resolveFixture('fixture-degraded-stale');
  assert.equal(stale.meta.stale, true);
  assert.equal(stale.meta.degraded, true);
  assert.ok(stale.meta.ledger_observed_at, 'the age of the data must be exposed');
});

test('19. stale data is never presented as freshly authoritative, and an unavailable source is not a revocation', () => {
  const degraded = resolveFixture('fixture-gold-annual', { sourceError: true });
  assert.equal(degraded.meta.degraded, true);
  assert.equal(degraded.membership.key, 'gold', 'access is not withdrawn because a source was unreachable');
  assert.ok(degraded.meta.notes.some((n) => /not a revocation/.test(n)));

  const stale = resolveFixture('fixture-degraded-stale');
  assert.notEqual(stale.meta.ledger_observed_at, null);
  assert.equal(stale.meta.resolved_from, 'ledger');
});

// ── 20. unknown entitlement types ───────────────────────────────────────────
test('20. unknown entitlement types fail safe', () => {
  const record = {
    contactId: 'c-unknown',
    entitlements: [
      { type: 'course_access', key: 'ok', status: 'active', source: 'ghl_offer', observed_at: NOW.toISOString() },
      { type: 'teleport_access', key: 'mars', status: 'active', source: 'manual', observed_at: NOW.toISOString() },
    ],
  };
  const resolved = resolveMemberAccess({ record, subscriptions: [], now });
  assert.equal(resolved.entitlements.length, 1, 'unknown types are withheld from rendering');
  assert.equal(resolved.entitlements[0].type, 'course_access');
  assert.deepEqual(resolved.meta.quarantined_entitlements, [{ type: 'teleport_access', key: 'mars' }]);
  assert.ok(!resolved.sections.some((s) => s.type === 'teleport_access'));
});

// ── 21/22. fixture isolation ────────────────────────────────────────────────
test('21. fixtures can never be written into a production ledger', () => {
  const store = { version: 2, contacts: {}, processedWebhookIds: [] };
  assert.throws(
    () => upsertEntitlement(store, 'fixture-gold', { type: 'course_access', key: 'x', status: 'active' }, { now }),
    /refusing to write fixture contact/,
  );
  assert.throws(
    () => setMembership(store, 'fixture-gold', { key: 'gold', status: 'active' }, { now }),
    /refusing to write fixture contact/,
  );
  assert.deepEqual(Object.keys(store.contacts), [], 'nothing was written');

  // and with the explicit fixture flag it is allowed, into a separate store
  const fixtureStore = { version: 2, contacts: {}, processedWebhookIds: [] };
  upsertEntitlement(fixtureStore, 'fixture-gold', { type: 'course_access', key: 'x', status: 'active' }, { now, allowFixtures: true });
  assert.equal(Object.keys(fixtureStore.contacts).length, 1);
});

test('22. migration flags fixture ids found in a production store instead of adopting them', () => {
  const dirty = {
    version: 1,
    contacts: {
      'real-1': { contactId: 'real-1', courses: [{ id: 'c1', name: 'Course 1' }] },
      'fixture-gold': { contactId: 'fixture-gold', courses: [] },
    },
    processedWebhookIds: ['w1'],
  };
  const { store, report } = migrateStore(dirty, { now });
  assert.deepEqual(report.fixturesSkipped, ['fixture-gold']);
  assert.ok(store.contacts['fixture-gold'], 'preserved, not deleted');
  assert.equal(store.contacts['fixture-gold'].ledgerVersion, undefined, 'and not migrated into the ledger schema');
});

// ── 23/24/25. no name, price or regex based access ──────────────────────────
test('23. product-name matching does not grant membership', () => {
  const nameOnly = resolveMemberAccess({
    subscriptions: [subscriptionWith({ productName: 'Gaia Healers 2.0 CRM Gold', entityId: 'deadbeefdeadbeefdeadbeef' })],
    now,
  });
  assert.equal(nameOnly.membership.key, null, 'a name that says Gold is not evidence');
  assert.equal(nameOnly.meta.unmapped_subscriptions.length, 1);

  // and when a canonical id IS present, the id decides — not the name
  const conflicting = resolveMemberAccess({
    subscriptions: [subscriptionWith({
      productName: 'Gaia Healers 2.0 CRM Gold',
      priceId: MEMBERSHIP_BILLING.silver.monthlyPriceId,
    })],
    now,
  });
  assert.equal(conflicting.membership.key, 'silver', 'canonical id beats the name');
});

test('24. price amount never determines membership', () => {
  for (const amount of [97, 497, 997, 4997, 9997]) {
    const resolved = resolveMemberAccess({
      subscriptions: [subscriptionWith({ amount, currency: 'usd', entityId: 'deadbeefdeadbeefdeadbeef' })], now,
    });
    assert.equal(resolved.membership.key, null, `$${amount} must not imply a tier`);
  }
  // the same canonical id resolves identically whatever the amount says
  const cheap = resolveMemberAccess({ subscriptions: [subscriptionWith({ priceId: MEMBERSHIP_BILLING.gold.monthlyPriceId, amount: 1 })], now });
  const dear = resolveMemberAccess({ subscriptions: [subscriptionWith({ priceId: MEMBERSHIP_BILLING.gold.monthlyPriceId, amount: 999999 })], now });
  assert.equal(cheap.membership.key, 'gold');
  assert.equal(dear.membership.key, 'gold');
});

test('25. the resolver contains no tier-name regex matching', () => {
  for (const file of ['resolver.js', 'config.js', 'ledger.js']) {
    const source = fs.readFileSync(path.join(here, '..', 'membership', file), 'utf8');
    const regexLiterals = source.match(/\/[^/\n*][^/\n]*\/[gimsuy]*/g) || [];
    for (const literal of regexLiterals) {
      assert.ok(
        !/(gold|silver|diamond|bronze|platinum)/i.test(literal),
        `${file} must not match tier names by regex: ${literal}`,
      );
    }
  }
});

// ── deprecated ids and the unresolved Diamond product ───────────────────────
test('deprecated price-mapping ids are recognised and never resolve a tier', () => {
  for (const bad of ['69177f9c1bdd94edd9e837ad', '691cbb5259384859b30a8231', '691cbd1e48ca08990aa1ebbc']) {
    assert.equal(isDeprecatedBillingId(bad), true);
    assert.equal(tierFromBillingIds([bad]), null, 'a deprecated mapping id must not identify a product');
  }
});

test('the unresolved second Diamond Stripe product cannot grant Diamond', () => {
  const unresolved = UNRESOLVED_BILLING_IDS.map((item) => item.id);
  assert.ok(unresolved.includes('prod_TRnOnug03GBUhM'));
  const resolved = resolveMemberAccess({
    subscriptions: [subscriptionWith({ stripeProductId: 'prod_TRnOnug03GBUhM' })], now,
  });
  assert.equal(resolved.membership.key, null);
});

// ── migration behaviour ─────────────────────────────────────────────────────
test('migration is additive, preserves course history and is idempotent', () => {
  const original = {
    version: 1,
    contacts: {
      'c-1': {
        contactId: 'c-1',
        tags: ['product_biowell_owner'],
        tier: { name: 'Gold', matchedBy: 'webhook:tier' },
        courses: [{ id: 'offer-1', name: 'Bio-Well Advanced Level 1', updatedAt: '2026-08-01T00:00:00Z' }],
        communities: [{ id: 'grp-1', name: 'Bio-Well Practitioners', updatedAt: '2026-08-01T00:00:00Z' }],
        subscriptions: [{ id: 'sub-1', status: 'active' }],
        domainUpdatedAt: { courses: '2026-08-01T00:00:00Z' },
        updatedAt: '2026-08-01T00:00:00Z',
      },
    },
    processedWebhookIds: ['hook-1', 'hook-2'],
    updatedAt: '2026-08-01T00:00:00Z',
  };
  const first = migrateStore(structuredClone(original), { now });
  const record = first.store.contacts['c-1'];

  // nothing lost
  assert.deepEqual(record.courses, original.contacts['c-1'].courses);
  assert.deepEqual(record.communities, original.contacts['c-1'].communities);
  assert.deepEqual(record.subscriptions, original.contacts['c-1'].subscriptions);
  assert.deepEqual(record.tags, original.contacts['c-1'].tags);
  assert.deepEqual(record.tier, original.contacts['c-1'].tier, 'legacy tier field preserved for diagnostics');
  assert.deepEqual(first.store.processedWebhookIds, ['hook-1', 'hook-2'], 'idempotency state preserved');

  // derived additively, with honest sources
  const course = record.entitlements.find((e) => e.type === 'course_access');
  assert.equal(course.key, 'offer-1');
  assert.equal(course.source, 'ghl_offer');
  const community = record.entitlements.find((e) => e.type === 'community_access');
  assert.equal(community.source, 'ghl_group');

  // membership is NOT invented from the legacy tier field
  assert.equal(record.membership, null, 'migration must not turn a legacy tier tag into a membership');

  // repeatable
  const second = migrateStore(structuredClone(first.store), { now });
  assert.equal(second.report.changed, 0, 'a second migration changes nothing');
  assert.deepEqual(second.store.contacts['c-1'].entitlements, record.entitlements);
});

test('a record that cannot be migrated is preserved and reported, not guessed at', () => {
  const broken = { version: 1, contacts: { 'c-bad': null }, processedWebhookIds: [] };
  const { store, report } = migrateStore(broken, { now });
  assert.equal(report.total, 1);
  assert.ok(store.contacts['c-bad'] === null || store.contacts['c-bad'], 'record preserved as-is');
});

// ── every fixture profile resolves ──────────────────────────────────────────
test('all 14 synthetic profiles resolve to their intended state', () => {
  const expected = {
    'fixture-free': ['free', 'active'],
    'fixture-silver-monthly': ['silver', 'active'],
    'fixture-gold-annual': ['gold', 'active'],
    'fixture-diamond': ['diamond', 'active'],
    'fixture-cancelled-gold': ['gold', 'cancelled'],
    'fixture-expired-entitlement': ['silver', 'active'],
    'fixture-lifetime-course': ['free', 'active'],
    'fixture-revoked-course': ['silver', 'active'],
    'fixture-device-owner': ['free', 'active'],
    'fixture-expiring-software': ['gold', 'active'],
    'fixture-partial-leads': ['gold', 'active'],
    'fixture-upgrade-available': ['silver', 'active'],
    'fixture-degraded-stale': ['gold', 'active'],
    'fixture-no-membership': [null, 'none'],
  };
  assert.equal(Object.keys(expected).length, 14);
  for (const [id, [key, status]] of Object.entries(expected)) {
    const resolved = resolveFixture(id);
    assert.equal(resolved.membership.key, key, `${id} key`);
    assert.equal(resolved.membership.status, status, `${id} status`);
  }
});

test('gold annual exposes a partially delivered lead allocation and an upgrade path', () => {
  const resolved = resolveFixture('fixture-gold-annual');
  const leads = resolved.entitlements.find((e) => e.type === 'lead_allocation');
  assert.deepEqual(leads.value, { monthly: 5, delivered: 3, period: '2026-08' });
  assert.equal(resolved.upgrade.next_key, 'diamond');
  assert.ok(resolved.upgrade.gains.length > 0);
});

test('upgrade path from silver points at gold', () => {
  const resolved = resolveFixture('fixture-upgrade-available');
  assert.equal(resolved.upgrade.next_key, 'gold');
});

test('software expiring in 14 days is still active', () => {
  const resolved = resolveFixture('fixture-expiring-software');
  const software = resolved.entitlements.find((e) => e.type === 'device_software');
  assert.equal(software.status, 'active');
  assert.ok(Date.parse(software.expires_at) > NOW.getTime());
});

test('presentation labels are attached but are not the authorization key', () => {
  const resolved = resolveFixture('fixture-gold-annual');
  assert.equal(resolved.membership.key, 'gold');
  assert.equal(resolved.membership.label, 'Gold');
  assert.equal(resolved.membership.subtitle, 'Gaia Practice Pro');
});
