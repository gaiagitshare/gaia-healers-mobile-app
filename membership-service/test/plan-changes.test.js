import './_providers-deny-network.mjs';
/**
 * Plan changes (owner decision 2026-10-26): upgrade after the prorated payment,
 * downgrade and interval switch at the period end, cancelling a scheduled change.
 * Real Postgres (test database) + a LOOPBACK fake Stripe + signed webhook fixtures
 * through the real ingest / processor / handlers. Nothing leaves this machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP } from './_db.js';
import { fakeStripe, fetchVia, noSleep } from './_providers-fakes.js';
import { createStripeClient } from '../src/providers/stripe/client.js';
import { ensureProductAndPrice, previewPlanChange, changePlan, cancelScheduledChange } from '../src/providers/stripe/adapter.js';
import { seedCatalog, currentVersion } from '../src/plans.js';
import { resolveOrCreatePerson, linkIdentity } from '../src/identity.js';
import { setLaunchStage, addPilotMember } from '../src/launch.js';
import { grantAllowance, walletView } from '../src/coins.js';
import { cycleStart } from '../src/jobs/allowance.js';
import { evaluate } from '../src/entitlements.js';
import { signForTest } from '../src/stripe/signature.js';
import { ingestStripeWebhook } from '../src/stripe/ingest.js';
import { processPending } from '../src/stripe/processor.js';
import { stripeHandlers } from '../src/stripe/handlers.js';
import { classifyChange } from '../src/plan-changes.js';
import { WEBHOOK_EVENTS } from '../src/providers/stripe/setup.js';

const KEY = 'sk_test_fixture_' + 'p'.repeat(16);
const SECRET = 'whsec_test_fixture_' + 'c'.repeat(24);
const T = Math.floor(Date.parse('2026-11-10T00:00:00Z') / 1000);   // inside the subscription's period
const START = T - 9 * 86400, END = START + 30 * 86400;
const NOW = new Date(T * 1000);
const admin = { actorType: 'admin', actorId: 'owner-fixture' };
const ENV = { MEMBERSHIP2_STAGE_CEILING: 'ALL_NEW_CUSTOMERS' };
let evn = 0;

async function send(pool, type, object, created) {
  const raw = JSON.stringify({ id: 'evt_pc_' + (++evn), object: 'event', type, created, livemode: false, data: { object } });
  return ingestStripeWebhook(pool, { rawBody: raw, signatureHeader: signForTest(SECRET, raw, created), secrets: [SECRET], now: created * 1000 });
}
const sendRaw = (pool, raw, created) => ingestStripeWebhook(pool, { rawBody: raw, signatureHeader: signForTest(SECRET, raw, created), secrets: [SECRET], now: created * 1000 });
const run = (pool, at = T + 3600) => processPending(pool, { handlers: stripeHandlers, now: new Date(at * 1000 + 60000) });

/**
 * A pilot member at INTERNAL_PILOT with an active Stripe subscription on `plan` / `interval`,
 * the Stripe prices for every paid plan recorded, and a loaded legacy mirror (someone else's row).
 */
