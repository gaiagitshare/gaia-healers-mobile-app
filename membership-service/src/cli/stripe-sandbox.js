#!/usr/bin/env node
/**
 * Stripe SANDBOX runner for docs/membership/SANDBOX-TEST-PLAN.md — Stripe TEST
 * MODE ONLY. Not run by anything; run by hand only after the plan's §1 approvals.
 * Credentials and permissions: docs/membership/STRIPE-SANDBOX-ACCESS.md.
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
 *     Planned counts are upper bounds: test-clock scenarios include their
 *     maximum number of clock status polls.
 *   - Prints object ids and statuses only; never keys, emails or names.
 *   - Fictional customers only (sandbox+<run>-<scenario>@example.invalid).
 *   - Cleans up what THIS run created, where Stripe allows: customers deleted
 *     (which cancels their test subscriptions), test clocks deleted (which
 *     deletes their customers and subscriptions), prices and products archived,
 *     checkout sessions expired. Anything it could not clean up is listed by id.
 *
 * Automated here (Stripe side only):
 *   A  subscription paid             B  declined card          E  refunds
 *   H  cancel at period end (flag)   I  coin pack charge       J  reconciliation fetch
 *   CHECKOUT    hosted checkout session created (paying it needs a browser) and expired
 *   RENEW       test clock: one period later the renewal invoice is paid
 *   DUNNING     test clock: renewal fails (pm_card_chargeCustomerFail), past_due, paid with a good card
 *   CANCEL_END  test clock: cancel_at_period_end, then past the period end it is canceled
 *   CANCEL_NOW  immediate cancellation
 *   CHANGE_UP   upgrade: invoice preview, always_invoice + pending_if_incomplete paid at once;
 *               then a failing card: the update stays pending, the item keeps its price
 *   CHANGE_DOWN downgrade at the period end on a test clock: subscription schedule, no
 *               proration; past the period end the renewal is billed at the lower price
 *   CHANGE_SWITCH monthly -> annual scheduled at the period end, then cancelled (released)
 *   3DS         pm_card_authenticationRequired: the subscription stays incomplete
 *   EVENTS      one page of recent events (ids and types) to pick from for a resend
 * Stripe cannot be made to retry a webhook; resends are done with the Dashboard
 * or `stripe events resend <evt_id>` (see STRIPE-SANDBOX-ACCESS.md §6).
 * Webhook-driven ledger checks need a webhook delivery path
 * (src/cli/staging-webhook-server.js); this runner checks the Stripe side.
 *
 * Exit codes: 0 every scenario passed; 1 a scenario failed; 2 refused (key,
 * arguments, cap); 3 unexpected error.
 */
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createStripeClient, keyMode, STRIPE_API_BASE } from '../providers/stripe/client.js';
import { createRequestCap } from '../providers/request-cap.js';
import { fetchReconciliationPage } from '../providers/stripe/reconcile.js';

const LABEL = 'stripe-sandbox';
export const DEFAULT_MAX_REQUESTS = 25;
export const MAX_SCENARIOS_PER_RUN = 3;
const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9_]{8,}$/;

const DAY = 86400;
/** Advance target for a monthly price: past one period end (and Stripe's ~1 h draft window), below two periods. */
export const ADVANCE_SECONDS = 33 * DAY;
/** Test clocks advance asynchronously: at most this many status polls per advance, with these waits before each. */
export const CLOCK_MAX_POLLS = 5;
export const CLOCK_POLL_DELAYS_MS = Object.freeze([2000, 3000, 5000, 8000, 12000]);
export const EVENTS_PAGE_LIMIT = 20;
const STANDARD_CENTS = 4700;
const PREMIUM_CENTS = 9700;
const TOP_CENTS = 29700;
const STANDARD_YEAR_CENTS = 47000;
const enc = encodeURIComponent;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idOf = (x) => (x && typeof x === 'object' ? x.id : x);
const invoiceOf = (sub) => (typeof sub?.latest_invoice === 'object' ? sub.latest_invoice : null);
const scenarioError = (code) => Object.assign(new Error(code), { code });

async function productAndPrices(ctx, sc, prices = [{ step: 'price', amount: STANDARD_CENTS }]) {
  const product = await ctx.post(sc, 'product', '/v1/products', { name: `Gaia sandbox ${ctx.runId}`, metadata: ctx.meta(sc) });
  ctx.track('product', product.id);
  const out = [];
  for (const p of prices) {
    const price = await ctx.post(sc, p.step, '/v1/prices', { product: product.id, currency: 'usd', unit_amount: p.amount, recurring: { interval: p.interval || 'month', interval_count: 1 }, metadata: ctx.meta(sc) });
    ctx.track('price', price.id);
    out.push(price);
  }
  return { product, prices: out };
}

