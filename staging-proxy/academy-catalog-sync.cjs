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

function fail(m) { console.error('[academy-sync] ' + m); process.exit(1); }
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
function lessonSource(l) {
  if (l.visibility && l.visibility !== 'published') return null;
  const d = String(l.description || '');
  const nv = l.video && l.video.id;
  const em = embeddedSource(l);
  const vm = (d.match(/vimeo\.com\/(?:video\/)?(\d+)/i) || [])[1];
  const yt = (d.match(/(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{11})/i) || [])[1];
  if (nv) return { postId: l.id, title: l.title, videoId: nv, seq: l.sequenceNo || 0 };
  if (em) return { postId: l.id, title: l.title, provider: em.provider, src: em.src, seq: l.sequenceNo || 0 };
  if (vm) return { postId: l.id, title: l.title, provider: 'vimeo', src: vm, seq: l.sequenceNo || 0 };
  if (yt) return { postId: l.id, title: l.title, provider: 'youtube', src: yt, seq: l.sequenceNo || 0 };
  return null;
}

(async () => {
  const token = await login();
  const libR = await request('GET', `${CP}/courses/learners/locations/${LOC}/courses/library?page=1&limit=500`, H(token));
  const courses = asArray(libR.json).map((c) => ({ id: c.id || c.productId || c._id, title: (c.title || c.name || '').trim() })).filter((c) => c.id);
  if (!courses.length) fail('no courses (status ' + libR.status + '): ' + String(libR.raw).slice(0, 160));
  const catalog = [];
  for (const c of courses) {
    const mR = await request('GET', `${CP}/courses/learners/locations/${LOC}/courses/${c.id}/modules`, H(token, c.id));
    const modules = asArray(mR.json);
    const lessons = [];
    for (const m of modules) {
      const lR = await request('GET', `${CP}/courses/learners/locations/${LOC}/courses/${c.id}/modules/${m.id || m._id}/lessons`, H(token, c.id));
      for (const l of asArray(lR.json)) { const s = lessonSource(l); if (s) lessons.push(s); }
    }
    lessons.sort((a, b) => a.seq - b.seq); lessons.forEach((o) => delete o.seq);
    if (lessons.length) catalog.push({ productId: c.id, title: c.title, modules: [{ title: 'Lessons', lessons }] });
    console.log('[academy-sync] ' + c.title + ' -> ' + lessons.length + ' videos');
  }
  const post = await request('POST', `http://127.0.0.1:8787/api/academy/sync?secret=${encodeURIComponent(SECRET)}`, { 'content-type': 'application/json' }, JSON.stringify({ catalog, members: [] }));
  console.log('[academy-sync] pushed ' + catalog.length + ' courses ->', post.json || post.status);
})();
