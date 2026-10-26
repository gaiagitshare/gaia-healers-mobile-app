import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, person } from './_db.js';
import { grantAllowance, creditPurchase, holdDebit, captureDebit, releaseDebit, debitNow, refundDebit, releaseExpiredHolds, walletView, openingBalance, quote } from '../src/coins.js';

async function reconciles(pool) {
  assert.deepEqual((await pool.query('SELECT * FROM wallet_mismatches()')).rows, [], 'wallet balances equal the sum of their transactions');
}
const bal = async (pool, p) => (await pool.query('SELECT granted_balance g, purchased_balance pu, legacy_balance l FROM coin_wallets WHERE person_id = $1', [p])).rows[0];

test('quote shows the dollar equivalent', () => {
  assert.equal(quote(40).text, 'This costs 40 coins (≈ $0.40)');
});

test('monthly allowance resets as a ledger event and is idempotent per cycle', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const p = await person(pool);
    await grantAllowance(pool, { personId: p, coins: 500, cycleKey: 'sub-fixture:2026-12' });
    assert.equal((await grantAllowance(pool, { personId: p, coins: 500, cycleKey: 'sub-fixture:2026-12' })).replayed, true);
    await debitNow(pool, { personId: p, coins: 120, idempotencyKey: 'job-fixture-0001', reason: 'scan_analysis' });
    const r = await grantAllowance(pool, { personId: p, coins: 500, cycleKey: 'sub-fixture:2027-01' });
    assert.equal(r.expiredCoins, 380, 'use-it-or-lose-it');
    assert.deepEqual(await bal(pool, p), { g: 500, pu: 0, l: 0 });
    const reasons = (await pool.query("SELECT reason FROM coin_transactions ORDER BY id")).rows.map((x) => x.reason);
    assert.deepEqual(reasons, ['grant', 'debit_hold', 'grant_expiry', 'grant']);
    await reconciles(pool);
  } finally { await pool.end(); }
});

test('spend order is granted, then purchased, then legacy; purchased coins survive resets', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const p = await person(pool);
    await grantAllowance(pool, { personId: p, coins: 100, cycleKey: 'c1:fixture' });
    await creditPurchase(pool, { personId: p, coins: 500, idempotencyKey: 'pay-fixture-0001', paymentRef: 'sim_pay_1' });
    await openingBalance(pool, { personId: p, coins: 50, bucket: 'legacy', sourceRef: 'fixture-import-1', actor: 'test-admin' });
    const r = await debitNow(pool, { personId: p, coins: 580, idempotencyKey: 'job-fixture-0002', reason: 'ai_report' });
    assert.deepEqual(r.split, { granted: 100, purchased: 480 });
    await grantAllowance(pool, { personId: p, coins: 100, cycleKey: 'c2:fixture' });
    assert.deepEqual(await bal(pool, p), { g: 100, pu: 20, l: 50 });
    const view = await walletView(pool, p);
    assert.equal(view.purchased.usd, '$0.20');
    assert.equal(view.total.coins, 170);
    await reconciles(pool);
  } finally { await pool.end(); }
});

test('insufficient coins charge nothing; an idempotency key cannot be reused for another request', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const p = await person(pool);
    await creditPurchase(pool, { personId: p, coins: 30, idempotencyKey: 'pay-fixture-0002', paymentRef: 'sim_pay_2' });
    await assert.rejects(debitNow(pool, { personId: p, coins: 40, idempotencyKey: 'job-fixture-0003', reason: 'x' }), (e) => e.code === 'INSUFFICIENT_COINS');
    assert.deepEqual(await bal(pool, p), { g: 0, pu: 30, l: 0 });
    assert.equal((await pool.query("SELECT count(*)::int n FROM coin_operations WHERE kind = 'debit'")).rows[0].n, 0, 'no trace of a failed debit');
    await debitNow(pool, { personId: p, coins: 10, idempotencyKey: 'job-fixture-0004', reason: 'x' });
    assert.equal((await debitNow(pool, { personId: p, coins: 10, idempotencyKey: 'job-fixture-0004', reason: 'x' })).replayed, true, 'double-click charges once');
    await assert.rejects(debitNow(pool, { personId: p, coins: 11, idempotencyKey: 'job-fixture-0004', reason: 'x' }), (e) => e.code === 'CONFLICT');
    assert.deepEqual(await bal(pool, p), { g: 0, pu: 20, l: 0 });
    await reconciles(pool);
  } finally { await pool.end(); }
});

