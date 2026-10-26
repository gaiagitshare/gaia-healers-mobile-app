#!/usr/bin/env node
/**
 * STAGING Stripe webhook receiver — Stripe TEST MODE, loopback only.
 *
 * Stripe cannot reach 127.0.0.1, so events reach this server either through
 * `stripe listen --forward-to http://127.0.0.1:<port>/v1/webhooks/stripe` (the
 * CLI prints the whsec to use) or through an HTTPS staging location proxied to
 * this port (needs the owner's approval; see docs/membership/STRIPE-SANDBOX-ACCESS.md §5).
 *
 *   MEMBERSHIP_DATABASE_URL=… STRIPE_TEST_WEBHOOK_SECRET=whsec_… \
 *     node src/cli/staging-webhook-server.js [--port 8791] [--batch 10] [--interval-ms 5000]
 *
 * Safety, enforced in code:
 *   - binds 127.0.0.1 only (there is no host option);
 *   - refuses to start unless the database URL's host is loopback (127.0.0.0/8,
 *     ::1, localhost), including any ?host= override; a Unix-socket or remote
 *     host is refused;
 *   - refuses a webhook secret that is not whsec_…, that contains "live", or
 *     that is an API key; whsec values look the same in test and live mode, so
 *     the second line of defence is ingest.js, which refuses every livemode
 *     event (allowLivemode is never passed here);
 *   - every delivery is verified (signature, timestamp tolerance) and stored by
 *     ingest.js before anything acts on it; bodies above 512 KiB are refused;
 *   - processing runs processPending() at most once per interval with a bounded
 *     batch (1..50), never two batches at once; it calls no external API;
 *   - logs status, event id and type only; never the secret, URL or payload.
 *
 * Exit codes: 2 refused (configuration); 3 failed to start.
 */
import http from 'node:http';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPool } from '../db.js';
import { ingestStripeWebhook } from '../stripe/ingest.js';
import { processPending } from '../stripe/processor.js';
import { stripeHandlers } from '../stripe/handlers.js';

const LABEL = 'staging-webhook';
export const BIND_HOST = '127.0.0.1';
export const WEBHOOK_PATH = '/v1/webhooks/stripe';
export const DEFAULT_PORT = 8791;
export const DEFAULT_BATCH = 10;
export const MAX_BATCH = 50;
export const DEFAULT_INTERVAL_MS = 5000;
export const MIN_INTERVAL_MS = 1000;
export const MAX_INTERVAL_MS = 10 * 60 * 1000;
export const MAX_BODY_BYTES = 512 * 1024;

export class RefusedError extends Error {
  constructor(message) { super(message); this.name = 'RefusedError'; this.code = 'REFUSED'; }
}

export function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** null when acceptable, otherwise the reason (never containing the URL itself). */
export function checkDatabaseUrl(url) {
  if (!url) return 'MEMBERSHIP_DATABASE_URL is not set';
  let u;
  try { u = new URL(url); } catch { return 'MEMBERSHIP_DATABASE_URL is not a valid URL'; }
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) return 'MEMBERSHIP_DATABASE_URL must be a postgres:// URL';
  if (!isLoopbackHost(u.hostname)) return 'the database host must be loopback (127.0.0.1, ::1 or localhost)';
  for (const k of ['host', 'hostaddr']) {
    for (const v of u.searchParams.getAll(k)) if (!isLoopbackHost(v)) return `the database URL's ?${k}= override must be loopback`;
  }
  return null;
}

/** null when acceptable, otherwise the reason (never containing the secret). */
export function checkWebhookSecret(secret) {
  if (!secret) return 'STRIPE_TEST_WEBHOOK_SECRET is not set';
  if (/live/i.test(secret)) return 'STRIPE_TEST_WEBHOOK_SECRET looks like a live secret';
  if (/^(sk|rk|pk)_/.test(secret)) return 'STRIPE_TEST_WEBHOOK_SECRET is an API key, not a webhook signing secret';
  if (!/^whsec_[A-Za-z0-9_]{16,}$/.test(secret)) return 'STRIPE_TEST_WEBHOOK_SECRET must be a Stripe webhook signing secret (whsec_…)';
  return null;
}

