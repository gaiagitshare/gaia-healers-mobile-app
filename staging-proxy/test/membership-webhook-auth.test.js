/**
 * Webhook authentication — Ed25519 and the shared secret.
 *
 * A real GHL key cannot be used to *sign* a test (we do not have its private
 * half), so the mechanism is proven with a locally generated Ed25519 pair, and
 * the real published key is checked separately for correct parsing. That
 * distinction matters: it proves the receiver verifies signatures correctly
 * without pretending we have observed a signed GHL delivery.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SECRET = 'auth-secret-'.padEnd(48, 'a');

// A throwaway pair standing in for the platform's signing key.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-auth-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
const storeFile = path.join(workdir, 'data', 'member-entitlements.json');
process.chdir(workdir);

const PORT = 8904;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: storeFile,
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  // configured exactly as GHL publishes it: bare base64 DER, no PEM wrapper
  GHL_WEBHOOK_ED25519_PUBLIC_KEY: publicDer,
});

await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));

const url = `http://127.0.0.1:${PORT}/api/webhooks/ghl/member-access`;
const send = async (body, headers) => {
  const raw = JSON.stringify(body);
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const sign = (body) => crypto.sign(null, Buffer.from(JSON.stringify(body), 'utf8'), privateKey).toString('base64');

let n = 0;
const event = () => ({
  type: 'course_access_granted', contactId: 'synthetic-auth-1',
  courseId: `auth-course-${++n}`, courseName: 'Auth Course',
  timestamp: '2026-08-17T10:00:00Z', webhookId: `auth-ev-${n}`,
});

test('bare base64 DER public key is accepted and used to verify', async () => {
  const body = event();
  const res = await send(body, { 'x-ghl-signature': sign(body) });
  assert.equal(res.status, 200);
  assert.equal(res.json.applied, true, 'a correctly signed delivery is accepted with no shared secret at all');
});

test('a hex-encoded signature is also accepted', async () => {
  const body = event();
  const hex = crypto.sign(null, Buffer.from(JSON.stringify(body), 'utf8'), privateKey).toString('hex');
  const res = await send(body, { 'x-ghl-signature': hex });
  assert.equal(res.json.applied, true);
});

test('a tampered body fails verification', async () => {
  const body = event();
  const signature = sign(body);
  const tampered = { ...body, contactId: 'someone-else' };
  const res = await send(tampered, { 'x-ghl-signature': signature });
  assert.equal(res.status, 403, 'signature must cover the body');
});

test('a garbage signature does not authenticate on its own', async () => {
  const res = await send(event(), { 'x-ghl-signature': Buffer.from('nonsense').toString('base64') });
  assert.equal(res.status, 403);
});

test('an unverifiable signature still falls back to the shared secret (non-strict default)', async () => {
  const body = event();
  const res = await send(body, {
    'x-ghl-signature': Buffer.from('nonsense').toString('base64'),
    'x-webhook-secret': SECRET,
  });
  assert.equal(res.status, 200,
    'a workflow that adds an unrecognised signature must not lose its secret-authenticated path');
  assert.equal(res.json.applied, true);
});

test('the shared secret alone still works — no weakening', async () => {
  const res = await send(event(), { 'x-webhook-secret': SECRET });
  assert.equal(res.status, 200);
  assert.equal(res.json.applied, true);
});

test('no credentials at all is still rejected', async () => {
  const res = await send(event(), {});
  assert.equal(res.status, 403);
});

test("GHL's published public key parses as a usable Ed25519 key", () => {
  // From the HighLevel webhook integration guide. Parsing it proves the
  // receiver would accept the real key; it does NOT prove GHL signs the
  // Workflow Webhook action, which only an observed delivery can establish.
  const published = 'MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=';
  const pem = `-----BEGIN PUBLIC KEY-----\n${published}\n-----END PUBLIC KEY-----\n`;
  const key = crypto.createPublicKey(pem);
  assert.equal(key.asymmetricKeyType, 'ed25519');
  // and a signature from a different key must not verify against it
  const bogus = crypto.sign(null, Buffer.from('x'), privateKey);
  assert.equal(crypto.verify(null, Buffer.from('x'), key, bogus), false);
});

// The proxy holds a listener open; the runner uses --test-force-exit.

// ── sign-in observability ───────────────────────────────────────────────────
test('every magic-link outcome is logged, and no email address is written to the log', async () => {
  // Production had zero evidence either way about whether sign-in links were
  // ever delivered: success logged nothing, so "users cannot log in" was
  // undiagnosable from the server side.
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('async function authMagicLinkRequest'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  for (const outcome of ['no_member_for_email', 'sent', 'delivery_failed', 'no_contact_to_email']) {
    assert.ok(body.includes(`'${outcome}'`), `the ${outcome} path must be logged`);
  }
  // The response stays identical whatever happened — the log is where the
  // difference lives, not the reply.
  assert.ok(body.includes('genericResponse'), 'the caller is told the same thing either way');
  // and the address itself is hashed rather than printed
  assert.ok(/createHash\('sha256'\)\.update\(email\)/.test(body),
    'the email must be hashed into a trace id, never logged in the clear');
  assert.ok(!/console\.log\([^)]*\bemail\b[^)]*\)/.test(body), 'no raw email in a log call');
});
