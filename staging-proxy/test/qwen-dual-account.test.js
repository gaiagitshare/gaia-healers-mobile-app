/**
 * TWO QWEN ACCOUNTS — account 2 is tried only when account 1 refuses for a
 * PERMANENT reason, with the same setup, and the usage record says which
 * account served the session. A transient failure never reaches account 2.
 *
 * Offline: two fake upstreams on localhost, keys are fakes, nothing is paid.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';

process.env.GAIA_USAGE_LOG = '';
const REFUSAL = { code: 'AccessDenied.Unpurchased', message: 'Access to model denied.' };

function fakeAccount({ refuse = null, drop = false } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  const seen = { connections: 0, auth: [], types: [] };
  wss.on('connection', (ws, req) => {
    seen.connections += 1; seen.auth.push(req.headers.authorization || '');
    if (drop) { setTimeout(() => ws.terminate(), 30); return; }
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      seen.types.push(m.type);
      if (m.type === 'session.update') {
        ws.send(JSON.stringify({ type: 'session.created' }));
        if (refuse) { ws.send(JSON.stringify(refuse)); setTimeout(() => ws.terminate(), 50); return; }
        ws.send(JSON.stringify({ type: 'session.updated' }));
      }
      if (m.type === 'response.create') {
        ws.send(JSON.stringify({ type: 'response.created' }));
        ws.send(JSON.stringify({ type: 'response.audio_transcript.delta', delta: 'hello ' }));
        ws.send(JSON.stringify({ type: 'response.done', response: { usage: { input_tokens: 10, output_tokens: 2 } } }));
      }
    });
  });
  return { port: wss.address().port, seen, close: () => wss.close() };
}

const ENV_KEYS = ['QWEN_API_KEY', 'QWEN_BASE_URL', 'QWEN_API_KEY_2', 'QWEN_BASE_URL_2', 'GAIA_USAGE_LOG'];
async function session({ one, two, usageFile = '' }) {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.QWEN_API_KEY = 'key-one'; process.env.QWEN_BASE_URL = `http://127.0.0.1:${one.port}`;
  if (two) { process.env.QWEN_API_KEY_2 = 'key-two'; process.env.QWEN_BASE_URL_2 = `http://127.0.0.1:${two.port}`; }
  else { delete process.env.QWEN_API_KEY_2; delete process.env.QWEN_BASE_URL_2; }
  process.env.GAIA_USAGE_LOG = usageFile;
  const relay = await import(`../qwen-voice-relay.js?t=${Date.now()}_${Math.random()}`);
  const server = http.createServer();
  relay.attachQwenVoiceRelay(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ticket = relay.issueQwenTicket({ instructions: 'You are Gaia.', ip: '127.0.0.1', tools: [] });
  const got = { setupComplete: false, transcript: '', closeCode: null, closeReason: '' };
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/assist/voice/qwen?ticket=${ticket}`);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.setupComplete) got.setupComplete = true; const t = m.serverContent?.outputTranscription?.text; if (t) got.transcript += t; });
  ws.on('close', (code, reason) => { got.closeCode = code; got.closeReason = String(reason); });
  ws.send(JSON.stringify({ setup: {} }));
  await new Promise((r) => setTimeout(r, 700));
  if (got.setupComplete) { ws.send(JSON.stringify({ realtimeInput: { text: 'Hi' } })); await new Promise((r) => setTimeout(r, 400)); }
  try { ws.close(); } catch { /* done */ }
  await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => server.close(r));
  for (const k of ENV_KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  return got;
}
const records = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

test('account 1 refuses permanently -> account 2 serves the same session, and the record says account 2', async () => {
  const one = fakeAccount({ refuse: REFUSAL }); const two = fakeAccount();
  const usageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-')), 'usage.jsonl');
  const got = await session({ one, two, usageFile });
  one.close(); two.close();
  assert.equal(got.setupComplete, true, 'the member got a working session');
  assert.match(got.transcript, /hello/);
  assert.equal(one.seen.connections, 1); assert.equal(one.seen.auth[0], 'Bearer key-one');
  assert.equal(two.seen.connections, 1); assert.equal(two.seen.auth[0], 'Bearer key-two');
  assert.deepEqual(two.seen.types.slice(0, 1), ['session.update'], 'account 2 received the setup again');
  const [rec] = records(usageFile);
  assert.ok(rec, 'one usage record');
  assert.equal(rec.provider, 'qwen'); assert.equal(rec.account, 2); assert.equal(rec.outcome, 'ok'); assert.equal(rec.turns, 1);
});

