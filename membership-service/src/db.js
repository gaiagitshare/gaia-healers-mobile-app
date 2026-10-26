/**
 * PostgreSQL access. One pool per process; every money/coin write runs inside
 * withTransaction() so a failure leaves nothing half-written.
 *
 * The connection string comes only from MEMBERSHIP_DATABASE_URL (or an explicit
 * argument). There is deliberately no default: this service has no production
 * database yet, and nothing should connect to one by accident.
 */
import pg from 'pg';

// bigint -> number for THIS pool only (never the process-wide pg default), and
// refuse rather than round a value beyond 2^53 (coins and cents stay far below).
const types = {
  getTypeParser(oid, format) {
    if (oid === 20) return (v) => { if (v === null) return null; const n = Number(v); if (!Number.isSafeInteger(n)) throw new Error('bigint out of safe range'); return n; };
    return pg.types.getTypeParser(oid, format);
  },
};

export function createPool(connectionString = process.env.MEMBERSHIP_DATABASE_URL, opts = {}) {
  if (!connectionString) throw new Error('MEMBERSHIP_DATABASE_URL is not set');
  return new pg.Pool({ connectionString, max: opts.max ?? 10, application_name: 'gaia-membership', types,
    options: '-c search_path=membership,public -c TimeZone=UTC' });
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

/** Run fn inside the caller's open transaction (a checked-out client) or a new one (a pool). */
export function inTransaction(poolOrClient, fn) {
  return typeof poolOrClient.release === 'function' ? fn(poolOrClient) : withTransaction(poolOrClient, fn);
}
