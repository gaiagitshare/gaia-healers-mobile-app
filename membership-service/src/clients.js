/**
 * Service clients of the internal API. A token is shown once at creation and
 * stored only as SHA-256; lookups are by hash, so there is no string compare of
 * secrets. Revocation is immediate.
 */
import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { audit } from './audit.js';
import { fail } from './errors.js';

export const SCOPES = ['identity:read', 'subscriptions:read', 'entitlements:read', 'wallet:read', 'coins:quote', 'coins:debit'];
export const TENANT_SCOPES = ['subscriptions:read', 'entitlements:read'];
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export async function createClient(pool, { name, scopes, practitionerId = null }, createdBy) {
  if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !SCOPES.includes(s))) fail('INVALID_INPUT', 'unknown scope');
  if (practitionerId && scopes.some((s) => !TENANT_SCOPES.includes(s))) fail('FORBIDDEN', 'tenant-scoped clients get read scopes only');
  if (!createdBy) fail('INVALID_INPUT', 'createdBy is required');
  const token = 'gms_' + crypto.randomBytes(32).toString('base64url');
  return withTransaction(pool, async (c) => {
    const r = await c.query('INSERT INTO api_clients (name, token_sha256, scopes, practitioner_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name, sha(token), scopes, practitionerId, createdBy]);
    await audit(c, { actorType: 'admin', actorId: createdBy, action: 'api_client.create', entityType: 'api_client', entityId: r.rows[0].id, after: { name, scopes, practitionerId } });
    return { id: r.rows[0].id, token };
  });
}

export async function revokeClient(pool, id, revokedBy) {
  return withTransaction(pool, async (c) => {
    const r = await c.query('UPDATE api_clients SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id', [id]);
    if (r.rowCount) await audit(c, { actorType: 'admin', actorId: revokedBy, action: 'api_client.revoke', entityType: 'api_client', entityId: id });
    return r.rowCount === 1;
  });
}

/** Bearer token -> active client or null. */
export async function authenticate(db, authorizationHeader) {
  const m = /^Bearer (gms_[A-Za-z0-9_-]{43})$/.exec(String(authorizationHeader || ''));
  if (!m) return null;
  const r = await db.query('SELECT id, name, scopes, practitioner_id FROM api_clients WHERE token_sha256 = $1 AND revoked_at IS NULL', [sha(m[1])]);
  return r.rows[0] || null;
}
