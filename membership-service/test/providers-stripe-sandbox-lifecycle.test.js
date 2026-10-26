import './_providers-deny-network.mjs';
/**
 * Subscription-lifecycle scenarios of the Stripe sandbox runner (test clocks,
 * dunning, cancellations, plan changes, 3DS, checkout, events) against a
 * LOOPBACK fake Stripe. No database, no network. Every scenario must fit the
 * 25-request cap on its own, and must never send more than it planned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchVia, noSleep } from './_providers-fakes.js';
import { fakeSandboxStripe } from './_stripe-sandbox-fake.js';
import { main, SCENARIOS, DEFAULT_MAX_REQUESTS, CLOCK_MAX_POLLS } from '../src/cli/stripe-sandbox.js';

const KEY = 'rk_test_fixture_' + 'z'.repeat(16);
const LIFECYCLE = ['CHECKOUT', 'RENEW', 'DUNNING', 'CANCEL_END', 'CANCEL_NOW', 'CHANGE', '3DS', 'EVENTS'];

function harness(srv, { env = { STRIPE_TEST_SECRET_KEY: KEY }, sleeps = [] } = {}) {
  const lines = [];
  const opts = { env, fetch: fetchVia, baseUrl: srv.url, runId: 'life0001', sleep: async (ms) => { sleeps.push(ms); }, out: (s) => lines.push(s), err: (s) => lines.push(s) };
  return { lines, run: (argv) => main(argv, opts), text: () => lines.join('\n') };
}

async function runOne(id, fakeOpts) {
  const srv = await fakeSandboxStripe(fakeOpts);
  const sleeps = [];
  const h = harness(srv, { sleeps });
  const code = await h.run(['--scenario', id, '--run']);
  return { srv, h, code, sleeps, close: () => srv.close() };
}

test('every scenario fits the cap on its own; the cap is still 25', () => {
  assert.equal(DEFAULT_MAX_REQUESTS, 25);
  for (const [id, s] of Object.entries(SCENARIOS)) assert.ok(Number.isInteger(s.planned) && s.planned >= 1 && s.planned <= DEFAULT_MAX_REQUESTS, `${id} planned ${s.planned}`);
  assert.deepEqual(Object.fromEntries(LIFECYCLE.map((id) => [id, SCENARIOS[id].planned])),
    { CHECKOUT: 8, RENEW: 16, DUNNING: 20, CANCEL_END: 17, CANCEL_NOW: 9, CHANGE: 12, '3DS': 8, EVENTS: 1 });
});

test('dry run of every lifecycle scenario: plan printed with counts, nothing sent', async () => {
  const srv = await fakeSandboxStripe();
  try {
    const h = harness(srv);
    for (const id of LIFECYCLE) assert.equal(await h.run(['--scenario', id]), 0, id);
    assert.equal(await h.run(['--scenario', 'renew,cancel_now', '--dry-run']), 0, 'ids are case-insensitive');
    assert.equal(srv.requests.length, 0, 'dry run sends nothing');
    assert.match(h.text(), /scenario RENEW: .* planned requests: 16 \(cleanup included; at most: includes up to 5 test-clock status polls\)/);
    assert.match(h.text(), /scenario DUNNING: .* planned requests: 20 /);
    assert.match(h.text(), /scenario EVENTS: .* planned requests: 1 /);
    assert.match(h.text(), /planned Stripe test-mode requests: 25 \| cap: 25/);
  } finally { await srv.close(); }
});

test('combinations above the cap are refused before sending (DUNNING cannot share a run)', async () => {
  const srv = await fakeSandboxStripe();
  try {
    const h = harness(srv);
    assert.equal(await h.run(['--scenario', 'DUNNING,EVENTS,A', '--run']), 2);
    assert.match(h.text(), /REFUSED: 29 planned requests exceed the cap of 25/);
    assert.equal(await h.run(['--scenario', 'D', '--run']), 2, 'plan row D points at DUNNING');
    assert.match(h.text(), /automated as DUNNING/);
    assert.equal(await h.run(['--scenario', 'G', '--run']), 2, 'Stripe cannot be forced to retry');
    assert.match(h.text(), /stripe events resend/);
    assert.equal(srv.requests.length, 0);
  } finally { await srv.close(); }
});

for (const id of LIFECYCLE) {
  test(`${id}: passes against the fake, within its plan and the cap, and leaves nothing behind`, async () => {
    const r = await runOne(id);
    try {
      assert.equal(r.code, 0, r.h.text());
      assert.match(r.h.text(), /all scenarios passed/);
      assert.ok(r.srv.requests.length <= SCENARIOS[id].planned, `${r.srv.requests.length} requests > planned ${SCENARIOS[id].planned}`);
      assert.ok(r.srv.requests.length <= DEFAULT_MAX_REQUESTS);
      assert.match(r.h.text(), new RegExp(`Stripe requests made: ${r.srv.requests.length} of cap 25`));
      assert.equal(r.srv.db.customers.size, 0, 'customers deleted (directly or with their test clock)');
      assert.equal(r.srv.db.clocks.size, 0, 'test clocks deleted');
      assert.ok([...r.srv.db.products.values()].every((p) => !p.active) && [...r.srv.db.prices.values()].every((p) => !p.active), 'products and prices archived');
      assert.ok(r.srv.requests.every((q) => q.method !== 'POST' || /^gaia-sbx-life0001-/.test(q.headers['idempotency-key'])));
      const t = r.h.text();
      assert.ok(!t.includes(KEY) && !t.includes('rk_test_') && !t.includes('@example.invalid') && !t.includes('Sandbox Tester'), 'no key, email or name printed');
    } finally { await r.close(); }
  });
}

test('RENEW: customer on the clock, one advance, one poll, a new paid invoice; cleanup deletes the clock, not the customer', async () => {
  const r = await runOne('RENEW');
  try {
    const cus = r.srv.requests.find((q) => q.method === 'POST' && q.path === '/v1/customers');
    assert.match(cus.form.test_clock, /^clock_sbx_/);
    assert.equal(r.srv.requests.filter((q) => /\/advance$/.test(q.path)).length, 1);
    assert.equal(r.srv.requests.filter((q) => q.method === 'GET' && /test_clocks/.test(q.path)).length, 1, 'the fake is ready on the first poll');
    assert.deepEqual(r.sleeps, [2000], 'one wait before the one poll');
    assert.equal(r.srv.requests.filter((q) => q.method === 'DELETE' && q.path.startsWith('/v1/customers/')).length, 0);
    assert.equal(r.srv.requests.filter((q) => q.method === 'DELETE' && q.path.startsWith('/v1/test_helpers/test_clocks/')).length, 1);
    const adv = Number(r.srv.requests.find((q) => /\/advance$/.test(q.path)).form.frozen_time);
    const start = Number(r.srv.requests.find((q) => q.path === '/v1/test_helpers/test_clocks').form.frozen_time);
    assert.equal(adv - start, 33 * 86400, 'past one monthly period, below two');
    assert.match(r.h.text(), /billing_reason=subscription_cycle/);
  } finally { await r.close(); }
});

test('DUNNING: failing card, past_due with an attempted open invoice, retry with the good card, active again', async () => {
  const r = await runOne('DUNNING');
  try {
    assert.ok(r.srv.requests.some((q) => q.path === '/v1/payment_methods/pm_card_chargeCustomerFail/attach'));
    assert.match(r.h.text(), /status=past_due .*invoice_status=open attempt_count=1/);
    const pay = r.srv.requests.find((q) => /^\/v1\/invoices\/[^/]+\/pay$/.test(q.path));
    assert.equal(r.srv.db.pms.get(pay.form.payment_method).token, 'pm_card_visa', 'retried with the good card');
    assert.match(r.h.text(), /\[DUNNING\] ok {3}the subscription is active again/);
    assert.ok(r.srv.db.events.some((e) => e.type === 'invoice.payment_failed'));
  } finally { await r.close(); }
});

test('CANCEL_END: canceled after the period end, no renewal invoice', async () => {
  const r = await runOne('CANCEL_END');
  try {
    assert.match(r.h.text(), /\[CANCEL_END\] ok {3}canceled after the period end/);
    assert.equal([...r.srv.db.invoices.values()].filter((i) => i.billing_reason === 'subscription_cycle').length, 0);
  } finally { await r.close(); }
});

test('CHANGE: proration_behavior=none on both changes, no proration recorded, no new invoice', async () => {
  const r = await runOne('CHANGE');
  try {
    const changes = r.srv.requests.filter((q) => q.method === 'POST' && /^\/v1\/subscriptions\/sub_/.test(q.path));
    assert.equal(changes.length, 2);
    assert.ok(changes.every((q) => q.form.proration_behavior === 'none' && /^si_sbx_/.test(q.form['items[0][id]'])));
    assert.equal(r.srv.db.prorations.length, 0);
    assert.equal(r.srv.db.invoices.size, 1, 'only the first invoice');
  } finally { await r.close(); }
});

test('3DS: allow_incomplete, the subscription is incomplete and its invoice open', async () => {
  const r = await runOne('3DS');
  try {
    const sub = r.srv.requests.find((q) => q.path === '/v1/subscriptions');
    assert.equal(sub.form.payment_behavior, 'allow_incomplete');
    assert.match(r.h.text(), /status=incomplete .*invoice_status=open/);
  } finally { await r.close(); }
});

test('EVENTS: one GET of at most 20, ids and types only', async () => {
  const srv = await fakeSandboxStripe();
  try {
    const h = harness(srv);
    assert.equal(await h.run(['--scenario', 'CANCEL_NOW,EVENTS', '--run']), 0, h.text());
    const ev = srv.requests.filter((q) => q.path === '/v1/events');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].query.get('limit'), '20');
    const lines = h.lines.filter((l) => /\[EVENTS\] event /.test(l));
    assert.ok(lines.length >= 3);
    assert.ok(lines.every((l) => /^\[stripe-sandbox\] \[EVENTS\] event evt_sbx_\d+ type=[a-z_.]+$/.test(l)), 'id and type only');
  } finally { await srv.close(); }
});

test('a clock that never becomes ready: bounded polls, scenario fails, the cap holds, leftovers listed', async () => {
  const r = await runOne('RENEW', { clockNeverReady: true });
  try {
    assert.equal(r.code, 1, r.h.text());
    assert.equal(r.srv.requests.filter((q) => q.method === 'GET' && /test_clocks/.test(q.path)).length, CLOCK_MAX_POLLS, 'exactly the bounded number of polls');
    assert.deepEqual(r.sleeps, [2000, 3000, 5000, 8000, 12000]);
    assert.ok(r.srv.requests.length <= SCENARIOS.RENEW.planned);
    assert.match(r.h.text(), /FAIL error CLOCK_NOT_READY/);
    assert.match(r.h.text(), /left behind in test mode \(clean up by hand\): test_clock clock_sbx_\d+/);
  } finally { await r.close(); }
});

test('the worst case is exactly the plan: slow clocks use every planned poll and never exceed the plan', async () => {
  for (const id of ['RENEW', 'DUNNING', 'CANCEL_END']) {
    const r = await runOne(id, { clockPollsUntilReady: CLOCK_MAX_POLLS });
    try {
      assert.equal(r.code, 0, r.h.text());
      assert.equal(r.srv.requests.length, SCENARIOS[id].planned, `${id}: worst case = planned`);
    } finally { await r.close(); }
  }
});
