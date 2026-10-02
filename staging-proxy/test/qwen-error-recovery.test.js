/**
 * QWEN VOICE — an upstream error is provisional until the turn proves it fatal.
 *
 * Any `error` event used to hand the member straight over to Gemini, which
 * swaps the voice mid-call and replays the transcript. Measured against the
 * live endpoint, most errors do not end the turn:
 *
 *   error "Conversation already has an active response"
 *     -> response.created, ..., response.done     a complete, correct answer
 *   error "Invalid value: 'totally.invalid.event'"
 *     -> response.created, ..., response.done     likewise
 *   error "Unknown function call id"
 *     -> error "Cannot create response without input"   genuinely dead
 *
 * So handing over on the first two threw away a healthy session, and the real
 * failure -- the InternalError.Algo.ModelServingError seen on the majority of
 * sessions during one bad hour on 2 Oct 2026 -- got no second chance at all.
 *
 * Both are fixed by waiting: an error is recorded, and only if the turn
 * produces nothing is it re-requested, once. The invariant that makes the retry
 * safe is that nothing of the response has reached the member yet -- no audio,
 * no transcript, no tool call -- so it cannot repeat anything they heard. Each
 * of those is pinned below, because the cost of getting it wrong is a member
 * hearing the same sentence twice.
 *
 * The relay is driven whole here: a real HTTP server with the relay attached, a
 * real browser-side socket, and a fake Qwen that can be told how to misbehave.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

/** A stand-in for Qwen that replays a scripted reaction to response.create. */
function fakeQwen(script) {
  const wss = new WebSocketServer({ port: 0 });
  const seen = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      seen.push(m.type);
      if (m.type === 'session.update') {
        ws.send(JSON.stringify({ type: 'session.created' }));
        ws.send(JSON.stringify({ type: 'session.updated' }));
        return;
      }
      if (m.type === 'response.create') {
        const n = seen.filter((t) => t === 'response.create').length;
        for (const evt of script(n)) {
          setTimeout(() => { try { ws.send(JSON.stringify(evt)); } catch { /* closed */ } }, evt._after || 0);
        }
      }
    });
  });
  return { wss, port: wss.address().port, seen,
           creates: () => seen.filter((t) => t === 'response.create').length,
           close: () => wss.close() };
}

const say = (text) => [
  { type: 'response.created' },
  { type: 'response.audio_transcript.delta', delta: text + ' ' },
  { type: 'response.done', response: { usage: {} } },
];
const errorEvt = (message) => ({ type: 'error', error: { message } });

/**
 * Runs one session against a fake upstream and returns what the browser saw.
 * `turns` are the browser messages to send, in order.
 */
