/**
 * Control Center backend: operators, sign-in, RBAC, the two-person rule and
 * audit, through the real internal API on loopback and real Postgres.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SKIP } from './_db.js';
import { adminStack, fixturePerson, PASSWORD, codeAt, KEY } from './_admin.js';
import { ACTIONS, permissionsFor } from '../src/admin-actions.js';
import { disableOperator, setOperatorRole, resetOperatorTotp, createOperator, matchTotp, stepOf, totpAt, listOperators, hashPassword, verifyPassword, encryptSecret, decryptSecret } from '../src/operators.js';
import { launchState } from '../src/launch.js';

const HOUR = 3600 * 1000;
const rnd = () => crypto.randomUUID();

test('crypto primitives: RFC 6238 vector, scrypt verify, AES-GCM bound to the operator id', () => {
  // RFC 6238 appendix B, SHA-1, T = 59 s -> 94287082 (8 digits); the 6-digit code is its last 6 digits.
  assert.equal(totpAt(Buffer.from('12345678901234567890'), 1), '287082');
  const h = hashPassword('correct horse battery');
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('correct horse batterY', h));
  const key = Buffer.from(KEY, 'base64'); const id = rnd();
  const enc = encryptSecret(key, id, Buffer.from('s3cret'));
  assert.equal(decryptSecret(key, id, enc).toString(), 's3cret');
  assert.throws(() => decryptSecret(key, rnd(), enc), 'a secret moved to another operator row does not decrypt');
});

test('TOTP window: +-1 step accepted, 2 steps refused, a used step never accepted again', () => {
  const s = crypto.randomBytes(20); const now = new Date('2026-10-26T10:00:10Z'); const st = stepOf(now);
  assert.equal(matchTotp(s, totpAt(s, st - 1), now), st - 1);
  assert.equal(matchTotp(s, totpAt(s, st + 1), now), st + 1);
  assert.equal(matchTotp(s, totpAt(s, st - 2), now), null);
  assert.equal(matchTotp(s, totpAt(s, st), now, st), null, 'replay of the same step');
  assert.equal(matchTotp(s, 'abcdef', now), null);
});

test('sign-in: uniform invalid_login, lockout after 5 failures for 15 min, sessions hashed', { skip: SKIP }, async () => {
  const s = await adminStack({ operators: { support: 'support' } });
  try {
    const bad = await s.call('POST', '/v1/admin/login', { body: { email: 'nobody@example.invalid', password: 'x', totp: '000000' } });
    assert.deepEqual([bad.status, bad.json.code, bad.json.error], [401, 'AUTH_REQUIRED', 'invalid_login']);
    const wrongCode = await s.call('POST', '/v1/admin/login', { body: { email: s.ops.support.email, password: PASSWORD, totp: '000000' } });
    const wrongPass = await s.login('support', { password: 'wrong-password-123' });
    assert.deepEqual(wrongCode.json, bad.json); assert.deepEqual(wrongPass.json, bad.json, 'every failure looks the same');
    for (let i = 0; i < 3; i++) await s.login('support', { password: 'wrong-password-123' });
    const locked = await s.login('support');
    assert.deepEqual(locked.json, bad.json, 'locked: even the right credentials get invalid_login');
    assert.equal((await s.pool.query('SELECT count(*)::int n FROM operator_sessions')).rows[0].n, 0);
    s.advance(16 * 60 * 1000);
    const ok = await s.login('support');
    assert.equal(ok.status, 200);
    assert.match(ok.json.session, /^gop_/);
    assert.deepEqual(Object.keys(ok.json.operator).sort(), ['displayName', 'email', 'id', 'role']);
    const stored = (await s.pool.query('SELECT token_sha256 FROM operator_sessions')).rows;
    assert.equal(stored.length, 1); assert.notEqual(stored[0].token_sha256, ok.json.session);
    assert.equal(stored[0].token_sha256, crypto.createHash('sha256').update(ok.json.session).digest('hex'));
    const replay = await s.call('POST', '/v1/admin/login', { body: { email: s.ops.support.email, password: PASSWORD, totp: codeAt(s.ops.support.secret, s.clock.t) } });
    assert.equal(replay.status, 401, 'the same TOTP code cannot sign in twice');
    const failures = (await s.pool.query("SELECT count(*)::int n FROM audit_logs WHERE action = 'operator.login_failed' AND actor_id = $1", ['operator:' + s.ops.support.id])).rows[0].n;
    assert.ok(failures >= 5);
    const enc = (await s.pool.query('SELECT totp_secret_enc, password_scrypt FROM operators')).rows[0];
    assert.ok(!enc.totp_secret_enc.includes(new URL('otpauth://x?secret=a').search) && enc.totp_secret_enc.startsWith('v1:'));
    assert.ok(enc.password_scrypt.startsWith('scrypt$') && !enc.password_scrypt.includes(PASSWORD));
  } finally { await s.close(); }
});

test('sessions: 30 min idle limit, 8 h absolute limit, logout revokes, disabled operator is signed out', { skip: SKIP }, async () => {
  const s = await adminStack({ operators: { viewer: 'viewer', support: 'support' } });
  try {
    await s.signIn('viewer', 'support');
    const me = await s.as('viewer').get('/v1/admin/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.json.permissions, []);
    assert.equal(new Date(me.json.idleExpiresAt).getTime(), s.clock.t.getTime() + 30 * 60 * 1000);
    for (let i = 0; i < 25; i++) { s.advance(20 * 60 * 1000); if (i < 23) assert.equal((await s.as('viewer').get('/v1/admin/me')).status, 200, 'activity keeps it alive'); }
    assert.equal((await s.as('viewer').get('/v1/admin/me')).status, 401, 'absolute 8 h limit');
    s.advance(60 * 1000);
    await s.signIn('viewer');
    s.advance(31 * 60 * 1000);
    assert.equal((await s.as('viewer').get('/v1/admin/me')).json.code, 'AUTH_REQUIRED', 'idle 30 min');
    s.advance(60 * 1000);
    await s.signIn('viewer', 'support');
    assert.equal((await s.as('viewer').post('/v1/admin/logout')).status, 200);
    assert.equal((await s.as('viewer').get('/v1/admin/me')).status, 401);
    await disableOperator(s.pool, s.ops.support.email, 'owner-cli');
    assert.equal((await s.as('support').get('/v1/admin/me')).status, 401);
    assert.equal((await s.call('GET', '/v1/admin/me')).status, 401, 'no session header');
    s.advance(60 * 1000);
    assert.equal((await s.login('support')).status, 401, 'disabled cannot sign in');
  } finally { await s.close(); }
});

test('the admin routes need an admin:operate client; member clients cannot reach them', { skip: SKIP }, async () => {
  const s = await adminStack({ operators: { viewer: 'viewer' } });
  try {
    const { createClient } = await import('../src/clients.js');
    const { token } = await createClient(s.pool, { name: 'member-proxy', scopes: ['member:read', 'member:write', 'identity:write'] }, 'owner-fixture');
    const r = await fetch(s.base + '/v1/admin/login', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
    await assert.rejects(createClient(s.pool, { name: 'tenant-admin', scopes: ['admin:operate'], practitionerId: rnd() }, 'x'), /read scopes only/);
  } finally { await s.close(); }
});

// One valid-shaped params object per action (ids are random: permission is decided before existence).
const SAMPLE = {
  'note.add': () => ({ personId: rnd(), body: 'a note about the member' }),
  'offer.create': () => ({ personId: rnd(), legacyMembershipId: rnd(), targetPlanKey: 'standard', interval: 'month' }),
  'offer.withdraw': () => ({ offerId: rnd() }),
  'legacy.confirm_cancelled': () => ({ offerId: rnd(), evidence: 'cancelled in GHL by hand, screenshot in ticket' }),
  'subscription.cancel_period_end': () => ({ subscriptionId: rnd() }),
  'subscription.cancel_now': () => ({ subscriptionId: rnd() }),
  'coins.credit': () => ({ personId: rnd(), coins: 100 }),
  'refund_review.resolve': () => ({ reviewId: rnd(), resolution: 'written off' }),
  'payment.refund': () => ({ ledgerId: 1, amountCents: 100 }),
  'migration.authorize_exception': () => ({ offerId: rnd() }),
  'pilot.add': () => ({ personId: rnd() }),
  'pilot.remove': () => ({ personId: rnd() }),
  'launch.set': () => ({ stage: 'INTERNAL_PILOT' }),
};
const MIN = { 'note.add': 'support', 'offer.create': 'support', 'offer.withdraw': 'support', 'legacy.confirm_cancelled': 'support', 'subscription.cancel_period_end': 'support',
  'subscription.cancel_now': 'finance', 'coins.credit': 'support', 'refund_review.resolve': 'finance', 'payment.refund': 'finance', 'migration.authorize_exception': 'finance',
  'pilot.add': 'owner', 'pilot.remove': 'owner', 'launch.set': 'owner' };
const RANK = ['viewer', 'support', 'finance', 'owner'];

test('RBAC: every action, every role, matches the contract matrix', { skip: SKIP }, async () => {
  const s = await adminStack({ operators: { viewer: 'viewer', support: 'support', finance: 'finance', owner: 'owner' } });
  try {
    await s.signIn('viewer', 'support', 'finance', 'owner');
    assert.deepEqual(Object.keys(ACTIONS).sort(), Object.keys(MIN).sort(), 'every contract action key exists');
    for (const [action, min] of Object.entries(MIN)) {
      for (const role of RANK) {
        const r = await s.as(role).act(action, SAMPLE[action]());
        if (RANK.indexOf(role) < RANK.indexOf(min)) assert.deepEqual([r.status, r.json.code, r.json.requiredRole], [403, 'FORBIDDEN', min], `${role} ${action}`);
        else assert.notEqual(r.status, 403, `${role} may ${action}: ${JSON.stringify(r.json)}`);
      }
    }
    // Thresholds: goodwill > 500 needs finance (and a second finance approver); stages above INTERNAL_PILOT are dual (owner).
    assert.deepEqual([(await s.as('support').act('coins.credit', { personId: rnd(), coins: 501 })).json.requiredRole], ['finance']);
    assert.equal((await s.as('finance').act('coins.credit', { personId: rnd(), coins: 10001 })).json.code, 'INVALID_INPUT');
    assert.equal((await s.as('owner').act('launch.set', { stage: 'LIMITED_NEW_CUSTOMERS', limitedCap: 5 })).json.code, 'INVALID_INPUT', 'approval reference required');
    assert.equal((await s.as('owner').act('launch.set', { stage: 'LIMITED_NEW_CUSTOMERS', limitedCap: 5, approvalRef: 'GO-fixture' })).json.status, 'pending');
    assert.equal((await s.as('owner').act('launch.set', { stage: 'OFF' })).json.status, 'executed', 'OFF / INTERNAL_PILOT are direct');
    // Reads are open to viewer.
    for (const p of ['/v1/admin/overview', '/v1/admin/persons', '/v1/admin/plans', '/v1/admin/payments', '/v1/admin/coins', '/v1/admin/legacy', '/v1/admin/migration-offers',
      '/v1/admin/reconciliation', '/v1/admin/refund-reviews', '/v1/admin/dead-letters', '/v1/admin/audit', '/v1/admin/health', '/v1/admin/launch', '/v1/admin/requests']) {
      const r = await s.as('viewer').get(p);
      assert.equal(r.status, 200, p + ' ' + JSON.stringify(r.json));
    }
    assert.deepEqual(permissionsFor({ role: 'support' }).sort(), Object.entries(MIN).filter(([, m]) => m === 'support').map(([k]) => k).sort());
    // Input rules: reason >= 10, requestId shape, unknown action.
    assert.equal((await s.as('owner').act('pilot.add', { personId: rnd() }, { reason: 'short' })).json.code, 'INVALID_INPUT');
    assert.equal((await s.as('owner').act('pilot.add', { personId: rnd() }, { requestId: 'x' })).json.code, 'INVALID_INPUT');
    assert.equal((await s.as('owner').act('money.print', {})).json.code, 'INVALID_INPUT');
    assert.ok((await s.pool.query("SELECT count(*)::int n FROM audit_logs WHERE action = 'admin.denied' AND actor_id = $1", ['operator:' + s.ops.viewer.id])).rows[0].n >= 13, 'denials are audited with the operator id');
  } finally { await s.close(); }
});

test('direct actions: support goodwill <= 500 executes once; replay returns the first result; audit names the operator', { skip: SKIP }, async () => {
  const s = await adminStack({ operators: { support: 'support', viewer: 'viewer' } });
  try {
    await s.signIn('support', 'viewer');
    const pid = await fixturePerson(s.pool);
    const r1 = await s.as('support').act('coins.credit', { personId: pid, coins: 300 }, { requestId: 'goodwill-0001', reason: 'service outage on 25 Oct' });
    assert.deepEqual([r1.status, r1.json.status, r1.json.result.coins], [200, 'executed', 300]);
    const r2 = await s.as('support').act('coins.credit', { personId: pid, coins: 300 }, { requestId: 'goodwill-0001', reason: 'service outage on 25 Oct' });
    assert.deepEqual([r2.json.status, r2.json.replayed, r2.json.result], ['executed', true, r1.json.result]);
    const r3 = await s.as('support').act('coins.credit', { personId: pid, coins: 400 }, { requestId: 'goodwill-0001', reason: 'service outage on 25 Oct' });
    assert.equal(r3.json.code, 'CONFLICT', 'same requestId for a different request');
    const w = (await s.pool.query('SELECT purchased_balance FROM coin_wallets WHERE person_id = $1', [pid])).rows[0];
    assert.equal(w.purchased_balance, 300, 'credited exactly once');
    assert.deepEqual((await s.pool.query('SELECT * FROM membership.wallet_mismatches()')).rows, []);
    const actions = (await s.pool.query('SELECT action FROM audit_logs WHERE actor_id = $1 ORDER BY id', ['operator:' + s.ops.support.id])).rows.map((r) => r.action);
    for (const a of ['operator.login', 'admin.action.submit', 'coins.adjustment', 'admin.action.executed']) assert.ok(actions.includes(a), a);
    // Notes: append-only, shown in the person detail.
    const n = await s.as('support').post(`/v1/admin/persons/${pid}/notes`, { body: 'Called the member about the outage credit.' });
    assert.equal(n.status, 201);
    const n2 = await s.as('support').act('note.add', { personId: pid, body: 'Second note sent through actions.' }, { reason: '' });
    assert.equal(n2.json.status, 'executed', 'a note is its own reason');
    assert.equal((await s.as('support').act('note.add', { personId: pid, body: 'short' }, { reason: '' })).json.code, 'INVALID_INPUT', 'but it still needs 10 characters');
    const d = (await s.as('viewer').get(`/v1/admin/persons/${pid}`)).json;
    assert.deepEqual([d.notes.length, d.notes[0].operator_name, d.wallet.purchased.coins], [2, 'support fixture', 300]);
    await assert.rejects(s.pool.query('UPDATE person_notes SET body = $1', ['x']), /append-only/);
    // A failed direct action is recorded as failed with its code.
    const f = await s.as('support').act('coins.credit', { personId: rnd(), coins: 5 });
    assert.equal(f.json.code, 'NOT_FOUND');
    assert.equal((await s.pool.query("SELECT result->>'code' c FROM admin_action_requests WHERE id = $1", [f.json.request.id])).rows[0].c, 'NOT_FOUND');
    assert.equal((await s.pool.query('SELECT status FROM admin_action_requests WHERE id = $1', [f.json.request.id])).rows[0].status, 'failed');
    // Search finds the person by email prefix.
    const found = (await s.as('viewer').get('/v1/admin/persons?q=person.fix')).json;
    assert.deepEqual(found.items.map((i) => [i.personId, i.coins]), [[pid, 300]]);
  } finally { await s.close(); }
});

test('two-person rule: self-approval refused, wrong role refused, a second operator approves and it executes exactly once', { skip: SKIP }, async () => {
  const s = await adminStack();
  try {
    await s.signIn('support', 'finance', 'finance2', 'owner');
    const pid = await fixturePerson(s.pool);
    const r = await s.as('finance').act('coins.credit', { personId: pid, coins: 2000 }, { requestId: 'big-credit-01', reason: 'migration courtesy credit agreed' });
    assert.deepEqual([r.json.status, r.json.request.requiredRole, r.json.request.canApprove], ['pending', 'finance', false]);
    const id = r.json.request.id;
    assert.equal((await s.pool.query('SELECT count(*)::int n FROM coin_wallets WHERE person_id = $1', [pid])).rows[0].n, 0, 'nothing moved yet');
    const self = await s.as('finance').post(`/v1/admin/requests/${id}/approve`, { note: 'me' });
    assert.deepEqual([self.status, self.json.code], [403, 'FORBIDDEN']);
    const low = await s.as('support').post(`/v1/admin/requests/${id}/approve`, {});
    assert.deepEqual([low.status, low.json.requiredRole], [403, 'finance']);
    const list = (await s.as('finance2').get('/v1/admin/requests?status=pending')).json.items;
    assert.deepEqual(list.map((x) => [x.id, x.canApprove]), [[id, true]]);
    const [a, b] = await Promise.all([s.as('finance2').post(`/v1/admin/requests/${id}/approve`, { note: 'checked' }), s.as('owner').post(`/v1/admin/requests/${id}/approve`, {})]);
    const statuses = [a, b].map((x) => x.json.status || x.json.code).sort();
    assert.deepEqual(statuses, ['CONFLICT', 'executed'], 'two approvers at once: one executes, the other is refused');
    assert.equal((await s.pool.query('SELECT purchased_balance FROM coin_wallets WHERE person_id = $1', [pid])).rows[0].purchased_balance, 2000);
    assert.equal((await s.as('finance2').post(`/v1/admin/requests/${id}/approve`, {})).json.code, 'CONFLICT', 'replayed approval');
    // An approval with a requestId is idempotent for that approver: the replay returns the first outcome.
    const pid2 = await fixturePerson(s.pool, 'second.fixture@example.invalid');
    const k = (await s.as('finance').act('coins.credit', { personId: pid2, coins: 700 })).json.request.id;
    const ap1 = await s.as('finance2').post(`/v1/admin/requests/${k}/approve`, { note: 'ok', requestId: 'approve-k-0001' });
    const ap2 = await s.as('finance2').post(`/v1/admin/requests/${k}/approve`, { note: 'ok', requestId: 'approve-k-0001' });
    assert.deepEqual([ap1.json.status, ap2.json.status, ap2.json.replayed], ['executed', 'executed', true]);
    assert.deepEqual(ap2.json.result, ap1.json.result);
    assert.equal((await s.pool.query('SELECT purchased_balance FROM coin_wallets WHERE person_id = $1', [pid2])).rows[0].purchased_balance, 700);
    const k2 = (await s.as('finance').act('coins.credit', { personId: pid2, coins: 800 })).json.request.id;
    assert.equal((await s.as('finance2').post(`/v1/admin/requests/${k2}/approve`, { requestId: 'approve-k-0001' })).json.code, 'CONFLICT', 'same decision key for another request');
    assert.equal((await s.as('finance2').post(`/v1/admin/requests/${k2}/reject`, { requestId: 'bad id' })).json.code, 'INVALID_INPUT');
    const replay = await s.as('finance').act('coins.credit', { personId: pid, coins: 2000 }, { requestId: 'big-credit-01', reason: 'migration courtesy credit agreed' });
    assert.deepEqual([replay.json.status, replay.json.replayed], ['executed', true]);
    assert.equal((await s.pool.query('SELECT purchased_balance FROM coin_wallets WHERE person_id = $1', [pid])).rows[0].purchased_balance, 2000, 'never twice');
    await assert.rejects(s.pool.query('UPDATE admin_action_requests SET decided_by = requested_by WHERE id = $1', [id]), /check/i, 'the database refuses self-approval too');
    const trail = (await s.pool.query("SELECT action, actor_id FROM audit_logs WHERE entity_type = 'admin_action_request' AND entity_id = $1 ORDER BY id", [id])).rows;
    assert.deepEqual(trail.map((t) => t.action), ['admin.request.create', 'admin.denied', 'admin.denied', 'admin.request.approve', 'admin.action.executed'], 'refused approvals are audited too');
    const winner = a.json.status === 'executed' ? 'finance2' : 'owner';
    assert.deepEqual(trail.map((t) => t.actor_id), ['finance', 'finance', 'support', winner, winner].map((n) => 'operator:' + s.ops[n].id));
    // Reject and cancel.
    const r2 = (await s.as('finance').act('coins.credit', { personId: pid, coins: 900 })).json.request.id;
    assert.equal((await s.as('finance2').post(`/v1/admin/requests/${r2}/reject`, { note: 'not agreed' })).json.status, 'rejected');
    const r3 = (await s.as('finance').act('coins.credit', { personId: pid, coins: 900 })).json.request.id;
    assert.equal((await s.as('finance2').post(`/v1/admin/requests/${r3}/cancel`, {})).status, 403, 'only the requester cancels');
    assert.equal((await s.as('finance').post(`/v1/admin/requests/${r3}/cancel`, {})).json.status, 'cancelled');
    // Exception needs an OWNER approver.
    const ex = (await s.as('finance').act('migration.authorize_exception', { offerId: rnd() })).json.request;
    assert.equal(ex.requiredRole, 'owner');
    assert.equal((await s.as('finance2').post(`/v1/admin/requests/${ex.id}/approve`, {})).json.requiredRole, 'owner');
    const exr = await s.as('owner').post(`/v1/admin/requests/${ex.id}/approve`, {});
    assert.deepEqual([exr.json.status, exr.json.result.code], ['failed', 'NOT_FOUND'], 'a failed execution is recorded');
  } finally { await s.close(); }
});

test('two-person rule: expiry after 72 h, disabled approver, disabled requester cancels pending requests', { skip: SKIP }, async () => {
  const s = await adminStack();
  try {
    await s.signIn('finance', 'finance2', 'owner');
    const pid = await fixturePerson(s.pool);
    const id = (await s.as('finance').act('coins.credit', { personId: pid, coins: 1000 })).json.request.id;
    s.advance(72 * HOUR + 1000);
    await s.signIn('finance2');
    const late = await s.as('finance2').post(`/v1/admin/requests/${id}/approve`, {});
    assert.deepEqual([late.status, late.json.message], [409, 'request expired']);
    assert.equal((await s.pool.query('SELECT status FROM admin_action_requests WHERE id = $1', [id])).rows[0].status, 'expired');
    s.advance(60 * 1000);
    await s.signIn('finance', 'owner');
    const id2 = (await s.as('finance').act('coins.credit', { personId: pid, coins: 1000 })).json.request.id;
    await disableOperator(s.pool, s.ops.finance2.id, 'owner-cli');
    assert.equal((await s.as('finance2').post(`/v1/admin/requests/${id2}/approve`, {})).status, 401, 'a disabled approver cannot approve');
    assert.equal((await s.pool.query('SELECT status FROM admin_action_requests WHERE id = $1', [id2])).rows[0].status, 'pending');
    await disableOperator(s.pool, s.ops.finance.id, 'owner-cli');
    assert.equal((await s.pool.query('SELECT status FROM admin_action_requests WHERE id = $1', [id2])).rows[0].status, 'cancelled', "a disabled operator's pending requests are cancelled");
    assert.equal((await s.as('owner').post(`/v1/admin/requests/${id2}/approve`, {})).json.code, 'CONFLICT');
    assert.equal((await s.pool.query('SELECT count(*)::int n FROM coin_wallets WHERE person_id = $1', [pid])).rows[0].n, 0);
  } finally { await s.close(); }
});

test('Stripe actions without Stripe: approved_not_executed with PROVIDER_UNAVAILABLE, never faked, never re-executed', { skip: SKIP }, async () => {
  const s = await adminStack();
  try {
    await s.signIn('finance', 'finance2', 'support');
    const pid = await fixturePerson(s.pool);
    const ledger = (await s.pool.query(`INSERT INTO payment_ledger (person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, occurred_at)
                                         VALUES ($1, 'stripe', 'charge', 'ch_fixture_admin', 'charge', 4700, 'USD', now()) RETURNING id`, [pid])).rows[0].id;
    const id = (await s.as('finance').act('payment.refund', { ledgerId: ledger, amountCents: 4700 })).json.request.id;
    const r = await s.as('finance2').post(`/v1/admin/requests/${id}/approve`, {});
    assert.deepEqual([r.status, r.json.status, r.json.result.code], [200, 'approved_not_executed', 'PROVIDER_UNAVAILABLE']);
    const row = (await s.pool.query('SELECT status, executed_at FROM admin_action_requests WHERE id = $1', [id])).rows[0];
    assert.deepEqual([row.status, row.executed_at], ['approved', null]);
    assert.equal((await s.as('finance2').post(`/v1/admin/requests/${id}/approve`, {})).json.code, 'CONFLICT');
    assert.equal((await s.pool.query("SELECT count(*)::int n FROM payment_ledger WHERE entry_type = 'refund'")).rows[0].n, 0, 'no refund booked');
    assert.equal((await s.as('finance').get('/v1/admin/requests')).json.items.find((x) => x.id === id).status, 'approved_not_executed');
    // Period-end cancel of a Stripe subscription (direct) also refuses honestly.
    const v = (await s.pool.query("SELECT v.id FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE p.key = 'standard'")).rows[0].id;
    const sub = (await s.pool.query(`INSERT INTO subscriptions (person_id, plan_version_id, billing_interval, status, provider, provider_subscription_id) VALUES ($1, $2, 'month', 'active', 'stripe', 'sub_fixture_admin') RETURNING id`, [pid, v])).rows[0].id;
    const c = await s.as('support').act('subscription.cancel_period_end', { subscriptionId: sub });
    assert.deepEqual([c.status, c.json.code], [503, 'PROVIDER_UNAVAILABLE']);
    assert.equal((await s.pool.query('SELECT cancel_at FROM subscriptions WHERE id = $1', [sub])).rows[0].cancel_at, null);
  } finally { await s.close(); }
});

test('Stripe actions with a (test-mode) Stripe client: refund and immediate cancel call the adapter once', { skip: SKIP }, async () => {
  const calls = [];
  const stripe = { livemode: false,
    async get(path) { calls.push(['GET', path]); return { id: 'in_fixture', payment_intent: 'pi_fixture', livemode: false }; },
    async post(path, params, { idempotencyKey }) { calls.push(['POST', path, params, idempotencyKey]); return { id: 're_fixture1', status: 'succeeded', amount: params.amount, currency: 'usd', livemode: false }; },
    async del(path) { calls.push(['DELETE', path]); return { id: 'sub_fixture_now', status: 'canceled', livemode: false }; } };
  const s = await adminStack({ stripe });
  try {
    await s.signIn('finance', 'finance2');
    const pid = await fixturePerson(s.pool);
    const ledger = (await s.pool.query(`INSERT INTO payment_ledger (person_id, provider, provider_object_type, provider_object_id, entry_type, amount_cents, currency, occurred_at)
                                         VALUES ($1, 'stripe', 'invoice', 'in_fixture', 'charge', 4700, 'USD', now()) RETURNING id`, [pid])).rows[0].id;
    assert.equal((await s.as('finance').act('payment.refund', { ledgerId: ledger, amountCents: 5000 })).json.status, 'pending');
    const tooMuch = (await s.as('finance').get('/v1/admin/requests?status=pending')).json.items[0].id;
    assert.equal((await s.as('finance2').post(`/v1/admin/requests/${tooMuch}/approve`, {})).json.result.code, 'INVALID_INPUT', 'more than the charge');
    const id = (await s.as('finance').act('payment.refund', { ledgerId: ledger, amountCents: 1000 })).json.request.id;
    const r = await s.as('finance2').post(`/v1/admin/requests/${id}/approve`, {});
    assert.deepEqual([r.json.status, r.json.result.refundId, r.json.result.amountCents], ['executed', 're_fixture1', 1000]);
    const post = calls.find((c) => c[0] === 'POST');
    assert.deepEqual([post[1], post[2].payment_intent, post[2].amount, post[3]], ['/v1/refunds', 'pi_fixture', 1000, `gaia-admin-refund-${id}`]);
    const v = (await s.pool.query("SELECT v.id FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE p.key = 'standard'")).rows[0].id;
    const sub = (await s.pool.query(`INSERT INTO subscriptions (person_id, plan_version_id, billing_interval, status, provider, provider_subscription_id) VALUES ($1, $2, 'month', 'active', 'stripe', 'sub_fixture_now') RETURNING id`, [pid, v])).rows[0].id;
    const cid = (await s.as('finance').act('subscription.cancel_now', { subscriptionId: sub })).json.request.id;
    assert.equal((await s.as('finance2').post(`/v1/admin/requests/${cid}/approve`, {})).json.status, 'executed');
    assert.equal((await s.pool.query('SELECT status FROM subscriptions WHERE id = $1', [sub])).rows[0].status, 'canceled');
    assert.equal(calls.filter((c) => c[0] === 'DELETE').length, 1);
  } finally { await s.close(); }
});

test('launch stage above INTERNAL_PILOT: owner requests, a second owner approves; the env ceiling still caps it; pilot list', { skip: SKIP }, async () => {
  const s = await adminStack({ operators: { owner: 'owner', owner2: 'owner', finance: 'finance' } });
  try {
    await s.signIn('owner', 'owner2', 'finance');
    const pid = await fixturePerson(s.pool);
    assert.equal((await s.as('owner').act('pilot.add', { personId: pid })).json.status, 'executed');
    const id = (await s.as('owner').act('launch.set', { stage: 'ALL_NEW_CUSTOMERS', approvalRef: 'GO-fixture-1' })).json.request.id;
    assert.equal((await s.as('finance').post(`/v1/admin/requests/${id}/approve`, {})).json.requiredRole, 'owner');
    assert.equal((await s.as('owner2').post(`/v1/admin/requests/${id}/approve`, {})).json.status, 'executed');
    assert.deepEqual(await launchState(s.pool, { env: { MEMBERSHIP2_STAGE_CEILING: 'INTERNAL_PILOT' } }).then((x) => [x.stored, x.effective]), ['ALL_NEW_CUSTOMERS', 'INTERNAL_PILOT']);
    const l = (await s.as('finance').get('/v1/admin/launch')).json;
    assert.deepEqual([l.state.stored, l.pilots.length, l.history[0].changed_by], ['ALL_NEW_CUSTOMERS', 1, 'operator:' + s.ops.owner2.id]);
  } finally { await s.close(); }
});

test('read models are bounded and paginated; health and overview answer', { skip: SKIP }, async () => {
  const s = await adminStack({ operators: { viewer: 'viewer', support: 'support' } });
  try {
    await s.signIn('viewer', 'support');
    for (let i = 0; i < 5; i++) await fixturePerson(s.pool, `page${i}.fixture@example.invalid`);
    const p1 = (await s.as('viewer').get('/v1/admin/persons?limit=2')).json;
    const p2 = (await s.as('viewer').get(`/v1/admin/persons?limit=2&cursor=${p1.next}`)).json;
    const p3 = (await s.as('viewer').get(`/v1/admin/persons?limit=2&cursor=${p2.next}`)).json;
    assert.deepEqual([p1.items.length, p2.items.length, p3.items.length, p3.next], [2, 2, 1, null]);
    assert.equal(new Set([...p1.items, ...p2.items, ...p3.items].map((x) => x.personId)).size, 5);
    const a = (await s.as('viewer').get('/v1/admin/audit?limit=1000')).json;
    assert.ok(a.items.length <= 200);
    const a1 = (await s.as('viewer').get('/v1/admin/audit?limit=2')).json;
    const a2 = (await s.as('viewer').get(`/v1/admin/audit?limit=2&cursor=${a1.next}`)).json;
    assert.ok(a2.items[0].id < a1.items[1].id);
    assert.equal((await s.as('viewer').get('/v1/admin/audit?cursor=!!')).json.code, 'INVALID_INPUT');
    const h = (await s.as('viewer').get('/v1/admin/health')).json;
    assert.deepEqual([h.db, h.migrationsVersion, h.stripeConnected], [true, '0011', false]);
    const o = (await s.as('viewer').get('/v1/admin/overview')).json;
    assert.deepEqual([o.mrrCents, o.pendingRequests, o.launch.effective], [0, 0, 'OFF']);
    assert.ok(Array.isArray((await s.as('viewer').get('/v1/admin/plans')).json.plans));
  } finally { await s.close(); }
});

test('operator management (CLI functions): audited, sessions revoked on role change and TOTP reset', { skip: SKIP }, async () => {
  const s = await adminStack({ operators: { support: 'support' } });
  try {
    await s.signIn('support');
    await assert.rejects(createOperator(s.pool, { email: 'x@example.invalid', displayName: 'X', role: 'admin' }, 'owner', { env: s.env }), /role/);
    await assert.rejects(createOperator(s.pool, { email: s.ops.support.email, displayName: 'dup', role: 'viewer' }, 'owner', { env: s.env }), /exists/);
    await assert.rejects(createOperator(s.pool, { email: 'y@example.invalid', displayName: 'Y', role: 'viewer' }, '', { env: s.env }), /actor/);
    await assert.rejects(createOperator(s.pool, { email: 'y@example.invalid', displayName: 'Y', role: 'viewer' }, 'owner', { env: {} }), /MEMBERSHIP_OPERATOR_KEY/);
    assert.deepEqual((await setOperatorRole(s.pool, s.ops.support.email, 'finance', 'owner')).to, 'finance');
    assert.equal((await s.as('support').get('/v1/admin/me')).status, 401, 'role change signs out');
    s.advance(60 * 1000);
    await s.signIn('support');
    assert.equal((await s.as('support').get('/v1/admin/me')).json.operator.role, 'finance');
    const reset = await resetOperatorTotp(s.pool, s.ops.support.email, 'owner', { env: s.env });
    assert.equal((await s.as('support').get('/v1/admin/me')).status, 401);
    s.advance(60 * 1000);
    assert.equal((await s.login('support')).status, 401, 'old secret no longer works');
    s.ops.support.secret = (await import('./_admin.js')).secretOf(reset.otpauthUri);
    assert.equal((await s.login('support')).status, 200);
    const rows = (await s.pool.query("SELECT action FROM audit_logs WHERE actor_id = 'cli:owner' ORDER BY id")).rows.map((r) => r.action);
    assert.deepEqual(rows, ['operator.set_role', 'operator.reset_totp']);
    assert.equal((await listOperators(s.pool)).length, 1);
  } finally { await s.close(); }
});
