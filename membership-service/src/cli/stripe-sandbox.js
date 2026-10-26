#!/usr/bin/env node
/**
 * Stripe SANDBOX runner for docs/membership/SANDBOX-TEST-PLAN.md — Stripe TEST
 * MODE ONLY. Not run by anything; run by hand only after the plan's §1 approvals.
 *
 *   node src/cli/stripe-sandbox.js --scenario A           # DRY RUN (default): planned requests, nothing sent
 *   node src/cli/stripe-sandbox.js --scenario A,E --run   # execute (needs STRIPE_TEST_SECRET_KEY)
 *     [--max-requests 25]
 *
 * Safety, enforced in code:
 *   - STRIPE_TEST_SECRET_KEY must be a sk_test_/rk_test_ key; anything else
 *     (live keys included) is refused. There is no live flag.
 *   - --scenario is required: one id, or an explicit list of at most 3.
 *   - Hard request cap per run (default 25, cleanup included). A plan above it
 *     is refused before anything is sent; the request that would exceed it
 *     throws (request-cap.js, counted at the fetch layer, retries included).
 *   - Prints object ids and statuses only; never keys, emails or names.
 *   - Fictional customers only (sandbox+<run>-<scenario>@example.invalid).
 *   - Cleans up what THIS run created, where Stripe allows: customers deleted
 *     (which cancels their test subscriptions), prices and products archived.
 *     Anything it could not clean up is listed by id.
 *
 * Automated here: A (subscription paid), B (declined), E (refunds), H (cancel at
 * period end), I (coin pack one-time charge), J (reconciliation fetch). The
 * other plan rows need a browser (C), a test clock (D), async disputes (F), the
 * Stripe CLI (G) or other providers (K-N), and are refused with a note.
 * Webhook-driven ledger checks need `stripe listen` and the webhook path; this
 * runner checks the Stripe side.
 *
 * Exit codes: 0 every scenario passed; 1 a scenario failed; 2 refused (key,
 * arguments, cap); 3 unexpected error.
 */
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createStripeClient, keyMode, STRIPE_API_BASE } from '../providers/stripe/client.js';
import { createRequestCap } from '../providers/request-cap.js';
import { fetchReconciliationPage } from '../providers/stripe/reconcile.js';

const LABEL = 'stripe-sandbox';
export const DEFAULT_MAX_REQUESTS = 25;
export const MAX_SCENARIOS_PER_RUN = 3;
const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9_]{8,}$/;

async function subscriptionSetup(ctx, sc) {
  const product = await ctx.post(sc, 'product', '/v1/products', { name: `Gaia sandbox ${ctx.runId}`, metadata: ctx.meta(sc) });
  ctx.track('product', product.id);
  const price = await ctx.post(sc, 'price', '/v1/prices', { product: product.id, currency: 'usd', unit_amount: 4700, recurring: { interval: 'month', interval_count: 1 }, metadata: ctx.meta(sc) });
  ctx.track('price', price.id);
  const cus = await ctx.customer(sc);
  const pm = await ctx.post(sc, 'attach', '/v1/payment_methods/pm_card_visa/attach', { customer: cus.id });
  const sub = await ctx.post(sc, 'subscription', '/v1/subscriptions', {
    customer: cus.id, items: [{ price: price.id }], default_payment_method: pm.id, payment_behavior: 'error_if_incomplete',
    expand: ['latest_invoice'], metadata: ctx.meta(sc),
  });
  const invoiceStatus = typeof sub.latest_invoice === 'object' ? sub.latest_invoice?.status : undefined;
  ctx.log(sc, `subscription ${sub.id} status=${sub.status} invoice=${typeof sub.latest_invoice === 'object' ? sub.latest_invoice?.id : sub.latest_invoice} invoice_status=${invoiceStatus}`);
  ctx.expect(sc, sub.status === 'active', 'subscription is active');
  ctx.expect(sc, invoiceStatus === 'paid', 'first invoice is paid');
  return sub;
}

async function payNow(ctx, sc, step, { amount, metadata = {}, paymentMethod = 'pm_card_visa' }) {
  const cus = ctx.customers.get(sc) || await ctx.customer(sc);
  return ctx.post(sc, step, '/v1/payment_intents', {
    amount, currency: 'usd', customer: cus.id, payment_method: paymentMethod, payment_method_types: ['card'], confirm: true,
    expand: ['latest_charge'], metadata: { ...ctx.meta(sc), ...metadata },
  });
}

