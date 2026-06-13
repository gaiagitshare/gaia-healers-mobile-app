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
const ELEVENLABS_VOICE_NAME = process.env.ELEVENLABS_VOICE_NAME || 'Adam';
const COMPAT_TTS_MODEL = process.env.OPENAI_COMPATIBLE_TTS_MODEL || OPENAI_TTS_MODEL;
const COMPAT_TTS_VOICE = process.env.OPENAI_COMPATIBLE_TTS_VOICE || OPENAI_TTS_VOICE;
const ASSIST_PROVIDER_ORDER = (process.env.ASSIST_PROVIDER_ORDER || 'groq,openrouter,openai')
  .split(',')
  .map((provider) => provider.trim().toLowerCase())
  .filter(Boolean);
const TTS_PROVIDER_ORDER = (process.env.TTS_PROVIDER_ORDER || 'elevenlabs,openai,compatible')
  .split(',')
  .map((provider) => provider.trim().toLowerCase())
  .filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const FALLBACK_GAIA = {
  members: 1252,
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

const GAIA_KNOWLEDGE = {
  brand: 'Gaia Healers',
  publicWebsite: 'https://gaiahealers.com',
  clientPortal: 'https://education.gaiahealers.com',
  crm: {
    observedLocationId: 'WkKl1K5RuZNQ60xR48k6',
    configuredLocationId: process.env.GHL_LOCATION_ID || '',
    sections: ['Client Portal', 'Courses', 'Communities', 'Credentials', 'Gokollab Marketplace', 'Marketing', 'Automation', 'Calendars', 'Contacts'],
    clientPortalUsers: 1252,
    adminActions: ['generate magic link', 'invite to client portal', 'send login email'],
  },
  services: [
    'Bio-Well practitioner certification and advanced biofield analysis',
    'BioPulsar aura and chakra education',
    'BioTekna nervous-system and stress-mapping education',
    'Healeex onboarding and practitioner calls',
    'Quantum sound therapy and frequency-based optimization education',
    'Continuing education, CE credits, live labs, and credentials',
    'Practitioner communities, discussion boards, mentoring, and wins wall',
    'Elevate 2026 event registration, badges, check-in, exhibitors, and lead retrieval',
    'GHL follow-up workflows, newsletters, marketing segments, and client portal login',
  ],
  devices: [
    'Bio-Well 3.0 wellness and stress assessment device',
    'Bio-Well Sputnik accessory for environmental and object energy measurements',
    'Bio-Well Glove, Water Sensor, and Bio Cor support channels',
    'BioPulsar aura/chakra reporting tools',
    'BioTekna nervous-system technology',
    'HeartMath-style coherence monitor products',
    'Sacred geometry and wellness marketplace products',
  ],
  communities: [
    '[Start Here] All Gaia Healers: public, 254 members, 28 posts, channels Home, Start Here, Healers Lounge, Ask A Mentor, Wins Wall',
    'Bio-Well Practitioners: public, 381 members, 11 posts, channels Orientation, Tech Support, Case Studies, Bio Cor, Bio-Well, Glove, Sputnik, Water Sensor, Leaderboard',
    'BioPulsar Practitioners: public, 507 members, aura and chakra practitioner support',
    'Biotekna Practitioners: public, 154 members, nervous-system and device education',
    'Healeex: public, 31 members, onboarding, calls, and protocols',
    'The Abundant Healer Collective: private, 117 members, mentorship and coaching',
  ],
  courses: [
    'BIO-WELL Orientation',
    'BIO-WELL Basic Certification',
    'Bio-Well Advanced Level 1',
    'Gaia Healers Advanced Level 2',
    'BioPulsar Basic Technical & Business',
    'BioTekna live trainings',
    'Healeex Getting Started',
    '9-Week Chakra Challenge',
  ],
  event: {
    name: 'Gaia Healers Elevate 2026',
    date: 'November 20-22, 2026',
    venue: 'Rosen Shingle Creek, Orlando, FL',
    positioning: 'three-day integrative wellness conference bridging ancient healing traditions and cutting-edge science',
    operations: ['GHL registration', 'QR badges', 'check-in', 'exhibitor leads', 'attendee import', 'hotel room block', 'speaker/exhibitor/volunteer interest'],
  },
  safety: [
    'Do not diagnose or make medical claims.',
    'Never claim that data was saved, imported, checked in, emailed, or changed.',
    'For admin actions, draft and ask for confirmation first.',
    'Do not expose private GHL, OpenAI, Groq, OpenRouter, Event Manager, or ElevenLabs tokens.',
  ],
};

function gaiaKnowledgePrompt() {
  return [
    `Gaia ecosystem knowledge: ${GAIA_KNOWLEDGE.brand}. Website ${GAIA_KNOWLEDGE.publicWebsite}. Client portal ${GAIA_KNOWLEDGE.clientPortal}.`,
    `GHL/CRM: observed location ${GAIA_KNOWLEDGE.crm.observedLocationId}; configured location ${GAIA_KNOWLEDGE.crm.configuredLocationId || 'not set'}; sections ${GAIA_KNOWLEDGE.crm.sections.join(', ')}; ${GAIA_KNOWLEDGE.crm.clientPortalUsers} portal users; admin actions ${GAIA_KNOWLEDGE.crm.adminActions.join(', ')}.`,
    `Services: ${GAIA_KNOWLEDGE.services.join('; ')}.`,
    `Devices and products: ${GAIA_KNOWLEDGE.devices.join('; ')}.`,
    `Communities: ${GAIA_KNOWLEDGE.communities.join('; ')}.`,
    `Courses: ${GAIA_KNOWLEDGE.courses.join('; ')}.`,
    `Event: ${GAIA_KNOWLEDGE.event.name}, ${GAIA_KNOWLEDGE.event.date}, ${GAIA_KNOWLEDGE.event.venue}; ${GAIA_KNOWLEDGE.event.positioning}; ops ${GAIA_KNOWLEDGE.event.operations.join(', ')}.`,
    `Safety rules: ${GAIA_KNOWLEDGE.safety.join(' ')}`,
  ].join('\n');
}

function corsHeaders(origin) {
  const allowed = !origin
    || ALLOWED_ORIGINS.length === 0
    || ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? (origin || '*') : 'null',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Expose-Headers': 'X-Gaia-Voice-Provider,X-Gaia-Voice-Model,X-Gaia-Voice-Name',
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

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
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
  if (!base || !eventId) {
    return {
      ...FALLBACK_GAIA.event,
      source: 'not-connected',
      liveData: false,
      note: 'Event Manager endpoint is not configured.',
    };
  }

  const headers = {};
  if (process.env.EVENT_MANAGER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EVENT_MANAGER_TOKEN}`;
  }

  const event = await fetchJson(`${base}/public/events/${encodeURIComponent(eventId)}`, headers);
  return {
    id: `event-${event.id || eventId}`,
    name: event.name || FALLBACK_GAIA.event.name,
    date: event.start_date && event.end_date ? `${event.start_date} - ${event.end_date}` : FALLBACK_GAIA.event.date,
    venue: event.location || FALLBACK_GAIA.event.venue,
    location: event.location || FALLBACK_GAIA.event.location,
    source: 'event-manager',
    liveData: true,
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
    normalized: false,
    liveData: false,
    locationId,
    apiBaseUrl: base,
    note: 'GHL credentials are configured backend-side. Add normalized reads here after staging auth is approved.',
  };
}

async function bootstrap() {
  const [event, ghl] = await Promise.all([
    getEventSummary().catch((error) => ({ ...FALLBACK_GAIA.event, source: 'event-manager-error', liveData: false, error: error.message })),
    getGhlSummary().catch((error) => ({ configured: false, error: error.message })),
  ]);
  const liveData = Boolean(event.liveData || ghl.liveData || ghl.normalized);

  return {
    ok: true,
    gaia: {
      ...FALLBACK_GAIA,
      event,
      sync: {
        generatedAt: new Date().toISOString(),
        liveData,
        mode: liveData ? 'live' : 'proxy-connected',
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
            elevenLabsVoice: ELEVENLABS_VOICE_NAME,
            elevenLabsVoiceId: ELEVENLABS_VOICE_ID || '',
            elevenLabsModel: ELEVENLABS_MODEL,
          },
        },
      },
    },
  };
}

function fallbackAssistReply(prompt, intent = '') {
  const normalized = `${intent} ${prompt}`.toLowerCase();
  if (normalized.includes('service') || normalized.includes('what do you do') || normalized.includes('gaia') || normalized.includes('device')) {
    return 'Gaia Healers connects Bio-Well, BioPulsar, BioTekna, Healeex, certification, practitioner communities, devices, CE progress, and Elevate event operations. I can explain services, compare devices, find the right course, prepare event badge steps, or draft GHL follow-up in review mode.';
  }
  if (normalized.includes('community') || normalized.includes('membership') || normalized.includes('login') || normalized.includes('discussion')) {
    return 'The Gaia member hub is built around GHL Client Portal, courses, credentials, communities, newsletters, and group discussions. The observed groups include All Gaia Healers, Bio-Well Practitioners, BioPulsar, Biotekna, Healeex, and Abundant Healer Collective.';
  }
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
    'You are Gaia Assist, the smart concierge for the Gaia Healers mobile app.',
    'Answer with deep awareness of Gaia Healers services, GHL membership/community structure, academy courses, event operations, devices, website offers, Bio-Well scans, and practitioner workflows.',
    'When asked operational questions, explain what the app can read, what still requires login, and what needs admin approval.',
    'Never claim that you saved, imported, checked in, emailed, purchased, or changed data. Keep all actions in review/confirm mode.',
    'Keep responses concise, practical, warm, and wellness-safe. Do not provide medical diagnosis.',
    gaiaKnowledgePrompt(),
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
      max_tokens: 520,
      presence_penalty: 0.1,
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
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
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
      voice: ELEVENLABS_VOICE_NAME || voiceId,
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

async function assistTranscribe(body) {
  const audioBase64 = String(body.audioBase64 || '').trim();
  if (!audioBase64) {
    return { ok: false, status: 400, error: 'audioBase64 is required' };
  }
  if (audioBase64.length > 3 * 1024 * 1024) {
    return { ok: false, status: 413, error: 'Audio payload is too large' };
  }

  const mimeType = String(body.mimeType || 'audio/webm').trim() || 'audio/webm';
  const extension = mimeType.includes('mp4') || mimeType.includes('aac') ? 'voice.m4a' : 'voice.webm';
  const audioBuffer = Buffer.from(audioBase64, 'base64');

  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const form = new FormData();
      form.append('file', new Blob([audioBuffer], { type: mimeType }), extension);
      form.append('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v1');
      const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
        body: form,
      });
      if (response.ok) {
        const payload = await response.json();
        const transcript = String(payload.text || payload.transcript || '').trim();
        if (transcript) {
          return {
            ok: true,
            transcript,
            provider: 'elevenlabs',
            model: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1',
          };
        }
      } else {
        const details = await response.text();
        console.error('[Gaia Assist] ElevenLabs STT failed', { status: response.status, details: details.slice(0, 180) });
      }
    } catch (error) {
      console.error('[Gaia Assist] ElevenLabs STT error', { error: error.message.split('\n')[0] });
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, status: 503, error: 'Speech transcription is not configured on the proxy' };
  }

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), extension);
  form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1');
  form.append('language', 'en');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Whisper transcription failed with ${response.status}: ${details.slice(0, 280)}`);
  }

  const payload = await response.json();
  const transcript = String(payload.text || '').trim();
  return {
    ok: true,
    transcript,
    provider: 'openai-whisper',
    model: process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1',
  };
}

