/**
 * Internal API end to end over loopback HTTP: authentication, scopes, tenant
 * isolation, quote -> hold -> capture/release, idempotency, no double charge,
 * failed jobs cost nothing, audit trail. Fictional people and prices only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, actor, person } from './_db.js';
import { createApiServer } from '../src/api/server.js';
import { createClient, revokeClient } from '../src/clients.js';
import { setActionPrice } from '../src/quotes.js';
import { seedCatalog, currentVersion, createPlan, createDraftVersion, publishVersion } from '../src/plans.js';
import { createSubscription } from '../src/subscriptions.js';
import { creditPurchase, grantAllowance } from '../src/coins.js';
import { linkIdentity } from '../src/identity.js';

let clockNow = new Date('2026-12-01T12:00:00Z');

async function boot() {
  const pool = await freshPool();
  await seedCatalog(pool);
  const server = createApiServer(pool, { clock: () => clockNow });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  return { pool, server, call, close: async () => { await new Promise((r) => server.close(r)); await pool.end(); } };
}

async function world(pool) {
  const member = await person(pool);
  const v = await currentVersion(pool, 'standard');
  await createSubscription(pool, { personId: member, planVersionId: v.id, interval: 'month', status: 'active', periodStart: new Date('2026-11-15T00:00:00Z'), periodEnd: new Date('2026-12-15T00:00:00Z') }, actor);
  await setActionPrice(pool, { actionKey: 'ai.scan_analysis', coins: 40, description: 'Automatic scan analysis (fixture price)' }, { actorType: 'admin', actorId: 'test-admin' });
  const proxy = await createClient(pool, { name: 'gaia-healers-proxy', scopes: ['identity:read', 'subscriptions:read', 'entitlements:read', 'wallet:read', 'coins:quote', 'coins:debit'] }, 'test-admin');
  return { member, proxy: proxy.token, proxyId: proxy.id };
}

test('authentication and scopes', { skip: SKIP }, async () => {
  const { pool, call, close } = await boot();
  try {
    const { member, proxy, proxyId } = await world(pool);
    assert.equal((await call(null, 'GET', '/v1/health')).status, 200);
    assert.equal((await call(null, 'GET', `/v1/persons/${member}/wallet`)).status, 401);
    assert.equal((await call('gms_' + 'x'.repeat(43), 'GET', `/v1/persons/${member}/wallet`)).status, 401);
    const reader = await createClient(pool, { name: 'read-only-fixture', scopes: ['entitlements:read'] }, 'test-admin');
    assert.equal((await call(reader.token, 'GET', `/v1/persons/${member}/wallet`)).json.code, 'FORBIDDEN');
    assert.equal((await call(reader.token, 'GET', `/v1/persons/${member}/entitlements?key=software.scan_analysis`)).json.entitled, true);
    await revokeClient(pool, proxyId, 'test-admin');
    assert.equal((await call(proxy, 'GET', `/v1/persons/${member}/wallet`)).status, 401, 'revocation is immediate');
    await assert.rejects(createClient(pool, { name: 'bad-tenant', scopes: ['coins:debit'], practitionerId: member }, 'test-admin'), (e) => e.code === 'FORBIDDEN');
  } finally { await close(); }
});

test('subscription status, entitlement checks and identity resolution', { skip: SKIP }, async () => {
  const { pool, call, close } = await boot();
  try {
    const { member, proxy } = await world(pool);
    await linkIdentity(pool, member, { platform: 'ghl', kind: 'contact', externalId: 'ghl-fixture-77' }, { linkedBy: 'test' });
    const id = await call(proxy, 'GET', '/v1/identities/resolve?platform=ghl&kind=contact&external_id=ghl-fixture-77');
    assert.equal(id.json.personId, member);
    const subs = await call(proxy, 'GET', `/v1/persons/${member}/subscriptions`);
    assert.equal(subs.json.subscriptions[0].plan_key, 'standard');
    assert.equal(subs.json.subscriptions[0].hasAccess, true);
    const ent = await call(proxy, 'GET', `/v1/persons/${member}/entitlements`);
    assert.equal(ent.json.entitlements['courses.core'], true);
    assert.equal(ent.json.entitlements['crm.ghl_subaccount'], undefined);
    assert.equal((await call(proxy, 'GET', '/v1/persons/00000000-0000-4000-8000-000000000000/subscriptions')).status, 404);
  } finally { await close(); }
});

test('tenant isolation: a practitioner client sees only its own members and plans', { skip: SKIP }, async () => {
  const { pool, call, close } = await boot();
  try {
    const { member } = await world(pool);
    const pracA = await person(pool), pracB = await person(pool);
    await pool.query("INSERT INTO entitlement_definitions (key, kind, description, owner_practitioner_id) VALUES ('practice.a.sessions', 'practice', 'A: monthly sessions (fixture)', $1)", [pracA]);
    const planA = await createPlan(pool, { key: 'prac_a_wellness', name: 'A wellness', ownerType: 'practitioner', practitionerId: pracA }, actor);
    const vA = await createDraftVersion(pool, planA, { prices: { month: 2500 }, entitlements: { 'practice.a.sessions': 2 } }, actor);
    await publishVersion(pool, vA.id, actor);
    const clientA = await person(pool);
    await createSubscription(pool, { personId: clientA, planVersionId: vA.id, interval: 'month', status: 'active' }, actor);
    await createSubscription(pool, { personId: member, planVersionId: vA.id, interval: 'month', status: 'active' }, actor);
    const tA = (await createClient(pool, { name: 'prac-a', scopes: ['subscriptions:read', 'entitlements:read'], practitionerId: pracA }, 'test-admin')).token;
    const tB = (await createClient(pool, { name: 'prac-b', scopes: ['subscriptions:read', 'entitlements:read'], practitionerId: pracB }, 'test-admin')).token;

    assert.equal((await call(tA, 'GET', `/v1/persons/${clientA}/subscriptions`)).status, 200);
    assert.equal((await call(tB, 'GET', `/v1/persons/${clientA}/subscriptions`)).status, 404, "B cannot see A's client");
    const both = await call(tA, 'GET', `/v1/persons/${member}/subscriptions`);
    assert.deepEqual(both.json.subscriptions.map((s) => s.plan_key), ['prac_a_wellness'], "A sees its own plan only, not the member's Gaia plan");
    const ent = await call(tA, 'GET', `/v1/persons/${member}/entitlements`);
    assert.deepEqual(ent.json.entitlements, { 'practice.a.sessions': 2 }, 'and only the benefits its plan grants');
    assert.equal((await call(tA, 'GET', '/v1/identities/resolve?platform=ghl&kind=contact&external_id=x')).status, 403);
    const denied = (await pool.query("SELECT count(*)::int n FROM audit_logs WHERE action = 'api.denied' AND actor_id = 'client:prac-b'")).rows[0].n;
    assert.ok(denied >= 1, 'denials are audited');
  } finally { await close(); }
});

test('quote -> hold -> capture: price is server-side, no double charge, idempotent', { skip: SKIP }, async () => {
  const { pool, call, close } = await boot();
  try {
    const { member, proxy } = await world(pool);
    await grantAllowance(pool, { personId: member, coins: 30, cycleKey: 'fixture:c1' });
    await creditPurchase(pool, { personId: member, coins: 100, idempotencyKey: 'pay-fixture-api-1', paymentRef: 'sim_pay_api_1' });
    const q = (await call(proxy, 'POST', '/v1/coins/quotes', { personId: member, action: 'ai.scan_analysis', coins: 1 })).json.quote;
    assert.equal(q.coins, 40, 'a client-sent amount is ignored');
    assert.equal(q.text, 'This costs 40 coins (≈ $0.40)');
    const H = { 'idempotency-key': 'job-api-fixture-0001' };
    assert.equal((await call(proxy, 'POST', '/v1/coins/holds', { personId: member, quoteId: q.quoteId })).status, 400, 'Idempotency-Key required');
    const [h1, h2] = await Promise.all([
      call(proxy, 'POST', '/v1/coins/holds', { personId: member, quoteId: q.quoteId }, H),
      call(proxy, 'POST', '/v1/coins/holds', { personId: member, quoteId: q.quoteId }, H)]);
    assert.deepEqual([h1.status, h2.status].sort(), [200, 201], 'double-click: one hold, one replay');
    assert.equal(h1.json.hold.operationId, h2.json.hold.operationId);
    const opId = h1.json.hold.operationId;
    assert.equal((await call(proxy, 'POST', '/v1/coins/holds', { personId: member, quoteId: q.quoteId }, { 'idempotency-key': 'job-api-fixture-0002' })).json.code, 'CONFLICT', 'a quote is single-use');
    const cap = await call(proxy, 'POST', `/v1/coins/holds/${opId}/capture`, { personId: member });
    assert.equal(cap.json.hold.status, 'captured');
    assert.equal((await call(proxy, 'POST', `/v1/coins/holds/${opId}/capture`, { personId: member })).json.replayed, true);
    const w = (await call(proxy, 'GET', `/v1/persons/${member}/wallet`)).json.wallet;
    assert.deepEqual([w.granted.coins, w.purchased.coins], [0, 90], 'granted first, then purchased');
    assert.equal(w.nextGrantAt, '2026-12-15T00:00:00.000Z');
    assert.deepEqual((await pool.query('SELECT * FROM wallet_mismatches()')).rows, []);
  } finally { await close(); }
});

test('a failed AI job costs nothing; insufficient coins and expired quotes are refused; only the holder settles', { skip: SKIP }, async () => {
  const { pool, call, close } = await boot();
  try {
    const { member, proxy } = await world(pool);
    await creditPurchase(pool, { personId: member, coins: 50, idempotencyKey: 'pay-fixture-api-2', paymentRef: 'sim_pay_api_2' });
    const quote = async () => (await call(proxy, 'POST', '/v1/coins/quotes', { personId: member, action: 'ai.scan_analysis' })).json.quote;
    const h = (await call(proxy, 'POST', '/v1/coins/holds', { personId: member, quoteId: (await quote()).quoteId }, { 'idempotency-key': 'job-api-fixture-0010' })).json.hold;
    const other = (await createClient(pool, { name: 'other-service', scopes: ['coins:debit'] }, 'test-admin')).token;
    assert.equal((await call(other, 'POST', `/v1/coins/holds/${h.operationId}/release`, { personId: member })).status, 404, "another client cannot settle this client's hold");
    await call(proxy, 'POST', `/v1/coins/holds/${h.operationId}/release`, { personId: member });
    assert.equal((await call(proxy, 'GET', `/v1/persons/${member}/wallet`)).json.wallet.purchased.coins, 50, 'job failed: nothing charged');

    const h2 = await call(proxy, 'POST', '/v1/coins/holds', { personId: member, quoteId: (await quote()).quoteId }, { 'idempotency-key': 'job-api-fixture-0011' });
    assert.equal(h2.status, 201);
    const poor = await call(proxy, 'POST', '/v1/coins/holds', { personId: member, quoteId: (await quote()).quoteId }, { 'idempotency-key': 'job-api-fixture-0012' });
    assert.equal(poor.status, 402); assert.equal(poor.json.code, 'INSUFFICIENT_COINS');
    const stale = await quote();
    clockNow = new Date(clockNow.getTime() + 11 * 60 * 1000);
    assert.equal((await call(proxy, 'POST', '/v1/coins/holds', { personId: member, quoteId: stale.quoteId }, { 'idempotency-key': 'job-api-fixture-0013' })).json.code, 'CONFLICT', 'expired quote');
    const bal = (await pool.query('SELECT purchased_balance FROM coin_wallets WHERE person_id = $1', [member])).rows[0].purchased_balance;
    assert.equal(bal, 10, 'never negative');
    const trail = (await pool.query("SELECT action FROM audit_logs WHERE actor_id = 'client:gaia-healers-proxy' ORDER BY id")).rows.map((r) => r.action);
    for (const a of ['coins.quote', 'coins.debit', 'coins.debit_released']) assert.ok(trail.includes(a), 'audited: ' + a);
  } finally { clockNow = new Date('2026-12-01T12:00:00Z'); await close(); }
});

test('bad input is rejected cleanly', { skip: SKIP }, async () => {
  const { pool, call, close } = await boot();
  try {
    const { member, proxy } = await world(pool);
    assert.equal((await call(proxy, 'POST', '/v1/coins/quotes', null, { 'content-type': 'text/plain' })).json.code, 'INVALID_INPUT');
    assert.equal((await call(proxy, 'POST', '/v1/coins/quotes', { personId: member, action: 'not.priced' })).status, 404);
    assert.equal((await call(proxy, 'GET', '/v1/nope')).status, 404);
  } finally { await close(); }
});
