import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';
const COMPAT_TTS_MODEL = process.env.OPENAI_COMPATIBLE_TTS_MODEL || OPENAI_TTS_MODEL;
const COMPAT_TTS_VOICE = process.env.OPENAI_COMPATIBLE_TTS_VOICE || OPENAI_TTS_VOICE;
const ASSIST_PROVIDER_ORDER = (process.env.ASSIST_PROVIDER_ORDER || 'groq,openrouter,openai')
  .split(',')
  .map((provider) => provider.trim().toLowerCase())
  .filter(Boolean);
const TTS_PROVIDER_ORDER = (process.env.TTS_PROVIDER_ORDER || 'openai,elevenlabs,compatible')
  .split(',')
  .map((provider) => provider.trim().toLowerCase())
  .filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const STATIC_GAIA = {
  members: 1233,
  portalUrl: 'https://education.gaiahealers.com',
  event: {
    id: 'elevate-2026',
    name: 'Gaia Healers Elevate 2026',
    date: 'Nov 20-22, 2026',
    venue: 'Rosen Shingle Creek',
    location: 'Orlando, FL',
    source: 'staging-proxy',
    stats: {
      attendees: 0,
      paidMembers: 0,
      checkedIn: 0,
      exhibitors: 0,
      leads: 0,
      checkInRate: 0,
    },
  },
};

function corsHeaders(origin) {
  const allowed = !origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? (origin || '*') : 'null',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Vary': 'Origin',
  };
}

function sendJson(res, status, data, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(origin),
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendBuffer(res, status, buffer, contentType, origin) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    ...corsHeaders(origin),
  });
  res.end(buffer);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function publicTtsOrder() {
  return [...new Set([...TTS_PROVIDER_ORDER, 'browser'])];
}

function hasAnyBackendTtsProvider() {
  return Boolean(
    process.env.OPENAI_API_KEY
    || (process.env.ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID)
    || (process.env.OPENAI_COMPATIBLE_TTS_API_KEY && process.env.OPENAI_COMPATIBLE_TTS_BASE_URL)
  );
}

