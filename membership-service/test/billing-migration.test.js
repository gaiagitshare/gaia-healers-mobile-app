import './_providers-deny-network.mjs';
/**
 * Architecture C: duplicate billing across GHL and Stripe is prevented, and the
 * legacy -> new tier move goes only through a controlled migration offer.
 * Loopback fake Stripe; fictional people and fixture GHL ids; GHL is never called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, actor } from './_db.js';
import { fakeStripe, fetchVia, noSleep } from './_providers-fakes.js';
import { createStripeClient } from '../src/providers/stripe/client.js';
import { createCheckoutSession, createMigrationCheckoutSession } from '../src/providers/stripe/adapter.js';
import { checkoutEligibility } from '../src/billing-guard.js';
import { createOffer, acceptOffer, confirmLegacyCancelled, pendingLegacyCancellations, withdrawOffer, verifyLegacyCancellations, authorizeException, enforceMigrationBillingGate, migrationPolicy } from '../src/migration-offers.js';
import { seedCatalog, currentVersion } from '../src/plans.js';
import { resolveOrCreatePerson, linkIdentity } from '../src/identity.js';
import { createSubscription } from '../src/subscriptions.js';
import { signForTest } from '../src/stripe/signature.js';
import { ingestStripeWebhook } from '../src/stripe/ingest.js';
import { processPending } from '../src/stripe/processor.js';
import { stripeHandlers } from '../src/stripe/handlers.js';

const KEY = 'sk_test_fixture_' + 'x'.repeat(16);
const URLS = { successUrl: 'https://gaiahealers.app/ok', cancelUrl: 'https://gaiahealers.app/cancel' };
const NOW = new Date('2026-12-01T00:00:00Z');
const client = (srv) => createStripeClient({ apiKey: KEY, fetch: fetchVia, baseUrl: srv.url, sleep: noSleep });
const priceIdOf = async (pool, planKey, interval) => {
  const v = await currentVersion(pool, planKey);
  return (await pool.query('SELECT id FROM plan_version_prices WHERE plan_version_id = $1 AND billing_interval = $2', [v.id, interval])).rows[0].id;
};
let n = 0;

/** A person known to Gaia by email and by a GHL contact id. */
async function member(pool) {
  const i = ++n;
  const { personId } = await resolveOrCreatePerson(pool, { platform: 'email', kind: 'address', externalId: `member${i}@example.invalid` });
  await linkIdentity(pool, personId, { platform: 'ghl', kind: 'contact', externalId: `ghl-contact-fixture-${i}` }, { linkedBy: 'test' });
  return { personId, contact: `ghl-contact-fixture-${i}` };
}

/** A legacy GHL membership as the legacy reader would mirror it (fixture values). */
async function legacy(pool, { contact = null, personId = null, tier = 'silver', mapping = 'mapped', status = 'active', provider = 'stripe', stale = false,
  review = 'none', reasons = [], paidThrough = new Date('2026-12-20T00:00:00Z'), seen = NOW } = {}) {
  return (await pool.query(
    `INSERT INTO legacy_memberships (external_subscription_id, external_contact_id, person_id, payment_provider, external_price_id, tier, mapping,
                                     reported_status, amount_cents, currency, billing_interval, paid_through_estimate, stale_suspected, review_state, review_reasons, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 9700, 'USD', 'month', $9, $10, $11, $12, $13) RETURNING *`,
    [`ghl-sub-fixture-${++n}`, contact, personId, provider, `price_fixture_${tier || 'x'}`, mapping === 'mapped' ? tier : null, mapping, status, paidThrough, stale, review, reasons, seen])).rows[0];
}

async function setup() {
  const pool = await freshPool();
  await seedCatalog(pool);
  await legacy(pool, { status: 'canceled', tier: 'gold' });     // someone else's ended row: the mirror is loaded
  const srv = await fakeStripe();
  return { pool, srv, deps: { pool, stripe: client(srv) }, close: async () => { await srv.close(); await pool.end(); } };
}
const checkoutCalls = (srv) => srv.requests.filter((r) => r.path === '/v1/checkout/sessions').length;

