/**
 * My Access rows must lead somewhere, and a member who keeps coming back must
 * stay signed in.
 *
 * Two member-reported gaps, one boot:
 *  - the access payload stamps an openUrl on every course/community row, and
 *    a course the in-app Academy player carries is also stamped with its
 *    manifest id so the row opens the player instead of the portal;
 *  - the profile read (the app's first call on every launch) re-issues the
 *    session cookie once it is a day old, so a daily member never hits the
 *    hard expiry — while a fixture session, a fresh session and a session
 *    past the absolute cap are all left alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'links-secret-'.padEnd(48, 'l');
const FIXTURE_KEY = 'links-fixture-key-'.padEnd(48, 'k');
const DAY = 24 * 60 * 60 * 1000;
const TTL_SECONDS = 14 * 24 * 60 * 60;

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-links-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);

// The in-app player's manifest: one fixture course with lessons, one without.
fs.writeFileSync(path.join(workdir, 'data', 'academy-manifest.json'), JSON.stringify({
  updatedAt: new Date().toISOString(),
  source: 'test',
  courses: [
    { id: 'acad-gold-1', title: 'Gold Course 1', grantMatch: ['Gold Course 1'],
      sections: [{ title: 'Lessons', lessons: [{ id: 'l1', title: 'One' }, { id: 'l2', title: 'Two' }] }] },
    { id: 'acad-silver-1', title: 'Silver Course 1', grantMatch: ['Silver Course 1'], sections: [] },
  ],
}));

const PORT = 8934;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  AUTH_SESSION_TTL_SECONDS: String(TTL_SECONDS),
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  MEMBERSHIP_FIXTURES: '1', MEMBERSHIP_FIXTURE_KEY: FIXTURE_KEY,
});

const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));

async function call(pathname, { method = 'GET', headers = {} } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { method, headers, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, setCookie: r.headers.get('set-cookie') };
}

const base64url = (v) => Buffer.from(v, 'utf8').toString('base64url');
const sign = (payload) => {
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `gaia_member_session=${body}.${sig}`;
};
const decode = (setCookie) => {
  const token = String(setCookie || '').split(';')[0].split('=').slice(1).join('=');
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
};
const member = { contactId: 'real-1', email: 'real@example.test' };

let fixtureCookie = '';
test.before(async () => {
  const res = await call('/api/dev/fixture-session?fixture=fixture-gold-annual', {
    method: 'POST', headers: { 'x-gaia-fixture-key': FIXTURE_KEY },
  });
  fixtureCookie = res.setCookie.split(';')[0];
});
test.after(() => closeServer());

const rowsOf = (json, type) => (json.entitlements || []).filter((e) => e.type === type);

test('a course the player carries is stamped with its manifest id, and keeps a portal fallback', async () => {
  const res = await call('/api/member/access?fixture=fixture-gold-annual', { headers: { cookie: fixtureCookie } });
  assert.equal(res.status, 200);
  const [course] = rowsOf(res.json, 'course_access');
  assert.equal(course.value.name, 'Gold Course 1');
  assert.equal(course.value.academyCourseId, 'acad-gold-1');
  assert.equal(course.value.academyLessons, 2);
  assert.match(course.value.openUrl, /^https:\/\//, 'portal fallback rides along');
});

test('a course the player lists with no lessons is not sent into an empty player', async () => {
  const res = await call('/api/member/access?fixture=fixture-silver-monthly', { headers: { cookie: fixtureCookie } });
  const first = rowsOf(res.json, 'course_access').find((e) => e.value.name === 'Silver Course 1');
  assert.ok(first, 'fixture still holds Silver Course 1');
  assert.equal(first.value.academyCourseId, undefined);
  assert.match(first.value.openUrl, /^https:\/\//, 'still has somewhere to go');
});

test('every course and community row carries an openUrl', async () => {
  const res = await call('/api/member/access?fixture=fixture-silver-monthly', { headers: { cookie: fixtureCookie } });
  const rows = [...rowsOf(res.json, 'course_access'), ...rowsOf(res.json, 'community_access')];
  assert.ok(rows.length > 0);
  for (const row of rows) assert.match(row.value.openUrl || '', /^https:\/\//, `${row.value.name} has no openUrl`);
});

test('a confirmed community deep link is used verbatim', async () => {
  const res = await call('/api/member/access?fixture=fixture-free', { headers: { cookie: fixtureCookie } });
  const [community] = rowsOf(res.json, 'community_access');
  assert.equal(community.value.openUrl, 'https://www.lightworkersapp.com/spaces/13553216');
  assert.equal(community.value.openUrlIsFallback, false);
});

test('a session more than a day old is re-issued with a fresh full TTL on the profile read', async () => {
  const iat = Date.now() - 2 * DAY;
  const res = await call('/api/member/profile', { headers: { cookie: sign({ member, iat, exp: iat + TTL_SECONDS * 1000 }) } });
  assert.equal(res.status, 200);
  assert.ok(res.setCookie, 'cookie re-issued');
  assert.match(res.setCookie, /HttpOnly/);
  assert.match(res.setCookie, /Max-Age=12095\d\d|Max-Age=1209600/, 'Max-Age is a fresh 14 days');
  const renewed = decode(res.setCookie);
  assert.equal(renewed.iat, iat, 'original sign-in time is kept');
  assert.ok(renewed.renewedAt > iat);
  assert.ok(Math.abs(renewed.exp - (Date.now() + TTL_SECONDS * 1000)) < 5000);
  assert.deepEqual(renewed.member, member, 'identity is carried over untouched');
});

test('a session renewed today is not re-issued again', async () => {
  const iat = Date.now() - 5 * DAY;
  const renewedAt = Date.now() - 60 * 1000;
  const res = await call('/api/member/profile', { headers: { cookie: sign({ member, iat, renewedAt, exp: renewedAt + TTL_SECONDS * 1000 }) } });
  assert.equal(res.status, 200);
  assert.equal(res.setCookie, null);
});

test('a fresh session is not re-issued', async () => {
  const iat = Date.now();
  const res = await call('/api/member/profile', { headers: { cookie: sign({ member, iat, exp: iat + TTL_SECONDS * 1000 }) } });
  assert.equal(res.status, 200);
  assert.equal(res.setCookie, null);
});

test('renewal stops at the absolute cap from the original sign-in', async () => {
  const iat = Date.now() - 91 * DAY;
  const res = await call('/api/member/profile', { headers: { cookie: sign({ member, iat, renewedAt: Date.now() - 3 * DAY, exp: Date.now() + 11 * DAY }) } });
  assert.equal(res.status, 200);
  assert.equal(res.setCookie, null);
});

test('a fixture session is never renewed', async () => {
  const res = await call('/api/member/profile', { headers: { cookie: fixtureCookie } });
  assert.equal(res.status, 200);
  assert.equal(res.setCookie, null);
});

test('an expired session is still refused, renewal or not', async () => {
  const iat = Date.now() - 20 * DAY;
  const res = await call('/api/member/profile', { headers: { cookie: sign({ member, iat, exp: iat + TTL_SECONDS * 1000 }) } });
  assert.equal(res.status, 401);
  assert.equal(res.setCookie, null);
});
