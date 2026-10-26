import './_providers-deny-network.mjs';
/**
 * Stripe sandbox runner (src/cli/stripe-sandbox.js) against a LOOPBACK fake
 * Stripe. No database, no network: refusals, dry run, the hard request cap at
 * the fetch layer, cleanup of what the run created, and output hygiene.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer, fetchVia, noSleep } from './_providers-fakes.js';
import { fakeSandboxStripe } from './_stripe-sandbox-fake.js';
import { main, SCENARIOS, DEFAULT_MAX_REQUESTS } from '../src/cli/stripe-sandbox.js';
import { createRequestCap, RequestCapError } from '../src/providers/request-cap.js';
import { createStripeClient } from '../src/providers/stripe/client.js';

const KEY = 'sk_test_fixture_' + 'y'.repeat(16);

function harness(srv, env = { STRIPE_TEST_SECRET_KEY: KEY }) {
  const lines = [];
  const opts = { env, fetch: fetchVia, baseUrl: srv.url, runId: 'run0001', sleep: noSleep, out: (s) => lines.push(s), err: (s) => lines.push(s) };
  return { lines, run: (argv) => main(argv, opts), text: () => lines.join('\n') };
}

test('request cap: the request that would exceed the cap throws before it is sent; a plan above the cap is refused', async () => {
  let sent = 0;
  const cap = createRequestCap({ label: 't', max: 2, fetch: async () => { sent++; return new Response('{}'); } });
  await cap.fetch('http://127.0.0.1/a'); await cap.fetch('http://127.0.0.1/b');
  await assert.rejects(cap.fetch('http://127.0.0.1/c'), (e) => e instanceof RequestCapError && e.code === 'REQUEST_CAP_EXCEEDED');
  assert.equal(sent, 2, 'the third request never reached the transport');
  assert.equal(cap.used(), 2);
  assert.equal(cap.refused(), 1);
  assert.throws(() => cap.assertPlan(3), (e) => e.code === 'REQUEST_CAP_EXCEEDED' && /REFUSED/.test(e.message));
  assert.equal(cap.assertPlan(2), 2);
  assert.throws(() => createRequestCap({ max: 0, fetch: () => {} }), /positive/);
});

test('request cap: http.js never retries a cap refusal (no backoff loop behind the cap)', async () => {
  const srv = await fakeServer(() => ({ status: 500, json: { error: { type: 'api_error' } } }));
  try {
    const cap = createRequestCap({ label: 't', max: 2, fetch: fetchVia });
    const stripe = createStripeClient({ apiKey: KEY, fetch: cap.fetch, baseUrl: srv.url, sleep: noSleep, retry: { maxRetries: 5 } });
    await assert.rejects(stripe.get('/v1/charges'), (e) => e.code === 'REQUEST_CAP_EXCEEDED');
    assert.equal(srv.requests.length, 2, 'two attempts sent, the third refused, no further retries');
    assert.equal(cap.refused(), 1);
  } finally { await srv.close(); }
});

test('dry run is the default: planned requests per scenario are printed and nothing is sent', async () => {
  const srv = await fakeSandboxStripe();
  try {
    const h = harness(srv);
    assert.equal(await h.run(['--scenario', 'A,E']), 0);
    assert.equal(await h.run(['--scenario', 'I', '--dry-run', '--run']), 0, '--dry-run wins over --run');
    assert.equal(await h.run(['--scenario', 'J']), 0);
    assert.equal(srv.requests.length, 0, 'dry run sends nothing');
    assert.match(h.text(), /scenario A: .* planned requests: 8/);
    assert.match(h.text(), /scenario E: .* planned requests: 6/);
    assert.match(h.text(), /planned Stripe test-mode requests: 14 \| cap: 25/);
    assert.match(h.text(), /dry run: nothing sent/);
    assert.equal(DEFAULT_MAX_REQUESTS, 25);
  } finally { await srv.close(); }
});

test('live keys and every non-test key are refused, in dry run and in a real run; the key is never printed', async () => {
  const srv = await fakeSandboxStripe();
  try {
    const bad = ['sk_live_' + 'a'.repeat(24), 'rk_live_' + 'b'.repeat(24), 'pk_test_' + 'c'.repeat(24), 'whsec_' + 'd'.repeat(24), 'sk_test_short', ''];
    for (const k of bad) {
      for (const argv of [['--scenario', 'A', '--run'], ['--scenario', 'A']]) {
        const h = harness(srv, { STRIPE_TEST_SECRET_KEY: k });
        assert.equal(await h.run(argv), 2, `refused: ${k.slice(0, 8)}…`);
        assert.match(h.text(), /REFUSED: STRIPE_TEST_SECRET_KEY must be a Stripe TEST/);
        if (k) assert.ok(!h.text().includes(k), 'the key is never echoed');
      }
    }
    const none = harness(srv, {});
    assert.equal(await none.run(['--scenario', 'A', '--run']), 2, 'no key, no run');
    assert.equal(srv.requests.length, 0, 'nothing was sent for any refused key');
  } finally { await srv.close(); }
});

test('scenario selection: required, at most 3, manual ones refused, a plan above the cap refused before sending', async () => {
  const srv = await fakeSandboxStripe();
  try {
    const h = harness(srv);
    assert.equal(await h.run(['--run']), 2, '--scenario is required');
    assert.equal(await h.run(['--scenario', 'A,B,E,I', '--run']), 2, 'at most 3 per run');
    assert.equal(await h.run(['--scenario', 'C', '--run']), 2, '3DS needs a browser');
    assert.equal(await h.run(['--scenario', 'Z', '--run']), 2);
    assert.equal(await h.run(['--scenario', 'A', '--run', '--bogus']), 2, 'unknown flags refused');
    assert.equal(await h.run(['--scenario', 'A,H,E', '--run', '--max-requests', '10']), 2, '23 planned > 10');
    assert.match(h.text(), /REFUSED: 23 planned requests exceed the cap of 10/);
    assert.equal(srv.requests.length, 0);
  } finally { await srv.close(); }
});

test('a full run: exact request count, Stripe-side expectations, cleanup of only what the run created, ids and statuses only', async () => {
  const srv = await fakeSandboxStripe();
  try {
    srv.db.customers.set('cus_preexisting', { id: 'cus_preexisting', object: 'customer', livemode: false });
    const h = harness(srv);
    assert.equal(await h.run(['--scenario', 'A,E,I', '--run']), 0, h.text());
    const planned = SCENARIOS.A.planned + SCENARIOS.E.planned + SCENARIOS.I.planned;
    assert.equal(srv.requests.length, planned, 'requests made = planned (cleanup included)');
    assert.match(h.text(), new RegExp(`Stripe requests made: ${planned} of cap 25`));
    assert.match(h.text(), /all scenarios passed/);
    assert.deepEqual([...srv.db.customers.keys()], ['cus_preexisting'], 'its own customers deleted, nobody else touched');
    assert.ok([...srv.db.products.values()].every((p) => p.active === false) && [...srv.db.prices.values()].every((p) => p.active === false), 'products and prices archived');
    const posted = srv.requests.filter((r) => r.path === '/v1/customers');
    assert.ok(posted.every((r) => /@example\.invalid$/.test(r.form.email)), 'fictional customers only');
    assert.ok(srv.requests.every((r) => r.method !== 'POST' || /^gaia-sbx-run0001-/.test(r.headers['idempotency-key'])), 'every POST has a run-scoped idempotency key');
    const t = h.text();
    assert.ok(!t.includes(KEY) && !t.includes('sk_test_') && !t.includes('@example.invalid') && !t.includes('Sandbox Tester'), 'no key, email or name in the output');

    const h2 = harness(srv);
    assert.equal(await h2.run(['--scenario', 'H,B', '--run']), 0, h2.text());
    assert.match(h2.text(), /\[B\] declined: code=card_declined/);
    assert.match(h2.text(), /cancel_at_period_end=true/);
  } finally { await srv.close(); }
});

test('J lists the charges and refunds made earlier in the same run', async () => {
  const srv = await fakeSandboxStripe();
  try {
    const h = harness(srv);
    assert.equal(await h.run(['--scenario', 'E,J', '--run']), 0, h.text());
    assert.match(h.text(), /\[J\] ok {3}every charge and refund made earlier in this run is listed/);
    assert.equal(srv.requests.filter((r) => r.method === 'GET').length, 4, 'one page per list');
  } finally { await srv.close(); }
});

test('the cap holds mid-run: a retry consumes budget, the request past the cap throws, leftovers are listed by id', async () => {
  const srv = await fakeSandboxStripe();
  try {
    srv.faults.push({ status: 500, json: { error: { type: 'api_error' } } });      // the first POST is retried once
    const h = harness(srv);
    const code = await h.run(['--scenario', 'A', '--run', '--max-requests', String(SCENARIOS.A.planned)]);
    assert.equal(code, 2);
    assert.equal(srv.requests.length, SCENARIOS.A.planned, 'never one request past the cap');
    assert.match(h.text(), /request cap reached \(8\)/);
    assert.match(h.text(), /left behind in test mode \(clean up by hand\): product prod_sbx_\d+/);
    assert.match(h.text(), /\(1 refused by the cap\)/);
  } finally { await srv.close(); }
});

test('the runner refuses to reach the network: real Stripe is unreachable from tests', async () => {
  const lines = [];
  const code = await main(['--scenario', 'I', '--run'], { env: { STRIPE_TEST_SECRET_KEY: KEY }, fetch: fetchVia, runId: 'run0002', sleep: noSleep, out: (s) => lines.push(s), err: (s) => lines.push(s) });
  assert.equal(code, 1, 'scenario fails: api.stripe.com is denied by the test network guard');
  assert.match(lines.join('\n'), /Stripe requests made: [0-9]+ of cap 25/);
});
