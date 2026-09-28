/**
 * GAIA ASSIST VOICE — Qwen Omni realtime, behind a relay that speaks Gemini.
 *
 * The voice orb (gaia-realtime-voice.js) was built on Gemini Live: one
 * WebSocket, Gemini's message shapes, a short-lived browser token. Qwen's
 * realtime API is a different protocol and has no browser tokens at all, so
 * the key can never go to the page.
 *
 * This relay sits between them. The browser keeps sending Gemini-shaped
 * messages to wss://api.gaiahealers.app/api/assist/voice/qwen; the relay holds
 * the Qwen key, translates both ways, and the orb cannot tell the difference —
 * one client code path, and everything Qwen-specific can be fixed here without
 * shipping the app.
 *
 * Gemini stays the fallback. The relay hands a conversation over (gaiaHandover)
 * when Qwen fails, stalls, nears its session limit, or hears Persian/Arabic
 * script it may not speak; the client then opens Gemini Live and carries the
 * conversation across. A circuit breaker sends everyone to Gemini for a while
 * after repeated Qwen failures.
 *
 * Why these defaults (2026-09-28 comparison, six spoken questions x2 runs, the
 * real Gaia instructions): qwen3.8-omni-flash-realtime answered as well as
 * gemini-3.8-live, ~2.3 s vs ~2.1 s to first audio, at ~1/4 of the cost per
 * turn. The older qwen3-omni-flash-realtime ignores typed turns, so it is not
 * a usable choice here.
 */
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const RELAY_PATH = '/api/assist/voice/qwen';

export function qwenVoiceConfig(env = process.env) {
  const base = String(env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com').trim().replace(/\/+$/, '');
  return {
    enabled: env.QWEN_VOICE_ENABLED === 'true' && Boolean(env.QWEN_API_KEY),
    apiKey: env.QWEN_API_KEY || '',
    wsBase: base.replace(/^http/, 'ws'),
    model: env.QWEN_VOICE_MODEL || 'qwen3.8-omni-flash-realtime',
    voice: env.QWEN_VOICE_NAME || '',
    // Qwen keeps at most 600 s of audio history per session; hand over first.
    maxSessionSeconds: Number(env.QWEN_VOICE_MAX_SECONDS || 540),
    maxSessions: Number(env.QWEN_VOICE_MAX_SESSIONS || 20),
    maxSessionsPerIp: Number(env.QWEN_VOICE_MAX_PER_IP || 3),
    stallMs: Number(env.QWEN_VOICE_STALL_MS || 12000),
    connectMs: Number(env.QWEN_VOICE_CONNECT_MS || 8000),
  };
}

// ── pure translation (unit-tested in test/qwen-voice-relay.test.js) ────────

/** Gemini functionDeclarations → Qwen/OpenAI-realtime tools. */
export function toQwenTools(setup) {
  const decls = (setup?.tools || []).flatMap((t) => t?.functionDeclarations || []);
  return decls.map((d) => ({
    type: 'function',
    name: d.name,
    description: d.description || '',
    parameters: lowerTypes(d.parameters || { type: 'object', properties: {} }),
  }));
}

function lowerTypes(schema) {
  if (Array.isArray(schema)) return schema.map(lowerTypes);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    out[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : lowerTypes(v);
  }
  return out;
}

/** The session.update that opens a Qwen session from a Gemini setup. */
export function sessionUpdateFor(setup, { instructions, voice }) {
  const session = {
    modalities: ['text', 'audio'],
    instructions,
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm24',
    // The orb already gates the mic locally and waits through short pauses;
    // this only has to notice the end of a sentence.
    turn_detection: { type: 'server_vad', silence_duration_ms: 900 },
    tools: toQwenTools(setup),
  };
  if (voice) session.voice = voice;
  return { type: 'session.update', session };
}

/** One browser (Gemini-shaped) message → the Qwen events to send upstream. */
export function browserToQwen(msg) {
  const out = [];
  const input = msg?.realtimeInput;
  if (input?.audio?.data) out.push({ type: 'input_audio_buffer.append', audio: input.audio.data });
  if (input?.text) {
    out.push({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: String(input.text) }] } });
    out.push({ type: 'response.create' });
  }
  // audioStreamEnd needs nothing: Qwen's server VAD ends the turn itself.
  const responses = msg?.toolResponse?.functionResponses;
  if (Array.isArray(responses) && responses.length) {
    for (const r of responses) {
      out.push({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: r.id, output: JSON.stringify(r.response ?? {}) } });
    }
    out.push({ type: 'response.create' });
  }
  return out;
}