async function world({ plan = 'standard', interval = 'month', pilot = true, stage = 'INTERNAL_PILOT', source = 'new' } = {}) {
  const pool = await freshPool();
  await seedCatalog(pool);
  await setLaunchStage(pool, { stage, reason: 'plan change test fixture', approvalRef: stage === 'INTERNAL_PILOT' ? null : 'GO-fixture' }, admin);
  await pool.query(`INSERT INTO legacy_memberships (external_subscription_id, external_contact_id, payment_provider, mapping, tier, reported_status, paid_through_estimate, last_seen_at)
                    VALUES ('ghl-sub-fixture-other', 'ghl-contact-fixture-other', 'paypal', 'mapped', 'gold', 'active', '2026-12-20', $1)`, [NOW]);
  const srv = await fakeStripe();
  const stripe = createStripeClient({ apiKey: KEY, fetch: fetchVia, baseUrl: srv.url, sleep: noSleep });
  const { personId } = await resolveOrCreatePerson(pool, { platform: 'email', kind: 'address', externalId: 'plan.change@example.invalid' });
  await linkIdentity(pool, personId, { platform: 'stripe', kind: 'customer', externalId: 'cus_pc_1' }, { linkedBy: 'test', verified: true });
  if (pilot) await addPilotMember(pool, personId, {}, admin);
  const price = {};
  for (const key of ['standard', 'professional', 'inner_circle']) {
    const v = await currentVersion(pool, key);
    for (const iv of ['month', 'year']) {
      const pvp = (await pool.query('SELECT id, amount_cents FROM plan_version_prices WHERE plan_version_id = $1 AND billing_interval = $2', [v.id, iv])).rows[0];
      price[`${key}:${iv}`] = { pvp: pvp.id, version: v.id, stripe: (await ensureProductAndPrice({ pool, stripe }, pvp.id)).priceId, amount: pvp.amount_cents };
    }
  }
  const cur = price[`${plan}:${interval}`];
  srv.db.subscriptions.set('sub_pc_1', { id: 'sub_pc_1', object: 'subscription', customer: 'cus_pc_1', status: 'active', livemode: false, cancel_at_period_end: false, schedule: null, pending_update: null,
    items: { data: [{ id: 'si_pc_1', price: { ...srv.db.prices.get(cur.stripe) }, current_period_start: START, current_period_end: END }] } });
  const subId = (await pool.query(
    `INSERT INTO subscriptions (person_id, plan_version_id, billing_interval, status, provider, provider_subscription_id, source, current_period_start, current_period_end, provider_state_at)
     VALUES ($1, $2, $3, 'active', 'stripe', 'sub_pc_1', $4, $5, $6, $7) RETURNING id`, [personId, cur.version, interval, source, new Date(START * 1000), new Date(END * 1000), new Date(START * 1000)])).rows[0].id;
  srv.requests.length = 0;
  const deps = { pool, stripe, env: ENV };
  const local = async () => (await pool.query('SELECT s.*, p.key AS plan_key FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id WHERE s.id = $1', [subId])).rows[0];
  const changes = async () => (await pool.query('SELECT * FROM subscription_changes WHERE subscription_id = $1 ORDER BY created_at', [subId])).rows;
  const stripeSub = () => srv.db.subscriptions.get('sub_pc_1');
  return { pool, srv, stripe, deps, personId, subId, price, local, changes, stripeSub, close: async () => { await srv.close(); await pool.end(); } };
}
const subEvent = (w, priceId, { start = START, end = END, status = 'active' } = {}) => ({ id: 'sub_pc_1', object: 'subscription', customer: 'cus_pc_1', status,
  items: { data: [{ id: 'si_pc_1', price: { id: priceId }, current_period_start: start, current_period_end: end }] } });

test('classification is server-side: interval switches and lower tiers wait for the period end', () => {
  assert.equal(classifyChange({ planId: 'a', interval: 'month', rank: 1 }, { planId: 'a', interval: 'month', rank: 1 }), null);
  assert.deepEqual(classifyChange({ planId: 'a', interval: 'month', rank: 1 }, { planId: 'b', interval: 'month', rank: 2 }), { kind: 'upgrade', timing: 'after_payment' });
  assert.deepEqual(classifyChange({ planId: 'b', interval: 'month', rank: 2 }, { planId: 'a', interval: 'month', rank: 1 }), { kind: 'downgrade', timing: 'period_end' });
  assert.deepEqual(classifyChange({ planId: 'a', interval: 'month', rank: 1 }, { planId: 'a', interval: 'year', rank: 1 }), { kind: 'interval_switch', timing: 'period_end' });
  assert.deepEqual(classifyChange({ planId: 'a', interval: 'month', rank: 1 }, { planId: 'b', interval: 'year', rank: 2 }), { kind: 'interval_switch', timing: 'period_end' });
  for (const e of ['customer.subscription.pending_update_applied', 'customer.subscription.pending_update_expired', 'subscription_schedule.released', 'subscription_schedule.canceled']) assert.ok(WEBHOOK_EVENTS.includes(e), e);
  assert.equal(WEBHOOK_EVENTS.length, 18);
});

