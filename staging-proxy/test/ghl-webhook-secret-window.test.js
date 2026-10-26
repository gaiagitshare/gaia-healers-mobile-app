// Dedicated secrets set, transition window open: both the dedicated secret and
// the old fallback are accepted, and the counter tells them apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootGhlSecretServer, OLD, NEW, NEW_BACKFILL, WRONG, AUTHENTICATED, REFUSED } from './_ghl-secret-server.js';

const future = new Date(Date.now() + 7 * 864e5).toISOString();
const s = await bootGhlSecretServer({ port: 8982, env: {
  GHL_WORKFLOW_WEBHOOK_SECRET: NEW, GHL_WORKFLOW_WEBHOOK_SECRET_TRANSITION_UNTIL: future,
  GHL_BACKFILL_SECRET: NEW_BACKFILL, GHL_BACKFILL_SECRET_TRANSITION_UNTIL: future,
} });
test.after(() => s.closeServer());

test('window: member-access accepts the dedicated and the old secret', async () => {
  assert.equal(await s.memberAccess(NEW), AUTHENTICATED);
  assert.equal(await s.memberAccess(OLD), AUTHENTICATED);
});

test('window: backfill accepts its own secret and the workflow family', async () => {
  assert.equal(await s.backfill(NEW_BACKFILL), AUTHENTICATED);
  assert.equal(await s.backfill(NEW), AUTHENTICATED);
  assert.equal(await s.backfill(OLD), AUTHENTICATED);
});

test('window: a wrong secret is still refused', async () => {
  assert.equal(await s.memberAccess(WRONG), REFUSED);
  assert.equal(await s.memberAccess(NEW_BACKFILL), REFUSED, 'the backfill secret is not a workflow secret');
  assert.equal(await s.backfill(WRONG), REFUSED);
});

test('window: the counter increments per secret kind', async () => {
  const before = (await s.review(NEW)).json.secret_auth.workflow;
  await s.memberAccess(NEW);
  await s.memberAccess(OLD);
  await s.memberAccess(OLD);
  const after = (await s.review(NEW)).json.secret_auth;
  const ma = after.workflow.byRoute['member-access'];
  const maBefore = before.byRoute['member-access'];
  assert.equal(ma.dedicated, maBefore.dedicated + 1);
  assert.equal(ma.fallback, maBefore.fallback + 2);
  assert.equal(after.workflow.transitionOpen, true);
  assert.ok(after.workflow.lastFallbackAt && after.workflow.lastDedicatedAt);
  assert.equal(after.backfill.byRoute['member-backfill'].dedicated, 1);
  assert.equal(after.backfill.byRoute['member-backfill'].fallback, 2);
  const text = JSON.stringify(after) + JSON.stringify(s.telemetry());
  for (const secret of [OLD, NEW, NEW_BACKFILL]) assert.ok(!text.includes(secret));
});
