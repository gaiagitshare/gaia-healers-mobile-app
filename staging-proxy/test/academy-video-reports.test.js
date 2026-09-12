/**
 * A lesson the player could not play is recorded — and only such a lesson.
 *
 * YouTube refuses videos to the page, not the server, so the player reports.
 * The endpoint keeps ids and the error code for a lesson the manifest knows,
 * refuses anything else, and will not be flooded by one client.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'video-secret-'.padEnd(48, 'v');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-video-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);
fs.writeFileSync(path.join(workdir, 'data', 'academy-manifest.json'), JSON.stringify({
  updatedAt: new Date().toISOString(), source: 'test',
  courses: [{ id: 'c-hx', title: 'Healeex - Getting Started', grantMatch: ['Healeex - Getting Started'],
    sections: [{ title: 'Lessons', lessons: [{ id: 'hx-1', title: 'Lesson 1: User Guide', provider: 'youtube', src: 'KmRBzDeRqPI' }] }] }],
}));

const PORT = 8937;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
});
const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => closeServer());

const post = async (body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/academy/video-unavailable`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})), retry: r.headers.get('retry-after') };
};
const reports = () => JSON.parse(fs.readFileSync(path.join(workdir, 'data', 'academy-video-reports.json'), 'utf8'));

test('a known lesson with a YouTube error code is recorded with its titles and source', async () => {
  const r = await post({ courseId: 'c-hx', lessonId: 'hx-1', code: 100 });
  assert.equal(r.status, 200);
  const rec = reports().lessons['c-hx/hx-1'];
  assert.equal(rec.courseTitle, 'Healeex - Getting Started');
  assert.equal(rec.lessonTitle, 'Lesson 1: User Guide');
  assert.equal(rec.provider, 'youtube');
  assert.equal(rec.src, 'KmRBzDeRqPI');
  assert.equal(rec.code, '100');
  assert.equal(rec.count, 1);
});

test('a repeat report counts up and keeps the first sighting', async () => {
  const before = reports().lessons['c-hx/hx-1'];
  await post({ courseId: 'c-hx', lessonId: 'hx-1', code: 100 });
  const after = reports().lessons['c-hx/hx-1'];
  assert.equal(after.count, 2);
  assert.equal(after.firstAt, before.firstAt);
});

test('the course can be named by its grantMatch title too', async () => {
  const r = await post({ courseId: 'Healeex - Getting Started', lessonId: 'hx-1', code: 150 });
  assert.equal(r.status, 200);
  assert.equal(reports().lessons['c-hx/hx-1'].code, '150', 'stored under the canonical course id');
});

test('a lesson the manifest does not know is refused, not stored', async () => {
  const r = await post({ courseId: 'c-hx', lessonId: 'made-up', code: 100 });
  assert.equal(r.status, 404);
  assert.equal(Object.keys(reports().lessons).length, 1);
});

test('an unknown error code is refused', async () => {
  const r = await post({ courseId: 'c-hx', lessonId: 'hx-1', code: 'anything' });
  assert.equal(r.status, 422);
});

test('one client is throttled after twenty reports a minute', async () => {
  let last;
  for (let i = 0; i < 25; i++) last = await post({ courseId: 'c-hx', lessonId: 'hx-1', code: 100 }, { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(last.status, 429);
  assert.equal(last.retry, '60');
});
