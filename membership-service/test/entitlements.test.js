import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, actor, person } from './_db.js';
import { seedCatalog, currentVersion } from '../src/plans.js';
import { createSubscription, transition } from '../src/subscriptions.js';
import { evaluate, hasEntitlement, computeEntitlements } from '../src/entitlements.js';

test('holding two plans never duplicates a benefit; numbers take the max, not the sum', () => {
  const now = new Date();
  const r = computeEntitlements({ subscriptions: [
    { id: 'a', status: 'active', plan_key: 'gaia_plan', entitlements: { 'courses.core': true, 'discount.certifications_pct': 20 } },
    { id: 'b', status: 'active', plan_key: 'practitioner_plan', entitlements: { 'courses.core': true, 'discount.certifications_pct': 10 } },
  ] }, now);
  assert.equal(r.entitlements['courses.core'].value, true);
  assert.equal(r.entitlements['courses.core'].sources.length, 2, 'both sources recorded, benefit counted once');
  assert.equal(r.entitlements['discount.certifications_pct'].value, 20);
});

test('tier entitlements, grace, incomplete payments and manual grants', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await seedCatalog(pool);
    const p = await person(pool);
    const std = await currentVersion(pool, 'standard');
    const sub = await createSubscription(pool, { personId: p, planVersionId: std.id, interval: 'month' }, actor);
    assert.equal(await hasEntitlement(pool, p, 'software.scan_analysis'), false, 'incomplete: nothing before payment');
    await transition(pool, sub, 'active', {});
    assert.equal(await hasEntitlement(pool, p, 'software.scan_analysis'), true);
    assert.equal(await hasEntitlement(pool, p, 'crm.ghl_subaccount'), false, 'Professional-only benefit');
    const t = new Date();
    await transition(pool, sub, 'past_due', { now: t, graceDays: 3 });
    assert.equal(await hasEntitlement(pool, p, 'courses.core', new Date(t.getTime() + 86400000)), true, 'inside grace');
    assert.equal(await hasEntitlement(pool, p, 'courses.core', new Date(t.getTime() + 4 * 86400000)), false, 'after grace');

    await pool.query(`INSERT INTO entitlement_grants (person_id, entitlement_key, source, source_ref, granted_by, ends_at)
                      VALUES ($1, 'perk.conference_vip', 'manual', 'fixture', 'test-admin', now() + interval '1 day')`, [p]);
    const e = await evaluate(pool, p);
    assert.equal(e.entitlements['perk.conference_vip'].sources[0].type, 'grant');
    await pool.query("UPDATE entitlement_grants SET revoked_at = now() WHERE person_id = $1", [p]);
    assert.equal(await hasEntitlement(pool, p, 'perk.conference_vip'), false, 'revoked grants stop immediately');
  } finally { await pool.end(); }
});
