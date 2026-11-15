// Quieter alerts (15 Nov 2026): blips that heal within the grace send nothing,
// buyer-matching problems remind every three days, and a flapping warning can
// no longer push real incidents out of the history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detect, reconcile, notificationsDue, recordNotification, pruneIncidents, NOTIFY_GRACE_MS } from '../alerts.js';

const health = (over = {}) => ({
  components: [
    { key: 'course_webhook', kind: 'webhook', state: 'idle', counters: {} },
    { key: 'membership_reconcile', kind: 'job', state: 'ok', lastSuccessAt: '2026-11-15T12:00:00Z' },
    { key: 'event_mirror', kind: 'job', state: 'ok', lastSuccessAt: '2026-11-15T12:00:00Z' },
  ].map((c) => (over[c.key] ? { ...c, ...over[c.key] } : c)),
});
const T0 = '2026-11-15T10:00:00.000Z';
const at = (min) => Date.parse(T0) + min * 60000;
const iso = (min) => new Date(at(min)).toISOString();

test('a blip that heals inside the grace sends no CRITICAL and no RESOLVED', () => {
  const store = { incidents: [] };
  reconcile(store, detect(health({ membership_reconcile: { state: 'failed' } })), { now: T0 });
  assert.equal(notificationsDue(store, { now: at(5) }).length, 0, 'not yet: may be a blip');
  reconcile(store, detect(health()), { now: iso(5) });
  assert.equal(store.incidents[0].state, 'resolved');
  assert.equal(notificationsDue(store, { now: at(6) }).length, 0, 'never announced, so no resolved notice');
});

test('a problem still open after the grace is announced once, then resolved once', () => {
  const store = { incidents: [] };
  const bad = detect(health({ event_mirror: { state: 'failed' } }));
  reconcile(store, bad, { now: T0 });
  reconcile(store, bad, { now: iso(NOTIFY_GRACE_MS / 60000) });
  const due = notificationsDue(store, { now: at(NOTIFY_GRACE_MS / 60000) });
  assert.deepEqual(due.map((d) => d.kind), ['opened']);
  recordNotification(due[0].incident, 'opened', { ok: true }, { now: iso(20) });
  reconcile(store, detect(health()), { now: iso(30) });
  assert.deepEqual(notificationsDue(store, { now: at(31) }).map((d) => d.kind), ['resolved']);
});

test('an unidentified course buyer is reminded every three days, not daily', () => {
  const store = { incidents: [] };
  reconcile(store, detect(health({ course_webhook: { state: 'identity_failure', lastRejectedAt: 'x', lastRejectionReason: 'y' } })), { now: T0 });
  const inc = store.incidents[0];
  assert.equal(inc.key, 'course-webhook:unresolved-contact');
  recordNotification(inc, 'opened', { ok: true }, { now: T0 });
  assert.equal(notificationsDue(store, { now: at(2 * 1440) }).length, 0, 'quiet after two days');
  assert.deepEqual(notificationsDue(store, { now: at(3 * 1440) }).map((d) => d.kind), ['ongoing']);
});

test('other critical problems still remind daily', () => {
  const store = { incidents: [] };
  reconcile(store, detect(health({ event_mirror: { state: 'failed' } })), { now: T0 });
  recordNotification(store.incidents[0], 'opened', { ok: true }, { now: T0 });
  assert.deepEqual(notificationsDue(store, { now: at(1440) }).map((d) => d.kind), ['ongoing']);
});

test('a flapping warning cannot push critical or open incidents out of the history', () => {
  const crit = Array.from({ length: 5 }, (_, i) => ({ key: 'event-mirror:failure', severity: 'critical', state: 'resolved', lastDetectedAt: iso(i) }));
  const open = { key: 'payments:paid-no-ticket', severity: 'critical', state: 'open', lastDetectedAt: iso(1) };
  const flap = Array.from({ length: 900 }, (_, i) => ({ key: 'academy-access:drift', severity: 'warning', state: 'resolved', lastDetectedAt: iso(100 + i) }));
  const kept = pruneIncidents([...crit, open, ...flap]);
  assert.equal(kept.filter((i) => i.severity === 'critical').length, 6, 'all critical kept');
  assert.equal(kept.filter((i) => i.key === 'academy-access:drift').length, 20, 'flapping key trimmed to its newest 20');
  assert.ok(kept.length <= 500);
  assert.equal(kept[0].key, 'academy-access:drift', 'still newest first');
});
