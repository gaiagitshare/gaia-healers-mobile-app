/**
 * Membership administration — the operator's write path into the ledger.
 *
 * These functions are a thin, human-shaped façade over the ingestion pipeline.
 * An operator action becomes a proposal from source `admin` and travels the
 * same road a GHL or Shopify event will: validation, identity, precedence,
 * ordering, audit. Admin holds no privileged shortcut into the ledger.
 *
 * That is the point. Because every operator action exercises the pipeline, the
 * architecture is under test from ordinary daily use long before an external
 * system is connected — and shadow mode is not a simulation that can drift from
 * the real path, it IS the real path with the last step withheld.
 *
 * The rule the whole design turns on is unchanged: assigning a plan does NOT
 * grant its benefits. `applyPolicy` is a separate, deliberate action.
 */

import crypto from 'node:crypto';

import { MEMBERSHIP_ORDER, ENTITLEMENT_TYPES, isFixtureContactId } from './config.js';
import { entitlementIdentity } from './ledger.js';
import { benefitsToEntitlements } from './policy.js';
import { ingest, overrideActive } from './proposals.js';
import { audit, auditFor } from './audit-log.js';

const clean = (value, max = 200) => String(value ?? '')
  .replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);

/** Monotonic, persisted with the store so it survives a restart. */
function nextSequence(store) {
  store.adminSequence = (Number(store.adminSequence) || 0) + 1;
  return store.adminSequence;
}

/**
 * Push one operator action through the pipeline.
 *
 * An admin proposal always carries an occurredAt of now and a source event id,
 * so it orders and deduplicates by exactly the same rules an adapter does.
 */
function propose(store, contactId, intentType, intent, { actor = 'admin', now = new Date(), note = '', evidence = null } = {}) {
  const id = clean(contactId, 120);
  if (!id) return { ok: false, error: 'contact_id_required' };
  const result = ingest(store, {
    source: 'admin',
    intentType,
    contactId: id,
    intent,
    occurredAt: now.toISOString(),
    // An operator action is a genuinely new event every time, never a redelivery
    // of an earlier one, so it gets a fresh id. Deriving one from the timestamp
    // made two actions in the same millisecond look like a duplicate.
    sourceEventId: `admin-${crypto.randomUUID()}`,
    // Operator actions are strictly ordered by when they were taken, and two of
    // them can land in the same millisecond. A monotonic sequence makes the
    // later one win deterministically instead of by an id comparison.
    sequence: nextSequence(store),
    evidence: evidence || {},
    actor,
    note,
    confidence: 'authoritative',
  }, { now });
  return result;
}

/**
 * Set or change a member's plan. Deliberately does not touch entitlements —
 * moving someone to Gold does not hand them Gold's benefits, because those are
 * separate rights with their own evidence and expiry.
 */
export function assignMembership(store, contactId, input, { actor = 'admin', now = new Date(), note = '' } = {}) {
  if (!MEMBERSHIP_ORDER.includes(input?.key)) return { ok: false, error: 'unknown_plan_key' };

  const result = propose(store, contactId, 'membership', {
    key: input.key,
    status: input.status || 'active',
    billing_cycle: input.billing_cycle || 'none',
    started_at: input.started_at || now.toISOString(),
    renews_at: input.renews_at || null,
    ends_at: input.ends_at || null,
    source: 'manual',
    evidence_id: input.evidence_id || null,
    override_until: input.override_until || null,
  }, { actor, now, note, evidence: { id: input.evidence_id || null } });

  if (!result.ok) return { ok: false, error: result.reason };
  return { ok: true, membership: store.contacts[clean(contactId, 120)].membership };
}

/** End a membership without touching anything the member owns outright. */
export function endMembership(store, contactId, { status = 'cancelled', endsAt = null, actor = 'admin', now = new Date(), note = '' } = {}) {
  const id = clean(contactId, 120);
  const record = store.contacts?.[id];
  if (!record?.membership) return { ok: false, error: 'no_membership' };

  const result = propose(store, id, 'membership', {
    ...record.membership,
    status,
    ends_at: endsAt || now.toISOString(),
  }, { actor, now, note });

  if (!result.ok) return { ok: false, error: result.reason };
  return { ok: true, membership: store.contacts[id].membership };
}

/**
 * Grant or update one entitlement.
 *
 * `source` is recorded honestly — an operator grant is never dressed up as a
 * Shopify order or a GHL sync. When the adapters arrive they write the same
 * records under their own sources and nothing else changes.
 */
export function grantEntitlement(store, contactId, input, { actor = 'admin', now = new Date(), note = '' } = {}) {
  const type = clean(input?.type, 40);
  if (!Object.prototype.hasOwnProperty.call(ENTITLEMENT_TYPES, type)) {
    return { ok: false, error: 'unknown_entitlement_type' };
  }
  const id = clean(contactId, 120);
  const identity = `${type}::${clean(input.key, 120)}`;
  const before = (store.contacts?.[id]?.entitlements || [])
    .find((item) => entitlementIdentity(item) === identity) || null;

  const result = propose(store, id, 'entitlement', {
    type,
    key: input.key,
    value: input.value,
    status: input.status || 'active',
    source: input.source || 'manual',
    evidence_id: input.evidence_id || null,
    starts_at: input.starts_at || now.toISOString(),
    expires_at: input.expires_at || null,
    override_until: input.override_until || null,
  }, { actor, now, note, evidence: { id: input.evidence_id || null } });

  if (!result.ok) return { ok: false, error: result.reason };
  const entitlement = (store.contacts[id].entitlements || [])
    .find((item) => entitlementIdentity(item) === identity);
  if (!entitlement) return { ok: false, error: 'invalid_entitlement' };
  return { ok: true, entitlement, replaced: Boolean(before) };
}