/**
 * One Qwen event → the Gemini-shaped messages for the browser. `state` carries
 * what a single event cannot know (did this response call a tool?).
 */
export function qwenToBrowser(evt, state = {}) {
  switch (evt?.type) {
    case 'session.updated':
      return [{ setupComplete: {} }];
    case 'response.created':
      state.calledTool = false;
      state.pendingText = '';
      return [];
    case 'response.audio.delta':
      return [{ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: evt.delta } }] } } }];
    case 'response.audio_transcript.delta': {
      // Qwen splits words across deltas ("Ga" + "ia Healers."), and the orb
      // joins Gemini-style pieces with a space, which printed "Ga ia". Send
      // only whole words, each piece ending in whitespace; hold the fragment
      // after the last space until the rest of the word arrives.
      const text = (state.pendingText || '') + (evt.delta || '');
      const cut = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\n'));
      if (cut < 0) { state.pendingText = text; return []; }
      state.pendingText = text.slice(cut + 1);
      return [{ serverContent: { outputTranscription: { text: text.slice(0, cut + 1) } } }];
    }
    case 'conversation.item.input_audio_transcription.completed':
      return evt.transcript ? [{ serverContent: { inputTranscription: { text: evt.transcript, finished: true } } }] : [];
    case 'response.function_call_arguments.done': {
      state.calledTool = true;
      let args = {};
      try { args = JSON.parse(evt.arguments || '{}'); } catch { /* model sent junk: run with none */ }
      return [{ toolCall: { functionCalls: [{ id: evt.call_id, name: evt.name, args }] } }];
    }
    case 'response.done': {
      const tail = state.pendingText ? [{ serverContent: { outputTranscription: { text: state.pendingText } } }] : [];
      state.pendingText = '';
      // A response that only called a tool is not the end of the turn: the
      // answer comes after the tool result. Gemini sends no turnComplete then.
      return state.calledTool ? tail : [...tail, { serverContent: { turnComplete: true } }];
    }
    default:
      return [];
  }
}

/**
 * Text the APP sends as a hidden instruction (the opening greeting, the
 * panel's welcome, a handover's CONTINUE) rather than words the member said
 * or typed. Kept out of the handover transcript: Gemini was being told the
 * member had said "BEGIN: The member just opened Gaia Assist…".
 */
export function isAppInstruction(text) {
  return /^(BEGIN|CONTINUE):|^Start the live app session now\./.test(String(text || '').trim());
}

/** Speech Qwen may not answer in: hand these to Gemini. */
export function needsGeminiForLanguage(text) {
  return /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.test(String(text || ''));
}

/** Phone languages that start on Gemini rather than hand over mid-sentence. */
export function prefersGemini(lang) {
  return /^(fa|ar|ur|ps|ku|ckb)\b/i.test(String(lang || ''));
}

// ── routing state: tickets, capacity, circuit breaker ────────────────────

const tickets = new Map();          // ticket -> { instructions, ip, exp }
const live = new Map();             // ip -> open sessions
let openSessions = 0;
const failures = [];                // timestamps of upstream failures
let breakerOpenUntil = 0;

function recordFailure(now = Date.now()) {
  failures.push(now);
  while (failures.length && now - failures[0] > 5 * 60 * 1000) failures.shift();
  if (failures.length >= 3) {
    breakerOpenUntil = now + 10 * 60 * 1000;
    failures.length = 0;
    console.warn('[Gaia Assist] qwen voice breaker OPEN — Gemini for 10 minutes');
  }
}

