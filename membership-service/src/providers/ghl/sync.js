/**
 * Push one person's Gaia membership state to their GHL contact (one-way).
 *
 *   1. evaluate Gaia entitlements (the truth) -> desiredGhlState()
 *   2. find the contact: a linked identity ('ghl', 'contact') first, else an
 *      exact email search. Several contacts for one email are REPORTED (dead
 *      letter 'duplicate_contacts'), never merged and never guessed between;
 *   3. apply the diff (tags under the Gaia prefix, allowlisted fields);
 *   4. a failure after the HTTP layer's bounded retries is a dead-letter
 *      record for a human; a later successful sync resolves it.
 *
 * Nothing here reads or writes GHL subscriptions or payments.
 */
import { evaluate } from '../../entitlements.js';
import { linkIdentity, identitiesOf } from '../../identity.js';
import { fail } from '../../errors.js';
import { desiredGhlState, diffGhlState, DEFAULT_TAG_PREFIX } from './desired-state.js';

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

/**
 * syncPersonToGhl({ pool, ghl, deadLetters, prefix, fieldIds, now }, personId)
 * -> { status: 'synced' | 'no_contact' | 'dead_letter', contactId?, addTags, removeTags, fieldUpdates, unmappedFields, reason? }
 */
export async function syncPersonToGhl({ pool, ghl, deadLetters = pgDeadLetterStore(pool), prefix = DEFAULT_TAG_PREFIX, fieldIds = {}, now = new Date() }, personId) {
  const evaluation = await evaluate(pool, personId, now);
  const desired = desiredGhlState(evaluation, { prefix, cancelScheduled: await cancelScheduled(pool, personId, now) });
  const ids = await identitiesOf(pool, personId);
  const linked = ids.filter((i) => i.platform === 'ghl' && i.kind === 'contact').map((i) => i.external_id);
  const email = ids.find((i) => i.platform === 'email')?.external_id || null;
  const dead = async (reason, extra = {}) => {
    await deadLetters.record({ personId, reason, ...extra });
    return { status: 'dead_letter', reason, ...(extra.contactId ? { contactId: extra.contactId } : {}), desired };
  };

  let contact;
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

    const diff = diffGhlState(contact, desired, { prefix, fieldIds });
    await ghl.addTags(contact.id, diff.addTags);
    await ghl.removeTags(contact.id, diff.removeTags);
    await ghl.updateCustomFields(contact.id, diff.fieldUpdates);
    await deadLetters.resolveOpen(personId, 'ghl-sync');
    return { status: 'synced', contactId: contact.id, ...diff, desired };
  } catch (e) {
    if (!e?.code) throw e;
    return dead(reasonFor(e), { contactId: contact?.id || null, errorCode: e.code, details: { status: e.details?.status ?? null } });
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
