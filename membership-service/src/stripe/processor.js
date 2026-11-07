/**
 * Asynchronous webhook processor.
 *
 * Claims a bounded batch with FOR UPDATE SKIP LOCKED (several workers are
 * safe), leases each event, runs its handler in ONE transaction with the event
 * status update, and retries failures with exponential backoff up to
 * maxAttempts, then parks the event as 'dead' for a human. replay() puts any
 * event back in the queue (spec: "replayable").
 */
import { withTransaction } from '../db.js';
import { audit } from '../audit.js';
import { MembershipError } from '../errors.js';

export const DEFAULT_MAX_ATTEMPTS = 8;
const LEASE_MS = 10 * 60 * 1000;

async function claim(pool, { now, limit, provider }) {
  return (await pool.query(
    `UPDATE webhook_events SET status = 'processing', attempts = attempts + 1, next_attempt_at = $2
      WHERE id IN (SELECT id FROM webhook_events
                    WHERE provider = $4 AND next_attempt_at <= $1 AND status IN ('received', 'failed', 'processing')
                    ORDER BY provider_created_at NULLS LAST, received_at LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [now, new Date(now.getTime() + LEASE_MS), limit, provider])).rows
    // RETURNING has no order: process in provider time so a creating event runs before what depends on it.
    .sort((a, b) => (a.provider_created_at - b.provider_created_at) || (a.received_at - b.received_at));
}

/** handlers: { [eventType]: async (client, event, row) => 'processed' | 'ignored' } */
export async function processPending(pool, { handlers, provider = 'stripe', now = new Date(), limit = 20, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  const rows = await claim(pool, { now, limit, provider });
  const summary = { processed: 0, ignored: 0, failed: 0, dead: 0 };
  for (const row of rows) {
    const handler = handlers[row.event_type];
    try {
      const outcome = await withTransaction(pool, async (c) => {
        const result = handler ? await handler(c, row.payload, row) : 'ignored';
        const status = result === 'ignored' ? 'ignored' : 'processed';
        await c.query("UPDATE webhook_events SET status = $2, processed_at = $3, last_error = NULL WHERE id = $1", [row.id, status, now]);
        return status;
      });
      summary[outcome]++;
    } catch (e) {
      // A business-rule refusal will not change on retry: park it for a human at once.
      const permanent = e instanceof MembershipError && e.code !== 'PROVIDER_UNAVAILABLE';
      const dead = permanent || row.attempts >= maxAttempts;
      const delayMs = Math.min(2 ** row.attempts * 30000, 6 * 3600 * 1000);
      await pool.query('UPDATE webhook_events SET status = $2, last_error = $3, next_attempt_at = $4 WHERE id = $1',
        [row.id, dead ? 'dead' : 'failed', String(e.code ? `${e.code}: ${e.message}` : e.message).slice(0, 500), new Date(now.getTime() + delayMs)]);
      summary[dead ? 'dead' : 'failed']++;
    }
  }
  return summary;
}

/** Events needing a human: dead letters, newest first (for an ops alert / admin view). */
export async function deadLetters(db, { provider = 'stripe', limit = 50 } = {}) {
  return (await db.query("SELECT id, event_id, event_type, attempts, last_error, received_at FROM webhook_events WHERE provider = $1 AND status = 'dead' ORDER BY received_at DESC LIMIT $2", [provider, limit])).rows;
}

export async function replay(pool, webhookEventId, actor) {
  return withTransaction(pool, async (c) => {
    // Never while a worker holds it, or it could run twice at once.
    const r = await c.query(`UPDATE webhook_events SET status = 'received', next_attempt_at = now(), attempts = 0
                              WHERE id = $1 AND status IN ('processed', 'ignored', 'failed', 'dead') RETURNING event_id`, [webhookEventId]);
    if (!r.rowCount) return false;
    await audit(c, { ...actor, action: 'webhook.replay', entityType: 'webhook_event', entityId: webhookEventId });
    return true;
  });
}
