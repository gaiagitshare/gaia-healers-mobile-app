/**
 * Member gateway, outage handling (Phase 5 drills): an unreachable, timed-out or
 * failed membership service answers SERVICE_UNAVAILABLE, never the
 * PROVIDER_UNAVAILABLE "billing not connected" code; reads time out after 4 s,
 * writes after 8 s. The service is replaced by an in-process fake fetch: no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMembership2Gateway, GET_TIMEOUT_MS, WRITE_TIMEOUT_MS } from '../membership2-gateway.js';

const TOKEN = 'gms_' + 'a'.repeat(43);
const ENV = { MEMBERSHIP2_GATEWAY: 'on', MEMBERSHIP_SERVICE_URL: 'http://127.0.0.1:8792', MEMBERSHIP_SERVICE_TOKEN: TOKEN };
const PID = '11111111-2222-4333-8444-555555555555';
const SUB = '66666666-7777-4888-8999-000000000000';
const json = (status, body) => ({ status, json: async () => body });

function harness(answer) {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ path: new URL(url).pathname, method: init.method, signal: init.signal });
    if (new URL(url).pathname === '/v1/identities/ensure') return json(200, { ok: true, personId: PID });
    return answer(new URL(url).pathname, init);
  };
  const gw = createMembership2Gateway({ env: ENV, fetch });
  const call = async (method, path, body) => {
    let out;
    const req = { method, headers: { 'content-type': 'application/json' } };
    await gw.handle(req, {}, new URL('http://x' + path), {
      origin: null, sendJson: (_res, status, b) => { out = { status, body: b }; },
      readJsonBody: async () => body || {}, requireSessionMember: () => ({ contactId: 'ghl-contact-fixture-outage', email: 'outage@example.invalid' }),
    });
    return out;
  };
  return { call, seen };
}

test('unreachable, timed out or failing service: SERVICE_UNAVAILABLE 503 with a plain message', async () => {
  const cases = [
    () => { throw new TypeError('fetch failed'); },
    () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
    () => json(500, { ok: false, code: 'INTERNAL', message: 'internal error' }),
    () => ({ status: 502, json: async () => { throw new SyntaxError('not json'); } }),
  ];
  for (const answer of cases) {
    const h = harness(answer);
    for (const [m, p, b] of [['GET', '/api/membership2/plans'], ['GET', '/api/membership2/me'], ['POST', '/api/membership2/checkout', { planKey: 'x', interval: 'month', requestId: 'req-outage-01' }]]) {
      const r = await h.call(m, p, b);
      assert.deepEqual([r.status, r.body.code], [503, 'SERVICE_UNAVAILABLE'], `${m} ${p}`);
      assert.equal(r.body.message, 'Membership is temporarily unavailable, please try again shortly');
    }
  }
});

test('the person lookup failing is an outage too, not "billing not connected"', async () => {
  const gw = createMembership2Gateway({ env: ENV, fetch: async () => { throw new TypeError('fetch failed'); } });
  let out;
  await gw.handle({ method: 'GET', headers: {} }, {}, new URL('http://x/api/membership2/me'), {
    origin: null, sendJson: (_r, status, body) => { out = { status, body }; }, readJsonBody: async () => ({}), requireSessionMember: () => ({ contactId: 'ghl-contact-fixture-outage2' }) });
  assert.deepEqual([out.status, out.body.code], [503, 'SERVICE_UNAVAILABLE']);
});

test('a real "billing not connected" answer from the service still passes through unchanged', async () => {
  const h = harness(() => json(503, { ok: false, code: 'PROVIDER_UNAVAILABLE', message: 'billing is not connected in this environment' }));
  const r = await h.call('POST', `/api/membership2/subscriptions/${SUB}/change`, { planKey: 'x', interval: 'month', requestId: 'req-outage-02' });
  assert.deepEqual([r.status, r.body.code], [503, 'PROVIDER_UNAVAILABLE']);
  const ok = harness(() => json(200, { ok: false, status: 'not_available', reason: 'pilot_only' }));
  assert.deepEqual((await ok.call('POST', `/api/membership2/subscriptions/${SUB}/change-preview`, { planKey: 'x', interval: 'month' })).body.reason, 'pilot_only');
});

test('timeouts: 4 s for reads, 8 s for writes', async () => {
  assert.deepEqual([GET_TIMEOUT_MS, WRITE_TIMEOUT_MS], [4000, 8000]);
  const asked = [];
  const real = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { asked.push(ms); return real.call(AbortSignal, ms); };
  try {
    const h = harness(() => json(200, { ok: true, plans: [] }));
    await h.call('GET', '/api/membership2/plans');
    asked.length = 0;
    await h.call('GET', '/api/membership2/me');
    assert.deepEqual(asked, [8000, 4000], 'identity ensure is a write (POST), the overview a read');
    asked.length = 0;
    await h.call('POST', `/api/membership2/subscriptions/${SUB}/change`, { planKey: 'x', interval: 'month', requestId: 'req-outage-03' });
    assert.deepEqual(asked, [8000], 'the person is cached; the change is a write');
  } finally { AbortSignal.timeout = real; }
});

test('plan-change routes: a requestId becomes the idempotency key; keep-plan has its own action', async () => {
  const keys = [];
  const gw = createMembership2Gateway({ env: ENV, fetch: async (url, init) => {
    if (new URL(url).pathname === '/v1/identities/ensure') return json(200, { ok: true, personId: PID });
    keys.push([new URL(url).pathname, init.headers['idempotency-key'] || null, init.body && JSON.parse(init.body)]); return json(200, { ok: true });
  } });
  const send = (path, body) => gw.handle({ method: 'POST', headers: { 'content-type': 'application/json' } }, {}, new URL('http://x' + path), {
    origin: null, sendJson: () => {}, readJsonBody: async () => body, requireSessionMember: () => ({ contactId: 'ghl-contact-fixture-outage3' }) });
  await send(`/api/membership2/subscriptions/${SUB}/change-preview`, { planKey: 'professional', interval: 'month' });
  await send(`/api/membership2/subscriptions/${SUB}/change`, { planKey: 'professional', interval: 'month', prorationDate: 1790000000, requestId: 'req-change-001' });
  await send(`/api/membership2/subscriptions/${SUB}/change/cancel`, { requestId: 'req-keep-0001' });
  assert.deepEqual(keys.map((k) => k[0]), [`/v1/persons/${PID}/subscriptions/${SUB}/change-preview`, `/v1/persons/${PID}/subscriptions/${SUB}/change`, `/v1/persons/${PID}/subscriptions/${SUB}/change/cancel`]);
  assert.deepEqual(keys.map((k) => k[1]), [null, 'm2-change-11111111-req-change-001', 'm2-keepplan-11111111-req-keep-0001']);
  assert.deepEqual(keys[1][2], { planKey: 'professional', interval: 'month', prorationDate: 1790000000 });
});
