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
import { Body, Ecliptic, GeoVector } from 'astronomy-engine';
import { todaySky } from './membership/sky.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = process.env.GAIA_WELLNESS_COOKIE || 'gaia_wellness';
const TTL_MS = 400 * 24 * 60 * 60 * 1000; // ~13 months
const DATA_DIR = path.join(__dirname, 'data');
const STORE = path.join(DATA_DIR, 'wellness-profiles.json');
const LOCATION_CACHE = new Map();

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

const ZODIAC_SIGNS = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
const ZODIAC_ELEMENTS = ['Fire', 'Earth', 'Air', 'Water'];
const SIGN_CHAKRA = {
  Aries: 'solar', Taurus: 'heart', Gemini: 'throat', Cancer: 'third-eye',
  Leo: 'crown', Virgo: 'throat', Libra: 'heart', Scorpio: 'solar',
  Sagittarius: 'sacral', Capricorn: 'root', Aquarius: 'root', Pisces: 'sacral',
};
const PLANETS = [
  { name: 'Sun', body: Body.Sun, chakraId: 'crown' },
  { name: 'Moon', body: Body.Moon, chakraId: 'third-eye' },
  { name: 'Mercury', body: Body.Mercury, chakraId: 'throat' },
  { name: 'Venus', body: Body.Venus, chakraId: 'heart' },
  { name: 'Mars', body: Body.Mars, chakraId: 'solar' },
  { name: 'Jupiter', body: Body.Jupiter, chakraId: 'sacral' },
  { name: 'Saturn', body: Body.Saturn, chakraId: 'root' },
];

// The astronomy remains factual; this layer is deliberately framed as a
// reflective wellness pathway. It never claims to measure or diagnose energy.
const CHAKRA_PATHS = {
  root: { intention: 'Ground and steady', practice: 'Plant both feet, lengthen your exhale, and name one thing that feels dependable right now.', journal: 'What would help me feel supported enough to take the next step?', colour: 'Red' },
  sacral: { intention: 'Restore creative flow', practice: 'Place a hand over your lower belly and let your hips or shoulders move gently for two minutes.', journal: 'What wants to move, be felt, or be created today?', colour: 'Orange' },
  solar: { intention: 'Choose with confidence', practice: 'Sit tall, take five steady breaths, and choose one small action you can complete today.', journal: 'Where can I trust my own decision without forcing the outcome?', colour: 'Yellow' },
  heart: { intention: 'Open with boundaries', practice: 'Rest a hand on your chest and breathe slowly while offering yourself one kind sentence.', journal: 'What would compassionate connection look like with a clear boundary?', colour: 'Green' },
  throat: { intention: 'Express what is true', practice: 'Hum softly on the exhale, then write one honest sentence you have been avoiding.', journal: 'What needs a clear, kind voice today?', colour: 'Blue' },
  'third-eye': { intention: 'Make space for clarity', practice: 'Soften your gaze, breathe quietly, and notice the first calm observation—not the loudest thought.', journal: 'What becomes clearer when I stop trying to solve everything?', colour: 'Indigo' },
  crown: { intention: 'Reconnect to meaning', practice: 'Sit in stillness for two minutes and name three things that place today in a larger perspective.', journal: 'What helps me remember that I am part of something larger?', colour: 'Violet' },
};
const ELEMENT_INVITATIONS = {
  Air: 'Give the feeling language: say it aloud, write one sentence, or take three breaths by an open window.',
  Earth: 'Add one physical anchor: feel your feet, hold a warm cup, or complete one small practical task.',
  Fire: 'Add gentle momentum: choose one energising song, a brisk two-minute walk, or one clear next action.',
  Water: 'Add softness and flow: drink water slowly, move without a goal, or let one emotion be present without fixing it.',
};

