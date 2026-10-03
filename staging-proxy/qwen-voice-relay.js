import './assist-guide.js';
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
 * Qwen is the only voice provider; the legacy gaiaHandover event now signals a retry. The relay hands a conversation over (gaiaHandover)
 * when Qwen fails, stalls, nears its session limit, or hears Persian/Arabic
 * session failure; the client displays retry or typed chat. A circuit breaker
 * pauses new voice sessions after repeated Qwen failures. No provider handoff.
 *
 * Why these defaults (2026-09-28 comparison, six spoken questions x2 runs, the
 * real Gaia instructions): qwen3.8-omni-flash-realtime answered as well as
 * gemini-3.8-live, ~2.3 s vs ~2.1 s to first audio, at ~1/4 of the cost per
 * turn. The older qwen3-omni-flash-realtime ignores typed turns, so it is not
 * a usable choice here.
 */
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { normalizeUsage, recordUsage, sumUsage, emptyUsage, errorCategory } from './assist-usage.js';

const RELAY_PATH = '/api/assist/voice/qwen';

/**
 * The instructions with ONE current-screen block, for this context.
 *
 * A screen change mid-session used to send the whole instruction block again
 * with a new navigation line APPENDED -- and the original line, naming the
 * screen the session started on, stayed where it was. After the first
 * navigation the model held two "current" screens, one of them stale. This
 * replaces the block in place, so it is the same size after ten navigations as
 * after one, and only the newest screen is named.
 */
export function instructionsWithNavigation(instructions, appContext) {
  const guide = globalThis.GaiaAssistGuide;
  const block = guide.navigationBlock(appContext);
  const lines = String(instructions || '').split('\n');
  const at = lines.findIndex((l) => l.startsWith(guide.NAVIGATION_HEAD));
  if (at < 0) return lines.concat(block.split('\n')).join('\n');
  const span = lines[at + 1]?.startsWith('Current screen: ') ? 2 : 1;
  lines.splice(at, span, ...block.split('\n'));
  return lines.join('\n');
}

// How long an upstream error is treated as provisional before the turn is
// re-requested. Measured against the live endpoint: a recoverable error was
// followed by response.created in well under a second, so this only has to
// outlast that.
const QWEN_ERROR_GRACE_MS = 2500;
// A bound, so a session that errors on every attempt ends rather than looping.
const QWEN_MAX_RETRIES = 3;

// Every voice qwen3.8-omni-flash-realtime accepts, from Alibaba's reference:
// https://www.alibabacloud.com/help/en/model-studio/omni-voice-list
//
// This list exists because the API does not validate the name. Sending it
// `__definitely_not_a_voice__` returns `session.updated` with that value
// accepted, and then the assistant simply speaks as somebody else -- no error,
// no warning, nothing in any log to connect the wrong voice to the typo that
// caused it. The only place that can catch a misspelling is here.
export const QWEN_VOICES = [
  'Tina', 'Cindy', 'Liora Mira', 'Raymond', 'Zane', 'Katerina', 'Ryan', 'Mia',
  'Cici', 'Theo Calm', 'Serena', 'Maia', 'Evan', 'Qiao', 'Momo', 'Wil', 'Angel',
  'Li Cassian', 'Joyner', 'Gold', 'Jennifer', 'Aiden', 'Mione', 'Sunny', 'Dylan',
  'Eric', 'Peter', 'Joseph Chen', 'Marcus', 'Li', 'Rocky', 'Kiki', 'Sohee',
  'Eli\u0161ka', 'Alek', 'Arda', 'Dolce', 'Lenn', 'Ono Anna', 'Sonrisa', 'Bodega',
  'Andre', 'Radio Gol', 'Rizky', 'Roya', 'Hana', 'Jakub', 'Griet', 'Marina',
  'Siiri', 'Ingrid', 'Sigga', 'Bea', 'Chloe', 'Emilien',
];

/** Closest known voices to what was typed, for the "did you mean" in the log. */
export function nearestVoices(name, voices = QWEN_VOICES, limit = 3) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return [];
  // Edit distance, because the mistakes this has to catch are a dropped letter
  // ("Jenifer"), a swapped pair, and a wrong vowel ("Zain" for "Zane"). Counting
  // shared characters instead ranked "Tina" level with "Zane" for "Zain", which
  // is the one suggestion that needed to be right.
  const score = (v) => {
    const cand = v.toLowerCase();
    if (cand === want) return 0;
    const prev = new Array(want.length + 1);
    for (let j = 0; j <= want.length; j += 1) prev[j] = j;
    for (let i = 1; i <= cand.length; i += 1) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= want.length; j += 1) {
        const cost = cand[i - 1] === want[j - 1] ? 0 : 1;
        const next = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + cost);
        diag = prev[j];
        prev[j] = next;
      }
    }
    // A name typed as part of a longer one is a near miss however far the
    // distance says, so it stays ahead of anything unrelated.
    return cand.startsWith(want) || want.startsWith(cand)
      ? Math.min(prev[want.length], 1)
      : prev[want.length];
  };
  return voices
    .map((v) => ({ v, s: score(v) }))
    .filter((x) => x.s <= Math.max(2, Math.ceil(want.length / 2)))
    .sort((a, b) => a.s - b.s || a.v.localeCompare(b.v))
    .slice(0, limit)
    .map((x) => x.v);
}

