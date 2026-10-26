/**
 * Push one person's Gaia membership state to their GHL contact (one-way).
 *
 *   1. evaluate Gaia entitlements (the truth) -> desiredGhlState()
 *   2. find the contact: a linked identity ('ghl', 'contact') first, else an
 *      exact email search. Several contacts for one email are REPORTED (dead
 *      letter 'duplicate_contacts'), never merged and never guessed between;
 *   3. apply the diff in a safe order: allowlisted fields first (so
 *      `gaia_membership_access_until` is final before any workflow fires),
 *      then REMOVE old Gaia tags, then ADD new ones. A downgrade or upgrade
 *      therefore never leaves both tiers' tags set: if the removal fails,
 *      nothing is added;
 *   4. a failure after the HTTP layer's bounded retries is a dead-letter
 *      record for a human; one that stops after some writes succeeded is a
 *      'partial_apply' dead letter. Every run recomputes the diff from the
 *      contact's CURRENT tags, so a re-run resumes exactly where it stopped
 *      (idempotent), and a later successful sync resolves the dead letter;
 *   5. only `gaia-m:` tags are ever sent (checked again right before the
 *      write); `ahc-*` and every other foreign tag are never added or removed;
 *   6. legacy GHL-billed memberships (legacy_memberships, mapped rows) add
 *      `gaia-m:legacy:<tier>` while GHL reports them live; never `tier:*`;
 *   7. with a benefit map, each mapped tag change records an expected GHL
 *      grant / revoke for confirmation tracking (grants.js).
 *
 * Nothing here reads or writes GHL subscriptions or payments.
 */
import { evaluate } from '../../entitlements.js';
import { linkIdentity, identitiesOf } from '../../identity.js';
import { fail } from '../../errors.js';
import { desiredGhlState, diffGhlState, DEFAULT_TAG_PREFIX } from './desired-state.js';
import { classifyStatus, LIVE_STATUSES, ENDED_STATUSES } from './legacy-config.js';
import { expectedGrantsFor, recordExpectedGrants } from './grants.js';

export const MAX_BATCH = 200;

/** Dead letters in Postgres (ghl_sync_dead_letters, migration 0003). */
export function pgDeadLetterStore(pool) {
  return {
    async record({ personId, contactId = null, reason, errorCode = null, details = {} }) {
      await pool.query(
        `INSERT INTO ghl_sync_dead_letters (person_id, contact_id, reason, error_code, details)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (person_id, reason) WHERE status = 'open'
         DO UPDATE SET attempts = ghl_sync_dead_letters.attempts + 1, last_seen_at = now(),
                       contact_id = EXCLUDED.contact_id, error_code = EXCLUDED.error_code, details = EXCLUDED.details`,
        [personId, contactId, reason, errorCode, JSON.stringify(details)]);
    },
    async resolveOpen(personId, by) {
      const r = await pool.query("UPDATE ghl_sync_dead_letters SET status = 'resolved', resolved_at = now(), resolved_by = $2 WHERE person_id = $1 AND status = 'open'", [personId, by]);
      return r.rowCount;
    },
    async listOpen() {
      return (await pool.query("SELECT * FROM ghl_sync_dead_letters WHERE status = 'open' ORDER BY first_seen_at")).rows;
    },
  };
}

/** Same interface in memory (unit tests, dry runs). */
export function memoryDeadLetterStore() {
  const rows = [];
  return {
    rows,
    async record(e) {
      const open = rows.find((r) => r.person_id === e.personId && r.reason === e.reason && r.status === 'open');
      if (open) { open.attempts++; Object.assign(open, { contact_id: e.contactId ?? null, error_code: e.errorCode ?? null, details: e.details || {} }); return; }
      rows.push({ person_id: e.personId, contact_id: e.contactId ?? null, reason: e.reason, error_code: e.errorCode ?? null, details: e.details || {}, attempts: 1, status: 'open' });
    },
    async resolveOpen(personId, by) { let n = 0; for (const r of rows) if (r.person_id === personId && r.status === 'open') { r.status = 'resolved'; r.resolved_by = by; n++; } return n; },
    async listOpen() { return rows.filter((r) => r.status === 'open'); },
  };
}

const reasonFor = (e) => (e?.code === 'PROVIDER_UNAVAILABLE' ? 'provider_unavailable' : e?.code === 'CONFLICT' ? 'identity_conflict' : 'rejected');

async function cancelScheduled(db, personId, now) {
  return (await db.query(
    `SELECT EXISTS (SELECT 1 FROM subscriptions WHERE person_id = $1 AND status IN ('trialing', 'active', 'past_due')
                      AND cancel_at IS NOT NULL AND cancel_at > $2) AS x`, [personId, now])).rows[0].x;
}

/** Legacy tiers for the desired state: live-reported -> tag; unknown status -> hold (neither added nor removed). */
export async function legacyTiersOf(db, personId, { liveStatuses = LIVE_STATUSES, endedStatuses = ENDED_STATUSES } = {}) {
  const rows = (await db.query("SELECT tier, reported_status FROM legacy_memberships WHERE person_id = $1 AND mapping = 'mapped' AND tier IS NOT NULL", [personId])).rows;
  const live = new Set(); const hold = new Set();
  for (const r of rows) {
    const c = classifyStatus(r.reported_status, { live: liveStatuses, ended: endedStatuses });
    if (c === 'live') live.add(r.tier); else if (c === 'unknown') hold.add(r.tier);
  }
  return { live: [...live].sort(), hold: [...hold].filter((t) => !live.has(t)).sort() };
}

