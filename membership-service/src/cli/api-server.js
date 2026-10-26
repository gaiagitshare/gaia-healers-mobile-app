#!/usr/bin/env node
/**
 * Start the internal membership API (loopback only).
 *   MEMBERSHIP_DATABASE_URL=… [STRIPE_TEST_SECRET_KEY=rk_test_…] [MEMBERSHIP2_STAGE_CEILING=…]
 *   [MEMBERSHIP2_RETURN_ORIGINS=https://gaiahealers.app] node src/cli/api-server.js [--port 8792]
 * - binds 127.0.0.1 only (no host option); the proxy reaches it over loopback with its client token;
 * - Stripe: test-mode keys only; without a key, checkout/cancel answer PROVIDER_UNAVAILABLE;
 * - the launch flag ceiling comes from this process's environment (default OFF).
 */
import { parseArgs } from 'node:util';
import { createPool } from '../db.js';
import { createApiServer } from '../api/server.js';
import { createStripeClient } from '../providers/stripe/client.js';

const { values: a } = parseArgs({ options: { port: { type: 'string', default: '8792' } } });
const port = Number(a.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('invalid --port'); process.exit(2); }
const key = process.env.STRIPE_TEST_SECRET_KEY || '';
if (key && !/^(sk|rk)_test_/.test(key)) { console.error('REFUSED: only Stripe test-mode keys are accepted here'); process.exit(2); }
const stripe = key ? createStripeClient({ apiKey: key, fetch: globalThis.fetch, retry: { maxRetries: 1 } }) : null;
const pool = createPool();
const server = createApiServer(pool, { stripe, env: process.env });
server.listen(port, '127.0.0.1', () => console.log(`[membership-api] listening on 127.0.0.1:${port} (stripe ${stripe ? 'test mode' : 'not connected'})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
