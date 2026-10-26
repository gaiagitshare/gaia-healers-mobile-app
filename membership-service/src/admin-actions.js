/**
 * Control Center actions: the permission matrix and the two-person rule
 * (docs/membership/CONTROL-CENTER.md §2).
 *
 * Every write is one admin_action_requests row, keyed by the operator's
 * requestId (a replay returns the first result; the same key for a different
 * request is CONFLICT). Direct actions execute at once. Dual actions stay
 * `pending` until a DIFFERENT active operator with the required role approves
 * (72 h expiry); the pending -> approved step is one conditional UPDATE, so a
 * request executes at most once. Outcomes: executed, failed (error recorded),
 * or approved_not_executed (PROVIDER_UNAVAILABLE: e.g. Stripe not connected;
 * stored as status `approved` with result.outcome, never faked as success).
 */
import { withTransaction } from './db.js';
import { audit } from './audit.js';
import { fail, MembershipError } from './errors.js';
import { roleRank, operatorActor } from './operators.js';
import { createOffer, withdrawOffer, confirmLegacyCancelled, authorizeException } from './migration-offers.js';
import { cancelPreview, scheduleCancel, transition } from './subscriptions.js';
import { creditGoodwill, resolveRefundReview, GOODWILL_MAX_COINS } from './coins.js';
import { setLaunchStage, addPilotMember, removePilotMember, STAGES } from './launch.js';
import { cancelAtPeriodEnd, cancelNow, refundPayment } from './providers/stripe/adapter.js';

export const REQUEST_TTL_MS = 72 * 3600 * 1000;
export const GOODWILL_DIRECT_MAX = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const uuid = (v, what) => (UUID_RE.test(String(v)) ? String(v) : fail('INVALID_INPUT', `${what} must be a uuid`));
const text = (v, what, min = 10, max = 2000) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) fail('INVALID_INPUT', `${what} must be ${min}-${max} characters`);
  return s;
};
const int = (v, what, min, max) => (Number.isSafeInteger(v) && v >= min && v <= max ? v : fail('INVALID_INPUT', `${what} must be an integer ${min}-${max}`));

/**
 * Action definitions. `role` = minimum role to request; `dual(params)` returns
 * the approver role when the two-person rule applies, else null.
 * `check(params)` normalizes and validates shape; `run(ctx, params, req)` executes.
 */