function safeOpenAiVoice(value, fallback) {
  const voice = String(value || '').trim().toLowerCase();
  const allowed = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']);
  return allowed.has(voice) ? voice : fallback;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error('Request body is too large');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function getEventSummary() {
  const base = (process.env.EVENT_MANAGER_BASE_URL || '').replace(/\/+$/, '');
  const eventId = process.env.EVENT_MANAGER_EVENT_ID || '';
  if (!base || !eventId) return STATIC_GAIA.event;

  const headers = {};
  if (process.env.EVENT_MANAGER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EVENT_MANAGER_TOKEN}`;
  }

  const event = await fetchJson(`${base}/public/events/${encodeURIComponent(eventId)}`, headers);
  return {
    id: `event-${event.id || eventId}`,
    name: event.name || STATIC_GAIA.event.name,
    date: event.start_date && event.end_date ? `${event.start_date} - ${event.end_date}` : STATIC_GAIA.event.date,
    venue: event.location || STATIC_GAIA.event.venue,
    location: event.location || STATIC_GAIA.event.location,
    source: 'event-manager',
    stats: {
      attendees: event.attendee_count || 0,
      paidMembers: 0,
      checkedIn: event.checked_in_count || 0,
      exhibitors: 0,
      leads: 0,
      checkInRate: event.attendee_count ? Math.round(((event.checked_in_count || 0) / event.attendee_count) * 100) : 0,
    },
  };
}

async function getGhlSummary() {
  const base = (process.env.GHL_API_BASE_URL || '').replace(/\/+$/, '');
  const token = process.env.GHL_API_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!base || !token || !locationId) {
    return { configured: false };
  }

  return {
    configured: true,
    locationId,
    apiBaseUrl: base,
    note: 'GHL credentials are configured backend-side. Add normalized reads here after staging auth is approved.',
  };
}

async function bootstrap() {
  const [event, ghl] = await Promise.all([
    getEventSummary().catch((error) => ({ ...STATIC_GAIA.event, source: 'event-manager-error', error: error.message })),
    getGhlSummary().catch((error) => ({ configured: false, error: error.message })),
  ]);

  return {
    ok: true,
    gaia: {
      ...STATIC_GAIA,
      event,
      sync: {
        generatedAt: new Date().toISOString(),
        ghl,
        voice: {
          configured: Boolean(process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY),
          enabled: process.env.GAIA_ASSIST_VOICE_ENABLED === 'true',
          providerOrder: ASSIST_PROVIDER_ORDER,
          tts: {
            configured: hasAnyBackendTtsProvider(),
            providerOrder: publicTtsOrder(),
            openaiModel: OPENAI_TTS_MODEL,
            openaiVoice: OPENAI_TTS_VOICE,
            elevenLabsConfigured: Boolean(process.env.ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID),
          },
        },
      },
    },
  };
}

function fallbackAssistReply(prompt, intent = '') {
  const normalized = `${intent} ${prompt}`.toLowerCase();
  if (normalized.includes('badge') || normalized.includes('elevate') || normalized.includes('event')) {
    return 'I can help prepare your Elevate badge test flow. Confirm the attendee email, verify the GHL registration, then the Event Manager can show QR badge status before anything is changed.';
  }
  if (normalized.includes('scan') || normalized.includes('bio-well') || normalized.includes('biowell')) {
    return 'For the Bio-Well flow, I can summarize today\'s readiness, highlight the chakra focus, and suggest the next practitioner action without saving anything automatically.';
  }
  if (normalized.includes('course') || normalized.includes('academy') || normalized.includes('certification')) {
    return 'For Academy progress, I can point you to the next module and remind you what evidence is still needed before exam unlock.';
  }
  if (normalized.includes('ghl') || normalized.includes('follow')) {
    return 'For GHL follow-up, I can draft a message and keep it in review mode so you approve it before it is sent or saved.';
  }
  return 'Gaia Assist is connected to the staging proxy. Ask about badges, Bio-Well scans, Academy progress, or GHL follow-up and I will keep changes in review mode.';
}

function assistSystemPrompt() {
  return [
    'You are Gaia Assist for the Gaia Healers mobile app staging prototype.',
    'Help with Elevate event badges, GHL registration context, Bio-Well scans, Academy progress, and community follow-up.',
    'Never claim that you saved, imported, checked in, emailed, or changed data. Keep all actions in review/confirm mode.',
    'Keep responses concise, practical, and wellness-safe. Do not provide medical diagnosis.',
  ].join(' ');
}

function assistUserPrompt(prompt, context = {}) {
  return [
    `Prompt: ${prompt}`,
    `Intent: ${context.intent || 'general'}`,
    `Page: ${context.page || 'unknown'}`,
  ].join('\n');
}

function chatOutputText(payload) {
  return payload.choices?.[0]?.message?.content?.trim() || '';
}

function providerConfig(provider) {
  const configs = {
    groq: {
      key: process.env.GROQ_API_KEY,
      model: GROQ_MODEL,
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      headers: {},
    },
    openrouter: {
      key: process.env.OPENROUTER_API_KEY,
      model: OPENROUTER_MODEL,
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        'HTTP-Referer': process.env.APP_PUBLIC_URL || 'https://gaiagitshare.github.io/gaia-healers-mobile-app/',
        'X-Title': 'Gaia Healers Mobile App',
      },
    },
    openai: {
      key: process.env.OPENAI_API_KEY,
      model: OPENAI_MODEL,
      endpoint: 'https://api.openai.com/v1/chat/completions',
      headers: {},
    },
  };
  return configs[provider];
}

async function callChatProvider(provider, prompt, context = {}) {
  const config = providerConfig(provider);
  if (!config) {
    return { skipped: true, reason: 'unknown-provider' };
  }
  if (!config.key) {
    return { skipped: true, reason: 'missing-api-key' };
  }

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      ...config.headers,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: assistSystemPrompt() },
        { role: 'user', content: assistUserPrompt(prompt, context) },
      ],
      temperature: 0.35,
      max_tokens: 360,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`${provider} chat request failed with ${response.status}: ${details.slice(0, 280)}`);
  }

  const payload = await response.json();
  return {
    provider,
    model: config.model,
    reply: chatOutputText(payload) || fallbackAssistReply(prompt, context.intent),
  };
}

async function callAssistProviders(prompt, context = {}) {
  const attempts = [];
  if (process.env.GAIA_ASSIST_VOICE_ENABLED !== 'true') {
    return {
      provider: 'local-fallback',
      reply: fallbackAssistReply(prompt, context.intent),
      attempts: [{ provider: 'assist', status: 'disabled' }],
    };
  }

  for (const provider of ASSIST_PROVIDER_ORDER) {
    const started = Date.now();
    try {
      console.log('[Gaia Assist] provider attempt', { provider });
      const result = await callChatProvider(provider, prompt, context);
      if (result.skipped) {
        attempts.push({ provider, status: 'skipped', reason: result.reason });
        console.log('[Gaia Assist] provider skipped', { provider, reason: result.reason });
        continue;
      }
      attempts.push({ provider, status: 'ok', latencyMs: Date.now() - started, model: result.model });
      return { ...result, attempts };
    } catch (error) {
      attempts.push({
        provider,
        status: 'failed',
        latencyMs: Date.now() - started,
        error: error.message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]'),
      });
      console.error('[Gaia Assist] provider failed', { provider, error: error.message.split('\n')[0] });
    }
  }

  return {
    provider: 'local-fallback',
    reply: fallbackAssistReply(prompt, context.intent),
    warning: 'All configured assistant providers failed; showing safe local fallback.',
    attempts,
  };
}

async function assistChat(body) {
  const prompt = String(body.prompt || body.transcript || '').trim();
  if (!prompt) {
    return { ok: false, error: 'Prompt is required' };
  }

  console.log('[Gaia Assist] request received', {
    intent: body.intent || 'general',
    source: body.source || 'unknown',
    hasPrompt: true,
  });

  try {
    const result = await callAssistProviders(prompt, {
      intent: body.intent,
      page: body.page,
    });
    console.log('[Gaia Assist] proxy response ready', { provider: result.provider, model: result.model || 'none' });
    return {
      ok: true,
      reply: result.reply,
      provider: result.provider,
      model: result.model,
      attempts: result.attempts,
      warning: result.warning,
      transcript: body.transcript || prompt,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[Gaia Assist] provider chain error', error);
    return {
      ok: true,
      reply: fallbackAssistReply(prompt, body.intent),
      provider: 'local-fallback-after-error',
      warning: 'Assistant provider chain returned an error; showing safe local fallback.',
      transcript: body.transcript || prompt,
      generatedAt: new Date().toISOString(),
    };
  }
}

async function assistTts(body) {
  const text = String(body.text || '').trim();
  if (!text) {
    return { ok: false, status: 400, error: 'Text is required for TTS' };
  }
  const requestedProvider = String(body.provider || '').trim().toLowerCase();
  if (requestedProvider === 'browser') {
    return { ok: false, status: 503, error: 'Browser speech requested; use SpeechSynthesis fallback.', provider: 'browser' };
  }
  const providers = requestedProvider && requestedProvider !== 'auto'
    ? [requestedProvider]
    : TTS_PROVIDER_ORDER;
  const attempts = [];

  for (const provider of providers) {
    const started = Date.now();
    try {
      const payload = await callTtsProvider(provider, text, body);
      if (payload.skipped) {
        attempts.push({ provider, status: 'skipped', reason: payload.reason });
        console.log('[Gaia Assist] TTS provider skipped', { provider, reason: payload.reason });
        continue;
      }
      attempts.push({ provider, status: 'ok', latencyMs: Date.now() - started, model: payload.model });
      console.log('[Gaia Assist] TTS response ready', { provider, bytes: payload.audio.length });
      return { ...payload, attempts };
    } catch (error) {
      attempts.push({
        provider,
        status: 'failed',
        latencyMs: Date.now() - started,
        error: error.message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]').slice(0, 320),
      });
      console.error('[Gaia Assist] TTS provider failed', { provider, error: error.message.split('\n')[0] });
    }
  }

  return {
    ok: false,
    status: 503,
    error: 'Backend TTS providers failed or are not configured; use browser SpeechSynthesis fallback.',
    provider: 'browser',
    attempts,
  };
}

async function callTtsProvider(provider, text, body = {}) {
  const speed = clampNumber(body.speed, 0.75, 1.25, 1);
  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) return { skipped: true, reason: 'missing-api-key' };
    const voice = safeOpenAiVoice(body.voice, OPENAI_TTS_VOICE);
    console.log('[Gaia Assist] TTS provider attempt', { provider: 'openai', model: OPENAI_TTS_MODEL, voice });
    return openAiCompatibleTts({
      endpoint: 'https://api.openai.com/v1/audio/speech',
      apiKey: process.env.OPENAI_API_KEY,
      model: OPENAI_TTS_MODEL,
      voice,
      text,
      speed,
      provider: 'openai',
    });
  }

  if (provider === 'elevenlabs') {
    if (!process.env.ELEVENLABS_API_KEY) return { skipped: true, reason: 'missing-api-key' };
    const voiceId = String(body.voiceId || ELEVENLABS_VOICE_ID).trim();
    if (!voiceId) return { skipped: true, reason: 'missing-voice-id' };
    console.log('[Gaia Assist] TTS provider attempt', { provider: 'elevenlabs', model: ELEVENLABS_MODEL, voice: voiceId });
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        Accept: 'audio/mpeg',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text.slice(0, 4500),
        model_id: ELEVENLABS_MODEL,
        voice_settings: {
          stability: 0.44,
          similarity_boost: 0.74,
          style: 0.18,
          use_speaker_boost: true,
        },
      }),
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`elevenlabs TTS request failed with ${response.status}: ${details.slice(0, 280)}`);
    }
    return {
      ok: true,
      provider: 'elevenlabs',
      model: ELEVENLABS_MODEL,
      voice: voiceId,
      audio: Buffer.from(await response.arrayBuffer()),
    };
  }

  if (provider === 'compatible') {
    const base = (process.env.OPENAI_COMPATIBLE_TTS_BASE_URL || '').replace(/\/+$/, '');
    const apiKey = process.env.OPENAI_COMPATIBLE_TTS_API_KEY;
    if (!base) return { skipped: true, reason: 'missing-base-url' };
    if (!apiKey) return { skipped: true, reason: 'missing-api-key' };
    const endpoint = base.endsWith('/audio/speech') ? base : `${base}/v1/audio/speech`;
    const voice = safeOpenAiVoice(body.voice, COMPAT_TTS_VOICE);
    console.log('[Gaia Assist] TTS provider attempt', { provider: 'compatible', model: COMPAT_TTS_MODEL, voice });
    return openAiCompatibleTts({
      endpoint,
      apiKey,
      model: COMPAT_TTS_MODEL,
      voice,
      text,
      speed,
      provider: 'compatible',
    });
  }

  return { skipped: true, reason: 'unknown-provider' };
}

async function openAiCompatibleTts({ endpoint, apiKey, model, voice, text, speed, provider }) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      input: text.slice(0, 4000),
      response_format: 'mp3',
      speed,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`${provider} TTS request failed with ${response.status}: ${details.slice(0, 280)}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  return { ok: true, provider, model, voice, audio };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true }, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/app/bootstrap') {
      sendJson(res, 200, await bootstrap(), origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/chat') {
      const body = await readJsonBody(req);
      const payload = await assistChat({ ...body, source: body.source || 'chat' });
      sendJson(res, payload.ok === false ? 400 : 200, payload, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/voice') {
      const body = await readJsonBody(req);
      const transcript = String(body.transcript || body.prompt || '').trim();
      if (!transcript) {
        sendJson(res, 400, {
          ok: false,
          error: 'Voice route expects a browser transcript. Raw audio upload is not enabled in staging.',
        }, origin);
        return;
      }
      const payload = await assistChat({ ...body, prompt: transcript, transcript, source: body.source || 'voice' });
      sendJson(res, payload.ok === false ? 400 : 200, payload, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/tts') {
      const body = await readJsonBody(req);
      try {
        const payload = await assistTts(body);
        if (!payload.ok) {
          sendJson(res, payload.status || 503, payload, origin);
          return;
        }
        res.setHeader('X-Gaia-Voice-Provider', payload.provider);
        res.setHeader('X-Gaia-Voice-Model', payload.model);
        res.setHeader('X-Gaia-Voice-Name', payload.voice || '');
        sendBuffer(res, 200, payload.audio, 'audio/mpeg', origin);
      } catch (error) {
        console.error('[Gaia Assist] TTS chain failed', { error: error.message.split('\n')[0] });
        sendJson(res, 503, {
          ok: false,
          error: 'Backend TTS failed; use browser SpeechSynthesis fallback.',
          provider: 'browser',
        }, origin);
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: 'Not found' }, origin);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message }, origin);
  }
});

server.listen(PORT, () => {
  console.log(`Gaia staging proxy listening on :${PORT}`);
});