/**
 * The configured voice, and what is wrong with it if anything.
 *
 * An unknown name is NOT passed upstream. Sending it would buy the worst of
 * both: the wrong voice AND the appearance of a working setting. Dropping it
 * means the model uses its own documented default (Tina), which is at least a
 * known voice, and `issue` carries the reason so the caller can say so out loud.
 */
export function resolveVoice(name, voices = QWEN_VOICES) {
  const raw = String(name || '').trim();
  if (!raw) return { voice: '', issue: null };
  const exact = voices.find((v) => v === raw);
  if (exact) return { voice: exact, issue: null };
  // A name that is right but for its capitals is a typo worth fixing, not a
  // reason to lose the voice, so it is corrected and reported.
  const cased = voices.find((v) => v.toLowerCase() === raw.toLowerCase());
  if (cased) {
    return { voice: cased, issue: { kind: 'case', given: raw, used: cased } };
  }
  return { voice: '', issue: { kind: 'unknown', given: raw, suggestions: nearestVoices(raw, voices) } };
}

/**
 * The one line to log at boot about the voice, and how loudly.
 *
 * Lives here rather than inline at startup so all three branches are tested. The
 * branch that matters is `error`: it is the only notice anybody will ever get
 * that QWEN_VOICE_NAME is wrong, because Qwen itself reports nothing.
 */
export function voiceBootLine(cfg) {
  if (!cfg.enabled) {
    return { level: 'log', message: '[Gaia Assist] qwen voice OFF \u2014 Gemini Live only' };
  }
  const issue = cfg.voiceIssue;
  if (!issue) {
    return { level: 'log',
             message: `[Gaia Assist] qwen voice ON { model: '${cfg.model}', voice: '${cfg.voice || "Qwen's default (Tina)"}' }` };
  }
  if (issue.kind === 'case') {
    return { level: 'warn',
             message: `[Gaia Assist] QWEN_VOICE_NAME is "${issue.given}" but the voice is `
               + `"${issue.used}" \u2014 using it; fix the capitals in .env` };
  }
  const guess = (issue.suggestions || []).join(', ');
  return { level: 'error',
           message: `[Gaia Assist] QWEN_VOICE_NAME="${issue.given}" is not a voice this model has. `
             + 'Qwen would have accepted it silently and spoken as somebody else, so it was NOT '
             + "sent: the assistant is using Qwen's default (Tina) instead."
             + (guess ? ` Did you mean: ${guess}?` : ' No known voice is close to it.') };
}


