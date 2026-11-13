/**
 * Unit matrix for the dedicated-secret families (ghl-webhook-secret.js).
 * The server wiring is covered by ghl-webhook-secret-{unset,window,expired}.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createSecretFamily, recordSecretAuth, parseTransitionUntil } from '../ghl-webhook-secret.js';

const OLD = 'o'.repeat(48);
const NEW = 'n'.repeat(48);
const WRONG = 'x'.repeat(48);
const T0 = Date.parse('2026-11-01T00:00:00Z');
let compares = 0;
const compare = (a, b) => {
  compares += 1;
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const legacyCheck = (v) => compare(v, OLD);
const fam = (dedicated, transitionUntil, now = T0) =>
  createSecretFamily({ dedicated, legacyCheck, transitionUntil, compare, now: () => now });

test('unset: the old fallback works exactly as before', () => {
  const f = fam('', '2030-01-01');
  assert.equal(f.check(OLD), 'fallback');
  assert.equal(f.check(NEW), '');
  assert.equal(f.describe().fallbackAccepted, true);
  assert.equal(f.describe().dedicatedConfigured, false);
});

test('set, inside the window: dedicated and fallback are both accepted', () => {
  const f = fam(NEW, '2026-12-01T00:00:00Z');
  assert.equal(f.check(NEW), 'dedicated');
  assert.equal(f.check(OLD), 'fallback');
  assert.equal(f.describe().transitionOpen, true);
});

test('set, after the window: only the dedicated secret is accepted', () => {
  const f = fam(NEW, '2026-10-01T00:00:00Z');
  assert.equal(f.check(NEW), 'dedicated');
  assert.equal(f.check(OLD), '');
  assert.equal(f.describe().fallbackAccepted, false);
});

test('the window closes on its own while the process keeps running', () => {
  let now = T0;
  const f = createSecretFamily({ dedicated: NEW, legacyCheck, transitionUntil: '2026-11-02T00:00:00Z', compare, now: () => now });
  assert.equal(f.check(OLD), 'fallback');
  now = Date.parse('2026-11-02T00:00:01Z');
  assert.equal(f.check(OLD), '');
  assert.equal(f.check(NEW), 'dedicated');
});

test('set with no or an invalid transition date: fallback is not accepted', () => {
  assert.equal(fam(NEW, '').check(OLD), '');
  const bad = fam(NEW, 'next tuesday');
  assert.equal(bad.check(OLD), '');
  assert.equal(bad.invalidTransition, true);
  assert.equal(parseTransitionUntil('not a date'), null);
});

test('a wrong or empty secret is always refused', () => {
  for (const f of [fam('', ''), fam(NEW, '2030-01-01'), fam(NEW, '2020-01-01')]) {
    assert.equal(f.check(WRONG), '');
    assert.equal(f.check(''), '');
    assert.equal(f.check(undefined), '');
    assert.equal(f.check(NEW.slice(0, 40)), '');
  }
});

test('a dedicated secret shorter than 32 characters is never accepted', () => {
  const f = fam('short', '');
  assert.equal(f.usable, false);
  assert.equal(f.check('short'), '');
});

test('the injected constant-time compare is the one used', () => {
  const before = compares;
  fam(NEW, '2030-01-01').check(OLD);
  assert.ok(compares > before);
});

test('counter increments by family and route and never holds a secret', () => {
  const all = {};
  recordSecretAuth(all, 'workflow', 'member-access', 'dedicated', 'A');
  recordSecretAuth(all, 'workflow', 'member-access', 'fallback', 'B');
  recordSecretAuth(all, 'workflow', 'member-access', 'dedicated', 'C');
  recordSecretAuth(all, 'backfill', 'member-backfill', 'fallback', 'D');
  recordSecretAuth(all, 'workflow', 'member-access', '', 'E'); // refusals are not counted here
  assert.equal(all.secret_auth.workflow.dedicated, 2);
  assert.equal(all.secret_auth.workflow.fallback, 1);
  assert.equal(all.secret_auth.workflow.lastDedicatedAt, 'C');
  assert.equal(all.secret_auth.workflow.byRoute['member-access'].fallback, 1);
  assert.equal(all.secret_auth.backfill.fallback, 1);
  const text = JSON.stringify(all) + JSON.stringify(fam(NEW, '2030-01-01').describe());
  assert.ok(!text.includes(NEW) && !text.includes(OLD));
});
