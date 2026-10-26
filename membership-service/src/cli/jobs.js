#!/usr/bin/env node
// One bounded pass of every membership job. For a future timer; nothing schedules it yet.
// Usage: MEMBERSHIP_DATABASE_URL=... node src/cli/jobs.js
import { createPool } from '../db.js';
import { runMonthlyAllowance } from '../jobs/allowance.js';
import { runSubscriptionMaintenance, runHoldCleanup } from '../jobs/maintenance.js';

const pool = createPool();
try {
  const now = new Date();
  const out = {
    holds: await runHoldCleanup(pool, { now }),
    subscriptions: await runSubscriptionMaintenance(pool, { now }),
    allowance: await runMonthlyAllowance(pool, { now }),
  };
  console.log(JSON.stringify({ at: now.toISOString(), ...out }));
} finally {
  await pool.end();
}
