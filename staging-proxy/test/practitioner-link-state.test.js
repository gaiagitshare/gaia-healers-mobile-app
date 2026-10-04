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
  assert.deepEqual(o.verifyPractitioner({ raw_ok: true, practitioner_id: '477', practitioner_name: 'Dr N', profile_status: 'pending' }), { verified: true, reason: '' });
  assert.deepEqual(o.verifyPractitioner({ raw_ok: true, practitioner_id: '', practitioner_email: 'client@example.invalid', profile_role: 'client' }), { verified: false, reason: 'no_practitioner_profile' });
  assert.deepEqual(o.verifyPractitioner({ raw_ok: true, practitioner_id: '477', profile_status: 'suspended' }), { verified: false, reason: 'account_not_active' });
  assert.deepEqual(o.verifyPractitioner({ raw_ok: true, practitioner_id: '', practitioner_email: 'x@example.invalid' }), { verified: null, reason: 'profile_unreadable' });
  assert.deepEqual(o.verifyPractitioner({ raw_ok: false }), { verified: null, reason: 'profile_unreadable' });
  assert.deepEqual(o.verifyPractitioner(null), { verified: null, reason: 'profile_unreadable' });
});

test('linkState: the five states, from what is stored, and connectionStatus is derived from it', () => {
  const file = tmp();
  assert.deepEqual(o.linkState('c1', file), { state: 'not_connected' });
  assert.equal(o.connectionStatus('c1', file).connected, false);
  const future = Date.now() + 3600e3;
  o.saveToken('c1', { access_token: 't', refresh_token: 'r', expires_at: future, connected_at: '2026-10-04T20:00:00Z', practitioner_id: '477', practitioner_name: 'Dr N', practitioner_email: 'n@example.invalid', verified: true, verification_version: 2, verify_reason: '' }, file);
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
  // a row written before the verdict existed (before 4 Oct 2026): the
  // practitioner id from THEIR profile is the same evidence; nobody is sent
  // back through OAuth for a bookkeeping field
  o.saveToken('c6', { access_token: 't', expires_at: future, practitioner_id: '12', practitioner_name: 'Old Row' }, file);
  assert.equal(o.linkState('c6', file).state, 'connected', 'legacy rows with a practitioner id stay connected');
  o.saveToken('c7', { access_token: 't', expires_at: future, practitioner_name: 'No id, no verdict' }, file);
  assert.equal(o.linkState('c7', file).state, 'unverified');
});

