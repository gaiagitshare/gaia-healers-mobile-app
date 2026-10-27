/**
 * Test database. Only MEMBERSHIP_TEST_DATABASE_URL, only a loopback host, only a
 * database whose name contains "test": these tests drop and recreate the
 * membership schema, so they must never reach a real database.
 * Start one with `npm run testdb:up` (Docker, tmpfs, loopback).
 */
import { createPool } from '../src/db.js';
import { migrateUp, migrateDown } from '../src/migrate.js';

export const TEST_URL = process.env.MEMBERSHIP_TEST_DATABASE_URL || '';

export function testDbAvailable() {
  if (!TEST_URL) return false;
  const u = new URL(TEST_URL);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]', 'postgres'].includes(u.hostname)) throw new Error('test database must be local');
  if (!/test/.test(u.pathname)) throw new Error('test database name must contain "test"');
  return true;
}

/** A pool on a freshly migrated, empty schema. */
export async function freshPool() {
  testDbAvailable();
  const pool = createPool(TEST_URL, { max: 20 });
  await pool.query('DROP SCHEMA IF EXISTS membership CASCADE');
  await pool.query('DROP TABLE IF EXISTS public.membership_schema_migrations');
  await migrateUp(pool);
  return pool;
}

if (process.env.CI && !TEST_URL) throw new Error('CI must provide MEMBERSHIP_TEST_DATABASE_URL; database tests may not be skipped');
export const SKIP = testDbAvailable() ? false : 'MEMBERSHIP_TEST_DATABASE_URL not set (npm run testdb:up)';
export const actor = { actorType: 'admin', actorId: 'test-admin' };

export async function person(pool) {
  return (await pool.query('INSERT INTO persons DEFAULT VALUES RETURNING id')).rows[0].id;
}

/**
 * Open the Membership 2.0 launch flag for a test (production default is OFF).
 * Sets the stored stage (with an approval reference) and this process's environment ceiling.
 */
export async function openLaunch(pool, stage = 'ALL_NEW_CUSTOMERS') {
  process.env.MEMBERSHIP2_STAGE_CEILING = stage;
  await pool.query("UPDATE membership.launch_state SET stage = $1, approval_ref = 'TEST-GO', reason = 'test fixture', changed_by = 'test' WHERE id", [stage]);
}
