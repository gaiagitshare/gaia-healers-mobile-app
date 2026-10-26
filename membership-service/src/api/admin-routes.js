/**
 * Control Center routes: /v1/admin/* (docs/membership/CONTROL-CENTER.md §4).
 *
 * Only a PLATFORM client with `admin:operate` (the proxy's admin gateway) may
 * call these. The operator is identified by `X-Operator-Session` (an opaque
 * token the proxy keeps in an HttpOnly cookie); roles and the two-person rule
 * are enforced here, never in the browser. Read models are bounded
 * (limit <= 200) and keyset-paginated with an opaque `cursor`. Writes go through
 * admin-actions.js (reason, idempotent requestId, audit with the operator id).
 */
import { fail } from '../errors.js';
import { requireScope } from '../access.js';
import { login, logout, authenticateOperator, operatorView } from '../operators.js';
import { ACTIONS, permissionsFor, submitAction, decide, cancelRequest, requestView, expireOverdue } from '../admin-actions.js';
import { evaluate, isEntitled } from '../entitlements.js';
import { walletView } from '../coins.js';
import { legacyBlock } from '../billing-guard.js';
import { launchState } from '../launch.js';
import { grantsAccess } from '../subscriptions.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PERSON = new RegExp(`^/v1/admin/persons/(${UUID})$`);
const NOTES = new RegExp(`^/v1/admin/persons/(${UUID})/notes$`);
const REQ = /^\/v1\/admin\/requests\/([0-9a-f-]{36})\/(approve|reject|cancel)$/;
export const MAX_LIMIT = 200;

