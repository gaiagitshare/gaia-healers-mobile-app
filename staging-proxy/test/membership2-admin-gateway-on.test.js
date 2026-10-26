/**
 * The admin gateway switched ON in the real proxy: the real Control Center admin
 * cookie is required (the Event bearer is not enough), the status probe answers,
 * cross-origin writes are refused before anything is forwarded. The membership
 * service URL points at a closed loopback port, so nothing is reachable upstream.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-m2-admin-on-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);
const PORT = 8975;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  AUTH_SESSION_SECRET: 'm2-admin-off-session-secret-'.padEnd(48, 's'),
  COURSES_SYNC_SECRET: 'm2-admin-off-sync-'.padEnd(48, 'y'),
  GAIA_ADMIN_PASSWORD: 'm2-admin-on-password-fixture',
  EVENT_JWT_SECRET: 'm2-admin-on-event-jwt-secret-fixture',
  MEMBERSHIP2_ADMIN: 'on', MEMBERSHIP2_ADMIN_ORIGINS: 'http://127.0.0.1:8799', MEMBERSHIP_SERVICE_URL: 'http://127.0.0.1:9', MEMBERSHIP_ADMIN_SERVICE_TOKEN: 'gms_' + 'A'.repeat(43),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x', EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9',
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  MEMBERSHIP_POLICY_FILE: path.join(workdir, 'data', 'membership-policy.json'),
});
const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => closeServer());

const base = `http://127.0.0.1:${PORT}`;
test('ON: admin cookie required; status probe; writes need the Control Center origin and JSON', async () => {
  assert.equal((await fetch(`${base}/api/admin/membership2/status`)).status, 401);
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password: process.env.GAIA_ADMIN_PASSWORD }) });
  const cookie = String(login.headers.get('set-cookie')).split(';')[0];
  const st = await fetch(`${base}/api/admin/membership2/status`, { headers: { cookie } });
  assert.deepEqual([st.status, await st.json()], [200, { ok: true, enabled: true, signedIn: false, mustChangePassword: false, environment: 'unknown', stripeMode: 'unknown' }]);
  assert.equal((await fetch(`${base}/api/admin/membership2/me`, { headers: { cookie } })).status, 401, 'no operator cookie');
  const evil = await fetch(`${base}/api/admin/membership2/login`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(evil.status, 403);
  const plain = await fetch(`${base}/api/admin/membership2/login`, { method: 'POST', headers: { cookie, origin: `https://127.0.0.1:${PORT}`, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(plain.status, 400);
  const down = await fetch(`${base}/api/admin/membership2/login`, { method: 'POST', headers: { cookie, origin: `https://127.0.0.1:${PORT}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.invalid', password: 'x', totp: '123456' }) });
  assert.deepEqual([down.status, (await down.json()).code], [503, 'PROVIDER_UNAVAILABLE'], 'service unreachable: an honest 503');
});

const jwt = (payload, secret = process.env.EVENT_JWT_SECRET) => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${b}.${crypto.createHmac('sha256', secret).update(h + '.' + b).digest('base64url')}`;
};

test('ON: the Event Manager bearer (how production signs in) is accepted exactly like the admin cookie; operator cookie still required', async () => {
  const good = jwt({ sub: 'staff-fixture', exp: Math.floor(Date.now() / 1000) + 600 });
  const st = await fetch(`${base}/api/admin/membership2/status`, { headers: { authorization: `Bearer ${good}` } });
  assert.deepEqual([st.status, (await st.json()).enabled], [200, true]);
  assert.equal((await fetch(`${base}/api/admin/membership2/me`, { headers: { authorization: `Bearer ${good}` } })).status, 401, 'no operator cookie');
  assert.equal((await fetch(`${base}/api/admin/membership2/status`, { headers: { authorization: `Bearer ${jwt({ sub: 'x' }, 'wrong-secret')}` } })).status, 401, 'forged bearer');
  assert.equal((await fetch(`${base}/api/admin/membership2/status`, { headers: { authorization: `Bearer ${jwt({ sub: 'x', exp: 1 })}` } })).status, 401, 'expired bearer');
  const fromStaging = await fetch(`${base}/api/admin/membership2/login`, { method: 'POST', headers: { authorization: `Bearer ${good}`, origin: 'http://127.0.0.1:8799', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.invalid', password: 'x', totp: '123456' }) });
  assert.equal(fromStaging.status, 503, 'an origin from MEMBERSHIP2_ADMIN_ORIGINS passes the origin check (then the closed service port answers 503)');
});
