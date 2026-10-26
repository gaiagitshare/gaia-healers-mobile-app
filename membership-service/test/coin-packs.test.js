/**
 * Coin-pack purchases through Stripe (fixtures, offline): coins credited and the
 * charge booked exactly once; only real Gaia packs at the right price; refunds
 * take back unspent coins, never below zero.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, person } from './_db.js';
import { signForTest } from '../src/stripe/signature.js';
import { ingestStripeWebhook } from '../src/stripe/ingest.js';
import { processPending, replay } from '../src/stripe/processor.js';
import { stripeHandlers } from '../src/stripe/handlers.js';
import { seedCatalog } from '../src/plans.js';
import { debitNow } from '../src/coins.js';

const SECRET = 'whsec_test_fixture_' + 'c'.repeat(24);
const T = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);
let n = 0;
const evt = (type, object, created = T) => ({ id: 'evt_cp_' + (++n), object: 'event', type, created, livemode: false, data: { object } });
async function send(pool, e) { const raw = JSON.stringify(e); return ingestStripeWebhook(pool, { rawBody: raw, signatureHeader: signForTest(SECRET, raw, T), secrets: [SECRET], now: T * 1000 }); }
let tick = 0;
const run = (pool) => processPending(pool, { handlers: stripeHandlers, now: new Date(T * 1000 + 1000 + (tick += 3600 * 1000)) });
const bal = async (pool, p) => (await pool.query('SELECT purchased_balance FROM coin_wallets WHERE person_id = $1', [p])).rows[0]?.purchased_balance ?? 0;

async function setup(pool) {
  await seedCatalog(pool);
  await pool.query("UPDATE coin_packages SET status = 'active'");
  const pack = (await pool.query("SELECT * FROM coin_packages WHERE key = 'regular'")).rows[0];   // 1,200 coins, $10
  return { p: await person(pool), pack };
}
const pi = (p, pack, extra = {}) => ({ id: 'pi_fixture_' + (extra.n || 1), object: 'payment_intent', amount_received: pack.price_cents, currency: 'usd', latest_charge: 'ch_fixture_' + (extra.n || 1),
  metadata: { gaia_person_id: p, gaia_coin_package_id: pack.id, gaia_coin_package_key: pack.key, gaia_coins: String(pack.coins) }, ...extra.override });

test('a paid coin pack credits purchased coins and books the charge once, even when replayed', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    const { p, pack } = await setup(pool);
    const e = evt('payment_intent.succeeded', pi(p, pack));
    await send(pool, e); await send(pool, e);                               // duplicate delivery
    assert.equal((await run(pool)).processed, 1);
    const id = (await pool.query('SELECT id FROM webhook_events')).rows[0].id;
    await replay(pool, id, { actorType: 'admin', actorId: 'test-admin' }); await run(pool);
    assert.equal(await bal(pool, p), 1200);
    const l = (await pool.query('SELECT provider_object_type, provider_object_id, amount_cents, coin_operation_id FROM payment_ledger')).rows;
    assert.equal(l.length, 1);
    assert.deepEqual([l[0].provider_object_type, l[0].provider_object_id, l[0].amount_cents], ['charge', 'ch_fixture_1', 1000], 'booked as the charge, matching reconciliation');
    assert.ok(l[0].coin_operation_id, 'ledger row points at the coin credit');
    assert.deepEqual((await pool.query('SELECT * FROM wallet_mismatches()')).rows, []);
  } finally { await pool.end(); }
});

test('only Gaia packs at the package price are credited; other payments are ignored', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    const { p, pack } = await setup(pool);
    await send(pool, evt('payment_intent.succeeded', { id: 'pi_other', object: 'payment_intent', amount_received: 5000, currency: 'usd', latest_charge: 'ch_other', metadata: {} }));
    await send(pool, evt('payment_intent.succeeded', pi(p, pack, { n: 2, override: { amount_received: 1 } })));
    await send(pool, evt('payment_intent.succeeded', pi(p, pack, { n: 3, override: { metadata: { gaia_person_id: p, gaia_coin_package_id: pack.id, gaia_coins: '999999' } } })));
    await run(pool);
    const st = (await pool.query('SELECT status, count(*)::int n FROM webhook_events GROUP BY status ORDER BY status')).rows.map((r) => `${r.status}:${r.n}`);
    assert.deepEqual(st, ['dead:2', 'ignored:1'], 'wrong amount or coin count goes to a human at once');
    assert.equal(await bal(pool, p), 0);
  } finally { await pool.end(); }
});

test('a refund takes back unspent coins pro rata and never goes below zero', { skip: SKIP }, async () => {
  const pool = await freshPool(); try {
    const { p, pack } = await setup(pool);
    await send(pool, evt('payment_intent.succeeded', pi(p, pack), T));
    await run(pool);
    await send(pool, evt('refund.created', { id: 're_half', object: 'refund', amount: 500, currency: 'usd', status: 'succeeded', charge: 'ch_fixture_1', payment_intent: 'pi_fixture_1', created: T + 10 }, T + 10));
    await run(pool);
    assert.equal(await bal(pool, p), 600, 'half refunded -> half the coins taken back');
    await debitNow(pool, { personId: p, coins: 550, idempotencyKey: 'job-cp-fixture-01', reason: 'ai' });
    await send(pool, evt('refund.created', { id: 're_rest', object: 'refund', amount: 500, currency: 'usd', status: 'succeeded', charge: 'ch_fixture_1', payment_intent: 'pi_fixture_1', created: T + 20 }, T + 20));
    await run(pool);
    assert.equal(await bal(pool, p), 0, 'only the 50 unspent coins could be taken back');
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE action = 'coins.adjustment'")).rows[0].n, 2);
    assert.equal((await pool.query('SELECT sum(amount_cents)::int s FROM payment_ledger')).rows[0].s, 0, 'money fully refunded in the ledger');
    assert.deepEqual((await pool.query('SELECT * FROM wallet_mismatches()')).rows, []);
  } finally { await pool.end(); }
});
