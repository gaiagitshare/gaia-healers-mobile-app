/**
 * Stripe test-mode adapter: Gaia state -> Stripe objects (spec v2.5 §10).
 *
 * Gaia stays the source of truth for plans and prices; Stripe gets a copy:
 *   - one Stripe Product per Gaia plan, with a deterministic id
 *     (`gaia_plan_<key>`), so creating it twice is impossible;
 *   - one Stripe Price per published plan-version price, recorded in
 *     provider_price_refs (livemode false). A price is NEVER edited: a new
 *     plan version gets a new Price, existing subscribers keep theirs;
 *   - Checkout Sessions carry metadata.gaia_person_id / gaia_plan_version_id so
 *     webhooks map back without guessing (handlers.js maps by price id).
 *
 * Every Stripe POST uses a deterministic Idempotency-Key derived from the Gaia
 * object (or the caller's request key), so retries never duplicate anything.
 *
 * Usage: const deps = { pool, stripe: createStripeClient({ apiKey, fetch }) }.
 */
import { withTransaction } from '../../db.js';
import { audit } from '../../audit.js';
import { fail } from '../../errors.js';
import { linkIdentity, identitiesOf } from '../../identity.js';
import { scheduleCancel } from '../../subscriptions.js';

const ACTOR = { actorType: 'system', actorId: 'stripe-adapter' };
const LIVE_SUB_STATUSES = ['incomplete', 'trialing', 'active', 'past_due', 'paused'];

const productIdFor = (planKey) => `gaia_plan_${planKey}`;
const lookupKeyFor = (p) => `gaia_${p.plan_key}_v${p.version}_${p.billing_interval}_${p.currency.toLowerCase()}`;

function checkUrl(u, what) {
  let url;
  try { url = new URL(u); } catch { fail('INVALID_INPUT', `${what} must be an absolute URL`); }
  if (!['https:', 'http:'].includes(url.protocol)) fail('INVALID_INPUT', `${what} must be http(s)`);
  return url.toString();
}
function checkKey(k) {
  if (typeof k !== 'string' || k.length < 8 || k.length > 200) fail('INVALID_INPUT', 'idempotencyKey must be 8-200 characters');
  return k;
}

async function activePerson(db, personId) {
  const p = (await db.query('SELECT id, status FROM persons WHERE id = $1', [personId])).rows[0];
  if (!p) fail('NOT_FOUND', 'person not found');
  if (p.status !== 'active') fail('CONFLICT', `person is ${p.status}`);
  return p;
}

export async function stripeCustomerOf(db, personId) {
  const r = await db.query("SELECT external_id FROM person_identities WHERE person_id = $1 AND platform = 'stripe' AND kind = 'customer' ORDER BY created_at LIMIT 1", [personId]);
  return r.rows[0]?.external_id || null;
}

/**
 * The person's Stripe customer, created once. Linked as identity
 * ('stripe', 'customer'). Concurrent calls share one idempotency key, so
 * Stripe returns the same customer and the second link is a no-op.
 */
export async function ensureCustomer({ pool, stripe }, person) {
  const personId = typeof person === 'string' ? person : person?.id;
  await activePerson(pool, personId);
  const existing = await stripeCustomerOf(pool, personId);
  if (existing) return { customerId: existing, created: false };
  const email = person?.email || (await identitiesOf(pool, personId)).find((i) => i.platform === 'email')?.external_id;
  const cus = await stripe.post('/v1/customers', {
    ...(email ? { email } : {}),
    ...(person?.name ? { name: person.name } : {}),
    metadata: { gaia_person_id: personId },
  }, { idempotencyKey: `gaia-customer-${personId}` });
  if (!cus?.id || !/^cus_/.test(cus.id)) fail('PROVIDER_UNAVAILABLE', 'stripe returned no customer id');
  if (cus.metadata?.gaia_person_id && cus.metadata.gaia_person_id !== personId) fail('CONFLICT', 'stripe customer belongs to another person');
  const r = await linkIdentity(pool, personId, { platform: 'stripe', kind: 'customer', externalId: cus.id },
    { linkedBy: 'stripe-adapter', verified: true, evidence: { livemode: stripe.livemode } });
  return { customerId: cus.id, created: r.linked };
}

async function priceRow(db, planVersionPriceId) {
  const r = (await db.query(
    `SELECT pvp.id, pvp.plan_version_id, pvp.billing_interval, pvp.amount_cents, pvp.currency,
            v.version, v.status AS version_status, v.is_legacy, p.key AS plan_key, p.name AS plan_name, p.owner_type
       FROM plan_version_prices pvp JOIN plan_versions v ON v.id = pvp.plan_version_id JOIN plans p ON p.id = v.plan_id
      WHERE pvp.id = $1`, [planVersionPriceId])).rows[0];
  if (!r) fail('NOT_FOUND', 'plan version price not found');
  return r;
}

