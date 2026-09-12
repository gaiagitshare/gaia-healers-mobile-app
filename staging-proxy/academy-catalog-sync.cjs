#!/usr/bin/env node
/* Gaia Academy — daily catalog sync.
 * Logs into the GHL client portal as a service member and reads every course
 * it can access + each lesson's video (native GHL MP4 via video.id, or a
 * Vimeo/YouTube link in the lesson description), published lessons only, then
 * POSTs the catalog to the academy pipeline. Per-member ACCESS stays live via
 * the webhook; this keeps course VIDEOS fresh.
 *
 * Env: GHL_LOCATION_ID, ACADEMY_SYNC_SECRET, GHL_PORTAL_SYNC_EMAIL, GHL_PORTAL_SYNC_PASSWORD
 */
'use strict';
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const LOC = (process.env.GHL_LOCATION_ID || '').trim();
const EMAIL = (process.env.GHL_PORTAL_SYNC_EMAIL || '').trim();
const PASS = (process.env.GHL_PORTAL_SYNC_PASSWORD || '').trim();
const SECRET = (process.env.ACADEMY_SYNC_SECRET || '').trim();
const CP = 'https://services.leadconnectorhq.com/clientportal-middleware';
const BASE = { channel: 'APP', source: 'PORTAL_USER', 'x-location-id': LOC, 'x-app-build': 'communities-nuxt-development', 'x-app-version': 'web', 'x-platform-details': 'server', origin: 'https://education.gaiahealers.com', referer: 'https://education.gaiahealers.com/', accept: 'application/json' };

function fail(m) { console.error('[academy-sync] CONTENT_SYNC_FAILED ' + m); process.exit(1); }
if (!LOC || !EMAIL || !PASS || !SECRET) fail('missing env');

function request(method, url, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const hh = {}; for (const k in headers) if (headers[k] != null && headers[k] !== '') hh[k] = String(headers[k]);
    const req = lib.request({ method, hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, headers: hh }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, json: j, raw: d }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}
const asArray = (b) => Array.isArray(b) ? b : ((b && (b.items || b.courses || b.data || b.lessons || b.modules)) || []);

async function login() {
  const r = await request('POST', `${CP}/clientclub/v2/${LOC}/auth/login/email`, { ...BASE, version: '2021-04-15', 'content-type': 'application/json' },
    JSON.stringify({ email: EMAIL, password: PASS, locationId: LOC, deviceId: crypto.randomUUID(), deviceName: 'gaia-academy-sync', deviceType: 'web', ipAddress: '127.0.0.1' }));
  const t = r.json && r.json.token;
  if (!t) fail('login failed (' + r.status + '): ' + String(r.raw).slice(0, 160));
  return t;
}
function H(token, productId) { const h = { ...BASE, version: '2021-07-28', authorization: 'Bearer ' + token }; if (productId) h['x-product-id'] = productId; return h; }

// GHL's "embed" lesson type keeps its video in `embedded_media`, not in
// `video` and not in the description: { source: 'youtube', meta: { src:
// 'https://www.youtube.com/embed/<id>?si=…' } }. Twenty lessons across three
// courses were built that way and never reached the app, because this only
// looked at the other two places — the nightly log said "Healeex → 0 videos"
// while the course had eleven.
function embeddedSource(l) {
  const em = l.embedded_media;
  const src = String((em && em.meta && em.meta.src) || '').trim();
  if (!src) return null;
  const yt = (src.match(/(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{11})/i) || [])[1];
  if (yt) return { provider: 'youtube', src: yt };
  const vm = (src.match(/vimeo\.com\/(?:video\/)?(\d+)/i) || [])[1];
  if (vm) return { provider: 'vimeo', src: vm };
  if (/\.(mp4|m3u8)(\?|$)/i.test(src)) return { provider: /\.m3u8(\?|$)/i.test(src) ? 'hls' : 'mp4', src };
  console.error('[academy-sync] unsupported embed source "' + String(em.source || '?') + '" on lesson "' + l.title + '" — not synced');
  return null;
}
// A native GHL upload. GHL tells us exactly where the file is in
// `video.url` — a CDN-relative path ("/memberships/<loc>/videos/<id>_3200k.mp4")
// or an absolute object URL (storage.googleapis.com/revex-membership-production/…).
// The rendition suffix is GHL's, per upload, and is never guessed here: this
// used to rebuild every URL with a hard-coded "_5300k" and 79 of 87 videos
// pointed at files that did not exist. The path is normalised to an absolute
// URL and otherwise passed through untouched; the source kind is kept so the
// app can tell a CDN file from a bucket object from an external provider.
const GHL_COURSE_CDN = 'https://cdn.courses.apisystem.tech';
function nativeSource(l) {
  const v = l.video;
  if (!v || !v.id) return null;
  const raw = String(v.url || '').trim();
  if (!raw) { log('LESSON_SOURCE_MISSING', { lessonId: l.id, lesson: l.title, videoId: v.id, reason: 'video.url absent' }); return { provider: 'none', src: '', sourceKind: 'ghl-native', sourceMissing: true }; }
  let src, sourceKind;
  if (/^https?:\/\//i.test(raw)) { src = raw; sourceKind = /storage\.googleapis\.com/i.test(raw) ? 'ghl-storage' : (/apisystem\.tech/i.test(raw) ? 'ghl-cdn' : 'external'); }
  else if (raw.startsWith('/')) { src = GHL_COURSE_CDN + raw; sourceKind = 'ghl-cdn'; }
  else { log('VIDEO_SOURCE_INVALID', { lessonId: l.id, lesson: l.title, reason: 'unrecognised video.url shape' }); return { provider: 'none', src: '', sourceKind: 'ghl-native', sourceMissing: true }; }
  return { provider: /\.m3u8(\?|$)/i.test(src) ? 'hls' : 'mp4', src, sourceKind, videoId: v.id };
}
function lessonSource(l) {
  if (l.visibility && l.visibility !== 'published') return null;
  const d = String(l.description || '');
  const base = { postId: l.id, title: l.title, seq: l.sequenceNo || 0 };
  const nv = nativeSource(l);
  if (nv) return { ...base, ...nv };
  const em = embeddedSource(l);
  if (em) return { ...base, provider: em.provider, src: em.src, sourceKind: em.provider };
  const vm = (d.match(/vimeo\.com\/(?:video\/)?(\d+)/i) || [])[1];
  const yt = (d.match(/(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{11})/i) || [])[1];
  if (vm) return { ...base, provider: 'vimeo', src: vm, sourceKind: 'vimeo' };
  if (yt) return { ...base, provider: 'youtube', src: yt, sourceKind: 'youtube' };
  return null;
}

// Every native file is checked before it is published to the app: one ranged
// GET per lesson, no body. A file that does not answer is still listed (the
// lesson exists) but marked so the player says "unavailable" instead of
// showing a blank screen, and the run logs which one.
function probe(url) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (_) { resolve(0); return; }
    const req = https.request({ method: 'GET', hostname: u.hostname, path: u.pathname + u.search, headers: { Range: 'bytes=0-0', 'User-Agent': 'GaiaAcademySync/1.0' } }, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.on('error', () => resolve(0)); req.setTimeout(15000, () => { req.destroy(); resolve(0); }); req.end();
  });
}
async function validateNative(lessons, courseTitle) {
  const queue = lessons.filter((l) => (l.provider === 'mp4' || l.provider === 'hls') && l.src);
  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const l = queue[i++];
      const status = await probe(l.src);
      l.sourceValid = status === 206 || status === 200;
      l.sourceCheckedAt = new Date().toISOString();
      if (!l.sourceValid) log('VIDEO_SOURCE_INVALID', { course: courseTitle, lessonId: l.postId, lesson: l.title, sourceKind: l.sourceKind, status });
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
}
function log(code, details) { console.error('[academy-sync] ' + code + ' ' + JSON.stringify(details)); }

