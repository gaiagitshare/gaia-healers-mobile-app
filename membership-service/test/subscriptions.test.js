import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, actor, person } from './_db.js';
import { seedCatalog, currentVersion } from '../src/plans.js';
import { createSubscription, transition, cancelPreview, scheduleCancel, canTransition, grantsAccess } from '../src/subscriptions.js';

const day = 86400000;

test('lifecycle rules (pure)', () => {
  assert.ok(canTransition('incomplete', 'active'));
  assert.ok(!canTransition('canceled', 'active'), 'canceled is terminal');
  assert.ok(!canTransition('expired', 'active'));
  assert.ok(!canTransition('paused', 'past_due'));
  const now = new Date('2026-12-01T00:00:00Z');
  assert.equal(grantsAccess({ status: 'incomplete' }, now), false, 'no paid access before confirmed payment');
  assert.equal(grantsAccess({ status: 'active' }, now), true);
  assert.equal(grantsAccess({ status: 'past_due', grace_until: new Date(now.getTime() + day) }, now), true, 'inside grace');
  assert.equal(grantsAccess({ status: 'past_due', grace_until: new Date(now.getTime() - 1) }, now), false, 'grace over');
  assert.equal(grantsAccess({ status: 'active', cancel_at: new Date(now.getTime() - 1) }, now), false, 'scheduled cancel reached');
  assert.equal(grantsAccess({ status: 'trialing', trial_end: new Date(now.getTime() - 1) }, now), false);
});

test('a subscription moves through its lifecycle with full history', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await seedCatalog(pool);
    const p = await person(pool);
    const v = await currentVersion(pool, 'standard');
    const id = await createSubscription(pool, { personId: p, planVersionId: v.id, interval: 'month' }, actor);
    const t0 = new Date('2026-12-01T00:00:00Z');
    await transition(pool, id, 'active', { reason: 'payment_confirmed', now: t0, periodStart: t0, periodEnd: new Date(t0.getTime() + 30 * day) });
    const pd = await transition(pool, id, 'past_due', { reason: 'payment_failed', now: new Date(t0.getTime() + 30 * day), graceDays: 5 });
    assert.equal(new Date(pd.subscription.grace_until).getTime(), t0.getTime() + 35 * day, 'configurable grace period');
    const again = await transition(pool, id, 'past_due', { reason: 'retry_failed', now: new Date(t0.getTime() + 32 * day), graceDays: 5 });
    assert.equal(new Date(again.subscription.grace_until).getTime(), t0.getTime() + 35 * day, 'a second failure does not extend grace');
    await transition(pool, id, 'active', { reason: 'retry_paid', now: new Date(t0.getTime() + 33 * day) });
    await transition(pool, id, 'canceled', { reason: 'user_canceled' });
    await assert.rejects(transition(pool, id, 'active', {}), (e) => e.code === 'INVALID_TRANSITION');
    const hist = (await pool.query('SELECT from_status, to_status FROM subscription_events WHERE subscription_id = $1 ORDER BY id', [id])).rows;
    assert.deepEqual(hist.map((h) => `${h.from_status}>${h.to_status}`), ['null>incomplete', 'incomplete>active', 'active>past_due', 'past_due>past_due', 'past_due>active', 'active>canceled']);
  } finally { await pool.end(); }
});

test('an older provider state never overwrites a newer one (out-of-order webhooks)', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await seedCatalog(pool);
    const p = await person(pool);
    const v = await currentVersion(pool, 'professional');
    const id = await createSubscription(pool, { personId: p, planVersionId: v.id, interval: 'year', provider: 'stripe', providerSubscriptionId: 'sub_fixture_1', status: 'active' }, actor);
    await transition(pool, id, 'past_due', { providerStateAt: new Date('2026-12-05T00:00:00Z') });
    const r = await transition(pool, id, 'active', { providerStateAt: new Date('2026-12-04T00:00:00Z') });
    assert.equal(r.stale, true);
    assert.equal((await pool.query('SELECT status FROM subscriptions WHERE id = $1', [id])).rows[0].status, 'past_due');
  } finally { await pool.end(); }
});

test('click-to-cancel shows the exact access-end date and keeps access until then', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await seedCatalog(pool);
    const p = await person(pool);
    const v = await currentVersion(pool, 'standard');
    const end = new Date('2027-01-01T00:00:00Z');
    const id = await createSubscription(pool, { personId: p, planVersionId: v.id, interval: 'month', status: 'active', periodStart: new Date('2026-12-01T00:00:00Z'), periodEnd: end }, actor);
    const { accessEndsAt } = await cancelPreview(pool, id);
    assert.equal(new Date(accessEndsAt).getTime(), end.getTime());
    await scheduleCancel(pool, id, { accessEndsAt }, { actorType: 'person', actorId: p });
    const s = (await pool.query('SELECT * FROM subscriptions WHERE id = $1', [id])).rows[0];
    assert.equal(grantsAccess(s, new Date('2026-12-20T00:00:00Z')), true);
    assert.equal(grantsAccess(s, new Date('2027-01-01T00:00:01Z')), false);
  } finally { await pool.end(); }
});
