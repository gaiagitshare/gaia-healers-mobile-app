/**
 * Gaia — Wellness profiles + daily content (self-contained, additive).
 *
 * Sign-up (name, DOB, location, email) → a real profile persisted to a
 * proxy-owned JSON store, linked to the device via a signed cookie. Unlocks two
 * daily features computed from the member's REAL data (no mock, no random):
 *   - Body point: today's focus chakra (a personal daily cycle from their birth
 *     chakra + the date) → that centre's real body area.
 *   - Wellness horoscope: their real sun sign + today's chakra → an AI tip
 *     (grounded in those facts), cached once per day.
 *
 * All request/crypto/AI helpers are INJECTED by server.js (deps).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = process.env.GAIA_WELLNESS_COOKIE || 'gaia_wellness';
const TTL_MS = 400 * 24 * 60 * 60 * 1000; // ~13 months
const DATA_DIR = path.join(__dirname, 'data');
const STORE = path.join(DATA_DIR, 'wellness-profiles.json');

// ---- reference chakra data (mirrors gaia-chakra-data.js; real correspondences) ----
const CHAKRAS = [
  { id: 'root', name: 'Root', sanskrit: 'Muladhara', color: '#E53935', element: 'Earth', area: 'the base of your spine, legs and feet', focus: 'grounding, safety and vitality' },
  { id: 'sacral', name: 'Sacral', sanskrit: 'Svadhisthana', color: '#FB8C00', element: 'Water', area: 'your lower abdomen, hips and reproductive system', focus: 'creativity, emotion and flow' },
  { id: 'solar', name: 'Solar Plexus', sanskrit: 'Manipura', color: '#FDD835', element: 'Fire', area: 'your stomach and digestion', focus: 'confidence, willpower and energy' },
  { id: 'heart', name: 'Heart', sanskrit: 'Anahata', color: '#43A047', element: 'Air', area: 'your heart, chest and lungs', focus: 'love, compassion and connection' },
  { id: 'throat', name: 'Throat', sanskrit: 'Vishuddha', color: '#1E88E5', element: 'Sound', area: 'your throat, neck and thyroid', focus: 'expression and truth' },
  { id: 'third-eye', name: 'Third Eye', sanskrit: 'Ajna', color: '#3949AB', element: 'Light', area: 'your forehead, eyes and head', focus: 'intuition and clarity' },
  { id: 'crown', name: 'Crown', sanskrit: 'Sahasrara', color: '#8E24AA', element: 'Consciousness', area: 'the crown of your head and nervous system', focus: 'awareness and spiritual connection' },
];

// ---- tiny JSON store ----
function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* ignore */ } }
function readStore() { try { const d = JSON.parse(fs.readFileSync(STORE, 'utf8')); return Array.isArray(d) ? d : []; } catch (_) { return []; } }
function writeStore(list) { ensureDir(); fs.writeFileSync(STORE, JSON.stringify(list, null, 2)); }
function saveProfile(p) { const list = readStore(); const i = list.findIndex((x) => x.id === p.id); if (i >= 0) list[i] = p; else list.push(p); writeStore(list); }

// ---- helpers ----
// eslint-disable-next-line no-control-regex
function str(v, max = 200) { return String(v == null ? '' : v).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max); }
function newId() { return 'w' + crypto.randomBytes(9).toString('hex'); }
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'friend'; }
function todayKey() { return new Date().toISOString().slice(0, 10); }

function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }
// Parse a YYYY-MM-DD dob; returns {y,m,d} or null.
function parseDob(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) return null;
  const y = +m[1]; const mo = +m[2]; const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (dt.getTime() > Date.now()) return null; // no future births
  return { y, m: mo, d };
}

function digitRoot(n) { n = Math.abs(n); while (n > 9) { n = String(n).split('').reduce((a, c) => a + (+c), 0); } return n; }
function birthChakraIndex(y, m, d) { return (digitRoot(y + m + d) - 1) % 7; }

function sunSign(month, day) {
  const cutoff = [20, 19, 21, 20, 21, 21, 23, 23, 23, 23, 22, 22];
  const from = ['Capricorn', 'Aquarius', 'Pisces', 'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius'];
  const to = ['Aquarius', 'Pisces', 'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn'];
  return day < cutoff[month - 1] ? from[month - 1] : to[month - 1];
}
// today's focus chakra: a personal daily cycle from birth chakra + the date.
function todayChakra(birthIdx, dateKey) {
  const days = Math.floor(Date.parse(dateKey + 'T00:00:00Z') / 86400000);
  return CHAKRAS[((birthIdx + days) % 7 + 7) % 7];
}

