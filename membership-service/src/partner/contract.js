/**
 * What we need from Gaia Practitioners, as code (docs/membership/PARTNER-INTEGRATION-REQUEST.md).
 *
 * The partner keeps its own database, subscriptions and coin system; we never
 * write to them. These validators check partner payloads against the agreed
 * shapes so a missing or ambiguous field is caught at the boundary instead of
 * being guessed. Every field below is a REQUEST until the partner confirms it.
 */
import { fail } from '../errors.js';

const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isInt = (v) => Number.isSafeInteger(v);
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const oneOf = (v, xs) => xs.includes(v);

export const COIN_SOURCES = ['purchase', 'grant', 'promotion', 'compensation', 'refund', 'adjustment', 'spend', 'unknown'];
export const SUB_STATUSES = ['trialing', 'active', 'past_due', 'paused', 'canceled', 'expired'];
export const BILLING_OWNERS = ['partner', 'gaia', 'none'];

function check(cond, field) { if (!cond) fail('INVALID_INPUT', 'partner payload: invalid ' + field, { field }); }

export function validatePractitionerIdentity(x) {
  check(x && isStr(x.practitioner_account_id), 'practitioner_account_id');
  check(x.status && oneOf(x.status, ['active', 'pending', 'suspended', 'closed']), 'status');
  check(x.email === undefined || isStr(x.email), 'email');
  check(x.gaia_contact_id === undefined || x.gaia_contact_id === null || isStr(x.gaia_contact_id), 'gaia_contact_id');
  return x;
}

export function validateSubscription(x) {
  check(x && isStr(x.subscription_id), 'subscription_id');
  check(isStr(x.practitioner_account_id), 'practitioner_account_id');
  check(isStr(x.plan_code), 'plan_code');
  check(oneOf(x.status, SUB_STATUSES), 'status');
  check(isInt(x.price_cents) && x.price_cents >= 0, 'price_cents');
  check(/^[A-Z]{3}$/.test(x.currency || ''), 'currency');
  check(oneOf(x.interval, ['month', 'year']), 'interval');
  check(isIso(x.current_period_end), 'current_period_end');
  check(oneOf(x.billing_owner, BILLING_OWNERS), 'billing_owner');
  check(x.billing_provider === null || isStr(x.billing_provider), 'billing_provider');
  check(Array.isArray(x.modules) && x.modules.every(isStr), 'modules');
  return x;
}

/** A balance is only usable if it is backed by its history: the sums must match. */
export function validateCoinLedger({ balance, transactions }) {
  check(balance && isStr(balance.practitioner_account_id) && isInt(balance.coins) && isIso(balance.as_of), 'balance');
  check(Array.isArray(transactions), 'transactions');
  let sum = 0;
  for (const t of transactions) {
    check(isStr(t.transaction_id) && isInt(t.delta_coins) && t.delta_coins !== 0 && isIso(t.created_at), 'transaction');
    check(oneOf(t.source, COIN_SOURCES), 'transaction.source');
    check(t.source !== 'purchase' || isStr(t.payment_ref), 'transaction.payment_ref (purchases must name their payment)');
    sum += t.delta_coins;
  }
  check(sum === balance.coins, 'balance (does not equal the sum of its transactions)');
  return { balance, transactions };
}

/**
 * Split a partner balance by provenance for the 1:1 carry-over (spec §11,
 * audit H / decision N-4). Purchased coins need a payment reference; anything
 * else goes to the legacy bucket (never expires, spent last) unless the owner
 * decides all historical coins count as purchased. Pure; moves nothing.
 */
export function classifyCarryOver({ balance, transactions }, { allHistoricalArePurchased = false } = {}) {
  validateCoinLedger({ balance, transactions });
  if (balance.coins <= 0) return { purchased: 0, legacy: 0 };
  if (allHistoricalArePurchased) return { purchased: balance.coins, legacy: 0 };
  // Spend is attributed to non-purchased coins first, which is the customer-favourable reading.
  const bought = transactions.filter((t) => t.source === 'purchase' && t.delta_coins > 0).reduce((a, t) => a + t.delta_coins, 0);
  const purchased = Math.min(bought, balance.coins);
  return { purchased, legacy: balance.coins - purchased };
}
