import { memberId as workspaceMemberId } from './beta-access.mjs';
import { appPlans, appOverview, appApi } from './beta-app-state.mjs';
// Gaia Healers Membership 2.0 BETA PREVIEW server (loopback only, 127.0.0.1:8800). Node built-ins only.
//
// Public:   /  (landing + staff password form), /robots.txt, /beta-assets/*, /healthz, POST /login
// Gated:    everything else, behind an HMAC-signed session cookie (gaia_beta, 12 h):
//   /choose                     "Choose how to look around"
//   POST /enter/member/<who>     the server mints a FIXTURE member session itself (the fixture key never reaches the browser)
//   POST /enter/staff/<role>     the server signs in to the staging console and as a DEMO operator (TOTP computed here);
//                                only the resulting HttpOnly cookies reach the browser
//   /app/*   -> staging web     127.0.0.1:8798 (API base rewritten to this origin)
//   /api/*   -> staging proxy   127.0.0.1:8797 (default-deny for writes, see writePolicy)
//   /admin/* -> staging Control Center 127.0.0.1:8799 (static only; its API goes through /api)
// Every upstream is a fixed 127.0.0.1:879x address; there is no route to production.
//
// Secrets: /root/.config/gaia-membership-beta.env (BETA_*), plus exactly two values read from the staging proxy env
// (MEMBERSHIP_FIXTURE_KEY, GAIA_ADMIN_PASSWORD). None of them is logged or sent to the browser.
// Logs: method, path (no query), status, milliseconds. Never cookies, headers or bodies.
import { createSandbox } from './beta-sandbox.mjs';
import http from 'node:http'; import fs from 'node:fs'; import crypto from 'node:crypto';

const PORT = 8800; const HOSTIP = '127.0.0.1';
const WEB = { host: '127.0.0.1', port: 8798 }; const PROXY = { host: '127.0.0.1', port: 8797 }; const ADMIN = { host: '127.0.0.1', port: 8799 };
const PROXY_ORIGIN = 'http://127.0.0.1:8797';          // what the staging web server writes in place of https://api.gaiahealers.app
const LIVE_APP = 'https://gaiahealers.app';
const ALLOWED_HOSTS = new Set(['beta.gaiahealers.app', '127.0.0.1:8800', 'localhost:8800']);
const BETA_COOKIE = 'gaia_beta'; const BETA_TTL_S = 12 * 3600;
const MEMBER_COOKIE = 'gaia_member_session'; const ADMIN_COOKIE = 'gaia_admin'; const OP_COOKIE = 'gaia_operator'; const OP_PATH = '/api/admin/membership2';
const MAX_BODY = 64 * 1024;
const MARK = process.env.BETA_MARK_FILE || new URL('../assets/gaia-mark.svg',import.meta.url).pathname;

const MEMBERS = {
  free: { fixture: 'fixture-beta-demo-free', title: 'Free member', text: 'No plan yet, not on the pilot list: sees what the Free plan includes and what each paid plan adds, marked “Not open yet”. Wallet: 100 monthly and 25 goodwill coins.' },
  standard: { fixture: 'fixture-beta-demo-standard', title: 'Standard member', text: 'Standard plan, active: 15 benefits and 500 coins a month included; Professional and Inner Circle benefits shown as locked. Wallet: 500 monthly and 25 goodwill coins.' },
  professional: { fixture: 'fixture-beta-demo-professional', title: 'Professional member', text: 'Professional plan, active: 24 benefits including 20% off certifications and 2,000 coins a month; Inner Circle extras shown as locked. Wallet: 2,000 monthly and 25 goodwill coins.' },
  innercircle: { fixture: 'fixture-beta-demo-inner-circle', title: 'Inner Circle member', text: 'Inner Circle plan, active: all 31 benefits and 4,000 coins a month; nothing locked. Wallet: 4,000 monthly and 25 goodwill coins.' },
  pilot: { fixture: 'fixture-beta-demo-pilot', title: 'Pilot member', text: 'No plan yet, on the internal pilot list: sees what the Free plan includes and can choose a paid plan, monthly or annual (checkout is simulated). Wallet: 100 monthly and 25 goodwill coins.' },
  silver: { fixture: 'fixture-beta-demo-silver', title: 'Legacy Silver member', text: 'Pays monthly for today’s Silver plan and has an offer to move to Standard (monthly); accepting is simulated. Wallet: 100 monthly and 25 goodwill coins.' },
};
const STAFF = {
  support: { title: 'Support', text: 'Looks people up, reads their membership and coins history.' },
  finance: { title: 'Finance', text: 'Sees billing, refunds and approvals.' },
  owner: { title: 'Owner', text: 'Sees everything, including the launch stage and pilot list (read-only here).' },
};

// ---------- config ----------
function readEnv(file) {
  const out = {};
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim()); if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ''); }
  return out;
}
const B = readEnv(process.env.BETA_ENV_FILE || '/root/.config/gaia-membership-beta.env');
const S = (() => { const e = readEnv(process.env.STAGING_PROXY_ENV_FILE || '/root/.config/gaia-membership-staging-proxy.env'); return { fixtureKey: e.MEMBERSHIP_FIXTURE_KEY || '', consolePassword: e.GAIA_ADMIN_PASSWORD || '' }; })();
for (const k of ['BETA_PASSWORD', 'BETA_COOKIE_SECRET']) if (!B[k] || B[k].length < 20) { console.error(`beta env: ${k} missing or too short`); process.exit(2); }

