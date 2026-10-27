/**
 * Control Center Phase 3 owner decisions (docs/membership/CONTROL-CENTER.md §1):
 * goodwill bucket, first-sign-in password change, explicit execute / retry,
 * reasons on every audit row, names instead of ids, environment / money source.
 * Real internal API on loopback, real Postgres; Stripe is a switchable stub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SKIP } from './_db.js';
import { adminStack, fixturePerson, PASSWORD, codeAt, secretOf } from './_admin.js';
import { createOperator, resetOperatorPassword } from '../src/operators.js';
import { creditGoodwill, creditPurchase, grantAllowance, debitNow, clawbackPurchased, walletView, SPEND_ORDER } from '../src/coins.js';
import { MembershipError } from '../src/errors.js';
import { createApiServer } from '../src/api/server.js';

const NOTE = 'checked against the ticket';
const here = path.dirname(fileURLToPath(import.meta.url));

/** A Stripe stub that is "not connected" until switched on; counts every call. */
function switchableStripe() {
  const st = { connected: false, calls: [] };
  const gate = () => { if (!st.connected) throw new MembershipError('PROVIDER_UNAVAILABLE', 'billing is not connected in this environment'); };
  st.client = { livemode: false,
    async get(p) { gate(); st.calls.push(['GET', p]); return {}; },
    async post(p, params, { idempotencyKey } = {}) { gate(); st.calls.push(['POST', p, params, idempotencyKey]); return { id: 're_fixture' + st.calls.length, status: 'succeeded', amount: params.amount, currency: 'usd', livemode: false }; },
    async del(p) { gate(); st.calls.push(['DELETE', p]); return { id: 'sub_x', status: 'canceled', livemode: false }; } };
  return st;
}
const chargeRow = async (pool, pid, id = 'ch_fixture_p3') => (await pool.query(`INSERT INTO payment_ledger (person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, occurred_at)
  VALUES ($1, 'stripe', 'charge', $2, 'charge', 4700, 'USD', now()) RETURNING id`, [pid, id])).rows[0].id;

test('goodwill is its own bucket: never clawed back by a refund, spent after granted and before purchased, shown separately', { skip: SKIP }, async () => {
  const s = await adminStack({ operators: { support: 'support', viewer: 'viewer' } });
  try {
    await s.signIn('support', 'viewer');
    assert.deepEqual(SPEND_ORDER, ['granted', 'goodwill', 'purchased', 'legacy']);
    const pid = await fixturePerson(s.pool);
    assert.equal((await s.as('support').act('coins.credit', { personId: pid, coins: 200 })).json.status, 'executed');
    await creditPurchase(s.pool, { personId: pid, coins: 300, idempotencyKey: 'pay-p3-0001', paymentRef: 'ch_fixture_pack' });
    // A refund of the pack takes back purchased coins only; the goodwill credit stays.
    const cb = await clawbackPurchased(s.pool, { personId: pid, coins: 500, idempotencyKey: 'clawback-p3-0001', relatedId: 're_fixture_pack' });
    assert.deepEqual([cb.clawedBack, cb.shortfall], [300, 200]);
    let w = await walletView(s.pool, pid);
    assert.deepEqual([w.goodwill.coins, w.purchased.coins, w.total.coins], [200, 0, 200]);
    // Spend order: granted -> goodwill -> purchased.
    await grantAllowance(s.pool, { personId: pid, coins: 50, cycleKey: 'p3:c1' });
    await creditPurchase(s.pool, { personId: pid, coins: 100, idempotencyKey: 'pay-p3-0002', paymentRef: 'ch_fixture_pack2' });
    const d = await debitNow(s.pool, { personId: pid, coins: 260, idempotencyKey: 'job-p3-0001', reason: 'ai_report' });
    assert.deepEqual(d.split, { granted: 50, goodwill: 200, purchased: 10 });
    // Goodwill never expires: an allowance reset or lapse touches granted only.
    assert.equal((await s.as('support').act('coins.credit', { personId: pid, coins: 40 })).json.status, 'executed');
    await grantAllowance(s.pool, { personId: pid, coins: 50, cycleKey: 'p3:c2', resetAt: new Date('2027-01-01') });
    w = await walletView(s.pool, pid);
    assert.deepEqual([w.granted.coins, w.goodwill.coins, w.purchased.coins], [50, 40, 90]);
    assert.deepEqual(w.spendOrder, ['granted', 'goodwill', 'purchased', 'legacy']);
    assert.deepEqual((await s.pool.query('SELECT * FROM membership.wallet_mismatches()')).rows, []);
    const detail = (await s.as('viewer').get(`/v1/admin/persons/${pid}`)).json;
    assert.equal(detail.wallet.goodwill.coins, 40);
    assert.equal((await s.as('viewer').get('/v1/admin/coins')).json.totals.goodwill, 40);
    assert.equal((await s.as('viewer').get('/v1/admin/overview')).json.coinsOutstanding, 180);
    await assert.rejects(creditGoodwill(s.pool, { personId: pid, coins: 10001, idempotencyKey: 'x-goodwill-01', requestRef: 'r', actor: 'a' }), /at most/);
  } finally { await s.close(); }
});