const limitOf = (url, def = 50) => Math.min(Math.max(Number.parseInt(url.searchParams.get('limit'), 10) || def, 1), MAX_LIMIT);
const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
function dec(url) {
  const c = url.searchParams.get('cursor');
  if (!c) return null;
  try { const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')); if (!Array.isArray(v)) throw 0; return v; } catch { fail('INVALID_INPUT', 'invalid cursor'); }
}
/** rows fetched with limit+1 -> { items, next } */
const page = (rows, limit, keyOf) => ({ items: rows.slice(0, limit), next: rows.length > limit ? enc(keyOf(rows[limit - 1])) : null });
const legacyState = (row) => { const b = legacyBlock(row); return !b ? 'ended' : (b.kind === 'migration_required' ? 'active' : 'under_review'); };
const iso = (s, what) => { if (!s) return null; const d = new Date(s); if (Number.isNaN(d.getTime())) fail('INVALID_INPUT', what + ' must be a date'); return d; };

/** Returns [status, body] for /v1/admin/* or null. */
export async function adminRoute(ctx) {
  const { pool, client, req, url, now, stripe, env, readJson } = ctx;
  const p = url.pathname;
  if (!p.startsWith('/v1/admin/')) return null;
  requireScope(client, 'admin:operate');
  if (client.practitioner_id) fail('FORBIDDEN', 'platform clients only');
  const requestId = ctx.actor.requestId;
  const M = req.method;

  if (M === 'POST' && p === '/v1/admin/login') {
    const b = await readJson(req);
    const ip = String(req.headers['x-operator-ip'] || '').slice(0, 64) || null;
    const ua = String(req.headers['x-operator-ua'] || '').slice(0, 300) || null;
    const r = await login(pool, { email: b.email, password: b.password, totp: b.totp }, { env, now, ip, ua, requestId });
    return [200, { ok: true, ...r }];
  }

  const auth = await authenticateOperator(pool, req.headers['x-operator-session'], now);
  const op = auth.operator;
  const unavailable = () => fail('PROVIDER_UNAVAILABLE', 'billing is not connected in this environment');
  const actx = { pool, stripe: stripe || { livemode: false, get: unavailable, post: unavailable, del: unavailable }, env, now, requestId };
  let m;

  if (M === 'POST' && p === '/v1/admin/logout') { await logout(pool, auth, requestId); return [200, { ok: true }]; }
  if (M === 'GET' && p === '/v1/admin/me') return [200, { ok: true, operator: operatorView(op), permissions: permissionsFor(op), idleExpiresAt: auth.idleExpiresAt, expiresAt: auth.expiresAt }];

  // ---------- writes ----------
  if (M === 'POST' && p === '/v1/admin/actions') return [200, { ok: true, ...(await submitAction(actx, op, await readJson(req))) }];
  if (M === 'POST' && (m = NOTES.exec(p))) {
    const b = await readJson(req);
    const requestId8 = typeof b.requestId === 'string' ? b.requestId : 'note-' + requestId;
    const r = await submitAction(actx, op, { action: 'note.add', params: { personId: m[1], body: b.body }, reason: typeof b.reason === 'string' ? b.reason : b.body, requestId: requestId8 });
    return [201, { ok: true, ...r }];
  }
  if (M === 'POST' && (m = REQ.exec(p))) {
    const b = await readJson(req);
    if (m[2] === 'cancel') return [200, { ok: true, ...(await cancelRequest(actx, op, m[1])) }];
    return [200, { ok: true, ...(await decide(actx, op, m[1], m[2], b.note, b.requestId ?? null)) }];
  }

  if (M !== 'GET') fail('NOT_FOUND', 'no such route');
  // ---------- reads (viewer and above) ----------
  if (p === '/v1/admin/overview') return [200, { ok: true, ...(await overview(pool, env, now)) }];
  if (p === '/v1/admin/persons') return [200, { ok: true, ...(await searchPersons(pool, url, now)) }];
  if ((m = PERSON.exec(p))) return [200, { ok: true, ...(await personDetail(pool, m[1], now)) }];
  if (p === '/v1/admin/plans') return [200, { ok: true, ...(await plansView(pool)) }];
  if (p === '/v1/admin/payments') {
    const limit = limitOf(url); const c = dec(url); const from = iso(url.searchParams.get('from'), 'from'); const to = iso(url.searchParams.get('to'), 'to');
    const type = url.searchParams.get('type') || null;
    const rows = (await pool.query(
      `SELECT id, person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, subscription_id, coin_operation_id, livemode, occurred_at, recorded_at
         FROM payment_ledger WHERE ($1::bigint IS NULL OR id < $1) AND ($2::timestamptz IS NULL OR occurred_at >= $2) AND ($3::timestamptz IS NULL OR occurred_at < $3)
          AND ($4::text IS NULL OR entry_type = $4) ORDER BY id DESC LIMIT $5`, [c ? c[0] : null, from, to, type, limit + 1])).rows;
    return [200, { ok: true, ...page(rows, limit, (r) => [r.id]) }];
  }
  if (p === '/v1/admin/coins') {
    const limit = limitOf(url); const c = dec(url);
    const rows = (await pool.query(
      `SELECT t.id, w.person_id, t.operation_id, o.kind, o.reason AS operation_reason, t.balance_type, t.delta_coins, t.balance_after, t.reason, t.created_at, o.actor
         FROM coin_transactions t JOIN coin_wallets w ON w.id = t.wallet_id JOIN coin_operations o ON o.id = t.operation_id
        WHERE ($1::bigint IS NULL OR t.id < $1) ORDER BY t.id DESC LIMIT $2`, [c ? c[0] : null, limit + 1])).rows;
    const totals = (await pool.query(`SELECT count(*)::int wallets, COALESCE(sum(granted_balance), 0)::bigint granted, COALESCE(sum(purchased_balance), 0)::bigint purchased,
                                             COALESCE(sum(legacy_balance), 0)::bigint legacy FROM coin_wallets`)).rows[0];
    return [200, { ok: true, totals, ...page(rows, limit, (r) => [r.id]) }];
  }
  if (p === '/v1/admin/legacy') {
    const limit = limitOf(url); const state = url.searchParams.get('state');
    const rows = (await pool.query(`SELECT id, person_id, external_contact_id, payment_provider, tier, mapping, reported_status, amount_cents, currency, billing_interval,
                                           last_payment_at, paid_through_estimate, stale_suspected, review_state, review_reasons, first_seen_at, last_seen_at
                                      FROM legacy_memberships ORDER BY last_seen_at DESC NULLS LAST, id LIMIT 2000`)).rows
      .map((r) => ({ ...r, state: legacyState(r) })).filter((r) => !state || r.state === state);
    const fresh = (await pool.query('SELECT max(last_seen_at) AS last_seen_at FROM legacy_memberships')).rows[0];
    const run = (await pool.query('SELECT started_at, finished_at, complete, error_code FROM legacy_reader_runs ORDER BY started_at DESC LIMIT 1')).rows[0] || null;
    return [200, { ok: true, items: rows.slice(0, limit), total: rows.length, freshness: { lastSeenAt: fresh.last_seen_at, ageSeconds: fresh.last_seen_at ? Math.round((now - new Date(fresh.last_seen_at)) / 1000) : null, lastRun: run } }];
  }
  if (p === '/v1/admin/migration-offers') {
    const st = url.searchParams.get('status');
    const rows = (await pool.query(`SELECT o.id, o.person_id, o.legacy_membership_id, l.tier AS from_tier, l.payment_provider, pl.key AS target_plan, o.target_interval, o.status, o.sweetener_months,
                                           o.billing_starts_at, o.subscription_id, o.offered_by, o.offered_at, o.accepted_at, o.legacy_cancel_confirmed_by, o.legacy_cancel_confirmed_at,
                                           o.legacy_cancel_verified_at, o.exception_authorized_by, o.exception_at, o.updated_at
                                      FROM migration_offers o JOIN legacy_memberships l ON l.id = o.legacy_membership_id JOIN plan_versions v ON v.id = o.target_plan_version_id JOIN plans pl ON pl.id = v.plan_id
                                     WHERE ($1::text IS NULL OR o.status = $1) ORDER BY o.offered_at DESC LIMIT $2`, [st, limitOf(url)])).rows;
    return [200, { ok: true, items: rows }];
  }
  if (p === '/v1/admin/reconciliation') {
    const runs = (await pool.query(`SELECT d.run_id, d.provider, d.livemode, d.day, d.requests_made, d.request_cap, d.coin_mismatches, d.new_alerts, d.repeat_alerts, d.created_at,
                                           r.complete, r.checked, r.matched, r.mismatch_count
                                      FROM reconciliation_daily_runs d JOIN reconciliation_runs r ON r.id = d.run_id ORDER BY d.created_at DESC LIMIT 30`)).rows;
    const alerts = (await pool.query(`SELECT id, provider, kind, object_type, object_id, entry_type, first_day, last_day, seen_count, first_seen_at, last_seen_at, notified_at
                                        FROM reconciliation_alerts WHERE status = 'open' ORDER BY last_seen_at DESC LIMIT 200`)).rows;
    return [200, { ok: true, runs, openAlerts: alerts }];
  }
  if (p === '/v1/admin/refund-reviews') {
    const st = url.searchParams.get('status') || 'open';
    const rows = (await pool.query(`SELECT id, person_id, provider, refund_ref, charge_ref, coins_refunded, coins_recovered, coins_unrecovered, value_cents_unrecovered, currency, status,
                                           resolved_by, resolution, created_at, resolved_at FROM coin_refund_reviews WHERE ($1 = 'all' OR status = $1) ORDER BY created_at LIMIT $2`, [st, limitOf(url)])).rows;
    return [200, { ok: true, items: rows }];
  }
  if (p === '/v1/admin/dead-letters') {
    const ghl = (await pool.query(`SELECT id, person_id, reason, error_code, attempts, status, first_seen_at, last_seen_at FROM ghl_sync_dead_letters
                                    WHERE status = 'open' ORDER BY last_seen_at DESC LIMIT $1`, [limitOf(url)])).rows;
    const webhooks = (await pool.query(`SELECT id, provider, event_id, event_type, status, attempts, left(last_error, 300) AS last_error, received_at, next_attempt_at FROM webhook_events
                                         WHERE status IN ('failed', 'dead') ORDER BY received_at DESC LIMIT $1`, [limitOf(url)])).rows;
    return [200, { ok: true, ghl, webhooks }];
  }
  if (p === '/v1/admin/audit') {
    const limit = limitOf(url); const c = dec(url);
    const rows = (await pool.query(`SELECT id, occurred_at, actor_type, actor_id, action, entity_type, entity_id, before, after, request_id FROM audit_logs
                                     WHERE ($1::bigint IS NULL OR id < $1) AND ($2::text IS NULL OR entity_type = $2) AND ($3::text IS NULL OR entity_id = $3) AND ($4::text IS NULL OR actor_id = $4)
                                     ORDER BY id DESC LIMIT $5`,
    [c ? c[0] : null, url.searchParams.get('entityType'), url.searchParams.get('entityId'), url.searchParams.get('actorId'), limit + 1])).rows;
    return [200, { ok: true, ...page(rows, limit, (r) => [r.id]) }];
  }
  if (p === '/v1/admin/health') return [200, { ok: true, ...(await health(pool, now, Boolean(stripe))) }];
  if (p === '/v1/admin/launch') {
    const state = await launchState(pool, { env });
    const history = (await pool.query('SELECT from_stage, to_stage, limited_cap, changed_by, approval_ref, reason, changed_at FROM launch_history ORDER BY id DESC LIMIT 50')).rows;
    const pilots = (await pool.query('SELECT person_id, added_by, note, added_at FROM pilot_members WHERE removed_at IS NULL ORDER BY added_at DESC LIMIT 200')).rows;
    return [200, { ok: true, state, history, pilots }];
  }
  if (p === '/v1/admin/requests') {
    await expireOverdue(pool, now);
    const st = url.searchParams.get('status');
    const limit = limitOf(url); const c = dec(url);
    const rows = (await pool.query(`SELECT r.*, a.display_name AS requester_name, d.display_name AS decider_name FROM admin_action_requests r
                                      JOIN operators a ON a.id = r.requested_by LEFT JOIN operators d ON d.id = r.decided_by
                                     WHERE ($1::text IS NULL OR r.status = $1) AND ($2::timestamptz IS NULL OR (r.created_at, r.id) < ($2, $3::uuid))
                                     ORDER BY r.created_at DESC, r.id DESC LIMIT $4`, [st, c ? c[0] : null, c ? c[1] : null, limit + 1])).rows;
    const pg = page(rows, limit, (r) => [r.created_at, r.id]);
    return [200, { ok: true, items: pg.items.map((r) => requestView(r, op)), next: pg.next, actions: Object.keys(ACTIONS) }];
  }
  fail('NOT_FOUND', 'no such route');
}

async function overview(pool, env, now) {
  const subs = (await pool.query(`SELECT p.key AS plan, s.status, count(*)::int n FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
                                   WHERE p.owner_type = 'gaia' GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
  const mrr = (await pool.query(`SELECT COALESCE(sum(CASE s.billing_interval WHEN 'month' THEN pr.amount_cents WHEN 'year' THEN pr.amount_cents / 12.0 ELSE 0 END), 0)::bigint AS cents
                                   FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id
                                   JOIN plan_version_prices pr ON pr.plan_version_id = v.id AND pr.billing_interval = s.billing_interval
                                  WHERE p.owner_type = 'gaia' AND s.provider IN ('stripe', 'manual') AND s.source <> 'legacy_import' AND s.status IN ('active', 'past_due')`)).rows[0].cents;
  const coins = (await pool.query('SELECT COALESCE(sum(granted_balance + purchased_balance + legacy_balance), 0)::bigint n FROM coin_wallets')).rows[0].n;
  const count = async (sql) => (await pool.query(sql)).rows[0].n;
  const legacy = {};
  for (const r of (await pool.query('SELECT * FROM legacy_memberships LIMIT 5000')).rows) { const s = legacyState(r); legacy[s] = (legacy[s] || 0) + 1; }
  const lastRecon = (await pool.query('SELECT day, created_at, new_alerts, repeat_alerts, coin_mismatches FROM reconciliation_daily_runs ORDER BY created_at DESC LIMIT 1')).rows[0] || null;
  return {
    members: subs, mrrCents: mrr, coinsOutstanding: coins,
    openRefundReviews: await count("SELECT count(*)::int n FROM coin_refund_reviews WHERE status = 'open'"),
    openAlerts: await count("SELECT count(*)::int n FROM reconciliation_alerts WHERE status = 'open'"),
    pendingRequests: (await pool.query("SELECT count(*)::int n FROM admin_action_requests WHERE status = 'pending' AND expires_at > $1", [now])).rows[0].n,
    legacyByState: legacy, launch: await launchState(pool, { env }), lastReconciliation: lastRecon,
  };
}

const LIKE = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
async function searchPersons(pool, url, now) {
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 200);
  const limit = limitOf(url); const c = dec(url);
  const ids = (await pool.query(
    `SELECT p.id, p.created_at FROM persons p
      WHERE ($1 = '' OR p.id::text = $1 OR EXISTS (SELECT 1 FROM person_identities i WHERE i.person_id = p.id AND
            ((i.platform = 'email' AND lower(i.external_id) LIKE lower($2) || '%') OR (i.platform = 'ghl' AND i.external_id = $1))))
        AND ($3::timestamptz IS NULL OR (p.created_at, p.id) < ($3, $4::uuid))
      ORDER BY p.created_at DESC, p.id DESC LIMIT $5`, [q, LIKE(q), c ? c[0] : null, c ? c[1] : null, limit + 1])).rows;
  const pg = page(ids, limit, (r) => [r.created_at, r.id]);
  const list = pg.items.map((r) => r.id);
  if (!list.length) return { items: [], next: null };
  const idents = (await pool.query('SELECT person_id, platform, kind, external_id FROM person_identities WHERE person_id = ANY($1)', [list])).rows;
  const subs = (await pool.query(`SELECT s.person_id, p.key, s.status, s.trial_end, s.current_period_end, s.grace_until, s.cancel_at, s.ended_at, s.created_at FROM subscriptions s
                                    JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id WHERE s.person_id = ANY($1) AND p.owner_type = 'gaia' ORDER BY s.created_at DESC`, [list])).rows;
  const legacy = (await pool.query('SELECT * FROM legacy_memberships WHERE person_id = ANY($1)', [list])).rows;
  const wallets = (await pool.query('SELECT person_id, granted_balance + purchased_balance + legacy_balance AS total FROM coin_wallets WHERE person_id = ANY($1)', [list])).rows;
  return {
    items: list.map((id) => {
      const s = subs.find((x) => x.person_id === id && grantsAccess(x, now)) || subs.find((x) => x.person_id === id);
      return {
        personId: id,
        emails: idents.filter((i) => i.person_id === id && i.platform === 'email').map((i) => i.external_id),
        contactIds: idents.filter((i) => i.person_id === id && i.platform === 'ghl').map((i) => i.external_id),
        plan: s?.key || null, status: s?.status || null,
        legacy: legacy.filter((l) => l.person_id === id && legacyState(l) !== 'ended').map((l) => l.tier),
        coins: wallets.find((w) => w.person_id === id)?.total || 0,
      };
    }),
    next: pg.next,
  };
}

async function personDetail(pool, id, now) {
  const person = (await pool.query('SELECT id, status, merged_into, created_at FROM persons WHERE id = $1', [id])).rows[0];
  if (!person) fail('NOT_FOUND', 'person not found');
  const q = async (sql, args = [id]) => (await pool.query(sql, args)).rows;
  const subscriptions = await q(`SELECT s.id, p.key AS plan_key, p.name AS plan_name, p.owner_type, v.version AS plan_version, s.billing_interval, s.status, s.provider, s.provider_subscription_id,
                                        s.source, s.trial_end, s.current_period_start, s.current_period_end, s.grace_until, s.cancel_at, s.canceled_at, s.ended_at, s.created_at,
                                        COALESCE((SELECT jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'reason', e.reason, 'at', e.occurred_at) ORDER BY e.id DESC)
                                                    FROM (SELECT * FROM subscription_events WHERE subscription_id = s.id ORDER BY id DESC LIMIT 50) e), '[]') AS events
                                   FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id WHERE s.person_id = $1 ORDER BY s.created_at DESC LIMIT 50`);
  const ent = await evaluate(pool, id, now);
  const coinTx = await q(`SELECT t.id, o.kind, o.reason AS operation_reason, t.balance_type, t.delta_coins, t.balance_after, t.reason, t.created_at, o.actor
                            FROM coin_transactions t JOIN coin_wallets w ON w.id = t.wallet_id JOIN coin_operations o ON o.id = t.operation_id WHERE w.person_id = $1 ORDER BY t.id DESC LIMIT 50`);
  const offers = await q(`SELECT o.id, o.status, o.legacy_membership_id, pl.key AS target_plan, o.target_interval, o.billing_starts_at, o.offered_by, o.offered_at, o.updated_at
                            FROM migration_offers o JOIN plan_versions v ON v.id = o.target_plan_version_id JOIN plans pl ON pl.id = v.plan_id WHERE o.person_id = $1 ORDER BY o.offered_at DESC`);
  const related = [id, ...subscriptions.map((s) => s.id), ...offers.map((o) => o.id)];
  return {
    person,
    identities: await q('SELECT platform, kind, external_id, verified_at, linked_by, created_at FROM person_identities WHERE person_id = $1 ORDER BY created_at'),
    subscriptions: subscriptions.map((s) => ({ ...s, hasAccess: grantsAccess(s, now) })),
    entitlements: Object.entries(ent.entitlements).filter(([, v]) => isEntitled(v)).map(([k, v]) => ({ key: k, value: v.value })),
    grants: await q('SELECT id, entitlement_key, value, source, starts_at, ends_at, revoked_at, granted_by FROM entitlement_grants WHERE person_id = $1 ORDER BY created_at DESC LIMIT 50'),
    wallet: await walletView(pool, id), coinTransactions: coinTx,
    payments: await q(`SELECT id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, subscription_id, coin_operation_id, occurred_at
                         FROM payment_ledger WHERE person_id = $1 ORDER BY occurred_at DESC LIMIT 50`),
    legacy: (await q('SELECT * FROM legacy_memberships WHERE person_id = $1 ORDER BY first_seen_at')).map((r) => ({ ...r, state: legacyState(r) })),
    offers,
    pilot: (await q('SELECT 1 FROM pilot_members WHERE person_id = $1 AND removed_at IS NULL')).length > 0,
    notes: await q(`SELECT n.id, n.body, n.created_at, o.id AS operator_id, o.display_name AS operator_name FROM person_notes n JOIN operators o ON o.id = n.operator_id
                     WHERE n.person_id = $1 ORDER BY n.id DESC LIMIT 100`),
    audit: await q(`SELECT id, occurred_at, actor_type, actor_id, action, entity_type, entity_id, after FROM audit_logs WHERE entity_id = ANY($1) ORDER BY id DESC LIMIT 50`, [related]),
  };
}

async function plansView(pool) {
  const plans = (await pool.query('SELECT id, key, name, owner_type, practitioner_id, rank, status, created_at FROM plans ORDER BY rank NULLS LAST, key')).rows;
  const versions = (await pool.query(`SELECT v.id, v.plan_id, v.version, v.status, v.is_legacy, v.monthly_coin_grant, v.published_at, v.retired_at,
                                             COALESCE((SELECT jsonb_agg(jsonb_build_object('id', pr.id, 'interval', pr.billing_interval, 'amountCents', pr.amount_cents, 'currency', pr.currency,
                                               'providerRefs', COALESCE((SELECT jsonb_agg(jsonb_build_object('provider', r.provider, 'externalPriceId', r.external_price_id, 'livemode', r.livemode))
                                                                          FROM provider_price_refs r WHERE r.plan_version_price_id = pr.id), '[]')))
                                                FROM plan_version_prices pr WHERE pr.plan_version_id = v.id), '[]') AS prices
                                        FROM plan_versions v ORDER BY v.plan_id, v.version`)).rows;
  const coinPacks = (await pool.query('SELECT id, key, coins, bonus_coins, price_cents, currency, status, created_at FROM coin_packages ORDER BY coins')).rows;
  return { plans: plans.map((p) => ({ ...p, versions: versions.filter((v) => v.plan_id === p.id) })), coinPacks };
}

async function health(pool, now, stripeConnected) {
  const db = (await pool.query('SELECT 1 AS ok')).rowCount === 1;
  const mig = (await pool.query('SELECT max(id) AS v FROM public.membership_schema_migrations')).rows[0].v;
  const wh = (await pool.query("SELECT count(*)::int n, min(received_at) oldest FROM webhook_events WHERE status IN ('received', 'failed', 'processing')")).rows[0];
  const holds = (await pool.query("SELECT count(*)::int n, min(hold_expires_at) oldest FROM coin_operations WHERE status = 'held'")).rows[0];
  const mirror = (await pool.query('SELECT max(last_seen_at) t FROM legacy_memberships')).rows[0].t;
  return {
    db, migrationsVersion: mig, webhookBacklog: wh.n, oldestPendingWebhookAt: wh.oldest,
    heldCoinOperations: holds.n, oldestHoldExpiresAt: holds.oldest,
    legacyMirrorAgeSeconds: mirror ? Math.round((now - new Date(mirror)) / 1000) : null,
    stripeConnected,
  };
}

