/**
 * Dedicated shared secrets for the GHL webhook families, with a dated
 * transition window off the old shared fallback.
 *
 * Before this, GHL_WORKFLOW_WEBHOOK_SECRET and GHL_BACKFILL_SECRET silently
 * fell back to COURSES_SYNC_SECRET, so one value authorised several webhook
 * families. A family now has:
 *
 *   - a dedicated secret (its own env var), and
 *   - a legacy check (whatever the family accepted before it had one).
 *
 * Rules, evaluated on every request so expiry needs no restart:
 *
 *   dedicated unset            -> legacy check only (exactly today's behaviour)
 *   dedicated set, window open -> dedicated OR legacy
 *   dedicated set, window shut -> dedicated only
 *
 * The window is open only while `<NAME>_TRANSITION_UNTIL` parses as a date in
 * the future. Unset or unparseable means shut: configuring a dedicated secret
 * never silently keeps the old one alive.
 *
 * The comparison is injected (server.js passes its `safeSecretEqual`) so there
 * is exactly one constant-time compare in the proxy. Nothing here stores,
 * logs or returns a secret value.
 */

export const MIN_SECRET_LENGTH = 32;

/** Parse an ISO date env value. Returns epoch ms, or null when unset/invalid. */
export function parseTransitionUntil(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {object} opts
 * @param {string} opts.dedicated        the family's own secret ('' when unset)
 * @param {(supplied: string) => boolean} opts.legacyCheck  what was accepted before
 * @param {string} [opts.transitionUntil] raw ISO date from env
 * @param {(a: string, b: string) => boolean} opts.compare  constant-time equality
 * @param {() => number} [opts.now]
 */
export function createSecretFamily({ dedicated, legacyCheck, transitionUntil, compare, now = () => Date.now() }) {
  const own = String(dedicated || '').trim();
  const untilMs = parseTransitionUntil(transitionUntil);
  const configured = own.length > 0;
  const usable = own.length >= MIN_SECRET_LENGTH;

  const transitionOpen = () => untilMs != null && now() < untilMs;

  /** Returns 'dedicated', 'fallback', or '' (refused). */
  function check(supplied) {
    const value = String(supplied || '').trim();
    if (!value) return '';
    if (!configured) return legacyCheck(value) ? 'fallback' : '';
    if (usable && compare(value, own)) return 'dedicated';
    if (transitionOpen() && legacyCheck(value)) return 'fallback';
    return '';
  }

  /** Non-secret description of the configuration, for diagnostics. */
  function describe() {
    return {
      dedicatedConfigured: configured,
      dedicatedUsable: usable,
      transitionUntil: untilMs == null ? null : new Date(untilMs).toISOString(),
      transitionOpen: configured ? transitionOpen() : null,
      fallbackAccepted: !configured || transitionOpen(),
    };
  }

  return { check, describe, configured, usable, invalidTransition: Boolean(String(transitionUntil || '').trim()) && untilMs == null };
}

/**
 * Fold one authentication result into a telemetry object (mutates and returns
 * it). Counters and timestamps only — never the secret, never the request.
 */
export function recordSecretAuth(all, family, route, result, at = new Date().toISOString()) {
  if (result !== 'dedicated' && result !== 'fallback') return all;
  const root = (all.secret_auth && typeof all.secret_auth === 'object') ? all.secret_auth : {};
  const f = root[family] || { dedicated: 0, fallback: 0, byRoute: {} };
  f[result] = (f[result] || 0) + 1;
  f[result === 'dedicated' ? 'lastDedicatedAt' : 'lastFallbackAt'] = at;
  f.byRoute = f.byRoute || {};
  const r = f.byRoute[route] || { dedicated: 0, fallback: 0 };
  r[result] = (r[result] || 0) + 1;
  r[result === 'dedicated' ? 'lastDedicatedAt' : 'lastFallbackAt'] = at;
  f.byRoute[route] = r;
  root[family] = f;
  all.secret_auth = root;
  return all;
}
