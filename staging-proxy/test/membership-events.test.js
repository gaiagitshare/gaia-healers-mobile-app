/**
 * Phase 4A-1 — membership events reach the canonical ledger.
 *
 * Before these fixes a membership webhook wrote only the legacy record.tier,
 * which the resolver ignores, and `membership_ended` was classified as a grant.
 * Both are asserted against here so neither can come back.
 *
 * Synthetic contacts and an isolated store throughout. No GHL request is made.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'events-secret-'.padEnd(48, 'e');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-events-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
const storeFile = path.join(workdir, 'data', 'member-entitlements.json');
process.chdir(workdir);

const PORT = 8905;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: storeFile,
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
});

await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));

const GOLD_MONTHLY = '691cbb52396387d816e0f670';
const GOLD_PRODUCT = '691cbb523963872e3be0f660';
const SILVER_ANNUAL = '69177f9c54010d7d6f6a8abe';

let n = 0;
const hook = async (body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/webhooks/ghl/member-access`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET, ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const store = () => JSON.parse(fs.readFileSync(storeFile, 'utf8'));
const membershipOf = (id) => store().contacts[id]?.membership || null;

const T = { early: '2026-08-17T09:00:00Z', mid: '2026-08-17T10:00:00Z', late: '2026-08-17T11:00:00Z' };

const activate = (contactId, extra = {}) => hook({
  eventId: `ev-${++n}`, eventType: 'membership_activated',
  contactId, timestamp: T.mid,
  productId: GOLD_PRODUCT, priceId: GOLD_MONTHLY,
  tier: 'gold', status: 'active', billingCycle: 'monthly',
  source: 'ghl_subscription', evidenceId: 'sub_qa_1',
  ...extra,
});

// ── the defect that mattered ────────────────────────────────────────────────
test('membership_activated writes canonical membership, not just legacy tier', async () => {
  const c = 'synthetic-ev-activate';
  const res = await activate(c);
  assert.equal(res.status, 200);
  assert.equal(res.json.applied, true);
  assert.equal(res.json.orderBasis, 'source', 'a source-timed event must be high confidence');

  const m = membershipOf(c);
  assert.ok(m, 'canonical membership record exists — this is what the resolver reads');
  assert.equal(m.key, 'gold');
  assert.equal(m.status, 'active');
  assert.equal(m.billing_cycle, 'monthly');
  assert.equal(m.source, 'ghl_subscription');
  assert.equal(m.evidence_id, 'sub_qa_1');
  // legacy mirror still written for diagnostics
  assert.equal(store().contacts[c].tier?.name, 'Gold');
});

test('membership_cancelled sets cancelled and stamps an end date', async () => {
  const c = 'synthetic-ev-cancel';
  await activate(c);
  const res = await hook({
    eventId: `ev-${++n}`, eventType: 'membership_cancelled', contactId: c,
    timestamp: T.late, priceId: GOLD_MONTHLY, tier: 'gold', status: 'cancelled',
  });
  assert.equal(res.json.applied, true);
  const m = membershipOf(c);
  assert.equal(m.status, 'cancelled');
  assert.ok(m.ends_at, 'a cancellation without endsAt records the event time');
});

test('membership_expired sets expired', async () => {
  const c = 'synthetic-ev-expire';
  await activate(c);
  await hook({
    eventId: `ev-${++n}`, eventType: 'membership_expired', contactId: c,
    timestamp: T.late, priceId: GOLD_MONTHLY, tier: 'gold',
    endsAt: '2026-08-16T00:00:00Z',
  });
  assert.equal(membershipOf(c).status, 'expired');
});

test('membership_ended can NEVER grant access', async () => {
  const c = 'synthetic-ev-ended';
  const res = await hook({
    eventId: `ev-${++n}`, eventType: 'membership_ended', contactId: c,
    timestamp: T.mid, priceId: GOLD_MONTHLY, tier: 'gold',
  });
  assert.equal(res.json.applied, true, 'it is a valid event');
  const m = membershipOf(c);
  assert.notEqual(m.status, 'active', 'ended must never produce an active membership');
  assert.equal(m.status, 'expired', 'and "ended" means expired, not cancelled');
  assert.ok(m.ends_at);
});

test('an unknown membership event type is rejected, not granted', async () => {
  const c = 'synthetic-ev-unknown';
  const res = await hook({
    eventId: `ev-${++n}`, eventType: 'membership_frobnicated', contactId: c,
    timestamp: T.mid, priceId: GOLD_MONTHLY, tier: 'gold',
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.applied, false);
  assert.equal(membershipOf(c), null, 'nothing was written');
});

// ── payload shape ───────────────────────────────────────────────────────────
test('the canonical flat payload from the build sheet is accepted', async () => {
  const c = 'synthetic-ev-flat';
  const res = await hook({
    eventId: `ev-${++n}`, eventType: 'membership_activated',
    locationId: 'WkKl1K5RuZNQ60xR48k6', contactId: c, timestamp: T.mid,
    productId: '69177f9c54010d18cf6a8aad', priceId: SILVER_ANNUAL,
    tier: 'silver', status: 'active', billingCycle: 'annual',
    startedAt: '2026-01-01T00:00:00Z', renewsAt: '2027-01-01T00:00:00Z',
    endsAt: null, evidenceId: 'sub_flat',
  });
  assert.equal(res.json.applied, true);
  const m = membershipOf(c);
  assert.equal(m.key, 'silver');
  assert.equal(m.billing_cycle, 'annual');
  assert.equal(m.started_at, '2026-01-01T00:00:00.000Z');
  assert.equal(m.renews_at, '2027-01-01T00:00:00.000Z');
  assert.equal(m.ends_at, null);
});

test('a nested membership object is normalized, never coerced to [object Object]', async () => {
  const c = 'synthetic-ev-nested';
  const res = await hook({
    eventId: `ev-${++n}`, eventType: 'membership_activated', contactId: c, timestamp: T.mid,
    membership: { key: 'diamond', status: 'active', billing_cycle: 'monthly' },
  });
  assert.equal(res.json.applied, true);
  const m = membershipOf(c);
  assert.equal(m.key, 'diamond', 'the nested key was read, not stringified');
  assert.equal(m.billing_cycle, 'monthly');
});

test('a canonical billing id overrules a contradictory tier claim', async () => {
  const c = 'synthetic-ev-conflict';
  const res = await hook({
    eventId: `ev-${++n}`, eventType: 'membership_activated', contactId: c, timestamp: T.mid,
    priceId: SILVER_ANNUAL, tier: 'gold',   // the body lies
  });
  assert.equal(res.json.applied, true);
  assert.equal(membershipOf(c).key, 'silver', 'billing identity wins over the claim');
  assert.ok(res.json.notes?.some((note) => /id wins/.test(note)), 'and the disagreement is reported');
});

test('a membership event with no recognisable tier is rejected', async () => {
  const c = 'synthetic-ev-notier';
  const res = await hook({
    eventId: `ev-${++n}`, eventType: 'membership_activated', contactId: c, timestamp: T.mid,
  });
  assert.equal(res.status, 422);
  assert.equal(membershipOf(c), null);
});

test('legacy tags in a membership payload still cannot grant a tier', async () => {
  const c = 'synthetic-ev-legacytag';
  const res = await hook({
    eventId: `ev-${++n}`, eventType: 'membership_activated', contactId: c, timestamp: T.mid,
    tags: ['ahc-gold-active', 'ahc-gold-trial'],   // no tier, no billing id
  });
  assert.equal(res.status, 422, 'tags are not tier evidence');
  assert.equal(membershipOf(c), null);
});

// ── Phase 3 ordering still governs membership ───────────────────────────────
test('a delayed older cancellation cannot undo a newer activation', async () => {
  const c = 'synthetic-ev-order-1';
  await activate(c, { timestamp: T.late, eventId: `ev-${++n}` });
  const stale = await hook({
    eventId: `ev-${++n}`, eventType: 'membership_cancelled', contactId: c,
    timestamp: T.early, priceId: GOLD_MONTHLY, tier: 'gold',
  });
  assert.equal(stale.json.applied, false);
  assert.equal(stale.json.reason, 'stale_timestamp');
  assert.equal(membershipOf(c).status, 'active', 'paid membership survives a delayed cancellation');
});

test('a delayed older activation cannot undo a newer cancellation', async () => {
  const c = 'synthetic-ev-order-2';
  await activate(c, { timestamp: T.early, eventId: `ev-${++n}` });
  await hook({
    eventId: `ev-${++n}`, eventType: 'membership_cancelled', contactId: c,
    timestamp: T.late, priceId: GOLD_MONTHLY, tier: 'gold',
  });
  const stale = await activate(c, { timestamp: T.mid, eventId: `ev-${++n}` });
  assert.equal(stale.json.applied, false);
  assert.equal(membershipOf(c).status, 'cancelled');
});

test('upgrade and downgrade are ordinary ordered activations', async () => {
  const c = 'synthetic-ev-updown';
  await activate(c, { timestamp: T.early, eventId: `ev-${++n}` });
  assert.equal(membershipOf(c).key, 'gold');
  // upgrade to Diamond
  await hook({
    eventId: `ev-${++n}`, eventType: 'membership_activated', contactId: c, timestamp: T.mid,
    priceId: '691cbd1d396387281fe141f7', tier: 'diamond', billingCycle: 'monthly',
  });
  assert.equal(membershipOf(c).key, 'diamond');
  // downgrade back to Gold
  await hook({
    eventId: `ev-${++n}`, eventType: 'membership_activated', contactId: c, timestamp: T.late,
    priceId: GOLD_MONTHLY, tier: 'gold', billingCycle: 'monthly',
  });
  assert.equal(membershipOf(c).key, 'gold');
});

test('duplicate membership delivery is idempotent', async () => {
  const c = 'synthetic-ev-dup';
  const body = {
    eventId: 'membership-dup-1', eventType: 'membership_activated', contactId: c,
    timestamp: T.mid, priceId: GOLD_MONTHLY, tier: 'gold',
  };
  const first = await hook(body);
  const second = await hook(body);
  assert.equal(first.json.applied, true);
  assert.equal(second.json.duplicate, true);
});

test('equal timestamps resolve deterministically for membership too', async () => {
  const run = async (contactId, firstId, secondId) => {
    await hook({ eventId: firstId, eventType: 'membership_activated', contactId, timestamp: T.mid, priceId: GOLD_MONTHLY, tier: 'gold' });
    await hook({ eventId: secondId, eventType: 'membership_cancelled', contactId, timestamp: T.mid, priceId: GOLD_MONTHLY, tier: 'gold' });
    return membershipOf(contactId).status;
  };
  const a = await run('synthetic-ev-tie-a', 'tie-a-aaa', 'tie-a-zzz');
  const b = await run('synthetic-ev-tie-b', 'tie-b-zzz', 'tie-b-aaa');
  assert.equal(a, 'cancelled', 'higher id (the cancel) wins');
  assert.equal(b, 'active', 'higher id (the activate) wins — arrival order irrelevant');
});

test('membership ordering does not interfere with course ordering', async () => {
  const c = 'synthetic-ev-mixed';
  await activate(c, { timestamp: T.late, eventId: `ev-${++n}` });
  const course = await hook({
    eventId: `ev-${++n}`, type: 'course_access_granted', contactId: c,
    courseId: 'course-x', courseName: 'Course X', timestamp: T.mid,
  });
  assert.equal(course.json.applied, true, 'an older course event is unaffected by the membership watermark');
  assert.equal(membershipOf(c).status, 'active');
});

test('canonical membership survives a store reload', async () => {
  const c = 'synthetic-ev-reload';
  await activate(c);
  const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf8')).contacts[c];
  assert.equal(onDisk.membership.key, 'gold');
  assert.equal(onDisk.order.membership.basis, 'source');
  assert.equal(onDisk.order.membership.action, 'grant');
});

// The proxy holds a listener open; the runner uses --test-force-exit.

// ── the whole point: does the member see it? ────────────────────────────────
import crypto from 'node:crypto';

const sessionCookie = (contactId) => {
  const body = Buffer.from(JSON.stringify({
    member: { contactId, email: `${contactId}@synthetic.invalid`, name: contactId },
    exp: Date.now() + 3600_000,
  }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `gaia_member_session=${body}.${sig}`;
};

const accessFor = async (contactId) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/member/access`, {
    headers: { cookie: sessionCookie(contactId) },
  });
  return r.json();
};

test('END TO END: a membership event changes /api/member/access', async () => {
  const c = 'synthetic-ev-e2e';
  // before: nothing
  const before = await accessFor(c);
  assert.equal(before.membership.key, null, 'no membership before the event');
  assert.equal(before.membership.status, 'none');

  await activate(c, { eventId: `ev-${++n}` });

  const after = await accessFor(c);
  assert.equal(after.membership.key, 'gold', 'the event is now visible to the member');
  assert.equal(after.membership.status, 'active');
  assert.equal(after.membership.billing_cycle, 'monthly');
  assert.equal(after.membership.label, 'Gold');
  assert.equal(after.membership.subtitle, 'Gaia Healers Practice Pro');
  assert.match(after.meta.membership_resolved_by, /^ledger:/, 'resolved from the ledger, not a live GHL call');
});

test('END TO END: cancellation is visible, and independent rights survive', async () => {
  const c = 'synthetic-ev-e2e-cancel';
  await activate(c, { eventId: `ev-${++n}`, timestamp: T.early });
  await hook({
    eventId: `ev-${++n}`, type: 'course_access_granted', contactId: c,
    courseId: 'lifetime-1', courseName: 'Lifetime Course', timestamp: T.early,
  });
  await hook({
    eventId: `ev-${++n}`, eventType: 'membership_cancelled', contactId: c,
    timestamp: T.late, priceId: GOLD_MONTHLY, tier: 'gold',
  });

  const access = await accessFor(c);
  assert.equal(access.membership.key, 'gold');
  assert.equal(access.membership.status, 'cancelled');
  const course = access.entitlements.find((e) => e.type === 'course_access');
  assert.equal(course.status, 'active', 'the course outlives the cancelled membership');
});

test('END TO END: legacy ahc tags on the session still grant nothing', async () => {
  const c = 'synthetic-ev-e2e-tags';
  const access = await accessFor(c);
  assert.equal(access.membership.key, null);
  assert.equal(access.membership.status, 'none');
});
