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
 *     amount or name (its invoices are ignored too, not retried);
 *   - money is always booked, even when the status change it implies is not
 *     allowed (e.g. a final invoice paid after a cancellation);
 *   - a plan change on the Stripe item (upgrade / downgrade) moves the local
 *     subscription to the mapped plan version, with a history row.
 */
import { createSubscriptionInTx, transitionInTx, canTransition } from '../subscriptions.js';
import { creditPurchase, clawbackPurchased } from '../coins.js';
import { fail } from '../errors.js';
import { linkSubscriptionInTx } from '../migration-offers.js';

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
  return (await c.query("SELECT id, status, person_id, plan_version_id, billing_interval, provider_state_at FROM subscriptions WHERE provider = 'stripe' AND provider_subscription_id = $1", [stripeSubId])).rows[0] || null;
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
  const ref = item?.price?.id ? await priceRef(c, item.price.id, event.livemode) : null;
  let local = await localSubscription(c, s.id);
  if (!local) {
    if (!ref) return 'ignored';                                   // not a Gaia membership price
    const personId = await personForCustomer(c, s.customer);
    if (!personId) throw new RetryLater('stripe customer not linked to a person yet');
    const id = await createSubscriptionInTx(c, { personId, planVersionId: ref.plan_version_id, interval: ref.billing_interval, provider: 'stripe',
      providerSubscriptionId: s.id, status: to, trialEnd: ts(s.trial_end), ...period, providerStateAt: at },
      { actorType: 'provider', actorId: 'stripe' }, { observedFromProvider: true });
    // A subscription started from a migration offer: link it (the legacy one is still billed by GHL until staff confirm its cancellation).
    if (s.metadata?.gaia_migration_offer_id) await linkSubscriptionInTx(c, s.metadata.gaia_migration_offer_id, id);
    return 'processed';
  }
  if (ref && (ref.plan_version_id !== local.plan_version_id || ref.billing_interval !== local.billing_interval)
      && !(local.provider_state_at && at < new Date(local.provider_state_at))) {
    await c.query('UPDATE subscriptions SET plan_version_id = $2, billing_interval = $3, updated_at = $4 WHERE id = $1', [local.id, ref.plan_version_id, ref.billing_interval, at]);
    await c.query("INSERT INTO subscription_events (subscription_id, from_status, to_status, reason, webhook_event_id, details, occurred_at) VALUES ($1, $2, $2, 'plan_changed', $3, $4, $5)",
      [local.id, local.status, row.id, JSON.stringify({ fromPlanVersion: local.plan_version_id, toPlanVersion: ref.plan_version_id, interval: ref.billing_interval }), at]);
  }
  if (local.status !== to && !canTransition(local.status, to)) return 'ignored';   // e.g. a stale "active" after a final cancel
  await transitionInTx(c, local.id, to, {
    reason: 'stripe:' + event.type, now: at, providerStateAt: at, ...period,
    cancelAt: s.cancel_at ? ts(s.cancel_at) : null, webhookEventId: row.id,
  });
  return 'processed';
}

/** Price ids on an invoice's lines, across Stripe API versions. */
function linePriceIds(inv) {
  return (inv.lines?.data || []).map((l) => l.price?.id || l.pricing?.price_details?.price || l.plan?.id).filter(Boolean);
}

async function invoiceIsOurs(c, inv, livemode) {
  for (const id of linePriceIds(inv)) if (await priceRef(c, id, livemode)) return true;
  return false;
}

