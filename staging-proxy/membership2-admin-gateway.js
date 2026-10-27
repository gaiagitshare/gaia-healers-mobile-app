/**
 * Gaia Healers Control Center: Membership 2.0 admin gateway, /api/admin/membership2/*
 * (docs/membership/CONTROL-CENTER.md §5).
 *
 * OFF unless MEMBERSHIP2_ADMIN=on with a loopback MEMBERSHIP_SERVICE_URL and a
 * dedicated MEMBERSHIP_ADMIN_SERVICE_TOKEN (an `admin:operate` client). While
 * off, handle() returns false and the proxy answers the normal 404.
 *
 * Every path needs the existing Control Center admin cookie (gaia_admin). All
 * paths except /status and /login also need the operator cookie gaia_operator
 * (HttpOnly, Secure, SameSite=Strict, Path=/api/admin/membership2), which holds
 * the operator session token. The token is set by /login and never returned
 * to JavaScript; the service token never leaves this process. Writes must be
 * JSON from the Control Center origin; /login and /password are rate-limited per
 * IP. The IP is deps.clientIp (adminRouter.clientIp): once the trusted-client-IP
 * fix (PR #287, staging-proxy/client-ip.js) is merged, that helper ignores
 * X-Forwarded-For / CF-Connecting-IP and trusts X-Real-IP only from loopback
 * (nginx), so this limit cannot be reset by rotating headers. Merge #287 first.
 *
 * /status (admin cookie only) also reports the server's environment and Stripe
 * mode, so the Control Center can show a STAGING / TEST MODE banner before any
 * operator signs in; /password changes the operator's own password (the only
 * write a restricted, must-change-password session may make).
 * Roles, the two-person rule and audit are enforced by the membership service.
 */

export const OPERATOR_COOKIE = 'gaia_operator';
const PREFIX = '/api/admin/membership2';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 10;                       // attempts per IP per window, /login and /password together (the service also locks an account after 5 failures)
const PATH_RE = /^\/api\/admin\/membership2\/[a-z0-9-]+(?:\/[a-z0-9-]+){0,3}$/;
const SESSION_RE = /^gop_[A-Za-z0-9_-]{43}$/;

export function membership2AdminConfig(env = process.env) {
  if (String(env.MEMBERSHIP2_ADMIN || '').trim().toLowerCase() !== 'on') return { enabled: false, reason: 'off' };
  let base;
  try { base = new URL(String(env.MEMBERSHIP_SERVICE_URL || '')); } catch { return { enabled: false, reason: 'service_url_missing' }; }
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) return { enabled: false, reason: 'service_url_not_loopback' };
  const token = String(env.MEMBERSHIP_ADMIN_SERVICE_TOKEN || '');
  if (!/^gms_[A-Za-z0-9_-]{43}$/.test(token)) return { enabled: false, reason: 'admin_service_token_missing' };
  const origins = String(env.MEMBERSHIP2_ADMIN_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { enabled: true, base: base.toString().replace(/\/+$/, ''), token, origins };
}

const cookie = (value, maxAge) => [`${OPERATOR_COOKIE}=${value}`, `Path=${PREFIX}`, 'HttpOnly', 'Secure', 'SameSite=Strict', `Max-Age=${Math.max(0, Math.floor(maxAge))}`].join('; ');

/**
 * deps for handle(): { origin, sendJson, readJsonBody, parseCookies, isAdmin(req), ownOrigins(req) -> string[], clientIp(req) }
 */
