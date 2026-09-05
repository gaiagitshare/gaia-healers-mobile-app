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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as membershipAdmin from './membership/admin-api.js';
import * as alerts from './alerts.js';

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

// ---------- login throttle (per client IP) ----------
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15m
const LOGIN_MAX_ATTEMPTS = 8;           // failures per window before lockout
const loginAttempts = new Map();        // ip -> { count, firstAt }

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return String(req.headers['cf-connecting-ip'] || '').trim() || fwd || req.socket?.remoteAddress || 'unknown';
}

function loginBlockedFor(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return 0;
  const age = Date.now() - rec.firstAt;
  if (age >= LOGIN_WINDOW_MS) { loginAttempts.delete(ip); return 0; }
  if (rec.count < LOGIN_MAX_ATTEMPTS) return 0;
  return Math.ceil((LOGIN_WINDOW_MS - age) / 1000);
}

function noteLoginFailure(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.firstAt >= LOGIN_WINDOW_MS) loginAttempts.set(ip, { count: 1, firstAt: now });
  else rec.count += 1;
  // keep the map small; drop anything already outside its window
  if (loginAttempts.size > 500) {
    for (const [key, val] of loginAttempts) if (now - val.firstAt >= LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
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
  const timelineInput = Array.isArray(input.timeline) ? input.timeline : [];
  const timeline = timelineInput.slice(0, 40).map((item) => ({
    time: clean(item && item.time, 40),
    title: clean(item && item.title, 140),
    detail: clean(item && item.detail, 260),
  })).filter((item) => item.time || item.title || item.detail);
  return {
    id: existing.id || id(),
    title: clean(input.title, 160),
    date: clean(input.date, 60),          // free-text or ISO; shown as-is
    venue: clean(input.venue, 160),
    registerUrl: clean(input.registerUrl, 500),
    summary: clean(input.summary, 600),
    timeline,
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
    .map((e) => ({ id: e.id, title: e.title, date: e.date, venue: e.venue, registerUrl: e.registerUrl, summary: e.summary, timeline: Array.isArray(e.timeline) ? e.timeline : [], live: e.live, featured: e.featured }));
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
// ---------- Gaia Admin: Contacts + Surveys (GHL PIT) ----------
let _cfMapCache = null, _cfMapAt = 0;
async function loadCustomFieldMap(deps) {
  const cfg = deps.ghlConfig();
  if (!cfg.enabled) return {};
  if (_cfMapCache && Date.now() - _cfMapAt < 10 * 60 * 1000) return _cfMapCache;
  const data = await deps.ghlGet(`/locations/${cfg.locationId}/customFields`).catch(() => null);
  const fields = (data && (data.customFields || data.customField || data.fields)) || [];
  const map = {};
  for (const f of fields) if (f && f.id) map[f.id] = { name: f.name || f.fieldKey || f.id, key: f.fieldKey || '', type: f.dataType || f.type || '' };
  _cfMapCache = map; _cfMapAt = Date.now();
  return map;
}
function contactName(c) { return (c.contactName || `${c.firstName || ''} ${c.lastName || ''}`).trim() || c.email || 'Contact'; }
async function ghlSearchContacts(cfg, deps, body) {
  try {
    const r = await fetch(`${cfg.base}/contacts/search`, { method: 'POST', headers: { ...deps.ghlHeaders(cfg.token, cfg.version), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}
async function listContacts(params, deps) {
  const cfg = deps.ghlConfig();
  if (!cfg.enabled) return { ok: false, reason: 'ghl_unconfigured', contacts: [] };
  const limit = Math.min(50, Math.max(1, parseInt(params.limit, 10) || 25));
  const body = { locationId: cfg.locationId, pageLimit: limit };
  if (params.tag) body.filters = [{ field: 'tags', operator: 'contains', value: String(params.tag) }];
  if (params.query) body.query = String(params.query);
  if (params.after) { try { body.searchAfter = JSON.parse(params.after); } catch (_) {} }
  const data = await ghlSearchContacts(cfg, deps, body);
  if (!data) return { ok: false, reason: 'ghl_error', contacts: [] };
  const list = data.contacts || data.data || [];
  const contacts = list.map((c) => ({ id: c.id, name: contactName(c), email: c.email || '', phone: c.phone || '', tagCount: (c.tags || []).length, tags: c.tags || [] }));
  const last = list[list.length - 1];
  return { ok: true, total: data.total != null ? data.total : null, count: contacts.length, contacts, next: (last && last.searchAfter) ? JSON.stringify(last.searchAfter) : null };
}
async function listContactsAdvanced(body, deps) {
  const cfg = deps.ghlConfig();
  if (!cfg.enabled) return { ok: false, reason: 'ghl_unconfigured', contacts: [] };
  const limit = Math.min(50, Math.max(1, parseInt(body.limit, 10) || 30));
  const q = { locationId: cfg.locationId, pageLimit: limit };
  const filters = [];
  // groups: array of tag-arrays. Within a group => OR (GHL contains + array value).
  // Across groups => AND (separate filter entries).
  (Array.isArray(body.groups) ? body.groups : []).forEach(function (g) {
    var arr = (Array.isArray(g) ? g : [g]).map(function (x) { return String(x || '').trim(); }).filter(Boolean);
    if (arr.length) filters.push({ field: 'tags', operator: 'contains', value: arr.length === 1 ? arr[0] : arr });
  });
  if (body.source) filters.push({ field: 'source', operator: 'eq', value: String(body.source) });
  if (filters.length) q.filters = filters;
  if (body.query) q.query = String(body.query);
  if (body.after) { try { q.searchAfter = typeof body.after === 'string' ? JSON.parse(body.after) : body.after; } catch (_) {} }
  const data = await ghlSearchContacts(cfg, deps, q);
  if (!data) return { ok: false, reason: 'ghl_error', contacts: [] };
  const list = data.contacts || data.data || [];
  const contacts = list.map(function (c) { return { id: c.id, name: contactName(c), email: c.email || '', phone: c.phone || '', tagCount: (c.tags || []).length, tags: c.tags || [] }; });
  const last = list[list.length - 1];
  return { ok: true, total: data.total != null ? data.total : null, count: contacts.length, contacts: contacts, next: (last && last.searchAfter) ? JSON.stringify(last.searchAfter) : null };
}
function normSub(s) {
  if (!s) return null;
  var rp = s.recurringProduct || {};
  var interval = (rp.price && rp.price.recurring && rp.price.recurring.interval) || '';
  return {
    status: s.status || '',
    amount: (s.amount != null ? s.amount : null),
    currency: (s.currency || '').toUpperCase(),
    interval: interval,
    product: (s.lineItemDetails && s.lineItemDetails.name) || (rp.product && rp.product.name) || '',
    startedAt: s.subscriptionStartDate || s.createdAt || '',
    trialEndAt: s.trialEndDate || '',
    updatedAt: s.updatedAt || '',
  };
}
var _subCache = { at: 0, byContact: null, summary: null };
async function loadSubscriptions(deps) {
  var now = Date.now();
  if (_subCache.byContact && (now - _subCache.at) < 5 * 60 * 1000) return _subCache;
  var cfg = deps.ghlConfig();
  var empty = { at: now, byContact: {}, summary: { total: 0, active: 0, canceled: 0, expired: 0, other: 0 }, list: [] };
  if (!cfg.enabled) return empty;
  var all = [], off = 0, guard = 0;
  while (guard < 20) {
    guard++;
    var r = await deps.ghlGet('/payments/subscriptions', { altId: cfg.locationId, altType: 'location', limit: 100, offset: off }).catch(function () { return null; });
    var arr = (r && (r.data || r.subscriptions)) || [];
    if (!arr.length) break;
    all = all.concat(arr);
    off += 100;
    if (arr.length < 100) break;
  }
  var rank = { active: 4, trialing: 3, past_due: 2, unpaid: 1, canceled: 0, incomplete_expired: 0, incomplete: 0 };
  var best = {}, summary = { total: all.length, active: 0, canceled: 0, expired: 0, other: 0 };
  all.forEach(function (s) {
    var id = s.contactId;
    if (id) { if (!best[id] || (rank[s.status] || 0) > (rank[best[id].status] || 0)) best[id] = s; }
    if (s.status === 'active') summary.active++;
    else if (s.status === 'canceled') summary.canceled++;
    else if (s.status === 'incomplete_expired' || s.status === 'expired') summary.expired++;
    else summary.other++;
  });
  var byContact = {};
  Object.keys(best).forEach(function (id) { byContact[id] = normSub(best[id]); });
  var list = all.map(function (s) { var n = normSub(s); n.contactId = s.contactId || ''; n.name = s.contactName || ''; n.email = s.contactEmail || ''; n.phone = s.contactPhone || ''; return n; });
  _subCache = { at: now, byContact: byContact, summary: summary, list: list };
  return _subCache;
}
async function contactBilling(cid, deps) {
  var cfg = deps.ghlConfig();
  if (!cfg.enabled) return { subscriptions: [], orders: [], transactions: [], totalPaid: 0, totalRefunded: 0, orderCount: 0, txCount: 0 };
  var L = cfg.locationId;
  var subsR = await deps.ghlGet('/payments/subscriptions', { altId: L, altType: 'location', contactId: cid, limit: 50 }).catch(function () { return null; });
  var ordR = await deps.ghlGet('/payments/orders', { altId: L, altType: 'location', contactId: cid, limit: 50 }).catch(function () { return null; });
  var txR = await deps.ghlGet('/payments/transactions', { altId: L, altType: 'location', contactId: cid, limit: 50 }).catch(function () { return null; });
  var subs = (((subsR && subsR.data) || [])).map(normSub);
  var orders = (((ordR && ordR.data) || [])).map(function (o) {
    var prods = Array.isArray(o.onetimeProducts) ? o.onetimeProducts.map(function (p) { return p && (p.name || p.productName || p.title); }).filter(Boolean) : [];
    return { amount: (o.amount != null ? o.amount : null), currency: (o.currency || '').toUpperCase(), status: o.status || o.paymentStatus || '', product: prods.join(', ') || o.sourceName || o.sourceType || '', source: o.sourceType || '', createdAt: o.createdAt || '' };
  });
  orders.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
  var totalPaid = 0, totalRefunded = 0;
  var transactions = (((txR && txR.data) || [])).map(function (t) {
    var amt = (typeof t.amount === 'number') ? t.amount : 0;
    var ref = (typeof t.amountRefunded === 'number') ? t.amountRefunded : 0;
    var st = (t.status || t.paymentStatus || '').toLowerCase();
    if (st === 'succeeded' || st === 'completed' || st === 'success' || st === 'paid') { totalPaid += amt; totalRefunded += ref; }
    return { amount: (t.amount != null ? t.amount : null), currency: (t.currency || '').toUpperCase(), status: t.status || '', refunded: ref || 0, product: t.entitySourceName || t.entityType || '', createdAt: t.createdAt || '' };
  });
  transactions.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
  return { subscriptions: subs, orders: orders, transactions: transactions, totalPaid: totalPaid, totalRefunded: totalRefunded, orderCount: orders.length, txCount: transactions.length };
}

async function contactDetail(cid, deps) {
  const data = await deps.ghlGet(`/contacts/${encodeURIComponent(cid)}`).catch(() => null);
  const c = (data && (data.contact || data)) || {};
  if (!c.id && !c.email) return { ok: false, reason: 'not_found' };
  const cfMap = await loadCustomFieldMap(deps);
  const rawCf = c.customFields || c.customField || [];
  const fields = rawCf.map((f) => {
    const def = cfMap[f.id] || {};
    let value = f.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) { const picked = Object.values(value).filter((x) => x !== '' && x != null); value = picked.length ? picked : ''; }
    return { id: f.id, name: def.name || f.id, value };
  }).filter((f) => f.value !== '' && f.value != null && !(Array.isArray(f.value) && !f.value.length));
  // Everything below is JOINED from its authoritative store at read time and
  // never copied onto the contact: the ledger owns entitlements, the Event
  // Manager owns attendance, GHL owns tags and fields.
  var membership = null, courses = [], entitlementCount = 0, audit = [];
  try {
    var led = deps.loadLedger && deps.loadLedger();
    var rec = led && led.contacts && led.contacts[c.id || cid];
    if (rec) {
      if (rec.membership) membership = rec.membership;
      courses = (rec.courses || []).map(function (x) {
        return { id: x.id, name: x.name, state: x.state, matchedBy: x.matchedBy, updatedAt: x.updatedAt };
      });
      entitlementCount = (rec.entitlements || []).length;
    }
    audit = ((led && led.auditLog) || []).filter(function (e) {
      return e && e.contactId === (c.id || cid);
    }).slice(-12).reverse();
  } catch (e) {}

  // A tier that rests only on a legacy GHL tag. Reported so an operator can see
  // it, kept apart from `membership` so it can never be read as billing
  // evidence — the resolver makes the same distinction for the app.
  var unverifiedTierTags = (Array.isArray(c.tags) ? c.tags : []).filter(function (t) {
    return /^(ahc|gaia|membership)[-_](free|silver|gold|diamond|trial)/i.test(String(t))
        || /^(silver|gold|diamond|free)-membership$/i.test(String(t));
  });

  var attendance = null;
  try {
    var evTok = String(process.env.IDENTITY_SERVICE_TOKEN || '').trim();
    if (evTok) {
      var ar = await fetch('http://127.0.0.1:8002/identity/attendees-by-contact?contact_id='
        + encodeURIComponent(c.id || cid), { headers: { Authorization: 'Bearer ' + evTok } });
      if (ar.ok) attendance = await ar.json();
    }
  } catch (e) { attendance = null; }
  var subscription = null;
  try { var subs = await loadSubscriptions(deps); subscription = subs.byContact[c.id || cid] || null; } catch (e) {}
  var billing = null;
  try { billing = await contactBilling(c.id || cid, deps); } catch (e) {}
  return { ok: true, contact: {
    id: c.id || cid, name: contactName(c), email: c.email || '', phone: c.phone || '',
    tags: Array.isArray(c.tags) ? c.tags : [], fields, membership: membership, subscription: subscription, billing: billing,
    courses: courses, entitlementCount: entitlementCount, audit: audit,
    unverifiedTierTags: unverifiedTierTags, attendance: attendance,
    source: c.source || '', dateAdded: c.dateAdded || '', country: c.country || '', city: c.city || '', state: c.state || '',
  } };
}
async function exportContacts(body, deps) {
  const cfg = deps.ghlConfig();
  if (!cfg.enabled) return { ok: false, reason: 'ghl_unconfigured' };
  const CAP = 5000;
  const base = { locationId: cfg.locationId, pageLimit: 100 };
  const filters = [];
  (Array.isArray(body.groups) ? body.groups : []).forEach(function (g) { var arr = (Array.isArray(g) ? g : [g]).map(function (x) { return String(x || '').trim(); }).filter(Boolean); if (arr.length) filters.push({ field: 'tags', operator: 'contains', value: arr.length === 1 ? arr[0] : arr }); });
  if (body.source) filters.push({ field: 'source', operator: 'eq', value: String(body.source) });
  if (filters.length) base.filters = filters;
  if (body.query) base.query = String(body.query);
  const rows = []; let after = null, guard = 0;
  while (rows.length < CAP && guard < 60) {
    guard++;
    const q = Object.assign({}, base); if (after) q.searchAfter = after;
    const data = await ghlSearchContacts(cfg, deps, q);
    if (!data) break;
    const list = data.contacts || data.data || [];
    if (!list.length) break;
    for (const c of list) rows.push([contactName(c), c.email || '', c.phone || '', c.country || '', c.dateAdded || '', (c.tags || []).join('; ')]);
    const last = list[list.length - 1]; after = last && last.searchAfter; if (!after) break;
  }
  const q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
  const head = ['Name', 'Email', 'Phone', 'Country', 'Date added', 'Tags'].map(q).join(',');
  const csv = [head].concat(rows.map(function (r) { return r.map(q).join(','); })).join('\r\n');
  return { ok: true, csv: csv, count: rows.length, capped: rows.length >= CAP };
}
var _sysMapCache = { at: 0, data: null };

/* ─────────────────────────────────────────────────────────────────────────────
 * Pipeline health, from evidence only.
 *
 * Every field here is something that was actually observed: a timestamp written
 * by a job, a row counted in a store, a socket that opened. Nothing returns
 * "Healthy" because a service is supposed to exist. Where there is no evidence
 * the answer is `unknown`, and the UI says so — a green badge that cannot be
 * traced to an observation is worse than no badge, because it is trusted.
 *
 * `state` is one of:
 *   ok        — observed recently enough for this component's own cadence
 *   stale     — observed, but longer ago than it should be
 *   idle      — working and simply has had nothing to do (a real, distinct state)
 *   unknown   — no evidence either way; never guessed
 *   error     — an observation exists and it is a failure
 * ────────────────────────────────────────────────────────────────────────── */

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = (v) => { try { return v ? new Date(v).toISOString() : null; } catch (_) { return null; } };
const ageMs = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? Date.now() - t : null; };

/** Newest mtime under a data file, as evidence a writer is still running. */
function fileSeen(file) {
  try { return { at: new Date(fs.statSync(file).mtimeMs).toISOString(), bytes: fs.statSync(file).size }; }
  catch (_) { return { at: null, bytes: null }; }
}

/** Ask systemd what it knows. A timer that has never run is evidence too. */
function unitState(unit) {
  try {
    const out = execFileSync('systemctl', ['show', unit, '--property=ActiveState,Result,ExecMainExitTimestamp'],
      { encoding: 'utf8', timeout: 4000 });
    const kv = Object.fromEntries(out.trim().split('\n').map((l) => l.split('=')));
    return { active: kv.ActiveState || null, result: kv.Result || null, lastExit: kv.ExecMainExitTimestamp || null };
  } catch (_) { return { active: null, result: null, lastExit: null }; }
}

function showUnit(unit, props) {
  try {
    // `--timestamp=unix` renders every timestamp as @<epoch-seconds>. Without
    // it systemd prints "Sat 2026-09-05 14:33:41 CEST", which Date.parse
    // rejects outright — every timestamp came back null and every job read
    // "unknown" while systemd knew perfectly well when it had run.
    const out = execFileSync('systemctl',
      ['show', unit, '--timestamp=unix', '--property=' + props.join(',')],
      { encoding: 'utf8', timeout: 4000 });
    const kv = {};
    for (const line of out.trim().split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
    }
    return kv;
  } catch (_) { return {}; }
}
const stamp = (v) => {
  if (!v || v === 'n/a' || v === '0') return null;
  const s = String(v).trim();
  if (s.startsWith('@')) {                       // @epoch-seconds, from --timestamp=unix
    const n = Number(s.slice(1));
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
  }
  if (/^\d+$/.test(s)) {                         // *USec properties: microseconds
    const n = Number(s);
    return n > 0 ? new Date(Math.round(n / 1000)).toISOString() : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * Where the observed run history lives.
 *
 * systemd keeps only the MOST RECENT run of a oneshot: its start, its exit and
 * whether it succeeded. That is real evidence and it is what the state below is
 * built from — but it cannot answer "when did this last SUCCEED" once a later
 * run has failed and overwritten it. So each observation is also appended here,
 * and the two are reported separately: `lastRun*` is systemd's own record,
 * `lastSuccessAt` / `lastFailureAt` are what Gaia has watched happen. Sampled,
 * and labelled as sampled, rather than presented as a complete log.
 */
function jobObservationsFile() {
  return path.join(process.cwd(), 'data', 'job-observations.json');
}
function readJobObservations() {
  try { return JSON.parse(fs.readFileSync(jobObservationsFile(), 'utf8')) || {}; } catch (_) { return {}; }
}
function recordJobObservation(unit, { exitAt, ok }) {
  if (!exitAt) return readJobObservations()[unit] || {};
  const all = readJobObservations();
  const cur = all[unit] || {};
  // Only a run we have not already filed. Re-reading the same exit timestamp
  // must not look like a fresh run.
  if (cur.lastSeenExitAt === exitAt) return cur;
  cur.lastSeenExitAt = exitAt;
  if (ok) cur.lastSuccessAt = exitAt; else cur.lastFailureAt = exitAt;
  all[unit] = cur;
  try {
    fs.mkdirSync(path.dirname(jobObservationsFile()), { recursive: true });
    fs.writeFileSync(jobObservationsFile(), JSON.stringify(all, null, 1));
  } catch (_) { /* observation is best-effort; never break the health read */ }
  return cur;
}

/**
 * A scheduled job's health, from systemd's own record of it.
 *
 * `Result=success` on a run that finished an hour ago is evidence. A timer that
 * merely EXISTS is not, and never produces `ok` here.
 */
function jobHealth({ key, label, service, timer, okWithin, cadence }) {
  const svc = showUnit(service, ['ActiveState', 'SubState', 'Result', 'ExecMainStartTimestamp',
    'ExecMainExitTimestamp', 'ExecMainStatus']);
  const tmr = showUnit(timer, ['ActiveState', 'NextElapseUSecRealtime', 'LastTriggerUSec']);
  // A calendar timer reports NextElapseUSecRealtime; a monotonic one (OnUnitActiveSec)
  // reports only a duration since boot, which is useless as a wall clock. list-timers
  // resolves both to an absolute microsecond stamp, so it is the fallback.
  let nextFromList = null;
  if (!stamp(tmr.NextElapseUSecRealtime)) {
    try {
      const raw = execFileSync('systemctl',
        ['list-timers', timer, '--output=json', '--no-pager'], { encoding: 'utf8', timeout: 4000 });
      const rows = JSON.parse(raw);
      if (Array.isArray(rows) && rows[0] && rows[0].next) nextFromList = String(rows[0].next);
    } catch (_) { /* leave unknown rather than invent one */ }
  }
  const startedAt = stamp(svc.ExecMainStartTimestamp);
  const exitedAt = stamp(svc.ExecMainExitTimestamp);
  const result = svc.Result || null;
  const exitCode = (svc.ExecMainStatus === '' || svc.ExecMainStatus == null) ? null : Number(svc.ExecMainStatus);
  const succeeded = result === 'success' && (exitCode === 0 || exitCode === null);
  const running = svc.ActiveState === 'activating'
    || (svc.ActiveState === 'active' && svc.SubState !== 'exited');

  const obs = recordJobObservation(service, { exitAt: exitedAt, ok: succeeded });

  let state;
  if (running) state = 'running';
  else if (!exitedAt && !startedAt) state = 'unknown';       // never observed running
  else if (!succeeded) state = 'failed';
  else {
    const age = ageMs(exitedAt);
    state = (age != null && age <= okWithin) ? 'ok' : 'stale';
  }

  return {
    key, label, kind: 'job', state,
    ageMs: ageMs(exitedAt),
    lastStartAt: startedAt,
    lastRunAt: exitedAt,
    lastRunResult: result,
    lastRunExitCode: exitCode,
    lastSuccessAt: obs.lastSuccessAt || (succeeded ? exitedAt : null),
    lastFailureAt: obs.lastFailureAt || (!succeeded && exitedAt ? exitedAt : null),
    nextRunAt: stamp(tmr.NextElapseUSecRealtime) || stamp(nextFromList),
    timer: tmr.ActiveState || null,
    cadence,
    evidence: 'systemd unit record (Result, ExecMainStart/ExitTimestamp, exit code) + observed run history',
  };
}

function grade(lastAt, { okWithin, staleAfter, idleReason = null }) {
  const age = ageMs(lastAt);
  if (age == null) return { state: idleReason ? 'idle' : 'unknown', ageMs: null };
  if (age <= okWithin) return { state: 'ok', ageMs: age };
  if (age <= staleAfter) return { state: idleReason ? 'idle' : 'stale', ageMs: age };
  return { state: idleReason ? 'idle' : 'stale', ageMs: age };
}

async function pipelineHealth(deps) {
  const out = { generatedAt: new Date().toISOString(), components: [] };
  const add = (c) => out.components.push(c);
  let led = null;
  try { led = deps.loadLedger && deps.loadLedger(); } catch (_) { led = null; }
  const contacts = (led && led.contacts) || {};
  const sources = (led && led.sources) || {};

  // ── Entitlement ledger ────────────────────────────────────────────────────
  const ledgerFile = fileSeen(process.env.MEMBER_ENTITLEMENTS_FILE
    || path.join(process.cwd(), 'data', 'member-entitlements.json'));
  const ids = Object.keys(contacts);
  let courseGrants = 0, memberships = 0, lastCourseAt = null, lastWebhookGrantAt = null;
  for (const id of ids) {
    const rec = contacts[id] || {};
    if (rec.membership) memberships++;
    for (const c of (rec.courses || [])) {
      courseGrants++;
      if (c.updatedAt && (!lastCourseAt || c.updatedAt > lastCourseAt)) lastCourseAt = c.updatedAt;
      if (/webhook/i.test(String(c.matchedBy || '')) && c.updatedAt
          && (!lastWebhookGrantAt || c.updatedAt > lastWebhookGrantAt)) lastWebhookGrantAt = c.updatedAt;
    }
  }
  add({
    key: 'entitlement_ledger', label: 'Entitlement ledger', kind: 'store',
    ...grade(ledgerFile.at, { okWithin: 2 * DAY, staleAfter: 14 * DAY }),
    lastWriteAt: iso(ledgerFile.at),
    counts: { contacts: ids.length, memberships, courseGrants },
    evidence: 'file mtime + record counts',
  });

  // ── Course entitlement webhook ────────────────────────────────────────────
  // One green/red light cannot tell an operator what to DO. These are the
  // failure classes that need different responses: a signature problem is a
  // credentials job, an unmapped course is a catalogue job, an unresolved
  // contact is an identity job, a failed write is an infrastructure job — and
  // silence with nothing sold is not a problem at all.
  const courseSrc = sources.ghl_course || {};
  let tele = {};
  try {
    const tf = process.env.WEBHOOK_TELEMETRY_FILE
      || path.join(path.dirname(process.env.MEMBER_ENTITLEMENTS_FILE
        || path.join(process.cwd(), 'data', 'member-entitlements.json')), 'webhook-telemetry.json');
    tele = (JSON.parse(fs.readFileSync(tf, 'utf8')) || {}).member_access || {};
  } catch (_) { tele = {}; }
  const c = tele.counters || {};

  // Newest evidence of each kind.
  const lastAccepted = tele.lastAcceptedAt || lastWebhookGrantAt || null;
  const lastRejected = tele.lastRejectedAt || null;
  const RECENT = 7 * DAY;
  const acceptedAge = ageMs(lastAccepted);
  const rejectedAge = ageMs(lastRejected);
  const rejectionIsCurrent = rejectedAge != null
    && rejectedAge <= RECENT
    && (acceptedAge == null || rejectedAge < acceptedAge);

  let webhookState, detail;
  if (rejectionIsCurrent) {
    // The most recent thing that happened was a refusal. Which kind decides
    // both the state and who needs to look at it.
    const kind = tele.lastRejectionKind;
    if (kind === 'rejected_auth') {
      webhookState = 'auth_failure';
      detail = 'A delivery arrived but its signature or shared secret did not verify. Check the webhook credentials in GHL.';
    } else if (kind === 'unknown_resource') {
      webhookState = 'mapping_failure';
      detail = 'An authenticated delivery arrived for a course or product Gaia could not resolve. Check the course authority and offer mapping.';
    } else if (kind === 'unknown_contact') {
      webhookState = 'identity_failure';
      detail = 'A valid course event arrived without a contact Gaia could resolve safely. Nothing was granted.';
    } else if (tele.lastRejectionReason === 'persistence_failed') {
      webhookState = 'processing_failure';
      detail = 'The event was valid and the ledger write failed. This is the one class that loses a grant.';
    } else if (kind === 'stale') {
      webhookState = 'ok';
      detail = 'The last delivery was an out-of-order replay and was correctly ignored.';
    } else {
      webhookState = 'stale';
      detail = 'The last delivery was refused: ' + (tele.lastRejectionReason || 'reason not recorded') + '.';
    }
  } else if (acceptedAge != null && acceptedAge <= RECENT) {
    webhookState = 'ok';
    detail = 'A course entitlement was granted from a live delivery within the last week.';
  } else if (!tele.lastReceivedAt && !lastAccepted) {
    webhookState = 'unknown';
    detail = 'No delivery has ever been observed by this monitor. It began recording on this deployment.';
  } else {
    webhookState = 'idle';
    detail = 'No applicable event recently, and no evidence of failure. Course grants only arrive when a course is actually sold.';
  }

  add({
    key: 'course_webhook', label: 'Course entitlement webhook', kind: 'webhook',
    state: webhookState, detail,
    ageMs: acceptedAge,
    lastWriteAt: iso(lastAccepted),
    lastReceivedAt: iso(tele.lastReceivedAt),
    lastAuthenticatedAt: iso(tele.lastAuthenticatedAt),
    lastAcceptedAt: iso(tele.lastAcceptedAt),
    lastGrantAt: iso(tele.lastGrantAt),
    lastRevokeAt: iso(tele.lastRevokeAt),
    lastRejectedAt: iso(tele.lastRejectedAt),
    lastRejectionReason: tele.lastRejectionReason || null,
    lastRejectionKind: tele.lastRejectionKind || null,
    counters: {
      received: c.received || 0, authenticated: c.authenticated || 0,
      rejected_auth: c.rejected_auth || 0, unknown_resource: c.unknown_resource || 0,
      unknown_contact: c.unknown_contact || 0, rejected_other: c.rejected_other || 0,
      accepted: c.accepted || 0, duplicate: c.duplicate || 0,
      grant: c.grant || 0, revoke: c.revoke || 0, stale: c.stale || 0,
    },
    telemetrySince: iso(tele.firstSeenAt),
    endpoint: '/api/webhooks/ghl/member-access',
    canonicalRoute: 'POST /api/webhooks/ghl/member-access',
    plannedAdapter: {
      source: 'ghl_course', state: courseSrc.state || 'unknown', implemented: false,
      note: 'Registry slot for a future adapter. No producer exists, so its counters stay at zero and mean nothing about the live route.',
    },
    historicGrantsFromWebhook: Object.keys(contacts).reduce((a, id) =>
      a + (contacts[id].courses || []).filter((x) => /webhook/i.test(String(x.matchedBy || ''))).length, 0),
    evidence: 'receiver telemetry (counters + per-decision timestamps) and the newest webhook-sourced grant in the ledger',
  });

  // ── Membership reconciliation ─────────────────────────────────────────────
  const memSrc = sources.ghl_membership || {};
  const memJob = jobHealth({
    key: 'membership_reconcile', label: 'Membership reconciliation',
    service: 'gaia-membership-reconcile.service', timer: 'gaia-membership-reconcile.timer',
    okWithin: 30 * MIN, cadence: 'every ~5 minutes',
  });
  add({
    ...memJob,
    // The sweep also files its own outcome in the source registry, which says
    // more than an exit code: it is kept alongside, not instead.
    registryLastRunAt: iso(memSrc.lastRunAt), lastOutcome: memSrc.lastRunOutcome || null,
    counts: memSrc.counters || null,
    // A snapshot source proposes for every contact it walks; the ones with no
    // membership to apply come back "rejected". That is the normal shape of a
    // 29k-contact sweep, not a failure, and the UI must not read it as one.
    countsNote: 'rejected = contacts walked with no membership to apply (normal for a snapshot sweep)',
    evidence: 'systemd unit record + source registry outcome',
  });

  // ── Event mirror ──────────────────────────────────────────────────────────
  add(jobHealth({
    key: 'event_mirror', label: 'Event order mirror',
    service: 'gaia-event-mirror.service', timer: 'gaia-event-mirror.timer',
    okWithin: 3 * HOUR, cadence: 'hourly',
  }));

  // ── Academy sync + backups ────────────────────────────────────────────────
  add(jobHealth({
    key: 'academy_sync', label: 'Academy catalogue sync',
    service: 'gaia-academy-sync.service', timer: 'gaia-academy-sync.timer',
    okWithin: 36 * HOUR, cadence: 'daily',
  }));
  // A backup job that exits 0 is not a backup. The artifact is checked too:
  // newest file, its age and its size. A truncated or missing archive turns the
  // component amber even when systemd is perfectly happy with the run.
  const backup = jobHealth({
    key: 'event_backup', label: 'Event database backup',
    service: 'gaia-event-backup.service', timer: 'gaia-event-backup.timer',
    okWithin: 36 * HOUR, cadence: 'daily',
  });
  try {
    const dir = process.env.EVENT_BACKUP_DIR || '/root/event/_backups';
    const files = fs.readdirSync(dir)
      .filter((f) => /^event-.*\.db\.gz$/.test(f))
      .map((f) => ({ f, st: fs.statSync(path.join(dir, f)) }))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    backup.artifactCount = files.length;
    if (files.length) {
      const newest = files[0];
      backup.latestArtifact = newest.f;
      backup.latestArtifactAt = new Date(newest.st.mtimeMs).toISOString();
      backup.latestArtifactBytes = newest.st.size;
      const artifactAge = ageMs(backup.latestArtifactAt);
      // An archive this small is not a database. Better to say so than to
      // inherit a green state from a job that technically exited cleanly.
      if (newest.st.size < 1024) {
        backup.state = 'failed';
        backup.detail = 'The newest backup archive is smaller than 1 KB — it is not a usable database.';
      } else if (artifactAge != null && artifactAge > 36 * HOUR) {
        backup.state = 'stale';
        backup.detail = 'The job may have run, but no fresh archive has appeared for over 36 hours.';
      } else {
        backup.detail = 'Newest archive is ' + Math.round(newest.st.size / 1024) + ' KB, written '
          + backup.latestArtifactAt.slice(0, 16).replace('T', ' ') + '. Contents verified separately; restore untested.';
      }
    } else {
      backup.state = 'failed';
      backup.detail = 'No backup archive found on disk, whatever the job reported.';
    }
    backup.evidence += ' + newest archive on disk (name, size, mtime)';
  } catch (_) {
    backup.detail = 'Could not read the backup directory, so the archive itself is unverified.';
    if (backup.state === 'ok') backup.state = 'unknown';
  }
  add(backup);

  // ── GHL reachability ──────────────────────────────────────────────────────
  const cfg = deps.ghlConfig();
  let ghl = { state: 'unknown', evidence: 'not configured' };
  if (cfg.enabled) {
    const t0 = Date.now();
    try {
      const r = await deps.ghlGet('/contacts/', { locationId: cfg.locationId, limit: 1 });
      ghl = { state: r ? 'ok' : 'error', ms: Date.now() - t0, evidence: 'live GET /contacts/ round-trip' };
    } catch (_) { ghl = { state: 'error', ms: Date.now() - t0, evidence: 'live GET /contacts/ failed' }; }
  }
  add({ key: 'ghl_api', label: 'GHL API', kind: 'service', lastWriteAt: null, ...ghl });

  // ── Event Manager ─────────────────────────────────────────────────────────
  let em = { state: 'unknown', evidence: 'no response' }, emCounts = null;
  try {
    const t0 = Date.now();
    // The app exposes no /health route; its schema document is the cheapest
    // thing that proves the process is up and serving.
    const r = await fetch('http://127.0.0.1:8002/openapi.json').catch(() => null);
    em = { state: r && r.ok ? 'ok' : 'error', ms: Date.now() - t0,
           evidence: 'HTTP probe of the Event Manager (/openapi.json)' };
  } catch (_) { /* leave unknown */ }
  add({ key: 'event_manager', label: 'Event Manager API', kind: 'service', ...em, counts: emCounts });

  return { ok: true, ...out };
}

/**
 * The evidence detection needs that health does not already carry.
 *
 * Two questions health cannot answer on its own: is anybody PAYING for a
 * membership they do not hold, and has money arrived for a ticket that does not
 * exist. Both compare two stores, so both live here rather than inside a health
 * component about a single service.
 */
async function alertExtras(deps) {
  const extra = { membershipExceptions: [], payments: null };

  // Paid, but no membership. The sweep can exit cleanly and still skip one
  // person; this is what would catch that. Evidence only — never a grant.
  try {
    const subs = await loadSubscriptions(deps);
    const led = deps.loadLedger && deps.loadLedger();
    const contacts = (led && led.contacts) || {};
    for (const sub of (subs.list || [])) {
      if (sub.status !== 'active') continue;
      const cid = sub.contactId;
      if (!cid) continue;
      const rec = contacts[cid];
      if (rec && rec.membership && rec.membership.status === 'active') continue;
      extra.membershipExceptions.push({
        contactId: cid,
        // GHL names this field differently across payloads; take whichever is
        // present so the alert can be traced back to a real subscription.
        subscriptionId: sub._id || sub.id || sub.subscriptionId || null,
        status: sub.status,
        amount: sub.amount != null ? sub.amount : null,
        email: sub.contactEmail || sub.email || '',
      });
    }
    // A cap, so one bad sweep cannot produce hundreds of incidents.
    extra.membershipExceptions = extra.membershipExceptions.slice(0, 25);
  } catch (_) { /* absence of evidence is not an alert */ }

  // Money in, nobody to admit — past a grace period, because a webhook and its
  // reconciliation are not simultaneous and a fresh purchase is not a fault.
  try {
    const GRACE_HOURS = 6;
    const evTok = String(process.env.IDENTITY_SERVICE_TOKEN || '').trim();
    if (evTok) {
      const r = await fetch('http://127.0.0.1:8002/identity/payment-exceptions?grace_hours=' + GRACE_HOURS,
        { headers: { Authorization: 'Bearer ' + evTok } });
      if (r.ok) {
        const d = await r.json();
        extra.payments = {
          graceHours: GRACE_HOURS,
          paidWithoutTicket: d.paid_without_ticket || 0,
          refundedStillActive: d.refunded_still_active || 0,
          unmatched: d.unmatched || 0,
          providers: d.providers || [],
          oldest: d.oldest || null,
          sample: d.sample || null,
        };
      }
    }
  } catch (_) { /* leave payments unevaluated rather than guess */ }

  return extra;
}

const ALERTS_FILE = () => path.join(process.cwd(), 'data', 'system-alerts.json');
function loadAlertStore() {
  try { return JSON.parse(fs.readFileSync(ALERTS_FILE(), 'utf8')) || { incidents: [] }; }
  catch (_) { return { incidents: [] }; }
}
function saveAlertStore(store) {
  try {
    fs.mkdirSync(path.dirname(ALERTS_FILE()), { recursive: true });
    fs.writeFileSync(ALERTS_FILE(), JSON.stringify(store, null, 1));
  } catch (_) { /* the incident is still in memory for this response */ }
}

/**
 * One pass: read health, detect, fold into incidents, send what is due.
 *
 * Safe to call as often as you like — that is the point of the incident model.
 * Ten failures of one problem produce one incident and one notification.
 */
export async function evaluateAlerts(deps, { notify = true } = {}) {
  const health = await pipelineHealth(deps);
  const extra = await alertExtras(deps);
  const detections = alerts.detect(health, extra);
  const store = loadAlertStore();
  const result = alerts.reconcile(store, detections);

  let delivered = 0, failed = 0;
  if (notify && typeof deps.sendAlertEmail === 'function') {
    for (const { incident, kind } of alerts.notificationsDue(store)) {
      const msg = alerts.renderNotification(incident, kind);
      let outcome;
      try { outcome = await deps.sendAlertEmail(msg); }
      catch (e) { outcome = { ok: false, reason: String((e && e.message) || e) }; }
      alerts.recordNotification(incident, kind, outcome);
      if (outcome && outcome.ok) delivered++; else failed++;
    }
  }
  saveAlertStore(store);
  return {
    ok: true, generatedAt: new Date().toISOString(),
    opened: result.opened.length, updated: result.updated.length, resolved: result.resolved.length,
    notificationsDelivered: delivered, notificationsFailed: failed,
    incidents: store.incidents,
  };
}

async function systemMap(deps) {
  if (_sysMapCache.data && (Date.now() - _sysMapCache.at) < 10 * 60 * 1000) return _sysMapCache.data;
  const cfg = deps.ghlConfig();
  const out = { ok: true, generatedAt: new Date().toISOString() };
  async function tagTotal(tag) { try { const d = await ghlSearchContacts(cfg, deps, { locationId: cfg.locationId, pageLimit: 1, filters: [{ field: 'tags', operator: 'contains', value: tag }] }); return (d && d.total != null) ? d.total : null; } catch (e) { return null; } }
  async function tagMemberIds(tag, cap) { const ids = []; let after = null, g = 0; while (ids.length < (cap || 400) && g < 8) { g++; const body = { locationId: cfg.locationId, pageLimit: 100, filters: [{ field: 'tags', operator: 'contains', value: tag }] }; if (after) body.searchAfter = after; const d = await ghlSearchContacts(cfg, deps, body); const list = (d && (d.contacts || d.data)) || []; if (!list.length) break; list.forEach((c) => ids.push(c.id)); const last = list[list.length - 1]; after = last && last.searchAfter; if (!after) break; } return ids; }
  try { const d = await ghlSearchContacts(cfg, deps, { locationId: cfg.locationId, pageLimit: 1 }); out.members = (d && d.total != null) ? d.total : null; } catch (e) { out.members = null; }
  out.tiers = { diamond: await tagTotal('ahc-diamond-active'), gold: await tagTotal('ahc-gold-active'), silver: await tagTotal('ahc-silver-active') };
  try {
    const subs = await loadSubscriptions(deps); out.subscriptions = subs.summary;
    const list = subs.list || []; const active = list.filter((x) => x.status === 'active');
    let mrr = 0; const bd = {};
    active.forEach((x) => { const amt = Number(x.amount) || 0; const yr = String(x.interval).indexOf('year') >= 0; mrr += yr ? amt / 12 : amt; const k = '$' + amt + (yr ? '/yr' : '/mo'); bd[k] = (bd[k] || 0) + 1; });
    out.revenue = { mrr: Math.round(mrr), activeCount: active.length, breakdown: Object.keys(bd).map((k) => ({ label: k, count: bd[k] })).sort((a, b) => b.count - a.count) };
    const activeSet = new Set(active.map((x) => x.contactId).filter(Boolean));
    async function payingFor(tag) { const ids = await tagMemberIds(tag, 300); return ids.filter((id) => activeSet.has(id)).length; }
    out.tierPaying = { gold: await payingFor('ahc-gold-active'), silver: await payingFor('ahc-silver-active'), diamond: await payingFor('ahc-diamond-active') };
  } catch (e) { out.subscriptions = null; }
  try { const sc = deps.loadStoreCatalog && deps.loadStoreCatalog(); out.products = (sc && sc.products) ? Object.keys(sc.products).length : null; } catch (e) { out.products = null; }
  try { const m = await fetch('http://127.0.0.1:8787/api/academy/manifest').then((r) => r.json()); out.courses = (m && m.courses ? m.courses.length : null); } catch (e) { out.courses = null; }
  try { const dr = await fetch('http://127.0.0.1:8787/api/directory').then((r) => r.json()); out.practitioners = (dr && (dr.count != null ? dr.count : (dr.practitioners || []).length)); } catch (e) { out.practitioners = null; }
  out.surveyComplete = await tagTotal('gaia_practitioner_form_complete');
  out.onboardingComplete = await tagTotal('gaia_app_onboarding_complete');
  const INT = [['biowell', 'Bio-Well'], ['biopulsar', 'BioPulsar'], ['biotekna', 'BioTekna'], ['braintap', 'BrainTap'], ['colourenergy', 'Colour Energy'], ['tachyon', 'Tachyon'], ['healy', 'Healy'], ['lifewave', 'LifeWave']];
  out.interests = []; for (const iv of INT) { const cnt = await tagTotal('product_' + iv[0] + '_interest'); if (cnt) out.interests.push({ label: iv[1], count: cnt }); }
  out.interests.sort((a, b) => b.count - a.count);
  const ST = [['prelaunch', 'Pre-launch'], ['early', 'Early'], ['growth', 'Growth'], ['established', 'Established'], ['scaling', 'Scaling'], ['mature', 'Mature']];
  out.stages = []; for (const sv of ST) { const cnt = await tagTotal('practice_stage_' + sv[0]); out.stages.push({ label: sv[1], count: cnt || 0 }); }
  const COM = [['biowell', 'Bio-Well'], ['biopulsar', 'BioPulsar'], ['biotekna', 'BioTekna'], ['braintap', 'BrainTap'], ['asea', 'ASEA'], ['lifewave', 'LifeWave']];
  out.communitiesList = []; for (const cv of COM) { const cnt = await tagTotal('community-' + cv[0] + '-member'); if (cnt) out.communitiesList.push({ label: cv[1], count: cnt }); }
  // The count is the list. This was hardcoded to 8 while the list beneath it
  // on the same card showed 3 — the only two numbers a reader can compare,
  // disagreeing. A community with no members is still a community, so this
  // counts the tags that were probed, not just the ones that came back.
  out.communitiesProbed = COM.length;
  out.communities = out.communitiesList.length;

  // The event side of the house. It was missing entirely: attendees, exhibitors
  // and the payment mirror are the busiest part of the system and the map that
  // claimed to show "the whole system" did not know they existed.
  try {
    const evTok = String(process.env.IDENTITY_SERVICE_TOKEN || '').trim();
    const r = evTok ? await fetch('http://127.0.0.1:8002/identity/system-summary',
      { headers: { Authorization: 'Bearer ' + evTok } }) : null;
    out.events = r && r.ok ? await r.json() : null;
  } catch (e) { out.events = null; }

  // Entitlements, counted from the ledger rather than described.
  try {
    const led = deps.loadLedger && deps.loadLedger();
    const cs = (led && led.contacts) || {};
    let memberships = 0, courseGrants = 0;
    for (const id of Object.keys(cs)) {
      if (cs[id].membership) memberships++;
      courseGrants += (cs[id].courses || []).length;
    }
    out.ledger = { contacts: Object.keys(cs).length, memberships, courseGrants };
  } catch (e) { out.ledger = null; }

  try { out.health = await pipelineHealth(deps); } catch (e) { out.health = null; }
  _sysMapCache = { at: Date.now(), data: out };
  return out;
}
async function listSurveys(deps) {
  const cfg = deps.ghlConfig();
  if (!cfg.enabled) return { ok: false, surveys: [] };
  const data = await deps.ghlGet(`/surveys/`, { locationId: cfg.locationId, limit: 50 }).catch(() => null);
  const surveys = ((data && (data.surveys || data.data)) || []).map((s) => ({ id: s.id, name: s.name || '' }));
  return { ok: true, surveys };
}
// Parse the live survey widget schema -> questions + conditional branch rules.
async function surveyMap(surveyId) {
  const id = String(surveyId || '').replace(/[^A-Za-z0-9]/g, '');
  if (!id) return { ok: false, reason: 'id_required' };
  let html = '';
  try { const r = await fetch(`https://api.leadconnectorhq.com/widget/survey/${id}`); html = await r.text(); } catch (_) { return { ok: false, reason: 'fetch_failed' }; }
  const m = html.match(/<script type="application\/json"[^>]*id="__NUXT_DATA__">([\s\S]*?)<\/script>/);
  if (!m) return { ok: false, reason: 'no_schema' };
  let arr; try { arr = JSON.parse(m[1]); } catch (_) { return { ok: false, reason: 'parse_failed' }; }
  const R = (i, d) => { if (d > 8 || typeof i !== 'number') return i; const v = arr[i]; if (v == null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map((x) => R(x, d + 1)); const o = {}; for (const k in v) o[k] = R(v[k], d + 1); return o; };
  // human question labels: contain a "?", an uppercase letter, and a space
  const questions = [];
  arr.forEach((v) => { if (typeof v === 'string' && v.length < 240 && /\?/.test(v) && /[A-Z]/.test(v) && /\s/.test(v)) questions.push(v); });
  let clIdx = null;
  for (const v of arr) { if (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, 'conditionalLogic')) { clIdx = v.conditionalLogic; break; } }
  const rules = [];
  if (typeof clIdx === 'number' && Array.isArray(arr[clIdx])) {
    for (const ri of arr[clIdx]) {
      const rule = R(ri, 0);
      const conds = (rule.conditions || []).map((c) => ({ field: c.selectedField, op: c.selectedOperation, value: String(c.inputValue || '').slice(0, 140) }));
      rules.push({ operation: rule.conditionalOperation, conditions: conds, outcomeType: rule.outcome && rule.outcome.type, shows: (rule.outcome && rule.outcome.value) || [] });
    }
  }
  let name = ''; const nm = html.match(/parentName":"([^"]+)"/); if (nm) name = nm[1];
  return { ok: true, survey: { id, name }, questions: [...new Set(questions)], rules };
}

// Accept an Event-admin bearer JWT (same accounts as /event) for single sign-on.
function verifyEventBearer(req) {
  var secret = String(process.env.EVENT_JWT_SECRET || '').trim();
  if (!secret) return null;
  var auth = String((req.headers && req.headers['authorization']) || '');
  var m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  var parts = m[1].split('.');
  if (parts.length !== 3) return null;
  try {
    var expected = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest('base64url');
    var a = Buffer.from(parts[2], 'utf8'), b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    var payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.exp && Math.floor(Date.now() / 1000) > Number(payload.exp)) return null;
    if (!payload.sub) return null;
    return payload;
  } catch (e) { return null; }
}

async function handle(req, res, url, deps) {
  const { origin, sendJson } = deps;
  const p = url.pathname.replace(/\/+$/, '') || url.pathname;
  const method = req.method;
  const authed = () => Boolean(adminCookieFromReq(req, deps) || verifyEventBearer(req));
  const need = () => { sendJson(res, 401, { ok: false, reason: 'admin_auth_required' }, origin); };

  // --- session / login / logout (public) ---
  if (p === '/api/admin/session' && method === 'GET') {
    return sendJson(res, 200, { ok: true, authed: authed(), configured: adminConfigured() }, origin);
  }
  if (p === '/api/admin/login' && method === 'POST') {
    if (!adminConfigured()) return sendJson(res, 200, { ok: false, reason: 'not_configured' }, origin);
    const ip = clientIp(req);
    const blockedFor = loginBlockedFor(ip);
    if (blockedFor > 0) {
      return sendJson(res, 429, { ok: false, reason: 'rate_limited', retryAfterSeconds: blockedFor }, origin,
        { 'Retry-After': String(blockedFor) });
    }
    const body = await deps.readJsonBody(req).catch(() => ({}));
    if (!passwordOk(body && body.password)) {
      noteLoginFailure(ip);
      return sendJson(res, 200, { ok: false, reason: 'bad_password' }, origin);
    }
    loginAttempts.delete(ip);
    const exp = Date.now() + ADMIN_TTL_MS;
    const token = deps.signTokenPayload({ role: 'admin', iat: Date.now(), exp });
    return sendJson(res, 200, { ok: true }, origin, { 'Set-Cookie': buildAdminSetCookie(token, exp) });
  }
  if (p === '/api/admin/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, origin, { 'Set-Cookie': buildAdminClearCookie() });
  }

  // --- everything below requires admin auth ---
  if (!authed()) return need();

  // Membership Admin — plans, members, entitlements, policy and audit.
  // Delegated whole so the membership rules live with the membership modules.
  if (p.startsWith('/api/admin/membership/')) {
    return membershipAdmin.handle(req, res, url, deps);
  }

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

  // --- Gaia Admin: Contacts + Surveys ---
  if (p === '/api/admin/contacts' && method === 'GET') {
    return sendJson(res, 200, await listContacts({ tag: url.searchParams.get('tag'), query: url.searchParams.get('query'), after: url.searchParams.get('after'), limit: url.searchParams.get('limit') }, deps), origin);
  }
  if (p === '/api/admin/contacts' && method === 'POST') {
    const body = await deps.readJsonBody(req).catch(function () { return {}; });
    return sendJson(res, 200, await listContactsAdvanced(body || {}, deps), origin);
  }
  if (p === '/api/admin/contacts/export' && method === 'POST') {
    const body = await deps.readJsonBody(req).catch(function () { return {}; });
    return sendJson(res, 200, await exportContacts(body || {}, deps), origin);
  }
  // Lets the failure path be proven against a throwaway unit rather than by
  // breaking a real job. Admin-only, read-only, and it names the unit it read.
  if (p === '/api/admin/health/job' && method === 'GET') {
    const unit = String(url.searchParams.get('service') || '').replace(/[^A-Za-z0-9._-]/g, '');
    if (!unit) return sendJson(res, 400, { ok: false, reason: 'service_required' }, origin);
    return sendJson(res, 200, {
      ok: true,
      job: jobHealth({
        key: 'probe', label: unit, service: unit,
        timer: unit.replace(/\.service$/, '.timer'), okWithin: 36 * 60 * 60 * 1000, cadence: 'probe',
      }),
    }, origin);
  }
  if (p === '/api/admin/alerts' && method === 'GET') {
    const evaluated = await evaluateAlerts(deps, { notify: url.searchParams.get('notify') !== '0' });
    const state = (url.searchParams.get('state') || '').toLowerCase();
    const sub = (url.searchParams.get('subsystem') || '').toLowerCase();
    let list = evaluated.incidents;
    if (state) list = list.filter((i) => i.state === state);
    if (sub) list = list.filter((i) => String(i.subsystem).toLowerCase() === sub);
    const open = evaluated.incidents.filter((i) => i.state === 'open');
    return sendJson(res, 200, {
      ok: true, generatedAt: evaluated.generatedAt,
      counts: {
        open: open.length,
        critical: open.filter((i) => i.severity === 'critical').length,
        warning: open.filter((i) => i.severity === 'warning').length,
        acknowledged: evaluated.incidents.filter((i) => i.state === 'acknowledged').length,
        resolved: evaluated.incidents.filter((i) => i.state === 'resolved').length,
      },
      subsystems: [...new Set(evaluated.incidents.map((i) => i.subsystem))],
      incidents: list,
    }, origin);
  }
  if (p === '/api/admin/alerts/ack' && method === 'POST') {
    const body = await deps.readJsonBody(req).catch(() => ({}));
    const store = loadAlertStore();
    const inc = (store.incidents || []).find((i) => i.id === (body && body.id));
    if (!inc) return sendJson(res, 404, { ok: false, reason: 'not_found' }, origin);
    // Acknowledging says a human has seen it. It does not say it is fixed, so
    // the condition keeps being evaluated and can still resolve on its own.
    inc.state = inc.state === 'resolved' ? 'resolved' : 'acknowledged';
    inc.acknowledgedAt = new Date().toISOString();
    saveAlertStore(store);
    return sendJson(res, 200, { ok: true, incident: inc }, origin);
  }
  if (p === '/api/admin/health' && method === 'GET') {
    return sendJson(res, 200, await pipelineHealth(deps), origin);
  }
  if (p === '/api/admin/system-map' && method === 'GET') {
    return sendJson(res, 200, await systemMap(deps), origin);
  }
  if (p === '/api/admin/subscriptions/summary' && method === 'GET') {
    const subs = await loadSubscriptions(deps);
    return sendJson(res, 200, { ok: true, summary: subs.summary }, origin);
  }
  if (p === '/api/admin/subscriptions' && method === 'GET') {
    const subs = await loadSubscriptions(deps);
    var st = (url.searchParams.get('status') || '').toLowerCase();
    var list = subs.list || [];
    if (st) list = list.filter(function (x) { return st === 'expired' ? (x.status === 'incomplete_expired' || x.status === 'expired') : x.status === st; });
    list = list.slice().sort(function (a, b) { return String(b.startedAt).localeCompare(String(a.startedAt)); });
    return sendJson(res, 200, { ok: true, count: list.length, subscriptions: list }, origin);
  }
  if (p === '/api/admin/contact' && method === 'GET') {
    const cid = url.searchParams.get('id') || '';
    if (!cid) return sendJson(res, 200, { ok: false, reason: 'id_required' }, origin);
    return sendJson(res, 200, await contactDetail(cid, deps), origin);
  }
  if (p === '/api/admin/surveys' && method === 'GET') {
    return sendJson(res, 200, await listSurveys(deps), origin);
  }
  if (p === '/api/admin/survey-map' && method === 'GET') {
    return sendJson(res, 200, await surveyMap(url.searchParams.get('id')), origin);
  }

  return sendJson(res, 404, { ok: false, reason: 'unknown_admin_route' }, origin);
}

export { handle, publishedAnnouncements, publishedEvents };
