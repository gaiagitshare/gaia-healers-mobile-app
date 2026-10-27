/**
 * Append-only audit trail (audit_logs refuses UPDATE/DELETE). Always called inside the caller's transaction.
 *
 * `reason` is stored on the row itself (migration 0012). Control Center actions
 * run inside withAuditReason(reason, fn), so every row written while the action
 * runs (the domain rows too: coins, launch, pilot list, offers, subscriptions)
 * carries the operator's written reason without each module passing it along.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const reasonStore = new AsyncLocalStorage();
export const withAuditReason = (reason, fn) => reasonStore.run({ reason: reason ?? null }, fn);

export async function audit(client, { actorType = 'system', actorId = 'system', action, entityType, entityId, before = null, after = null, requestId = null, reason }) {
  const why = reason !== undefined && reason !== null && reason !== '' ? reason : (reasonStore.getStore()?.reason ?? null);
  await client.query(
    `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, before, after, request_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [actorType, String(actorId), action, entityType, String(entityId), before && JSON.stringify(before), after && JSON.stringify(after), requestId,
      why == null ? null : String(why).slice(0, 4000)],
  );
}
