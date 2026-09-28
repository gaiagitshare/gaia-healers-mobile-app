/**
 * GAIA ASSIST — safety before selling, and no call that hangs forever.
 *
 * A wellness concierge told to push memberships must still answer "I want to
 * die" or "my chest hurts" with help, not a breathing session. The crisis
 * check runs before any model on typed and transcribed questions; the SAFETY
 * FIRST rule sits above every sales instruction in both prompts, because live
 * voice replies never pass through the server.
 *
 * And a provider that stops answering must fail within its budget, so the
 * chain moves on to the next provider instead of holding a member for five
 * minutes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { detectCrisis, crisisReply, SAFETY_FIRST } from '../assist-safety.js';
import { deadline, idleWatch } from '../provider-timeouts.js';

// ── detection ────────────────────────────────────────────────────────────────
test('self-harm is recognised, in English and Persian', () => {
  for (const t of ['I want to kill myself', "I don't want to live anymore", 'thinking about suicide', 'I keep hurting myself', 'everyone would be better off dead without me', 'دیگه نمی‌خوام زنده باشم', 'به خودکشی فکر می‌کنم', 'میخوام بمیرم']) {
    assert.equal(detectCrisis(t), 'self_harm', t);
  }
});

test('a possible medical emergency is recognised, in English and Persian', () => {
  for (const t of ['my chest hurts right now', "I can't breathe", 'I think I am having a stroke', 'she passed out', 'he took an overdose', 'درد قفسه سینه دارم', 'نمی‌تونم نفس بکشم']) {
    assert.equal(detectCrisis(t), 'emergency', t);
  }
});

test('ordinary wellness questions are not crises', () => {
  for (const t of ['my energy is low today', 'what is a chakra', 'which chakra is linked to the heart', 'I feel a bit stressed about work', 'a stroke of luck', 'breathing exercise for sleep', 'how much is Gold membership']) {
    assert.equal(detectCrisis(t), null, t);
  }
});

test('the fixed replies give real help and sell nothing', () => {
  const en = crisisReply('self_harm', 'I want to die');
  assert.match(en, /988/);
  assert.match(en, /911|emergency/);
  assert.doesNotMatch(en, /member|join|store|course|session|Bio-Well/i);
  assert.match(crisisReply('self_harm', 'میخوام بمیرم'), /۱۴۸۰/, 'Persian gets the Iranian counselling line');
  assert.match(crisisReply('emergency', 'my chest hurts'), /911/);
  assert.match(crisisReply('emergency', 'درد قفسه سینه'), /۱۱۵/);
});

// ── the server ───────────────────────────────────────────────────────────────
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-safety-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);
const PORT = 8949;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  AUTH_SESSION_SECRET: 'safety-secret-'.padEnd(48, 's'),
  COURSES_SYNC_SECRET: 'safety-sync-'.padEnd(48, 'y'),
  GHL_BACKFILL_SECRET: 'safety-backfill-'.padEnd(48, 'b'),
  GHL_WORKFLOW_WEBHOOK_SECRET: 'safety-webhook-'.padEnd(48, 'w'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9',
  GAIA_ASSIST_VOICE_ENABLED: 'true', ASSIST_PROVIDER_ORDER: 'gemini',   // must not be reached
});
const { assistSystemPrompt, buildGaiaLiveInstructions, closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => closeServer());

test('SAFETY FIRST sits above every sales instruction, in text and in voice', () => {
  for (const [name, prompt] of [['text', assistSystemPrompt('')], ['text member', assistSystemPrompt('MEMBER CONTEXT: Free member')], ['voice', buildGaiaLiveInstructions({ view: 'today' })]]) {
    const safety = prompt.indexOf(SAFETY_FIRST);
    assert.ok(safety > 0, `${name}: safety rule missing`);
    for (const sales of ['GATEKEEPER', 'HANDLE HESITATION', 'EVENTS —']) {
      const at = prompt.indexOf(sales);
      if (at >= 0) assert.ok(safety < at, `${name}: "${sales}" comes before the safety rule`);
    }
  }
});

test('a crisis in chat gets the fixed reply without asking any model', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/assist/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '192.0.2.80' },
    body: JSON.stringify({ prompt: 'honestly I just want to die' }),
  });
  const body = await r.json();
  assert.equal(body.provider, 'safety');
  assert.match(body.reply, /988/);
});

test('a crisis in the streamed chat gets the same fixed reply', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/assist/chat/stream`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '192.0.2.81' },
    body: JSON.stringify({ prompt: 'my chest hurts and my left arm is numb' }),
  });
  const text = await r.text();
  assert.match(text, /"provider":"safety"/);
  assert.match(text, /911/);
});

// ── timeouts ─────────────────────────────────────────────────────────────────
test('a provider that never answers is abandoned within its budget', async () => {
  const hang = http.createServer(() => { /* never responds */ });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  process.env.ASSIST_TIMEOUT_CATALOG_MS = '300';
  const started = Date.now();
  await assert.rejects(fetch(`http://127.0.0.1:${hang.address().port}/`, { signal: deadline('catalog') }));
  assert.ok(Date.now() - started < 2000, 'took too long to give up');
  hang.closeAllConnections(); hang.close();
});

test('a stream that goes quiet is cut off, and one that keeps talking is not', async () => {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url === '/quiet') { res.write('data: hello\n\n'); return; }        // then silence
    let n = 0; const t = setInterval(() => { res.write(`data: ${n}\n\n`); if (++n === 6) { clearInterval(t); res.end(); } }, 100);
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const read = async (p) => {
    const w = idleWatch(null, 300);
    const res = await fetch(base + p, { signal: w.signal });
    const reader = res.body.getReader();
    for (;;) { const { done } = await reader.read(); if (done) break; w.bump(); }
    w.stop();
  };
  await read('/steady');                              // 600 ms total, but never 300 ms silent
  await assert.rejects(read('/quiet'));
  s.closeAllConnections(); s.close();
});

test('a member closing the chat stops the stream', async () => {
  const parent = new AbortController();
  const w = idleWatch(parent.signal, 10_000);
  parent.abort(new Error('client closed'));
  assert.equal(w.signal.aborted, true);
});
