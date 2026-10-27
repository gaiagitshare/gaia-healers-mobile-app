/**
 * Webhook ingestion: verify -> persist -> acknowledge. Processing happens later
 * (processor.js), so the HTTP handler answers fast and a crash between receipt
 * and processing loses nothing (spec §10, §17).
 *
 * Live-mode events are refused unless explicitly enabled: there is no live
 * Stripe integration yet, and a stray live event must never move state.
 */
import crypto from 'node:crypto';
import { verifyStripeSignature } from './signature.js';

/**
 * Returns an HTTP-shaped result: { status, body }.
 *   400 bad signature / body; 200 accepted or duplicate (Stripe must not retry those).
 */
export async function ingestStripeWebhook(pool, { rawBody, signatureHeader, secrets, now = Date.now(), allowLivemode = false, toleranceSec }) {
  const v = verifyStripeSignature({ rawBody, header: signatureHeader, secrets, now, toleranceSec });
  if (!v.ok) return { status: 400, body: { ok: false, reason: v.reason } };
  let event;
  try { event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody); } catch { return { status: 400, body: { ok: false, reason: 'invalid_json' } }; }
  if (!event || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9_]{1,200}$/.test(event.id) || typeof event.type !== 'string') {
    return { status: 400, body: { ok: false, reason: 'not_a_stripe_event' } };
  }
  if (event.livemode === true && !allowLivemode) return { status: 400, body: { ok: false, reason: 'livemode_not_enabled' } };
  const sha = crypto.createHash('sha256').update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)).digest('hex');
  const r = await pool.query(
    `INSERT INTO webhook_events (provider, event_id, event_type, livemode, provider_created_at, payload, payload_sha256)
     VALUES ('stripe', $1, $2, $3, to_timestamp($4), $5, $6)
     ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    [event.id, event.type, event.livemode === true, Number(event.created) || v.timestamp, event, sha]);
  return { status: 200, body: { ok: true, duplicate: r.rowCount === 0 } };
}
