/**
 * Stripe webhook signature verification (Stripe-Signature, scheme v1), against
 * the RAW request body. Implemented locally (no Stripe SDK) so it is auditable
 * and testable offline.
 *
 *   header:  t=<unix seconds>,v1=<hex hmac>[,v1=...][,v0=...]
 *   signed:  HMAC-SHA256(secret, `${t}.${rawBody}`)
 *
 * Replay protection: the timestamp must be within `toleranceSec` of now, and
 * the event id is unique in webhook_events (ingest.js).
 * Several secrets may be passed during a rotation; any one matching is enough.
 */
import crypto from 'node:crypto';

export const DEFAULT_TOLERANCE_SEC = 300;

export function parseHeader(header) {
  const out = { t: null, v1: [] };
  for (const part of String(header || '').split(',')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) out.t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) out.v1.push(v);
  }
  return out;
}

export function computeSignature(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')).digest('hex');
}

/** Returns { ok: true, timestamp } or { ok: false, reason }. Never throws on bad input. */
export function verifyStripeSignature({ rawBody, header, secrets, toleranceSec = DEFAULT_TOLERANCE_SEC, now = Date.now() }) {
  const keys = (Array.isArray(secrets) ? secrets : [secrets]).filter((s) => typeof s === 'string' && s.length >= 16);
  if (!keys.length) return { ok: false, reason: 'no_secret_configured' };
  if (rawBody == null || (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody))) return { ok: false, reason: 'raw_body_required' };
  const { t, v1 } = parseHeader(header);
  if (t == null || !v1.length) return { ok: false, reason: 'malformed_header' };
  if (Math.abs(Math.floor(now / 1000) - t) > toleranceSec) return { ok: false, reason: 'timestamp_outside_tolerance' };
  for (const secret of keys) {
    const expected = Buffer.from(computeSignature(secret, t, rawBody), 'hex');
    for (const sig of v1) {
      if (crypto.timingSafeEqual(expected, Buffer.from(sig, 'hex'))) return { ok: true, timestamp: t };
    }
  }
  return { ok: false, reason: 'signature_mismatch' };
}

/** Test helper: build a header the way Stripe does. */
export function signForTest(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}`;
}
