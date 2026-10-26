/**
 * PR 1 -- Event Manager logins and the Control Center (26 Oct 2026 audit, S1).
 *
 * Defect: verifyEventBearer accepted ANY Event Manager JWT with a valid
 * signature and a subject as a full Control Center administrator. Event tokens
 * carry only `sub`, so door / check-in staff logins were admins here.
 *
 * Now: a valid Event token proves identity only; the Control Center asks the
 * Event Manager (service-only identity API) whether that user is a platform
 * admin, and fails closed. Fake Event Manager on loopback; no network, no
 * real accounts, no paid calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const JWT_SECRET = 'test-event-jwt-secret-' + 'x'.repeat(24);
const SVC = 'test-identity-service-token-' + 'y'.repeat(16);

// Fictional staff: 1 platform admin, 2 door staff (checkin_staff), 3 organiser of one event.
const STAFF = { 1: true, 2: false, 3: false };
const calls = [];
let eventManagerDown = false, lieAboutUser = false;
const fake = http.createServer((req, res) => {
  calls.push(req.url);
  if (eventManagerDown) { res.writeHead(503); return res.end('{}'); }
  if (req.headers.authorization !== 'Bearer ' + SVC) { res.writeHead(403); return res.end('{"detail":"Invalid service token"}'); }
  const m = req.url.match(/^\/identity\/staff\/(\d+)\/control-center$/);
  if (!m) { res.writeHead(404); return res.end('{}'); }
  const id = Number(m[1]);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ user_id: lieAboutUser ? id + 1 : id, control_center_admin: Boolean(STAFF[id]) }));
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.EVENT_JWT_SECRET = JWT_SECRET;
process.env.IDENTITY_SERVICE_TOKEN = SVC;
process.env.EVENT_MANAGER_INTERNAL_URL = 'http://127.0.0.1:' + fake.address().port;
const admin = await import('../admin-router.js');
test.after(() => fake.close());

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(payload, secret = JWT_SECRET) {
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64(payload);
  return `${head}.${body}.` + crypto.createHmac('sha256', secret).update(head + '.' + body).digest('base64url');
}
const soon = () => Math.floor(Date.now() / 1000) + 3600;

async function call(path, { bearer, cookie } = {}) {
  const res = {};
  const req = { method: 'GET', headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(cookie ? { cookie } : {}) } };
  const deps = {
    origin: 'https://api.gaiahealers.app',
    sendJson: (r, status, data) => { r.status = status; r.data = data; },
    parseCookies: (h) => Object.fromEntries(String(h).split(';').map((x) => x.trim().split('=')).filter((x) => x[0])),
    readSignedToken: (v) => (v === 'valid-admin-cookie' ? { role: 'admin' } : null),
  };
  await admin.handle(req, res, new URL('https://api.gaiahealers.app' + path), deps);
  return res;
}
const fresh = () => { admin._resetEventAdminCacheForTest(); calls.length = 0; eventManagerDown = false; lieAboutUser = false; };

test('door / check-in staff token: NOT a Control Center admin (the defect)', async () => {
  fresh();
  const t = jwt({ sub: '2', exp: soon() });
  // The desk stays signed in to the shell (its official entry to Events), as event_staff only.
  const session = (await call('/api/admin/session', { bearer: t })).data;
  assert.equal(session.authed, true, 'registered desk devices keep their session');
  assert.equal(session.role, 'event_staff');
  assert.equal((await call('/api/admin/events', { bearer: t })).status, 401);
  assert.equal((await call('/api/admin/membership/schema', { bearer: t })).status, 401, 'membership admin API is behind the same gate');
  assert.equal((await call('/api/admin/contacts', { bearer: t })).status, 401, 'contact export is refused');
});

test('an event organiser (per-event role, not platform admin) is not a Control Center admin', async () => {
  fresh();
  assert.equal((await call('/api/admin/events', { bearer: jwt({ sub: '3', exp: soon() }) })).status, 401);
});

test('a platform admin keeps access through the Event login; the answer is cached', async () => {
  fresh();
  const t = jwt({ sub: '1', exp: soon() });
  const s1 = (await call('/api/admin/session', { bearer: t })).data;
  assert.equal(s1.authed, true); assert.equal(s1.role, 'admin');
  assert.notEqual((await call('/api/admin/events', { bearer: t })).status, 401);
  assert.equal(calls.length, 1, 'one Event Manager lookup, then the 60-second cache');
  assert.match(calls[0], /^\/identity\/staff\/1\/control-center$/);
});

test('the Control Center password cookie still works, with no Event Manager call', async () => {
  fresh();
  assert.notEqual((await call('/api/admin/events', { cookie: 'gaia_admin=valid-admin-cookie' })).status, 401);
  assert.equal(calls.length, 0);
});

test('invalid, expired, mis-signed and malformed tokens are rejected before any lookup', async () => {
  fresh();
  const bad = [
    jwt({ sub: '1', exp: Math.floor(Date.now() / 1000) - 10 }),                 // expired
    jwt({ sub: '1', exp: soon() }, 'some-other-secret-' + 'z'.repeat(24)),    // wrong key
    jwt({ exp: soon() }),                                                      // no subject
    jwt({ sub: '1 OR 1=1', exp: soon() }),                                     // not an Event user id
    'not.a.jwt', 'garbage',
  ];
  for (const t of bad) assert.equal((await call('/api/admin/events', { bearer: t })).status, 401, t.slice(0, 30));
  assert.equal(calls.length, 0, 'none of these reach the Event Manager');
});

test('fails closed: Event Manager down, wrong answer, or no service token = not admin', async () => {
  fresh();
  const t = jwt({ sub: '1', exp: soon() });
  eventManagerDown = true;
  assert.equal((await call('/api/admin/events', { bearer: t })).status, 401);
  eventManagerDown = false;
  assert.notEqual((await call('/api/admin/events', { bearer: t })).status, 401, 'a failed lookup is not cached as "no"');
  fresh(); lieAboutUser = true;
  assert.equal((await call('/api/admin/events', { bearer: t })).status, 401, 'an answer about a different user is refused');
  fresh();
  const svc = process.env.IDENTITY_SERVICE_TOKEN; delete process.env.IDENTITY_SERVICE_TOKEN;
  try { assert.equal((await call('/api/admin/events', { bearer: t })).status, 401); } finally { process.env.IDENTITY_SERVICE_TOKEN = svc; }
});

test('a demoted admin loses access once the cache entry expires', async () => {
  fresh();
  const t = jwt({ sub: '1', exp: soon() });
  assert.notEqual((await call('/api/admin/events', { bearer: t })).status, 401);
  STAFF[1] = false; admin._resetEventAdminCacheForTest();   // stands in for the 60 seconds passing
  try { assert.equal((await call('/api/admin/events', { bearer: t })).status, 401); } finally { STAFF[1] = true; }
});

test('the gate uses the role check, never the signature check alone', () => {
  const src = fs.readFileSync(new URL('../admin-router.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /adminCookieFromReq\(req, deps\) \|\| verifyEventBearer\(req\)/);
  assert.match(src, /await eventAdminFromReq\(req\)/);
  assert.match(src, /if \(!\(await authed\(\)\)\) return need\(\);/);
});

test('session: an invalid token is neither admin nor staff', async () => {
  fresh();
  const s = (await call('/api/admin/session', { bearer: jwt({ sub: '2', exp: soon() }, 'wrong-key-' + 'q'.repeat(30)) })).data;
  assert.equal(s.authed, false); assert.equal(s.role, null);
  const none = (await call('/api/admin/session')).data;
  assert.equal(none.authed, false);
});
