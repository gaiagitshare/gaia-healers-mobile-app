/**
 * Stripe event -> Gaia state. Every handler is idempotent and order-tolerant:
 *   - ledger rows are unique per (provider object, entry type): a duplicate or
 *     replayed event writes nothing new;
 *   - subscription state carries Stripe's event time; older events are ignored;
 *   - an event that references a subscription we have not recorded yet throws,
 *     so the processor retries it after the creating event arrives.
 *
 * Mapping rules (no guessing):
 *   - person: the Stripe customer must be linked in person_identities
 *     (platform 'stripe', kind 'customer');
 *   - plan: the Stripe price must be in provider_price_refs. An unknown price
 *     is not a Gaia membership price and the event is ignored, never mapped by
 *     amount or name.
 */
import { createSubscriptionInTx, transitionInTx } from '../subscriptions.js';

const STATUS = {
  incomplete: 'incomplete', incomplete_expired: 'expired', trialing: 'trialing', active: 'active',
  past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', paused: 'paused',
};
const ts = (s) => (s == null ? null : new Date(Number(s) * 1000));

class RetryLater extends Error { constructor(m) { super(m); this.code = 'RETRY_LATER'; } }

async function personForCustomer(c, customerId) {
  if (!customerId) return null;
  const r = await c.query("SELECT person_id FROM person_identities WHERE platform = 'stripe' AND kind = 'customer' AND external_id = $1", [customerId]);
  return r.rows[0]?.person_id || null;
}

async function priceRef(c, priceId, livemode) {
  const r = await c.query(
    `SELECT p.plan_version_id, p.billing_interval FROM provider_price_refs r JOIN plan_version_prices p ON p.id = r.plan_version_price_id
      WHERE r.provider = 'stripe' AND r.external_price_id = $1 AND r.livemode = $2`, [priceId, Boolean(livemode)]);
  return r.rows[0] || null;
}

async function localSubscription(c, stripeSubId) {
  return (await c.query("SELECT id, status, person_id FROM subscriptions WHERE provider = 'stripe' AND provider_subscription_id = $1", [stripeSubId])).rows[0] || null;
}

async function ledger(c, row) {
  await c.query(
    `INSERT INTO payment_ledger (person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency,
                                 subscription_id, webhook_event_id, livemode, occurred_at)
     VALUES ($1, 'stripe', $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (provider, provider_object_type, provider_object_id, entry_type) DO NOTHING`,
    [row.personId, row.objectType, row.objectId, row.entryType, row.amount, String(row.currency || '').toUpperCase(), row.subscriptionId || null, row.webhookEventId, row.livemode, row.occurredAt]);
}

async function subscriptionChanged(c, event, row) {
  const s = event.data.object;
  const to = STATUS[s.status];
  if (!to) return 'ignored';
  const at = ts(event.created);
  const item = s.items?.data?.[0];
  const period = { periodStart: ts(item?.current_period_start ?? s.current_period_start), periodEnd: ts(item?.current_period_end ?? s.current_period_end) };
  let local = await localSubscription(c, s.id);
  if (!local) {
    const ref = item?.price?.id ? await priceRef(c, item.price.id, event.livemode) : null;
    if (!ref) return 'ignored';                                   // not a Gaia membership price
    const personId = await personForCustomer(c, s.customer);
    if (!personId) throw new RetryLater('stripe customer not linked to a person yet');
    const initial = ['incomplete', 'trialing', 'active'].includes(to) ? to : 'incomplete';
    const id = await createSubscriptionInTx(c, { personId, planVersionId: ref.plan_version_id, interval: ref.billing_interval, provider: 'stripe',
      providerSubscriptionId: s.id, status: initial, trialEnd: ts(s.trial_end), ...period, providerStateAt: at });
    if (initial === to) return 'processed';
    local = { id };
  }
  const r = await transitionInTx(c, local.id, to, {
    reason: 'stripe:' + event.type, now: at, providerStateAt: at, ...period,
    cancelAt: s.cancel_at ? ts(s.cancel_at) : null, webhookEventId: row.id,
  });
  return r.applied || r.stale ? 'processed' : 'ignored';
}

