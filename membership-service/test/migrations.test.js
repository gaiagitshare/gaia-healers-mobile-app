import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshPool, SKIP, person } from './_db.js';
import { migrateUp, migrateDown, loadMigrations } from '../src/migrate.js';

test('migrations apply, roll back and re-apply cleanly', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    assert.deepEqual(await migrateUp(pool), [], 'second run applies nothing');
    const tables = (await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'membership'")).rows[0].n;
    assert.ok(tables >= 17, 'all foundation tables exist');
    assert.deepEqual(await migrateDown(pool, { steps: 1 }), ['0001_foundation.sql']);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'membership'")).rows[0].n, 0);
    assert.deepEqual(await migrateUp(pool), ['0001_foundation.sql']);
  } finally { await pool.end(); }
});

test('an applied migration that is edited afterwards is refused', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  try {
    for (const m of loadMigrations()) fs.writeFileSync(path.join(dir, m.file), `-- up\n${m.up}-- down\n${m.down}`.replace('CREATE SCHEMA IF NOT EXISTS membership;', 'CREATE SCHEMA IF NOT EXISTS membership; -- edited'));
    await assert.rejects(migrateUp(pool, { dir }), /changed after it was applied/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); await pool.end(); }
});

test('ledgers and the audit log are append-only', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await pool.query("INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id) VALUES ('system', 's', 'x', 'y', 'z')");
    await assert.rejects(pool.query("UPDATE audit_logs SET action = 'tampered'"), /append-only/);
    await assert.rejects(pool.query('DELETE FROM audit_logs'), /append-only/);
    const p = await person(pool);
    await pool.query(`INSERT INTO payment_ledger (person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, occurred_at)
                      VALUES ($1, 'simulated', 'invoice', 'in_1', 'charge', 4700, 'USD', now())`, [p]);
    await assert.rejects(pool.query('UPDATE payment_ledger SET amount_cents = 1'), /append-only/);
    await assert.rejects(pool.query('DELETE FROM payment_ledger'), /append-only/);
    await assert.rejects(pool.query(`INSERT INTO payment_ledger (person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, occurred_at)
                      VALUES ($1, 'simulated', 'invoice', 'in_1', 'charge', 4700, 'USD', now())`, [p]), /duplicate key/, 'one row per provider object and entry type');
    await assert.rejects(pool.query(`INSERT INTO payment_ledger (person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, occurred_at)
                      VALUES ($1, 'simulated', 'refund', 're_1', 'refund', 500, 'USD', now())`, [p]), /check constraint/, 'refunds are negative');
  } finally { await pool.end(); }
});
