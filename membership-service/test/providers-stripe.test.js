import './_providers-deny-network.mjs';
/**
 * Stripe test-mode adapter against a LOOPBACK fake Stripe. No request leaves
 * this machine; the fake enforces Idempotency-Key and test keys itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openLaunch, freshPool, SKIP, actor } from './_db.js';
import { fakeStripe, fakeServer, fetchVia, noSleep } from './_providers-fakes.js';
import { createStripeClient, encodeForm, keyMode } from '../src/providers/stripe/client.js';
import { ensureCustomer, ensureProductAndPrice, createCheckoutSession, createCoinPackCheckout, cancelAtPeriodEnd } from '../src/providers/stripe/adapter.js';
import { reconcilePage, reconcileStripe } from '../src/providers/stripe/reconcile.js';
import { seedCatalog, currentVersion, createDraftVersion, publishVersion } from '../src/plans.js';
import { resolveOrCreatePerson, identitiesOf } from '../src/identity.js';
import { createSubscription } from '../src/subscriptions.js';

const KEY = 'sk_test_fixture_' + 'x'.repeat(16);
const client = (srv, extra = {}) => createStripeClient({ apiKey: KEY, fetch: fetchVia, baseUrl: srv.url, sleep: noSleep, ...extra });
const URLS = { successUrl: 'https://gaiahealers.app/ok', cancelUrl: 'https://gaiahealers.app/cancel' };

async function priceIdOf(pool, planKey, interval) {
  const v = await currentVersion(pool, planKey);
  return (await pool.query('SELECT id FROM plan_version_prices WHERE plan_version_id = $1 AND billing_interval = $2', [v.id, interval])).rows[0].id;
}
const newPerson = async (pool, email) => (await resolveOrCreatePerson(pool, { platform: 'email', kind: 'address', externalId: email })).personId;

// ---- client, no database -----------------------------------------------------

test('live keys are refused unless allowLive is passed explicitly; junk keys are refused', () => {
  for (const k of ['sk_live_' + 'a'.repeat(24), 'rk_live_' + 'b'.repeat(24)]) {
    assert.throws(() => createStripeClient({ apiKey: k, fetch: fetchVia }), (e) => e.code === 'FORBIDDEN');
  }
  assert.equal(createStripeClient({ apiKey: 'sk_live_' + 'a'.repeat(24), fetch: fetchVia, allowLive: true }).livemode, true, 'only an explicit flag opens live mode');
  assert.throws(() => createStripeClient({ apiKey: 'pk_test_abcdefgh123', fetch: fetchVia }), (e) => e.code === 'INVALID_INPUT', 'publishable keys are not secrets');
  assert.throws(() => createStripeClient({ apiKey: KEY }), /explicit fetch/);
  assert.equal(keyMode(KEY), 'test');
});

test('form encoding matches Stripe bracket notation', () => {
  assert.equal(decodeURIComponent(encodeForm({ a: 1, metadata: { x: 'y z' }, line_items: [{ price: 'p', quantity: 1 }], expand: ['data'], b: true })),
    'a=1&metadata[x]=y z&line_items[0][price]=p&line_items[0][quantity]=1&expand[]=data&b=true');
});

test('every POST needs an idempotency key; a reused key with other params is CONFLICT', async () => {
  const srv = await fakeStripe();
  try {
    const s = client(srv);
    await assert.rejects(s.post('/v1/customers', { email: 'a@b.invalid' }), (e) => e.code === 'INVALID_INPUT');
    assert.equal(srv.requests.length, 0, 'refused before sending');
    const a = await s.post('/v1/customers', { email: 'a@b.invalid' }, { idempotencyKey: 'key-00000001' });
    const b = await s.post('/v1/customers', { email: 'a@b.invalid' }, { idempotencyKey: 'key-00000001' });
    assert.equal(a.id, b.id);
    await assert.rejects(s.post('/v1/customers', { email: 'other@b.invalid' }, { idempotencyKey: 'key-00000001' }), (e) => e.code === 'CONFLICT');
    assert.ok(srv.requests.every((r) => r.method !== 'POST' || r.headers['idempotency-key']));
  } finally { await srv.close(); }
});

test('a live-mode object returned to a test client is refused', async () => {
  const srv = await fakeStripe({ livemode: true });
  try {
    await assert.rejects(client(srv).post('/v1/customers', {}, { idempotencyKey: 'key-00000002' }), (e) => e.code === 'FORBIDDEN');
  } finally { await srv.close(); }
});

test('5xx retries reuse the same idempotency key; Stripe-Should-Retry:false stops retries', async () => {
  const srv = await fakeStripe();
  try {
    srv.faults.push({ status: 500, json: { error: { type: 'api_error' } } }, { status: 502, json: {} });
    const c = await client(srv).post('/v1/customers', {}, { idempotencyKey: 'key-00000003' });
    assert.match(c.id, /^cus_/);
    assert.equal(new Set(srv.requests.map((r) => r.headers['idempotency-key'])).size, 1);
    srv.requests.length = 0;
    srv.faults.push({ status: 500, headers: { 'stripe-should-retry': 'false' }, json: { error: { type: 'api_error' } } });
    await assert.rejects(client(srv).post('/v1/customers', {}, { idempotencyKey: 'key-00000004' }), (e) => e.code === 'PROVIDER_UNAVAILABLE');
    assert.equal(srv.requests.length, 1);
  } finally { await srv.close(); }
});

// ---- adapter + database ------------------------------------------------------

test('ensureCustomer creates once, links the identity, and is idempotent under concurrency', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeStripe();
  try {
    const deps = { pool, stripe: client(srv), env: process.env };
    const pid = await newPerson(pool, 'cust@example.invalid');
    const results = await Promise.all([ensureCustomer(deps, pid), ensureCustomer(deps, pid), ensureCustomer(deps, pid)]);
    assert.equal(new Set(results.map((r) => r.customerId)).size, 1);
    assert.equal(srv.db.customers.size, 1);
    const cus = [...srv.db.customers.values()][0];
    assert.equal(cus.metadata.gaia_person_id, pid);
    assert.equal(cus.email, 'cust@example.invalid');
    assert.ok((await identitiesOf(pool, pid)).some((i) => i.platform === 'stripe' && i.kind === 'customer' && i.external_id === cus.id));
    const posts = srv.requests.filter((r) => r.method === 'POST').length;
    assert.deepEqual(await ensureCustomer(deps, pid), { customerId: cus.id, created: false });
    assert.equal(srv.requests.filter((r) => r.method === 'POST').length, posts, 'a linked customer needs no Stripe call');
  } finally { await srv.close(); await pool.end(); }
});

test('ensureProductAndPrice: one product per plan, one price per version price, livemode=false, never edited', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeStripe();
  try {
    await seedCatalog(pool);
    await openLaunch(pool);
    const deps = { pool, stripe: client(srv), env: process.env };
    const m = await priceIdOf(pool, 'standard', 'month');
    const y = await priceIdOf(pool, 'standard', 'year');
    const a = await ensureProductAndPrice(deps, m);
    assert.equal(a.created, true);
    assert.deepEqual(await ensureProductAndPrice(deps, m), { priceId: a.priceId, created: false });
    const b = await ensureProductAndPrice(deps, y);
    assert.notEqual(a.priceId, b.priceId);
    assert.equal(srv.db.products.size, 1, 'monthly and annual share the plan product');
    const price = srv.db.prices.get(a.priceId);
    assert.equal(price.unit_amount, 4700);
    assert.equal(price.recurring.interval, 'month');
    assert.equal(price.metadata.gaia_plan_version_price_id, m);
    const refs = (await pool.query("SELECT livemode FROM provider_price_refs WHERE provider = 'stripe'")).rows;
    assert.deepEqual(refs.map((r) => r.livemode), [false, false]);

    // A price change is a NEW version, which gets a NEW Stripe price; the old one is untouched.
    const planId = (await pool.query("SELECT id FROM plans WHERE key = 'standard'")).rows[0].id;
    const v2 = await createDraftVersion(pool, planId, { prices: { month: 5200 }, entitlements: {}, monthlyCoinGrant: 500 }, actor);
    const v2price = (await pool.query("SELECT id FROM plan_version_prices WHERE plan_version_id = $1", [v2.id])).rows[0].id;
    await assert.rejects(ensureProductAndPrice(deps, v2price), (e) => e.code === 'PLAN_ARCHIVED', 'a draft version is not priced');
    await publishVersion(pool, v2.id, actor);
    const c = await ensureProductAndPrice(deps, v2price);
    assert.notEqual(c.priceId, a.priceId);
    assert.equal(srv.db.prices.get(a.priceId).unit_amount, 4700, 'old price unchanged');
    assert.ok(srv.requests.every((r) => !(r.method === 'POST' && /^\/v1\/prices\/.+/.test(r.path))), 'no price is ever updated');

    await assert.rejects(ensureProductAndPrice(deps, await priceIdOf(pool, 'free', 'none')), (e) => e.code === 'INVALID_INPUT', 'free is not billed');
  } finally { await srv.close(); await pool.end(); }
});

test('ensureProductAndPrice adopts an exactly matching price found by lookup key, refuses a mismatching one', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeStripe();
  try {
    await seedCatalog(pool);
    await openLaunch(pool);
    const deps = { pool, stripe: client(srv), env: process.env };
    const m = await priceIdOf(pool, 'professional', 'month');
    const first = await ensureProductAndPrice(deps, m);
    await pool.query('TRUNCATE provider_price_refs');            // simulate a crash after the Stripe call, before the insert
    assert.deepEqual(await ensureProductAndPrice(deps, m), { priceId: first.priceId, created: false });
    assert.equal(srv.db.prices.size, 1, 'no duplicate price');
    await pool.query('TRUNCATE provider_price_refs');
    srv.db.prices.get(first.priceId).unit_amount = 1;               // someone edited it in the dashboard
    await assert.rejects(ensureProductAndPrice(deps, m), (e) => e.code === 'CONFLICT');
  } finally { await srv.close(); await pool.end(); }
});

/** One ended legacy row for someone else: the mirror counts as loaded and fresh. */
async function seedLegacyMirror(pool) {
  await pool.query(`INSERT INTO legacy_memberships (external_subscription_id, payment_provider, mapping, reported_status, last_seen_at)
                    VALUES ('ghl-sub-fixture-mirror', 'stripe', 'mapped', 'canceled', now())`);
}

