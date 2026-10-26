/**
 * Minimal Stripe REST client — TEST MODE ONLY by default.
 *
 * No Stripe SDK: a few form-encoded calls are easier to audit and to fake.
 *   - Live keys (`sk_live_…`, `rk_live_…`) are REFUSED unless `allowLive: true`
 *     is passed. Nothing in this repository passes it; turning live mode on is
 *     a reviewed code change, not a configuration accident.
 *   - Every POST carries an Idempotency-Key (required, never generated
 *     randomly here: callers derive it from the Gaia operation so a retry, a
 *     crash or a double click reuses the same key).
 *   - Every object Stripe returns is checked for `livemode` matching the key's
 *     mode, so a test client can never act on live data.
 *   - Retries: 429 / 5xx / network errors, and whatever Stripe flags with
 *     `Stripe-Should-Retry: true`; never when it says `false`. Bounded.
 */
import { createHttpClient } from '../http.js';
import { MembershipError } from '../../errors.js';

export const STRIPE_API_BASE = 'https://api.stripe.com';

/** Encode nested params the way Stripe expects: a[b][0][c]=v. Arrays of scalars use a[]. */
export function encodeForm(obj) {
  const out = [];
  const walk = (prefix, v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x !== null && typeof x === 'object' ? `${prefix}[${i}]` : `${prefix}[]`, x));
    } else if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, x);
    } else {
      out.push(encodeURIComponent(prefix) + '=' + encodeURIComponent(typeof v === 'boolean' ? String(v) : String(v)));
    }
  };
  walk('', obj);
  return out.join('&');
}

export function keyMode(apiKey) {
  if (typeof apiKey !== 'string') return null;
  if (/^(sk|rk)_test_[A-Za-z0-9_]{8,}$/.test(apiKey)) return 'test';
  if (/^(sk|rk)_live_/.test(apiKey)) return 'live';
  return null;
}

function mapStripeError(status, body) {
  const e = body?.error || {};
  const providerCode = e.code || e.type || undefined;
  if (e.type === 'idempotency_error') return { code: 'CONFLICT', providerCode, message: 'stripe: idempotency key reused with different parameters' };
  if (status === 401 || status === 403) return { code: 'PROVIDER_UNAVAILABLE', providerCode, message: 'stripe: credentials rejected' };
  if (e.code === 'resource_already_exists') return { code: 'CONFLICT', providerCode, message: 'stripe: resource already exists' };
  return { providerCode };
}

function assertMode(obj, livemode) {
  const check = (o) => {
    if (o && typeof o === 'object' && 'livemode' in o && o.livemode !== livemode) {
      throw new MembershipError('FORBIDDEN', `stripe returned a ${o.livemode ? 'live' : 'test'}-mode object to a ${livemode ? 'live' : 'test'}-mode client`);
    }
  };
  check(obj);
  if (Array.isArray(obj?.data)) obj.data.forEach(check);
  return obj;
}

/**
 * createStripeClient({ apiKey, fetch, baseUrl?, apiVersion?, allowLive?, retry?, sleep? })
 * returns { livemode, get(path, query), post(path, params, { idempotencyKey }) }
 */
export function createStripeClient({ apiKey, fetch, baseUrl = STRIPE_API_BASE, apiVersion, allowLive = false, retry, sleep, random } = {}) {
  const mode = keyMode(apiKey);
  if (mode === 'live' && allowLive !== true) throw new MembershipError('FORBIDDEN', 'stripe live keys are refused (test mode only; allowLive is not enabled)');
  if (!mode) throw new MembershipError('INVALID_INPUT', 'stripe api key must be a test-mode secret or restricted key');
  const livemode = mode === 'live';
  const request = createHttpClient({
    provider: 'stripe', baseUrl, fetch, retry, sleep, random,
    headers: { Authorization: `Bearer ${apiKey}`, ...(apiVersion ? { 'Stripe-Version': apiVersion } : {}) },
    shouldRetry: (res) => {
      const h = res.headers.get('stripe-should-retry');
      if (h === 'true') return true;
      if (h === 'false') return false;
      return undefined;
    },
    mapError: mapStripeError,
  });
  return Object.freeze({
    livemode,
    async get(path, query) { return assertMode(await request('GET', path, { query }), livemode); },
    async post(path, params, { idempotencyKey } = {}) {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 255) {
        throw new MembershipError('INVALID_INPUT', 'every stripe POST needs an idempotency key (8-255 chars)');
      }
      return assertMode(await request('POST', path, { form: encodeForm(params || {}), idempotencyKey }), livemode);
    },
  });
}
