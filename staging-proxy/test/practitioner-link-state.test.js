/**
 * PRACTITIONER LINK — one state, decided by Gaia Practitioners.
 *
 * The member login stays the one login. Being a practitioner in this app is a
 * link on top of it: You > Practice > Connect, their OAuth, and at the callback
 * THEIR profile says whether the account is a practitioner. A GHL tag is a
 * mirror written afterwards, never a gate. One function (linkState) feeds
 * /status, the role the tools run with, and the screen, so they cannot
 * disagree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const o = await import('../practitioners-oauth.js');

function read(name) {
  for (const base of ['../../', '../../gaia-healers-mobile-app-1/']) {
    try { return fs.readFileSync(new URL(base + name, import.meta.url), 'utf8'); } catch { /* next */ }
  }
  throw new Error(`${name} not found beside the proxy`);
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plink-')), 'tokens.json');

test('verifyPractitioner: their profile is the verdict; an unreadable profile is no verdict', () => {
  assert.deepEqual(o.verifyPractitioner({ raw_ok: true, practitioner_id: '477', practitioner_name: 'Dr N' }), { verified: true, reason: '' });
  assert.deepEqual(o.verifyPractitioner({ raw_ok: true, practitioner_id: '', practitioner_email: 'client@example.invalid' }), { verified: false, reason: 'no_practitioner_profile' });
  assert.deepEqual(o.verifyPractitioner({ raw_ok: false }), { verified: null, reason: 'profile_unreadable' });
  assert.deepEqual(o.verifyPractitioner(null), { verified: null, reason: 'profile_unreadable' });
});

test('linkState: the five states, from what is stored, and connectionStatus is derived from it', () => {
  const file = tmp();
  assert.deepEqual(o.linkState('c1', file), { state: 'not_connected' });
  assert.equal(o.connectionStatus('c1', file).connected, false);
  const future = Date.now() + 3600e3;
  o.saveToken('c1', { access_token: 't', refresh_token: 'r', expires_at: future, connected_at: '2026-10-04T20:00:00Z', practitioner_id: '477', practitioner_name: 'Dr N', practitioner_email: 'n@example.invalid', verified: true, verify_reason: '' }, file);
  let s = o.linkState('c1', file);
  assert.equal(s.state, 'connected'); assert.equal(s.practitioner_name, 'Dr N'); assert.equal(o.isLinkedPractitioner('c1', file), true);
  assert.equal(o.connectionStatus('c1', file).connected, true);
  // signed in, but not a practitioner account
  o.saveToken('c2', { access_token: 't', expires_at: future, connected_at: 'x', practitioner_email: 'client@example.invalid', verified: false, verify_reason: 'no_practitioner_profile' }, file);
  s = o.linkState('c2', file); assert.equal(s.state, 'not_practitioner'); assert.equal(s.reason, 'no_practitioner_profile'); assert.equal(o.isLinkedPractitioner('c2', file), false);
  assert.equal(o.connectionStatus('c2', file).connected, false, 'a client account never reads as connected');
  // profile unreadable at the callback
  o.saveToken('c3', { access_token: 't', expires_at: future, connected_at: 'x', verified: null, verify_reason: 'profile_unreadable' }, file);
  assert.equal(o.linkState('c3', file).state, 'unverified'); assert.equal(o.isLinkedPractitioner('c3', file), false);
  // broken or expired
  o.saveToken('c4', { access_token: '', refresh_token: '', needs_reconnect: true, broken_at: 'y', practitioner_id: '9', verified: true }, file);
  assert.equal(o.linkState('c4', file).state, 'needs_reconnect'); assert.equal(o.connectionStatus('c4', file).needs_reconnect, true);
  o.saveToken('c5', { access_token: 't', expires_at: Date.now() - 1000, practitioner_id: '9', verified: true }, file);
  assert.equal(o.linkState('c5', file).state, 'needs_reconnect', 'expired is a reconnect, not a silent use');
  // a row written before verification existed: the practitioner id is the same evidence
  o.saveToken('c6', { access_token: 't', expires_at: future, practitioner_id: '12', practitioner_name: 'Old Row' }, file);
  assert.equal(o.linkState('c6', file).state, 'connected');
  o.saveToken('c7', { access_token: 't', expires_at: future, practitioner_name: 'No id, no verdict' }, file);
  assert.equal(o.linkState('c7', file).state, 'unverified');
});