test('the server: connect has no GHL gate, the callback verifies and mirrors, status and the tools use linkState', () => {
  const srv = read('staging-proxy/server.js');
  const connect = srv.slice(srv.indexOf("url.pathname === '/api/practitioners/connect'"), srv.indexOf("url.pathname === '/api/practitioners/callback'"));
  assert.doesNotMatch(connect, /not_a_practitioner|could_not_verify_role|buildMemberAccess/, 'any signed-in member may start the link; the verdict comes from Gaia Practitioners');
  const callback = srv.slice(srv.indexOf("url.pathname === '/api/practitioners/callback'"), srv.indexOf('Gaia Practitioners: a MEMBER'));
  assert.match(callback, /const verdict = verifyPractitioner\(who\);/);
  assert.match(callback, /verified: verdict\.verified,\n\s+verification_version: 2,\n\s+verify_reason: verdict\.reason,/);
  assert.match(callback, /if \(verdict\.verified === true\) \{\n\s+ghlPost\(`\/contacts\/\$\{encodeURIComponent\(member\.contactId\)\}\/tags`, \{ tags: \['gaiapractitioner'\] \}\)/, 'the GHL tag is mirrored after verification, best effort');
  assert.match(callback, /back\(verdict\.verified === true, verdict\.verified === false \? \(verdict\.reason === 'account_not_active' \? 'account_not_active' : 'not_practitioner'\) : \(verdict\.verified === null \? 'unverified' : ''\)\)/, 'an unverified or inactive account is reported as a failure, with its reason');
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
  assert.match(ui, /connected as \$\{esc\(status\.practitioner_email\)\}/, 'who you are connected as');
  assert.match(ui, /data-prac-disconnect/, 'and the way out, where the account is');
  assert.match(ui, /gaia:practitioner-state/, 'the state is announced for the avatar');
  const av = read('gaia-avatar.js');
  assert.match(av, /addEventListener\('gaia:practitioner-state'/); assert.match(av, /Your practice is connected\./);
  assert.match(av, /chips: \['practice', 'talk'\]/, 'one chip that matters, plus voice');
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


test('expired verified links with refresh tokens stay connected until renewal is refused', async () => {
  const file = tmp();
  o.saveToken('refreshable', { access_token: 'old', refresh_token: 'refresh', expires_at: Date.now() - 1000, verified: true, verification_version: 2, practitioner_id: '42' }, file);
  assert.equal(o.linkState('refreshable', file).state, 'connected');
  assert.equal(o.isLinkedPractitioner('refreshable', file), true);
  await o.validAccessToken({ base: 'https://example.invalid', clientId: 'test' }, 'refreshable', { file, fetchImpl: async () => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }), { status: 200 }) });
  assert.equal(o.tokenFor('refreshable', file).access_token, 'new');
  o.saveToken('refreshable', { ...o.tokenFor('refreshable', file), expires_at: Date.now() - 1000 }, file);
  await assert.rejects(o.validAccessToken({ base: 'https://example.invalid', clientId: 'test' }, 'refreshable', { file, fetchImpl: async () => new Response('{}', { status: 401 }) }), { code: 'needs_reconnect' });
  assert.equal(o.linkState('refreshable', file).state, 'needs_reconnect');
});

// The REAL shape, measured on staging 4 Oct 2026 with the one live link (field
// names only; values here are invented). No role, no practitionerId: the plain
// id IS the practitioner id, and status carries the partner's lifecycle.
export const REAL_PROFILE = { id: 477, name: 'Dr N Example', firstname: 'N', lastname: 'Example', email: 'n@example.invalid',
  sex: 'f', specialty: 'Bio-Well', city: 'Berlin', state: '', address: '', zipcode: '', tags: null, imageURL: '', status: 'pending' };
const mcpReply = (data) => async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } }), { status: 200 });

test('the real staging profile verifies: a numeric id is the practitioner id, status is recorded, "pending" still connects', async () => {
  const who = await o.resolveProfile({ mcpUrl: 'https://example.invalid' }, 'mock', mcpReply(REAL_PROFILE));
  assert.equal(who.practitioner_id, '477');
  assert.equal(who.practitioner_name, 'Dr N Example');
  assert.equal(who.practitioner_email, 'n@example.invalid');
  assert.equal(who.profile_status, 'pending');
  assert.equal(who.profile_role, '');
  assert.deepEqual(o.verifyPractitioner(who), { verified: true, reason: '' });
});

test('what else the profile could say: an explicit client role or an inactive status is not a practitioner; no id is no verdict', async () => {
  for (const [data, verified, reason] of [
    [{ ...REAL_PROFILE, status: 'active' }, true, ''],
    [{ ...REAL_PROFILE, status: 'suspended' }, false, 'account_not_active'],
    [{ ...REAL_PROFILE, status: 'Disabled' }, false, 'account_not_active'],
    [{ ...REAL_PROFILE, role: 'client' }, false, 'no_practitioner_profile'],
    [{ ...REAL_PROFILE, role: 'Practitioner' }, true, ''],
    [{ practitionerId: '42', name: 'x' }, true, ''],
    [{ userId: 'client-1', role: 'client' }, false, 'no_practitioner_profile'],
    [{ name: 'no id at all' }, null, 'profile_unreadable'],
    [{}, null, 'profile_unreadable'],
  ]) {
    const who = await o.resolveProfile({ mcpUrl: 'https://example.invalid' }, 'mock', mcpReply(data));
    assert.deepEqual(o.verifyPractitioner(who), { verified, reason }, JSON.stringify(data));
  }
});

test('linkState carries the partner status so the screen can mention a pending account', () => {
  const file = tmp();
  o.saveToken('p', { access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3600e3, practitioner_id: '477', verified: true, verification_version: 2, profile_status: 'pending' }, file);
  const s = o.linkState('p', file);
  assert.equal(s.state, 'connected'); assert.equal(s.profile_status, 'pending');
});

test('the screen names the inactive-account reason', () => {
  const ui = fs.readFileSync(new URL('../../gaia-practitioner.js', import.meta.url), 'utf8');
  assert.match(ui, /account_not_active: '/);
});