test('checkout session carries Gaia metadata; legacy, duplicate-plan and bad-input cases are refused', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeStripe();
  try {
    await seedCatalog(pool);
    await openLaunch(pool);
    const deps = { pool, stripe: client(srv), env: process.env };
    const pid = await newPerson(pool, 'buyer@example.invalid');
    const m = await priceIdOf(pool, 'standard', 'month');
    await seedLegacyMirror(pool);                                   // the guard needs a loaded legacy mirror
    const s = await createCheckoutSession(deps, pid, m, { ...URLS, idempotencyKey: 'req-checkout-1' });
    assert.equal(s.status, 'ok');
    assert.match(s.sessionId, /^cs_test_/);
    const f = srv.db.sessions.get(s.sessionId).form;
    const v = await currentVersion(pool, 'standard');
    assert.equal(f.mode, 'subscription');
    assert.equal(f['metadata[gaia_person_id]'], pid);
    assert.equal(f['metadata[gaia_plan_version_id]'], v.id);
    assert.equal(f['subscription_data[metadata][gaia_person_id]'], pid);
    assert.equal(f['line_items[0][price]'], s.priceId);
    assert.equal(f.client_reference_id, pid);
    const again = await createCheckoutSession(deps, pid, m, { ...URLS, idempotencyKey: 'req-checkout-1' });
    assert.equal(again.sessionId, s.sessionId, 'same request key, same session');
    await assert.rejects(createCheckoutSession(deps, pid, m, { ...URLS }), (e) => e.code === 'INVALID_INPUT', 'idempotency key required');
    await assert.rejects(createCheckoutSession(deps, pid, m, { ...URLS, successUrl: 'javascript:alert(1)', idempotencyKey: 'req-checkout-2' }), (e) => e.code === 'INVALID_INPUT');

    await createSubscription(pool, { personId: pid, planVersionId: v.id, interval: 'month', status: 'active' }, actor);
    assert.equal((await createCheckoutSession(deps, pid, m, { ...URLS, idempotencyKey: 'req-checkout-3' })).status, 'already_subscribed');

    const planId = (await pool.query("SELECT id FROM plans WHERE key = 'professional'")).rows[0].id;
    const legacy = await createDraftVersion(pool, planId, { prices: { month: 9700 }, isLegacy: true }, actor);
    await publishVersion(pool, legacy.id, actor);
    const lp = (await pool.query('SELECT id FROM plan_version_prices WHERE plan_version_id = $1', [legacy.id])).rows[0].id;
    await assert.rejects(createCheckoutSession(deps, pid, lp, { ...URLS, idempotencyKey: 'req-checkout-4' }), (e) => e.code === 'FORBIDDEN', 'legacy is never sold');
  } finally { await srv.close(); await pool.end(); }
});

