// Dedicated secrets unset (production today): the COURSES_SYNC_SECRET fallback
// authenticates every GHL workflow route, exactly as before, and is counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootGhlSecretServer, OLD, NEW, WRONG, AUTHENTICATED, REFUSED } from './_ghl-secret-server.js';

const s = await bootGhlSecretServer({ port: 8981 });
test.after(() => s.closeServer());

test('unset: fallback authenticates member-access, backfill and review', async () => {
  assert.equal(await s.memberAccess(OLD), AUTHENTICATED);
  assert.equal(await s.backfill(OLD), AUTHENTICATED);
  assert.equal((await s.review(OLD)).status, 200);
});

test('unset: a wrong secret is refused everywhere', async () => {
  assert.equal(await s.memberAccess(WRONG), REFUSED);
  assert.equal(await s.memberAccess(NEW), REFUSED);
  assert.equal(await s.backfill(WRONG), REFUSED);
  assert.equal((await s.review(WRONG)).status, 403);
});

test('unset: the counter records fallback use and exposes no secret', async () => {
  const { json } = await s.review(OLD);
  const wf = json.secret_auth.workflow;
  assert.equal(wf.dedicatedConfigured, false);
  assert.equal(wf.fallbackAccepted, true);
  assert.equal(wf.dedicated, 0);
  assert.ok(wf.fallback >= 3);
  assert.ok(wf.byRoute['member-access'].fallback >= 1);
  assert.ok(json.secret_auth.backfill.fallback >= 1);
  const text = JSON.stringify(json) + JSON.stringify(s.telemetry());
  assert.ok(!text.includes(OLD), 'no secret in diagnostics or telemetry');
});
