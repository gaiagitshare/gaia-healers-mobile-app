import './_providers-deny-network.mjs';
/**
 * docs/membership/partner-api.openapi.yaml must agree with the code that
 * enforces the contract. Required fields are DERIVED from the validators (drop
 * each field from a valid fixture; if the validator then rejects it, the field
 * is required), so neither side can drift without this test failing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './_mini-yaml.js';
import { validatePractitionerIdentity, validateSubscription, validateCoinLedger, COIN_SOURCES, SUB_STATUSES, BILLING_OWNERS } from '../src/partner/contract.js';
import { validateModuleEntitlement, ENTITLEMENT_SOURCES } from '../src/providers/practitioners/adapter.js';
import { PARTNER_EVENT_TYPES } from '../src/providers/practitioners/webhooks.js';

const DOC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'membership', 'partner-api.openapi.yaml');
const spec = parseYaml(fs.readFileSync(DOC, 'utf8'));
const S = spec.components.schemas;

const balance = { practitioner_account_id: 'gp_1', coins: 5, as_of: '2026-12-01T00:00:00Z' };
const tx = { transaction_id: 't1', delta_coins: 5, source: 'purchase', payment_ref: 'pi_1', created_at: '2026-01-01T00:00:00Z' };
const FIXTURES = {
  PractitionerIdentity: [{ practitioner_account_id: 'gp_1', status: 'active', email: 'a@b.invalid', gaia_contact_id: 'c1' }, validatePractitionerIdentity],
  Subscription: [{ subscription_id: 's1', practitioner_account_id: 'gp_1', plan_code: 'x', status: 'active', price_cents: 1, currency: 'USD', interval: 'month',
    current_period_end: '2026-12-31T00:00:00Z', billing_owner: 'partner', billing_provider: null, modules: [] }, validateSubscription],
  CoinBalance: [balance, (b) => validateCoinLedger({ balance: b, transactions: [tx] })],
  CoinTransaction: [{ ...tx, source: 'grant', payment_ref: undefined }, (t) => validateCoinLedger({ balance, transactions: [t] })],
  ModuleEntitlement: [{ module: 'scan_analysis', source: 'subscription', subscription_id: 's1', ends_at: null }, validateModuleEntitlement],
};
for (const f of Object.values(FIXTURES)) for (const k of Object.keys(f[0])) if (f[0][k] === undefined) delete f[0][k];

function requiredByValidator(fixture, validate) {
  validate(structuredClone(fixture));   // the fixture itself is valid
  return Object.keys(fixture).filter((k) => {
    const x = structuredClone(fixture); delete x[k];
    try { validate(x); return false; } catch { return true; }
  }).sort();
}

test('the OpenAPI document parses and is 3.1 with every proposed endpoint', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.match(spec.info.description, /proposed, not confirmed/);
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/v1/practitioners/{id}', '/v1/practitioners/{id}/coins', '/v1/practitioners/{id}/entitlements', '/v1/practitioners/{id}/subscriptions']);
  for (const p of Object.values(spec.paths)) assert.deepEqual(Object.keys(p), ['get'], 'read-only: GET only');
});

test('required fields: validators and OpenAPI schemas agree', () => {
  for (const [name, [fixture, validate]] of Object.entries(FIXTURES)) {
    assert.deepEqual(requiredByValidator(fixture, validate), [...S[name].required].sort(), name);
    for (const k of Object.keys(fixture)) assert.ok(k in S[name].properties, `${name}.${k} documented`);
    for (const k of Object.keys(S[name].properties)) assert.ok(k in fixture || (name === 'CoinTransaction' && k === 'payment_ref'), `${name}.${k} exercised`);
  }
});

test('enums agree', () => {
  assert.deepEqual(S.Subscription.properties.status.enum, SUB_STATUSES);
  assert.deepEqual(S.Subscription.properties.billing_owner.enum, BILLING_OWNERS);
  assert.deepEqual(S.CoinTransaction.properties.source.enum, COIN_SOURCES);
  assert.deepEqual(S.ModuleEntitlement.properties.source.enum, [...ENTITLEMENT_SOURCES]);
  assert.deepEqual(S.WebhookEvent.properties.type.enum, [...PARTNER_EVENT_TYPES]);
  for (const st of S.PractitionerIdentity.properties.status.enum) validatePractitionerIdentity({ practitioner_account_id: 'x', status: st });
  assert.throws(() => validatePractitionerIdentity({ practitioner_account_id: 'x', status: 'deleted' }));
});

test('conditional rule documented and enforced: a purchase must name its payment', () => {
  assert.match(S.CoinTransaction.description, /payment_ref is REQUIRED when source is purchase/);
  assert.throws(() => validateCoinLedger({ balance, transactions: [{ ...tx, payment_ref: undefined }] }), /payment_ref/);
});

test('page envelopes require next_cursor (null on the last page), like the adapter', () => {
  for (const n of ['SubscriptionPage', 'CoinLedgerPage', 'EntitlementPage']) assert.ok(S[n].required.includes('next_cursor') && S[n].required.includes('data'), n);
  assert.ok(S.CoinLedgerPage.required.includes('balance'));
});
