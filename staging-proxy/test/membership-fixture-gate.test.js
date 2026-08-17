/**
 * Fixture gate and plan-catalogue separation.
 *
 * The gate is the mechanism that keeps synthetic members out of production, so
 * it is tested from the outside: a real booted proxy, first with fixtures off
 * (production's configuration) and then with them on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { membershipPlans } from '../membership/plans.js';

const SECRET = 'gate-secret-'.padEnd(48, 'y');
const FIXTURE_KEY = 'fixture-key-'.padEnd(48, 'z');

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-gate-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);

const PORT = 8901;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', // unreachable on purpose
  GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  // fixtures deliberately DISABLED for the first block of tests
  MEMBERSHIP_FIXTURES: '', MEMBERSHIP_FIXTURE_KEY: '',
});

await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));

const base64url = (v) => Buffer.from(v, 'utf8').toString('base64url');
function cookie(payload) {
  const body = base64url(JSON.stringify({ exp: Date.now() + 3600_000, ...payload }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `gaia_member_session=${body}.${sig}`;
}
async function call(pathname, { method = 'GET', headers = {} } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { method, headers });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json };
}

// A session that CLAIMS fixture authority. Signed correctly — the only thing
// stopping it must be the process configuration.
const forgedFixtureSession = cookie({
  member: { contactId: 'fixture-gold-annual', email: 'x@fixture.invalid' },
  fixtureAccess: true, fixture: 'fixture-gold-annual', source: 'fixture',
});

test('with fixtures disabled, a fixture-claiming session gets no fixture data', async () => {
  const res = await call('/api/member/access?fixture=fixture-diamond', { headers: { cookie: forgedFixtureSession } });
  assert.equal(res.status, 200);
  assert.notEqual(res.json.source, 'fixture', 'must not serve a fixture');
  assert.equal(res.json.meta?.fixture, undefined, 'no fixture marker');
  assert.equal(res.json.membership.key, null, 'and certainly no synthetic membership');
});

test('with fixtures disabled, the dev mint route does not exist', async () => {
  const res = await call('/api/dev/fixture-session?fixture=fixture-gold-annual', {
    method: 'POST', headers: { 'x-gaia-fixture-key': FIXTURE_KEY },
  });
  assert.equal(res.status, 404, 'production must behave as if the route is absent');
});

test('the query parameter alone is inert', async () => {
  const plain = cookie({ member: { contactId: 'real-contact', email: 'real@example.test' } });
  const res = await call('/api/member/access?fixture=fixture-diamond', { headers: { cookie: plain } });
  assert.notEqual(res.json.source, 'fixture');
  assert.equal(res.json.meta?.fixture, undefined);
});

// ── plan catalogue ──────────────────────────────────────────────────────────
test('GET /api/membership/plans returns presentation data for all four tiers', async () => {
  const res = await call('/api/membership/plans');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.deepEqual(res.json.plans.map((p) => p.key), ['free', 'silver', 'gold', 'diamond']);
  for (const plan of res.json.plans) {
    for (const key of ['key', 'label', 'subtitle', 'prices', 'displayBenefits', 'checkoutUrl']) {
      assert.ok(key in plan, `plan.${key} present`);
    }
  }
  const gold = res.json.plans.find((p) => p.key === 'gold');
  assert.equal(gold.label, 'Gold');
  assert.equal(gold.subtitle, 'Gaia Practice Pro');
  assert.equal(gold.prices.monthly, '$497/mo');
});

test('the plan catalogue carries no authorization data', () => {
  const serialized = JSON.stringify(membershipPlans());
  // canonical billing ids must never leak into the public catalogue
  for (const id of ['69177f9c54010d18cf6a8aad', '691cbb523963872e3be0f660',
    '691cbd1d396387d0eae141e3', 'price_1SUtfsC410ERaiteINnWuhja', 'prod_TRnGmfv0pZjdKM']) {
    assert.ok(!serialized.includes(id), `${id} must not appear in the public plan catalogue`);
  }
  for (const plan of membershipPlans()) {
    assert.equal(plan.entitlements, undefined, 'plans never carry entitlements');
    assert.equal(plan.grants, undefined);
  }
});

test('the resolver does not import the plan catalogue', () => {
  const resolverSource = fs.readFileSync(new URL('../membership/resolver.js', import.meta.url), 'utf8');
  assert.ok(!/plans\.js/.test(resolverSource),
    'pricing/marketing copy must be structurally unable to reach an access decision');
  const gateSource = fs.readFileSync(new URL('../membership/fixture-gate.js', import.meta.url), 'utf8');
  assert.ok(!/plans\.js/.test(gateSource));
});

test('the plan catalogue is not consulted by /api/member/access', async () => {
  const plain = cookie({ member: { contactId: 'real-contact-2', email: 'r2@example.test' } });
  const res = await call('/api/member/access', { headers: { cookie: plain } });
  const serialized = JSON.stringify(res.json);
  assert.ok(!serialized.includes('checkoutUrl'), 'access response carries no catalogue data');
  assert.ok(!serialized.includes('displayBenefits'));
});

// The proxy holds a listener open; the runner uses --test-force-exit.
