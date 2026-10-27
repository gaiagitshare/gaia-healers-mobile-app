import './_providers-deny-network.mjs';
/**
 * Coin-pack reconciliation. The handler that books coin packs lives in another
 * PR (#296), so these tests write its rows directly in the same shape:
 *   coin_operations: kind 'purchase', related ('payment', ch_…)   (creditPurchase)
 *   payment_ledger:  ('charge', ch_…, 'charge', +amount, coin_operation_id = that operation)
 *   refunds:         ('refund', re_…, 'refund', -amount)
 * Covers reconcilePage for invoice-less charges and their refunds, and the SQL
 * check membership.coin_purchase_ledger_mismatches() (migration 0006), also as
 * part of the daily job.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP } from './_db.js';
import { fakeStripe, fetchVia, noSleep } from './_providers-fakes.js';
import { reconcilePage } from '../src/providers/stripe/reconcile.js';
import { coinPurchaseLedgerMismatches, planDailyReconcile, runDailyReconcile } from '../src/providers/stripe/daily-reconcile.js';
import { creditPurchase, grantAllowance } from '../src/coins.js';
import { resolveOrCreatePerson } from '../src/identity.js';
import { createStripeClient } from '../src/providers/stripe/client.js';
import { createRequestCap } from '../src/providers/request-cap.js';

const T = (iso) => Math.floor(Date.parse(iso) / 1000);
const AT = '2026-12-01T10:00:00Z';
const WINDOW = { from: new Date('2026-12-01T00:00:00Z'), to: new Date('2026-12-02T00:00:00Z') };

async function setup(pool, cus = 'cus_cp') {
  return (await resolveOrCreatePerson(pool, { platform: 'stripe', kind: 'customer', externalId: cus })).personId;
}
/** What #296 writes for one paid coin pack: a purchase operation + one ledger charge row pointing at it. */
async function bookCoinPack(pool, personId, chargeId, { amount = 1000, coins = 1200, currency = 'USD', at = AT, ledger = true, ledgerChargeId = chargeId } = {}) {
  const { operation } = await creditPurchase(pool, { personId, coins, idempotencyKey: 'stripe-pi:pi_' + chargeId, paymentRef: chargeId, actor: 'system' });
  if (ledger) await ledgerCharge(pool, personId, ledgerChargeId, { amount, currency, at, op: operation.id });
  return operation.id;
}
async function ledgerCharge(pool, personId, chargeId, { amount = 1000, currency = 'USD', at = AT, op = null } = {}) {
  await pool.query(`INSERT INTO payment_ledger (person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, coin_operation_id, livemode, occurred_at)
                    VALUES ($1, 'stripe', 'charge', $2, 'charge', $3, $4, $5, false, $6)`, [personId, chargeId, amount, currency, op, at]);
}
async function ledgerRefund(pool, personId, refundId, amount, at = AT) {
  await pool.query(`INSERT INTO payment_ledger (person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, livemode, occurred_at)
                    VALUES ($1, 'stripe', 'refund', $2, 'refund', $3, 'USD', false, $4)`, [personId, refundId, -Math.abs(amount), at]);
}
const charge = (id, extra = {}) => ({ id, object: 'charge', invoice: null, paid: true, status: 'succeeded', amount: 1000, currency: 'usd', customer: 'cus_cp', created: T(AT), ...extra });
const kinds = (r) => r.mismatches.map((m) => `${m.kind}:${m.objectId}`).sort();

test('coin-pack charges (no invoice) match their ledger rows', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const pid = await setup(pool);
    await bookCoinPack(pool, pid, 'ch_cp1');
    await bookCoinPack(pool, pid, 'ch_cp2', { amount: 2500, coins: 3000 });
    const r = await reconcilePage(pool, { charges: [charge('ch_cp1'), charge('ch_cp2', { amount: 2500 })], window: WINDOW, complete: true });
    assert.deepEqual(r.mismatches, []);
    assert.equal(r.matched, 2);
    // a charge that belongs to an invoice is the subscription's, never booked twice as a coin pack
    const withInvoice = await reconcilePage(pool, { charges: [charge('ch_cp1'), charge('ch_cp2', { amount: 2500 }), charge('ch_sub', { invoice: 'in_x' })], window: WINDOW, complete: true });
    assert.deepEqual(withInvoice.mismatches, []);
    // a failed / unpaid charge is not expected in the ledger
    const failed = await reconcilePage(pool, { charges: [charge('ch_cp1'), charge('ch_cp2', { amount: 2500 }), charge('ch_fail', { paid: false, status: 'failed' })], window: WINDOW, complete: true });
    assert.deepEqual(failed.mismatches, []);
    assert.deepEqual(await coinPurchaseLedgerMismatches(pool, { from: new Date(Date.now() - 3600000), to: new Date(Date.now() + 3600000) }), []);
  } finally { await pool.end(); }
});

