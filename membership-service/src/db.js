/**
 * PostgreSQL access. One pool per process; every money/coin write runs inside
 * withTransaction() so a failure leaves nothing half-written.
 *
 * The connection string comes only from MEMBERSHIP_DATABASE_URL (or an explicit
 * argument). There is deliberately no default: this service has no production
 * database yet, and nothing should connect to one by accident.
 */
import pg from 'pg';

pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // bigint -> number (coins/cents stay far below 2^53)

export function createPool(connectionString = process.env.MEMBERSHIP_DATABASE_URL, opts = {}) {
  if (!connectionString) throw new Error('MEMBERSHIP_DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10, application_name: 'gaia-membership' });
  pool.on('connect', (c) => c.query('SET search_path = membership, public; SET TIME ZONE \'UTC\''));
  return pool;
}

/** Run fn(client) in a transaction; retries serialization failures / deadlocks a bounded number of times. */
export async function withTransaction(pool, fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (attempt < retries && (e.code === '40001' || e.code === '40P01')) continue;
      throw e;
    } finally {
      client.release();
    }
  }
}