/**
 * Revoke an entitlement.
 *
 * The record is kept and marked revoked rather than deleted: "this was removed
 * on the 3rd by an operator" is an answer, and a missing row is not.
 */
export function revokeEntitlement(store, contactId, { type, key }, { actor = 'admin', now = new Date(), note = '' } = {}) {
  const id = clean(contactId, 120);
  const record = store.contacts?.[id];
  if (!record) return { ok: false, error: 'unknown_contact' };
  const identity = `${clean(type, 40)}::${clean(key, 120)}`;
  const existing = (record.entitlements || []).find((item) => entitlementIdentity(item) === identity);
  if (!existing) return { ok: false, error: 'entitlement_not_found' };

  const result = propose(store, id, 'entitlement_absent', { type: clean(type, 40), key: clean(key, 120) },
    { actor, now, note });
  if (!result.ok) return { ok: false, error: result.reason };
  return {
    ok: true,
    entitlement: (record.entitlements || []).find((item) => entitlementIdentity(item) === identity),
  };
}

/**
 * Place or lift a manual override.
 *
 * This is what stops a future reconciliation sweep from quietly undoing a comp,
 * a correction or a temporary grant. It is time-boxed on purpose: an override
 * with no end date is how a ledger drifts permanently out of step with billing.
 */
export function setOverride(store, contactId, { resource = 'membership', type, key, until, reason = '' },
  { actor = 'admin', now = new Date() } = {}) {
  const id = clean(contactId, 120);
  const record = store.contacts?.[id];
  if (!record) return { ok: false, error: 'unknown_contact' };
  const untilIso = until ? new Date(Date.parse(until)).toISOString() : null;
  if (until && !Number.isFinite(Date.parse(until))) return { ok: false, error: 'invalid_until' };

  let target = null;
  let label = 'membership';
  if (resource === 'membership') {
    if (!record.membership) return { ok: false, error: 'no_membership' };
    target = record.membership;
  } else {
    const identity = `${clean(type, 40)}::${clean(key, 120)}`;
    target = (record.entitlements || []).find((item) => entitlementIdentity(item) === identity);
    if (!target) return { ok: false, error: 'entitlement_not_found' };
    label = identity;
  }

  const from = target.override_until || null;
  target.override_until = untilIso;
  target.override_reason = clean(reason, 200) || null;
  record.updatedAt = now.toISOString();

  audit(store, {
    at: now.toISOString(), actor, source: 'admin',
    action: untilIso ? 'override.set' : 'override.clear',
    contactId: id, note: clean(reason, 300),
    detail: { resource: label, from, to: untilIso },
  });
  return { ok: true, override_until: untilIso, resource: label };
}

/**
 * Write a plan's promised benefits as real entitlements for one member.
 *
 * This is the ONLY bridge from policy to access, and it is explicit on purpose.
 */
export function applyPolicy(store, contactId, policy, planKey, { actor = 'admin', now = new Date(), period = null, note = '' } = {}) {
  if (!policy?.plans?.[planKey]) return { ok: false, error: 'unknown_plan_key' };
  const drafts = benefitsToEntitlements(policy, planKey, { now, period });
  const written = [];
  for (const draft of drafts) {
    const result = grantEntitlement(store, contactId, draft, { actor, now, note: note || `apply ${planKey} policy` });
    if (result.ok) written.push(result.entitlement);
  }
  audit(store, {
    at: now.toISOString(), actor, source: 'admin', action: 'policy.apply', contactId, note,
    detail: { plan: planKey, created: written.map((item) => `${item.type}:${item.key}`) },
  });
  return { ok: true, created: written };
}

/**
 * Compare what a member HAS against what their plan PROMISES.
 *
 * Drift is expected and not an error — a Gold member with no lead allocation
 * this month is simply not holding that right yet. Surfacing it is how an
 * operator notices before the member does.
 */
export function policyDrift(record, policy, now = new Date()) {
  const planKey = record?.membership?.key;
  if (!planKey || !policy?.plans?.[planKey]) return { plan: null, missing: [], extra: [] };
  const expected = benefitsToEntitlements(policy, planKey, { now });
  const held = (record.entitlements || []).filter((item) => item.status === 'active');

  const missing = expected
    .filter((item) => !held.some((h) => h.type === item.type))
    .map((item) => ({ type: item.type, key: item.key, value: item.value }));

  // Rights the member holds from policy that their current plan no longer
  // promises — typically left behind by a downgrade.
  const extra = held
    .filter((item) => item.source === 'membership_policy' && !expected.some((e) => e.type === item.type))
    .map((item) => ({ type: item.type, key: item.key }));

  return { plan: planKey, missing, extra, heldTypes: [...new Set(held.map((i) => i.type))] };
}

export { isFixtureContactId, audit, auditFor, overrideActive };