test('the server: connect has no GHL gate, the callback verifies and mirrors, status and the tools use linkState', () => {
  const srv = read('staging-proxy/server.js');
  const connect = srv.slice(srv.indexOf("url.pathname === '/api/practitioners/connect'"), srv.indexOf("url.pathname === '/api/practitioners/callback'"));
  assert.doesNotMatch(connect, /not_a_practitioner|could_not_verify_role|buildMemberAccess/, 'any signed-in member may start the link; the verdict comes from Gaia Practitioners');
  const callback = srv.slice(srv.indexOf("url.pathname === '/api/practitioners/callback'"), srv.indexOf('Gaia Practitioners: a MEMBER'));
  assert.match(callback, /const verdict = verifyPractitioner\(who\);/);
  assert.match(callback, /verified: verdict\.verified,\n\s+verify_reason: verdict\.reason,/);
  assert.match(callback, /if \(verdict\.verified === true\) \{\n\s+ghlPost\(`\/contacts\/\$\{encodeURIComponent\(member\.contactId\)\}\/tags`, \{ tags: \['gaiapractitioner'\] \}\)/, 'the GHL tag is mirrored after verification, best effort');
  assert.match(callback, /back\(verdict\.verified !== false, verdict\.verified === false \? 'not_practitioner' : \(verdict\.verified === null \? 'unverified' : ''\)\)/);
  assert.match(srv, /\.\.\.connectionStatus\(member\.contactId\),\n\s+\.\.\.linkState\(member\.contactId\),/, '/status carries the one state');
  assert.match(srv, /let isPractitioner = isLinkedPractitioner\(member\.contactId\);/, 'the role the tools run with starts from the link');
});

test('the screen tells the four states apart and names what the last attempt brought back', () => {
  const ui = read('gaia-practitioner.js');
  for (const s of ["status.state === 'not_practitioner'", "status.state === 'unverified'", "status.state === 'needs_reconnect'", "status.state !== 'connected'"]) assert.ok(ui.includes(s), s);
  for (const r of ['access_denied', 'bad_state', 'session_changed', 'exchange_failed', 'not_practitioner', 'unverified']) assert.ok(ui.includes(`${r}:`), r);
  assert.match(ui, /practitioners'\) !== 'failed'/, 'the callback result is read from the URL');
  assert.match(ui, /data-prac-action="disconnect"/); assert.match(ui, /Connect a different account/);
  assert.match(ui, /Your Gaia login stays as it is\. This links your practitioner account to it\./, 'one login; the link sits on top');
  assert.match(ui, /function badge\(status\)/, 'the role shows on the You header once linked');
});

test('every script that calls the API asks the shared resolver first', () => {
  const urls = read('gaia-app-urls.js');
  assert.match(urls, /window\.GaiaApi = \{\n\s+base\(\) \{/);
  const dir = new URL('../../', import.meta.url);
  let dirPath = dir.pathname; if (!fs.existsSync(path.join(dirPath, 'home.html'))) dirPath = path.join(dirPath, 'gaia-healers-mobile-app-1');
  const offenders = [];
  for (const f of fs.readdirSync(dirPath)) {
    if (!f.endsWith('.js') || ['sw.js', 'gaia-live-sync.js', 'gaia-app-urls.js'].includes(f)) continue;
    const src = fs.readFileSync(path.join(dirPath, f), 'utf8');
    if (!/fetch\(/.test(src) || !/\/api\//.test(src)) continue;
    if (!src.includes('GaiaApi')) offenders.push(f);
    if (/window\.GaiaAppUrls/.test(src)) offenders.push(f + ' (GaiaAppUrls)');
  }
  assert.deepEqual(offenders, [], 'scripts resolving the API host on their own');
});
