/**
 * Regression tests for the independent review of PR #291 (findings 1-9, 13).
 * Each test is a scenario that went wrong before the fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, person, actor } from './_db.js';
import { signForTest } from '../src/stripe/signature.js';
import { ingestStripeWebhook } from '../src/stripe/ingest.js';
import { processPending, replay } from '../src/stripe/processor.js';
import { stripeHandlers } from '../src/stripe/handlers.js';
import { seedCatalog, currentVersion, createDraftVersion } from '../src/plans.js';
import { resolveOrCreatePerson } from '../src/identity.js';
import { hasEntitlement, computeEntitlements } from '../src/entitlements.js';
import * as coins from '../src/coins.js';

const SECRET = 'whsec_test_fixture_' + 'a'.repeat(24);
const T = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);
const NOW = T * 1000;
let n = 0;
const evt = (type, object, created = T) => ({ id: 'evt_rr_' + (++n), object: 'event', type, created, livemode: false, data: { object } });
async function send(pool, event) { const raw = JSON.stringify(event); return ingestStripeWebhook(pool, { rawBody: raw, signatureHeader: signForTest(SECRET, raw, T), secrets: [SECRET], now: NOW }); }
const run = (pool, ms = 1000) => processPending(pool, { handlers: stripeHandlers, now: new Date(NOW + ms) });
async function setup(pool) {
  await seedCatalog(pool);
  for (const [k, pid] of [['standard', 'price_std'], ['professional', 'price_pro']]) {
    const v = await currentVersion(pool, k);
    const priceId = (await pool.query("SELECT id FROM plan_version_prices WHERE plan_version_id = $1 AND billing_interval = 'month'", [v.id])).rows[0].id;
    await pool.query("INSERT INTO provider_price_refs (plan_version_price_id, provider, external_price_id) VALUES ($1, 'stripe', $2)", [priceId, pid]);
  }
  return (await resolveOrCreatePerson(pool, { platform: 'stripe', kind: 'customer', externalId: 'cus_1' })).personId;
}
const sub = (status, price = 'price_std', extra = {}) => ({ id: 'sub_1', customer: 'cus_1', status, items: { data: [{ price: { id: price }, current_period_start: T, current_period_end: T + 30 * 86400 }] }, ...extra });
const statuses = async (pool) => (await pool.query('SELECT status, count(*)::int n FROM webhook_events GROUP BY status ORDER BY status')).rows.map((r) => `${r.status}:${r.n}`);
const subStatus = async (pool) => (await pool.query('SELECT status FROM subscriptions')).rows.map((r) => r.status);

test('a declined first payment leaves the subscription incomplete, not dead-lettered', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    await setup(pool);
    await send(pool, evt('customer.subscription.created', sub('incomplete'), T));
    await send(pool, evt('invoice.payment_failed', { id: 'in_1', subscription: 'sub_1', customer: 'cus_1', lines: { data: [{ price: { id: 'price_std' } }] } }, T + 1));
    await run(pool);
    assert.deepEqual(await statuses(pool), ['ignored:1', 'processed:1']);
    assert.deepEqual(await subStatus(pool), ['incomplete']);
  } finally { await pool.end(); }
});

test('an invoice paid after cancellation is still booked', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    await setup(pool);
    await send(pool, evt('customer.subscription.created', sub('active'), T));
    await send(pool, evt('customer.subscription.deleted', sub('canceled'), T + 10));
    await send(pool, evt('invoice.paid', { id: 'in_final', subscription: 'sub_1', customer: 'cus_1', amount_paid: 1234, currency: 'usd' }, T + 20));
    await run(pool);
    assert.deepEqual(await statuses(pool), ['processed:3']);
    assert.equal((await pool.query('SELECT sum(amount_cents)::int s FROM payment_ledger')).rows[0].s, 1234);
    assert.deepEqual(await subStatus(pool), ['canceled']);
  } finally { await pool.end(); }
});

test('same-second terminal events and replays of them are no-ops without duplicate history', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    await setup(pool);
    await send(pool, evt('customer.subscription.created', sub('active'), T));
    await send(pool, evt('customer.subscription.updated', sub('canceled'), T + 10));
    await send(pool, evt('customer.subscription.deleted', sub('canceled'), T + 10));
    await run(pool);
    assert.deepEqual(await statuses(pool), ['processed:3']);
    const id = (await pool.query("SELECT id FROM webhook_events WHERE event_type = 'customer.subscription.updated'")).rows[0].id;
    assert.equal(await replay(pool, id, actor), true);
    await run(pool, 2000);
    assert.equal((await pool.query('SELECT status FROM webhook_events WHERE id = $1', [id])).rows[0].status, 'processed');
    assert.equal((await pool.query("SELECT count(*)::int n FROM subscription_events WHERE to_status = 'canceled'")).rows[0].n, 1, 'one cancel in history');
  } finally { await pool.end(); }
});

test('invoices of non-Gaia Stripe subscriptions are ignored, not retried', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    await setup(pool);
    await send(pool, evt('customer.subscription.created', { ...sub('active', 'price_other'), id: 'sub_other' }, T));
    await send(pool, evt('invoice.paid', { id: 'in_o', subscription: 'sub_other', customer: 'cus_1', amount_paid: 999, currency: 'usd', lines: { data: [{ price: { id: 'price_other' } }] } }, T + 1));
    await run(pool);
    assert.deepEqual(await statuses(pool), ['ignored:2']);
  } finally { await pool.end(); }
});

test('a subscription first seen past_due is recorded as past_due', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    await setup(pool);
    await send(pool, evt('customer.subscription.updated', sub('past_due'), T));
    await run(pool);
    assert.deepEqual(await subStatus(pool), ['past_due']);
  } finally { await pool.end(); }
});

test('an upgrade on the Stripe item moves the subscription to the new plan', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    const p = await setup(pool);
    await send(pool, evt('customer.subscription.created', sub('active'), T));
    await send(pool, evt('customer.subscription.updated', sub('active', 'price_pro'), T + 10));
    await run(pool);
    assert.deepEqual((await pool.query('SELECT p.key FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id')).rows.map((r) => r.key), ['professional']);
    assert.equal(await hasEntitlement(pool, p, 'crm.ghl_subaccount', new Date(NOW + 5000)), true);
    assert.equal((await pool.query("SELECT count(*)::int n FROM subscription_events WHERE reason = 'plan_changed'")).rows[0].n, 1);
  } finally { await pool.end(); }
});

test('refunds: refund.* events book succeeded refunds only, once', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    await setup(pool);
    await send(pool, evt('refund.created', { id: 're_9', object: 'refund', amount: 500, currency: 'usd', status: 'pending', created: T }, T));
    await send(pool, evt('refund.updated', { id: 're_9', object: 'refund', amount: 500, currency: 'usd', status: 'succeeded', created: T }, T + 5));
    await send(pool, evt('charge.refund.updated', { id: 're_9', object: 'refund', amount: 500, currency: 'usd', status: 'succeeded', created: T }, T + 6));
    await run(pool);
    assert.deepEqual((await pool.query('SELECT amount_cents FROM payment_ledger')).rows.map((r) => r.amount_cents), [-500]);
  } finally { await pool.end(); }
});

test('granted coins do not outlive their cycle (release, refund, late or out-of-order grants)', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    const p = await person(pool);
    await coins.grantAllowance(pool, { personId: p, coins: 100, cycleKey: 'c1:rr-a', resetAt: new Date('2026-11-01') });
    const h = await coins.holdDebit(pool, { personId: p, coins: 100, idempotencyKey: 'job-rr-0001', reason: 'ai' });
    await coins.grantAllowance(pool, { personId: p, coins: 100, cycleKey: 'c2:rr-a', resetAt: new Date('2026-12-01') });
    const rel = await coins.releaseDebit(pool, h.operation.id);
    assert.equal(rel.forfeitedGrantedCoins, 100);
    assert.equal((await pool.query('SELECT granted_balance FROM coin_wallets')).rows[0].granted_balance, 100, 'not 200');

    const d = await coins.debitNow(pool, { personId: p, coins: 100, idempotencyKey: 'job-rr-0002', reason: 'ai' });
    await coins.grantAllowance(pool, { personId: p, coins: 100, cycleKey: 'c3:rr-a', resetAt: new Date('2026-12-01T00:00:01Z') });
    const r = await coins.refundDebit(pool, { operationId: d.operation.id, idempotencyKey: 'refund-rr-0001', reason: 's', actor: 'a' });
    assert.equal(r.forfeitedGrantedCoins, 100, 'decided by ledger order, not by a caller-supplied date');
    await assert.rejects(coins.refundDebit(pool, { operationId: d.operation.id, idempotencyKey: 'refund-rr-0002', reason: 's', actor: 'a' }), (e) => e.code === 'CONFLICT');

    await assert.rejects(coins.grantAllowance(pool, { personId: p, coins: 300, cycleKey: 'c0:rr-a', resetAt: new Date('2026-10-01') }), (e) => e.code === 'CONFLICT', 'an older cycle never overwrites a newer allowance');
    assert.equal((await pool.query('SELECT granted_balance FROM coin_wallets')).rows[0].granted_balance, 100);
    assert.deepEqual((await pool.query('SELECT * FROM wallet_mismatches()')).rows, []);
  } finally { await pool.end(); }
});

test('replaying a released hold is refused, so a retried job is never free', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    const p = await person(pool);
    await coins.creditPurchase(pool, { personId: p, coins: 100, idempotencyKey: 'pay-rr-0001', paymentRef: 'x' });
    const h = await coins.holdDebit(pool, { personId: p, coins: 50, idempotencyKey: 'job-rr-0011', reason: 'ai' });
    await coins.releaseDebit(pool, h.operation.id);
    await assert.rejects(coins.debitNow(pool, { personId: p, coins: 50, idempotencyKey: 'job-rr-0011', reason: 'ai' }), (e) => e.code === 'CONFLICT');
  } finally { await pool.end(); }
});

test('false and zero benefit values are not entitlements; merging is symmetric', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    await seedCatalog(pool);
    const p = await person(pool);
    await pool.query("INSERT INTO entitlement_grants (person_id, entitlement_key, value, source, granted_by) VALUES ($1, 'support.premium', 'false', 'manual', 'x'), ($1, 'discount.certifications_pct', '0', 'manual', 'x')", [p]);
    assert.equal(await hasEntitlement(pool, p, 'support.premium'), false);
    assert.equal(await hasEntitlement(pool, p, 'discount.certifications_pct'), false);
    const m = (a, b) => computeEntitlements({ subscriptions: [{ id: '1', status: 'active', entitlements: { k: a } }, { id: '2', status: 'active', entitlements: { k: b } }] }).entitlements.k.value;
    assert.equal(m(5, false), 5); assert.equal(m(false, 5), 5); assert.equal(m(true, 20), 20); assert.equal(m(20, true), 20);
  } finally { await pool.end(); }
});

test('a price cannot be added to a version while it is being published', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    await seedCatalog(pool);
    const planId = (await pool.query("SELECT id FROM plans WHERE key = 'standard'")).rows[0].id;
    const d = await createDraftVersion(pool, planId, { prices: { month: 5000 } }, actor);
    const a = await pool.connect(), b = await pool.connect();
    try {
      await a.query('BEGIN'); await a.query('SELECT id FROM plan_versions WHERE id = $1 FOR UPDATE', [d.id]);
      await a.query("UPDATE plan_versions SET status = 'published', published_at = now() WHERE id = $1", [d.id]);
      await b.query('BEGIN');
      const ins = b.query("INSERT INTO plan_version_prices (plan_version_id, billing_interval, amount_cents) VALUES ($1, 'year', 1)", [d.id]);
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      await assert.rejects(ins, /cannot change/);
      await b.query('ROLLBACK');
    } finally { a.release(); b.release(); }
    assert.equal((await pool.query("SELECT count(*)::int n FROM plan_version_prices WHERE plan_version_id = $1 AND billing_interval = 'year'", [d.id])).rows[0].n, 0);
    await assert.rejects(pool.query("UPDATE plan_versions SET status = 'retired', retired_at = now(), created_at = '2000-01-01' WHERE id = $1", [d.id]), /identity cannot change/);
  } finally { await pool.end(); }
});

test('an active subscription whose renewal never arrived loses access after the leeway', async () => {
  const { grantsAccess, PERIOD_END_LEEWAY_MS } = await import('../src/subscriptions.js');
  const end = new Date('2026-12-31T00:00:00Z');
  assert.equal(grantsAccess({ status: 'active', current_period_end: end }, new Date(end.getTime() + PERIOD_END_LEEWAY_MS - 1)), true);
  assert.equal(grantsAccess({ status: 'active', current_period_end: end }, new Date(end.getTime() + PERIOD_END_LEEWAY_MS + 1)), false);
  assert.equal(grantsAccess({ status: 'trialing' }, new Date()), false, 'a trial needs an end date');
});
