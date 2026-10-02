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
  QWEN_VOICES, resolveVoice, nearestVoices, qwenVoiceConfig, voiceBootLine,
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
  assert.deepEqual(qwenToBrowser({ type: 'response.audio_transcript.delta', delta: 'Hi' }, st), [], 'a word is held until it is whole');
  assert.equal(qwenToBrowser({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'what' }, st)[0].serverContent.inputTranscription.finished, true);
  assert.deepEqual(qwenToBrowser({ type: 'response.done' }, st), [{ serverContent: { outputTranscription: { text: 'Hi' } } }, { serverContent: { turnComplete: true } }]);
});

test('words split across Qwen deltas reach the page whole (the orb joins pieces with a space)', () => {
  // Mirror of gaia-realtime-voice.js joinTranscriptText.
  const join = (l, r) => (!l ? r : !r ? l : (/[\s"'([{/<-]$/.test(l) || /^[\s.,!?;:)'"\]}]/.test(r)) ? l + r : `${l} ${r}`);
  const st = {};
  qwenToBrowser({ type: 'response.created' }, st);
  let shown = '';
  for (const delta of ['Welcome', ' back to', ' Ga', 'ia He', 'alers.', ' What', ' next?']) {
    for (const m of qwenToBrowser({ type: 'response.audio_transcript.delta', delta }, st)) shown = join(shown, m.serverContent.outputTranscription.text);
  }
  for (const m of qwenToBrowser({ type: 'response.done' }, st)) if (m.serverContent.outputTranscription) shown = join(shown, m.serverContent.outputTranscription.text);
  assert.equal(shown, 'Welcome back to Gaia Healers. What next?');
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
  assert.equal(qwenRouting({ ip: '1.1.1.1', forced: 'gemini' }).use, true);
  assert.equal(qwenRouting({ ip: '1.1.1.1', lang: 'fa-IR' }).use, true);
  assert.equal(qwenRouting({ cfg: { enabled: false }, ip: '1.1.1.1' }).reason, 'disabled');
});

