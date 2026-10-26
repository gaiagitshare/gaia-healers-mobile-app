import './_providers-deny-network.mjs';
/**
 * cli/stripe-setup.js + providers/stripe/setup.js against a LOOPBACK fake
 * Stripe: dry run sends nothing, --run refuses without a test key, an explicit
 * --max-requests and ledger budget, the event list is exactly the handler
 * table, existing objects are adopted or reported, never edited, and the
 * webhook secret is written to a 0600 file, never printed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { freshPool, SKIP, TEST_URL } from './_db.js';
import { fakeServer, fetchVia } from './_providers-fakes.js';
import { main } from '../src/cli/stripe-setup.js';
import { WEBHOOK_EVENTS, PORTAL_CONFIG_KEY, planSetup, seedSellablePrices, portalConfigurationParams, portalDifferences } from '../src/providers/stripe/setup.js';
import { stripeHandlers } from '../src/stripe/handlers.js';
import { seedCatalog } from '../src/plans.js';

const KEY = 'sk_test_' + 'x'.repeat(24);
const URLS = ['--webhook-url', 'https://staging.example.invalid/v1/webhooks/stripe', '--return-url', 'https://app.example.invalid/membership',
  '--privacy-url', 'https://app.example.invalid/privacy', '--terms-url', 'https://app.example.invalid/terms'];

async function fakeSetupStripe({ webhooks = [], portals = [] } = {}) {
  const db = { products: new Map(), prices: new Map(), webhooks: [...webhooks], portals: [...portals] };
  const idem = new Map();
  let n = 0;
  const id = (p) => `${p}_setup_${++n}`;
  const nested = (f, prefix) => Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith(prefix + '[')).map(([k, v]) => [k.slice(prefix.length + 1, -1), v]));
  const notFound = { status: 404, json: { error: { type: 'invalid_request_error', code: 'resource_missing' } } };
  const route = (r) => {
    if (!/^Bearer sk_test_/.test(r.headers.authorization || '')) return { status: 401, json: { error: { type: 'invalid_request_error', code: 'api_key_invalid' } } };
    const f = r.form || {};
    let m;
    if (r.method === 'GET' && (m = r.path.match(/^\/v1\/products\/(.+)$/))) return db.products.get(m[1]) ? { json: db.products.get(m[1]) } : notFound;
    if (r.method === 'POST' && r.path === '/v1/products') { const p = { id: f.id, object: 'product', name: f.name, metadata: nested(f, 'metadata'), livemode: false }; db.products.set(p.id, p); return { json: p }; }
    if (r.method === 'GET' && r.path === '/v1/prices') return { json: { object: 'list', data: [...db.prices.values()].filter((p) => r.query.getAll('lookup_keys[]').includes(p.lookup_key)), has_more: false } };
    if (r.method === 'POST' && r.path === '/v1/prices') {
      const p = { id: id('price'), object: 'price', product: f.product, currency: f.currency, unit_amount: Number(f.unit_amount), lookup_key: f.lookup_key,
        recurring: f['recurring[interval]'] ? { interval: f['recurring[interval]'], interval_count: Number(f['recurring[interval_count]']) } : null, metadata: nested(f, 'metadata'), livemode: false };
      db.prices.set(p.id, p); return { json: p };
    }
    if (r.method === 'GET' && r.path === '/v1/webhook_endpoints') return { json: { object: 'list', data: db.webhooks, has_more: false } };
    if (r.method === 'POST' && r.path === '/v1/webhook_endpoints') {
      const ev = new URLSearchParams(r.raw).getAll('enabled_events[]');   // repeated keys: the parsed form keeps only the last
      const w = { id: id('we'), object: 'webhook_endpoint', url: f.url, enabled_events: ev, metadata: nested(f, 'metadata'), livemode: false, form: f };
      db.webhooks.push(w); return { json: { ...w, secret: 'whsec_' + 'S'.repeat(32) } };
    }
    if (r.method === 'GET' && r.path === '/v1/billing_portal/configurations') return { json: { object: 'list', data: db.portals, has_more: false } };
    if (r.method === 'POST' && r.path === '/v1/billing_portal/configurations') {
      const feat = (k) => ({ enabled: f[`features[${k}][enabled]`] === 'true', ...(f[`features[${k}][mode]`] ? { mode: f[`features[${k}][mode]`] } : {}) });
      const c = { id: id('bpc'), object: 'billing_portal.configuration', livemode: false, metadata: nested(f, 'metadata'), form: f,
        features: Object.fromEntries(['payment_method_update', 'invoice_history', 'customer_update', 'subscription_cancel', 'subscription_update'].map((k) => [k, feat(k)])) };
      db.portals.push(c); return { json: c };
    }
    return { status: 404, json: { error: { type: 'invalid_request_error', code: 'unknown_route' } } };
  };
  const srv = await fakeServer((r) => {
    if (r.method !== 'POST') return route(r);
    const key = r.headers['idempotency-key'];
    if (!key) return { status: 400, json: { error: { code: 'idempotency_key_required_by_fake' } } };
    const h = crypto.createHash('sha256').update(r.path + r.raw).digest('hex');
    const prev = idem.get(key);
    if (prev) return prev.h === h ? prev.out : { status: 400, json: { error: { type: 'idempotency_error' } } };
    const out = route(r); idem.set(key, { h, out }); return out;
  });
  return { ...srv, db };
}

function harness() {
  const lines = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stripe-setup-'));
  return { lines, dir, ledger: path.join(dir, 'ledger.json'), secret: path.join(dir, 'webhook.env'),
    out: (s) => lines.push(s), err: (s) => lines.push(s), text: () => lines.join('\n') };
}
const noFetch = async () => { throw new Error('dry run must not send'); };

test('the webhook event list is exactly the pipeline handler table', () => {
  assert.deepEqual([...WEBHOOK_EVENTS].sort(), Object.keys(stripeHandlers).sort());
  assert.equal(WEBHOOK_EVENTS.length, 18);
});

test('plan: seed catalog = 3 paid tiers x 2 intervals; 3 requests per price + 1 per product; webhook 2; portal 2', () => {
  const prices = seedSellablePrices();
  assert.equal(prices.length, 6);
  const plan = planSetup({ prices });
  assert.equal(plan.sections.catalog.requests, 6 * 3 + 3);
  assert.equal(plan.total, 21 + 2 + 2);
  assert.ok(plan.sections.catalog.items.some((i) => i.lookupKey === 'gaia_standard_v1_month_usd' && i.productId === 'gaia_plan_standard' && i.amountCents === 4700));
  assert.equal(plan.sections.webhook.params, null, 'no URL given: recorded as missing, not invented');
  assert.throws(() => planSetup({ sections: ['catalog', 'coupons'] }), /sections must be/);
});

test('portal configuration: card update, invoices, cancel at period end ON; plan switching and profile edits OFF', () => {
  const p = portalConfigurationParams({ returnUrl: 'https://a.example.invalid/', privacyUrl: 'https://a.example.invalid/p', termsUrl: 'https://a.example.invalid/t' });
  assert.deepEqual(p.features, { payment_method_update: { enabled: true }, invoice_history: { enabled: true }, customer_update: { enabled: false },
    subscription_cancel: { enabled: true, mode: 'at_period_end' }, subscription_update: { enabled: false } });
  assert.equal(p.metadata.gaia_config, PORTAL_CONFIG_KEY);
  assert.throws(() => portalConfigurationParams({ returnUrl: 'http://a.example.invalid/', privacyUrl: 'https://x.invalid', termsUrl: 'https://x.invalid' }), /https/);
  assert.deepEqual(portalDifferences({ features: { ...p.features, subscription_update: { enabled: true } } }, p), ['subscription_update.enabled']);
});

test('dry run is the default: sends nothing, prints the plan, the events and the count', async () => {
  const h = harness();
  const code = await main([...URLS], { env: {}, fetch: noFetch, out: h.out, err: h.err });
  assert.equal(code, 0);
  assert.match(h.text(), /seed catalog/);
  assert.match(h.text(), /planned Stripe requests: 25/);
  assert.match(h.text(), new RegExp(WEBHOOK_EVENTS.join(',').replace(/\./g, '\\.')));
  assert.match(h.text(), /plan switching OFF/);
  assert.match(h.text(), /dry run: nothing sent/);
  assert.ok(!fs.existsSync(h.ledger));
});

test('--run refusals: no or live key, no --max-requests, too small a cap, no ledger budget, no secret file, missing URLs', async () => {
  const srv = await fakeSetupStripe();
  try {
    const run = async (args, env = { STRIPE_TEST_SECRET_KEY: KEY }) => { const h = harness(); const c = await main(args, { env, fetch: fetchVia, baseUrl: srv.url, out: h.out, err: h.err }); return { c, t: h.text(), h }; };
    const base = ['--only', 'webhook,portal', ...URLS, '--run'];
    const s = harness();
    let r = await run([...base, '--max-requests', '4', '--budget-ledger', s.ledger, '--secret-file', s.secret], {});
    assert.equal(r.c, 2); assert.match(r.t, /test-mode key/);
    r = await run([...base, '--max-requests', '4', '--budget-ledger', s.ledger, '--secret-file', s.secret], { STRIPE_TEST_SECRET_KEY: 'sk_live_' + 'x'.repeat(24) });
    assert.equal(r.c, 2); assert.match(r.t, /test-mode key/);
    r = await run([...base, '--budget-ledger', s.ledger, '--secret-file', s.secret]);
    assert.equal(r.c, 2); assert.match(r.t, /explicit --max-requests/);
    r = await run([...base, '--max-requests', '3', '--budget-ledger', s.ledger, '--secret-file', s.secret]);
    assert.equal(r.c, 2); assert.match(r.t, /4 planned requests exceed --max-requests 3/);
    r = await run([...base, '--max-requests', '4', '--budget-ledger', s.ledger]);
    assert.equal(r.c, 2); assert.match(r.t, /--secret-file/);
    r = await run(['--only', 'portal', '--run', '--max-requests', '2', '--budget-ledger', s.ledger]);
    assert.equal(r.c, 2); assert.match(r.t, /--return-url \(https\) is required/);
    fs.writeFileSync(s.ledger, JSON.stringify({ budget: 25, used: 22, runs: [] }));
    r = await run([...base, '--max-requests', '4', '--budget-ledger', s.ledger, '--secret-file', s.secret]);
    assert.equal(r.c, 2); assert.match(r.t, /ledger has 3 of 25 left/);
    r = await run(['--run', '--max-requests', '25', ...URLS, '--budget-ledger', s.ledger, '--secret-file', s.secret]);
    assert.equal(r.c, 2); assert.match(r.t, /needs MEMBERSHIP_DATABASE_URL/);
    assert.equal(srv.requests.length, 0, 'no refusal sent anything');
    assert.equal(JSON.parse(fs.readFileSync(s.ledger, 'utf8')).used, 22, 'no refusal consumed budget');
  } finally { await srv.close(); }
});

test('--run webhook + portal: creates both once, secret to a 0600 file and never printed; second run adopts, sends no POST', async () => {
  const srv = await fakeSetupStripe();
  try {
    const h = harness();
    const args = ['--only', 'webhook,portal', ...URLS, '--run', '--max-requests', '4', '--budget-ledger', h.ledger, '--secret-file', h.secret];
    assert.equal(await main(args, { env: { STRIPE_TEST_SECRET_KEY: KEY }, fetch: fetchVia, baseUrl: srv.url, out: h.out, err: h.err }), 0);
    assert.equal(srv.requests.length, 4);
    const we = srv.db.webhooks[0];
    assert.deepEqual(we.enabled_events.sort(), [...WEBHOOK_EVENTS].sort());
    assert.match(fs.readFileSync(h.secret, 'utf8'), /^STRIPE_TEST_WEBHOOK_SECRET=whsec_/);
    assert.equal(fs.statSync(h.secret).mode & 0o777, 0o600);
    assert.doesNotMatch(h.text(), /whsec_|sk_test_/);
    const bpc = srv.db.portals[0];
    assert.equal(bpc.form['features[subscription_update][enabled]'], 'false');
    assert.equal(bpc.form['features[subscription_cancel][mode]'], 'at_period_end');
    assert.ok(srv.requests.filter((r) => r.method === 'POST').every((r) => r.headers['idempotency-key']?.startsWith('gaia-setup-')));
    assert.equal(JSON.parse(fs.readFileSync(h.ledger, 'utf8')).used, 4);

    const h2 = harness();
    const args2 = ['--only', 'webhook,portal', ...URLS, '--run', '--max-requests', '4', '--budget-ledger', h.ledger, '--secret-file', h2.secret];
    assert.equal(await main(args2, { env: { STRIPE_TEST_SECRET_KEY: KEY }, fetch: fetchVia, baseUrl: srv.url, out: h2.out, err: h2.err }), 0);
    assert.match(h2.text(), /webhook we_\S+: exists/);
    assert.match(h2.text(), /portal bpc_\S+: exists/);
    assert.equal(srv.requests.filter((r) => r.method === 'POST').length, 2, 'no new POST');
    assert.ok(!fs.existsSync(h2.secret));
  } finally { await srv.close(); }
});

test('--run conflicts are reported, never edited: other events on the same URL, a portal that allows plan switching', async () => {
  const srv = await fakeSetupStripe({
    webhooks: [{ id: 'we_old', object: 'webhook_endpoint', url: 'https://staging.example.invalid/v1/webhooks/stripe', enabled_events: ['invoice.paid', 'checkout.session.completed'], livemode: false }],
    portals: [{ id: 'bpc_old', object: 'billing_portal.configuration', livemode: false, metadata: { gaia_config: PORTAL_CONFIG_KEY },
      features: { payment_method_update: { enabled: true }, invoice_history: { enabled: true }, customer_update: { enabled: false }, subscription_cancel: { enabled: true, mode: 'at_period_end' }, subscription_update: { enabled: true } } }],
  });
  try {
    const h = harness();
    const code = await main(['--only', 'webhook,portal', ...URLS, '--run', '--max-requests', '4', '--budget-ledger', h.ledger, '--secret-file', h.secret],
      { env: { STRIPE_TEST_SECRET_KEY: KEY }, fetch: fetchVia, baseUrl: srv.url, out: h.out, err: h.err });
    assert.equal(code, 1);
    assert.match(h.text(), /webhook we_old: conflict .*extra checkout\.session\.completed.*NOT changed/);
    assert.match(h.text(), /portal bpc_old: conflict \(differs: subscription_update\.enabled; NOT changed\)/);
    assert.equal(srv.requests.filter((r) => r.method !== 'GET').length, 0);
  } finally { await srv.close(); }
});

test('--run catalog from the database: 3 products, 6 prices with lookup keys, refs recorded; a re-run plans 0 catalog requests', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeSetupStripe();
  try {
    await seedCatalog(pool);
    const env = { STRIPE_TEST_SECRET_KEY: KEY, MEMBERSHIP_DATABASE_URL: TEST_URL };
    const h = harness();
    const dry = await main(['--only', 'catalog'], { env, fetch: noFetch, out: h.out, err: h.err });
    assert.equal(dry, 0);
    assert.match(h.text(), /database \(published plan versions\): 6 prices, 3 products to ensure, 21 requests/);
    const code = await main(['--only', 'catalog', '--run', '--max-requests', '21', '--budget-ledger', h.ledger], { env, fetch: fetchVia, baseUrl: srv.url, out: h.out, err: h.err });
    assert.equal(code, 0, h.text());
    assert.ok(srv.requests.length <= 21);
    assert.equal(srv.db.products.size, 3);
    assert.deepEqual([...srv.db.prices.values()].map((p) => p.lookup_key).sort(), ['gaia_inner_circle_v1_month_usd', 'gaia_inner_circle_v1_year_usd',
      'gaia_professional_v1_month_usd', 'gaia_professional_v1_year_usd', 'gaia_standard_v1_month_usd', 'gaia_standard_v1_year_usd']);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_price_refs WHERE provider = 'stripe' AND NOT livemode")).rows[0].n, 6);
    const h2 = harness();
    await main(['--only', 'catalog'], { env, fetch: noFetch, out: h2.out, err: h2.err });
    assert.match(h2.text(), /0 products to ensure, 0 requests/);
  } finally { await srv.close(); await pool.end(); }
});

test('the CLI never enables live mode and has no live flag', () => {
  const src = fs.readFileSync(new URL('../src/cli/stripe-setup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /allowLive|allow-live/);
});