export function createMembership2AdminGateway({ env = process.env, fetch = globalThis.fetch, now = () => Date.now() } = {}) {
  const cfg = membership2AdminConfig(env);
  const attempts = new Map();   // ip -> { n, first }

  function limited(ip) {
    const t = now(); const r = attempts.get(ip);
    if (!r || t - r.first >= LOGIN_WINDOW_MS) { attempts.set(ip, { n: 1, first: t }); if (attempts.size > 1000) for (const [k, v] of attempts) if (t - v.first >= LOGIN_WINDOW_MS) attempts.delete(k); return 0; }
    r.n += 1;
    return r.n > LOGIN_MAX ? Math.ceil((LOGIN_WINDOW_MS - (t - r.first)) / 1000) : 0;
  }

  async function call(method, path, { body, session, ip, ua } = {}) {
    const headers = { authorization: `Bearer ${cfg.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (session) headers['x-operator-session'] = session;
    if (ip) headers['x-operator-ip'] = String(ip).slice(0, 64);
    if (ua) headers['x-operator-ua'] = String(ua).slice(0, 300);
    try {
      const r = await fetch(cfg.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      return { status: r.status, body: await r.json().catch(() => ({ ok: false, code: 'PROVIDER_UNAVAILABLE', message: 'bad answer from the membership service' })) };
    } catch {
      return { status: 503, body: { ok: false, code: 'PROVIDER_UNAVAILABLE', message: 'membership service unavailable' } };
    }
  }

  async function handle(req, res, url, deps) {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
    if (!cfg.enabled) return false;
    const { origin, sendJson } = deps;
    const reply = (status, body, headers) => { sendJson(res, status, body, origin, headers); return true; };
    if (!deps.isAdmin(req)) return reply(401, { ok: false, code: 'AUTH_REQUIRED', reason: 'admin_auth_required', message: 'Control Center sign-in required' });
    if (!PATH_RE.test(url.pathname) || !['GET', 'POST'].includes(req.method)) return reply(404, { ok: false, code: 'NOT_FOUND', message: 'no such route' });
    const sub = url.pathname.slice(PREFIX.length + 1);
    const raw = deps.parseCookies(req.headers.cookie || '')[OPERATOR_COOKIE] || '';
    const session = SESSION_RE.test(raw) ? raw : '';

    if (sub === 'status' && req.method === 'GET') {
      const me = session ? await call('GET', '/v1/admin/me', { session }) : null;
      const envr = await call('GET', '/v1/admin/environment');
      const e = envr.status === 200 ? envr.body : {};
      return reply(200, { ok: true, enabled: true, signedIn: Boolean(me && me.status === 200), mustChangePassword: Boolean(me && me.status === 200 && me.body?.mustChangePassword),
        environment: typeof e.environment === 'string' ? e.environment : 'unknown', stripeMode: typeof e.stripeMode === 'string' ? e.stripeMode : 'unknown' });
    }

    let body;
    if (req.method === 'POST') {
      const from = String(req.headers.origin || '').trim() || (() => { try { return req.headers.referer ? new URL(req.headers.referer).origin : ''; } catch { return ''; } })();
      const allowed = [...deps.ownOrigins(req), ...cfg.origins];
      if (!from || !allowed.includes(from)) return reply(403, { ok: false, code: 'FORBIDDEN', reason: 'admin_origin_not_allowed', message: 'This request did not come from the Control Center.' });
      if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return reply(400, { ok: false, code: 'INVALID_INPUT', reason: 'admin_json_required', message: 'JSON body required' });
      try { body = (await deps.readJsonBody(req, 16 * 1024)) || {}; } catch { return reply(400, { ok: false, code: 'INVALID_INPUT', message: 'invalid JSON' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { ok: false, code: 'INVALID_INPUT', message: 'invalid JSON' });
    }

    if (sub === 'login' && req.method === 'POST') {
      const ip = deps.clientIp(req);
      const wait = limited(ip);
      if (wait) return reply(429, { ok: false, code: 'RATE_LIMITED', message: 'too many sign-in attempts', retryAfterSeconds: wait }, { 'Retry-After': String(wait) });
      const r = await call('POST', '/v1/admin/login', { body: { email: String(body.email || ''), password: String(body.password || ''), totp: String(body.totp || '') }, ip, ua: req.headers['user-agent'] });
      if (r.status !== 200 || !SESSION_RE.test(String(r.body?.session || ''))) return reply(r.status === 200 ? 502 : r.status, { ...r.body, session: undefined });
      const { session: token, ...rest } = r.body;   // the token goes only into the HttpOnly cookie
      const maxAge = (new Date(rest.expiresAt).getTime() - now()) / 1000;
      return reply(200, rest, { 'Set-Cookie': cookie(token, maxAge) });
    }
    if (sub === 'logout' && req.method === 'POST') {
      if (session) await call('POST', '/v1/admin/logout', { session, body: {} });
      return reply(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    }
    if (!session) return reply(401, { ok: false, code: 'AUTH_REQUIRED', message: 'operator sign-in required' });
    if (sub === 'password' && req.method === 'POST') {
      const wait = limited(deps.clientIp(req));
      if (wait) return reply(429, { ok: false, code: 'RATE_LIMITED', message: 'too many attempts', retryAfterSeconds: wait }, { 'Retry-After': String(wait) });
      const r = await call('POST', '/v1/admin/password', { session, body: { currentPassword: String(body.currentPassword || ''), newPassword: String(body.newPassword || '') } });
      return reply(r.status, r.body, r.status === 401 ? { 'Set-Cookie': cookie('', 0) } : undefined);
    }
    const r = await call(req.method, `/v1/admin/${sub}${url.search}`, { session, body });
    return reply(r.status, r.body, r.status === 401 ? { 'Set-Cookie': cookie('', 0) } : undefined);
  }

  return { handle, config: { enabled: cfg.enabled, reason: cfg.reason || null } };
}
