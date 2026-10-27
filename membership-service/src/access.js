/**
 * Server-side authorization and tenant isolation for the internal API.
 *
 * Platform clients (no practitioner_id) may act for any person; they are trusted
 * services that authenticate their own users (e.g. the Gaia Healers proxy).
 * Tenant clients (practitioner_id set) see a person only if that person holds a
 * subscription to one of the tenant's plans, and then only those subscriptions
 * and the benefits they grant. Everything else is NOT_FOUND, so a tenant cannot
 * learn whether someone exists elsewhere.
 */
import { fail } from './errors.js';
import { audit } from './audit.js';
import { computeEntitlements, loadEntitlementInputs } from './entitlements.js';

export function actorOf(client, requestId) {
  return { actorType: client.practitioner_id ? 'partner' : 'system', actorId: 'client:' + client.name, requestId };
}

export async function deny(db, client, requestId, what) {
  await audit(db, { ...actorOf(client, requestId), action: 'api.denied', entityType: 'api_request', entityId: requestId || 'n/a', after: { what } });
}

export function requireScope(client, scope) {
  if (!client.scopes.includes(scope)) fail('FORBIDDEN', 'missing scope ' + scope);
}

export async function assertPersonVisible(db, client, personId) {
  if (!/^[0-9a-f-]{36}$/.test(String(personId))) fail('NOT_FOUND', 'person not found');
  const sql = client.practitioner_id
    ? `SELECT 1 FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
        WHERE s.person_id = $1 AND p.practitioner_id = $2 LIMIT 1`
    : 'SELECT 1 FROM persons WHERE id = $1';
  const r = await db.query(sql, client.practitioner_id ? [personId, client.practitioner_id] : [personId]);
  if (!r.rowCount) fail('NOT_FOUND', 'person not found');
}

export async function subscriptionsFor(db, client, personId) {
  const r = await db.query(
    `SELECT s.id, p.key AS plan_key, p.name AS plan_name, v.version AS plan_version, v.is_legacy, s.billing_interval, s.status, s.provider, s.source,
            s.trial_end, s.current_period_start, s.current_period_end, s.grace_until, s.cancel_at, s.canceled_at, s.ended_at
       FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
      WHERE s.person_id = $1 AND ($2::uuid IS NULL OR p.practitioner_id = $2)
      ORDER BY s.created_at`, [personId, client.practitioner_id]);
  return r.rows;
}

export async function entitlementsFor(db, client, personId, now) {
  const inputs = await loadEntitlementInputs(db, personId);
  if (client.practitioner_id) {
    const own = new Set((await db.query(
      `SELECT s.id FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
        WHERE s.person_id = $1 AND p.practitioner_id = $2`, [personId, client.practitioner_id])).rows.map((r) => r.id));
    inputs.subscriptions = inputs.subscriptions.filter((s) => own.has(s.id));
    inputs.grants = [];   // Gaia-side grants are not the tenant's business
  }
  return computeEntitlements(inputs, now);
}
