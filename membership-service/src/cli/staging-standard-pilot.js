#!/usr/bin/env node
/**
 * REAL Gaia Standard membership on Stripe TEST MODE against the STAGING database.
 * No fakes: real Stripe test-mode API, real webhooks (Stripe CLI -> loopback
 * receiver), real staging Postgres. One fictional member (@example.invalid).
 *
 *   node src/cli/staging-standard-pilot.js plan            # default: reads staging, prints the exact requests; sends nothing
 *   node src/cli/staging-standard-pilot.js listener --run  # books the Stripe CLI listener's own requests (3) in the ledger, before it starts
 *   node src/cli/staging-standard-pilot.js whoami --run    # which Stripe account the key belongs to; must equal EXPECTED_STRIPE_ACCOUNT_ID (1 request)
 *   node src/cli/staging-standard-pilot.js start  --run    # member + Stripe product/price/customer + Checkout URL       (6 requests)
 *        (tester pays on the Stripe page with 4242 4242 4242 4242; webhooks arrive through the receiver)
 *   node src/cli/staging-standard-pilot.js verify --run    # activation, 500 coins, entitlements, reconciliation         (4 requests)
 *   node src/cli/staging-standard-pilot.js cancel --run    # cancel AT PERIOD END (our policy: access until the paid period ends) (1 request)
 *   node src/cli/staging-standard-pilot.js status          # database only: subscription, cancel date, access, coins          (0 requests)
 *
 * Safety, in code:
 *   - staging database only (127.0.0.1:55500/gaia_membership_staging, MEMBERSHIP_ENV=staging);
 *   - STRIPE_TEST_SECRET_KEY must be rk_test_/sk_test_ (live refused by the client);
 *   - total budget ledger (--budget-ledger, budget 25): each step reserves its full
 *     count first and its cap equals that count; no automatic retries, so no
 *     hidden requests; a failure stops the step;
 *   - prints ids and statuses only, never keys or the member's email.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPool } from '../db.js';
import { createRequestCap } from '../providers/request-cap.js';
import { openLedger } from '../providers/budget-ledger.js';
import { createStripeClient } from '../providers/stripe/client.js';
import { createCheckoutSession, stripeCustomerOf } from '../providers/stripe/adapter.js';
import { fetchReconciliationPage, reconcilePage } from '../providers/stripe/reconcile.js';
import { seedCatalog, currentVersion } from '../plans.js';
import { resolveOrCreatePerson } from '../identity.js';
import { checkoutEligibility } from '../billing-guard.js';
import { evaluate } from '../entitlements.js';
import { walletView } from '../coins.js';
import { runMonthlyAllowance } from '../jobs/allowance.js';
import { launchState, addPilotMember } from '../launch.js';

const LABEL = 'standard-pilot';
export const BUDGET = 25;
export const STEP_REQUESTS = { whoami: 1, start: 6, verify: 4, cancel: 1 };     // first-run worst case; see plan()
export const CLI_LISTENER_RESERVE = 3;                                // Stripe CLI's own session calls, counted against the same budget
const STATE_FILE = '/var/lib/gaia-membership-staging/standard-pilot.json';
const EXPECTED = { coins: 500, priceCents: 4700, entitled: ['software.scan_analysis', 'courses.core', 'certification.foundational', 'support.group_coaching_monthly'], notEntitled: ['crm.ghl_subaccount', 'support.premium'] };

function assertStaging(env) {
  const u = new URL(env.MEMBERSHIP_DATABASE_URL || 'postgres://none');
  if (env.MEMBERSHIP_ENV !== 'staging' || u.hostname !== '127.0.0.1' || u.port !== '55500' || u.pathname !== '/gaia_membership_staging') {
    throw new Error('REFUSED: staging database only (127.0.0.1:55500/gaia_membership_staging with MEMBERSHIP_ENV=staging)');
  }
}
const readState = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const writeState = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(s, null, 1), { mode: 0o600 }); };

/** Exact Stripe requests the next step will send, computed from the staging database. */
async function planRequests(pool, state) {
  const v = await currentVersion(pool, 'standard');
  const price = v ? (await pool.query("SELECT id FROM plan_version_prices WHERE plan_version_id = $1 AND billing_interval = 'month'", [v.id])).rows[0] : null;
  const ref = price ? (await pool.query("SELECT 1 FROM provider_price_refs WHERE plan_version_price_id = $1 AND provider = 'stripe' AND NOT livemode", [price.id])).rowCount : 0;
  const customer = state.personId ? await stripeCustomerOf(pool, state.personId) : null;
  const start = (ref ? 0 : 4) + (customer ? 0 : 1) + 1;   // product get+create, price lookup+create | customer | checkout session
  return { catalogSeeded: Boolean(v), priceRef: Boolean(ref), customer: Boolean(customer), whoami: STEP_REQUESTS.whoami, start, verify: STEP_REQUESTS.verify, cancel: STEP_REQUESTS.cancel };
}