test('coin pack checkout: draft packs are not sold; an active pack is a one-time payment with coin metadata', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeStripe();
  try {
    await seedCatalog(pool);
    await openLaunch(pool);
    const deps = { pool, stripe: client(srv), env: process.env };
    const pid = await newPerson(pool, 'coins@example.invalid');
    await assert.rejects(createCoinPackCheckout(deps, pid, 'starter', { ...URLS, idempotencyKey: 'req-coins-1' }), (e) => e.code === 'PLAN_ARCHIVED');
    assert.equal(srv.requests.length, 0, 'refused before any Stripe call');
    await pool.query("UPDATE coin_packages SET status = 'active' WHERE key = 'regular'");
    const closed = await createCoinPackCheckout(deps, pid, 'regular', { ...URLS, idempotencyKey: 'req-coins-x' });
    assert.deepEqual([closed.status, closed.reason], ['not_available', 'coins_need_membership2'], 'coin packs are for Membership 2.0 members');
    assert.equal(srv.requests.length, 0, 'still no Stripe call');
    await createSubscription(pool, { personId: pid, planVersionId: (await currentVersion(pool, 'standard')).id, interval: 'month', status: 'active' }, actor);
    const s = await createCoinPackCheckout(deps, pid, 'regular', { ...URLS, idempotencyKey: 'req-coins-2' });
    assert.equal(s.coins, 1200);
    const f = srv.db.sessions.get(s.sessionId).form;
    assert.equal(f.mode, 'payment');
    assert.equal(f['line_items[0][price_data][unit_amount]'], '1000');
    assert.equal(f['metadata[gaia_coin_package_key]'], 'regular');
    assert.equal(f['payment_intent_data[metadata][gaia_coins]'], '1200');
    assert.equal(f['metadata[gaia_person_id]'], pid);
  } finally { await srv.close(); await pool.end(); }
});