test('a live GHL membership of ANY tier blocks a new Stripe subscription: migration_required, Stripe never called', { skip: SKIP }, async () => {
  const { pool, srv, deps, close } = await setup();
  try {
    for (const [tier, provider] of [['silver', 'stripe'], ['silver', 'paypal'], ['diamond', 'paypal'], ['gold', 'manual']]) {
      const m = await member(pool);
      await legacy(pool, { contact: m.contact, tier, provider });               // linked only by GHL contact id
      for (const target of ['standard', 'professional', 'inner_circle']) {
        const r = await createCheckoutSession(deps, m.personId, await priceIdOf(pool, target, 'month'), { ...URLS, idempotencyKey: `req-${tier}-${provider}-${target}`, now: NOW });
        assert.equal(r.status, 'migration_required', `${tier}/${provider} -> ${target}`);
        assert.equal(r.legacy[0].tier, tier);
      }
    }
    assert.equal(checkoutCalls(srv), 0, 'no checkout session was ever created');
  } finally { await close(); }
});

test('unknown or ambiguous legacy memberships require review, never treated as inactive', { skip: SKIP }, async () => {
  const { pool, deps, close } = await setup();
  try {
    const cases = [
      [{ mapping: 'unmapped' }, 'unmapped_price'],                        // e.g. the Next Level "CRM" plan
      [{ mapping: 'ambiguous' }, 'ambiguous_price'],
      [{ status: 'on_hold_by_provider' }, 'unknown_status'],
      [{ stale: true }, 'no_recent_payment'],                             // no recent payment is NOT a cancellation
      [{ review: 'needs_review', reasons: ['contact_rekeyed'] }, 'contact_rekeyed'],
      [{ status: 'canceled', review: 'needs_review', reasons: ['several_live_subscriptions'] }, 'several_live_subscriptions'],
    ];
    for (const [over, reason] of cases) {
      const m = await member(pool);
      await legacy(pool, { personId: m.personId, ...over });
      const r = await createCheckoutSession(deps, m.personId, await priceIdOf(pool, 'standard', 'month'), { ...URLS, idempotencyKey: `req-review-${reason}`, now: NOW });
      assert.equal(r.status, 'review_required', reason);
      assert.ok(r.reasons.includes(reason), `${reason} in ${r.reasons}`);
    }
    const ended = await member(pool);
    await legacy(pool, { personId: ended.personId, status: 'Cancelled' });
    assert.equal((await checkoutEligibility(pool, ended.personId, (await currentVersion(pool, 'standard')).id, { now: NOW })).status, 'ok', 'only a GHL-reported end clears a row');
  } finally { await close(); }
});

test('without a loaded, recent legacy mirror nobody can be told "nothing paid elsewhere"', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await seedCatalog(pool);
    const m = await member(pool);
    const v = (await currentVersion(pool, 'standard')).id;
    assert.deepEqual((await checkoutEligibility(pool, m.personId, v, { now: NOW })).reasons, ['legacy_mirror_not_loaded']);
    await legacy(pool, { status: 'canceled', seen: new Date(NOW.getTime() - 48 * 3600 * 1000) });
    assert.deepEqual((await checkoutEligibility(pool, m.personId, v, { now: NOW })).reasons, ['legacy_mirror_out_of_date']);
  } finally { await pool.end(); }
});

test('Gaia-side duplicates: same plan is already_subscribed, another tier is a plan change, never a second subscription', { skip: SKIP }, async () => {
  const { pool, srv, deps, close } = await setup();
  try {
    const m = await member(pool);
    await createSubscription(pool, { personId: m.personId, planVersionId: (await currentVersion(pool, 'standard')).id, interval: 'month', status: 'active' }, actor);
    assert.equal((await createCheckoutSession(deps, m.personId, await priceIdOf(pool, 'standard', 'year'), { ...URLS, idempotencyKey: 'req-dup-1', now: NOW })).status, 'already_subscribed');
    assert.equal((await createCheckoutSession(deps, m.personId, await priceIdOf(pool, 'inner_circle', 'month'), { ...URLS, idempotencyKey: 'req-dup-2', now: NOW })).status, 'change_plan_required');
    assert.equal(checkoutCalls(srv), 0);
    const free = await member(pool);
    const ok = await createCheckoutSession(deps, free.personId, await priceIdOf(pool, 'professional', 'month'), { ...URLS, idempotencyKey: 'req-dup-3', now: NOW });
    assert.equal(ok.status, 'ok', 'someone with nothing elsewhere can subscribe');
    assert.equal(checkoutCalls(srv), 1);
  } finally { await close(); }
});

