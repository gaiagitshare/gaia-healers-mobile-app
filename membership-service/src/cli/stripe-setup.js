#!/usr/bin/env node
/**
 * Stripe setup for Membership 2.0 (catalog, webhook endpoint, Customer Portal).
 * DRY RUN BY DEFAULT: prints the plan and the request count, sends nothing.
 * Stripe TEST MODE only. Not scheduled. Run with --run only after approval.
 *
 *   node src/cli/stripe-setup.js                                   # dry run, all sections
 *   node src/cli/stripe-setup.js --only catalog                    # dry run, one section
 *   node src/cli/stripe-setup.js --only webhook --webhook-url https://… --run --max-requests 2 --secret-file <new file>
 *   node src/cli/stripe-setup.js --only portal --return-url https://… --privacy-url https://… --terms-url https://… --run --max-requests 2
 *
 * Environment: MEMBERSHIP_DATABASE_URL (loopback only; optional for a dry run:
 * without it the plan uses the seed catalog), STRIPE_TEST_SECRET_KEY (only
 * with --run; sk_test_/rk_test_; anything else refused, there is no live flag).
 *
 * --run refuses (exit 2, nothing sent) unless ALL hold:
 *   - the key is a test-mode key;
 *   - --max-requests N is given explicitly and N >= the planned count;
 *   - the budget ledger (--budget-ledger, --total-budget, default 25, shared
 *     with the sandbox runs) has room for the whole plan, which is reserved
 *     BEFORE the first request and never refunded;
 *   - every URL the chosen sections need is given (https only).
 * The transport cap equals the plan; automatic retries are off, so every
 * request is counted. Existing objects that differ are reported, never edited.
 * The webhook signing secret is written to --secret-file (created 0600, must
 * not exist) and never printed.
 *
 * Exit codes: 0 done / dry run; 1 a conflict was reported; 2 refused; 3 failed.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPool as defaultCreatePool } from '../db.js';
import { createStripeClient, keyMode, STRIPE_API_BASE } from '../providers/stripe/client.js';
import { createRequestCap } from '../providers/request-cap.js';
import { openLedger } from '../providers/budget-ledger.js';
import { SECTIONS, planSetup, runSetup, loadSellablePrices, seedSellablePrices } from '../providers/stripe/setup.js';

const LABEL = 'stripe-setup';
export const DEFAULT_LEDGER = '/root/.config/gaia-stripe-sandbox-budget.json';
export const DEFAULT_TOTAL_BUDGET = 25;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export async function main(argv = process.argv.slice(2), {
  env = process.env, fetch = globalThis.fetch, baseUrl = STRIPE_API_BASE, createPool = defaultCreatePool,
  out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n'),
} = {}) {
  let a;
  try {
    a = parseArgs({ args: argv, strict: true, options: {
      run: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
      only: { type: 'string' }, 'max-requests': { type: 'string' },
      'budget-ledger': { type: 'string', default: DEFAULT_LEDGER }, 'total-budget': { type: 'string' },
      'webhook-url': { type: 'string' }, 'api-version': { type: 'string' }, 'secret-file': { type: 'string' },
      'return-url': { type: 'string' }, 'privacy-url': { type: 'string' }, 'terms-url': { type: 'string' }, headline: { type: 'string' },
    } }).values;
  } catch (e) { err(`[${LABEL}] ${e.message}`); return 2; }
  const run = a.run && !a['dry-run'];
  const sections = a.only ? a.only.split(',').map((s) => s.trim()).filter(Boolean) : [...SECTIONS];
  if (!sections.length || sections.some((s) => !SECTIONS.includes(s))) { err(`[${LABEL}] REFUSED: --only takes ${SECTIONS.join(',')}`); return 2; }

  let pool = null;
  try {
    // Catalog source: the published plan versions in the database; without one, the seed catalog (dry run only).
    let prices = [];
    let source = 'none';
    if (sections.includes('catalog')) {
      if (env.MEMBERSHIP_DATABASE_URL) {
        const u = new URL(env.MEMBERSHIP_DATABASE_URL);
        if (!LOOPBACK.has(u.hostname)) { err(`[${LABEL}] REFUSED: MEMBERSHIP_DATABASE_URL must be on a loopback host`); return 2; }
        pool = createPool(env.MEMBERSHIP_DATABASE_URL, { max: 2 });
        prices = await loadSellablePrices(pool, { livemode: false });
        source = 'database (published plan versions)';
      } else {
        if (run) { err(`[${LABEL}] REFUSED: the catalog section needs MEMBERSHIP_DATABASE_URL (plan versions are the source)`); return 2; }
        prices = seedSellablePrices();
        source = 'seed catalog (no database configured; a --run reads the database)';
      }
    }
    const plan = planSetup({ prices, sections,
      webhook: { url: a['webhook-url'], apiVersion: a['api-version'] },
      portal: { returnUrl: a['return-url'], privacyUrl: a['privacy-url'], termsUrl: a['terms-url'], headline: a.headline } });

    const c = plan.sections.catalog;
    if (c) {
      out(`[${LABEL}] catalog from ${source}: ${c.items.length} prices, ${c.products.length} products to ensure, ${c.requests} requests (max)`);
      for (const i of c.items) out(`[${LABEL}]   ${i.action === 'exists' ? 'exists ' : 'ensure '} product ${i.productId}  price ${i.lookupKey}  ${i.amountCents} ${i.currency}/${i.interval}`);
    }
    const w = plan.sections.webhook;
    if (w) {
      out(`[${LABEL}] webhook endpoint: ${w.params ? w.params.url : '(URL not given: owner decision, STRIPE-SANDBOX-ACCESS.md §5)'}; ${w.requests} requests (list + create)`);
      out(`[${LABEL}]   events (${w.events.length}, exactly what src/stripe/handlers.js handles): ${w.events.join(',')}`);
    }
    const p = plan.sections.portal;
    if (p) {
      out(`[${LABEL}] customer portal: payment method update ON, invoice history ON, cancel AT PERIOD END ON, plan switching OFF (proration decision pending), profile edits OFF; ${p.requests} requests (list + create)`);
      if (p.missing.length) out(`[${LABEL}]   missing for --run: ${p.missing.join('; ')}`);
    }
    out(`[${LABEL}] planned Stripe requests: ${plan.total} (upper bound; retries off)`);

    const key = env.STRIPE_TEST_SECRET_KEY;
    const mode = key ? keyMode(key) : null;
    if (!run) {
      out(`[${LABEL}] key: ${key ? (mode === 'test' ? 'test mode' : 'REFUSED (not a test-mode key)') : 'not set'}; --max-requests: ${a['max-requests'] ?? 'not given'}`);
      out(`[${LABEL}] dry run: nothing sent. --run needs a test key, --max-requests >= ${plan.total}, and ledger budget.`);
      return 0;
    }

    if (mode !== 'test') { err(`[${LABEL}] REFUSED: STRIPE_TEST_SECRET_KEY must be a test-mode key (sk_test_/rk_test_)`); return 2; }
    if (a['max-requests'] === undefined) { err(`[${LABEL}] REFUSED: --run needs an explicit --max-requests (the plan is ${plan.total})`); return 2; }
    const max = Number(a['max-requests']);
    if (!Number.isInteger(max) || max < 1) { err(`[${LABEL}] REFUSED: --max-requests must be a positive whole number`); return 2; }
    if (plan.total > max) { err(`[${LABEL}] REFUSED: ${plan.total} planned requests exceed --max-requests ${max}. Narrow with --only, or raise it for one run after approval.`); return 2; }
    for (const s of [w, p]) if (s && !s.params) { err(`[${LABEL}] REFUSED: ${s.missing.join('; ')}`); return 2; }
    let secretFile = null;
    if (w) {
      secretFile = a['secret-file'];
      if (!secretFile) { err(`[${LABEL}] REFUSED: creating a webhook endpoint needs --secret-file <new file> (the signing secret is never printed)`); return 2; }
      if (fs.existsSync(secretFile)) { err(`[${LABEL}] REFUSED: --secret-file already exists; choose a new file`); return 2; }
    }
    const totalBudget = a['total-budget'] === undefined ? DEFAULT_TOTAL_BUDGET : Number(a['total-budget']);
    let ledger;
    try { ledger = openLedger(a['budget-ledger'], totalBudget); } catch (e) { err(`[${LABEL}] REFUSED: ${e.message}`); return 2; }
    if (plan.total > ledger.remaining()) { err(`[${LABEL}] REFUSED: ${plan.total} planned, ledger has ${ledger.remaining()} of ${ledger.budget} left`); return 2; }
    if (plan.total === 0) { out(`[${LABEL}] nothing to send`); return 0; }

    const reservation = ledger.reserve(`${LABEL}:${sections.join('+')}`, plan.total);
    const cap = createRequestCap({ label: LABEL, max: plan.total, fetch });
    try {
      const stripe = createStripeClient({ apiKey: key, fetch: cap.fetch, baseUrl, retry: { maxRetries: 0 } });
      const secretSink = (secret) => {
        fs.writeFileSync(secretFile, `STRIPE_TEST_WEBHOOK_SECRET=${secret}\n`, { mode: 0o600, flag: 'wx' });
      };
      const r = await runSetup({ pool, stripe }, plan, { secretSink });
      let conflicts = 0;
      for (const i of r.catalog || []) out(`[${LABEL}] catalog ${i.lookupKey}: ${i.status}${i.priceId ? ' ' + i.priceId : ''}`);
      if (r.webhook) {
        if (r.webhook.status === 'conflict') conflicts++;
        out(`[${LABEL}] webhook ${r.webhook.endpointId}: ${r.webhook.status}${r.webhook.status === 'conflict' ? ` (missing ${r.webhook.missing.join(',') || '-'}; extra ${r.webhook.extra.join(',') || '-'}; NOT changed)` : ''}${r.webhook.secretStored ? '; signing secret written to --secret-file (not shown)' : ''}`);
      }
      if (r.portal) {
        if (r.portal.status === 'conflict') conflicts++;
        out(`[${LABEL}] portal ${r.portal.configurationId}: ${r.portal.status}${r.portal.differences ? ` (differs: ${r.portal.differences.join(',')}; NOT changed)` : ''}`);
      }
      return conflicts ? 1 : 0;
    } catch (e) {
      err(`[${LABEL}] FAILED: ${e.code || e.name}: ${e.message}`);
      return e.code === 'REQUEST_CAP_EXCEEDED' || e.code === 'FORBIDDEN' ? 2 : 3;
    } finally {
      reservation.done(cap.used());
      out(`[${LABEL}] Stripe requests sent: ${cap.used()} (reserved ${plan.total}); ledger ${ledger.used} of ${ledger.budget}`);
    }
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`[${LABEL}] ${e.message}\n`); process.exitCode = 3; });
}
