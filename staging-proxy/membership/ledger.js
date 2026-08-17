/**
 * The Gaia entitlement ledger.
 *
 * Pure functions over a plain store object — no file I/O, no network. server.js
 * owns persistence; this module owns shape, validation and migration so both
 * the running proxy and the contract tests exercise identical logic.
 *
 * Storage stays the existing JSON document. That is a deliberate choice, not an
 * oversight: the store holds 12 contacts, is written only by a single-process
 * webhook receiver, is already written through an atomic temp-file rename, and
 * has no query requirement beyond "fetch one contact by id". SQLite would add a
 * migration, a binary file to back up and a dependency without answering any
 * question the JSON document cannot. Revisit if concurrent writers appear or
 * reconciliation starts needing cross-contact queries.
 */

import {
  MEMBERSHIP_STATUSES, MEMBERSHIP_SOURCES, BILLING_CYCLES,
  ENTITLEMENT_TYPES, ENTITLEMENT_STATUSES, ENTITLEMENT_SOURCES,
  normalizeMembershipKey, isFixtureContactId,
} from './config.js';

const LEDGER_VERSION = 2;

const isoOrNull = (value) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

/**
 * Validate a membership record.
 *
 * An unrecognised key resolves to status "none" rather than being passed
 * through: a typo or a renamed product must never become a tier the rest of the
 * system then honours.
 */
function normalizeMembership(input, { now = new Date() } = {}) {
  if (!input || typeof input !== 'object') return null;
  const key = normalizeMembershipKey(input.key);
  if (!key) {
    return {
      key: null, status: 'none', billing_cycle: 'none',
      started_at: null, renews_at: null, ends_at: null,
      source: MEMBERSHIP_SOURCES.includes(input.source) ? input.source : 'manual',
      evidence_id: input.evidence_id ? String(input.evidence_id) : null,
      rejected_key: input.key ? String(input.key) : null,
    };
  }
  let status = MEMBERSHIP_STATUSES.includes(input.status) ? input.status : 'none';
  const ends_at = isoOrNull(input.ends_at);
  // A cancellation dated in the past is expired, whatever the record claims.
  if (ends_at && Date.parse(ends_at) <= now.getTime() && ['active', 'trialing'].includes(status)) {
    status = 'expired';
  }
  return {
    key,
    status,
    billing_cycle: BILLING_CYCLES.includes(input.billing_cycle) ? input.billing_cycle : 'none',
    started_at: isoOrNull(input.started_at),
    renews_at: isoOrNull(input.renews_at),
    ends_at,
    source: MEMBERSHIP_SOURCES.includes(input.source) ? input.source : 'manual',
    evidence_id: input.evidence_id ? String(input.evidence_id) : null,
  };
}

/**
 * Validate one entitlement record.
 *
 * Unknown types are preserved but marked so the resolver can quarantine them:
 * dropping them silently would hide a producer bug, and rendering them would
 * mean the frontend inventing semantics it does not have.
 */
function normalizeEntitlement(input, { now = new Date() } = {}) {
  if (!input || typeof input !== 'object') return null;
  const type = String(input.type || '').trim();
  const key = String(input.key ?? '').trim();
  if (!type || !key) return null;

  const known = Object.prototype.hasOwnProperty.call(ENTITLEMENT_TYPES, type);
  const expires_at = isoOrNull(input.expires_at);
  let status = ENTITLEMENT_STATUSES.includes(input.status) ? input.status : 'pending';
  // Expiry is computed, never trusted from the producer: a record that says
  // "active" with a past expiry is expired.
  if (status === 'active' && expires_at && Date.parse(expires_at) <= now.getTime()) {
    status = 'expired';
  }
  return {
    type,
    key,
    value: input.value && typeof input.value === 'object' ? input.value : {},
    status,
    source: ENTITLEMENT_SOURCES.includes(input.source) ? input.source : 'manual',
    evidence_id: input.evidence_id ? String(input.evidence_id) : null,
    starts_at: isoOrNull(input.starts_at),
    expires_at,
    observed_at: isoOrNull(input.observed_at),
    ...(known ? {} : { unknown_type: true }),
  };
}