// ---- cookie ----
function profileFromReq(req, deps) {
  const cookies = deps.parseCookies(req.headers.cookie || '');
  const payload = deps.readSignedToken(cookies[COOKIE] || '');
  if (!payload || !payload.wpid) return null;
  return readStore().find((p) => p.id === payload.wpid) || null;
}
function buildSetCookie(value) {
  return [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=None', 'Secure', `Max-Age=${Math.floor(TTL_MS / 1000)}`].join('; ');
}
function buildClearCookie() {
  return [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=None', 'Secure', 'Max-Age=0'].join('; ');
}

// ---- daily content (real; AI tip cached per day) ----
async function dailyFor(profile, deps) {
  const dob = parseDob(profile.dob);
  const birthIdx = birthChakraIndex(dob.y, dob.m, dob.d);
  const birth = CHAKRAS[birthIdx];
  const sign = sunSign(dob.m, dob.d);
  const dateKey = todayKey();
  const chakra = todayChakra(birthIdx, dateKey);
  const fn = firstName(profile.name);

  // Cached tip for today?
  let tip = (profile.lastDaily && profile.lastDaily.date === dateKey && profile.lastDaily.tip) || '';
  if (!tip) {
    const system = 'You are Gaia, a warm wellness guide for an energy-healing app. Write brief, uplifting daily guidance grounded in chakra and astrology wellness traditions. This is not medical advice — never diagnose or mention illness. Address the person by first name. Two short sentences, no preamble, no emojis.';
    const user = `Write today's wellness note for ${fn}, whose sun sign is ${sign}. Today their focus energy centre is the ${chakra.name} chakra, which governs ${chakra.area} and relates to ${chakra.focus}. Give one gentle, practical wellness suggestion for today connected to that centre.`;
    tip = (await deps.aiComplete(system, user, { maxTokens: 120, temperature: 0.7 })).trim();
    if (!tip) {
      // Deterministic fallback derived from their real data (used only if AI is down).
      tip = `${fn}, your ${chakra.name} centre is in focus today — give ${chakra.area} a little extra care and take a few slow, grounding breaths. Lean into ${chakra.focus}.`;
    }
    profile.lastDaily = { date: dateKey, tip, chakraId: chakra.id };
    saveProfile(profile);
  }

  return {
    date: dateKey,
    sunSign: sign,
    birthChakra: { id: birth.id, name: birth.name, sanskrit: birth.sanskrit, color: birth.color, element: birth.element, focus: birth.focus },
    bodyPoint: { chakra: chakra.name, sanskrit: chakra.sanskrit, area: chakra.area, focus: chakra.focus, element: chakra.element, color: chakra.color },
    tip,
  };
}

function publicProfile(p) { return { name: p.name, firstName: firstName(p.name), location: p.location, email: p.email }; }

// ---- handler ----
async function handle(req, res, url, deps) {
  const { origin, sendJson } = deps;
  const p = url.pathname.replace(/\/+$/, '') || url.pathname;
  const method = req.method;

  if (p === '/api/wellness/me' && method === 'GET') {
    const profile = profileFromReq(req, deps);
    if (!profile) return sendJson(res, 200, { ok: true, signedUp: false }, origin);
    const today = await dailyFor(profile, deps);
    return sendJson(res, 200, { ok: true, signedUp: true, profile: publicProfile(profile), today }, origin);
  }

  if (p === '/api/wellness/signup' && method === 'POST') {
    const body = await deps.readJsonBody(req).catch(() => ({}));
    const name = str(body.name, 100);
    const email = str(body.email, 160).toLowerCase();
    const location = str(body.location, 120);
    const dob = parseDob(body.dob);
    if (!name) return sendJson(res, 200, { ok: false, reason: 'name_required' }, origin);
    if (!validEmail(email)) return sendJson(res, 200, { ok: false, reason: 'email_invalid' }, origin);
    if (!dob) return sendJson(res, 200, { ok: false, reason: 'dob_invalid' }, origin);

    const list = readStore();
    // one profile per email (update if returning with the same email)
    let profile = list.find((x) => x.email === email);
    if (profile) {
      profile.name = name; profile.location = location;
      profile.dob = `${dob.y}-${String(dob.m).padStart(2, '0')}-${String(dob.d).padStart(2, '0')}`;
      profile.updatedAt = new Date().toISOString();
      profile.lastDaily = null; // recompute for possibly-changed dob
    } else {
      profile = {
        id: newId(), name, email, location,
        dob: `${dob.y}-${String(dob.m).padStart(2, '0')}-${String(dob.d).padStart(2, '0')}`,
        createdAt: new Date().toISOString(), lastDaily: null,
      };
    }
    saveProfile(profile);

    const token = deps.signTokenPayload({ wpid: profile.id, iat: Date.now(), exp: Date.now() + TTL_MS });
    const today = await dailyFor(profile, deps);
    return sendJson(res, 200, { ok: true, signedUp: true, profile: publicProfile(profile), today }, origin, { 'Set-Cookie': buildSetCookie(token) });
  }

  if (p === '/api/wellness/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, origin, { 'Set-Cookie': buildClearCookie() });
  }

  return sendJson(res, 404, { ok: false, reason: 'unknown_wellness_route' }, origin);
}

export { handle };