async function createClock(ctx, sc) {
  const clock = await ctx.post(sc, 'clock', '/v1/test_helpers/test_clocks', { frozen_time: ctx.clockStart, name: `gaia-sbx-${ctx.runId}-${sc}` });
  ctx.track('test_clock', clock.id);
  ctx.log(sc, `test_clock ${clock.id} status=${clock.status} frozen_time=${clock.frozen_time}`);
  return clock;
}

/** Advance, then poll (bounded) until Stripe has finished billing. Throws CLOCK_NOT_READY otherwise. */
async function advanceClock(ctx, sc, clock, seconds = ADVANCE_SECONDS) {
  let c = await ctx.post(sc, 'advance', `/v1/test_helpers/test_clocks/${enc(clock.id)}/advance`, { frozen_time: ctx.clockStart + seconds });
  for (let i = 0; i < CLOCK_MAX_POLLS && c.status !== 'ready' && c.status !== 'internal_failure'; i++) {
    await ctx.sleep(CLOCK_POLL_DELAYS_MS[i]);
    c = await ctx.stripe.get(`/v1/test_helpers/test_clocks/${enc(clock.id)}`);
  }
  ctx.log(sc, `test_clock ${clock.id} status=${c.status} frozen_time=${c.frozen_time}`);
  ctx.expect(sc, c.status === 'ready', `test clock advanced ${Math.round(seconds / DAY)} days and finished billing`);
  if (c.status !== 'ready') throw scenarioError('CLOCK_NOT_READY');
  return c;
}

async function getSubscription(ctx, sub) {
  return ctx.stripe.get(`/v1/subscriptions/${enc(sub.id)}`, { 'expand[]': ['latest_invoice'] });
}

/**
 * product + price(s) + customer (optionally on a test clock) + card + subscription.
 * Requests: 1 + prices + 1 + 1 + 1.
 */
async function subscriptionSetup(ctx, sc, { clock = null, card = 'pm_card_visa', paymentBehavior = 'error_if_incomplete', prices, expectPaid = true } = {}) {
  const { prices: made } = await productAndPrices(ctx, sc, prices);
  const cus = await ctx.customer(sc, { testClock: clock?.id });
  const pm = await ctx.post(sc, 'attach', `/v1/payment_methods/${enc(card)}/attach`, { customer: cus.id });
  const sub = await ctx.post(sc, 'subscription', '/v1/subscriptions', {
    customer: cus.id, items: [{ price: made[0].id }], default_payment_method: pm.id, payment_behavior: paymentBehavior,
    expand: ['latest_invoice'], metadata: ctx.meta(sc),
  });
  const inv = invoiceOf(sub);
  ctx.log(sc, `subscription ${sub.id} status=${sub.status} invoice=${inv ? inv.id : sub.latest_invoice} invoice_status=${inv?.status}`);
  if (expectPaid) {
    ctx.expect(sc, sub.status === 'active', 'subscription is active');
    ctx.expect(sc, inv?.status === 'paid', 'first invoice is paid');
  }
  return { sub, pm, customer: cus, prices: made };
}

async function payNow(ctx, sc, step, { amount, metadata = {}, paymentMethod = 'pm_card_visa' }) {
  const cus = ctx.customers.get(sc) || await ctx.customer(sc);
  return ctx.post(sc, step, '/v1/payment_intents', {
    amount, currency: 'usd', customer: cus.id, payment_method: paymentMethod, payment_method_types: ['card'], confirm: true,
    expand: ['latest_charge'], metadata: { ...ctx.meta(sc), ...metadata },
  });
}