test('a transient failure on account 1 (socket dropped) is NOT retried on account 2', async () => {
  const one = fakeAccount({ drop: true }); const two = fakeAccount();
  const got = await session({ one, two });
  one.close(); two.close();
  assert.equal(got.setupComplete, false);
  assert.equal(two.seen.connections, 0, 'account 2 must not be touched for a transient failure');
  assert.equal(got.closeCode, 4502);
  assert.match(got.closeReason, /^qwen_unavailable:/);
  assert.doesNotMatch(got.closeReason, /access_denied|auth/);
});

test('both accounts refuse -> one attempt each, the orb is told it is permanent, the record names account 2', async () => {
  const one = fakeAccount({ refuse: REFUSAL }); const two = fakeAccount({ refuse: REFUSAL });
  const usageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-')), 'usage.jsonl');
  const got = await session({ one, two, usageFile });
  one.close(); two.close();
  assert.equal(one.seen.connections, 1); assert.equal(two.seen.connections, 1);
  assert.equal(got.closeCode, 4502); assert.equal(got.closeReason, 'qwen_unavailable:access_denied');
  const [rec] = records(usageFile);
  assert.equal(rec.account, 2); assert.equal(rec.outcome, 'failed'); assert.equal(rec.error, 'access_denied');
});

test('with no second account configured the refusal ends the session exactly as before', async () => {
  const one = fakeAccount({ refuse: REFUSAL });
  const got = await session({ one, two: null });
  one.close();
  assert.equal(one.seen.connections, 1);
  assert.equal(got.closeCode, 4502); assert.equal(got.closeReason, 'qwen_unavailable:access_denied');
});

test('qwenVoiceAccounts: order, defaults and ws conversion', async () => {
  const { qwenVoiceAccounts, PERMANENT_ACCOUNT_FAILURES } = await import('../qwen-voice-relay.js');
  assert.deepEqual(qwenVoiceAccounts({}), []);
  assert.deepEqual(qwenVoiceAccounts({ QWEN_API_KEY: 'a' }), [{ index: 1, apiKey: 'a', wsBase: 'wss://dashscope-intl.aliyuncs.com' }]);
  const both = qwenVoiceAccounts({ QWEN_API_KEY: 'a', QWEN_BASE_URL: 'https://ws-one.example/', QWEN_API_KEY_2: 'b', QWEN_BASE_URL_2: 'https://ws-two.example' });
  assert.deepEqual(both.map((x) => [x.index, x.apiKey, x.wsBase]), [[1, 'a', 'wss://ws-one.example'], [2, 'b', 'wss://ws-two.example']]);
  assert.deepEqual([...PERMANENT_ACCOUNT_FAILURES], ['access_denied', 'auth'], 'only entitlement/key refusals switch accounts');
});

test('qwen-access-check --account 2 reads the second key and host; refuses when absent', () => {
  const TOOL = new URL('../tools/qwen-access-check.mjs', import.meta.url).pathname;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qac2-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'QWEN_API_KEY=one\nQWEN_VOICE_ENABLED=true\n');
  const missing = spawnSync(process.execPath, [TOOL, '--account', '2', '--env', envFile], { encoding: 'utf8', timeout: 15000 });
  assert.equal(missing.status, 2); assert.match(missing.stderr, /QWEN_API_KEY_2 is not set/);
  fs.writeFileSync(envFile, 'QWEN_API_KEY=one\nQWEN_API_KEY_2=two\nQWEN_BASE_URL_2=https://ws-two.example\nQWEN_VOICE_ENABLED=true\n');
  const dry = spawnSync(process.execPath, [TOOL, '--account', '2', '--dry-run', '--env', envFile], { encoding: 'utf8', timeout: 15000 });
  assert.equal(dry.status, 0, dry.stderr); assert.match(dry.stderr, /dry run: nothing sent/);
});