test('the 500-coin support limit holds exactly at the boundary', { skip: SKIP }, async () => {
  const s = await adminStack({ operators: { support: 'support' } });
  try {
    await s.signIn('support');
    const pid = await fixturePerson(s.pool);
    assert.equal((await s.as('support').act('coins.credit', { personId: pid, coins: 500 })).json.status, 'executed');
    const over = await s.as('support').act('coins.credit', { personId: pid, coins: 501 });
    assert.deepEqual([over.status, over.json.requiredRole], [403, 'finance']);
  } finally { await s.close(); }
});

test('initial password must be changed: restricted session until POST /v1/admin/password succeeds', { skip: SKIP }, async () => {
  const s = await adminStack({ operators: {} });
  try {
    const created = await createOperator(s.pool, { email: 'new.fixture@example.invalid', displayName: 'New Fixture', role: 'finance' }, 'test-owner', { env: s.env });
    assert.equal(created.password.length >= 12, true);
    s.ops.newop = { id: created.id, email: created.email, secret: secretOf(created.otpauthUri) };
    const login = await s.call('POST', '/v1/admin/login', { body: { email: created.email, password: created.password, totp: codeAt(s.ops.newop.secret, s.clock.t) } });
    assert.deepEqual([login.status, login.json.operator.mustChangePassword], [200, true]);
    const sess = login.json.session;
    const get = (p) => s.call('GET', p, { session: sess });
    const post = (p, body) => s.call('POST', p, { session: sess, body });
    const me = await get('/v1/admin/me');
    assert.deepEqual([me.status, me.json.mustChangePassword, me.json.permissions], [200, true, []]);
    for (const p of ['/v1/admin/overview', '/v1/admin/persons', '/v1/admin/requests', '/v1/admin/audit']) {
      const r = await get(p);
      assert.deepEqual([r.status, r.json.reason], [403, 'password_change_required'], p);
    }
    const w = await post('/v1/admin/actions', { action: 'coins.credit', params: { personId: crypto.randomUUID(), coins: 5 }, reason: 'should never run at all', requestId: 'restricted-0001' });
    assert.deepEqual([w.status, w.json.reason], [403, 'password_change_required']);
    // Rules: 12+ characters, different from the current one, the current one must be right.
    assert.equal((await post('/v1/admin/password', { currentPassword: created.password, newPassword: 'short-pass' })).json.code, 'INVALID_INPUT');
    assert.equal((await post('/v1/admin/password', { currentPassword: created.password, newPassword: created.password })).json.code, 'INVALID_INPUT');
    assert.equal((await post('/v1/admin/password', { currentPassword: 'wrong-current-pass', newPassword: 'a-brand-new-passphrase' })).json.code, 'INVALID_INPUT');
    // A second session of the same operator is revoked by the change.
    s.advance(31 * 1000);
    const other = await s.call('POST', '/v1/admin/login', { body: { email: created.email, password: created.password, totp: codeAt(s.ops.newop.secret, s.clock.t) } });
    assert.equal(other.status, 200);
    const ok = await post('/v1/admin/password', { currentPassword: created.password, newPassword: 'a-brand-new-passphrase' });
    assert.deepEqual([ok.status, ok.json.changed], [200, true]);
    assert.equal((await s.call('GET', '/v1/admin/me', { session: other.json.session })).status, 401, 'other sessions revoked');
    const after = await get('/v1/admin/me');
    assert.deepEqual([after.json.mustChangePassword, after.json.permissions.includes('payment.refund')], [false, true]);
    assert.equal((await get('/v1/admin/overview')).status, 200);
    const row = (await s.pool.query('SELECT password_scrypt, must_change_password, password_changed_at FROM operators WHERE id = $1', [created.id])).rows[0];
    assert.ok(row.password_scrypt.startsWith('scrypt$') && !row.password_scrypt.includes('a-brand-new'));
    assert.deepEqual([row.must_change_password, row.password_changed_at !== null], [false, true]);
    s.advance(31 * 1000);
    assert.equal((await s.call('POST', '/v1/admin/login', { body: { email: created.email, password: created.password, totp: codeAt(s.ops.newop.secret, s.clock.t) } })).status, 401, 'the old password is gone');
    // A CLI reset sets the flag again and signs the operator out.
    const reset = await resetOperatorPassword(s.pool, created.email, 'test-owner');
    assert.equal((await get('/v1/admin/me')).status, 401);
    s.advance(31 * 1000);
    const again = await s.call('POST', '/v1/admin/login', { body: { email: created.email, password: reset.password, totp: codeAt(s.ops.newop.secret, s.clock.t) } });
    assert.deepEqual([again.status, again.json.operator.mustChangePassword], [200, true]);
    const actions = (await s.pool.query("SELECT action FROM audit_logs WHERE entity_type = 'operator' AND entity_id = $1 ORDER BY id", [created.id])).rows.map((r) => r.action);
    for (const a of ['operator.create', 'operator.password_change_failed', 'operator.password_change', 'operator.reset_password']) assert.ok(actions.includes(a), a);
  } finally { await s.close(); }
});

