/**
 * Audit S3: the client IP behind every throttle must come from the connection,
 * not from headers the caller writes.
 *
 * nginx (same host, loopback) sets X-Real-IP from $remote_addr. CF-Connecting-IP
 * and the first X-Forwarded-For entry are attacker-controlled (no Cloudflare in
 * front), so rotating them must NOT buy a fresh admin-login or magic-link
 * allowance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clientIp, isLoopback } from '../client-ip.js';

// ── through the real server ─────────────────────────────────────────────────
const SECRET = 'ip-trust-secret-'.padEnd(48, 'i');
const ADMIN_PASSWORD = 'ip-trust-admin-password';
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-ip-trust-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);

const PORT = 8981;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  GAIA_ADMIN_PASSWORD: ADMIN_PASSWORD,
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  AUTH_ALLOW_DEBUG_LINKS: 'false',
});

const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));

const post = async (p, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const spoof = (i) => ({ 'cf-connecting-ip': `1.2.${i}.1`, 'x-forwarded-for': `9.8.${i}.7` });

test('rotating spoofed CF-Connecting-IP / X-Forwarded-For does not reset the admin-login throttle', async () => {
  const real = { 'x-real-ip': '203.0.113.120' };
  for (let i = 0; i < 8; i++) {
    const r = await post('/api/admin/login', { password: 'wrong' }, { ...real, ...spoof(i) });
    assert.equal(r.json.reason, 'bad_password', `attempt ${i + 1}`);
  }
  const blocked = await post('/api/admin/login', { password: 'wrong' }, { ...real, ...spoof(99) });
  assert.equal(blocked.status, 429, 'a new spoofed header bought a fresh allowance');
  // The correct password is refused too while locked out.
  const good = await post('/api/admin/login', { password: ADMIN_PASSWORD }, { ...real, ...spoof(100) });
  assert.equal(good.status, 429);
  // A genuinely different client (different X-Real-IP from nginx) is unaffected.
  const other = await post('/api/admin/login', { password: ADMIN_PASSWORD }, { 'x-real-ip': '203.0.113.121' });
  assert.equal(other.json.ok, true);
});

test('rotating spoofed headers does not reset the magic-link request throttle', async () => {
  const real = { 'x-real-ip': '203.0.113.130' };
  const email = 'ip-trust-magic@example.com';
  for (let i = 0; i < 5; i++) {
    const r = await post('/api/auth/magic-link/request', { email }, { ...real, ...spoof(i) });
    assert.notEqual(r.status, 429, `attempt ${i + 1}`);
  }
  const blocked = await post('/api/auth/magic-link/request', { email }, { ...real, ...spoof(50) });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.code, 'rate_limited');
});

test('rotating spoofed headers does not reset the join throttle', async () => {
  const real = { 'x-real-ip': '203.0.113.140' };
  const email = 'ip-trust-join@example.com';
  let last;
  for (let i = 0; i < 6; i++) last = await post('/api/auth/join', { name: 'Ip Trust', email }, { ...real, ...spoof(i) });
  assert.equal(last.status, 429);
  assert.equal(last.json.code, 'rate_limited');
});

// ── helper unit tests ───────────────────────────────────────────────────────
const req = (peer, headers = {}) => ({ headers, socket: { remoteAddress: peer } });

test('X-Real-IP from a loopback peer (nginx) is honoured', () => {
  assert.equal(clientIp(req('127.0.0.1', { 'x-real-ip': '203.0.113.7' })), '203.0.113.7');
  assert.equal(clientIp(req('::1', { 'x-real-ip': '2001:db8::5' })), '2001:db8::5');
  assert.equal(clientIp(req('::ffff:127.0.0.1', { 'x-real-ip': '203.0.113.8' })), '203.0.113.8');
});

test('X-Real-IP from a non-loopback peer is ignored; the socket address is used', () => {
  assert.equal(clientIp(req('198.51.100.4', { 'x-real-ip': '203.0.113.7' })), '198.51.100.4');
  assert.equal(clientIp(req('::ffff:198.51.100.4', { 'x-real-ip': '203.0.113.7' })), '198.51.100.4');
});

test('CF-Connecting-IP and X-Forwarded-For are never trusted', () => {
  const spoof = { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2, 203.0.113.7' };
  assert.equal(clientIp(req('127.0.0.1', { ...spoof, 'x-real-ip': '203.0.113.7' })), '203.0.113.7');
  assert.equal(clientIp(req('127.0.0.1', spoof)), '127.0.0.1');
  assert.equal(clientIp(req('198.51.100.4', spoof)), '198.51.100.4');
});

test('loopback detection is exact', () => {
  assert.ok(isLoopback('127.0.0.1'));
  assert.ok(isLoopback('127.5.6.7'));
  assert.ok(isLoopback('::1'));
  assert.ok(!isLoopback('10.0.0.1'));
  assert.ok(!isLoopback('1127.0.0.1'));
  assert.ok(!isLoopback(''));
  assert.equal(clientIp({ headers: { 'x-real-ip': '203.0.113.7' }, socket: {} }), 'unknown');
});

test.after(() => closeServer());
