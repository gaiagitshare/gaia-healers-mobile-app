/** Gaia — Practitioner Directory proxy.
 *
 * gaiapractitioners.com is the SOLE source of truth (a real Next.js app + DB with
 * a public API). This module mirrors its public data server-side (the browser
 * can't reach it — no CORS) and normalises a safe, public-only shape. It never
 * stores an authoritative copy: a short transient cache for performance only,
 * and on upstream failure it serves the last real cache within a resilience
 * window, or a truthful "unavailable" — never fabricated data.
 *
 * Only public endpoints are used: /api/data (list) and /api/practitioner/:id
 * (detail). The auth-gated /api/user and /api/profile/:id are never touched.
 */

const SOURCE = 'https://gaiapractitioners.com';
const FRESH_MS = 45 * 60 * 1000;              // considered fresh
const RESILIENCE_MS = 24 * 60 * 60 * 1000;    // serve last real cache this long if upstream is down
const UA = 'GaiaHealers-App/1.0 (+https://gaiahealers.app)';

let _listCache = { at: 0, list: null };
const _detailCache = new Map(); // id -> { at, data }

function directoryImage(url) {
  const u = String(url == null ? '' : url).trim();
  if (!u || u.toLowerCase() === 'null' || /\/null$/i.test(u)) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return SOURCE + (u.startsWith('/') ? '' : '/') + u;
}
function safeHttpUrl(url) {
  const u = String(url == null ? '' : url).trim();
  return /^https?:\/\//i.test(u) ? u : '';
}
function toArray(v) {
  if (Array.isArray(v)) return v.map((s) => String(s || '').trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function normalizeListItem(p) {
  const lat = parseFloat(p.latitude);
  const lng = parseFloat(p.longitude);
  return {
    id: p.id,
    name: [p.firstname, p.lastname].map((s) => String(s || '').trim()).filter(Boolean).join(' '),
    city: String(p.city || '').trim(),
    state: String(p.state || '').trim(),
    lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
    availability: String(p.availability || '').trim(),
    specialty: toArray(p.specialty),
    tags: toArray(p.tags),
    image: directoryImage(p.imageURL),
    hasVideo: !!(p.intro_video || Number(p.uploadVideo)),
    rank: Number(p.rank) || 0,
    reviewAvg: Number(p.review_avg) || 0,
    reviewCnt: Number(p.review_cnt) || 0,
    profileLink: safeHttpUrl(p.profileLink),
  };
}

function normalizeDetail(j, id, listItem) {
  const base = listItem || {};
  return Object.assign({}, base, {
    id: Number(id),
    name: String(j.fullname || [j.firstname, j.lastname].filter(Boolean).join(' ')).trim() || base.name || '',
    city: String(j.city || base.city || '').trim(),
    state: String(j.state || base.state || '').trim(),
    specialty: toArray(j.specialty).length ? toArray(j.specialty) : (base.specialty || []),
    image: directoryImage(j.imageURL) || base.image || '',
    meetingLink: safeHttpUrl(j.meetingLink),
    reviewAvg: Number(j.review_avg) || base.reviewAvg || 0,
    reviewCnt: Number(j.review_cnt) || base.reviewCnt || 0,
  });
}

async function fetchUpstream(path, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    const r = await fetch(SOURCE + path, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error('upstream_' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function handleList(res, sendJson, origin) {
  const now = Date.now();
  if (_listCache.list && (now - _listCache.at) < FRESH_MS) {
    return sendJson(res, 200, { ok: true, source: 'gaiapractitioners.com', cached: true, count: _listCache.list.length, practitioners: _listCache.list }, origin);
  }
  try {
    const j = await fetchUpstream('/api/data');
    const raw = Array.isArray(j.practitioner) ? j.practitioner : [];
    const list = raw
      .filter((p) => String(p.status || '').toLowerCase() === 'active')
      .map(normalizeListItem)
      .filter((p) => p.id != null && p.name);
    _listCache = { at: now, list };
    return sendJson(res, 200, { ok: true, source: 'gaiapractitioners.com', cached: false, count: list.length, practitioners: list }, origin);
  } catch (e) {
    if (_listCache.list && (now - _listCache.at) < RESILIENCE_MS) {
      return sendJson(res, 200, { ok: true, source: 'gaiapractitioners.com', cached: true, stale: true, count: _listCache.list.length, practitioners: _listCache.list }, origin);
    }
    return sendJson(res, 503, { ok: false, unavailable: true, error: 'The practitioner directory is temporarily unavailable. Please try again shortly.' }, origin);
  }
}

async function handleDetail(res, sendJson, origin, id) {
  if (!/^\d+$/.test(String(id))) return sendJson(res, 400, { ok: false, error: 'Invalid practitioner id.' }, origin);
  const now = Date.now();
  const cached = _detailCache.get(String(id));
  if (cached && (now - cached.at) < FRESH_MS) {
    return sendJson(res, 200, { ok: true, cached: true, practitioner: cached.data }, origin);
  }
  const listItem = (_listCache.list || []).find((p) => String(p.id) === String(id)) || null;
  try {
    const j = await fetchUpstream('/api/practitioner/' + id);
    const data = normalizeDetail(j, id, listItem);
    _detailCache.set(String(id), { at: now, data });
    return sendJson(res, 200, { ok: true, cached: false, practitioner: data }, origin);
  } catch (e) {
    if (cached && (now - cached.at) < RESILIENCE_MS) {
      return sendJson(res, 200, { ok: true, cached: true, stale: true, practitioner: cached.data }, origin);
    }
    if (listItem) return sendJson(res, 200, { ok: true, cached: false, partial: true, practitioner: listItem }, origin);
    return sendJson(res, 503, { ok: false, unavailable: true }, origin);
  }
}

export async function handle(req, res, url, deps) {
  const { origin, sendJson } = deps;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed.' }, origin);
  const p = url.pathname.replace(/\/+$/, '') || url.pathname;
  if (p === '/api/directory') return handleList(res, sendJson, origin);
  const m = p.match(/^\/api\/directory\/([^/]+)$/);
  if (m) return handleDetail(res, sendJson, origin, m[1]);
  return sendJson(res, 404, { ok: false, error: 'Not found.' }, origin);
}
