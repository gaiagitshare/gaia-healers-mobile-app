/**
 * /api/academy/webhook grants land in the entitlement ledger, not a side file.
 *
 * It used to write academy-access.json, which the player read and My Access
 * did not — a grant that arrived here showed in one place and not the other.
 * It now hands each resolved course to the ledger's own webhook path over
 * loopback, so identity resolution, ordering and health apply, and a member's
 * course list is the same everywhere. Ownership for the player reads the
 * ledger alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCourseAuthority } from './course-authority-fixture.js';

const SECRET = 'fwd-secret-'.padEnd(48, 'f');
const ACADEMY_SECRET = 'academy-sync-secret-'.padEnd(40, 'a');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-fwd-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);
fs.writeFileSync(path.join(workdir, 'data', 'academy-manifest.json'), JSON.stringify({
  updatedAt: new Date().toISOString(), source: 'test',
  courses: [{ id: 'prod-1', title: 'Bio-Well Orientation', grantMatch: ['prod-1', 'Bio-Well Orientation'],
    sections: [{ title: 'Lessons', lessons: [{ id: 'l1', title: 'One', provider: 'mp4', src: 'https://cdn.example/1.mp4' }] }] }],
}));
// A stale side-file grant for someone who holds nothing in the ledger.
fs.writeFileSync(path.join(workdir, 'data', 'academy-access.json'), JSON.stringify({ byContact: { 'seeded-1': ['prod-1'] }, byEmail: {}, updatedAt: '2026-08-30T00:00:00.000Z' }));
fs.writeFileSync(path.join(workdir, 'data', 'member-entitlements.json'), JSON.stringify({ version: 2, contacts: { 'seeded-1': { courses: [] } } }));

installCourseAuthority(workdir, [{ id: 'prod-1', title: 'Bio-Well Orientation' }]);

const PORT = 8939;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  GHL_WORKFLOW_WEBHOOK_SECRET: SECRET, ACADEMY_SYNC_SECRET: ACADEMY_SECRET,
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
const post = async (p, body, headers = {}) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const get = async (p, cookie) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: cookie ? { cookie } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const ledger = () => JSON.parse(fs.readFileSync(path.join(workdir, 'data', 'member-entitlements.json'), 'utf8'));

test('a grant through the academy webhook is written to the ledger', async () => {
  const r = await post('/api/academy/webhook', { contactId: 'buyer-1', productId: 'prod-1', action: 'grant', timestamp: new Date().toISOString() }, { 'x-academy-secret': ACADEMY_SECRET });
  assert.equal(r.status, 200);
  assert.equal(r.json.forwarded.length, 1);
  assert.equal(r.json.forwarded[0].status, 200, JSON.stringify(r.json.forwarded[0]));
  const rec = ledger().contacts['buyer-1'];
  assert.ok(rec, 'contact created in the ledger');
  assert.ok(rec.courses.some((c) => /Bio-Well Orientation/.test(c.name)), 'course grant present: ' + JSON.stringify(rec.courses));
});

test('…and that member can now play the course, while the side-file seed cannot', async () => {
  const buyer = await get('/api/academy/manifest', session('buyer-1'));
  assert.equal(buyer.json.courses[0].locked, false);
  assert.equal(buyer.json.courses[0].sections[0].lessons[0].src, 'https://cdn.example/1.mp4');
  const seeded = await get('/api/academy/manifest', session('seeded-1'));
  assert.equal(seeded.json.courses[0].locked, true, 'academy-access.json no longer grants anything');
  const me = await get('/api/academy/me', session('seeded-1'));
  assert.equal(me.json.count, 0);
});

test('a revoke through the academy webhook removes the grant', async () => {
  const r = await post('/api/academy/webhook', { contactId: 'buyer-1', productId: 'prod-1', action: 'revoke', timestamp: new Date(Date.now() + 1000).toISOString() }, { 'x-academy-secret': ACADEMY_SECRET });
  assert.equal(r.status, 200);
  assert.equal(r.json.forwarded[0].status, 200, JSON.stringify(r.json.forwarded[0]));
  const rec = ledger().contacts['buyer-1'];
  const live = (rec.courses || []).filter((c) => /Bio-Well Orientation/.test(c.name) && (!c.state || c.state === 'unlocked'));
  assert.equal(live.length, 0, 'no live grant left: ' + JSON.stringify(rec.courses));
  const gone = await get('/api/academy/manifest', session('buyer-1'));
  assert.equal(gone.json.courses[0].locked, true);
});

test('the academy webhook still refuses a bad secret', async () => {
  const r = await post('/api/academy/webhook', { contactId: 'x', productId: 'prod-1' }, { 'x-academy-secret': 'nope' });
  assert.equal(r.status, 401);
});
