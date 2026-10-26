/**
 * Legacy GHL membership reader (architecture C): a READ-ONLY mirror of the
 * Silver / Gold / Diamond subscriptions GHL still bills.
 *
 * Two parts:
 *   createGhlLegacyReader()  GET-only client for /payments/subscriptions,
 *                            /payments/transactions and /products/{id}/price.
 *                            Separate from the contacts client (client.js).
 *                            Every other method or path is refused before a
 *                            request is built; there is no write path at all.
 *   syncLegacyMemberships()  one pass: read everything (paginated, hard page
 *                            cap), then upsert legacy_memberships in one
 *                            transaction.
 *
 * What a pass guarantees (tested):
 *   - tier comes ONLY from the price id (mapped / unmapped / ambiguous);
 *   - `reported_status` is GHL's string verbatim; nothing is ever marked
 *     canceled, inactive or ended by this code, and no access changes here;
 *   - stale or odd rows are REVIEW items (`review_state='needs_review'`,
 *     explicit `review_reasons`), never "inactive";
 *   - rows are never deleted: a subscription that stops appearing in a
 *     COMPLETE pass is flagged `not_seen_in_complete_pass`;
 *   - an INCOMPLETE pass (page cap hit, or an error part-way) writes nothing
 *     to legacy_memberships, so `max(last_seen_at)` stays an honest freshness
 *     signal for the billing guard; it is logged in legacy_reader_runs.
 */
import { createHttpClient } from '../http.js';
import { withTransaction } from '../../db.js';
import { findPerson } from '../../identity.js';
import { MembershipError, fail } from '../../errors.js';
import { GHL_API_BASE, GHL_API_VERSION } from './client.js';
import { LEGACY_BILLING, DEFAULT_LEGACY_OPTIONS, LIVE_STATUSES, ENDED_STATUSES, buildPriceIndex } from './legacy-config.js';
import { normalizeSubscription, successfulPayments, evaluateLegacyRow, mergeReview } from './legacy-rules.js';

const ID = '[A-Za-z0-9_-]{1,64}';
const ROUTES = [
  new RegExp('^/payments/subscriptions$'),
  new RegExp('^/payments/transactions$'),
  new RegExp(`^/products/${ID}/price$`),
];

/** GET only, three billing read routes only. */
export function guardLegacyPath(method, path) {
  if (method !== 'GET') throw new MembershipError('FORBIDDEN', `GHL legacy reader is GET-only (refused ${method})`);
  if (!ROUTES.some((re) => re.test(path))) throw new MembershipError('FORBIDDEN', `GHL GET ${path.split('?')[0]} is outside the legacy billing reader`);
}

export function createGhlLegacyReader({ token, locationId, fetch, baseUrl = GHL_API_BASE, version = GHL_API_VERSION, retry, sleep, random, maxPages = DEFAULT_LEGACY_OPTIONS.maxPages, pageSize = DEFAULT_LEGACY_OPTIONS.pageSize, onRequest } = {}) {
  if (!token) throw new MembershipError('INVALID_INPUT', 'GHL token is required');
  if (!locationId) throw new MembershipError('INVALID_INPUT', 'GHL locationId is required');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new MembershipError('INVALID_INPUT', 'maxPages must be 1..100');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new MembershipError('INVALID_INPUT', 'pageSize must be 1..100');
  const request = createHttpClient({
    provider: 'ghl', baseUrl, fetch, retry, sleep, random, onRequest, guardPath: guardLegacyPath,
    headers: { Authorization: `Bearer ${token}`, Version: version },
  });
  const base = { altId: locationId, altType: 'location' };

  /** Offset pagination with a hard cap. complete=false when the cap stops it with rows still remaining. */
  async function paginate(path, query = {}) {
    const items = [];
    let pages = 0;
    let total = null;
    for (let offset = 0; pages < maxPages; offset += pageSize) {
      const r = await request('GET', path, { query: { ...base, ...query, limit: pageSize, offset } });
      pages++;
      const data = Array.isArray(r?.data) ? r.data : Array.isArray(r?.subscriptions) ? r.subscriptions : Array.isArray(r?.transactions) ? r.transactions : [];
      if (Number.isFinite(Number(r?.totalCount))) total = Number(r.totalCount);
      items.push(...data);
      const done = data.length < pageSize || (total !== null && items.length >= total);
      if (done) return { items, pages, complete: true, totalCount: total };
    }
    return { items, pages, complete: false, totalCount: total };
  }

  return Object.freeze({
    listSubscriptions: () => paginate('/payments/subscriptions'),
    listTransactions: ({ startAt } = {}) => paginate('/payments/transactions', startAt ? { startAt: new Date(startAt).toISOString() } : {}),
    async getProductPrices(productId) {
      if (typeof productId !== 'string' || !new RegExp(`^${ID}$`).test(productId)) fail('INVALID_INPUT', 'invalid GHL product id');
      const r = await request('GET', `/products/${productId}/price`, { query: { locationId } });
      return Array.isArray(r?.prices) ? r.prices : Array.isArray(r?.data) ? r.data : [];
    },
  });
}