export function _resetRelayState() {
  tickets.clear(); live.clear(); openSessions = 0; failures.length = 0; breakerOpenUntil = 0;
}
export function _recordFailureForTest(now) { recordFailure(now); }

/**
 * Should this token request get Qwen? Returns a reason when it should not, so
 * the log says why a member was sent to Gemini.
 */
export function qwenRouting({ cfg = qwenVoiceConfig(), ip = '', lang = '', forced = '' } = {}) {
  if (forced === 'gemini') return { use: false, reason: 'forced_gemini' };
  if (!cfg.enabled) return { use: false, reason: 'disabled' };
  if (forced !== 'qwen' && prefersGemini(lang)) return { use: false, reason: 'language' };
  if (Date.now() < breakerOpenUntil) return { use: false, reason: 'breaker_open' };
  if (openSessions >= cfg.maxSessions) return { use: false, reason: 'capacity' };
  if ((live.get(ip) || 0) >= cfg.maxSessionsPerIp) return { use: false, reason: 'ip_capacity' };
  return { use: true };
}

/** A one-use, one-minute ticket that lets the browser open the relay. */
export function issueQwenTicket({ instructions, ip }) {
  const ticket = crypto.randomBytes(18).toString('base64url');
  const now = Date.now();
  for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k);
  tickets.set(ticket, { instructions: String(instructions || ''), ip, exp: now + 60 * 1000 });
  return ticket;
}

// ── the relay ─────────────────────────────────────────────────────────────

export function attachQwenVoiceRelay(server, { clientIp = (req) => req.socket.remoteAddress || '' } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://relay'); } catch { socket.destroy(); return; }
    if (url.pathname !== RELAY_PATH) return;          // not ours; others may handle it
    const ticket = url.searchParams.get('ticket') || '';
    const grant = tickets.get(ticket);
    tickets.delete(ticket);
    if (!grant || grant.exp < Date.now()) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => runSession(ws, grant, clientIp(req)));
  });
  return wss;
}

