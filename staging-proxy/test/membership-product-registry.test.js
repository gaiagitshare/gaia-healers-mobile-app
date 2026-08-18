/**
 * The canonical product registry, and the placeholder-identity rule.
 *
 * Both exist because of specific things found in the live account: one device
 * answering to seventeen GHL ids and sixteen Shopify products, and $37,826 of
 * counter sales attached to a generated contact. These tests pin the behaviour
 * that stops either from becoming access.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyRegistry, observeProduct, mapProduct, entitlementsForPurchase,
  registryHealth, PURCHASABLE_TYPES,
} from '../membership/product-registry.js';
import { resolveIdentity, placeholderReason } from '../membership/identity.js';
import { ingest } from '../membership/proposals.js';
import { setSourceState } from '../membership/sources.js';
import { grantEntitlement } from '../membership/admin-ops.js';

const NOW = new Date('2026-08-18T12:00:00Z');
const fresh = () => ({ version: 2, contacts: {}, processedWebhookIds: [], auditLog: [] });

// ── the registry ────────────────────────────────────────────────────────────
test('an observed product grants nothing until a person maps it', () => {
  const registry = emptyRegistry();
  observeProduct(registry, { system: 'ghl', externalId: '6480f94660c6b7ac09684b97', title: 'Bio-Well 3.0', orders: 36, customers: 36 });

  const mapping = registry.mappings['ghl:6480f94660c6b7ac09684b97'];
  assert.equal(mapping.canonical, null, 'discovery is not classification');
  assert.equal(mapping.confidence, 'needs_review');

  const result = entitlementsForPurchase(registry, { system: 'ghl', externalId: '6480f94660c6b7ac09684b97' });
  assert.deepEqual(result.entitlements, []);
  assert.equal(result.reason, 'unmapped_product');
});

test('mapping to a canonical product makes the purchase meaningful', () => {
  const registry = emptyRegistry();
  observeProduct(registry, { system: 'ghl', externalId: 'p1', title: 'Bio-Well 3.0', orders: 36 });
  const mapped = mapProduct(registry, { system: 'ghl', externalId: 'p1', canonical: 'biowell-3' });
  assert.equal(mapped.ok, true);

  const result = entitlementsForPurchase(registry, { system: 'ghl', externalId: 'p1' });
  assert.deepEqual(result.entitlements, [{ type: 'device_owner', key: 'biowell-3' }]);
});

test('seventeen external ids collapse to one canonical product', () => {
  const registry = emptyRegistry();
  const ghlIds = ['6480f94660c6b7ac09684b97', '69bdc40cf1e32d1f6b4418cd', '6a18a936a8f99dc2ec560568'];
  const shopifyIds = ['8337764876575', '8337759011103'];
  for (const id of ghlIds) observeProduct(registry, { system: 'ghl', externalId: id, title: 'Bio-Well variant', orders: 5 });
  for (const id of shopifyIds) observeProduct(registry, { system: 'shopify', externalId: id, title: 'Bio-Well variant', orders: 3 });
  for (const id of ghlIds) mapProduct(registry, { system: 'ghl', externalId: id, canonical: 'biowell-3' });
  for (const id of shopifyIds) mapProduct(registry, { system: 'shopify', externalId: id, canonical: 'biowell-3' });

  for (const id of [...ghlIds]) {
    assert.deepEqual(entitlementsForPurchase(registry, { system: 'ghl', externalId: id }).entitlements,
      [{ type: 'device_owner', key: 'biowell-3' }], 'every id yields the same right');
  }
  const health = registryHealth(registry);
  const cluster = health.clusters.find((c) => c.canonical === 'biowell-3');
  assert.equal(cluster.external.length, 5, 'the cluster spans both platforms');
  assert.equal(cluster.systems.ghl, 3);
  assert.equal(cluster.systems.shopify, 2);
});

test('a canonical key is a Gaia identity, never an external product id', () => {
  const registry = emptyRegistry();
  observeProduct(registry, { system: 'ghl', externalId: 'p1', title: 'x' });
  const bad = mapProduct(registry, { system: 'ghl', externalId: 'p1', canonical: '6480f94660c6b7ac09684b97' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unknown_canonical_product');
});

test('a purchase can NEVER produce a software licence', () => {
  const registry = emptyRegistry();
  observeProduct(registry, { system: 'shopify', externalId: '8337764876575', title: 'Bio-Well 3.0', orders: 1 });
  mapProduct(registry, { system: 'shopify', externalId: '8337764876575', canonical: 'biowell-3' });

  const result = entitlementsForPurchase(registry, { system: 'shopify', externalId: '8337764876575' });
  assert.ok(!result.entitlements.some((e) => e.type === 'device_software'),
    'marketing copy saying software is included is not a licence');
  const withheld = result.withheld.find((w) => w.type === 'device_software');
  assert.equal(withheld.state, 'vendor_evidence', 'and the reason is stated, not hidden');

  assert.ok(!PURCHASABLE_TYPES.includes('device_software'),
    'structurally excluded, not merely absent from the seed data');
});

test('an undecided business rule withholds rather than guesses', () => {
  const registry = emptyRegistry();
  observeProduct(registry, { system: 'ghl', externalId: 'p1', title: 'Bio-Well 3.0' });
  mapProduct(registry, { system: 'ghl', externalId: 'p1', canonical: 'biowell-3' });
  const result = entitlementsForPurchase(registry, { system: 'ghl', externalId: 'p1' });

  assert.ok(!result.entitlements.some((e) => e.type === 'promo_membership'),
    'promotional Gold is not granted while its duration is undecided');
  assert.equal(result.withheld.find((w) => w.type === 'promo_membership').state, 'policy_decision');
});

test('a mapping awaiting review grants nothing even once it points somewhere', () => {
  const registry = emptyRegistry();
  observeProduct(registry, { system: 'ghl', externalId: 'p1', title: 'Custom Item', orders: 1 });
  mapProduct(registry, { system: 'ghl', externalId: 'p1', canonical: 'biowell-3', confidence: 'needs_review' });
  const result = entitlementsForPurchase(registry, { system: 'ghl', externalId: 'p1' });
  assert.deepEqual(result.entitlements, []);
  assert.equal(result.reason, 'awaiting_review');
});

test('unmapping a product silences it again', () => {
  const registry = emptyRegistry();
  observeProduct(registry, { system: 'ghl', externalId: 'p1', title: 'Bio-Well 3.0' });
  mapProduct(registry, { system: 'ghl', externalId: 'p1', canonical: 'biowell-3' });
  mapProduct(registry, { system: 'ghl', externalId: 'p1', canonical: null });
  assert.deepEqual(entitlementsForPurchase(registry, { system: 'ghl', externalId: 'p1' }).entitlements, []);
});

test('re-observing a product never resets a decision someone made', () => {
  const registry = emptyRegistry();
  observeProduct(registry, { system: 'ghl', externalId: 'p1', title: 'Bio-Well 3.0', orders: 10 });
  mapProduct(registry, { system: 'ghl', externalId: 'p1', canonical: 'biowell-3', note: 'confirmed with Nima' });
  observeProduct(registry, { system: 'ghl', externalId: 'p1', title: 'Bio-Well 3.0 (renamed)', orders: 12 });

  const mapping = registry.mappings['ghl:p1'];
  assert.equal(mapping.canonical, 'biowell-3', 'a rescan must not undo an operator');
  assert.equal(mapping.confidence, 'confirmed');
  assert.equal(mapping.orders, 12, 'but the counts do refresh');
});

test('health triages by what actually sold', () => {
  const registry = emptyRegistry();
  observeProduct(registry, { system: 'ghl', externalId: 'big', title: 'Conference Exhibit Pass', orders: 603, customers: 544 });
  observeProduct(registry, { system: 'ghl', externalId: 'small', title: 'Custom Item', orders: 1 });
  observeProduct(registry, { system: 'ghl', externalId: 'done', title: 'Bio-Well 3.0', orders: 36 });
  mapProduct(registry, { system: 'ghl', externalId: 'done', canonical: 'biowell-3' });

  const health = registryHealth(registry);
  assert.equal(health.total, 3);
  assert.equal(health.mapped, 1);
  assert.equal(health.unmapped, 2);
  assert.equal(health.ordersCovered, 36);
  assert.equal(health.ordersUncovered, 604);
  assert.equal(health.priority[0].externalId, 'big', 'the 603-order product is triaged first');
});

// ── the placeholder rule ────────────────────────────────────────────────────
test('the point-of-sale placeholder is recognised by id and by email', () => {
  assert.equal(placeholderReason({ ghl_contact_id: '5oIseYl3sDBKZm9vtxHf' }), 'placeholder_contact');
  assert.equal(placeholderReason({ email: 'auto.generated@pos.payment' }), 'placeholder_email');
  assert.equal(placeholderReason({ email: 'AUTO.GENERATED@POS.PAYMENT' }), 'placeholder_email');
  assert.equal(placeholderReason({ email: 'real.person@gmail.com' }), null);
  assert.equal(placeholderReason({ ghl_contact_id: 'someone-real' }), null);
});

test('a placeholder resolves to nobody even though it is a valid contact', () => {
  const store = fresh();
  store.contacts['5oIseYl3sDBKZm9vtxHf'] = { contactId: '5oIseYl3sDBKZm9vtxHf', entitlements: [] };
  const resolved = resolveIdentity(store, { ghl_contact_id: '5oIseYl3sDBKZm9vtxHf' });
  assert.equal(resolved.contactId, null, 'being a real ledger key is not enough — it is not a person');
  assert.equal(resolved.confidence, 'unresolved');
});

test('an adapter cannot grant a device to the placeholder, even handed the id', () => {
  const store = fresh();
  setSourceState(store, 'shopify', 'active', { now: NOW });
  const result = ingest(store, {
    source: 'shopify',
    intentType: 'entitlement',
    contactId: '5oIseYl3sDBKZm9vtxHf',          // supplied outright, bypassing resolution
    identity: { email: 'auto.generated@pos.payment' },
    sourceEventId: 'pos-order-1',
    occurredAt: NOW.toISOString(),
    intent: { type: 'device_owner', key: 'biowell-3', status: 'active' },
  }, { now: NOW });

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'placeholder_contact');
  assert.equal(store.contacts['5oIseYl3sDBKZm9vtxHf'], undefined,
    'the phantom contact must not accumulate every device sold at a counter');
  assert.equal(store.unresolved.length, 1, 'and the order is kept for a human to attribute');
});

test('an operator can still act on a placeholder by hand', () => {
  const store = fresh();
  const result = grantEntitlement(store, '5oIseYl3sDBKZm9vtxHf',
    { type: 'device_owner', key: 'biowell-3' },
    { now: NOW, note: 'walk-in sale, buyer identified from the paper receipt' });
  assert.equal(result.ok, true,
    'resolving these by hand is exactly how they are meant to be fixed');
});
