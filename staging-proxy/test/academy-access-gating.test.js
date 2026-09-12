/**
 * A course video is served only to a session that owns the course.
 *
 * Before this, /api/academy/manifest handed every CDN mp4 of every
 * certification to anyone who asked, /api/academy/me returned any member's
 * courses and progress for a contact id typed into the URL, and progress could
 * be written under anyone's name. The rule is the one My Access already lives
 * by — the entitlement ledger mirrored from GHL — keyed by the session cookie.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'gating-secret-'.padEnd(48, 'g');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-gate-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);

const MP4 = 'https://cdn.courses.apisystem.tech/memberships/loc/videos/abc_5300k.mp4';
fs.writeFileSync(path.join(workdir, 'data', 'academy-manifest.json'), JSON.stringify({
  updatedAt: new Date().toISOString(), source: 'test',
  courses: [
    { id: 'c-paid', title: 'Bio-Well Orientation', grantMatch: ['Bio-Well Orientation'],
      sections: [{ title: 'Lessons', lessons: [{ id: 'l1', title: 'Scan basics', provider: 'mp4', src: MP4 }, { id: 'l2', title: 'Taster', provider: 'mp4', src: MP4, free: true }] }] },
    { id: 'c-demo', title: 'Demo', preview: true, grantMatch: [],
      sections: [{ title: 'Welcome', lessons: [{ id: 'd1', title: 'Hello', provider: 'mp4', src: MP4 }] }] },
  ],
}));
// The ledger: one contact owns the paid course, another owns nothing.
fs.writeFileSync(path.join(workdir, 'data', 'member-entitlements.json'), JSON.stringify({
  version: 2, contacts: {
    'owner-1': { courses: [{ id: 'x', name: 'Bio-Well Orientation', state: 'unlocked' }] },
    'nobody-1': { courses: [] },
  },
}));

const PORT = 8938;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
});
const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => closeServer());

const base64url = (v) => Buffer.from(v, 'utf8').toString('base64url');
const session = (contactId) => {
  const body = base64url(JSON.stringify({ member: { contactId, email: `${contactId}@example.test` }, iat: Date.now(), exp: Date.now() + 3600_000 }));
  return `gaia_member_session=${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};
const get = async (p, cookie) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: cookie ? { cookie } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const post = async (p, body, cookie) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const lesson = (manifest, courseId, lessonId) => manifest.courses.find((c) => c.id === courseId).sections[0].lessons.find((l) => l.id === lessonId);

test('a visitor sees course and lesson titles, but no video source for a paid course', async () => {
  const r = await get('/api/academy/manifest');
  assert.equal(r.status, 200);
  const paid = r.json.courses.find((c) => c.id === 'c-paid');
  assert.equal(paid.locked, true);
  assert.equal(paid.title, 'Bio-Well Orientation');
  assert.equal(lesson(r.json, 'c-paid', 'l1').title, 'Scan basics', 'structure stays visible');
  assert.equal(lesson(r.json, 'c-paid', 'l1').src, '', 'the video does not');
  assert.equal(lesson(r.json, 'c-paid', 'l1').locked, true);
});

test('a free lesson and a preview course keep their video for everyone', async () => {
  const r = await get('/api/academy/manifest');
  assert.equal(lesson(r.json, 'c-paid', 'l2').src, MP4, 'free lesson inside a paid course');
  const demo = r.json.courses.find((c) => c.id === 'c-demo');
  assert.equal(demo.locked, false);
  assert.equal(lesson(r.json, 'c-demo', 'd1').src, MP4);
});

test('the owner of a course gets its videos', async () => {
  const r = await get('/api/academy/manifest', session('owner-1'));
  const paid = r.json.courses.find((c) => c.id === 'c-paid');
  assert.equal(paid.locked, false);
  assert.equal(lesson(r.json, 'c-paid', 'l1').src, MP4);
});

test('a signed-in member without the grant is treated like a visitor for that course', async () => {
  const r = await get('/api/academy/manifest', session('nobody-1'));
  assert.equal(r.json.courses.find((c) => c.id === 'c-paid').locked, true);
  assert.equal(lesson(r.json, 'c-paid', 'l1').src, '');
});

test('/api/academy/me answers for the session only — a contact id in the URL is ignored', async () => {
  const anon = await get('/api/academy/me?contactId=owner-1');
  assert.equal(anon.json.count, 0, 'no session, no courses — whoever the URL names');
  assert.equal(anon.json.authenticated, false);
  const owner = await get('/api/academy/me?contactId=nobody-1', session('owner-1'));
  assert.deepEqual(owner.json.courses.map((c) => c.id), ['c-paid'], 'the session\'s courses, not the URL\'s');
});

test('progress is written for the session, only on a course it owns', async () => {
  const anon = await post('/api/academy/progress', { contactId: 'owner-1', courseId: 'c-paid', lessonId: 'l1', positionSec: 10 });
  assert.equal(anon.status, 401);
  const stranger = await post('/api/academy/progress', { contactId: 'owner-1', courseId: 'c-paid', lessonId: 'l1', positionSec: 10 }, session('nobody-1'));
  assert.equal(stranger.status, 403);
  const owner = await post('/api/academy/progress', { contactId: 'someone-else', courseId: 'c-paid', lessonId: 'l1', positionSec: 10, durationSec: 100 }, session('owner-1'));
  assert.equal(owner.status, 200);
  const stored = JSON.parse(fs.readFileSync(path.join(workdir, 'data', 'academy-progress.json'), 'utf8'));
  assert.ok(stored.byContact['owner-1'], 'stored under the session\'s contact');
  assert.equal(stored.byContact['someone-else'], undefined, 'never under the name in the body');
});
