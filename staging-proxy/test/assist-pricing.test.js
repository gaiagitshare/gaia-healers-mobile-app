/**
 * THE PRICE BOOK — dated, sourced, never guessed, kept apart from usage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_BOOK, priceFor, priceById, costFromUsage } from '../assist-pricing.js';

test('every entry is dated, sourced from the provider, and prices only what was read', () => {
  for (const e of PRICE_BOOK) {
    assert.match(e.id, /^[a-z0-9.\-\/]+\/\d{4}-\d{2}-\d{2}$/, `${e.id}: id ends in the effective date`);
    assert.match(e.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(e.source, /^https:\/\/(www\.alibabacloud\.com|ai\.google\.dev|platform\.openai\.com|console\.groq\.com|openrouter\.ai|elevenlabs\.io)\//,
      `${e.id}: the source must be the provider's own documentation, not an aggregator`);
    assert.ok(e.note && e.note.length > 20, `${e.id}: say when it was read and what it covers`);
    for (const [k, v] of Object.entries(e.usd)) {
      assert.ok(v === null || (typeof v === 'number' && v >= 0), `${e.id}.${k} must be a number or null, never a guess`);
    }
  }
});

test('the entry in force is chosen by date, and a future price does not apply yet', () => {
  assert.equal(priceFor('gemini-3.6-flash', '2026-10-15T12:00:00Z').id, 'gemini-3.6-flash/global/2026-10-03');
  assert.equal(priceFor('gemini-3.6-flash', '2027-02-01T00:00:00Z').id, 'gemini-3.6-flash/global/2027-01-01');
  assert.equal(priceFor('gemini-3.6-flash', '2026-01-01T00:00:00Z'), null, 'before any entry, there is no price');
});

test('an unpriced model costs null, never a number', () => {
  assert.equal(priceFor('qwen/qwen3.8-27b'), null);
  assert.equal(priceFor('gpt-4o-mini'), null);
  assert.equal(costFromUsage(null, { input: 1000, output: 10 }).usd, null);
});

test('cost from reported counts: Qwen voice with the full modality split', () => {
  const e = priceById('qwen3.8-omni-flash-realtime/singapore/2026-10-03');
  const c = costFromUsage(e, { input: 6900, textIn: 6800, audioIn: 100, cachedInput: 0, output: 140, textOut: 30, audioOut: 110, reasoning: null });
  const expected = (6800 * 0.23 + 100 * 0.93 + 30 * 0.70 + 110 * 1.87) / 1e6;
  assert.ok(Math.abs(c.usd - expected) < 1e-9, `${c.usd} vs ${expected}`);
  assert.equal(c.basis, 'reported');
});

test('a cache hit is priced at the cache rate only when the provider reported it', () => {
  const e = priceById('qwen3.8-omni-flash-realtime/singapore/2026-10-03');
  const hit = costFromUsage(e, { input: 1_000_000, textIn: 1_000_000, cachedInput: 1_000_000, output: 0, textOut: 0, audioIn: 0, audioOut: 0 });
  assert.ok(Math.abs(hit.usd - 0.016) < 1e-9);
  const miss = costFromUsage(e, { input: 1_000_000, textIn: 1_000_000, cachedInput: 0, output: 0, textOut: 0, audioIn: 0, audioOut: 0 });
  assert.ok(Math.abs(miss.usd - 0.23) < 1e-9);
});

test('Gemini thinking is priced as output, on top of the visible answer', () => {
  const e = priceById('gemini-3.6-flash/global/2026-10-03');
  const c = costFromUsage(e, { input: 4000, cachedInput: 0, output: 100, reasoning: 500 });
  const expected = (4000 * 0.75 + 100 * 3.75 + 500 * 3.75) / 1e6;
  assert.ok(Math.abs(c.usd - expected) < 1e-9);
});

test('when a modality was not reported the cost is marked partial, not exact', () => {
  const e = priceById('qwen3.8-omni-flash-realtime/singapore/2026-10-03');
  const c = costFromUsage(e, { input: 5000, output: 100 });
  assert.equal(c.basis, 'partial');
  assert.ok(c.missing.length >= 1);
});

test('entries are append-only: an id, once present, keeps its prices', () => {
  // Pins the first two entries so a "correction" cannot silently rewrite history.
  const q = priceById('qwen3.8-omni-flash-realtime/singapore/2026-10-03');
  assert.deepEqual(q.usd, { textIn: 0.23, cachedIn: 0.016, textOut: 0.70, reasoningOut: null, audioIn: 0.93, audioOut: 1.87 });
  const g = priceById('gemini-3.6-flash/global/2026-10-03');
  assert.deepEqual(g.usd, { textIn: 0.75, cachedIn: 0.075, textOut: 3.75, reasoningOut: 3.75, audioIn: null, audioOut: null });
});