function buildEnergyPath(spotlight, representedElement, elementToInvite) {
  const base = CHAKRA_PATHS[spotlight.id] || CHAKRA_PATHS.heart;
  return {
    intention: base.intention,
    summary: `${spotlight.name} is the symbolic spotlight, with ${representedElement} most represented. Invite ${elementToInvite} as a balancing reflection—not as a diagnosis or deficiency.`,
    practice: base.practice,
    invitation: ELEMENT_INVITATIONS[elementToInvite] || 'Choose one gentle action that brings a different quality into the moment.',
    journal: base.journal,
    colour: base.colour,
    routes: {
      measured: 'home.html?view=bookings',
      product: 'home.html?view=store',
      event: 'home.html?view=events',
      community: 'home.html?view=community',
    },
  };
}

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

function normalizePlace(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = str(raw.label, 160);
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  const timezone = str(raw.timezone, 80);
  if (!label || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !timezone) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date()); } catch (_) { return null; }
  return { label, latitude, longitude, timezone };
}

function localBirthInstant(dob, birthTime, timezone) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(birthTime || '12:00'));
  const hour = match ? Math.min(23, Number(match[1])) : 12;
  const minute = match ? Math.min(59, Number(match[2])) : 0;
  const target = Date.UTC(dob.y, dob.m - 1, dob.d, hour, minute, 0);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let i = 0; i < 3; i += 1) {
    const values = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    const shownAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    guess += target - shownAsUtc;
  }
  return new Date(guess);
}

function zodiacPlacement(longitude) {
  const normalized = ((longitude % 360) + 360) % 360;
  const index = Math.floor(normalized / 30);
  return { sign: ZODIAC_SIGNS[index], element: ZODIAC_ELEMENTS[index % 4], degree: Math.floor(normalized % 30) };
}

function buildCosmicMap(dob, birthTime, place) {
  const timeKnown = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(birthTime || ''));
  const instant = localBirthInstant(dob, timeKnown ? birthTime : '12:00', place.timezone);
  const placements = PLANETS.map((planet) => {
    const vector = GeoVector(planet.body, instant, true);
    const placement = zodiacPlacement(Ecliptic(vector).elon);
    return { name: planet.name, chakraId: planet.chakraId, ...placement };
  });
  const signCounts = Object.fromEntries(ZODIAC_SIGNS.map((sign) => [sign, 0]));
  const elementCounts = Object.fromEntries(ZODIAC_ELEMENTS.map((element) => [element, 0]));
  placements.forEach((planet) => { signCounts[planet.sign] += 1; elementCounts[planet.element] += 1; });
  const sun = placements.find((planet) => planet.name === 'Sun');
  const dominantSign = Object.entries(signCounts).sort((a, b) => b[1] - a[1] || (a[0] === sun.sign ? -1 : 1))[0][0];
  const rankedElements = Object.entries(elementCounts).sort((a, b) => b[1] - a[1]);
  const spotlight = CHAKRAS.find((chakra) => chakra.id === SIGN_CHAKRA[dominantSign]) || CHAKRAS[0];
  const representedElement = rankedElements[0][0];
  const elementToInvite = rankedElements[rankedElements.length - 1][0];
  return {
    source: 'astronomy-engine',
    calculatedAt: instant.toISOString(),
    timeBasis: timeKnown ? 'exact-local-time' : 'local-noon-estimate',
    place: place.label,
    timezone: place.timezone,
    placements,
    dominantSign,
    representedElement,
    elementToInvite,
    spotlight: { id: spotlight.id, name: spotlight.name, color: spotlight.color, focus: spotlight.focus },
    energyPath: buildEnergyPath(spotlight, representedElement, elementToInvite),
  };
}

