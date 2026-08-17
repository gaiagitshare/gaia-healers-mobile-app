/**
 * The fixture path with the process opted in.
 *
 * Separate file because the flag has to be set before the server module is
 * imported — which is itself the point: enabling fixtures is a deployment
 * decision, not something a request can talk its way into.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SECRET = 'enabled-secret-'.padEnd(48, 'q');
const FIXTURE_KEY = 'enabled-fixture-key-'.padEnd(48, 'w');

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-fixon-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
const storeFile = path.join(workdir, 'data', 'member-entitlements.json');
process.chdir(workdir);

const PORT = 8902;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: storeFile,
  GHL_API_BASE_URL: 'http://127.0.0.1:9',
  GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  MEMBERSHIP_FIXTURES: '1',
  MEMBERSHIP_FIXTURE_KEY: FIXTURE_KEY,
});

await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));

async function call(pathname, { method = 'GET', headers = {} } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { method, headers, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, setCookie: r.headers.get('set-cookie') };
}

const base64url = (v) => Buffer.from(v, 'utf8').toString('base64url');
const plainSession = () => {
  const body = base64url(JSON.stringify({
    member: { contactId: 'real-1', email: 'real@example.test' }, exp: Date.now() + 3600_000,
  }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `gaia_member_session=${body}.${sig}`;
};

let fixtureCookie = '';

test('the dev route refuses a wrong key even with fixtures enabled', async () => {
  const res = await call('/api/dev/fixture-session?fixture=fixture-gold-annual', {
    method: 'POST', headers: { 'x-gaia-fixture-key': 'wrong-key' },
  });
  assert.equal(res.status, 404);
});

test('the dev route mints a fixture session with the right key', async () => {
  const res = await call('/api/dev/fixture-session?fixture=fixture-gold-annual', {
    method: 'POST', headers: { 'x-gaia-fixture-key': FIXTURE_KEY },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.fixture, 'fixture-gold-annual');
  assert.equal(res.json.available.length, 14, 'all 14 profiles are offered');
  assert.ok(res.setCookie, 'a session cookie is issued');
  fixtureCookie = res.setCookie.split(';')[0];
});

test('an ordinary signed-in session still gets no fixture, even with fixtures enabled', async () => {
  const res = await call('/api/member/access?fixture=fixture-diamond', { headers: { cookie: plainSession() } });
  assert.notEqual(res.json.source, 'fixture', 'authority comes from the session, not the URL');
  assert.equal(res.json.meta?.fixture, undefined);
});

test('a fixture session serves the requested profile', async () => {
  const res = await call('/api/member/access', { headers: { cookie: fixtureCookie } });
  assert.equal(res.status, 200);
  assert.equal(res.json.source, 'fixture');
  assert.equal(res.json.meta.fixture, 'fixture-gold-annual');
  assert.equal(res.json.membership.key, 'gold');
  assert.equal(res.json.membership.status, 'active');
  assert.equal(res.json.membership.billing_cycle, 'annual');
});

test('a fixture session can switch profiles by parameter', async () => {
  const res = await call('/api/member/access?fixture=fixture-cancelled-gold', { headers: { cookie: fixtureCookie } });
  assert.equal(res.json.meta.fixture, 'fixture-cancelled-gold');
  assert.equal(res.json.membership.key, 'gold');
  assert.equal(res.json.membership.status, 'cancelled');
  // the assertion that matters: independent rights survive
  const course = res.json.entitlements.find((e) => e.type === 'course_access');
  assert.equal(course.status, 'active', 'lifetime course survives cancellation');
  const leads = res.json.entitlements.find((e) => e.type === 'lead_allocation');
  assert.notEqual(leads.status, 'active', 'monthly leads do not survive cancellation');
});

test('every one of the 14 profiles is reachable and carries the v2 shape', async () => {
  const listed = (await call('/api/dev/fixture-session', {
    method: 'POST', headers: { 'x-gaia-fixture-key': FIXTURE_KEY },
  })).json.available;
  assert.equal(listed.length, 14);
  for (const id of listed) {
    const res = await call(`/api/member/access?fixture=${id}`, { headers: { cookie: fixtureCookie } });
    assert.equal(res.status, 200, `${id} resolves`);
    for (const key of ['membership', 'entitlements', 'sections', 'upgrade', 'meta']) {
      assert.ok(key in res.json, `${id} exposes ${key}`);
    }
    assert.equal(res.json.meta.fixture, id);
  }
});

test('an unknown fixture id is refused, not invented', async () => {
  const res = await call('/api/member/access?fixture=fixture-does-not-exist', { headers: { cookie: fixtureCookie } });
  assert.equal(res.status, 404);
  assert.ok(Array.isArray(res.json.available));
});

test('serving fixtures never writes to the ledger', () => {
  const exists = fs.existsSync(storeFile);
  if (exists) {
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    const fixtureIds = Object.keys(store.contacts || {}).filter((id) => id.startsWith('fixture-'));
    assert.deepEqual(fixtureIds, [], 'no fixture contact was persisted');
  } else {
    assert.ok(true, 'no store was written at all');
  }
});

// The proxy holds a listener open; the runner uses --test-force-exit.
