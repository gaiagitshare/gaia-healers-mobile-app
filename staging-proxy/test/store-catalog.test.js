/**
 * The store shadow catalogue.
 *
 * Gaia holds the shelf; Shopify holds the till. These tests are about the sync
 * being an observation that can never destroy a decision, empty the store, or
 * turn a product into an entitlement.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyCatalog, normalizeShopifyProduct, syncCatalog, storeView, diffMessages, toCents, money,
} from '../membership/store-catalog.js';
import { emptyRegistry, observeProduct, mapProduct } from '../membership/product-registry.js';

const NOW = new Date('2026-08-18T09:00:00Z');
const LATER = new Date('2026-08-19T09:00:00Z');

/** Shaped like a real gaiahealers.com products.json entry. */
const shopifyProduct = (over = {}) => ({
  id: over.id || 8337764876575,
  handle: over.handle || 'biowell-3-0',
  title: over.title || 'Bio-Well 3.0 Energy Monitoring Device',
  body_html: '<p>The <b>Bio-Well</b> camera.</p>',
  vendor: 'Gaia Healers',
  product_type: over.product_type || '',
  tags: ['device'],
  images: [{ src: 'https://cdn.shopify.com/x.jpg' }],
  variants: [{ id: over.variantId || 45269826765087, title: 'Default', price: over.price || '2299.00', compare_at_price: over.compareAt || null, available: over.available ?? true }],
  ...over,
});

test('a Shopify product normalises to only what the storefront exposes', () => {
  const p = normalizeShopifyProduct(shopifyProduct(), { now: NOW });
  assert.equal(p.system, 'shopify');
  assert.equal(p.externalId, '8337764876575');
  assert.equal(p.priceCents, 229900);
  assert.equal(money(p.priceCents), '$2299');
  assert.equal(p.variants[0].variantId, '45269826765087', 'the variant id a future orders adapter needs');
  assert.equal(p.url, 'https://gaiahealers.com/products/biowell-3-0');
  assert.equal(p.description, 'The Bio-Well camera.', 'markup stripped, text kept');
  assert.equal(p.available, true);
});

test('availability distinguishes "out of stock" from "not stated"', () => {
  assert.equal(normalizeShopifyProduct(shopifyProduct({ available: false })).available, false);
  const unknown = normalizeShopifyProduct({
    id: 1, handle: 'h', title: 't', variants: [{ id: 2, price: '10.00' }], images: [],
  });
  assert.equal(unknown.available, null, 'silence is not a claim that it is sold out');
});

test('a first sync reports every product as new', () => {
  const { catalog, diff } = syncCatalog(emptyCatalog(), [shopifyProduct(), shopifyProduct({ id: 2, handle: 'b', title: 'Bio-Well Element', price: '5000.00' })], { now: NOW });
  assert.equal(Object.keys(catalog.products).length, 2);
  assert.equal(diff.added.length, 2);
  assert.equal(diff.priceChanged.length, 0);
  assert.equal(catalog.syncedAt, NOW.toISOString());
});

test('a price change is reported, not silently applied', () => {
  const first = syncCatalog(emptyCatalog(), [shopifyProduct()], { now: NOW });
  const second = syncCatalog(first.catalog, [shopifyProduct({ price: '2499.00' })], { now: LATER });

  assert.equal(second.diff.priceChanged.length, 1);
  assert.deepEqual(second.diff.priceChanged[0], {
    externalId: '8337764876575',
    title: 'Bio-Well 3.0 Energy Monitoring Device',
    fromCents: 229900, toCents: 249900,
  });
  const product = second.catalog.products['8337764876575'];
  assert.equal(product.priceCents, 249900, 'the store shows the current price');
  assert.equal(product.previousPriceCents, 229900, 'and remembers what it was');
  assert.match(diffMessages(second.diff)[0], /price changed .* \$2299 to \$2499/);
});

