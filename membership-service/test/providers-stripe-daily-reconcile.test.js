import './_providers-deny-network.mjs';
/**
 * Daily reconciliation job and its CLI, against a LOOPBACK fake Stripe and the
 * throwaway test database. Covers: previous-UTC-day window + overlap, per-day
 * idempotency (a re-run is a new run, never a duplicate alert), pluggable
 * alert with re-send after a failed alert, exit codes, the hard request cap
 * (refused above the cap before sending; the request past it throws), dry run
 * by default and live keys refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, TEST_URL } from './_db.js';
import { fakeStripe, fetchVia, noSleep } from './_providers-fakes.js';
import { createStripeClient } from '../src/providers/stripe/client.js';
import { createRequestCap } from '../src/providers/request-cap.js';
import { planDailyReconcile, runDailyReconcile, resolveReconciliationAlert, DAILY_DEFAULTS } from '../src/providers/stripe/daily-reconcile.js';
import { main } from '../src/cli/reconcile-daily.js';
import { resolveOrCreatePerson } from '../src/identity.js';
import { createPool } from '../src/db.js';

const KEY = 'sk_test_fixture_' + 'z'.repeat(16);
const NOW = new Date('2026-12-02T03:00:00Z');                 // "yesterday" = 2026-12-01
const T = (iso) => Math.floor(Date.parse(iso) / 1000);

function deps(pool, srv, plan, extra = {}) {
  const cap = createRequestCap({ label: 'test', max: plan.maxRequests, fetch: fetchVia });
  return { pool, cap, stripe: createStripeClient({ apiKey: KEY, fetch: cap.fetch, baseUrl: srv.url, sleep: noSleep, ...extra }) };
}
async function ledgerRow(pool, personId, type, id, entry, amount, at) {
  await pool.query(`INSERT INTO payment_ledger (person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, livemode, occurred_at)
                    VALUES ($1, 'stripe', $2, $3, $4, $5, 'USD', false, $6)`, [personId, type, id, entry, amount, at]);
}
const linked = async (pool, cus) => (await resolveOrCreatePerson(pool, { platform: 'stripe', kind: 'customer', externalId: cus })).personId;

test('plan: previous UTC day plus a backward overlap; only finished days; request count = 4 lists x pages', () => {
  const p = planDailyReconcile({ now: NOW });
  assert.equal(p.day, '2026-12-01');
  assert.equal(p.dayStart.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(p.dayEnd.toISOString(), '2026-12-02T00:00:00.000Z');
  assert.equal(p.fetchFrom.toISOString(), '2026-11-30T18:00:00.000Z', `${DAILY_DEFAULTS.overlapHours}h overlap`);
  assert.equal(p.plannedRequests, 8);
  assert.equal(p.maxRequests, 8);
  assert.equal(p.withinCap, true);
  assert.equal(planDailyReconcile({ now: NOW, day: '2026-11-15' }).day, '2026-11-15');
  assert.throws(() => planDailyReconcile({ now: NOW, day: '2026-12-02' }), /finished UTC day/);
  assert.throws(() => planDailyReconcile({ now: NOW, day: '2026-02-30' }), /real calendar date/);
  assert.throws(() => planDailyReconcile({ now: NOW, day: 'yesterday' }), /YYYY-MM-DD/);
  assert.throws(() => planDailyReconcile({ now: NOW, maxPages: 0 }), /maxPages/);
  assert.equal(planDailyReconcile({ now: NOW, maxPages: 3 }).withinCap, false, '12 planned > cap 8: reported, never trimmed');
  assert.equal(planDailyReconcile({ now: NOW, maxPages: 3 }).maxPages, 3);
});

test('daily run: clean day exits 0; a mismatch alerts once; re-running the day stores a new run without a duplicate alert', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const invoices = [{ id: 'in_d1', status: 'paid', amount_paid: 4700, currency: 'usd', customer: 'cus_d1', created: T('2026-12-01T10:00:00Z') }];
  const srv = await fakeStripe({ lists: { invoices } });
  try {
    const pid = await linked(pool, 'cus_d1');
    await ledgerRow(pool, pid, 'invoice', 'in_d1', 'charge', 4700, '2026-12-01T10:00:00Z');
    const plan = planDailyReconcile({ now: NOW });
    const alerts = [];
    const alert = async (x) => alerts.push(x);

    const d1 = deps(pool, srv, plan);
    const r = await runDailyReconcile(d1, plan, { alert });
    assert.equal(r.exitCode, 0);
    assert.equal(r.matched, 1);
    assert.equal(r.requestsMade, 4, 'one page per list');
    assert.equal(alerts.length, 0);
    const q = srv.requests.find((x) => x.path === '/v1/invoices').query;
    assert.equal(q.get('created[gte]'), String(T('2026-11-30T18:00:00Z')), 'fetch starts at the overlap');
    assert.equal(q.get('created[lt]'), String(T('2026-12-02T00:00:00Z')));

    invoices.push({ id: 'in_d2', status: 'paid', amount_paid: 9700, currency: 'usd', customer: 'cus_d1', created: T('2026-12-01T12:00:00Z') });
    const r2 = await runDailyReconcile(deps(pool, srv, plan), plan, { alert });
    assert.equal(r2.exitCode, 1);
    assert.equal(r2.newAlerts, 1);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].day, '2026-12-01');
    assert.deepEqual(alerts[0].alerts.map((a) => `${a.kind}:${a.objectId}:${a.stripeAmount}`), ['missing_in_ledger:in_d2:9700']);

    const r3 = await runDailyReconcile(deps(pool, srv, plan), plan, { alert });
    assert.equal(r3.exitCode, 1, 'still mismatching');
    assert.equal(r3.newAlerts, 0);
    assert.equal(r3.repeatAlerts, 1);
    assert.equal(alerts.length, 1, 'no duplicate alert for the same mismatch');
    assert.notEqual(r3.runId, r2.runId);
    const days = (await pool.query("SELECT day::text AS day, new_alerts, repeat_alerts, requests_made, request_cap FROM reconciliation_daily_runs ORDER BY created_at")).rows;
    assert.deepEqual(days.map((d) => [d.day, d.new_alerts, d.repeat_alerts, d.requests_made, d.request_cap]),
      [['2026-12-01', 0, 0, 4, 8], ['2026-12-01', 1, 0, 4, 8], ['2026-12-01', 0, 1, 4, 8]]);
    const open = (await pool.query("SELECT id, seen_count, notified_at FROM reconciliation_alerts WHERE status = 'open'")).rows;
    assert.equal(open.length, 1);
    assert.equal(open[0].seen_count, 2);
    assert.ok(open[0].notified_at);
    await assert.rejects(pool.query('DELETE FROM reconciliation_daily_runs'), /append-only/);

    // the next day's overlap sees the same object again: still one alert
    const next = planDailyReconcile({ now: new Date('2026-12-03T03:00:00Z') });
    await runDailyReconcile(deps(pool, srv, next), next, { alert });
    assert.equal(alerts.length, 1);
    // resolved, then seen again: a NEW alert
    await resolveReconciliationAlert(pool, open[0].id, { by: 'test-admin' });
    await runDailyReconcile(deps(pool, srv, plan), plan, { alert });
    assert.equal(alerts.length, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reconciliation_alerts')).rows[0].n, 2);
  } finally { await srv.close(); await pool.end(); }
});

test('a failed alert() is not lost: the next run re-sends it', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeStripe({ lists: { charges: [{ id: 'ch_f1', paid: true, status: 'succeeded', amount: 1000, currency: 'usd', customer: 'cus_f1', created: T('2026-12-01T08:00:00Z') }] } });
  try {
    await linked(pool, 'cus_f1');
    const plan = planDailyReconcile({ now: NOW });
    await assert.rejects(runDailyReconcile(deps(pool, srv, plan), plan, { alert: async () => { throw new Error('pager down'); } }), /pager down/);
    const sent = [];
    const r = await runDailyReconcile(deps(pool, srv, plan), plan, { alert: async (x) => sent.push(x) });
    assert.equal(r.newAlerts, 0, 'not new');
    assert.equal(sent.length, 1, 'but re-sent because it was never notified');
    assert.equal(sent[0].alerts[0].objectId, 'ch_f1');
    await runDailyReconcile(deps(pool, srv, plan), plan, { alert: async (x) => sent.push(x) });
    assert.equal(sent.length, 1, 'once notified, not again');
  } finally { await srv.close(); await pool.end(); }
});

test('overlap: an object created before the day is matched; a ledger row in the overlap is not judged missing in Stripe', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeStripe({ lists: { invoices: [{ id: 'in_late', status: 'paid', amount_paid: 4700, currency: 'usd', customer: 'cus_o1', created: T('2026-11-30T23:30:00Z'), status_transitions: { paid_at: T('2026-12-01T00:20:00Z') } }] } });
  try {
    const pid = await linked(pool, 'cus_o1');
    await ledgerRow(pool, pid, 'invoice', 'in_late', 'charge', 4700, '2026-12-01T00:20:00Z');
    await ledgerRow(pool, pid, 'invoice', 'in_prevday', 'charge', 4700, '2026-11-30T22:00:00Z');   // previous day's business
    const plan = planDailyReconcile({ now: NOW });
    const r = await runDailyReconcile(deps(pool, srv, plan), plan, {});
    assert.equal(r.exitCode, 0, JSON.stringify(r.mismatches));
    assert.equal(r.matched, 1);
  } finally { await srv.close(); await pool.end(); }
});

test('incomplete fetch (page cap reached) exits non-zero with an incomplete_fetch alert', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const invoices = Array.from({ length: 120 }, (_, i) => ({ id: `in_i${i}`, status: 'paid', amount_paid: 100, currency: 'usd', customer: 'cus_i', created: T('2026-12-01T01:00:00Z') }));
  const srv = await fakeStripe({ lists: { invoices } });
  try {
    const pid = await linked(pool, 'cus_i');
    for (const i of invoices) await ledgerRow(pool, pid, 'invoice', i.id, 'charge', 100, '2026-12-01T01:00:00Z');
    const plan = planDailyReconcile({ now: NOW, maxPages: 1, maxRequests: 4 });
    const sent = [];
    const r = await runDailyReconcile(deps(pool, srv, plan), plan, { alert: async (x) => sent.push(x) });
    assert.equal(r.complete, false);
    assert.equal(r.exitCode, 1);
    assert.deepEqual(r.mismatches.map((m) => m.kind), ['incomplete_fetch']);
    assert.equal(sent[0].alerts[0].kind, 'incomplete_fetch');
  } finally { await srv.close(); await pool.end(); }
});

test('hard cap: a plan above the cap is refused before any request; a retry that would pass the cap throws and records nothing', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeStripe();
  try {
    const big = planDailyReconcile({ now: NOW, maxPages: 3 });           // 12 > 8
    await assert.rejects(runDailyReconcile(deps(pool, srv, big), big, {}), (e) => e.code === 'REQUEST_CAP_EXCEEDED');
    assert.equal(srv.requests.length, 0, 'refused before sending');
    const mismatch = planDailyReconcile({ now: NOW });
    const wrongCap = { ...deps(pool, srv, mismatch), cap: createRequestCap({ max: 50, fetch: fetchVia }) };
    await assert.rejects(runDailyReconcile(wrongCap, mismatch, {}), /disagree/);

    const tight = planDailyReconcile({ now: NOW, maxPages: 1, maxRequests: 4 });
    srv.faults.push({ status: 500, json: {} });                         // one retry eats the budget
    const d = deps(pool, srv, tight);
    await assert.rejects(runDailyReconcile(d, tight, {}), (e) => e.code === 'REQUEST_CAP_EXCEEDED');
    assert.equal(srv.requests.length, 4, 'never past the cap');
    assert.equal(d.cap.refused(), 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reconciliation_runs')).rows[0].n, 0);
  } finally { await srv.close(); await pool.end(); }
});

// ---- CLI ---------------------------------------------------------------------

function cli(env, extra = {}) {
  const lines = [];
  const run = (argv) => main(argv, { env, fetch: fetchVia, now: NOW, out: (s) => lines.push(s), err: (s) => lines.push(s), ...extra });
  return { run, lines, text: () => lines.join('\n') };
}

test('CLI: dry run is the default and sends nothing; live keys refused without --allow-live; above-cap plans refused', async () => {
  const srv = await fakeStripe();
  try {
    const h = cli({ STRIPE_RECONCILE_KEY: KEY }, { baseUrl: srv.url });
    assert.equal(await h.run([]), 0);
    assert.match(h.text(), /day 2026-12-01/);
    assert.match(h.text(), /planned Stripe requests: 8 .* cap: 8/);
    assert.match(h.text(), /dry run: nothing sent \(key mode: test\)/);
    assert.equal(await h.run(['--run', '--dry-run']), 0, '--dry-run wins');
    assert.equal(await h.run(['--max-pages', '3']), 2, 'above the cap: refused, not trimmed');
    assert.match(h.text(), /REFUSED: 12 planned requests exceed the cap of 8/);
    assert.equal(await h.run(['--day', '2026-12-02']), 2, 'unfinished day');
    assert.equal(await h.run(['--nope']), 2);
    for (const k of ['sk_live_' + 'a'.repeat(24), 'rk_live_' + 'b'.repeat(24)]) {
      const l = cli({ STRIPE_RECONCILE_KEY: k, MEMBERSHIP_DATABASE_URL: TEST_URL || 'postgres://127.0.0.1/none_test' }, { baseUrl: srv.url });
      assert.equal(await l.run(['--run']), 2);
      assert.equal(await l.run([]), 2, 'refused even for a dry run');
      assert.match(l.text(), /REFUSED: a live Stripe key/);
      assert.ok(!l.text().includes(k));
    }
    assert.equal(await cli({ STRIPE_RECONCILE_KEY: 'pk_test_' + 'c'.repeat(20) }).run(['--run']), 2);
    assert.equal(await cli({}).run(['--run']), 2, 'no key');
    assert.equal(srv.requests.length, 0, 'nothing sent by any of these');
  } finally { await srv.close(); }
});

test('CLI --run: exit 0 on a clean day, 1 on a mismatch; counts printed, key never printed', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const invoices = [{ id: 'in_c1', status: 'paid', amount_paid: 4700, currency: 'usd', customer: 'cus_c1', created: T('2026-12-01T10:00:00Z') }];
  const srv = await fakeStripe({ lists: { invoices } });
  try {
    await linked(pool, 'cus_c1');
    const env = { STRIPE_RECONCILE_KEY: KEY, MEMBERSHIP_DATABASE_URL: TEST_URL };
    const alerts = [];
    const h = cli(env, { baseUrl: srv.url, createPool: (u) => createPool(u), alert: async (x) => alerts.push(x) });
    assert.equal(await h.run(['--run']), 1);
    assert.match(h.text(), /missing_in_ledger invoice in_c1 charge/);
    assert.match(h.text(), /Stripe requests made: 4 of cap 8/);
    assert.equal(alerts.length, 1);
    const pid = (await pool.query("SELECT person_id FROM person_identities WHERE external_id = 'cus_c1'")).rows[0].person_id;
    await ledgerRow(pool, pid, 'invoice', 'in_c1', 'charge', 4700, '2026-12-01T10:00:00Z');
    const h2 = cli(env, { baseUrl: srv.url, alert: async (x) => alerts.push(x) });
    assert.equal(await h2.run(['--run']), 0);
    assert.ok(!h.text().includes(KEY) && !h2.text().includes(KEY));
  } finally { await srv.close(); await pool.end(); }
});
