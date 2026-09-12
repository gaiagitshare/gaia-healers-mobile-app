/**
 * Stable GHL ids become the primary course identity once seen; names stay
 * the fallback. And content in the catalog never grants anyone anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'idmap-secret-'.padEnd(48, 'm');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-idmap-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);
fs.writeFileSync(path.join(workdir, 'data', 'academy-manifest.json'), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'test', courses: [
  { id: 'prod-orientation', title: 'Bio-Well Orientation', grantMatch: ['prod-orientation', 'Bio-Well Orientation'], sections: [{ id: 'm1', title: 'Getting Started', lessons: [{ id: 'l1', title: 'One', provider: 'mp4', src: 'https://cdn.example/1.mp4', sourceKind: 'ghl-cdn', sourceValid: true }] }] },
  { id: 'prod-chakra', title: '9-Week Chakra Challenge', grantMatch: ['prod-chakra', '9-Week Chakra Challenge'], sections: [{ id: 'm2', title: 'Weeks', lessons: [{ id: 'l2', title: 'Week 1', provider: 'mp4', src: 'https://cdn.example/2.mp4', sourceKind: 'ghl-storage', sourceValid: true }] }] },
] }));
fs.writeFileSync(path.join(workdir, 'data', 'member-entitlements.json'), JSON.stringify({ version: 2, contacts: {} }));
// Authority without a precomputed groupKey: the server derives it with its own
// normaliser (the fixture helper keeps hyphens, which "Bio-Well" would trip on).
fs.writeFileSync(path.join(workdir, 'data', 'course-authority.json'), JSON.stringify({ version: 1, courses: [{ id: 'prod-orientation', title: 'Bio-Well Orientation' }, { id: 'prod-chakra', title: '9-Week Chakra Challenge' }], ambiguous_keys: {} }));
fs.writeFileSync(path.join(workdir, 'data', 'course-authority-aliases.json'), JSON.stringify({ version: 1, aliases: [] }));
process.env.COURSE_AUTHORITY_FILE = path.join(workdir, 'data', 'course-authority.json');
process.env.COURSE_ALIAS_FILE = path.join(workdir, 'data', 'course-authority-aliases.json');

const PORT = 8943;
Object.assign(process.env, { PORT: String(PORT), HOST: '127.0.0.1', COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET, GHL_WORKFLOW_WEBHOOK_SECRET: SECRET, MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'), GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x' });
const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => closeServer());
const post = async (body) => { const r = await fetch(`http://127.0.0.1:${PORT}/api/webhooks/ghl/member-access`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const idmap = () => JSON.parse(fs.readFileSync(path.join(workdir, 'data', 'course-id-map.json'), 'utf8')).learned;
const ledger = () => JSON.parse(fs.readFileSync(path.join(workdir, 'data', 'member-entitlements.json'), 'utf8')).contacts;
const b64 = (v) => Buffer.from(v).toString('base64url');
const session = (cid) => { const body = b64(JSON.stringify({ member: { contactId: cid, email: `${cid}@x.test` }, iat: Date.now(), exp: Date.now() + 3600_000 })); return `gaia_member_session=${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`; };

test('a grant that carries an offer id and resolves by name teaches the id', async () => {
  // GHL offer titled "<Course>-<Audience>", with the offer id in the body.
  const r = await post({ eventId: 'g1', type: 'course_access_granted', contactId: 'm1', offerId: 'offer-77', courseName: 'Bio-Well Orientation-Reiki Practitioners', timestamp: new Date().toISOString() });
  assert.equal(r.json.applied, true, JSON.stringify(r.json));
  assert.equal(ledger().m1.courses[0].name, 'Bio-Well Orientation');
  assert.equal(ledger().m1.courses[0].sourceIds.offerId, 'offer-77');
  assert.equal(idmap()['offer-77'].courseId, 'prod-orientation');
  assert.equal(idmap()['offer-77'].method, 'offer_title_prefix', 'learned from the strict rule that settled it');
});

test('the next event with that id resolves by id — even with a name nobody could match', async () => {
  const r = await post({ eventId: 'g2', type: 'course_access_granted', contactId: 'm2', offerId: 'offer-77', courseName: 'Renamed Offer Nobody Recognises', timestamp: new Date().toISOString() });
  assert.equal(r.json.applied, true, JSON.stringify(r.json));
  assert.equal(ledger().m2.courses[0].name, 'Bio-Well Orientation');
  assert.match(ledger().m2.courses[0].matchedBy, /learned_id/);
});

test('a learned id is never re-pointed at another course', async () => {
  const r = await post({ eventId: 'g3', type: 'course_access_granted', contactId: 'm3', offerId: 'offer-77', courseName: '9-Week Chakra Challenge', timestamp: new Date().toISOString() });
  assert.equal(r.json.applied, true);
  assert.equal(ledger().m3.courses[0].name, 'Bio-Well Orientation', 'the id wins over the (conflicting) name');
  assert.equal(idmap()['offer-77'].courseId, 'prod-orientation');
});

test('an id whose name the strict rules refuse teaches nothing', async () => {
  const r = await post({ eventId: 'g4', type: 'course_access_granted', contactId: 'm4', offerId: 'offer-88', courseName: 'Totally Unknown Bundle', timestamp: new Date().toISOString() });
  assert.equal(r.json.applied, false);
  assert.equal(idmap()['offer-88'], undefined);
});

test('CONTENT ≠ ENTITLEMENT: a course in the catalog is locked for a member who holds nothing', async () => {
  const man = await (await fetch(`http://127.0.0.1:${PORT}/api/academy/manifest`, { headers: { cookie: session('holds-nothing') } })).json();
  assert.equal(man.courses.length, 2, 'both courses are in the catalog (content)');
  assert.ok(man.courses.every((c) => c.locked), 'and neither is playable for this member (entitlement)');
  assert.ok(man.courses.every((c) => c.sections.every((s) => s.lessons.every((l) => l.src === ''))));
  const me = await (await fetch(`http://127.0.0.1:${PORT}/api/academy/me`, { headers: { cookie: session('holds-nothing') } })).json();
  assert.equal(me.count, 0);
});