export function qwenVoiceConfig(env = process.env) {
  const base = String(env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com').trim().replace(/\/+$/, '');
  const picked = resolveVoice(env.QWEN_VOICE_NAME);
  return {
    enabled: env.QWEN_VOICE_ENABLED === 'true' && Boolean(env.QWEN_API_KEY),
    apiKey: env.QWEN_API_KEY || '',
    wsBase: base.replace(/^http/, 'ws'),
    model: env.QWEN_VOICE_MODEL || 'qwen3.8-omni-flash-realtime',
    voice: picked.voice,
    voiceIssue: picked.issue,
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
export function sessionUpdateFor(setup, { instructions, voice, tools = null }) {
  const session = {
    modalities: ['text', 'audio'],
    instructions,
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm24',
    // The orb already gates the mic locally and waits through short pauses;
    // this only has to notice the end of a sentence.
    turn_detection: { type: 'server_vad', silence_duration_ms: 900 },
    // The server's list wins when there is one. The page used to decide what
    // the model could call, which was survivable while the tools only moved
    // somebody around their own app -- and is not, now that one of them reads a
    // client's health data. An empty server list means exactly that: no tools.
    tools: Array.isArray(tools)
      ? toQwenTools({ tools: [{ functionDeclarations: tools }] })
      : toQwenTools(setup),
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
    case 'input_audio_buffer.speech_stopped':
      return [{ gaiaTiming: { stage: 'speech_stopped' } }];
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
    console.warn('[Gaia Assist] qwen voice breaker OPEN — voice retry required');
  }
}

export function _resetRelayState() {
  tickets.clear(); live.clear(); openSessions = 0; failures.length = 0; breakerOpenUntil = 0;
}
export function _recordFailureForTest(now) { recordFailure(now); }

/**
 * Should this token request get Qwen? Returns a reason when it should not, so
 * the UI explains why Qwen needs a retry.
 */
export function qwenRouting({ cfg = qwenVoiceConfig(), ip = '', lang = '', forced = '' } = {}) {
  if (!cfg.enabled) return { use: false, reason: 'disabled' };
  if (Date.now() < breakerOpenUntil) return { use: false, reason: 'breaker_open' };
  if (openSessions >= cfg.maxSessions) return { use: false, reason: 'capacity' };
  if ((live.get(ip) || 0) >= cfg.maxSessionsPerIp) return { use: false, reason: 'ip_capacity' };
  return { use: true };
}

/** A one-use, one-minute ticket that lets the browser open the relay. */
export function issueQwenTicket({ instructions, ip, tools = null, state = null }) {
  const ticket = crypto.randomBytes(18).toString('base64url');
  const now = Date.now();
  for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k);
  tickets.set(ticket, { instructions: String(instructions || ''), ip, tools, state,
                       exp: now + 60 * 1000 });
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
  // The provider's own per-response counts, kept with the cache and audio
  // split so a session's real cost can be read back later (assist-usage.js).
  let reported = emptyUsage();
  // What the model was last told; navigation replaces its screen lines.
  let currentInstructions = grant.instructions;

  // ── an upstream error is provisional until the turn proves it fatal ─────
  //
  // Any `error` event used to hand the member straight over to Gemini, which
  // changes the voice mid-call. Measured against the live endpoint, most errors
  // do not end the turn at all: "Conversation already has an active response"
  // and an invalid event type were each followed by a complete, successful
  // response. Handing over on those throws away a session that was about to
  // answer. So an error waits to see whether the turn recovers.
  //
  // If it does not, the turn is re-requested once. The invariant that makes
  // that safe is `emittedSinceCreate`: nothing of this response has reached the
  // member yet -- no audio, no transcript, no tool call -- so asking for it
  // again cannot repeat anything they already heard. Errors also arrive with no
  // `code`, so nothing here keys off one.
  let errorTimer = null;
  let pendingError = null;
  let emittedSinceCreate = false;
  let retriedSinceCreate = false;
  let recovered = 0;
  let retried = 0;

  openSessions += 1;
  live.set(ip, (live.get(ip) || 0) + 1);

  const toBrowser = (m) => { if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(m)); };
  const toQwen = (m) => { if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(m)); };

  const finish = (why) => {
    if (closed) return;
    closed = true;
    clearTimeout(stallTimer); clearTimeout(sessionTimer); clearTimeout(connectTimer); clearInterval(keepAlive);
    clearTimeout(errorTimer);
    openSessions = Math.max(0, openSessions - 1);
    const n = (live.get(ip) || 1) - 1;
    if (n > 0) live.set(ip, n); else live.delete(ip);
    try { upstream?.close(); } catch { /* already gone */ }
    try { browser.close(1000, why); } catch { /* already gone */ }
    console.log('[Gaia Assist] qwen voice session ended', {
      why, turns, seconds: Math.round((Date.now() - startedAt) / 1000),
      firstAudioMs: firstAudioAt || null, inputTokens: usage.input, outputTokens: usage.output,
      cachedInputTokens: reported.cachedInput, audioInputTokens: reported.audioIn,
    });
    // Every session that reached the upstream is accounted for, including one
    // that failed before setup: a refused session may still bill, and knowing
    // how many fail -- and why, by category -- is the point. `why` is one of
    // ours; the provider's message is never stored.
    const outcome = why.startsWith('failed:') ? 'failed' : (turns > 0 ? 'ok' : 'ended');
    const error = outcome === 'ok' ? null : errorCategory(why.replace(/^(failed|handover):/, ''));
    recordUsage({ channel: 'voice', provider: 'qwen', model: cfg.model, state: grant.state,
      turns, seconds: Math.round((Date.now() - startedAt) / 1000), usage: reported, outcome, error });
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
    // Before setup the client has not heard anything yet: a close is enough.
    // (There is no Gemini fallback any more -- the orb accepts only Qwen and
    // shows "Qwen voice is unavailable" after one silent retry.)
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

  const clearPendingError = (why) => {
    if (!pendingError) return;
    clearTimeout(errorTimer);
    errorTimer = null;
    recovered += 1;
    console.warn('[Gaia Assist] qwen voice error recovered', { reason: pendingError, by: why, recovered });
    pendingError = null;
  };

  /**
   * The turn produced nothing after an error. Ask for it once more if nothing
   * of this response has reached the member; otherwise hand over as before.
   */
  const resolvePendingError = () => {
    errorTimer = null;
    const reason = pendingError || 'qwen_error';
    pendingError = null;
    if (emittedSinceCreate || retriedSinceCreate || retried >= QWEN_MAX_RETRIES) {
      failEarly(reason);
      return;
    }
    retriedSinceCreate = true;
    retried += 1;
    console.warn('[Gaia Assist] qwen voice retrying the turn', { reason, retried });
    toQwen({ type: 'response.create' });
    armStall();                 // a retry that also goes quiet must still end
  };

  const noteError = (reason) => {
    if (!setupDone) { failEarly(reason); return; }        // nothing heard yet
    if (emittedSinceCreate) { failEarly(reason); return; } // mid-speech: cannot repeat
    if (pendingError) { clearTimeout(errorTimer); resolvePendingError(); return; }
    pendingError = reason;
    errorTimer = setTimeout(resolvePendingError, QWEN_ERROR_GRACE_MS);
  };

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
    toQwen(sessionUpdateFor(pendingSetup, { instructions: grant.instructions, voice: cfg.voice,
                                            tools: grant.tools }));
    pendingSetup = null;
  };
  upstream.on('open', sendSetup);

  upstream.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(String(raw)); } catch { return; }
    if (evt.type === 'error') {
      const detail = String(evt.error?.message || '').slice(0, 160);
      console.error('[Gaia Assist] qwen voice error', { code: evt.error?.code, message: detail });
      // Provisional: the turn may still answer. noteError decides.
      noteError('qwen_error:' + (evt.error?.code || detail.slice(0, 40) || 'unknown'));
      return;
    }
    if (evt.type === 'session.updated' && setupDone) return;
    if (evt.type === 'session.updated' && !setupDone) {
      setupDone = true;
      clearTimeout(connectTimer);
    }
    if (evt.type === 'response.created') {
      // A response starting IS the recovery: the error before it was noise.
      emittedSinceCreate = false;
      clearPendingError('response.created');
      toBrowser({ gaiaTiming: { stage: 'model_request' } });
    }
    if (evt.type === 'response.audio.delta' || evt.type === 'response.audio_transcript.delta' || evt.type === 'response.function_call_arguments.done') {
      emittedSinceCreate = true;
      clearPendingError(evt.type);
      disarmStall();
      if (!firstAudioAt && evt.type === 'response.audio.delta') firstAudioAt = Date.now() - startedAt;
    }
    if (evt.type === 'input_audio_buffer.speech_stopped') armStall();
    if (evt.type === 'response.audio_transcript.delta') assistantLine += evt.delta || '';
    if (evt.type === 'conversation.item.input_audio_transcription.completed') {
      transcript.push({ role: 'user', text: evt.transcript || '' });

    }
    if (evt.type === 'response.done') {
      clearPendingError('response.done');
      disarmStall();
      turns += 1;
      if (assistantLine.trim()) transcript.push({ role: 'assistant', text: assistantLine.trim() });
      assistantLine = '';
      const u = evt.response?.usage || {};
      usage.input += u.input_tokens || 0;
      usage.output += u.output_tokens || 0;
      if (evt.response?.usage) reported = sumUsage(reported, normalizeUsage('qwen', evt.response.usage));
    }
    for (const m of qwenToBrowser(evt, state)) toBrowser(m);
  });

  browser.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.gaiaContext && setupDone) {
      // Replace the screen lines in place; send nothing if nothing changed.
      const next = instructionsWithNavigation(currentInstructions, msg.gaiaContext);
      if (next !== currentInstructions) {
        currentInstructions = next;
        toQwen({ type: 'session.update', session: { instructions: next } });
      }
      return;
    }
    if (msg.setup) {
      pendingSetup = msg.setup;
      sendSetup();
      return;
    }
    if (msg.realtimeInput?.text && !isAppInstruction(msg.realtimeInput.text)) {
      transcript.push({ role: 'user', text: String(msg.realtimeInput.text).slice(0, 400) });
    }
    const events = browserToQwen(msg);
    if (events.some((e) => e.type === 'response.create')) {
      // Whatever the last response emitted is behind us; this one has sent
      // nothing yet, so it is retryable again.
      emittedSinceCreate = false;
      retriedSinceCreate = false;
      armStall();
    }
    for (const e of events) toQwen(e);
  });
  browser.on('close', () => finish('client_closed'));
  browser.on('error', () => finish('client_error'));
}
