/**
 * Partner (Gaia Practitioners) webhooks — CONTRACT PROPOSED, NOT CONFIRMED.
 *
 * Mirrors the Stripe approach exactly (src/stripe/signature.js, ingest.js):
 *   header  Gaia-Partner-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
 *   - verified over the RAW body, 5-minute tolerance, several secrets during rotation;
 *   - the event id is unique in webhook_events (provider 'partner'): a duplicate
 *     delivery is stored once and acknowledged;
 *   - verify -> validate -> persist -> 200. Processing happens later via
 *     processPending(pool, { provider: 'partner', handlers }).
 *
 * The event data is validated against src/partner/contract.js at the door, so
 * a malformed event is a 400 the partner sees, not a poison row in our queue.
 * An event only tells us something changed; the truth is re-read through the
 * read-only API (coins.changed carries no balance on purpose).
 */
import crypto from 'node:crypto';
import { verifyStripeSignature, computeSignature } from '../../stripe/signature.js';
import { validatePractitionerIdentity, validateSubscription } from '../../partner/contract.js';

export const SIGNATURE_HEADER = 'gaia-partner-signature';
export const PARTNER_EVENT_TYPES = Object.freeze(['subscription.updated', 'coins.changed', 'practitioner.status_changed']);

const EVENT_ID = /^[A-Za-z0-9_-]{8,200}$/;

function validateData(type, data) {
  const obj = data?.object;
  if (type === 'subscription.updated') validateSubscription(obj);
  else if (type === 'practitioner.status_changed') validatePractitionerIdentity(obj);
  else if (type === 'coins.changed') {
    if (!obj || typeof obj.practitioner_account_id !== 'string' || !obj.practitioner_account_id) throw new Error('coins.changed needs practitioner_account_id');
  }
}

export function verifyPartnerSignature({ rawBody, header, secrets, toleranceSec, now = Date.now() }) {
  return verifyStripeSignature({ rawBody, header, secrets, toleranceSec, now });
}

/** Test helper / partner reference implementation. */
export function signPartnerPayload(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}`;
}

/** HTTP-shaped: { status, body }. 400 for anything not verifiably ours; 200 accepted / duplicate. */
export async function ingestPartnerWebhook(pool, { rawBody, signatureHeader, secrets, now = Date.now(), toleranceSec }) {
  const v = verifyPartnerSignature({ rawBody, header: signatureHeader, secrets, now, toleranceSec });
  if (!v.ok) return { status: 400, body: { ok: false, reason: v.reason } };
  let event;
  try { event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody); } catch { return { status: 400, body: { ok: false, reason: 'invalid_json' } }; }
  if (!event || typeof event.id !== 'string' || !EVENT_ID.test(event.id)) return { status: 400, body: { ok: false, reason: 'invalid_event_id' } };
  if (!PARTNER_EVENT_TYPES.includes(event.type)) return { status: 400, body: { ok: false, reason: 'unknown_event_type' } };
  if (!Number.isSafeInteger(event.created) || event.created <= 0) return { status: 400, body: { ok: false, reason: 'invalid_created' } };
  try { validateData(event.type, event.data); } catch { return { status: 400, body: { ok: false, reason: 'invalid_event_data' } }; }
  const sha = crypto.createHash('sha256').update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)).digest('hex');
  const r = await pool.query(
    `INSERT INTO webhook_events (provider, event_id, event_type, livemode, provider_created_at, payload, payload_sha256)
     VALUES ('partner', $1, $2, false, to_timestamp($3), $4, $5)
     ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    [event.id, event.type, event.created, event, sha]);
  if (!r.rowCount) {
    // Same id, different body: never overwrite; surface it.
    const prev = (await pool.query("SELECT payload_sha256 FROM webhook_events WHERE provider = 'partner' AND event_id = $1", [event.id])).rows[0];
    if (prev && prev.payload_sha256 !== sha) return { status: 409, body: { ok: false, reason: 'event_id_reused_with_different_body' } };
  }
  return { status: 200, body: { ok: true, duplicate: r.rowCount === 0 } };
}