test('execute / retry: approve is not execute; explicit retry only; replay returns the first result; executed is final (409); no background retry', { skip: SKIP }, async () => {
  const stripe = switchableStripe();
  const s = await adminStack({ stripe: stripe.client, operators: { support: 'support', finance: 'finance', finance2: 'finance', finance3: 'finance', owner: 'owner' } });
  try {
    await s.signIn('support', 'finance', 'finance2', 'finance3', 'owner');
    const pid = await fixturePerson(s.pool, 'refund.fixture@example.invalid');
    const ledger = await chargeRow(s.pool, pid);
    const id = (await s.as('finance').act('payment.refund', { ledgerId: ledger, amountCents: 1200 }, { reason: 'duplicate charge on 25 Oct' })).json.request.id;
    const ap = await s.as('finance2').post(`/v1/admin/requests/${id}/approve`, { note: NOTE });
    // Approve != execute: the approval is recorded, the execution is a separate attempt that did not run.
    assert.deepEqual([ap.json.status, ap.json.request.decidedBy.id, ap.json.request.executedAt, ap.json.request.money], ['approved_not_executed', s.ops.finance2.id, null, 'not_executed']);
    assert.equal(stripe.calls.length, 0, 'nothing reached Stripe');
    let attempts = (await s.pool.query('SELECT attempt_no, kind, outcome FROM admin_action_attempts WHERE request_id = $1 ORDER BY attempt_no', [id])).rows;
    assert.deepEqual(attempts, [{ attempt_no: 1, kind: 'initial', outcome: 'not_executed' }]);
    // No background retry: time passes, a new API process starts, reads happen; nothing re-executes.
    stripe.connected = true;
    s.advance(24 * 3600 * 1000);
    const api2 = createApiServer(s.pool, { env: s.env, stripe: stripe.client, clock: () => s.clock.t });
    await new Promise((r) => api2.listen(0, '127.0.0.1', r));
    await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => api2.close(r));
    await s.signIn('support', 'finance', 'finance2', 'finance3', 'owner');
    assert.equal((await s.as('finance2').get('/v1/admin/requests?status=retryable')).json.items.length, 1);
    assert.equal(stripe.calls.length, 0, 'no timer, no start-up hook, no read path executes a request');
    assert.equal((await s.pool.query('SELECT count(*)::int n FROM admin_action_attempts WHERE request_id = $1', [id])).rows[0].n, 1);
    for (const f of ['src/admin-actions.js', 'src/api/server.js', 'src/api/admin-routes.js']) {
      const src = fs.readFileSync(path.join(here, '..', f), 'utf8');
      assert.doesNotMatch(src, /setInterval|setTimeout\([^)]*execute/, f + ' has no timer that could execute a request');
    }
    // Who may execute: finance or above, never the requester of a dual request, a reason and a requestId are required.
    const ex = (who, body) => s.as(who).post(`/v1/admin/requests/${id}/execute`, body);
    assert.deepEqual([(await ex('support', { reason: 'retry now billing is on', requestId: 'exec-sup-0001' })).json.requiredRole], ['finance']);
    const own = await ex('finance', { reason: 'retry now billing is on', requestId: 'exec-own-0001' });
    assert.deepEqual([own.status, own.json.code], [403, 'FORBIDDEN'], 'the requester cannot execute their own dual request');
    assert.equal((await ex('finance2', { reason: 'short', requestId: 'exec-f2-00001' })).json.code, 'INVALID_INPUT');
    assert.equal((await ex('finance2', { reason: 'retry now billing is on' })).json.code, 'INVALID_INPUT');
    assert.equal(stripe.calls.length, 0);
    const r1 = await ex('finance2', { reason: 'retry now billing is on', requestId: 'exec-f2-00002' });
    assert.deepEqual([r1.status, r1.json.status, r1.json.attempt.attemptNo, r1.json.request.money], [200, 'executed', 2, 'stripe_confirmed']);
    assert.equal(stripe.calls.filter((c) => c[0] === 'POST').length, 1);
    assert.equal(stripe.calls[0][3], `gaia-admin-refund-${id}`, 'every attempt uses the same Stripe idempotency key, so Stripe itself can never refund twice');
    const r2 = await ex('finance2', { reason: 'retry now billing is on', requestId: 'exec-f2-00002' });
    assert.deepEqual([r2.json.status, r2.json.replayed, r2.json.result], ['executed', true, r1.json.result], 'replay returns the first result');
    assert.equal((await ex('finance2', { reason: 'a different reason here', requestId: 'exec-f2-00002' })).json.code, 'CONFLICT');
    const again = await ex('finance3', { reason: 'second execute attempt', requestId: 'exec-f3-00001' });
    assert.deepEqual([again.status, again.json.code], [409, 'CONFLICT'], 'an executed request never executes again');
    assert.equal(stripe.calls.filter((c) => c[0] === 'POST').length, 1);
    attempts = (await s.pool.query('SELECT attempt_no, kind, outcome, reason FROM admin_action_attempts WHERE request_id = $1 ORDER BY attempt_no', [id])).rows;
    assert.deepEqual(attempts.map((a) => [a.attempt_no, a.kind, a.outcome]), [[1, 'initial', 'not_executed'], [2, 'retry', 'executed']]);
    // The database refuses a second executed attempt and any change to a finished one.
    await assert.rejects(s.pool.query(`INSERT INTO admin_action_attempts (request_id, attempt_no, kind, attempt_key, executed_by, reason, outcome, result, started_at, finished_at)
      VALUES ($1, 3, 'retry', 'manual-key-0001', $2, 'forced second execution', 'executed', '{}', now(), now())`, [id, s.ops.owner.id]), /duplicate key/);
    await assert.rejects(s.pool.query("UPDATE admin_action_attempts SET outcome = 'failed' WHERE request_id = $1 AND attempt_no = 2", [id]), /finished once/);
    await assert.rejects(s.pool.query('DELETE FROM admin_action_attempts WHERE request_id = $1', [id]), /append-only/);
    // Approval, execution and the retry are separate audited states, each with its reason.
    const trail = (await s.pool.query("SELECT action, reason FROM audit_logs WHERE entity_type = 'admin_action_request' AND entity_id = $1 AND action <> 'admin.denied' ORDER BY id", [id])).rows;
    assert.deepEqual(trail.map((t) => t.action), ['admin.request.create', 'admin.request.approve', 'admin.action.not_executed', 'admin.request.execute', 'admin.action.executed']);
    assert.deepEqual(trail.map((t) => t.reason), ['duplicate charge on 25 Oct', NOTE, 'duplicate charge on 25 Oct', 'retry now billing is on', 'retry now billing is on']);
    // A failed execution can be retried too; it stays failed and is recorded as attempt 2.
    const exReq = (await s.as('finance').act('migration.authorize_exception', { offerId: crypto.randomUUID() }, { reason: 'owner agreed by phone' })).json.request.id;
    assert.equal((await s.as('owner').post(`/v1/admin/requests/${exReq}/approve`, { note: NOTE })).json.status, 'failed');
    const fr = await s.as('owner').post(`/v1/admin/requests/${exReq}/execute`, { reason: 'retry after the data fix', requestId: 'exec-own-ex-01' });
    assert.deepEqual([fr.json.status, fr.json.attempt.attemptNo, fr.json.result.code], ['failed', 2, 'NOT_FOUND']);
    assert.equal((await s.as('finance2').post(`/v1/admin/requests/${exReq}/execute`, { reason: 'retry after the data fix', requestId: 'exec-f2-ex-01' })).json.requiredRole, 'owner', 'the approver role still applies');
    // Pending, rejected and cancelled requests are never executable.
    const pend = (await s.as('finance').act('payment.refund', { ledgerId: ledger, amountCents: 100 })).json.request.id;
    assert.equal((await s.as('finance2').post(`/v1/admin/requests/${pend}/execute`, { reason: 'skip the approval please', requestId: 'exec-pend-001' })).json.code, 'CONFLICT');
    assert.equal(stripe.calls.filter((c) => c[0] === 'POST').length, 1);
  } finally { await s.close(); }
});