test('cancelAtPeriodEnd sets cancel_at_period_end on Stripe and schedules the same end locally', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeStripe();
  try {
    await seedCatalog(pool);
    await openLaunch(pool);
    const deps = { pool, stripe: client(srv), env: process.env };
    const pid = await newPerson(pool, 'cancel@example.invalid');
    const v = await currentVersion(pool, 'standard');
    const end = Math.floor(Date.parse('2027-01-01T00:00:00Z') / 1000);
    srv.db.subscriptions.set('sub_fake_c', { id: 'sub_fake_c', object: 'subscription', livemode: false, cancel_at_period_end: false, items: { data: [{ current_period_end: end }] } });
    const sid = await createSubscription(pool, { personId: pid, planVersionId: v.id, interval: 'month', provider: 'stripe', providerSubscriptionId: 'sub_fake_c', status: 'active' }, actor);
    const r = await cancelAtPeriodEnd(deps, sid);
    assert.equal(r.accessEndsAt.toISOString(), '2027-01-01T00:00:00.000Z');
    assert.equal(r.cancelAtPeriodEnd, true);
    const local = (await pool.query('SELECT status, cancel_at FROM subscriptions WHERE id = $1', [sid])).rows[0];
    assert.equal(local.status, 'active', 'access continues until the period end');
    assert.equal(local.cancel_at.toISOString(), '2027-01-01T00:00:00.000Z');
    const post = srv.requests.find((x) => x.path === '/v1/subscriptions/sub_fake_c');
    assert.equal(post.form.cancel_at_period_end, 'true');
    assert.ok(!('cancel_at' in post.form) && !srv.requests.some((x) => x.method === 'DELETE'), 'never an immediate cancel');
    const manual = await createSubscription(pool, { personId: pid, planVersionId: (await currentVersion(pool, 'professional')).id, interval: 'month', status: 'active' }, actor);
    await assert.rejects(cancelAtPeriodEnd(deps, manual), (e) => e.code === 'CONFLICT');
  } finally { await srv.close(); await pool.end(); }
});

