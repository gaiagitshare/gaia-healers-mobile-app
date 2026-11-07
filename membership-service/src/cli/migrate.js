#!/usr/bin/env node
// Usage: MEMBERSHIP_DATABASE_URL=... node src/cli/migrate.js up | down [steps]
import { createPool } from '../db.js';
import { migrateUp, migrateDown } from '../migrate.js';

const [cmd = 'up', n = '1'] = process.argv.slice(2);
const pool = createPool();
try {
  const out = cmd === 'down' ? await migrateDown(pool, { steps: Number(n) }) : await migrateUp(pool);
  console.log((cmd === 'down' ? 'reverted: ' : 'applied: ') + (out.join(', ') || 'nothing'));
} finally {
  await pool.end();
}