/** Planned counts include cleanup. Keep them exact: the cap is checked against the sum. */
export const SCENARIOS = Object.freeze({
  A: { title: 'initial payment success (subscription, 4242 test card)', planned: 5 + 3,
    run: async (ctx) => { await subscriptionSetup(ctx, 'A'); } },
  B: { title: 'initial payment failure (declined test card)', planned: 2 + 1,
    run: async (ctx) => {
      try {
        const pi = await payNow(ctx, 'B', 'pi', { amount: 4700, paymentMethod: 'pm_card_chargeDeclined' });
        ctx.log('B', `payment_intent ${pi.id} status=${pi.status}`);
        ctx.expect('B', pi.status !== 'succeeded', 'a declined card never succeeds');
      } catch (e) {
        if (e.code === 'REQUEST_CAP_EXCEEDED') throw e;
        ctx.log('B', `declined: code=${e.details?.providerCode || e.code} status=${e.details?.status ?? '-'}`);
        ctx.expect('B', e.details?.providerCode === 'card_declined' || e.details?.providerCode === 'card_error', 'Stripe reports card_declined');
      }
    } },
  E: { title: 'refund (partial, duplicate request, then the rest)', planned: 5 + 1,
    run: async (ctx) => {
      const pi = await payNow(ctx, 'E', 'pi', { amount: 1000 });
      const ch = typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
      ctx.log('E', `payment_intent ${pi.id} status=${pi.status} charge=${ch?.id ?? pi.latest_charge}`);
      ctx.expect('E', pi.status === 'succeeded', 'payment succeeded');
      const r1 = await ctx.post('E', 'refund-1', '/v1/refunds', { payment_intent: pi.id, amount: 400, metadata: ctx.meta('E') });
      const dup = await ctx.post('E', 'refund-1', '/v1/refunds', { payment_intent: pi.id, amount: 400, metadata: ctx.meta('E') });
      const r2 = await ctx.post('E', 'refund-2', '/v1/refunds', { payment_intent: pi.id, amount: 600, metadata: ctx.meta('E') });
      ctx.log('E', `refund ${r1.id} status=${r1.status}; replay ${dup.id}; refund ${r2.id} status=${r2.status}`);
      ctx.expect('E', r1.status === 'succeeded' && r2.status === 'succeeded', 'both refunds succeeded');
      ctx.expect('E', dup.id === r1.id, 'a replayed refund request returns the same refund (idempotency key)');
      ctx.ids.charges.push(ch?.id ?? pi.latest_charge); ctx.ids.refunds.push(r1.id, r2.id);
    } },
  H: { title: 'cancel at period end', planned: 5 + 1 + 3,
    run: async (ctx) => {
      const sub = await subscriptionSetup(ctx, 'H');
      const c = await ctx.post('H', 'cancel', `/v1/subscriptions/${encodeURIComponent(sub.id)}`, { cancel_at_period_end: true });
      ctx.log('H', `subscription ${c.id} status=${c.status} cancel_at_period_end=${c.cancel_at_period_end}`);
      ctx.expect('H', c.cancel_at_period_end === true && c.status === 'active', 'scheduled to cancel; access continues until the period end');
    } },
  I: { title: 'coin pack one-time payment (standalone charge, no invoice)', planned: 2 + 1,
    run: async (ctx) => {
      const pi = await payNow(ctx, 'I', 'pi', { amount: 1000, metadata: { gaia_coin_package_key: 'regular', gaia_coins: '1200' } });
      const ch = typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
      ctx.log('I', `payment_intent ${pi.id} status=${pi.status} charge=${ch?.id ?? pi.latest_charge} invoice=${ch?.invoice ?? null}`);
      ctx.expect('I', pi.status === 'succeeded', 'payment succeeded');
      ctx.expect('I', !!ch && !ch.invoice, 'the charge has no invoice (reconciled as a coin-pack charge)');
      ctx.ids.charges.push(ch?.id ?? pi.latest_charge);
    } },
  J: { title: 'reconciliation fetch over this run (1 page per list)', planned: 4,
    run: async (ctx) => {
      const page = await fetchReconciliationPage(ctx.stripe, { from: new Date(ctx.startedAt.getTime() - 120000), to: new Date(Date.now() + 120000), maxPages: 1 });
      ctx.log('J', `complete=${page.complete} invoices=${page.invoices.length} charges=${page.charges.length} refunds=${page.refunds.length} disputes=${page.disputes.length}`);
      const charges = new Set(page.charges.map((x) => x.id));
      const refunds = new Set(page.refunds.map((x) => x.id));
      ctx.expect('J', ctx.ids.charges.every((id) => charges.has(id)) && ctx.ids.refunds.every((id) => refunds.has(id)), 'every charge and refund made earlier in this run is listed');
    } },
});
export const MANUAL = Object.freeze({
  C: '3DS needs a browser challenge', D: 'dunning needs a Stripe test clock', F: 'disputes arrive asynchronously',
  G: 'needs the Stripe CLI (events resend)', K: 'GHL sandbox', L: 'partner sandbox', M: 'partner sandbox', N: 'cross-provider',
});