async function searchLocations(query) {
  const key = query.toLocaleLowerCase('en');
  const cached = LOCATION_CACHE.get(key);
  if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) return cached.items;
  const endpoint = new URL('https://geocoding-api.open-meteo.com/v1/search');
  endpoint.searchParams.set('name', query);
  endpoint.searchParams.set('count', '8');
  endpoint.searchParams.set('language', 'en');
  endpoint.searchParams.set('format', 'json');
  const response = await fetch(endpoint, { headers: { Accept: 'application/json', 'User-Agent': 'GaiaHealersApp/1.0' }, signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`Location lookup failed (${response.status})`);
  const payload = await response.json();
  const items = (Array.isArray(payload.results) ? payload.results : []).map((item) => {
    const parts = [item.name, item.admin1, item.country].filter(Boolean).filter((part, index, list) => list.indexOf(part) === index);
    return {
      id: String(item.id || `${item.latitude},${item.longitude}`),
      label: parts.join(', '),
      name: str(item.name, 100),
      region: str(item.admin1, 100),
      country: str(item.country, 100),
      countryCode: str(item.country_code, 2),
      latitude: Number(item.latitude),
      longitude: Number(item.longitude),
      timezone: str(item.timezone, 80),
    };
  }).filter((item) => item.label && item.timezone && Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
  LOCATION_CACHE.set(key, { at: Date.now(), items });
  if (LOCATION_CACHE.size > 250) LOCATION_CACHE.delete(LOCATION_CACHE.keys().next().value);
  return items;
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
    cosmicMap: profile.place ? buildCosmicMap(dob, profile.birthTime, profile.place) : null,
  };
}

// ---- Daily Energy: a composed daily ritual + real server-side streak ----
// Built entirely on the existing real daily (focus chakra, sun sign, AI tip)
// plus the per-chakra CHAKRA_PATHS. No mock data, no random.
function dayNumberUTC(dateKey) { return Math.floor(Date.parse(dateKey + 'T00:00:00Z') / 86400000); }
function keyFromDayNumber(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }

// Streak state derived from profile.ritual.checkins (an array of YYYY-MM-DD).
function ritualState(profile) {
  const log = (profile.ritual && Array.isArray(profile.ritual.checkins)) ? profile.ritual.checkins : [];
  const set = new Set(log);
  const todayKeyStr = todayKey();
  const todayN = dayNumberUTC(todayKeyStr);
  // Current streak: consecutive days ending today, or ending yesterday if today
  // is not done yet (so the streak is not shown as broken before you check in).
  let current = 0;
  const anchor = set.has(todayKeyStr) ? todayN : todayN - 1;
  for (let n = anchor; ; n -= 1) { if (set.has(keyFromDayNumber(n))) current += 1; else break; }
  // Longest run anywhere in the log.
  const nums = [...set].map(dayNumberUTC).sort((a, b) => a - b);
  let longest = 0, run = 0, prev = null;
  for (const n of nums) { run = (prev !== null && n === prev + 1) ? run + 1 : 1; if (run > longest) longest = run; prev = n; }
  // Last 7 days for a calendar strip.
  const last7 = [];
  for (let i = 6; i >= 0; i -= 1) { const key = keyFromDayNumber(todayN - i); last7.push({ date: key, done: set.has(key) }); }
  return { doneToday: set.has(todayKeyStr), current, longest, total: set.size, last7 };
}

async function dailyEnergyFor(profile, deps) {
  const d = await dailyFor(profile, deps);
  const dob = parseDob(profile.dob);
  const focus = todayChakra(birthChakraIndex(dob.y, dob.m, dob.d), todayKey());
  const path = CHAKRA_PATHS[focus.id] || CHAKRA_PATHS.heart;
  return Object.assign({}, d, {
    name: firstName(profile.name),
    chakraId: focus.id,
    intention: path.intention,
    practice: path.practice,
    journal: path.journal,
    colour: path.colour,
    ritual: ritualState(profile),
  });
}

// Guest preview: a COLLECTIVE focus chakra derived from the date only (never
// personal), so signed-out visitors see a real, changing preview and a reason
// to add their birth date. Clearly flagged guest:true so the UI never implies
// it is personalised.
function guestDaily() {
  const dateKey = todayKey();
  const focus = CHAKRAS[((dayNumberUTC(dateKey) % 7) + 7) % 7];
  const path = CHAKRA_PATHS[focus.id] || CHAKRA_PATHS.heart;
  return {
    guest: true,
    date: dateKey,
    bodyPoint: { chakra: focus.name, sanskrit: focus.sanskrit, area: focus.area, focus: focus.focus, element: focus.element, color: focus.color },
    chakraId: focus.id,
    intention: path.intention,
    practice: path.practice,
    colour: path.colour,
  };
}