async function recordRun(pool, run) {
  await pool.query(
    `INSERT INTO legacy_reader_runs (started_at, finished_at, complete, subscriptions_seen, transactions_seen, pages, error_code, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [run.startedAt, run.finishedAt, run.complete, run.subscriptions, run.transactions, run.pages, run.errorCode, JSON.stringify(run.summary || {})]);
}

/**
 * syncLegacyMemberships({ pool, reader, billing, options, now })
 * -> { complete, written, flaggedNotSeen, reasons: {reason: n}, pages, errorCode? }
 */
export async function syncLegacyMemberships({ pool, reader, billing = LEGACY_BILLING, options = {}, now = new Date() }) {
  const opt = { ...DEFAULT_LEGACY_OPTIONS, liveStatuses: LIVE_STATUSES, endedStatuses: ENDED_STATUSES, ...options };
  const index = buildPriceIndex(billing);
  const startedAt = new Date();
  const run = { startedAt, finishedAt: null, complete: false, subscriptions: 0, transactions: 0, pages: 0, errorCode: null, summary: {} };

  let subs; let txs;
  try {
    subs = await reader.listSubscriptions();
    run.pages += subs.pages; run.subscriptions = subs.items.length;
    if (subs.complete) {
      txs = await reader.listTransactions({ startAt: new Date(now.getTime() - opt.transactionsLookbackDays * 86400000) });
      run.pages += txs.pages; run.transactions = txs.items.length;
    }
  } catch (e) {
    if (!e?.code) throw e;
    run.errorCode = e.code;
  }
  if (run.errorCode || !subs?.complete || !txs?.complete) {
    run.finishedAt = new Date();
    run.summary = { reason: run.errorCode ? 'error' : 'page_cap' };
    await recordRun(pool, run);
    return { complete: false, written: 0, flaggedNotSeen: 0, reasons: {}, pages: run.pages, ...(run.errorCode ? { errorCode: run.errorCode } : { reason: 'page_cap' }) };
  }

  const payments = successfulPayments(txs.items);
  const normalized = subs.items.map((s) => normalizeSubscription(s, index)).filter((s) => s.externalSubscriptionId);

  const result = await withTransaction(pool, async (c) => {
    const prevRows = (await c.query("SELECT * FROM legacy_memberships WHERE source = 'ghl' FOR UPDATE")).rows;
    const prev = new Map(prevRows.map((r) => [r.external_subscription_id, r]));

    // person links first, so "several live legacy subscriptions for one person" can be judged across the pass
    for (const s of normalized) {
      const p = s.externalContactId && /^[A-Za-z0-9_-]{1,200}$/.test(s.externalContactId)
        ? await findPerson(c, { platform: 'ghl', kind: 'contact', externalId: s.externalContactId }) : null;
      s.personId = p ? (p.merged_into || p.id) : (prev.get(s.externalSubscriptionId)?.person_id || null);
    }
    const liveMappedByOwner = new Map();
    for (const s of normalized) {
      const ev = evaluateLegacyRow(s, { payments, now, ...opt });
      s.ev = ev;
      if (ev.statusClass === 'live' && s.mapping === 'mapped') {
        const owner = s.personId ? 'p:' + s.personId : s.externalContactId ? 'c:' + s.externalContactId : null;
        if (owner) liveMappedByOwner.set(owner, (liveMappedByOwner.get(owner) || 0) + 1);
      }
    }

    const reasons = {};
    const seen = new Set();
    for (const s of normalized) {
      seen.add(s.externalSubscriptionId);
      const old = prev.get(s.externalSubscriptionId) || null;
      const computed = [...s.ev.reasons];
      const owner = s.personId ? 'p:' + s.personId : s.externalContactId ? 'c:' + s.externalContactId : null;
      if (s.ev.statusClass === 'live' && s.mapping === 'mapped' && owner && liveMappedByOwner.get(owner) > 1) computed.push('multiple_live_legacy');
      if (old && old.external_contact_id && s.externalContactId && old.external_contact_id !== s.externalContactId) computed.push('contact_rekeyed');
      const review = mergeReview(old, computed);
      for (const r of review.reasons) reasons[r] = (reasons[r] || 0) + 1;
      await c.query(
        `INSERT INTO legacy_memberships (source, external_subscription_id, external_contact_id, person_id, payment_provider, external_price_id, tier, mapping,
            reported_status, amount_cents, currency, billing_interval, last_payment_at, paid_through_estimate, stale_suspected, review_state, review_reasons,
            first_seen_at, last_seen_at, updated_at)
         VALUES ('ghl', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17, $17)
         ON CONFLICT (source, external_subscription_id) DO UPDATE SET
            external_contact_id = EXCLUDED.external_contact_id, person_id = EXCLUDED.person_id, payment_provider = EXCLUDED.payment_provider,
            external_price_id = EXCLUDED.external_price_id, tier = EXCLUDED.tier, mapping = EXCLUDED.mapping, reported_status = EXCLUDED.reported_status,
            amount_cents = EXCLUDED.amount_cents, currency = EXCLUDED.currency, billing_interval = EXCLUDED.billing_interval,
            last_payment_at = EXCLUDED.last_payment_at, paid_through_estimate = EXCLUDED.paid_through_estimate,
            stale_suspected = EXCLUDED.stale_suspected, review_state = EXCLUDED.review_state, review_reasons = EXCLUDED.review_reasons,
            last_seen_at = EXCLUDED.last_seen_at, updated_at = EXCLUDED.updated_at`,
        [s.externalSubscriptionId, s.externalContactId, s.personId, s.provider, s.priceId, s.tier, s.mapping, s.reportedStatus, s.amountCents, s.currency,
          s.interval, s.ev.lastPaymentAt, s.ev.paidThrough, s.ev.stale, review.state, review.reasons, now]);
    }

    // never delete; a subscription that stopped appearing in a complete pass is a review item
    let flaggedNotSeen = 0;
    for (const old of prevRows) {
      if (seen.has(old.external_subscription_id)) continue;
      const review = mergeReview(old, [...old.review_reasons, 'not_seen_in_complete_pass']);
      if (review.state === old.review_state && review.reasons.join() === old.review_reasons.join()) continue;
      await c.query('UPDATE legacy_memberships SET review_state = $2, review_reasons = $3, updated_at = $4 WHERE id = $1', [old.id, review.state, review.reasons, now]);
      flaggedNotSeen++;
    }
    return { written: normalized.length, flaggedNotSeen, reasons };
  });

  run.complete = true; run.finishedAt = new Date(); run.summary = { written: result.written, flaggedNotSeen: result.flaggedNotSeen, reasons: result.reasons };
  await recordRun(pool, run);
  return { complete: true, pages: run.pages, ...result };
}

/** Staff acknowledgement of a review item. Never changes status, tier or access. */
export async function markLegacyReviewed(pool, id, { by, note = null }) {
  if (!by) fail('INVALID_INPUT', 'by is required');
  const r = await pool.query(
    "UPDATE legacy_memberships SET review_state = 'reviewed', review_note = $2, updated_at = now() WHERE id = $1 AND review_state = 'needs_review' RETURNING id",
    [id, `${by}: ${note || 'reviewed'}`.slice(0, 500)]);
  if (!r.rowCount) fail('NOT_FOUND', 'no legacy membership awaiting review with that id');
  return { reviewed: true };
}

/**
 * Check that every configured price id exists on its GHL product (config drift report).
 * -> { checked, missing: [{ tier, field, priceId }] }
 */
export async function checkLegacyConfig(reader, billing = LEGACY_BILLING) {
  buildPriceIndex(billing);
  const missing = [];
  let checked = 0;
  for (const [tier, m] of Object.entries(billing)) {
    if (!m.ghlProductId) continue;
    const ids = new Set((await reader.getProductPrices(m.ghlProductId)).map((p) => String(p?._id || p?.id || '')));
    for (const field of ['monthlyPriceId', 'annualPriceId']) {
      if (!m[field]) continue;
      checked++;
      if (!ids.has(m[field])) missing.push({ tier, field, priceId: m[field] });
    }
  }
  return { checked, missing };
}
