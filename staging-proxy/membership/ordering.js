/**
 * Event ordering for the entitlement receiver.
 *
 * Webhooks arrive out of order. Before Phase 4 connects real GHL membership
 * transitions, the receiver has to guarantee that a revoke generated at 09:00
 * cannot delete a grant generated at 10:00 just because it was delivered second.
 *
 * The model is a per-resource watermark. Not per-domain: a single "courses"
 * timestamp would mean an event about course A silently blocks a legitimate
 * older-but-unseen event about course B. Each course, each community and the
 * membership carry their own last-accepted marker.
 *
 * Pure functions — no I/O, so the receiver and the tests exercise identical logic.
 */

/** Resource key for the watermark map. One entry per independently ordered right. */
export function resourceKey(kind, resource) {
  if (kind === 'tier' || kind === 'membership') return 'membership';
  if (kind === 'tags') return 'tags';
  if (kind === 'subscriptions') return 'subscriptions';
  const id = String(resource?.id || resource?.name || '').trim().toLowerCase();
  return `${kind}:${id}`;
}

/**
 * The moment the SOURCE says the event happened.
 *
 * Delivery time is not event time, so a source timestamp is always preferred.
 * Returns { ms, basis } where basis is 'source' when the event told us and
 * 'arrival' when we had to fall back to when it reached us.
 */
export function eventTimestamp(body, headers = {}, arrivalMs = Date.now()) {
  const candidates = [
    headers['x-ghl-event-time'], headers['x-event-time'],
    body?.timestamp, body?.occurredAt, body?.occurred_at, body?.eventTime, body?.event_time,
    body?.updatedAt, body?.updated_at, body?.createdAt, body?.created_at,
    body?.data?.timestamp, body?.data?.occurredAt, body?.data?.updatedAt,
    body?.customData?.timestamp, body?.customData?.occurredAt,
  ];
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    // Numeric epochs arrive as seconds or milliseconds depending on the sender.
    if (typeof candidate === 'number' || /^\d{10,13}$/.test(String(candidate))) {
      const numeric = Number(candidate);
      const ms = String(candidate).length <= 10 ? numeric * 1000 : numeric;
      if (Number.isFinite(ms)) return { ms, basis: 'source', raw: String(candidate) };
      continue;
    }
    const parsed = Date.parse(String(candidate));
    if (Number.isFinite(parsed)) return { ms: parsed, basis: 'source', raw: String(candidate) };
  }
  return { ms: arrivalMs, basis: 'arrival', raw: null };
}

/** A monotonically increasing sequence number, when the source provides one. */
export function eventSequence(body) {
  const candidates = [body?.sequence, body?.seq, body?.version, body?.data?.sequence];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

/**
 * Decide whether an incoming event may be applied to a resource.
 *
 * Returns { accept, reason, comparison }. `reason` is stored on rejection so
 * support can answer "why didn't this event take effect?" without guesswork.
 *
 * The rules, in order:
 *   1. A higher source sequence always wins; a lower one is stale.
 *   2. Otherwise compare timestamps on the SAME basis. Newer wins, older is
 *      rejected as stale.
 *   3. Exact ties resolve by event id, lexicographically, greater id wins.
 *      Arbitrary but deterministic and independent of arrival order — which is
 *      the property we actually need.
 *   4. Mixed basis (one side timed by the source, the other only by arrival)
 *      cannot be proven either way. The event is applied and flagged
 *      low-confidence rather than silently dropped: this is a mirror that
 *      nightly reconciliation corrects, and refusing real events would be the
 *      worse failure. Phase 4 must make GHL send timestamps so this path stops
 *      being reachable.
 */
export function decideOrder(incoming, stored) {
  if (!stored) return { accept: true, reason: 'first_event_for_resource', comparison: null };

  const comparison = {
    incoming: { at: incoming.ms, basis: incoming.basis, eventId: incoming.eventId, seq: incoming.seq ?? null },
    stored: { at: stored.atMs, basis: stored.basis, eventId: stored.eventId, seq: stored.seq ?? null },
  };

  // 1 — explicit sequence beats everything else
  if (Number.isFinite(incoming.seq) && Number.isFinite(stored.seq)) {
    if (incoming.seq > stored.seq) return { accept: true, reason: 'newer_sequence', comparison };
    if (incoming.seq < stored.seq) return { accept: false, reason: 'stale_sequence', comparison };
  }

  // 4 — bases disagree, ordering is not provable
  if (incoming.basis !== stored.basis) {
    return { accept: true, reason: 'unprovable_order_basis_mismatch', comparison, lowConfidence: true };
  }

  // 2 — same basis, compare time
  if (incoming.ms > stored.atMs) return { accept: true, reason: 'newer_timestamp', comparison };
  if (incoming.ms < stored.atMs) return { accept: false, reason: 'stale_timestamp', comparison };

  // 3 — exact tie
  const incomingId = String(incoming.eventId || '');
  const storedId = String(stored.eventId || '');
  if (incomingId === storedId) return { accept: false, reason: 'duplicate_event_id', comparison };
  if (incomingId > storedId) return { accept: true, reason: 'tie_broken_by_event_id', comparison };
  return { accept: false, reason: 'tie_lost_by_event_id', comparison };
}

/** The watermark to store after an event is accepted. */
export function watermark({ ms, basis, eventId, seq, action, appliedAt }) {
  return {
    atMs: ms,
    at: new Date(ms).toISOString(),
    basis,
    eventId: eventId || null,
    seq: Number.isFinite(seq) ? seq : null,
    action: action || null,
    appliedAt: appliedAt || new Date().toISOString(),
  };
}

const MAX_REJECTIONS = 20;

/** Record why an event was ignored, so the decision is explainable later. */
export function noteRejection(record, entry) {
  const list = Array.isArray(record.rejectedEvents) ? record.rejectedEvents : [];
  list.push(entry);
  record.rejectedEvents = list.slice(-MAX_REJECTIONS);
  return record;
}

/**
 * The newest accepted source time across every resource in a domain.
 * Used so a backfill snapshot cannot overwrite fresher live webhook evidence.
 */
export function domainWatermarkMs(record, kind) {
  const order = record?.order && typeof record.order === 'object' ? record.order : {};
  const prefix = kind === 'subscriptions' ? 'subscriptions' : `${kind}:`;
  let newest = 0;
  for (const [key, value] of Object.entries(order)) {
    const matches = kind === 'subscriptions' ? key === 'subscriptions' : key.startsWith(prefix);
    if (!matches) continue;
    const at = Number(value?.atMs) || 0;
    if (at > newest) newest = at;
  }
  return newest;
}
