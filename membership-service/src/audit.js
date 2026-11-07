/** Append-only audit trail (audit_logs refuses UPDATE/DELETE). Always called inside the caller's transaction. */
export async function audit(client, { actorType = 'system', actorId = 'system', action, entityType, entityId, before = null, after = null, requestId = null }) {
  await client.query(
    `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, before, after, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actorType, String(actorId), action, entityType, String(entityId), before && JSON.stringify(before), after && JSON.stringify(after), requestId],
  );
}