function runSession(browser, grant, ip) {
  const cfg = qwenVoiceConfig();
  const startedAt = Date.now();
  const state = { calledTool: false };
  const transcript = [];               // [{ role, text }] for a handover
  let assistantLine = '';
  let upstream = null;
  let setupDone = false;
  let closed = false;
  let stallTimer = null;
  let firstAudioAt = 0;
  let turns = 0;
  const usage = { input: 0, output: 0 };

  openSessions += 1;
  live.set(ip, (live.get(ip) || 0) + 1);

  const toBrowser = (m) => { if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(m)); };
  const toQwen = (m) => { if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(m)); };

  const finish = (why) => {
    if (closed) return;
    closed = true;
    clearTimeout(stallTimer); clearTimeout(sessionTimer); clearTimeout(connectTimer); clearInterval(keepAlive);
    openSessions = Math.max(0, openSessions - 1);
    const n = (live.get(ip) || 1) - 1;
    if (n > 0) live.set(ip, n); else live.delete(ip);
    try { upstream?.close(); } catch { /* already gone */ }
    try { browser.close(1000, why); } catch { /* already gone */ }
    console.log('[Gaia Assist] qwen voice session ended', {
      why, turns, seconds: Math.round((Date.now() - startedAt) / 1000),
      firstAudioMs: firstAudioAt || null, inputTokens: usage.input, outputTokens: usage.output,
    });
  };

  // Hand the conversation to Gemini: the client reconnects there and carries
  // the transcript across, so the member hears one pause, not a restart.
  const handover = (reason) => {
    if (closed) return;
    console.warn('[Gaia Assist] qwen voice handover to gemini', { reason, turns });
    toBrowser({ gaiaHandover: { reason, transcript: transcript.slice(-12) } });
    finish('handover:' + reason);
  };

  const failEarly = (reason) => {
    recordFailure();
    // Before setup the client has not heard anything yet: a close is enough,
    // and it falls back to Gemini on its own.
    if (!setupDone) {
      console.warn('[Gaia Assist] qwen voice failed before setup', { reason });
      try { browser.close(4502, 'qwen_unavailable'); } catch { /* gone */ }
      finish('failed:' + reason);
    } else {
      handover(reason);
    }
  };

  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => failEarly('stall'), cfg.stallMs);
  };
  const disarmStall = () => { clearTimeout(stallTimer); stallTimer = null; };

  const sessionTimer = setTimeout(() => handover('session_limit'), cfg.maxSessionSeconds * 1000);
  // nginx drops a proxied socket after 300 s without traffic, and a member
  // who is thinking sends none (the orb gates silence) while Qwen waits too.
  const keepAlive = setInterval(() => { try { browser.ping(); } catch { /* closing */ } }, 25 * 1000);
  keepAlive.unref?.();
  const connectTimer = setTimeout(() => { if (!setupDone) failEarly('connect_timeout'); }, cfg.connectMs);

  upstream = new WebSocket(`${cfg.wsBase}/api-ws/v1/realtime?model=${encodeURIComponent(cfg.model)}`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  upstream.on('error', (e) => failEarly('upstream_error:' + String(e.message || e).slice(0, 80)));
  upstream.on('close', (code) => { if (!closed) failEarly('upstream_closed:' + code); });

  let pendingSetup = null;
  const sendSetup = () => {
    if (!pendingSetup || upstream.readyState !== WebSocket.OPEN) return;
    toQwen(sessionUpdateFor(pendingSetup, { instructions: grant.instructions, voice: cfg.voice }));
    pendingSetup = null;
  };
  upstream.on('open', sendSetup);

  upstream.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(String(raw)); } catch { return; }
    if (evt.type === 'error') {
      console.error('[Gaia Assist] qwen voice error', { code: evt.error?.code, message: String(evt.error?.message || '').slice(0, 160) });
      failEarly('qwen_error');
      return;
    }
    if (evt.type === 'session.updated' && !setupDone) {
      setupDone = true;
      clearTimeout(connectTimer);
    }
    if (evt.type === 'response.audio.delta' || evt.type === 'response.audio_transcript.delta' || evt.type === 'response.function_call_arguments.done') {
      disarmStall();
      if (!firstAudioAt && evt.type === 'response.audio.delta') firstAudioAt = Date.now() - startedAt;
    }
    if (evt.type === 'input_audio_buffer.speech_stopped') armStall();
    if (evt.type === 'response.audio_transcript.delta') assistantLine += evt.delta || '';
    if (evt.type === 'conversation.item.input_audio_transcription.completed') {
      transcript.push({ role: 'user', text: evt.transcript || '' });
      if (needsGeminiForLanguage(evt.transcript)) {
        // Forward what they said first, so the bubble shows it, then hand over.
        toBrowser({ serverContent: { inputTranscription: { text: evt.transcript, finished: true } } });
        handover('language');
        return;
      }
    }
    if (evt.type === 'response.done') {
      disarmStall();
      turns += 1;
      if (assistantLine.trim()) transcript.push({ role: 'assistant', text: assistantLine.trim() });
      assistantLine = '';
      const u = evt.response?.usage || {};
      usage.input += u.input_tokens || 0;
      usage.output += u.output_tokens || 0;
    }
    for (const m of qwenToBrowser(evt, state)) toBrowser(m);
  });

  browser.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.setup) {
      pendingSetup = msg.setup;
      sendSetup();
      return;
    }
    if (msg.realtimeInput?.text && !isAppInstruction(msg.realtimeInput.text)) {
      transcript.push({ role: 'user', text: String(msg.realtimeInput.text).slice(0, 400) });
    }
    const events = browserToQwen(msg);
    if (events.some((e) => e.type === 'response.create')) armStall();
    for (const e of events) toQwen(e);
  });
  browser.on('close', () => finish('client_closed'));
  browser.on('error', () => finish('client_error'));
}
