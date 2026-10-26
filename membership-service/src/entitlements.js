/**
 * Entitlement evaluation (spec §16, §17).
 *
 * Effective benefits = union of (a) every subscription that grants access now
 * and (b) active entitlement_grants. A person holding several plans (e.g. a
 * Gaia plan and a practitioner plan) gets each benefit ONCE: booleans merge,
 * numbers take the maximum, never a sum. Monthly coin allowances are NOT
 * entitlements; they are wallet grants (coins.js), so they cannot stack here.
 *
 * computeEntitlements() is pure (tested without a database); evaluate() loads
 * the rows.
 */
import { grantsAccess } from './subscriptions.js';

function merge(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
  if (a === true || b === true) return a === true && typeof b === 'number' ? b : (typeof a === 'number' ? a : true);
  return b ?? a;
}

export function computeEntitlements({ subscriptions = [], grants = [] }, now = new Date()) {
  const out = new Map();
  const add = (key, value, source) => {
    const cur = out.get(key);
    out.set(key, cur ? { value: merge(cur.value, value), sources: [...cur.sources, source] } : { value, sources: [source] });
  };
  const plans = [];
  for (const s of subscriptions) {
    if (!grantsAccess(s, now)) continue;
    plans.push({ subscriptionId: s.id, planKey: s.plan_key, status: s.status, accessUntil: s.status === 'past_due' ? s.grace_until : (s.cancel_at || s.current_period_end || null) });
    for (const [key, value] of Object.entries(s.entitlements || {})) add(key, value, { type: 'subscription', id: s.id, plan: s.plan_key });
  }
  const t = now.getTime();
  for (const g of grants) {
    if (g.revoked_at || new Date(g.starts_at).getTime() > t || (g.ends_at && new Date(g.ends_at).getTime() <= t)) continue;
    add(g.entitlement_key, g.value, { type: 'grant', id: g.id, source: g.source });
  }
  return { entitlements: Object.fromEntries(out), plans };
}

export async function loadEntitlementInputs(db, personId) {
  const subscriptions = (await db.query(
    `SELECT s.*, p.key AS plan_key,
            COALESCE((SELECT jsonb_object_agg(e.entitlement_key, e.value) FROM plan_version_entitlements e WHERE e.plan_version_id = s.plan_version_id), '{}'::jsonb) AS entitlements
       FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
      WHERE s.person_id = $1 AND s.status NOT IN ('canceled', 'expired')`, [personId])).rows;
  const grants = (await db.query('SELECT * FROM entitlement_grants WHERE person_id = $1 AND revoked_at IS NULL', [personId])).rows;
  return { subscriptions, grants };
}

export async function evaluate(db, personId, now = new Date()) {
  return computeEntitlements(await loadEntitlementInputs(db, personId), now);
}

export async function hasEntitlement(db, personId, key, now = new Date()) {
  const { entitlements } = await evaluate(db, personId, now);
  return Boolean(entitlements[key]);
}
