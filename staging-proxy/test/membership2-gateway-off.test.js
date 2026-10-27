/**
 * Production default: the Membership 2.0 member gateway is OFF. With
 * MEMBERSHIP2_GATEWAY unset, the real proxy answers every /api/membership2/*
 * path with its normal 404, so nothing new is exposed until it is deliberately enabled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-m2-off-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);
const PORT = 8973;
delete process.env.MEMBERSHIP2_GATEWAY;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  AUTH_SESSION_SECRET: 'm2-off-session-secret-'.padEnd(48, 's'),
  COURSES_SYNC_SECRET: 'm2-off-sync-'.padEnd(48, 'y'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x', EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9',
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  MEMBERSHIP_POLICY_FILE: path.join(workdir, 'data', 'membership-policy.json'),
});
const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => closeServer());

test('every membership2 path is a plain 404 while the gateway is off', async () => {
  for (const [method, p] of [['GET', '/api/membership2/plans'], ['GET', '/api/membership2/me'], ['POST', '/api/membership2/checkout']]) {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORT}` }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 404, `${method} ${p}`);
  }
});