// ---------- small helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const peer = (req) => req.socket.remoteAddress || '';
/** The client IP: X-Real-IP only when the TCP peer is loopback (nginx on this host), else the socket address. */
function clientIp(req) {
  const p = peer(req);
  if (isLoopback(p)) { const x = String(req.headers['x-real-ip'] || '').trim(); if (/^[0-9a-fA-F.:]{3,45}$/.test(x)) return x; }
  return p || 'unknown';
}
const isHttps = (req) => isLoopback(peer(req)) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
function originOf(req) {
  const host = String(req.headers.host || '').trim().toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return null;
  return (isHttps(req) ? 'https://' : 'http://') + host;
}
function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) { const k = part.slice(0, i).trim(); if (k && !(k in out)) out[k] = part.slice(i + 1).trim(); } }
  return out;
}
const tsEq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(); const y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y) && String(a).length === String(b).length; };
const hmac = (s) => crypto.createHmac('sha256', B.BETA_COOKIE_SECRET).update(s).digest('base64url');
function signBeta() { const p = Buffer.from(JSON.stringify({ v: 1, exp: Math.floor(Date.now() / 1000) + BETA_TTL_S, n: crypto.randomBytes(8).toString('base64url') })).toString('base64url'); return `${p}.${hmac(p)}`; }
function betaOk(req) {
  const v = parseCookies(req.headers.cookie)[BETA_COOKIE]; if (!v) return false;
  const [p, sig] = v.split('.'); if (!p || !sig || !tsEq(sig, hmac(p))) return false;
  try { const j = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return j.v === 1 && Number(j.exp) > Date.now() / 1000; } catch { return false; }
}
const cookieAttrs = (req, extra) => ['Path=/', 'HttpOnly', 'SameSite=Lax', ...(isHttps(req) ? ['Secure'] : []), ...(extra || [])].join('; ');
const betaCookie = (req) => `${BETA_COOKIE}=${signBeta()}; ${cookieAttrs(req, [`Max-Age=${BETA_TTL_S}`])}`;
const clearCookie = (req, name, path = '/') => `${name}=; Path=${path}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}; Max-Age=0`;
/** Upstream Set-Cookie -> what this origin hands the browser: SameSite=None becomes Lax (same-origin here); Secure only over https. */
function adaptCookie(req, c) {
  const parts = String(c).split(';').map((s) => s.trim()).filter(Boolean).filter((p) => !/^secure$/i.test(p) && !/^domain=/i.test(p))
    .map((p) => (/^samesite=none$/i.test(p) ? 'SameSite=Lax' : p));
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}
const SEC_HEADERS = { 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };
const OWN_CSP = "default-src 'self'; media-src 'self' https://cdn.courses.apisystem.tech https://storage.googleapis.com; frame-src https://www.youtube-nocookie.com https://player.vimeo.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
// x-gaia-beta-answer marks a response written by the beta server itself (nothing was forwarded upstream).
function send(res, status, body, headers = {}) { res.writeHead(status, { 'cache-control': 'no-store', ...SEC_HEADERS, 'x-gaia-beta-answer': 'local', ...headers }); res.end(body); }
const sendJson = (res, status, obj, headers = {}) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', ...headers });
const sendPage = (res, status, html, headers = {}) => send(res, status, html, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': OWN_CSP, ...headers });
function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(Object.assign(new Error('too big'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
/** Same-origin check for the beta's own form POSTs (the cookie is SameSite=Lax as well). */
function sameOrigin(req) {
  const own = originOf(req); if (!own) return false;
  const o = String(req.headers.origin || '').trim();
  if (o) return o === own;
  try { return new URL(String(req.headers.referer || '')).origin === own; } catch { return false; }
}

const sandbox = createSandbox({secret:B.BETA_COOKIE_SECRET,sendPage,send,readBody,sameOrigin,parseCookies});

// ---------- rate limits ----------
function limiter(max, windowMs) {
  const m = new Map();
  return { hit(ip) { const t = Date.now(); let r = m.get(ip); if (!r || t - r.first >= windowMs) { r = { n: 0, first: t }; m.set(ip, r); } r.n++; if (m.size > 2000) for (const [k, v] of m) if (t - v.first >= windowMs) m.delete(k); return r.n > max ? Math.ceil((windowMs - (t - r.first)) / 1000) : 0; },
    reset(ip) { m.delete(ip); } };
}
const loginLimit = limiter(8, 15 * 60 * 1000);   // failed staff-password attempts per client IP
const enterLimit = limiter(30, 10 * 60 * 1000);  // sign-ins as a fictional member/operator per client IP

// ---------- upstream calls (server side) ----------
function upstream(target, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve) => {
    const h = { ...headers }; if (body) h['content-length'] = String(Buffer.byteLength(body));
    const r = http.request({ ...target, method, path, headers: h, timeout: 15000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', () => resolve({ status: 0, headers: {}, json: null }));
    r.end(body);
  });
}
const firstCookie = (r, name) => { for (const c of [].concat(r.headers['set-cookie'] || [])) if (c.startsWith(name + '=')) return c; return null; };
const cookieValue = (c) => String(c).split(';')[0].slice(String(c).indexOf('=') + 1);
const maxAgeOf = (c) => { const m = /max-age=(\d+)/i.exec(String(c)); return m ? Number(m[1]) : 3600; };
const SRV_H = { 'content-type': 'application/json', origin: PROXY_ORIGIN, 'user-agent': 'gaia-beta-server' };

async function fixtureCookie(fixture) {
  const r = await upstream(PROXY, { method: 'POST', path: `/api/dev/fixture-session?fixture=${encodeURIComponent(fixture)}`, headers: { 'x-gaia-fixture-key': S.fixtureKey, 'user-agent': 'gaia-beta-server' } });
  return r.status === 200 ? firstCookie(r, MEMBER_COOKIE) : null;
}

let consoleSess = null;   // { value, exp }
async function consoleCookie(ip) {
  if (consoleSess && consoleSess.exp - Date.now() > 30 * 60 * 1000) return consoleSess;
  const r = await upstream(PROXY, { method: 'POST', path: '/api/admin/login', headers: { ...SRV_H, 'x-forwarded-for': ip, 'x-real-ip': ip }, body: JSON.stringify({ password: S.consolePassword }) });
  const c = r.status === 200 && r.json?.ok ? firstCookie(r, ADMIN_COOKIE) : null;
  if (!c) return null;
  consoleSess = { value: cookieValue(c), exp: Date.now() + maxAgeOf(c) * 1000 };
  return consoleSess;
}

function b32(s) { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const ch of String(s).replace(/=+$/, '').replace(/\s/g, '').toUpperCase()) { const i = A.indexOf(ch); if (i < 0) continue; bits += i.toString(2).padStart(5, '0'); } const o = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(o); }
function totpAt(secret, step) { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(step)); const h = crypto.createHmac('sha1', b32(secret)).update(c).digest(); const o = h[h.length - 1] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One shared demo-operator session per role. Codes are single-use per 30 s step, so sessions are reused while
// valid and a new sign-in waits for a fresh step instead of failing (and counting toward the account lock).
const opSess = {}; const opLastStep = {}; const opBusy = {};
// Sign-ins are made on behalf of one visitor, so the staging proxy's per-IP sign-in limit counts that visitor's IP.
async function operatorSession(role, adminValue, ip) {
  const R = role.toUpperCase(); const email = B[`BETA_OPERATOR_${R}_EMAIL`], pw = B[`BETA_OPERATOR_${R}_PASSWORD`], sec = B[`BETA_OPERATOR_${R}_TOTP_SECRET`];
  if (!email || !pw || !sec) return null;
  while (opBusy[role]) await opBusy[role];
  let done; opBusy[role] = new Promise((r) => { done = r; });
  try {
    const cached = opSess[role];
    if (cached && cached.exp - Date.now() > 5 * 60 * 1000) {
      const me = await upstream(PROXY, { path: '/api/admin/membership2/me', headers: { cookie: `${ADMIN_COOKIE}=${adminValue}; ${OP_COOKIE}=${cached.value}`, 'user-agent': 'gaia-beta-server' } });
      if (me.status === 200) return cached;
    }
    let step = Math.floor(Date.now() / 30000);
    if (opLastStep[role] != null && step <= opLastStep[role]) { await sleep((opLastStep[role] + 1) * 30000 - Date.now() + 250); step = Math.floor(Date.now() / 30000); }
    opLastStep[role] = step;
    const r = await upstream(PROXY, { method: 'POST', path: '/api/admin/membership2/login', headers: { ...SRV_H, cookie: `${ADMIN_COOKIE}=${adminValue}`, 'x-forwarded-for': ip, 'x-real-ip': ip }, body: JSON.stringify({ email, password: pw, totp: totpAt(sec, step) }) });
    const c = r.status === 200 ? firstCookie(r, OP_COOKIE) : null;
    if (!c) { opSess[role] = null; console.log(`staff sign-in ${role}: upstream ${r.status} ${String(r.json?.code || '').replace(/[^A-Z_]/g, '')}`); return null; }
    opSess[role] = { value: cookieValue(c), exp: Date.now() + maxAgeOf(c) * 1000 };
    return opSess[role];
  } finally { opBusy[role] = null; done(); }
}

// ---------- write policy for /api ----------
const DISABLED = 'Disabled in the beta preview: nothing was changed';
const SIMULATED = 'Simulated in the beta preview: no payment or change was made';
const CANCEL_PREVIEW = /^\/api\/membership2\/subscriptions\/[0-9a-f-]{36}\/cancel-preview$/;   // a pure read in the service (SELECT only)
function writePolicy(method, p) {
  const lp = p.toLowerCase();
  if ((method === 'GET' || method === 'HEAD') && p.startsWith('/api/admin/membership2/') && !/^\/api\/admin\/membership2\/(?:status|environment|me|overview|persons|persons\/[0-9a-f-]{36}|plans|payments|coins|legacy|migration-offers|reconciliation|refund-reviews|dead-letters|audit|health|launch|requests)$/.test(p)) return { block: 404 };
  if (lp.startsWith('/api/dev/') || lp === '/api/dev' || lp.startsWith('/api/dev.')) return { block: 404 };   // fixture sessions: beta server only, every spelling
  // Gaia AI assistant: no paid AI calls from the beta. Only the onboarding-state read passes (assist-guard: "no paid call").
  if ((p.startsWith('/api/assist/') || p === '/api/assist') && !(method === 'GET' && p === '/api/assist/onboarding')) return { kind: 'simulated', status: 403 };
  // Control Center: only the console session check and the Membership 2.0 area are reachable through the beta.
  // (Contacts, surveys, events and system read GHL, the Event Manager or local data files: not part of the preview.)
  if ((p === '/api/admin' || p.startsWith('/api/admin/')) && (method === 'GET' || method === 'HEAD')
      && !(p === '/api/admin/session' || p.startsWith('/api/admin/membership2/'))) return { kind: 'disabled', status: 404 };
  if (method === 'GET' || method === 'HEAD') return { pass: true };
  if (method === 'OPTIONS') return { block: 204 };
  if (method === 'POST' && (p === '/api/admin/logout')) return { local: 'admin-logout' };
  if (method === 'POST' && (p === '/api/admin/membership2/logout')) return { local: 'op-logout' };
  if (method === 'POST' && (p === '/api/auth/logout' || p === '/api/member/logout')) return { local: 'member-logout' };
  if (method === 'POST' && CANCEL_PREVIEW.test(p)) return { pass: true };
  if (p === '/api/member/path/event') return { kind: 'simulated', status: 423, quiet: true };   // background activity tracking: refused without an on-page notice
  if (p.startsWith('/api/admin')) return { kind: 'disabled', status: 423 };   // incl. console/operator login and password: the beta signs staff in itself
  return { kind: 'simulated', status: 423 };                                 // every member write: checkout, coin checkout, cancel, change, migration, prefs…
}

// ---------- HTML injection (banner, noindex, beta notices) ----------
const BANNER_CSS = `
#gaia-beta-bar{position:fixed;top:0;left:0;right:0;z-index:2147483600;background:#F4F1E8;color:#16261F;border-bottom:2px solid #16261F;
 font:600 14px/1.35 'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',sans-serif;padding:8px max(12px,env(safe-area-inset-right)) 8px max(12px,env(safe-area-inset-left));
 display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;box-sizing:border-box}
#gaia-beta-bar *{box-sizing:border-box}
#gaia-beta-bar .gb-t{flex:1 1 260px;min-width:0;margin:0}
#gaia-beta-bar .gb-t small{display:block;font-weight:500;font-size:12.5px;color:#2B3A33}
#gaia-beta-bar .gb-a{display:flex;gap:8px;flex-wrap:wrap}
#gaia-beta-bar a{display:inline-flex;align-items:center;min-height:36px;padding:6px 14px;border-radius:999px;text-decoration:none;font-weight:700;font-size:13.5px;border:2px solid #16261F}
#gaia-beta-bar a.gb-back{background:#16261F;color:#F4F1E8}
#gaia-beta-bar a.gb-switch{background:transparent;color:#16261F}
#gaia-beta-bar a:hover{text-decoration:underline}
#gaia-beta-bar a:focus-visible{outline:3px solid #B8860B;outline-offset:2px}
#gaia-beta-note{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483601;max-width:min(520px,calc(100vw - 24px));
 background:#16261F;color:#F4F1E8;border:2px solid #F4F1E8;border-radius:14px;padding:12px 16px;font:600 14px/1.4 'Plus Jakarta Sans',system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35);display:none}
#gaia-beta-note.on{display:block}
@media (max-width:600px){#gaia-beta-bar{font-size:13px;padding-top:6px;padding-bottom:6px}#gaia-beta-bar .gb-t small{display:none}
 #gaia-beta-bar a{min-height:32px;padding:4px 12px;font-size:12.5px}#gaia-beta-note{bottom:calc(96px + env(safe-area-inset-bottom))}}
html{scroll-padding-top:var(--gaia-beta-h,56px)}
body{padding-top:var(--gaia-beta-h,56px)!important}
`;
const ADMIN_EXTRA_CSS = `
.drawer,.m2-dlg,.scrim,.side,.side__scrim{top:var(--gaia-beta-h,56px)!important}
.drawer{height:calc(100vh - var(--gaia-beta-h,56px))!important}
.sidetoggle{top:calc(var(--gaia-beta-h,56px) + 10px)!important}
.side{height:calc(100vh - var(--gaia-beta-h,56px))!important}
`;
// Full-screen layers of the app start below the banner, so their own close/back controls stay visible.
const APP_EXTRA_CSS = `
#gaia-beta-bar{background:#102017;color:#c5d6c9;border-bottom:1px solid rgba(160,255,185,.16);font-size:11px}#gaia-beta-bar .gb-t small{display:none}#gaia-beta-bar a{border-color:#36583f;font-size:11px;color:#c5d6c9}#gaia-beta-bar a.gb-back{background:#1c3020;color:#9de177}#gaia-beta-bar a.gb-switch{color:#c5d6c9}

@font-face{font-family:'Plus Jakarta Sans';src:url('/app/assets/beta-jakarta.ttf') format('truetype');font-style:normal;font-weight:200 800;font-display:swap}

/* Calls & Perks: group headings inside the My Access panel. */
.gaia-beta-cp-head{list-style:none;padding:14px 0 4px;border:0}
.gaia-beta-cp-head:first-child{padding-top:4px}
.gaia-beta-cp-head + .g-ma-item{border-top:0}
.gaia-beta-cp-head h3{margin:0;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--g-text-muted,#9DB0A4)}
/* Academy plan chips: never cut a label off; wrap inside the chip instead. */
body.gaia-v2 [data-screen="academy"] .g-access--link > .g-access__tags { max-width: 62%; }
body.gaia-v2 [data-screen="academy"] .g-access--link > .g-access__tags .g-chip { white-space: normal; text-overflow: clip; line-height: 1.2; text-align: left; }

.gaia-journey,.gaia-acad,.gaia-tour,.gaia-share-modal,.gaia-onboard-modal,.gaia-dirprofile-modal,.gaia-transition-modal,.gaia-product-modal,.g-confirm,.g-ticket,
.gaia-auth-modal,.gaia-menu-sheet,body.gaia-v2 .gaia-assist__backdrop,body.gaia-v2 .gaia-portal-workspace{top:var(--gaia-beta-h,56px)!important}
.gaia-skip-link{top:calc(var(--gaia-beta-h,56px) + 12px)!important}
@media (min-width:700px){body.gaia-v2 .gaia-tabbar{top:var(--gaia-beta-h,56px)!important;height:calc(100vh - var(--gaia-beta-h,56px))!important}}
body:not(.gaia-v2) .gaia-live-sync{top:calc(var(--gaia-beta-h,56px) + 5.25rem + env(safe-area-inset-top))!important}
`;
function bannerHtml(area) {
  const sub = area === 'admin'
    ? 'Actions are disabled in the beta: buttons show what would happen, and nothing is changed.'
    : 'Fictional members only. Payments and plan changes are simulated: no payment or change is made.';
  return `<div id="gaia-beta-bar" role="region" aria-label="Gaia Healers beta preview notice">
<p class="gb-t">Beta preview · Coming after Elevate 2026 · Test data, no real payments<small>${sub}</small></p>
<div class="gb-a"><a class="gb-switch" href="/sandbox">Test full membership</a><a class="gb-switch" href="/choose">Switch view</a><a class="gb-back" href="${LIVE_APP}" rel="noopener">Back to the current app</a></div></div>
<div id="gaia-beta-note" role="status" aria-live="polite"></div>`;
}
// Runs before the page's own scripts. Measures the banner, shows the beta notice for refused writes, keeps the
// Control Center's boot check satisfied (the real sign-in is the HttpOnly gaia_admin cookie; this placeholder is not a secret).
// Member view: what each refused member action would do after launch (shown in place of the app's error notice).
const WOULD = [
  [/\/coins\/checkout$/, 'After launch, this opens a secure checkout for the coin pack.'],
  [/\/migration(-offers)?\/[^/]+\/checkout$/, 'After launch, this opens a secure checkout to move to Gaia Healers Membership 2.0.'],
  [/\/migration(-offers)?\/[^/]+\/accept$/, 'After launch, this accepts the offer to move to Gaia Healers Membership 2.0.'],
  [/\/checkout$/, 'After launch, this opens a secure checkout for the chosen plan.'],
  [/\/change-preview$/, 'After launch, this shows what the plan change costs before you confirm it.'],
  [/\/change\/cancel$/, 'After launch, this keeps your current plan and drops the scheduled change.'],
  [/\/change$/, 'After launch, this changes your plan.'],
  [/\/cancel$/, 'After launch, this schedules the cancellation for the end of the paid period.'],
];
const headScript = (area, workspace=false) => `<script>(function(){
${area==='app'?`document.addEventListener('click',function(e){var t=e.target&&e.target.closest&&e.target.closest('[data-sync-portal],[data-course-open],[data-open-in-app],a[href]');if(!t)return;var u=t.getAttribute('data-sync-portal')||t.getAttribute('data-course-open')||t.getAttribute('data-open-in-app')||t.getAttribute('href')||'';if(u.indexOf('/beta/simulated?what=course')!==0)return;e.preventDefault();e.stopImmediatePropagation();location.href=u;},true);`:''}
${workspace&&area==='app'?`document.addEventListener('click',function(e){var t=e.target&&e.target.closest&&e.target.closest('[data-sync-portal],[data-course-open],[data-open-in-app],a[href]');if(!t)return;var u=t.getAttribute('data-sync-portal')||t.getAttribute('data-course-open')||t.getAttribute('data-open-in-app')||t.getAttribute('href')||'';if(u.indexOf('/sandbox/academy')!==0)return;e.preventDefault();e.stopImmediatePropagation();location.href=u;},true);document.addEventListener('click',function(e){var t=e.target&&e.target.closest&&e.target.closest('[data-super-join],[data-super-signin],[data-join-toggle],.gaia-header-signin,a.gaia-login-pill,a.gaia-login-btn,[data-menu-signin],[data-membership-signin],[data-auth-signin],[data-m2-signin],[data-m2-choose],[data-m2-change-to],[data-m2-cancel],[data-m2-keep],[data-m2-pack],[data-m2-accept],[data-m2-migrate]');if(!t)return;e.preventDefault();e.stopImmediatePropagation();location.href=t.matches('[data-super-join],[data-super-signin],[data-join-toggle],.gaia-header-signin,a.gaia-login-pill,a.gaia-login-btn,[data-menu-signin],[data-membership-signin],[data-auth-signin],[data-m2-signin]')?'/sandbox/join':t.hasAttribute('data-m2-pack')?'/sandbox/wallet':'/sandbox/membership';},true);`:''}
${area === 'admin' ? "try{localStorage.setItem('gha_token','beta-cookie-session');localStorage.setItem('token','beta-cookie-session');}catch(e){}" : ''}
try{navigator.serviceWorker&&navigator.serviceWorker.getRegistrations&&navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister();});});}catch(e){}
var t;function note(m){var n=document.getElementById('gaia-beta-note');if(!n)return;n.textContent=m;n.className='on';clearTimeout(t);t=setTimeout(function(){n.className='';},6000);}
window.GaiaBetaNote=note;
var AREA=${JSON.stringify(area)},SIM=${JSON.stringify(SIMULATED)},DIS=${JSON.stringify(DISABLED + '.')};
var WOULD=[${WOULD.map(([re, txt]) => `[${re.toString()},${JSON.stringify(txt)}]`).join(',')}];
// Member view: the app shows its generic error for a refused write; replace that notice with a calm beta notice.
var last=null,included=function(){};
function would(u){for(var i=0;i<WOULD.length;i++)if(WOULD[i][0].test(u))return WOULD[i][1];return 'In the live app this would go ahead; here nothing is sent.';}
function rewrite(){
  if(!last||Date.now()-last.at>120000)return false;
  var el=document.querySelector('[data-m2-notice]');if(!el)return false;
  if(el.getAttribute('data-beta-notice')===String(last.at))return true;
  var tt=el.querySelector('.g-ann__title'),bd=el.querySelector('.g-ann__body');if(!tt||!bd)return false;
  el.classList.remove('g-ann--warn','g-ann--success');el.classList.add('g-ann--info');el.setAttribute('role','status');el.setAttribute('data-beta-notice',String(last.at));
  tt.textContent=SIM+'.';bd.textContent=last.would+' Everything here is test data with fictional people.';
  el.querySelectorAll('[data-m2-retry],[data-m2-reload],a').forEach(function(x){x.remove();});
  var nt=document.getElementById('gaia-beta-note');if(nt)nt.className='';
  setTimeout(function(){try{el.scrollIntoView({block:'center'});}catch(e){}},60);
  return true;
}
// Control Center: label blanked figures "Demo data only" and say so once per screen.
var blank=null;
function labelBlanks(){ if(!blank)return; var panel=document.getElementById('m2s-panel'); if(!panel)return;
  panel.querySelectorAll('.m2-stat').forEach(function(st){var b=st.querySelector('b'),l=st.querySelector('span');if(b&&l&&/^Open alerts$/.test(l.textContent)&&b.textContent!=='Demo data only')b.textContent='Demo data only';});
  if(!panel.querySelector('.gaia-beta-demo-note')){var n=document.createElement('p');n.className='m2-note gaia-beta-demo-note';n.setAttribute('role','note');
    n.textContent='Demo data only: every figure here is computed from the fictional demo people; anything that would come from real records is hidden in the beta preview.';panel.insertBefore(n,panel.firstChild);} }
if(AREA==='admin'){document.addEventListener('DOMContentLoaded',function(){new MutationObserver(function(){labelBlanks();}).observe(document.body,{childList:true,subtree:true});});}
if(AREA==='app'){
  // No sign-up or checkout link may leave the beta: the live join / checkout pages answer with the simulated page instead.
  document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href],[data-open-in-app],[data-course-open]');if(!a)return;
    var u=a.getAttribute('href')||a.getAttribute('data-open-in-app')||a.getAttribute('data-course-open')||'';
    if(/^https?:[/][/](join[.]gaiahealers[.]com|education[.]gaiahealers[.]com|gaiahealers[.]com[/](cart|checkout|products))|checkout[.]stripe[.]com|paypal[.]com/i.test(u)){e.preventDefault();e.stopImmediatePropagation();location.href='/beta/simulated?what='+(/education[.]/.test(u)?'course':'checkout');}},true);
  document.addEventListener('click',function(e){if(e.target&&e.target.closest&&e.target.closest('[data-m2-dismiss]'))last=null;},true);
  // Calls & Perks are benefits of the plan, not subscriptions: the app's row status "Active" reads "Included" here.
  // Its summary is the server's "N calls · M perks" (the app's generic row would say "N items"), on My Access and on the plan card's "Your access".
  included=function(){document.querySelectorAll('#ma-panel-calls_perks .g-ma-item__status').forEach(function(x){if(x.textContent==='Active')x.textContent='Included';});
    var ul=document.querySelector('#ma-panel-calls_perks .g-ma-list');
    if(ul){var rows=Array.from(ul.querySelectorAll('.g-ma-item')),sig=JSON.stringify(rows.map(function(li){var nm=li.querySelector('.g-ma-item__name');return nm?nm.textContent.trim():'';}));
      sig+=JSON.stringify(cpGroup);if(ul.getAttribute('data-beta-cp-rows')!==sig||(!ul.querySelector('.gaia-beta-cp-head')&&Object.keys(cpGroup).length)){ul.setAttribute('data-beta-cp-rows',sig);ul.querySelectorAll('.gaia-beta-cp-head').forEach(function(h){h.remove();});var seen={};rows.forEach(function(li){var nm=li.querySelector('.g-ma-item__name'),g=nm&&cpGroup[nm.textContent.trim()];
      if(g&&!seen[g]){seen[g]=1;var h=document.createElement('li');h.className='gaia-beta-cp-head';h.innerHTML='<h3></h3>';h.firstChild.textContent=g;ul.insertBefore(h,li);}});}}
    if(!cpSum)return;var v=document.querySelector('[data-ma-toggle="calls_perks"] .g-ma-row__value');if(v&&v.textContent!==cpSum)v.textContent=cpSum;
    document.querySelectorAll('.g-tier__access-link').forEach(function(a){var n=a.querySelector('.g-tier__access-name'),m=a.querySelector('.g-tier__access-meta');if(n&&m&&n.textContent==='Calls & Perks'&&m.textContent!==cpSum)m.textContent=cpSum;});}
  document.addEventListener('DOMContentLoaded',function(){included();new MutationObserver(function(){rewrite();included();}).observe(document.body,{childList:true,subtree:true});});
}
var cpSum=null,cpGroup={};
var f=window.fetch;if(f){window.fetch=function(input){var u='';try{u=String(input&&input.url||input);}catch(e){}
  return f.apply(this,arguments).then(function(r){try{
    if(AREA==='app'&&/[/]api[/]member[/]access$/.test(new URL(u,location.href).pathname))r.clone().json().then(function(j){var x=(j&&j.sections||[]).find(function(s){return s.type==='calls_perks';});cpSum=x?x.summary:null;cpGroup={};(j&&j.entitlements||[]).forEach(function(e){if(e.type==='calls_perks'&&e.value)cpGroup[e.value.name]=e.value.group;});setTimeout(included,0);}).catch(function(){});var k=r.headers.get('x-gaia-beta');
    if(r.headers.get('x-gaia-beta-hidden')!==null){blank={at:Date.now()};setTimeout(labelBlanks,50);}
    if(k==='disabled')note(DIS);
    else if(k==='simulated'){if(AREA==='app'){last={at:Date.now(),would:would(new URL(u,location.href).pathname)};setTimeout(function(){if(!rewrite())note(SIM+'.');},700);}else note(SIM+'.');}
  }catch(e){}return r;});};}
function size(){var b=document.getElementById('gaia-beta-bar');if(b)document.documentElement.style.setProperty('--gaia-beta-h',b.offsetHeight+'px');}
document.addEventListener('DOMContentLoaded',function(){size();if(window.ResizeObserver){var b=document.getElementById('gaia-beta-bar');if(b)new ResizeObserver(size).observe(b);}});
window.addEventListener('resize',size);
})();</script>`;
function injectHtml(html, area, origin, workspace=false) {
  let out = html.replaceAll(PROXY_ORIGIN, origin);
  out = out.replace(/navigator\.serviceWorker\.register\(\s*['"]\/sw\.js['"]\s*\)/g, 'Promise.reject(new Error("no service worker in the beta"))');
  // The script goes first (before the page's own scripts); the style goes last in <head> so it wins over the page's CSS.
  const head = `<meta name="robots" content="noindex,nofollow">${headScript(area,workspace)}`;
  const style = `<style id="gaia-beta-css">${BANNER_CSS}${area === 'admin' ? ADMIN_EXTRA_CSS : APP_EXTRA_CSS}</style>`;
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => m + head) : head + out;
  out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, style + '</head>') : style + out;
  out = /<body[^>]*>/i.test(out) ? out.replace(/<body[^>]*>/i, (m) => m + bannerHtml(area)) : out + bannerHtml(area);
  return out;
}

// ---------- demo-only view of Control Center data ----------
// The staging database also mirrors 34 REAL legacy memberships (GHL contact ids, tiers, amounts). A beta visitor
// sees only fictional people: any list item that names a person, contact or email that is not a demo identity
// (fixture-… contact ids, …@….invalid / example.invalid emails) is dropped, and stray real-looking strings are masked.
const DEMO_CONTACT = /^fixture-/;
const DEMO_EMAIL = /@([a-z0-9-]+\.)*(invalid|example\.invalid)$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CONTACT_KEYS = /(^|_)contact_?id$|^contactIds$|^external_contact_id$/i;
const EMAIL_KEYS = /(^|_)email$|^emails$/i;
function itemIsReal(o) {
  for (const [k, v] of Object.entries(o)) {
    const vals = Array.isArray(v) ? v : [v];
    if (CONTACT_KEYS.test(k) && vals.some((x) => typeof x === 'string' && x && !DEMO_CONTACT.test(x))) return true;
    if (EMAIL_KEYS.test(k) && vals.some((x) => typeof x === 'string' && x && !DEMO_EMAIL.test(x))) return true;
  }
  return false;
}
function demoOnly(value) {
  let hidden = 0;
  const walk = (v) => {
    if (Array.isArray(v)) return v.filter((x) => { if (x && typeof x === 'object' && !Array.isArray(x) && itemIsReal(x)) { hidden++; return false; } return true; }).map(walk);
    if (v && typeof v === 'object') {
      if (itemIsReal(v) && v !== value) { hidden++; return null; }
      const o = {}; for (const [k, x] of Object.entries(v)) o[k] = walk(x); return o;
    }
    if (typeof v === 'string') return v.replace(EMAIL_RE, (e) => (DEMO_EMAIL.test(e) ? e : (hidden++, 'hidden in the beta')));
    return v;
  };
  const out = walk(value);
  if (out && typeof out === 'object' && Array.isArray(out.items) && typeof out.total === 'number') out.total = out.items.length;
  return { value: out, hidden };
}

// ---------- demo-only aggregates ----------
// Every count, total and sum the Control Center shows is recomputed from the demo people the beta can see, or blanked
// ("Demo data only"). The staging DB's real rows are never changed. Context is fetched upstream with the visitor's own
// (demo operator) cookies and cached briefly.
const DEMO_ONLY = 'Demo data only';
const PERSON_KEYS = ['person_id', 'personId', 'person_email', 'person_contact_id', 'external_contact_id', 'emails', 'contactIds'];
const IDENT_KEYS = ['person_email', 'person_contact_id', 'external_contact_id', 'emails', 'contactIds'];
const isDemoIdent = (k, v) => (/email/i.test(k) ? DEMO_EMAIL.test(v) : DEMO_CONTACT.test(v));
/** 'keep' | 'drop' for a list item that may name a person. */
function personVerdict(o, demoIds) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'keep';
  if (!PERSON_KEYS.some((k) => k in o)) return 'keep';
  const idents = IDENT_KEYS.flatMap((k) => (o[k] == null ? [] : [].concat(o[k]).filter((x) => x != null && x !== '').map((x) => [k, String(x)])));
  if (idents.length) return idents.every(([k, v]) => isDemoIdent(k, v)) ? 'keep' : 'drop';
  const id = o.person_id ?? o.personId;
  return id && demoIds.has(String(id)) ? 'keep' : 'drop';
}
const DEMO_ACTOR = /^(operator:[0-9a-f-]{36}|beta-demo-setup|cli:beta-setup|beta-setup)$/;
function upJson(req, path) {
  const headers = forwardHeaders(req); delete headers['content-type']; headers.accept = 'application/json';
  return new Promise((resolve) => {
    const r = http.request({ ...PROXY, method: 'GET', path, headers, timeout: 15000 }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(Buffer.concat(c).toString('utf8')) : null); } catch { resolve(null); } });
    });
    r.on('timeout', () => r.destroy()); r.on('error', () => resolve(null)); r.end();
  });
}
const ctxCache = new Map();   // operator cookie hash -> { at, ctx }
async function demoContext(req) {
  const key = crypto.createHash('sha256').update(String(parseCookies(req.headers.cookie)[OP_COOKIE] || '')).digest('hex');
  const hit = ctxCache.get(key); if (hit && Date.now() - hit.at < 20000) return hit.ctx;
  const persons = (await upJson(req, '/api/admin/membership2/persons?limit=200'))?.items || [];
  const demo = persons.filter((p) => { const ids = [...(p.emails || []).map((v) => ['email', v]), ...(p.contactIds || []).map((v) => ['contact', v])]; return ids.length && ids.every(([k, v]) => isDemoIdent(k, v)); });
  const demoIds = new Set(demo.map((p) => String(p.personId)));
  const details = (await Promise.all([...demoIds].map((id) => upJson(req, `/api/admin/membership2/persons/${id}`)))).filter(Boolean);
  const legacyAll = (await upJson(req, '/api/admin/membership2/legacy?limit=200'))?.items || [];
  const legacy = legacyAll.filter((x) => DEMO_CONTACT.test(String(x.external_contact_id || '')) && personVerdict(x, demoIds) === 'keep');
  const pending = ((await upJson(req, '/api/admin/membership2/requests?status=pending&limit=200'))?.items || []).filter((x) => personVerdict(x, demoIds) === 'keep' && !itemIsReal(x));
  const reviews = ((await upJson(req, '/api/admin/membership2/refund-reviews?status=open'))?.items || []).filter((x) => personVerdict(x, demoIds) === 'keep');
  const catalog = (await upJson(req, '/api/membership2/plans'))?.plans || [];
  const price = Object.fromEntries(catalog.map((p) => [p.key, p.prices || {}]));
  const subs = details.flatMap((d) => d.subscriptions || []).filter((s) => s.owner_type === 'gaia');
  const members = Object.values(subs.reduce((a, s) => { const k = s.plan_key + '|' + s.status; a[k] = a[k] || { plan: s.plan_key, status: s.status, n: 0 }; a[k].n++; return a; }, {}))
    .sort((x, y) => (x.plan + x.status).localeCompare(y.plan + y.status));
  const mrrCents = subs.filter((s) => ['active', 'past_due'].includes(s.status) && ['stripe', 'manual'].includes(s.provider) && s.source !== 'legacy_import')
    .reduce((t, s) => t + (s.billing_interval === 'month' ? Number(price[s.plan_key]?.month || 0) : s.billing_interval === 'year' ? Number(price[s.plan_key]?.year || 0) / 12 : 0), 0);
  const w = details.map((d) => d.wallet).filter(Boolean);
  const sum = (b) => w.reduce((t, x) => t + Number(x[b]?.coins || 0), 0);
  const wallets = { wallets: w.filter((x) => Number(x.total?.coins || 0) > 0 || x.lastGrantAt).length, granted: sum('granted'), goodwill: sum('goodwill'), purchased: sum('purchased'), legacy: sum('legacy') };
  const legacyByState = legacy.reduce((a, x) => { a[x.state] = (a[x.state] || 0) + 1; return a; }, {});
  const lastSeen = legacy.map((x) => x.last_seen_at).filter(Boolean).sort().pop() || null;
  const ctx = { demoIds, members, mrrCents: Math.round(mrrCents), coinsOutstanding: w.reduce((t, x) => t + Number(x.total?.coins || 0), 0), wallets, legacy, legacyByState, lastSeen,
    pendingRequests: pending.length, openRefundReviews: reviews.length };
  ctxCache.set(key, { at: Date.now(), ctx }); if (ctxCache.size > 200) ctxCache.clear();
  return ctx;
}
const ageOf = (t) => (t ? Math.round((Date.now() - new Date(t).getTime()) / 1000) : null);
function filterLists(v, demoIds, counter) {
  if (Array.isArray(v)) return v.filter((x) => { if (personVerdict(x, demoIds) === 'drop') { counter.n++; return false; } return true; }).map((x) => filterLists(x, demoIds, counter));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = filterLists(x, demoIds, counter); return o; }
  return v;
}
/** The demo-only view of one Control Center Membership 2.0 read. */
async function demoView(req, path, buf) {
  const sub = path.split('?')[0].slice('/api/admin/membership2/'.length);
  let j = JSON.parse(buf.toString('utf8'));
  const ctx = await demoContext(req);
  const blanked = []; const counter = { n: 0 };
  const m = /^persons\/([0-9a-f-]{36})$/.exec(sub);
  if (m && !ctx.demoIds.has(m[1])) return { value: { ok: false, code: 'NOT_FOUND', message: 'Not found in the beta preview (demo people only)' }, hidden: 1, blanked };
  j = filterLists(j, ctx.demoIds, counter);
  if (sub === 'overview' && j.ok !== false) {
    Object.assign(j, { members: ctx.members, mrrCents: ctx.mrrCents, coinsOutstanding: ctx.coinsOutstanding, pendingRequests: ctx.pendingRequests, openRefundReviews: ctx.openRefundReviews, legacyByState: ctx.legacyByState });
    j.openAlerts = null; blanked.push('Open alerts');
    j.lastReconciliation = { [DEMO_ONLY]: 'reconciliation figures are not shown in the beta preview' }; blanked.push('Last reconciliation');
  }
  if (sub === 'legacy' && Array.isArray(j.items)) {
    j.items = j.items.filter((x) => DEMO_CONTACT.test(String(x.external_contact_id || '')));
    j.total = j.items.length;
    j.freshness = { lastSeenAt: ctx.lastSeen, ageSeconds: ageOf(ctx.lastSeen), lastRun: null }; blanked.push('last reader run');
  }
  if (sub === 'coins' && j.totals) { j.totals = ctx.wallets; }
  if (sub === 'health' && j.ok !== false) {
    for (const k of ['webhookBacklog', 'oldestPendingWebhookAt', 'heldCoinOperations', 'oldestHoldExpiresAt']) if (k in j) j[k] = DEMO_ONLY;
    j.legacyMirrorAgeSeconds = ageOf(ctx.lastSeen); blanked.push('health counters');
  }
  if (sub === 'reconciliation') { j.runs = []; j.openAlerts = []; blanked.push('reconciliation'); }
  if (sub === 'dead-letters') { j.webhooks = []; blanked.push('dead letters'); }
  if (sub === 'audit' && Array.isArray(j.items)) {
    j.items = j.items.filter((a) => { const keep = DEMO_ACTOR.test(String(a.actor_id || '')) || (/^person:/.test(a.actor_id || '') && ctx.demoIds.has(String(a.actor_id).slice(7))) || ctx.demoIds.has(String(a.entity_id || ''));
      if (!keep) counter.n++; return keep; });
  }
  const f = demoOnly(j);
  return { value: f.value, hidden: counter.n + f.hidden, blanked };
}