test('legacy -> new tier: offer, accept, billing only after paid-through (no sweetener by default), completion only when the cancellation is verified', { skip: SKIP }, async () => {
  const { pool, srv, deps, close } = await setup();
  try {
    const m = await member(pool);
    const silver = await legacy(pool, { personId: m.personId, tier: 'silver', provider: 'paypal', paidThrough: new Date('2026-12-20T00:00:00Z') });
    const target = (await currentVersion(pool, 'professional')).id;

    // No offer, no checkout.
    assert.equal((await createCheckoutSession(deps, m.personId, await priceIdOf(pool, 'professional', 'month'), { ...URLS, idempotencyKey: 'req-mig-0', now: NOW })).status, 'migration_required');
    const offer = await createOffer(pool, { legacyMembershipId: silver.id, targetPlanVersionId: target, targetInterval: 'month' }, 'staff-fixture');
    await assert.rejects(createOffer(pool, { legacyMembershipId: silver.id, targetPlanVersionId: target, targetInterval: 'month' }, 'staff-fixture'), (e) => e.code === 'CONFLICT', 'one open offer per legacy membership');
    assert.equal((await createMigrationCheckoutSession(deps, offer.id, { ...URLS, idempotencyKey: 'req-mig-1', now: NOW })).status, 'review_required', 'not accepted yet');
    const other = await member(pool);
    await assert.rejects(acceptOffer(pool, offer.id, other.personId), (e) => e.code === 'NOT_FOUND', 'only the member can accept');
    await acceptOffer(pool, offer.id, m.personId);

    const s = await createMigrationCheckoutSession(deps, offer.id, { ...URLS, idempotencyKey: 'req-mig-2', now: NOW });
    assert.equal(s.status, 'ok');
    assert.equal(s.billingStartsAt.toISOString(), '2026-12-20T00:00:00.000Z', 'legacy paid through Dec 20; the sweetener is off by default');
    const form = srv.db.sessions.get(s.sessionId).form;
    assert.equal(Number(form['subscription_data[trial_end]']), Math.floor(Date.parse('2026-12-20T00:00:00Z') / 1000));
    assert.equal(form['subscription_data[metadata][gaia_migration_offer_id]'], offer.id);

    // Stripe reports the new subscription (trialing until billing starts).
    const SECRET = 'whsec_test_fixture_' + 'm'.repeat(24);
    const priceRef = (await pool.query('SELECT external_price_id FROM provider_price_refs LIMIT 1')).rows[0].external_price_id;
    const customer = (await pool.query("SELECT external_id FROM person_identities WHERE person_id = $1 AND platform = 'stripe'", [m.personId])).rows[0].external_id;
    const T = Math.floor(NOW.getTime() / 1000);
    const event = { id: 'evt_mig_1', object: 'event', type: 'customer.subscription.created', created: T, livemode: false,
      data: { object: { id: 'sub_mig_1', customer, status: 'trialing', trial_end: Math.floor(Date.parse('2026-12-20T00:00:00Z') / 1000),
        metadata: { gaia_migration_offer_id: offer.id }, items: { data: [{ price: { id: priceRef }, current_period_start: T, current_period_end: T + 81 * 86400 }] } } } };
    const raw = JSON.stringify(event);
    await ingestStripeWebhook(pool, { rawBody: raw, signatureHeader: signForTest(SECRET, raw, T), secrets: [SECRET], now: NOW.getTime() });
    await processPending(pool, { handlers: stripeHandlers, now: new Date(NOW.getTime() + 1000) });
    const o1 = (await pool.query('SELECT status, subscription_id FROM migration_offers WHERE id = $1', [offer.id])).rows[0];
    assert.equal(o1.status, 'subscribed');
    assert.equal((await pool.query('SELECT source FROM subscriptions WHERE id = $1', [o1.subscription_id])).rows[0].source, 'migration_offer');

    // Nobody reported the GHL cancellation: alert before billing would start.
    const alerts = [];
    await pendingLegacyCancellations(pool, { now: new Date('2026-12-15T00:00:00Z'), alert: (a) => alerts.push(a) });
    assert.deepEqual(alerts.map((a) => a.kind), ['legacy_cancel_due']);
    // Billing gate: 3 days before billing, still unverified -> the trial is extended, not charged.
    srv.db.subscriptions.set('sub_mig_1', { id: 'sub_mig_1', status: 'trialing', items: { data: [{ current_period_end: T + 19 * 86400 }] } });
    const deps2 = { pool, stripe: client(srv) };
    assert.deepEqual(await enforceMigrationBillingGate(deps2, { now: new Date('2026-12-18T00:00:00Z') }), { due: 1, held: 1 });
    const hold = srv.requests.filter((r) => r.method === 'POST' && r.path === '/v1/subscriptions/sub_mig_1').pop();
    assert.equal(Number(hold.form.trial_end), Math.floor(Date.parse('2026-12-27T00:00:00Z') / 1000), 'held 7 days past the planned start');
    assert.equal((await pool.query("SELECT trial_end FROM subscriptions WHERE provider_subscription_id = 'sub_mig_1'")).rows[0].trial_end.toISOString(), '2026-12-27T00:00:00.000Z', 'local access follows the held trial');
    assert.equal((await pool.query('SELECT reported_status FROM legacy_memberships WHERE id = $1', [silver.id])).rows[0].reported_status, 'active', 'code never touched the legacy membership');

    // Staff report the hand-made cancellation: NOT complete yet (GHL still shows it active).
    await confirmLegacyCancelled(pool, offer.id, 'staff-fixture');
    assert.equal((await pool.query('SELECT status FROM migration_offers WHERE id = $1', [offer.id])).rows[0].status, 'cancel_reported');
    assert.deepEqual(await verifyLegacyCancellations(pool), { checked: 1, verified: 0 }, 'the mirror still shows it active');
    assert.equal((await enforceMigrationBillingGate(deps2, { now: new Date('2026-12-25T00:00:00Z') })).held, 1, 'still held');

    // The next complete reader pass sees GHL report it cancelled -> verified -> completed; no more holds.
    await pool.query("UPDATE legacy_memberships SET reported_status = 'canceled' WHERE id = $1", [silver.id]);
    assert.deepEqual(await verifyLegacyCancellations(pool), { checked: 1, verified: 1 });
    const done = (await pool.query('SELECT status, legacy_cancel_verified_at, billing_holds FROM migration_offers WHERE id = $1', [offer.id])).rows[0];
    assert.equal(done.status, 'completed'); assert.ok(done.legacy_cancel_verified_at); assert.equal(done.billing_holds, 2);
    assert.deepEqual(await enforceMigrationBillingGate(deps2, { now: new Date('2027-01-02T00:00:00Z') }), { due: 0, held: 0 });
    assert.deepEqual(await pendingLegacyCancellations(pool, { now: new Date('2027-01-02T00:00:00Z') }), { pending: 0, alerted: 0 });
    assert.ok(srv.requests.every((r) => r.path.startsWith('/v1/')), 'only Stripe (fake) was called; GHL never');
  } finally { await close(); }
});

