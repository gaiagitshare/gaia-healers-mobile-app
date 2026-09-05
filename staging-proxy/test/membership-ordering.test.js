/**
 * Phase 3 — receiver ordering.
 *
 * Twelve scenarios against a real booted receiver with an isolated store. The
 * one that matters most: a revoke generated before a grant must never delete
 * that grant, however late it is delivered. Everything here uses synthetic
 * contact ids; no GHL request is made.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCourseAuthority } from './course-authority-fixture.js';

const SECRET = 'ordering-secret-'.padEnd(48, 'o');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-order-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
const storeFile = path.join(workdir, 'data', 'member-entitlements.json');
// The receiver validates every grant against the course authority. These
// synthetic ids are not in the live catalogue, so the suite installs its own.
installCourseAuthority(workdir, ['course-1', 'course-2', 'course-live', 'course-old',
  'course-A', 'course-B', { id: 'cid-chakra-9001', title: 'Chakra Awakening' }]);
process.chdir(workdir);

const PORT = 8903;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: storeFile,
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  GAIA_DISABLE_ALERT_TIMER: '1', MEMBERSHIP_FIXTURES: '', MEMBERSHIP_FIXTURE_KEY: '',
});

await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));

let seq = 0;
const post = async (pathname, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET, ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};
const hook = (body, headers) => post('/api/webhooks/ghl/member-access', body, headers);
const store = () => JSON.parse(fs.readFileSync(storeFile, 'utf8'));
const rec = (id) => store().contacts[id] || null;
const hasCourse = (id, courseId) => (rec(id)?.courses || []).some((c) => c.id === courseId);
const hasCommunity = (id, groupId) => (rec(id)?.communities || []).some((c) => c.id === groupId);

const grant = (contactId, courseId, timestamp, extra = {}) => hook({
  type: 'course_access_granted', contactId, courseId, courseName: courseId,
  timestamp, webhookId: `ev-${++seq}`, ...extra,
});
const revoke = (contactId, courseId, timestamp, extra = {}) => hook({
  type: 'course_access_removed', contactId, courseId, courseName: courseId,
  timestamp, webhookId: `ev-${++seq}`, ...extra,
});

const T = {
  early: '2026-08-17T09:00:00Z',
  mid: '2026-08-17T10:00:00Z',
  late: '2026-08-17T11:00:00Z',
};

// 1 ─────────────────────────────────────────────────────────────────────────
test('1. grant then revoke, in order — the revoke applies', async () => {
  const c = 'synthetic-order-1';
  await grant(c, 'course-1', T.mid);
  assert.equal(hasCourse(c, 'course-1'), true);
  const r = await revoke(c, 'course-1', T.late);
  assert.equal(r.json.applied, true);
  assert.equal(hasCourse(c, 'course-1'), false);
});

// 2 ─────────────────────────────────────────────────────────────────────────
test('2. revoke then a delayed OLDER grant — the grant is rejected', async () => {
  const c = 'synthetic-order-2';
  await grant(c, 'course-1', T.early);
  await revoke(c, 'course-1', T.late);
  assert.equal(hasCourse(c, 'course-1'), false);
  const stale = await grant(c, 'course-1', T.mid);
  assert.equal(stale.json.applied, false);
  assert.equal(stale.json.reason, 'stale_timestamp');
  assert.equal(hasCourse(c, 'course-1'), false, 'a stale grant must not resurrect a newer revoke');
});

// 3 ─────────────────────────────────────────────────────────────────────────
test('3. grant then a delayed OLDER revoke — the revoke is rejected', async () => {
  const c = 'synthetic-order-3';
  await grant(c, 'course-1', T.late);
  const stale = await revoke(c, 'course-1', T.early);
  assert.equal(stale.json.applied, false);
  assert.equal(stale.json.stale, true);
  assert.equal(hasCourse(c, 'course-1'), true, 'paid access survives a delayed revoke');
});

// 4 / 5 ─────────────────────────────────────────────────────────────────────
test('4. duplicate grant delivery is a no-op', async () => {
  const c = 'synthetic-order-4';
  const body = { type: 'course_access_granted', contactId: c, courseId: 'course-1', courseName: 'c1', timestamp: T.mid, webhookId: 'dup-grant' };
  const first = await hook(body);
  const second = await hook(body);
  assert.equal(first.json.applied, true);
  assert.equal(second.json.duplicate, true);
  assert.equal((rec(c).courses || []).filter((x) => x.id === 'course-1').length, 1);
});

test('5. duplicate revoke delivery is a no-op', async () => {
  const c = 'synthetic-order-5';
  await grant(c, 'course-1', T.early);
  const body = { type: 'course_access_removed', contactId: c, courseId: 'course-1', courseName: 'c1', timestamp: T.late, webhookId: 'dup-revoke' };
  await hook(body);
  const second = await hook(body);
  assert.equal(second.json.duplicate, true);
  assert.equal(hasCourse(c, 'course-1'), false);
});

// 6 ─────────────────────────────────────────────────────────────────────────
test('6. identical timestamps with different event ids resolve deterministically', async () => {
  const run = async (contactId, firstId, secondId) => {
    await hook({ type: 'course_access_granted', contactId, courseId: 'course-1', courseName: 'c1', timestamp: T.mid, webhookId: firstId });
    await hook({ type: 'course_access_removed', contactId, courseId: 'course-1', courseName: 'c1', timestamp: T.mid, webhookId: secondId });
    return hasCourse(contactId, 'course-1');
  };
  // Same pair of ids, opposite arrival order, must reach the same end state.
  // Ids must be globally unique: processedWebhookIds is a global idempotency
  // set, so reusing an id across contacts would dedupe rather than compare.
  const a = await run('synthetic-order-6a', '6a-ev-aaa', '6a-ev-zzz');
  const b = await run('synthetic-order-6b', '6b-ev-zzz', '6b-ev-aaa');
  assert.equal(a, false, 'higher event id (ev-zzz revoke) wins');
  assert.equal(b, true, 'higher event id (ev-zzz grant) wins — same rule, arrival order irrelevant');
});

// 7 ─────────────────────────────────────────────────────────────────────────
test('7. events about course A do not affect course B', async () => {
  const c = 'synthetic-order-7';
  await grant(c, 'course-A', T.late);
  // An OLDER grant for a different course must still apply: watermarks are
  // per-resource, so course A cannot block course B.
  const other = await grant(c, 'course-B', T.mid);
  assert.equal(other.json.applied, true);
  assert.equal(hasCourse(c, 'course-A'), true);
  assert.equal(hasCourse(c, 'course-B'), true);
  // and revoking B leaves A untouched
  await revoke(c, 'course-B', T.late);
  assert.equal(hasCourse(c, 'course-A'), true);
  assert.equal(hasCourse(c, 'course-B'), false);
});

// 8 ─────────────────────────────────────────────────────────────────────────
test('8. events about community A do not affect community B', async () => {
  const c = 'synthetic-order-8';
  await hook({ type: 'community_access_granted', contactId: c, groupId: 'grp-A', groupName: 'A', timestamp: T.late, webhookId: 'ca1' });
  const b = await hook({ type: 'community_access_granted', contactId: c, groupId: 'grp-B', groupName: 'B', timestamp: T.mid, webhookId: 'cb1' });
  assert.equal(b.json.applied, true);
  assert.equal(hasCommunity(c, 'grp-A'), true);
  assert.equal(hasCommunity(c, 'grp-B'), true);
  await hook({ type: 'community_access_revoked', contactId: c, groupId: 'grp-B', groupName: 'B', timestamp: T.late, webhookId: 'cb2' });
  assert.equal(hasCommunity(c, 'grp-A'), true, 'community A untouched');
  assert.equal(hasCommunity(c, 'grp-B'), false);
});

// 9 ─────────────────────────────────────────────────────────────────────────
// The canonical Gold monthly price id. A membership event must carry a billing
// identifier the config recognises: the id decides the tier, and a body-supplied
// `tier` is diagnostic input that cannot grant anything on its own.
const GOLD_MONTHLY_PRICE = '691cbb52396387d816e0f670';

test('a membership event with no billing identifier grants nothing', async () => {
  // The rule this suite must not quietly lose: a tier claim on its own is not
  // evidence of billing, whether it arrives as a tag or as a webhook body.
  const c = 'synthetic-order-9-bare';
  const bare = await hook({ type: 'membership_tier_granted', contactId: c, tier: 'gold', timestamp: T.late, webhookId: 'm0' });
  assert.equal(bare.json.applied, false);
  assert.equal(bare.json.reason, 'BILLING_ID_REQUIRED');
  assert.equal(rec(c), null, 'no record is created by an unbacked tier claim');
});

test('9. membership ordering is independent of course and community ordering', async () => {
  const c = 'synthetic-order-9';
  await hook({ type: 'membership_tier_granted', contactId: c, tier: 'gold',
    priceId: GOLD_MONTHLY_PRICE, timestamp: T.late, webhookId: 'm1' });
  assert.equal(rec(c).tier?.name, 'Gold');
  // an older course event still applies — different resource
  const course = await grant(c, 'course-1', T.mid);
  assert.equal(course.json.applied, true);
  // an older membership event does not
  const staleTier = await hook({ type: 'membership_tier_removed', contactId: c, tier: 'gold',
    priceId: GOLD_MONTHLY_PRICE, timestamp: T.early, webhookId: 'm2' });
  assert.equal(staleTier.json.applied, false);
  assert.equal(rec(c).tier?.name, 'Gold', 'membership survives its own stale event');
  assert.equal(hasCourse(c, 'course-1'), true);
});

// 10 ────────────────────────────────────────────────────────────────────────
test('10. a backfill snapshot cannot overwrite newer live webhook evidence', async () => {
  const c = 'synthetic-order-10';
  await grant(c, 'course-live', T.late);
  const backfill = await post('/api/webhooks/ghl/member-backfill', {
    snapshotAt: T.early, snapshotSource: 'ghl',
    contacts: [{ contactId: c, courses: [{ id: 'course-old', name: 'Old Course' }] }],
  }, { 'x-backfill-secret': SECRET });
  assert.equal(backfill.status, 200);
  assert.equal(hasCourse(c, 'course-live'), true, 'live grant survives an older snapshot');
  assert.equal(hasCourse(c, 'course-old'), false, 'the stale snapshot did not overwrite it');
});

// 11 ────────────────────────────────────────────────────────────────────────
test('11. ordering metadata survives a store reload', async () => {
  const c = 'synthetic-order-11';
  await grant(c, 'course-1', T.late);
  const persisted = store().contacts[c].order['course:course-1'];
  assert.ok(persisted, 'watermark written to disk');
  assert.equal(persisted.basis, 'source');
  assert.equal(persisted.action, 'grant');
  assert.equal(new Date(persisted.at).toISOString(), new Date(T.late).toISOString());
  // a stale event after the reload path is still rejected
  const stale = await revoke(c, 'course-1', T.early);
  assert.equal(stale.json.applied, false);
});

// 12 ────────────────────────────────────────────────────────────────────────
test('12. an event with no usable timestamp is applied but flagged, never treated as a revoke', async () => {
  const c = 'synthetic-order-12';
  // no timestamp at all -> arrival basis
  const first = await hook({ type: 'course_access_granted', contactId: c, courseId: 'course-1', courseName: 'c1', webhookId: 'nt1' });
  assert.equal(first.json.applied, true);
  assert.equal(first.json.orderBasis, 'arrival');
  // a source-timed event against an arrival-timed watermark cannot be ordered
  const mixed = await revoke(c, 'course-1', T.early);
  assert.equal(mixed.json.applied, true);
  assert.equal(mixed.json.orderReason, 'unprovable_order_basis_mismatch');
  assert.equal(mixed.json.lowConfidence, true, 'applied, but honestly marked unprovable');
});

// 13
test('13. an id-keyed grant is not deleted by a delayed OLDER name-only revoke', async () => {
  const c = 'synthetic-order-13';
  // A live GHL course-access grant carries a real product id AND a human name,
  // so the row is keyed by id and the id<->name alias is learned.
  await hook({
    type: 'course_access_granted', contactId: c,
    courseId: 'cid-chakra-9001', courseName: 'Chakra Awakening',
    timestamp: T.late, webhookId: 'ev13-grant',
  });
  assert.equal(hasCourse(c, 'cid-chakra-9001'), true);
  // A late-delivered, strictly OLDER revoke carrying ONLY the course name — the
  // case that used to sidestep the per-resource watermark by landing on a
  // different key than the grant's. It must be refused, not applied.
  const stale = await hook({
    type: 'course_access_removed', contactId: c,
    courseName: 'Chakra Awakening',
    timestamp: T.early, webhookId: 'ev13-revoke',
  });
  assert.equal(stale.json.applied, false, 'the older name-only revoke is refused');
  assert.equal(stale.json.stale, true);
  assert.equal(hasCourse(c, 'cid-chakra-9001'), true, 'paid access survives the aliased stale revoke');
});

test('rejections are stored with an explanation', async () => {
  const c = 'synthetic-order-explain';
  await grant(c, 'course-1', T.late);
  await revoke(c, 'course-1', T.early);
  const rejected = rec(c).rejectedEvents || [];
  assert.ok(rejected.length >= 1);
  const last = rejected[rejected.length - 1];
  assert.equal(last.resource, 'course:course-1');
  assert.equal(last.reason, 'stale_timestamp');
  assert.ok(last.storedAt && last.incomingAt, 'both sides of the comparison are recorded');
});

test('a rejected event is still marked processed so retries do not reopen it', async () => {
  const c = 'synthetic-order-retry';
  await grant(c, 'course-1', T.late);
  const body = { type: 'course_access_removed', contactId: c, courseId: 'course-1', courseName: 'c1', timestamp: T.early, webhookId: 'retry-1' };
  const first = await hook(body);
  const retry = await hook(body);
  assert.equal(first.json.applied, false);
  assert.equal(retry.json.duplicate, true);
  assert.equal(hasCourse(c, 'course-1'), true);
});

test('sequence numbers win over timestamps when both sides provide them', async () => {
  const c = 'synthetic-order-seq';
  await hook({ type: 'course_access_granted', contactId: c, courseId: 'course-1', courseName: 'c1', timestamp: T.early, sequence: 5, webhookId: 's1' });
  const lower = await hook({ type: 'course_access_removed', contactId: c, courseId: 'course-1', courseName: 'c1', timestamp: T.late, sequence: 4, webhookId: 's2' });
  assert.equal(lower.json.applied, false);
  assert.equal(lower.json.reason, 'stale_sequence');
  assert.equal(hasCourse(c, 'course-1'), true, 'a later timestamp cannot beat a lower sequence');
});

// The proxy holds a listener open; the runner uses --test-force-exit.
