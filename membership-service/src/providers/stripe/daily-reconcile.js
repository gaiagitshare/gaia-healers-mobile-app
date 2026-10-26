/**
 * Daily Stripe <-> payment_ledger reconciliation (spec v2.5: daily
 * reconciliation, alert on mismatch). Built on reconcile.js
 * (fetchReconciliationPage + reconcilePage); nothing schedules it.
 *
 *   - Window: the previous UTC day [dayStart, dayEnd). Stripe objects are
 *     fetched from dayStart - overlap, so an object created late the day before
 *     whose ledger row is dated today is still found; "missing in Stripe" is
 *     only judged for ledger rows dated inside the day itself.
 *   - Coin packs: membership.coin_purchase_ledger_mismatches(dayStart, dayEnd)
 *     (migration 0006) is part of every run.
 *   - Idempotent per day: every run is a new append-only reconciliation_runs +
 *     reconciliation_daily_runs row. Each mismatch is ONE open
 *     reconciliation_alerts row; seeing it again (a re-run, or the next day's
 *     overlap) bumps seen_count instead of alerting again. alert() receives
 *     only alerts not yet notified, and an alert is marked notified only after
 *     alert() returns, so a failed alert is re-sent by the next run.
 *   - Hard request cap: the caller hands in the cap (request-cap.js) whose
 *     fetch the Stripe client uses. The plan (4 lists x maxPages) is checked
 *     against the cap BEFORE the first request; above the cap the run is
 *     refused, never trimmed. Retries count, and the request that would exceed
 *     the cap throws.
 *   - exitCode: 0 = complete and zero mismatches; 1 = mismatches or an
 *     incomplete fetch (the page cap was reached, so absence proves nothing).
 */
import { withTransaction } from '../../db.js';
import { audit } from '../../audit.js';
import { fail } from '../../errors.js';
import { fetchReconciliationPage, reconcilePage } from './reconcile.js';

export const RECONCILE_LISTS = 4;                     // invoices, charges, refunds, disputes
export const DAILY_DEFAULTS = Object.freeze({ overlapHours: 6, maxPages: 2, maxRequests: 8 });
const DAY_MS = 86400000;
const ACTOR = { actorType: 'system', actorId: 'stripe-daily-reconcile' };

const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * planDailyReconcile({ day?, now?, overlapHours?, maxPages?, maxRequests? })
 * Pure: no database, no request. `day` defaults to the previous UTC day.
 */
export function planDailyReconcile({ day, now = new Date(), overlapHours = DAILY_DEFAULTS.overlapHours, maxPages = DAILY_DEFAULTS.maxPages,
  maxRequests = DAILY_DEFAULTS.maxRequests } = {}) {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let dayStart;
  if (day === undefined || day === null) dayStart = todayStart - DAY_MS;
  else {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day + 'T00:00:00Z'))) fail('INVALID_INPUT', 'day must be YYYY-MM-DD');
    dayStart = Date.parse(day + 'T00:00:00Z');
    if (isoDay(new Date(dayStart)) !== day) fail('INVALID_INPUT', 'day must be a real calendar date');
  }
  if (dayStart + DAY_MS > now.getTime()) fail('INVALID_INPUT', 'only a finished UTC day can be reconciled');
  if (!Number.isFinite(overlapHours) || overlapHours < 0 || overlapHours > 48) fail('INVALID_INPUT', 'overlapHours must be 0..48');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) fail('INVALID_INPUT', 'maxPages must be 1..20');
  if (!Number.isInteger(maxRequests) || maxRequests < 1) fail('INVALID_INPUT', 'maxRequests must be a positive whole number');
  const overlapSeconds = Math.round(overlapHours * 3600);
  const plannedRequests = RECONCILE_LISTS * maxPages;
  return Object.freeze({
    day: isoDay(new Date(dayStart)),
    dayStart: new Date(dayStart), dayEnd: new Date(dayStart + DAY_MS),
    fetchFrom: new Date(dayStart - overlapSeconds * 1000), fetchTo: new Date(dayStart + DAY_MS),
    overlapSeconds, maxPages, maxRequests, plannedRequests,
    withinCap: plannedRequests <= maxRequests,
  });
}

/** Coin-pack purchases vs Stripe ledger charge rows in [from, to). Read-only. */
export async function coinPurchaseLedgerMismatches(db, { from, to }) {
  const r = await db.query('SELECT * FROM membership.coin_purchase_ledger_mismatches($1, $2) ORDER BY kind, charge_id NULLS LAST, ledger_id NULLS LAST', [from, to]);
  return r.rows.map((x) => ({ kind: x.kind, coinOperationId: x.coin_operation_id, ledgerId: x.ledger_id, chargeId: x.charge_id, coins: x.coins, amountCents: x.amount_cents }));
}

function alertKey(m) {
  if (m.kind.startsWith('coin_')) return [m.kind, m.coinOperationId || '-', m.ledgerId ?? '-'].join('|');
  return [m.kind, m.objectType || '-', m.objectId || '-', m.entryType || '-'].join('|');
}

/**
 * runDailyReconcile({ pool, stripe, cap }, plan, { alert })
 *   stripe: a client created with cap.fetch as its transport.
 *   alert(payload): called with { day, runId, livemode, complete, alerts[] } when
 *   there are alerts not yet notified. Ids and amounts only, never customer data.
 */
