/**
 * CONTROL CENTER — cross-site request forgery (audit S2).
 *
 * The admin cookie (gaia_admin) is SameSite=None, so a browser attaches it to
 * requests from any site, and the proxy parses a text/plain body as JSON. A
 * page elsewhere could therefore publish events or change memberships as the
 * signed-in operator with a no-preflight form/fetch. A cookie-authenticated
 * admin write must now come from one of our own origins and carry JSON.
 * Bearer-authenticated (Event Manager SSO) writes and all reads are unchanged.
 *
 * Isolated workdir, stubbed GHL, no network, no paid calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-admin-csrf-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);
const PORT = 8972;
const SELF = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'csrf-test-operator-password';
const EVENT_SECRET = 'csrf-event-secret-'.padEnd(48, 'e');
const SERVICE_TOKEN = 'csrf-identity-service-'.padEnd(48, 'i');
// Loopback stand-in for the Event Manager identity API: once the Control Center
// checks that an Event login is a platform admin (PR #286), user 1 is one.
const http = await import('node:http');
const fakeEventManager = http.createServer((req, res) => {
  const ok = req.headers.authorization === 'Bearer ' + SERVICE_TOKEN && req.url === '/identity/staff/1/control-center';
  res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' });
  res.end(ok ? JSON.stringify({ user_id: 1, control_center_admin: true }) : '{}');
});
await new Promise((r) => fakeEventManager.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  AUTH_SESSION_SECRET: 'csrf-session-secret-'.padEnd(48, 's'),
  COURSES_SYNC_SECRET: 'csrf-sync-'.padEnd(48, 'y'),
  GHL_BACKFILL_SECRET: 'csrf-backfill-'.padEnd(48, 'b'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9',
  GAIA_ADMIN_PASSWORD: ADMIN_PASSWORD,
  EVENT_JWT_SECRET: EVENT_SECRET,
  IDENTITY_SERVICE_TOKEN: SERVICE_TOKEN,
  EVENT_MANAGER_INTERNAL_URL: 'http://127.0.0.1:' + fakeEventManager.address().port,
  ALLOWED_ORIGINS: 'https://gaiahealers.app',
  // keep every write inside the temp workdir (the events store is module-relative)
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  MEMBERSHIP_POLICY_FILE: path.join(workdir, 'data', 'membership-policy.json'),
});
const { crossSiteAdminWriteReason, closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => { closeServer(); fakeEventManager.close(); });

async function call(pathname, { method = 'GET', headers = {}, body } = {}) {
  const r = await fetch(`${SELF}${pathname}`, { method, headers, body });
  const raw = await r.text();
  let json = null; try { json = JSON.parse(raw); } catch { /* not json */ }
  return { status: r.status, json, headers: r.headers };
}

function eventBearer() {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: '1', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  const sig = crypto.createHmac('sha256', EVENT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `Bearer ${head}.${body}.${sig}`;
}

let cookie = '';
const WRITE = '/api/admin/membership/assign';
const assign = (contactId) => JSON.stringify({ contactId, key: 'gold', status: 'active', note: 'csrf test' });
const ledger = () => { try { return JSON.parse(fs.readFileSync(process.env.MEMBER_ENTITLEMENTS_FILE, 'utf8')).contacts || {}; } catch { return {}; } };

test('the operator signs in (login itself carries no admin cookie)', async () => {
  const r = await call('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: SELF },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.equal(r.json.ok, true);
  cookie = String(r.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.startsWith('gaia_admin='));
});

test('a cross-site text/plain POST with the admin cookie is refused before any handler', async () => {
  const r = await call(WRITE, {
    method: 'POST',
    headers: { cookie, origin: 'https://evil.example', 'content-type': 'text/plain' },
    body: assign('forged-1'),
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.reason, 'admin_origin_not_allowed');
  assert.ok(!ledger()['forged-1'], 'nothing was written');
});

test('a cross-site JSON POST, a Referer-only cross-site POST and an opaque origin are refused', async () => {
  const body = assign('forged-2');
  for (const extra of [
    { origin: 'https://evil.example', 'content-type': 'application/json' },
    { referer: 'https://evil.example/page', 'content-type': 'text/plain' },
    { origin: 'null', 'content-type': 'text/plain' },
    { 'content-type': 'application/json' }, // no Origin and no Referer: not provably ours
  ]) {
    const r = await call(WRITE, { method: 'POST', headers: { cookie, ...extra }, body });
    assert.equal(r.status, 403, JSON.stringify(extra));
  }
  const del = await call('/api/admin/events?id=x', { method: 'DELETE', headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(del.status, 403, 'DELETE is a write too');
});

test('a same-origin POST with the cookie but a text/plain body is refused', async () => {
  const r = await call(WRITE, {
    method: 'POST', headers: { cookie, origin: SELF, 'content-type': 'text/plain' },
    body: assign('forged-3'),
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.reason, 'admin_json_required');
});

test('a same-origin JSON POST with the cookie works as before', async () => {
  const r = await call(WRITE, {
    method: 'POST', headers: { cookie, origin: SELF, 'content-type': 'application/json; charset=utf-8' },
    body: assign('same-origin-1'),
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(ledger()['same-origin-1'].membership.key, 'gold');
  assert.ok(!ledger()['forged-2'] && !ledger()['forged-3'], 'refused writes left no trace');
});

test('a Referer from our own page stands in when Origin is absent', async () => {
  const r = await call(WRITE, {
    method: 'POST', headers: { cookie, referer: `${SELF}/admin/#events`, 'content-type': 'application/json' },
    body: assign('referer-1'),
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('an allowed app origin and a body-less JSON-typed POST (merges scan shape) pass the guard', async () => {
  const r = await call(WRITE, {
    method: 'POST', headers: { cookie, origin: 'https://gaiahealers.app', 'content-type': 'application/json' },
    body: assign('app-origin-1'),
  });
  assert.equal(r.status, 200);
  assert.equal(crossSiteAdminWriteReason({ method: 'POST', headers: { cookie, host: `127.0.0.1:${PORT}`, origin: SELF, 'content-type': 'application/json' } }), '');
  assert.equal(crossSiteAdminWriteReason({ method: 'POST', headers: { cookie, host: `127.0.0.1:${PORT}`, origin: SELF } }), '', 'no body, no type needed');
});

test('a bearer-authenticated (Event Manager SSO) write is unaffected', async () => {
  const r = await call(WRITE, {
    method: 'POST', headers: { authorization: eventBearer(), 'content-type': 'application/json' },
    body: assign('bearer-1'),
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(ledger()['bearer-1'], 'bearer write applied');
});

test('GETs are unaffected, cross-site or not', async () => {
  const r = await call('/api/admin/membership/members', { headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const s = await call('/api/admin/session', { headers: { cookie } });
  assert.equal(s.json.authed, true);
});

test('requests without the admin cookie are left to the normal auth gate', async () => {
  const r = await call(WRITE, {
    method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: '{}',
  });
  assert.equal(r.status, 401, 'unauthenticated, not a CSRF case');
});