(async () => {
  const token = await login();
  const libR = await request('GET', `${CP}/courses/learners/locations/${LOC}/courses/library?page=1&limit=500`, H(token));
  const courses = asArray(libR.json).map((c) => ({ id: c.id || c.productId || c._id, title: (c.title || c.name || '').trim(), membersCount: Number(c.membersCount) })).filter((c) => c.id);
  if (!courses.length) fail('no courses (status ' + libR.status + '): ' + String(libR.raw).slice(0, 160));
  const catalog = [];
  // GHL's own member count per course rides along. It is the only live number
  // GHL exposes about WHO holds a course, so the proxy compares it with the
  // grants it mirrors — the way to notice when the access webhook goes quiet.
  const courseStats = [];
  for (const c of courses) {
    const mR = await request('GET', `${CP}/courses/learners/locations/${LOC}/courses/${c.id}/modules`, H(token, c.id));
    // GHL modules are kept as modules ("Getting Started", "Troubleshooting", …)
    // instead of being poured into one flat "Lessons" list. Lesson ids do not
    // change, so progress and video reports keep their meaning.
    const modules = asArray(mR.json).slice().sort((a, b) => (a.sequenceNo || 0) - (b.sequenceNo || 0));
    const out = [];
    let total = 0, valid = 0, invalid = 0;
    for (const m of modules) {
      const lR = await request('GET', `${CP}/courses/learners/locations/${LOC}/courses/${c.id}/modules/${m.id || m._id}/lessons`, H(token, c.id));
      const lessons = [];
      for (const l of asArray(lR.json)) { const s = lessonSource(l); if (s) lessons.push(s); }
      lessons.sort((a, b) => a.seq - b.seq); lessons.forEach((o) => delete o.seq);
      await validateNative(lessons, c.title);
      total += lessons.length; valid += lessons.filter((l) => l.sourceValid === true).length; invalid += lessons.filter((l) => l.sourceValid === false).length;
      if (lessons.length) out.push({ id: m.id || m._id, title: String(m.title || 'Lessons').trim(), lessons });
    }
    if (out.length) catalog.push({ productId: c.id, title: c.title, modules: out });
    if (Number.isFinite(c.membersCount)) courseStats.push({ productId: c.id, title: c.title, membersCount: c.membersCount });
    console.log('[academy-sync] ' + c.title + ' -> ' + total + ' videos in ' + out.length + ' modules' + (invalid ? ' (' + invalid + ' native sources FAILED validation)' : (valid ? ' (' + valid + ' native sources validated)' : '')));
  }
  const post = await request('POST', `http://127.0.0.1:8787/api/academy/sync?secret=${encodeURIComponent(SECRET)}`, { 'content-type': 'application/json' }, JSON.stringify({ catalog, courseStats, members: [] }));
  if (!post.json || post.json.ok !== true) { log('CONTENT_SYNC_FAILED', { status: post.status, body: String(post.raw || post.error || '').slice(0, 160) }); process.exit(1); }
  console.log('[academy-sync] pushed ' + catalog.length + ' courses ->', post.json);
})();
