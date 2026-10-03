/**
 * USAGE CAPTURE, END TO END — with every provider faked.
 *
 * Proves the numbers a provider reports reach the usage log, through the real
 * request paths: Gemini text (plain and streamed) and a Qwen voice session
 * through the real relay. Nothing leaves the machine: Gemini is a stubbed
 * fetch, Qwen is a local WebSocket server, and the test fails if any other
 * host is called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-usage-capture-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);
const LOG = path.join(workdir, 'usage.jsonl');
const SECRET = 'usage-capture-secret-'.padEnd(48, 'u');
const PORT = 8961;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  AUTH_SESSION_SECRET: SECRET, COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, GHL_WORKFLOW_WEBHOOK_SECRET: SECRET,
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9',
  GAIA_DISABLE_ALERT_TIMER: '1', STORE_SYNC_ENABLED: 'false', ALLOWED_ORIGINS: 'https://gaiahealers.app',
  GAIA_ASSIST_VOICE_ENABLED: 'true', ASSIST_PROVIDER_ORDER: 'gemini',
  GEMINI_API_KEY: 'test-gemini', GEMINI_TEXT_MODEL: 'gemini-3.6-flash',
  GAIA_USAGE_LOG: LOG,
});

// Gemini, faked. Its usage block includes THINKING tokens, which is the number
// nobody could see before this change.
const USAGE = { promptTokenCount: 4123, cachedContentTokenCount: 0, candidatesTokenCount: 87,
                thoughtsTokenCount: 412, totalTokenCount: 4622 };
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (/^(127\.|localhost$)/.test(u.hostname)) return realFetch(url, opts);
  outbound.push(u.hostname);
  if (u.hostname === 'generativelanguage.googleapis.com' && /FAIL-ME/.test(String(opts?.body || ''))) {
    return new Response('{"error":{"code":503,"message":"The model is overloaded. Echo: FAIL-ME secret-prompt-text"}}',
      { status: 503, headers: { 'content-type': 'application/json' } });
  }
  if (u.hostname === 'generativelanguage.googleapis.com' && u.pathname.endsWith(':streamGenerateContent')) {
    const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
    const body = chunk({ candidates: [{ content: { parts: [{ text: 'Breathing slowly ' }] } }] })
      + chunk({ candidates: [{ content: { parts: [{ text: 'can help.' }] } }], usageMetadata: USAGE });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  if (u.hostname === 'generativelanguage.googleapis.com' && u.pathname.endsWith(':generateContent')) {
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello.' }] } }], usageMetadata: USAGE }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`test refused an unexpected outbound call to ${u.hostname}`);
};

const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => closeServer());

const records = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const post = (p, body) => realFetch(`http://127.0.0.1:${PORT}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://gaiahealers.app', 'x-real-ip': '192.0.2.71' },
  body: JSON.stringify(body),
});

test('a streamed Gemini reply records its usage, including thinking tokens', async () => {
  const before = records().length;
  const r = await post('/api/assist/chat/stream', { prompt: 'I feel tense tonight' });
  await r.text();
  const rec = records().slice(before).find((x) => x.channel === 'text');
  assert.ok(rec, 'a usage record was written for the streamed reply');
  assert.equal(rec.provider, 'gemini');
  assert.equal(rec.model, 'gemini-3.6-flash');
  assert.equal(rec.input, 4123);
  assert.equal(rec.output, 87);
  assert.equal(rec.reasoning, 412, 'thinking tokens are billed as output and must be visible');
  assert.equal(rec.cachedInput, 0, 'and so is whether caching hit');
  assert.equal(rec.state, 'visitor');
  // gemini-3.6-flash has a dated entry in the price book, so a cost is estimated
  // from the reported counts and the entry used is named on the record.
  assert.ok(rec.estCostUsd > 0 && rec.estCostUsd < 0.01, `cost ${rec.estCostUsd}`);
  assert.match(rec.priceList, /^gemini-3\.6-flash\//);
  assert.equal(rec.outcome, 'ok');
  assert.equal(rec.usageReported, true);
});

test('a plain (non-streamed) Gemini reply records its usage too', async () => {
  const before = records().length;
  const r = await post('/api/assist/chat', { prompt: 'Hello there' });
  assert.equal(r.status, 200);
  const rec = records().slice(before).find((x) => x.channel === 'text');
  assert.ok(rec);
  assert.equal(rec.reasoning, 412);
});

test('a provider failure is recorded as a failed attempt, by category, with no body', async () => {
  const before = records().length;
  const r = await post('/api/assist/chat/stream', { prompt: 'FAIL-ME please' });
  await r.text();
  const rec = records().slice(before).find((x) => x.outcome === 'failed');
  assert.ok(rec, 'a failed attempt must be accounted for -- it may still bill');
  assert.equal(rec.provider, 'gemini');
  assert.equal(rec.error, 'server');
  assert.equal(rec.usageReported, false);
  assert.equal(rec.attempt, 1);
  assert.ok(!/overloaded|FAIL-ME|secret-prompt/.test(JSON.stringify(rec)), 'the provider body never reaches the log');
});

test('no record contains what anybody said', () => {
  const all = JSON.stringify(records());
  assert.ok(!/tense|Hello there|Breathing|can help|FAIL-ME|overloaded/.test(all));
});

test('only the faked provider was called', () => {
  assert.ok(outbound.every((h) => h === 'generativelanguage.googleapis.com'), `unexpected hosts: ${outbound}`);
});

// ── a Qwen voice session through the real relay, upstream faked ───────────

test('a voice session records the provider-reported totals, cache and audio split', async () => {
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'session.update') { ws.send(JSON.stringify({ type: 'session.created' })); ws.send(JSON.stringify({ type: 'session.updated' })); }
      if (m.type === 'response.create') {
        ws.send(JSON.stringify({ type: 'response.created' }));
        ws.send(JSON.stringify({ type: 'response.audio_transcript.delta', delta: 'Hi. ' }));
        ws.send(JSON.stringify({ type: 'response.done', response: { usage: {
          input_tokens: 6900, output_tokens: 140,
          input_token_details: { text_tokens: 6800, audio_tokens: 100, cached_tokens: 5000 },
          output_token_details: { text_tokens: 30, audio_tokens: 110 } } } }));
      }
    });
  });
  const prev = process.env.QWEN_BASE_URL;
  process.env.QWEN_BASE_URL = `http://127.0.0.1:${wss.address().port}`;
  const relay = await import(`../qwen-voice-relay.js?usage=${Date.now()}`);
  const server = http.createServer();
  relay.attachQwenVoiceRelay(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ticket = relay.issueQwenTicket({ instructions: 'You are Gaia.', ip: '127.0.0.1', tools: [], state: 'member' });
  const before = records().length;

  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/assist/voice/qwen?ticket=${ticket}`);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ setup: {} }));
  await new Promise((r) => setTimeout(r, 250));
  ws.send(JSON.stringify({ realtimeInput: { text: 'hello' } }));
  await new Promise((r) => setTimeout(r, 500));
  ws.close();
  await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => server.close(r));
  wss.close();
  if (prev === undefined) delete process.env.QWEN_BASE_URL; else process.env.QWEN_BASE_URL = prev;

  const rec = records().slice(before).find((x) => x.channel === 'voice');
  assert.ok(rec, 'a usage record was written when the session ended');
  assert.equal(rec.provider, 'qwen');
  assert.equal(rec.state, 'member', 'the session state travels on the ticket');
  assert.equal(rec.turns, 1);
  assert.deepEqual([rec.input, rec.cachedInput, rec.textIn, rec.audioIn, rec.textOut, rec.audioOut],
                   [6900, 5000, 6800, 100, 30, 110]);
  assert.ok(rec.estCostUsd > 0 && rec.estCostUsd < 0.01, `cost ${rec.estCostUsd}`);
});