async function invoicePaid(c, event, row) {
  const inv = event.data.object;
  const subId = inv.subscription || inv.parent?.subscription_details?.subscription;
  const local = subId ? await localSubscription(c, subId) : null;
  if (subId && !local) throw new RetryLater('invoice for a subscription not recorded yet');
  const personId = local?.person_id || await personForCustomer(c, inv.customer);
  if (!local && !personId) return 'ignored';
  await ledger(c, { personId, objectType: 'invoice', objectId: inv.id, entryType: 'charge', amount: inv.amount_paid, currency: inv.currency,
    subscriptionId: local?.id, webhookEventId: row.id, livemode: event.livemode === true, occurredAt: ts(inv.status_transitions?.paid_at) || ts(event.created) });
  if (local && local.status !== 'active') {
    const line = inv.lines?.data?.[0]?.period;
    await transitionInTx(c, local.id, 'active', { reason: 'stripe:invoice.paid', now: ts(event.created), providerStateAt: ts(event.created),
      periodStart: ts(line?.start), periodEnd: ts(line?.end), webhookEventId: row.id });
  }
  return 'processed';
}

async function invoiceFailed(c, event, row) {
  const inv = event.data.object;
  const subId = inv.subscription || inv.parent?.subscription_details?.subscription;
  if (!subId) return 'ignored';
  const local = await localSubscription(c, subId);
  if (!local) throw new RetryLater('invoice for a subscription not recorded yet');
  if (local.status === 'canceled' || local.status === 'expired') return 'ignored';
  await transitionInTx(c, local.id, 'past_due', { reason: 'stripe:invoice.payment_failed', now: ts(event.created), providerStateAt: ts(event.created), webhookEventId: row.id });
  return 'processed';
}

async function chargeRefunded(c, event, row) {
  const ch = event.data.object;
  const personId = await personForCustomer(c, ch.customer);
  const refunds = ch.refunds?.data || [];
  for (const r of refunds) {
    await ledger(c, { personId, objectType: 'refund', objectId: r.id, entryType: 'refund', amount: -Math.abs(r.amount), currency: r.currency || ch.currency,
      webhookEventId: row.id, livemode: event.livemode === true, occurredAt: ts(r.created) || ts(event.created) });
  }
  return refunds.length ? 'processed' : 'ignored';
}

async function dispute(c, event, row) {
  const d = event.data.object;
  const personId = await personForCustomer(c, d.customer || d.charge?.customer);
  if (event.type === 'charge.dispute.created') {
    await ledger(c, { personId, objectType: 'dispute', objectId: d.id, entryType: 'dispute', amount: -Math.abs(d.amount), currency: d.currency,
      webhookEventId: row.id, livemode: event.livemode === true, occurredAt: ts(d.created) || ts(event.created) });
    return 'processed';
  }
  if (d.status === 'won') {
    await ledger(c, { personId, objectType: 'dispute', objectId: d.id, entryType: 'dispute_reversal', amount: Math.abs(d.amount), currency: d.currency,
      webhookEventId: row.id, livemode: event.livemode === true, occurredAt: ts(event.created) });
    return 'processed';
  }
  return 'ignored';
}

export const stripeHandlers = Object.freeze({
  'customer.subscription.created': subscriptionChanged,
  'customer.subscription.updated': subscriptionChanged,
  'customer.subscription.deleted': subscriptionChanged,
  'customer.subscription.paused': subscriptionChanged,
  'customer.subscription.resumed': subscriptionChanged,
  'invoice.paid': invoicePaid,
  'invoice.payment_failed': invoiceFailed,
  'charge.refunded': chargeRefunded,
  'charge.dispute.created': dispute,
  'charge.dispute.closed': dispute,
});
