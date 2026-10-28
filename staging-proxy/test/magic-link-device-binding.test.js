/**
 * Magic-link poll binding (audit S4, "magic-link poll hijack").
 *
 * The attack: submit a victim's email, keep the pollId the response returns,
 * wait for the victim to click the emailed link, and receive their session on
 * the attacker's device through the poll. The fix binds poll completion to the
 * requesting browser (an HttpOnly nonce cookie) or, for a click from another
 * browser, to a short code that only the requesting screen shows.
 *
 * The emailed token is minted here with the suite's own session secret, which
 * is exactly what the proxy puts in the email; GHL is unreachable (loopback
 * port 9), so no mail is sent and no network is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SECRET = 'magic-bind-secret-'.padEnd(48, 'm');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-magic-bind-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);

const PORT = 8975;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  AUTH_ALLOW_DEBUG_LINKS: 'false',
});

const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
const base = `http://127.0.0.1:${PORT}`;

const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};
const member = (n) => ({ contactId: `synthetic-ml-${n}`, memberId: `synthetic-ml-${n}`, email: `victim-${n}@example.invalid`, displayName: 'Synthetic Member', role: 'Member' });
// What the proxy emails: a signed magic-link token naming the poll.
const emailedToken = (pollId, n) => sign({ type: 'magic-link', member: member(n), returnTo: 'https://gaiahealers.app/home.html', pollId, iat: Date.now(), exp: Date.now() + 900_000 });

const cookiePair = (setCookie, name) => {
  const hit = String(setCookie || '').split(/,(?=\s*[A-Za-z_]+=)/).map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(';')[0] : '';
};

let ipSeq = 0;
async function requestLink(email, cookie = '') {
  const r = await fetch(`${base}/api/auth/magic-link/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++ipSeq}`, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ email }),
  });
  const json = await r.json();
  return { status: r.status, json, setCookie: r.headers.get('set-cookie') || '' };
}
async function consume(token, cookie = '') {
  const r = await fetch(`${base}/api/auth/magic-link/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ token }),
  });
  return { status: r.status, json: await r.json(), setCookie: r.headers.get('set-cookie') || '' };
}
async function poll(pollId, cookie = '') {
  const r = await fetch(`${base}/api/auth/magic-link/poll?pollId=${encodeURIComponent(pollId)}`, { headers: cookie ? { cookie } : {} });
  return { json: await r.json(), setCookie: r.headers.get('set-cookie') || '' };
}
async function confirm(ticket, code) {
  const r = await fetch(`${base}/api/auth/magic-link/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket, code }),
  });
  return { status: r.status, json: await r.json() };
}
const wrongCode = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

test('the request sets an HttpOnly device nonce and returns a 6-digit code with the poll', async () => {
  const req = await requestLink('nonce-shape@example.invalid');
  assert.equal(req.status, 200);
  assert.ok(req.json.pollId);
  assert.match(req.json.confirmCode, /^\d{6}$/);
  assert.match(req.setCookie, /gaia_ml_nonce=[A-Za-z0-9_-]{32,}/);
  assert.match(req.setCookie, /HttpOnly/);
  assert.match(req.setCookie, /Secure/);
  assert.match(req.setCookie, /Path=\/api\/auth\/magic-link/);
  assert.match(req.setCookie, /Max-Age=900\b/);
  // a second request from the same browser keeps the same nonce
  const nonce = cookiePair(req.setCookie, 'gaia_ml_nonce');
  const again = await requestLink('nonce-shape@example.invalid', nonce);
  assert.equal(cookiePair(again.setCookie, 'gaia_ml_nonce'), nonce);
});

test('same device: the click completes the poll exactly as before', async () => {
  const req = await requestLink('same-device@example.invalid');
  const nonce = cookiePair(req.setCookie, 'gaia_ml_nonce');
  const click = await consume(emailedToken(req.json.pollId, 1), nonce);
  assert.equal(click.status, 200);
  assert.equal(click.json.authenticated, true);
  assert.equal(click.json.confirmRequired, undefined, 'no code step on the same browser');
  assert.ok(cookiePair(click.setCookie, 'gaia_member_session'), 'clicking browser is signed in');
  const done = await poll(req.json.pollId, nonce);
  assert.equal(done.json.authenticated, true);
  assert.ok(cookiePair(done.setCookie, 'gaia_member_session'), 'polling screen receives its own session');
  // single use
  assert.equal((await poll(req.json.pollId, nonce)).json.status, 'unknown');
});

test('attacker device: a victim clicking the link does NOT hand the attacker a session', async () => {
  // attacker requests the victim's email from their own browser and keeps the pollId
  const attacker = await requestLink('victim-2@example.invalid');
  const attackerNonce = cookiePair(attacker.setCookie, 'gaia_ml_nonce');
  // the victim clicks in their own browser (no nonce, or a different one)
  const victimOwn = await requestLink('unrelated@example.invalid');
  const victimNonce = cookiePair(victimOwn.setCookie, 'gaia_ml_nonce');
  assert.notEqual(victimNonce, attackerNonce);
  const click = await consume(emailedToken(attacker.json.pollId, 2), victimNonce);
  assert.equal(click.json.authenticated, true, 'the clicking browser is still signed in, as today');
  assert.equal(click.json.confirmRequired, true);
  // the attacker's poll is not completed
  for (let i = 0; i < 3; i += 1) {
    const p = await poll(attacker.json.pollId, attackerNonce);
    assert.equal(p.json.authenticated, false);
    assert.equal(p.json.status, 'awaiting_code');
    assert.equal(cookiePair(p.setCookie, 'gaia_member_session'), '');
  }
  // the attacker knows the code but not the ticket only the clicking browser got
  const forged = await confirm(sign({ type: 'magic-link-confirm', pollId: attacker.json.pollId, exp: Date.now() + 60_000 }).replace(/.$/, 'x'), attacker.json.confirmCode);
  assert.equal(forged.status, 400);
  assert.equal((await confirm('', attacker.json.confirmCode)).status, 400);
  // and the emailed token itself is not a ticket
  assert.equal((await confirm(emailedToken(attacker.json.pollId, 2), attacker.json.confirmCode)).status, 400);
  assert.equal((await poll(attacker.json.pollId, attackerNonce)).json.authenticated, false);
});

test('cross-device with the correct code completes the poll', async () => {
  const pwa = await requestLink('cross-device@example.invalid');
  const click = await consume(emailedToken(pwa.json.pollId, 3)); // Safari: separate cookie jar, no nonce
  assert.equal(click.json.confirmRequired, true);
  assert.ok(click.json.confirmTicket);
  assert.equal((await poll(pwa.json.pollId)).json.status, 'awaiting_code');
  const ok = await confirm(click.json.confirmTicket, pwa.json.confirmCode);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.confirmed, true);
  const done = await poll(pwa.json.pollId);
  assert.equal(done.json.authenticated, true);
  assert.ok(cookiePair(done.setCookie, 'gaia_member_session'));
  // a ticket cannot be reused once the poll is done
  assert.equal((await confirm(click.json.confirmTicket, pwa.json.confirmCode)).status, 410);
});

test('a code typed with spaces or a dash is accepted', async () => {
  const pwa = await requestLink('code-format@example.invalid');
  const click = await consume(emailedToken(pwa.json.pollId, 4));
  const c = pwa.json.confirmCode;
  const ok = await confirm(click.json.confirmTicket, ` ${c.slice(0, 3)}-${c.slice(3)} `);
  assert.equal(ok.json.confirmed, true);
});

test('a wrong code is refused, and too many wrong codes drop the poll', async () => {
  const pwa = await requestLink('wrong-code@example.invalid');
  const click = await consume(emailedToken(pwa.json.pollId, 5));
  const bad = wrongCode(pwa.json.confirmCode);
  for (let left = 4; left >= 1; left -= 1) {
    const r = await confirm(click.json.confirmTicket, bad);
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'wrong_code');
    assert.equal(r.json.attemptsLeft, left);
    assert.equal((await poll(pwa.json.pollId)).json.authenticated, false);
  }
  const fifth = await confirm(click.json.confirmTicket, bad);
  assert.equal(fifth.status, 429);
  assert.equal(fifth.json.code, 'too_many_attempts');
  // even the right code is now useless; the poll is gone
  assert.equal((await confirm(click.json.confirmTicket, pwa.json.confirmCode)).status, 410);
  assert.equal((await poll(pwa.json.pollId)).json.status, 'unknown');
});

test('a too-short code never matches', async () => {
  const pwa = await requestLink('short-code@example.invalid');
  const click = await consume(emailedToken(pwa.json.pollId, 6));
  const r = await confirm(click.json.confirmTicket, pwa.json.confirmCode.slice(0, 5));
  assert.equal(r.status, 401);
});

test('a signed one-time token (magic-link, confirm ticket) is not accepted as a session cookie', async () => {
  const token = emailedToken('no-such-poll', 7);
  const r = await fetch(`${base}/api/auth/session`, { headers: { cookie: `gaia_member_session=${token}` } });
  const json = await r.json();
  assert.equal(json.authenticated, false);
  // while a real session-shaped token still is
  const session = sign({ sub: 'synthetic-ml-7', member: member(7), source: 'magic-link', emailVerified: true, iat: Date.now(), exp: Date.now() + 60_000 });
  const ok = await (await fetch(`${base}/api/auth/session`, { headers: { cookie: `gaia_member_session=${session}` } })).json();
  assert.equal(ok.authenticated, true);
});

test('the start page offers the code step and its script parses', async () => {
  const r = await fetch(`${base}/api/auth/magic-link/start`);
  const html = await r.text();
  assert.match(html, /id="confirm"/);
  assert.match(html, /\/api\/auth\/magic-link\/confirm/);
  assert.match(html, /Never enter a code someone sent you/);
  const script = html.slice(html.indexOf('<script'), html.indexOf('</script>')).replace(/^<script[^>]*>/, '');
  assert.doesNotThrow(() => new Function(script));
  assert.ok(script.includes('replace(/\\D/g'), 'the digit filter survives the template literal');
});

test.after(() => closeServer());
