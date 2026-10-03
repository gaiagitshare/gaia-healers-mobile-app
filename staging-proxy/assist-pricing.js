/**
 * PRICE BOOK — kept apart from raw usage on purpose.
 *
 * A usage record stores what the PROVIDER reported (token counts) and the id
 * of the price-book entry that was current when it was written. The dollar
 * figure on a record is a convenience; the authoritative numbers are the
 * counts, and any later price change is applied by recomputing from them
 * (tools/assist-usage-report.mjs does exactly that) rather than by editing
 * history.
 *
 * Rules:
 *   - every entry names its source and the date it took effect;
 *   - a price we have not read from the provider's own page is `null`, and a
 *     model with no entry costs `null`. Nothing is guessed;
 *   - entries are never edited once used. A change is a new entry with a
 *     later `effectiveFrom` (and `effectiveUntil` on the old one if announced).
 *
 * USD per million tokens throughout.
 */

export const PRICE_BOOK = [
  {
    id: 'qwen3.8-omni-flash-realtime/singapore/2026-10-03',
    provider: 'qwen',
    model: 'qwen3.8-omni-flash-realtime',
    region: 'Singapore (international deployment)',
    effectiveFrom: '2026-10-03',
    effectiveUntil: null,
    source: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
    note: 'Read 2026-10-03. Speech output bills both the audio and its text at their respective output rates. '
        + 'Whether the realtime model applies the cache-hit price is undocumented; the October bill showed none.',
    usd: { textIn: 0.23, cachedIn: 0.016, textOut: 0.70, reasoningOut: null, audioIn: 0.93, audioOut: 1.87 },
  },
  {
    id: 'gemini-3.6-flash/global/2026-10-03',
    provider: 'gemini',
    model: 'gemini-3.6-flash',
    region: 'global',
    effectiveFrom: '2026-10-03',
    effectiveUntil: '2026-12-31',
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    note: 'Read 2026-10-03, paid tier, standard. Thinking tokens are billed as output at the output rate '
        + '(no separate price). Announced to double on 2027-01-01 -- see the next entry.',
    usd: { textIn: 0.75, cachedIn: 0.075, textOut: 3.75, reasoningOut: 3.75, audioIn: null, audioOut: null },
  },
  {
    id: 'gemini-3.6-flash/global/2027-01-01',
    provider: 'gemini',
    model: 'gemini-3.6-flash',
    region: 'global',
    effectiveFrom: '2027-01-01',
    effectiveUntil: null,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    note: 'The increase announced on the pricing page as of 2026-10-03.',
    usd: { textIn: 1.50, cachedIn: 0.15, textOut: 7.50, reasoningOut: 7.50, audioIn: null, audioOut: null },
  },
  // Not priced, deliberately: qwen/qwen3.8-27b on Groq, meta-llama/llama-3.3-70b-instruct on
  // OpenRouter, gpt-4o-mini on OpenAI. They are fallbacks the proxy rarely reaches, and no
  // price has been read from the provider's own page. They cost `null` until one is.
];

/** The entry in force for a model at a moment, or null. */
export function priceFor(model, at = new Date()) {
  const day = (at instanceof Date ? at : new Date(at)).toISOString().slice(0, 10);
  if (!day || day === 'Invalid Date') return null;
  const candidates = PRICE_BOOK.filter((p) => p.model === model && p.effectiveFrom <= day
    && (!p.effectiveUntil || day <= p.effectiveUntil));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
}

export function priceById(id) {
  return PRICE_BOOK.find((p) => p.id === id) || null;
}

/**
 * Cost of one usage record under one price entry.
 *
 * Returns { usd, basis, missing } where `basis` says how much of the number is
 * real: 'reported' when every priced quantity came from the provider,
 * 'partial' when a modality the entry prices was not reported and was taken as
 * zero, or when counts were only reported as a total and priced as text.
 * `usd` is null if the record has no input count or the entry is null.
 */
export function costFromUsage(entry, u) {
  if (!entry || !u || u.input == null) return { usd: null, basis: 'unavailable', missing: ['no price entry or no input count'] };
  const p = entry.usd;
  const missing = [];
  const cached = u.cachedInput ?? 0;
  if (u.cachedInput == null) missing.push('cachedInput not reported; priced as uncached');
  const audioIn = u.audioIn ?? 0;
  let textIn;
  if (u.textIn != null) textIn = Math.max(0, u.textIn - cached);
  else { textIn = Math.max(0, u.input - audioIn - cached); if (p.audioIn != null && u.audioIn == null) missing.push('audioIn not reported; input priced as text'); }
  const audioOut = u.audioOut ?? 0;
  const textOut = u.textOut != null ? u.textOut : Math.max(0, (u.output ?? 0) - audioOut);
  if (u.output == null && u.textOut == null) missing.push('output not reported');
  // Reasoning is billed as output by Gemini and sits inside candidatesTokenCount
  // for some models and outside it for others; when a separate reasoning price
  // exists and the count was reported, it is priced at that rate ON TOP only if
  // the provider reports it separately from output. Gemini's thoughtsTokenCount
  // is separate from candidatesTokenCount, so it is added here.
  const reasoning = u.reasoning ?? 0;
  const rate = (k) => (p[k] == null ? null : p[k]);
  const parts = [
    [textIn, rate('textIn')], [cached, rate('cachedIn') ?? rate('textIn')], [audioIn, rate('audioIn')],
    [textOut, rate('textOut')], [audioOut, rate('audioOut')], [reasoning, rate('reasoningOut')],
  ];
  let usd = 0;
  for (const [n, r] of parts) {
    if (!n) continue;
    if (r == null) { missing.push('a reported modality has no price in this entry'); continue; }
    usd += (n * r) / 1e6;
  }
  return { usd: Math.round(usd * 1e7) / 1e7, basis: missing.length ? 'partial' : 'reported', missing };
}