test('upgrade, payment succeeds: preview from Stripe, always_invoice + pending_if_incomplete, tier and coins only after the paid-invoice webhook', { skip: SKIP }, async () => {
  const w = await world();
  try {
    // This cycle's Standard allowance was granted (by the monthly job's key).
    const cyc = cycleStart(new Date(START * 1000), NOW);
    await grantAllowance(w.pool, { personId: w.personId, coins: 500, cycleKey: `${w.subId}:${cyc.toISOString()}`, resetAt: cyc });

    const pv = await previewPlanChange(w.deps, w.personId, w.subId, { planKey: 'professional', interval: 'month', now: NOW });
    assert.deepEqual([pv.status, pv.kind, pv.timing, pv.amountDueNowCents, pv.currency, pv.to.planName, pv.from.planName], ['ok', 'upgrade', 'after_payment', 2500, 'USD', 'Professional', 'Standard']);
    assert.equal(pv.prorationDate, T);
    assert.ok(w.srv.requests.some((r) => r.path === '/v1/invoices/create_preview' && r.form['subscription_details[proration_behavior]'] === 'always_invoice'));
    assert.equal((await w.changes()).length, 0, 'a preview writes nothing');

    const r = await changePlan(w.deps, w.personId, w.subId, { planKey: 'professional', interval: 'month', prorationDate: pv.prorationDate, idempotencyKey: 'm2-change-up-0001', now: NOW });
    assert.deepEqual([r.status, r.outcome, r.change.status, r.change.toPlan, r.change.amountDueCents], ['ok', 'processing', 'pending_payment', 'professional', 2500]);
    const upd = w.srv.db.changes.at(-1).form;
    assert.deepEqual([upd.proration_behavior, upd.payment_behavior, upd['items[0][id]'], upd['items[0][price]'], upd.proration_date], ['always_invoice', 'pending_if_incomplete', 'si_pc_1', w.price['professional:month'].stripe, String(T)]);
    const stripeKey = w.srv.requests.find((q) => q.method === 'POST' && q.path === '/v1/subscriptions/sub_pc_1').headers['idempotency-key'];
    assert.equal(stripeKey, `gaia-change-${r.change.id}`);
    assert.equal((await w.local()).plan_key, 'standard', 'the API answer alone grants nothing');
    assert.deepEqual((await evaluate(w.pool, w.personId, NOW)).plans.map((x) => x.planKey), ['standard']);
    assert.equal((await evaluate(w.pool, w.personId, NOW)).entitlements['discount.certifications_pct'], undefined, 'no Professional benefit before payment');

    // Replay of the same member request: the same change, no second Stripe update.
    const n = w.srv.db.changes.length;
    const again = await changePlan(w.deps, w.personId, w.subId, { planKey: 'professional', interval: 'month', idempotencyKey: 'm2-change-up-0001', now: NOW });
    assert.deepEqual([again.replayed, again.change.id, w.srv.db.changes.length], [true, r.change.id, n]);
    await assert.rejects(changePlan(w.deps, w.personId, w.subId, { planKey: 'inner_circle', interval: 'month', idempotencyKey: 'm2-change-up-0001', now: NOW }), (e) => e.code === 'CONFLICT');
    assert.equal((await changePlan(w.deps, w.personId, w.subId, { planKey: 'inner_circle', interval: 'month', idempotencyKey: 'm2-change-up-0002', now: NOW })).status, 'change_pending', 'one pending change per subscription');

    // Out of order: the subscription update (new price) arrives BEFORE the invoice: still Standard.
    await send(w.pool, 'customer.subscription.updated', subEvent(w, w.price['professional:month'].stripe), T + 2);
    await run(w.pool);
    assert.equal((await w.local()).plan_key, 'standard', 'the item change alone does not grant the higher tier');
    const inv = [...w.srv.db.invoices.values()].at(-1);
    const paid = JSON.stringify({ id: 'evt_pc_paid_1', object: 'event', type: 'invoice.paid', created: T + 1, livemode: false, data: { object: { ...inv, amount_paid: inv.amount_due, status_transitions: { paid_at: T + 1 } } } });
    await sendRaw(w.pool, paid, T + 1);
    await sendRaw(w.pool, paid, T + 1);                                                   // a duplicate delivery
    assert.deepEqual(await run(w.pool), { processed: 1, ignored: 0, failed: 0, dead: 0 });
    const after = await w.local();
    assert.equal(after.plan_key, 'professional', 'paid: the higher tier applies');
    assert.equal((await w.changes())[0].status, 'applied');
    assert.equal((await w.changes())[0].coins_granted, 1500, 'Professional 2,000 minus Standard 500 for this cycle');
    const wallet = await walletView(w.pool, w.personId);
    assert.equal(wallet.granted.coins, 2000);
    const ent = await evaluate(w.pool, w.personId, NOW);
    assert.deepEqual([ent.plans.map((x) => x.planKey), ent.entitlements['discount.certifications_pct'].value], [['professional'], 20], 'Professional entitlements now');
    assert.equal((await w.pool.query("SELECT count(*)::int n FROM payment_ledger WHERE provider_object_id = $1", [inv.id])).rows[0].n, 1, 'money booked once');

    // A replay of the invoice under another event id changes nothing (no second coin credit).
    await send(w.pool, 'invoice.paid', { ...inv, amount_paid: inv.amount_due }, T + 5);
    await run(w.pool);
    assert.equal((await walletView(w.pool, w.personId)).granted.coins, 2000);
    // A stale subscription.updated with the OLD price, created before the payment, does not undo the upgrade.
    await send(w.pool, 'customer.subscription.updated', subEvent(w, w.price['standard:month'].stripe), T);
    await run(w.pool);
    assert.equal((await w.local()).plan_key, 'professional');
    assert.deepEqual((await w.pool.query('SELECT * FROM membership.wallet_mismatches()')).rows, []);
    const events = (await w.pool.query("SELECT reason FROM subscription_events WHERE subscription_id = $1 ORDER BY id", [w.subId])).rows.map((x) => x.reason);
    assert.ok(events.includes('change_requested') && events.includes('plan_changed'));
    const audits = (await w.pool.query("SELECT action, reason FROM audit_logs WHERE entity_type = 'subscription_change' ORDER BY id")).rows;
    assert.deepEqual(audits.map((a) => a.action), ['subscription.change_requested', 'subscription.change_invoiced', 'subscription.change_applied']);
    assert.ok(audits.every((a) => a.reason && a.reason.length > 10), 'every audit row has a reason');
  } finally { await w.close(); }
});

