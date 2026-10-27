/**
 * Hard request cap for scripts that call a provider API (AGENTS.md, paid-API
 * rule: "every script that can call a paid API must have a hard programmatic
 * cap"). Same contract as staging-proxy/tools/paid-call-guard.mjs, but scoped
 * to ONE injected transport instead of the process-wide fetch, and it counts
 * EVERY request it carries, loopback included, so the cap is testable against
 * a loopback fake:
 *
 *   1. Before sending: `assertPlan(planned)` refuses a run whose plan exceeds
 *      the cap. Nothing trims the run to fit; the caller must narrow it or get
 *      approval and pass a higher cap for that one run.
 *   2. While running: the request that would exceed the cap THROWS before it
 *      is sent (retries count: each attempt is a request). http.js never
 *      retries this error.
 *
 * The cap is never raised by this module; it is fixed when the cap is created.
 */

export class RequestCapError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RequestCapError';
    this.code = 'REQUEST_CAP_EXCEEDED';
    this.requestCapExceeded = true;      // http.js re-throws this instead of retrying
    this.details = details;
  }
}

/**
 * createRequestCap({ label, max, fetch }) -> { fetch, max, used(), remaining(), assertPlan(planned) }
 */
export function createRequestCap({ label = 'provider', max, fetch } = {}) {
  if (!Number.isInteger(max) || max < 1) throw new Error(`${label}: request cap must be a positive whole number`);
  if (typeof fetch !== 'function') throw new Error(`${label}: an explicit fetch transport is required`);
  let used = 0;
  let refused = 0;
  const capped = async function cappedFetch(input, init) {
    if (used >= max) {
      refused += 1;
      throw new RequestCapError(`${label}: request cap reached (${max}); refusing request #${used + refused}`, { max, used });
    }
    used += 1;
    return fetch(input, init);
  };
  return Object.freeze({
    fetch: capped,
    max,
    used: () => used,
    refused: () => refused,
    remaining: () => max - used,
    assertPlan(planned) {
      if (!Number.isInteger(planned) || planned < 0) throw new Error(`${label}: planned request count must be a whole number`);
      if (planned > max) {
        throw new RequestCapError(`${label}: REFUSED: ${planned} planned requests exceed the cap of ${max}. Narrow the run, or re-run with a higher cap only after approval (AGENTS.md).`, { planned, max });
      }
      return planned;
    },
  });
}