async function invoicePaid(c, event, row) {
  const inv = event.data.object;
  const subId = inv.subscription || inv.parent?.subscription_details?.subscription;
  const local = subId ? await localSubscription(c, subId) : null;
  if (subId && !local) {
    if (!(await invoiceIsOurs(c, inv, event.livemode))) return 'ignored';      // not a Gaia membership subscription
    throw new RetryLater('invoice for a subscription not recorded yet');
  }
  const personId = local?.person_id || await personForCustomer(c, inv.customer);
  if (!local && !personId) return 'ignored';
  await ledger(c, { personId, objectType: 'invoice', objectId: inv.id, entryType: 'charge', amount: inv.amount_paid, currency: inv.currency,
    subscriptionId: local?.id, webhookEventId: row.id, livemode: event.livemode === true, occurredAt: ts(inv.status_transitions?.paid_at) || ts(event.created) });
  if (local && local.status !== 'active' && canTransition(local.status, 'active')) {
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
  if (!local) {
    if (!(await invoiceIsOurs(c, inv, event.livemode))) return 'ignored';
    throw new RetryLater('invoice for a subscription not recorded yet');
  }
  // A declined first payment leaves it incomplete (no access either way); paused / ended ones are not dunned.
  if (!canTransition(local.status, 'past_due') || local.status === 'incomplete') return 'ignored';
  await transitionInTx(c, local.id, 'past_due', { reason: 'stripe:invoice.payment_failed', now: ts(event.created), providerStateAt: ts(event.created), webhookEventId: row.id });
  return 'processed';
}

async function bookRefund(c, r, { personId = null, currency, event, row, chargeId = null }) {
  if (r.status && r.status !== 'succeeded') return false;        // pending / failed refunds move no money
  const charge = r.charge || chargeId;
  const pack = charge ? (await c.query(
    `SELECT o.coins, o.related_entity_id, w.person_id, l.amount_cents FROM coin_operations o JOIN coin_wallets w ON w.id = o.wallet_id
       JOIN payment_ledger l ON l.coin_operation_id = o.id AND l.entry_type = 'charge'
      WHERE o.kind = 'purchase' AND o.related_entity_type = 'payment' AND o.related_entity_id = $1`, [charge])).rows[0] : null;
  await ledger(c, { personId: personId || pack?.person_id || null, objectType: 'refund', objectId: r.id, entryType: 'refund', amount: -Math.abs(r.amount), currency: r.currency || currency,
    webhookEventId: row.id, livemode: event.livemode === true, occurredAt: ts(r.created) || ts(event.created) });
  if (pack) {
    // Refund of a coin pack: take back the refunded share of its coins, as far as they are unspent.
    const coins = Math.min(pack.coins, Math.ceil(pack.coins * Math.abs(r.amount) / Math.max(1, pack.amount_cents)));
    if (coins > 0) {
      const cb = await clawbackPurchased(c, { personId: pack.person_id, coins, idempotencyKey: 'stripe-refund:' + r.id, relatedId: r.id, actor: { actorType: 'provider', actorId: 'stripe' } });
      if (cb.shortfall > 0) {
        // Already spent: record what could not be recovered, in coins and money, for a human decision.
        await c.query(
          `INSERT INTO coin_refund_reviews (person_id, refund_ref, charge_ref, coins_refunded, coins_recovered, coins_unrecovered, value_cents_unrecovered, currency)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (provider, refund_ref) DO NOTHING`,
          [pack.person_id, r.id, charge, coins, cb.clawedBack, cb.shortfall, Math.round(Math.abs(r.amount) * cb.shortfall / coins), String(r.currency || currency || 'usd').toUpperCase()]);
      }
    }
  }
  return true;
}

/**
 * Coin pack paid (spec §4): credit the purchased balance and book the charge in
 * ONE transaction. Only for PaymentIntents our checkout created (metadata), only
 * once the money arrived (payment_intent.succeeded, so delayed methods wait), and
 * only if the amount paid equals the pack price; anything else is refused for a human.
 */
async function coinPackPaid(c, event, row) {
  const pi = event.data.object;
  const md = pi.metadata || {};
  if (!md.gaia_coin_package_id) return 'ignored';                // not a Gaia coin pack (subscriptions arrive as invoices)
  const pack = (await c.query('SELECT id, key, coins, bonus_coins, price_cents, currency FROM coin_packages WHERE id = $1', [md.gaia_coin_package_id])).rows[0];
  if (!pack) fail('INVALID_INPUT', 'unknown coin package');
  const person = (await c.query('SELECT id FROM persons WHERE id = $1', [md.gaia_person_id])).rows[0];
  if (!person) fail('INVALID_INPUT', 'unknown person on coin pack payment');
  const coins = Number(md.gaia_coins);
  if (!Number.isSafeInteger(coins) || coins !== pack.coins + pack.bonus_coins) fail('INVALID_INPUT', 'coin count does not match the package');
  if (pi.amount_received !== pack.price_cents || String(pi.currency).toUpperCase() !== pack.currency) fail('INVALID_INPUT', 'amount paid does not match the package price');
  const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
  if (!chargeId) throw new RetryLater('payment intent has no charge yet');
  const credit = await creditPurchase(c, { personId: person.id, coins, idempotencyKey: 'stripe-pi:' + pi.id, paymentRef: chargeId, actor: { actorType: 'provider', actorId: 'stripe' } });
  await c.query(
    `INSERT INTO payment_ledger (person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, coin_operation_id, webhook_event_id, livemode, occurred_at)
     VALUES ($1, 'stripe', 'charge', $2, 'charge', $3, $4, $5, $6, $7, $8)
     ON CONFLICT (provider, provider_object_type, provider_object_id, entry_type) DO NOTHING`,
    [person.id, chargeId, pi.amount_received, pack.currency, credit.operation.id, row.id, event.livemode === true, ts(event.created)]);
  return 'processed';
}

/** Older API versions embed refunds in the charge; newer ones send refund.* events (handled below). */
async function chargeRefunded(c, event, row) {
  const ch = event.data.object;
  const personId = await personForCustomer(c, ch.customer);
  let booked = 0;
  for (const r of ch.refunds?.data || []) if (await bookRefund(c, r, { personId, currency: ch.currency, event, row, chargeId: ch.id })) booked++;
  return booked ? 'processed' : 'ignored';
}

async function refundEvent(c, event, row) {
  const r = event.data.object;
  return (await bookRefund(c, r, { currency: r.currency, event, row })) ? 'processed' : 'ignored';
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
  'payment_intent.succeeded': coinPackPaid,
  'invoice.payment_failed': invoiceFailed,
  'charge.refunded': chargeRefunded,
  'refund.created': refundEvent,
  'refund.updated': refundEvent,
  'charge.refund.updated': refundEvent,
  'charge.dispute.created': dispute,
  'charge.dispute.closed': dispute,
});