export async function main(argv = process.argv.slice(2), { env = process.env, fetch = globalThis.fetch, out = (s) => process.stdout.write(s + '\n'), stateFile = STATE_FILE } = {}) {
  const { values: a, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    run: { type: 'boolean', default: false }, 'budget-ledger': { type: 'string', default: '/root/.config/gaia-stripe-sandbox-budget.json' } } });
  const step = positionals[0] || 'plan';
  if (!['plan', 'listener', 'whoami', 'start', 'verify', 'cancel', 'status'].includes(step)) { out(`[${LABEL}] unknown step ${step}`); return 2; }
  assertStaging(env);
  const pool = createPool(env.MEMBERSHIP_DATABASE_URL, { max: 4 });
  try {
    const state = readState(stateFile);
    const p = await planRequests(pool, state);
    const ledger = openLedger(a['budget-ledger'], BUDGET);
    const mirror = (await pool.query('SELECT max(last_seen_at) AS t FROM legacy_memberships')).rows[0].t;
    const mirrorAgeH = mirror ? Math.round((Date.now() - new Date(mirror)) / 3600000) : null;

    if (step === 'status') {
      if (!state.personId) { out(`[${LABEL}] no pilot member yet`); return 0; }
      const sub = (await pool.query(`SELECT s.status, s.current_period_end, s.cancel_at FROM subscriptions s WHERE s.person_id = $1 ORDER BY s.created_at DESC LIMIT 1`, [state.personId])).rows[0];
      const e = (await evaluate(pool, state.personId)).entitlements;
      const w = await walletView(pool, state.personId);
      out(`[${LABEL}] subscription ${sub?.status || 'none'}; period ends ${sub?.current_period_end?.toISOString?.() || '-'}; cancel at ${sub?.cancel_at?.toISOString?.() || '-'}`);
      out(`[${LABEL}] access now: ${Object.keys(e).length ? 'yes' : 'no'} (${Object.keys(e).length} benefits); coins granted ${w.granted.coins}, purchased ${w.purchased.coins}`);
      return 0;
    }
    if (step === 'plan' || !a.run) {
      const total = p.whoami + p.start + p.verify + p.cancel + CLI_LISTENER_RESERVE;
      out(`[${LABEL}] staging: catalog ${p.catalogSeeded ? 'seeded' : 'NOT seeded (start seeds it, database only)'}; Stripe price ref ${p.priceRef ? 'exists' : 'will be created'}; customer ${p.customer ? 'exists' : 'will be created'}`);
      out(`[${LABEL}] legacy mirror age: ${mirrorAgeH ?? 'empty'} h (the duplicate-billing guard needs < 36 h: refresh with the read-only legacy import first if older)`);
      out(`[${LABEL}] planned Stripe requests (application, ledger-enforced): whoami ${p.whoami} + start ${p.start} + verify ${p.verify} + cancel ${p.cancel} = ${total - CLI_LISTENER_RESERVE}`);
      out(`[${LABEL}] plus Stripe CLI listener (outside the application, NOT enforceable by the ledger, booked as a reserve): ${CLI_LISTENER_RESERVE}  => total booked ${total}`);
      out(`[${LABEL}] expected account: ${env.EXPECTED_STRIPE_ACCOUNT_ID ? 'set' : 'NOT SET (whoami and start refuse without EXPECTED_STRIPE_ACCOUNT_ID)'}; GHL account fragment check: ${env.EXPECTED_STRIPE_ACCOUNT_FRAGMENT ? 'set' : 'not set'}`);
      out(`[${LABEL}] budget ledger: ${ledger.used} of ${ledger.budget} used; ${ledger.remaining()} left; ${total <= ledger.remaining() ? 'fits' : 'DOES NOT FIT'}`);
      const ls = await launchState(pool, { env });
      out(`[${LABEL}] launch flag: stored ${ls.stored}, ceiling ${ls.ceiling}, EFFECTIVE ${ls.effective}${ls.effective === 'OFF' ? ' (start refuses: set staging to INTERNAL_PILOT first)' : ''}`);
      out(`[${LABEL}] dry run: nothing sent${step !== 'plan' ? ' (pass --run to execute this step)' : ''}`);
      return total <= ledger.remaining() ? 0 : 2;
    }

    if (step === 'listener') {
      ledger.reserve(`${LABEL}:stripe-cli-listener`, CLI_LISTENER_RESERVE).done(null);
      out(`[${LABEL}] reserved ${CLI_LISTENER_RESERVE} requests for the Stripe CLI listener; ledger ${ledger.used} of ${ledger.budget}`);
      return 0;
    }
    const key = env.STRIPE_TEST_SECRET_KEY;
    if (!/^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(String(key || ''))) { out(`[${LABEL}] REFUSED: STRIPE_TEST_SECRET_KEY must be a test-mode key`); return 2; }
    if (!/^acct_[A-Za-z0-9]{8,}$/.test(String(env.EXPECTED_STRIPE_ACCOUNT_ID || ''))) { out(`[${LABEL}] REFUSED: set EXPECTED_STRIPE_ACCOUNT_ID (the acct_… shown in the Gaia Stripe dashboard)`); return 2; }
    if (step === 'start' && !state.accountVerified && !env.EXPECTED_STRIPE_ACCOUNT_FRAGMENT) { out(`[${LABEL}] REFUSED: run whoami first (or set EXPECTED_STRIPE_ACCOUNT_FRAGMENT if the key cannot read the account)`); return 2; }
    // Pre-flight (database only) so a refused step never consumes budget.
    if (step === 'start' && (await launchState(pool, { env })).effective === 'OFF') { out(`[${LABEL}] REFUSED: Membership 2.0 is OFF in staging (launch flag) - nothing sent, no budget used`); return 2; }
    if (step === 'start' && state.sessionId) { out(`[${LABEL}] REFUSED: a checkout already exists for this pilot (${state.sessionId})`); return 2; }
    if (step === 'verify' && !state.personId) { out(`[${LABEL}] REFUSED: run start first`); return 2; }
    if (step === 'cancel' && !state.subscriptionId) { out(`[${LABEL}] REFUSED: run verify first`); return 2; }
    const planned = p[step];
    const reservation = ledger.reserve(`${LABEL}:${step}`, planned);
    const cap = createRequestCap({ label: LABEL, max: Math.max(1, planned), fetch });
    const stripe = createStripeClient({ apiKey: key, fetch: cap.fetch, retry: { maxRetries: 0 } });
    if (stripe.livemode !== false) { out(`[${LABEL}] REFUSED: not test mode`); return 2; }
    try {
      if (step === 'whoami') {
        try {
          const acct = await stripe.get('/v1/account');
          const match = acct?.id === env.EXPECTED_STRIPE_ACCOUNT_ID;
          out(`[${LABEL}] key belongs to ${acct?.id} (${match ? 'matches' : 'DOES NOT match'} EXPECTED_STRIPE_ACCOUNT_ID)`);
          if (!match) return 2;
          writeState(stateFile, { ...state, accountVerified: acct.id, accountVerifiedAt: new Date().toISOString() });
        } catch (e) {
          out(`[${LABEL}] this key cannot read the account (${e.code || e.name}${e.details?.status ? ' ' + e.details.status : ''}); start will instead check the created price id against EXPECTED_STRIPE_ACCOUNT_FRAGMENT`);
          return 2;
        }
      }
      if (step === 'start') {
        if (state.sessionId) { out(`[${LABEL}] REFUSED: a checkout already exists for this pilot (${state.sessionId})`); return 2; }
        if ((await launchState(pool, { env })).effective === 'OFF') { out(`[${LABEL}] REFUSED: Membership 2.0 is OFF in staging (launch flag) - nothing sent`); return 2; }
        await seedCatalog(pool);
        const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
        const { personId } = await resolveOrCreatePerson(pool, { platform: 'email', kind: 'address', externalId: `pilot-standard-${stamp}@example.invalid` }, { linkedBy: LABEL });
        const pv = await currentVersion(pool, 'standard');
        const priceId = (await pool.query("SELECT id FROM plan_version_prices WHERE plan_version_id = $1 AND billing_interval = 'month'", [pv.id])).rows[0].id;
        if (env.EXPECTED_STRIPE_ACCOUNT_FRAGMENT) {
          // Same account as GHL? Stripe price ids carry an account-specific fragment; check it on the price
          // before any customer or checkout exists (ensureProductAndPrice is idempotent and DB-recorded).
          const { ensureProductAndPrice } = await import('../providers/stripe/adapter.js');
          const { priceId: pid } = await ensureProductAndPrice({ pool, stripe }, priceId);
          if (!pid.includes(env.EXPECTED_STRIPE_ACCOUNT_FRAGMENT)) { out(`[${LABEL}] STOPPED: price ${pid} is not in the expected Stripe account; no customer or checkout created`); return 2; }
          out(`[${LABEL}] price ${pid} carries the expected account fragment`);
        }
        await addPilotMember(pool, personId, { note: 'staging Standard pilot (fictional)' }, { actorType: 'admin', actorId: env.MEMBERSHIP_ADMIN_ACTOR || 'staging-pilot-runner' });
        const g = await checkoutEligibility(pool, personId, pv.id);
        if (g.status !== 'ok') { out(`[${LABEL}] guard: ${g.status} ${JSON.stringify(g.reasons || [])} - nothing sent`); return 2; }
        const s = await createCheckoutSession({ pool, stripe, env }, personId, priceId, {
          successUrl: 'https://gaiahealers.app/?pilot=standard-ok', cancelUrl: 'https://gaiahealers.app/?pilot=standard-cancel', idempotencyKey: `pilot-standard-${stamp}` });
        if (s.status !== 'ok') { out(`[${LABEL}] checkout: ${s.status}`); return 2; }
        writeState(stateFile, { personId, sessionId: s.sessionId, customerId: s.customerId, priceId: s.priceId, startedAt: new Date().toISOString() });
        out(`[${LABEL}] checkout session ${s.sessionId} for person ${personId}`);
        out(`[${LABEL}] OPEN THIS URL and pay with 4242 4242 4242 4242, any future date, any CVC: ${s.url}`);
      }
      if (step === 'verify') {
        if (!state.personId) { out(`[${LABEL}] REFUSED: run start first`); return 2; }
        const sub = (await pool.query(`SELECT s.id, s.status, s.provider_subscription_id, p.key FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id
                                          JOIN plans p ON p.id = v.plan_id WHERE s.person_id = $1 ORDER BY s.created_at DESC LIMIT 1`, [state.personId])).rows[0];
        const charge = (await pool.query("SELECT amount_cents, currency FROM payment_ledger WHERE person_id = $1 AND entry_type = 'charge'", [state.personId])).rows;
        const checks = [];
        const ok = (cond, what) => { checks.push(cond); out(`[${LABEL}] ${cond ? 'ok  ' : 'FAIL'} ${what}`); };
        ok(sub?.status === 'active' && sub?.key === 'standard', `membership active on Standard (${sub?.status || 'none'}, via verified webhooks)`);
        ok(charge.length === 1 && charge[0].amount_cents === EXPECTED.priceCents && charge[0].currency === 'USD', `one charge of $47.00 in the payment ledger (${charge.map((c) => c.amount_cents).join(',') || 'none'})`);
        await runMonthlyAllowance(pool);
        const w = await walletView(pool, state.personId);
        ok(w.granted.coins === EXPECTED.coins, `${EXPECTED.coins} monthly coins granted (${w.granted.coins})`);
        const e = (await evaluate(pool, state.personId)).entitlements;
        ok(EXPECTED.entitled.every((k) => e[k]) && EXPECTED.notEntitled.every((k) => !e[k]), 'Standard entitlements on, Professional-only ones off');
        const from = new Date(new Date(state.startedAt).getTime() - 3600000); const to = new Date(Date.now() + 300000);
        const page = await fetchReconciliationPage(stripe, { from, to, maxPages: 1 });
        const r = await reconcilePage(pool, page);
        ok(page.complete && r.mismatches.length === 0, `reconciliation: ${r.matched} matched, ${r.mismatches.length} mismatches${page.complete ? '' : ' (incomplete page)'}`);
        writeState(stateFile, { ...state, verifiedAt: new Date().toISOString(), subscriptionId: sub?.provider_subscription_id || null });
        if (!checks.every(Boolean)) return 1;
      }
      if (step === 'cancel') {
        if (!state.subscriptionId) { out(`[${LABEL}] REFUSED: run verify first`); return 2; }
        // Policy (spec §15, click-to-cancel): cancel AT PERIOD END, access continues until the paid period ends, end date shown.
        const local = (await pool.query("SELECT id FROM subscriptions WHERE provider = 'stripe' AND provider_subscription_id = $1", [state.subscriptionId])).rows[0];
        const { cancelAtPeriodEnd } = await import('../providers/stripe/adapter.js');
        const r = await cancelAtPeriodEnd({ pool, stripe }, local.id, { idempotencyKey: `pilot-standard-cancel-${local.id}` });
        out(`[${LABEL}] cancel_at_period_end=${r.cancelAtPeriodEnd}; access continues until ${r.accessEndsAt.toISOString()}, then ends (no renewal is billed)`);
        const e = (await evaluate(pool, state.personId)).entitlements;
        out(`[${LABEL}] ${e['software.scan_analysis'] ? 'ok  ' : 'FAIL'} member still has Standard access until that date`);
        writeState(stateFile, { ...state, cancelScheduledFor: r.accessEndsAt.toISOString() });
      }
      return 0;
    } finally {
      reservation.done(cap.used());
      out(`[${LABEL}] Stripe requests sent this step: ${cap.used()} (reserved ${planned}); ledger ${ledger.used} of ${ledger.budget}`);
    }
  } finally { await pool.end(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`[${LABEL}] ${e.message}\n`); process.exitCode = 2; });
}
