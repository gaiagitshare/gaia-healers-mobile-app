/**
 * GAIA ASSIST — no provider call may hang.
 *
 * None of the calls to Gemini, Groq, OpenRouter, OpenAI or ElevenLabs had a
 * timeout, so Node's defaults applied: up to 300 s to receive headers and 300 s
 * between body chunks. One stuck provider held a member on "thinking…" until
 * nginx gave up at five minutes — and the server kept waiting after that. The
 * provider chain only moves on to the next provider when a call FAILS, so a
 * hang also stopped the fallback from ever running.
 *
 * Budgets (ms), each overridable by env ASSIST_TIMEOUT_<NAME>_MS:
 *   chat         one whole non-streamed answer
 *   streamIdle   silence allowed between streamed chunks (and before the first)
 *   tts / stt    one speech or transcription call
 *   catalog      a model or voice list
 */
const DEFAULTS = { chat: 20_000, streamIdle: 15_000, tts: 15_000, stt: 20_000, catalog: 8_000 };

export function timeoutMs(name, env = process.env) {
  const v = Number(env[`ASSIST_TIMEOUT_${name.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}_MS`]);
  return Number.isFinite(v) && v > 0 ? v : DEFAULTS[name];
}

/** A signal that fires after the named budget, or when `parent` does. */
export function deadline(name, parent) {
  const t = AbortSignal.timeout(timeoutMs(name));
  return parent ? AbortSignal.any([t, parent]) : t;
}

/**
 * For streamed answers: abort when no chunk has arrived for the idle budget,
 * or when `parent` aborts (the member closed the chat). Call bump() on every
 * chunk and stop() when done.
 */
export function idleWatch(parent, ms = timeoutMs('streamIdle')) {
  const controller = new AbortController();
  let timer = null;
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`no data for ${ms} ms`)), ms);
  };
  const stop = () => clearTimeout(timer);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', () => { stop(); controller.abort(parent.reason); }, { once: true });
  }
  bump();
  return { signal: controller.signal, bump, stop };
}