test('a product that stops appearing is kept and marked unobserved', () => {
  const first = syncCatalog(emptyCatalog(), [shopifyProduct(), shopifyProduct({ id: 2, handle: 'b', title: 'Gone' })], { now: NOW });
  const second = syncCatalog(first.catalog, [shopifyProduct()], { now: LATER });

  assert.equal(Object.keys(second.catalog.products).length, 2, 'nothing is ever deleted');
  assert.equal(second.catalog.products['2'].observed, false);
  assert.equal(second.diff.unobserved.length, 1);
  assert.match(diffMessages(second.diff)[0], /no longer appears .* kept, marked unobserved/);
});

test('one bad fetch cannot empty the store', () => {
  const first = syncCatalog(emptyCatalog(), [shopifyProduct(), shopifyProduct({ id: 2, handle: 'b', title: 'B' })], { now: NOW });
  const outage = syncCatalog(first.catalog, [], { now: LATER });
  assert.equal(Object.keys(outage.catalog.products).length, 2);
  assert.equal(outage.diff.unobserved.length, 2);

  // and the store simply shows nothing rather than showing wrong things
  const view = storeView(outage.catalog, emptyRegistry());
  assert.equal(view.sections.length, 0);

  // when Shopify recovers, the products come back and it is reported
  const recovered = syncCatalog(outage.catalog, [shopifyProduct(), shopifyProduct({ id: 2, handle: 'b', title: 'B' })], { now: LATER });
  assert.equal(recovered.diff.returned.length, 2);
  assert.equal(recovered.catalog.products['8337764876575'].observed, true);
});

test('a sync never overwrites a mapping or a curation a person made', () => {
  const first = syncCatalog(emptyCatalog(), [shopifyProduct()], { now: NOW });
  first.catalog.products['8337764876575'].canonical = 'biowell-3';
  first.catalog.products['8337764876575'].curated = { blurb: 'Our flagship camera' };
  first.catalog.products['8337764876575'].hidden = false;

  const second = syncCatalog(first.catalog, [shopifyProduct({ title: 'Bio-Well 3.0 (2027 model)' })], { now: LATER });
  const product = second.catalog.products['8337764876575'];
  assert.equal(product.canonical, 'biowell-3', 'a decision survives a rename');
  assert.deepEqual(product.curated, { blurb: 'Our flagship camera' });
  assert.equal(product.title, 'Bio-Well 3.0 (2027 model)', 'but Shopify still owns the facts');
  assert.equal(product.firstObservedAt, NOW.toISOString(), 'history is preserved');
});

// ── the shelf ───────────────────────────────────────────────────────────────
test('the store is organised by Gaia categories, not by Shopify structure', () => {
  const registry = emptyRegistry();
  const products = [
    shopifyProduct({ id: 1, handle: 'bw3', title: 'Bio-Well 3.0' }),
    shopifyProduct({ id: 2, handle: 'bwe', title: 'Bio-Well Element', price: '5000.00' }),
    shopifyProduct({ id: 3, handle: 'bp', title: 'Biopulsar Organ Package', price: '9997.00' }),
    shopifyProduct({ id: 4, handle: 'oil', title: 'Chakra Essential Oil' }),
  ];
  for (const p of products) observeProduct(registry, { system: 'shopify', externalId: String(p.id), title: p.title });
  mapProduct(registry, { system: 'shopify', externalId: '1', canonical: 'biowell-3' });
  mapProduct(registry, { system: 'shopify', externalId: '2', canonical: 'biowell-element' });
  mapProduct(registry, { system: 'shopify', externalId: '3', canonical: 'biopulsar-organ' });

  const { catalog } = syncCatalog(emptyCatalog(), products, { now: NOW });
  const view = storeView(catalog, registry);

  const biowell = view.sections.find((s) => s.key === 'devices-biowell');
  assert.equal(biowell.products.length, 2, 'two Shopify listings, one Bio-Well shelf');
  assert.equal(view.sections.find((s) => s.key === 'devices-biopulsar').products.length, 1);

  const other = view.sections.find((s) => s.key === 'other');
  assert.equal(other.products.length, 1,
    'an unclassified product is still sold, under a general heading — never hidden from the customer');
});

