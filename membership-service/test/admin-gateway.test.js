/**
 * Control Center admin gateway end to end WITHOUT fakes for our own systems:
 * the real proxy module (staging-proxy/membership2-admin-gateway.js) in front of
 * the real internal API on loopback and the real Postgres test database. Only
 * the Control Center admin cookie check is supplied (the proxy's own signed-cookie
 * check is covered by the proxy suite).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SKIP } from './_db.js';
import { adminStack, fixturePerson, PASSWORD, codeAt } from './_admin.js';
import { createMembership2AdminGateway, membership2AdminConfig } from '../../staging-proxy/membership2-admin-gateway.js';

const ORIGIN = 'https://admin.example.invalid';

async function gatewayStack() {
  const s = await adminStack({ operators: { support: 'support', finance: 'finance', finance2: 'finance' } });
  const { createClient } = await import('../src/clients.js');
  const { token } = await createClient(s.pool, { name: 'gaia-healers-staging-admin', scopes: ['admin:operate'] }, 'owner-fixture');
  const gw = createMembership2AdminGateway({ env: { MEMBERSHIP2_ADMIN: 'on', MEMBERSHIP_SERVICE_URL: s.base, MEMBERSHIP_ADMIN_SERVICE_TOKEN: token }, now: () => s.clock.t.getTime() });
  const parseCookies = (h) => Object.fromEntries(String(h || '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  const proxy = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const sendJson = (r, status, data, origin, headers = {}) => { r.writeHead(status, { 'content-type': 'application/json', ...headers }); r.end(JSON.stringify(data)); };
    const readJsonBody = async (r) => { let raw = ''; for await (const c of r) raw += c; return raw ? JSON.parse(raw) : {}; };
    const handled = await gw.handle(req, res, url, { origin: null, sendJson, readJsonBody, parseCookies,
      isAdmin: (r) => parseCookies(r.headers.cookie).gaia_admin === 'valid-admin-cookie', ownOrigins: () => [ORIGIN], clientIp: (r) => String(r.headers['x-test-ip'] || '127.0.0.1') });
    if (!handled) sendJson(res, 404, { ok: false, fellThrough: true });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const jar = {};
  const call = async (method, path, { body, who, admin = true, origin = ORIGIN, type = 'application/json', ip } = {}) => {
    const cookies = [admin ? 'gaia_admin=valid-admin-cookie' : '', who && jar[who] ? `gaia_operator=${jar[who]}` : ''].filter(Boolean).join('; ');
    const headers = { ...(cookies ? { cookie: cookies } : {}), ...(origin ? { origin } : {}), ...(body !== undefined ? { 'content-type': type } : {}), ...(ip ? { 'x-test-ip': ip } : {}) };
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    return { status: r.status, json: await r.json(), setCookie: r.headers.get('set-cookie') };
  };
  const signIn = async (who) => {
    const r = await call('POST', '/api/admin/membership2/login', { body: { email: s.ops[who].email, password: PASSWORD, totp: codeAt(s.ops[who].secret, s.clock.t) } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    jar[who] = /gaia_operator=([^;]+)/.exec(r.setCookie)[1];
    return r;
  };
  return { s, call, signIn, jar, close: async () => { await new Promise((r) => proxy.close(r)); await s.close(); } };
}

test('admin gateway config fails closed: off unless on, loopback only, a real admin client token', () => {
  assert.equal(membership2AdminConfig({}).enabled, false);
  assert.equal(membership2AdminConfig({ MEMBERSHIP2_ADMIN: 'on' }).reason, 'service_url_missing');
  assert.equal(membership2AdminConfig({ MEMBERSHIP2_ADMIN: 'on', MEMBERSHIP_SERVICE_URL: 'http://10.0.0.5:8792' }).reason, 'service_url_not_loopback');
  assert.equal(membership2AdminConfig({ MEMBERSHIP2_ADMIN: 'on', MEMBERSHIP_SERVICE_URL: 'http://127.0.0.1:8792', MEMBERSHIP_SERVICE_TOKEN: 'gms_' + 'a'.repeat(43) }).reason, 'admin_service_token_missing',
    'the member gateway token is not reused');
});

test('admin gateway OFF: falls through, nothing reaches the service', async () => {
  const gw = createMembership2AdminGateway({ env: {} });
  let touched = false;
  const handled = await gw.handle({ method: 'GET', headers: {} }, {}, new URL('http://x/api/admin/membership2/status'), { sendJson: () => { touched = true; }, isAdmin: () => { touched = true; return true; } });
  assert.equal(handled, false); assert.equal(touched, false);
});

test('status probe, login cookie (token never in the body), admin cookie + operator cookie required', { skip: SKIP }, async () => {
  const g = await gatewayStack();
  try {
    assert.equal((await g.call('GET', '/api/admin/membership2/status', { admin: false })).status, 401, 'Control Center sign-in first');
    assert.deepEqual((await g.call('GET', '/api/admin/membership2/status')).json, { ok: true, enabled: true, signedIn: false, mustChangePassword: false, environment: 'unset', stripeMode: 'none' });
    const r = await g.signIn('support');
    assert.equal(r.json.session, undefined, 'the operator token never reaches JavaScript');
    assert.ok(!JSON.stringify(r.json).includes(g.jar.support));
    assert.match(r.setCookie, /^gaia_operator=gop_[^;]+; Path=\/api\/admin\/membership2; HttpOnly; Secure; SameSite=Strict; Max-Age=28800$/);
    assert.deepEqual((await g.call('GET', '/api/admin/membership2/status', { who: 'support' })).json.signedIn, true);
    const me = await g.call('GET', '/api/admin/membership2/me', { who: 'support' });
    assert.deepEqual([me.status, me.json.operator.role], [200, 'support']);
    assert.equal((await g.call('GET', '/api/admin/membership2/me', { who: 'support', admin: false })).status, 401, 'operator cookie alone is not enough');
    assert.equal((await g.call('GET', '/api/admin/membership2/me')).json.code, 'AUTH_REQUIRED', 'admin cookie alone is not enough');
    const bad = await g.call('POST', '/api/admin/membership2/login', { body: { email: g.s.ops.finance.email, password: 'wrong-password-xx', totp: '000000' } });
    assert.deepEqual([bad.status, bad.json.error], [401, 'invalid_login']);
    const out = await g.call('POST', '/api/admin/membership2/logout', { who: 'support', body: {} });
    assert.match(out.setCookie, /Max-Age=0/);
    assert.equal((await g.call('GET', '/api/admin/membership2/me', { who: 'support' })).status, 401, 'session revoked');
  } finally { await g.close(); }
});

test('writes: JSON only, Control Center origin only; login is rate-limited per IP', { skip: SKIP }, async () => {
  const g = await gatewayStack();
  try {
    await g.signIn('support');
    const pid = await fixturePerson(g.s.pool);
    const action = { action: 'coins.credit', params: { personId: pid, coins: 50 }, reason: 'goodwill through the gateway', requestId: 'gw-credit-0001' };
    assert.equal((await g.call('POST', '/api/admin/membership2/actions', { who: 'support', body: action, origin: 'https://evil.example' })).json.reason, 'admin_origin_not_allowed');
    assert.equal((await g.call('POST', '/api/admin/membership2/actions', { who: 'support', body: action, origin: '' })).status, 403, 'no origin, no write');
    assert.equal((await g.call('POST', '/api/admin/membership2/actions', { who: 'support', body: JSON.stringify(action), type: 'text/plain' })).json.reason, 'admin_json_required');
    assert.equal((await g.s.pool.query('SELECT count(*)::int n FROM admin_action_requests')).rows[0].n, 0);
    const ok = await g.call('POST', '/api/admin/membership2/actions', { who: 'support', body: action });
    assert.deepEqual([ok.status, ok.json.status], [200, 'executed']);
    for (let i = 0; i < 10; i++) await g.call('POST', '/api/admin/membership2/login', { ip: '203.0.113.9', body: { email: 'x@example.invalid', password: 'x', totp: '1' } });
    const lim = await g.call('POST', '/api/admin/membership2/login', { ip: '203.0.113.9', body: { email: 'x@example.invalid', password: 'x', totp: '1' } });
    assert.deepEqual([lim.status, lim.json.code], [429, 'RATE_LIMITED']);
    assert.equal((await g.call('POST', '/api/admin/membership2/login', { ip: '203.0.113.10', body: { email: 'x@example.invalid', password: 'x', totp: '1' } })).status, 401, 'another IP is not limited');
  } finally { await g.close(); }
});

test('dual approval end to end through the gateway: request, refused self-approval, second operator executes', { skip: SKIP }, async () => {
  const g = await gatewayStack();
  try {
    await g.signIn('finance'); await g.signIn('finance2');
    const pid = await fixturePerson(g.s.pool);
    const r = await g.call('POST', '/api/admin/membership2/actions', { who: 'finance', body: { action: 'coins.credit', params: { personId: pid, coins: 1500 }, reason: 'courtesy credit after billing error', requestId: 'gw-dual-0001' } });
    assert.equal(r.json.status, 'pending');
    const id = r.json.request.id;
    assert.equal((await g.call('POST', `/api/admin/membership2/requests/${id}/approve`, { who: 'finance', body: { note: 'approving my own request' } })).status, 403);
    const list = await g.call('GET', '/api/admin/membership2/requests?status=pending', { who: 'finance2' });
    assert.equal(list.json.items[0].canApprove, true);
    const a = await g.call('POST', `/api/admin/membership2/requests/${id}/approve`, { who: 'finance2', body: { note: 'checked with the member' } });
    assert.deepEqual([a.status, a.json.status], [200, 'executed']);
    const person = await g.call('GET', `/api/admin/membership2/persons/${pid}`, { who: 'finance' });
    assert.equal(person.json.wallet.goodwill.coins, 1500);
    assert.equal((await g.call('GET', '/api/admin/membership2/nope/../../v1/health', { who: 'finance' })).status, 404);
  } finally { await g.close(); }
});

test('first sign-in through the gateway: restricted until the password is changed; /password needs the operator cookie and the origin', { skip: SKIP }, async () => {
  const g = await gatewayStack();
  try {
    const { createOperator } = await import('../src/operators.js');
    const { secretOf } = await import('./_admin.js');
    const c = await createOperator(g.s.pool, { email: 'first.fixture@example.invalid', displayName: 'First Fixture', role: 'support' }, 'test-owner', { env: g.s.env });
    const r = await g.call('POST', '/api/admin/membership2/login', { body: { email: c.email, password: c.password, totp: codeAt(secretOf(c.otpauthUri), g.s.clock.t) } });
    assert.deepEqual([r.status, r.json.operator.mustChangePassword], [200, true]);
    g.jar.first = /gaia_operator=([^;]+)/.exec(r.setCookie)[1];
    assert.equal((await g.call('GET', '/api/admin/membership2/status', { who: 'first' })).json.mustChangePassword, true);
    const blocked = await g.call('GET', '/api/admin/membership2/overview', { who: 'first' });
    assert.deepEqual([blocked.status, blocked.json.reason], [403, 'password_change_required']);
    const body = { currentPassword: c.password, newPassword: 'first-fixture-new-passphrase' };
    assert.equal((await g.call('POST', '/api/admin/membership2/password', { body })).status, 401, 'no operator cookie');
    assert.equal((await g.call('POST', '/api/admin/membership2/password', { who: 'first', body, origin: 'https://evil.example' })).status, 403);
    const ok = await g.call('POST', '/api/admin/membership2/password', { who: 'first', body });
    assert.deepEqual([ok.status, ok.json.changed], [200, true]);
    assert.equal((await g.call('GET', '/api/admin/membership2/overview', { who: 'first' })).status, 200);
    assert.equal((await g.call('GET', '/api/admin/membership2/status', { who: 'first' })).json.mustChangePassword, false);
  } finally { await g.close(); }
});
