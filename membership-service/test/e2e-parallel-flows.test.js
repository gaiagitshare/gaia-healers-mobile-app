import './_providers-deny-network.mjs';
/**
 * Phase 5 (parallel-system testing): cross-cutting flows through the REAL
 * member gateway (staging-proxy/membership2-gateway.js), the REAL internal API
 * and the REAL Postgres test database. Stripe is not connected, so every path
 * that would reach Stripe stops at PROVIDER_UNAVAILABLE; everything before it
 * (the duplicate-billing guard, the launch gate, the env ceiling) answers for real.
 *
 * Rows in docs/membership/TEST-MATRIX.md: CP-LEG-*, CP-ERR-*, LF-*, PI-*.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { freshPool, SKIP } from './_db.js';
import { createApiServer } from '../src/api/server.js';
import { createClient } from '../src/clients.js';
import { seedCatalog } from '../src/plans.js';
import { setLaunchStage, addPilotMember } from '../src/launch.js';
import { createMembership2Gateway } from '../../staging-proxy/membership2-gateway.js';

const admin = { actorType: 'admin', actorId: 'owner-fixture' };
const member = (n) => ({ contactId: `ghl-contact-fixture-e2e${n}`, email: `e2e.member${n}@example.invalid`, name: 'Fixture Member', source: 'magic-link' });
const loadMirror = (pool) => pool.query(`INSERT INTO legacy_memberships (external_subscription_id, external_contact_id, payment_provider, mapping, tier, reported_status, paid_through_estimate, last_seen_at)
                                         VALUES ('ghl-sub-fixture-e2e-other', 'ghl-contact-fixture-e2e-other', 'stripe', 'mapped', 'gold', 'active', '2026-12-20', now())`);
const legacyRow = (pool, contactId, { id, tier = 'silver', status = 'active', provider = 'stripe' }) => pool.query(
  `INSERT INTO legacy_memberships (external_subscription_id, external_contact_id, payment_provider, mapping, tier, reported_status, paid_through_estimate, last_payment_at, last_seen_at)
   VALUES ($1, $2, $3, 'mapped', $4, $5, now() + interval '20 days', now() - interval '10 days', now())`, [id, contactId, provider, tier, status]);

/** One API process per env (the ceiling is read from its env), all sharing one pool and one gateway client. */
async function stack({ stage = 'INTERNAL_PILOT', ceiling = 'ALL_NEW_CUSTOMERS', serviceUrl } = {}) {
  const pool = await freshPool();
  await seedCatalog(pool);
  if (stage !== 'OFF') await setLaunchStage(pool, { stage, reason: 'e2e parallel fixture', approvalRef: stage === 'INTERNAL_PILOT' ? null : 'GO-fixture-e2e' }, admin);
  const env = { MEMBERSHIP2_RETURN_ORIGINS: 'https://gaiahealers.app' };
  if (ceiling !== null) env.MEMBERSHIP2_STAGE_CEILING = ceiling;           // null = variable not set at all
  const api = createApiServer(pool, { env });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const { token } = await createClient(pool, { name: 'gaia-healers-proxy', scopes: ['identity:write', 'member:read', 'member:write'] }, 'owner-fixture');
  const gw = createMembership2Gateway({ env: { MEMBERSHIP2_GATEWAY: 'on', MEMBERSHIP_SERVICE_URL: serviceUrl || `http://127.0.0.1:${api.address().port}`, MEMBERSHIP_SERVICE_TOKEN: token } });
  let session = null;
  const proxy = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const sendJson = (r, status, data) => { r.writeHead(status, { 'content-type': 'application/json' }); r.end(JSON.stringify(data)); };
    const readJsonBody = async (r) => { let raw = ''; for await (const c of r) raw += c; return raw ? JSON.parse(raw) : {}; };
    const requireSessionMember = (r, s) => { if (!session) { sendJson(s, 401, { ok: false, reason: 'auth_required' }); return null; } return session; };
    if (!(await gw.handle(req, res, url, { origin: null, sendJson, readJsonBody, requireSessionMember }))) sendJson(res, 404, { ok: false, fellThrough: true });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const as = (m) => { session = m; };
  const call = async (method, path, body) => {
    const t0 = Date.now();
    const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json(), ms: Date.now() - t0 };
  };
  const personOf = async (m) => (await pool.query('SELECT person_id FROM person_identities WHERE external_id = $1', [m.contactId])).rows[0].person_id;
  const checkout = (requestId) => call('POST', '/api/membership2/checkout', { planKey: 'standard', interval: 'month', requestId });
  return { pool, call, as, personOf, checkout,
    close: async () => { await new Promise((r) => proxy.close(r)); await new Promise((r) => api.close(r)); await pool.end(); } };
}

