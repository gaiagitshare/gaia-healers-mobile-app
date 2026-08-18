/**
 * Membership Admin, end to end against the real proxy.
 *
 * This is the scenario the whole phase exists to make possible: an operator
 * builds a member's access by hand — plan, leads, a course, a device, a licence
 * — and the app reflects it immediately, with no GHL involved anywhere.
 *
 * Runs against an isolated store and a stub GHL. No real data is touched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SECRET = 'admin-secret-'.padEnd(48, 'z');
const ADMIN_PASSWORD = 'operator-test-password';
const CONTACT_ID = 'synthetic-admin-e2e';

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-admin-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
const storeFile = path.join(workdir, 'data', 'member-entitlements.json');
const policyFile = path.join(workdir, 'data', 'membership-policy.json');
process.chdir(workdir);

// stub GHL — the admin path must not depend on it, but the server boots with it
const stub = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ contacts: [{ id: CONTACT_ID, email: 'e2e@example.test', tags: [], customFields: [] }], data: [] }));
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));

const PORT = 8907;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: storeFile,
  MEMBERSHIP_POLICY_FILE: policyFile,
  GAIA_ADMIN_PASSWORD: ADMIN_PASSWORD,
  GHL_API_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
  GHL_API_TOKEN: 'test-token', GHL_LOCATION_ID: 'test-location',
});

await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 400));

// ── helpers ─────────────────────────────────────────────────────────────────
let adminCookie = '';

async function call(pathname, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  return { status: response.status, json, raw, headers: response.headers };
}

const admin = (pathname, options = {}) => call(pathname, {
  ...options, headers: { ...(options.headers || {}), cookie: adminCookie },
});

const base64url = (value) => Buffer.from(value, 'utf8').toString('base64url');
function memberSession(contactId) {
  const payload = { member: { contactId, email: 'e2e@example.test', name: 'E2E' }, source: 'session', exp: Date.now() + 3600_000 };
  const body = base64url(JSON.stringify(payload));
  return `gaia_member_session=${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
const memberAccess = () => call('/api/member/access', { headers: { cookie: memberSession(CONTACT_ID) } });

const typesOf = (body) => (body.entitlements || []).filter((e) => e.status === 'active').map((e) => e.type);

// ── auth ────────────────────────────────────────────────────────────────────
test('membership admin is closed to anyone without the admin cookie', async () => {
  const res = await call('/api/admin/membership/members');
  assert.equal(res.status, 401);
  const write = await call('/api/admin/membership/assign', {
    method: 'POST', body: { contactId: CONTACT_ID, key: 'diamond' },
  });
  assert.equal(write.status, 401, 'the write path is behind the same gate');
});

test('logging in as the operator opens the membership routes', async () => {
  const login = await call('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } });
  assert.equal(login.json.ok, true);
  adminCookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(adminCookie.startsWith('gaia_admin='));
  const res = await admin('/api/admin/membership/members');
  assert.equal(res.json.ok, true);
});

// ── the operator's scenario ─────────────────────────────────────────────────
test('1. assign Gold — the plan is set and nothing is granted', async () => {
  const res = await admin('/api/admin/membership/assign', {
    method: 'POST',
    body: { contactId: CONTACT_ID, key: 'gold', status: 'active', billing_cycle: 'annual', note: 'comped for the retreat' },
  });
  assert.equal(res.json.ok, true);
  assert.equal(res.json.member.membership.key, 'gold');
  assert.equal(res.json.member.membership.source, 'manual');
  assert.deepEqual(res.json.member.entitlements, [], 'a plan is not a bundle of rights');

  const app = await memberAccess();
  assert.equal(app.json.membership.key, 'gold', 'the app sees the new plan at once');
  assert.equal(app.json.membership.status, 'active');
});

test('2. the member view names exactly what Gold promises but the member lacks', async () => {
  const res = await admin(`/api/admin/membership/member?id=${CONTACT_ID}`);
  assert.deepEqual(res.json.member.drift.missing.map((m) => m.type).sort(),
    ['crm_access', 'directory_level', 'discount', 'lead_allocation']);
});

test('3. applying Gold policy writes real records, and the app gains them', async () => {
  const res = await admin('/api/admin/membership/apply-policy', {
    method: 'POST', body: { contactId: CONTACT_ID, key: 'gold' },
  });
  assert.equal(res.json.ok, true);
  assert.equal(res.json.result.created.length, 4);
  assert.equal(res.json.member.drift.missing.length, 0);

  const leads = res.json.member.entitlements.find((e) => e.type === 'lead_allocation');
  assert.equal(leads.value.monthly, 5, 'Gold includes 5 leads a month');
  assert.match(leads.key, /^\d{4}-\d{2}$/, 'scoped to a period, not left as "monthly"');
  assert.equal(leads.source, 'membership_policy');

  const app = await memberAccess();
  for (const type of ['crm_access', 'directory_level', 'lead_allocation', 'discount']) {
    assert.ok(typesOf(app.json).includes(type), `${type} reaches the app`);
  }
});

test('4. grant a course, then revoke it — the app follows both ways', async () => {
  const grant = await admin('/api/admin/membership/grant', {
    method: 'POST',
    body: { contactId: CONTACT_ID, type: 'course_access', key: 'offer-biowell-1', value: { name: 'Bio-Well Level 1' } },
  });
  assert.equal(grant.json.ok, true);
  assert.equal(grant.json.result.entitlement.source, 'manual');
  assert.ok(typesOf((await memberAccess()).json).includes('course_access'));

  const revoke = await admin('/api/admin/membership/revoke', {
    method: 'POST', body: { contactId: CONTACT_ID, type: 'course_access', key: 'offer-biowell-1', note: 'refunded' },
  });
  assert.equal(revoke.json.ok, true);
  assert.ok(!typesOf((await memberAccess()).json).includes('course_access'),
    'the app loses it immediately');

  const stored = revoke.json.member.entitlements.find((e) => e.key === 'offer-biowell-1');
  assert.equal(stored.status, 'revoked', 'the record survives so the history can be read');
});

test('5. the member owns a device, and a licence that expires', async () => {
  await admin('/api/admin/membership/grant', {
    method: 'POST',
    body: { contactId: CONTACT_ID, type: 'device_owner', key: 'biowell-3', value: { name: 'Bio-Well 3.0' }, note: 'shipped 12 Aug' },
  });
  const expired = await admin('/api/admin/membership/grant', {
    method: 'POST',
    body: {
      contactId: CONTACT_ID, type: 'device_software', key: 'biowell-suite',
      value: { name: 'Bio-Well Suite' }, expires_at: '2026-01-01T00:00:00.000Z',
    },
  });
  assert.equal(expired.json.ok, true);
  assert.equal(expired.json.result.entitlement.status, 'expired',
    'a past expiry is honoured at write time, not left as active');

  const app = await memberAccess();
  assert.ok(typesOf(app.json).includes('device_owner'), 'the device is owned');
  assert.ok(!typesOf(app.json).includes('device_software'), 'the lapsed licence is not active');
});

test('6. downgrade to Silver — owned things stay, leftover policy rights are surfaced', async () => {
  const res = await admin('/api/admin/membership/assign', {
    method: 'POST', body: { contactId: CONTACT_ID, key: 'silver', status: 'active', billing_cycle: 'monthly' },
  });
  assert.equal(res.json.ok, true);
  assert.equal(res.json.member.membership.key, 'silver');
  assert.ok(res.json.member.drift.extra.some((e) => e.type === 'lead_allocation'),
    'Gold leads left behind by the downgrade are named, not silently kept');

  const app = await memberAccess();
  assert.equal(app.json.membership.key, 'silver');
  assert.ok(typesOf(app.json).includes('device_owner'), 'the device the member owns is untouched by a downgrade');
});

test('7. every step is on the audit trail, in order, with its note', async () => {
  const res = await admin(`/api/admin/membership/audit?id=${CONTACT_ID}`);
  const actions = res.json.entries.map((e) => e.action).reverse();
  assert.deepEqual(actions.slice(0, 2), ['membership.assign', 'entitlement.grant']);
  assert.ok(actions.includes('policy.apply'));
  assert.ok(actions.includes('entitlement.revoke'));
  assert.equal(actions[actions.length - 1], 'membership.assign', 'the downgrade is last');

  const revoked = res.json.entries.find((e) => e.action === 'entitlement.revoke');
  assert.equal(revoked.note, 'refunded');
  assert.equal(revoked.actor, 'admin');
  assert.ok(revoked.detail.from && revoked.detail.to, 'before and after are both recorded');
});

// ── guards ──────────────────────────────────────────────────────────────────
test('the admin write path refuses fixture ids', async () => {
  const res = await admin('/api/admin/membership/assign', {
    method: 'POST', body: { contactId: 'fixture-gold-annual', key: 'diamond' },
  });
  assert.equal(res.json.ok, false);
  assert.equal(res.json.reason, 'fixture_ids_are_read_only');
});

test('an unknown plan or entitlement type is refused, and nothing is written', async () => {
  const plan = await admin('/api/admin/membership/assign', {
    method: 'POST', body: { contactId: 'synthetic-guard-1', key: 'platinum' },
  });
  assert.equal(plan.json.reason, 'unknown_plan_key');
  const type = await admin('/api/admin/membership/grant', {
    method: 'POST', body: { contactId: 'synthetic-guard-1', type: 'teleport_access', key: 'mars' },
  });
  assert.equal(type.json.reason, 'unknown_entitlement_type');

  const list = await admin('/api/admin/membership/members');
  assert.ok(!list.json.members.some((m) => m.contactId === 'synthetic-guard-1'),
    'a refused write creates no record');
});

// ── policy editing ──────────────────────────────────────────────────────────
test('editing a plan changes the promise and no member access', async () => {
  const before = (await memberAccess()).json;
  const beforeTypes = typesOf(before).slice().sort();

  const save = await admin('/api/admin/membership/policy', {
    method: 'POST',
    body: {
      key: 'silver',
      plan: {
        label: 'Silver', prices: { monthly: '$127/mo', annual: '$1,297/yr' },
        benefits: [
          { type: 'crm_access', key: 'diy', value: { level: 'diy' } },
          { type: 'directory_level', key: '3', value: { level: 3 } },
          { type: 'lead_allocation', key: 'monthly', value: { monthly: 2 } },
        ],
      },
    },
  });
  assert.equal(save.json.ok, true);
  assert.equal(save.json.plan.prices.monthly, '$127/mo');
  assert.equal(save.json.plan.benefits.length, 3);

  const after = (await memberAccess()).json;
  assert.deepEqual(typesOf(after).slice().sort(), beforeTypes,
    'a policy edit is not a grant — no member gained or lost anything');
});

test('a saved policy survives a reload and is served to the app catalogue', async () => {
  const raw = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  assert.equal(raw.plans.silver.prices.monthly, '$127/mo');
  assert.ok(raw.updatedAt, 'the edit is stamped');

  const preview = await admin('/api/admin/membership/policy/preview?plan=silver');
  assert.equal(preview.json.entitlements.length, 3);
  for (const item of preview.json.entitlements) {
    assert.equal(item.source, 'membership_policy');
  }
});

test('the schema route describes what can be granted, so the UI invents nothing', async () => {
  const res = await admin('/api/admin/membership/schema');
  assert.deepEqual(res.json.membershipKeys, ['free', 'silver', 'gold', 'diamond']);
  assert.ok(res.json.entitlementTypes.length >= 6);
  assert.ok(res.json.entitlementTypes.every((t) => t.key && t.title));
  assert.equal(res.json.entitlementTypes[0].key, 'course_access', 'served in display order');
  assert.ok(res.json.entitlementSources.includes('manual'));
});

test('the member list counts plans and finds a member by id', async () => {
  const res = await admin(`/api/admin/membership/members?q=${CONTACT_ID}`);
  assert.equal(res.json.members.length, 1);
  assert.equal(res.json.members[0].plan, 'silver');
  assert.ok(res.json.members[0].entitlements >= 4);
  assert.equal(res.json.counts.silver, 1);
});

// The proxy holds a listener open; the runner uses --test-force-exit.