export const ACTIONS = {
  'note.add': {
    role: 'support', dual: () => null,
    check: (p) => ({ personId: uuid(p.personId, 'personId'), body: text(p.body, 'body', 1, 4000) }),
    async run({ pool }, p, rq) {
      await exists(pool, 'persons', p.personId, 'person');
      const n = (await pool.query('INSERT INTO person_notes (person_id, operator_id, body) VALUES ($1, $2, $3) RETURNING id, created_at', [p.personId, rq.requested_by, p.body])).rows[0];
      return { noteId: n.id, createdAt: n.created_at };
    },
  },
  'offer.create': {
    role: 'support', dual: () => null,
    check: (p) => ({ personId: uuid(p.personId, 'personId'), legacyMembershipId: uuid(p.legacyMembershipId, 'legacyMembershipId'),
      targetPlanKey: /^[a-z][a-z0-9_]{1,59}$/.test(String(p.targetPlanKey)) ? p.targetPlanKey : fail('INVALID_INPUT', 'targetPlanKey is required'),
      interval: ['month', 'year'].includes(p.interval) ? p.interval : fail('INVALID_INPUT', 'interval must be month or year') }),
    async run({ pool, env }, p, rq, actor) {
      const l = (await pool.query('SELECT person_id FROM legacy_memberships WHERE id = $1', [p.legacyMembershipId])).rows[0];
      if (!l || l.person_id !== p.personId) fail('NOT_FOUND', 'legacy membership not found for this person');
      const v = (await pool.query(`SELECT v.id FROM plans p JOIN LATERAL (SELECT id FROM plan_versions WHERE plan_id = p.id AND status = 'published' AND NOT is_legacy ORDER BY version DESC LIMIT 1) v ON true
                                     WHERE p.key = $1 AND p.owner_type = 'gaia' AND p.status = 'active'`, [p.targetPlanKey])).rows[0];
      if (!v) fail('NOT_FOUND', 'plan not on sale');
      const { migrationPolicy } = await import('./migration-offers.js');
      const o = await createOffer(pool, { legacyMembershipId: p.legacyMembershipId, targetPlanVersionId: v.id, targetInterval: p.interval }, actor.actorId, { policy: migrationPolicy(env) });
      return { offerId: o.id, status: o.status };
    },
  },
  'offer.withdraw': {
    role: 'support', dual: () => null,
    check: (p) => ({ offerId: uuid(p.offerId, 'offerId') }),
    async run({ pool }, p, rq, actor) { const r = await withdrawOffer(pool, p.offerId, actor.actorId); return { offerId: p.offerId, status: r.offer.status, replayed: r.replayed }; },
  },
  'legacy.confirm_cancelled': {
    role: 'support', dual: () => null,
    check: (p) => ({ offerId: uuid(p.offerId, 'offerId'), evidence: text(p.evidence, 'evidence', 10, 2000) }),
    async run({ pool }, p, rq, actor) { const r = await confirmLegacyCancelled(pool, p.offerId, actor.actorId); return { offerId: p.offerId, status: r.offer.status, replayed: r.replayed }; },
  },
  'subscription.cancel_period_end': {
    role: 'support', dual: () => null,
    check: (p) => ({ subscriptionId: uuid(p.subscriptionId, 'subscriptionId') }),
    async run({ pool, stripe }, p, rq, actor) {
      const s = await gaiaSubscription(pool, p.subscriptionId);
      if (s.provider === 'stripe') {
        const r = await cancelAtPeriodEnd({ pool, stripe }, s.id, { idempotencyKey: 'gaia-admin-cancel-' + rq.id, actor });
        return { subscriptionId: s.id, accessEndsAt: r.accessEndsAt };
      }
      if (!['manual', 'simulated'].includes(s.provider)) fail('CONFLICT', `a ${s.provider} subscription is not cancelled from here`);
      const { accessEndsAt } = await cancelPreview(pool, s.id);
      await scheduleCancel(pool, s.id, { accessEndsAt }, actor);
      return { subscriptionId: s.id, accessEndsAt };
    },
  },
  'subscription.cancel_now': {
    role: 'finance', dual: () => 'finance',
    check: (p) => ({ subscriptionId: uuid(p.subscriptionId, 'subscriptionId') }),
    async run({ pool, stripe, now }, p, rq, actor) {
      const s = await gaiaSubscription(pool, p.subscriptionId);
      if (s.provider === 'stripe') return { subscriptionId: s.id, ...(await cancelNow({ pool, stripe }, s.id, { actor, now })) };
      if (!['manual', 'simulated'].includes(s.provider)) fail('CONFLICT', `a ${s.provider} subscription is not cancelled from here`);
      const t = await transition(pool, s.id, 'canceled', { reason: 'admin_cancel_now', now }, actor);
      return { subscriptionId: s.id, canceledAt: now, from: t.from };
    },
  },
  'coins.credit': {
    role: (p) => (p.coins > GOODWILL_DIRECT_MAX ? 'finance' : 'support'),
    dual: (p) => (p.coins > GOODWILL_DIRECT_MAX ? 'finance' : null),
    check: (p) => ({ personId: uuid(p.personId, 'personId'), coins: int(p.coins, 'coins', 1, GOODWILL_MAX_COINS) }),
    async run({ pool }, p, rq, actor) {
      await exists(pool, 'persons', p.personId, 'person');
      const r = await creditGoodwill(pool, { personId: p.personId, coins: p.coins, idempotencyKey: 'admin-goodwill:' + rq.id, requestRef: rq.id, actor });
      return { operationId: r.operation.id, coins: p.coins, replayed: r.replayed };
    },
  },
  'refund_review.resolve': {
    role: 'finance', dual: () => null,
    check: (p) => ({ reviewId: uuid(p.reviewId, 'reviewId'), resolution: text(p.resolution, 'resolution', 5, 2000) }),
    async run({ pool }, p, rq, actor) { await resolveRefundReview(pool, p.reviewId, { by: actor.actorId, resolution: p.resolution }); return { reviewId: p.reviewId, status: 'resolved' }; },
  },
  'payment.refund': {
    role: 'finance', dual: () => 'finance',
    check: (p) => ({ ledgerId: int(p.ledgerId, 'ledgerId', 1, Number.MAX_SAFE_INTEGER), amountCents: int(p.amountCents, 'amountCents', 1, 100000000) }),
    async run({ pool, stripe }, p, rq) { return refundPayment({ pool, stripe }, p.ledgerId, { amountCents: p.amountCents, idempotencyKey: rq.id }); },
  },
  'migration.authorize_exception': {
    role: 'finance', dual: () => 'owner',
    check: (p) => ({ offerId: uuid(p.offerId, 'offerId') }),
    async run({ pool }, p, rq, actor) { const r = await authorizeException(pool, p.offerId, { authorizedBy: actor.actorId, reason: rq.reason }); return { offerId: p.offerId, status: r.offer.status }; },
  },
  'pilot.add': {
    role: 'owner', dual: () => null,
    check: (p) => ({ personId: uuid(p.personId, 'personId') }),
    async run({ pool }, p, rq, actor) { await exists(pool, 'persons', p.personId, 'person'); await addPilotMember(pool, p.personId, { note: rq.reason }, actor); return { personId: p.personId, pilot: true }; },
  },
  'pilot.remove': {
    role: 'owner', dual: () => null,
    check: (p) => ({ personId: uuid(p.personId, 'personId') }),
    async run({ pool }, p, rq, actor) { await removePilotMember(pool, p.personId, actor); return { personId: p.personId, pilot: false }; },
  },
  'launch.set': {
    role: 'owner',
    dual: (p) => (STAGES.indexOf(p.stage) > STAGES.indexOf('INTERNAL_PILOT') ? 'owner' : null),
    check: (p) => {
      if (!STAGES.includes(p.stage)) fail('INVALID_INPUT', 'stage must be one of ' + STAGES.join(', '));
      const out = { stage: p.stage };
      if (p.limitedCap !== undefined && p.limitedCap !== null) out.limitedCap = int(p.limitedCap, 'limitedCap', 0, 1000000);
      if (p.approvalRef) out.approvalRef = text(p.approvalRef, 'approvalRef', 3, 120);
      if (STAGES.indexOf(p.stage) > STAGES.indexOf('INTERNAL_PILOT') && !out.approvalRef) fail('INVALID_INPUT', 'stages above INTERNAL_PILOT need approvalRef (the GO decision)');
      return out;
    },
    async run({ pool }, p, rq, actor) { return setLaunchStage(pool, { stage: p.stage, limitedCap: p.limitedCap, reason: rq.reason, approvalRef: p.approvalRef || null }, actor); },
  },
};

