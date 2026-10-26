/**
 * Membership 2.0 launch flag: server-enforced, OFF by default, environment
 * ceiling always wins, approvals and audit for every change, fails closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, person } from './_db.js';
import { launchState, setLaunchStage, addPilotMember, removePilotMember, newBillingAllowed, ceilingFromEnv } from '../src/launch.js';
import { seedCatalog, currentVersion } from '../src/plans.js';
import { createSubscription } from '../src/subscriptions.js';

const admin = { actorType: 'admin', actorId: 'owner-fixture' };
const env = (c) => ({ MEMBERSHIP2_STAGE_CEILING: c });

test('ceiling: unset or junk means OFF', () => {
  assert.equal(ceilingFromEnv({}), 'OFF');
  assert.equal(ceilingFromEnv({ MEMBERSHIP2_STAGE_CEILING: 'all' }), 'OFF');
  assert.equal(ceilingFromEnv(env('internal_pilot')), 'INTERNAL_PILOT');
});

test('a fresh database is OFF; nobody can start new billing; the env ceiling caps the stored stage', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await seedCatalog(pool);
    const p = await person(pool);
    assert.equal((await launchState(pool, { env: {} })).effective, 'OFF');
    assert.deepEqual(await newBillingAllowed(pool, p, { env: env('ALL_NEW_CUSTOMERS') }), { allowed: false, reason: 'membership2_off', stage: 'OFF' }, 'stored OFF wins');
    await setLaunchStage(pool, { stage: 'ALL_NEW_CUSTOMERS', reason: 'fixture GO decision recorded', approvalRef: 'GO-fixture-1' }, admin);
    assert.equal((await launchState(pool, { env: {} })).effective, 'OFF', 'a deployment without the ceiling never activates billing');
    assert.equal((await launchState(pool, { env: env('INTERNAL_PILOT') })).effective, 'INTERNAL_PILOT');
    assert.equal((await launchState(pool, { env: env('ALL_NEW_CUSTOMERS') })).effective, 'ALL_NEW_CUSTOMERS');
  } finally { await pool.end(); }
});

test('changes need an admin, a reason, and above INTERNAL_PILOT the GO approval reference; history is append-only', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await assert.rejects(setLaunchStage(pool, { stage: 'INTERNAL_PILOT', reason: 'pilot start for staff' }, { actorType: 'system', actorId: 'deploy' }), (e) => e.code === 'FORBIDDEN');
    await assert.rejects(setLaunchStage(pool, { stage: 'INTERNAL_PILOT', reason: 'short' }, admin), (e) => e.code === 'INVALID_INPUT');
    await assert.rejects(setLaunchStage(pool, { stage: 'LIMITED_NEW_CUSTOMERS', reason: 'open to first customers', limitedCap: 10 }, admin), (e) => e.code === 'FORBIDDEN');
    await setLaunchStage(pool, { stage: 'INTERNAL_PILOT', reason: 'pilot start for staff' }, admin);
    await setLaunchStage(pool, { stage: 'OFF', reason: 'rollback drill for the runbook' }, admin);
    const h = (await pool.query('SELECT from_stage, to_stage FROM launch_history ORDER BY id')).rows.map((r) => `${r.from_stage}>${r.to_stage}`);
    assert.deepEqual(h, ['OFF>INTERNAL_PILOT', 'INTERNAL_PILOT>OFF']);
    await assert.rejects(pool.query("UPDATE launch_history SET to_stage = 'x'"), /append-only/);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE action = 'launch.stage'")).rows[0].n, 2);
    await assert.rejects(pool.query("UPDATE launch_state SET stage = 'ALL_NEW_CUSTOMERS', approval_ref = NULL"), /check constraint/, 'even a direct SQL write needs the approval reference');
  } finally { await pool.end(); }
});

test('stages: pilot-only, limited cap counted on new non-pilot customers, legacy members always routed to migration', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await seedCatalog(pool);
    const E = env('ALL_NEW_CUSTOMERS');
    const pilot = await person(pool), newcomer = await person(pool), legacy = await person(pool), second = await person(pool);
    await pool.query(`INSERT INTO legacy_memberships (external_subscription_id, person_id, payment_provider, mapping, tier, reported_status, last_seen_at)
                      VALUES ('ghl-sub-fixture-lf', $1, 'paypal', 'mapped', 'silver', 'active', now())`, [legacy]);
    await setLaunchStage(pool, { stage: 'INTERNAL_PILOT', reason: 'pilot start for staff' }, admin);
    await addPilotMember(pool, pilot, { note: 'staff' }, admin);
    assert.equal((await newBillingAllowed(pool, pilot, { env: E })).allowed, true);
    assert.equal((await newBillingAllowed(pool, newcomer, { env: E })).reason, 'pilot_only');
    await setLaunchStage(pool, { stage: 'LIMITED_NEW_CUSTOMERS', reason: 'first customers after GO', approvalRef: 'GO-fixture-2', limitedCap: 1 }, admin);
    assert.equal((await newBillingAllowed(pool, newcomer, { env: E })).allowed, true);
    assert.equal((await newBillingAllowed(pool, legacy, { env: E })).reason, 'legacy_member_use_migration');
    await createSubscription(pool, { personId: newcomer, planVersionId: (await currentVersion(pool, 'standard')).id, interval: 'month', provider: 'stripe', providerSubscriptionId: 'sub_fixture_lf1', status: 'active' }, admin);
    assert.equal((await newBillingAllowed(pool, second, { env: E })).reason, 'limited_cap_reached');
    assert.equal((await newBillingAllowed(pool, newcomer, { env: E })).reason, 'existing_customer');
    assert.equal((await newBillingAllowed(pool, newcomer, { env: E, purpose: 'coins' })).allowed, true, 'a Membership 2.0 member can buy coins');
    await removePilotMember(pool, pilot, admin);
    await setLaunchStage(pool, { stage: 'INTERNAL_PILOT', reason: 'back to pilot after a problem' }, admin);
    assert.equal((await newBillingAllowed(pool, pilot, { env: E })).reason, 'pilot_only', 'removed from the pilot');
  } finally { await pool.end(); }
});

test('fails closed when the state cannot be read', async () => {
  const broken = { query: async () => { throw new Error('db down'); } };
  assert.equal((await launchState(broken, { env: env('ALL_NEW_CUSTOMERS') })).effective, 'OFF');
  const r = await newBillingAllowed(broken, '00000000-0000-4000-8000-000000000000', { env: env('ALL_NEW_CUSTOMERS') });
  assert.deepEqual([r.allowed, r.stage], [false, 'OFF'], 'an unreadable state never allows billing');
});