// ---------- beta-only plan access for demo members (Membership 2.0 catalog drives the whole app) ----------
// For a demo member on Free / Standard / Professional / Inner Circle (and the pilot, who has no plan), the app's
// EXISTING access answers are rebuilt from that member's Membership 2.0 entitlements (/api/membership2/me and
// /api/membership2/plans, i.e. the membership service and its catalog), in the shape the app already reads. The live
// app and the production proxy are not touched; nothing here runs outside the beta. Map: /root/audits/beta-plan-access-map.md
const TIER_DEMOS = new Set(['fixture-beta-demo-free', 'fixture-beta-demo-pilot', 'fixture-beta-demo-standard', 'fixture-beta-demo-professional', 'fixture-beta-demo-inner-circle']);
const LEGACY_KEYS = ['free', 'silver', 'gold', 'diamond'];   // the app's own plan-key slots, in tier order; labels come from Membership 2.0
const SIM_PATH = '/beta/simulated';
const memberIdCache = new Map();   // sha256(member cookie) -> contactId
async function demoMemberId(req) {
  const v = parseCookies(req.headers.cookie)[MEMBER_COOKIE]; if (!v) return null;
  const k = crypto.createHash('sha256').update(v).digest('hex');
  if (memberIdCache.has(k)) return memberIdCache.get(k);
  const s = await upJson(req, '/api/auth/session');
  const id = s?.member?.contactId || null;
  memberIdCache.set(k, id); if (memberIdCache.size > 500) memberIdCache.clear();
  return id;
}
const planCache = { at: 0, plans: null };
async function m2Plans(req) {
  if(sandbox.read(req))return appPlans().plans;
  if (planCache.plans && Date.now() - planCache.at < 60000) return planCache.plans;
  const j = await upJson(req, '/api/membership2/plans');
  if (Array.isArray(j?.plans) && j.plans.length) { planCache.plans = j.plans; planCache.at = Date.now(); }
  return planCache.plans;
}
const usd = (cents) => '$' + (Number(cents) / 100).toLocaleString('en-US', { maximumFractionDigits: Number(cents) % 100 ? 2 : 0 });
/** The member's Membership 2.0 position: plans (tier order), their index, what they have, and per benefit the lowest plan that has it. */
async function planAccess(req) {
  const plans = await m2Plans(req); if (!plans) return null;
  const workspace=sandbox.read(req);const me = workspace?appOverview(workspace.joined===false||workspace.signedOut===true?{...workspace,plan:'free',status:'guest'}:workspace):await upJson(req, '/api/membership2/me'); if (!me || me.ok === false) return null;
  const live = (me.membership || []).find((m) => m.hasAccess);
  let at = live ? plans.findIndex((p) => p.key === live.plan_key) : -1;
  const hasPlan = at >= 0;
  if (!hasPlan) at = Math.max(0, plans.findIndex((p) => p.prices && p.prices.none != null));
  const have = new Map(hasPlan ? (me.access || []).filter((a) => a.value !== false && a.value != null).map((a) => [a.key, a.value])
    : (plans[at].benefits || []).map((b) => [b.key, true]));
  const label = {}; const lowest = {};
  plans.forEach((p) => (p.benefits || []).forEach((b) => { label[b.key] = b.label; if (!(b.key in lowest)) lowest[b.key] = p.name; }));
  return { plans, at, hasPlan, live, have, label, lowest, current: plans[at], next: plans[at + 1] || null };
}
/** Catalog entitlements -> the app's entitlement types (only where the app has one; everything else is listed as unmapped). */
const CP_ORDER = ['support.inner_circle_call_monthly', 'support.group_coaching_monthly', 'community.state_of_union_calls', 'support.premium', 'community.newsletter',
  'perk.early_access', 'perk.conference_vip', 'perk.podcast_priority', 'perk.podcast_spotlight_eligibility', 'listing.badge.gaia_recommended'];
