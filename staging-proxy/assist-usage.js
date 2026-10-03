/**
 * GAIA ASSIST — what each reply actually cost, as the PROVIDER reported it.
 *
 * Until Phase 1 the proxy kept two numbers per voice session and nothing for
 * text chat, which left three questions unanswerable: whether prompt caching
 * ever hits, how much of a long voice session is re-billed audio, and what
 * Gemini's hidden "thinking" costs. This records the provider's own counts so
 * they can be answered from real traffic -- and, since a failed request can
 * bill too, it records failed attempts as well, with an error CATEGORY only.
 *
 * Rules it keeps:
 *   - provider-reported numbers only. Nothing here estimates tokens; a field
 *     the provider did not report stays null rather than guessed.
 *   - NO conversation content, NO identity: no prompt, reply, name, email,
 *     contact id, IP, token or raw provider error body. A record is counts,
 *     outcome, provider, model, channel and session state. The field list is
 *     fixed and tested.
 *   - it never calls anything. It reads numbers already in a response.
 *   - it never throws into a reply. A logger failure is reported once a minute
 *     to the console, by error code, and the member's answer is unaffected.
 *
 * Records go to a JSON-lines file, one per text reply / attempt and one per
 * voice session (0600, root). Rotation: deploy/logrotate-gaia-assist-usage.
 *   GAIA_USAGE_LOG=<path>   default data/assist-usage.jsonl; empty disables
 *
 * Pricing is deliberately NOT here: assist-pricing.js is a dated price book,
 * and a record carries the id of the entry used (`priceList`) so the dollar
 * figure can be recomputed from the raw counts when prices change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { priceFor, costFromUsage } from './assist-pricing.js';

/** Every field a record may carry, in order. Tests fail on anything else. */
export const USAGE_FIELDS = Object.freeze([
  'at', 'channel', 'provider', 'model', 'state', 'turns', 'seconds',
  'outcome', 'error', 'usageReported', 'attempt',
  'input', 'cachedInput', 'output', 'reasoning', 'textIn', 'audioIn', 'textOut', 'audioOut',
  'estCostUsd', 'priceList',
]);

/** The error categories a record may carry. Never a message, never a body. */
export const ERROR_CATEGORIES = Object.freeze([
  'access_denied', 'auth', 'rate_limit', 'timeout', 'network', 'server', 'bad_request',
  'empty', 'stall', 'client_closed', 'unknown',
]);

const num = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const add = (a, b) => (a == null && b == null ? null : (a || 0) + (b || 0));

export function emptyUsage() {
  return { input: null, cachedInput: null, output: null, reasoning: null,
           textIn: null, audioIn: null, textOut: null, audioOut: null };
}

/**
 * One provider's usage object -> one shape. Fields the provider did not report
 * stay null. Anything malformed (not an object, wrong types) yields nulls
 * rather than an exception: a strange usage block must not cost an answer.
 */
export function normalizeUsage(provider, raw) {
  const out = emptyUsage();
  const u = raw && typeof raw === 'object' ? raw : {};
  const d = (o, k) => (o && typeof o === 'object' ? o[k] : undefined);
  if (provider === 'gemini') {
    out.input = num(u.promptTokenCount);
    out.cachedInput = num(u.cachedContentTokenCount);
    out.output = num(u.candidatesTokenCount);
    out.reasoning = num(u.thoughtsTokenCount);
    for (const det of Array.isArray(u.promptTokensDetails) ? u.promptTokensDetails : []) {
      if (d(det, 'modality') === 'TEXT') out.textIn = num(det.tokenCount);
      if (d(det, 'modality') === 'AUDIO') out.audioIn = num(det.tokenCount);
    }
    return out;
  }
  if (provider === 'qwen') {
    // OpenAI-realtime shape, as Qwen's realtime API reports it on response.done.
    // input_token_details.{text_tokens,audio_tokens,cached_tokens} and
    // output_token_details.{text_tokens,audio_tokens}. Alibaba's realtime docs
    // do not describe the cached_tokens detail; it is kept if present and
    // null otherwise, never inferred.
    out.input = num(u.input_tokens);
    out.output = num(u.output_tokens);
    out.cachedInput = num(d(u.input_token_details, 'cached_tokens'));
    out.textIn = num(d(u.input_token_details, 'text_tokens'));
    out.audioIn = num(d(u.input_token_details, 'audio_tokens'));
    out.textOut = num(d(u.output_token_details, 'text_tokens'));
    out.audioOut = num(d(u.output_token_details, 'audio_tokens'));
    return out;
  }
  // OpenAI-shaped chat completions: Groq, OpenRouter, OpenAI. Groq streams it
  // as x_groq.usage on the last chunk; the caller passes whichever it found.
  out.input = num(u.prompt_tokens);
  out.output = num(u.completion_tokens);
  out.cachedInput = num(d(u.prompt_tokens_details, 'cached_tokens'));
  out.reasoning = num(d(u.completion_tokens_details, 'reasoning_tokens'));
  return out;
}

/** Sum per-response usage into a per-session total, keeping null when unreported. */
export function sumUsage(a, b) {
  const out = {};
  for (const k of Object.keys(emptyUsage())) out[k] = add(a?.[k] ?? null, b?.[k] ?? null);
  return out;
}