/**
 * Planned counts include cleanup. Keep them exact upper bounds: the cap is
 * checked against the sum. `polls` = clock status polls included in `planned`.
 */
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
      const { sub } = await subscriptionSetup(ctx, 'H');
      const c = await ctx.post('H', 'cancel', `/v1/subscriptions/${enc(sub.id)}`, { cancel_at_period_end: true });
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

  CHECKOUT: { title: 'hosted checkout session (subscription mode) created with Gaia metadata, then expired', planned: 5 + 3,
    run: async (ctx) => {
      const sc = 'CHECKOUT';
      const { prices: [price] } = await productAndPrices(ctx, sc);
      const cus = await ctx.customer(sc);
      const meta = ctx.meta(sc);
      const s = await ctx.post(sc, 'session', '/v1/checkout/sessions', {
        mode: 'subscription', customer: cus.id, client_reference_id: `sbx-${ctx.runId}`, line_items: [{ price: price.id, quantity: 1 }],
        success_url: 'https://example.invalid/gaia-sandbox/success', cancel_url: 'https://example.invalid/gaia-sandbox/cancel',
        metadata: meta, subscription_data: { metadata: meta },
      });
      ctx.log(sc, `checkout_session ${s.id} status=${s.status} mode=${s.mode}`);
      ctx.expect(sc, s.mode === 'subscription' && s.status === 'open' && /^https:\/\/checkout\.stripe\.com\//.test(String(s.url)), 'an open hosted checkout session with a Stripe checkout URL');
      ctx.expect(sc, s.metadata?.gaia_sandbox_run === ctx.runId, 'session metadata carries the Gaia keys');
      const x = await ctx.post(sc, 'expire', `/v1/checkout/sessions/${enc(s.id)}/expire`, {});
      ctx.log(sc, `checkout_session ${x.id} status=${x.status}`);
      ctx.expect(sc, x.status === 'expired', 'the unpaid session is expired (nothing can be paid on it any more)');
    } },

  RENEW: { title: 'renewal on a test clock: advance one period, the renewal invoice is paid', planned: 6 + 1 + CLOCK_MAX_POLLS + 1 + 3, polls: CLOCK_MAX_POLLS,
    run: async (ctx) => {
      const sc = 'RENEW';
      const clock = await createClock(ctx, sc);
      const { sub } = await subscriptionSetup(ctx, sc, { clock });
      const first = idOf(sub.latest_invoice);
      await advanceClock(ctx, sc, clock);
      const s = await getSubscription(ctx, sub);
      const inv = invoiceOf(s);
      ctx.log(sc, `subscription ${s.id} status=${s.status} latest_invoice=${inv?.id} invoice_status=${inv?.status} billing_reason=${inv?.billing_reason}`);
      ctx.expect(sc, !!inv && inv.id !== first, 'a new (renewal) invoice was created');
      ctx.expect(sc, inv?.status === 'paid' && s.status === 'active', 'the renewal invoice is paid and the subscription stays active');
    } },

  DUNNING: { title: 'failed renewal on a test clock: past_due, then paid with a good card', planned: 6 + 1 + 1 + 1 + CLOCK_MAX_POLLS + 1 + 1 + 1 + 3, polls: CLOCK_MAX_POLLS,
    run: async (ctx) => {
      const sc = 'DUNNING';
      const clock = await createClock(ctx, sc);
      const { sub, pm: good, customer } = await subscriptionSetup(ctx, sc, { clock });
      const bad = await ctx.post(sc, 'attach-fail', '/v1/payment_methods/pm_card_chargeCustomerFail/attach', { customer: customer.id });
      const u = await ctx.post(sc, 'use-failing-card', `/v1/subscriptions/${enc(sub.id)}`, { default_payment_method: bad.id });
      ctx.log(sc, `subscription ${u.id} default_payment_method=${idOf(u.default_payment_method)} (attaches, fails on charge)`);
      await advanceClock(ctx, sc, clock);
      const s = await getSubscription(ctx, sub);
      const inv = invoiceOf(s);
      ctx.log(sc, `subscription ${s.id} status=${s.status} latest_invoice=${inv?.id} invoice_status=${inv?.status} attempt_count=${inv?.attempt_count}`);
      ctx.expect(sc, s.status === 'past_due', 'the subscription is past_due after the failed renewal');
      ctx.expect(sc, inv?.status === 'open' && inv?.paid !== true && Number(inv?.attempt_count) >= 1, 'the renewal invoice is open, unpaid, attempted');
      if (!inv || inv.status !== 'open') throw scenarioError('NO_OPEN_INVOICE');
      const paid = await ctx.post(sc, 'retry-pay', `/v1/invoices/${enc(inv.id)}/pay`, { payment_method: good.id });
      ctx.log(sc, `invoice ${paid.id} status=${paid.status} (retried with a good card)`);
      ctx.expect(sc, paid.status === 'paid', 'the retry with a good card pays the invoice');
      const after = await getSubscription(ctx, sub);
      ctx.log(sc, `subscription ${after.id} status=${after.status}`);
      ctx.expect(sc, after.status === 'active', 'the subscription is active again');
    } },

  CANCEL_END: { title: 'cancel at period end on a test clock: past the period end the subscription is canceled', planned: 6 + 1 + 1 + CLOCK_MAX_POLLS + 1 + 3, polls: CLOCK_MAX_POLLS,
    run: async (ctx) => {
      const sc = 'CANCEL_END';
      const clock = await createClock(ctx, sc);
      const { sub } = await subscriptionSetup(ctx, sc, { clock });
      const c = await ctx.post(sc, 'cancel', `/v1/subscriptions/${enc(sub.id)}`, { cancel_at_period_end: true });
      ctx.log(sc, `subscription ${c.id} status=${c.status} cancel_at_period_end=${c.cancel_at_period_end}`);
      ctx.expect(sc, c.cancel_at_period_end === true && c.status === 'active', 'scheduled to cancel; still active before the period end');
      await advanceClock(ctx, sc, clock);
      const s = await getSubscription(ctx, sub);
      const inv = invoiceOf(s);
      ctx.log(sc, `subscription ${s.id} status=${s.status} latest_invoice=${inv?.id}`);
      ctx.expect(sc, s.status === 'canceled', 'canceled after the period end');
      ctx.expect(sc, inv?.id === idOf(sub.latest_invoice), 'no renewal invoice was created');
    } },

  CANCEL_NOW: { title: 'immediate cancellation', planned: 5 + 1 + 3,
    run: async (ctx) => {
      const sc = 'CANCEL_NOW';
      const { sub } = await subscriptionSetup(ctx, sc);
      const c = await ctx.stripe.del(`/v1/subscriptions/${enc(sub.id)}`);
      ctx.log(sc, `subscription ${c.id} status=${c.status} canceled_at=${c.canceled_at ?? '-'}`);
      ctx.expect(sc, c.status === 'canceled', 'canceled immediately');
    } },

  // The plan-change rules of providers/stripe/plan-change.js (owner decision 2026-10-26), Stripe side.
  CHANGE_UP: { title: 'upgrade: preview, always_invoice + pending_if_incomplete paid now; a failing card leaves the update pending', planned: 7 + 1 + 1 + 1 + 1 + 1 + 5,
    run: async (ctx) => {
      const sc = 'CHANGE_UP';
      const { sub, customer, prices: [, premium, top] } = await subscriptionSetup(ctx, sc, { prices: [
        { step: 'price', amount: STANDARD_CENTS }, { step: 'price-premium', amount: PREMIUM_CENTS }, { step: 'price-top', amount: TOP_CENTS }] });
      const item = sub.items?.data?.[0]?.id;
      if (!item) throw scenarioError('NO_SUBSCRIPTION_ITEM');
      const prorationDate = Math.floor(Date.now() / 1000);
      const pv = await ctx.post(sc, 'preview', '/v1/invoices/create_preview', { customer: customer.id, subscription: sub.id,
        subscription_details: { items: [{ id: item, price: premium.id, quantity: 1 }], proration_behavior: 'always_invoice', proration_date: prorationDate } });
      ctx.log(sc, `preview amount_due=${pv.amount_due} currency=${pv.currency}`);
      ctx.expect(sc, Number.isInteger(pv.amount_due) && pv.amount_due > 0, 'the preview shows a prorated amount due now');
      const up = await ctx.post(sc, 'upgrade', `/v1/subscriptions/${enc(sub.id)}`, { items: [{ id: item, price: premium.id, quantity: 1 }],
        proration_behavior: 'always_invoice', payment_behavior: 'pending_if_incomplete', proration_date: prorationDate, expand: ['latest_invoice'] });
      const inv = invoiceOf(up);
      ctx.log(sc, `upgrade: subscription ${up.id} status=${up.status} price=${idOf(up.items?.data?.[0]?.price)} pending_update=${up.pending_update ? 'yes' : 'no'} invoice=${inv?.id} invoice_status=${inv?.status} billing_reason=${inv?.billing_reason} amount_paid=${inv?.amount_paid}`);
      ctx.expect(sc, idOf(up.items?.data?.[0]?.price) === premium.id && !up.pending_update && up.status === 'active', 'paid: the item is on the higher price, nothing pending');
      ctx.expect(sc, inv?.status === 'paid' && inv?.billing_reason === 'subscription_update', 'the prorated invoice was charged at once (always_invoice)');
      ctx.expect(sc, inv?.amount_paid === pv.amount_due, 'the amount charged equals the preview (same proration date)');
      const bad = await ctx.post(sc, 'attach-fail', '/v1/payment_methods/pm_card_chargeCustomerFail/attach', { customer: customer.id });
      await ctx.post(sc, 'use-failing-card', `/v1/subscriptions/${enc(sub.id)}`, { default_payment_method: bad.id });
      const up2 = await ctx.post(sc, 'upgrade-fails', `/v1/subscriptions/${enc(sub.id)}`, { items: [{ id: item, price: top.id, quantity: 1 }],
        proration_behavior: 'always_invoice', payment_behavior: 'pending_if_incomplete', expand: ['latest_invoice'] });
      const inv2 = invoiceOf(up2);
      ctx.log(sc, `upgrade-fails: subscription ${up2.id} status=${up2.status} price=${idOf(up2.items?.data?.[0]?.price)} pending_update=${up2.pending_update ? 'yes' : 'no'} invoice_status=${inv2?.status}`);
      ctx.expect(sc, !!up2.pending_update && idOf(up2.items?.data?.[0]?.price) === premium.id, 'payment failed: the update is pending, the item keeps the current price');
      ctx.expect(sc, up2.status === 'active' && inv2?.status === 'open', 'the subscription stays active; the prorated invoice is open (Stripe lets the pending update expire)');
    } },

  CHANGE_DOWN: { title: 'downgrade at the period end (test clock): schedule, no proration, the renewal bills the lower price', planned: 1 + 6 + 2 + 1 + CLOCK_MAX_POLLS + 1 + 4, polls: CLOCK_MAX_POLLS,
    run: async (ctx) => {
      const sc = 'CHANGE_DOWN';
      const clock = await createClock(ctx, sc);
      const { sub, prices: [premium, standard] } = await subscriptionSetup(ctx, sc, { clock, prices: [{ step: 'price-premium', amount: PREMIUM_CENTS }, { step: 'price', amount: STANDARD_CENTS }] });
      const first = idOf(sub.latest_invoice);
      const sch = await ctx.post(sc, 'schedule', '/v1/subscription_schedules', { from_subscription: sub.id });
      const ph0 = sch.phases?.[0];
      ctx.expect(sc, !!ph0?.start_date && !!ph0?.end_date, 'the schedule starts from the current phase');
      if (!ph0) throw scenarioError('NO_SCHEDULE_PHASE');
      const upd = await ctx.post(sc, 'phases', `/v1/subscription_schedules/${enc(sch.id)}`, { end_behavior: 'release', proration_behavior: 'none',
        phases: [{ items: [{ price: premium.id, quantity: 1 }], start_date: ph0.start_date, end_date: ph0.end_date, proration_behavior: 'none' },
          { items: [{ price: standard.id, quantity: 1 }], iterations: 1, proration_behavior: 'none' }], metadata: ctx.meta(sc) });
      ctx.log(sc, `schedule ${upd.id} status=${upd.status} phases=${upd.phases?.length} switch_at=${upd.phases?.[0]?.end_date}`);
      ctx.expect(sc, idOf(upd.phases?.[1]?.items?.[0]?.price) === standard.id && upd.phases?.[0]?.end_date === ph0.end_date, 'the lower price starts at the period end');
      await advanceClock(ctx, sc, clock);
      const s = await getSubscription(ctx, sub);
      const inv = invoiceOf(s);
      ctx.log(sc, `subscription ${s.id} status=${s.status} price=${idOf(s.items?.data?.[0]?.price)} latest_invoice=${inv?.id} invoice_status=${inv?.status} amount_paid=${inv?.amount_paid} billing_reason=${inv?.billing_reason}`);
      ctx.expect(sc, idOf(s.items?.data?.[0]?.price) === standard.id && s.status === 'active', 'past the period end the subscription is on the lower price');
      ctx.expect(sc, !!inv && inv.id !== first && inv.status === 'paid' && inv.amount_paid === STANDARD_CENTS, 'the renewal invoice is paid at the lower price (no proration, no refund)');
    } },

  CHANGE_SWITCH: { title: 'monthly -> annual scheduled at the period end, then cancelled: the schedule is released, nothing changes', planned: 6 + 2 + 1 + 1 + 4,
    run: async (ctx) => {
      const sc = 'CHANGE_SWITCH';
      const { sub, prices: [month, year] } = await subscriptionSetup(ctx, sc, { prices: [{ step: 'price', amount: STANDARD_CENTS }, { step: 'price-year', amount: STANDARD_YEAR_CENTS, interval: 'year' }] });
      const first = idOf(sub.latest_invoice);
      const sch = await ctx.post(sc, 'schedule', '/v1/subscription_schedules', { from_subscription: sub.id });
      const ph0 = sch.phases?.[0];
      if (!ph0) throw scenarioError('NO_SCHEDULE_PHASE');
      const upd = await ctx.post(sc, 'phases', `/v1/subscription_schedules/${enc(sch.id)}`, { end_behavior: 'release', proration_behavior: 'none',
        phases: [{ items: [{ price: month.id, quantity: 1 }], start_date: ph0.start_date, end_date: ph0.end_date, proration_behavior: 'none' },
          { items: [{ price: year.id, quantity: 1 }], iterations: 1, proration_behavior: 'none' }], metadata: ctx.meta(sc) });
      ctx.expect(sc, idOf(upd.phases?.[1]?.items?.[0]?.price) === year.id, 'the annual price is scheduled for the period end');
      const rel = await ctx.post(sc, 'release', `/v1/subscription_schedules/${enc(sch.id)}/release`, {});
      ctx.log(sc, `schedule ${rel.id} status=${rel.status}`);
      ctx.expect(sc, rel.status === 'released', 'cancelled: the schedule is released');
      const s = await getSubscription(ctx, sub);
      ctx.log(sc, `subscription ${s.id} status=${s.status} price=${idOf(s.items?.data?.[0]?.price)} schedule=${idOf(s.schedule) ?? 'none'} latest_invoice=${idOf(s.latest_invoice)}`);
      ctx.expect(sc, idOf(s.items?.data?.[0]?.price) === month.id && !s.schedule && s.status === 'active', 'the member stays on the monthly price, no schedule');
      ctx.expect(sc, idOf(s.latest_invoice) === first, 'nothing was invoiced');
    } },

  '3DS': { title: '3DS required (pm_card_authenticationRequired): the subscription stays incomplete', planned: 5 + 3,
    run: async (ctx) => {
      const sc = '3DS';
      const { sub } = await subscriptionSetup(ctx, sc, { card: 'pm_card_authenticationRequired', paymentBehavior: 'allow_incomplete', expectPaid: false });
      const inv = invoiceOf(sub);
      ctx.expect(sc, sub.status === 'incomplete', 'the subscription is incomplete (no access before authentication)');
      ctx.expect(sc, inv?.status === 'open', 'the first invoice is open, not paid');
    } },

  EVENTS: { title: `recent events, one page of at most ${EVENTS_PAGE_LIMIT} (ids and types, to pick one for a resend)`, planned: 1,
    run: async (ctx) => {
      const sc = 'EVENTS';
      const list = await ctx.stripe.get('/v1/events', { limit: EVENTS_PAGE_LIMIT });
      const data = Array.isArray(list?.data) ? list.data.slice(0, EVENTS_PAGE_LIMIT) : [];
      for (const e of data) ctx.log(sc, `event ${e.id} type=${e.type}`);
      ctx.log(sc, `${data.length} event(s)${list?.has_more ? ', more exist (not fetched)' : ''}. Resend one to a test endpoint: stripe events resend <evt_id> --webhook-endpoint <we_id>`);
      ctx.expect(sc, list?.object === 'list', 'events listed');
    } },
});
export const MANUAL = Object.freeze({
  C: 'the 3DS browser challenge needs a browser; the Stripe side (subscription stays incomplete) is automated as 3DS',
  D: 'automated as DUNNING (test clock)',
  F: 'disputes arrive asynchronously',
  G: 'Stripe cannot be made to retry; list events with EVENTS, then resend with the Dashboard or `stripe events resend` (STRIPE-SANDBOX-ACCESS.md)',
  CHANGE: 'split into CHANGE_UP, CHANGE_DOWN and CHANGE_SWITCH (owner proration decision 2026-10-26)',
  K: 'GHL sandbox', L: 'partner sandbox', M: 'partner sandbox', N: 'cross-provider',
});

