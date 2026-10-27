#!/usr/bin/env node
/**
 * Daily Stripe reconciliation, by hand. NOTHING schedules this (a proposed
 * systemd timer is in the README, not installed).
 *
 *   node src/cli/reconcile-daily.js                  # DRY RUN (default): print the plan, send nothing
 *   node src/cli/reconcile-daily.js --run            # reconcile the previous UTC day
 *     [--day YYYY-MM-DD] [--overlap-hours 6] [--max-pages 2] [--max-requests 8]
 *
 * Environment (only with --run): STRIPE_RECONCILE_KEY (a test key: sk_test_/rk_test_;
 * live keys are refused unless --allow-live), MEMBERSHIP_DATABASE_URL.
 *
 * Hard cap: 4 lists x --max-pages requests are planned; a plan above
 * --max-requests (default 8) is REFUSED (exit 2), never trimmed. The Stripe
 * transport is capped too: the request that would exceed the cap throws.
 * Raise --max-requests only for one run, after approval (AGENTS.md).
 *
 * Exit codes: 0 clean; 1 mismatches or incomplete fetch; 2 refused (cap, key,
 * arguments); 3 failed (Stripe or database error).
 * Output: counts, object ids, amounts and statuses only; never keys or customer data.
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPool as defaultCreatePool } from '../db.js';
import { createStripeClient, keyMode, STRIPE_API_BASE } from '../providers/stripe/client.js';
import { createRequestCap } from '../providers/request-cap.js';
import { planDailyReconcile, runDailyReconcile, DAILY_DEFAULTS } from '../providers/stripe/daily-reconcile.js';

const LABEL = 'reconcile-daily';

export async function main(argv = process.argv.slice(2), {
  env = process.env, fetch = globalThis.fetch, baseUrl = STRIPE_API_BASE, now = new Date(), createPool = defaultCreatePool,
  alert, out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n'),
} = {}) {
  let a;
  try {
    a = parseArgs({ args: argv, strict: true, options: {
      run: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, 'allow-live': { type: 'boolean', default: false },
      day: { type: 'string' }, 'overlap-hours': { type: 'string' }, 'max-pages': { type: 'string' }, 'max-requests': { type: 'string' },
    } }).values;
  } catch (e) { err(`[${LABEL}] ${e.message}`); return 2; }
  const num = (v, d) => (v === undefined ? d : Number(v));
  const dryRun = a['dry-run'] || !a.run;

  let plan;
  try {
    plan = planDailyReconcile({ day: a.day, now, overlapHours: num(a['overlap-hours'], DAILY_DEFAULTS.overlapHours),
      maxPages: num(a['max-pages'], DAILY_DEFAULTS.maxPages), maxRequests: num(a['max-requests'], DAILY_DEFAULTS.maxRequests) });
  } catch (e) { err(`[${LABEL}] refused: ${e.message}`); return 2; }

  out(`[${LABEL}] day ${plan.day} (Stripe objects created from ${plan.fetchFrom.toISOString()}, overlap ${plan.overlapSeconds / 3600}h)`);
  out(`[${LABEL}] planned Stripe requests: ${plan.plannedRequests} (4 lists x ${plan.maxPages} pages, retries count) | cap: ${plan.maxRequests}`);
  if (!plan.withinCap) {
    err(`[${LABEL}] REFUSED: ${plan.plannedRequests} planned requests exceed the cap of ${plan.maxRequests}. Lower --max-pages, or raise --max-requests for one run only after approval.`);
    return 2;
  }

  const key = env.STRIPE_RECONCILE_KEY;
  const mode = key ? keyMode(key) : null;
  if (key && mode === 'live' && !a['allow-live']) { err(`[${LABEL}] REFUSED: a live Stripe key is configured and --allow-live was not given.`); return 2; }
  if (key && !mode) { err(`[${LABEL}] REFUSED: STRIPE_RECONCILE_KEY is not a Stripe secret or restricted key.`); return 2; }

  if (dryRun) { out(`[${LABEL}] dry run: nothing sent${key ? ` (key mode: ${mode})` : ''}. Pass --run to reconcile.`); return 0; }
  if (!key) { err(`[${LABEL}] REFUSED: STRIPE_RECONCILE_KEY is not set.`); return 2; }

  const cap = createRequestCap({ label: LABEL, max: plan.maxRequests, fetch });
  let pool;
  try {
    const stripe = createStripeClient({ apiKey: key, fetch: cap.fetch, baseUrl, allowLive: mode === 'live' && a['allow-live'] === true });
    pool = createPool(env.MEMBERSHIP_DATABASE_URL);
    const report = await runDailyReconcile({ pool, stripe, cap }, plan, {
      alert: alert || (async (p) => err(`[${LABEL}] ALERT ${JSON.stringify(p)}`)),
    });
    out(`[${LABEL}] run ${report.runId}: complete=${report.complete} checked=${report.checked} matched=${report.matched} skipped=${report.skipped} `
      + `mismatches=${report.mismatches.length} (coin=${report.coinMismatches}) newAlerts=${report.newAlerts} repeatAlerts=${report.repeatAlerts}`);
    for (const m of report.mismatches) out(`[${LABEL}]   ${m.kind} ${m.objectType || ''} ${m.objectId || ''} ${m.entryType || ''}`.trimEnd());
    out(`[${LABEL}] Stripe requests made: ${cap.used()} of cap ${cap.max}`);
    return report.exitCode;
  } catch (e) {
    err(`[${LABEL}] FAILED: ${e.code || e.name}: ${e.message}`);
    err(`[${LABEL}] Stripe requests made: ${cap.used()} of cap ${cap.max}`);
    return e.code === 'REQUEST_CAP_EXCEEDED' || e.code === 'FORBIDDEN' ? 2 : 3;
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await main();
}
