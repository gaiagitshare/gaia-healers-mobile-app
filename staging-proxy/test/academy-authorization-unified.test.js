/**
 * One authorization source for every course surface.
 *
 * My Access read record.entitlements[]; the player read record.courses[]. An
 * admin grant (Membership Control Center) landed only in the first — visible
 * in My Access, locked in the player. A webhook revoke spliced the second and
 * left the first alone — player locked, My Access still "Active", on every
 * production record that carried a persisted entitlement list (1,194 of
 * 1,198). Both surfaces now read the same migrated entitlement list, and a
 * webhook write keeps it in step.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCourseAuthority } from './course-authority-fixture.js';

const SECRET = 'unified-secret-'.padEnd(48, 'u');
const ADMIN_PASSWORD = 'admin-pass-for-tests-0123456789abcdef';
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-unified-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);
const MP4 = 'https://cdn.example/orientation.mp4';
fs.writeFileSync(path.join(workdir, 'data', 'academy-manifest.json'), JSON.stringify({
  updatedAt: new Date().toISOString(), source: 'test',
  courses: [{ id: 'prod-1', title: 'Bio-Well Orientation', grantMatch: ['prod-1', 'Bio-Well Orientation'],
    sections: [{ id: 'm1', title: 'Getting Started', lessons: [{ id: 'l1', title: 'One', provider: 'mp4', src: MP4, sourceKind: 'ghl-cdn', sourceValid: true }] }] }],
}));
// Production-shaped record: a course row AND a persisted, derived entitlement.
const prodShaped = (cid) => ({
  contactId: cid, tags: [], tier: null, communities: [], subscriptions: [], ledgerVersion: 2,
  courses: [{ id: 'prod-1', name: 'Bio-Well Orientation', state: 'unlocked', matchedBy: 'backfill:ghl', updatedAt: '2026-08-19T06:00:00.000Z' }],
  entitlements: [{ type: 'course_access', key: 'prod-1', value: { name: 'Bio-Well Orientation' }, status: 'active', source: 'ghl_offer', evidence_id: 'prod-1', starts_at: '2026-08-19T06:00:00.000Z', expires_at: null, observed_at: '2026-08-19T06:00:00.000Z' }],
});
fs.writeFileSync(path.join(workdir, 'data', 'member-entitlements.json'), JSON.stringify({ version: 2, contacts: { 'backfilled-1': prodShaped('backfilled-1'), 'admin-target-1': { contactId: 'admin-target-1', tags: [], tier: null, courses: [], communities: [], subscriptions: [], entitlements: [], ledgerVersion: 2 } } }));
installCourseAuthority(workdir, [{ id: 'prod-1', title: 'Bio-Well Orientation' }]);

const PORT = 8941;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET, GHL_WORKFLOW_WEBHOOK_SECRET: SECRET,
  GAIA_ADMIN_PASSWORD: ADMIN_PASSWORD,
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
});
const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => closeServer());

const b64 = (v) => Buffer.from(v, 'utf8').toString('base64url');
const session = (cid) => { const body = b64(JSON.stringify({ member: { contactId: cid, email: `${cid}@x.test` }, iat: Date.now(), exp: Date.now() + 3600_000 })); return `gaia_member_session=${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`; };
const get = async (p, cookie) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: cookie ? { cookie } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const post = async (p, body, headers = {}) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const surfaces = async (cid) => {
  const [acc, man, me] = await Promise.all([get('/api/member/access', session(cid)), get('/api/academy/manifest', session(cid)), get('/api/academy/me', session(cid))]);
  const row = (acc.json.entitlements || []).find((e) => e.type === 'course_access' && /Orientation/.test(e.value?.name || ''));
  return { myAccess: row ? row.status : 'absent', playerLocked: man.json.courses[0].locked, playerSrc: man.json.courses[0].sections[0].lessons[0].src, meCount: me.json.count };
};

test('backfilled member: My Access, /me and the player agree (all open)', async () => {
  const s = await surfaces('backfilled-1');
  assert.deepEqual(s, { myAccess: 'active', playerLocked: false, playerSrc: MP4, meCount: 1 });
});

test('GHL revoke on a production-shaped record closes every surface, and keeps the history', async () => {
  const r = await post('/api/webhooks/ghl/member-access', { eventId: 'rv-1', type: 'course_access_revoked', contactId: 'backfilled-1', courseId: 'prod-1', courseName: 'Bio-Well Orientation', timestamp: new Date().toISOString() }, { 'x-webhook-secret': SECRET });
  assert.equal(r.json.applied, true, JSON.stringify(r.json));
  const s = await surfaces('backfilled-1');
  assert.equal(s.myAccess, 'revoked', 'My Access shows the course as removed, not active');
  assert.equal(s.playerLocked, true);
  assert.equal(s.playerSrc, '');
  assert.equal(s.meCount, 0);
  const led = JSON.parse(fs.readFileSync(path.join(workdir, 'data', 'member-entitlements.json'), 'utf8')).contacts['backfilled-1'];
  const ent = led.entitlements.find((e) => e.type === 'course_access');
  assert.equal(ent.status, 'revoked', 'the entitlement row is kept, marked revoked');
  assert.ok(ent.revoked_at, 'with the date');
  const denied = await post('/api/academy/progress', { courseId: 'prod-1', lessonId: 'l1', positionSec: 5 }, { cookie: session('backfilled-1') });
  assert.equal(denied.status, 403, 'progress refused after revoke');
});

test('a later GHL re-grant reopens every surface', async () => {
  const r = await post('/api/webhooks/ghl/member-access', { eventId: 'rg-1', type: 'course_access_granted', contactId: 'backfilled-1', courseId: 'prod-1', courseName: 'Bio-Well Orientation', offerId: 'offer-xyz', timestamp: new Date(Date.now() + 1000).toISOString() }, { 'x-webhook-secret': SECRET });
  assert.equal(r.json.applied, true, JSON.stringify(r.json));
  const s = await surfaces('backfilled-1');
  assert.deepEqual(s, { myAccess: 'active', playerLocked: false, playerSrc: MP4, meCount: 1 });
  const led = JSON.parse(fs.readFileSync(path.join(workdir, 'data', 'member-entitlements.json'), 'utf8')).contacts['backfilled-1'];
  assert.equal(led.courses[0].sourceIds.offerId, 'offer-xyz', 'stable GHL ids ride along on the row for id-based mapping later');
});

test('an admin grant from the Control Center unlocks the player too', async () => {
  const lr = await fetch(`http://127.0.0.1:${PORT}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN_PASSWORD }) });
  assert.equal(lr.status, 200);
  const cookie = String(lr.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.startsWith('gaia_admin='), 'admin cookie issued');
  const before = await surfaces('admin-target-1');
  assert.equal(before.playerLocked, true);
  const r = await post('/api/admin/membership/grant', { contactId: 'admin-target-1', type: 'course_access', key: 'prod-1', value: { name: 'Bio-Well Orientation' }, note: 'comp for testing' }, { cookie });
  assert.equal(r.status, 200, 'admin grant: ' + JSON.stringify(r.json).slice(0, 200));
  const after = await surfaces('admin-target-1');
  assert.deepEqual(after, { myAccess: 'active', playerLocked: false, playerSrc: MP4, meCount: 1 });
});
