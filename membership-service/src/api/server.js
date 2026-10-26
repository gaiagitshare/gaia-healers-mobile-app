/**
 * Internal membership API (Milestone D). Service-to-service only: every route
 * except /v1/health needs a client token (clients.js), a scope, and passes the
 * tenant check (access.js). Bind it to loopback / a private network; it is not
 * a public API and it is not started anywhere yet.
 *
 *   GET  /v1/health
 *   GET  /v1/identities/resolve?platform=&kind=&external_id=   identity:read     (platform clients)
 *   GET  /v1/persons/:id/subscriptions                         subscriptions:read
 *   GET  /v1/persons/:id/entitlements[?key=]                   entitlements:read
 *   GET  /v1/persons/:id/wallet                                wallet:read
 *   POST /v1/coins/quotes          { personId, action }        coins:quote
 *   POST /v1/coins/holds           { personId, quoteId }  + Idempotency-Key   coins:debit
 *   POST /v1/coins/holds/:op/capture   { personId }            coins:debit (same client that held)
 *   POST /v1/coins/holds/:op/release   { personId }            coins:debit (same client that held)
 *
 * Errors: { ok: false, code, message } with the spec's codes (errors.js).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { MembershipError, fail } from '../errors.js';
import { authenticate } from '../clients.js';
import { actorOf, deny, requireScope, assertPersonVisible, subscriptionsFor, entitlementsFor } from '../access.js';
import { createQuote, holdForQuote } from '../quotes.js';
import { captureDebit, releaseDebit, walletView } from '../coins.js';
import { findPerson } from '../identity.js';
import { nextCycleStart } from '../jobs/allowance.js';
import { grantsAccess } from '../subscriptions.js';
import { isEntitled } from '../entitlements.js';

const MAX_BODY = 16 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const send = (res, status, body, requestId) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) fail('INVALID_INPUT', 'Content-Type must be application/json');
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) fail('INVALID_INPUT', 'body too large'); chunks.push(c); }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; }
  catch { fail('INVALID_INPUT', 'invalid JSON'); }
}

function idempotencyKey(req) {
  const k = String(req.headers['idempotency-key'] || '');
  if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(k)) fail('INVALID_INPUT', 'Idempotency-Key header (8-200 safe characters) is required');
  return k;
}

const opView = (op, extra = {}) => ({ operationId: op.id, status: op.status, coins: op.coins, holdExpiresAt: op.hold_expires_at, ...extra });

export function createApiHandler(pool, { clock = () => new Date() } = {}) {
  async function route(req, url, requestId) {
    const now = clock();
    if (req.method === 'GET' && url.pathname === '/v1/health') return [200, { ok: true }];
    const client = await authenticate(pool, req.headers.authorization);
    if (!client) fail('UNAUTHORIZED', 'unknown or revoked client');
    const actor = actorOf(client, requestId);
    let m;
    try {
      if (req.method === 'GET' && url.pathname === '/v1/identities/resolve') {
        requireScope(client, 'identity:read');
        if (client.practitioner_id) fail('FORBIDDEN', 'platform clients only');
        const p = await findPerson(pool, { platform: url.searchParams.get('platform'), kind: url.searchParams.get('kind'), externalId: url.searchParams.get('external_id') || '' });
        if (!p) fail('NOT_FOUND', 'no person for this identity');
        return [200, { ok: true, personId: p.status === 'merged' ? p.merged_into : p.id }];
      }
      if (req.method === 'GET' && (m = new RegExp(`^/v1/persons/(${UUID})/(subscriptions|entitlements|wallet)$`).exec(url.pathname))) {
        const [, personId, what] = m;
        requireScope(client, what === 'wallet' ? 'wallet:read' : what + ':read');
        await assertPersonVisible(pool, client, personId);
        if (what === 'subscriptions') {
          const subs = await subscriptionsFor(pool, client, personId);
          return [200, { ok: true, subscriptions: subs.map((s) => ({ ...s, hasAccess: grantsAccess(s, now) })) }];
        }
        if (what === 'entitlements') {
          const e = await entitlementsFor(pool, client, personId, now);
          const key = url.searchParams.get('key');
          if (key) return [200, { ok: true, key, entitled: isEntitled(e.entitlements[key]), value: e.entitlements[key]?.value ?? null }];
          return [200, { ok: true, entitlements: Object.fromEntries(Object.entries(e.entitlements).filter(([, v]) => isEntitled(v)).map(([k, v]) => [k, v.value])), plans: e.plans }];
        }
        const sub = (await pool.query(
          `SELECT s.current_period_start, s.created_at FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id
            WHERE s.person_id = $1 AND s.status IN ('active', 'trialing', 'past_due') AND v.monthly_coin_grant > 0
            ORDER BY v.monthly_coin_grant DESC LIMIT 1`, [personId])).rows[0];
        const nextGrantAt = sub ? nextCycleStart(sub.current_period_start || sub.created_at, now) : null;
        return [200, { ok: true, wallet: await walletView(pool, personId, { nextGrantAt }) }];
      }
      if (req.method === 'POST' && url.pathname === '/v1/coins/quotes') {
        requireScope(client, 'coins:quote');
        const b = await readJson(req);
        await assertPersonVisible(pool, client, b.personId);
        if (typeof b.action !== 'string') fail('INVALID_INPUT', 'action is required');
        return [201, { ok: true, quote: await createQuote(pool, { client, personId: b.personId, actionKey: b.action, now }, actor) }];
      }
      if (req.method === 'POST' && url.pathname === '/v1/coins/holds') {
        requireScope(client, 'coins:debit');
        const key = idempotencyKey(req);
        const b = await readJson(req);
        await assertPersonVisible(pool, client, b.personId);
        if (!new RegExp(`^${UUID}$`).test(String(b.quoteId))) fail('INVALID_INPUT', 'quoteId is required');
        const r = await holdForQuote(pool, { client, personId: b.personId, quoteId: b.quoteId, idempotencyKey: key, now }, actor);
        return [r.replayed ? 200 : 201, { ok: true, replayed: r.replayed, hold: opView(r.operation, r.split ? { split: r.split } : {}) }];
      }
      if (req.method === 'POST' && (m = new RegExp(`^/v1/coins/holds/(${UUID})/(capture|release)$`).exec(url.pathname))) {
        requireScope(client, 'coins:debit');
        const [, opId, action] = m;
        const b = await readJson(req);
        await assertPersonVisible(pool, client, b.personId);
        const own = (await pool.query(
          `SELECT o.actor FROM coin_operations o JOIN coin_wallets w ON w.id = o.wallet_id WHERE o.id = $1 AND w.person_id = $2 AND o.kind = 'debit'`, [opId, b.personId])).rows[0];
        if (!own || own.actor !== actor.actorId) fail('NOT_FOUND', 'hold not found');
        const r = action === 'capture' ? await captureDebit(pool, opId, actor) : await releaseDebit(pool, opId, actor);
        return [200, { ok: true, replayed: r.replayed, hold: opView(r.operation) }];
      }
      fail('NOT_FOUND', 'no such route');
    } catch (e) {
      if (e instanceof MembershipError && (e.code === 'FORBIDDEN' || e.code === 'NOT_FOUND') && url.pathname !== '/v1/health') {
        await deny(pool, client, requestId, `${req.method} ${url.pathname} -> ${e.code}`).catch(() => {});
      }
      throw e;
    }
  }

  return async function handler(req, res) {
    const requestId = crypto.randomUUID();
    try {
      const url = new URL(req.url, 'http://internal');
      const [status, body] = await route(req, url, requestId);
      send(res, status, body, requestId);
    } catch (e) {
      if (e instanceof MembershipError) return send(res, e.status, { ok: false, code: e.code, message: e.message }, requestId);
      console.error('[membership-api]', requestId, e.code || '', e.message);
      send(res, 500, { ok: false, code: 'INTERNAL', message: 'internal error' }, requestId);
    }
  };
}

export function createApiServer(pool, opts) {
  return http.createServer(createApiHandler(pool, opts));
}
