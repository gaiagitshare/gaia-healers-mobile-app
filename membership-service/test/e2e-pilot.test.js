import './_providers-deny-network.mjs';
/**
 * END-TO-END PILOT (fictional people, loopback fakes for Stripe and GHL).
 *
 *  A. New member: signup -> checkout -> payment -> membership active -> coins
 *     granted -> entitlements -> AI coin debit through the internal API -> GHL
 *     sync (grant confirmed by the mirror) -> renewal -> reconciliation ->
 *     cancellation -> access and coins end -> GHL access revoked.
 *  B. Legacy Silver member -> Professional: blocked checkout -> offer -> accept
 *     -> migration checkout (no billing while legacy is paid) -> legacy access
 *     kept and new access granted -> billing held until the cancellation is
 *     verified -> completed -> old Gaia tag revoked only after the new grant is
 *     confirmed -> first charge.
 *
 * Existing GHL tags (ahc-*) are asserted untouched throughout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openLaunch, freshPool, SKIP } from './_db.js';
import { fakeStripe, fakeGhl, fetchVia, noSleep } from './_providers-fakes.js';
import { createStripeClient } from '../src/providers/stripe/client.js';
import { createCheckoutSession, createMigrationCheckoutSession } from '../src/providers/stripe/adapter.js';
import { reconcilePage } from '../src/providers/stripe/reconcile.js';
import { createGhlClient } from '../src/providers/ghl/client.js';
import { syncPersonToGhl } from '../src/providers/ghl/sync.js';
import { confirmationFromMirror, recordGrantConfirmation } from '../src/providers/ghl/grants.js';
import { seedCatalog, currentVersion } from '../src/plans.js';
import { resolveOrCreatePerson, linkIdentity } from '../src/identity.js';
import { signForTest } from '../src/stripe/signature.js';
import { ingestStripeWebhook } from '../src/stripe/ingest.js';
import { processPending } from '../src/stripe/processor.js';
import { stripeHandlers } from '../src/stripe/handlers.js';
import { evaluate } from '../src/entitlements.js';
import { runMonthlyAllowance } from '../src/jobs/allowance.js';
import { createApiServer } from '../src/api/server.js';
import { createClient } from '../src/clients.js';
import { setActionPrice } from '../src/quotes.js';
import { createOffer, acceptOffer, confirmLegacyCancelled, verifyLegacyCancellations, enforceMigrationBillingGate } from '../src/migration-offers.js';

const KEY = 'sk_test_fixture_' + 'p'.repeat(16);
const SECRET = 'whsec_test_fixture_' + 'p'.repeat(24);
const URLS = { successUrl: 'https://gaiahealers.app/ok', cancelUrl: 'https://gaiahealers.app/cancel' };
const P = 'gaia-m:';
const day = 86400;
const D = (s) => new Date(s);
const sec = (d) => Math.floor(d.getTime() / 1000);
const BENEFITS = {
  'courses.core': { type: 'offer', ghlId: 'offer-fixture-core', viaTag: `${P}benefit:courses.core` },
  'crm.ghl_subaccount': { type: 'offer', ghlId: 'offer-fixture-crm', viaTag: `${P}benefit:crm.ghl_subaccount` },
};

async function world() {
  const pool = await freshPool();
  await seedCatalog(pool);
  await openLaunch(pool);
  await pool.query(`INSERT INTO legacy_memberships (external_subscription_id, payment_provider, mapping, reported_status, last_seen_at)
                    VALUES ('ghl-sub-fixture-other', 'stripe', 'mapped', 'canceled', '2026-12-01T09:00:00Z')`);   // mirror loaded and fresh at the pilot's clock
  const stripeSrv = await fakeStripe();
  const ghlSrv = await fakeGhl({ contacts: [
    { id: 'gp_ava', email: 'ava.pilot@example.invalid', tags: ['ahc-newsletter'] },
    { id: 'gp_leo', email: 'leo.pilot@example.invalid', tags: ['ahc-silver-active'] },
  ] });
  const stripe = createStripeClient({ apiKey: KEY, fetch: fetchVia, baseUrl: stripeSrv.url, sleep: noSleep });
  const ghl = createGhlClient({ token: 'ghl-fixture-token', locationId: 'loc_fixture', fetch: fetchVia, baseUrl: ghlSrv.url, sleep: noSleep });
  let n = 0;
  const deliver = async (type, object, at) => {
    const e = { id: `evt_pilot_${++n}`, object: 'event', type, created: sec(at), livemode: false, data: { object } };
    const raw = JSON.stringify(e);
    const r = await ingestStripeWebhook(pool, { rawBody: raw, signatureHeader: signForTest(SECRET, raw, sec(at)), secrets: [SECRET], now: at.getTime() });
    assert.equal(r.status, 200);
    return processPending(pool, { handlers: stripeHandlers, now: new Date(at.getTime() + 1000) });
  };
  const sync = (personId, now) => syncPersonToGhl({ pool, ghl, fieldIds: {}, benefitMap: BENEFITS, now }, personId);
  const tagsOf = (id) => ghlSrv.db.get(id).tags;
  return { pool, stripe, stripeSrv, ghlSrv, deliver, sync, tagsOf, close: async () => { await stripeSrv.close(); await ghlSrv.close(); await pool.end(); } };
}
const priceIdOf = async (pool, key, interval) => (await pool.query('SELECT id FROM plan_version_prices WHERE plan_version_id = $1 AND billing_interval = $2', [(await currentVersion(pool, key)).id, interval])).rows[0].id;
const stripeRefs = async (pool, personId) => ({
  customer: (await pool.query("SELECT external_id FROM person_identities WHERE person_id = $1 AND platform = 'stripe'", [personId])).rows[0].external_id,
  price: (key) => pool.query(`SELECT r.external_price_id FROM provider_price_refs r JOIN plan_version_prices p ON p.id = r.plan_version_price_id
                              JOIN plan_versions v ON v.id = p.plan_version_id JOIN plans pl ON pl.id = v.plan_id WHERE pl.key = $1 AND p.billing_interval = 'month'`, [key]).then((r) => r.rows[0].external_price_id),
});
const subObj = (id, customer, price, status, start, end, extra = {}) => ({ id, object: 'subscription', customer, status, items: { data: [{ price: { id: price }, current_period_start: sec(start), current_period_end: sec(end) }] }, ...extra });

test('A. new member: signup to cancellation, every step through the real services', { skip: SKIP }, async () => {
  const w = await world();
  const { pool } = w;
  try {
    // Signup: Gaia identity + the existing GHL contact.
    const { personId: ava } = await resolveOrCreatePerson(pool, { platform: 'email', kind: 'address', externalId: 'ava.pilot@example.invalid' });
    await linkIdentity(pool, ava, { platform: 'ghl', kind: 'contact', externalId: 'gp_ava' }, { linkedBy: 'pilot' });

    // Checkout (guard says ok: nothing paid elsewhere).
    const t0 = D('2026-12-01T10:00:00Z');
    const co = await createCheckoutSession({ pool, stripe: w.stripe, env: process.env }, ava, await priceIdOf(pool, 'standard', 'month'), { ...URLS, idempotencyKey: 'pilot-ava-checkout', now: t0 });
    assert.equal(co.status, 'ok');
    const refs = await stripeRefs(pool, ava);
    const std = await refs.price('standard');

    // Payment: Stripe reports the subscription and the paid first invoice.
    const end1 = D('2027-01-01T10:00:00Z');
    await w.deliver('customer.subscription.created', subObj('sub_ava', refs.customer, std, 'active', t0, end1), t0);
    await w.deliver('invoice.paid', { id: 'in_ava_1', object: 'invoice', subscription: 'sub_ava', customer: refs.customer, amount_paid: 4700, currency: 'usd',
      status_transitions: { paid_at: sec(t0) }, lines: { data: [{ price: { id: std }, period: { start: sec(t0), end: sec(end1) } }] } }, t0);
    assert.equal((await pool.query("SELECT status FROM subscriptions WHERE provider_subscription_id = 'sub_ava'")).rows[0].status, 'active', 'membership activated');

    // Coins granted (monthly allowance job) and entitlements active.
    assert.equal((await runMonthlyAllowance(pool, { now: D('2026-12-01T11:00:00Z') })).granted, 1);
    assert.equal((await pool.query('SELECT granted_balance FROM coin_wallets WHERE person_id = $1', [ava])).rows[0].granted_balance, 500);
    const ent = await evaluate(pool, ava, D('2026-12-02T00:00:00Z'));
    assert.equal(ent.entitlements['software.scan_analysis'].value, true);
    assert.equal(ent.entitlements['crm.ghl_subaccount'], undefined);

    // An AI job paid with coins through the internal API (quote -> hold -> capture).
    await setActionPrice(pool, { actionKey: 'ai.scan_analysis', coins: 40, description: 'pilot fixture price' }, { actorType: 'admin', actorId: 'pilot' });
    const { token } = await createClient(pool, { name: 'pilot-proxy', scopes: ['wallet:read', 'coins:quote', 'coins:debit', 'entitlements:read'] }, 'pilot');
    const api = createApiServer(pool, { clock: () => D('2026-12-02T00:00:00Z') });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));
    const call = async (method, path, body, h = {}) => (await fetch(`http://127.0.0.1:${api.address().port}${path}`, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...h }, body: body && JSON.stringify(body) })).json();
    try {
      const q = (await call('POST', '/v1/coins/quotes', { personId: ava, action: 'ai.scan_analysis' })).quote;
      const h = (await call('POST', '/v1/coins/holds', { personId: ava, quoteId: q.quoteId }, { 'idempotency-key': 'pilot-ava-job-0001' })).hold;
      assert.equal((await call('POST', `/v1/coins/holds/${h.operationId}/capture`, { personId: ava })).hold.status, 'captured');
      assert.equal((await call('GET', `/v1/persons/${ava}/wallet`)).wallet.granted.coins, 460);
      assert.equal((await call('GET', `/v1/persons/${ava}/entitlements?key=courses.core`)).entitled, true);
    } finally { await new Promise((r) => api.close(r)); }

    // GHL sync: Gaia tags added, course grant expected, confirmed by the course-access mirror; ahc-* untouched.
    const s1 = await w.sync(ava, D('2026-12-02T00:00:00Z'));
    assert.equal(s1.status, 'synced');
    assert.ok(w.tagsOf('gp_ava').includes(`${P}tier:standard`) && w.tagsOf('gp_ava').includes(`${P}benefit:courses.core`));
    const conf = confirmationFromMirror({ type: 'Course Access Granted', contactId: 'gp_ava', offerId: 'offer-fixture-core' });
    assert.equal((await recordGrantConfirmation(pool, conf)).matched, true);

    // Renewal: next period paid; next month's allowance replaces the old one.
    const end2 = D('2027-02-01T10:00:00Z');
    await w.deliver('invoice.paid', { id: 'in_ava_2', object: 'invoice', subscription: 'sub_ava', customer: refs.customer, amount_paid: 4700, currency: 'usd',
      lines: { data: [{ price: { id: std }, period: { start: sec(end1), end: sec(end2) } }] } }, end1);
    await w.deliver('customer.subscription.updated', subObj('sub_ava', refs.customer, std, 'active', end1, end2), new Date(end1.getTime() + 2000));
    await runMonthlyAllowance(pool, { now: D('2027-01-01T12:00:00Z') });
    assert.equal((await pool.query('SELECT granted_balance FROM coin_wallets WHERE person_id = $1', [ava])).rows[0].granted_balance, 500, 'new allowance; last month\'s leftovers expired');

    // Reconciliation of the two charges: zero mismatches.
    const rec = await reconcilePage(pool, { invoices: [
      { id: 'in_ava_1', status: 'paid', amount_paid: 4700, currency: 'usd', livemode: false, customer: refs.customer },
      { id: 'in_ava_2', status: 'paid', amount_paid: 4700, currency: 'usd', livemode: false, customer: refs.customer }], charges: [], refunds: [], disputes: [],
      window: { from: D('2026-11-30T00:00:00Z'), to: D('2027-01-02T00:00:00Z') }, complete: true });
    assert.deepEqual(rec.mismatches, []);

    // Cancellation at period end, then Stripe ends it.
    await w.deliver('customer.subscription.updated', subObj('sub_ava', refs.customer, std, 'active', end1, end2, { cancel_at: sec(end2) }), D('2027-01-10T00:00:00Z'));
    assert.equal((await evaluate(pool, ava, D('2027-01-20T00:00:00Z'))).entitlements['courses.core'].value, true, 'access until the period end');
    await w.deliver('customer.subscription.deleted', subObj('sub_ava', refs.customer, std, 'canceled', end1, end2), end2);
    assert.equal((await pool.query("SELECT status FROM subscriptions WHERE provider_subscription_id = 'sub_ava'")).rows[0].status, 'canceled');
    assert.deepEqual((await evaluate(pool, ava, D('2027-02-02T00:00:00Z'))).entitlements, {});
    assert.equal((await runMonthlyAllowance(pool, { now: D('2027-02-02T00:00:00Z') })).expired, 1, 'granted coins end with the membership');

    // GHL: Gaia access revoked; the member's own GHL tags never touched.
    const s2 = await w.sync(ava, D('2027-02-02T00:00:00Z'));
    assert.equal(s2.status, 'synced');
    assert.ok(!w.tagsOf('gp_ava').includes(`${P}benefit:courses.core`));
    assert.ok(w.tagsOf('gp_ava').includes('ahc-newsletter'));
    assert.equal((await pool.query('SELECT sum(amount_cents)::int s FROM payment_ledger')).rows[0].s, 9400);
    assert.deepEqual((await pool.query('SELECT * FROM wallet_mismatches()')).rows, []);
  } finally { await w.close(); }
});

test('B. legacy Silver member migrates to Professional without double billing or losing access', { skip: SKIP }, async () => {
  const w = await world();
  const { pool } = w;
  try {
    const { personId: leo } = await resolveOrCreatePerson(pool, { platform: 'email', kind: 'address', externalId: 'leo.pilot@example.invalid' });
    await linkIdentity(pool, leo, { platform: 'ghl', kind: 'contact', externalId: 'gp_leo' }, { linkedBy: 'pilot' });
    const paidThrough = D('2026-12-20T00:00:00Z');
    const legacy = (await pool.query(
      `INSERT INTO legacy_memberships (external_subscription_id, external_contact_id, person_id, payment_provider, external_price_id, tier, mapping, reported_status,
                                       amount_cents, currency, billing_interval, paid_through_estimate, last_seen_at)
       VALUES ('ghl-sub-fixture-leo', 'gp_leo', $1, 'paypal', 'price_fixture_silver', 'silver', 'mapped', 'active', 9700, 'USD', 'month', $2, '2026-12-01T09:00:00Z') RETURNING id`, [leo, paidThrough])).rows[0].id;
    const t0 = D('2026-12-01T10:00:00Z');

    // A normal checkout is refused: he already pays through GHL.
    assert.equal((await createCheckoutSession({ pool, stripe: w.stripe, env: process.env }, leo, await priceIdOf(pool, 'professional', 'month'), { ...URLS, idempotencyKey: 'pilot-leo-0', now: t0 })).status, 'migration_required');

    // Offer (no sweetener by default) -> accept -> migration checkout.
    const offer = await createOffer(pool, { legacyMembershipId: legacy, targetPlanVersionId: (await currentVersion(pool, 'professional')).id, targetInterval: 'month' }, 'staff-pilot');
    await acceptOffer(pool, offer.id, leo);
    const co = await createMigrationCheckoutSession({ pool, stripe: w.stripe, env: process.env }, offer.id, { ...URLS, idempotencyKey: 'pilot-leo-1', now: t0 });
    assert.equal(co.status, 'ok');
    assert.equal(co.billingStartsAt.toISOString(), paidThrough.toISOString(), 'no charge while the legacy membership is paid');

    // Stripe reports the trialing subscription; it links to the offer.
    const refs = await stripeRefs(pool, leo);
    const pro = await refs.price('professional');
    await w.deliver('customer.subscription.created', subObj('sub_leo', refs.customer, pro, 'trialing', t0, paidThrough, { trial_end: sec(paidThrough), metadata: { gaia_migration_offer_id: offer.id } }), t0);
    w.stripeSrv.db.subscriptions.set('sub_leo', { id: 'sub_leo', status: 'trialing', items: { data: [{ current_period_end: sec(paidThrough) }] } });
    assert.equal((await pool.query('SELECT status FROM migration_offers WHERE id = $1', [offer.id])).rows[0].status, 'subscribed');

    // GHL: new access granted while the legacy access stays (both Gaia tags; ahc-* untouched).
    await w.sync(leo, D('2026-12-02T00:00:00Z'));
    const tags1 = w.tagsOf('gp_leo');
    assert.ok(tags1.includes(`${P}legacy:silver`) && tags1.includes(`${P}tier:professional`) && tags1.includes(`${P}benefit:crm.ghl_subaccount`));
    assert.ok(tags1.includes('ahc-silver-active'), 'existing course access untouched');

    // Billing gate: staff have not reported the cancellation -> trial extended, no charge.
    assert.equal((await enforceMigrationBillingGate({ pool, stripe: w.stripe, env: process.env }, { now: D('2026-12-18T00:00:00Z') })).held, 1);
    await confirmLegacyCancelled(pool, offer.id, 'staff-pilot');
    // The read-only mirror sees GHL report the PayPal subscription cancelled -> verified -> completed.
    await pool.query("UPDATE legacy_memberships SET reported_status = 'canceled' WHERE id = $1", [legacy]);
    assert.equal((await verifyLegacyCancellations(pool)).verified, 1);
    assert.equal((await pool.query('SELECT status FROM migration_offers WHERE id = $1', [offer.id])).rows[0].status, 'completed');

    // GHL: the old Gaia legacy tag goes only after the new grant is confirmed.
    const s2 = await w.sync(leo, D('2026-12-21T00:00:00Z'));
    assert.equal(s2.status, 'synced_revoke_deferred');
    assert.ok(w.tagsOf('gp_leo').includes(`${P}legacy:silver`), 'kept until the new access is confirmed');
    for (const id of ['offer-fixture-core', 'offer-fixture-crm']) await recordGrantConfirmation(pool, { contactId: 'gp_leo', type: 'offer', ghlId: id, granted: true });
    assert.equal((await w.sync(leo, D('2026-12-21T01:00:00Z'))).status, 'synced');
    assert.ok(!w.tagsOf('gp_leo').includes(`${P}legacy:silver`));
    assert.ok(w.tagsOf('gp_leo').includes('ahc-silver-active'), 'GHL-owned tags are left to GHL workflows');

    // First real charge only after the (held) trial ends.
    const start = D('2026-12-27T00:00:00Z'); const end = D('2027-01-27T00:00:00Z');
    await w.deliver('invoice.paid', { id: 'in_leo_1', object: 'invoice', subscription: 'sub_leo', customer: refs.customer, amount_paid: 9700, currency: 'usd',
      lines: { data: [{ price: { id: pro }, period: { start: sec(start), end: sec(end) } }] } }, start);
    assert.equal((await pool.query("SELECT status FROM subscriptions WHERE provider_subscription_id = 'sub_leo'")).rows[0].status, 'active');
    assert.equal((await pool.query('SELECT count(*)::int n, sum(amount_cents)::int s FROM payment_ledger')).rows[0].s, 9700, 'one charge, after the legacy period');
    assert.equal((await evaluate(pool, leo, D('2027-01-02T00:00:00Z'))).entitlements['crm.ghl_subaccount'].value, true);
  } finally { await w.close(); }
});
