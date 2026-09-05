/**
 * The ingestion pipeline — the one and only way anything changes a member's
 * access.
 *
 *   proposed → validated → applied | shadow | rejected | unresolved
 *
 * Every source goes through here, including the operator. That is deliberate:
 * if Admin is just another adapter, then the whole pipeline is exercised by
 * ordinary daily work long before an external system is connected, and shadow
 * mode is not a separate simulation that can drift — it is this exact path with
 * the final apply withheld.
 *
 * A proposal is a claim, not a change. Nothing in this file writes to the
 * ledger until validation has passed AND the source is active.
 */

import { ENTITLEMENT_TYPES, MEMBERSHIP_ORDER, isFixtureContactId } from './config.js';
import {
  normalizeMembership, normalizeEntitlement, entitlementIdentity, emptyContactRecord,
} from './ledger.js';
import { decideOrder, watermark, noteRejection } from './ordering.js';
import { resolveIdentity, queueUnresolved, placeholderReason } from './identity.js';
import { getSource, noteOutcome } from './sources.js';
import { audit } from './audit-log.js';

const PROPOSAL_STATES = ['proposed', 'validated', 'applied', 'shadow', 'rejected', 'unresolved'];
const CONFIDENCE = ['authoritative', 'advisory'];
const INTENT_TYPES = ['membership', 'membership_absent', 'entitlement', 'entitlement_absent'];

const MAX_PROPOSALS = 1000;

const clean = (value, max = 200) => String(value ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);
const isoOrNull = (value) => {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/**
 * Normalize an incoming claim into the envelope every source shares.
 *
 * `occurredAt` is when the SOURCE says it happened; `observedAt` is when it
 * reached us. Keeping both is what lets ordering distinguish a genuinely older
 * event from one that merely arrived late.
 */
function normalizeProposal(input = {}, { now = new Date() } = {}) {
  const source = clean(input.source, 40);
  const intentType = clean(input.intentType, 40);
  if (!source) return { ok: false, reason: 'source_required' };
  if (!INTENT_TYPES.includes(intentType)) return { ok: false, reason: 'unknown_intent_type' };

  const occurredAt = isoOrNull(input.occurredAt);
  const observedAt = isoOrNull(input.observedAt) || now.toISOString();

  return {
    ok: true,
    proposal: {
      id: clean(input.id, 120) || `p-${source}-${observedAt}-${clean(input.sourceEventId, 60) || Math.abs(hash(JSON.stringify(input.intent || {})))}`,
      source,
      mode: clean(input.mode, 20) || null,          // filled from the registry
      sourceEventId: clean(input.sourceEventId, 120) || null,
      sourceEntityId: clean(input.sourceEntityId, 120) || null,
      intentType,
      identity: input.identity && typeof input.identity === 'object' ? input.identity : {},
      contactId: clean(input.contactId, 120) || null,
      occurredAt,
      observedAt,
      // No source timestamp is not an error — it is a fact about the source,
      // and ordering downgrades confidence rather than rejecting the event.
      timeBasis: occurredAt ? 'source' : 'arrival',
      intent: input.intent && typeof input.intent === 'object' ? input.intent : {},
      // An explicit sequence beats timestamps in decideOrder. Sources that can
      // order their own events supply one; two actions in the same millisecond
      // are otherwise unorderable, and a random tie-break would be a coin flip.
      sequence: Number.isFinite(Number(input.sequence)) ? Number(input.sequence) : null,
      evidence: input.evidence && typeof input.evidence === 'object' ? input.evidence : {},
      confidence: CONFIDENCE.includes(input.confidence) ? input.confidence : 'authoritative',
      note: clean(input.note, 300),
      actor: clean(input.actor, 80) || 'system',
      state: 'proposed',
      reason: null,
      diff: null,
      lowConfidence: false,
    },
  };
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) { h = ((h << 5) - h + text.charCodeAt(i)) | 0; }
  return h;
}

/** The resource a proposal competes for. Ordering is per resource, not global. */
function proposalResourceKey(proposal) {
  if (proposal.intentType.startsWith('membership')) return 'membership';
  const type = clean(proposal.intent?.type, 40);
  const key = clean(proposal.intent?.key, 120);
  // Must match entitlementIdentity() exactly — this string is both the ordering
  // watermark key and the lookup used to find the record being replaced.
  return `${type}::${key}`;
}

/**
 * Is a manual override still standing?
 *
 * An operator's deliberate decision — a comp, a correction, a temporary grant —
 * outranks any external source until it expires. Without this, the first
 * reconciliation sweep silently undoes every exception anyone made.
 */
