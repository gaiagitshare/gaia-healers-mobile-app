/**
 * Membership administration — the operator's write path into the ledger.
 *
 * Every mutation here is explicit, carries a source and evidence, and writes an
 * audit entry. That is what makes the system answerable: a member asks "why can
 * I open this course?" and the answer is a record with a source, a timestamp and
 * the name of whoever granted it — not an inference.
 *
 * The rule the whole design turns on: assigning a plan does NOT grant its
 * benefits. `assignMembership` sets the membership and nothing else.
 * `applyPolicy` is a separate, deliberate action that writes real entitlement
 * records. An operator has to mean it.
 *
 * Pure functions over a store object — persistence belongs to the caller.
 */

import { MEMBERSHIP_ORDER, ENTITLEMENT_TYPES, isFixtureContactId } from './config.js';
import { normalizeMembership, normalizeEntitlement, emptyContactRecord, entitlementIdentity } from './ledger.js';
import { benefitsToEntitlements } from './policy.js';

const MAX_AUDIT = 2000;

const clean = (value, max = 200) => String(value ?? '')
  .replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);

/**
 * Append an audit entry. Append-only and capped; the cap is generous because
 * "why does this member have access" is a question asked months later.
 */
export function audit(store, entry) {
  const list = Array.isArray(store.auditLog) ? store.auditLog : [];
  list.push({
    at: entry.at || new Date().toISOString(),
    actor: clean(entry.actor, 80) || 'admin',
    action: clean(entry.action, 60),
    contactId: clean(entry.contactId, 120),
    detail: entry.detail && typeof entry.detail === 'object' ? entry.detail : {},
    note: clean(entry.note, 300),
  });
  store.auditLog = list.slice(-MAX_AUDIT);
  return store.auditLog[store.auditLog.length - 1];
}

function recordFor(store, contactId, now) {
  const id = clean(contactId, 120);
  if (!id) throw new Error('contactId is required');
  if (!store.contacts[id]) store.contacts[id] = emptyContactRecord(id, now.toISOString());
  return store.contacts[id];
}

/**
 * Set or change a member's plan. Deliberately does not touch entitlements —
 * moving someone to Gold does not hand them Gold's benefits, because those are
 * separate rights with their own evidence and expiry.
 */
export function assignMembership(store, contactId, input, { actor = 'admin', now = new Date(), note = '' } = {}) {
  if (!MEMBERSHIP_ORDER.includes(input?.key)) {
    return { ok: false, error: 'unknown_plan_key' };
  }
  const record = recordFor(store, contactId, now);
  const before = record.membership ? { ...record.membership } : null;

  record.membership = normalizeMembership({
    key: input.key,
    status: input.status || 'active',
    billing_cycle: input.billing_cycle || 'none',
    started_at: input.started_at || now.toISOString(),
    renews_at: input.renews_at || null,
    ends_at: input.ends_at || null,
    source: input.source || 'manual',
    evidence_id: input.evidence_id || null,
  }, { now });
  record.updatedAt = now.toISOString();

  audit(store, {
    at: now.toISOString(), actor, action: 'membership.assign', contactId, note,
    detail: { from: before, to: record.membership },
  });
  return { ok: true, membership: record.membership };
}

/** End a membership without touching anything the member owns outright. */
export function endMembership(store, contactId, { status = 'cancelled', endsAt = null, actor = 'admin', now = new Date(), note = '' } = {}) {
  const record = recordFor(store, contactId, now);
  if (!record.membership) return { ok: false, error: 'no_membership' };
  const before = { ...record.membership };
  record.membership = normalizeMembership({
    ...record.membership,
    status,
    ends_at: endsAt || now.toISOString(),
  }, { now });
  record.updatedAt = now.toISOString();
  audit(store, {
    at: now.toISOString(), actor, action: 'membership.end', contactId, note,
    detail: { from: before, to: record.membership },
  });
  return { ok: true, membership: record.membership };
}