/**
 * An error -> one of ERROR_CATEGORIES. Reads the message and code; stores
 * neither. Deliberately narrow: only patterns that are unambiguous. Anything
 * else is 'unknown', which is still useful ("something failed") and never wrong.
 */
export function errorCategory(err) {
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? err ?? '');
  const status = Number(err?.status ?? (/\b(?:with|status) (\d{3})\b/.exec(msg) || [])[1] ?? 0);
  if (/AccessDenied|Unpurchased|not purchased|not eligible|model.*denied|denied.*model/i.test(msg + ' ' + code)) return 'access_denied';
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|api key|forbidden/i.test(msg)) return 'auth';
  if (status === 429 || /rate limit|too many requests|quota exceeded/i.test(msg)) return 'rate_limit';
  if (code === 'TimeoutError' || code === 'AbortError' || /timed? ?out|timeout|stall/i.test(msg + ' ' + code)) return /stall/i.test(msg + code) ? 'stall' : 'timeout';
  if (/^E(CONN|HOST|NETUNREACH|PIPE|AI_AGAIN)|ENOTFOUND|socket hang up|network|fetch failed/i.test(code + ' ' + msg)) return 'network';
  if (status >= 500 || /ModelServingError|InternalError|internal error|service unavailable|bad gateway/i.test(msg)) return 'server';
  if (status >= 400 || /invalid_value|bad request|invalid request/i.test(msg)) return 'bad_request';
  if (/empty[- ]reply|no content|empty response/i.test(msg + ' ' + code)) return 'empty';
  if (/client[_ ]closed|client[_ ]error/i.test(msg + ' ' + code)) return 'client_closed';
  return 'unknown';
}

function logPath() {
  const configured = process.env.GAIA_USAGE_LOG;
  if (configured === '') return null;
  if (configured) return configured;
  // Under the test runner, never fall back to the real log. A test that wants
  // records must name a file explicitly.
  if (process.env.NODE_TEST_CONTEXT) return null;
  return path.join(process.cwd(), 'data', 'assist-usage.jsonl');
}

// A broken logger is reported, not retried on every record and not thrown.
let lastWriteWarning = 0;
function warnOnce(code) {
  const now = Date.now();
  if (now - lastWriteWarning < 60000) return;
  lastWriteWarning = now;
  console.warn('[Gaia Usage] could not write the usage log', { code: String(code || 'unknown') });
}

/** Build one record. Pure; exported for tests. */
export function buildRecord(r) {
  const usage = { ...emptyUsage(), ...(r.usage && typeof r.usage === 'object' ? r.usage : {}) };
  for (const k of Object.keys(emptyUsage())) usage[k] = num(usage[k]);
  const at = r.at instanceof Date ? r.at : new Date();
  const outcome = ['ok', 'failed', 'ended'].includes(r.outcome) ? r.outcome : (r.error ? 'failed' : 'ok');
  const error = r.error == null ? null : (ERROR_CATEGORIES.includes(r.error) ? r.error : errorCategory(r.error));
  const entry = priceFor(String(r.model || ''), at);
  const cost = entry ? costFromUsage(entry, usage) : { usd: null };
  return {
    at: at.toISOString(),
    channel: r.channel === 'voice' ? 'voice' : 'text',
    provider: String(r.provider || 'unknown').slice(0, 40),
    model: String(r.model || 'unknown').slice(0, 80),
    state: r.state == null ? null : String(r.state).slice(0, 20),
    turns: num(r.turns),
    seconds: num(r.seconds),
    outcome,
    error,
    usageReported: usage.input != null,
    attempt: num(r.attempt),
    input: usage.input, cachedInput: usage.cachedInput, output: usage.output, reasoning: usage.reasoning,
    textIn: usage.textIn, audioIn: usage.audioIn, textOut: usage.textOut, audioOut: usage.audioOut,
    estCostUsd: cost.usd,
    priceList: entry ? entry.id : null,
  };
}

/**
 * Append one record. Never throws: losing a usage line must not cost a member
 * their answer.
 *
 * @param {{channel:'text'|'voice', provider:string, model:string, state?:string,
 *          turns?:number, seconds?:number, usage?:object,
 *          outcome?:'ok'|'failed'|'ended', error?:string|Error, attempt?:number}} r
 */
export function recordUsage(r) {
  let record;
  try { record = buildRecord(r || {}); } catch (e) { warnOnce(e?.code || 'build'); return null; }
  const file = logPath();
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // One line per append; O_APPEND keeps concurrent writers from interleaving
      // lines of this size on Linux. 0600: nobody but the service user.
      fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch (e) { warnOnce(e?.code); }
  }
  return record;
}

/** A failed or empty attempt, by category only. */
export function recordFailure(r) {
  return recordUsage({ ...r, outcome: 'failed', usage: r?.usage || emptyUsage() });
}

/** Kept for callers that only need a quick figure; the price book is the source. */
export function estimateCost(model, u, at = new Date()) {
  const entry = priceFor(model, at);
  return entry ? costFromUsage(entry, u).usd : null;
}