function overrideActive(current, now) {
  if (!current?.override_until) return false;
  const until = Date.parse(current.override_until);
  return Number.isFinite(until) && until > now.getTime();
}

/** What this proposal would change, computed before anything is written. */
function computeDiff(record, proposal, { now = new Date() } = {}) {
  if (proposal.intentType === 'membership') {
    const from = record?.membership || null;
    const to = normalizeMembership({
      ...proposal.intent,
      source: proposal.intent.source || proposal.source,
      evidence_id: proposal.intent.evidence_id || proposal.evidence?.id || null,
    }, { now });
    const changed = !from
      || from.key !== to?.key
      || from.status !== to?.status
      || from.billing_cycle !== to?.billing_cycle;
    return { kind: 'membership', from, to, changed };
  }

  if (proposal.intentType === 'membership_absent') {
    const from = record?.membership || null;
    const changed = Boolean(from && from.status !== 'cancelled' && from.status !== 'expired');
    return {
      kind: 'membership',
      from,
      to: from ? { ...from, status: 'cancelled', ends_at: now.toISOString() } : null,
      changed,
    };
  }

  const identity = proposalResourceKey(proposal);
  const list = Array.isArray(record?.entitlements) ? record.entitlements : [];
  const from = list.find((item) => entitlementIdentity(item) === identity) || null;

  if (proposal.intentType === 'entitlement_absent') {
    const changed = Boolean(from && from.status === 'active');
    return {
      kind: 'entitlement',
      identity,
      from,
      to: from ? { ...from, status: 'revoked' } : null,
      changed,
    };
  }

  const to = normalizeEntitlement({
    ...proposal.intent,
    source: proposal.intent.source || proposal.source,
    evidence_id: proposal.intent.evidence_id || proposal.evidence?.id || null,
    observed_at: proposal.observedAt,
  }, { now });
  const changed = !from || from.status !== to?.status || JSON.stringify(from.value) !== JSON.stringify(to?.value);
  return { kind: 'entitlement', identity, from, to, changed };
}

/**
 * Validate a proposal against the ledger, the source registry and precedence.
 *
 * Returns the proposal with a terminal-or-validated state. It never mutates the
 * ledger; that is `applyProposal`'s job, and only for active sources.
 */