export async function runDailyReconcile({ pool, stripe, cap }, plan, { alert = async () => {} } = {}) {
  if (!cap || typeof cap.assertPlan !== 'function' || typeof cap.used !== 'function') fail('INVALID_INPUT', 'a request cap (request-cap.js) is required');
  if (!plan || !(plan.dayStart instanceof Date)) fail('INVALID_INPUT', 'a plan from planDailyReconcile is required');
  if (plan.maxRequests !== cap.max) fail('INVALID_INPUT', 'the plan and the request cap disagree on the cap');
  cap.assertPlan(plan.plannedRequests);                   // refuse before the first request; never trim

  const page = await fetchReconciliationPage(stripe, { from: plan.fetchFrom, to: plan.fetchTo, maxPages: plan.maxPages });
  const report = await reconcilePage(pool, { ...page, window: { from: plan.dayStart, to: plan.dayEnd } }, { livemode: stripe.livemode });
  const coin = await coinPurchaseLedgerMismatches(pool, { from: plan.dayStart, to: plan.dayEnd });

  const mismatches = [
    ...report.mismatches,
    ...coin.map((c) => ({ ...c, kind: 'coin_' + c.kind, objectType: 'charge', objectId: c.chargeId, entryType: 'charge' })),
    ...(page.complete ? [] : [{ kind: 'incomplete_fetch', objectType: 'day', objectId: plan.day, maxPages: plan.maxPages }]),
  ];
  const livemode = stripe.livemode === true;

  const out = await withTransaction(pool, async (c) => {
    const runId = (await c.query(
      `INSERT INTO reconciliation_runs (provider, window_from, window_to, livemode, complete, checked, matched, mismatch_count, mismatches)
       VALUES ('stripe', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [plan.fetchFrom, plan.fetchTo, livemode, page.complete, report.checked, report.matched, mismatches.length, JSON.stringify(mismatches)])).rows[0].id;
    let fresh = 0, repeat = 0;
    for (const m of mismatches) {
      const { kind, objectType = null, objectId = null, entryType = null, ...details } = m;
      const r = (await c.query(
        `INSERT INTO reconciliation_alerts (provider, livemode, mismatch_key, kind, object_type, object_id, entry_type, details, first_day, last_day, first_run_id, last_run_id)
         VALUES ('stripe', $1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $9)
         ON CONFLICT (provider, livemode, mismatch_key) WHERE status = 'open'
         DO UPDATE SET seen_count = reconciliation_alerts.seen_count + 1, last_run_id = EXCLUDED.last_run_id, details = EXCLUDED.details,
                       last_day = GREATEST(reconciliation_alerts.last_day, EXCLUDED.last_day), last_seen_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [livemode, alertKey(m), kind, objectType, objectId == null ? null : String(objectId), entryType, JSON.stringify(details), plan.day, runId])).rows[0];
      if (r.inserted) fresh++; else repeat++;
    }
    await c.query(
      `INSERT INTO reconciliation_daily_runs (run_id, provider, livemode, day, overlap_seconds, request_cap, requests_made, coin_mismatches, new_alerts, repeat_alerts)
       VALUES ($1, 'stripe', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [runId, livemode, plan.day, plan.overlapSeconds, cap.max, cap.used(), coin.length, fresh, repeat]);
    await audit(c, { ...ACTOR, action: 'reconciliation.daily_run', entityType: 'reconciliation_run', entityId: runId,
      after: { day: plan.day, complete: page.complete, mismatches: mismatches.length, newAlerts: fresh, requests: cap.used() } });
    return { runId, fresh, repeat };
  });

  // Notify: everything open and not yet notified (this run's new alerts, plus any whose alert() failed before).
  const pending = (await pool.query(
    `SELECT id, kind, object_type, object_id, entry_type, details, first_day::text AS first_day, seen_count FROM reconciliation_alerts
      WHERE provider = 'stripe' AND livemode = $1 AND status = 'open' AND notified_at IS NULL ORDER BY first_seen_at, mismatch_key`, [livemode])).rows;
  if (pending.length) {
    await alert({
      day: plan.day, runId: out.runId, livemode, complete: page.complete,
      alerts: pending.map((a) => ({ id: a.id, kind: a.kind, objectType: a.object_type, objectId: a.object_id, entryType: a.entry_type, firstDay: a.first_day, seenCount: a.seen_count, ...a.details })),
    });
    await pool.query('UPDATE reconciliation_alerts SET notified_at = now() WHERE id = ANY($1) AND notified_at IS NULL', [pending.map((a) => a.id)]);
  }

  return {
    day: plan.day, runId: out.runId, livemode, complete: page.complete,
    checked: report.checked, matched: report.matched, skipped: report.skipped.length,
    mismatches, coinMismatches: coin.length, newAlerts: out.fresh, repeatAlerts: out.repeat, notified: pending.length,
    requestsMade: cap.used(), requestCap: cap.max,
    exitCode: mismatches.length || !page.complete ? 1 : 0,
  };
}

/** A human closes an alert once the mismatch is explained or fixed. A later recurrence opens a new one. */
export async function resolveReconciliationAlert(pool, alertId, { by }) {
  if (typeof by !== 'string' || !by.trim()) fail('INVALID_INPUT', 'resolved_by is required');
  return withTransaction(pool, async (c) => {
    const r = await c.query("UPDATE reconciliation_alerts SET status = 'resolved', resolved_at = now(), resolved_by = $2 WHERE id = $1 AND status = 'open' RETURNING id", [alertId, by]);
    if (!r.rowCount) fail('NOT_FOUND', 'open alert not found');
    await audit(c, { actorType: 'admin', actorId: by, action: 'reconciliation.alert_resolved', entityType: 'reconciliation_alert', entityId: alertId });
    return { resolved: true };
  });
}
