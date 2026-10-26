/**
 * Member-facing routes for the Gaia Healers proxy (the member gateway).
 *
 * Only a PLATFORM client with member:read / member:write may call these; the
 * proxy has already authenticated the member from their session and passes
 * the person id it resolved through /v1/identities/ensure. Every write goes
 * through the same guards as everywhere else: duplicate-billing guard, launch
 * flag, idempotency, audit. Stripe is called only by checkout / cancel, and only
 * when this process was given a Stripe client.
 *
 *   POST /v1/identities/ensure                          identity:write
 *   GET  /v1/catalog/plans                              member:read
 *   GET  /v1/persons/:id/overview                       member:read
 *   GET  /v1/persons/:id/coin-history?limit=            member:read
 *   GET  /v1/persons/:id/billing-history?limit=         member:read
 *   POST /v1/persons/:id/checkout            (+Idempotency-Key)  member:write
 *   POST /v1/persons/:id/coin-checkout       (+Idempotency-Key)  member:write
 *   POST /v1/persons/:id/subscriptions/:sid/cancel-preview       member:read
 *   POST /v1/persons/:id/subscriptions/:sid/cancel  (+Idempotency-Key) member:write
 *   POST /v1/persons/:id/migration-offers/:oid/accept            member:write
 *   POST /v1/persons/:id/migration-offers/:oid/checkout (+Idempotency-Key) member:write
 */
import { fail } from '../errors.js';
import { requireScope, assertPersonVisible } from '../access.js';
import { resolveOrCreatePerson, linkIdentity, findPerson } from '../identity.js';
import { evaluate, isEntitled } from '../entitlements.js';
import { walletView } from '../coins.js';
import { grantsAccess, cancelPreview } from '../subscriptions.js';
import { legacyRowsFor, legacyBlock } from '../billing-guard.js';
import { acceptOffer } from '../migration-offers.js';
import { launchState, newBillingAllowed } from '../launch.js';
import { nextCycleStart } from '../jobs/allowance.js';
import { createCheckoutSession, createCoinPackCheckout, createMigrationCheckoutSession, cancelAtPeriodEnd } from '../providers/stripe/adapter.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const R = (re) => new RegExp(`^${re.replace(/:uuid/g, `(${UUID})`)}$`);
const ROUTES = {
  overview: R('/v1/persons/:uuid/overview'),
  coins: R('/v1/persons/:uuid/coin-history'),
  billing: R('/v1/persons/:uuid/billing-history'),
  checkout: R('/v1/persons/:uuid/checkout'),
  coinCheckout: R('/v1/persons/:uuid/coin-checkout'),
  cancelPreview: R('/v1/persons/:uuid/subscriptions/:uuid/cancel-preview'),
  cancel: R('/v1/persons/:uuid/subscriptions/:uuid/cancel'),
  offerAccept: R('/v1/persons/:uuid/migration-offers/:uuid/accept'),
  offerCheckout: R('/v1/persons/:uuid/migration-offers/:uuid/checkout'),
};

/** Return URLs must be on an allowed origin (no open redirect via Stripe). */
export function checkReturnUrl(u, env) {
  const allowed = String(env.MEMBERSHIP2_RETURN_ORIGINS || 'https://gaiahealers.app').split(',').map((s) => s.trim()).filter(Boolean);
  let parsed;
  try { parsed = new URL(u); } catch { fail('INVALID_INPUT', 'return URL is not valid'); }
  if (!allowed.includes(parsed.origin)) fail('INVALID_INPUT', 'return URL is not on an allowed origin');
  return parsed.toString();
}

const platformOnly = (client) => { if (client.practitioner_id) fail('FORBIDDEN', 'platform clients only'); };
const limitOf = (url) => Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);

/** Member-safe view of a legacy membership (no provider ids, no review internals). */
function legacyView(row) {
  const b = legacyBlock(row);
  return {
    id: row.id, tier: row.tier, provider: row.payment_provider, status: row.reported_status, paidThrough: row.paid_through_estimate,
    state: !b ? 'ended' : (b.kind === 'migration_required' ? 'active' : 'under_review'),
  };
}