test('upgrade, payment fails or needs 3DS: payment required, no access, no coins, the pending update expires on its own', { skip: SKIP }, async () => {
  const w = await world();
  try {
    w.srv.db.payOutcome = 'fail';
    const r = await changePlan(w.deps, w.personId, w.subId, { planKey: 'professional', interval: 'month', idempotencyKey: 'm2-change-fail-01', now: NOW });
    assert.deepEqual([r.status, r.outcome, r.change.paymentRequired], ['ok', 'payment_required', true]);
    assert.match(r.change.paymentUrl, /^https:\/\//);
    assert.equal(w.stripeSub().items.data[0].price.id, w.price['standard:month'].stripe, 'Stripe kept the current price (pending update)');
    const inv = [...w.srv.db.invoices.values()].at(-1);
    await send(w.pool, 'invoice.payment_failed', inv, T + 1);
    await send(w.pool, 'customer.subscription.updated', { ...subEvent(w, w.price['standard:month'].stripe), pending_update: { expires_at: T + 82800 } }, T + 1);
    await run(w.pool);
    const l = await w.local();
    assert.deepEqual([l.plan_key, l.status], ['standard', 'active'], 'a failed proration invoice does not dun the subscription or upgrade it');
    assert.equal((await walletView(w.pool, w.personId)).granted.coins, 0);
    await send(w.pool, 'customer.subscription.pending_update_expired', subEvent(w, w.price['standard:month'].stripe), T + 82801);
    await run(w.pool, T + 82900);
    const ch = (await w.changes())[0];
    assert.deepEqual([ch.status, ch.end_reason], ['expired', 'payment_not_completed']);
    assert.equal((await w.local()).plan_key, 'standard');
    // Now a new change is possible again.
    w.srv.db.payOutcome = 'ok'; w.stripeSub().pending_update = null;
    assert.equal((await previewPlanChange(w.deps, w.personId, w.subId, { planKey: 'professional', interval: 'month', now: NOW })).status, 'ok');
  } finally { await w.close(); }
});

test('downgrade at the period end: schedule from the subscription, no proration, tier kept until the renewal webhook', { skip: SKIP }, async () => {
  const w = await world({ plan: 'professional' });
  try {
    const pv = await previewPlanChange({ ...w.deps, stripe: null }, w.personId, w.subId, { planKey: 'standard', interval: 'month', now: NOW });
    assert.deepEqual([pv.status, pv.kind, pv.timing, pv.amountDueNowCents], ['ok', 'downgrade', 'period_end', 0], 'a period-end preview needs no Stripe call');
    assert.equal(+new Date(pv.effectiveAt), END * 1000);
    const r = await changePlan(w.deps, w.personId, w.subId, { planKey: 'standard', interval: 'month', idempotencyKey: 'm2-change-down-01', now: NOW });
    assert.deepEqual([r.status, r.outcome, r.change.status, r.change.kind, r.change.canCancel], ['ok', 'scheduled', 'scheduled', 'downgrade', true]);
    assert.equal(+new Date(r.change.effectiveAt), END * 1000);
    const sch = [...w.srv.db.schedules.values()][0];
    assert.deepEqual([sch.end_behavior, sch.proration_behavior, sch.phases.length], ['release', 'none', 2]);
    assert.deepEqual([sch.phases[0].items[0].price, sch.phases[0].end_date, sch.phases[1].items[0].price, sch.phases[1].iterations, sch.phases[1].proration_behavior],
      [w.price['professional:month'].stripe, END, w.price['standard:month'].stripe, 1, 'none']);
    assert.equal(sch.metadata.gaia_change_id, r.change.id);
    assert.equal(w.srv.db.changes.length, 0, 'the subscription item is not touched now');
    assert.equal((await w.local()).plan_key, 'professional', 'the member keeps the paid tier until then');
    assert.equal((await changePlan(w.deps, w.personId, w.subId, { planKey: 'professional', interval: 'year', idempotencyKey: 'm2-change-down-02', now: NOW })).status, 'change_pending');
    // The renewal: Stripe moves the item to the scheduled price with the new period.
    await send(w.pool, 'customer.subscription.updated', subEvent(w, w.price['standard:month'].stripe, { start: END, end: END + 30 * 86400 }), END + 10);
    await send(w.pool, 'customer.subscription.updated', subEvent(w, w.price['professional:month'].stripe), T + 100);   // older, delivered late
    await run(w.pool, END + 60);
    const l = await w.local();
    assert.deepEqual([l.plan_key, +l.current_period_end], ['standard', (END + 30 * 86400) * 1000]);
    assert.equal((await w.changes())[0].status, 'applied');
    await send(w.pool, 'subscription_schedule.released', { ...sch, status: 'released' }, END + 30 * 86400 + 5);
    assert.deepEqual(await run(w.pool, END + 30 * 86400 + 60), { processed: 0, ignored: 1, failed: 0, dead: 0 }, 'release after the change applied: nothing to do');
  } finally { await w.close(); }
});

test('annual <-> monthly switch at the period end, and "keep my current plan" releases the schedule (replay-safe)', { skip: SKIP }, async () => {
  const w = await world({ plan: 'standard', interval: 'month' });
  try {
    const r = await changePlan(w.deps, w.personId, w.subId, { planKey: 'standard', interval: 'year', idempotencyKey: 'm2-change-int-01', now: NOW });
    assert.deepEqual([r.outcome, r.change.kind, r.change.toInterval], ['scheduled', 'interval_switch', 'year']);
    assert.equal([...w.srv.db.schedules.values()][0].phases[1].items[0].price, w.price['standard:year'].stripe);
    assert.equal(w.srv.requests.filter((q) => q.method === 'POST').length, 2, 'schedule create + phases');
    const c1 = await cancelScheduledChange(w.deps, w.personId, w.subId, { idempotencyKey: 'm2-keepplan-0001', now: NOW });
    assert.deepEqual([c1.status, c1.change.status, c1.change.endReason], ['ok', 'canceled', 'member_kept_current_plan']);
    assert.equal([...w.srv.db.schedules.values()][0].status, 'released');
    const c2 = await cancelScheduledChange(w.deps, w.personId, w.subId, { idempotencyKey: 'm2-keepplan-0001', now: NOW });
    assert.deepEqual([c2.status, c2.replayed], ['ok', true]);
    assert.equal((await cancelScheduledChange(w.deps, w.personId, w.subId, { idempotencyKey: 'm2-keepplan-0002', now: NOW })).status, 'no_pending_change');
    await send(w.pool, 'subscription_schedule.released', { id: r.change.id, object: 'subscription_schedule', status: 'released' }, T + 10);
    await run(w.pool);
    assert.equal((await w.local()).billing_interval, 'month');
    const reasons = (await w.pool.query('SELECT reason FROM subscription_events WHERE subscription_id = $1 ORDER BY id', [w.subId])).rows.map((x) => x.reason);
    assert.deepEqual(reasons, ['change_requested', 'change_scheduled', 'change_canceled']);
    // A new change is allowed again once the scheduled one is cancelled.
    assert.equal((await previewPlanChange(w.deps, w.personId, w.subId, { planKey: 'standard', interval: 'year', now: NOW })).status, 'ok');
  } finally { await w.close(); }
});

test('an upgrade waiting for payment cannot be "kept"; a schedule released at Stripe ends the Gaia change', { skip: SKIP }, async () => {
  const w = await world({ plan: 'professional' });
  try {
    const r = await changePlan(w.deps, w.personId, w.subId, { planKey: 'standard', interval: 'month', idempotencyKey: 'm2-change-rel-01', now: NOW });
    const sch = [...w.srv.db.schedules.values()][0];
    await send(w.pool, 'subscription_schedule.released', { ...sch, status: 'released' }, T + 10);
    await run(w.pool);
    const ch = (await w.changes())[0];
    assert.deepEqual([ch.id, ch.status, ch.end_reason], [r.change.id, 'canceled', 'schedule_released_at_stripe']);
  } finally { await w.close(); }
  const u = await world();
  try {
    u.srv.db.payOutcome = 'fail';
    await changePlan(u.deps, u.personId, u.subId, { planKey: 'professional', interval: 'month', idempotencyKey: 'm2-change-rel-02', now: NOW });
    const c = await cancelScheduledChange(u.deps, u.personId, u.subId, { idempotencyKey: 'm2-keepplan-0003', now: NOW });
    assert.deepEqual([c.status, c.reason], ['not_cancellable', 'awaiting_payment_expires_on_its_own']);
  } finally { await u.close(); }
});

test('refusals before any Stripe request: legacy members, a non-pilot member, cancelling subscriptions, the same plan', { skip: SKIP }, async () => {
  const leg = await world({ source: 'legacy_import' });
  try {
    for (const fn of [previewPlanChange, changePlan]) {
      const r = await fn(leg.deps, leg.personId, leg.subId, { planKey: 'professional', interval: 'month', idempotencyKey: 'm2-change-leg-01', now: NOW });
      assert.deepEqual([r.status, r.reasons], ['migration_required', ['legacy_subscription']]);
    }
    assert.equal(leg.srv.requests.length, 0);
  } finally { await leg.close(); }

  const ghl = await world();
  try {
    await ghl.pool.query(`INSERT INTO legacy_memberships (external_subscription_id, external_contact_id, payment_provider, mapping, tier, reported_status, paid_through_estimate, last_seen_at, person_id)
                          VALUES ('ghl-sub-fixture-pc', 'ghl-contact-fixture-pc', 'stripe', 'mapped', 'silver', 'active', '2026-12-20', $1, $2)`, [NOW, ghl.personId]);
    const r = await changePlan(ghl.deps, ghl.personId, ghl.subId, { planKey: 'professional', interval: 'month', idempotencyKey: 'm2-change-ghl-01', now: NOW });
    assert.equal(r.status, 'migration_required', 'a live GHL legacy membership: migration only');
    assert.equal(ghl.srv.requests.length, 0);
  } finally { await ghl.close(); }

  const np = await world({ pilot: false });
  try {
    const r = await changePlan(np.deps, np.personId, np.subId, { planKey: 'professional', interval: 'month', idempotencyKey: 'm2-change-np-001', now: NOW });
    assert.deepEqual([r.status, r.reason, r.stage], ['not_available', 'pilot_only', 'INTERNAL_PILOT'], 'the launch gate refuses a non-pilot member');
    assert.equal((await previewPlanChange(np.deps, np.personId, np.subId, { planKey: 'standard', interval: 'year', now: NOW })).reason, 'pilot_only');
    assert.equal(np.srv.requests.length, 0);
    await np.pool.query("UPDATE launch_state SET stage = 'OFF' WHERE id");
    assert.equal((await previewPlanChange(np.deps, np.personId, np.subId, { planKey: 'professional', interval: 'month', now: NOW })).reason, 'membership2_off');
  } finally { await np.close(); }

  const x = await world();
  try {
    assert.equal((await previewPlanChange(x.deps, x.personId, x.subId, { planKey: 'standard', interval: 'month', now: NOW })).status, 'already_subscribed');
    await assert.rejects(previewPlanChange(x.deps, x.personId, x.subId, { planKey: 'free', interval: 'month', now: NOW }), (e) => e.code === 'NOT_FOUND', 'free is a cancellation, not a plan change');
    await x.pool.query('UPDATE subscriptions SET cancel_at = $2 WHERE id = $1', [x.subId, new Date(END * 1000)]);
    assert.deepEqual(Object.values(await previewPlanChange(x.deps, x.personId, x.subId, { planKey: 'professional', interval: 'month', now: NOW })).slice(0, 2), ['not_changeable', 'cancel_scheduled']);
    await x.pool.query('UPDATE subscriptions SET cancel_at = NULL WHERE id = $1', [x.subId]);
    // Stripe disagrees with the record (someone else's customer): review, never a change.
    x.stripeSub().customer = 'cus_someone_else';
    assert.deepEqual((await changePlan(x.deps, x.personId, x.subId, { planKey: 'professional', interval: 'month', idempotencyKey: 'm2-change-mis-01', now: NOW })).reasons, ['stripe_subscription_mismatch']);
    assert.equal((await x.changes()).length, 0);
    x.stripeSub().customer = 'cus_pc_1';
    // A preview older than 15 minutes is refused, so the charged amount is the one shown.
    assert.equal((await changePlan(x.deps, x.personId, x.subId, { planKey: 'professional', interval: 'month', prorationDate: T - 3600, idempotencyKey: 'm2-change-old-01', now: NOW })).status, 'preview_expired');
    await assert.rejects(previewPlanChange(x.deps, x.personId, (await x.pool.query('INSERT INTO persons DEFAULT VALUES RETURNING id')).rows[0].id, { planKey: 'professional', interval: 'month', now: NOW }), (e) => e.code === 'NOT_FOUND', "someone else's subscription");
  } finally { await x.close(); }
});

test('without Stripe: an upgrade preview is PROVIDER_UNAVAILABLE and a change leaves no half-written row', { skip: SKIP }, async () => {
  const w = await world();
  try {
    const { MembershipError } = await import('../src/errors.js');
    const stub = { livemode: false, get: () => { throw new MembershipError('PROVIDER_UNAVAILABLE', 'not connected'); }, post: () => { throw new MembershipError('PROVIDER_UNAVAILABLE', 'not connected'); } };
    await assert.rejects(previewPlanChange({ ...w.deps, stripe: stub }, w.personId, w.subId, { planKey: 'professional', interval: 'month', now: NOW }), (e) => e.code === 'PROVIDER_UNAVAILABLE');
    await assert.rejects(changePlan({ ...w.deps, stripe: stub }, w.personId, w.subId, { planKey: 'standard', interval: 'year', idempotencyKey: 'm2-change-off-01', now: NOW }), (e) => e.code === 'PROVIDER_UNAVAILABLE');
    assert.equal((await w.changes()).length, 0);
    // A network failure AFTER the row exists keeps it `requested`; the same key resumes it.
    // The GET is fine, the schedule POST fails like a network error.
    let calls = 0;
    const flaky = { livemode: false, get: (...a) => w.stripe.get(...a), post: (...a) => { if (++calls === 1) throw new MembershipError('PROVIDER_UNAVAILABLE', 'network'); return w.stripe.post(...a); } };
    await assert.rejects(changePlan({ ...w.deps, stripe: flaky }, w.personId, w.subId, { planKey: 'standard', interval: 'year', idempotencyKey: 'm2-change-net-01', now: NOW }), (e) => e.code === 'PROVIDER_UNAVAILABLE');
    assert.deepEqual((await w.changes()).map((c) => c.status), ['requested']);
    assert.equal((await changePlan(w.deps, w.personId, w.subId, { planKey: 'standard', interval: 'year', idempotencyKey: 'm2-change-net-02', now: NOW })).status, 'change_pending');
    const resumed = await changePlan(w.deps, w.personId, w.subId, { planKey: 'standard', interval: 'year', idempotencyKey: 'm2-change-net-01', now: NOW });
    assert.deepEqual([resumed.status, resumed.outcome], ['ok', 'scheduled']);
    assert.equal(w.srv.db.schedules.size, 1);
  } finally { await w.close(); }
});
