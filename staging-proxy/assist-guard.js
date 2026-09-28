/**
 * GAIA ASSIST — spending limits for the open assistant.
 *
 * Gaia Assist is open to every visitor by product decision, and every route
 * behind it spends money: an LLM answer, a transcription, ElevenLabs speech, a
 * Gemini Live or Qwen voice session. Until now the only brake was nginx's
 * 30 requests a minute per address — 43,000 a day each, from as many
 * addresses as anyone cares to use.
 *
 * This adds the brakes that matter for a bill:
 *   - per caller: a burst limit per minute and a total per day, with signed-in
 *     members allowed several times more than anonymous visitors;
 *   - for the whole site: a daily ceiling per kind of spend, so no amount of
 *     distributed traffic can run past a known cost. When a ceiling is hit the
 *     assistant says it is busy; the rest of the app is untouched.
 *
 * The caller is X-Real-IP, which nginx sets from the connection itself.
 * X-Forwarded-For is NOT used: nginx appends to whatever the client sent, so
 * its first entry is anything the caller likes — a new "address" per request.
 * IPv6 callers are grouped by /64, because one connection routinely holds a
 * whole /64 and could otherwise rotate through it.
 *
 * Counters live in memory and reset on restart and at midnight UTC. That is a
 * deliberate trade: a restart forgives a day's counts, but nothing here can
 * fail a request because a file could not be written.
 */

const DEFAULTS = {
  // kind: [perMinute, perDay] for one anonymous caller; memberFactor scales
  // both for signed-in members; globalPerDay caps the whole site.
  chat: { perMinute: 12, perDay: 150, globalPerDay: 20000 },
  voice: { perMinute: 6, perDay: 40, globalPerDay: 3000 },       // live voice sessions (tokens/tickets)
  stt: { perMinute: 12, perDay: 150, globalPerDay: 10000 },      // transcription and pipeline turns
  tts: { perMinute: 20, perDay: 25000, globalPerDay: 600000 },   // perDay/globalPerDay are CHARACTERS
  misc: { perMinute: 20, perDay: 400, globalPerDay: 50000 },     // lookups, voice list
};
const MEMBER_FACTOR_DEFAULT = 4;

function num(v, d) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; }

export function guardConfig(env = process.env) {
  const out = {};
  for (const [kind, d] of Object.entries(DEFAULTS)) {
    const K = `ASSIST_LIMIT_${kind.toUpperCase()}_`;
    out[kind] = {
      perMinute: num(env[K + 'PER_MINUTE'], d.perMinute),
      perDay: num(env[K + 'PER_DAY'], d.perDay),
      globalPerDay: num(env[K + 'GLOBAL_PER_DAY'], d.globalPerDay),
    };
  }
  out.memberFactor = num(env.ASSIST_LIMIT_MEMBER_FACTOR, MEMBER_FACTOR_DEFAULT);
  out.enabled = env.ASSIST_LIMITS_ENABLED !== 'false';
  return out;
}

/**
 * Who is being charged for this request.
 *
 * A verified member is keyed by their OWN id, not by the address they are
 * sitting behind. 350 people on one hotel NAT are one address, and without
 * this a member's allowance is spent by the 349 strangers next to them.
 *
 * The id comes from `sessionMemberContext(req)`, which reads the session
 * cookie through `readSignedToken`: HMAC-SHA256 over the payload with the
 * server's own secret, compared with `crypto.timingSafeEqual`, expiry checked,
 * null on any failure. The cookie is HttpOnly and Secure, and its contents
 * were written by this server at sign-in. Nothing a client can set — a header,
 * a query parameter, a body field — reaches this function. A forged or edited
 * cookie fails the signature, `sessionMemberContext` returns null, and the
 * caller falls back to the anonymous address bucket. It cannot be used to
 * escape a limit, only to land in the shared one.
 *
 * The prefixes matter: without them a member whose id happened to look like an
 * address would share that address's bucket.
 */
export function guardSubject(req, identity = null) {
  const id = String(
    (identity && (identity.memberId || identity.contactId || identity.email)) || '',
  ).trim().toLowerCase();
  if (id) return { key: 'member:' + id, member: true };
  return { key: 'ip:' + callerKey(req), member: false };
}

