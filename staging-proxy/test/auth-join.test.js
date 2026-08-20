/**
 * In-app Join endpoint (/api/auth/join).
 *
 * Boots a real receiver with GHL pointed at an unreachable base, so the upsert
 * fails and we can assert the guard logic and the never-strand funnel fallback
 * without touching a live CRM. The success path (real upsert + email) is covered
 * by the live smoke test, not here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'join-secret-'.padEnd(48, 'j');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-join-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);

const PORT = 8911;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  // GHL "configured" but unreachable → upsert fails → funnel fallback path.
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  AUTH_ALLOW_DEBUG_LINKS: 'false',
});

await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));

const post = async (body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

test('missing name is rejected', async () => {
  const r = await post({ email: 'a@b.com' });
  assert.equal(r.status, 400);
  assert.equal(r.json.reason, 'name_required');
});

test('invalid email is rejected', async () => {
  const r = await post({ name: 'Test Person', email: 'not-an-email' });
  assert.equal(r.status, 400);
  assert.equal(r.json.reason, 'email_invalid');
});

test('valid join with unreachable GHL never strands the user — it returns the funnel', async () => {
  const r = await post({ name: 'New Person', email: 'newperson-join-1@example.com' }, { 'x-forwarded-for': '203.0.113.10' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false, 'reports it could not finish here');
  assert.equal(r.json.delivery, 'funnel');
  assert.match(r.json.joinUrl, /join\.gaiahealers\.com\/onboarding/);
});

test('join is rate limited per ip+email (6th attempt is 429)', async () => {
  const ip = '203.0.113.55';
  const email = 'rate-join@example.com';
  let last;
  for (let i = 0; i < 6; i++) last = await post({ name: 'Rate Test', email }, { 'x-forwarded-for': ip });
  assert.equal(last.status, 429);
  assert.equal(last.json.code, 'rate_limited');
});