export function planRun(ids) {
  return ids.map((id) => ({ id, title: SCENARIOS[id].title, planned: SCENARIOS[id].planned, polls: SCENARIOS[id].polls || 0 }));
}

export async function main(argv = process.argv.slice(2), {
  env = process.env, fetch = globalThis.fetch, baseUrl = STRIPE_API_BASE, runId = crypto.randomBytes(5).toString('hex'),
  out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n'), sleep, now = () => Date.now(),
} = {}) {
  let a;
  try {
    a = parseArgs({ args: argv, strict: true, options: {
      scenario: { type: 'string' }, run: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, 'max-requests': { type: 'string' },
      'total-budget': { type: 'string' }, 'budget-ledger': { type: 'string' },
    } }).values;
  } catch (e) { err(`[${LABEL}] ${e.message}`); return 2; }
  const dryRun = a['dry-run'] || !a.run;

  if (!a.scenario) { err(`[${LABEL}] REFUSED: --scenario <id>[,<id>] is required (automated: ${Object.keys(SCENARIOS).join(', ')}).`); return 2; }
  const ids = [...new Set(a.scenario.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!ids.length || ids.length > MAX_SCENARIOS_PER_RUN) { err(`[${LABEL}] REFUSED: give 1 to ${MAX_SCENARIOS_PER_RUN} scenarios per run.`); return 2; }
  for (const id of ids) {
    if (MANUAL[id]) { err(`[${LABEL}] REFUSED: scenario ${id} is not automated (${MANUAL[id]}); run it by hand per the test plan.`); return 2; }
    if (!Object.hasOwn(SCENARIOS, id)) { err(`[${LABEL}] REFUSED: unknown scenario ${id}.`); return 2; }
  }
  const max = a['max-requests'] === undefined ? DEFAULT_MAX_REQUESTS : Number(a['max-requests']);
  if (!Number.isInteger(max) || max < 1) { err(`[${LABEL}] REFUSED: --max-requests must be a positive whole number.`); return 2; }

  const plan = planRun(ids);
  const planned = plan.reduce((s, p) => s + p.planned, 0);
  for (const p of plan) out(`[${LABEL}] scenario ${p.id}: ${p.title} — planned requests: ${p.planned} (cleanup included${p.polls ? `; at most: includes up to ${p.polls} test-clock status polls` : ''})`);
  out(`[${LABEL}] planned Stripe test-mode requests: ${planned} | cap: ${max}`);
  if (planned > max) { err(`[${LABEL}] REFUSED: ${planned} planned requests exceed the cap of ${max}. Run fewer scenarios; raise --max-requests for one run only after approval.`); return 2; }

  // Optional budget across runs (the owner's "25 requests in total for the first smoke test"): a ledger file
  // records every request actually made; a run whose plan would take the total past the budget is refused.
  let ledger = null;
  if (a['total-budget'] !== undefined || a['budget-ledger'] !== undefined) {
    const total = Number(a['total-budget']);
    if (!a['budget-ledger'] || !Number.isInteger(total) || total < 1) { err(`[${LABEL}] REFUSED: --total-budget N and --budget-ledger <file> go together.`); return 2; }
    let state = { budget: total, used: 0, runs: [] };
    try { state = JSON.parse(fs.readFileSync(a['budget-ledger'], 'utf8')); } catch (e) { if (e.code !== 'ENOENT') { err(`[${LABEL}] REFUSED: budget ledger unreadable.`); return 2; } }
    if (state.budget !== total) { err(`[${LABEL}] REFUSED: ledger budget is ${state.budget}; it cannot be changed from the command line (new budget = new ledger, after approval).`); return 2; }
    out(`[${LABEL}] total budget: ${state.used} of ${total} used; this run plans ${planned}`);
    if (state.used + planned > total) { err(`[${LABEL}] REFUSED: ${state.used} used + ${planned} planned exceeds the total budget of ${total}.`); return 2; }
    ledger = { file: a['budget-ledger'], state };
  }
  const saveLedger = () => {
    fs.writeFileSync(ledger.file + '.tmp', JSON.stringify(ledger.state, null, 1), { mode: 0o600 });
    fs.renameSync(ledger.file + '.tmp', ledger.file);
  };

  // Key: test mode only, checked even for a dry run if one is set. Never echoed.
  const key = env.STRIPE_TEST_SECRET_KEY;
  if (key !== undefined && !(TEST_KEY.test(key) && keyMode(key) === 'test')) {
    err(`[${LABEL}] REFUSED: STRIPE_TEST_SECRET_KEY must be a Stripe TEST secret or restricted key (sk_test_/rk_test_). Live and other keys are never used.`);
    return 2;
  }
  if (dryRun) { out(`[${LABEL}] dry run: nothing sent. Pass --run to execute against Stripe test mode.`); return 0; }
  if (!key) { err(`[${LABEL}] REFUSED: STRIPE_TEST_SECRET_KEY is not set.`); return 2; }

  const cap = createRequestCap({ label: LABEL, max: ledger ? Math.min(max, planned) : max, fetch });
  cap.assertPlan(planned);
  if (ledger) {
    // Reserve the whole plan BEFORE sending anything: even a crash mid-run can never take the total past the budget.
    ledger.state.used += planned;
    ledger.state.runs.push({ runId, scenarios: ids, reserved: planned, requests: null, at: new Date(now()).toISOString() });
    saveLedger();
  }
  const stripe = createStripeClient({ apiKey: key, fetch: cap.fetch, baseUrl, retry: { maxRetries: 1 }, ...(sleep ? { sleep } : {}) });
  if (stripe.livemode !== false) { err(`[${LABEL}] REFUSED: not a test-mode client.`); return 2; }

  const created = [];            // only what THIS run created, in creation order
  const failures = [];
  const ctx = {
    stripe, runId, startedAt: new Date(now()), clockStart: Math.floor(now() / 1000), customers: new Map(), ids: { charges: [], refunds: [] },
    sleep: sleep || realSleep,
    meta: (sc) => ({ gaia_sandbox_run: runId, gaia_sandbox_scenario: sc }),
    log: (sc, s) => out(`[${LABEL}] [${sc}] ${s}`),
    track: (type, id) => { if (id) created.push({ type, id }); },
    expect: (sc, ok, what) => { out(`[${LABEL}] [${sc}] ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(`${sc}: ${what}`); },
    post: (sc, step, path, params) => stripe.post(path, params, { idempotencyKey: `gaia-sbx-${runId}-${sc}-${step}` }),
    async customer(sc, { testClock } = {}) {
      const c = await ctx.post(sc, 'customer', '/v1/customers', {
        email: `sandbox+${runId}-${sc.toLowerCase()}@example.invalid`, name: 'Sandbox Tester', metadata: ctx.meta(sc), ...(testClock ? { test_clock: testClock } : {}),
      });
      // A customer on a test clock is deleted with the clock; tracking it too would spend a request on a 404.
      if (!testClock) ctx.track('customer', c.id);
      ctx.customers.set(sc, c);
      ctx.log(sc, `customer ${c.id} created${testClock ? ` on test_clock ${testClock}` : ''}`);
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
      if (o.type === 'customer') { const r = await stripe.del(`/v1/customers/${enc(o.id)}`); out(`[${LABEL}] cleanup customer ${o.id} deleted=${r.deleted === true}`); }
      else if (o.type === 'test_clock') { const r = await stripe.del(`/v1/test_helpers/test_clocks/${enc(o.id)}`); out(`[${LABEL}] cleanup test_clock ${o.id} deleted=${r.deleted === true} (its customers and subscriptions go with it)`); }
      else if (o.type === 'price') { const r = await stripe.post(`/v1/prices/${enc(o.id)}`, { active: false }, { idempotencyKey: `gaia-sbx-${runId}-archive-${o.id}` }); out(`[${LABEL}] cleanup price ${o.id} active=${r.active}`); }
      else if (o.type === 'product') { const r = await stripe.post(`/v1/products/${enc(o.id)}`, { active: false }, { idempotencyKey: `gaia-sbx-${runId}-archive-${o.id}` }); out(`[${LABEL}] cleanup product ${o.id} active=${r.active}`); }
    } catch (e) {
      left.push(o);
      out(`[${LABEL}] cleanup ${o.type} ${o.id} FAILED (${e.code || e.name})`);
    }
  }
  if (left.length) out(`[${LABEL}] left behind in test mode (clean up by hand): ${left.map((o) => `${o.type} ${o.id}`).join(', ')}`);
  out(`[${LABEL}] Stripe requests made: ${cap.used()} of cap ${cap.max}${cap.refused() ? ` (${cap.refused()} refused by the cap)` : ''}`);
  if (ledger) {
    ledger.state.runs[ledger.state.runs.length - 1].requests = cap.used();   // the reservation stays: conservative, never refunded
    saveLedger();
    out(`[${LABEL}] total budget: ${ledger.state.used} of ${ledger.state.budget} reserved (${cap.used()} sent this run)`);
  }
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
