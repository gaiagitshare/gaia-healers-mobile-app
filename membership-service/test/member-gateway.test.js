/**
 * Member gateway end to end WITHOUT fakes for our own systems: the real proxy
 * gateway module (staging-proxy/membership2-gateway.js) in front of the real
 * internal membership API on loopback, backed by the real Postgres test
 * database. Only the member session is supplied (a fictional signed-in member);
 * Stripe is NOT connected here, so checkout stops honestly at "billing not
 * connected" — the real Stripe path is proven by the sandbox run, not by a fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshPool, SKIP } from './_db.js';
import { createApiServer } from '../src/api/server.js';
import { createClient } from '../src/clients.js';
import { seedCatalog } from '../src/plans.js';
import { setLaunchStage, addPilotMember } from '../src/launch.js';
import { grantAllowance } from '../src/coins.js';
import { createMembership2Gateway, membership2Config } from '../../staging-proxy/membership2-gateway.js';

const MEMBER = { contactId: 'ghl-contact-fixture-gw1', email: 'gateway.member@example.invalid', name: 'Fixture Member', source: 'magic-link' };
const admin = { actorType: 'admin', actorId: 'owner-fixture' };

async function stack({ stage = 'OFF', session = MEMBER } = {}) {
  const pool = await freshPool();
  await seedCatalog(pool);
  const env = { MEMBERSHIP2_STAGE_CEILING: 'ALL_NEW_CUSTOMERS', MEMBERSHIP2_RETURN_ORIGINS: 'https://gaiahealers.app' };
  if (stage !== 'OFF') await setLaunchStage(pool, { stage, reason: 'gateway test fixture', approvalRef: stage === 'INTERNAL_PILOT' ? null : 'GO-fixture' }, admin);
  const api = createApiServer(pool, { env });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const { token } = await createClient(pool, { name: 'gaia-healers-proxy', scopes: ['identity:write', 'member:read', 'member:write'] }, 'owner-fixture');
  const gw = createMembership2Gateway({ env: { MEMBERSHIP2_GATEWAY: 'on', MEMBERSHIP_SERVICE_URL: `http://127.0.0.1:${api.address().port}`, MEMBERSHIP_SERVICE_TOKEN: token } });
  // The proxy side: the real gateway handle() with the proxy's helper contracts.
  const proxy = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const sendJson = (r, status, data) => { r.writeHead(status, { 'content-type': 'application/json' }); r.end(JSON.stringify(data)); };
    const readJsonBody = async (r) => { let raw = ''; for await (const c of r) raw += c; return raw ? JSON.parse(raw) : {}; };
    const requireSessionMember = (r, s) => { if (!session) { sendJson(s, 401, { ok: false, reason: 'auth_required' }); return null; } return session; };
    if (!(await gw.handle(req, res, url, { origin: null, sendJson, readJsonBody, requireSessionMember }))) sendJson(res, 404, { ok: false, fellThrough: true });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  return { pool, call, close: async () => { await new Promise((r) => proxy.close(r)); await new Promise((r) => api.close(r)); await pool.end(); } };
}

test('gateway config fails closed: off unless explicitly on, loopback service only, a real client token', () => {
  assert.equal(membership2Config({}).enabled, false);
  assert.equal(membership2Config({ MEMBERSHIP2_GATEWAY: 'on' }).reason, 'service_url_missing');
  assert.equal(membership2Config({ MEMBERSHIP2_GATEWAY: 'on', MEMBERSHIP_SERVICE_URL: 'http://10.0.0.5:8792' }).reason, 'service_url_not_loopback');
  assert.equal(membership2Config({ MEMBERSHIP2_GATEWAY: 'on', MEMBERSHIP_SERVICE_URL: 'http://127.0.0.1:8792' }).reason, 'service_token_missing');
});

test('gateway OFF: every /api/membership2 path falls through (404), nothing reaches the service', async () => {
  const gw = createMembership2Gateway({ env: {} });
  let touched = false;
  const handled = await gw.handle({ method: 'GET', headers: {} }, {}, new URL('http://x/api/membership2/me'), { sendJson: () => { touched = true; }, requireSessionMember: () => { touched = true; } });
  assert.equal(handled, false); assert.equal(touched, false);
});

test('plans are public; everything else needs the member session', { skip: SKIP }, async () => {
  const s = await stack({ session: null });
  try {
    const plans = await s.call('GET', '/api/membership2/plans');
    assert.equal(plans.status, 200);
    assert.deepEqual(plans.json.plans.map((p) => [p.key, p.prices.month ?? p.prices.none, p.prices.year ?? null, p.monthlyCoins]),
      [['free', 0, null, 0], ['standard', 4700, 47000, 500], ['professional', 9700, 97000, 2000], ['inner_circle', 29700, 297000, 4000]]);
    assert.ok(plans.json.plans[1].benefits.some((b) => b.key === 'courses.core' && b.label === 'Core courses'));
    assert.deepEqual(plans.json.coinPacks, [], 'coin packs are drafts until their prices are approved');
    assert.equal((await s.call('GET', '/api/membership2/me')).status, 401);
  } finally { await s.close(); }
});

test('signed-in member: account is created once, overview shows availability; launch OFF means no checkout', { skip: SKIP }, async () => {
  const s = await stack({ stage: 'OFF' });
  try {
    const me = await s.call('GET', '/api/membership2/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.json.membership, []);
    assert.equal(me.json.wallet.total.coins, 0);
    assert.deepEqual([me.json.availability.stage, me.json.availability.newMembership], ['OFF', false]);
    await s.call('GET', '/api/membership2/me');
    assert.equal((await s.pool.query("SELECT count(*)::int n FROM person_identities WHERE external_id IN ('ghl-contact-fixture-gw1', 'gateway.member@example.invalid')")).rows[0].n, 2, 'one person, contact + email linked once');
    const co = await s.call('POST', '/api/membership2/checkout', { planKey: 'standard', interval: 'month', requestId: 'req-gw-0001' });
    assert.equal(co.status, 503, 'with no billing connected the service says so');
    assert.equal(co.json.code, 'PROVIDER_UNAVAILABLE');
    assert.equal((await s.call('POST', '/api/membership2/checkout', { planKey: 'standard', interval: 'month' })).json.code, 'INVALID_INPUT', 'a request id is required');
  } finally { await s.close(); }
});

test('legacy members are shown their legacy membership and never offered a second subscription', { skip: SKIP }, async () => {
  const s = await stack({ stage: 'INTERNAL_PILOT' });
  try {
    await s.pool.query(`INSERT INTO legacy_memberships (external_subscription_id, external_contact_id, payment_provider, mapping, tier, reported_status, paid_through_estimate, last_seen_at)
                        VALUES ('ghl-sub-fixture-gw', 'ghl-contact-fixture-gw1', 'paypal', 'mapped', 'silver', 'active', '2026-12-20', now())`);
    const me = (await s.call('GET', '/api/membership2/me')).json;
    assert.deepEqual(me.legacy.map((l) => [l.tier, l.provider, l.state]), [['silver', 'paypal', 'active']]);
    const pid = (await s.pool.query("SELECT person_id FROM person_identities WHERE external_id = 'ghl-contact-fixture-gw1'")).rows[0].person_id;
    await addPilotMember(s.pool, pid, {}, admin);
    assert.equal((await s.call('GET', '/api/membership2/me')).json.availability.newMembershipReason, 'pilot_member');
  } finally { await s.close(); }
});

test('coin and billing history, and a member can only touch their own subscription', { skip: SKIP }, async () => {
  const s = await stack({ stage: 'INTERNAL_PILOT' });
  try {
    await s.call('GET', '/api/membership2/me');
    const pid = (await s.pool.query("SELECT person_id FROM person_identities WHERE external_id = 'ghl-contact-fixture-gw1'")).rows[0].person_id;
    await grantAllowance(s.pool, { personId: pid, coins: 500, cycleKey: 'fixture:gw' });
    const coins = (await s.call('GET', '/api/membership2/me/coins')).json;
    assert.deepEqual(coins.items.map((i) => [i.kind, i.coins]), [['grant', 500]]);
    assert.deepEqual((await s.call('GET', '/api/membership2/me/billing')).json.items, []);
    const other = (await s.pool.query('INSERT INTO persons DEFAULT VALUES RETURNING id')).rows[0].id;
    const v = (await s.pool.query("SELECT v.id FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE p.key = 'standard'")).rows[0].id;
    const sub = (await s.pool.query(`INSERT INTO subscriptions (person_id, plan_version_id, billing_interval, status, provider, provider_subscription_id) VALUES ($1, $2, 'month', 'active', 'stripe', 'sub_fixture_gw_other') RETURNING id`, [other, v])).rows[0].id;
    const r = await s.call('POST', `/api/membership2/subscriptions/${sub}/cancel-preview`, {});
    assert.equal(r.status, 404, "someone else's subscription is not found");
  } finally { await s.close(); }
});
