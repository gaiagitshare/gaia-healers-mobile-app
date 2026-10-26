/**
 * Gaia Healers Membership 2.0 member gateway: /api/membership2/*
 *
 * The app talks only to this proxy, using the member session it already has.
 * The proxy resolves the member to a membership person and calls the internal
 * membership API over loopback with its own client token. Server-side rules
 * (duplicate-billing guard, launch flag, idempotency, audit) live in the
 * membership service; this layer adds session auth, input shaping and fixed
 * return URLs (the browser never chooses where Stripe sends it back).
 *
 * OFF by default: unless MEMBERSHIP2_GATEWAY=on, handle() returns false and
 * every /api/membership2/* path falls through to the normal 404.
 *
 *   GET  /api/membership2/plans                       (no session needed)
 *   GET  /api/membership2/me                          membership, access, coins, legacy, availability
 *   GET  /api/membership2/me/coins                    coin history
 *   GET  /api/membership2/me/billing                  billing history
 *   POST /api/membership2/checkout                    { planKey, interval, requestId }
 *   POST /api/membership2/coins/checkout              { packKey, requestId }
 *   POST /api/membership2/subscriptions/:id/cancel-preview
 *   POST /api/membership2/subscriptions/:id/cancel    { requestId }
 *   POST /api/membership2/subscriptions/:id/change-preview  { planKey, interval }
 *   POST /api/membership2/subscriptions/:id/change    { planKey, interval, prorationDate?, requestId }
 *   POST /api/membership2/subscriptions/:id/change/cancel   { requestId }   (keep the current plan)
 *   POST /api/membership2/migration/:id/accept
 *   POST /api/membership2/migration/:id/checkout      { requestId }
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const RE = {
  cancelPreview: new RegExp(`^/api/membership2/subscriptions/${UUID}/cancel-preview$`),
  cancel: new RegExp(`^/api/membership2/subscriptions/${UUID}/cancel$`),
  changePreview: new RegExp(`^/api/membership2/subscriptions/${UUID}/change-preview$`),
  change: new RegExp(`^/api/membership2/subscriptions/${UUID}/change$`),
  changeCancel: new RegExp(`^/api/membership2/subscriptions/${UUID}/change/cancel$`),
  offerAccept: new RegExp(`^/api/membership2/migration/${UUID}/accept$`),
  offerCheckout: new RegExp(`^/api/membership2/migration/${UUID}/checkout$`),
};
const PERSON_TTL_MS = 5 * 60 * 1000;
/** Reads fail fast; writes (which may wait on Stripe inside the service) get longer. */
export const GET_TIMEOUT_MS = 4000;
export const WRITE_TIMEOUT_MS = 8000;
/**
 * The membership service is unreachable, timed out or failed. Its own code, so the app
 * never shows "billing isn't connected" (PROVIDER_UNAVAILABLE, a real service answer)
 * during an outage.
 */
const SERVICE_DOWN = () => ({ status: 503, body: { ok: false, code: 'SERVICE_UNAVAILABLE', message: 'Membership is temporarily unavailable, please try again shortly' } });
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Gateway configuration from the environment. Fails closed: anything missing or unsafe = off. */
export function membership2Config(env = process.env) {
  if (String(env.MEMBERSHIP2_GATEWAY || '').trim().toLowerCase() !== 'on') return { enabled: false, reason: 'off' };
  let base;
  try { base = new URL(String(env.MEMBERSHIP_SERVICE_URL || '')); } catch { return { enabled: false, reason: 'service_url_missing' }; }
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) return { enabled: false, reason: 'service_url_not_loopback' };
  const token = String(env.MEMBERSHIP_SERVICE_TOKEN || '');
  if (!/^gms_[A-Za-z0-9_-]{43}$/.test(token)) return { enabled: false, reason: 'service_token_missing' };
  const app = String(env.MEMBERSHIP2_APP_URL || 'https://gaiahealers.app').replace(/\/+$/, '');
  return { enabled: true, base: base.toString().replace(/\/+$/, ''), token, app };
}

