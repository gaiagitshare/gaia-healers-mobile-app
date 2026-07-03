/**
 * Gaia — Admin router (self-contained, additive).
 *
 * Powers the in-app Admin panel: events, announcements, and member lookup /
 * tag editing. Persists events + announcements to JSON files the proxy owns
 * (./data/*.json) so what an operator publishes feeds the app via
 * /api/app/bootstrap (gaia.announcements / gaia.adminEvents).
 *
 * Auth: a separate signed cookie (gaia_admin), gated by GAIA_ADMIN_PASSWORD.
 * If that env var is unset, admin is DISABLED (never a default password).
 *
 * All request/crypto/GHL helpers are INJECTED by server.js (deps) so this file
 * stays decoupled from the big server module and safe to drop onto prod.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADMIN_COOKIE = process.env.GAIA_ADMIN_COOKIE || 'gaia_admin';
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const DATA_DIR = path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'admin-events.json');
const CONTENT_FILE = path.join(DATA_DIR, 'admin-content.json');

// ---------- tiny JSON store ----------
function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* ignore */ } }
function readStore(file) {
  try { const raw = fs.readFileSync(file, 'utf8'); const d = JSON.parse(raw); return Array.isArray(d) ? d : []; }
  catch (_) { return []; }
}
function writeStore(file, list) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

function id() { return 'a' + crypto.randomBytes(8).toString('hex'); }
function nowIso() { return new Date().toISOString(); }
function str(v, max = 500) { return String(v == null ? '' : v).slice(0, max); }
// eslint-disable-next-line no-control-regex
function clean(v, max) { return str(v, max).replace(/[\x00-\x1F\x7F]/g, '').trim(); }

// ---------- admin auth ----------
function adminConfigured() { return Boolean(String(process.env.GAIA_ADMIN_PASSWORD || '').trim()); }