// ---- reconciliation -----------------------------------------------------------

async function ledgerRow(pool, personId, type, id, entry, amount, at = '2026-12-01T10:00:00Z') {
  await pool.query(`INSERT INTO payment_ledger (person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, livemode, occurred_at)
                    VALUES ($1, 'stripe', $2, $3, $4, $5, 'USD', false, $6)`, [personId, type, id, entry, amount, at]);
}
const T = (iso) => Math.floor(Date.parse(iso) / 1000);

test('reconciliation: zero diff when the ledger matches; every kind of mismatch is reported; foreign objects skipped', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const pid = (await resolveOrCreatePerson(pool, { platform: 'stripe', kind: 'customer', externalId: 'cus_rec_1' })).personId;
    await ledgerRow(pool, pid, 'invoice', 'in_1', 'charge', 4700);
    await ledgerRow(pool, pid, 'refund', 're_1', 'refund', -4700);
    const window = { from: new Date('2026-12-01T00:00:00Z'), to: new Date('2026-12-02T00:00:00Z') };
    const page = {
      invoices: [{ id: 'in_1', status: 'paid', amount_paid: 4700, currency: 'usd', customer: 'cus_rec_1', created: T('2026-12-01T10:00:00Z') },
        { id: 'in_other', status: 'paid', amount_paid: 9900, currency: 'usd', customer: 'cus_not_gaia', created: T('2026-12-01T11:00:00Z') }],
      charges: [{ id: 'ch_1', invoice: 'in_1', paid: true, status: 'succeeded', amount: 4700, currency: 'usd', customer: 'cus_rec_1' }],
      refunds: [{ id: 're_1', status: 'succeeded', amount: 4700, currency: 'usd', charge: { customer: 'cus_rec_1' }, metadata: {} }],
      window, complete: true,
    };
    const ok = await reconcilePage(pool, page);
    assert.deepEqual(ok.mismatches, []);
    assert.equal(ok.matched, 2);
    assert.deepEqual(ok.skipped, [{ objectType: 'invoice', objectId: 'in_other' }]);

    await ledgerRow(pool, pid, 'invoice', 'in_ghost', 'charge', 100);          // in ledger, not in Stripe
    const bad = await reconcilePage(pool, {
      ...page,
      invoices: [{ ...page.invoices[0], amount_paid: 4800 }, { id: 'in_2', status: 'paid', amount_paid: 9700, currency: 'usd', customer: 'cus_rec_1' }],
      charges: [{ id: 'ch_pack', paid: true, status: 'succeeded', amount: 1000, currency: 'usd', customer: 'cus_rec_1' }],
      refunds: [{ ...page.refunds[0], currency: 'eur' }],
    });
    const kinds = bad.mismatches.map((x) => `${x.kind}:${x.objectId}`).sort();
    assert.deepEqual(kinds, ['amount_mismatch:in_1', 'currency_mismatch:re_1', 'missing_in_ledger:ch_pack', 'missing_in_ledger:in_2', 'missing_in_stripe:in_ghost']);
    const partial = await reconcilePage(pool, { ...page, complete: false });
    assert.ok(!partial.mismatches.some((x) => x.kind === 'missing_in_stripe'), 'an incomplete page proves no absence');
  } finally { await pool.end(); }
});