test('retries close 72 hours after the approval: refused, audited, and the request stays not executed', { skip: SKIP }, async () => {
  const stripe = switchableStripe();
  const s = await adminStack({ stripe: stripe.client, operators: { finance: 'finance', finance2: 'finance', finance3: 'finance' } });
  try {
    await s.signIn('finance', 'finance2', 'finance3');
    const pid = await fixturePerson(s.pool, 'retry.window@example.invalid');
    const ledger = await chargeRow(s.pool, pid);
    const id = (await s.as('finance').act('payment.refund', { ledgerId: ledger, amountCents: 500 }, { reason: 'duplicate charge on 26 Oct' })).json.request.id;
    const ap = await s.as('finance2').post(`/v1/admin/requests/${id}/approve`, { note: NOTE });
    assert.equal(ap.json.status, 'approved_not_executed');
    const until = new Date(ap.json.request.retryUntil);
    assert.equal(until.getTime() - new Date(ap.json.request.decidedAt).getTime(), 72 * 3600 * 1000, 'the window is 72 h from the approval');
    stripe.connected = true;
    s.advance(72 * 3600 * 1000 + 1000);
    await s.signIn('finance3');
    const view = (await s.as('finance3').get('/v1/admin/requests?status=retryable')).json.items.find((x) => x.id === id);
    assert.equal(view?.canExecute ?? false, false, 'the UI no longer offers Execute again');
    const late = await s.as('finance3').post(`/v1/admin/requests/${id}/execute`, { reason: 'billing is connected now', requestId: 'exec-late-0001' });
    assert.deepEqual([late.status, late.json.code], [409, 'CONFLICT']);
    assert.match(late.json.message, /72-hour retry window closed/);
    assert.equal(stripe.calls.length, 0, 'nothing reached Stripe');
    const attempts = (await s.pool.query('SELECT attempt_no, outcome FROM admin_action_attempts WHERE request_id = $1 ORDER BY attempt_no', [id])).rows;
    assert.deepEqual(attempts, [{ attempt_no: 1, outcome: 'not_executed' }], 'no new attempt was recorded');
    const denied = (await s.pool.query("SELECT reason, after FROM audit_logs WHERE entity_id = $1 AND action = 'admin.denied' ORDER BY id DESC LIMIT 1", [id])).rows[0];
    assert.deepEqual([denied.reason, denied.after.why], ['billing is connected now', 'retry_window_closed']);
  } finally { await s.close(); }
});

