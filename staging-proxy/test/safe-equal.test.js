/**
 * safeEqual: constant-time comparison of shared secrets and service tokens.
 *
 * Unit tests for the helper, plus a source tripwire: the files that check an
 * inbound secret must not go back to `===` / `!==` (which stops at the first
 * differing byte), nor to the hand-rolled `a.length === b.length &&
 * timingSafeEqual` (which leaks the secret's length).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeEqual } from '../safe-equal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('equal secrets match, anything else does not', () => {
  const s = 'fictional-secret-0123456789abcdef0123456789';
  assert.equal(safeEqual(s, s), true);
  assert.equal(safeEqual(s.slice(0, -1) + 'X', s), false);
  assert.equal(safeEqual(s.slice(0, -1), s), false, 'a prefix is not a match');
  assert.equal(safeEqual(s + 'x', s), false, 'a longer value is not a match');
  assert.equal(safeEqual('', s), false);
  assert.equal(safeEqual(undefined, s), false);
  assert.equal(safeEqual(null, s), false);
});

test('different lengths never throw', () => {
  assert.doesNotThrow(() => safeEqual('a', 'a much longer configured secret'));
  assert.doesNotThrow(() => safeEqual('x'.repeat(10_000), 'short'));
});

test('an empty or missing expected secret never matches', () => {
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual('anything', ''), false);
  assert.equal(safeEqual('', undefined), false);
  assert.equal(safeEqual(undefined, undefined), false);
  assert.equal(safeEqual('null', null), false);
});

test('compares by UTF-8 content, non-strings are stringified', () => {
  assert.equal(safeEqual('café-ключ', 'café-ключ'), true);
  assert.equal(safeEqual('cafe-ключ', 'café-ключ'), false);
  assert.equal(safeEqual(12345, '12345'), true);
});

// ---------- source tripwire ----------
const FILES = ['server.js', 'admin-router.js', 'member-link.js', 'membership/fixture-gate.js'];
const SECRET_NAMES = [
  'IDENTITY_SERVICE_TOKEN', 'COURSES_SYNC_SECRET', 'GHL_WORKFLOW_WEBHOOK_SECRET', 'GHL_BACKFILL_SECRET',
  'ACADEMY_SYNC_SECRET', 'REGISTRATION_WEBHOOK_SECRET', 'AUTH_EMBED_SHARED_SECRET', 'APP_PROXY_SHARED_SECRET',
  'GAIA_ADMIN_PASSWORD', 'GAIA_PRACTITIONERS_LINK_SECRET', 'MEMBERSHIP_FIXTURE_KEY',
];
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('no ===/!== comparison against a secret env name in the fixed files', () => {
  const names = SECRET_NAMES.join('|');
  const re = new RegExp(`(?:[!=]==?)\\s*(?:process\\.)?(?:env\\.)?(?:${names})\\b|\\b(?:${names})\\b\\s*\\)?\\s*[!=]==?(?!=)`, 'g');
  for (const f of FILES) {
    const hits = (src(f).match(re) || []);
    assert.deepEqual(hits, [], `${f} compares a secret with ===/!==`);
  }
});

test('the service-token routes compare via safeEqual, not !==', () => {
  const s = src('server.js');
  assert.ok(!/auth\s*!==\s*svc/.test(s), 'ghl-sales / notify must not use auth !== svc');
  assert.ok((s.match(/!safeEqual\(auth, svc\)/g) || []).length >= 2);
});

test('no hand-rolled length-check + timingSafeEqual left in the fixed files', () => {
  for (const f of FILES) {
    let s = src(f);
    // verifyEventBearer (admin-router.js) is owned by another open change; it
    // compares an HMAC of fixed length, so it leaks nothing secret-dependent.
    if (f === 'admin-router.js') s = s.replace(/function verifyEventBearer[\s\S]*?\n}\n/, '');
    assert.ok(!/timingSafeEqual/.test(s), `${f} should call safeEqual instead of timingSafeEqual`);
  }
});
