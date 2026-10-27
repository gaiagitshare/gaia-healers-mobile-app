/**
 * Pure rules for the legacy GHL mirror: normalise a GHL subscription, find its
 * newest successful payment, estimate paid-through, flag stale and review
 * items. No I/O.
 *
 * Hard rule: these functions only ever produce REVIEW signals. There is no
 * output that means "canceled", "inactive" or "ended"; the reported status is
 * passed through verbatim.
 */
import { mapPrice, classifyStatus, LIVE_STATUSES, ENDED_STATUSES } from './legacy-config.js';

/** Reasons that persist until a human marks the row reviewed (they record an event, not a current fact). */
export const STICKY_REASONS = Object.freeze(['contact_rekeyed', 'not_seen_in_complete_pass']);

export const REVIEW_REASONS = Object.freeze([
  'unknown_status', 'unmapped_price', 'ambiguous_price', 'missing_contact', 'contact_rekeyed', 'multiple_live_legacy',
  'stale_suspected', 'paypal_no_recent_payment', 'unknown_provider', 'not_seen_in_complete_pass',
]);

export function providerOf(raw) {
  const v = String(raw?.paymentProvider?.type ?? raw?.paymentProviderType ?? raw?.paymentProvider ?? raw?.provider ?? '').toLowerCase();
  if (v.includes('paypal')) return 'paypal';
  if (v.includes('stripe')) return 'stripe';
  if (v.includes('manual')) return 'manual';
  return 'unknown';
}

const INTERVALS = ['month', 'year', 'week', 'day'];
const toInterval = (v) => {
  const s = String(v || '').toLowerCase().replace(/ly$/, '').replace(/^annual$/, 'year');
  if (!s) return null;
  return INTERVALS.includes(s) ? s : 'other';
};
const cents = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Math.round(Number(v) * 100));
const currency = (v) => (typeof v === 'string' && /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : null);
const str = (v) => (v == null || v === '' ? null : String(v));

/** One GHL /payments/subscriptions item -> the fields the mirror stores. */
export function normalizeSubscription(raw, priceIndex) {
  const price = raw?.recurringProduct?.price || raw?.price || {};
  const priceId = str(price?._id ?? price?.id ?? raw?.priceId);
  const m = mapPrice(priceIndex, priceId);
  return {
    externalSubscriptionId: str(raw?._id ?? raw?.id),
    providerSubscriptionId: str(raw?.subscriptionId),
    externalContactId: str(raw?.contactId ?? raw?.contact?.id),
    provider: providerOf(raw),
    priceId,
    mapping: m.mapping,
    tier: m.tier,
    interval: m.interval || toInterval(price?.recurring?.interval ?? raw?.recurring?.interval ?? raw?.interval),
    intervalCount: Number(price?.recurring?.intervalCount ?? 1) || 1,
    reportedStatus: raw?.status == null ? '' : String(raw.status),
    amountCents: cents(price?.amount ?? raw?.amount),
    currency: currency(price?.currency ?? raw?.currency),
    startedAt: raw?.createdAt || raw?.startDate || null,
  };
}

/** subscription id (GHL `_id` or provider `sub_…`/`I-…`) -> newest successful, not fully refunded, payment time. */
export function successfulPayments(transactions) {
  const out = new Map();
  for (const t of transactions || []) {
    if (String(t?.status || '').toLowerCase() !== 'succeeded') continue;
    const amount = Number(t?.amount ?? 0);
    if (Number(t?.amountRefunded ?? 0) > 0 && Number(t.amountRefunded) >= amount) continue;
    const at = new Date(t?.createdAt || t?.fulfilledAt || 0);
    if (!Number.isFinite(at.getTime()) || at.getTime() === 0) continue;
    for (const key of [t?.subscriptionId, t?.entitySourceMeta?.subscriptionId, t?.meta?.subscriptionId].filter(Boolean).map(String)) {
      const cur = out.get(key);
      if (!cur || at > cur) out.set(key, at);
    }
  }
  return out;
}

/** last payment + one billing interval (calendar arithmetic, UTC). null when the interval is unknown. */
export function addInterval(at, interval, count = 1) {
  if (!at) return null;
  const d = new Date(at);
  if (interval === 'month') d.setUTCMonth(d.getUTCMonth() + count);
  else if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + count);
  else if (interval === 'week') d.setUTCDate(d.getUTCDate() + 7 * count);
  else if (interval === 'day') d.setUTCDate(d.getUTCDate() + count);
  else return null;
  return d;
}

/**
 * Evaluate one normalised subscription.
 * -> { statusClass, lastPaymentAt, paidThrough, stale, reasons }
 */
export function evaluateLegacyRow(s, { payments = new Map(), now = new Date(), graceDays = 7, liveStatuses = LIVE_STATUSES, endedStatuses = ENDED_STATUSES } = {}) {
  const statusClass = classifyStatus(s.reportedStatus, { live: liveStatuses, ended: endedStatuses });
  const candidates = [s.externalSubscriptionId, s.providerSubscriptionId].filter(Boolean).map((k) => payments.get(k)).filter(Boolean);
  const lastPaymentAt = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;
  const paidThrough = addInterval(lastPaymentAt, s.interval, s.intervalCount);
  const graceMs = graceDays * 86400000;

  let stale = false;
  if (statusClass === 'live') {
    if (paidThrough) stale = now.getTime() > paidThrough.getTime() + graceMs;
    else if (!lastPaymentAt) {
      // no successful payment seen at all: stale once a whole interval + grace has passed since it started
      const fromStart = addInterval(s.startedAt, s.interval, s.intervalCount);
      stale = fromStart ? now.getTime() > fromStart.getTime() + graceMs : !s.startedAt;
    }
  }

  const reasons = [];
  if (statusClass === 'unknown') reasons.push('unknown_status');
  if (s.mapping === 'unmapped') reasons.push('unmapped_price');
  if (s.mapping === 'ambiguous') reasons.push('ambiguous_price');
  if (!s.externalContactId) reasons.push('missing_contact');
  if (s.provider === 'unknown') reasons.push('unknown_provider');
  if (stale) reasons.push('stale_suspected');
  if (stale && s.provider === 'paypal') reasons.push('paypal_no_recent_payment');
  return { statusClass, lastPaymentAt, paidThrough, stale, reasons };
}

/**
 * Combine the previous review state with this pass's reasons.
 *   - sticky reasons survive until a human reviews the row;
 *   - a reviewed row stays reviewed while no NEW reason appears;
 *   - no reasons -> 'none' (unless reviewed).
 */
export function mergeReview(prev, computed) {
  const prevReasons = prev?.review_reasons || [];
  const prevState = prev?.review_state || 'none';
  const sticky = prevState === 'reviewed' ? [] : prevReasons.filter((r) => STICKY_REASONS.includes(r));
  const reasons = [...new Set([...computed, ...sticky])].sort();
  if (!reasons.length) return { state: prevState === 'reviewed' ? 'reviewed' : 'none', reasons };
  if (prevState === 'reviewed' && reasons.every((r) => prevReasons.includes(r))) return { state: 'reviewed', reasons };
  return { state: 'needs_review', reasons };
}
