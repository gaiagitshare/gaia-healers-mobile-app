/**
 * "Paid subscription with no membership record" must not fire for a member
 * whose subscription still names a contact id GHL has merged away, when the
 * sweep has already repaired that subscription onto her current contact and
 * the membership there is active (3 Oct 2026: 2,323 false warnings).
 *
 * Offline: fake deps, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { alertExtras } from '../admin-router.js';

const SUB_ID = '6997df79f015031db4712083';
const subs = [
  // the Diamond subscription, still carrying the dead contact id
  { _id: SUB_ID, contactId: 'OLD-dead-contact', status: 'active', amount: 997,
    recurringProduct: { product: { _id: '691cbd1d396387d0eae141e3', name: 'Gaia Healers 2.0 CRM Diamond' }, price: { _id: '691cbd1d396387281fe141f7' } } },
  // a genuinely missing one: active, canonical product, nobody holds it
  { _id: 'sub-missing', contactId: 'C-nobody', status: 'active', amount: 97,
    recurringProduct: { product: { _id: '69177f9c54010d18cf6a8aad', name: 'Silver' }, price: { _id: '69177f9c54010d2bad6a8ac6' } } },
  // an unmapped product
  { _id: 'sub-crm', contactId: 'C-crm', status: 'active', amount: 97,
    recurringProduct: { product: { _id: '67bb407aee6d11417bd8f459', name: 'Gaia Healers CRM' }, price: { _id: '67bb407aee6d11a5f3d8f45c' } } },
];
const ledger = { contacts: {
  'OLD-dead-contact': { membership: { key: 'diamond', status: 'cancelled', evidence_id: SUB_ID } },
  'NEW-canonical':    { membership: { key: 'diamond', status: 'active',    evidence_id: SUB_ID } },
} };
const deps = {
  ghlConfig: () => ({ enabled: true, locationId: 'L' }),
  ghlGet: async (p) => (p === '/payments/subscriptions' ? { data: subs } : {}),
  loadLedger: () => ledger,
};

test('a subscription held actively under the member\'s current contact is not "missing", whatever contact id it still names', async () => {
  const x = await alertExtras(deps);
  const keys = x.membershipExceptions.map((m) => `${m.kind}:${m.contactId}`).sort();
  assert.deepEqual(keys, ['missing_membership:C-nobody', 'unmapped_product:C-crm']);
  assert.ok(!keys.some((k) => k.includes('OLD-dead-contact')), 'the merged-away contact must not be reported');
});

test('the same subscription held only as cancelled IS still reported -- the check needs an active holder', async () => {
  const cancelledOnly = { ...deps, loadLedger: () => ({ contacts: { 'OLD-dead-contact': ledger.contacts['OLD-dead-contact'] } }) };
  // alertExtras caches subscriptions per module for 5 minutes; the ledger is read fresh each call.
  const x = await alertExtras(cancelledOnly);
  assert.ok(x.membershipExceptions.some((m) => m.contactId === 'OLD-dead-contact' && m.kind === 'missing_membership' && m.heldStatus === 'cancelled'));
});