async function existingRef(db, planVersionPriceId, livemode) {
  return (await db.query("SELECT external_price_id FROM provider_price_refs WHERE plan_version_price_id = $1 AND provider = 'stripe' AND livemode = $2",
    [planVersionPriceId, livemode])).rows[0]?.external_price_id || null;
}

function priceMatches(price, p) {
  const interval = p.billing_interval === 'none' ? null : p.billing_interval;
  return price.unit_amount === p.amount_cents
    && String(price.currency).toUpperCase() === p.currency
    && (price.recurring?.interval ?? null) === interval
    && (price.recurring ? (price.recurring.interval_count ?? 1) === 1 : true)
    && price.metadata?.gaia_plan_version_price_id === p.id;
}

async function ensureProduct(stripe, p) {
  const id = productIdFor(p.plan_key);
  try {
    return await stripe.get(`/v1/products/${id}`);
  } catch (e) {
    if (e.code !== 'NOT_FOUND') throw e;
  }
  return stripe.post('/v1/products', { id, name: `Gaia ${p.plan_name}`, metadata: { gaia_plan_key: p.plan_key } },
    { idempotencyKey: `gaia-product-${p.plan_key}` });
}

/**
 * A Stripe Price for one published plan-version price. Idempotent: an existing
 * ref is returned without any Stripe call; a Price found by its lookup key is
 * adopted only if it matches exactly (amount, currency, interval, metadata),
 * otherwise CONFLICT — never edited, never re-pointed.
 */
export async function ensureProductAndPrice({ pool, stripe }, planVersionPriceId) {
  const p = await priceRow(pool, planVersionPriceId);
  if (p.owner_type !== 'gaia') fail('FORBIDDEN', 'practitioner-owned plans are not billed through Gaia Stripe yet (D5)');
  if (p.version_status !== 'published') fail('PLAN_ARCHIVED', 'only a published plan version gets a Stripe price');
  if (p.is_legacy) fail('FORBIDDEN', 'legacy plan versions are never sold');
  if (p.amount_cents <= 0) fail('INVALID_INPUT', 'free prices are not billed through Stripe');

  const have = await existingRef(pool, p.id, stripe.livemode);
  if (have) return { priceId: have, created: false };

  const product = await ensureProduct(stripe, p);
  const lookupKey = lookupKeyFor(p);
  const found = (await stripe.get('/v1/prices', { 'lookup_keys[]': lookupKey, limit: 1 }))?.data?.[0];
  let price = found;
  let created = false;
  if (found) {
    if (!priceMatches(found, p)) fail('CONFLICT', 'a Stripe price with this lookup key exists but does not match the plan version', { lookupKey });
  } else {
    price = await stripe.post('/v1/prices', {
      product: product.id, currency: p.currency.toLowerCase(), unit_amount: p.amount_cents, lookup_key: lookupKey,
      ...(p.billing_interval === 'none' ? {} : { recurring: { interval: p.billing_interval, interval_count: 1 } }),
      metadata: { gaia_plan_key: p.plan_key, gaia_plan_version_id: p.plan_version_id, gaia_plan_version: String(p.version), gaia_plan_version_price_id: p.id },
    }, { idempotencyKey: `gaia-price-${p.id}` });
    if (!price?.id || !priceMatches(price, p)) fail('PROVIDER_UNAVAILABLE', 'stripe returned a price that does not match the request');
    created = true;
  }
  return withTransaction(pool, async (c) => {
    const ins = await c.query(
      `INSERT INTO provider_price_refs (plan_version_price_id, provider, external_price_id, livemode) VALUES ($1, 'stripe', $2, $3)
       ON CONFLICT DO NOTHING RETURNING id`, [p.id, price.id, stripe.livemode]);
    if (!ins.rowCount) {
      const winner = await existingRef(c, p.id, stripe.livemode);
      if (winner !== price.id) fail('CONFLICT', 'another Stripe price is already recorded for this plan version price');
      return { priceId: winner, created: false };
    }
    await audit(c, { ...ACTOR, action: 'provider_price.record', entityType: 'plan_version_price', entityId: p.id,
      after: { provider: 'stripe', priceId: price.id, livemode: stripe.livemode, adopted: !created } });
    return { priceId: price.id, created };
  });
}

/**
 * Hosted Checkout for a plan-version price. The plan version must be on sale
 * (published, not legacy); a person who already holds a live subscription on
 * the same plan is refused (upgrade/downgrade is a different flow).
 */
