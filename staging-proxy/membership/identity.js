/**
 * Identity resolution — turning an external system's idea of a person into a
 * Gaia contact.
 *
 * The ledger is keyed by GHL contactId because that is what every existing
 * record, session and URL already uses. External sources arrive with their own
 * identifiers, so each contact carries an `identities` map recording which
 * external ids are known to be the same person, and where that knowledge came
 * from.
 *
 * The rule that matters: an identifier either matches exactly or it does not
 * match at all. Names are never compared, and an unverified email is a
 * suggestion for an operator rather than a resolution — handing one person's
 * paid access to another because two accounts share a display name is the
 * failure this module exists to prevent.
 */

const CONTROL = /[\x00-\x1F\x7F]/g;
const clean = (value, max = 200) => String(value ?? '').replace(CONTROL, '').trim().slice(0, max);
const lower = (value) => clean(value, 320).toLowerCase();

/** External identifier fields we know how to resolve, strongest first. */
const IDENTITY_FIELDS = ['ghl_contact_id', 'shopify_customer_id', 'stripe_customer_id', 'vendor_customer_id'];

const EMAIL_SHAPE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

function emptyIdentity(contactId, now) {
  return {
    contactId,
    emails: [],
    ghl_contact_id: contactId,   // the ledger key IS the GHL contact id today
    shopify_customer_id: null,
    stripe_customer_id: null,
    vendor_customer_id: null,
    updatedAt: now,
  };
}

/** Ensure the store has an identity map; the ledger key seeds its own entry. */
function identityFor(store, contactId, now = new Date()) {
  const id = clean(contactId, 120);
  if (!id) return null;
  if (!store.identities || typeof store.identities !== 'object') store.identities = {};
  if (!store.identities[id]) store.identities[id] = emptyIdentity(id, now.toISOString());
  return store.identities[id];
}

/**
 * Record an external identifier against a contact.
 *
 * `verified` separates "the source told us this id belongs to this person"
 * from "these two records happen to share an email". Only verified links are
 * used to resolve later events automatically.
 */
function linkIdentity(store, contactId, { field, value, email, verified = false, source = 'manual' } = {}, now = new Date()) {
  const identity = identityFor(store, contactId, now);
  if (!identity) return { ok: false, reason: 'contact_id_required' };

  if (email) {
    const address = lower(email);
    if (!EMAIL_SHAPE.test(address)) return { ok: false, reason: 'invalid_email' };
    const existing = identity.emails.find((e) => e.address === address);
    if (existing) {
      existing.verified = existing.verified || Boolean(verified);
      existing.source = source;
    } else {
      identity.emails.push({ address, verified: Boolean(verified), source });
    }
    identity.updatedAt = now.toISOString();
    return { ok: true, identity };
  }

  if (!IDENTITY_FIELDS.includes(field)) return { ok: false, reason: 'unknown_identity_field' };
  const id = clean(value, 120);
  if (!id) return { ok: false, reason: 'identity_value_required' };

  // The same external id must never point at two contacts.
  const clash = Object.values(store.identities)
    .find((item) => item.contactId !== contactId && item[field] === id);
  if (clash) return { ok: false, reason: 'identity_already_linked', contactId: clash.contactId };

  identity[field] = id;
  identity.updatedAt = now.toISOString();
  return { ok: true, identity };
}

/**
 * Resolve an incoming identity claim to a contact.
 *
 * Returns { contactId, method, confidence }. `confidence: 'ambiguous'` means an
 * operator must decide — the caller must not apply anything on that basis.
 */
function resolveIdentity(store, claim = {}, { allowEmailFallback = true } = {}) {
  const identities = (store.identities && typeof store.identities === 'object') ? store.identities : {};
  const contacts = (store.contacts && typeof store.contacts === 'object') ? store.contacts : {};

  // 1. an exact external id we have already linked
  for (const field of IDENTITY_FIELDS) {
    const wanted = clean(claim[field], 120);
    if (!wanted) continue;
    const hit = Object.values(identities).find((item) => item[field] === wanted);
    if (hit) return { contactId: hit.contactId, method: field, confidence: 'exact' };
  }

  // 2. a GHL contact id that is already a ledger key, even with no identity row
  const ghlId = clean(claim.ghl_contact_id, 120);
  if (ghlId && contacts[ghlId]) {
    return { contactId: ghlId, method: 'ledger_key', confidence: 'exact' };
  }

  // 3. email — deliberately weaker. An address that resolves to exactly one
  //    contact is a lead, not a verdict: unverified matches stay advisory so a
  //    shared or recycled address cannot silently transfer access.
  if (allowEmailFallback) {
    const address = lower(claim.email);
    if (address && EMAIL_SHAPE.test(address)) {
      const matches = Object.values(identities)
        .filter((item) => item.emails.some((e) => e.address === address));
      if (matches.length === 1) {
        const verified = matches[0].emails.find((e) => e.address === address)?.verified;
        return {
          contactId: matches[0].contactId,
          method: 'email',
          confidence: verified ? 'exact' : 'advisory',
        };
      }
      if (matches.length > 1) {
        return { contactId: null, method: 'email', confidence: 'ambiguous', candidates: matches.map((m) => m.contactId) };
      }
    }
  }

  return { contactId: null, method: 'none', confidence: 'unresolved' };
}

/**
 * The unresolved queue.
 *
 * An event nobody can be identified for is kept whole, not logged and dropped.
 * A mapping or a link corrected on Tuesday can then recover Monday's events,
 * which is the difference between a queue and a regret.
 */
const MAX_UNRESOLVED = 500;

function queueUnresolved(store, entry, now = new Date()) {
  if (!Array.isArray(store.unresolved)) store.unresolved = [];
  const id = clean(entry.id, 120) || `unresolved-${store.unresolved.length + 1}`;
  const existing = store.unresolved.find((item) => item.id === id);
  if (existing) return existing;
  const record = {
    id,
    at: now.toISOString(),
    source: clean(entry.source, 40),
    reason: clean(entry.reason, 80),
    claim: entry.claim && typeof entry.claim === 'object' ? entry.claim : {},
    candidates: Array.isArray(entry.candidates) ? entry.candidates.slice(0, 10) : [],
    proposal: entry.proposal && typeof entry.proposal === 'object' ? entry.proposal : null,
  };
  store.unresolved.push(record);
  store.unresolved = store.unresolved.slice(-MAX_UNRESOLVED);
  return record;
}

function takeUnresolved(store, id) {
  if (!Array.isArray(store.unresolved)) return null;
  const index = store.unresolved.findIndex((item) => item.id === clean(id, 120));
  if (index < 0) return null;
  return store.unresolved.splice(index, 1)[0];
}

function unresolvedCount(store) {
  return Array.isArray(store.unresolved) ? store.unresolved.length : 0;
}

export {
  IDENTITY_FIELDS,
  identityFor,
  linkIdentity,
  resolveIdentity,
  queueUnresolved,
  takeUnresolved,
  unresolvedCount,
};