const minRole = (def, p) => (typeof def.role === 'function' ? def.role(p) : def.role);
const atLeast = (op, role) => roleRank(op.role) >= roleRank(role);
const forbidden = (role, msg = 'your role does not allow this') => { throw Object.assign(new MembershipError('FORBIDDEN', msg), { expose: { requiredRole: role } }); };

/** Action keys the operator may request (the UI shows only these). */
export function permissionsFor(op) {
  return Object.entries(ACTIONS).filter(([key, def]) => atLeast(op, minRole(def, key === 'coins.credit' ? { coins: 1 } : {}))).map(([k]) => k);
}

async function exists(db, table, id, what) {
  if (!(await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount) fail('NOT_FOUND', what + ' not found');
}
async function gaiaSubscription(db, id) {
  const s = (await db.query(`SELECT s.id, s.provider, s.status FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
                              WHERE s.id = $1 AND p.owner_type = 'gaia'`, [id])).rows[0];
  return s || fail('NOT_FOUND', 'subscription not found');
}

/** API view of a request; approved + PROVIDER_UNAVAILABLE reads as approved_not_executed. */
export function requestView(r, viewer = null) {
  const status = r.status === 'approved' && r.result?.outcome === 'approved_not_executed' ? 'approved_not_executed' : r.status;
  return {
    id: r.id, action: r.action, params: r.params, reason: r.reason, dual: r.dual, status, requiredRole: r.required_role,
    requestedBy: { id: r.requested_by, displayName: r.requester_name ?? null }, requestedAt: r.created_at,
    decidedBy: r.decided_by ? { id: r.decided_by, displayName: r.decider_name ?? null } : null, decidedAt: r.decided_at, decisionNote: r.decision_note,
    executedAt: r.executed_at, result: r.result, expiresAt: r.expires_at,
    ...(viewer ? { canApprove: Boolean(r.dual && r.status === 'pending' && new Date(r.expires_at) > new Date() && viewer.id !== r.requested_by && atLeast(viewer, r.required_role)),
      own: viewer.id === r.requested_by } : {}),
  };
}

const errResult = (e) => ({ code: e.code || 'INTERNAL', message: e instanceof MembershipError ? e.message : 'internal error' });

/** Execute an approved / direct request once and record the outcome. */
async function execute(ctx, rq, executor) {
  const def = ACTIONS[rq.action];
  const actor = operatorActor(executor, ctx.requestId);
  let status, result, error = null;
  try {
    result = await def.run(ctx, rq.params, rq, actor);
    status = 'executed';
  } catch (e) {
    error = e;
    if (e.code === 'PROVIDER_UNAVAILABLE') { status = 'approved'; result = { outcome: 'approved_not_executed', ...errResult(e) }; }
    else { status = 'failed'; result = errResult(e); }
    if (!(e instanceof MembershipError)) console.error('[membership-admin] action failed', rq.action, rq.id, e.code || '', e.message);
  }
  const row = await withTransaction(ctx.pool, async (c) => {
    const u = (await c.query(`UPDATE admin_action_requests SET status = $2, result = $3, executed_at = CASE WHEN $2 = 'executed' THEN $4::timestamptz ELSE NULL END
                               WHERE id = $1 RETURNING *`, [rq.id, status, JSON.stringify(result ?? {}), ctx.now])).rows[0];
    await audit(c, { ...actor, action: 'admin.action.' + (status === 'approved' ? 'not_executed' : status), entityType: 'admin_action_request', entityId: rq.id,
      after: { action: rq.action, requestedBy: rq.requested_by, executedBy: executor.id, ...(status === 'executed' ? {} : { code: result.code }) } });
    return u;
  });
  return { row, error };
}

const outcome = (row) => requestView(row).status;

/**
 * POST /v1/admin/actions { action, params, reason, requestId }.
 * Direct: { status: 'executed', result } (or the error). Dual: { status: 'pending', request }.
 */
export async function submitAction(ctx, operator, body) {
  const def = ACTIONS[body?.action];
  if (!def) fail('INVALID_INPUT', 'unknown action');
  if (!REQUEST_ID_RE.test(String(body.requestId || ''))) fail('INVALID_INPUT', 'requestId (8-64 of A-Z a-z 0-9 _ -) is required');
  const params = def.check(body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {});
  // A note is its own written reason; every other write needs a separate one.
  const reason = text(body.action === 'note.add' && (body.reason === undefined || body.reason === null || body.reason === '') ? params.body : body.reason, 'reason', 10, 1000);
  const need = minRole(def, params);
  if (!atLeast(operator, need)) {
    await audit(ctx.pool, { ...operatorActor(operator, ctx.requestId), action: 'admin.denied', entityType: 'admin_action', entityId: body.action, after: { requiredRole: need, role: operator.role } });
    forbidden(need);
  }
  const approver = def.dual(params);
  const key = `${operator.id}:${body.requestId}`;
  const prior = (await ctx.pool.query('SELECT * FROM admin_action_requests WHERE idempotency_key = $1', [key])).rows[0];
  if (prior) return replay(prior, { action: body.action, params, reason });
  let row;
  try {
    row = await withTransaction(ctx.pool, async (c) => {
      const r = (await c.query(`INSERT INTO admin_action_requests (action, params, reason, requested_by, required_role, dual, status, idempotency_key, created_at, expires_at)
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [body.action, JSON.stringify(params), reason, operator.id, approver || need, Boolean(approver), approver ? 'pending' : 'approved', key, ctx.now, new Date(ctx.now.getTime() + REQUEST_TTL_MS)])).rows[0];
      await audit(c, { ...operatorActor(operator, ctx.requestId), action: approver ? 'admin.request.create' : 'admin.action.submit', entityType: 'admin_action_request', entityId: r.id,
        after: { action: body.action, params, reason, dual: Boolean(approver), requiredRole: approver || need } });
      return r;
    });
  } catch (e) {
    if (e.code === '23505') { const p = (await ctx.pool.query('SELECT * FROM admin_action_requests WHERE idempotency_key = $1', [key])).rows[0]; return replay(p, { action: body.action, params, reason }); }
    throw e;
  }
  if (approver) return { status: 'pending', request: requestView(row, operator) };
  const { row: done, error } = await execute(ctx, row, operator);
  if (error) throw Object.assign(error instanceof MembershipError ? error : new MembershipError('CONFLICT', 'action failed'), { expose: { ...(error.expose || {}), request: { id: done.id, status: outcome(done) } } });
  return { status: 'executed', result: done.result, request: { id: done.id, status: 'executed' } };
}

function replay(prior, { action, params, reason }) {
  if (prior.action !== action || JSON.stringify(sortKeys(prior.params)) !== JSON.stringify(sortKeys(params)) || prior.reason !== reason) fail('CONFLICT', 'requestId was already used for a different request');
  if (prior.dual) return { status: outcome(prior) === 'pending' ? 'pending' : outcome(prior), replayed: true, request: requestView(prior), ...(prior.result ? { result: prior.result } : {}) };
  if (prior.status === 'executed') return { status: 'executed', replayed: true, result: prior.result, request: { id: prior.id, status: 'executed' } };
  if (prior.status === 'approved' && !prior.result) fail('CONFLICT', 'this request is still being executed');
  throw Object.assign(new MembershipError(prior.result?.code === 'PROVIDER_UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE' : (prior.result?.code in { NOT_FOUND: 1, INVALID_INPUT: 1, FORBIDDEN: 1 } ? prior.result.code : 'CONFLICT'),
    prior.result?.message || 'action failed'), { expose: { replayed: true, request: { id: prior.id, status: outcome(prior) } } });
}
const sortKeys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])])) : o);

async function lockRequest(c, id, now) {
  if (!UUID_RE.test(String(id))) fail('NOT_FOUND', 'request not found');
  const r = (await c.query('SELECT * FROM admin_action_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!r) fail('NOT_FOUND', 'request not found');
  if (r.status === 'pending' && new Date(r.expires_at) <= now) {
    await c.query("UPDATE admin_action_requests SET status = 'expired' WHERE id = $1", [id]);
    await audit(c, { actorType: 'system', actorId: 'admin-requests', action: 'admin.request.expired', entityType: 'admin_action_request', entityId: id });
    return { ...r, status: 'expired' };
  }
  return r;
}

/** Approve (and execute) or reject a pending dual request. */
export async function decide(ctx, operator, id, verdict, note, requestId = null) {
  const decisionNote = note == null || note === '' ? null : text(note, 'note', 1, 1000);
  if (requestId != null && !REQUEST_ID_RE.test(String(requestId))) fail('INVALID_INPUT', 'requestId (8-64 of A-Z a-z 0-9 _ -) is invalid');
  const dkey = requestId ? `${operator.id}:${requestId}` : null;
  if (dkey) {
    const prior = (await ctx.pool.query('SELECT * FROM admin_action_requests WHERE decision_key = $1', [dkey])).rows[0];
    if (prior) {
      const sameVerdict = verdict === 'reject' ? prior.status === 'rejected' : prior.status !== 'rejected';
      if (prior.id !== id || !sameVerdict) fail('CONFLICT', 'requestId was already used for a different decision');
      if (verdict === 'reject') return { status: 'rejected', replayed: true, request: requestView(prior, operator) };
      if (prior.status === 'approved' && !prior.result) fail('CONFLICT', 'this request is still being executed');
      return { status: outcome(prior), replayed: true, result: prior.result, request: requestView(prior, operator) };
    }
  }
  const decided = await withTransaction(ctx.pool, async (c) => {
    const r = await lockRequest(c, id, ctx.now);
    if (!r.dual) fail('CONFLICT', 'this action does not need an approval');
    if (r.status === 'expired') return { expired: true };
    if (r.status !== 'pending') fail('CONFLICT', `request is ${outcome(r)}`);
    if (r.requested_by === operator.id) {
      await audit(c, { ...operatorActor(operator, ctx.requestId), action: 'admin.denied', entityType: 'admin_action_request', entityId: r.id, after: { why: 'own_request' } });
      return { own: true, role: r.required_role };
    }
    const me = (await c.query('SELECT id, role, status FROM operators WHERE id = $1 FOR SHARE', [operator.id])).rows[0];
    if (!me || me.status !== 'active') fail('AUTH_REQUIRED', 'operator sign-in required');
    if (!atLeast(me, r.required_role)) {
      await audit(c, { ...operatorActor(operator, ctx.requestId), action: 'admin.denied', entityType: 'admin_action_request', entityId: r.id, after: { requiredRole: r.required_role, role: me.role } });
      return { role: r.required_role, forbidden: true };
    }
    let u;
    try {
      u = (await c.query(`UPDATE admin_action_requests SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5, decision_key = $6 WHERE id = $1 AND status = 'pending' RETURNING *`,
        [r.id, verdict === 'approve' ? 'approved' : 'rejected', operator.id, ctx.now, decisionNote, dkey])).rows[0];
    } catch (e) { if (e.code === '23505') fail('CONFLICT', 'requestId was already used for a different decision'); throw e; }
    await audit(c, { ...operatorActor(operator, ctx.requestId), action: verdict === 'approve' ? 'admin.request.approve' : 'admin.request.reject', entityType: 'admin_action_request', entityId: r.id,
      after: { action: r.action, requestedBy: r.requested_by, note: decisionNote } });
    return { row: u };
  });
  if (decided.expired) fail('CONFLICT', 'request expired');
  if (decided.own) forbidden(decided.role, 'you cannot approve or reject your own request');
  if (decided.forbidden) forbidden(decided.role);
  if (verdict !== 'approve') return { status: 'rejected', request: requestView(decided.row, operator) };
  const { row } = await execute(ctx, decided.row, operator);
  return { status: outcome(row), result: row.result, request: requestView(row, operator) };
}

/** The requester withdraws their own pending request. */
export async function cancelRequest(ctx, operator, id) {
  return withTransaction(ctx.pool, async (c) => {
    const r = await lockRequest(c, id, ctx.now);
    if (r.requested_by !== operator.id) forbidden(r.required_role, 'only the requester can cancel a request');
    if (r.status !== 'pending') fail('CONFLICT', `request is ${outcome(r)}`);
    const u = (await c.query("UPDATE admin_action_requests SET status = 'cancelled', decided_at = $2 WHERE id = $1 RETURNING *", [r.id, ctx.now])).rows[0];
    await audit(c, { ...operatorActor(operator, ctx.requestId), action: 'admin.request.cancel', entityType: 'admin_action_request', entityId: r.id });
    return { status: 'cancelled', request: requestView(u, operator) };
  });
}

/** Lazily mark overdue pending requests expired (bounded). */
export async function expireOverdue(db, now) {
  const ids = (await db.query("UPDATE admin_action_requests SET status = 'expired' WHERE id IN (SELECT id FROM admin_action_requests WHERE status = 'pending' AND expires_at <= $1 LIMIT 200) RETURNING id", [now])).rows;
  for (const { id } of ids) await audit(db, { actorType: 'system', actorId: 'admin-requests', action: 'admin.request.expired', entityType: 'admin_action_request', entityId: id });
  return ids.length;
}