/**
 * Grant or update one entitlement.
 *
 * `source` defaults to manual and is recorded honestly — an operator grant is
 * never dressed up as a Shopify order or a GHL offer. When the adapters arrive
 * they write the same records with their own sources, and nothing else changes.
 */
export function grantEntitlement(store, contactId, input, { actor = 'admin', now = new Date(), note = '' } = {}) {
  const type = clean(input?.type, 40);
  if (!Object.prototype.hasOwnProperty.call(ENTITLEMENT_TYPES, type)) {
    return { ok: false, error: 'unknown_entitlement_type' };
  }
  const entitlement = normalizeEntitlement({
    type,
    key: input.key,
    value: input.value,
    status: input.status || 'active',
    source: input.source || 'manual',
    evidence_id: input.evidence_id || null,
    starts_at: input.starts_at || now.toISOString(),
    expires_at: input.expires_at || null,
    observed_at: now.toISOString(),
  }, { now });
  if (!entitlement) return { ok: false, error: 'invalid_entitlement' };

  const record = recordFor(store, contactId, now);
  const list = Array.isArray(record.entitlements) ? record.entitlements : [];
  const identity = entitlementIdentity(entitlement);
  const index = list.findIndex((item) => entitlementIdentity(item) === identity);
  const before = index >= 0 ? { ...list[index] } : null;
  if (index >= 0) list[index] = entitlement; else list.push(entitlement);
  record.entitlements = list;
  record.updatedAt = now.toISOString();

  audit(store, {
    at: now.toISOString(), actor, action: before ? 'entitlement.update' : 'entitlement.grant',
    contactId, note, detail: { identity, from: before, to: entitlement },
  });
  return { ok: true, entitlement, replaced: Boolean(before) };
}

/**
 * Revoke an entitlement.
 *
 * The record is kept and marked revoked rather than deleted: "this was removed
 * on the 3rd by Sara" is an answer, and a missing row is not.
 */
export function revokeEntitlement(store, contactId, { type, key }, { actor = 'admin', now = new Date(), note = '' } = {}) {
  const record = store.contacts[clean(contactId, 120)];
  if (!record) return { ok: false, error: 'unknown_contact' };
  const identity = `${clean(type, 40)}::${clean(key, 120)}`;
  const list = Array.isArray(record.entitlements) ? record.entitlements : [];
  const index = list.findIndex((item) => entitlementIdentity(item) === identity);
  if (index < 0) return { ok: false, error: 'entitlement_not_found' };

  const before = { ...list[index] };
  list[index] = { ...list[index], status: 'revoked', observed_at: now.toISOString() };
  record.entitlements = list;
  record.updatedAt = now.toISOString();

  audit(store, {
    at: now.toISOString(), actor, action: 'entitlement.revoke', contactId, note,
    detail: { identity, from: before, to: list[index] },
  });
  return { ok: true, entitlement: list[index] };
}

/**
 * Write a plan's promised benefits as real entitlements for one member.
 *
 * This is the ONLY bridge from policy to access, and it is explicit on purpose.
 * Returns what it wrote so the operator sees exactly which rights now exist.
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
    at: now.toISOString(), actor, action: 'policy.apply', contactId, note,
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
  const heldTypes = new Set(held.map((item) => item.type));

  const missing = expected
    .filter((item) => !held.some((h) => h.type === item.type))
    .map((item) => ({ type: item.type, key: item.key, value: item.value }));

  // Rights the member holds from policy that their current plan no longer
  // promises — typically left behind by a downgrade.
  const extra = held
    .filter((item) => item.source === 'membership_policy'
      && !expected.some((e) => e.type === item.type))
    .map((item) => ({ type: item.type, key: item.key }));

  return { plan: planKey, missing, extra, heldTypes: [...heldTypes] };
}

/** Audit entries for one contact, newest first. */
export function auditFor(store, contactId, limit = 100) {
  const id = clean(contactId, 120);
  return (store.auditLog || [])
    .filter((entry) => !id || entry.contactId === id)
    .slice(-limit)
    .reverse();
}

export { isFixtureContactId };