test('migration offers are refused for anything under review, ended, or with an unknown paid-through date', { skip: SKIP }, async () => {
  const { pool, deps, close } = await setup();
  try {
    const target = (await currentVersion(pool, 'standard')).id;
    const a = await member(pool);
    const stale = await legacy(pool, { personId: a.personId, stale: true });
    await assert.rejects(createOffer(pool, { legacyMembershipId: stale.id, targetPlanVersionId: target, targetInterval: 'month' }, 'staff'), (e) => e.code === 'CONFLICT');
    const b = await member(pool);
    const done = await legacy(pool, { personId: b.personId, status: 'canceled' });
    await assert.rejects(createOffer(pool, { legacyMembershipId: done.id, targetPlanVersionId: target, targetInterval: 'month' }, 'staff'), (e) => e.code === 'CONFLICT');
    const c = await member(pool);
    const unknownPaid = await legacy(pool, { personId: c.personId, paidThrough: null });
    const o = await createOffer(pool, { legacyMembershipId: unknownPaid.id, targetPlanVersionId: target, targetInterval: 'month' }, 'staff');
    await acceptOffer(pool, o.id, c.personId);
    assert.deepEqual((await createMigrationCheckoutSession(deps, o.id, { ...URLS, idempotencyKey: 'req-mig-x', now: NOW })).reasons, ['legacy_paid_through_unknown'], 'never guess the start date');
    // A second live legacy membership still blocks, even with an accepted offer for the first.
    const d = await member(pool);
    const first = await legacy(pool, { personId: d.personId, tier: 'silver' });
    await legacy(pool, { personId: d.personId, tier: 'diamond', provider: 'paypal' });
    const od = await createOffer(pool, { legacyMembershipId: first.id, targetPlanVersionId: target, targetInterval: 'month' }, 'staff');
    await acceptOffer(pool, od.id, d.personId);
    const r = await createMigrationCheckoutSession(deps, od.id, { ...URLS, idempotencyKey: 'req-mig-y', now: NOW });
    assert.equal(r.status, 'migration_required');
    assert.equal(r.legacy[0].tier, 'diamond');
    await withdrawOffer(pool, od.id, 'staff');
  } finally { await close(); }
});