function checkInt(name, v, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw new RefusedError(`${name} must be a whole number from ${min} to ${max}`);
  return v;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let over = false;
    req.on('data', (c) => { size += c.length; if (size > limit) { over = true; chunks.length = 0; } else if (!over) chunks.push(c); });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * startStagingWebhookServer({ env, port, batch, intervalMs, pool?, handlers?, log?, setIntervalFn?, clearIntervalFn? })
 * -> { url, port, tick(), close() }. Throws RefusedError before binding or connecting on a bad configuration.
 */
export async function startStagingWebhookServer({
  env = process.env, port = DEFAULT_PORT, batch = DEFAULT_BATCH, intervalMs = DEFAULT_INTERVAL_MS, pool: injectedPool, handlers = stripeHandlers,
  log = (s) => process.stdout.write(s + '\n'), setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  const dbReason = checkDatabaseUrl(env.MEMBERSHIP_DATABASE_URL);
  if (dbReason) throw new RefusedError(dbReason);
  const secret = env.STRIPE_TEST_WEBHOOK_SECRET;
  const secretReason = checkWebhookSecret(secret);
  if (secretReason) throw new RefusedError(secretReason);
  checkInt('port', port, 0, 65535);
  checkInt('batch', batch, 1, MAX_BATCH);
  checkInt('interval', intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS);

  const pool = injectedPool || createPool(env.MEMBERSHIP_DATABASE_URL, { max: 4 });
  let running = null;

  async function tick() {
    if (running) return { skipped: true };
    running = (async () => {
      try {
        const s = await processPending(pool, { handlers, limit: batch });
        if (s.processed || s.ignored || s.failed || s.dead) log(`[${LABEL}] batch processed=${s.processed} ignored=${s.ignored} failed=${s.failed} dead=${s.dead}`);
        return s;
      } catch (e) {
        log(`[${LABEL}] batch error ${e.code || e.name}`);
        return { error: e.code || e.name };
      }
    })();
    try { return await running; } finally { running = null; }
  }

  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (path === '/healthz' && req.method === 'GET') return reply(200, { ok: true });
      if (path !== WEBHOOK_PATH) return reply(404, { ok: false, reason: 'not_found' });
      if (req.method !== 'POST') return reply(405, { ok: false, reason: 'method_not_allowed' });
      const raw = await readBody(req, MAX_BODY_BYTES);
      if (raw === null) return reply(413, { ok: false, reason: 'body_too_large' });
      const r = await ingestStripeWebhook(pool, { rawBody: raw, signatureHeader: req.headers['stripe-signature'], secrets: [secret] });
      if (r.status === 200) {
        const e = JSON.parse(raw.toString('utf8'));
        log(`[${LABEL}] accepted ${e.id} type=${e.type}${r.body.duplicate ? ' (duplicate)' : ''}`);
      } else {
        log(`[${LABEL}] rejected status=${r.status} reason=${r.body.reason}`);
      }
      return reply(r.status, r.body);
    } catch (e) {
      log(`[${LABEL}] error ${e.code || e.name}`);
      return reply(500, { ok: false, reason: 'internal_error' });   // Stripe retries a 500; nothing was half-stored (single INSERT)
    }
  });

  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, BIND_HOST, resolve); });
  } catch (e) {
    if (!injectedPool) await pool.end().catch(() => {});
    throw e;
  }
  const bound = server.address().port;
  const timer = setIntervalFn(() => { tick(); }, intervalMs);
  log(`[${LABEL}] listening on http://${BIND_HOST}:${bound}${WEBHOOK_PATH} (test mode; batch ${batch} every ${intervalMs} ms)`);

  return {
    url: `http://${BIND_HOST}:${bound}`,
    port: bound,
    tick,
    async close() {
      clearIntervalFn(timer);
      await new Promise((r) => server.close(r));
      if (running) await running.catch(() => {});
      if (!injectedPool) await pool.end().catch(() => {});
    },
  };
}

/** CLI entry. Returns { code } on refusal, or { code: 0, server } once listening. */
export async function main(argv = process.argv.slice(2), { env = process.env, out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n'), ...rest } = {}) {
  let a;
  try {
    a = parseArgs({ args: argv, strict: true, options: { port: { type: 'string' }, batch: { type: 'string' }, 'interval-ms': { type: 'string' } } }).values;
  } catch (e) { err(`[${LABEL}] ${e.message}`); return { code: 2 }; }
  const num = (v, d) => (v === undefined ? d : Number(v));
  try {
    const server = await startStagingWebhookServer({
      env, log: out, ...rest,
      port: num(a.port ?? env.STAGING_WEBHOOK_PORT, DEFAULT_PORT), batch: num(a.batch, DEFAULT_BATCH), intervalMs: num(a['interval-ms'], DEFAULT_INTERVAL_MS),
    });
    return { code: 0, server };
  } catch (e) {
    if (e instanceof RefusedError) { err(`[${LABEL}] REFUSED: ${e.message}`); return { code: 2 }; }
    err(`[${LABEL}] FAILED to start: ${e.code || e.name}`);
    return { code: 3 };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { code, server } = await main();
  if (code) process.exitCode = code;
  else {
    const stop = async () => { await server.close(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }
}
