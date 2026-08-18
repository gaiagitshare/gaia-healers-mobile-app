/**
 * Membership Phase 1 integration tests.
 *
 * Boots the real proxy against a stub GHL and an isolated entitlement store, so
 * the existing course pipeline, the webhook idempotency guard and the legacy
 * /api/member/access fields are proven against the actual server rather than a
 * reimplementation of it. No real GHL, Shopify or production data is touched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SECRET = 'test-secret-'.padEnd(48, 'x');
const CONTACT_ID = 'contact-integration-1';

// ── isolated workspace ──────────────────────────────────────────────────────
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-membership-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
const storeFile = path.join(workdir, 'data', 'member-entitlements.json');
process.chdir(workdir);

// ── stub GHL ────────────────────────────────────────────────────────────────
let subscriptionsResponse = { data: [] };
const stub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  const json = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/contacts/search') {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => json({
      contacts: [{ id: CONTACT_ID, email: 'member@example.test', firstName: 'Test', lastName: 'Member',
        tags: ['ahc-gold-active', 'ahc-gold-trial', 'product_biowell_owner'], customFields: [] }],
      total: 1,
    }));
    return;
  }
  if (url.pathname === '/payments/subscriptions') return json(subscriptionsResponse);
  if (url.pathname.startsWith('/contacts/')) {
    return json({ contact: { id: CONTACT_ID, email: 'member@example.test', tags: ['ahc-gold-active'], customFields: [] } });
  }
  json({});
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubPort = stub.address().port;

// ── boot the real proxy ─────────────────────────────────────────────────────
const PORT = 8899;
Object.assign(process.env, {
  PORT: String(PORT),
  HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET,
  GHL_BACKFILL_SECRET: SECRET,
  GHL_WORKFLOW_WEBHOOK_SECRET: SECRET,
  AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: storeFile,
  GHL_API_BASE_URL: `http://127.0.0.1:${stubPort}`,
  GHL_API_TOKEN: 'test-token',
  GHL_LOCATION_ID: 'test-location',
  ALLOWED_ORIGINS: 'http://localhost:9999',
});

const serverModuleUrl = new URL('../server.js', import.meta.url).href;
await import(serverModuleUrl);
await new Promise((resolve) => setTimeout(resolve, 400));

// ── helpers ─────────────────────────────────────────────────────────────────
const base64url = (value) => Buffer.from(value, 'utf8').toString('base64url');
function sessionCookie(member) {
  const payload = { member, source: 'session', exp: Date.now() + 60 * 60 * 1000 };
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `gaia_member_session=${body}.${sig}`;
}

async function call(pathname, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text };
}

const authed = (pathname) => call(pathname, {
  headers: { cookie: sessionCookie({ contactId: CONTACT_ID, email: 'member@example.test', name: 'Test Member' }) },
});

const webhook = (body, headers = {}) => call('/api/webhooks/ghl/member-access', {
  method: 'POST', body, headers: { 'x-webhook-secret': SECRET, ...headers },
});

const readStore = () => { try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { return null; } };

// ── 13. idempotency ─────────────────────────────────────────────────────────
test('13. duplicate webhook replay is idempotent', async () => {
  const payload = {
    type: 'course_access_granted', contactId: CONTACT_ID,
    courseId: 'offer-idem-1', courseName: 'Idempotency Course', webhookId: 'hook-replay-1',
  };
  const first = await webhook(payload);
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.notEqual(first.json.duplicate, true);

  const second = await webhook(payload);
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicate, true, 'the replay must be recognised, not re-applied');

  const store = readStore();
  const courses = store.contacts[CONTACT_ID].courses.filter((c) => c.id === 'offer-idem-1');
  assert.equal(courses.length, 1, 'exactly one course record after the replay');
  assert.equal(store.processedWebhookIds.filter((id) => id === 'hook-replay-1').length, 1);
});

// ── 15. the existing course pipeline ────────────────────────────────────────
test('15. course grant then remove still works end to end', async () => {
  const granted = await webhook({
    type: 'course_access_granted', contactId: CONTACT_ID,
    courseId: 'offer-pipeline-1', courseName: 'Pipeline Course', webhookId: 'hook-grant-1',
  });
  assert.equal(granted.json.ok, true);
  assert.equal(granted.json.kind, 'course');
  assert.equal(granted.json.grant, true);
  assert.ok(readStore().contacts[CONTACT_ID].courses.some((c) => c.id === 'offer-pipeline-1'));

  const removed = await webhook({
    type: 'course_access_removed', contactId: CONTACT_ID,
    courseId: 'offer-pipeline-1', courseName: 'Pipeline Course', webhookId: 'hook-remove-1',
  });
  assert.equal(removed.json.ok, true);
  assert.equal(removed.json.grant, false);
  assert.ok(!readStore().contacts[CONTACT_ID].courses.some((c) => c.id === 'offer-pipeline-1'),
    'removal still deletes the grant exactly as before');
});

test('webhook rejects an invalid secret', async () => {
  const bad = await webhook({ type: 'course_access_granted', contactId: CONTACT_ID, courseId: 'x' },
    { 'x-webhook-secret': 'wrong' });
  assert.equal(bad.status, 403);
});

// ── 14. out-of-order events ─────────────────────────────────────────────────
test('14. a late-arriving stale revoke can no longer delete a newer grant', async () => {
  await webhook({
    type: 'course_access_granted', contactId: CONTACT_ID,
    courseId: 'offer-order-1', courseName: 'Order Course', webhookId: 'hook-order-grant',
    timestamp: '2026-08-17T10:00:00Z',
  });
  // A revoke generated BEFORE the grant, delivered after it. Phase 1 let this
  // win; Phase 3 must reject it as stale.
  const stale = await webhook({
    type: 'course_access_removed', contactId: CONTACT_ID,
    courseId: 'offer-order-1', courseName: 'Order Course', webhookId: 'hook-order-revoke',
    timestamp: '2026-08-17T09:00:00Z',
  });
  assert.equal(stale.json.applied, false);
  assert.equal(stale.json.stale, true);
  assert.equal(stale.json.reason, 'stale_timestamp');
  assert.ok(readStore().contacts[CONTACT_ID].courses.some((c) => c.id === 'offer-order-1'),
    'the newer grant survives the delayed revoke');
});

// ── 16/17. existing endpoints and legacy fields ─────────────────────────────
test('16. /api/member/courses behaviour is unchanged', async () => {
  const anon = await call('/api/member/courses');
  assert.equal(anon.status, 401, 'still session-gated');
  assert.equal(anon.json.authenticated, false);

  const signedIn = await authed('/api/member/courses');
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.json.ok, true);
  assert.ok('courses' in signedIn.json, 'still returns a courses collection');
});

test('17. /api/member/access keeps every legacy field and adds v2 alongside', async () => {
  const anon = await call('/api/member/access');
  assert.equal(anon.status, 401);

  const response = await authed('/api/member/access');
  assert.equal(response.status, 200);
  const body = response.json;

  // legacy contract — exactly what the current frontend reads
  for (const key of ['ok', 'authenticated', 'source', 'generatedAt', 'member',
    'communities', 'products', 'unknownAccessTags', 'counts', 'customFieldsCount', 'entitlementSource']) {
    assert.ok(key in body, `legacy key ${key} must survive`);
  }
  for (const key of ['name', 'email', 'practitioner', 'practitionerCertified',
    'membershipTier', 'tierMatchedBy', 'tierConflict', 'tierCandidates']) {
    assert.ok(key in body.member, `legacy member.${key} must survive`);
  }
  assert.ok(Array.isArray(body.communities.unlocked));
  assert.ok(Array.isArray(body.communities.locked));

  // v2 contract, added not substituted
  for (const key of ['membership', 'entitlements', 'sections', 'upgrade', 'meta']) {
    assert.ok(key in body, `v2 key ${key} must be present`);
  }
  assert.equal(body.member.contactId, CONTACT_ID, 'contactId added to member without disturbing it');
  assert.ok(Array.isArray(body.entitlements));
  assert.equal(body.meta.resolved_from, 'ledger');
});

test('3 (integration). ahc-gold tags on a live contact still do not grant Gold', async () => {
  subscriptionsResponse = { data: [] };
  const body = (await authed('/api/member/access')).json;
  assert.equal(body.membership.key, null, 'gold tags must not become a Gold membership');
  assert.equal(body.membership.status, 'none');
  assert.ok(body.meta.legacy_membership_tags.includes('ahc-gold-active'));
});

test('5 (integration). a canonical Gold subscription does grant Gold', async () => {
  subscriptionsResponse = {
    data: [{
      _id: 'sub-live-1', status: 'active',
      entityId: '691cbb523963872e3be0f660',           // canonical Gold product
      priceId: '691cbb52396387d816e0f670',            // canonical Gold monthly price
      amount: 0, updatedAt: new Date().toISOString(),
    }],
  };
  const body = (await authed('/api/member/access')).json;
  assert.equal(body.membership.key, 'gold');
  assert.equal(body.membership.status, 'active');
  assert.equal(body.membership.billing_cycle, 'monthly');
  assert.equal(body.membership.label, 'Gold');
  assert.equal(body.membership.subtitle, 'Gaia Practice Pro');
  // This member has no ledger membership, so billing answers — and the read
  // says so, which is how the remaining live dependency stays countable.
  assert.equal(body.meta.membership_resolved_by, 'live_fallback');
  assert.equal(body.meta.membership_provisional, true);
  assert.equal(body.meta.membership_authority, 'ledger_first');
});

test('an unmapped subscription is reported, never guessed into a tier', async () => {
  subscriptionsResponse = {
    data: [{ _id: 'sub-paypal-legacy', status: 'active', amount: 97, currency: 'usd',
      entityId: 'aaaaaaaaaaaaaaaaaaaaaaaa', subscriptionId: 'I-LEGACYPAYPAL', updatedAt: new Date().toISOString() }],
  };
  const body = (await authed('/api/member/access')).json;
  assert.equal(body.membership.key, null, '$97 alone is not Silver');
  assert.equal(body.meta.unmapped_subscriptions.length, 1);
});

test('course grants reach the v2 entitlement list through migration', async () => {
  subscriptionsResponse = { data: [] };
  await webhook({
    type: 'course_access_granted', contactId: CONTACT_ID,
    courseId: 'offer-v2-1', courseName: 'V2 Visible Course', webhookId: 'hook-v2-1',
  });
  const body = (await authed('/api/member/access')).json;
  const course = body.entitlements.find((e) => e.key === 'offer-v2-1');
  assert.ok(course, 'the existing course pipeline feeds the v2 read model');
  assert.equal(course.type, 'course_access');
  assert.equal(course.source, 'ghl_offer');
  assert.equal(course.status, 'active');
});

test('the store on disk keeps its original working shape after v2 reads', () => {
  const store = readStore();
  const record = store.contacts[CONTACT_ID];
  for (const key of ['contactId', 'tags', 'courses', 'communities', 'subscriptions', 'domainUpdatedAt', 'updatedAt']) {
    assert.ok(key in record, `${key} still present on disk`);
  }
  assert.ok(Array.isArray(store.processedWebhookIds) && store.processedWebhookIds.length > 0);
});

// The proxy keeps a listener open; the runner is started with --test-force-exit
// so the process ends once every test has actually finished.
test.after(() => { stub.close(); });