test('sweetener is a policy, off by default; offers cannot override it', { skip: SKIP }, async () => {
  const { pool, close } = await setup();
  try {
    assert.deepEqual(migrationPolicy({}), { sweetenerMonths: 0 });
    assert.deepEqual(migrationPolicy({ MEMBERSHIP_MIGRATION_SWEETENER_MONTHS: '2' }), { sweetenerMonths: 2 });
    assert.throws(() => migrationPolicy({ MEMBERSHIP_MIGRATION_SWEETENER_MONTHS: '24' }), (e) => e.code === 'INVALID_INPUT');
    const m = await member(pool);
    const l = await legacy(pool, { personId: m.personId });
    const target = (await currentVersion(pool, 'standard')).id;
    await assert.rejects(createOffer(pool, { legacyMembershipId: l.id, targetPlanVersionId: target, targetInterval: 'month', sweetenerMonths: 2 }, 'staff', { policy: { sweetenerMonths: 0 } }), (e) => e.code === 'FORBIDDEN');
    const o = await createOffer(pool, { legacyMembershipId: l.id, targetPlanVersionId: target, targetInterval: 'month' }, 'staff', { policy: { sweetenerMonths: 2 } });
    assert.equal(o.sweetener_months, 2, 'only when the owner turns it on');
  } finally { await close(); }
});

