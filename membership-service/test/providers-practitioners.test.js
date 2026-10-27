import './_providers-deny-network.mjs';
/**
 * Gaia Practitioners HTTP adapter (CONTRACT PROPOSED, NOT CONFIRMED) against a
 * LOOPBACK fake partner, plus partner webhook ingestion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP } from './_db.js';
import { fakePartner, fetchVia, noSleep } from './_providers-fakes.js';
import { createPractitionersAdapter, CONTRACT_STATUS } from '../src/providers/practitioners/adapter.js';
import { ingestPartnerWebhook, signPartnerPayload } from '../src/providers/practitioners/webhooks.js';
import { mockAdapter } from '../src/partner/adapter.js';
import { processPending } from '../src/stripe/processor.js';

const TOKEN = 'partner-service-token-fixture-0001';
const ID = 'gp_fixture_1';
const SUB = { subscription_id: 's1', practitioner_account_id: ID, plan_code: 'scan_analysis', status: 'active', price_cents: 4700, currency: 'USD',
  interval: 'month', current_period_end: '2026-12-31T00:00:00Z', billing_owner: 'partner', billing_provider: 'stripe', modules: ['scan_analysis'] };
const BAL = { practitioner_account_id: ID, coins: 700, as_of: '2026-12-01T00:00:00Z' };
const TX = [
  { transaction_id: 't1', delta_coins: 500, source: 'grant', created_at: '2026-01-01T00:00:00Z' },
  { transaction_id: 't2', delta_coins: 600, source: 'purchase', payment_ref: 'pi_fixture', created_at: '2026-02-01T00:00:00Z' },
  { transaction_id: 't3', delta_coins: -400, source: 'spend', created_at: '2026-03-01T00:00:00Z' },
];
const base = `/v1/practitioners/${ID}`;
const ROUTES = {
  [base]: { practitioner_account_id: ID, status: 'active', email: 'p@example.invalid', gaia_contact_id: null },
  [`${base}/subscriptions`]: [{ data: [SUB] }, { data: [{ ...SUB, subscription_id: 's2', status: 'canceled', modules: ['chakras'] }] }],
  [`${base}/coins`]: [{ balance: BAL, data: TX.slice(0, 2) }, { balance: BAL, data: TX.slice(2) }],
  [`${base}/entitlements`]: [{ data: [{ module: 'scan_analysis', source: 'subscription', subscription_id: 's1' }] },
    { data: [{ module: 'chakras', source: 'promotion', ends_at: '2026-01-01T00:00:00Z' }, { module: 'scan_analysis', source: 'grant' }] }],
};
const adapterFor = (srv, extra = {}) => createPractitionersAdapter({ baseUrl: srv.url, serviceToken: TOKEN, fetch: fetchVia, sleep: noSleep, ...extra });

test('marked proposed; same interface as the mock adapter; reads validated, paged data', async () => {
  const srv = await fakePartner({ routes: ROUTES, token: TOKEN });
  try {
    const a = adapterFor(srv);
    assert.equal(a.contractStatus, 'proposed-not-confirmed');
    assert.equal(CONTRACT_STATUS, 'proposed-not-confirmed');
    for (const m of Object.keys(mockAdapter())) assert.equal(typeof a[m], 'function', m);
    assert.equal((await a.getPractitioner(ID)).status, 'active');
    assert.deepEqual((await a.listSubscriptions(ID)).map((s) => s.subscription_id), ['s1', 's2']);
    const l = await a.getCoinLedger(ID);
    assert.equal(l.balance.coins, 700);
    assert.equal(l.transactions.length, 3, 'full history across pages');
    assert.deepEqual(await a.listModuleEntitlements(ID, { now: new Date('2026-12-01') }), ['scan_analysis'], 'expired entitlement dropped, duplicates merged');
    assert.ok(srv.requests.every((r) => r.method === 'GET' && r.headers.authorization === `Bearer ${TOKEN}`));
    assert.equal(srv.requests.filter((r) => r.path.endsWith('/coins'))[1].query.get('cursor'), 'cur_1');
  } finally { await srv.close(); }
});

test('invalid partner payloads are rejected at the boundary', async () => {
  const bad = {
    [base]: { practitioner_account_id: 'someone_else', status: 'active' },
    [`${base}/subscriptions`]: [{ data: [{ ...SUB, billing_owner: 'unknown' }] }],
    [`${base}/coins`]: [{ balance: { ...BAL, coins: 701 }, data: TX }],
    [`${base}/entitlements`]: [{ data: [{ module: 'x', source: 'magic' }] }],
  };
  const srv = await fakePartner({ routes: bad });
  try {
    const a = adapterFor(srv);
    await assert.rejects(a.getPractitioner(ID), /does not match/);
    await assert.rejects(a.listSubscriptions(ID), /billing_owner/);
    await assert.rejects(a.getCoinLedger(ID), /sum of its transactions/);
    await assert.rejects(a.listModuleEntitlements(ID), /source/);
    await assert.rejects(a.getPractitioner('../admin'), (e) => e.code === 'INVALID_INPUT');
  } finally { await srv.close(); }
});

test('pagination is bounded: repeated cursor, page cap, missing envelope, balance drift between pages', async () => {
  const srv = await fakePartner({ routes: {
    [`${base}/subscriptions`]: [{ data: [SUB], next_cursor: 'cur_0' }],
    [`${base}/coins`]: [{ balance: BAL, data: TX.slice(0, 2) }, { balance: { ...BAL, as_of: '2026-12-02T00:00:00Z' }, data: TX.slice(2) }],
    [`${base}/entitlements`]: { modules: ['x'] },
  } });
  try {
    await assert.rejects(adapterFor(srv).listSubscriptions(ID), /repeated a cursor/);
    await assert.rejects(adapterFor(srv, { maxPages: 1 }).getCoinLedger(ID), /exceeded 1 pages/);
    await assert.rejects(adapterFor(srv).getCoinLedger(ID), (e) => e.code === 'CONFLICT');
    await assert.rejects(adapterFor(srv).listModuleEntitlements(ID), /data: \[\], next_cursor/);
  } finally { await srv.close(); }
});

test('auth failure, 404 and outage map to standard errors; config is validated', async () => {
  const srv = await fakePartner({ routes: ROUTES, token: TOKEN });
  try {
    await assert.rejects(adapterFor(srv, { serviceToken: 'wrong-token-but-long-enough' }).getPractitioner(ID), (e) => e.code === 'PROVIDER_UNAVAILABLE' && e.details.status === 401);
    await assert.rejects(adapterFor(srv).getPractitioner('gp_unknown'), (e) => e.code === 'NOT_FOUND');
    srv.faults.push({ status: 503, json: {} }, { status: 503, json: {} });
    assert.equal((await adapterFor(srv).getPractitioner(ID)).status, 'active', 'transient outage retried');
    assert.throws(() => createPractitionersAdapter({ baseUrl: 'http://partner.example.invalid', serviceToken: TOKEN, fetch: fetchVia }), /https/);
    assert.throws(() => createPractitionersAdapter({ baseUrl: srv.url, serviceToken: 'short', fetch: fetchVia }), /token/);
  } finally { await srv.close(); }
});

// ---- webhooks -------------------------------------------------------------------

const SECRET = 'partner_whsec_fixture_' + 'p'.repeat(20);
const T = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);
const evt = (id, type, object) => ({ id, type, created: T, data: { object } });
const send = (pool, event, { secret = SECRET, at = T, raw } = {}) => {
  const body = raw ?? JSON.stringify(event);
  return ingestPartnerWebhook(pool, { rawBody: body, signatureHeader: signPartnerPayload(secret, body, at), secrets: [SECRET], now: T * 1000 });
};

test('partner webhooks: HMAC + timestamp verified, event id deduped, data validated, stored for async processing', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const e1 = evt('pevt_00000001', 'subscription.updated', SUB);
    assert.deepEqual(await send(pool, e1), { status: 200, body: { ok: true, duplicate: false } });
    assert.deepEqual(await send(pool, e1), { status: 200, body: { ok: true, duplicate: true } }, 'duplicate delivery stored once');
    assert.equal((await send(pool, e1, { secret: 'attacker_secret_' + 'z'.repeat(20) })).body.reason, 'signature_mismatch');
    assert.equal((await send(pool, e1, { at: T - 301 })).body.reason, 'timestamp_outside_tolerance', 'replay of an old delivery');
    assert.equal((await send(pool, evt('pevt_00000002', 'subscription.updated', { ...SUB, status: 'bogus' }))).body.reason, 'invalid_event_data');
    assert.equal((await send(pool, evt('pevt_00000003', 'coins.set_balance', {}))).body.reason, 'unknown_event_type');
    assert.equal((await send(pool, evt('x', 'coins.changed', { practitioner_account_id: ID }))).body.reason, 'invalid_event_id');
    assert.equal((await send(pool, { ...e1, data: { object: { ...SUB, price_cents: 1 } } })).status, 409, 'same id, different body is surfaced');
    assert.equal((await send(pool, evt('pevt_00000004', 'coins.changed', { practitioner_account_id: ID }))).status, 200);
    const rows = (await pool.query("SELECT event_id, status, livemode FROM webhook_events WHERE provider = 'partner' ORDER BY event_id")).rows;
    assert.deepEqual(rows.map((r) => r.event_id), ['pevt_00000001', 'pevt_00000004']);
    assert.ok(rows.every((r) => r.status === 'received' && r.livemode === false));
    const s = await processPending(pool, { provider: 'partner', handlers: {}, now: new Date(T * 1000 + 1000) });
    assert.equal(s.ignored, 2, 'no partner handlers until the contract is confirmed: events are kept, not acted on');
  } finally { await pool.end(); }
});
