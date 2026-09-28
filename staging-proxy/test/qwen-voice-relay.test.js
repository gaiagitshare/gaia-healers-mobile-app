/**
 * GAIA ASSIST VOICE — the Qwen relay must be indistinguishable from Gemini
 * Live to the orb, and must give a conversation to Gemini whenever Qwen can't
 * carry it.
 *
 * The orb (gaia-realtime-voice.js) speaks Gemini Live's messages. The relay
 * translates them to Qwen's realtime API and back; a wrong shape in either
 * direction is a silent orb, not an error anyone sees. So every translation is
 * pinned here, and the relay itself runs against a fake Qwen server: the
 * ticket gate, setup, audio, a tool call, the Persian handover, a Qwen that
 * never answers, and the breaker that sends everyone to Gemini after repeated
 * failures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const fakeQwen = new WebSocketServer({ port: 0 });
await new Promise((r) => fakeQwen.on('listening', r));
Object.assign(process.env, {
  QWEN_VOICE_ENABLED: 'true',
  QWEN_API_KEY: 'test-qwen-key',
  QWEN_BASE_URL: `http://127.0.0.1:${fakeQwen.address().port}`,
  QWEN_VOICE_STALL_MS: '600',
  QWEN_VOICE_CONNECT_MS: '1500',
});

const relay = await import('../qwen-voice-relay.js');
const {
  toQwenTools, sessionUpdateFor, browserToQwen, qwenToBrowser,
  needsGeminiForLanguage, prefersGemini, qwenRouting, issueQwenTicket,
  attachQwenVoiceRelay, _resetRelayState, _recordFailureForTest,
} = relay;

// What the fake Qwen does with each connection; set per test.
let onQwen = () => {};
const upstreamAuth = [];
fakeQwen.on('connection', (ws, req) => {
  upstreamAuth.push(req.headers.authorization);
  ws.send(JSON.stringify({ type: 'session.created', session: {} }));
  onQwen(ws);
});

const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
attachQwenVoiceRelay(server, { clientIp: () => '203.0.113.9' });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const relayBase = `ws://127.0.0.1:${server.address().port}/api/assist/voice/qwen`;
test.after(() => { server.close(); fakeQwen.close(); });

const SETUP = {
  setup: {
    model: 'models/qwen3.8-omni-flash-realtime',
    systemInstruction: { parts: [{ text: 'CLIENT-SUPPLIED INSTRUCTIONS' }] },
    tools: [{ functionDeclarations: [{ name: 'navigate', description: 'Go somewhere', parameters: { type: 'OBJECT', properties: { screen: { type: 'STRING', enum: ['today'] } }, required: ['screen'] } }] }],
  },
};

/** Open the relay as the page would; collect what it sends back. */
async function openPage() {
  const ticket = issueQwenTicket({ instructions: 'SERVER INSTRUCTIONS', ip: '203.0.113.9' });
  const ws = new WebSocket(`${relayBase}?ticket=${ticket}`);
  const got = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    got.push(m);
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const until = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (!got.some(pred)) {
      if (Date.now() > end) throw new Error('timed out; got ' + JSON.stringify(got).slice(0, 400));
      await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    }
    return got.find(pred);
  };
  return { ws, got, until, closed };
}

// ── translation ────────────────────────────────────────────────────────────

test('Gemini tool declarations become Qwen tools with JSON-schema types', () => {
  const [tool] = toQwenTools(SETUP.setup);
  assert.equal(tool.type, 'function');
  assert.equal(tool.name, 'navigate');
  assert.equal(tool.parameters.type, 'object');
  assert.equal(tool.parameters.properties.screen.type, 'string');
  assert.deepEqual(tool.parameters.required, ['screen']);
});

test('the session is opened with the SERVER instructions, pcm16 in and 24 kHz out', () => {
  const u = sessionUpdateFor(SETUP.setup, { instructions: 'SERVER', voice: '' });
  assert.equal(u.type, 'session.update');
  assert.equal(u.session.instructions, 'SERVER');
  assert.equal(u.session.input_audio_format, 'pcm16');
  assert.equal(u.session.output_audio_format, 'pcm24');
  assert.equal(u.session.turn_detection.type, 'server_vad');
  assert.ok(!('voice' in u.session), 'an unset voice must be left to Qwen (it rejects names it lacks)');
});

