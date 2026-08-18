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
  assert.equal(money(p.priceCents), '$2299 USD', 'a price always carries its currency');
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
  assert.match(diffMessages(second.diff)[0], /price changed .* \$2299 USD to \$2499 USD/);
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
    shopifyProduct({ id: 4, handle: 'nectar', title: 'Golden Facial Nectar w/24K Gold Flakes' }),
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
  assert.equal(other.products[0].title, 'Golden Facial Nectar w/24K Gold Flakes');
});

test('every card sends the buyer to Shopify, and Gaia never takes a payment', () => {
  const { catalog } = syncCatalog(emptyCatalog(), [shopifyProduct()],
    { now: NOW, currency: 'USD', market: 'US', priceVerified: true });
  const view = storeView(catalog, emptyRegistry());
  const card = view.sections[0].products[0];
  assert.equal(card.checkout, 'shopify');
  assert.equal(card.url, 'https://gaiahealers.com/products/biowell-3-0');
  assert.equal(card.price, '$2299 USD');
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
  assert.equal(money(229900), '$2299 USD');
  assert.equal(money(131650), '$1316.50 USD');
  assert.equal(money(203695, 'EUR'), '2036.95 EUR', 'a non-USD market is never dressed as dollars');
});

test('a display shelf may be guessed from a title; an entitlement may never be', () => {
  const registry = emptyRegistry();
  const products = [
    shopifyProduct({ id: 1, handle: 'a', title: 'Bio-Well Sputnik Sensor' }),
    shopifyProduct({ id: 2, handle: 'b', title: 'BioTekna TomEEX' }),
    shopifyProduct({ id: 3, handle: 'c', title: 'Golden Facial Nectar w/24K Gold Flakes' }),
  ];
  const { catalog } = syncCatalog(emptyCatalog(), products, { now: NOW });
  const view = storeView(catalog, registry);

  const biowell = view.sections.find((s) => s.key === 'devices-biowell');
  assert.equal(biowell.products[0].shelvedBy, 'title_hint',
    'the store is usable before anyone has filed 102 products');
  assert.equal(biowell.products[0].canonical, null,
    'but the card carries no canonical product, so no purchase could resolve from it');

  assert.equal(view.sections.find((s) => s.key === 'devices-biotekna').products.length, 1);
  assert.equal(view.sections.find((s) => s.key === 'other').products[0].title,
    'Golden Facial Nectar w/24K Gold Flakes');
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

// ── currency, the thing that nearly shipped wrong ───────────────────────────
test('an unverified currency withholds every price rather than guessing', () => {
  // Found before release: this proxy runs in Germany, and an unpinned
  // products.json fetch returned EUR prices — 2036.95 for a device that sells
  // for $2,299. The feed carries no currency field, so nothing downstream could
  // have caught it. Withholding is the only honest answer.
  const { catalog } = syncCatalog(emptyCatalog(), [shopifyProduct()],
    { now: NOW, currency: null, priceVerified: false });
  const view = storeView(catalog, emptyRegistry());
  const card = view.sections[0].products[0];

  assert.equal(card.price, null, 'no number is better than a wrong number');
  assert.equal(card.priceUnavailable, true);
  assert.equal(view.currency, null);
  assert.equal(view.priceNote, null);
  assert.ok(card.url, 'the product is still sold — the price just comes from Shopify');
});

test('a verified market shows prices, labelled, with checkout stated plainly', () => {
  const { catalog } = syncCatalog(emptyCatalog(), [shopifyProduct()],
    { now: NOW, currency: 'USD', market: 'US', priceVerified: true });
  const view = storeView(catalog, emptyRegistry());
  assert.equal(view.sections[0].products[0].price, '$2299 USD');
  assert.equal(view.sections[0].products[0].priceUnavailable, false);
  assert.equal(view.currency, 'USD');
  assert.match(view.priceNote, /confirmed at checkout/,
    'a member outside the synced market sees their own currency at Shopify');
});

test('the catalogue records which market its prices came from', () => {
  const { catalog } = syncCatalog(emptyCatalog(), [shopifyProduct()],
    { now: NOW, currency: 'USD', market: 'US', priceVerified: true });
  assert.equal(catalog.currency, 'USD');
  assert.equal(catalog.market, 'US');
  assert.equal(catalog.priceVerified, true);
});

test('a zero or lower "was" price is never struck through beside the real one', () => {
  // Shopify writes 0 when there is no compare-at price. Five live products do,
  // and the card was rendering "$3499 USD $0 USD".
  const zero = normalizeShopifyProduct(shopifyProduct({ compareAt: '0.00' }));
  assert.equal(zero.compareAtCents, null);

  const lower = syncCatalog(emptyCatalog(), [shopifyProduct({ price: '2299.00', compareAt: '1000.00' })],
    { now: NOW, currency: 'USD', priceVerified: true });
  assert.equal(storeView(lower.catalog, emptyRegistry()).sections[0].products[0].compareAt, null,
    'a "was" price below the price is not a discount');

  const real = syncCatalog(emptyCatalog(), [shopifyProduct({ price: '2299.00', compareAt: '2648.00' })],
    { now: NOW, currency: 'USD', priceVerified: true });
  assert.equal(storeView(real.catalog, emptyRegistry()).sections[0].products[0].compareAt, '$2648',
    'the currency is stated once, on the price that matters');
});

test('images are requested at the size the card renders them', () => {
  const p = normalizeShopifyProduct({
    id: 1, handle: 'h', title: 't', variants: [{ id: 2, price: '1.00' }],
    images: [{ src: 'https://cdn.shopify.com/s/files/1/x/IMGS1191.jpg?v=1736629260' }],
  });
  assert.match(p.images[0], /width=600/, 'the feed links 3360px originals');
  assert.ok(p.images[0].startsWith('https://cdn.shopify.com/'));

  const foreign = normalizeShopifyProduct({
    id: 2, handle: 'h', title: 't', variants: [{ id: 3, price: '1.00' }],
    images: [{ src: 'https://example.org/pic.jpg' }],
  });
  assert.equal(foreign.images[0], 'https://example.org/pic.jpg', 'a non-Shopify URL is left alone');
});

test('the long tail is broken into real shelves rather than one endless rail', () => {
  // The live catalogue put 70 of 102 products under a single heading, which on
  // a phone is a 70-card horizontal scroll. These are display shelves only.
  const titles = [
    'Therapeutic Blend Roll-On — Pain Buster 10ml',
    'Aura Cleanser Spray 30ml',
    'Sacred Geometry Jap Mala – Angelite',
    'StemRegen Mobilize - 1 Bag',
    'One (1) Colour Energy Personality Test',
    'HeartMath Inner Balance Coherence Plus Monitor',
    'Jiva Yami',
  ];
  const products = titles.map((title, i) => shopifyProduct({ id: i + 1, handle: `h${i}`, title }));
  const { catalog } = syncCatalog(emptyCatalog(), products, { now: NOW });
  const view = storeView(catalog, emptyRegistry());

  const other = view.sections.find((s) => s.key === 'other');
  assert.equal(other, undefined, 'none of these belong in a catch-all');
  assert.deepEqual(view.sections.map((s) => s.key).sort(), [
    'colour-energy', 'crystals', 'jiva', 'oils', 'sprays', 'supplements', 'therapy-tools',
  ]);
  for (const section of view.sections) {
    assert.ok(section.products.every((p) => p.canonical === null),
      'a display shelf still grants nothing');
  }
});

test('a device family keeps its own products even when a generic word matches', () => {
  const { catalog } = syncCatalog(emptyCatalog(), [
    shopifyProduct({ id: 1, handle: 'a', title: 'Bio-Well Water Sensor' }),
    shopifyProduct({ id: 2, handle: 'b', title: 'Water Sensor + Sputnik' }),
  ], { now: NOW });
  const view = storeView(catalog, emptyRegistry());
  assert.equal(view.sections.length, 1);
  assert.equal(view.sections[0].key, 'devices-biowell',
    'the Bio-Well hint runs before the generic water hint');
});

// ── the boundary that must never blur ───────────────────────────────────────
test('the store speaks about products; only the ledger speaks about access', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../../gaia-store.js', import.meta.url), 'utf8');

  // A card may say what a product is and what it costs. It may never tell a
  // signed-in member what they hold — that sentence belongs to My Access,
  // which reads the ledger. A catalogue has no idea who is looking at it.
  const forbidden = [
    /you\s+own/i,
    /you\s+have\s+access/i,
    /your\s+licen[cs]e/i,
    /you'?re\s+(gold|silver|diamond)/i,
    /already\s+owned/i,
    /included\s+in\s+your/i,
    /unlocked/i,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `the store must not claim entitlement: ${pattern}`);
  }

  // and it must not be reading the member's access to decide what to render
  assert.ok(!/\/api\/member\/access/.test(source),
    'the store has no business knowing what a member holds');
  assert.ok(!/entitlement/i.test(source));
});

