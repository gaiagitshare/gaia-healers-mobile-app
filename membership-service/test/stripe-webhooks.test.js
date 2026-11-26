/**
 * Stripe webhook ingestion and processing, fully offline: events are fixtures
 * signed with a test secret; nothing talks to Stripe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, actor } from './_db.js';
import { verifyStripeSignature, signForTest } from '../src/stripe/signature.js';
import { ingestStripeWebhook } from '../src/stripe/ingest.js';
import { processPending, replay } from '../src/stripe/processor.js';
import { stripeHandlers } from '../src/stripe/handlers.js';
import { seedCatalog, currentVersion } from '../src/plans.js';
import { resolveOrCreatePerson } from '../src/identity.js';
import { evaluate } from '../src/entitlements.js';

const SECRET = 'whsec_test_fixture_' + 'a'.repeat(24);
const OLD_SECRET = 'whsec_test_fixture_' + 'b'.repeat(24);
const T = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);
const NOW = T * 1000;
let n = 0;
const evt = (type, object, created = T, extra = {}) => ({ id: 'evt_fixture_' + (++n), object: 'event', type, created, livemode: false, data: { object }, ...extra });

async function send(pool, event, { secret = SECRET, now = NOW, body } = {}) {
  const raw = body ?? JSON.stringify(event);
  return ingestStripeWebhook(pool, { rawBody: raw, signatureHeader: signForTest(secret, raw, Math.floor(now / 1000)), secrets: [SECRET, OLD_SECRET], now });
}
const run = (pool, now = new Date(NOW + 1000)) => processPending(pool, { handlers: stripeHandlers, now });

async function setup(pool) {
  await seedCatalog(pool);
  const v = await currentVersion(pool, 'standard');
  const priceId = (await pool.query("SELECT id FROM plan_version_prices WHERE plan_version_id = $1 AND billing_interval = 'month'", [v.id])).rows[0].id;
  await pool.query("INSERT INTO provider_price_refs (plan_version_price_id, provider, external_price_id) VALUES ($1, 'stripe', 'price_fixture_standard_m')", [priceId]);
  const { personId } = await resolveOrCreatePerson(pool, { platform: 'stripe', kind: 'customer', externalId: 'cus_fixture_1' });
  return { personId };
}
const stripeSub = (status, extra = {}) => ({ id: 'sub_fixture_1', object: 'subscription', customer: 'cus_fixture_1', status,
  items: { data: [{ price: { id: 'price_fixture_standard_m' }, current_period_start: T, current_period_end: T + 30 * 86400 }] }, ...extra });

test('signature: valid, tampered, wrong secret, stale timestamp, malformed, rotated secret', () => {
  const raw = '{"id":"evt_x"}';
  const ok = (h, now = NOW) => verifyStripeSignature({ rawBody: raw, header: h, secrets: [SECRET], now });
  assert.equal(ok(signForTest(SECRET, raw, T)).ok, true);
  assert.equal(verifyStripeSignature({ rawBody: raw + ' ', header: signForTest(SECRET, raw, T), secrets: [SECRET], now: NOW }).reason, 'signature_mismatch');
  assert.equal(ok(signForTest('whsec_attacker_' + 'z'.repeat(24), raw, T)).reason, 'signature_mismatch');
  assert.equal(ok(signForTest(SECRET, raw, T - 301)).reason, 'timestamp_outside_tolerance', 'replay of an old delivery');
  assert.equal(ok('v1=abc').reason, 'malformed_header');
  assert.equal(verifyStripeSignature({ rawBody: raw, header: signForTest(OLD_SECRET, raw, T), secrets: [SECRET, OLD_SECRET], now: NOW }).ok, true, 'rotation window');
  assert.equal(verifyStripeSignature({ rawBody: raw, header: signForTest(SECRET, raw, T), secrets: [], now: NOW }).reason, 'no_secret_configured');
  assert.equal(verifyStripeSignature({ rawBody: JSON.parse('{"a":1}'), header: signForTest(SECRET, raw, T), secrets: [SECRET], now: NOW }).reason, 'raw_body_required', 'a re-serialized body is never verified');
});

test('duplicates are stored once; live-mode events are refused', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const e = evt('invoice.paid', { id: 'in_dup' });
    assert.deepEqual((await send(pool, e)).body, { ok: true, duplicate: false });
    assert.deepEqual((await send(pool, e)).body, { ok: true, duplicate: true });
    assert.equal((await pool.query('SELECT count(*)::int n FROM webhook_events')).rows[0].n, 1);
    const live = await send(pool, evt('invoice.paid', { id: 'in_live' }, T, { livemode: true }));
    assert.equal(live.status, 400); assert.equal(live.body.reason, 'livemode_not_enabled');
    assert.equal((await send(pool, e, { secret: 'whsec_attacker_' + 'z'.repeat(24) })).status, 400);
  } finally { await pool.end(); }
});

test('subscription lifecycle from Stripe events: paid, failed, recovered, refunded, disputed', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const { personId } = await setup(pool);
    await send(pool, evt('customer.subscription.created', stripeSub('incomplete'), T));
    await send(pool, evt('invoice.paid', { id: 'in_1', subscription: 'sub_fixture_1', customer: 'cus_fixture_1', amount_paid: 4700, currency: 'usd',
      status_transitions: { paid_at: T + 5 }, lines: { data: [{ period: { start: T, end: T + 30 * 86400 } }] } }, T + 5));
    assert.deepEqual(await run(pool), { processed: 2, ignored: 0, failed: 0, dead: 0 });
    const s = (await pool.query('SELECT id, status FROM subscriptions')).rows[0];
    assert.equal(s.status, 'active');
    assert.equal((await evaluate(pool, personId, new Date(NOW + 10000))).entitlements['software.scan_analysis'].value, true);

    await send(pool, evt('invoice.payment_failed', { id: 'in_2', subscription: 'sub_fixture_1', customer: 'cus_fixture_1' }, T + 100));
    await send(pool, evt('charge.refunded', { id: 'ch_1', customer: 'cus_fixture_1', currency: 'usd', refunds: { data: [{ id: 're_1', amount: 4700, currency: 'usd', created: T + 200 }] } }, T + 200));
    await send(pool, evt('charge.dispute.created', { id: 'dp_1', customer: 'cus_fixture_1', amount: 4700, currency: 'usd', created: T + 300 }, T + 300));
    await send(pool, evt('charge.dispute.closed', { id: 'dp_1', customer: 'cus_fixture_1', amount: 4700, currency: 'usd', status: 'won' }, T + 400));
    await run(pool, new Date(NOW + 500000));
    assert.equal((await pool.query('SELECT status FROM subscriptions')).rows[0].status, 'past_due');
    const ledger = (await pool.query('SELECT entry_type, amount_cents FROM payment_ledger ORDER BY id')).rows.map((r) => [r.entry_type, r.amount_cents]);
    assert.deepEqual(ledger, [['charge', 4700], ['refund', -4700], ['dispute', -4700], ['dispute_reversal', 4700]]);
    assert.equal((await pool.query('SELECT sum(amount_cents)::int s FROM payment_ledger')).rows[0].s, 0);
  } finally { await pool.end(); }
});

test('replays and out-of-order deliveries change nothing twice', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await setup(pool);
    await send(pool, evt('customer.subscription.created', stripeSub('active'), T));
    const paid = evt('invoice.paid', { id: 'in_r', subscription: 'sub_fixture_1', customer: 'cus_fixture_1', amount_paid: 4700, currency: 'usd' }, T + 1);
    await send(pool, paid);
    await send(pool, evt('customer.subscription.updated', stripeSub('canceled'), T + 50));
    await send(pool, evt('customer.subscription.updated', stripeSub('active'), T + 10));     // older, delivered last
    await run(pool);
    assert.equal((await pool.query('SELECT status FROM subscriptions')).rows[0].status, 'canceled', 'the older event did not resurrect it');
    const id = (await pool.query("SELECT id FROM webhook_events WHERE event_id = $1", [paid.id])).rows[0].id;
    await replay(pool, id, actor);
    await run(pool, new Date(NOW + 5000));
    assert.equal((await pool.query('SELECT count(*)::int n FROM payment_ledger')).rows[0].n, 1, 'replayed invoice is not booked twice');
  } finally { await pool.end(); }
});

test('an invoice that arrives before its subscription is retried, then applied', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await setup(pool);
    await send(pool, evt('invoice.paid', { id: 'in_early', subscription: 'sub_fixture_1', customer: 'cus_fixture_1', amount_paid: 4700, currency: 'usd',
      lines: { data: [{ price: { id: 'price_fixture_standard_m' } }] } }, T + 5));
    assert.deepEqual(await run(pool), { processed: 0, ignored: 0, failed: 1, dead: 0 });
    await send(pool, evt('customer.subscription.created', stripeSub('incomplete'), T));
    await run(pool, new Date(NOW + 3600 * 1000));
    assert.equal((await pool.query('SELECT status FROM subscriptions')).rows[0].status, 'active');
    assert.equal((await pool.query("SELECT status, attempts FROM webhook_events WHERE event_id LIKE 'evt_fixture_%' AND event_type = 'invoice.paid'")).rows[0].status, 'processed');
  } finally { await pool.end(); }
});

test('unknown prices are ignored (never mapped by amount); poison events go dead after max attempts', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await setup(pool);
    await send(pool, evt('customer.subscription.created', { ...stripeSub('active'), id: 'sub_other', items: { data: [{ price: { id: 'price_not_ours' } }] } }));
    assert.equal((await run(pool)).ignored, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM subscriptions')).rows[0].n, 0);
    await send(pool, evt('invoice.payment_failed', { id: 'in_orphan', subscription: 'sub_never_created', lines: { data: [{ price: { id: 'price_fixture_standard_m' } }] } }));
    let now = NOW;
    for (let i = 0; i < 3; i++) { now += 24 * 3600 * 1000; await processPending(pool, { handlers: stripeHandlers, now: new Date(now), maxAttempts: 3 }); }
    const r = (await pool.query("SELECT status, attempts, last_error FROM webhook_events WHERE event_type = 'invoice.payment_failed'")).rows[0];
    assert.equal(r.status, 'dead'); assert.equal(r.attempts, 3); assert.match(r.last_error, /RETRY_LATER/);
  } finally { await pool.end(); }
});