function validateProposal(store, proposal, { now = new Date() } = {}) {
  const fail = (state, reason, extra = {}) => Object.assign(proposal, { state, reason, ...extra });

  const source = getSource(store, proposal.source);
  if (!source) return fail('rejected', 'unknown_source');
  proposal.mode = source.mode;
  if (source.state === 'disabled') return fail('rejected', 'source_disabled');

  // ── idempotency ───────────────────────────────────────────────────────────
  //
  // For an EVENT source this is essential: a webhook redelivered twice must not
  // apply twice. For a SNAPSHOT source it is actively harmful. A snapshot does
  // not report events; it restates current truth on every run, with a stable id
  // for the same underlying subscription. Rejecting those restatements as
  // duplicates means the store can never converge on the truth again once it
  // has diverged from it — which is precisely what happened here: a membership
  // wrongly ended by a truncated snapshot could not be repaired by the next
  // fifty correct ones, because each was dismissed as something already seen.
  //
  // Snapshots have their own protections (ordering, and the absence guard
  // above). Re-applying an unchanged state is a no-op; re-applying a changed
  // one is the correction the mechanism exists to make.
  if (proposal.sourceEventId) {
    const seen = Array.isArray(store.processedWebhookIds) ? store.processedWebhookIds : [];
    const key = `${proposal.source}:${proposal.sourceEventId}`;
    if (seen.includes(key) || seen.includes(proposal.sourceEventId)) {
      if (source.mode !== 'snapshot') return fail('rejected', 'duplicate_source_event');
      // A snapshot restating what the store already holds is genuinely nothing
      // to do. A snapshot restating something DIFFERENT is the correction, and
      // must not be dismissed as a repeat.
      const held = store.contacts?.[proposal.contactId]?.membership || null;
      if (proposal.intentType === 'membership' && sameMembership(held, proposal.intent)) {
        return fail('rejected', 'duplicate_source_event');
      }
      if (proposal.intentType !== 'membership') {
        return fail('rejected', 'duplicate_source_event');
      }
    }
  }

  // ── identity ──────────────────────────────────────────────────────────────
  // A placeholder is refused even when an adapter hands us the id outright.
  // Admin is exempt: an operator correcting a counter sale by hand is exactly
  // how these are meant to be resolved.
  if (proposal.source !== 'admin') {
    const placeholder = placeholderReason({ ...proposal.identity, contactId: proposal.contactId });
    if (placeholder) return fail('unresolved', placeholder);
  }

  let contactId = proposal.contactId;
  if (!contactId) {
    const resolved = resolveIdentity(store, proposal.identity);
    if (resolved.confidence === 'ambiguous') {
      return fail('unresolved', 'ambiguous_identity', { candidates: resolved.candidates });
    }
    if (!resolved.contactId) return fail('unresolved', 'unknown_identity');
    // An unverified email match is a lead for an operator, never a resolution
    // strong enough to move somebody's paid access.
    if (resolved.confidence === 'advisory') {
      return fail('unresolved', 'identity_needs_confirmation', { candidates: [resolved.contactId] });
    }
    contactId = resolved.contactId;
    proposal.identityMethod = resolved.method;
  }
  if (isFixtureContactId(contactId)) return fail('rejected', 'fixture_contact');
  proposal.contactId = contactId;

  // ── shape ─────────────────────────────────────────────────────────────────
  if (proposal.intentType === 'membership' && !MEMBERSHIP_ORDER.includes(proposal.intent?.key)) {
    return fail('rejected', 'unknown_plan_key');
  }
  if (proposal.intentType === 'entitlement'
    && !Object.prototype.hasOwnProperty.call(ENTITLEMENT_TYPES, clean(proposal.intent?.type, 40))) {
    return fail('rejected', 'unknown_entitlement_type');
  }

  const record = store.contacts?.[contactId] || null;
  const resource = proposalResourceKey(proposal);

  // ── precedence: a standing manual override outranks every other source ────
  const current = proposal.intentType.startsWith('membership')
    ? record?.membership
    : (record?.entitlements || []).find((item) => entitlementIdentity(item) === resource);

  if (proposal.source !== 'admin' && overrideActive(current, now)) {
    return fail('rejected', 'manual_override_in_effect', {
      overrideUntil: current.override_until,
    });
  }

  // ── precedence: advisory evidence never displaces authoritative evidence ──
  if (proposal.confidence === 'advisory' && current && current.confidence !== 'advisory' && current.source !== 'advisory') {
    return fail('rejected', 'advisory_cannot_override_authoritative');
  }

  // ── ordering ──────────────────────────────────────────────────────────────
  const order = (record?.order && typeof record.order === 'object') ? record.order : {};
  const decision = decideOrder(
    {
      ms: Date.parse(proposal.occurredAt || proposal.observedAt),
      basis: proposal.timeBasis,
      eventId: proposal.sourceEventId || proposal.id,
      seq: proposal.sequence,
    },
    order[resource] || null,
  );
  if (!decision.accept) return fail('rejected', decision.reason, { comparison: decision.comparison });
  if (decision.lowConfidence) proposal.lowConfidence = true;
  proposal.orderReason = decision.reason;

  proposal.diff = computeDiff(record, proposal, { now });
  proposal.state = 'validated';
  return proposal;
}

/**
 * Name the change the way a person reading the history would name it.
 *
 * The envelope's intent type describes the mechanism; an operator scanning a
 * member's history wants to know that a course was granted and later revoked.
 */
function auditAction(proposal, diff) {
  if (diff.kind === 'membership') {
    const ended = diff.to && (diff.to.status === 'cancelled' || diff.to.status === 'expired');
    return ended ? 'membership.end' : 'membership.assign';
  }
  if (proposal.intentType === 'entitlement_absent') return 'entitlement.revoke';
  return diff.from ? 'entitlement.update' : 'entitlement.grant';
}