test('concurrent debits never overdraw and each key charges once', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const p = await person(pool);
    await creditPurchase(pool, { personId: p, coins: 1000, idempotencyKey: 'pay-fixture-0003', paymentRef: 'sim_pay_3' });
    // 40 distinct jobs of 30 coins (1,200 wanted, 1,000 available), each sent twice at once.
    const calls = [];
    for (let i = 0; i < 40; i++) for (let k = 0; k < 2; k++) calls.push(debitNow(pool, { personId: p, coins: 30, idempotencyKey: `job-concurrent-${String(i).padStart(4, '0')}`, reason: 'ai' }).then(() => 'ok', (e) => e.code));
    const out = await Promise.all(calls);
    const ops = (await pool.query("SELECT count(*)::int n FROM coin_operations WHERE kind = 'debit' AND status = 'captured'")).rows[0].n;
    assert.equal(ops, 33, '33 x 30 = 990 coins fit; the rest are refused');
    assert.ok(out.every((x) => x === 'ok' || x === 'INSUFFICIENT_COINS'));
    assert.deepEqual(await bal(pool, p), { g: 0, pu: 10, l: 0 });
    await reconciles(pool);
  } finally { await pool.end(); }
});

test('a failed AI job nets zero; captured jobs can be refunded once; stale holds are released', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const p = await person(pool);
    await grantAllowance(pool, { personId: p, coins: 50, cycleKey: 'c1:hold' });
    await creditPurchase(pool, { personId: p, coins: 100, idempotencyKey: 'pay-fixture-0004', paymentRef: 'sim_pay_4' });
    const h = await holdDebit(pool, { personId: p, coins: 80, idempotencyKey: 'job-fixture-0005', reason: 'ai' });
    assert.deepEqual(await bal(pool, p), { g: 0, pu: 70, l: 0 }, 'held coins cannot be spent twice');
    await releaseDebit(pool, h.operation.id);
    assert.equal((await releaseDebit(pool, h.operation.id)).replayed, true);
    await assert.rejects(captureDebit(pool, h.operation.id), (e) => e.code === 'CONFLICT', 'a released hold cannot be captured');
    assert.deepEqual(await bal(pool, p), { g: 50, pu: 100, l: 0 }, 'failed job: nothing charged');

    const c = await debitNow(pool, { personId: p, coins: 80, idempotencyKey: 'job-fixture-0006', reason: 'ai' });
    await refundDebit(pool, { operationId: c.operation.id, idempotencyKey: 'refund-fixture-0001', reason: 'support', actor: 'test-admin' });
    assert.deepEqual(await bal(pool, p), { g: 50, pu: 100, l: 0 });
    await assert.rejects(refundDebit(pool, { operationId: c.operation.id, idempotencyKey: 'refund-fixture-0002', reason: 'support', actor: 'test-admin' }), /duplicate key|CONFLICT/);

    const t0 = new Date();
    await holdDebit(pool, { personId: p, coins: 10, idempotencyKey: 'job-fixture-0007', reason: 'ai', holdSeconds: 60, now: t0 });
    assert.equal(await releaseExpiredHolds(pool, { now: new Date(t0.getTime() + 30000) }), 0);
    assert.equal(await releaseExpiredHolds(pool, { now: new Date(t0.getTime() + 61000) }), 1);
    assert.deepEqual(await bal(pool, p), { g: 50, pu: 100, l: 0 });
    await assert.rejects(pool.query('UPDATE coin_transactions SET delta_coins = 1'), /append-only/);
    await reconciles(pool);
  } finally { await pool.end(); }
});

test('a refund after the allowance reset does not revive expired granted coins', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const p = await person(pool);
    await grantAllowance(pool, { personId: p, coins: 100, cycleKey: 'c1:refund', resetAt: new Date(Date.now() - 1000) });
    const c = await debitNow(pool, { personId: p, coins: 60, idempotencyKey: 'job-fixture-0008', reason: 'ai' });
    await grantAllowance(pool, { personId: p, coins: 100, cycleKey: 'c2:refund', resetAt: new Date(Date.now() + 1000) });
    const r = await refundDebit(pool, { operationId: c.operation.id, idempotencyKey: 'refund-fixture-0003', reason: 'support', actor: 'test-admin' });
    assert.equal(r.forfeitedGrantedCoins, 60);
    assert.deepEqual(await bal(pool, p), { g: 100, pu: 0, l: 0 }, 'never converted into perpetual purchased coins');
    await reconciles(pool);
  } finally { await pool.end(); }
});
