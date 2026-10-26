/**
 * Membership 2.0 launch gate (server-enforced feature flag).
 *
 *   OFF                    nothing new is sold to anyone (default, production)
 *   INTERNAL_PILOT         only people on the pilot list
 *   LIMITED_NEW_CUSTOMERS  pilot list + up to `limited_cap` NEW customers
 *   ALL_NEW_CUSTOMERS      every NEW customer
 *
 * "New customer" = no live or under-review legacy GHL membership and no Gaia
 * Healers subscription yet; legacy members only ever move through the
 * controlled migration flow (migration-offers.js), whatever the stage.
 *
 * Effective stage = the LOWER of the stored stage (changed only by an admin,
 * audited, with an approval reference above INTERNAL_PILOT) and the
 * environment ceiling MEMBERSHIP2_STAGE_CEILING, which defaults to OFF: a
 * deployment, a migration or a restart can never switch billing on.
 * The gate fails closed: any error means OFF.
 */
import { withTransaction } from './db.js';
import { audit } from './audit.js';
import { fail } from './errors.js';
import { legacyRowsFor, legacyBlock } from './billing-guard.js';

export const STAGES = Object.freeze(['OFF', 'INTERNAL_PILOT', 'LIMITED_NEW_CUSTOMERS', 'ALL_NEW_CUSTOMERS']);
const rank = (s) => STAGES.indexOf(s);

export function ceilingFromEnv(env = process.env) {
  const c = String(env.MEMBERSHIP2_STAGE_CEILING || 'OFF').trim().toUpperCase();
  return STAGES.includes(c) ? c : 'OFF';
}

export async function launchState(db, { env = process.env } = {}) {
  try {
    const row = (await db.query('SELECT * FROM launch_state WHERE id')).rows[0];
    const stored = row?.stage && STAGES.includes(row.stage) ? row.stage : 'OFF';
    const ceiling = ceilingFromEnv(env);
    const effective = STAGES[Math.min(rank(stored), rank(ceiling))];
    return { stored, ceiling, effective, limitedCap: row?.limited_cap ?? 0, changedAt: row?.changed_at ?? null, changedBy: row?.changed_by ?? null, approvalRef: row?.approval_ref ?? null };
  } catch {
    return { stored: 'OFF', ceiling: 'OFF', effective: 'OFF', limitedCap: 0, error: 'state_unreadable' };
  }
}

/** Change the stored stage. Above INTERNAL_PILOT an approval reference (the GO decision) is mandatory. */
export async function setLaunchStage(pool, { stage, limitedCap, reason, approvalRef = null }, actor) {
  if (!STAGES.includes(stage)) fail('INVALID_INPUT', 'unknown stage');
  if (!actor?.actorId || actor.actorType !== 'admin') fail('FORBIDDEN', 'only an admin can change the launch stage');
  if (typeof reason !== 'string' || reason.trim().length < 10) fail('INVALID_INPUT', 'a written reason (10+ characters) is required');
  if (rank(stage) > rank('INTERNAL_PILOT') && !(approvalRef && String(approvalRef).trim().length >= 3)) fail('FORBIDDEN', 'stages above INTERNAL_PILOT need the GO approval reference');
  return withTransaction(pool, async (c) => {
    const cur = (await c.query('SELECT * FROM launch_state WHERE id FOR UPDATE')).rows[0];
    const cap = limitedCap === undefined ? cur.limited_cap : limitedCap;
    if (!Number.isInteger(cap) || cap < 0) fail('INVALID_INPUT', 'limitedCap must be a non-negative integer');
    await c.query('UPDATE launch_state SET stage = $1, limited_cap = $2, changed_by = $3, approval_ref = $4, reason = $5, changed_at = now() WHERE id',
      [stage, cap, actor.actorId, approvalRef, reason.trim()]);
    await c.query('INSERT INTO launch_history (from_stage, to_stage, limited_cap, changed_by, approval_ref, reason) VALUES ($1, $2, $3, $4, $5, $6)',
      [cur.stage, stage, cap, actor.actorId, approvalRef, reason.trim()]);
    await audit(c, { ...actor, action: 'launch.stage', entityType: 'launch_state', entityId: 'membership2', before: { stage: cur.stage, limitedCap: cur.limited_cap }, after: { stage, limitedCap: cap, approvalRef } });
    return { from: cur.stage, to: stage, limitedCap: cap };
  });
}