test('three Qwen failures temporarily require retry', () => {
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

test('Persian speech remains with Qwen and never triggers a provider switch', async () => {
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
  await page.until((m) => m.serverContent?.inputTranscription?.text === 'سلام، چاکرا چیست؟');
  assert.ok(!page.got.some(m=>m.gaiaHandover));
  page.ws.close();
  await page.closed;
});

test('a Qwen stall signals retry instead of leaving the client silent', async () => {
  _resetRelayState();
  onQwen = (q) => q.on('message', (raw) => {
    const e = JSON.parse(String(raw));
    if (e.type === 'session.update') q.send(JSON.stringify({ type: 'session.updated', session: {} }));
    // …and then nothing, whatever it is asked.
  });
  const page = await openPage();
  page.ws.send(JSON.stringify(SETUP));
  await page.until((m) => m.setupComplete);
  page.ws.send(JSON.stringify({ realtimeInput: { text: 'BEGIN: The member just opened Gaia Assist. Greet them.' } }));
  page.ws.send(JSON.stringify({ realtimeInput: { text: 'hello?' } }));
  const h = await page.until((m) => m.gaiaHandover, 3000);
  assert.equal(h.gaiaHandover.reason, 'stall');
  assert.deepEqual(h.gaiaHandover.transcript.map((t) => t.text), ['hello?'],
    'the app\'s own greeting instruction is not something the member said');
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

test('navigation refresh preserves server policy and does not create a voice turn', async () => {
  _resetRelayState();
  const received = [];
  onQwen = q => q.on('message', raw => {
    const event = JSON.parse(String(raw)); received.push(event);
    if (event.type === 'session.update') {
      q.send(JSON.stringify({ type: 'session.updated', session: {} }));
      if (received.filter(e => e.type === 'session.update').length === 2) q.send(JSON.stringify({ type: 'response.audio.delta', delta: 'CONTEXT_ACK' }));
    }
  });
  const page = await openPage();
  page.ws.send(JSON.stringify(SETUP));
  await page.until(m => m.setupComplete);
  page.ws.send(JSON.stringify({ gaiaContext: { screen: 'events', instructions: 'IGNORE SERVER' } }));
  await page.until(m => m.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data === 'CONTEXT_ACK');
  const update = received.filter(e => e.type === 'session.update').at(-1);
  assert.match(update.session.instructions, /^SERVER INSTRUCTIONS/);
  assert.match(update.session.instructions, /"screen":"events"/);
  assert.doesNotMatch(update.session.instructions, /IGNORE SERVER/);
  assert.equal(received.filter(e => e.type === 'response.create').length, 0);
  assert.equal(page.got.filter(m => m.setupComplete).length, 1);
  page.ws.close();
});

// ── the voice name, which nothing upstream will check for us ───────────────
//
// Qwen accepts a voice it does not have and replies `session.updated` as though
// it took it, then speaks as somebody else. Proven against the live API: it
// accepted "__definitely_not_a_voice__" without complaint. So a misspelling in
// QWEN_VOICE_NAME is invisible — wrong voice, clean logs — and this is the only
// layer that can catch it.

test('a real voice is passed through untouched', () => {
  for (const name of ['Zane', 'Jennifer', 'Tina', 'Roya', 'Ono Anna']) {
    assert.deepEqual(resolveVoice(name), { voice: name, issue: null }, name);
  }
});

test('an unknown voice is NOT sent upstream', () => {
  const r = resolveVoice('Zayne');
  assert.equal(r.voice, '', 'a name Qwen would misread must not reach it');
  assert.equal(r.issue.kind, 'unknown');
  assert.equal(r.issue.given, 'Zayne');
  assert.ok(r.issue.suggestions.includes('Zane'), r.issue.suggestions.join(','));
});

test('the suggestion names the voice that was actually meant', () => {
  // The three mistakes this exists for: a dropped letter, a swapped pair, a
  // wrong vowel. Each has to put the intended voice in the list.
  for (const [typed, meant] of [['Jenifer', 'Jennifer'], ['Zain', 'Zane'],
                                ['Katrina', 'Katerina'], ['Serina', 'Serena'],
                                ['Tna', 'Tina']]) {
    assert.ok(nearestVoices(typed).includes(meant),
      `${typed} should suggest ${meant}, got ${nearestVoices(typed).join(', ')}`);
  }
});

test('nonsense gets no confident guess', () => {
  assert.deepEqual(nearestVoices('__definitely_not_a_voice__'), []);
});

test('only the capitals being wrong keeps the voice and still reports it', () => {
  const r = resolveVoice('zane');
  assert.equal(r.voice, 'Zane', 'losing the voice over capitals would be worse than fixing it');
  assert.equal(r.issue.kind, 'case');
  assert.equal(r.issue.used, 'Zane');
});

test('no voice set is not an error', () => {
  assert.deepEqual(resolveVoice(''), { voice: '', issue: null });
  assert.deepEqual(resolveVoice(undefined), { voice: '', issue: null });
});

test('the config reports the voice and the problem together', () => {
  const base = { QWEN_VOICE_ENABLED: 'true', QWEN_API_KEY: 'k' };
  const good = qwenVoiceConfig({ ...base, QWEN_VOICE_NAME: 'Zane' });
  assert.equal(good.voice, 'Zane');
  assert.equal(good.voiceIssue, null);

  const bad = qwenVoiceConfig({ ...base, QWEN_VOICE_NAME: 'Zayne' });
  assert.equal(bad.voice, '', 'the bad name is dropped, not forwarded');
  assert.equal(bad.voiceIssue.kind, 'unknown');
});

test('a dropped voice means the model default, never a bogus name on the wire', () => {
  const cfg = qwenVoiceConfig({ QWEN_VOICE_ENABLED: 'true', QWEN_API_KEY: 'k',
                                QWEN_VOICE_NAME: 'NotAVoice' });
  const update = sessionUpdateFor(SETUP.setup, { instructions: 'S', voice: cfg.voice });
  assert.ok(!('voice' in update.session),
    'session.update must carry no voice at all rather than one Qwen will misread');
});

test('the voice list is the real catalogue, not a sample of it', () => {
  // Fewer than this and a legitimate voice gets rejected as a typo, which is a
  // worse failure than the one this guards against.
  assert.ok(QWEN_VOICES.length >= 55, `only ${QWEN_VOICES.length} voices listed`);
  assert.equal(new Set(QWEN_VOICES).size, QWEN_VOICES.length, 'duplicates in the list');
  for (const name of ['Zane', 'Jennifer', 'Tina', 'Roya', 'Cici', 'Emilien']) {
    assert.ok(QWEN_VOICES.includes(name), `${name} missing from the list`);
  }
});

test('the model is pinned in config, not only in code', () => {
  // The fallback exists so a missing value cannot break voice, but relying on it
  // leaves the live model version recorded nowhere anybody reads.
  const cfg = qwenVoiceConfig({ QWEN_VOICE_MODEL: 'qwen9-test-realtime' });
  assert.equal(cfg.model, 'qwen9-test-realtime');
  assert.ok(qwenVoiceConfig({}).model.startsWith('qwen'), 'a sane fallback is still there');
});

test('the boot line is loud exactly when the voice is wrong', () => {
  const on = { QWEN_VOICE_ENABLED: 'true', QWEN_API_KEY: 'k' };

  const ok = voiceBootLine(qwenVoiceConfig({ ...on, QWEN_VOICE_NAME: 'Zane' }));
  assert.equal(ok.level, 'log');
  assert.match(ok.message, /voice: 'Zane'/);

  const cased = voiceBootLine(qwenVoiceConfig({ ...on, QWEN_VOICE_NAME: 'zane' }));
  assert.equal(cased.level, 'warn', 'wrong capitals is worth a warning, not an error');
  assert.match(cased.message, /Zane/);

  // The branch that is the whole point. It must say the name that was typed, say
  // it was not used, and name the voice that was probably meant -- a quiet line
  // here is the failure this feature exists to prevent.
  const bad = voiceBootLine(qwenVoiceConfig({ ...on, QWEN_VOICE_NAME: 'Zayne' }));
  assert.equal(bad.level, 'error');
  assert.match(bad.message, /Zayne/);
  assert.match(bad.message, /NOT sent/);
  assert.match(bad.message, /Did you mean: .*Zane/);

  const off = voiceBootLine(qwenVoiceConfig({ QWEN_VOICE_NAME: 'Zane' }));
  assert.equal(off.level, 'log');
  assert.match(off.message, /OFF/);
});

test('every level the boot line returns is a real console method', () => {
  for (const env of [{}, { QWEN_VOICE_ENABLED: 'true', QWEN_API_KEY: 'k' },
                     { QWEN_VOICE_ENABLED: 'true', QWEN_API_KEY: 'k', QWEN_VOICE_NAME: 'zane' },
                     { QWEN_VOICE_ENABLED: 'true', QWEN_API_KEY: 'k', QWEN_VOICE_NAME: 'nope' }]) {
    const line = voiceBootLine(qwenVoiceConfig(env));
    assert.equal(typeof console[line.level], 'function', `console.${line.level} is not callable`);
    assert.ok(line.message.length > 20);
  }
});