test('legacy Silver member: shown as legacy, no new-membership path, checkout answers migration_required (any stage, pilot or not), nothing reaches Stripe', { skip: SKIP }, async () => {
  const s = await stack({ stage: 'INTERNAL_PILOT' });
  try {
    const m = member(1); s.as(m);
    await legacyRow(s.pool, m.contactId, { id: 'ghl-sub-fixture-e2e-silver', tier: 'silver' });
    const me = (await s.call('GET', '/api/membership2/me')).json;
    assert.deepEqual(me.legacy.map((l) => [l.tier, l.state]), [['silver', 'active']], 'the view renders "billed through your existing plan" and no buy button from this');
    assert.deepEqual(me.membership, []);
    assert.equal(me.availability.newMembership, false); assert.equal(me.availability.newMembershipReason, 'pilot_only');
    const co = await s.checkout('req-e2e-legacy-1');
    assert.deepEqual([co.status, co.json.ok, co.json.status], [200, false, 'migration_required'], 'the duplicate-billing guard answers before the launch gate and before Stripe');
    assert.notEqual(co.json.code, 'PROVIDER_UNAVAILABLE');
    // A pilot member who also has a legacy membership is still routed to migration.
    await addPilotMember(s.pool, await s.personOf(m), {}, admin);
    assert.equal((await s.checkout('req-e2e-legacy-2')).json.status, 'migration_required');
    // Fully open: legacy members are never "new customers".
    await setLaunchStage(s.pool, { stage: 'ALL_NEW_CUSTOMERS', reason: 'e2e open for every new customer', approvalRef: 'GO-fixture-e2e' }, admin);
    const s2 = (await s.call('GET', '/api/membership2/me')).json;
    assert.equal(s2.availability.newMembershipReason, 'pilot_member', 'the pilot list still wins in the gate itself');
    assert.equal((await s.checkout('req-e2e-legacy-3')).json.status, 'migration_required');
    assert.equal((await s.pool.query("SELECT count(*)::int n FROM person_identities WHERE platform = 'stripe'")).rows[0].n, 0, 'no Stripe customer was created');
  } finally { await s.close(); }
});

test('legacy member under review (unknown GHL status): shown under_review, checkout review_required, never treated as inactive', { skip: SKIP }, async () => {
  const s = await stack({ stage: 'ALL_NEW_CUSTOMERS' });
  try {
    const m = member(2); s.as(m);
    await legacyRow(s.pool, m.contactId, { id: 'ghl-sub-fixture-e2e-unknown', tier: 'gold', status: 'weird_status' });
    const me = (await s.call('GET', '/api/membership2/me')).json;
    assert.deepEqual(me.legacy.map((l) => l.state), ['under_review']);
    assert.equal(me.availability.newMembership, false);
    const co = await s.checkout('req-e2e-review-1');
    assert.deepEqual([co.status, co.json.status], [200, 'review_required']);
  } finally { await s.close(); }
});

test('pilot member reaches the billing step: 503 PROVIDER_UNAVAILABLE, and the same requestId answers the same way', { skip: SKIP }, async () => {
  const s = await stack({ stage: 'INTERNAL_PILOT' });
  try {
    const m = member(3); s.as(m);
    await s.call('GET', '/api/membership2/me'); await loadMirror(s.pool);
    await addPilotMember(s.pool, await s.personOf(m), {}, admin);
    const me = (await s.call('GET', '/api/membership2/me')).json;
    assert.deepEqual([me.availability.newMembership, me.availability.newMembershipReason], [true, 'pilot_member']);
    const a = await s.checkout('req-e2e-pilot-1');
    assert.deepEqual([a.status, a.json.code], [503, 'PROVIDER_UNAVAILABLE']);
    const b = await s.checkout('req-e2e-pilot-1');
    assert.deepEqual([b.status, b.json.code], [503, 'PROVIDER_UNAVAILABLE'], 'Try again with the same id is safe');
    assert.equal((await s.pool.query("SELECT count(*)::int n FROM person_identities WHERE platform = 'stripe'")).rows[0].n, 0);
  } finally { await s.close(); }
});