export function createMembership2Gateway({ env = process.env, fetch = globalThis.fetch, now = () => Date.now() } = {}) {
  const cfg = membership2Config(env);
  const persons = new Map();   // session key -> { personId, at }

  async function call(method, path, { body, idempotencyKey } = {}) {
    const headers = { authorization: `Bearer ${cfg.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    try {
      const r = await fetch(cfg.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(method === 'GET' ? GET_TIMEOUT_MS : WRITE_TIMEOUT_MS) });
      const j = await r.json().catch(() => null);
      // The service failed (not a business answer): an outage, never "billing not connected".
      if (!j || typeof j !== 'object' || (r.status >= 500 && j.code !== 'PROVIDER_UNAVAILABLE')) return SERVICE_DOWN();
      return { status: r.status, body: j };
    } catch {
      return SERVICE_DOWN();                                        // unreachable or timed out
    }
  }

  async function personFor(member) {
    const key = member.contactId ? `c:${member.contactId}` : (member.email ? `e:${String(member.email).toLowerCase()}` : '');
    if (!key) return null;
    const hit = persons.get(key);
    if (hit && now() - hit.at < PERSON_TTL_MS) return hit.personId;
    const r = await call('POST', '/v1/identities/ensure', { body: { contactId: member.contactId || undefined, email: member.email || undefined } });
    if (r.status >= 300 || !r.body?.personId) return null;
    persons.set(key, { personId: r.body.personId, at: now() });
    return r.body.personId;
  }

  const back = (state) => ({ successUrl: `${cfg.app}/home.html?view=membership&checkout=${state}`, cancelUrl: `${cfg.app}/home.html?view=membership&checkout=cancelled` });

  /** Returns true when it handled the request; false lets the proxy continue (gateway off or not ours). */
  async function handle(req, res, url, { origin, sendJson, readJsonBody, requireSessionMember }) {
    if (!url.pathname.startsWith('/api/membership2/')) return false;
    if (!cfg.enabled) return false;
    const reply = (r) => { sendJson(res, r.status, r.body, origin); return true; };

    if (req.method === 'GET' && url.pathname === '/api/membership2/plans') return reply(await call('GET', '/v1/catalog/plans'));

    const member = requireSessionMember(req, res, origin);
    if (!member) return true;                                         // 401 already sent
    const personId = await personFor(member);
    if (!personId) return reply(SERVICE_DOWN());
    const P = `/v1/persons/${personId}`;
    const body = async () => {
      const ct = String(req.headers['content-type'] || '');
      if (!ct.toLowerCase().startsWith('application/json')) return null;
      try { return (await readJsonBody(req, 16 * 1024)) || {}; } catch { return null; }
    };
    const keyFor = (b, action) => {
      if (!b || !REQUEST_ID.test(String(b.requestId || ''))) return null;
      return `m2-${action}-${personId.slice(0, 8)}-${b.requestId}`;
    };
    const bad = (message) => reply({ status: 400, body: { ok: false, code: 'INVALID_INPUT', message } });
    let m;

    if (req.method === 'GET' && url.pathname === '/api/membership2/me') return reply(await call('GET', `${P}/overview`));
    if (req.method === 'GET' && url.pathname === '/api/membership2/me/coins') return reply(await call('GET', `${P}/coin-history?limit=${Number(url.searchParams.get('limit')) || 50}`));
    if (req.method === 'GET' && url.pathname === '/api/membership2/me/billing') return reply(await call('GET', `${P}/billing-history?limit=${Number(url.searchParams.get('limit')) || 50}`));

    if (req.method === 'POST' && url.pathname === '/api/membership2/checkout') {
      const b = await body(); const k = keyFor(b, 'checkout');
      if (!k) return bad('JSON body with planKey, interval and requestId is required');
      return reply(await call('POST', `${P}/checkout`, { idempotencyKey: k, body: { planKey: String(b.planKey || ''), interval: String(b.interval || ''), ...back('done') } }));
    }
    if (req.method === 'POST' && url.pathname === '/api/membership2/coins/checkout') {
      const b = await body(); const k = keyFor(b, 'coins');
      if (!k) return bad('JSON body with packKey and requestId is required');
      return reply(await call('POST', `${P}/coin-checkout`, { idempotencyKey: k, body: { packKey: String(b.packKey || ''), ...back('coins') } }));
    }
    if (req.method === 'POST' && (m = RE.cancelPreview.exec(url.pathname))) return reply(await call('POST', `${P}/subscriptions/${m[1]}/cancel-preview`, { body: {} }));
    if (req.method === 'POST' && (m = RE.cancel.exec(url.pathname))) {
      const b = await body(); const k = keyFor(b, 'cancel');
      if (!k) return bad('JSON body with requestId is required');
      return reply(await call('POST', `${P}/subscriptions/${m[1]}/cancel`, { idempotencyKey: k, body: {} }));
    }
    if (req.method === 'POST' && (m = RE.changePreview.exec(url.pathname))) {
      const b = await body();
      if (!b) return bad('JSON body with planKey and interval is required');
      return reply(await call('POST', `${P}/subscriptions/${m[1]}/change-preview`, { body: { planKey: String(b.planKey || ''), interval: String(b.interval || '') } }));
    }
    if (req.method === 'POST' && (m = RE.change.exec(url.pathname))) {
      const b = await body(); const k = keyFor(b, 'change');
      if (!k) return bad('JSON body with planKey, interval and requestId is required');
      const pd = Number(b.prorationDate);
      return reply(await call('POST', `${P}/subscriptions/${m[1]}/change`, { idempotencyKey: k,
        body: { planKey: String(b.planKey || ''), interval: String(b.interval || ''), ...(Number.isSafeInteger(pd) && pd > 0 ? { prorationDate: pd } : {}) } }));
    }
    if (req.method === 'POST' && (m = RE.changeCancel.exec(url.pathname))) {
      const b = await body(); const k = keyFor(b, 'keepplan');
      if (!k) return bad('JSON body with requestId is required');
      return reply(await call('POST', `${P}/subscriptions/${m[1]}/change/cancel`, { idempotencyKey: k, body: {} }));
    }
    if (req.method === 'POST' && (m = RE.offerAccept.exec(url.pathname))) return reply(await call('POST', `${P}/migration-offers/${m[1]}/accept`, { body: {} }));
    if (req.method === 'POST' && (m = RE.offerCheckout.exec(url.pathname))) {
      const b = await body(); const k = keyFor(b, 'migrate');
      if (!k) return bad('JSON body with requestId is required');
      return reply(await call('POST', `${P}/migration-offers/${m[1]}/checkout`, { idempotencyKey: k, body: back('migrated') }));
    }
    return reply({ status: 404, body: { ok: false, code: 'NOT_FOUND', message: 'no such route' } });
  }

  return { handle, config: { enabled: cfg.enabled, reason: cfg.reason || null } };
}
