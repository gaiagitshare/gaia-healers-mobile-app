/**
 * Cross-platform identity mapping.
 *
 * A person is the Gaia-side anchor; each platform account (Gaia Healers GHL
 * contact, Gaia Practitioners account, Stripe customer, ...) is an identity row.
 * Gaia Practitioners keeps its own database: we only ever store its account id
 * here, as reported by the partner, never a copy of its data.
 *
 * Linking an external id that already belongs to another person is a CONFLICT.
 * The audit found GHL merges re-keying people and one Practitioners account
 * connected by several contacts; both must surface, never be resolved silently.
 */
import { withTransaction } from './db.js';
import { audit } from './audit.js';
import { fail } from './errors.js';

const PLATFORMS = new Set(['gaia_healers', 'gaia_practitioners', 'ghl', 'stripe', 'event_manager', 'email']);

function checkRef({ platform, kind, externalId }) {
  if (!PLATFORMS.has(platform)) fail('INVALID_INPUT', 'unknown platform');
  if (!kind || !/^[a-z][a-z_]{1,39}$/.test(kind)) fail('INVALID_INPUT', 'invalid identity kind');
  if (typeof externalId !== 'string' || !externalId.trim() || externalId.length > 200) fail('INVALID_INPUT', 'invalid external id');
  return { platform, kind, externalId: platform === 'email' ? externalId.trim().toLowerCase() : externalId.trim() };
}

export async function findPerson(db, ref) {
  const { platform, kind, externalId } = checkRef(ref);
  const r = await db.query(
    `SELECT p.id, p.status, p.merged_into FROM person_identities i JOIN persons p ON p.id = i.person_id
      WHERE i.platform = $1 AND i.kind = $2 AND i.external_id = $3`, [platform, kind, externalId]);
  return r.rows[0] || null;
}

/** Find the person owning this external id, or create one. Idempotent under concurrency. */
export async function resolveOrCreatePerson(pool, ref, { linkedBy = 'system', evidence = {}, verified = false } = {}) {
  const r = checkRef(ref);
  return withTransaction(pool, async (c) => {
    const existing = await findPerson(c, r);
    if (existing) return { personId: existing.id, created: false };
    const p = (await c.query('INSERT INTO persons DEFAULT VALUES RETURNING id')).rows[0];
    const ins = await c.query(
      `INSERT INTO person_identities (person_id, platform, kind, external_id, verified_at, linked_by, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (platform, kind, external_id) DO NOTHING RETURNING id`,
      [p.id, r.platform, r.kind, r.externalId, verified ? new Date() : null, linkedBy, JSON.stringify(evidence)]);
    if (!ins.rowCount) throw Object.assign(new Error('identity race'), { code: '40001' });   // lost the race: retry sees the winner
    await audit(c, { actorId: linkedBy, action: 'person.create', entityType: 'person', entityId: p.id, after: { platform: r.platform, kind: r.kind } });
    return { personId: p.id, created: true };
  });
}

/** Attach another platform identity to an existing person. */
export async function linkIdentity(pool, personId, ref, { linkedBy, evidence = {}, verified = false }) {
  const r = checkRef(ref);
  if (!linkedBy) fail('INVALID_INPUT', 'linkedBy is required');
  return withTransaction(pool, async (c) => {
    const owner = await findPerson(c, r);
    if (owner && owner.id === personId) return { linked: false, alreadyLinked: true };
    if (owner) fail('CONFLICT', 'this external identity already belongs to another person', { platform: r.platform, kind: r.kind });
    const p = (await c.query('SELECT status FROM persons WHERE id = $1 FOR UPDATE', [personId])).rows[0];
    if (!p) fail('NOT_FOUND', 'person not found');
    if (p.status === 'merged') fail('CONFLICT', 'person was merged');
    const ins = await c.query(
      `INSERT INTO person_identities (person_id, platform, kind, external_id, verified_at, linked_by, evidence) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (platform, kind, external_id) DO NOTHING`,
      [personId, r.platform, r.kind, r.externalId, verified ? new Date() : null, linkedBy, JSON.stringify(evidence)]);
    if (!ins.rowCount) fail('CONFLICT', 'this external identity was just linked to another person');
    await audit(c, { actorId: linkedBy, action: 'identity.link', entityType: 'person', entityId: personId, after: { platform: r.platform, kind: r.kind } });
    return { linked: true, alreadyLinked: false };
  });
}

export async function identitiesOf(db, personId) {
  return (await db.query(
    'SELECT platform, kind, external_id, verified_at, linked_by FROM person_identities WHERE person_id = $1 ORDER BY platform, kind', [personId])).rows;
}