/** Stable identity for an entitlement, so migration and upserts stay idempotent. */
const entitlementIdentity = (entitlement) => `${entitlement.type}::${entitlement.key}`;

function emptyContactRecord(contactId, now = new Date().toISOString()) {
  return {
    contactId: String(contactId),
    tags: [], tier: null, courses: [], communities: [], subscriptions: [],
    domainUpdatedAt: {}, updatedAt: now,
    membership: null, entitlements: [], ledgerVersion: LEDGER_VERSION,
  };
}

/**
 * Additively bring one contact record up to the ledger schema.
 *
 * Everything that already exists is preserved untouched — course grant history
 * above all. New fields are derived from what is already there, and a record
 * that has been migrated before is left alone, so running this repeatedly is a
 * no-op.
 */
function migrateContactRecord(record, { now = new Date() } = {}) {
  if (!record || typeof record !== 'object') return { record, changed: false, notes: [] };
  const nowIso = now.toISOString();
  const notes = [];
  const migrated = { ...record };
  let changed = false;

  // Preserve the existing working fields exactly as they are.
  migrated.tags = Array.isArray(record.tags) ? record.tags : [];
  migrated.courses = Array.isArray(record.courses) ? record.courses : [];
  migrated.communities = Array.isArray(record.communities) ? record.communities : [];
  migrated.subscriptions = Array.isArray(record.subscriptions) ? record.subscriptions : [];
  migrated.domainUpdatedAt = record.domainUpdatedAt && typeof record.domainUpdatedAt === 'object'
    ? record.domainUpdatedAt : {};

  const existing = Array.isArray(record.entitlements) ? record.entitlements : [];
  const byIdentity = new Map();
  for (const raw of existing) {
    const entitlement = normalizeEntitlement(raw, { now });
    if (entitlement) byIdentity.set(entitlementIdentity(entitlement), entitlement);
  }
  if (!Array.isArray(record.entitlements)) changed = true;

  // Course grants already mirrored from GHL are explicit offer evidence.
  for (const course of migrated.courses) {
    const key = String(course?.id || course?.name || '').trim();
    if (!key) continue;
    const identity = `course_access::${key}`;
    if (byIdentity.has(identity)) continue;
    const revoked = course?.status === 'removed' || course?.granted === false;
    byIdentity.set(identity, normalizeEntitlement({
      type: 'course_access',
      key,
      value: { name: course?.name || null },
      status: revoked ? 'revoked' : 'active',
      source: 'ghl_offer',
      evidence_id: course?.id ? String(course.id) : null,
      starts_at: course?.grantedAt || course?.updatedAt || null,
      expires_at: null,
      observed_at: course?.updatedAt || nowIso,
    }, { now }));
    changed = true;
    notes.push(`course_access:${key} derived from existing course grant`);
  }

  // Community rows arrived through the grant/revoke webhook — explicit group
  // evidence. Tag-inferred community access is NOT migrated here; the resolver
  // reports it separately so the two never look alike.
  for (const community of migrated.communities) {
    const key = String(community?.id || community?.name || '').trim();
    if (!key) continue;
    const identity = `community_access::${key}`;
    if (byIdentity.has(identity)) continue;
    const revoked = community?.status === 'removed' || community?.granted === false;
    byIdentity.set(identity, normalizeEntitlement({
      type: 'community_access',
      key,
      value: { name: community?.name || null },
      status: revoked ? 'revoked' : 'active',
      source: 'ghl_group',
      evidence_id: community?.id ? String(community.id) : null,
      starts_at: community?.grantedAt || community?.updatedAt || null,
      observed_at: community?.updatedAt || nowIso,
    }, { now }));
    changed = true;
    notes.push(`community_access:${key} derived from existing community grant`);
  }

  migrated.entitlements = [...byIdentity.values()];

  // Membership is NOT derived during migration. The only membership evidence we
  // hold is a live subscription, which the resolver reads at request time; and
  // legacy tier tags are explicitly not evidence. Inventing a membership record
  // here would bake today's guess into storage.
  if (!Object.prototype.hasOwnProperty.call(migrated, 'membership')) {
    migrated.membership = null;
    changed = true;
  }

  if (migrated.ledgerVersion !== LEDGER_VERSION) {
    migrated.ledgerVersion = LEDGER_VERSION;
    changed = true;
  }
  return { record: migrated, changed, notes };
}

