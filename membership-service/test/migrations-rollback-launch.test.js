/**
 * Phase 5 rollback drill, automated: migrations 0009 (launch flags), 0010
 * (member scopes) and 0011 (operators) — and any later migration, so that a
 * new one cannot slip in without a working down — roll back and re-apply on a
 * database that holds data, without touching the data of 0001–0008.
 *
 * What a rollback means for the operator (docs/membership/TEST-MATRIX.md RB-MIG-*):
 *   - rolling back 0009 deletes the launch state, history and pilot list;
 *     re-applying starts at OFF (fails closed), never at the old stage;
 *   - 0010 / 0011 down re-tighten the api_clients scope CHECK, so they are
 *     REFUSED (atomically, nothing half-done) while any client row — even a
 *     revoked one — still carries member:* / admin:operate scopes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, person } from './_db.js';
import { migrateUp, migrateDown, loadMigrations } from '../src/migrate.js';
import { seedCatalog } from '../src/plans.js';
import { createClient, revokeClient } from '../src/clients.js';
import { setLaunchStage, addPilotMember, launchState } from '../src/launch.js';

const admin = { actorType: 'admin', actorId: 'owner-fixture' };
const applied = async (pool) => (await pool.query('SELECT id FROM public.membership_schema_migrations ORDER BY id')).rows.map((r) => r.id);
const tableExists = async (pool, t) => (await pool.query("SELECT to_regclass('membership.' || $1) IS NOT NULL AS x", [t])).rows[0].x;
const counts = async (pool) => Object.fromEntries((await pool.query(
  `SELECT 'persons' t, count(*)::int n FROM persons UNION ALL SELECT 'plans', count(*)::int FROM plans
   UNION ALL SELECT 'plan_versions', count(*)::int FROM plan_versions UNION ALL SELECT 'legacy_memberships', count(*)::int FROM legacy_memberships
   UNION ALL SELECT 'audit_logs', count(*)::int FROM audit_logs`)).rows.map((r) => [r.t, r.n]));

test('0009+ roll back and re-apply on a database with data; earlier data untouched; launch comes back OFF', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const later = loadMigrations().filter((m) => m.id >= '0009');
    assert.ok(later.length >= 3, '0009, 0010 and 0011 at least');
    await seedCatalog(pool);
    const p = await person(pool);
    await pool.query(`INSERT INTO legacy_memberships (external_subscription_id, person_id, payment_provider, mapping, tier, reported_status, last_seen_at)
                      VALUES ('ghl-sub-fixture-rb', $1, 'paypal', 'mapped', 'silver', 'active', now())`, [p]);
    await setLaunchStage(pool, { stage: 'INTERNAL_PILOT', reason: 'rollback drill fixture' }, admin);
    await addPilotMember(pool, p, {}, admin);
    const before = await counts(pool);

    const down = await migrateDown(pool, { steps: later.length });
    assert.deepEqual(down, later.map((m) => m.file).reverse());
    assert.equal((await applied(pool)).at(-1), '0008');
    for (const t of ['launch_state', 'launch_history', 'pilot_members', 'operators', 'operator_sessions', 'admin_action_requests', 'person_notes']) {
      assert.equal(await tableExists(pool, t), false, `${t} dropped`);
    }
    const mid = await counts(pool);
    for (const k of Object.keys(before)) assert.equal(mid[k], before[k], `${k} untouched by the rollback`);
    // With 0009 gone the gate cannot read its state: it fails closed.
    assert.equal((await launchState(pool, { env: { MEMBERSHIP2_STAGE_CEILING: 'ALL_NEW_CUSTOMERS' } })).effective, 'OFF');

    assert.deepEqual(await migrateUp(pool), later.map((m) => m.file));
    const st = await launchState(pool, { env: { MEMBERSHIP2_STAGE_CEILING: 'ALL_NEW_CUSTOMERS' } });
    assert.deepEqual([st.stored, st.effective], ['OFF', 'OFF'], 're-applied launch flags start OFF, never at the old stage');
    assert.equal((await pool.query('SELECT count(*)::int n FROM pilot_members')).rows[0].n, 0, 'the pilot list must be rebuilt by hand after a 0009 rollback');
    const after = await counts(pool);
    for (const k of ['persons', 'plans', 'plan_versions', 'legacy_memberships']) assert.equal(after[k], before[k], `${k} intact after re-apply`);
    assert.deepEqual(await migrateUp(pool), [], 'idempotent');
  } finally { await pool.end(); }
});

test('each of 0011, 0010, 0009 rolls back and re-applies on its own (one step at a time)', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const later = loadMigrations().filter((m) => m.id >= '0009');
    // Peel off one step at a time down to 0008, then climb back one step at a time.
    for (const m of [...later].reverse()) {
      assert.deepEqual(await migrateDown(pool, { steps: 1 }), [m.file]);
    }
    assert.equal((await applied(pool)).at(-1), '0008');
    const all = loadMigrations();
    assert.deepEqual(await migrateUp(pool), later.map((m) => m.file));
    assert.deepEqual(await applied(pool), all.map((m) => m.id));
  } finally { await pool.end(); }
});

test('0011 / 0010 down are refused atomically while a client still holds admin:operate / member:* scopes, even when revoked', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const later = loadMigrations().filter((m) => m.id >= '0009');
    const above11 = later.filter((m) => m.id > '0011').length;     // e.g. 0012, rolled back first
    if (above11) await migrateDown(pool, { steps: above11 });
    const adminClient = await createClient(pool, { name: 'gaia-healers-proxy-admin', scopes: ['admin:operate'] }, 'owner-fixture');
    const memberClient = await createClient(pool, { name: 'gaia-healers-proxy', scopes: ['identity:write', 'member:read', 'member:write'] }, 'owner-fixture');
    await revokeClient(pool, adminClient.id, 'owner-fixture');
    const ids = await applied(pool);
    await assert.rejects(migrateDown(pool, { steps: 1 }), /0011_operators\.sql \(down\).*check constraint/);
    assert.deepEqual(await applied(pool), ids, 'nothing recorded as rolled back');
    assert.equal(await tableExists(pool, 'operators'), true, 'the failed down left 0011 fully in place');
    // The runbook step: strip the newer scopes (or delete the client rows) first.
    await pool.query("UPDATE api_clients SET scopes = array_remove(scopes, 'admin:operate') WHERE 'admin:operate' = ANY(scopes)");
    await pool.query("DELETE FROM api_clients WHERE scopes = '{}'");
    assert.deepEqual(await migrateDown(pool, { steps: 1 }), ['0011_operators.sql']);
    await assert.rejects(migrateDown(pool, { steps: 1 }), /0010_member_scopes\.sql \(down\).*check constraint/);
    await pool.query("UPDATE api_clients SET scopes = ARRAY(SELECT unnest(scopes) EXCEPT SELECT unnest(ARRAY['identity:write', 'member:read', 'member:write'])) WHERE id = $1", [memberClient.id]);
    await pool.query("DELETE FROM api_clients WHERE scopes = '{}'");
    assert.deepEqual(await migrateDown(pool, { steps: 1 }), ['0010_member_scopes.sql']);
    assert.ok((await migrateUp(pool)).includes('0011_operators.sql'));
  } finally { await pool.end(); }
});
