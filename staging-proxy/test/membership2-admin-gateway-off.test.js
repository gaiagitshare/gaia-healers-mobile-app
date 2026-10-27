/**
 * Production default: the Control Center Membership 2.0 admin gateway is OFF.
 * With MEMBERSHIP2_ADMIN unset, the real proxy answers every
 * /api/admin/membership2/* path with the normal unknown-admin-route 404 —
 * signed in to the Control Center or not — and the rest of the admin area is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-m2-admin-off-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);
const PORT = 8974;
delete process.env.MEMBERSHIP2_ADMIN;
delete process.env.MEMBERSHIP_ADMIN_SERVICE_TOKEN;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  AUTH_SESSION_SECRET: 'm2-admin-off-session-secret-'.padEnd(48, 's'),
  COURSES_SYNC_SECRET: 'm2-admin-off-sync-'.padEnd(48, 'y'),
  GAIA_ADMIN_PASSWORD: 'm2-admin-off-password-fixture',
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x', EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9',
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  MEMBERSHIP_POLICY_FILE: path.join(workdir, 'data', 'membership-policy.json'),
});
const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => closeServer());

const base = `http://127.0.0.1:${PORT}`;
const PATHS = [['GET', '/api/admin/membership2/status'], ['POST', '/api/admin/membership2/login'], ['GET', '/api/admin/membership2/me'],
  ['GET', '/api/admin/membership2/persons'], ['POST', '/api/admin/membership2/actions'], ['GET', '/api/admin/membership2']];

test('every admin membership2 path is a plain 404 while the admin gateway is off (signed out and signed in)', async () => {
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password: process.env.GAIA_ADMIN_PASSWORD }) });
  assert.equal((await login.json()).ok, true);
  const adminCookie = String(login.headers.get('set-cookie')).split(';')[0];
  for (const cookie of ['', adminCookie]) {
    for (const [method, p] of PATHS) {
      const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 404, `${method} ${p} ${cookie ? 'signed in' : 'signed out'}`);
      assert.deepEqual(await r.json(), { ok: false, reason: 'unknown_admin_route' });
    }
  }
  // The existing admin area still answers as before.
  assert.equal((await fetch(`${base}/api/admin/session`)).status, 200);
});