function passwordOk(input) {
  const secret = String(process.env.GAIA_ADMIN_PASSWORD || '');
  if (!secret) return false;
  const a = Buffer.from(String(input || ''), 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function adminCookieFromReq(req, deps) {
  const cookies = deps.parseCookies(req.headers.cookie || '');
  const payload = deps.readSignedToken(cookies[ADMIN_COOKIE] || '');
  return payload && payload.role === 'admin' ? payload : null;
}

function buildAdminSetCookie(value, expiresAtMs) {
  return [
    `${ADMIN_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=None', 'Secure',
    `Max-Age=${Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000))}`,
  ].join('; ');
}
function buildAdminClearCookie() {
  return [`${ADMIN_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=None', 'Secure', 'Max-Age=0'].join('; ');
}

// ---------- normalizers ----------
function normalizeEvent(input = {}, existing = {}) {
  return {
    id: existing.id || id(),
    title: clean(input.title, 160),
    date: clean(input.date, 60),          // free-text or ISO; shown as-is
    venue: clean(input.venue, 160),
    registerUrl: clean(input.registerUrl, 500),
    summary: clean(input.summary, 600),
    live: Boolean(input.live),            // "happening now" flag
    published: input.published !== false, // default published
    featured: Boolean(input.featured),    // becomes the Home event card
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}
function normalizeAnnouncement(input = {}, existing = {}) {
  return {
    id: existing.id || id(),
    title: clean(input.title, 160),
    body: clean(input.body, 800),
    link: clean(input.link, 500),
    tone: ['info', 'success', 'warn'].includes(input.tone) ? input.tone : 'info',
    published: input.published !== false,
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

// ---------- public feeds (consumed by /api/app/bootstrap) ----------
function publishedAnnouncements() {
  return readStore(CONTENT_FILE)
    .filter((a) => a.published)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((a) => ({ id: a.id, title: a.title, body: a.body, link: a.link, tone: a.tone }));
}
function publishedEvents() {
  return readStore(EVENTS_FILE)
    .filter((e) => e.published)
    .map((e) => ({ id: e.id, title: e.title, date: e.date, venue: e.venue, registerUrl: e.registerUrl, summary: e.summary, live: e.live, featured: e.featured }));
}

// ---------- GHL members (read + guarded write) ----------
async function searchMembers(q, deps) {
  const cfg = deps.ghlConfig();
  if (!cfg.enabled) return { ok: false, reason: 'ghl_unconfigured', members: [] };
  const data = await deps.ghlGet('/contacts/', { locationId: cfg.locationId, query: q, limit: 20 }).catch(() => null);
  const contacts = (data && (data.contacts || data.contact)) || [];
  const members = (Array.isArray(contacts) ? contacts : []).map((c) => ({
    id: c.id || c.contactId || '',
    name: (c.contactName || `${c.firstName || ''} ${c.lastName || ''}`).trim() || c.email || 'Contact',
    email: c.email || '',
    tags: Array.isArray(c.tags) ? c.tags : [],
  }));
  return { ok: true, members };
}
async function getMember(cid, deps) {
  const data = await deps.ghlGet(`/contacts/${encodeURIComponent(cid)}`).catch(() => null);
  const c = (data && (data.contact || data)) || {};
  if (!c.id && !c.email) return { ok: false, reason: 'not_found' };
  return {
    ok: true,
    member: {
      id: c.id || cid,
      name: (c.contactName || `${c.firstName || ''} ${c.lastName || ''}`).trim() || c.email || 'Contact',
      email: c.email || '',
      tags: Array.isArray(c.tags) ? c.tags : [],
    },
  };
}
// Add / remove a tag. Requires the GHL PIT to carry contacts.write — until that
// scope is enabled these calls return 401/403, surfaced as scope_required.
async function writeTag(cid, tag, add, deps) {
  const cfg = deps.ghlConfig();
  if (!cfg.enabled) return { ok: false, reason: 'ghl_unconfigured' };
  const url = `${cfg.base}/contacts/${encodeURIComponent(cid)}/tags`;
  const method = add ? 'POST' : 'DELETE';
  try {
    const r = await fetch(url, {
      method,
      headers: { ...deps.ghlHeaders(cfg.token, cfg.version), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [tag] }),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'scope_required' };
    if (!r.ok) return { ok: false, reason: 'ghl_error', status: r.status };
    return { ok: true };
  } catch (e) { return { ok: false, reason: 'network', error: String(e && e.message || e) }; }
}

// ---------- main handler ----------
async function handle(req, res, url, deps) {
  const { origin, sendJson } = deps;
  const p = url.pathname.replace(/\/+$/, '') || url.pathname;
  const method = req.method;
  const authed = () => Boolean(adminCookieFromReq(req, deps));
  const need = () => { sendJson(res, 401, { ok: false, reason: 'admin_auth_required' }, origin); };

  // --- session / login / logout (public) ---
  if (p === '/api/admin/session' && method === 'GET') {
    return sendJson(res, 200, { ok: true, authed: authed(), configured: adminConfigured() }, origin);
  }
  if (p === '/api/admin/login' && method === 'POST') {
    if (!adminConfigured()) return sendJson(res, 200, { ok: false, reason: 'not_configured' }, origin);
    const body = await deps.readJsonBody(req).catch(() => ({}));
    if (!passwordOk(body && body.password)) return sendJson(res, 200, { ok: false, reason: 'bad_password' }, origin);
    const exp = Date.now() + ADMIN_TTL_MS;
    const token = deps.signTokenPayload({ role: 'admin', iat: Date.now(), exp });
    return sendJson(res, 200, { ok: true }, origin, { 'Set-Cookie': buildAdminSetCookie(token, exp) });
  }
  if (p === '/api/admin/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, origin, { 'Set-Cookie': buildAdminClearCookie() });
  }

  // --- everything below requires admin auth ---
  if (!authed()) return need();

  // Events
  if (p === '/api/admin/events' && method === 'GET') {
    return sendJson(res, 200, { ok: true, events: readStore(EVENTS_FILE) }, origin);
  }
  if (p === '/api/admin/events' && method === 'POST') {
    const body = await deps.readJsonBody(req).catch(() => ({}));
    const list = readStore(EVENTS_FILE);
    const existing = body.id ? list.find((e) => e.id === body.id) : null;
    const ev = normalizeEvent(body, existing || {});
    if (!ev.title) return sendJson(res, 200, { ok: false, reason: 'title_required' }, origin);
    // one featured event max — clear others if this one is featured
    let next = existing ? list.map((e) => (e.id === ev.id ? ev : e)) : [ev, ...list];
    if (ev.featured) next = next.map((e) => (e.id === ev.id ? e : { ...e, featured: false }));
    writeStore(EVENTS_FILE, next);
    return sendJson(res, 200, { ok: true, event: ev }, origin);
  }
  if (p === '/api/admin/events' && method === 'DELETE') {
    const key = url.searchParams.get('id') || '';
    writeStore(EVENTS_FILE, readStore(EVENTS_FILE).filter((e) => e.id !== key));
    return sendJson(res, 200, { ok: true }, origin);
  }

  // Content / announcements
  if (p === '/api/admin/content' && method === 'GET') {
    return sendJson(res, 200, { ok: true, announcements: readStore(CONTENT_FILE) }, origin);
  }
  if (p === '/api/admin/content' && method === 'POST') {
    const body = await deps.readJsonBody(req).catch(() => ({}));
    const list = readStore(CONTENT_FILE);
    const existing = body.id ? list.find((a) => a.id === body.id) : null;
    const a = normalizeAnnouncement(body, existing || {});
    if (!a.title) return sendJson(res, 200, { ok: false, reason: 'title_required' }, origin);
    const next = existing ? list.map((x) => (x.id === a.id ? a : x)) : [a, ...list];
    writeStore(CONTENT_FILE, next);
    return sendJson(res, 200, { ok: true, announcement: a }, origin);
  }
  if (p === '/api/admin/content' && method === 'DELETE') {
    const key = url.searchParams.get('id') || '';
    writeStore(CONTENT_FILE, readStore(CONTENT_FILE).filter((a) => a.id !== key));
    return sendJson(res, 200, { ok: true }, origin);
  }

  // Members (read via GHL; tag write guarded on contacts.write scope)
  if (p === '/api/admin/members/search' && method === 'GET') {
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) return sendJson(res, 200, { ok: true, members: [] }, origin);
    return sendJson(res, 200, await searchMembers(q.trim(), deps), origin);
  }
  if (p === '/api/admin/members/get' && method === 'GET') {
    const cid = url.searchParams.get('id') || '';
    if (!cid) return sendJson(res, 200, { ok: false, reason: 'id_required' }, origin);
    return sendJson(res, 200, await getMember(cid, deps), origin);
  }
  if (p === '/api/admin/members/tags' && method === 'POST') {
    const body = await deps.readJsonBody(req).catch(() => ({}));
    const cid = str(body.contactId, 80);
    const tag = clean(body.tag, 80);
    if (!cid || !tag) return sendJson(res, 200, { ok: false, reason: 'params_required' }, origin);
    const result = await writeTag(cid, tag, body.add !== false, deps);
    return sendJson(res, 200, result, origin);
  }

  return sendJson(res, 404, { ok: false, reason: 'unknown_admin_route' }, origin);
}

export { handle, publishedAnnouncements, publishedEvents };