function publicProfile(p) { return { name: p.name, firstName: firstName(p.name), location: p.location, birthTime: p.birthTime || '', email: p.email }; }

// ---- GHL sync (best-effort; needs contacts.write on the PIT) ----
function splitName(name) { const parts = String(name || '').trim().split(/\s+/); return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') }; }
async function syncGhl(profile, deps) {
  if (!deps.ghlUpsertContact) return { ok: false, reason: 'no_helper' };
  const { firstName: fn, lastName: ln } = splitName(profile.name);
  const r = await deps.ghlUpsertContact({
    firstName: fn, lastName: ln, email: profile.email,
    dateOfBirth: profile.dob, // GHL standard contact field
    city: profile.location || undefined,
    tags: ['gaia-app', 'gaia-wellness-signup'],
    source: 'Gaia Healers app — wellness sign-up',
  });
  profile.ghl = { synced: !!r.ok, contactId: r.contactId || (profile.ghl && profile.ghl.contactId) || '', reason: r.reason || '', at: new Date().toISOString() };
  saveProfile(profile);
  return r;
}
// Retry sync at most once every 6h while unsynced (so it catches up once the
// scope is enabled, without hammering GHL on every page load).
async function maybeSyncGhl(profile, deps) {
  const g = profile.ghl || {};
  if (g.synced) return;
  if (g.at && Date.now() - Date.parse(g.at) < 6 * 60 * 60 * 1000) return;
  await syncGhl(profile, deps).catch(() => {});
}

// ---- 8-week chakra challenge (real chakra practices; one centre per week) ----
const CHALLENGE = [
  { week: 1, chakra: 'Root', sanskrit: 'Muladhara', color: '#E53935', focus: 'Grounding & safety', practice: 'Stand or sit with bare feet for five minutes and feel the ground hold you.', affirmation: 'I am safe, supported and grounded.' },
  { week: 2, chakra: 'Sacral', sanskrit: 'Svadhisthana', color: '#FB8C00', focus: 'Creativity & emotion', practice: 'Move your body freely for a few minutes — sway, stretch or dance.', affirmation: 'I allow myself to feel and to create.' },
  { week: 3, chakra: 'Solar Plexus', sanskrit: 'Manipura', color: '#FDD835', focus: 'Confidence & willpower', practice: 'Name one thing you did well today and one small step for tomorrow.', affirmation: 'I trust my own strength.' },
  { week: 4, chakra: 'Heart', sanskrit: 'Anahata', color: '#43A047', focus: 'Love & compassion', practice: 'Place a hand on your heart and breathe, or send someone a kind message.', affirmation: 'I give and receive love freely.' },
  { week: 5, chakra: 'Throat', sanskrit: 'Vishuddha', color: '#1E88E5', focus: 'Expression & truth', practice: 'Say or write one honest thing you have been holding back.', affirmation: 'I express my truth with ease.' },
  { week: 6, chakra: 'Third Eye', sanskrit: 'Ajna', color: '#3949AB', focus: 'Intuition & clarity', practice: 'Sit quietly for five minutes and notice the first thought that brings you calm.', affirmation: 'I trust my inner knowing.' },
  { week: 7, chakra: 'Crown', sanskrit: 'Sahasrara', color: '#8E24AA', focus: 'Connection & awareness', practice: 'Spend a few minutes in stillness or gratitude, open to something larger.', affirmation: 'I am connected to all that is.' },
  { week: 8, chakra: 'Integration', sanskrit: 'Sarva', color: '#7DD956', focus: 'Whole-system harmony', practice: 'Breathe slowly from root to crown, one breath for each centre.', affirmation: 'My energy flows freely and in balance.' },
];
function dayNumber(dateKey) { return Math.floor(Date.parse(dateKey + 'T00:00:00Z') / 86400000); }
function challengeState(profile) {
  const c = profile.challenge;
  if (!c || !c.joinedAt) return { joined: false };
  const dateKey = todayKey();
  const days = Math.max(0, dayNumber(dateKey) - dayNumber(c.joinedAt)); // 0-based
  const week = Math.min(8, Math.floor(days / 7) + 1);
  const info = CHALLENGE[week - 1];
  const checkins = Array.isArray(c.checkins) ? c.checkins : [];
  return {
    joined: true, joinedAt: c.joinedAt, week, totalWeeks: 8,
    chakra: info.chakra, sanskrit: info.sanskrit, color: info.color, focus: info.focus,
    practice: info.practice, affirmation: info.affirmation,
    doneToday: checkins.includes(dateKey), totalDone: checkins.length,
    complete: days >= 56,
  };
}

// ---- handler ----
async function handle(req, res, url, deps) {
  const { origin, sendJson } = deps;
  const p = url.pathname.replace(/\/+$/, '') || url.pathname;
  const method = req.method;

  if (p === '/api/wellness/locations' && method === 'GET') {
    const query = str(url.searchParams.get('q'), 80);
    if (query.length < 3) return sendJson(res, 200, { ok: true, results: [] }, origin);
    try { return sendJson(res, 200, { ok: true, results: await searchLocations(query), attribution: 'Open-Meteo geocoding / GeoNames' }, origin); }
    catch (_) { return sendJson(res, 200, { ok: false, reason: 'location_lookup_unavailable', results: [] }, origin); }
  }

  if (p === '/api/wellness/chart' && method === 'POST') {
    const body = await deps.readJsonBody(req).catch(() => ({}));
    const dob = parseDob(body.dob);
    const place = normalizePlace(body.place);
    const birthTime = str(body.birthTime, 5);
    if (!dob) return sendJson(res, 200, { ok: false, reason: 'dob_invalid' }, origin);
    if (!place) return sendJson(res, 200, { ok: false, reason: 'place_invalid' }, origin);
    return sendJson(res, 200, { ok: true, cosmicMap: buildCosmicMap(dob, birthTime, place) }, origin);
  }

  if (p === '/api/wellness/me' && method === 'GET') {
    const profile = profileFromReq(req, deps);
    if (!profile) return sendJson(res, 200, { ok: true, signedUp: false }, origin);
    await maybeSyncGhl(profile, deps); // catches up once contacts.write is enabled
    const today = await dailyFor(profile, deps);
    return sendJson(res, 200, { ok: true, signedUp: true, profile: publicProfile(profile), today, challenge: challengeState(profile) }, origin);
  }

  // Chakra Challenge: join (tags the GHL contact) + daily check-in.
  if (p === '/api/wellness/challenge/join' && method === 'POST') {
    const profile = profileFromReq(req, deps);
    if (!profile) return sendJson(res, 401, { ok: false, reason: 'not_signed_up' }, origin);
    if (!profile.challenge || !profile.challenge.joinedAt) profile.challenge = { joinedAt: todayKey(), checkins: [] };
    saveProfile(profile);
    // fire the GHL 'chakra-challenge' tag (best-effort → your workflow)
    if (deps.ghlUpsertContact) {
      const { firstName: fn, lastName: ln } = splitName(profile.name);
      deps.ghlUpsertContact({ firstName: fn, lastName: ln, email: profile.email, tags: ['gaia-app', 'chakra-challenge'] }).catch(() => {});
    }
    return sendJson(res, 200, { ok: true, challenge: challengeState(profile) }, origin);
  }
  if (p === '/api/wellness/challenge/checkin' && method === 'POST') {
    const profile = profileFromReq(req, deps);
    if (!profile || !profile.challenge || !profile.challenge.joinedAt) return sendJson(res, 200, { ok: false, reason: 'not_joined' }, origin);
    const dateKey = todayKey();
    if (!Array.isArray(profile.challenge.checkins)) profile.challenge.checkins = [];
    if (!profile.challenge.checkins.includes(dateKey)) profile.challenge.checkins.push(dateKey);
    saveProfile(profile);
    return sendJson(res, 200, { ok: true, challenge: challengeState(profile) }, origin);
  }

  if (p === '/api/wellness/daily' && method === 'GET') {
    const profile = profileFromReq(req, deps);
    if (!profile) return sendJson(res, 200, Object.assign({ ok: true }, guestDaily()), origin);
    const daily = await dailyEnergyFor(profile, deps);
    return sendJson(res, 200, Object.assign({ ok: true }, daily), origin);
  }
  if (p === '/api/wellness/daily/complete' && method === 'POST') {
    const profile = profileFromReq(req, deps);
    if (!profile) return sendJson(res, 401, { ok: false, reason: 'not_signed_up' }, origin);
    const dateKey = todayKey();
    if (!profile.ritual || !Array.isArray(profile.ritual.checkins)) profile.ritual = { checkins: [] };
    if (!profile.ritual.checkins.includes(dateKey)) profile.ritual.checkins.push(dateKey);
    saveProfile(profile);
    return sendJson(res, 200, { ok: true, ritual: ritualState(profile) }, origin);
  }

  if (p === '/api/wellness/quickstart' && method === 'POST') {
    // The frictionless personalisation step after Join: birth date only (the
    // city / sky-map is a later optional step). A logged-in member's real,
    // verified email and name are used when present; otherwise name + email
    // must be supplied. Never creates a profile without a real email.
    const body = await deps.readJsonBody(req).catch(function () { return {}; });
    const dob = parseDob(body.dob);
    if (!dob) return sendJson(res, 200, { ok: false, reason: 'dob_invalid' }, origin);
    const ms = (deps.memberSession && deps.memberSession.member) ? deps.memberSession.member : null;
    let email = ms && ms.email ? String(ms.email).toLowerCase().trim() : str(body.email, 160).toLowerCase();
    let name = (ms && (ms.displayName || ms.name)) ? String(ms.displayName || ms.name) : str(body.name, 100);
    if (!validEmail(email)) return sendJson(res, 200, { ok: false, reason: 'email_required' }, origin);
    if (!name) name = firstName(email);
    let profile = readStore().find(function (x) { return x.email === email; });
    const now = new Date().toISOString();
    if (!profile) profile = { id: newId(), name: name, email: email, location: '', dob: body.dob, createdAt: now, updatedAt: now };
    else { profile.dob = body.dob; if (!profile.name) profile.name = name; profile.updatedAt = now; }
    saveProfile(profile);
    maybeSyncGhl(profile, deps).catch(function () {});
    const token = deps.signTokenPayload({ wpid: profile.id, iat: Date.now(), exp: Date.now() + TTL_MS });
    const daily = await dailyEnergyFor(profile, deps);
    return sendJson(res, 200, { ok: true, daily: daily }, origin, { 'Set-Cookie': buildSetCookie(token) });
  }
  if (p === '/api/wellness/signup' && method === 'POST') {
    const body = await deps.readJsonBody(req).catch(() => ({}));
    const name = str(body.name, 100);
    const email = str(body.email, 160).toLowerCase();
    const location = str(body.location, 120);
    const place = normalizePlace(body.place);
    const birthTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(str(body.birthTime, 5)) ? str(body.birthTime, 5) : '';
    const dob = parseDob(body.dob);
    if (!name) return sendJson(res, 200, { ok: false, reason: 'name_required' }, origin);
    if (!validEmail(email)) return sendJson(res, 200, { ok: false, reason: 'email_invalid' }, origin);
    if (!dob) return sendJson(res, 200, { ok: false, reason: 'dob_invalid' }, origin);
    if (!place) return sendJson(res, 200, { ok: false, reason: 'place_invalid' }, origin);

    // Recognise the person BEFORE we upsert, so it reflects their PRE-signup
    // state: an existing GHL contact → a warm "welcome back"; a contact that is
    // already a real member (with access) → offer a sign-in that syncs their
    // full profile. We never expose private access from an unverified email.
    let existingContact = false; let existingMember = false; let memberName = '';
    if (deps.memberLookup) {
      try { const m = await deps.memberLookup(email); if (m && m.existing) { existingContact = true; existingMember = !!m.member; memberName = m.name || ''; } } catch (_) {}
    }

    const list = readStore();
    // one profile per email (update if returning with the same email)
    let profile = list.find((x) => x.email === email);
    if (profile) {
      profile.name = name; profile.location = place.label || location; profile.place = place; profile.birthTime = birthTime;
      profile.dob = `${dob.y}-${String(dob.m).padStart(2, '0')}-${String(dob.d).padStart(2, '0')}`;
      profile.updatedAt = new Date().toISOString();
      profile.lastDaily = null; // recompute for possibly-changed dob
    } else {
      profile = {
        id: newId(), name, email, location: place.label || location, place, birthTime,
        dob: `${dob.y}-${String(dob.m).padStart(2, '0')}-${String(dob.d).padStart(2, '0')}`,
        createdAt: new Date().toISOString(), lastDaily: null,
      };
    }
    if (profile.ghl && profile.ghl.synced) profile.ghl = null; // re-sync on any change
    saveProfile(profile);
    await syncGhl(profile, deps).catch(() => {}); // best-effort push to GHL

    const token = deps.signTokenPayload({ wpid: profile.id, iat: Date.now(), exp: Date.now() + TTL_MS });
    const today = await dailyFor(profile, deps);
    return sendJson(res, 200, { ok: true, signedUp: true, profile: publicProfile(profile), today, challenge: challengeState(profile), existingMember, existingContact, memberName }, origin, { 'Set-Cookie': buildSetCookie(token) });
  }

  // Today's sky — the only wellness route that asks for nothing.
  //
  // Public and uncached-by-identity: the moon is the same for everyone, so this
  // needs no cookie, no birth date and no email. A visitor gets the real reading
  // first; the personal layer below is what signing up adds, not what it unlocks.
  if (p === '/api/wellness/sky' && method === 'GET') {
    let sky;
    try {
      sky = todaySky();
    } catch (err) {
      // An ephemeris failure is a real failure — better to say so than to
      // invent a moon.
      console.log('[Gaia Wellness] sky', JSON.stringify({ outcome: 'compute_failed', message: String(err && err.message) }));
      return sendJson(res, 200, { ok: false, reason: 'sky_unavailable' }, origin);
    }

    // The symbolic layer is attached here, in the file that owns Gaia's chakra
    // vocabulary — everyone gets it, signed up or not.
    const moonChakra = CHAKRAS.find((c) => c.id === SIGN_CHAKRA[sky.moon.sign]) || null;
    if (moonChakra) {
      sky.moon.chakra = { id: moonChakra.id, name: moonChakra.name, colour: moonChakra.color, focus: moonChakra.focus };
    }

    // If they already have a profile, say how today's sky meets their chart.
    // This is the honest version of the signup promise: the same sky, read
    // against something only they have given us.
    const profile = profileFromReq(req, deps);
    if (profile) {
      const dob = parseDob(profile.dob);
      if (dob) {
        const birth = CHAKRAS[birthChakraIndex(dob.y, dob.m, dob.d)];
        const resonant = !!(moonChakra && birth && moonChakra.id === birth.id);
        sky.personal = {
          firstName: firstName(profile.name),
          birthChakra: { id: birth.id, name: birth.name, colour: birth.color },
          sunSign: sunSign(dob.m, dob.d),
          resonant,
          note: resonant
            ? `The moon is in ${sky.moon.sign} today, which meets your ${birth.name.toLowerCase()} centre directly. Your own ground is lit — a good day to work with it rather than around it.`
            : `The moon is in ${sky.moon.sign} today, asking for your ${(moonChakra ? moonChakra.name : 'whole system').toLowerCase()} while your own centre is the ${birth.name.toLowerCase()}. Different ground than usual — notice what that stretches.`,
        };
      }
    }
    return sendJson(res, 200, sky, origin, {
      // Recomputed on request but safe to hold briefly at the edge: the numbers
      // move continuously, the reading does not change within an hour.
      'Cache-Control': 'public, max-age=900',
    });
  }

  if (p === '/api/wellness/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, origin, { 'Set-Cookie': buildClearCookie() });
  }

  return sendJson(res, 404, { ok: false, reason: 'unknown_wellness_route' }, origin);
}

export { handle };
