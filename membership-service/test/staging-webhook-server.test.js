import './_providers-deny-network.mjs';
/**
 * Staging Stripe webhook receiver (src/cli/staging-webhook-server.js): config
 * refusals (non-loopback database, live-looking or wrong secrets, bad bounds),
 * loopback-only binding, signature checking through ingest.js, and bounded
 * processing batches. Deliveries come from a loopback client; the database is
 * the throwaway test database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, TEST_URL } from './_db.js';
import { signForTest } from '../src/stripe/signature.js';
import {
  main, startStagingWebhookServer, checkDatabaseUrl, checkWebhookSecret, WEBHOOK_PATH, MAX_BATCH, MAX_BODY_BYTES, BIND_HOST,
} from '../src/cli/staging-webhook-server.js';

const SECRET = 'whsec_test_fixture_' + 's'.repeat(24);
const LOCAL_DB = 'postgres://u:p@127.0.0.1:5999/membership_test';
const env = (o = {}) => ({ MEMBERSHIP_DATABASE_URL: LOCAL_DB, STRIPE_TEST_WEBHOOK_SECRET: SECRET, ...o });
let n = 0;
const evt = (type = 'sandbox.unhandled', extra = {}) => ({ id: `evt_whs_${++n}`, object: 'event', type, created: Math.floor(Date.now() / 1000) - 60 + n, livemode: false, data: { object: { id: `obj_${n}` } }, ...extra });
const post = (url, body, header) => fetch(url + WEBHOOK_PATH, { method: 'POST', headers: { 'content-type': 'application/json', ...(header ? { 'stripe-signature': header } : {}) }, body });
const send = (url, e, secret = SECRET) => { const raw = JSON.stringify(e); return post(url, raw, signForTest(secret, raw)); };

test('database URL: loopback only, including ?host= overrides', () => {
  for (const ok of [LOCAL_DB, 'postgresql://u@localhost/db', 'postgres://u@[::1]:5432/db', 'postgres://u@127.0.0.2/db?host=127.0.0.1']) assert.equal(checkDatabaseUrl(ok), null, ok);
  for (const bad of ['', undefined, 'not a url', 'mysql://u@127.0.0.1/db', 'postgres://u:p@db.example.com:5432/db', 'postgres://u@10.0.0.5/db',
    'postgres://u@127.0.0.1/db?host=db.example.com', 'postgres://u@127.0.0.1/db?hostaddr=10.1.1.1', 'postgres:///db', 'postgres://u@127.0.0.1.evil.example/db']) {
    assert.notEqual(checkDatabaseUrl(bad), null, String(bad));
  }
});

test('webhook secret: whsec_ only; live-looking secrets and API keys refused', () => {
  assert.equal(checkWebhookSecret(SECRET), null);
  for (const bad of ['', undefined, 'whsec_short', 'whsec_live_' + 'a'.repeat(24), 'whsec_' + 'a'.repeat(10) + 'LIVE' + 'b'.repeat(10),
    'sk_live_' + 'a'.repeat(24), 'rk_live_' + 'a'.repeat(24), 'sk_test_' + 'a'.repeat(24), 'pk_test_' + 'a'.repeat(24), 'secret-' + 'a'.repeat(30)]) {
    assert.notEqual(checkWebhookSecret(bad), null, String(bad).slice(0, 12));
  }
});

test('the CLI refuses to start on a bad configuration, binds nothing, and never prints the secret or URL', async () => {
  const cases = [
    env({ MEMBERSHIP_DATABASE_URL: 'postgres://u:hunter2@db.example.com:5432/membership' }),
    env({ MEMBERSHIP_DATABASE_URL: undefined }),
    env({ STRIPE_TEST_WEBHOOK_SECRET: 'whsec_live_' + 'q'.repeat(24) }),
    env({ STRIPE_TEST_WEBHOOK_SECRET: 'sk_live_' + 'q'.repeat(24) }),
    env({ STRIPE_TEST_WEBHOOK_SECRET: undefined }),
  ];
  for (const e of cases) {
    const lines = [];
    const r = await main(['--port', '0'], { env: e, out: (s) => lines.push(s), err: (s) => lines.push(s) });
    assert.equal(r.code, 2);
    assert.equal(r.server, undefined);
    const t = lines.join('\n');
    assert.match(t, /REFUSED/);
    assert.ok(!t.includes('hunter2') && !t.includes('q'.repeat(24)), 'no secret or database credential echoed');
  }
  for (const argv of [['--batch', String(MAX_BATCH + 1)], ['--batch', '0'], ['--interval-ms', '10'], ['--port', '-1'], ['--host', '0.0.0.0']]) {
    const r = await main(argv[0] === '--port' ? argv : ['--port', '0', ...argv], { env: env(), out: () => {}, err: () => {} });
    assert.equal(r.code, 2, argv.join(' '));
  }
});

test('receiver: loopback bind, signatures verified, events stored once, live and oversized refused', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const timers = [];
  const logs = [];
  const srv = await startStagingWebhookServer({
    env: env({ MEMBERSHIP_DATABASE_URL: TEST_URL }), port: 0, pool, log: (s) => logs.push(s),
    setIntervalFn: (fn, ms) => { timers.push(ms); return 1; }, clearIntervalFn: () => {},
  });
  try {
    assert.ok(srv.url.startsWith(`http://${BIND_HOST}:`));
    assert.deepEqual(timers, [5000], 'one interval, the default 5 s');
    assert.equal((await fetch(srv.url + '/healthz')).status, 200);
    assert.equal((await fetch(srv.url + WEBHOOK_PATH)).status, 405);
    assert.equal((await fetch(srv.url + '/other', { method: 'POST' })).status, 404);

    const e = evt();
    assert.equal((await send(srv.url, e)).status, 200);
    const dup = await send(srv.url, e);
    assert.deepEqual(await dup.json(), { ok: true, duplicate: true });

    const bad = await send(srv.url, evt(), 'whsec_attacker_' + 'z'.repeat(24));
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).reason, 'signature_mismatch');
    assert.equal((await post(srv.url, JSON.stringify(evt()))).status, 400, 'no signature header');
    const raw = JSON.stringify(evt());
    assert.equal((await post(srv.url, raw, signForTest(SECRET, raw, Math.floor(Date.now() / 1000) - 3600))).status, 400, 'stale timestamp');
    const live = await send(srv.url, evt('invoice.paid', { livemode: true }));
    assert.equal((await live.json()).reason, 'livemode_not_enabled');
    assert.equal((await post(srv.url, 'x'.repeat(MAX_BODY_BYTES + 1), 't=1,v1=' + '0'.repeat(64))).status, 413);

    assert.equal((await pool.query('SELECT count(*)::int n FROM webhook_events')).rows[0].n, 1, 'only the one verified test-mode event is stored');
    const t = logs.join('\n');
    assert.match(t, new RegExp(`accepted ${e.id} type=sandbox.unhandled`));
    assert.ok(!t.includes(SECRET) && !t.includes('obj_'), 'no secret or payload logged');
  } finally { await srv.close(); await pool.end(); }
});

test('processing: one bounded batch per tick, never two at once', { skip: SKIP }, async () => {
  const pool = await freshPool();
  let concurrent = 0, peak = 0;
  const handlers = { 'sandbox.counted': async () => { concurrent++; peak = Math.max(peak, concurrent); await new Promise((r) => setTimeout(r, 2)); concurrent--; return 'processed'; } };
  const srv = await startStagingWebhookServer({ env: env({ MEMBERSHIP_DATABASE_URL: TEST_URL }), port: 0, pool, batch: 10, handlers, log: () => {}, setIntervalFn: () => 1, clearIntervalFn: () => {} });
  try {
    for (let i = 0; i < 25; i++) assert.equal((await send(srv.url, evt('sandbox.counted'))).status, 200);
    const [a, b] = await Promise.all([srv.tick(), srv.tick()]);
    assert.equal(a.processed, 10, 'the batch is bounded');
    assert.deepEqual(b, { skipped: true }, 'a tick while one runs is skipped, not queued');
    assert.equal((await srv.tick()).processed, 10);
    assert.equal((await srv.tick()).processed, 5);
    assert.equal((await srv.tick()).processed, 0);
    assert.equal(peak, 1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM webhook_events WHERE status = 'processed'")).rows[0].n, 25);
  } finally { await srv.close(); await pool.end(); }
});

test('the real interval drives processing (minimum interval)', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await startStagingWebhookServer({ env: env({ MEMBERSHIP_DATABASE_URL: TEST_URL }), port: 0, pool, intervalMs: 1000, log: () => {} });
  try {
    assert.equal((await send(srv.url, evt())).status, 200);
    let status;
    for (let i = 0; i < 50 && status !== 'ignored'; i++) {      // bounded wait: up to ~5 s for the 1 s interval
      await new Promise((r) => setTimeout(r, 100));
      status = (await pool.query('SELECT status FROM webhook_events')).rows[0].status;
    }
    assert.equal(status, 'ignored', 'no handler: ignored by the interval tick');
  } finally { await srv.close(); await pool.end(); }
});
