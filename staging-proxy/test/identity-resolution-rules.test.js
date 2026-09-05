/**
 * One human, one Gaia identity — and where that cannot be established, one
 * visible question rather than a guess.
 *
 * The resolver is shared by Membership, Academy, Surveys, Events and Contacts,
 * so a mistake here is a mistake in all five at once. The failure it exists to
 * prevent is specific and expensive: handing one person's paid access to
 * another because two records looked similar.
 *
 * The rule is exact match or no match. Names are never compared. An unverified
 * email is a suggestion for an operator, not a resolution.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveIdentity, identityFor, linkIdentity, placeholderReason,
  queueUnresolved, unresolvedCount, PLACEHOLDER_CONTACT_IDS,
} from '../membership/identity.js';

const emptyStore = () => ({ version: 1, contacts: {}, unresolved: [] });

test('an exact external id resolves; a near-miss does not', () => {
  const store = emptyStore();
  store.contacts['contact-1'] = { contactId: 'contact-1', identities: {} };
  linkIdentity(store, 'contact-1', { field: 'shopify_customer_id', value: 'shop-999', verified: true });

  // A claim is keyed by field name, not { field, value }.
  assert.equal(resolveIdentity(store, { shopify_customer_id: 'shop-999' }).contactId,
    'contact-1', 'the exact id resolves');
  for (const near of ['shop-99', 'shop-9990', 'shop-999x']) {
    const r = resolveIdentity(store, { shopify_customer_id: near });
    assert.notEqual(r.contactId, 'contact-1', `"${near}" must not resolve to contact-1`);
  }
});

test('a name is never a key — two people who share one cannot collide', () => {
  const store = emptyStore();
  store.contacts['contact-a'] = { contactId: 'contact-a', identities: {}, name: 'Kay Raymond' };
  store.contacts['contact-b'] = { contactId: 'contact-b', identities: {}, name: 'Kay Raymond' };
  const r = resolveIdentity(store, { name: 'Kay Raymond' });
  assert.notEqual(r.contactId, 'contact-a');
  assert.notEqual(r.contactId, 'contact-b');
});

test('the point-of-sale placeholder resolves to nobody, by force', () => {
  // One generated contact in the live account carries 45 orders worth $37,826.
  // Left alone, an adapter would hand every counter sale to that one phantom.
  assert.ok(placeholderReason({ email: 'auto.generated@pos.payment' }),
    'the generated POS address is refused');
  assert.ok(placeholderReason({ email: 'AUTO.GENERATED@pos.payment' }),
    'and case does not smuggle it through');
  for (const id of PLACEHOLDER_CONTACT_IDS) {
    assert.ok(placeholderReason({ contactId: id }), `the known placeholder ${id} is refused`);
  }
  assert.equal(placeholderReason({ email: 'a.real.person@example.invalid' }), null,
    'an ordinary address is not caught by the placeholder rule');
});

test('an unresolvable claim is queued for a human, never guessed', () => {
  const store = emptyStore();
  const before = unresolvedCount(store);
  queueUnresolved(store, { source: 'shopify', reason: 'no_matching_identity',
    claim: { field: 'shopify_customer_id', value: 'shop-unknown' } });
  assert.equal(unresolvedCount(store), before + 1,
    'it lands in the queue an operator can see');
});

test('linking an identity to one contact does not move it to another', () => {
  const store = emptyStore();
  store.contacts['keep'] = { contactId: 'keep', identities: {} };
  store.contacts['other'] = { contactId: 'other', identities: {} };
  linkIdentity(store, 'keep', { field: 'stripe_customer_id', value: 'cus_1', verified: true });
  assert.equal(resolveIdentity(store, { stripe_customer_id: 'cus_1' }).contactId, 'keep');

  // The scenario that matters: a shared buyer. A second person's record must
  // not be able to claim an identifier that already belongs to someone else and
  // silently redirect their access.
  linkIdentity(store, 'other', { field: 'stripe_customer_id', value: 'cus_1', verified: true });
  const after = resolveIdentity(store, { stripe_customer_id: 'cus_1' });
  assert.ok(after.contactId === 'keep' || after.ambiguous || after.contactId == null,
    'a contested identifier either stays with its owner or becomes ambiguous — it never silently switches');
  if (after.contactId === 'other') {
    assert.fail('an identifier was reassigned to a second contact without review');
  }
});

test('identityFor round-trips what was linked, and nothing else', () => {
  const store = emptyStore();
  store.contacts['c'] = { contactId: 'c', identities: {} };
  linkIdentity(store, 'c', { field: 'ghl_contact_id', value: 'ghl-1', verified: true });
  const ids = identityFor(store, 'c');
  assert.ok(ids && typeof ids === 'object');
  assert.ok(JSON.stringify(ids).includes('ghl-1'), 'the linked id is there');
  assert.ok(!JSON.stringify(ids).includes('shop-'), 'and nothing that was never linked');
});