test('a catalogue card carries no member-specific field at all', () => {
  const { catalog } = syncCatalog(emptyCatalog(), [shopifyProduct()],
    { now: NOW, currency: 'USD', priceVerified: true });
  const card = storeView(catalog, emptyRegistry()).sections[0].products[0];
  for (const key of ['owned', 'hasAccess', 'entitled', 'contactId', 'member', 'licensed']) {
    assert.equal(card[key], undefined, `a card must not carry ${key}`);
  }
  assert.deepEqual(Object.keys(card).sort(), [
    'available', 'canonical', 'checkout', 'compareAt', 'externalId',
    'handle', 'image', 'price', 'priceUnavailable', 'shelvedBy', 'title', 'url',
  ], 'the card surface is a closed set — nothing member-specific can creep in');
});

test('a product with variant prices quotes the lowest, and says "From"', () => {
  // Live example: "Aura Cleanser Spray 30ml / 120ml" lists 7.99 and 19.99. The
  // card previously showed whichever variant came first in the feed.
  const varied = shopifyProduct({
    variants: [
      { id: 1, title: '120ml', price: '19.99', available: true },
      { id: 2, title: '30ml', price: '7.99', available: true },
    ],
  });
  const p = normalizeShopifyProduct(varied);
  assert.equal(p.priceCents, 799, 'the lowest price a customer can actually pay');
  assert.equal(p.priceVaries, true);

  const { catalog } = syncCatalog(emptyCatalog(), [varied], { now: NOW, currency: 'USD', priceVerified: true });
  assert.equal(storeView(catalog, emptyRegistry()).sections[0].products[0].price, 'From $7.99 USD');
});

