/**
 * The audit log — an append-only record of every change to a member's access,
 * with what it was before and what it became.
 *
 * Kept separate from the operations that write it so both the admin path and
 * the adapter pipeline can record into the same log without importing each
 * other. There is one history per member, regardless of which source acted.
 */

const MAX_AUDIT = 2000;

const clean = (value, max = 200) => String(value ?? '')
  .replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);

/**
 * Append an audit entry. The cap is generous because "why does this member
 * have access" is a question asked months after the fact.
 */
export function audit(store, entry) {
  const list = Array.isArray(store.auditLog) ? store.auditLog : [];
  list.push({
    at: entry.at || new Date().toISOString(),
    actor: clean(entry.actor, 80) || 'admin',
    action: clean(entry.action, 60),
    contactId: clean(entry.contactId, 120),
    source: clean(entry.source, 40) || 'admin',
    detail: entry.detail && typeof entry.detail === 'object' ? entry.detail : {},
    note: clean(entry.note, 300),
  });
  store.auditLog = list.slice(-MAX_AUDIT);
  return store.auditLog[store.auditLog.length - 1];
}

/** Audit entries for one contact, newest first. An empty id means every entry. */
export function auditFor(store, contactId, limit = 100) {
  const id = clean(contactId, 120);
  return (store.auditLog || [])
    .filter((entry) => !id || entry.contactId === id)
    .slice(-limit)
    .reverse();
}

export { clean as cleanText, MAX_AUDIT };