/**
 * Migrate a whole store. Idempotent: a second run reports zero changes.
 *
 * A record that cannot be migrated confidently is kept exactly as-is and listed
 * in `failed` rather than being reshaped on a guess.
 */
function migrateStore(store, { now = new Date() } = {}) {
  const source = store && typeof store === 'object' ? store : {};
  const contacts = source.contacts && typeof source.contacts === 'object' ? source.contacts : {};
  const out = {
    ...source,
    version: LEDGER_VERSION,
    contacts: {},
    processedWebhookIds: Array.isArray(source.processedWebhookIds) ? source.processedWebhookIds : [],
    updatedAt: source.updatedAt || null,
  };
  const report = { total: 0, changed: 0, unchanged: 0, failed: [], fixturesSkipped: [], notes: [] };

  for (const [contactId, record] of Object.entries(contacts)) {
    report.total += 1;
    // A fixture id must never live in the production store. Preserve it so
    // nothing is destroyed, but flag it loudly.
    if (isFixtureContactId(contactId)) {
      out.contacts[contactId] = record;
      report.fixturesSkipped.push(contactId);
      continue;
    }
    try {
      const { record: migrated, changed, notes } = migrateContactRecord(record, { now });
      out.contacts[contactId] = migrated;
      if (changed) { report.changed += 1; report.notes.push(...notes); } else { report.unchanged += 1; }
    } catch (error) {
      out.contacts[contactId] = record;
      report.failed.push({ contactId, error: error.message });
    }
  }
  return { store: out, report };
}

/** Read one contact's ledger record. Never creates. */
function getContactRecord(store, contactId) {
  const id = String(contactId || '').trim();
  if (!id) return null;
  return store?.contacts?.[id] || null;
}

/**
 * Insert or replace one entitlement on a contact, keyed by type+key.
 *
 * Refuses to write fixture ids into a store that is not a fixture store, which
 * is the mechanism that keeps synthetic profiles out of production data.
 */
function upsertEntitlement(store, contactId, entitlement, { now = new Date(), allowFixtures = false } = {}) {
  const id = String(contactId || '').trim();
  if (!id) throw new Error('contactId is required');
  if (isFixtureContactId(id) && !allowFixtures) {
    throw new Error(`refusing to write fixture contact ${id} into a production ledger`);
  }
  const normalized = normalizeEntitlement(entitlement, { now });
  if (!normalized) throw new Error('invalid entitlement record');

  const record = store.contacts[id] || emptyContactRecord(id, now.toISOString());
  const list = Array.isArray(record.entitlements) ? record.entitlements : [];
  const identity = entitlementIdentity(normalized);
  const index = list.findIndex((item) => entitlementIdentity(item) === identity);
  if (index >= 0) list[index] = normalized; else list.push(normalized);

  record.entitlements = list;
  record.updatedAt = now.toISOString();
  store.contacts[id] = record;
  return normalized;
}

function setMembership(store, contactId, membership, { now = new Date(), allowFixtures = false } = {}) {
  const id = String(contactId || '').trim();
  if (!id) throw new Error('contactId is required');
  if (isFixtureContactId(id) && !allowFixtures) {
    throw new Error(`refusing to write fixture contact ${id} into a production ledger`);
  }
  const record = store.contacts[id] || emptyContactRecord(id, now.toISOString());
  record.membership = normalizeMembership(membership, { now });
  record.updatedAt = now.toISOString();
  store.contacts[id] = record;
  return record.membership;
}

export {
  LEDGER_VERSION,
  normalizeMembership,
  normalizeEntitlement,
  entitlementIdentity,
  emptyContactRecord,
  migrateContactRecord,
  migrateStore,
  getContactRecord,
  upsertEntitlement,
  setMembership,
};