test('non-pilot member at INTERNAL_PILOT: availability false (pilot_only), checkout not_available pilot_only, no Stripe', { skip: SKIP }, async () => {
  const s = await stack({ stage: 'INTERNAL_PILOT' });
  try {
    const m = member(4); s.as(m);
    await loadMirror(s.pool);
    const me = (await s.call('GET', '/api/membership2/me')).json;
    assert.deepEqual([me.availability.stage, me.availability.newMembership, me.availability.newMembershipReason], ['INTERNAL_PILOT', false, 'pilot_only']);
    const co = await s.checkout('req-e2e-nonpilot-1');
    assert.deepEqual([co.status, co.json.status, co.json.reason], [200, 'not_available', 'pilot_only']);
    const coins = await s.call('POST', '/api/membership2/coins/checkout', { packKey: 'any', requestId: 'req-e2e-nonpilot-2' });
    assert.notEqual(coins.json.status, 'ok');
  } finally { await s.close(); }
});

test('launch ceiling env overrides the DB stage end to end (DB says ALL_NEW_CUSTOMERS)', { skip: SKIP }, async () => {
  const cases = [
    { ceiling: 'INTERNAL_PILOT', stage: 'INTERNAL_PILOT', reason: 'pilot_only' },
    { ceiling: 'OFF', stage: 'OFF', reason: 'membership2_off' },
    { ceiling: null, stage: 'OFF', reason: 'membership2_off' },                  // unset = OFF: a deploy never activates billing
    { ceiling: 'all', stage: 'OFF', reason: 'membership2_off' },                 // junk = OFF
    { ceiling: 'LIMITED_NEW_CUSTOMERS', stage: 'LIMITED_NEW_CUSTOMERS', reason: 'limited_cap_reached' },  // cap 0
  ];
  for (const c of cases) {
    const s = await stack({ stage: 'ALL_NEW_CUSTOMERS', ceiling: c.ceiling });
    try {
      s.as(member(5)); await loadMirror(s.pool);
      const me = (await s.call('GET', '/api/membership2/me')).json;
      assert.equal(me.availability.stage, c.stage, `ceiling ${c.ceiling}`);
      assert.equal(me.availability.newMembershipReason, c.reason, `ceiling ${c.ceiling}`);
      const co = await s.checkout('req-e2e-ceiling-1');
      assert.deepEqual([co.json.status, co.json.reason], ['not_available', c.reason], `ceiling ${c.ceiling}`);
    } finally { await s.close(); }
  }
  // Ceiling ALL and DB ALL: a new customer reaches the (unconnected) billing step.
  const s = await stack({ stage: 'ALL_NEW_CUSTOMERS', ceiling: 'ALL_NEW_CUSTOMERS' });
  try {
    s.as(member(6)); await loadMirror(s.pool);
    assert.equal((await s.call('GET', '/api/membership2/me')).json.availability.newMembershipReason, 'new_customer');
    assert.equal((await s.checkout('req-e2e-ceiling-2')).json.code, 'PROVIDER_UNAVAILABLE');
  } finally { await s.close(); }
});

test('membership service down: the gateway answers 503 PROVIDER_UNAVAILABLE quickly (refused port) and within its 8 s bound (silent service)', { skip: SKIP }, async () => {
  // A closed port: connection refused.
  const probe = net.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const closed = probe.address().port; await new Promise((r) => probe.close(r));
  let s = await stack({ serviceUrl: `http://127.0.0.1:${closed}` });
  try {
    const plans = await s.call('GET', '/api/membership2/plans');
    assert.deepEqual([plans.status, plans.json.code], [503, 'PROVIDER_UNAVAILABLE']);
    assert.ok(plans.ms < 2000, `refused answered in ${plans.ms} ms`);
    s.as(member(7));
    const me = await s.call('GET', '/api/membership2/me');
    assert.deepEqual([me.status, me.json.code], [503, 'PROVIDER_UNAVAILABLE']);
  } finally { await s.close(); }
  // A service that accepts and never answers: bounded by the gateway timeout.
  const sockets = new Set();
  const silent = net.createServer((sock) => { sockets.add(sock); }); await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  s = await stack({ serviceUrl: `http://127.0.0.1:${silent.address().port}` });
  try {
    const plans = await s.call('GET', '/api/membership2/plans');
    assert.deepEqual([plans.status, plans.json.code], [503, 'PROVIDER_UNAVAILABLE']);
    assert.ok(plans.ms >= 7000 && plans.ms < 12000, `silent service answered in ${plans.ms} ms`);
  } finally { for (const x of sockets) x.destroy(); await new Promise((r) => silent.close(r)); await s.close(); }
});
