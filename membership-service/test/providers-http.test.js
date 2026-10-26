import './_providers-deny-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, backoffDelay } from '../src/providers/http.js';
import { fakeServer, fetchVia } from './_providers-fakes.js';

test('fetch must be injected: no client can be built on an implicit network', () => {
  assert.throws(() => createHttpClient({ provider: 'x', baseUrl: 'http://127.0.0.1:1' }), /explicit fetch/);
  assert.throws(() => createHttpClient({ provider: 'x', baseUrl: 'http://127.0.0.1:1', fetch: fetchVia, retry: { maxRetries: 50 } }), /maxRetries/);
});

test('429 and 5xx are retried with bounded backoff, then PROVIDER_UNAVAILABLE', async () => {
  const srv = await fakeServer(() => ({ status: 503, json: { error: 'down' } }));
  const delays = [];
  try {
    const req = createHttpClient({ provider: 'p', baseUrl: srv.url, fetch: fetchVia, retry: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 }, sleep: async (ms) => delays.push(ms), random: () => 1 });
    await assert.rejects(req('GET', '/x'), (e) => e.code === 'PROVIDER_UNAVAILABLE' && e.details.attempts === 4 && e.details.status === 503);
    assert.equal(srv.requests.length, 4, 'exactly 1 + maxRetries attempts');
    assert.deepEqual(delays, [100, 200, 400]);
  } finally { await srv.close(); }
});

test('a transient failure recovers; Retry-After is honoured but capped', async () => {
  const srv = await fakeServer(() => ({ json: { ok: true } }));
  srv.faults.push({ status: 429, headers: { 'retry-after': '3600' }, json: {} });
  const delays = [];
  try {
    const req = createHttpClient({ provider: 'p', baseUrl: srv.url, fetch: fetchVia, retry: { maxDelayMs: 2000 }, sleep: async (ms) => delays.push(ms) });
    assert.deepEqual(await req('GET', '/x'), { ok: true });
    assert.deepEqual(delays, [2000], 'an hour-long Retry-After is capped');
  } finally { await srv.close(); }
});

test('4xx is not retried and maps to a standard code; bodies never leak into errors', async () => {
  const srv = await fakeServer((r) => ({ status: Number(r.path.slice(1)), json: { secret: 'do-not-leak' } }));
  try {
    const req = createHttpClient({ provider: 'p', baseUrl: srv.url, fetch: fetchVia, sleep: async () => {} });
    for (const [s, code] of [[400, 'INVALID_INPUT'], [401, 'PROVIDER_UNAVAILABLE'], [404, 'NOT_FOUND'], [409, 'CONFLICT']]) {
      await assert.rejects(req('GET', '/' + s), (e) => e.code === code && !JSON.stringify(e).includes('do-not-leak'));
    }
    assert.equal(srv.requests.length, 4);
  } finally { await srv.close(); }
});

test('connection refused is retried then PROVIDER_UNAVAILABLE', async () => {
  const req = createHttpClient({ provider: 'p', baseUrl: 'http://127.0.0.1:9', fetch: fetchVia, retry: { maxRetries: 1 }, sleep: async () => {} });
  await assert.rejects(req('GET', '/x'), (e) => e.code === 'PROVIDER_UNAVAILABLE' && e.details.status === 0);
});

test('backoff never exceeds the cap', () => {
  for (let a = 0; a < 10; a++) assert.ok(backoffDelay(a, { baseDelayMs: 250, maxDelayMs: 4000 }, null) <= 4000);
});
