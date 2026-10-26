import './_providers-deny-network.mjs';
/**
 * Legacy GHL reader (architecture C) against a LOOPBACK fake of GHL payments.
 * Fictional data and fixture price ids only. Proves: GET-only, price-id-only
 * mapping, verbatim status, paid-through from the newest successful payment,
 * stale = review (never canceled, never an access change), review rules,
 * never delete, incomplete passes write nothing, read-only report.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP } from './_db.js';
import { fakeGhlPayments, fakeGhl, fetchVia, noSleep } from './_providers-fakes.js';
import { createGhlLegacyReader, guardLegacyPath, syncLegacyMemberships, markLegacyReviewed, checkLegacyConfig } from '../src/providers/ghl/legacy-reader.js';
import { buildPriceIndex, mapPrice, classifyStatus, LEGACY_BILLING } from '../src/providers/ghl/legacy-config.js';
import { evaluateLegacyRow, normalizeSubscription, mergeReview, addInterval } from '../src/providers/ghl/legacy-rules.js';
import { legacyReport } from '../src/providers/ghl/legacy-report.js';
import { createGhlClient } from '../src/providers/ghl/client.js';
import { syncPersonToGhl } from '../src/providers/ghl/sync.js';
import { resolveOrCreatePerson } from '../src/identity.js';

const NOW = new Date('2026-10-26T12:00:00Z');
const BILLING = {
  silver: { ghlProductId: 'prod_fx_silver', monthlyPriceId: 'pr_fx_silver_m', annualPriceId: 'pr_fx_silver_y' },
  gold: { ghlProductId: 'prod_fx_gold', monthlyPriceId: 'pr_fx_gold_m', annualPriceId: 'pr_fx_gold_y' },
  diamond: { ghlProductId: 'prod_fx_diamond', monthlyPriceId: 'pr_fx_diamond_m', annualPriceId: 'pr_fx_diamond_y' },
};
const sub = (id, { contact = 'gc_' + id, status = 'active', price = 'pr_fx_silver_m', provider = 'stripe', amount = 97, created = '2025-06-01T00:00:00Z', interval = 'month' } = {}) => ({
  _id: id, contactId: contact, status, paymentProvider: { type: provider }, subscriptionId: (provider === 'paypal' ? 'I-' : 'sub_') + id,
  recurringProduct: { price: { _id: price, amount, currency: 'usd', recurring: { interval, intervalCount: 1 } } }, createdAt: created,
});
let txn = 0;
const tx = (subId, at, extra = {}) => ({ _id: 'tx_' + (++txn), subscriptionId: subId, status: 'succeeded', amount: 97, amountRefunded: 0, createdAt: at, ...extra });
const readerFor = (srv, extra = {}) => createGhlLegacyReader({ token: 'ghl-fixture-token', locationId: 'loc_fixture', fetch: fetchVia, baseUrl: srv.url, sleep: noSleep, ...extra });
const rows = async (pool) => Object.fromEntries((await pool.query('SELECT * FROM legacy_memberships')).rows.map((r) => [r.external_subscription_id, r]));

// ---- pure ----------------------------------------------------------------------

test('legacy reader is GET-only and limited to three billing read routes', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const p of ['/payments/subscriptions', '/payments/transactions', '/products/prod_fx_silver/price']) {
      assert.throws(() => guardLegacyPath(m, p), (e) => e.code === 'FORBIDDEN' && /GET-only/.test(e.message), `${m} ${p}`);
    }
  }
  for (const p of ['/contacts/abc', '/payments/orders', '/payments/subscriptions/x', '/products/../payments/price', '/invoices/x', '/locations/x/customFields']) {
    assert.throws(() => guardLegacyPath('GET', p), (e) => e.code === 'FORBIDDEN', p);
  }
  for (const p of ['/payments/subscriptions', '/payments/transactions', '/products/prod_fx_1/price']) guardLegacyPath('GET', p);
  const r = createGhlLegacyReader({ token: 't', locationId: 'loc', fetch: async () => { throw new Error('unused'); } });
  assert.deepEqual(Object.keys(r).sort(), ['getProductPrices', 'listSubscriptions', 'listTransactions'], 'no write method exists');
});

test('tier maps ONLY by price id: mapped, unmapped, ambiguous', () => {
  const idx = buildPriceIndex(BILLING);
  assert.deepEqual(mapPrice(idx, 'pr_fx_gold_y'), { mapping: 'mapped', tier: 'gold', interval: 'year' });
  assert.equal(mapPrice(idx, 'pr_fx_next_level').mapping, 'unmapped');
  assert.equal(mapPrice(idx, null).mapping, 'unmapped');
  const amb = buildPriceIndex({ gold: { monthlyPriceId: 'pr_fx_shared' }, diamond: { annualPriceId: 'pr_fx_shared' } });
  assert.deepEqual(mapPrice(amb, 'pr_fx_shared'), { mapping: 'ambiguous', tier: null, interval: null });
  // name and amount are ignored: a "Gold"-named $497 subscription with an unknown price is unmapped
  const s = normalizeSubscription({ _id: 's', contactId: 'c', status: 'active', recurringProduct: { product: { name: 'Gaia Healers 2.0 CRM Gold' }, price: { _id: 'pr_fx_other', amount: 497 } } }, idx);
  assert.deepEqual([s.mapping, s.tier], ['unmapped', null]);
  assert.throws(() => buildPriceIndex({ 'Bad Tier': {} }), /invalid legacy tier/);
  assert.ok(buildPriceIndex(LEGACY_BILLING).size === 6, 'the shipped config has six distinct GHL price ids, none ambiguous');
  for (const [, hits] of buildPriceIndex(LEGACY_BILLING)) assert.equal(hits.length, 1);
});

test('status is classified, never rewritten; unknown strings are unknown', () => {
  assert.equal(classifyStatus('active'), 'live');
  assert.equal(classifyStatus('Past_Due'), 'live');
  assert.equal(classifyStatus('canceled'), 'ended');
  assert.equal(classifyStatus('pending_paypal_thing'), 'unknown');
  assert.equal(classifyStatus(''), 'unknown');
  const s = normalizeSubscription(sub('x', { status: 'ACTIVE ' }), buildPriceIndex(BILLING));
  assert.equal(s.reportedStatus, 'ACTIVE ', 'verbatim');
});

test('paid-through and stale: interval + grace, calendar arithmetic, review only', () => {
  assert.equal(addInterval(new Date('2026-01-31T00:00:00Z'), 'year').toISOString(), '2027-01-31T00:00:00.000Z');
  assert.equal(addInterval(new Date('2026-09-10T00:00:00Z'), 'month').toISOString(), '2026-10-10T00:00:00.000Z');
  const idx = buildPriceIndex(BILLING);
  const s = normalizeSubscription(sub('m'), idx);
  const pay = (d) => new Map([['m', new Date(d)]]);
  assert.equal(evaluateLegacyRow(s, { payments: pay('2026-09-20T00:00:00Z'), now: NOW, graceDays: 7 }).stale, false, '10-20 + 7d grace not passed');
  const late = evaluateLegacyRow(s, { payments: pay('2026-09-10T00:00:00Z'), now: NOW, graceDays: 7 });
  assert.equal(late.stale, true);
  assert.deepEqual(late.reasons, ['stale_suspected']);
  assert.equal(evaluateLegacyRow(s, { payments: pay('2026-09-10T00:00:00Z'), now: NOW, graceDays: 30 }).stale, false, 'grace is configurable');
  const ended = evaluateLegacyRow(normalizeSubscription(sub('m', { status: 'canceled' }), idx), { payments: new Map(), now: NOW });
  assert.deepEqual([ended.stale, ended.reasons], [false, []], 'an ended row is never stale and never a review item by itself');
  const fresh = evaluateLegacyRow(normalizeSubscription(sub('n', { created: '2026-10-20T00:00:00Z' }), idx), { payments: new Map(), now: NOW });
  assert.equal(fresh.stale, false, 'a subscription started this month without a payment yet is not stale');
  for (const out of [late, ended, fresh]) assert.deepEqual(Object.keys(out).sort(), ['lastPaymentAt', 'paidThrough', 'reasons', 'stale', 'statusClass'], 'no status / access output exists');
});

test('review merge: sticky reasons, reviewed rows stay reviewed until a NEW reason', () => {
  assert.deepEqual(mergeReview(null, []), { state: 'none', reasons: [] });
  const a = mergeReview(null, ['contact_rekeyed']);
  assert.deepEqual(a, { state: 'needs_review', reasons: ['contact_rekeyed'] });
  assert.deepEqual(mergeReview({ review_state: 'needs_review', review_reasons: a.reasons }, []), a, 'sticky until reviewed');
  assert.deepEqual(mergeReview({ review_state: 'reviewed', review_reasons: ['contact_rekeyed', 'stale_suspected'] }, ['stale_suspected']).state, 'reviewed');
  assert.deepEqual(mergeReview({ review_state: 'reviewed', review_reasons: ['stale_suspected'] }, ['stale_suspected', 'unknown_status']).state, 'needs_review');
});

// ---- passes against the fake ----------------------------------------------------

test('a pass mirrors subscriptions: mapping, provider, amount, interval, last payment, person link, review reasons', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhlPayments({
    subscriptions: [
      sub('s_silver_m', { contact: 'gc_linked' }),
      sub('s_silver_y', { provider: 'paypal', price: 'pr_fx_silver_y', amount: 997, interval: 'year' }),
      sub('s_diamond_pp', { provider: 'paypal', price: 'pr_fx_diamond_m', amount: 997 }),
      sub('s_next', { price: 'pr_fx_next_level' }),
      sub('s_weird', { status: 'Pending_Review_X' }),
      { ...sub('s_nocontact'), contactId: undefined },
      sub('s_cancelled', { status: 'canceled' }),
      sub('s_manual', { provider: 'manual' }),
      sub('s_who', { provider: 'bank-of-nowhere' }),
      sub('s_multi_a', { contact: 'gc_multi' }),
      sub('s_multi_b', { contact: 'gc_multi', price: 'pr_fx_diamond_y', interval: 'year', amount: 9997 }),
    ],
    transactions: [
      tx('sub_s_silver_m', '2026-09-10T00:00:00Z'), tx('sub_s_silver_m', '2026-10-10T00:00:00Z'),
      tx('sub_s_silver_m', '2026-10-20T00:00:00Z', { amountRefunded: 97 }),      // fully refunded: not a payment
      tx('sub_s_silver_m', '2026-10-22T00:00:00Z', { status: 'failed' }),
      tx('I-s_silver_y', '2026-03-01T00:00:00Z'),
      tx('I-s_diamond_pp', '2026-03-05T00:00:00Z'),
      tx('s_manual', '2026-10-01T00:00:00Z'), tx('sub_s_who', '2026-10-01T00:00:00Z'),
      tx('sub_s_multi_a', '2026-10-15T00:00:00Z'), tx('sub_s_multi_b', '2026-05-01T00:00:00Z'),
      tx('sub_s_weird', '2026-10-15T00:00:00Z'), tx('sub_s_next', '2026-10-15T00:00:00Z'), tx('sub_s_nocontact', '2026-10-15T00:00:00Z'),
    ],
  });
  try {
    const linked = (await resolveOrCreatePerson(pool, { platform: 'ghl', kind: 'contact', externalId: 'gc_linked' })).personId;
    const r = await syncLegacyMemberships({ pool, reader: readerFor(srv), billing: BILLING, now: NOW });
    assert.equal(r.complete, true);
    assert.equal(r.written, 11);
    assert.ok(srv.requests.every((x) => x.method === 'GET'), 'GET only');
    assert.ok(srv.requests.every((x) => x.query.get('altType') === 'location' && x.query.get('altId') === 'loc_fixture'));
    const m = await rows(pool);

    const s = m.s_silver_m;
    assert.deepEqual([s.tier, s.mapping, s.payment_provider, s.amount_cents, s.currency, s.billing_interval], ['silver', 'mapped', 'stripe', 9700, 'USD', 'month']);
    assert.equal(s.last_payment_at.toISOString(), '2026-10-10T00:00:00.000Z', 'newest SUCCESSFUL, not refunded, not failed');
    assert.equal(s.paid_through_estimate.toISOString(), '2026-11-10T00:00:00.000Z');
    assert.equal(s.person_id, linked, 'linked through person_identities (ghl, contact)');
    assert.deepEqual([s.stale_suspected, s.review_state, s.review_reasons], [false, 'none', []]);
    assert.equal(s.last_seen_at.toISOString(), NOW.toISOString(), 'last_seen_at = pass time');

    assert.deepEqual([m.s_silver_y.payment_provider, m.s_silver_y.billing_interval, m.s_silver_y.paid_through_estimate.toISOString().slice(0, 10), m.s_silver_y.review_state], ['paypal', 'year', '2027-03-01', 'none']);
    assert.equal(m.s_silver_y.person_id, null, 'unknown contact -> no person, not a review reason by itself');

    const d = m.s_diamond_pp;
    assert.deepEqual([d.reported_status, d.stale_suspected, d.review_state, d.review_reasons], ['active', true, 'needs_review', ['paypal_no_recent_payment', 'stale_suspected']]);

    assert.deepEqual([m.s_next.mapping, m.s_next.tier, m.s_next.review_reasons], ['unmapped', null, ['unmapped_price']]);
    assert.deepEqual([m.s_weird.reported_status, m.s_weird.review_reasons], ['Pending_Review_X', ['unknown_status']]);
    assert.deepEqual([m.s_nocontact.external_contact_id, m.s_nocontact.review_reasons], [null, ['missing_contact']]);
    assert.deepEqual([m.s_cancelled.reported_status, m.s_cancelled.review_state, m.s_cancelled.stale_suspected], ['canceled', 'none', false]);
    assert.deepEqual([m.s_manual.payment_provider, m.s_manual.review_state], ['manual', 'none']);
    assert.deepEqual([m.s_who.payment_provider, m.s_who.review_reasons], ['unknown', ['unknown_provider']]);
    assert.deepEqual(m.s_multi_a.review_reasons, ['multiple_live_legacy']);
    assert.deepEqual(m.s_multi_b.review_reasons, ['multiple_live_legacy']);
    for (const row of Object.values(m)) if (row.review_state === 'needs_review') assert.ok(row.review_reasons.length > 0, 'every review item says why');

    const run = (await pool.query('SELECT * FROM legacy_reader_runs')).rows;
    assert.deepEqual([run.length, run[0].complete, run[0].subscriptions_seen], [1, true, 11]);
  } finally { await srv.close(); await pool.end(); }
});

test('ambiguous price ids are review items, never a tier', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhlPayments({ subscriptions: [sub('s_amb', { price: 'pr_fx_shared' })], transactions: [tx('sub_s_amb', '2026-10-20T00:00:00Z')] });
  try {
    await syncLegacyMemberships({ pool, reader: readerFor(srv), billing: { gold: { monthlyPriceId: 'pr_fx_shared' }, diamond: { annualPriceId: 'pr_fx_shared' } }, now: NOW });
    const r = (await rows(pool)).s_amb;
    assert.deepEqual([r.mapping, r.tier, r.review_state, r.review_reasons], ['ambiguous', null, 'needs_review', ['ambiguous_price']]);
  } finally { await srv.close(); await pool.end(); }
});

test('stale detection NEVER marks anything canceled, inactive or ended and never changes access', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhlPayments({ subscriptions: [sub('s_stale', { contact: 'gc_stale', provider: 'paypal', price: 'pr_fx_diamond_m' })], transactions: [tx('I-s_stale', '2026-03-05T00:00:00Z')] });
  const ghl = await fakeGhl({ contacts: [{ id: 'gc_stale', email: 'stale@example.invalid', tags: ['ahc-diamond-active'] }] });
  try {
    const pid = (await resolveOrCreatePerson(pool, { platform: 'ghl', kind: 'contact', externalId: 'gc_stale' })).personId;
    const before = (await pool.query('SELECT count(*)::int AS n FROM subscriptions')).rows[0].n;
    for (const now of [NOW, new Date('2027-06-01T00:00:00Z')]) {
      await syncLegacyMemberships({ pool, reader: readerFor(srv), billing: BILLING, now });
      const r = (await rows(pool)).s_stale;
      assert.equal(r.stale_suspected, true);
      assert.equal(r.review_state, 'needs_review');
      assert.ok(r.review_reasons.includes('stale_suspected'));
      assert.equal(r.reported_status, 'active', 'status stays what GHL reports');
      assert.deepEqual([r.tier, r.mapping], ['diamond', 'mapped'], 'tier is unchanged');
    }
    const all = JSON.stringify((await pool.query('SELECT * FROM legacy_memberships')).rows);
    assert.doesNotMatch(all, /cancel|inactive|ended|expired/i);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM subscriptions')).rows[0].n, before, 'no Gaia subscription touched');
    assert.ok(srv.requests.every((x) => x.method === 'GET'));

    // access mirror: the stale legacy member keeps gaia-m:legacy:diamond
    const client = createGhlClient({ token: 'ghl-fixture-token', locationId: 'loc_fixture', fetch: fetchVia, baseUrl: ghl.url, sleep: noSleep });
    const s = await syncPersonToGhl({ pool, ghl: client, now: NOW }, pid);
    assert.equal(s.status, 'synced');
    assert.ok(ghl.db.get('gc_stale').tags.includes('gaia-m:legacy:diamond'));
    assert.ok(ghl.db.get('gc_stale').tags.includes('ahc-diamond-active'));
    assert.ok(!ghl.db.get('gc_stale').tags.some((t) => t.startsWith('gaia-m:tier:diamond')), 'never mirrored into tier:*');
  } finally { await srv.close(); await ghl.close(); await pool.end(); }
});

test('contact re-key, disappearing subscriptions, never delete; reviewed rows stay reviewed', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhlPayments({
    subscriptions: [sub('s1', { contact: 'gc_old' }), sub('s2')],
    transactions: [tx('sub_s1', '2026-10-15T00:00:00Z'), tx('sub_s2', '2026-10-15T00:00:00Z')],
  });
  try {
    const T1 = NOW; const T2 = new Date('2026-10-27T12:00:00Z'); const T3 = new Date('2026-10-28T12:00:00Z');
    await syncLegacyMemberships({ pool, reader: readerFor(srv), billing: BILLING, now: T1 });
    srv.state.subscriptions = [sub('s1', { contact: 'gc_new' })];            // a GHL merge re-keyed s1; s2 vanished
    const r2 = await syncLegacyMemberships({ pool, reader: readerFor(srv), billing: BILLING, now: T2 });
    assert.equal(r2.flaggedNotSeen, 1);
    let m = await rows(pool);
    assert.deepEqual([m.s1.external_contact_id, m.s1.review_state, m.s1.review_reasons], ['gc_new', 'needs_review', ['contact_rekeyed']]);
    assert.ok(m.s2, 'never deleted');
    assert.deepEqual([m.s2.reported_status, m.s2.review_reasons, m.s2.last_seen_at.toISOString()], ['active', ['not_seen_in_complete_pass'], T1.toISOString()],
      'status untouched, last_seen_at kept');
    assert.equal(m.s1.last_seen_at.toISOString(), T2.toISOString());

    await syncLegacyMemberships({ pool, reader: readerFor(srv), billing: BILLING, now: T2 });
    assert.deepEqual((await rows(pool)).s1.review_reasons, ['contact_rekeyed'], 'sticky: a re-key is not forgotten on the next pass');

    await markLegacyReviewed(pool, m.s1.id, { by: 'staff-fixture', note: 'merge confirmed' });
    await assert.rejects(markLegacyReviewed(pool, m.s1.id, { by: 'staff-fixture' }), (e) => e.code === 'NOT_FOUND');
    await syncLegacyMemberships({ pool, reader: readerFor(srv), billing: BILLING, now: T3 });
    m = await rows(pool);
    assert.deepEqual([m.s1.review_state, m.s1.review_reasons], ['reviewed', []]);
    await syncLegacyMemberships({ pool, reader: readerFor(srv), billing: BILLING, now: new Date('2026-12-30T00:00:00Z') });
    m = await rows(pool);
    assert.deepEqual([m.s1.review_state, m.s1.review_reasons, m.s1.reported_status], ['needs_review', ['stale_suspected'], 'active'], 'a NEW reason reopens it');
  } finally { await srv.close(); await pool.end(); }
});

test('pagination has a hard page cap; an incomplete pass or an error writes nothing and keeps last_seen_at', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const subs = Array.from({ length: 5 }, (_, i) => sub('p' + i));
  const srv = await fakeGhlPayments({ subscriptions: subs, transactions: subs.map((s) => tx('sub_' + s._id, '2026-10-20T00:00:00Z')) });
  try {
    const T2 = new Date('2026-10-27T12:00:00Z');
    const ok = await syncLegacyMemberships({ pool, reader: readerFor(srv, { pageSize: 2, maxPages: 3 }), billing: BILLING, now: NOW });
    assert.deepEqual([ok.complete, ok.written], [true, 5]);
    assert.equal(srv.requests.filter((x) => x.path === '/payments/subscriptions').length, 3);

    srv.state.subscriptions = subs.slice(0, 4);                      // one disappears, but the next pass is capped
    srv.requests.length = 0;
    const capped = await syncLegacyMemberships({ pool, reader: readerFor(srv, { pageSize: 1, maxPages: 2 }), billing: BILLING, now: T2 });
    assert.deepEqual([capped.complete, capped.reason, capped.written], [false, 'page_cap', 0]);
    assert.equal(srv.requests.length, 2, 'stopped at the cap, transactions not even read');
    const fresh = (await pool.query('SELECT max(last_seen_at) AS t, count(*) FILTER (WHERE review_state <> $1)::int AS flagged FROM legacy_memberships', ['none'])).rows[0];
    assert.equal(fresh.t.toISOString(), NOW.toISOString(), 'incomplete pass does not bump freshness');
    assert.equal(fresh.flagged, 0, 'and flags nothing as not seen');

    for (let i = 0; i < 4; i++) srv.faults.push({ status: 503, json: {} });
    const failed = await syncLegacyMemberships({ pool, reader: readerFor(srv, { retry: { maxRetries: 3 } }), billing: BILLING, now: T2 });
    assert.deepEqual([failed.complete, failed.errorCode], [false, 'PROVIDER_UNAVAILABLE']);
    assert.equal((await pool.query('SELECT max(last_seen_at) AS t FROM legacy_memberships')).rows[0].t.toISOString(), NOW.toISOString());
    const runs = (await pool.query('SELECT complete, error_code FROM legacy_reader_runs ORDER BY finished_at')).rows;
    assert.deepEqual(runs.map((r) => [r.complete, r.error_code]), [[true, null], [false, null], [false, 'PROVIDER_UNAVAILABLE']]);
    await assert.rejects(pool.query('DELETE FROM legacy_reader_runs'), /append-only/);
    assert.throws(() => readerFor(srv, { maxPages: 1000 }), /maxPages/);
  } finally { await srv.close(); await pool.end(); }
});

test('read-only legacy report: counts by tier, provider and status; review list; stale suspects; freshness', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhlPayments({
    subscriptions: [sub('r1'), sub('r2', { provider: 'paypal', price: 'pr_fx_diamond_m' }), sub('r3', { price: 'pr_fx_next_level' }), sub('r4', { status: 'canceled' })],
    transactions: [tx('sub_r1', '2026-10-20T00:00:00Z'), tx('sub_r3', '2026-10-20T00:00:00Z')],
  });
  try {
    await syncLegacyMemberships({ pool, reader: readerFor(srv), billing: BILLING, now: NOW });
    const before = JSON.stringify((await pool.query('SELECT * FROM legacy_memberships ORDER BY id')).rows);
    const rep = await legacyReport(pool, { now: NOW });
    assert.equal(rep.total, 4);
    assert.deepEqual(rep.byTier, { '(none)': 1, diamond: 1, silver: 2 });
    assert.deepEqual(rep.byProvider, { paypal: 1, stripe: 3 });
    assert.deepEqual(rep.byStatus, { active: 3, canceled: 1 });
    assert.deepEqual(rep.byMapping, { mapped: 3, unmapped: 1 });
    assert.deepEqual(rep.review.map((r) => r.external_subscription_id).sort(), ['r2', 'r3']);
    assert.deepEqual(rep.stale.map((r) => r.external_subscription_id), ['r2']);
    assert.equal(rep.freshness.lastSeenAt.toISOString(), NOW.toISOString());
    assert.ok(rep.freshness.lastCompleteRunAt);
    assert.equal(JSON.stringify((await pool.query('SELECT * FROM legacy_memberships ORDER BY id')).rows), before, 'report writes nothing');
  } finally { await srv.close(); await pool.end(); }
});

test('config drift check: configured price ids that GHL no longer lists are reported', async () => {
  const srv = await fakeGhlPayments({ prices: {
    prod_fx_silver: [{ _id: 'pr_fx_silver_m' }, { _id: 'pr_fx_silver_y' }],
    prod_fx_gold: [{ _id: 'pr_fx_gold_m' }],
    prod_fx_diamond: [{ _id: 'pr_fx_diamond_m' }, { _id: 'pr_fx_diamond_y' }],
  } });
  try {
    const r = await checkLegacyConfig(readerFor(srv), BILLING);
    assert.deepEqual(r, { checked: 6, missing: [{ tier: 'gold', field: 'annualPriceId', priceId: 'pr_fx_gold_y' }] });
    assert.ok(srv.requests.every((x) => x.method === 'GET' && /^\/products\/prod_fx_[a-z]+\/price$/.test(x.path)));
  } finally { await srv.close(); }
});
