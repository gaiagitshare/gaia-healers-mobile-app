/**
 * The manifest holds the video URL GHL supplied, and the modules GHL has.
 *
 * The extractor used to send only a videoId and the server rebuilt every
 * native URL as …/<videoId>_5300k.mp4 — a rendition that existed for 8 of 87
 * uploads. It also poured every module into one "Lessons" list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'ingest-secret-'.padEnd(48, 'i');
const ACADEMY_SECRET = 'academy-sync-secret-'.padEnd(40, 's');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-ingest-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);
const PORT = 8942;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET, ACADEMY_SYNC_SECRET: ACADEMY_SECRET,
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'WkKl1K5RuZNQ60xR48k6',
});
const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => closeServer());

const CDN = 'https://cdn.courses.apisystem.tech/memberships/WkKl1K5RuZNQ60xR48k6/videos/3651b5b6-b78e-4ec4-a0f2-807add9cdce6_3200k.mp4';
const GCS = 'https://storage.googleapis.com/revex-membership-production/memberships/WkKl1K5RuZNQ60xR48k6/videos/cts-c94a97895c973fac_1080.mp4';

test('a synced course keeps GHL modules and GHL URLs exactly', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/academy/sync`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-academy-secret': ACADEMY_SECRET },
    body: JSON.stringify({ members: [], courseStats: [], catalog: [{ productId: 'c1', title: 'Bio-Well Orientation', modules: [
      { id: 'm-a', title: 'Getting Started', lessons: [
        { postId: 'l1', title: 'CDN lesson', provider: 'mp4', src: CDN, sourceKind: 'ghl-cdn', videoId: '3651b5b6-b78e-4ec4-a0f2-807add9cdce6', sourceValid: true, sourceCheckedAt: '2026-09-12T16:00:00.000Z' },
        { postId: 'l2', title: 'Bucket lesson', provider: 'mp4', src: GCS, sourceKind: 'ghl-storage', videoId: 'cts-c94a97895c973fac', sourceValid: false, sourceCheckedAt: '2026-09-12T16:00:00.000Z' },
      ] },
      { id: 'm-b', title: 'Troubleshooting', lessons: [
        { postId: 'l3', title: 'YouTube lesson', provider: 'youtube', src: 'wCFHHDa8C-A', sourceKind: 'youtube' },
        { postId: 'l4', title: 'Legacy id-only lesson', videoId: 'deadbeef-0000' },
      ] },
    ] }] }) });
  assert.equal(r.status, 200);
  const m = JSON.parse(fs.readFileSync(path.join(workdir, 'data', 'academy-manifest.json'), 'utf8'));
  const c = m.courses.find((x) => x.id === 'c1');
  assert.deepEqual(c.sections.map((s) => [s.id, s.title, s.lessons.length]), [['m-a', 'Getting Started', 2], ['m-b', 'Troubleshooting', 2]], 'modules kept, in order');
  const [l1, l2] = c.sections[0].lessons; const [l3, l4] = c.sections[1].lessons;
  assert.equal(l1.src, CDN, 'CDN URL verbatim — no rendition rewritten');
  assert.equal(l1.sourceKind, 'ghl-cdn'); assert.equal(l1.sourceValid, true);
  assert.equal(l2.src, GCS, 'bucket URL verbatim');
  assert.equal(l2.sourceKind, 'ghl-storage'); assert.equal(l2.sourceValid, false, 'the failed check is carried to the player');
  assert.equal(l3.provider, 'youtube'); assert.equal(l3.src, 'wCFHHDa8C-A');
  assert.equal(l4.provider, 'none'); assert.equal(l4.src, '', 'an id without a GHL url is never turned into a guessed path');
  assert.ok(!JSON.stringify(m).includes('_5300k'), 'no guessed rendition anywhere in the manifest');
});
