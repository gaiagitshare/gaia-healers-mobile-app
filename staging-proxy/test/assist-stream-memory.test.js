/**
 * GAIA ASSIST — the streamed chat saves what it learns, and never shows the
 * save codes.
 *
 * The text prompt has the model end a reply with <<REMEMBER: …>> or
 * <<ONBOARD …>>. The streamed route (the chat panel's first choice) showed
 * those codes in the bubble, read them aloud, and saved nothing; and even the
 * non-streamed route skipped a reply that carried only a REMEMBER code. Here a
 * fake provider streams a reply with both codes split across chunks, and the
 * member's memory file must end up holding the facts while the page sees none
 * of the markup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMarkerFilter } from '../assist-markers.js';

// ── the filter on its own ────────────────────────────────────────────────────
test('codes split across chunks never leak, ordinary text is released', () => {
  const f = createMarkerFilter();
  const pieces = ['Try Coherence Breathing tonight. <', '<REMEM', 'BER: likes breathing ;; wants Silver>', '>\n<<ONBOARD step=goals | SELECTIONS: Sleep | complete=false>>', ' Sweet dreams.'];
  const shown = pieces.map((p) => f.push(p)).join('') + f.flush();
  assert.equal(shown.includes('<<'), false);
  assert.equal(shown.includes('REMEMBER'), false);
  assert.match(shown, /Try Coherence Breathing tonight\./);
  assert.match(shown, /Sweet dreams\./);
});

test('a lone "<" that is not a code is kept; an unfinished code at the end is dropped', () => {
  const f = createMarkerFilter();
  assert.equal(f.push('3 < 5 and ') + f.push('5 > 3') + f.flush(), '3 < 5 and 5 > 3');
  const g = createMarkerFilter();
  assert.equal(g.push('Done. <<REMEMBER: cut o') + g.flush(), 'Done. ');
});

// ── the real route, with a fake provider ─────────────────────────────────────
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-stream-memory-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);
const SECRET = 'stream-memory-secret-'.padEnd(48, 'm');
const PORT = 8953;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  AUTH_SESSION_SECRET: SECRET, COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, GHL_WORKFLOW_WEBHOOK_SECRET: SECRET,
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9',
  GAIA_DISABLE_ALERT_TIMER: '1', STORE_SYNC_ENABLED: 'false',
  ALLOWED_ORIGINS: 'https://gaiahealers.app',
  GAIA_ASSIST_VOICE_ENABLED: 'true', ASSIST_PROVIDER_ORDER: 'groq', GROQ_API_KEY: 'test-groq',
});

// The provider: an OpenAI-style SSE stream, codes cut mid-token.
const realFetch = globalThis.fetch;
const CHUNKS = ['Coherence Breathing is lovely before sleep. ', 'Want me to open it? <', '<REMEMBER: wants better sleep ', ';; interested in Silver>>'];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.groq.com')) {
    const body = CHUNKS.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return realFetch(url, opts);
};

const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => closeServer());

const b64 = (v) => Buffer.from(v, 'utf8').toString('base64url');
const session = (cid) => {
  const body = b64(JSON.stringify({ member: { contactId: cid, email: `${cid}@x.test` }, iat: Date.now(), exp: Date.now() + 3600_000 }));
  return `gaia_member_session=${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};

async function ask(cookie) {
  const r = await realFetch(`http://127.0.0.1:${PORT}/api/assist/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://gaiahealers.app', 'x-real-ip': '192.0.2.90', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ prompt: 'I cannot sleep well lately' }),
  });
  const text = await r.text();
  const events = text.split('\n\n').filter(Boolean).map((block) => {
    const ev = /event: (\w+)/.exec(block)?.[1];
    const data = /data: (.*)/.exec(block)?.[1];
    return { ev, data: data ? JSON.parse(data) : null };
  });
  return { shown: events.filter((e) => e.ev === 'delta').map((e) => e.data.text).join(''), done: events.find((e) => e.ev === 'done')?.data };
}

test('a member: the page never sees the code, and the memory is saved', async () => {
  const { shown, done } = await ask(session('contact-sleep-1'));
  assert.equal(shown.includes('<<'), false, `code leaked into the bubble: ${shown}`);
  assert.equal(shown.includes('REMEMBER'), false);
  assert.match(shown, /Coherence Breathing is lovely before sleep\. Want me to open it\?/);
  assert.equal(done.reply.includes('<<'), false, 'the final reply (read aloud) must be clean too');
  const memory = JSON.parse(fs.readFileSync(path.join(workdir, 'data', 'assist-memory.json'), 'utf8'));
  const facts = JSON.stringify(memory.byContact['contact-sleep-1'] || {});
  assert.match(facts, /wants better sleep/);
  assert.match(facts, /interested in Silver/);
});

test('a visitor: the code is still hidden, and nothing is saved for anyone', async () => {
  const before = fs.existsSync(path.join(workdir, 'data', 'assist-memory.json'))
    ? Object.keys(JSON.parse(fs.readFileSync(path.join(workdir, 'data', 'assist-memory.json'), 'utf8')).byContact).length : 0;
  const { shown, done } = await ask(null);
  assert.equal(shown.includes('<<'), false);
  assert.equal(done.reply.includes('<<'), false);
  const after = Object.keys(JSON.parse(fs.readFileSync(path.join(workdir, 'data', 'assist-memory.json'), 'utf8')).byContact).length;
  assert.equal(after, before);
});
