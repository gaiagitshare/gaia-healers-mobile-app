import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, actor, person } from './_db.js';
import { seedCatalog, currentVersion } from '../src/plans.js';
import { createSubscription, transition } from '../src/subscriptions.js';
import { holdDebit } from '../src/coins.js';
import { runMonthlyAllowance, cycleStart, nextCycleStart } from '../src/jobs/allowance.js';
import { runSubscriptionMaintenance, runHoldCleanup } from '../src/jobs/maintenance.js';

const D = (s) => new Date(s);
const bal = async (pool, p) => (await pool.query('SELECT granted_balance g, purchased_balance pu FROM coin_wallets WHERE person_id = $1', [p])).rows[0];

test('cycle dates clamp to short months and never precede the anchor', () => {
  const a = D('2026-01-31T10:00:00Z');
  assert.equal(cycleStart(a, D('2026-02-28T10:00:00Z')).toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(cycleStart(a, D('2026-03-30T00:00:00Z')).toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(nextCycleStart(a, D('2026-03-31T11:00:00Z')).toISOString(), '2026-04-30T10:00:00.000Z');
  assert.equal(cycleStart(a, D('2026-01-01T00:00:00Z')).toISOString(), a.toISOString());
});

test('monthly allowance: once per cycle, largest plan wins, annual plans grant monthly, lapse expires leftovers', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await seedCatalog(pool);
    const std = await currentVersion(pool, 'standard'), pro = await currentVersion(pool, 'professional');
    const a = await person(pool), b = await person(pool);
    await createSubscription(pool, { personId: a, planVersionId: std.id, interval: 'month', status: 'active', periodStart: D('2026-12-01T00:00:00Z'), periodEnd: D('2027-01-01T00:00:00Z') }, actor);
    await createSubscription(pool, { personId: a, planVersionId: pro.id, interval: 'month', status: 'active', periodStart: D('2026-12-01T00:00:00Z'), periodEnd: D('2027-01-01T00:00:00Z') }, actor);
    const bSub = await createSubscription(pool, { personId: b, planVersionId: std.id, interval: 'year', status: 'active', periodStart: D('2026-12-10T00:00:00Z'), periodEnd: D('2027-12-10T00:00:00Z') }, actor);

    assert.deepEqual(await runMonthlyAllowance(pool, { now: D('2026-12-15T00:00:00Z') }), { granted: 2, alreadyGranted: 0, expired: 0, skipped: 0 });
    assert.deepEqual(await runMonthlyAllowance(pool, { now: D('2026-12-20T00:00:00Z') }), { granted: 0, alreadyGranted: 2, expired: 0, skipped: 0 }, 're-run grants nothing');
    assert.equal((await bal(pool, a)).g, 2000, 'Professional allowance, not 2,000 + 500');
    assert.equal((await bal(pool, b)).g, 500);
    await runMonthlyAllowance(pool, { now: D('2027-01-12T00:00:00Z') });
    assert.equal((await pool.query("SELECT count(*)::int n FROM coin_operations o JOIN coin_wallets w ON w.id = o.wallet_id WHERE w.person_id = $1 AND o.kind = 'grant'", [b])).rows[0].n, 2, 'annual plan: second monthly grant');

    await transition(pool, bSub, 'canceled', { reason: 'fixture' });
    const r = await runMonthlyAllowance(pool, { now: D('2027-01-20T00:00:00Z') });
    assert.equal(r.expired, 1);
    assert.equal((await bal(pool, b)).g, 0, 'no allowance without a granting plan');
    assert.equal((await runMonthlyAllowance(pool, { now: D('2027-01-21T00:00:00Z') })).expired, 0);
    assert.deepEqual((await pool.query('SELECT * FROM wallet_mismatches()')).rows, []);
  } finally { await pool.end(); }
});

test('grace and scheduled ends: Gaia-owned subscriptions are closed, provider-owned ones only counted', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await seedCatalog(pool);
    const v = await currentVersion(pool, 'standard');
    const p = await person(pool);
    const sim = await createSubscription(pool, { personId: p, planVersionId: v.id, interval: 'month', status: 'active' }, actor);
    const stripe = await createSubscription(pool, { personId: p, planVersionId: v.id, interval: 'month', status: 'active', provider: 'stripe', providerSubscriptionId: 'sub_fixture_grace' }, actor);
    const t = D('2026-12-01T00:00:00Z');
    await transition(pool, sim, 'past_due', { now: t, graceDays: 7 });
    await transition(pool, stripe, 'past_due', { now: t, graceDays: 7 });
    assert.deepEqual(await runSubscriptionMaintenance(pool, { now: D('2026-12-05T00:00:00Z') }), { ended: 0, providerOwnedOverdue: 0 }, 'inside grace nothing happens');
    assert.deepEqual(await runSubscriptionMaintenance(pool, { now: D('2026-12-09T00:00:00Z') }), { ended: 1, providerOwnedOverdue: 1 });
    const st = Object.fromEntries((await pool.query('SELECT provider, status FROM subscriptions')).rows.map((r) => [r.provider, r.status]));
    assert.deepEqual(st, { simulated: 'expired', stripe: 'past_due' }, 'Stripe stays the billing truth for its own subscription');
    const ev = (await pool.query("SELECT reason FROM subscription_events WHERE subscription_id = $1 ORDER BY id DESC LIMIT 1", [sim])).rows[0].reason;
    assert.equal(ev, 'grace_elapsed');
  } finally { await pool.end(); }
});

test('stale holds are released by the cleanup job', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const p = await person(pool);
    await pool.query('INSERT INTO coin_wallets (person_id, purchased_balance) VALUES ($1, 0)', [p]);
    const { creditPurchase } = await import('../src/coins.js');
    await creditPurchase(pool, { personId: p, coins: 100, idempotencyKey: 'pay-fixture-job-1', paymentRef: 'sim_pay_job_1' });
    const t0 = new Date();
    await holdDebit(pool, { personId: p, coins: 70, idempotencyKey: 'job-hold-fixture-01', reason: 'ai', holdSeconds: 60, now: t0 });
    assert.deepEqual(await runHoldCleanup(pool, { now: new Date(t0.getTime() + 61000) }), { released: 1 });
    assert.equal((await bal(pool, p)).pu, 100);
  } finally { await pool.end(); }
});
