/**
 * Minimal migration runner: migrations/NNNN_name.sql, each with a `-- up` and a
 * `-- down` section, applied in order inside one transaction each, under an
 * advisory lock. An applied migration whose file later changes (up or down) is
 * refused (checksum), so history cannot be rewritten silently.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK = 7472519001;

export function loadMigrations(dir = DIR) {
  return fs.readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort().map((file) => {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const m = text.match(/^-- up\s*$([\s\S]*?)^-- down\s*$([\s\S]*)$/m);
    if (!m) throw new Error(file + ': needs "-- up" and "-- down" sections');
    return { id: file.slice(0, 4), file, up: m[1], down: m[2], checksum: crypto.createHash('sha256').update(m[1] + '\n-- down\n' + m[2]).digest('hex') };
  });
}

async function locked(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK]);
    await c.query(`CREATE TABLE IF NOT EXISTS public.membership_schema_migrations (
      id text PRIMARY KEY, file text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    return await fn(c);
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    c.release();
  }
}

export async function migrateUp(pool, { dir } = {}) {
  const all = loadMigrations(dir);
  return locked(pool, async (c) => {
    const done = new Map((await c.query('SELECT id, checksum FROM public.membership_schema_migrations')).rows.map((r) => [r.id, r.checksum]));
    const applied = [];
    for (const m of all) {
      if (done.has(m.id)) {
        if (done.get(m.id) !== m.checksum) throw new Error(`migration ${m.file} was changed after it was applied`);
        continue;
      }
      await c.query('BEGIN');
      try {
        await c.query(m.up);
        await c.query('INSERT INTO public.membership_schema_migrations (id, file, checksum) VALUES ($1, $2, $3)', [m.id, m.file, m.checksum]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`${m.file}: ${e.message}`);
      }
      applied.push(m.file);
    }
    return applied;
  });
}

export async function migrateDown(pool, { steps = 1, dir } = {}) {
  const all = loadMigrations(dir);
  return locked(pool, async (c) => {
    const done = (await c.query('SELECT id FROM public.membership_schema_migrations ORDER BY id DESC LIMIT $1', [steps])).rows;
    const reverted = [];
    for (const { id } of done) {
      const m = all.find((x) => x.id === id);
      if (!m) throw new Error('no file for applied migration ' + id);
      await c.query('BEGIN');
      try {
        await c.query(m.down);
        await c.query('DELETE FROM public.membership_schema_migrations WHERE id = $1', [id]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`${m.file} (down): ${e.message}`);
      }
      reverted.push(m.file);
    }
    return reverted;
  });
}
