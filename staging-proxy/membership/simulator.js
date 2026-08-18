/**
 * The dry-run purchase simulator.
 *
 * Answers one question: "if this external purchase arrived right now, what
 * would Gaia propose?" — and stops there. It has no reference to the ledger,
 * no import that can write one, and returns plain data. The safety property is
 * structural: there is nothing here to disable.
 *
 * It exists because every unsafe outcome we care about is easier to see than to
 * reason about — a phantom point-of-sale buyer, an unmapped product, a pending
 * policy, a bundle resolving through its components.
 */

import { entitlementsForPurchase } from './product-registry.js';
import { effectsForPurchase } from './commerce-model.js';
import { placeholderReason, resolveIdentity } from './identity.js';

/**
 * Outcomes, deliberately named for what an operator would say out loud.
 *
 * `policy_decision_required` is a success, not a failure: the product is known
 * and the business rule is not, which is exactly the state most of the
 * catalogue is in and must be safe to sit in indefinitely.
 */
const OUTCOMES = [
  'proposal',                 // an approved effect would be proposed
  'no_entitlement',           // recognised, and grants nothing by decision
  'policy_decision_required', // recognised, policy pending — navigation only
  'non_product',              // a tax line, an instalment, a name at a till
  'unresolved_product',       // nobody has mapped this external id
  'unresolved_identity',      // we do not know who bought it
];

const clean = (value, max = 120) => String(value ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);

/**
 * Simulate one purchase.
 *
 * `store` is only ever READ, and only to resolve identity. Nothing in this
 * function writes, and no caller can make it write.
 */
function simulatePurchase(store, registry, model, input = {}, { now = new Date() } = {}) {
  const system = clean(input.system, 20);
  const externalId = clean(input.externalId, 80);
  const identity = input.identity && typeof input.identity === 'object' ? input.identity : {};
  const refunded = Boolean(input.refunded);

  const result = {
    input: { system, externalId, identity: describeIdentity(identity), refunded },
    outcome: null,
    contactId: null,
    product: null,
    productType: null,
    proposals: [],
    pending: [],
    destination: null,
    notes: [],
  };

  // ── who is this? ──────────────────────────────────────────────────────────
  const placeholder = placeholderReason(identity);
  if (placeholder) {
    result.outcome = 'unresolved_identity';
    result.notes.push('the point-of-sale placeholder is not a person — this order needs attributing by hand');
    // Deliberately keep going, so an operator can still see WHAT was bought.
  } else {
    const resolved = resolveIdentity(store, identity);
    result.contactId = resolved.contactId;
    if (!resolved.contactId) {
      result.outcome = 'unresolved_identity';
      result.notes.push(`identity ${resolved.confidence}: ${resolved.method}`);
    }
  }

  // ── what was bought? ──────────────────────────────────────────────────────
  const mapped = entitlementsForPurchase(registry, { system, externalId });
  if (!mapped.canonical) {
    if (!result.outcome) result.outcome = 'unresolved_product';
    result.notes.push(`external product not mapped (${mapped.reason})`);
    return finish(result);
  }
  result.product = mapped.canonical;

  const effects = effectsForPurchase(model, mapped.canonical, { now });
  result.productType = effects.type || null;
  result.destination = effects.destination || null;
  if (effects.components) result.components = effects.components;

  if (!effects.ok) {
    if (!result.outcome) result.outcome = 'unresolved_product';
    result.notes.push(effects.reason);
    return finish(result);
  }

  result.pending = effects.pending;
  // An unidentified buyer means nothing may be proposed, whatever was bought.
  result.proposals = result.contactId ? effects.proposals : [];
  if (!result.contactId && effects.proposals.length) {
    result.notes.push(`${effects.proposals.length} effect(s) withheld: nobody to grant them to`);
  }

  if (refunded) {
    result.refundOutcome = effects.proposals.map((p) => ({ type: p.type, key: p.key, rule: p.refundRule }));
    result.proposals = [];
    result.notes.push('refunded: the purchase proposes nothing; the refund rule decides what a prior grant does');
  }

  if (!result.outcome) {
    if (result.productType === 'non_product') result.outcome = 'non_product';
    else if (result.proposals.length) result.outcome = 'proposal';
    else if (result.pending.length) result.outcome = 'policy_decision_required';
    else result.outcome = 'no_entitlement';
  }
  return finish(result);
}

function finish(result) {
  if (result.pending.length && !result.notes.some((n) => n.includes('pending'))) {
    result.notes.push(`${result.pending.length} effect(s) pending a business decision — navigation only, no access`);
  }
  // The invariant, asserted at the boundary rather than trusted: nothing whose
  // policy is not approved may ever appear in proposals.
  result.proposals = result.proposals.filter((p) => p.policy === 'approved');
  return result;
}

/** Never echo a raw email back into a report an operator might share. */
function describeIdentity(identity) {
  const out = {};
  for (const [key, value] of Object.entries(identity)) {
    if (!value) continue;
    out[key] = key === 'email'
      ? String(value).replace(/^(.).*(@.*)$/, '$1***$2')
      : clean(value, 60);
  }
  return out;
}

/** Run the standard suite an operator should see before trusting any of this. */
function standardScenarios(store, registry, model, { now = new Date() } = {}) {
  const known = (system, externalId) => ({ system, externalId });
  const someone = { ghl_contact_id: firstRealContact(store) };
  const scenarios = [
    ['Bio-Well 3.0 device', { ...known('ghl', '6480f94660c6b7ac09684b97'), identity: someone }],
    ['Bio-Well accessory (Sputnik)', { ...known('ghl', '648206ad60c6b7850068629e'), identity: someone }],
    ['Bio-Well Accessory Pack (bundle)', { ...known('shopify', '8337754849567'), identity: someone }],
    ['Healeex device', { ...known('shopify', '10439488536863'), identity: someone }],
    ['BioTekna BIA-ACC', { ...known('shopify', '10117224038687'), identity: someone }],
    ['Bio-Well 1 Year Subscription', { ...known('ghl', '69bc27ce847fa67373c2c1d3'), identity: someone }],
    ['Elevate ticket', { ...known('ghl', '68755fe707a26368c72395d6'), identity: someone }],
    ['Elevate exhibitor (Ambassador)', { ...known('ghl', '687d506b7b34222f15da1ac5'), identity: someone }],
    ['Silver monthly', { ...known('ghl', '69177f9c54010d18cf6a8aad'), identity: someone }],
    ['Booked consultation', { ...known('ghl', '696172c3140fc20ff6dda033'), identity: someone }],
    ['Custom Item (point of sale)', { ...known('ghl', '6a418b1e7560b6867c2edc50'), identity: someone }],
    ['unknown Shopify product', { ...known('shopify', '9999999999'), identity: someone }],
    ['unknown GHL product', { ...known('ghl', 'not-a-real-id'), identity: someone }],
    ['point-of-sale placeholder buyer', { ...known('ghl', '6480f94660c6b7ac09684b97'), identity: { email: 'auto.generated@pos.payment' } }],
    ['refunded device', { ...known('ghl', '6480f94660c6b7ac09684b97'), identity: someone, refunded: true }],
  ];
  return scenarios.map(([label, input]) => ({
    label, ...simulatePurchase(store, registry, model, input, { now }),
  }));
}

function firstRealContact(store) {
  const ids = Object.keys(store?.contacts || {});
  return ids.find((id) => !id.startsWith('fixture-')) || 'unknown-contact';
}

export { OUTCOMES, simulatePurchase, standardScenarios };