async function session(script, { turns = [{ realtimeInput: { text: 'How has he been?' } }], waitMs = 6000 } = {}) {
  const qwen = fakeQwen(script);
  const prev = process.env.QWEN_BASE_URL;
  process.env.QWEN_BASE_URL = `http://127.0.0.1:${qwen.port}`;
  // A fresh import per session, so the module reads the base URL we just set.
  const relay = await import(`../qwen-voice-relay.js?t=${Date.now()}_${Math.random()}`);

  const server = http.createServer();
  relay.attachQwenVoiceRelay(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ticket = relay.issueQwenTicket({ instructions: 'You are Gaia.', ip: '127.0.0.1', tools: [] });

  const got = { handover: null, transcript: '', setupComplete: false, requests: 0 };
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/assist/voice/qwen?ticket=${ticket}`);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.setupComplete) got.setupComplete = true;
    if (m.gaiaHandover) got.handover = m.gaiaHandover.reason;
    if (m.gaiaTiming?.stage === 'model_request') got.requests += 1;
    const t = m.serverContent?.outputTranscription?.text;
    if (t) got.transcript += t;
  });

  ws.send(JSON.stringify({ setup: { } }));
  await new Promise((r) => setTimeout(r, 300));
  for (const turn of turns) {
    ws.send(JSON.stringify(turn));
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, waitMs));

  const creates = qwen.creates();
  try { ws.close(); } catch { /* done */ }
  await new Promise((r) => server.close(r));
  qwen.close();
  if (prev === undefined) delete process.env.QWEN_BASE_URL; else process.env.QWEN_BASE_URL = prev;
  return { ...got, creates };
}

// ── the two shapes that were throwing away a healthy session ─────────────

test('an error the turn recovers from does not hand the member over', async () => {
  const out = await session((n) => (n === 1
    ? [errorEvt('Conversation already has an active response'), ...say('He is doing well.')]
    : []), { waitMs: 4000 });
  assert.equal(out.handover, null, 'the session answered; handing over would change the voice for nothing');
  assert.match(out.transcript, /doing well/, 'and the answer still reached the member');
  assert.equal(out.creates, 1, 'a turn that answered must not be asked for twice');
});

test('an invalid-event error is likewise not fatal', async () => {
  const out = await session((n) => (n === 1
    ? [errorEvt("Invalid value: 'totally.invalid.event'."), ...say('His stress is down.')]
    : []), { waitMs: 4000 });
  assert.equal(out.handover, null);
  assert.match(out.transcript, /stress is down/);
  assert.equal(out.creates, 1);
});

// ── the retry, and the invariant that makes it safe ──────────────────────

test('a turn that errors and then produces nothing is asked for once more', async () => {
  // This is the ModelServingError case: the error is the whole turn.
  const out = await session((n) => (n === 1
    ? [errorEvt('<50002> InternalError.Algo.ModelServingError')]
    : say('He is improving.')), { waitMs: 6000 });
  assert.equal(out.creates, 2, 'the dead turn should have been re-requested exactly once');
  assert.equal(out.handover, null, 'and the retry answered, so no handover');
  assert.match(out.transcript, /improving/);
});

test('an error after the member has already heard something is NOT retried', async () => {
  // The invariant. Re-requesting here would repeat audio they have heard, so
  // this case keeps the old behaviour and hands over.
  const out = await session((n) => (n === 1
    ? [{ type: 'response.created' },
       { type: 'response.audio_transcript.delta', delta: 'His stress ' },
       { ...errorEvt('<50002> InternalError.Algo.ModelServingError'), _after: 50 }]
    : say('should not be asked for')), { waitMs: 5000 });
  assert.equal(out.creates, 1, 'a response that already spoke must never be repeated');
  assert.ok(out.handover, 'mid-speech failure is what the handover is for');
});

test('a retry that also fails ends in a handover rather than a loop', async () => {
  const out = await session(() => [errorEvt('<50002> InternalError.Algo.ModelServingError')],
    { waitMs: 9000 });
  assert.equal(out.creates, 2, 'one retry, not many');
  assert.ok(out.handover, 'and then the existing fallback takes over');
});

test('a second error while one is pending resolves immediately', async () => {
  // Their server's genuinely-dead shape: an error, then another error, no
  // response. Waiting out the full grace period would add 2.5s of silence to a
  // turn that is already finished, so a second error settles it at once.
  const started = Date.now();
  const out = await session((n) => (n === 1
    ? [errorEvt('Unknown function call id: does-not-exist'),
       { ...errorEvt('Cannot create response without input, history, or instructions'), _after: 100 }]
    : say('Recovered.')), { waitMs: 4000 });
  assert.equal(out.creates, 2, 'the turn was re-requested');
  assert.ok(Date.now() - started < 8000);
  assert.match(out.transcript, /Recovered/);
});

// ── the boundary that was already right, and must stay right ─────────────

test('an error before setup still closes the socket for the Gemini fallback', async () => {
  // Nothing has been heard yet, so there is no session worth saving and the
  // orb falls back on its own. A retry here would only delay that.
  const qwen = fakeQwen(() => []);
  const prev = process.env.QWEN_BASE_URL;
  process.env.QWEN_BASE_URL = `http://127.0.0.1:${qwen.port}`;
  const relay = await import(`../qwen-voice-relay.js?t=${Date.now()}_pre`);
  const server = http.createServer();
  relay.attachQwenVoiceRelay(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ticket = relay.issueQwenTicket({ instructions: 'x', ip: '127.0.0.1', tools: [] });

  // Answer the setup with an error instead of session.updated.
  qwen.wss.removeAllListeners('connection');
  qwen.wss.on('connection', (ws) => {
    ws.on('message', () => ws.send(JSON.stringify(errorEvt('upstream exploded'))));
  });

  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/assist/voice/qwen?ticket=${ticket}`);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const code = await new Promise((resolve) => {
    ws.on('close', (c) => resolve(c));
    ws.send(JSON.stringify({ setup: {} }));
    setTimeout(() => resolve(0), 5000);
  });
  assert.equal(code, 4502, 'the orb keys its Gemini fallback off this close code');
  try { ws.close(); } catch { /* closed */ }
  await new Promise((r) => server.close(r));
  qwen.close();
  if (prev === undefined) delete process.env.QWEN_BASE_URL; else process.env.QWEN_BASE_URL = prev;
});

test('a clean turn is never re-requested and never delayed', async () => {
  const out = await session(() => say('All good.'), { waitMs: 3000 });
  assert.equal(out.creates, 1);
  assert.equal(out.handover, null);
  assert.match(out.transcript, /All good/);
});
