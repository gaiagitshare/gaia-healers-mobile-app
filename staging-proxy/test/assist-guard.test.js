/**
 * GAIA ASSIST — the open assistant has a spending ceiling.
 *
 * Assist is open to every visitor by product decision, and every route behind
 * it is a paid call. assist-guard.js caps what one caller, and the whole site,
 * may spend per minute and per day. These pin the parts that are easy to get
 * quietly wrong: the caller is who nginx saw (not a header the caller wrote),
 * an IPv6 /64 is one caller, members get more room, the site ceiling holds
 * against many callers, and the server really answers 429.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowSpend, callerKey, spendKindFor, guardConfig, _resetGuard } from '../assist-guard.js';

const cfg = (over = {}) => ({ ...guardConfig({}), ...over });

test('the caller is X-Real-IP, never the first X-Forwarded-For entry the caller wrote', () => {
  const req = { headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }, socket: {} };
  assert.equal(callerKey(req), '203.0.113.7');
});

test('an IPv6 /64 is one caller, however many addresses it rotates through', () => {
  const a = callerKey({ headers: { 'x-real-ip': '2001:db8:aa:bb:1::1' }, socket: {} });
  const b = callerKey({ headers: { 'x-real-ip': '2001:db8:aa:bb:ffff:eeee:dddd:cccc' }, socket: {} });
  const c = callerKey({ headers: { 'x-real-ip': '2001:db8:aa:bc::1' }, socket: {} });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('a caller is stopped after the per-minute burst, and told when to retry', () => {
  _resetGuard();
  const c = cfg({ chat: { perMinute: 3, perDay: 100, globalPerDay: 1000 } });
  const now = Date.now();
  for (let i = 0; i < 3; i++) assert.equal(allowSpend({ kind: 'chat', caller: 'a', cfg: c, now }).ok, true);
  const v = allowSpend({ kind: 'chat', caller: 'a', cfg: c, now });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'caller_minute');
  assert.ok(v.retryAfter >= 1 && v.retryAfter <= 60);
  assert.equal(allowSpend({ kind: 'chat', caller: 'a', cfg: c, now: now + 61_000 }).ok, true, 'the burst window slides');
});

test('members get more room than anonymous visitors', () => {
  _resetGuard();
  const c = cfg({ voice: { perMinute: 100, perDay: 2, globalPerDay: 1000 }, memberFactor: 4 });
  assert.equal(allowSpend({ kind: 'voice', caller: 'anon', cfg: c }).ok, true);
  assert.equal(allowSpend({ kind: 'voice', caller: 'anon', cfg: c }).ok, true);
  assert.equal(allowSpend({ kind: 'voice', caller: 'anon', cfg: c }).reason, 'caller_day');
  for (let i = 0; i < 8; i++) assert.equal(allowSpend({ kind: 'voice', caller: 'm', member: true, cfg: c }).ok, true);
  assert.equal(allowSpend({ kind: 'voice', caller: 'm', member: true, cfg: c }).ok, false);
});

test('the site ceiling holds against many callers', () => {
  _resetGuard();
  const c = cfg({ stt: { perMinute: 100, perDay: 100, globalPerDay: 5 } });
  for (let i = 0; i < 5; i++) assert.equal(allowSpend({ kind: 'stt', caller: `ip${i}`, cfg: c }).ok, true);
  assert.equal(allowSpend({ kind: 'stt', caller: 'fresh-address', cfg: c }).reason, 'site_day');
});

test('speech is budgeted in characters, not requests', () => {
  _resetGuard();
  const c = cfg({ tts: { perMinute: 100, perDay: 5000, globalPerDay: 100000 } });
  assert.equal(allowSpend({ kind: 'tts', caller: 'a', units: 2500, cfg: c }).ok, true);
  assert.equal(allowSpend({ kind: 'tts', caller: 'a', units: 2500, cfg: c }).ok, true);
  assert.equal(allowSpend({ kind: 'tts', caller: 'a', units: 1, cfg: c }).reason, 'caller_day');
});

test('every paid assist route has a kind; member-only routes do not', () => {
  for (const p of ['/api/assist/chat', '/api/assist/chat/stream', '/api/assist/voice', '/api/assist/voice/token', '/api/assist/transcribe', '/api/assist/voice/turn', '/api/assist/tts', '/api/assist/lookup', '/api/assist/voices']) {
    assert.ok(spendKindFor('POST', p), `${p} has no spend limit`);
  }
  assert.equal(spendKindFor('POST', '/api/assist/memory'), null);
});

// ── the server really answers 429 ───────────────────────────────────────────
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-guard-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);
const PORT = 8947;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  AUTH_SESSION_SECRET: 'guard-secret-'.padEnd(48, 'g'),
  COURSES_SYNC_SECRET: 'guard-sync-'.padEnd(48, 's'),
  GHL_BACKFILL_SECRET: 'guard-backfill-'.padEnd(48, 'b'),
  GHL_WORKFLOW_WEBHOOK_SECRET: 'guard-webhook-'.padEnd(48, 'w'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9',
  GAIA_ASSIST_VOICE_ENABLED: 'false',          // canned replies: no provider is called
  ASSIST_LIMIT_CHAT_PER_MINUTE: '2',
  ASSIST_LIMIT_TTS_PER_DAY: '100',
});

test('the server answers 429 with Retry-After once a caller is over the limit, whatever X-Forwarded-For says', async () => {
  _resetGuard();
  const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
  await new Promise((r) => setTimeout(r, 300));
  try {
    const ask = (xff) => fetch(`http://127.0.0.1:${PORT}/api/assist/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.9', 'x-forwarded-for': xff },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    assert.equal((await ask('10.0.0.1')).status, 200);
    assert.equal((await ask('10.0.0.2')).status, 200);
    const third = await ask('10.0.0.3');
    assert.equal(third.status, 429, 'a new X-Forwarded-For must not buy a new allowance');
    assert.ok(Number(third.headers.get('retry-after')) >= 1);

    const speak = (text) => fetch(`http://127.0.0.1:${PORT}/api/assist/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.10' },
      body: JSON.stringify({ text }),
    });
    await speak('x'.repeat(90));
    assert.equal((await speak('x'.repeat(20))).status, 429, 'the character budget applies to speech');
  } finally {
    await closeServer();
  }
});
