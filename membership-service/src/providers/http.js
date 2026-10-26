/**
 * Shared outbound HTTP for provider adapters (Stripe, GHL, Gaia Practitioners).
 *
 * Rules this layer enforces so no adapter has to remember them:
 *   - `fetch` is REQUIRED and injected. There is no default to globalThis.fetch:
 *     nothing in this package can reach a network unless a caller hands it a
 *     transport on purpose. Tests pass a fetch pointed at a loopback fake.
 *   - Retries are bounded: only 429, 5xx and network errors, at most
 *     `maxRetries` extra attempts, exponential backoff with jitter capped at
 *     `maxDelayMs` (Retry-After is honoured but also capped). There is no path
 *     that loops without a bound (AGENTS.md: no uncontrolled loops).
 *   - Errors are typed: exhausted retries / timeouts / auth misconfiguration
 *     become PROVIDER_UNAVAILABLE; a provider 404 is NOT_FOUND; a provider
 *     rejection of our input is INVALID_INPUT; 409 is CONFLICT. Details carry
 *     the provider name, HTTP status and the provider's error code only, never
 *     a response body or a credential.
 */
import { MembershipError } from '../errors.js';

export const DEFAULT_RETRY = Object.freeze({ maxRetries: 3, baseDelayMs: 250, maxDelayMs: 4000, timeoutMs: 15000 });

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function providerError(code, message, details) {
  return new MembershipError(code, message, details);
}

/** Map a final (non-retried) HTTP failure to a standard error code. */
export function codeForStatus(status) {
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 400 || status === 422 || status === 402) return 'INVALID_INPUT';
  return 'PROVIDER_UNAVAILABLE';   // 401/403 (our credentials), 429/5xx after retries, anything unexpected
}

export function backoffDelay(attempt, { baseDelayMs, maxDelayMs }, retryAfterHeader, random = Math.random) {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  let ms = Math.round(exp / 2 + random() * (exp / 2));          // "equal jitter"
  const ra = Number(retryAfterHeader);
  if (Number.isFinite(ra) && ra >= 0) ms = Math.max(ms, ra * 1000);
  return Math.min(ms, maxDelayMs);
}

/**
 * createHttpClient({ provider, baseUrl, fetch, headers, retry, sleep, shouldRetry, mapError, guardPath })
 * returns request(method, path, { query, json, form, headers, idempotencyKey }) -> parsed JSON body.
 *
 *   shouldRetry(response) -> true | false | undefined  (undefined = default 429/5xx rule)
 *   mapError(status, body) -> { code, providerCode, message } overrides the default mapping
 *   guardPath(method, path) -> throws to refuse a request before it is sent
 */
export function createHttpClient({ provider, baseUrl, fetch, headers = {}, retry = {}, sleep = realSleep, random = Math.random, shouldRetry, mapError, guardPath, onRequest } = {}) {
  if (typeof fetch !== 'function') throw new Error(`${provider}: an explicit fetch transport is required (no default network access)`);
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new Error(`${provider}: baseUrl must be an absolute http(s) URL`);
  const base = baseUrl.replace(/\/+$/, '');
  const cfg = { ...DEFAULT_RETRY, ...retry };
  if (!Number.isInteger(cfg.maxRetries) || cfg.maxRetries < 0 || cfg.maxRetries > 6) throw new Error(`${provider}: maxRetries must be 0..6`);

  return async function request(method, path, { query, json, form, headers: extra = {}, idempotencyKey } = {}) {
    if (guardPath) guardPath(method, path);
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]]))).toString() : '';
    const url = base + path + (qs ? '?' + qs : '');
    const h = { Accept: 'application/json', ...headers, ...extra };
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else if (form !== undefined) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = form; }
    if (idempotencyKey) h['Idempotency-Key'] = idempotencyKey;

    let lastStatus = 0;
    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      let res;
      try {
        if (onRequest) onRequest({ method, url, attempt });
        res = await fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(cfg.timeoutMs) });
      } catch (e) {
        if (String(e?.message || '').includes('TEST NETWORK DENY')) throw e;   // never retry a test-guard refusal
        if (e?.requestCapExceeded === true) throw e;                          // nor a request-cap refusal (request-cap.js)
        lastStatus = 0;
        if (attempt < cfg.maxRetries) { await sleep(backoffDelay(attempt, cfg, null, random)); continue; }
        throw providerError('PROVIDER_UNAVAILABLE', `${provider} unreachable`, { provider, status: 0, attempts: attempt + 1 });
      }
      lastStatus = res.status;
      const text = await res.text();
      let parsed = null;
      if (text) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
      if (res.ok) {
        if (text && parsed === null) throw providerError('PROVIDER_UNAVAILABLE', `${provider} returned a non-JSON body`, { provider, status: res.status });
        return parsed ?? {};
      }
      const custom = shouldRetry ? shouldRetry(res) : undefined;
      const retryable = custom ?? (res.status === 429 || res.status >= 500);
      if (retryable && attempt < cfg.maxRetries) { await sleep(backoffDelay(attempt, cfg, res.headers.get('retry-after'), random)); continue; }
      const mapped = mapError ? mapError(res.status, parsed) : null;
      const code = mapped?.code || (retryable ? 'PROVIDER_UNAVAILABLE' : codeForStatus(res.status));
      throw providerError(code, mapped?.message || `${provider} request failed (${res.status})`,
        { provider, status: res.status, attempts: attempt + 1, ...(mapped?.providerCode ? { providerCode: mapped.providerCode } : {}) });
    }
    /* c8 ignore next */
    throw providerError('PROVIDER_UNAVAILABLE', `${provider} request failed`, { provider, status: lastStatus });
  };
}