async function listHostedVoices() {
  if (!process.env.ELEVENLABS_API_KEY) {
    return {
      ok: true,
      provider: 'none',
      voices: ELEVENLABS_VOICE_ID
        ? [{ id: ELEVENLABS_VOICE_ID, name: ELEVENLABS_VOICE_NAME, provider: 'elevenlabs' }]
        : [],
    };
  }
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`voices ${response.status}`);
    const payload = await response.json();
    const voices = (payload.voices || [])
      .map((voice) => ({
        id: voice.voice_id,
        name: voice.name,
        provider: 'elevenlabs',
        category: voice.category || '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, provider: 'elevenlabs', voices };
  } catch (error) {
    return {
      ok: true,
      provider: 'elevenlabs',
      voices: ELEVENLABS_VOICE_ID
        ? [{ id: ELEVENLABS_VOICE_ID, name: ELEVENLABS_VOICE_NAME, provider: 'elevenlabs' }]
        : [],
      warning: error.message,
    };
  }
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
    if (req.method === 'POST' && url.pathname === '/api/assist/transcribe') {
      const body = await readJsonBody(req, 3 * 1024 * 1024);
      try {
        const payload = await assistTranscribe(body);
        sendJson(res, payload.ok === false ? (payload.status || 503) : 200, payload, origin);
      } catch (error) {
        console.error('[Gaia Assist] transcription failed', { error: error.message.split('\n')[0] });
        sendJson(res, 503, { ok: false, error: error.message }, origin);
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/assist/voices') {
      sendJson(res, 200, await listHostedVoices(), origin);
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
