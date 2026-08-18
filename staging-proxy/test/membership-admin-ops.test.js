/**
 * Membership Admin operations.
 *
 * The assertion this file exists for: assigning a plan must not grant that
 * plan's benefits. Policy and grant are separate tables, separate actions and
 * separate evidence — if they ever merge, a tier name silently confers access
 * again, which is the failure the whole architecture was built to prevent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPolicy, normalizePolicy, normalizePlan, benefitsToEntitlements, plansInOrder } from '../membership/policy.js';
import {
  assignMembership, endMembership, grantEntitlement, revokeEntitlement,
  applyPolicy, policyDrift, audit, auditFor,
} from '../membership/admin-ops.js';

const NOW = new Date('2026-08-18T10:00:00Z');
const policy = normalizePolicy(defaultPolicy());
const fresh = () => ({ version: 2, contacts: {}, processedWebhookIds: [], auditLog: [] });

test('assigning a plan does NOT grant that plan benefits', () => {
  const store = fresh();
  assignMembership(store, 'c1', { key: 'gold', status: 'active', billing_cycle: 'annual' }, { now: NOW });
  const record = store.contacts.c1;
  assert.equal(record.membership.key, 'gold');
  assert.equal(record.membership.status, 'active');
  assert.deepEqual(record.entitlements, [], 'a plan is not a bundle of rights');
});

test('policy drift reports what is promised but not held', () => {
  const store = fresh();
  assignMembership(store, 'c1', { key: 'gold' }, { now: NOW });
  const drift = policyDrift(store.contacts.c1, policy, NOW);
  assert.equal(drift.plan, 'gold');
  assert.deepEqual(drift.missing.map((m) => m.type).sort(),
    ['crm_access', 'directory_level', 'discount', 'lead_allocation']);
});

test('applying policy is the only bridge, and it is explicit and audited', () => {
  const store = fresh();
  assignMembership(store, 'c1', { key: 'gold' }, { now: NOW });
  const result = applyPolicy(store, 'c1', policy, 'gold', { actor: 'sara', now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.created.length, 4);
  for (const entitlement of result.created) {
    assert.equal(entitlement.source, 'membership_policy', 'provenance is recorded honestly');
    assert.ok(entitlement.evidence_id.startsWith('policy:gold:'));
  }
  assert.equal(policyDrift(store.contacts.c1, policy, NOW).missing.length, 0);
  assert.ok(auditFor(store, 'c1').some((e) => e.action === 'policy.apply'));
});

test('a lead allocation is scoped to a period, never left as "monthly"', () => {
  const created = benefitsToEntitlements(policy, 'gold', { now: NOW });
  const leads = created.find((e) => e.type === 'lead_allocation');
  assert.equal(leads.key, '2026-08');
  assert.equal(leads.value.period, '2026-08');
  assert.equal(leads.value.monthly, 5);
  assert.equal(leads.value.delivered, 0);
});

test('a manual grant records itself as manual, never as a system source', () => {
  const store = fresh();
  const result = grantEntitlement(store, 'c1',
    { type: 'device_owner', key: 'biowell-3', value: { name: 'Bio-Well 3.0' } },
    { actor: 'sara', now: NOW, note: 'shipped at the retreat' });
  assert.equal(result.ok, true);
  assert.equal(result.entitlement.source, 'manual', 'not shopify_order — we did not see an order');
  const entry = auditFor(store, 'c1')[0];
  assert.equal(entry.action, 'entitlement.grant');
  assert.equal(entry.actor, 'sara');
  assert.equal(entry.note, 'shipped at the retreat');
});

test('revoking keeps the record and marks it, so the history survives', () => {
  const store = fresh();
  grantEntitlement(store, 'c1', { type: 'course_access', key: 'offer-1' }, { now: NOW });
  const result = revokeEntitlement(store, 'c1', { type: 'course_access', key: 'offer-1' },
    { actor: 'sara', now: NOW, note: 'refunded' });
  assert.equal(result.ok, true);
  const held = store.contacts.c1.entitlements;
  assert.equal(held.length, 1, 'not deleted');
  assert.equal(held[0].status, 'revoked');
  assert.equal(auditFor(store, 'c1')[0].note, 'refunded');
});

test('cancelling a membership leaves owned rights untouched', () => {
  const store = fresh();
  assignMembership(store, 'c1', { key: 'gold' }, { now: NOW });
  applyPolicy(store, 'c1', policy, 'gold', { now: NOW });
  grantEntitlement(store, 'c1', { type: 'device_owner', key: 'biowell-3' }, { now: NOW });
  grantEntitlement(store, 'c1', { type: 'course_access', key: 'lifetime-1' }, { now: NOW });

  endMembership(store, 'c1', { status: 'cancelled', now: NOW });
  const record = store.contacts.c1;
  assert.equal(record.membership.status, 'cancelled');
  assert.ok(record.membership.ends_at, 'an end date is stamped');
  assert.equal(record.entitlements.find((e) => e.type === 'device_owner').status, 'active');
  assert.equal(record.entitlements.find((e) => e.type === 'course_access').status, 'active');
});

test('a downgrade leaves policy rights the new plan does not promise, and drift names them', () => {
  const store = fresh();
  assignMembership(store, 'c1', { key: 'diamond' }, { now: NOW });
  applyPolicy(store, 'c1', policy, 'diamond', { now: NOW });
  assignMembership(store, 'c1', { key: 'silver' }, { now: NOW });
  const drift = policyDrift(store.contacts.c1, policy, NOW);
  assert.equal(drift.plan, 'silver');
  assert.ok(drift.extra.some((e) => e.type === 'lead_allocation'),
    'leads left over from Diamond are surfaced, not silently kept or silently dropped');
});

test('an unknown plan key is refused', () => {
  const store = fresh();
  assert.equal(assignMembership(store, 'c1', { key: 'platinum' }, { now: NOW }).ok, false);
  assert.equal(assignMembership(store, 'c1', { key: '' }, { now: NOW }).ok, false);
  assert.deepEqual(Object.keys(store.contacts), [], 'nothing written');
});

test('an unknown entitlement type is refused', () => {
  const store = fresh();
  const result = grantEntitlement(store, 'c1', { type: 'teleport_access', key: 'mars' }, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unknown_entitlement_type');
});

test('an operator cannot invent a fifth tier through the plan editor', () => {
  assert.equal(normalizePlan('platinum', { label: 'Platinum' }), null);
  const edited = normalizePlan('gold', { label: 'Gold Pro', prices: { monthly: '$555/mo' } }, policy.plans.gold);
  assert.equal(edited.key, 'gold', 'the key is fixed');
  assert.equal(edited.label, 'Gold Pro', 'presentation is editable');
  assert.equal(edited.prices.monthly, '$555/mo');
});

test('the plan editor refuses a benefit of an unknown type', () => {
  const edited = normalizePlan('gold', {
    benefits: [
      { type: 'crm_access', key: 'managed', value: {} },
      { type: 'teleport_access', key: 'mars', value: {} },
    ],
  }, policy.plans.gold);
  assert.equal(edited.benefits.length, 1);
  assert.equal(edited.benefits[0].type, 'crm_access');
});

test('plans come back in display order', () => {
  assert.deepEqual(plansInOrder(policy).map((p) => p.key), ['free', 'silver', 'gold', 'diamond']);
});

test('the audit log is capped but keeps the most recent entries', () => {
  const store = fresh();
  for (let i = 0; i < 2100; i += 1) {
    audit(store, { actor: 'bot', action: 'test', contactId: 'c1', note: `entry-${i}` });
  }
  assert.equal(store.auditLog.length, 2000);
  assert.equal(store.auditLog[store.auditLog.length - 1].note, 'entry-2099');
});