export function planRun(ids) {
  return ids.map((id) => ({ id, title: SCENARIOS[id].title, planned: SCENARIOS[id].planned }));
}

export async function main(argv = process.argv.slice(2), {
  env = process.env, fetch = globalThis.fetch, baseUrl = STRIPE_API_BASE, runId = crypto.randomBytes(5).toString('hex'),
  out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n'), sleep,
} = {}) {
  let a;
  try {
    a = parseArgs({ args: argv, strict: true, options: {
      scenario: { type: 'string' }, run: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, 'max-requests': { type: 'string' },
    } }).values;
  } catch (e) { err(`[${LABEL}] ${e.message}`); return 2; }
  const dryRun = a['dry-run'] || !a.run;

  if (!a.scenario) { err(`[${LABEL}] REFUSED: --scenario <id>[,<id>] is required (automated: ${Object.keys(SCENARIOS).join(', ')}).`); return 2; }
  const ids = [...new Set(a.scenario.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!ids.length || ids.length > MAX_SCENARIOS_PER_RUN) { err(`[${LABEL}] REFUSED: give 1 to ${MAX_SCENARIOS_PER_RUN} scenarios per run.`); return 2; }
  for (const id of ids) {
    if (MANUAL[id]) { err(`[${LABEL}] REFUSED: scenario ${id} is not automated (${MANUAL[id]}); run it by hand per the test plan.`); return 2; }
    if (!SCENARIOS[id]) { err(`[${LABEL}] REFUSED: unknown scenario ${id}.`); return 2; }
  }
  const max = a['max-requests'] === undefined ? DEFAULT_MAX_REQUESTS : Number(a['max-requests']);
  if (!Number.isInteger(max) || max < 1) { err(`[${LABEL}] REFUSED: --max-requests must be a positive whole number.`); return 2; }

  const plan = planRun(ids);
  const planned = plan.reduce((s, p) => s + p.planned, 0);
  for (const p of plan) out(`[${LABEL}] scenario ${p.id}: ${p.title} — planned requests: ${p.planned} (cleanup included)`);
  out(`[${LABEL}] planned Stripe test-mode requests: ${planned} | cap: ${max}`);
  if (planned > max) { err(`[${LABEL}] REFUSED: ${planned} planned requests exceed the cap of ${max}. Run fewer scenarios; raise --max-requests for one run only after approval.`); return 2; }

  // Key: test mode only, checked even for a dry run if one is set. Never echoed.
  const key = env.STRIPE_TEST_SECRET_KEY;
  if (key !== undefined && !(TEST_KEY.test(key) && keyMode(key) === 'test')) {
    err(`[${LABEL}] REFUSED: STRIPE_TEST_SECRET_KEY must be a Stripe TEST secret or restricted key (sk_test_/rk_test_). Live and other keys are never used.`);
    return 2;
  }
  if (dryRun) { out(`[${LABEL}] dry run: nothing sent. Pass --run to execute against Stripe test mode.`); return 0; }
  if (!key) { err(`[${LABEL}] REFUSED: STRIPE_TEST_SECRET_KEY is not set.`); return 2; }

  const cap = createRequestCap({ label: LABEL, max, fetch });
  cap.assertPlan(planned);
  const stripe = createStripeClient({ apiKey: key, fetch: cap.fetch, baseUrl, retry: { maxRetries: 1 }, ...(sleep ? { sleep } : {}) });
  if (stripe.livemode !== false) { err(`[${LABEL}] REFUSED: not a test-mode client.`); return 2; }

  const created = [];            // only what THIS run created, in creation order
  const failures = [];
  const ctx = {
    stripe, runId, startedAt: new Date(), customers: new Map(), ids: { charges: [], refunds: [] },
    meta: (sc) => ({ gaia_sandbox_run: runId, gaia_sandbox_scenario: sc }),
    log: (sc, s) => out(`[${LABEL}] [${sc}] ${s}`),
    track: (type, id) => { if (id) created.push({ type, id }); },
    expect: (sc, ok, what) => { out(`[${LABEL}] [${sc}] ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(`${sc}: ${what}`); },
    post: (sc, step, path, params) => stripe.post(path, params, { idempotencyKey: `gaia-sbx-${runId}-${sc}-${step}` }),
    async customer(sc) {
      const c = await ctx.post(sc, 'customer', '/v1/customers', { email: `sandbox+${runId}-${sc.toLowerCase()}@example.invalid`, name: 'Sandbox Tester', metadata: ctx.meta(sc) });
      ctx.track('customer', c.id); ctx.customers.set(sc, c);
      ctx.log(sc, `customer ${c.id} created`);
      return c;
    },
  };

  let code = 0;
  out(`[${LABEL}] run ${runId} (Stripe test mode)`);
  try {
    for (const id of ids) {
      try { await SCENARIOS[id].run(ctx); }
      catch (e) {
        if (e.code === 'REQUEST_CAP_EXCEEDED') throw e;
        failures.push(`${id}: ${e.code || e.name}`);
        out(`[${LABEL}] [${id}] FAIL error ${e.code || e.name} status=${e.details?.status ?? '-'} provider_code=${e.details?.providerCode ?? '-'}`);
      }
    }
  } catch (e) {
    err(`[${LABEL}] STOPPED: ${e.message}`);
    code = 2;
  }

  // Cleanup, newest first, only objects this run created; cap still applies.
  const left = [];
  for (const o of [...created].reverse()) {
    try {
      if (o.type === 'customer') { const r = await stripe.del(`/v1/customers/${encodeURIComponent(o.id)}`); out(`[${LABEL}] cleanup customer ${o.id} deleted=${r.deleted === true}`); }
      else if (o.type === 'price') { const r = await stripe.post(`/v1/prices/${encodeURIComponent(o.id)}`, { active: false }, { idempotencyKey: `gaia-sbx-${runId}-archive-${o.id}` }); out(`[${LABEL}] cleanup price ${o.id} active=${r.active}`); }
      else if (o.type === 'product') { const r = await stripe.post(`/v1/products/${encodeURIComponent(o.id)}`, { active: false }, { idempotencyKey: `gaia-sbx-${runId}-archive-${o.id}` }); out(`[${LABEL}] cleanup product ${o.id} active=${r.active}`); }
    } catch (e) {
      left.push(o);
      out(`[${LABEL}] cleanup ${o.type} ${o.id} FAILED (${e.code || e.name})`);
    }
  }
  if (left.length) out(`[${LABEL}] left behind in test mode (clean up by hand): ${left.map((o) => `${o.type} ${o.id}`).join(', ')}`);
  out(`[${LABEL}] Stripe requests made: ${cap.used()} of cap ${cap.max}${cap.refused() ? ` (${cap.refused()} refused by the cap)` : ''}`);
  if (code) return code;
  if (cap.refused()) { err(`[${LABEL}] STOPPED: request cap reached (${cap.max}) during cleanup; nothing past the cap was sent.`); return 2; }
  if (failures.length) { out(`[${LABEL}] FAILED: ${failures.join('; ')}`); return 1; }
  out(`[${LABEL}] all scenarios passed`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.exitCode = await main(); }
  catch (e) { process.stderr.write(`[${LABEL}] FAILED: ${e.code || e.name}\n`); process.exitCode = 3; }
}
