/**
 * Legacy GHL membership configuration (architecture C).
 *
 * Silver / Gold / Diamond stay billed by GHL (Stripe and PayPal behind GHL)
 * until a member chooses to migrate. This module only RECOGNISES which GHL
 * subscription is which legacy tier; it never sells, prices or grants.
 *
 * Shape mirrors staging-proxy/membership/config.js MEMBERSHIP_BILLING (the
 * proxy stays the authority; the ids below were copied from it and match the
 * live GHL prices checked read-only on 2026-10-26). Rules:
 *   - a subscription maps to a tier ONLY by its GHL price id
 *     (`recurringProduct.price._id`); never by name, amount or product;
 *   - a price id listed under two tiers is AMBIGUOUS and maps to nothing;
 *   - an id that is not listed is UNMAPPED (Next Level, "CRM", the $47 item):
 *     reported for review, never imported as a tier.
 *
 * Tests inject fixture configs; nothing here is read from the environment.
 */
import { fail } from '../../errors.js';

export const LEGACY_BILLING = Object.freeze({
  silver: Object.freeze({ ghlProductId: '69177f9c54010d18cf6a8aad', monthlyPriceId: '69177f9c54010d2bad6a8ac6', annualPriceId: '69177f9c54010d7d6f6a8abe' }),
  gold: Object.freeze({ ghlProductId: '691cbb523963872e3be0f660', monthlyPriceId: '691cbb52396387d816e0f670', annualPriceId: '691cbb5239638772cee0f66b' }),
  diamond: Object.freeze({ ghlProductId: '691cbd1d396387d0eae141e3', monthlyPriceId: '691cbd1d396387281fe141f7', annualPriceId: '691cbd1d3963874f57e141f2' }),
});

/** GHL statuses that REPORT a live subscription. Live-reported is not proof of payment (see stale detection). */
export const LIVE_STATUSES = Object.freeze(['active', 'trialing', 'past_due']);
/** GHL statuses known to report a subscription that is not live. Anything else is "unknown" and goes to review. */
export const ENDED_STATUSES = Object.freeze(['canceled', 'cancelled', 'incomplete', 'incomplete_expired', 'expired', 'ended', 'unpaid', 'paused']);

export const DEFAULT_LEGACY_OPTIONS = Object.freeze({
  graceDays: 7,                 // interval + grace without a successful payment -> stale_suspected (review only)
  transactionsLookbackDays: 400,
  maxPages: 20,                 // per list; hitting it makes the pass INCOMPLETE (nothing is written)
  pageSize: 100,
});

const TIER = /^[a-z][a-z0-9_]{1,39}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Validate a billing map and build the price index. Throws on malformed config, never on ambiguity (that is data). */
export function buildPriceIndex(billing = LEGACY_BILLING) {
  if (!billing || typeof billing !== 'object') fail('INVALID_INPUT', 'legacy billing config must be an object');
  const index = new Map();
  for (const [tier, m] of Object.entries(billing)) {
    if (!TIER.test(tier)) fail('INVALID_INPUT', 'invalid legacy tier key: ' + tier);
    for (const [field, interval] of [['monthlyPriceId', 'month'], ['annualPriceId', 'year']]) {
      const id = m?.[field];
      if (id == null) continue;
      if (!ID.test(String(id))) fail('INVALID_INPUT', `invalid ${field} for ${tier}`);
      const list = index.get(id) || [];
      list.push({ tier, interval });
      index.set(id, list);
    }
  }
  return index;
}

/** -> { mapping: 'mapped'|'unmapped'|'ambiguous', tier, interval } */
export function mapPrice(index, priceId) {
  const hits = priceId ? index.get(String(priceId)) || [] : [];
  const tiers = [...new Set(hits.map((h) => h.tier))];
  if (tiers.length === 0) return { mapping: 'unmapped', tier: null, interval: null };
  if (tiers.length > 1 || hits.length > 1) return { mapping: 'ambiguous', tier: null, interval: null };
  return { mapping: 'mapped', tier: hits[0].tier, interval: hits[0].interval };
}

/** 'live' | 'ended' | 'unknown'. The verbatim string is stored separately and never rewritten. */
export function classifyStatus(reported, { live = LIVE_STATUSES, ended = ENDED_STATUSES } = {}) {
  const s = String(reported ?? '').trim().toLowerCase();
  if (live.includes(s)) return 'live';
  if (ended.includes(s)) return 'ended';
  return 'unknown';
}