/** Gaia's desired GHL state for one person (the truth side of sync and reconcile). */
export async function desiredForPerson(pool, personId, { prefix = DEFAULT_TAG_PREFIX, now = new Date(), legacyStatuses } = {}) {
  const evaluation = await evaluate(pool, personId, now);
  return desiredGhlState(evaluation, { prefix, cancelScheduled: await cancelScheduled(pool, personId, now), legacy: await legacyTiersOf(pool, personId, legacyStatuses) });
}

function assertOwnTags(tags, prefix) {
  const bad = tags.filter((t) => !String(t).toLowerCase().startsWith(prefix));
  if (bad.length) fail('FORBIDDEN', `refusing to write ${bad.length} tag(s) outside the ${prefix} prefix`);
}

/**
 * syncPersonToGhl({ pool, ghl, deadLetters, prefix, fieldIds, fieldResolver, benefitMap, now }, personId)
 *   fieldResolver: field-ids.js resolver; when given it replaces the static fieldIds
 *   benefitMap: validated grants.js map; when given, mapped tag changes are recorded as expected grants
 * -> { status: 'synced' | 'no_contact' | 'dead_letter', contactId?, addTags, removeTags, fieldUpdates, unmappedFields, reason? }
 */
export async function syncPersonToGhl({ pool, ghl, deadLetters = pgDeadLetterStore(pool), prefix = DEFAULT_TAG_PREFIX, fieldIds = {}, fieldResolver = null, benefitMap = null, legacyStatuses, now = new Date() }, personId) {
  const desired = await desiredForPerson(pool, personId, { prefix, now, legacyStatuses });
  const ids = await identitiesOf(pool, personId);
  const linked = ids.filter((i) => i.platform === 'ghl' && i.kind === 'contact').map((i) => i.external_id);
  const email = ids.find((i) => i.platform === 'email')?.external_id || null;
  const dead = async (reason, extra = {}) => {
    await deadLetters.record({ personId, reason, ...extra });
    return { status: 'dead_letter', reason, ...(extra.contactId ? { contactId: extra.contactId } : {}), desired };
  };

  let contact;
  const applied = [];
  try {
    if (linked.length > 1) return await dead('duplicate_contacts', { details: { contactIds: linked, via: 'identities' } });
    if (linked.length === 1) {
      try { contact = await ghl.getContact(linked[0]); } catch (e) {
        if (e.code === 'NOT_FOUND') return await dead('contact_missing', { contactId: linked[0], errorCode: 'NOT_FOUND' });
        throw e;
      }
    } else {
      if (!email) return { status: 'no_contact', desired };
      const found = await ghl.findContactsByEmail(email);
      if (found.length === 0) return { status: 'no_contact', desired };
      if (found.length > 1) return await dead('duplicate_contacts', { details: { contactIds: found.map((c) => c.id).sort(), via: 'email' } });
      contact = found[0];
      try {
        await linkIdentity(pool, personId, { platform: 'ghl', kind: 'contact', externalId: contact.id }, { linkedBy: 'ghl-sync', evidence: { matchedBy: 'exact_email' } });
      } catch (e) {
        if (e.code === 'CONFLICT') return await dead('identity_conflict', { contactId: contact.id, errorCode: 'CONFLICT' });
        throw e;
      }
    }

    const ids = fieldResolver ? (await fieldResolver.resolve()).fieldIds : fieldIds;
    const diff = diffGhlState(contact, desired, { prefix, fieldIds: ids });
    assertOwnTags([...diff.addTags, ...diff.removeTags], prefix);
    if (diff.fieldUpdates.length) { await ghl.updateCustomFields(contact.id, diff.fieldUpdates); applied.push('fields'); }
    if (diff.removeTags.length) { await ghl.removeTags(contact.id, diff.removeTags); applied.push('remove_tags'); }
    if (diff.addTags.length) { await ghl.addTags(contact.id, diff.addTags); applied.push('add_tags'); }
    if (benefitMap) {
      const expected = expectedGrantsFor(diff, benefitMap);
      if (expected.length) await recordExpectedGrants(pool, { personId, contactId: contact.id, expected, now });
    }
    await deadLetters.resolveOpen(personId, 'ghl-sync');
    return { status: 'synced', contactId: contact.id, ...diff, desired };
  } catch (e) {
    if (!e?.code) throw e;
    const reason = applied.length ? 'partial_apply' : reasonFor(e);
    return dead(reason, { contactId: contact?.id || null, errorCode: e.code, details: { status: e.details?.status ?? null, ...(applied.length ? { applied } : {}) } });
  }
}

/** Sequential batch with a hard cap: a list above it is refused, not trimmed. */
export async function syncPeopleToGhl(deps, personIds, { max = MAX_BATCH } = {}) {
  if (!Array.isArray(personIds)) fail('INVALID_INPUT', 'personIds must be an array');
  if (personIds.length > max) fail('INVALID_INPUT', `batch of ${personIds.length} exceeds the cap of ${max}`);
  const summary = { synced: 0, no_contact: 0, dead_letter: 0, results: [] };
  for (const id of personIds) {
    const r = await syncPersonToGhl(deps, id);
    summary[r.status]++;
    summary.results.push({ personId: id, status: r.status, reason: r.reason });
  }
  return summary;
}