test('every card sends the buyer to Shopify, and Gaia never takes a payment', () => {
  const { catalog } = syncCatalog(emptyCatalog(), [shopifyProduct()], { now: NOW });
  const view = storeView(catalog, emptyRegistry());
  const card = view.sections[0].products[0];
  assert.equal(card.checkout, 'shopify');
  assert.equal(card.url, 'https://gaiahealers.com/products/biowell-3-0');
  assert.equal(card.price, '$2299');
  const serialized = JSON.stringify(view);
  assert.ok(!/card|payment|token|checkout_url|cart/i.test(serialized.replace(/"checkout":"shopify"/g, '')),
    'the shelf carries no payment machinery of any kind');
});

test('an unobserved product disappears from the shelf but not from the record', () => {
  const first = syncCatalog(emptyCatalog(), [shopifyProduct()], { now: NOW });
  const second = syncCatalog(first.catalog, [], { now: LATER });
  assert.equal(storeView(second.catalog, emptyRegistry()).sections.length, 0);
  assert.equal(storeView(second.catalog, emptyRegistry(), { includeUnobserved: true }).sections.length, 1,
    'an operator can still see it to decide what happened');
});

test('a hidden product is withheld from the store without being deleted', () => {
  const { catalog } = syncCatalog(emptyCatalog(), [shopifyProduct()], { now: NOW });
  catalog.products['8337764876575'].hidden = true;
  assert.equal(storeView(catalog, emptyRegistry()).sections.length, 0);
  assert.ok(catalog.products['8337764876575'], 'still on record');
});

test('the catalogue grants nothing — it is a shelf, not a ledger', () => {
  const { catalog } = syncCatalog(emptyCatalog(), [shopifyProduct()], { now: NOW });
  const serialized = JSON.stringify(catalog);
  for (const forbidden of ['entitlement', 'device_owner', 'membership', 'contactId']) {
    assert.ok(!serialized.includes(forbidden), `a catalogue entry must not carry ${forbidden}`);
  }
});

test('price parsing is exact and survives odd input', () => {
  assert.equal(toCents('2299.00'), 229900);
  assert.equal(toCents('$1,316.00'), 131600);
  assert.equal(toCents(null), null);
  assert.equal(toCents('free'), null);
  assert.equal(money(229900), '$2299');
  assert.equal(money(131650), '$1316.50');
});

test('a display shelf may be guessed from a title; an entitlement may never be', () => {
  const registry = emptyRegistry();
  const products = [
    shopifyProduct({ id: 1, handle: 'a', title: 'Bio-Well Sputnik Sensor' }),
    shopifyProduct({ id: 2, handle: 'b', title: 'BioTekna TomEEX' }),
    shopifyProduct({ id: 3, handle: 'c', title: 'Lavender Roll-On' }),
  ];
  const { catalog } = syncCatalog(emptyCatalog(), products, { now: NOW });
  const view = storeView(catalog, registry);

  const biowell = view.sections.find((s) => s.key === 'devices-biowell');
  assert.equal(biowell.products[0].shelvedBy, 'title_hint',
    'the store is usable before anyone has filed 102 products');
  assert.equal(biowell.products[0].canonical, null,
    'but the card carries no canonical product, so no purchase could resolve from it');

  assert.equal(view.sections.find((s) => s.key === 'devices-biotekna').products.length, 1);
  assert.equal(view.sections.find((s) => s.key === 'other').products[0].title, 'Lavender Roll-On');
});

test('a confirmed mapping outranks the title hint', () => {
  const registry = emptyRegistry();
  observeProduct(registry, { system: 'shopify', externalId: '1', title: 'Mystery Box' });
  mapProduct(registry, { system: 'shopify', externalId: '1', canonical: 'biopulsar-organ' });

  const { catalog } = syncCatalog(emptyCatalog(), [shopifyProduct({ id: 1, handle: 'm', title: 'Mystery Box' })], { now: NOW });
  const card = storeView(catalog, registry).sections.find((s) => s.key === 'devices-biopulsar').products[0];
  assert.equal(card.shelvedBy, 'registry');
  assert.equal(card.canonical, 'biopulsar-organ');
});
