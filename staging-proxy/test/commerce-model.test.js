/**
 * The canonical commerce model, and the invariants it exists to enforce.
 *
 * Most of these are not feature tests. They assert that certain things are
 * *impossible* — a pending policy producing a right, a session carrying access,
 * a title deciding identity, a simulation touching the ledger. Those are the
 * properties that let us keep building while three business rules are still
 * undecided.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRODUCT_TYPES, EFFECTLESS_TYPES, EFFECT_POLICY_STATES,
  normalizeProduct, normalizeEffect, normalizeDuration, resolveDuration,
  effectsForPurchase, setEffectPolicy, normalizeModel,
} from '../membership/commerce-model.js';
import { defaultCatalogue } from '../membership/commerce-catalogue.js';
import { simulatePurchase, standardScenarios } from '../membership/simulator.js';
import { candidateFor, generateCandidates, candidateCoverage } from '../membership/candidates.js';
import { emptyRegistry, observeProduct, mapProduct } from '../membership/product-registry.js';
import { linkIdentity } from '../membership/identity.js';

const NOW = new Date('2026-08-18T12:00:00Z');
const model = normalizeModel(defaultCatalogue());

const storeWith = (contactId = 'c1') => ({
  version: 2, contacts: { [contactId]: { contactId, entitlements: [] } },
  identities: {}, processedWebhookIds: [], auditLog: [],
});

function registryFor(pairs) {
  const registry = emptyRegistry();
  // the commerce model's canonical keys, not the seed registry's
  for (const key of Object.keys(model.products)) {
    registry.canonical[key] = { key, label: model.products[key].label };
  }
  for (const [system, externalId, canonical] of pairs) {
    observeProduct(registry, { system, externalId, title: canonical });
    if (canonical) mapProduct(registry, { system, externalId, canonical });
  }
  return registry;
}

// ── the pending-policy invariant ────────────────────────────────────────────
test('a pending policy is structurally incapable of proposing a right', () => {
  const result = effectsForPurchase(model, 'biowell-software-1y', { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.proposals.length, 0, 'nothing may be proposed while the rule is undecided');
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].type, 'device_software');
  assert.equal(result.reason, 'policy_decision_required');
  assert.ok(result.destination, 'but the member can still be sent somewhere useful');
});

test('every effect that reaches proposals is approved — asserted, not assumed', () => {
  for (const key of Object.keys(model.products)) {
    const result = effectsForPurchase(model, key, { now: NOW });
    for (const proposal of result.proposals) {
      assert.equal(proposal.policy, 'approved', `${key} proposed a non-approved effect`);
    }
  }
});

test('approving a policy is what turns a pending effect into a proposal', () => {
  const draft = normalizeModel(defaultCatalogue());
  assert.equal(effectsForPurchase(draft, 'biowell-software-1y', { now: NOW }).proposals.length, 0);

  const change = setEffectPolicy(draft, 'biowell-software-1y', 'device_software', 'approved');
  assert.equal(change.ok, true);
  assert.equal(change.from, 'pending');

  const after = effectsForPurchase(draft, 'biowell-software-1y', { now: NOW });
  assert.equal(after.proposals.length, 1);
  assert.equal(after.proposals[0].type, 'device_software');
  assert.equal(after.proposals[0].expires_at, '2027-08-18T12:00:00.000Z', 'a 12-month term, resolved to a date');
});

// ── device vs accessory ─────────────────────────────────────────────────────
test('a primary device confers ownership; an accessory never does', () => {
  const device = effectsForPurchase(model, 'biowell-3', { now: NOW });
  assert.equal(device.proposals.length, 1);
  assert.equal(device.proposals[0].type, 'device_owner');
  assert.equal(device.proposals[0].key, 'biowell-3');
  assert.equal(device.proposals[0].expires_at, null, 'owned hardware does not expire');

  for (const key of ['biowell-sputnik', 'biowell-glove', 'biowell-water-sensor']) {
    const accessory = effectsForPurchase(model, key, { now: NOW });
    assert.deepEqual(accessory.proposals, [], `${key} must not confer ownership`);
    assert.equal(accessory.reason, 'no_entitlement');
  }
});

test('a $99 glove can never make somebody a Bio-Well owner', () => {
  const result = effectsForPurchase(model, 'biowell-glove', { now: NOW });
  const owns = [...result.proposals, ...result.pending].some((e) => e.key === 'biowell-3');
  assert.equal(owns, false);
});

// ── bundles ─────────────────────────────────────────────────────────────────
test('a bundle proposes through its components, not as an identity of its own', () => {
  const pack = effectsForPurchase(model, 'biowell-accessory-pack', { now: NOW });
  assert.equal(pack.type, 'bundle');
  assert.equal(pack.components.length, 4, 'title, description and image all name four components');

  // three accessories grant nothing; the Bio-Cor inside it does
  assert.equal(pack.proposals.length, 1);
  assert.equal(pack.proposals[0].key, 'biowell-biocor');
  assert.equal(pack.proposals[0].viaBundle, 'biowell-accessory-pack',
    'the proposal says which bundle it came through');
});

test('a bundle containing a primary device does confer that device', () => {
  const combo = effectsForPurchase(model, 'biowell-3-biocor-package', { now: NOW });
  const keys = combo.proposals.map((p) => p.key).sort();
  assert.deepEqual(keys, ['biowell-3', 'biowell-biocor']);
});

test('a bundle of accessories alone proposes nothing', () => {
  const holiday = effectsForPurchase(model, 'biowell-holiday-bundle', { now: NOW });
  assert.deepEqual(holiday.proposals, []);
  assert.equal(holiday.components.length, 3);
});

test('a cyclic bundle terminates instead of recursing forever', () => {
  const cyclic = normalizeModel({
    products: {
      a: { type: 'bundle', label: 'A', components: [{ productKey: 'b' }] },
      b: { type: 'bundle', label: 'B', components: [{ productKey: 'a' }] },
    },
  });
  const result = effectsForPurchase(cyclic, 'a', { now: NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.proposals, []);
});

// ── types that must never carry access ──────────────────────────────────────
test('a session, a consumable and a non-product cannot carry an effect at all', () => {
  for (const type of EFFECTLESS_TYPES) {
    const product = normalizeProduct('x', {
      type, label: 'x',
      effects: [{ entitlementType: 'device_owner', key: 'biowell-3', policy: 'approved' }],
    });
    assert.deepEqual(product.effects, [], `${type} must drop any effect declared on it`);
  }
});

test('a session is commerce history, never a right', () => {
  const result = effectsForPurchase(model, 'session-consultation', { now: NOW });
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.pending, []);
  assert.equal(result.reason, 'no_entitlement');
});

test('an approval cannot be forced onto a type that may not hold access', () => {
  const draft = normalizeModel(defaultCatalogue());
  const attempt = setEffectPolicy(draft, 'session-consultation', 'course_access', 'approved');
  assert.equal(attempt.ok, false);
  assert.match(attempt.reason, /cannot_carry_access|unknown_effect/);
});

test('a non-product returns non_product and nothing else, ever', () => {
  for (const key of ['non-product-custom-item', 'non-product-tax', 'non-product-instalment']) {
    const result = effectsForPurchase(model, key, { now: NOW });
    assert.equal(result.reason, 'non_product');
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.pending, []);
  }
});

// ── membership stays where it is ────────────────────────────────────────────
test('a membership product defers, and never writes a tier', () => {
  const silver = effectsForPurchase(model, 'membership-silver', { now: NOW });
  assert.deepEqual(silver.proposals, [], 'commerce never grants membership');
  assert.deepEqual(silver.pending, []);
  const serialized = JSON.stringify(model.products['membership-silver']);
  assert.ok(!/membership\.key|"tier"/.test(serialized));
});

// ── duration ────────────────────────────────────────────────────────────────
test('duration is structured, never parsed out of a title', () => {
  assert.deepEqual(normalizeDuration({ kind: 'term', months: 12 }), { kind: 'term', months: 12, from: 'purchase' });
  assert.equal(normalizeDuration({ kind: 'nonsense' }).kind, 'perpetual', 'an unknown kind fails safe');
  assert.equal(normalizeDuration('1 Year').kind, 'perpetual', 'marketing text is not a duration');

  assert.equal(resolveDuration({ kind: 'perpetual' }, { now: NOW }).expiresAt, null);
  assert.equal(resolveDuration({ kind: 'term', months: 12 }, { now: NOW }).expiresAt, '2027-08-18T12:00:00.000Z');
  assert.match(resolveDuration({ kind: 'event', eventKey: 'elevate-2026' }, { now: NOW }).basis, /^event:elevate-2026$/);
  assert.equal(resolveDuration({ kind: 'billing' }, { now: NOW }).expiresAt, null,
    'the membership pipeline owns the real end date');
});

// ── navigation is not authorization ─────────────────────────────────────────
test('a destination is navigation and can never become a right', () => {
  const product = normalizeProduct('x', {
    type: 'software', label: 'x',
    presentation: { destination: 'https://example.com/a', learnMoreUrl: 'javascript:alert(1)' },
    effects: [{ entitlementType: 'device_software', key: 'k', policy: 'pending' }],
  });
  assert.equal(product.presentation.destination, 'https://example.com/a');
  assert.equal(product.presentation.learnMoreUrl, null, 'only https survives');

  const result = effectsForPurchase({ products: { x: product } }, 'x', { now: NOW });
  assert.deepEqual(result.proposals, []);
  assert.ok(result.destination, 'navigation is offered while access is withheld');
  for (const line of [...result.proposals, ...result.pending]) {
    assert.equal(line.destination, undefined, 'a destination must not ride inside an effect');
  }
});

// ── candidates ──────────────────────────────────────────────────────────────
test('a SKU outranks a title, because Shopify wrote it and we did not', () => {
  const c = candidateFor({ title: 'Something Renamed By Marketing' }, { sku: '88833311110051' });
  assert.equal(c.canonical, 'biowell-3');
  assert.equal(c.confidence, 'high');
  assert.equal(c.state, 'proposed', 'never mapped — a person decides');
});

test('an exact price identifies a product across two platforms', () => {
  const c = candidateFor({ title: 'Bio-Well 3.0 Energy Monitoring Device' }, { priceCents: 229900 });
  assert.equal(c.canonical, 'biowell-3');
  assert.equal(c.confidence, 'high', 'price and title agreeing is as strong as it gets without a SKU');

  const conflicting = candidateFor({ title: 'Mystery Box' }, { priceCents: 229900 });
  assert.equal(conflicting.confidence, 'medium', 'a price with no corroboration is weaker');
});

test('a title alone is capped at low confidence', () => {
  const c = candidateFor({ title: 'Bio-Well 3.0' });
  assert.equal(c.canonical, 'biowell-3');
  assert.equal(c.confidence, 'low');
});

test('a customer name typed at a till is recognised as a payment artifact', () => {
  for (const title of ['Custom Item - Custom Item @ 150.0', 'Katarina - Katarina @ 150.0',
    'katia ghazi Dahan - katia ghazi Dahan @ 150.0', 'Patricia 1st payment for Biopulsar', 'tax']) {
    const c = candidateFor({ title });
    assert.ok(c, `${title} should be recognised`);
    assert.match(c.canonical, /^non-product-/, `${title} must never become a real product`);
  }
});

test('a real programme that merely repeats like a till entry is NOT called a payment artifact', () => {
  // Found running this over the live 197: "High-Ticket Heart-Centered Sales"
  // has seven sales and repeats in the same shape a name does. An earlier
  // version called it a non-product with high confidence.
  const c = candidateFor({ title: 'High-Ticket Heart-Centered Sales - High-Ticket Heart-Centered Sales @ 1200' });
  assert.ok(!c || !String(c.canonical).startsWith('non-product-'),
    'commercial vocabulary in the repeated text means it is not a personal name');
});

test('a personal-name till entry is medium confidence, never high', () => {
  const c = candidateFor({ title: 'Katarina - Katarina @ 150.0' });
  assert.equal(c.confidence, 'medium', 'we are inferring from shape — a person still reviews it');
});

test('a booked appointment is recognised as a session, not a course', () => {
  const c = candidateFor({ title: 'TCCHE San Diego (via calendars) - TCCHE San Diego @ 150' });
  assert.equal(c.canonical, 'session-consultation');
});

test('the misleading accessory title is not mapped to an accessory by price alone', () => {
  // "Bio-Well Accessories by Dr. Nima Farshid — Learn about…" is a course.
  const c = candidateFor({ title: 'Bio-Well Accessories by Dr. Nima Farshid - Learn about Sputnik' }, { priceCents: 25000 });
  assert.notEqual(c?.canonical, 'biowell-sputnik', 'the word "accessories" must not make this an accessory');
});

test('candidates never come back mapped, and are ordered by sales', () => {
  const registry = emptyRegistry();
  observeProduct(registry, { system: 'ghl', externalId: 'a', title: 'Bio-Well 3.0', orders: 36 });
  observeProduct(registry, { system: 'ghl', externalId: 'b', title: 'Bio-Well Glove', orders: 5 });
  const list = generateCandidates(registry);
  assert.equal(list[0].orders, 36, 'the 36-sale product is triaged first');
  assert.ok(list.every((c) => !c.candidate || c.candidate.state === 'proposed'));

  const coverage = candidateCoverage(list);
  assert.equal(coverage.products, 2);
  assert.equal(coverage.totalOrders, 41);
});

// ── the simulator ───────────────────────────────────────────────────────────
test('the simulator proposes for a mapped device and a known buyer', () => {
  const store = storeWith('c1');
  const registry = registryFor([['ghl', 'dev1', 'biowell-3']]);
  const result = simulatePurchase(store, registry, model,
    { system: 'ghl', externalId: 'dev1', identity: { ghl_contact_id: 'c1' } }, { now: NOW });

  assert.equal(result.outcome, 'proposal');
  assert.equal(result.contactId, 'c1');
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].type, 'device_owner');
});

test('the three pending policies simulate to zero entitlement, with a destination', () => {
  const store = storeWith('c1');
  const registry = registryFor([
    ['ghl', 'sub1', 'biowell-software-1y'],
    ['ghl', 'tix1', 'elevate-2026-exhibit'],
  ]);
  const identity = { ghl_contact_id: 'c1' };

  const software = simulatePurchase(store, registry, model, { system: 'ghl', externalId: 'sub1', identity }, { now: NOW });
  assert.equal(software.outcome, 'policy_decision_required');
  assert.deepEqual(software.proposals, [], 'D3: recognised product, zero entitlement');
  assert.equal(software.pending[0].type, 'device_software');
  assert.ok(software.destination, 'and a place to send the member');

  const ticket = simulatePurchase(store, registry, model, { system: 'ghl', externalId: 'tix1', identity }, { now: NOW });
  assert.equal(ticket.outcome, 'policy_decision_required');
  assert.deepEqual(ticket.proposals, [], 'D5: recognised ticket, zero invented privilege');
  assert.equal(ticket.pending[0].value.tier, 'exhibit');
  assert.match(ticket.destination, /view=events/, 'sent to the existing Event experience');
});

test('no product anywhere in the catalogue proposes a membership', () => {
  const store = storeWith('c1');
  for (const key of Object.keys(model.products)) {
    const registry = registryFor([['ghl', 'x', key]]);
    const result = simulatePurchase(store, registry, model,
      { system: 'ghl', externalId: 'x', identity: { ghl_contact_id: 'c1' } }, { now: NOW });
    for (const proposal of result.proposals) {
      assert.notEqual(proposal.type, 'promo_membership', `${key} proposed a promotional membership`);
      assert.notEqual(proposal.type, 'membership_deferred');
    }
  }
});

test('the point-of-sale placeholder is unresolved, and still shows what was bought', () => {
  const store = storeWith('c1');
  const registry = registryFor([['ghl', 'dev1', 'biowell-3']]);
  const result = simulatePurchase(store, registry, model,
    { system: 'ghl', externalId: 'dev1', identity: { email: 'auto.generated@pos.payment' } }, { now: NOW });

  assert.equal(result.outcome, 'unresolved_identity');
  assert.deepEqual(result.proposals, [], 'nothing may be granted to a phantom');
  assert.equal(result.product, 'biowell-3', 'but an operator can see what it was');
  assert.ok(result.notes.some((n) => /by hand/.test(n)));
});

test('an unmapped external product is unresolved, not guessed', () => {
  const store = storeWith('c1');
  const registry = registryFor([]);
  for (const system of ['shopify', 'ghl']) {
    const result = simulatePurchase(store, registry, model,
      { system, externalId: 'never-seen', identity: { ghl_contact_id: 'c1' } }, { now: NOW });
    assert.equal(result.outcome, 'unresolved_product');
    assert.deepEqual(result.proposals, []);
  }
});

test('a refund proposes nothing and reports what the rule would do', () => {
  const store = storeWith('c1');
  const registry = registryFor([['ghl', 'dev1', 'biowell-3']]);
  const result = simulatePurchase(store, registry, model,
    { system: 'ghl', externalId: 'dev1', identity: { ghl_contact_id: 'c1' }, refunded: true }, { now: NOW });
  assert.deepEqual(result.proposals, []);
  assert.equal(result.refundOutcome[0].rule, 'revoke');
});

test('the simulator never writes to the store it was handed', () => {
  const store = storeWith('c1');
  const before = JSON.stringify(store);
  const registry = registryFor([['ghl', 'dev1', 'biowell-3'], ['ghl', 'sub1', 'biowell-software-1y']]);
  linkIdentity(store, 'c1', { email: 'a@b.test', verified: true }, NOW);
  const after = JSON.stringify(store);

  standardScenarios(store, registry, model, { now: NOW });
  assert.equal(JSON.stringify(store), after, 'not one byte of the ledger changed');
  assert.notEqual(before, after, 'and the harness itself did change it, so the check is real');
});

test('the simulator has no route to the ledger at all', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../membership/simulator.js', import.meta.url), 'utf8');
  for (const forbidden of ['upsertEntitlement', 'setMembership', 'saveMemberEntitlements', 'applyProposal', 'ingest(']) {
    assert.ok(!source.includes(forbidden), `the simulator must not import or call ${forbidden}`);
  }
});

test('the standard scenario suite covers every unsafe outcome we care about', () => {
  const store = storeWith('c1');
  const registry = registryFor([
    ['ghl', '6480f94660c6b7ac09684b97', 'biowell-3'],
    ['ghl', '648206ad60c6b7850068629e', 'biowell-sputnik'],
    ['shopify', '8337754849567', 'biowell-accessory-pack'],
    ['ghl', '69bc27ce847fa67373c2c1d3', 'biowell-software-1y'],
    ['ghl', '68755fe707a26368c72395d6', 'elevate-2026-exhibit'],
    ['ghl', '69177f9c54010d18cf6a8aad', 'membership-silver'],
    ['ghl', '6a418b1e7560b6867c2edc50', 'non-product-custom-item'],
    ['ghl', '696172c3140fc20ff6dda033', 'session-consultation'],
  ]);
  const results = standardScenarios(store, registry, model, { now: NOW });
  const outcomes = new Set(results.map((r) => r.outcome));
  for (const expected of ['proposal', 'no_entitlement', 'policy_decision_required',
    'unresolved_product', 'unresolved_identity']) {
    assert.ok(outcomes.has(expected), `the suite should demonstrate ${expected}`);
  }
  // and every single scenario is safe
  for (const r of results) {
    assert.ok(r.proposals.every((p) => p.policy === 'approved'), `${r.label} leaked a non-approved effect`);
  }
});

// ── shape ───────────────────────────────────────────────────────────────────
test('an unknown product type is refused rather than defaulted', () => {
  assert.equal(normalizeProduct('x', { type: 'teleporter', label: 'x' }), null);
  assert.equal(normalizeProduct('', { type: 'device' }), null);
  assert.ok(PRODUCT_TYPES.includes('bundle') && PRODUCT_TYPES.includes('non_product'));
});

test('components only exist on bundles', () => {
  const device = normalizeProduct('x', { type: 'device', label: 'x', components: [{ productKey: 'y' }] });
  assert.deepEqual(device.components, [], 'a device declaring components is a modelling mistake');
});

test('an effect with no explicit policy defaults to pending, never approved', () => {
  const effect = normalizeEffect({ entitlementType: 'device_owner', key: 'k' }, 'device');
  assert.equal(effect.policy, 'pending');
  assert.ok(EFFECT_POLICY_STATES.includes('pending'));
});