async function ownSubscription(db, personId, subId) {
  const s = (await db.query('SELECT id FROM subscriptions WHERE id = $1 AND person_id = $2', [subId, personId])).rows[0];
  if (!s) fail('NOT_FOUND', 'subscription not found');
}

/**
 * Returns [status, body] when the route is a member route, or null.
 * ctx: { pool, client, actor, req, url, now, stripe, env, readJson, idempotencyKey }
 */
export async function memberRoute(ctx) {
  const { pool, client, actor, req, url, now, stripe, env, readJson, idempotencyKey } = ctx;
  const p = url.pathname; let m;
  const needStripe = () => { if (!stripe) fail('PROVIDER_UNAVAILABLE', 'billing is not connected in this environment'); return stripe; };
  const person = async (id) => { platformOnly(client); await assertPersonVisible(pool, client, id); return id; };

  if (req.method === 'POST' && p === '/v1/identities/ensure') {
    requireScope(client, 'identity:write'); platformOnly(client);
    const b = await readJson(req);
    if (!b.contactId && !b.email) fail('INVALID_INPUT', 'contactId or email is required');
    const primary = b.contactId ? { platform: 'ghl', kind: 'contact', externalId: String(b.contactId) } : { platform: 'email', kind: 'address', externalId: String(b.email) };
    const { personId, created } = await resolveOrCreatePerson(pool, primary, { linkedBy: actor.actorId });
    if (b.contactId && b.email) {
      const byEmail = await findPerson(pool, { platform: 'email', kind: 'address', externalId: String(b.email) });
      if (!byEmail) await linkIdentity(pool, personId, { platform: 'email', kind: 'address', externalId: String(b.email) }, { linkedBy: actor.actorId }).catch((e) => { if (e.code !== 'CONFLICT') throw e; });
    }
    return [created ? 201 : 200, { ok: true, personId, created }];
  }

  if (req.method === 'GET' && p === '/v1/catalog/plans') {
    requireScope(client, 'member:read');
    const rows = (await pool.query(
      `SELECT p.key, p.name, p.rank, v.id AS version_id, v.monthly_coin_grant,
              COALESCE((SELECT jsonb_object_agg(billing_interval, amount_cents) FROM plan_version_prices WHERE plan_version_id = v.id), '{}') AS prices,
              COALESCE((SELECT jsonb_agg(e.entitlement_key ORDER BY e.entitlement_key) FROM plan_version_entitlements e WHERE e.plan_version_id = v.id AND e.value <> 'false'::jsonb), '[]') AS benefits
         FROM plans p JOIN LATERAL (SELECT * FROM plan_versions WHERE plan_id = p.id AND status = 'published' AND NOT is_legacy ORDER BY version DESC LIMIT 1) v ON true
        WHERE p.owner_type = 'gaia' AND p.status = 'active' ORDER BY p.rank`)).rows;
    const defs = Object.fromEntries((await pool.query('SELECT key, description FROM entitlement_definitions WHERE owner_practitioner_id IS NULL')).rows.map((r) => [r.key, r.description]));
    const packs = (await pool.query("SELECT key, coins, bonus_coins, price_cents, currency FROM coin_packages WHERE status = 'active' ORDER BY coins")).rows;
    return [200, { ok: true, currency: 'USD', plans: rows.map((r) => ({ key: r.key, name: r.name, rank: r.rank, monthlyCoins: r.monthly_coin_grant, prices: r.prices,
      benefits: r.benefits.map((k) => ({ key: k, label: defs[k] || k })) })), coinPacks: packs }];
  }

  if (req.method === 'GET' && (m = ROUTES.overview.exec(p))) {
    requireScope(client, 'member:read'); const id = await person(m[1]);
    const subs = (await pool.query(
      `SELECT s.id, p.key AS plan_key, p.name AS plan_name, s.billing_interval, s.status, s.provider, s.source, s.trial_end, s.current_period_start, s.current_period_end,
              s.grace_until, s.cancel_at, s.canceled_at, s.ended_at, s.created_at
         FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
        WHERE s.person_id = $1 AND p.owner_type = 'gaia' ORDER BY s.created_at DESC`, [id])).rows;
    const ent = await evaluate(pool, id, now);
    const live = subs.find((s) => grantsAccess(s, now));
    const wallet = await walletView(pool, id, { nextGrantAt: live ? nextCycleStart(live.current_period_start || live.created_at, now) : null });
    const legacy = (await legacyRowsFor(pool, id)).map(legacyView);
    const offers = (await pool.query(`SELECT o.id, o.status, o.target_interval, o.billing_starts_at, p.key AS target_plan, l.tier AS from_tier
                                        FROM migration_offers o JOIN plan_versions v ON v.id = o.target_plan_version_id JOIN plans p ON p.id = v.plan_id
                                        JOIN legacy_memberships l ON l.id = o.legacy_membership_id
                                       WHERE o.person_id = $1 AND o.status NOT IN ('withdrawn', 'declined') ORDER BY o.offered_at DESC`, [id])).rows;
    const launch = await launchState(pool, { env });
    const canBuy = await newBillingAllowed(pool, id, { env, purpose: 'subscription' });
    const canBuyCoins = await newBillingAllowed(pool, id, { env, purpose: 'coins' });
    return [200, { ok: true,
      membership: subs.map((s) => ({ ...s, hasAccess: grantsAccess(s, now) })),
      access: Object.entries(ent.entitlements).filter(([, v]) => isEntitled(v)).map(([k, v]) => ({ key: k, value: v.value })),
      wallet, legacy, migrationOffers: offers,
      availability: { stage: launch.effective, newMembership: canBuy.allowed, newMembershipReason: canBuy.reason, coinPacks: canBuyCoins.allowed, coinPacksReason: canBuyCoins.reason } }];
  }

  if (req.method === 'GET' && (m = ROUTES.coins.exec(p))) {
    requireScope(client, 'member:read'); const id = await person(m[1]);
    const rows = (await pool.query(
      `SELECT o.id, o.kind, o.reason, o.status, o.coins, o.created_at, o.settled_at,
              COALESCE((SELECT jsonb_object_agg(balance_type, s) FROM (SELECT balance_type, sum(delta_coins) s FROM coin_transactions WHERE operation_id = o.id GROUP BY 1) x), '{}') AS net
         FROM coin_operations o JOIN coin_wallets w ON w.id = o.wallet_id
        WHERE w.person_id = $1 AND NOT (o.kind = 'debit' AND o.status IN ('held', 'released'))
        ORDER BY o.created_at DESC LIMIT $2`, [id, limitOf(url)])).rows;
    return [200, { ok: true, items: rows.map((r) => ({ id: r.id, kind: r.kind, reason: r.reason, coins: r.coins, at: r.settled_at || r.created_at, byBalance: r.net })) }];
  }

  if (req.method === 'GET' && (m = ROUTES.billing.exec(p))) {
    requireScope(client, 'member:read'); const id = await person(m[1]);
    const rows = (await pool.query(
      `SELECT l.id, l.entry_type, l.amount_cents, l.currency, l.occurred_at, l.provider, l.provider_object_type, l.provider_object_id,
              p.key AS plan_key, (l.coin_operation_id IS NOT NULL) AS coin_pack
         FROM payment_ledger l LEFT JOIN subscriptions s ON s.id = l.subscription_id LEFT JOIN plan_versions v ON v.id = s.plan_version_id LEFT JOIN plans p ON p.id = v.plan_id
        WHERE l.person_id = $1 ORDER BY l.occurred_at DESC LIMIT $2`, [id, limitOf(url)])).rows;
    return [200, { ok: true, items: rows.map((r) => ({ id: r.id, type: r.entry_type, amountCents: r.amount_cents, currency: r.currency, at: r.occurred_at,
      what: r.coin_pack ? 'coin_pack' : (r.plan_key ? `membership:${r.plan_key}` : r.provider_object_type), provider: r.provider,
      invoiceRef: r.provider_object_type === 'invoice' ? r.provider_object_id : null })) }];
  }

  if (req.method === 'POST' && (m = ROUTES.checkout.exec(p))) {
    requireScope(client, 'member:write'); const id = await person(m[1]);
    const key = idempotencyKey(req); const b = await readJson(req);
    if (!['month', 'year'].includes(b.interval)) fail('INVALID_INPUT', 'interval must be month or year');
    const price = (await pool.query(
      `SELECT pvp.id FROM plans p JOIN LATERAL (SELECT * FROM plan_versions WHERE plan_id = p.id AND status = 'published' AND NOT is_legacy ORDER BY version DESC LIMIT 1) v ON true
         JOIN plan_version_prices pvp ON pvp.plan_version_id = v.id AND pvp.billing_interval = $2
        WHERE p.key = $1 AND p.owner_type = 'gaia' AND p.status = 'active'`, [String(b.planKey || ''), b.interval])).rows[0];
    if (!price) fail('NOT_FOUND', 'plan not on sale');
    const r = await createCheckoutSession({ pool, stripe: needStripe(), env }, id, price.id,
      { successUrl: checkReturnUrl(b.successUrl, env), cancelUrl: checkReturnUrl(b.cancelUrl, env), idempotencyKey: key, now });
    return [r.status === 'ok' ? 201 : 200, { ok: r.status === 'ok', ...r }];
  }

  if (req.method === 'POST' && (m = ROUTES.coinCheckout.exec(p))) {
    requireScope(client, 'member:write'); const id = await person(m[1]);
    const key = idempotencyKey(req); const b = await readJson(req);
    const r = await createCoinPackCheckout({ pool, stripe: needStripe(), env }, id, String(b.packKey || ''),
      { successUrl: checkReturnUrl(b.successUrl, env), cancelUrl: checkReturnUrl(b.cancelUrl, env), idempotencyKey: key });
    return [r.status === 'ok' ? 201 : 200, { ok: r.status === 'ok', ...r }];
  }

  if (req.method === 'POST' && (m = ROUTES.cancelPreview.exec(p))) {
    requireScope(client, 'member:read'); const id = await person(m[1]); await ownSubscription(pool, id, m[2]);
    return [200, { ok: true, ...(await cancelPreview(pool, m[2])) }];
  }

  if (req.method === 'POST' && (m = ROUTES.cancel.exec(p))) {
    requireScope(client, 'member:write'); const id = await person(m[1]); await ownSubscription(pool, id, m[2]);
    const key = idempotencyKey(req);
    const r = await cancelAtPeriodEnd({ pool, stripe: needStripe() }, m[2], { idempotencyKey: key, actor: { actorType: 'person', actorId: id, requestId: actor.requestId } });
    return [200, { ok: true, ...r }];
  }

  if (req.method === 'POST' && (m = ROUTES.offerAccept.exec(p))) {
    requireScope(client, 'member:write'); const id = await person(m[1]);
    const r = await acceptOffer(pool, m[2], id);
    return [200, { ok: true, status: r.offer.status, replayed: r.replayed }];
  }

  if (req.method === 'POST' && (m = ROUTES.offerCheckout.exec(p))) {
    requireScope(client, 'member:write'); const id = await person(m[1]);
    const o = (await pool.query('SELECT person_id FROM migration_offers WHERE id = $1', [m[2]])).rows[0];
    if (!o || o.person_id !== id) fail('NOT_FOUND', 'offer not found');
    const key = idempotencyKey(req); const b = await readJson(req);
    const r = await createMigrationCheckoutSession({ pool, stripe: needStripe(), env }, m[2],
      { successUrl: checkReturnUrl(b.successUrl, env), cancelUrl: checkReturnUrl(b.cancelUrl, env), idempotencyKey: key, now });
    return [r.status === 'ok' ? 201 : 200, { ok: r.status === 'ok', ...r }];
  }
  return null;
}