test('authorized exception: a named admin and a written reason complete the migration; anything less is refused', { skip: SKIP }, async () => {
  const { pool, deps, close } = await setup();
  try {
    const m = await member(pool);
    const l = await legacy(pool, { personId: m.personId, provider: 'paypal' });
    const o = await createOffer(pool, { legacyMembershipId: l.id, targetPlanVersionId: (await currentVersion(pool, 'standard')).id, targetInterval: 'month' }, 'staff');
    await assert.rejects(authorizeException(pool, o.id, { authorizedBy: 'owner-fixture', reason: 'short' }), (e) => e.code === 'INVALID_INPUT');
    await assert.rejects(authorizeException(pool, o.id, { reason: 'PayPal agreement cancelled at PayPal directly' }), (e) => e.code === 'INVALID_INPUT');
    await assert.rejects(authorizeException(pool, o.id, { authorizedBy: 'owner-fixture', reason: 'PayPal agreement cancelled at PayPal directly' }), (e) => e.code === 'CONFLICT', 'only once a new subscription exists');
    await acceptOffer(pool, o.id, m.personId);
    await createMigrationCheckoutSession(deps, o.id, { ...URLS, idempotencyKey: 'req-exc-1', now: NOW });
    await pool.query(`INSERT INTO subscriptions (person_id, plan_version_id, billing_interval, status, provider, provider_subscription_id, source)
                      VALUES ($1, $2, 'month', 'trialing', 'stripe', 'sub_exc_1', 'migration_offer')`, [m.personId, (await currentVersion(pool, 'standard')).id]);
    await pool.query("UPDATE migration_offers SET status = 'subscribed', subscription_id = (SELECT id FROM subscriptions WHERE provider_subscription_id = 'sub_exc_1') WHERE id = $1", [o.id]);
    await authorizeException(pool, o.id, { authorizedBy: 'owner-fixture', reason: 'PayPal agreement cancelled at PayPal directly' });
    const r = (await pool.query('SELECT status, exception_authorized_by, legacy_cancel_verified_at FROM migration_offers WHERE id = $1', [o.id])).rows[0];
    assert.deepEqual([r.status, r.exception_authorized_by, r.legacy_cancel_verified_at], ['completed', 'owner-fixture', null]);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE action = 'migration_offer.completed' AND actor_id = 'owner-fixture'")).rows[0].n, 1);
  } finally { await close(); }
});

test('billing gate: an ambiguous legacy membership keeps billing held; a subscription already charging raises an urgent alert', { skip: SKIP }, async () => {
  const { pool, srv, deps, close } = await setup();
  try {
    const m = await member(pool);
    const l = await legacy(pool, { personId: m.personId });
    const o = await createOffer(pool, { legacyMembershipId: l.id, targetPlanVersionId: (await currentVersion(pool, 'standard')).id, targetInterval: 'month' }, 'staff');
    await acceptOffer(pool, o.id, m.personId);
    await createMigrationCheckoutSession(deps, o.id, { ...URLS, idempotencyKey: 'req-gate-1', now: NOW });
    const sid = (await pool.query(`INSERT INTO subscriptions (person_id, plan_version_id, billing_interval, status, provider, provider_subscription_id, source)
                      VALUES ($1, $2, 'month', 'trialing', 'stripe', 'sub_gate_1', 'migration_offer') RETURNING id`, [m.personId, (await currentVersion(pool, 'standard')).id])).rows[0].id;
    await pool.query("UPDATE migration_offers SET status = 'cancel_reported', legacy_cancel_confirmed_by = 'staff', legacy_cancel_confirmed_at = now(), subscription_id = $2 WHERE id = $1", [o.id, sid]);
    srv.db.subscriptions.set('sub_gate_1', { id: 'sub_gate_1', status: 'trialing', items: { data: [{ current_period_end: 0 }] } });
    await pool.query("UPDATE legacy_memberships SET reported_status = 'canceled', review_state = 'needs_review', review_reasons = '{contact_rekeyed}' WHERE id = $1", [l.id]);
    assert.deepEqual(await verifyLegacyCancellations(pool), { checked: 1, verified: 0 }, 'ended but under review: not verified');
    assert.equal((await enforceMigrationBillingGate({ pool, stripe: deps.stripe }, { now: new Date('2026-12-19T00:00:00Z') })).held, 1);
    await pool.query("UPDATE subscriptions SET status = 'active' WHERE id = $1", [sid]);
    const alerts = [];
    await enforceMigrationBillingGate({ pool, stripe: deps.stripe }, { now: new Date('2026-12-30T00:00:00Z'), alert: (a) => alerts.push(a) });
    assert.deepEqual(alerts.map((a) => a.kind), ['billing_started_unverified']);
    assert.equal(srv.requests.filter((r) => r.path === '/v1/subscriptions/sub_gate_1').length, 1, 'never edits a subscription that is already charging');
  } finally { await close(); }
});