/** Write a validated proposal into the ledger. Only ever called for active sources. */
function applyProposal(store, proposal, { now = new Date() } = {}) {
  const contactId = proposal.contactId;
  if (!store.contacts[contactId]) store.contacts[contactId] = emptyContactRecord(contactId, now.toISOString());
  const record = store.contacts[contactId];
  const diff = proposal.diff;
  const resource = proposalResourceKey(proposal);

  if (diff.kind === 'membership') {
    if (diff.to) {
      record.membership = proposal.intentType === 'membership_absent'
        ? normalizeMembership({ ...record.membership, status: 'cancelled', ends_at: now.toISOString() }, { now })
        : diff.to;
      // Carry the operator's override forward: an admin action may set it, and
      // nothing else may clear it before it expires.
      if (proposal.intent?.override_until) record.membership.override_until = proposal.intent.override_until;
      else if (record.membership && diff.from?.override_until) {
        record.membership.override_until = diff.from.override_until;
        record.membership.override_reason = diff.from.override_reason || null;
      }
    }
  } else {
    const list = Array.isArray(record.entitlements) ? record.entitlements : [];
    const index = list.findIndex((item) => entitlementIdentity(item) === resource);
    if (proposal.intentType === 'entitlement_absent') {
      if (index >= 0) list[index] = { ...list[index], status: 'revoked', observed_at: now.toISOString() };
    } else if (diff.to) {
      const next = { ...diff.to };
      if (proposal.intent?.override_until) next.override_until = proposal.intent.override_until;
      else if (diff.from?.override_until) {
        next.override_until = diff.from.override_until;
        next.override_reason = diff.from.override_reason || null;
      }
      if (index >= 0) list[index] = next; else list.push(next);
    }
    record.entitlements = list;
  }

  // watermark, so a later stale event for this resource is refused
  if (!record.order || typeof record.order !== 'object') record.order = {};
  record.order[resource] = {
    ...watermark({
      ms: Date.parse(proposal.occurredAt || proposal.observedAt),
      basis: proposal.timeBasis,
      eventId: proposal.sourceEventId || proposal.id,
      seq: proposal.sequence,
      action: proposal.intentType,
      appliedAt: now.toISOString(),
    }),
    // Which registered source last wrote this resource. Distinct from the
    // record's own `source` enum, which describes provenance rather than
    // authorship — a snapshot may only end what it itself established.
    writtenBy: proposal.source,
  };
  record.updatedAt = now.toISOString();

  if (proposal.sourceEventId) {
    const seen = Array.isArray(store.processedWebhookIds) ? store.processedWebhookIds : [];
    seen.push(`${proposal.source}:${proposal.sourceEventId}`);
    store.processedWebhookIds = seen.slice(-5000);
  }

  audit(store, {
    at: now.toISOString(),
    actor: proposal.actor,
    source: proposal.source,
    action: auditAction(proposal, diff),
    contactId,
    note: proposal.note,
    detail: {
      resource,
      from: diff.from,
      to: diff.to,
      evidence: proposal.evidence,
      lowConfidence: proposal.lowConfidence || undefined,
    },
  });
  return proposal;
}

const MAX_KEPT = MAX_PROPOSALS;

/** Keep the proposal for review — this is the shadow-mode review surface. */
function recordProposal(store, proposal) {
  if (!Array.isArray(store.proposals)) store.proposals = [];
  store.proposals.push({
    id: proposal.id,
    at: proposal.observedAt,
    source: proposal.source,
    mode: proposal.mode,
    state: proposal.state,
    reason: proposal.reason,
    contactId: proposal.contactId,
    intentType: proposal.intentType,
    resource: proposalResourceKey(proposal),
    diff: proposal.diff,
    evidence: proposal.evidence,
    lowConfidence: Boolean(proposal.lowConfidence),
    candidates: proposal.candidates,
  });
  store.proposals = store.proposals.slice(-MAX_KEPT);
  return proposal;
}

/**
 * The single entry point. Normalize, validate, then either apply or — for a
 * source in shadow — record exactly what would have happened and change nothing.
 */
function ingest(store, input, { now = new Date() } = {}) {
  const normalized = normalizeProposal(input, { now });
  if (!normalized.ok) return { ok: false, reason: normalized.reason, proposal: null };
  const proposal = normalized.proposal;

  validateProposal(store, proposal, { now });

  if (proposal.state === 'unresolved') {
    queueUnresolved(store, {
      id: proposal.id, source: proposal.source, reason: proposal.reason,
      claim: proposal.identity, candidates: proposal.candidates, proposal,
    }, now);
    noteOutcome(store, proposal.source, 'unresolved', { now });
    recordProposal(store, proposal);
    return { ok: false, reason: proposal.reason, proposal, applied: false };
  }

  if (proposal.state === 'rejected') {
    if (proposal.contactId && store.contacts?.[proposal.contactId]) {
      noteRejection(store.contacts[proposal.contactId], {
        at: now.toISOString(), source: proposal.source,
        resource: proposalResourceKey(proposal), reason: proposal.reason,
      });
    }
    noteOutcome(store, proposal.source, 'rejected', { now });
    recordProposal(store, proposal);
    return { ok: false, reason: proposal.reason, proposal, applied: false };
  }

  const source = getSource(store, proposal.source);
  if (source.state === 'shadow') {
    proposal.state = 'shadow';
    noteOutcome(store, proposal.source, 'shadow', { now, lowConfidence: proposal.lowConfidence });
    recordProposal(store, proposal);
    return { ok: true, proposal, applied: false, shadow: true };
  }

  applyProposal(store, proposal, { now });
  proposal.state = 'applied';
  noteOutcome(store, proposal.source, 'applied', { now, lowConfidence: proposal.lowConfidence });
  recordProposal(store, proposal);
  return { ok: true, proposal, applied: true };
}