/** The caller, as nginx saw it. IPv6 grouped by /64. */
export function callerKey(req) {
  const raw = String(req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown').trim().replace(/^::ffff:/, '');
  if (raw.includes(':')) {
    const parts = raw.split('::')[0].split(':');
    const full = raw.includes('::')
      ? [...parts, ...Array(8 - raw.split(':').filter(Boolean).length).fill('0')]
      : raw.split(':');
    return full.slice(0, 4).join(':') + '::/64';
  }
  return raw;
}

// ── counters ────────────────────────────────────────────────────────────────
let day = '';
const perDayUse = new Map();     // `${kind}|${caller}` -> units today
const globalUse = new Map();     // kind -> units today
const minuteUse = new Map();     // `${kind}|${caller}` -> [timestamps]
const warned = new Set();        // kinds whose global ceiling was logged today

function today(now) { return new Date(now).toISOString().slice(0, 10); }
function rollDay(now) {
  const d = today(now);
  if (d !== day) { day = d; perDayUse.clear(); globalUse.clear(); warned.clear(); }
}

export function _resetGuard() { day = ''; perDayUse.clear(); globalUse.clear(); minuteUse.clear(); warned.clear(); }

/**
 * May this caller spend `units` of `kind` now? Counts it if so.
 * Returns { ok: true } or { ok: false, reason, retryAfter }.
 */
export function allowSpend({ kind, caller, member = false, units = 1, now = Date.now(), cfg = guardConfig() }) {
  if (!cfg.enabled) return { ok: true };
  const lim = cfg[kind];
  if (!lim) return { ok: true };
  rollDay(now);
  const factor = member ? cfg.memberFactor : 1;
  const key = `${kind}|${caller}`;

  const stamps = (minuteUse.get(key) || []).filter((t) => now - t < 60_000);
  if (stamps.length >= lim.perMinute * factor) {
    minuteUse.set(key, stamps);
    return { ok: false, reason: 'caller_minute', retryAfter: Math.max(1, Math.ceil((60_000 - (now - stamps[0])) / 1000)) };
  }
  const used = perDayUse.get(key) || 0;
  if (used + units > lim.perDay * factor) {
    return { ok: false, reason: 'caller_day', retryAfter: secondsToMidnight(now) };
  }
  const g = globalUse.get(kind) || 0;
  if (g + units > lim.globalPerDay) {
    if (!warned.has(kind)) {
      warned.add(kind);
      console.warn('[Gaia Assist] daily ceiling reached — assistant answers "busy" until midnight UTC', { kind, used: g, ceiling: lim.globalPerDay });
    }
    return { ok: false, reason: 'site_day', retryAfter: secondsToMidnight(now) };
  }
  stamps.push(now);
  minuteUse.set(key, stamps);
  perDayUse.set(key, used + units);
  globalUse.set(kind, g + units);
  return { ok: true };
}

/** Today's use, for the health endpoint and the logs. */
export function spendToday() {
  rollDay(Date.now());
  return { day, ...Object.fromEntries(globalUse) };
}

function secondsToMidnight(now) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.ceil((next - now) / 1000);
}

// Keep the minute map from growing with one-off callers.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of minuteUse) if (!v.length || now - v[v.length - 1] > 60_000) minuteUse.delete(k);
}, 60_000).unref?.();

/** Which kind of spend an /api/assist/* route is. */
export function spendKindFor(method, pathname) {
  if (pathname === '/api/assist/chat' || pathname === '/api/assist/chat/stream' || pathname === '/api/assist/voice') return 'chat';
  if (pathname === '/api/assist/voice/token') return 'voice';
  if (pathname === '/api/assist/transcribe' || pathname === '/api/assist/voice/turn') return 'stt';
  if (pathname === '/api/assist/tts') return 'tts';
  if (pathname === '/api/assist/lookup' || pathname === '/api/assist/voices') return 'misc';
  return null; // memory / onboarding / interest: member-only, no paid call
}

export const ASSIST_MAX_PROMPT_CHARS = 2000;
export const ASSIST_MAX_TTS_CHARS = 2500;
