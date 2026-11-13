/**
 * Plans and immutable plan versions (spec §10, §11, §17).
 *
 * A price or benefit change is never an edit: it is a new draft version that is
 * then published. Existing subscriptions keep pointing at the version they
 * bought (grandfathering); the database refuses changes to published rows.
 */
import { withTransaction } from './db.js';
import { audit } from './audit.js';
import { fail } from './errors.js';
import { ENTITLEMENTS, TIERS, COIN_PACKAGES } from './catalog.js';

const INTERVALS = new Set(['none', 'month', 'year']);

export async function ensureEntitlementDefinitions(c, defs = ENTITLEMENTS) {
  for (const [key, kind, description] of defs) {
    await c.query(
      'INSERT INTO entitlement_definitions (key, kind, description) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING',
      [key, kind, description]);
  }
}

export async function createPlan(pool, { key, name, ownerType = 'gaia', practitionerId = null, rank = 0 }, actor) {
  return withTransaction(pool, async (c) => {
    const r = await c.query(
      `INSERT INTO plans (key, name, owner_type, practitioner_id, rank) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO NOTHING RETURNING id`, [key, name, ownerType, practitionerId, rank]);
    if (!r.rowCount) fail('CONFLICT', 'plan key already exists');
    await audit(c, { ...actor, action: 'plan.create', entityType: 'plan', entityId: r.rows[0].id, after: { key, name, ownerType, rank } });
    return r.rows[0].id;
  });
}

export async function createDraftVersion(pool, planId, { prices, entitlements = {}, monthlyCoinGrant = 0, terms = {}, isLegacy = false }, actor) {
  if (!prices || !Object.keys(prices).length) fail('INVALID_INPUT', 'a version needs at least one price');
  for (const [interval, cents] of Object.entries(prices)) {
    if (!INTERVALS.has(interval)) fail('INVALID_INPUT', 'unknown billing interval ' + interval);
    if (!Number.isSafeInteger(cents) || cents < 0) fail('INVALID_INPUT', 'prices are non-negative integer cents');
  }
  if (!Number.isSafeInteger(monthlyCoinGrant) || monthlyCoinGrant < 0) fail('INVALID_INPUT', 'monthlyCoinGrant must be a non-negative integer');
  return withTransaction(pool, async (c) => {
    const plan = (await c.query('SELECT id, status FROM plans WHERE id = $1 FOR UPDATE', [planId])).rows[0];
    if (!plan) fail('NOT_FOUND', 'plan not found');
    if (plan.status === 'archived') fail('PLAN_ARCHIVED', 'plan is archived');
    const next = (await c.query('SELECT COALESCE(max(version), 0) + 1 AS v FROM plan_versions WHERE plan_id = $1', [planId])).rows[0].v;
    const v = (await c.query(
      `INSERT INTO plan_versions (plan_id, version, is_legacy, monthly_coin_grant, terms) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [planId, next, isLegacy, monthlyCoinGrant, JSON.stringify(terms)])).rows[0];
    for (const [interval, cents] of Object.entries(prices)) {
      await c.query('INSERT INTO plan_version_prices (plan_version_id, billing_interval, amount_cents) VALUES ($1, $2, $3)', [v.id, interval, cents]);
    }
    for (const [key, value] of Object.entries(entitlements)) {
      await c.query('INSERT INTO plan_version_entitlements (plan_version_id, entitlement_key, value) VALUES ($1, $2, $3)', [v.id, key, JSON.stringify(value)]);
    }
    await audit(c, { ...actor, action: 'plan_version.draft', entityType: 'plan_version', entityId: v.id, after: { planId, version: next, prices, monthlyCoinGrant, isLegacy } });
    return { id: v.id, version: next };
  });
}

export async function publishVersion(pool, versionId, actor, { now = new Date() } = {}) {
  return withTransaction(pool, async (c) => {
    const v = (await c.query('SELECT id, status FROM plan_versions WHERE id = $1 FOR UPDATE', [versionId])).rows[0];
    if (!v) fail('NOT_FOUND', 'plan version not found');
    if (v.status !== 'draft') fail('CONFLICT', 'only a draft can be published');
    await c.query("UPDATE plan_versions SET status = 'published', published_at = $2 WHERE id = $1", [versionId, now]);
    await audit(c, { ...actor, action: 'plan_version.publish', entityType: 'plan_version', entityId: versionId });
  });
}

/** Stop selling a version. Subscribers on it keep it (grandfathered). */
export async function retireVersion(pool, versionId, actor, { now = new Date() } = {}) {
  return withTransaction(pool, async (c) => {
    const r = await c.query("UPDATE plan_versions SET status = 'retired', retired_at = $2 WHERE id = $1 AND status = 'published' RETURNING id", [versionId, now]);
    if (!r.rowCount) fail('CONFLICT', 'only a published version can be retired');
    await audit(c, { ...actor, action: 'plan_version.retire', entityType: 'plan_version', entityId: versionId });
  });
}

/** The version currently on sale for a plan: newest published, non-legacy. */
export async function currentVersion(db, planKey) {
  const r = await db.query(
    `SELECT v.id, v.version, v.monthly_coin_grant FROM plan_versions v JOIN plans p ON p.id = v.plan_id
      WHERE p.key = $1 AND p.status = 'active' AND v.status = 'published' AND NOT v.is_legacy
      ORDER BY v.version DESC LIMIT 1`, [planKey]);
  return r.rows[0] || null;
}

export async function versionDetails(db, versionId) {
  const v = (await db.query(
    `SELECT v.*, p.key AS plan_key, p.name AS plan_name, p.rank FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE v.id = $1`, [versionId])).rows[0];
  if (!v) return null;
  const prices = Object.fromEntries((await db.query('SELECT billing_interval, amount_cents FROM plan_version_prices WHERE plan_version_id = $1', [versionId])).rows.map((r) => [r.billing_interval, r.amount_cents]));
  const entitlements = Object.fromEntries((await db.query('SELECT entitlement_key, value FROM plan_version_entitlements WHERE plan_version_id = $1', [versionId])).rows.map((r) => [r.entitlement_key, r.value]));
  return { ...v, prices, entitlements };
}

/** Seed version 1 of the four v2.5 tiers and the (draft) coin packs. Safe to run repeatedly. */
export async function seedCatalog(pool, actor = { actorType: 'system', actorId: 'seed' }) {
  await withTransaction(pool, (c) => ensureEntitlementDefinitions(c));
  const created = [];
  for (const t of TIERS) {
    const exists = (await pool.query('SELECT id FROM plans WHERE key = $1', [t.key])).rows[0];
    if (exists) continue;
    const planId = await createPlan(pool, { key: t.key, name: t.name, rank: t.rank }, actor);
    const v = await createDraftVersion(pool, planId, { prices: t.prices, entitlements: t.entitlements, monthlyCoinGrant: t.coins, terms: { spec: 'v2.5' } }, actor);
    await publishVersion(pool, v.id, actor);
    created.push(t.key);
  }
  for (const p of COIN_PACKAGES) {
    await pool.query('INSERT INTO coin_packages (key, coins, price_cents) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING', [p.key, p.coins, p.priceCents]);
  }
  return created;
}