const CP_CALLS = new Set(['support.inner_circle_call_monthly', 'support.group_coaching_monthly', 'community.state_of_union_calls']);
const CALLS_PERKS = /^(support\.|perk\.|community\.state_of_union_calls$|community\.newsletter$|listing\.badge\.)/;
function mappedEntitlements(pa, keys) {
  const has = (k) => keys.has(k);
  const ent = (type, key, value) => ({ type, key, value, status: 'active', source: 'fixture', evidence_id: 'beta-demo-membership2', starts_at: null, expires_at: null, observed_at: new Date().toISOString() });
  const out = [];
  for (const k of keys) {
    if (/^(courses|certification)\./.test(k)) out.push(ent('course_access', k, { name: pa.label[k] || k, openUrl: SIM_PATH + '?what=course', openUrlIsFallback: false }));
    if (/^software\./.test(k)) out.push(ent('device_software', k, { name: pa.label[k] || k }));
  }
  if (has('community.access')) out.push(ent('community_access', 'all-gaia', { name: 'All Gaia Healers', openUrl: SIM_PATH + '?what=community', openUrlIsFallback: false }));
  if (has('community.inner_circle_channel')) out.push(ent('community_access', 'inner-circle', { name: pa.label['community.inner_circle_channel'], openUrl: SIM_PATH + '?what=community', openUrlIsFallback: false }));
  if (has('listing.featured')) out.push(ent('directory_level', '1', { level: 1 }));
  else if (has('listing.directory')) out.push(ent('directory_level', '3', { level: 3 }));
  if (has('crm.ghl_subaccount')) out.push(ent('crm_access', 'full-ghl-subaccount', { level: 'Full GHL subaccount' }));
  // Calls & Perks: catalog benefits the app has no screen for (coaching and support calls, newsletter, podcast, early access, conference VIP, directory badge).
  // The app's generic row shows `key` as the name, so the key carries the catalog label.
  const cpRank = (k) => { const i = CP_ORDER.indexOf(k); return i < 0 ? CP_ORDER.length : i; };
  for (const k of [...keys].filter((x) => CALLS_PERKS.test(x)).sort((a, b) => cpRank(a) - cpRank(b))) out.push(ent('calls_perks', pa.label[k] || k, { name: pa.label[k] || k, catalogKey: k, group: CP_CALLS.has(k) ? 'Calls' : 'Perks' }));
  const pct = pa.have.get('discount.certifications_pct');
  if (keys.has('discount.certifications_pct')) out.push(ent('discount', 'certification', { percent: typeof pct === 'number' ? pct : null, scope: 'off certifications' }));
  return out;
}
const TYPE_META = { course_access: ['Courses', 'course', 2], community_access: ['Community', 'community', 3], crm_access: ['Practice / CRM', 'level', 4], directory_level: ['Directory', 'level', 5], discount: ['Discounts', 'discount', 7], device_software: ['Software', 'module', 9], calls_perks: ['Calls & Perks', 'item', 6] };
function sectionsFor(ents) {
  const n = {}; ents.forEach((e) => { n[e.type] = (n[e.type] || 0) + 1; });
  const pl = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`;
  const cp = ents.filter((e) => e.type === 'calls_perks'); const calls = cp.filter((e) => CP_CALLS.has(e.value.catalogKey)).length;
  const summary = (type, c) => type === 'calls_perks' ? [calls && pl(calls, 'call'), c - calls && pl(c - calls, 'perk')].filter(Boolean).join(' · ') : pl(c, TYPE_META[type][1]);
  return Object.entries(n).map(([type, c]) => ({ type, title: TYPE_META[type][0], summary: summary(type, c), order: TYPE_META[type][2] })).sort((a, b) => a.order - b.order);
}
function nextGains(pa) {
  if (!pa.next) return [];
  const nowKeys = new Set(pa.have.keys()); const nextKeys = new Set((pa.next.benefits || []).map((b) => b.key));
  const a = mappedEntitlements(pa, nowKeys), b = mappedEntitlements({ ...pa, have: new Map([...nextKeys].map((k) => [k, k === 'discount.certifications_pct' ? (pa.have.get(k) ?? 20) : true])) }, nextKeys);
  const first = (l, t) => l.find((e) => e.type === t);
  const g = [];
  for (const t of ['crm_access', 'directory_level', 'discount']) { const x = first(a, t), y = first(b, t); if (y && JSON.stringify(x?.value) !== JSON.stringify(y.value)) g.push({ type: t, from: x ? (x.value.level ?? x.value.percent ?? x.key) : null, to: t === 'discount' ? y.value.percent : (y.value.level ?? y.key) }); }
  for (const t of ['course_access', 'device_software', 'community_access', 'calls_perks']) { const d = b.filter((e) => e.type === t).length - a.filter((e) => e.type === t).length; if (d > 0) g.push({ type: t, from: null, to: `${d} more` }); }
  return g;
}
const BETA_DEMO_COURSE = 'Fictional demo course for the Gaia Healers beta preview.';
/** GET rewrites for a demo member's app session; returns a JSON value or null (pass the upstream answer through). */
async function demoAppView(req, path) {
  const p = path.split('?')[0];
  const WATCH = ['/api/member/access', '/api/member/profile', '/api/member/courses', '/api/courses', '/api/membership/plans', '/api/member/communities', '/api/academy/me'];
  if (!WATCH.includes(p)) return null;
  const id = await demoMemberId(req);
  const tierDemo = Boolean(sandbox.read(req)) || (id && TIER_DEMOS.has(id));
  if (p === '/api/membership/plans') {
    // Every beta session: no checkout link may leave the beta. Tier demos see the Membership 2.0 plans in the app's own plan shape.
    if (!tierDemo) { const j = await upJson(req, path); if (!j) return null; (j.plans || []).forEach((x) => { x.checkoutUrl = SIM_PATH + '?what=checkout&plan=' + encodeURIComponent(x.key); }); return j; }
    const pa = await planAccess(req); if (!pa) return null;
    return { ok: true, beta: true, plans: pa.plans.map((x, i) => {
      const prev = pa.plans[i - 1]; const prevKeys = new Set(((prev && prev.benefits) || []).map((b) => b.key));
      const adds = (x.benefits || []).filter((b) => !prevKeys.has(b.key)).map((b) => b.label);
      const m = x.prices || {};
      return { key: LEGACY_KEYS[i] || x.key, label: x.name, subtitle: 'Gaia Healers Membership 2.0',
        prices: m.none != null ? { monthly: '$0', annual: '$0' } : { monthly: m.month != null ? usd(m.month) + '/mo' : '', annual: m.year != null ? usd(m.year) + '/yr' : '' },
        displayBenefits: [...(prev ? ['Everything in ' + prev.name + ', plus:'] : []), ...(Number(x.monthlyCoins) > 0 ? [Number(x.monthlyCoins).toLocaleString('en-US') + ' coins every month'] : []), ...adds],
        checkoutUrl: SIM_PATH + '?what=checkout&plan=' + encodeURIComponent(x.key), featured: i === Math.min(2, pa.plans.length - 1) };
    }) };
  }
  if (!tierDemo) return null;
  const pa = await planAccess(req); if (!pa) return null;
  const keys = new Set(pa.have.keys());
  if (p === '/api/courses') {
    const all = [...new Set(pa.plans.flatMap((x) => (x.benefits || []).map((b) => b.key)))].filter((k) => /^(courses|certification)\./.test(k));
    return { ok: true, beta: true, courses: all.map((k) => ({ id: 'beta-demo-' + k, title: pa.label[k], description: BETA_DEMO_COURSE, image: '', category: /^certification\./.test(k) ? 'Certification' : 'Courses',
      accessLevel: 'With ' + pa.lowest[k], price: null, portalUrl: SIM_PATH + '?what=course', memberCount: 0 })) };
  }
  if (p === '/api/academy/me') {
    // "Your courses" in the Academy: the member's own course and certification entitlements (no lesson videos in the beta).
    const mine = [...keys].filter((k) => /^(courses|certification)\./.test(k));
    return { ok: true, authenticated: true, beta: true, courses: mine.map((k) => ({ id: 'beta-demo-' + k, title: pa.label[k], description: BETA_DEMO_COURSE, poster: '', sections: [], grantMatch: [pa.label[k]] })), progress: {}, count: mine.length, updatedAt: null };
  }
  if (p === '/api/member/courses') {
    const mine = [...keys].filter((k) => /^(courses|certification)\./.test(k));
    return { ok: true, authenticated: true, beta: true, courses: mine.map((k) => ({ id: 'beta-demo-' + k, title: pa.label[k], description: BETA_DEMO_COURSE, image: '', category: '', state: 'unlocked',
      openUrl: SIM_PATH + '?what=course', openUrlIsFallback: false, matchedBy: 'beta-demo-membership2', updatedAt: null, progressAvailable: false })), count: mine.length, tagHints: [], portalUrl: SIM_PATH + '?what=course', source: 'beta-demo-membership2', reason: null };
  }
  const up = await upJson(req, path); if (!up) return null;
  if (p === '/api/member/profile') { if (up.profile) { const workspace=sandbox.read(req);if(workspace?.displayName)up.profile.name=workspace.displayName;up.profile.membershipTier = pa.hasPlan ? pa.current.name : null; up.profile.tierMatchedBy = pa.hasPlan ? 'beta-demo-membership2' : null; } return up; }
  const ents = mappedEntitlements(pa, keys);
  const comm = () => {
    const unlocked = ents.filter((e) => e.type === 'community_access').map((e) => ({ id: e.key, name: e.value.name, state: 'unlocked', matchedBy: 'beta-demo-membership2', openUrl: e.value.openUrl, openUrlIsFallback: false }));
    const locked = keys.has('community.inner_circle_channel') ? [] : [{ id: 'inner-circle', name: pa.label['community.inner_circle_channel'], state: 'locked', reason: 'Included with ' + pa.lowest['community.inner_circle_channel'], matchedBy: null, openUrl: SIM_PATH + '?what=checkout', openUrlIsFallback: false }];
    if (!keys.has('community.access')) locked.unshift({ id: 'all-gaia', name: 'All Gaia Healers', state: 'locked', reason: 'Included with ' + pa.lowest['community.access'], matchedBy: null, openUrl: SIM_PATH + '?what=checkout', openUrlIsFallback: false });
    return { unlocked, locked };
  };
  if (p === '/api/member/communities') { up.communities = comm(); up.unknownAccessTags = []; return up; }
  // /api/member/access
  const slot = LEGACY_KEYS[pa.at] || 'free';
  up.membership = { key: slot, status: pa.hasPlan ? (pa.live.status || 'active') : 'none', billing_cycle: pa.hasPlan ? (pa.live.billing_interval === 'year' ? 'annual' : 'monthly') : 'none',
    started_at: null, renews_at: pa.hasPlan ? (pa.live.current_period_end || null) : null, ends_at: null, source: 'fixture', evidence_id: 'beta-demo-membership2', label: pa.current.name, subtitle: 'Gaia Healers Membership 2.0' };
  up.entitlements = ents; up.sections = sectionsFor(ents);
  up.upgrade = pa.next ? { next_key: LEGACY_KEYS[pa.at + 1] || pa.next.key, gains: nextGains(pa) } : null;
  up.communities = comm(); up.products = []; up.unknownAccessTags = [];
  if (up.member) { const workspace=sandbox.read(req);if(workspace){up.member.name=workspace.displayName||'Demo Member';up.member.contactId=workspaceMemberId(workspace);}up.member.membershipTier = pa.hasPlan ? pa.current.name : null; up.member.tierMatchedBy = pa.hasPlan ? 'beta-demo-membership2' : null; }
  if (up.meta) up.meta = { ...up.meta, degraded: false, stale: false, resolved_from: 'beta-demo-membership2', notes: ['Beta preview: access from the Membership 2.0 catalog'] };
  return up;
}

// ---------- reverse proxy ----------
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-prefix', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'forwarded', 'accept-encoding', 'x-gaia-fixture-key',
  'x-original-url', 'x-rewrite-url', 'x-http-method-override', 'x-http-method', 'x-method-override', 'x-operator-session', 'x-operator-ip', 'x-operator-ua', 'authorization-override']);
function forwardHeaders(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) h[k] = v;
  const jar = parseCookies(req.headers.cookie); delete jar[BETA_COOKIE]; delete jar.gaia_sandbox;delete jar.gaia_beta_workspace;                 // our own cookie stays here
  const c = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); if (c) h.cookie = c; else delete h.cookie;
  const ip = clientIp(req); h['x-forwarded-for'] = ip; h['x-real-ip'] = ip;
  return h;
}
async function proxyTo(target, req, res, path, { area = null, origin, body } = {}) {
  const headers = forwardHeaders(req);
  if (body && body.length) headers['content-length'] = String(body.length);
  const up = http.request({ ...target, method: req.method, path, headers, timeout: 20000 }, (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k) || k === 'content-length') out[k] = v;
    for (const k of ['access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-expose-headers', 'content-security-policy']) delete out[k];
    if (r.headers['set-cookie']) out['set-cookie'] = [].concat(r.headers['set-cookie']).map((c) => adaptCookie(req, c));
    Object.assign(out, SEC_HEADERS); out['cache-control'] = 'no-store';
    const ct = String(r.headers['content-type'] || '');
    if (!area && path.startsWith('/api/admin/membership2/') && !/application\/json/i.test(ct)) {r.resume(); return sendJson(res,502,{ok:false,code:'BETA_FILTER',message:'Only demo-filtered JSON is available in the beta.'});}
    const filterJson = !area && req.method === 'GET' && path.startsWith('/api/admin/membership2/') && /application\/json/.test(ct);
    if (filterJson) {
      const chunks = []; r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        let buf = Buffer.concat(chunks);
        demoView(req, path, buf).then((v) => { buf = Buffer.from(JSON.stringify(v.value)); out['x-gaia-beta-hidden'] = String(v.hidden); if (v.blanked.length) out['x-gaia-beta-blanked'] = v.blanked.join(','); })
          .catch(() => { buf = Buffer.from(JSON.stringify({ ok: false, code: 'BETA_FILTER', message: 'Not available in the beta preview' })); })
          .finally(() => { out['content-length'] = String(buf.length); res.writeHead(r.statusCode || 502, out); res.end(buf); });
      });
      return;
    }
    const rewrite = area && (/text\/html|javascript/.test(ct));
    if (!rewrite) { res.writeHead(r.statusCode || 502, out); return r.pipe(res); }
    const chunks = []; r.on('data', (c) => chunks.push(c));
    r.on('end', () => {
      let text = Buffer.concat(chunks).toString('utf8');
      text = /text\/html/.test(ct) ? injectHtml(text, area, origin, Boolean(sandbox.read(req))) : text.replaceAll(PROXY_ORIGIN, origin);
      delete out['content-length']; const buf = Buffer.from(text, 'utf8'); out['content-length'] = String(buf.length);
      res.writeHead(r.statusCode || 502, out); res.end(buf);
    });
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', () => { if (!res.headersSent) sendJson(res, 502, { ok: false, code: 'UPSTREAM_UNAVAILABLE' }); else res.destroy(); });
  up.end(body);
}

// ---------- pages ----------
const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">`;
const PAGE_CSS = `
:root{--green:#16261F;--green2:#1F3329;--cream:#F4F1E8;--cream2:#E6E0CF;--ink:#16261F;--muted:#C9CFC4;--gold:#D9B86C}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--green);color:var(--cream);font:400 16px/1.6 'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh}
a{color:inherit}
.bar{position:sticky;top:0;z-index:10;background:var(--cream);color:var(--ink);border-bottom:2px solid var(--green);padding:8px 16px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-weight:600;font-size:14px}
.bar p{margin:0;flex:1 1 260px}
.bar a{display:inline-flex;align-items:center;min-height:36px;padding:6px 14px;border-radius:999px;text-decoration:none;font-weight:700;font-size:13.5px;border:2px solid var(--green)}
.bar a.back{background:var(--green);color:var(--cream)}
.bar a:hover{text-decoration:underline}
:focus-visible{outline:3px solid var(--gold);outline-offset:3px}
.bar a:focus-visible{outline-color:#8A6414}
main{max-width:1040px;margin:0 auto;padding:40px 16px 64px}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:28px}
.brand img{width:44px;height:44px}
.brand span{font:600 22px/1 'Cormorant Garamond',Georgia,serif;letter-spacing:.02em}
h1{font:600 clamp(34px,5.4vw,58px)/1.05 'Cormorant Garamond',Georgia,serif;margin:0 0 16px;letter-spacing:-.01em}
h2{font:600 clamp(24px,3vw,32px)/1.15 'Cormorant Garamond',Georgia,serif;margin:0 0 12px}
h3{font-size:18px;margin:0 0 6px}
.lead{font-size:clamp(17px,2vw,19px);color:var(--cream2);max-width:640px;margin:0 0 28px}
.kicker{display:inline-block;background:rgba(244,241,232,.1);border:1px solid rgba(244,241,232,.3);color:var(--cream);padding:4px 12px;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:.04em;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin:0 0 32px;padding:0;list-style:none}
.card{background:var(--green2);border:1px solid rgba(244,241,232,.18);border-radius:18px;padding:20px}
.card p{margin:0;color:var(--cream2);font-size:15px}
.panel{background:var(--cream);color:var(--ink);border-radius:20px;padding:24px;max-width:520px}
.panel p{margin:0 0 14px;color:#2B3A33}
label{display:block;font-weight:700;margin-bottom:6px}
input[type=password]{width:100%;font:inherit;padding:12px 14px;border-radius:12px;border:2px solid #4A5A52;background:#fff;color:var(--ink);min-height:48px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:10px 20px;border-radius:999px;border:2px solid var(--green);background:var(--green);color:var(--cream);font-weight:700;font-size:15px;line-height:1.2;font-family:inherit;cursor:pointer;text-decoration:none}
.btn.light{background:var(--cream);color:var(--ink);border-color:var(--cream)}
.btn.ghost{background:transparent;color:var(--cream);border-color:var(--cream)}
.row{display:flex;flex-wrap:wrap;gap:12px;margin-top:14px}
.err{background:#FBE3E0;color:#7A1C12;border:2px solid #7A1C12;border-radius:12px;padding:10px 14px;margin:0 0 14px;font-weight:600}
.ok{background:#E3F0E2;color:#16261F;border:2px solid #2F6B3A;border-radius:12px;padding:10px 14px;margin:0 0 14px;font-weight:600}
.note{background:rgba(217,184,108,.14);border:2px solid var(--gold);color:var(--cream);border-radius:14px;padding:12px 16px;font-weight:600;margin:0 0 28px}
.choose form{margin:0}
.choose .card{display:flex;flex-direction:column;gap:12px}
.choose .card .btn{margin-top:auto;width:100%;background:var(--cream);color:var(--ink);border-color:var(--cream)}
.foot{margin-top:40px;color:var(--muted);font-size:14px}
.foot form{display:inline}
.linkbtn{background:none;border:0;color:var(--cream);text-decoration:underline;font:inherit;cursor:pointer;padding:0}
@media (max-width:480px){main{padding-top:28px}.panel{padding:18px}}
`;
function shell({ title, body, area = 'landing' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><meta name="theme-color" content="#16261F">
<link rel="icon" href="/beta-assets/gaia-mark.svg">${FONT_LINKS}<style>${PAGE_CSS}</style></head><body data-area="${area}">
<div class="bar" role="region" aria-label="Gaia Healers beta preview notice"><p>Beta preview · Coming after Elevate 2026 · Test data, no real payments</p>
<a class="back" href="${LIVE_APP}" rel="noopener">Back to the current app</a></div>
<main id="main">${body}</main></body></html>`;
}
const brand = `<div class="brand"><img src="/beta-assets/gaia-mark.svg" alt=""><span>Gaia Healers</span></div>`;
function landingPage({ error = '', signedIn = false } = {}) {
  const form = signedIn
    ? `<div class="panel"><p class="ok" role="status">You are signed in to the beta preview.</p><div class="row"><a class="btn" href="/choose">Continue to the beta</a></div></div>`
    : `<form class="panel" method="post" action="/login" aria-labelledby="staff-h">
<h2 id="staff-h" style="color:#16261F">For Gaia Healers staff</h2>
<p>The working preview is for the Gaia Healers management and staff team. Enter the staff beta password you were given.</p>
${error ? `<p class="err" role="alert" id="pw-err">${esc(error)}</p>` : ''}
<label for="pw">Staff beta password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required ${error ? 'aria-invalid="true" aria-describedby="pw-err"' : ''}>
<div class="row"><button class="btn" type="submit">Open the beta preview</button></div></form>`;
  return shell({ title: 'Gaia Healers Membership 2.0 beta', body: `${brand}
<span class="kicker">COMING AFTER ELEVATE 2026 · 20–22 NOVEMBER</span>
<h1>Gaia Healers Membership 2.0</h1>
<p class="lead">A simpler, fairer Gaia Healers membership is on its way. This is an early look at it, for our team, before it opens to members after Elevate 2026.</p>
<ul class="grid" aria-label="What is coming">
<li class="card"><h3>Clear plans</h3><p>Plans with plain prices and benefits, shown the same way in the app and to our team.</p></li>
<li class="card"><h3>Gaia Healers coins</h3><p>A monthly coin allowance for priced AI features, with purchased coins that never expire and a full history.</p></li>
<li class="card"><h3>Easy changes</h3><p>Members can see what a plan change or cancellation means before anything happens.</p></li>
<li class="card"><h3>A fair move for today’s members</h3><p>Current Silver, Gold and Diamond members get a guided move with what they already have.</p></li>
</ul>
<p class="note">Nothing changes in the Gaia Healers app today. Your membership, payments and bookings stay exactly as they are.</p>
${form}
<div class="row" style="margin-top:28px"><a class="btn ghost" href="${LIVE_APP}" rel="noopener">Back to the current app</a></div>
<p class="foot">Questions? Ask the Gaia Healers team at Elevate 2026.</p>` });
}
function choosePage(msg = '') {
  const m = Object.entries(MEMBERS).map(([k, v]) => `<li class="card"><h3>${esc(v.title)}</h3><p>${esc(v.text)}</p>
<form method="post" action="/enter/member/${k}"><button class="btn" type="submit">Look around as the ${esc(v.title.toLowerCase())}</button></form></li>`).join('');
  const s = Object.entries(STAFF).map(([k, v]) => `<li class="card"><h3>${esc(v.title)}</h3><p>${esc(v.text)}</p>
<form method="post" action="/enter/staff/${k}"><button class="btn" type="submit">Open the Control Center as ${esc(v.title.toLowerCase())}</button></form></li>`).join('');
  return shell({ title: 'Choose how to look around · Gaia Healers beta', area: 'choose', body: `${brand}
<h1>Choose how to look around</h1>
<section class="card"><h2>Explore Gaia from the beginning</h2><p>Start as a visitor, try the free tools, join Free, then choose a paid test membership in the same Gaia experience.</p><form method="post" action="/enter/visitor"><button class="btn" type="submit">Explore the full website as a guest</button></form></section>
<section class="card"><h2>Test the full future membership</h2><p>Make test purchases, spend coins, publish practitioner plans, subscribe as a client, try CRM workflows and staff approvals. Your fictional records persist and can be reset.</p><a class="btn" href="/sandbox">Open the working membership sandbox</a></section>
<p class="note" role="note">Everything here is test data with fictional people. No real payments are possible.</p>
${msg ? `<p class="err" role="alert">${esc(msg)}</p>` : ''}
<section class="choose" aria-labelledby="as-member"><h2 id="as-member">As a member</h2>
<p class="lead">See the Membership screen in the Gaia Healers app the way a member will.</p><ul class="grid">${m}</ul></section>
<section class="choose" aria-labelledby="as-staff"><h2 id="as-staff">As staff in the Control Center</h2>
<p class="lead">See the Membership 2.0 area of the Gaia Healers Control Center with a fictional demo operator. Actions are disabled: buttons show what would happen, and nothing is changed.</p><ul class="grid">${s}</ul></section>
<p class="foot">Signed in to the beta preview for 12 hours. <form method="post" action="/logout"><button class="linkbtn" type="submit">Sign out of the beta</button></form></p>` });
}

// ---------- request handling ----------
function log(req, status, t0) {
  const p = String(req.url || '').split('?')[0].slice(0, 200).replace(/[^\x21-\x7e]/g, '?');
  console.log(`${req.method} ${p} ${status} ${Date.now() - t0}ms`);
}
async function handle(req, res) {
  const origin = originOf(req);
  if (!origin) return send(res, 421, 'unknown host', { 'content-type': 'text/plain' });
  // Strict request target: origin-form only ("/path?query"), no absolute URLs, no "*", no CONNECT.
  // The path may not contain percent-encoding, dot segments, backslashes, NUL, ";" parameters or "//": none of the
  // beta's own pages, the app, the Control Center or the API use them, so every encoded or traversal trick is refused
  // before routing (and before the gate decides anything).
  const raw = String(req.url || '');
  const rawPath = raw.split('?')[0];
  if (!raw.startsWith('/') || /[%\\;\x00-\x20\x7f]|\/\/|(^|\/)\.\.?(\/|$)/.test(rawPath)) return send(res, 400, 'bad request', { 'content-type': 'text/plain' });
  let url; try { url = new URL(raw, origin); } catch { return send(res, 400, 'bad request'); }
  const p = url.pathname;
  if (p !== rawPath) return send(res, 400, 'bad request', { 'content-type': 'text/plain' });

  if (!['GET', 'HEAD', 'POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return send(res, 405, 'method not allowed', { 'content-type': 'text/plain' });
  // ----- public -----
  if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'content-type': 'text/plain; charset=utf-8' });
  if (p === '/healthz') return sendJson(res, 200, { ok: true });
  if (p === '/beta-assets/gaia-mark.svg') return send(res, 200, fs.readFileSync(MARK), { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' });
  if (p === '/' && (req.method === 'GET' || req.method === 'HEAD')) return sendPage(res, 200, landingPage({ signedIn: betaOk(req) }));
  if (p === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (!sameOrigin(req)) return sendPage(res, 403, landingPage({ error: 'Please use the form on this page.' }));
    const wait = loginLimit.hit(ip);
    if (wait) return sendPage(res, 429, landingPage({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.` }), { 'retry-after': String(wait) });
    let pw = '';
    try { pw = new URLSearchParams((await readBody(req, 4096)).toString('utf8')).get('password') || ''; } catch { return send(res, 413, 'too big'); }
    if (!tsEq(pw, B.BETA_PASSWORD)) return sendPage(res, 401, landingPage({ error: 'That password is not right. Please try again.' }));
    loginLimit.reset(ip);
    return send(res, 303, '', { location: '/choose', 'set-cookie': betaCookie(req) });
  }

  // ----- everything else needs the beta session -----
  if (!betaOk(req)) {
    const wantsHtml = (req.method === 'GET' || req.method === 'HEAD') && /text\/html/.test(String(req.headers.accept || ''));
    if (wantsHtml) return send(res, 303, '', { location: '/' });
    return sendJson(res, 401, { ok: false, code: 'BETA_AUTH_REQUIRED', message: 'Sign in to the Gaia Healers beta preview first.' });
  }

  if(p==='/beta-learning-player.js'&&['GET','HEAD'].includes(req.method))return send(res,200,fs.readFileSync(new URL('./beta-learning-player.js',import.meta.url)),{'content-type':'application/javascript; charset=utf-8'});
  // Only the local beta orientation clip is exposed; original course sources are never inferred.
  if(p.startsWith('/beta-media/')){
    if(!['GET','HEAD'].includes(req.method))return send(res,405,'method not allowed');
    const files={'/beta-media/membership-walkthrough.mp4':['membership-walkthrough.mp4','video/mp4'],'/beta-media/membership-walkthrough.webm':['membership-walkthrough.webm','video/webm'],'/beta-media/membership-walkthrough.vtt':['membership-walkthrough.vtt','text/vtt; charset=utf-8']};
    const entry=files[p];if(!entry)return send(res,404,'not found');
    const file=new URL('./beta-media/'+entry[0],import.meta.url).pathname;if(!fs.existsSync(file))return send(res,503,'Media is being prepared.');
    const size=fs.statSync(file).size;let start=0,end=size-1,status=200;
    if(req.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!m||Number(m[1])>=size||(m[2]&&Number(m[2])<Number(m[1])))return send(res,416,'',{'content-range':`bytes */${size}`});start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),size-1):size-1;status=206;}
    res.writeHead(status,{...SEC_HEADERS,'content-type':entry[1],'accept-ranges':'bytes','content-length':end-start+1,'cache-control':'private, no-store',...(status===206?{'content-range':`bytes ${start}-${end}/${size}`}:{})});
    if(req.method==='HEAD')return res.end();fs.createReadStream(file,{start,end}).on('error',()=>res.destroy()).pipe(res);return;
  }
  if(p==='/enter/visitor'&&req.method==='POST'){if(!sameOrigin(req))return send(res,403,'forbidden');return send(res,303,'',{location:'/app/home.html','set-cookie':[sandbox.startGuest(req),clearCookie(req,MEMBER_COOKIE),clearCookie(req,ADMIN_COOKIE),clearCookie(req,OP_COOKIE,OP_PATH)]});}
  if(p==='/sandbox/preview'&&(req.method==='GET'||req.method==='HEAD')){const workspace=sandbox.read(req);if(!workspace)return send(res,303,'',{location:'/sandbox'});if(workspace.joined===false||workspace.signedOut===true)return send(res,303,'',{location:'/app/home.html'});const c=await fixtureCookie(MEMBERS.standard.fixture);if(!c)return sendJson(res,503,{ok:false,code:'BETA_FIXTURE_UNAVAILABLE'});return send(res,303,'',{location:'/app/home.html?view=membership','set-cookie':[adaptCookie(req,c),clearCookie(req,ADMIN_COOKIE),clearCookie(req,OP_COOKIE,OP_PATH)]});}
  if (await sandbox(req,res,url)) return;

  if (p === '/logout' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, 'forbidden');
    return send(res, 303, '', { location: '/', 'set-cookie': [clearCookie(req, BETA_COOKIE), sandbox.clear(req),clearCookie(req,'gaia_sandbox','/sandbox'), clearCookie(req, MEMBER_COOKIE), clearCookie(req, ADMIN_COOKIE), clearCookie(req, OP_COOKIE, OP_PATH)] });
  }
  if (p === SIM_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
    const what = url.searchParams.get('what');
    if(what==='course'&&!sandbox.read(req)){const demo=await demoMemberId(req);if(demo&&TIER_DEMOS.has(demo)){const pa=await planAccess(req);if(pa?.current)return send(res,303,'',{location:'/sandbox/academy','set-cookie':sandbox.startTier(req,pa.current.key)});}}
    if(sandbox.read(req))return send(res,303,'',{location:what==='course'?'/sandbox/academy':what==='community'?'/sandbox/services':'/sandbox/membership'});
    const line = what === 'course' ? 'In the live app this opens the course in the Gaia Healers Academy. Course content is not part of the beta preview.'
      : what === 'community' ? 'In the live app this opens the community in the Gaia Healers portal. Communities are not part of the beta preview.'
      : 'In the live app this opens a secure checkout for the plan. In the beta preview nothing is sent.';
    return sendPage(res, 200, shell({ title: 'Simulated · Gaia Healers beta', area: 'choose', body: `${brand}<h1>Simulated in the beta preview</h1>
<p class="note" role="status">No payment or change was made.</p><p class="lead">${esc(line)}</p>
<div class="row"><a class="btn light" href="/app/home.html?view=membership">Back to the Membership screen</a><a class="btn ghost" href="/choose">Switch view</a></div>` }));
  }
  if (p === '/choose' && (req.method === 'GET' || req.method === 'HEAD')) {
    const msg = url.searchParams.get('m') === 'staff' ? 'Please choose a staff role first.' : url.searchParams.get('m') === 'fail' ? 'That view could not be opened just now. Please try again in a minute.' : '';
    return sendPage(res, 200, choosePage(msg));
  }
  let m;
  if ((m = /^\/enter\/(member|staff)\/([a-z]+)$/.exec(p)) && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, 'forbidden');
    const wait = enterLimit.hit(clientIp(req)); if (wait) return send(res, 429, 'Too many sign-ins. Try again later.', { 'retry-after': String(wait), 'content-type': 'text/plain' });
    if (m[1] === 'member') {
      const who = MEMBERS[m[2]]; if (!who) return send(res, 404, 'not found');
      const c = await fixtureCookie(who.fixture);
      if (!c) return send(res, 303, '', { location: '/choose?m=fail' });
      return send(res, 303, '', { location: '/app/home.html?view=membership', 'set-cookie': [sandbox.clear(req),adaptCookie(req, c), clearCookie(req, ADMIN_COOKIE), clearCookie(req, OP_COOKIE, OP_PATH)] });
    }
    if (!STAFF[m[2]]) return send(res, 404, 'not found');
    const vip = clientIp(req); const con = await consoleCookie(vip); const op = con && await operatorSession(m[2], con.value, vip);
    if (!con || !op) return send(res, 303, '', { location: '/choose?m=fail' });
    const conAge = Math.max(60, Math.floor((con.exp - Date.now()) / 1000)), opAge = Math.max(60, Math.floor((op.exp - Date.now()) / 1000));
    return send(res, 303, '', { location: '/admin/#membership2', 'set-cookie': [
      `${ADMIN_COOKIE}=${con.value}; ${cookieAttrs(req, [`Max-Age=${conAge}`])}`,
      `${OP_COOKIE}=${op.value}; Path=${OP_PATH}; HttpOnly; SameSite=Strict${isHttps(req) ? '; Secure' : ''}; Max-Age=${opAge}`,
      sandbox.clear(req),clearCookie(req, MEMBER_COOKIE)] });
  }

  if(p==='/home.html'&&(req.method==='GET'||req.method==='HEAD'))return send(res,303,'',{location:'/app/home.html'+url.search});

  // ----- /api -> staging proxy -----
  if (p === '/api' || p.startsWith('/api/')) {
    if (url.searchParams.has('_method')) return sendJson(res, 400, { ok: false, code: 'BETA_BAD_REQUEST', message: 'Method overrides are not accepted by the beta preview' });
    if(p==='/api/member/path/event'&&req.method==='POST'&&sandbox.read(req)){
      if(!sameOrigin(req))return sendJson(res,403,{ok:false,error:'forbidden'});
      try{const body=JSON.parse((await readBody(req,2048)).toString('utf8'));return sendJson(res,200,{ok:true,state:sandbox.pathEvent(req,body)});}catch{return sendJson(res,409,{ok:false,error:'path_action_unavailable'});}
    }
    const pol = writePolicy(req.method, p);
    if (pol.block) return pol.block === 204 ? send(res, 204, '') : sendJson(res, pol.block, { ok: false, code: 'NOT_FOUND', error: 'Not found.' });
    if (pol.kind) {
      req.resume();
      const message = pol.kind === 'disabled' ? DISABLED : SIMULATED;
      // The on-page beta notice is shown for refused writes only (not for blocked background reads).
      return sendJson(res, pol.status, { ok: false, code: pol.kind === 'disabled' ? 'BETA_DISABLED' : 'BETA_SIMULATED', beta: true, message, error: message }, req.method === 'GET' || req.method === 'HEAD' || pol.quiet ? {} : { 'x-gaia-beta': pol.kind });
    }
    if (pol.local) {
      req.resume();
      if(pol.local==='member-logout'&&sandbox.read(req)){if(!sameOrigin(req))return send(res,403,'forbidden');sandbox.signOut(req);}
      const cookies = { 'admin-logout': [clearCookie(req, ADMIN_COOKIE), clearCookie(req, OP_COOKIE, OP_PATH)], 'op-logout': [clearCookie(req, OP_COOKIE, OP_PATH)], 'member-logout': [clearCookie(req, MEMBER_COOKIE)] }[pol.local];
      return sendJson(res, 200, { ok: true }, { 'set-cookie': cookies });
    }
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') { try { body = await readBody(req); } catch { return send(res, 413, 'too big'); } }
    if (req.method === 'GET') {
      const workspace=sandbox.read(req);const local=workspace&&appApi(workspace,url.pathname);if(local)return sendJson(res,200,local,{'x-gaia-beta-view':'sandbox'});
      const v = await demoAppView(req, url.pathname + url.search).catch(() => undefined);
      if (v === undefined) return sendJson(res, 503, { ok: false, code: 'BETA_UNAVAILABLE', message: 'Not available in the beta preview just now' });
      if (v) return sendJson(res, 200, v, { 'x-gaia-beta-view': 'membership2' });
    }
    return proxyTo(PROXY, req, res, url.pathname + url.search, { origin, body });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  // ----- /app -> staging web -----
  if (p === '/app' || p === '/app/') return send(res, 303, '', { location: '/app/home.html?view=membership' });
  if (p.startsWith('/app/')) {
    const workspace=sandbox.read(req);if((p==='/app/home.html'||p==='/app/index.html')&&workspace&&workspace.joined!==false&&workspace.signedOut!==true&&!parseCookies(req.headers.cookie)[MEMBER_COOKIE]){const c=await fixtureCookie(MEMBERS.standard.fixture);if(!c)return sendJson(res,503,{ok:false,code:'BETA_FIXTURE_UNAVAILABLE'});return send(res,303,'',{location:raw,'set-cookie':adaptCookie(req,c)});}
    if((p==='/app/home.html'||p==='/app/index.html')&&!sandbox.read(req)&&!parseCookies(req.headers.cookie)[MEMBER_COOKIE])return send(res,303,'',{location:raw,'set-cookie':sandbox.startGuest(req)});
    const sub = p.slice(4);
    if (sub === '/sw.js') return send(res, 404, 'not found');
    return proxyTo(WEB, req, res, sub + url.search, { area: 'app', origin });
  }
  // ----- /admin -> staging Control Center (static) -----
  if (p === '/admin') return send(res, 303, '', { location: '/admin/' });
  if (p.startsWith('/admin/')) {
    if ((p === '/admin/' || p === '/admin/index.html') && !parseCookies(req.headers.cookie)[ADMIN_COOKIE]) return send(res, 303, '', { location: '/choose?m=staff' });
    return proxyTo(ADMIN, req, res, p + url.search, { area: 'admin', origin });
  }
  return send(res, 404, 'not found', { 'content-type': 'text/plain' });
}

http.createServer((req, res) => {
  const t0 = Date.now();
  res.on('finish', () => log(req, res.statusCode, t0));
  handle(req, res).catch(() => { if (!res.headersSent) send(res, 500, 'error'); else res.destroy(); });
}).listen(PORT, HOSTIP, () => console.log(`[beta] http://${HOSTIP}:${PORT} -> web :${WEB.port}, proxy :${PROXY.port}, admin :${ADMIN.port}`));
