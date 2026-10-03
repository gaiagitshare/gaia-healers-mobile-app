/**
 * GAIA ASSIST — what each reply actually cost, as the PROVIDER reported it.
 *
 * Until now the proxy kept two numbers per voice session (input and output
 * totals) and nothing at all for text chat. That made three questions
 * unanswerable: whether prompt caching ever hits, how much of a long voice
 * session is re-billed audio, and what Gemini's hidden "thinking" costs. This
 * records the provider's own counts so they can be answered from real traffic.
 *
 * Rules it keeps:
 *   - provider-reported numbers only. Nothing here estimates tokens, and a
 *     field the provider did not report is left null rather than guessed.
 *   - NO conversation content: no prompt, no reply, no names, no contact id.
 *     A record is counts, provider, model, channel and session state.
 *   - it never calls anything. It reads numbers already in a response.
 *
 * Records go to a JSON-lines file, one per text reply and one per voice
 * session, so cost per reply / session / provider can be compared later:
 *   GAIA_USAGE_LOG=<path>   default data/assist-usage.jsonl; empty disables
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Published list prices, USD per million tokens. Only models whose price was
 * read from the provider's own page are here; anything else costs `null`,
 * because a guessed price would make every later comparison wrong.
 */
export const PRICE_LIST_VERSION = '2026-10-03';
export const PRICES = {
  // alibabacloud.com/help/en/model-studio/model-pricing, Singapore deployment.
  // Speech output bills both the audio and its text.
  'qwen3.8-omni-flash-realtime': { textIn: 0.23, audioIn: 0.93, textOut: 0.70, audioOut: 1.87, cachedIn: 0.016 },
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const add = (a, b) => (a == null && b == null ? null : (a || 0) + (b || 0));

/**
 * One provider's usage object -> one shape. Fields the provider did not report
 * stay null.
 */
export function normalizeUsage(provider, raw) {
  const u = raw || {};
  const out = { input: null, cachedInput: null, output: null, reasoning: null,
                textIn: null, audioIn: null, textOut: null, audioOut: null };
  if (provider === 'gemini') {
    out.input = num(u.promptTokenCount);
    out.cachedInput = num(u.cachedContentTokenCount);
    out.output = num(u.candidatesTokenCount);
    out.reasoning = num(u.thoughtsTokenCount);
    for (const d of u.promptTokensDetails || []) {
      if (d.modality === 'TEXT') out.textIn = num(d.tokenCount);
      if (d.modality === 'AUDIO') out.audioIn = num(d.tokenCount);
    }
    return out;
  }
  if (provider === 'qwen') {
    // OpenAI-realtime shape, as Qwen's realtime API reports it.
    out.input = num(u.input_tokens);
    out.output = num(u.output_tokens);
    out.cachedInput = num(u.input_token_details?.cached_tokens);
    out.textIn = num(u.input_token_details?.text_tokens);
    out.audioIn = num(u.input_token_details?.audio_tokens);
    out.textOut = num(u.output_token_details?.text_tokens);
    out.audioOut = num(u.output_token_details?.audio_tokens);
    return out;
  }
  // OpenAI-shaped chat completions: Groq, OpenRouter, OpenAI. Groq streams it
  // as x_groq.usage on the last chunk; the caller passes whichever it found.
  out.input = num(u.prompt_tokens);
  out.output = num(u.completion_tokens);
  out.cachedInput = num(u.prompt_tokens_details?.cached_tokens);
  out.reasoning = num(u.completion_tokens_details?.reasoning_tokens);
  return out;
}

/** Sum per-response usage into a per-session total, keeping null when unreported. */
export function sumUsage(a, b) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = add(a[k], b[k]);
  return out;
}

export function emptyUsage() {
  return { input: null, cachedInput: null, output: null, reasoning: null,
           textIn: null, audioIn: null, textOut: null, audioOut: null };
}

/**
 * Estimated cost from provider-reported counts and the published price, or
 * null when either is missing. The modality split is used when the provider
 * gave it; otherwise totals are priced as text, which is a floor.
 */
export function estimateCost(model, u) {
  const p = PRICES[model];
  if (!p || !u || u.input == null) return null;
  const cached = u.cachedInput || 0;
  const audioIn = u.audioIn || 0;
  const textIn = u.textIn != null ? Math.max(0, u.textIn - cached) : Math.max(0, u.input - audioIn - cached);
  const audioOut = u.audioOut || 0;
  const textOut = u.textOut != null ? u.textOut : Math.max(0, (u.output || 0) - audioOut);
  const usd = (textIn * p.textIn + audioIn * p.audioIn + cached * (p.cachedIn ?? p.textIn)
             + textOut * p.textOut + audioOut * p.audioOut) / 1e6;
  return Math.round(usd * 1e7) / 1e7;
}

function logPath() {
  const configured = process.env.GAIA_USAGE_LOG;
  if (configured === '') return null;
  if (configured) return configured;
  // Under the test runner, never fall back to the real log. Two relay suites
  // open fake Qwen sessions without redirecting it, and running the suite in
  // the live directory on 3 Oct wrote six fake sessions into the production
  // file -- the very data the next optimisation decision is meant to rest on.
  // A test that wants records must name a file explicitly.
  if (process.env.NODE_TEST_CONTEXT) return null;
  return path.join(process.cwd(), 'data', 'assist-usage.jsonl');
}

/**
 * Append one record. Never throws: losing a usage line must not cost a member
 * their answer.
 *
 * @param {{channel:'text'|'voice', provider:string, model:string, state?:string,
 *          turns?:number, seconds?:number, usage:object}} r
 */
export function recordUsage(r) {
  const file = logPath();
  const usage = r.usage || emptyUsage();
  const record = {
    at: new Date().toISOString(),
    channel: r.channel,
    provider: r.provider,
    model: r.model,
    state: r.state || null,
    turns: r.turns ?? null,
    seconds: r.seconds ?? null,
    ...usage,
    estCostUsd: estimateCost(r.model, usage),
    priceList: PRICES[r.model] ? PRICE_LIST_VERSION : null,
  };
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(record) + '\n');
    } catch { /* never fatal */ }
  }
  return record;
}
