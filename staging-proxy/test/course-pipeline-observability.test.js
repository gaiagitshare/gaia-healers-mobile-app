/**
 * The course purchase → access path, and the monitoring that watches it.
 *
 * Two things are proved here, together, because they are only useful together.
 *
 * First the path itself: a signed delivery is authenticated, checked against the
 * course authority, resolved to a contact, written to the ledger and readable
 * afterwards — and the ways it can go wrong all refuse safely. A duplicate
 * grants nothing twice. A revoke that was generated before the grant it would
 * undo cannot delete it, however late it arrives.
 *
 * Then the monitoring: each of those outcomes has to be DISTINGUISHABLE
 * afterwards. The pipeline is idle in production — no course has sold since 27
 * August — and idle looks exactly like broken from the outside. The next real
 * purchase is the moment that matters, so every decision is counted and the
 * last time each kind happened is kept. A failure class that cannot be told
 * apart from silence is a failure nobody will notice.
 *
 * Synthetic contacts and a throwaway store. No GHL request is made, and no real
 * person's access is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { installCourseAuthority } from './course-authority-fixture.js';

const SECRET = 'pipeline-secret-'.padEnd(48, 'p');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-pipe-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
const storeFile = path.join(workdir, 'data', 'member-entitlements.json');
const teleFile = path.join(workdir, 'data', 'webhook-telemetry.json');
process.chdir(workdir);
installCourseAuthority(workdir, ['pipe-course-1', 'pipe-course-2']);

const PORT = 8931;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: storeFile, WEBHOOK_TELEMETRY_FILE: teleFile,
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  MEMBERSHIP_FIXTURES: '', MEMBERSHIP_FIXTURE_KEY: '',
});

await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 400));

const url = `http://127.0.0.1:${PORT}/api/webhooks/ghl/member-access`;
let n = 0;
const send = async (body, headers = { 'x-webhook-secret': SECRET }) => {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const store = () => JSON.parse(fs.readFileSync(storeFile, 'utf8'));
const tele = () => (JSON.parse(fs.readFileSync(teleFile, 'utf8')) || {}).member_access || {};
const counters = () => tele().counters || {};
const coursesOf = (id) => (store().contacts?.[id]?.courses || []);
const holds = (id, courseId) => coursesOf(id).some((c) => c.id === courseId);

const T = { early: '2026-08-17T09:00:00Z', mid: '2026-08-17T10:00:00Z', late: '2026-08-17T11:00:00Z' };
const grant = (contactId, courseId, timestamp) => send({
  type: 'course_access_granted', contactId, courseId, courseName: courseId,
  timestamp, webhookId: `pipe-${++n}`,
});

// ── The path, end to end ────────────────────────────────────────────────────
test('a signed delivery for a known course grants access and persists it', async () => {
  const c = 'synthetic-pipe-happy';
  const res = await grant(c, 'pipe-course-1', T.mid);
  assert.equal(res.json.applied, true, 'the grant applied');
  assert.equal(holds(c, 'pipe-course-1'), true, 'and the ledger holds it');

  // Persistence is the point: re-read from disk, not from memory.
  const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assert.ok(onDisk.contacts[c].courses.some((x) => x.id === 'pipe-course-1'),
    'the grant survives a re-read of the store file');
  assert.equal(counters().accepted >= 1, true);
  assert.equal(counters().grant >= 1, true);
  assert.ok(tele().lastAcceptedAt, 'and the monitor recorded when it happened');
});

test('a duplicate delivery grants nothing twice', async () => {
  const c = 'synthetic-pipe-dupe';
  const first = await send({
    type: 'course_access_granted', contactId: c, courseId: 'pipe-course-1',
    courseName: 'pipe-course-1', timestamp: T.mid, webhookId: 'pipe-dupe-fixed',
  });
  assert.equal(first.json.applied, true);
  const before = coursesOf(c).length;
  const again = await send({
    type: 'course_access_granted', contactId: c, courseId: 'pipe-course-1',
    courseName: 'pipe-course-1', timestamp: T.mid, webhookId: 'pipe-dupe-fixed',
  });
  assert.equal(again.json.duplicate, true, 'the replay is recognised');
  assert.equal(coursesOf(c).length, before, 'and adds nothing');
  assert.ok(counters().duplicate >= 1, 'the monitor counted it as a duplicate, not a grant');
});

test('a revoke generated BEFORE the grant cannot delete it', async () => {
  const c = 'synthetic-pipe-stale';
  await grant(c, 'pipe-course-1', T.late);
  const stale = await send({
    type: 'course_access_removed', contactId: c, courseId: 'pipe-course-1',
    courseName: 'pipe-course-1', timestamp: T.early, webhookId: `pipe-${++n}`,
  });
  assert.equal(stale.json.applied, false, 'the out-of-order revoke is refused');
  assert.equal(holds(c, 'pipe-course-1'), true, 'and the newer grant survives it');
});

test('a legitimate revoke does remove access', async () => {
  const c = 'synthetic-pipe-revoke';
  await grant(c, 'pipe-course-2', T.mid);
  assert.equal(holds(c, 'pipe-course-2'), true);
  const res = await send({
    type: 'course_access_removed', contactId: c, courseId: 'pipe-course-2',
    courseName: 'pipe-course-2', timestamp: T.late, webhookId: `pipe-${++n}`,
  });
  assert.equal(res.json.applied, true);
  assert.equal(holds(c, 'pipe-course-2'), false, 'access is gone');
  assert.ok(counters().revoke >= 1, 'and it was counted as a revoke, not a grant');
});

// ── The failure classes, each distinguishable ───────────────────────────────
test('an unauthenticated delivery is refused and recorded as an AUTH failure', async () => {
  const before = counters().rejected_auth || 0;
  const res = await send({
    type: 'course_access_granted', contactId: 'synthetic-pipe-auth',
    courseId: 'pipe-course-1', courseName: 'pipe-course-1', timestamp: T.mid, webhookId: `pipe-${++n}`,
  }, { 'x-webhook-secret': 'wrong-secret' });
  assert.equal(res.status, 403);
  assert.equal(counters().rejected_auth, before + 1);
  assert.equal(tele().lastRejectionKind, 'rejected_auth');
  assert.equal(store().contacts?.['synthetic-pipe-auth'], undefined, 'nothing was written');
});

test('an unknown course is refused and recorded as a MAPPING failure', async () => {
  const before = counters().unknown_resource || 0;
  const res = await grant('synthetic-pipe-map', 'course-nobody-has-heard-of', T.mid);
  assert.equal(res.json.applied, false);
  assert.equal(res.json.reason, 'UNKNOWN_RESOURCE');
  assert.equal(counters().unknown_resource, before + 1);
  assert.equal(tele().lastRejectionKind, 'unknown_resource');
});

test('a delivery with no resolvable contact is recorded as an IDENTITY failure', async () => {
  const before = counters().unknown_contact || 0;
  const res = await send({
    type: 'course_access_granted', courseId: 'pipe-course-1',
    courseName: 'pipe-course-1', timestamp: T.mid, webhookId: `pipe-${++n}`,
  });
  assert.equal(res.status, 422);
  assert.equal(counters().unknown_contact, before + 1);
  assert.equal(tele().lastRejectionKind, 'unknown_contact');
});

test('every decision is counted, and no payload is kept', async () => {
  const c = counters();
  for (const k of ['received', 'authenticated', 'rejected_auth', 'unknown_resource',
    'unknown_contact', 'accepted', 'duplicate', 'grant', 'revoke']) {
    assert.equal(typeof c[k], 'number', `${k} is counted`);
  }
  assert.ok(c.received > c.accepted, 'received counts everything, accepted only what applied');

  // The monitor must not become a copy of the thing it monitors.
  const raw = fs.readFileSync(teleFile, 'utf8');
  assert.ok(!raw.includes(SECRET), 'no secret is stored');
  assert.ok(!/synthetic-pipe-/.test(raw), 'no contact identifier is stored');
  assert.ok(!/courseName|course_access_granted/.test(raw), 'no payload is stored');
  const reason = tele().lastRejectionReason || '';
  assert.ok(reason.length <= 80, 'the rejection reason is a short label, not a body');
});