test('page audio, typed text and tool results reach Qwen in its own shapes', () => {
  assert.deepEqual(browserToQwen({ realtimeInput: { audio: { data: 'AAA=' } } }), [{ type: 'input_audio_buffer.append', audio: 'AAA=' }]);
  const text = browserToQwen({ realtimeInput: { text: 'hello' } });
  assert.equal(text[0].item.content[0].text, 'hello');
  assert.equal(text[1].type, 'response.create');
  assert.deepEqual(browserToQwen({ realtimeInput: { audioStreamEnd: true } }), []);
  const tool = browserToQwen({ toolResponse: { functionResponses: [{ id: 'c1', name: 'navigate', response: { result: 'Done.' } }] } });
  assert.equal(tool[0].item.type, 'function_call_output');
  assert.equal(tool[0].item.call_id, 'c1');
  assert.equal(tool[1].type, 'response.create');
});

test('Qwen audio, transcripts and turn ends come back as Gemini serverContent', () => {
  const st = {};
  assert.deepEqual(qwenToBrowser({ type: 'session.updated' }, st), [{ setupComplete: {} }]);
  qwenToBrowser({ type: 'response.created' }, st);
  const [audio] = qwenToBrowser({ type: 'response.audio.delta', delta: 'UENN' }, st);
  assert.equal(audio.serverContent.modelTurn.parts[0].inlineData.data, 'UENN');
  assert.match(audio.serverContent.modelTurn.parts[0].inlineData.mimeType, /rate=24000/);
  assert.equal(qwenToBrowser({ type: 'response.audio_transcript.delta', delta: 'Hi' }, st)[0].serverContent.outputTranscription.text, 'Hi');
  assert.equal(qwenToBrowser({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'what' }, st)[0].serverContent.inputTranscription.finished, true);
  assert.deepEqual(qwenToBrowser({ type: 'response.done' }, st), [{ serverContent: { turnComplete: true } }]);
});

test('a response that only called a tool is not the end of the turn', () => {
  const st = {};
  qwenToBrowser({ type: 'response.created' }, st);
  const [call] = qwenToBrowser({ type: 'response.function_call_arguments.done', call_id: 'c9', name: 'navigate', arguments: '{"screen":"today"}' }, st);
  assert.deepEqual(call.toolCall.functionCalls[0], { id: 'c9', name: 'navigate', args: { screen: 'today' } });
  assert.deepEqual(qwenToBrowser({ type: 'response.done' }, st), [], 'turnComplete here would reopen the mic before the answer');
});

test('Persian and Arabic speech, and Persian phones, go to Gemini', () => {
  assert.equal(needsGeminiForLanguage('سلام، چطوری؟'), true);
  assert.equal(needsGeminiForLanguage('How can I sleep better?'), false);
  assert.equal(prefersGemini('fa-IR'), true);
  assert.equal(prefersGemini('ar'), true);
  assert.equal(prefersGemini('en-US'), false);
});

// ── routing ────────────────────────────────────────────────────────────────

test('routing: Qwen when on; Gemini when forced, off, or for a Persian phone', () => {
  _resetRelayState();
  assert.equal(qwenRouting({ ip: '1.1.1.1', lang: 'en-US' }).use, true);
  assert.equal(qwenRouting({ ip: '1.1.1.1', forced: 'gemini' }).reason, 'forced_gemini');
  assert.equal(qwenRouting({ ip: '1.1.1.1', lang: 'fa-IR' }).reason, 'language');
  assert.equal(qwenRouting({ cfg: { enabled: false }, ip: '1.1.1.1' }).reason, 'disabled');
});

test('three Qwen failures in five minutes send everyone to Gemini', () => {
  _resetRelayState();
  const now = Date.now();
  _recordFailureForTest(now); _recordFailureForTest(now); _recordFailureForTest(now);
  assert.equal(qwenRouting({ ip: '1.1.1.1', lang: 'en' }).reason, 'breaker_open');
  _resetRelayState();
});

// ── the relay itself ─────────────────────────────────────────────────────────

test('the relay refuses a page without a valid ticket', async () => {
  const ws = new WebSocket(`${relayBase}?ticket=forged`);
  const err = await new Promise((r) => { ws.on('unexpected-response', (_q, res) => r(res.statusCode)); ws.on('error', () => r('error')); });
  assert.equal(err, 401);
});

test('a ticket opens the relay once', async () => {
  _resetRelayState();
  onQwen = () => {};
  const ticket = issueQwenTicket({ instructions: 'x', ip: '203.0.113.9' });
  const first = new WebSocket(`${relayBase}?ticket=${ticket}`);
  await new Promise((r) => first.on('open', r));
  const second = new WebSocket(`${relayBase}?ticket=${ticket}`);
  const status = await new Promise((r) => { second.on('unexpected-response', (_q, res) => r(res.statusCode)); second.on('error', () => r('error')); });
  assert.equal(status, 401);
  first.close();
});