test('identical variant prices are quoted plainly, with no "From"', () => {
  const same = shopifyProduct({
    variants: [
      { id: 1, title: 'A', price: '99.00', available: true },
      { id: 2, title: 'B', price: '99.00', available: true },
    ],
  });
  assert.equal(normalizeShopifyProduct(same).priceVaries, false);
  const { catalog } = syncCatalog(emptyCatalog(), [same], { now: NOW, currency: 'USD', priceVerified: true });
  assert.equal(storeView(catalog, emptyRegistry()).sections[0].products[0].price, '$99 USD');
});

// ── the member-facing detail projection ─────────────────────────────────────
import { productDetail, actionFor, MEMBER_ACTIONS } from '../membership/store-catalog.js';
import { normalizeModel } from '../membership/commerce-model.js';
import { defaultCatalogue } from '../membership/commerce-catalogue.js';

const commerce = normalizeModel(defaultCatalogue());

function detailFixture(canonicalKey, over = {}) {
  const { catalog } = syncCatalog(emptyCatalog(), [shopifyProduct(over)],
    { now: NOW, currency: 'USD', priceVerified: true });
  const registry = emptyRegistry();
  for (const key of Object.keys(commerce.products)) registry.canonical[key] = { key };
  observeProduct(registry, { system: 'shopify', externalId: String(over.id || 8337764876575), title: 'x' });
  if (canonicalKey) mapProduct(registry, { system: 'shopify', externalId: String(over.id || 8337764876575), canonical: canonicalKey });
  return productDetail(catalog, registry, commerce, String(over.id || 8337764876575));
}

test('a product detail carries nothing internal — no ids, status, policy or evidence', () => {
  const detail = detailFixture('biowell-3');
  const serialized = JSON.stringify(detail);

  // Field names first. A substring scan would false-positive here: the public
  // Shopify handle is "biowell-3-0", which contains the canonical key by pure
  // coincidence, and the URL is exactly what a customer is meant to see.
  for (const field of ['canonical', 'mappingStatus', 'confidence', 'evidence', 'policy',
    'shelvedBy', 'effects', 'entitlementType', 'components']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(detail, field), `a customer must never receive a "${field}" field`);
  }
  // Then values: no canonical key may appear as a value anywhere.
  const values = JSON.stringify(Object.entries(detail)
    .filter(([k]) => !['href', 'images'].includes(k))
    .map(([, v]) => v));
  for (const key of Object.keys(commerce.products)) {
    assert.ok(!values.includes(`"${key}"`), `canonical key ${key} leaked as a value`);
  }
  assert.ok(!/\bapproved\b|\bpending\b/.test(serialized), 'policy words must not reach a customer');
  // and it does carry what a person actually wants
  assert.equal(detail.title, 'Bio-Well 3.0 Energy Monitoring Device');
  assert.equal(detail.price, '$2299 USD');
  assert.equal(detail.kind, 'device', 'a word a person recognises, not a canonical key');
});