test('reconcileStripe pages through the fake API, records the run, alerts only on mismatch', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const invoices = Array.from({ length: 150 }, (_, i) => ({ id: `in_p${i}`, status: 'paid', amount_paid: 4700, currency: 'usd', customer: 'cus_rec_2', created: T('2026-12-01T01:00:00Z') }));
  const srv = await fakeStripe({ lists: { invoices } });
  try {
    const pid = (await resolveOrCreatePerson(pool, { platform: 'stripe', kind: 'customer', externalId: 'cus_rec_2' })).personId;
    for (const i of invoices) await ledgerRow(pool, pid, 'invoice', i.id, 'charge', 4700, '2026-12-01T01:00:00Z');
    const alerts = [];
    const window = { from: new Date('2026-12-01T00:00:00Z'), to: new Date('2026-12-02T00:00:00Z') };
    const r = await reconcileStripe({ pool, stripe: client(srv), env: process.env }, { ...window, alert: async (x) => alerts.push(x) });
    assert.equal(r.checked, 150);
    assert.deepEqual(r.mismatches, []);
    assert.equal(r.complete, true);
    assert.equal(alerts.length, 0);
    assert.equal(srv.requests.filter((x) => x.path === '/v1/invoices').length, 2, 'two pages of 100');
    assert.equal(srv.requests.filter((x) => x.path === '/v1/invoices')[1].query.get('starting_after'), 'in_p99');
    assert.equal(srv.requests.length, 5, '2 invoice pages + charges + refunds + disputes');

    invoices.push({ id: 'in_new', status: 'paid', amount_paid: 9700, currency: 'usd', customer: 'cus_rec_2', created: T('2026-12-01T02:00:00Z') });
    const r2 = await reconcileStripe({ pool, stripe: client(srv), env: process.env }, { ...window, alert: async (x) => alerts.push(x) });
    assert.equal(r2.mismatches.length, 1);
    assert.equal(alerts.length, 1);
    const runs = (await pool.query('SELECT mismatch_count, complete, livemode FROM reconciliation_runs ORDER BY created_at')).rows;
    assert.deepEqual(runs.map((x) => x.mismatch_count), [0, 1]);
    await assert.rejects(pool.query('DELETE FROM reconciliation_runs'), /append-only/);

    const r3 = await reconcileStripe({ pool, stripe: client(srv), env: process.env }, { ...window, maxPages: 1, alert: async (x) => alerts.push(x) });
    assert.equal(r3.complete, false, 'page cap reached: reported incomplete, never silently treated as complete');
    assert.equal(alerts.length, 2);
  } finally { await srv.close(); await pool.end(); }
});

test('reconciliation fetch failure is PROVIDER_UNAVAILABLE and records nothing', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeServer(() => ({ status: 503, json: {} }));
  try {
    const stripe = createStripeClient({ apiKey: KEY, fetch: fetchVia, baseUrl: srv.url, sleep: noSleep, retry: { maxRetries: 1 } });
    await assert.rejects(reconcileStripe({ pool, stripe }, { from: new Date('2026-12-01'), to: new Date('2026-12-02') }), (e) => e.code === 'PROVIDER_UNAVAILABLE');
    assert.equal(srv.requests.length, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reconciliation_runs')).rows[0].n, 0);
  } finally { await srv.close(); await pool.end(); }
});