test('a spoken turn: setup, audio up, answer and turn end down, key never leaves the server', async () => {
  _resetRelayState();
  const upstream = [];
  onQwen = (q) => q.on('message', (raw) => {
    const e = JSON.parse(String(raw));
    upstream.push(e);
    if (e.type === 'session.update') q.send(JSON.stringify({ type: 'session.updated', session: {} }));
    if (e.type === 'input_audio_buffer.append') {
      q.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'what is a chakra' }));
      q.send(JSON.stringify({ type: 'response.created' }));
      q.send(JSON.stringify({ type: 'response.audio_transcript.delta', delta: 'An energy centre.' }));
      q.send(JSON.stringify({ type: 'response.audio.delta', delta: 'UENN' }));
      q.send(JSON.stringify({ type: 'response.done', response: { usage: { input_tokens: 10, output_tokens: 5 } } }));
    }
  });
  const page = await openPage();
  page.ws.send(JSON.stringify(SETUP));
  await page.until((m) => m.setupComplete);
  const update = upstream.find((e) => e.type === 'session.update');
  assert.equal(update.session.instructions, 'SERVER INSTRUCTIONS', 'the page must not be able to set the instructions');
  assert.equal(update.session.tools[0].name, 'navigate');
  assert.equal(upstreamAuth.at(-1), 'Bearer test-qwen-key');

  page.ws.send(JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: 'AAAA' } } }));
  await page.until((m) => m.serverContent?.turnComplete);
  assert.ok(page.got.some((m) => m.serverContent?.inputTranscription?.text === 'what is a chakra'));
  assert.ok(page.got.some((m) => m.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data === 'UENN'));
  assert.ok(!JSON.stringify(page.got).includes('test-qwen-key'));
  page.ws.close();
});

test('Persian speech is shown, then handed to Gemini with the conversation so far', async () => {
  _resetRelayState();
  onQwen = (q) => q.on('message', (raw) => {
    const e = JSON.parse(String(raw));
    if (e.type === 'session.update') q.send(JSON.stringify({ type: 'session.updated', session: {} }));
    if (e.type === 'input_audio_buffer.append') {
      q.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'سلام، چاکرا چیست؟' }));
    }
  });
  const page = await openPage();
  page.ws.send(JSON.stringify(SETUP));
  await page.until((m) => m.setupComplete);
  page.ws.send(JSON.stringify({ realtimeInput: { audio: { data: 'AAAA' } } }));
  const h = await page.until((m) => m.gaiaHandover);
  assert.equal(h.gaiaHandover.reason, 'language');
  assert.equal(h.gaiaHandover.transcript.at(-1).text, 'سلام، چاکرا چیست؟');
  assert.ok(page.got.some((m) => m.serverContent?.inputTranscription?.text === 'سلام، چاکرا چیست؟'), 'the bubble should still show what they said');
  await page.closed;
});

test('a Qwen that never answers is handed to Gemini, not left silent', async () => {
  _resetRelayState();
  onQwen = (q) => q.on('message', (raw) => {
    const e = JSON.parse(String(raw));
    if (e.type === 'session.update') q.send(JSON.stringify({ type: 'session.updated', session: {} }));
    // …and then nothing, whatever it is asked.
  });
  const page = await openPage();
  page.ws.send(JSON.stringify(SETUP));
  await page.until((m) => m.setupComplete);
  page.ws.send(JSON.stringify({ realtimeInput: { text: 'hello?' } }));
  const h = await page.until((m) => m.gaiaHandover, 3000);
  assert.equal(h.gaiaHandover.reason, 'stall');
  assert.equal(h.gaiaHandover.transcript.at(-1).text, 'hello?');
});

test('a Qwen that fails before setup closes with 4502 so the page starts Gemini', async () => {
  _resetRelayState();
  onQwen = (q) => q.on('message', (raw) => {
    const e = JSON.parse(String(raw));
    if (e.type === 'session.update') q.send(JSON.stringify({ type: 'error', error: { code: 'AccessDenied', message: 'Access denied by API-Key restrictions.' } }));
  });
  const page = await openPage();
  page.ws.send(JSON.stringify(SETUP));
  const { code } = await page.closed;
  assert.equal(code, 4502);
  assert.ok(!page.got.some((m) => m.setupComplete));
});