export async function createCheckoutSession({ pool, stripe }, personId, planVersionPriceId, { successUrl, cancelUrl, idempotencyKey } = {}) {
  checkKey(idempotencyKey);
  const success = checkUrl(successUrl, 'successUrl');
  const cancel = checkUrl(cancelUrl, 'cancelUrl');
  await activePerson(pool, personId);
  const p = await priceRow(pool, planVersionPriceId);
  const dup = (await pool.query(
    `SELECT s.id FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id
      WHERE s.person_id = $1 AND v.plan_id = (SELECT plan_id FROM plan_versions WHERE id = $2) AND s.status = ANY($3) LIMIT 1`,
    [personId, p.plan_version_id, LIVE_SUB_STATUSES])).rows[0];
  if (dup) fail('CONFLICT', 'person already holds this plan', { subscriptionId: dup.id });
  const { priceId } = await ensureProductAndPrice({ pool, stripe }, planVersionPriceId);
  const { customerId } = await ensureCustomer({ pool, stripe }, personId);
  const metadata = { gaia_person_id: personId, gaia_plan_version_id: p.plan_version_id, gaia_plan_version_price_id: p.id };
  const recurring = p.billing_interval !== 'none';
  const s = await stripe.post('/v1/checkout/sessions', {
    mode: recurring ? 'subscription' : 'payment',
    customer: customerId,
    client_reference_id: personId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: success,
    cancel_url: cancel,
    metadata,
    ...(recurring ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
  }, { idempotencyKey: `gaia-checkout-${idempotencyKey}` });
  if (!s?.id || !s.url) fail('PROVIDER_UNAVAILABLE', 'stripe returned no checkout session');
  return { sessionId: s.id, url: s.url, expiresAt: s.expires_at ? new Date(s.expires_at * 1000) : null, customerId, priceId };
}

/**
 * One-time Checkout for a coin pack. Only an `active` coin package can be sold
 * (the v2.5 packs seed as drafts: their prices are "indicative"). Coins are
 * credited by the webhook path, never here.
 */
export async function createCoinPackCheckout({ pool, stripe }, personId, packageKey, { successUrl, cancelUrl, idempotencyKey } = {}) {
  checkKey(idempotencyKey);
  const success = checkUrl(successUrl, 'successUrl');
  const cancel = checkUrl(cancelUrl, 'cancelUrl');
  await activePerson(pool, personId);
  const pack = (await pool.query('SELECT * FROM coin_packages WHERE key = $1', [packageKey])).rows[0];
  if (!pack) fail('NOT_FOUND', 'coin package not found');
  if (pack.status !== 'active') fail('PLAN_ARCHIVED', `coin package is ${pack.status}, not on sale`);
  const { customerId } = await ensureCustomer({ pool, stripe }, personId);
  const coins = pack.coins + pack.bonus_coins;
  const metadata = { gaia_person_id: personId, gaia_coin_package_id: pack.id, gaia_coin_package_key: pack.key, gaia_coins: String(coins) };
  const s = await stripe.post('/v1/checkout/sessions', {
    mode: 'payment',
    customer: customerId,
    client_reference_id: personId,
    line_items: [{ quantity: 1, price_data: { currency: pack.currency.toLowerCase(), unit_amount: pack.price_cents, product_data: { name: `Gaia coins: ${coins}`, metadata: { gaia_coin_package_key: pack.key } } } }],
    success_url: success,
    cancel_url: cancel,
    metadata,
    payment_intent_data: { metadata },
  }, { idempotencyKey: `gaia-coinpack-${idempotencyKey}` });
  if (!s?.id || !s.url) fail('PROVIDER_UNAVAILABLE', 'stripe returned no checkout session');
  return { sessionId: s.id, url: s.url, coins, amountCents: pack.price_cents, customerId };
}

/**
 * Click-to-cancel on Stripe: cancel_at_period_end, then record the scheduled
 * end locally (access continues until then). The webhook that follows is
 * applied by handlers.js and is consistent with this.
 */
export async function cancelAtPeriodEnd({ pool, stripe }, subscriptionId, { idempotencyKey, actor = ACTOR } = {}) {
  const s = (await pool.query('SELECT id, status, provider, provider_subscription_id FROM subscriptions WHERE id = $1', [subscriptionId])).rows[0];
  if (!s) fail('NOT_FOUND', 'subscription not found');
  if (s.provider !== 'stripe') fail('CONFLICT', 'not a Stripe subscription');
  if (s.status === 'canceled' || s.status === 'expired') fail('CONFLICT', 'subscription already ended');
  const r = await stripe.post(`/v1/subscriptions/${encodeURIComponent(s.provider_subscription_id)}`, { cancel_at_period_end: true },
    { idempotencyKey: idempotencyKey ? checkKey(idempotencyKey) : `gaia-cancel-${s.id}` });
  if (r?.id !== s.provider_subscription_id) fail('PROVIDER_UNAVAILABLE', 'stripe answered for a different subscription');
  const endSec = r.cancel_at ?? r.items?.data?.[0]?.current_period_end ?? r.current_period_end;
  if (!endSec) fail('PROVIDER_UNAVAILABLE', 'stripe did not report the access end date');
  const accessEndsAt = new Date(endSec * 1000);
  await scheduleCancel(pool, s.id, { accessEndsAt }, actor);
  return { accessEndsAt, cancelAtPeriodEnd: r.cancel_at_period_end === true };
}
