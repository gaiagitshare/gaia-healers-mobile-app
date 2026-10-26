// Dedicated secrets set, transition window over: only the dedicated secret is
// accepted; COURSES_SYNC_SECRET no longer opens the GHL workflow routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootGhlSecretServer, OLD, NEW, NEW_BACKFILL, WRONG, AUTHENTICATED, REFUSED } from './_ghl-secret-server.js';

const past = '2026-01-01T00:00:00Z';
const s = await bootGhlSecretServer({ port: 8983, env: {
  GHL_WORKFLOW_WEBHOOK_SECRET: NEW, GHL_WORKFLOW_WEBHOOK_SECRET_TRANSITION_UNTIL: past,
  GHL_BACKFILL_SECRET: NEW_BACKFILL, GHL_BACKFILL_SECRET_TRANSITION_UNTIL: past,
} });
test.after(() => s.closeServer());

test('expired: only the dedicated secret opens member-access and review', async () => {
  assert.equal(await s.memberAccess(NEW), AUTHENTICATED);
  assert.equal(await s.memberAccess(OLD), REFUSED);
  assert.equal((await s.review(OLD)).status, 403);
  assert.equal((await s.review(NEW)).status, 200);
});

test('expired: only the backfill secret opens backfill', async () => {
  assert.equal(await s.backfill(NEW_BACKFILL), AUTHENTICATED);
  assert.equal(await s.backfill(NEW), REFUSED);
  assert.equal(await s.backfill(OLD), REFUSED);
});

test('expired: wrong secrets refused, fallback counter stays at zero', async () => {
  assert.equal(await s.memberAccess(WRONG), REFUSED);
  assert.equal(await s.backfill(WRONG), REFUSED);
  const { json } = await s.review(NEW);
  assert.equal(json.secret_auth.workflow.fallback, 0);
  assert.equal(json.secret_auth.workflow.fallbackAccepted, false);
  assert.equal(json.secret_auth.backfill.fallback, 0);
  assert.ok(json.secret_auth.workflow.dedicated >= 2);
});