test('a refunded coin pack matches its refund rows (partial and full)', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const pid = await setup(pool);
    await bookCoinPack(pool, pid, 'ch_rf1');
    await ledgerRefund(pool, pid, 're_rf1', 400);
    await ledgerRefund(pool, pid, 're_rf2', 600);
    const refunds = [
      { id: 're_rf1', status: 'succeeded', amount: 400, currency: 'usd', charge: { id: 'ch_rf1', customer: 'cus_cp' }, created: T(AT) },
      { id: 're_rf2', status: 'succeeded', amount: 600, currency: 'usd', charge: { id: 'ch_rf1', customer: 'cus_cp' }, created: T(AT) },
      { id: 're_pending', status: 'pending', amount: 100, currency: 'usd', charge: { id: 'ch_rf1', customer: 'cus_cp' }, created: T(AT) },
    ];
    const r = await reconcilePage(pool, { charges: [charge('ch_rf1', { refunded: true, amount_refunded: 1000 })], refunds, window: WINDOW, complete: true });
    assert.deepEqual(r.mismatches, [], 'charge + two succeeded refunds match; a pending refund is not expected yet');
    assert.equal(r.matched, 3);
    const short = await reconcilePage(pool, { charges: [charge('ch_rf1')], refunds: [...refunds, { id: 're_rf3', status: 'succeeded', amount: 50, currency: 'usd', charge: { customer: 'cus_cp' } }], window: WINDOW, complete: true });
    assert.deepEqual(kinds(short), ['missing_in_ledger:re_rf3']);
  } finally { await pool.end(); }
});

test('a Stripe charge with no ledger row is reported; a ledger row missing in Stripe only when the fetch is complete', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const pid = await setup(pool);
    await bookCoinPack(pool, pid, 'ch_ok');
    await bookCoinPack(pool, pid, 'ch_ghost');                     // booked, but Stripe does not list it
    const page = { charges: [charge('ch_ok'), charge('ch_unbooked')], window: WINDOW };
    const complete = await reconcilePage(pool, { ...page, complete: true });
    assert.deepEqual(kinds(complete), ['missing_in_ledger:ch_unbooked', 'missing_in_stripe:ch_ghost']);
    const partial = await reconcilePage(pool, { ...page, complete: false });
    assert.deepEqual(kinds(partial), ['missing_in_ledger:ch_unbooked'], 'an incomplete fetch proves no absence');
    // a charge of a customer who is not Gaia's is skipped, not a mismatch
    const foreign = await reconcilePage(pool, { charges: [charge('ch_ok'), charge('ch_ghost'), charge('ch_foreign', { customer: 'cus_not_gaia' })], window: WINDOW, complete: true });
    assert.deepEqual(foreign.mismatches, []);
    assert.deepEqual(foreign.skipped, [{ objectType: 'charge', objectId: 'ch_foreign' }]);
    // metadata.gaia_person_id is enough to make an unlinked customer's coin pack Gaia's
    const meta = await reconcilePage(pool, { charges: [charge('ch_ok'), charge('ch_ghost'), charge('ch_meta', { customer: 'cus_unlinked', metadata: { gaia_person_id: pid } })], window: WINDOW, complete: true });
    assert.deepEqual(kinds(meta), ['missing_in_ledger:ch_meta']);
  } finally { await pool.end(); }
});

test('coin-pack amount and currency mismatches are reported', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const pid = await setup(pool);
    await bookCoinPack(pool, pid, 'ch_amt', { amount: 1000 });
    await bookCoinPack(pool, pid, 'ch_cur', { amount: 1000, currency: 'EUR' });
    const r = await reconcilePage(pool, { charges: [charge('ch_amt', { amount: 1100 }), charge('ch_cur')], window: WINDOW, complete: true });
    assert.deepEqual(kinds(r), ['amount_mismatch:ch_amt', 'currency_mismatch:ch_cur']);
    const amt = r.mismatches.find((m) => m.kind === 'amount_mismatch');
    assert.deepEqual([amt.stripeAmount, amt.ledgerAmount], [1100, 1000]);
    const cur = r.mismatches.find((m) => m.kind === 'currency_mismatch');
    assert.deepEqual([cur.stripe, cur.ledger], ['USD', 'EUR']);
  } finally { await pool.end(); }
});