/**
 * A snapshot reconciliation.
 *
 * `observed` is the source's COMPLETE authoritative set for `scope`. Only for a
 * snapshot source does absence mean anything: a membership previously sourced
 * from this system and missing from the sweep has ended. For an event source
 * this function refuses to infer absence at all, because a webhook that never
 * arrived looks exactly like one that was never sent.
 */
/**
 * `applyAbsence` exists because absence is the dangerous half of a snapshot.
 *
 * A snapshot says two things: these exist, and — by omission — the rest do not.
 * The first is safe under any circumstances. The second is only true if the
 * snapshot is COMPLETE, and a paginated fetch that returns a short page for a
 * transient reason produces a snapshot that looks complete and is not.
 *
 * That is not hypothetical: a live member's Diamond membership was assigned at
 * 20:56 from a snapshot that saw all three of her subscriptions, and cancelled
 * at 21:12 as "absent" while the subscription was, and still is, active in GHL.
 * A truncated read cancelled a paying member.
 *
 * So the caller may withhold the absence pass when it cannot vouch for the
 * snapshot. Presences still apply — being told somebody exists is never unsafe.
 */
/**
 * Do these describe the same membership?
 *
 * Compared on the fields that decide access — tier, status, cycle, end date —
 * and not on timestamps a re-run naturally regenerates. Two records that differ
 * only in when they were written are the same fact.
 */
function sameMembership(a, b) {
  if (!a || !b) return false;
  return a.key === b.key
    && a.status === b.status
    && (a.billing_cycle || null) === (b.billing_cycle || null)
    && (a.ends_at || null) === (b.ends_at || null);
}

function reconcile(store, { source, observed = [], scope = 'membership', now = new Date(), actor = 'reconciler', applyAbsence = true } = {}) {
  const registered = getSource(store, source);
  if (!registered) return { ok: false, reason: 'unknown_source' };
  if (registered.state === 'disabled') return { ok: false, reason: 'source_disabled' };
  if (registered.mode !== 'snapshot') {
    return { ok: false, reason: 'absence_not_meaningful_for_event_source' };
  }

  const results = [];
  const present = new Set();
  for (const claim of observed) {
    const outcome = ingest(store, { ...claim, source, actor }, { now });
    if (outcome.proposal?.contactId) present.add(outcome.proposal.contactId);
    results.push(outcome);
  }

  // absence — only within the scope this sweep actually covered, and only when
  // the caller can vouch for the snapshot being complete.
  const absences = [];
  for (const [contactId, record] of Object.entries(store.contacts || {})) {
    if (!applyAbsence) break;
    if (present.has(contactId)) continue;
    if (scope !== 'membership') continue;
    const membership = record.membership;
    if (!membership) continue;
    // Only end what this source itself established. A GHL sweep has nothing to
    // say about a membership an operator granted by hand.
    if (record.order?.membership?.writtenBy !== source) continue;
    if (membership.status === 'cancelled' || membership.status === 'expired') continue;
    const outcome = ingest(store, {
      source,
      intentType: 'membership_absent',
      contactId,
      occurredAt: now.toISOString(),
      actor,
      note: `absent from ${source} snapshot`,
      evidence: { id: `sweep:${now.toISOString()}` },
    }, { now });
    absences.push(outcome);
  }

  return {
    ok: true,
    observed: results.length,
    applied: results.filter((r) => r.applied).length + absences.filter((r) => r.applied).length,
    shadow: results.filter((r) => r.shadow).length + absences.filter((r) => r.shadow).length,
    rejected: results.filter((r) => !r.ok).length,
    absences: absences.length,
    results,
    absenceResults: absences,
  };
}

/** Proposals kept for review, newest first. */
function proposalsFor(store, { source = '', state = '', contactId = '', limit = 200 } = {}) {
  return (store.proposals || [])
    .filter((p) => (!source || p.source === source)
      && (!state || p.state === state)
      && (!contactId || p.contactId === contactId))
    .slice(-limit)
    .reverse();
}

export {
  PROPOSAL_STATES,
  INTENT_TYPES,
  CONFIDENCE,
  normalizeProposal,
  validateProposal,
  applyProposal,
  computeDiff,
  proposalResourceKey,
  overrideActive,
  recordProposal,
  ingest,
  reconcile,
  proposalsFor,
};