test('every admin audit row carries its reason; read models name people and operators; environment and money source', { skip: SKIP }, async () => {
  const s = await adminStack({ operators: { support: 'support', finance: 'finance', finance2: 'finance', owner: 'owner', owner2: 'owner' } });
  s.env.MEMBERSHIP_ENV = 'staging';
  try {
    await s.signIn('support', 'finance', 'finance2', 'owner', 'owner2');
    const pid = await fixturePerson(s.pool, 'named.fixture@example.invalid');
    await s.as('support').act('note.add', { personId: pid, body: 'Member called about the outage.' }, { reason: '' });
    await s.as('support').act('coins.credit', { personId: pid, coins: 50 }, { reason: 'outage goodwill credit' });
    await s.as('owner').act('pilot.add', { personId: pid }, { reason: 'internal pilot tester' });
    await s.as('owner').act('launch.set', { stage: 'INTERNAL_PILOT' }, { reason: 'open the internal pilot' });
    const big = (await s.as('finance').act('coins.credit', { personId: pid, coins: 900 }, { reason: 'migration courtesy credit' })).json.request.id;
    await s.as('finance2').post(`/v1/admin/requests/${big}/reject`, { note: 'not agreed with finance' });
    const big2 = (await s.as('finance').act('coins.credit', { personId: pid, coins: 900 }, { reason: 'migration courtesy credit' })).json.request.id;
    await s.as('finance2').post(`/v1/admin/requests/${big2}/approve`, { note: NOTE });
    const pilot2 = await fixturePerson(s.pool, 'pilot2.fixture@example.invalid');
    await s.as('owner').act('pilot.add', { personId: pilot2 }, { reason: 'second pilot tester' });
    await s.as('owner').act('pilot.remove', { personId: pilot2 }, { reason: 'left the pilot early' });
    const missing = (await s.pool.query(`SELECT action FROM audit_logs WHERE actor_id LIKE 'operator:%' AND action NOT IN ('operator.login', 'operator.logout') AND reason IS NULL`)).rows;
    assert.deepEqual(missing, [], 'no admin audit row without a reason');
    const domain = (await s.pool.query("SELECT action, reason FROM audit_logs WHERE action IN ('coins.adjustment', 'launch.pilot_add', 'launch.pilot_remove', 'launch.stage') ORDER BY id")).rows;
    assert.deepEqual(domain.map((d) => [d.action, d.reason]), [['coins.adjustment', 'outage goodwill credit'], ['launch.pilot_add', 'internal pilot tester'], ['launch.stage', 'open the internal pilot'],
      ['coins.adjustment', 'migration courtesy credit'], ['launch.pilot_add', 'second pilot tester'], ['launch.pilot_remove', 'left the pilot early']]);
    const audit = (await s.as('support').get('/v1/admin/audit?limit=200')).json.items;
    const rej = audit.find((a) => a.action === 'admin.request.reject');
    assert.deepEqual([rej.reason, rej.actor_name], ['not agreed with finance', 'finance2 fixture']);
    assert.equal(audit.find((a) => a.action === 'launch.pilot_add' && a.entity_id === pid).entity_label, 'named.fixture@example.invalid');
    // Names instead of ids.
    const reqs = (await s.as('support').get('/v1/admin/requests')).json.items;
    const emailOf = { [pid]: 'named.fixture@example.invalid', [pilot2]: 'pilot2.fixture@example.invalid' };
    for (const r of reqs) {
      assert.ok(r.requestedBy.displayName, 'requester named');
      if (r.action === 'launch.set') assert.equal(r.subject, null, 'a launch change is about no member');
      else assert.equal(r.subject.email, emailOf[r.params.personId], r.action);
    }
    const executed = reqs.find((r) => r.id === big2);
    assert.deepEqual([executed.decidedBy.displayName, executed.attempts, executed.lastAttempt.executedBy.displayName], ['finance2 fixture', 1, 'finance2 fixture']);
    const launch = (await s.as('support').get('/v1/admin/launch')).json;
    assert.equal(launch.history[0].changed_by_name, 'owner fixture');
    assert.deepEqual([launch.pilots[0].person_email, launch.pilots[0].added_by_name], ['named.fixture@example.invalid', 'owner fixture']);
    const detail = (await s.as('support').get(`/v1/admin/persons/${pid}`)).json;
    assert.equal(detail.notes[0].operator_name, 'support fixture');
    assert.ok(detail.audit.every((a) => 'reason' in a));
    // Environment and Stripe mode come from the server.
    assert.deepEqual((await s.call('GET', '/v1/admin/environment')).json, { ok: true, environment: 'staging', stripeMode: 'none' });
    const h = (await s.as('support').get('/v1/admin/health')).json;
    assert.deepEqual([h.environment, h.stripeMode], ['staging', 'none']);
    // Money source from the record: a fixture row vs a row written from a verified Stripe webhook.
    await chargeRow(s.pool, pid, 'ch_fixture_nowebhook');
    const ev = (await s.pool.query(`INSERT INTO webhook_events (provider, event_id, event_type, payload, payload_sha256, status) VALUES ('stripe', 'evt_fixture_p3', 'invoice.paid', '{}', $1, 'processed') RETURNING id`,
      [crypto.createHash('sha256').update('{}').digest('hex')])).rows[0].id;
    await s.pool.query(`INSERT INTO payment_ledger (person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, webhook_event_id, occurred_at)
      VALUES ($1, 'stripe', 'invoice', 'in_fixture_hook', 'charge', 4700, 'USD', $2, now())`, [pid, ev]);
    const pays = (await s.as('support').get('/v1/admin/payments')).json.items;
    assert.deepEqual(Object.fromEntries(pays.map((p) => [p.provider_object_id, p.source])), { in_fixture_hook: 'stripe_confirmed', ch_fixture_nowebhook: 'test_fixture' });
    assert.ok(pays.every((p) => p.person_email === 'named.fixture@example.invalid'));
    await creditPurchase(s.pool, { personId: pid, coins: 10, idempotencyKey: 'pay-p3-src-01', paymentRef: 'ch_fixture_nowebhook' });
    const coins = (await s.as('support').get('/v1/admin/coins')).json.items;
    assert.equal(coins.find((c) => c.kind === 'purchase').source, 'test_fixture');
    assert.equal(coins.find((c) => c.kind === 'adjustment').source, null, 'goodwill is not money');
    assert.equal(coins.find((c) => c.kind === 'adjustment' && Number(c.delta_coins) === 50).actor_name, 'support fixture');
    assert.equal(coins.find((c) => c.kind === 'adjustment' && Number(c.delta_coins) === 900).actor_name, 'finance2 fixture', 'a dual credit is booked by its approver');
  } finally { await s.close(); }
});

test('login: the session of an operator who must change the password is still fully audited and rate-limited by the account lock', { skip: SKIP }, async () => {
  const s = await adminStack({ operators: {} });
  try {
    const c = await createOperator(s.pool, { email: 'lock.fixture@example.invalid', displayName: 'Lock Fixture', role: 'viewer', password: PASSWORD }, 'test-owner', { env: s.env });
    const secret = secretOf(c.otpauthUri);
    const r = await s.call('POST', '/v1/admin/login', { body: { email: c.email, password: PASSWORD, totp: codeAt(secret, s.clock.t) } });
    for (let i = 0; i < 5; i++) await s.call('POST', '/v1/admin/password', { session: r.json.session, body: { currentPassword: 'wrong-current-' + i, newPassword: 'another-new-passphrase' } });
    assert.equal((await s.call('GET', '/v1/admin/me', { session: r.json.session })).status, 401, 'five wrong current passwords lock the account and end the session');
  } finally { await s.close(); }
});