test('catalogue data can never make an ownership or access claim', () => {
  // The words that may only ever come from the ledger.
  const forbidden = /\b(you own|owned|you have access|unlocked|your device|your software|your ticket|included in your|active on your)\b/i;
  for (const key of Object.keys(commerce.products)) {
    const detail = detailFixture(key);
    if (!detail) continue;
    const text = [detail.title, detail.description, detail.label, detail.kind,
      ...(detail.contents || []).map((c) => c.title),
      ...(detail.related || []).map((r) => r.title)].filter(Boolean).join(' ');
    assert.ok(!forbidden.test(text), `${key} produced an ownership claim from catalogue data`);
  }
});

test('a bundle shows what is in the box, and never what it grants', () => {
  const detail = detailFixture('biowell-accessory-pack');
  assert.equal(detail.kind, 'bundle');
  assert.deepEqual(detail.contents.map((c) => c.title).sort(), [
    'Bio-Well Bio-Cor', 'Bio-Well Glove', 'Bio-Well Water Sensor', 'Sputnik Environment Sensor',
  ]);
  const serialized = JSON.stringify(detail.contents);
  assert.ok(!/device_owner|entitle|grant|access/i.test(serialized),
    'composition is commerce; effects are the ledger\'s business');
});

test('related products are a family, not a claim about anything', () => {
  const detail = detailFixture('biowell-3');
  assert.ok(detail.related.length > 0, 'a device suggests its accessories');
  assert.ok(detail.related.every((r) => ['device', 'accessory'].includes(r.kind)));
  assert.ok(!JSON.stringify(detail.related).includes('own'));
});

test('the action model routes by what a product is, never by what a member holds', () => {
  const cases = [
    ['biowell-3', 'buy'],
    ['biowell-software-1y', 'open_software'],
    ['elevate-2026-exhibit', 'open_event'],
    ['session-consultation', 'contact_gaia'],
    ['non-product-custom-item', 'contact_gaia'],
  ];
  for (const [key, expected] of cases) {
    const detail = detailFixture(key);
    assert.equal(detail.action, expected, `${key} should offer ${expected}`);
    assert.ok(MEMBER_ACTIONS.includes(detail.action));
  }
});

test('a pending access policy changes the destination, never the entitlement', () => {
  const software = detailFixture('biowell-software-1y');
  assert.equal(software.action, 'open_software');
  assert.ok(software.href, 'the member is sent somewhere useful');
  assert.equal(software.kind, 'software');
  // nothing in the payload resembles a grant
  assert.ok(!/device_software|entitle|licence granted/i.test(JSON.stringify(software)));

  const ticket = detailFixture('elevate-2026-exhibit');
  assert.equal(ticket.action, 'open_event');
  assert.match(ticket.href, /view=events/, 'handed to the existing Events experience');
});

test('an unavailable product offers viewing, not buying', () => {
  const detail = detailFixture('biowell-3', { available: false });
  assert.equal(detail.action, 'learn_more');
  assert.equal(detail.label, 'View on Shopify');
});

test('an unmapped product still gets a safe, honest action', () => {
  const detail = detailFixture(null);
  assert.equal(detail.kind, null, 'we do not pretend to know what it is');
  assert.equal(detail.action, 'buy', 'but it is still a real thing Shopify sells');
  assert.deepEqual(detail.contents, []);
});

test('a hidden product has no detail at all', () => {
  const { catalog } = syncCatalog(emptyCatalog(), [shopifyProduct()], { now: NOW, currency: 'USD', priceVerified: true });
  catalog.products['8337764876575'].hidden = true;
  assert.equal(productDetail(catalog, emptyRegistry(), commerce, '8337764876575'), null);
});

test('an unverified currency withholds price from the detail too', () => {
  const { catalog } = syncCatalog(emptyCatalog(), [shopifyProduct()], { now: NOW, priceVerified: false });
  const detail = productDetail(catalog, emptyRegistry(), commerce, '8337764876575', { showPrices: false });
  assert.equal(detail.price, null);
  assert.ok(detail.variants.every((v) => v.price === null));
});

test('a description reads as a person wrote it, not as markup', () => {
  // Live data: "FAST &amp; FREE National Shipping" reached the member endpoint
  // with the entity intact.
  const p = normalizeShopifyProduct({
    id: 1, handle: 'h', title: 't', variants: [{ id: 2, price: '1.00' }], images: [],
    body_html: '<p>FAST &amp; FREE Shipping &ndash; <b>Bio&#45;Well</b> &nbsp; kit&hellip;</p>',
  });
  assert.ok(!/&(amp|ndash|nbsp|hellip|#\d+);/.test(p.description), 'no raw entity survives');
  assert.match(p.description, /FAST & FREE Shipping – Bio-Well kit…/);
});
