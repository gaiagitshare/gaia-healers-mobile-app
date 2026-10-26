/**
 * The Control Center operator sign-in limit (10 per IP per 15 min) keys on
 * deps.clientIp = adminRouter.clientIp. With the trusted-client-IP fix (PR #287,
 * staging-proxy/client-ip.js) a caller cannot reset the limit by rotating
 * X-Forwarded-For or CF-Connecting-IP. Merge order: #287 first, then this branch.
 * Until #287 is merged this test is skipped (and says why); after the merge it runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HAS_TRUSTED_IP = fs.existsSync(new URL('../client-ip.js', import.meta.url));
const SKIP = HAS_TRUSTED_IP ? false : 'needs PR #287 (staging-proxy/client-ip.js, trusted client IP); merge #287 before this branch';

let base = null, closeServer = null;
if (HAS_TRUSTED_IP) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-m2-admin-ip-'));
  fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
  process.chdir(workdir);
  const PORT = 8976;
  Object.assign(process.env, {
    PORT: String(PORT), HOST: '127.0.0.1',
    AUTH_SESSION_SECRET: 'm2-admin-ip-session-secret-'.padEnd(48, 's'),
    COURSES_SYNC_SECRET: 'm2-admin-ip-sync-'.padEnd(48, 'y'),
    GAIA_ADMIN_PASSWORD: 'm2-admin-ip-password-fixture',
    EVENT_JWT_SECRET: 'm2-admin-ip-event-jwt-secret-fixture',
    MEMBERSHIP2_ADMIN: 'on', MEMBERSHIP_SERVICE_URL: 'http://127.0.0.1:9', MEMBERSHIP_ADMIN_SERVICE_TOKEN: 'gms_' + 'B'.repeat(43),
    GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x', EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9',
    MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
    MEMBERSHIP_POLICY_FILE: path.join(workdir, 'data', 'membership-policy.json'),
  });
  ({ closeServer } = await import(new URL('../server.js', import.meta.url).href));
  await new Promise((r) => setTimeout(r, 300));
  base = `http://127.0.0.1:${PORT}`;
  test.after(() => closeServer());
}

test('a spoofed X-Forwarded-For / CF-Connecting-IP does not reset the operator sign-in limit', { skip: SKIP }, async () => {
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password: process.env.GAIA_ADMIN_PASSWORD }) });
  const cookie = String(login.headers.get('set-cookie')).split(';')[0];
  const attempt = (i) => fetch(`${base}/api/admin/membership2/login`, { method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i}`, 'cf-connecting-ip': `203.0.113.${i}` },
    body: JSON.stringify({ email: 'nobody@example.invalid', password: 'x', totp: '123456' }) });
  const statuses = [];
  for (let i = 1; i <= 11; i++) statuses.push((await attempt(i)).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(503), 'the first 10 reach the (closed) service port');
  assert.equal(statuses[10], 429, 'the 11th is limited although every request claimed a new IP');
});