test('coin totals: every Stripe purchase operation has exactly one ledger charge row, and vice versa (SQL check)', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const pid = await setup(pool);
    const near = { from: new Date(Date.now() - 3600000), to: new Date(Date.now() + 3600000) };
    await bookCoinPack(pool, pid, 'ch_t1');
    await bookCoinPack(pool, pid, 'ch_t2', { at: '2026-11-30T23:59:00Z' });   // ledger dated another day: matched by link, not by date
    assert.deepEqual(await coinPurchaseLedgerMismatches(pool, near), []);

    const lost = await bookCoinPack(pool, pid, 'ch_t3', { ledger: false });   // coins credited, charge never booked
    const ref = await bookCoinPack(pool, pid, 'ch_t4', { ledgerChargeId: 'ch_t4_other' });  // booked under another charge id
    const dbl = await bookCoinPack(pool, pid, 'ch_t5');
    await ledgerCharge(pool, pid, 'ch_t5_dup', { op: dbl });                  // a second charge row for one purchase
    const grant = (await grantAllowance(pool, { personId: pid, coins: 500, cycleKey: 'cycle-test-1' })).operation.id;
    await ledgerCharge(pool, pid, 'ch_t6', { op: grant, at: new Date().toISOString() });   // charge row linked to a grant
    await ledgerCharge(pool, pid, 'ch_t7', { at: new Date().toISOString() });               // charge row with no coins at all

    const got = (await coinPurchaseLedgerMismatches(pool, near)).map((m) => `${m.kind}:${m.chargeId}`).sort();
    assert.deepEqual(got, [
      'charge_ref_mismatch:ch_t4_other',
      'ledger_row_without_purchase:ch_t6',
      'ledger_row_without_purchase:ch_t7',
      'purchase_with_multiple_ledger_rows:ch_t5',
      'purchase_with_multiple_ledger_rows:ch_t5_dup',
      'purchase_without_ledger_row:ch_t3',
    ]);
    const m = (await coinPurchaseLedgerMismatches(pool, near)).find((x) => x.kind === 'purchase_without_ledger_row');
    assert.equal(m.coinOperationId, lost);
    assert.equal(m.coins, 1200);
    assert.ok(ref);
    // outside the window: nothing
    assert.deepEqual(await coinPurchaseLedgerMismatches(pool, { from: new Date('2020-01-01'), to: new Date('2020-01-02') }), []);
    // non-Stripe purchases (e.g. a simulated payment ref) are not this check's business
    await creditPurchase(pool, { personId: pid, coins: 10, idempotencyKey: 'sim-purchase-1', paymentRef: 'sim_1' });
    assert.equal((await coinPurchaseLedgerMismatches(pool, near)).length, 6);
  } finally { await pool.end(); }
});

test('the daily job includes the coin check: a purchase without its ledger charge row alerts once', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeStripe({ lists: { charges: [] } });
  try {
    const pid = await setup(pool);
    await bookCoinPack(pool, pid, 'ch_dj1', { ledger: false });
    const plan = planDailyReconcile({ now: new Date(Date.now() + 86400000) });     // "yesterday" = today, where the operation was created
    const sent = [];
    const run = () => {
      const cap = createRequestCap({ max: plan.maxRequests, fetch: fetchVia });
      return runDailyReconcile({ pool, cap, stripe: createStripeClient({ apiKey: 'sk_test_fixture_' + 'q'.repeat(16), fetch: cap.fetch, baseUrl: srv.url, sleep: noSleep }) }, plan, { alert: async (x) => sent.push(x) });
    };
    const r = await run();
    assert.equal(r.exitCode, 1);
    assert.equal(r.coinMismatches, 1);
    assert.deepEqual(r.mismatches.map((x) => `${x.kind}:${x.objectId}`), ['coin_purchase_without_ledger_row:ch_dj1']);
    await run();
    assert.equal(sent.length, 1, 'same coin mismatch on a re-run: no second alert');
  } finally { await srv.close(); await pool.end(); }
});