export async function addPilotMember(pool, personId, { note = null } = {}, actor) {
  if (actor?.actorType !== 'admin') fail('FORBIDDEN', 'only an admin can add pilot members');
  return withTransaction(pool, async (c) => {
    await c.query(`INSERT INTO pilot_members (person_id, added_by, note) VALUES ($1, $2, $3)
                   ON CONFLICT (person_id) DO UPDATE SET removed_at = NULL, removed_by = NULL, added_by = EXCLUDED.added_by, added_at = now(), note = EXCLUDED.note`, [personId, actor.actorId, note]);
    await audit(c, { ...actor, action: 'launch.pilot_add', entityType: 'person', entityId: personId });
  });
}

export async function removePilotMember(pool, personId, actor) {
  if (actor?.actorType !== 'admin') fail('FORBIDDEN', 'only an admin can remove pilot members');
  return withTransaction(pool, async (c) => {
    await c.query('UPDATE pilot_members SET removed_at = now(), removed_by = $2 WHERE person_id = $1 AND removed_at IS NULL', [personId, actor.actorId]);
    await audit(c, { ...actor, action: 'launch.pilot_remove', entityType: 'person', entityId: personId });
  });
}

/**
 * May this person start NEW Membership 2.0 billing (checkout / coin pack / plan change) right now? Fails closed.
 * purpose: 'subscription' | 'coins' | 'plan_change' (an existing Membership 2.0 subscription moves to another plan).
 */
export async function newBillingAllowed(db, personId, { env = process.env, purpose = 'subscription' } = {}) {
  try {
    const st = await launchState(db, { env });
    if (st.effective === 'OFF') return { allowed: false, reason: 'membership2_off', stage: st.effective };
    const pilot = (await db.query('SELECT 1 FROM pilot_members WHERE person_id = $1 AND removed_at IS NULL', [personId])).rowCount > 0;
    if (pilot) return { allowed: true, reason: 'pilot_member', stage: st.effective };
    if (st.effective === 'INTERNAL_PILOT') return { allowed: false, reason: 'pilot_only', stage: st.effective };
    // Beyond the pilot, only NEW customers. Legacy members go through the controlled migration flow.
    const legacy = (await legacyRowsFor(db, personId)).map(legacyBlock).filter(Boolean);
    if (legacy.length) return { allowed: false, reason: 'legacy_member_use_migration', stage: st.effective };
    const hasSub = (await db.query(`SELECT 1 FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
                                     WHERE s.person_id = $1 AND p.owner_type = 'gaia' LIMIT 1`, [personId])).rowCount > 0;
    // A plan change moves an existing Membership 2.0 subscription; it is not a new customer, so the LIMITED cap does not apply.
    if (purpose === 'plan_change') return hasSub ? { allowed: true, reason: 'membership2_customer', stage: st.effective } : { allowed: false, reason: 'no_subscription', stage: st.effective };
    if (purpose === 'subscription' && hasSub) return { allowed: false, reason: 'existing_customer', stage: st.effective };
    if (purpose === 'coins' && !hasSub) return { allowed: false, reason: 'coins_need_membership2', stage: st.effective };
    if (purpose === 'coins') return { allowed: true, reason: 'membership2_customer', stage: st.effective };
    if (st.effective === 'LIMITED_NEW_CUSTOMERS') {
      const used = (await db.query(`SELECT count(DISTINCT s.person_id)::int n FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
                                     WHERE p.owner_type = 'gaia' AND s.provider = 'stripe' AND s.source = 'new'
                                       AND s.person_id NOT IN (SELECT person_id FROM pilot_members)`)).rows[0].n;
      if (used >= st.limitedCap) return { allowed: false, reason: 'limited_cap_reached', stage: st.effective };
    }
    return { allowed: true, reason: 'new_customer', stage: st.effective };
  } catch {
    return { allowed: false, reason: 'gate_error', stage: 'OFF' };
  }
}
