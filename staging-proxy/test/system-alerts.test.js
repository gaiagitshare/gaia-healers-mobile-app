/**
 * Incidents, not occurrences — and one notification, not five hundred.
 *
 * The reliability work made failures visible; this makes them arrive. The
 * property that decides whether that is useful or unbearable is deduplication:
 * a job failing every five minutes for a day is ONE problem, and an alerting
 * system that says so 288 times is one people turn off. So the tests below are
 * mostly about restraint — what does NOT get created, and what does NOT get
 * sent — with detection proved alongside it.
 *
 * Pure functions over a plain store: no server, no network, no clock tricks
 * beyond the injected `now`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detect, reconcile, notificationsDue, recordNotification, renderNotification, maskEmail,
} from '../alerts.js';

const emptyStore = () => ({ incidents: [] });
const health = (over = {}) => ({
  components: [
    { key: 'course_webhook', kind: 'webhook', state: 'idle', counters: {} },
    { key: 'membership_reconcile', kind: 'job', state: 'ok', lastSuccessAt: '2026-09-05T12:00:00Z' },
    { key: 'event_mirror', kind: 'job', state: 'ok', lastSuccessAt: '2026-09-05T12:00:00Z' },
    { key: 'event_backup', kind: 'job', state: 'ok', lastSuccessAt: '2026-09-05T01:00:00Z' },
  ].map((c) => (over[c.key] ? { ...c, ...over[c.key] } : c)),
});
const keys = (ds) => ds.map((d) => d.key).sort();

// ── Detection: each failure class, and the silence that is not one ──────────
test('an idle course webhook with no sales raises nothing', () => {
  assert.deepEqual(detect(health()), [], 'silence with nothing sold is not a fault');
});

test('course webhook auth failure raises a critical', () => {
  const d = detect(health({ course_webhook: { state: 'auth_failure', lastRejectedAt: 'x', lastRejectionReason: 'invalid_authentication' } }));
  assert.deepEqual(keys(d), ['course-webhook:auth']);
  assert.equal(d[0].severity, 'critical');
});

test('an unknown course raises a MAPPING failure, distinct from auth', () => {
  const d = detect(health({ course_webhook: { state: 'mapping_failure', lastRejectionReason: 'UNKNOWN_RESOURCE' } }));
  assert.deepEqual(keys(d), ['course-webhook:unknown-resource']);
});

test('an unresolved buyer raises an IDENTITY failure, distinct again', () => {
  const d = detect(health({ course_webhook: { state: 'identity_failure' } }));
  assert.deepEqual(keys(d), ['course-webhook:unresolved-contact']);
});

test('a failed entitlement write raises its own class — the one that loses a grant', () => {
  const d = detect(health({ course_webhook: { state: 'processing_failure', lastRejectionReason: 'persistence_failed' } }));
  assert.deepEqual(keys(d), ['course-webhook:write-failed']);
  assert.match(d[0].why, /loses a grant/);
});

test('repeated refusals with nothing accepted raise a separate incident', () => {
  const d = detect(health({ course_webhook: { state: 'auth_failure',
    counters: { rejected_auth: 7, accepted: 0 } } }));
  assert.ok(d.some((x) => x.key === 'course-webhook:repeated-failures'));
});

test('membership reconcile failure and staleness are different problems', () => {
  assert.deepEqual(keys(detect(health({ membership_reconcile: { state: 'failed', lastRunResult: 'exit-code', lastRunExitCode: 1 } }))),
    ['membership-reconcile:failure']);
  const stale = detect(health({ membership_reconcile: { state: 'stale' } }));
  assert.deepEqual(keys(stale), ['membership-reconcile:stale']);
  assert.equal(stale[0].severity, 'warning', 'stale is a warning; failing is critical');
});

test('mirror and backup failures each raise their own incident', () => {
  const d = detect(health({ event_mirror: { state: 'failed' }, event_backup: { state: 'failed', detail: 'archive missing' } }));
  assert.deepEqual(keys(d), ['event-backup:failure', 'event-mirror:failure']);
});

test('an invalid backup artifact is a failure even when the job exited cleanly', () => {
  const d = detect(health({ event_backup: { state: 'failed', lastRunResult: 'success',
    detail: 'The newest backup archive is smaller than 1 KB — it is not a usable database.',
    latestArtifactBytes: 12 } }));
  assert.deepEqual(keys(d), ['event-backup:failure']);
  assert.match(d[0].why, /1 KB|usable database/);
});

test('a paid subscription with no membership is detected, and never granted', () => {
  const d = detect(health(), { membershipExceptions: [
    { contactId: 'c1', subscriptionId: 'sub_1', status: 'active', email: 'someone@example.invalid' },
  ] });
  assert.deepEqual(keys(d), ['membership:missing:c1']);
  assert.match(d[0].why, /does not grant it automatically/);
  assert.equal(d[0].affected.label, maskEmail('someone@example.invalid'));
  assert.ok(!d[0].affected.label.startsWith('someone'), 'the address is masked');
});

test('payments raise on money without a ticket and on refunds that still admit', () => {
  const d = detect(health(), { payments: {
    graceHours: 6, paidWithoutTicket: 3, refundedStillActive: 1, unmatched: 0,
    providers: ['PayPal', 'Stripe'], oldest: '2026-09-01T00:00:00Z', sample: null,
  } });
  assert.deepEqual(keys(d), ['payments:paid-no-ticket', 'payments:refunded-active']);
  assert.match(d.find((x) => x.key === 'payments:paid-no-ticket').evidence, /PayPal/,
    'the provider is named, PayPal included');
});

// ── Deduplication: the property that makes this usable ──────────────────────
test('ten failures of one problem are ONE incident with ten occurrences', () => {
  const store = emptyStore();
  const d = detect(health({ event_backup: { state: 'failed' } }));
  for (let i = 0; i < 10; i++) reconcile(store, d);
  assert.equal(store.incidents.length, 1, 'one incident, not ten');
  assert.equal(store.incidents[0].occurrences, 10, 'and it counted all ten');
  assert.equal(store.incidents[0].key, 'event-backup:failure');
});

test('ten failures of one problem are ONE notification', () => {
  const store = emptyStore();
  const d = detect(health({ event_backup: { state: 'failed' } }));
  let sent = 0;
  for (let i = 0; i < 10; i++) {
    reconcile(store, d);
    for (const due of notificationsDue(store)) {
      recordNotification(due.incident, due.kind, { ok: true });
      sent++;
    }
  }
  assert.equal(sent, 1, 'notified once for one ongoing problem');
});

test('an unresolved incident re-notifies only after the defined interval', () => {
  const store = emptyStore();
  reconcile(store, detect(health({ event_mirror: { state: 'failed' } })));
  const inc = store.incidents[0];
  recordNotification(inc, 'opened', { ok: true }, { now: '2026-09-05T00:00:00.000Z' });

  const anHourLater = Date.parse('2026-09-05T01:00:00Z');
  assert.equal(notificationsDue(store, { now: anHourLater }).length, 0, 'silent while it stays open');

  const twoDaysLater = Date.parse('2026-09-07T00:00:00Z');
  const due = notificationsDue(store, { now: twoDaysLater });
  assert.equal(due.length, 1);
  assert.equal(due[0].kind, 'ongoing', 'and says so once more after a day, not every few minutes');
});

test('warnings never trigger an external notification', () => {
  const store = emptyStore();
  reconcile(store, detect(health({ membership_reconcile: { state: 'stale' } })));
  assert.equal(store.incidents[0].severity, 'warning');
  assert.equal(notificationsDue(store).length, 0, 'only criticals leave the building');
});

// ── Recovery ────────────────────────────────────────────────────────────────
test('when the condition recovers the incident resolves itself', () => {
  const store = emptyStore();
  reconcile(store, detect(health({ event_mirror: { state: 'failed' } })));
  assert.equal(store.incidents[0].state, 'open');

  reconcile(store, detect(health()));                     // mirror healthy again
  assert.equal(store.incidents[0].state, 'resolved');
  assert.ok(store.incidents[0].resolvedAt);
});

test('a problem that returns becomes a NEW incident, not a reopened one', () => {
  const store = emptyStore();
  const bad = detect(health({ event_mirror: { state: 'failed' } }));
  reconcile(store, bad);
  reconcile(store, detect(health()));                     // recovers
  reconcile(store, bad);                                  // and breaks again
  const mirror = store.incidents.filter((i) => i.key === 'event-mirror:failure');
  assert.equal(mirror.length, 2, 'two separate outages, not one endless record');
  assert.equal(mirror.filter((i) => i.state === 'open').length, 1);
});

test('a resolved critical produces one closing notice, then silence', () => {
  const store = emptyStore();
  reconcile(store, detect(health({ event_backup: { state: 'failed' } })));
  recordNotification(store.incidents[0], 'opened', { ok: true });
  reconcile(store, detect(health()));
  const due = notificationsDue(store);
  assert.equal(due.length, 1);
  assert.equal(due[0].kind, 'resolved');
  recordNotification(due[0].incident, 'resolved', { ok: true });
  assert.equal(notificationsDue(store).length, 0, 'and nothing further');
});

// ── Delivery is separate from detection ─────────────────────────────────────
test('a failed notification does NOT resolve or hide the incident', () => {
  const store = emptyStore();
  reconcile(store, detect(health({ event_backup: { state: 'failed' } })));
  const inc = store.incidents[0];
  recordNotification(inc, 'opened', { ok: false, reason: 'not_configured' });

  assert.equal(inc.state, 'open', 'the problem is still a problem');
  assert.equal(inc.notified.sentAt, null, 'nothing was delivered');
  assert.equal(inc.notified.lastError, 'not_configured', 'and the failure is recorded');
  assert.equal(notificationsDue(store).length, 1, 'so it remains due — a lost email is not a delivered one');
});

test('acknowledging does not stop the condition being evaluated', () => {
  const store = emptyStore();
  const bad = detect(health({ event_mirror: { state: 'failed' } }));
  reconcile(store, bad);
  store.incidents[0].state = 'acknowledged';
  reconcile(store, bad);
  assert.equal(store.incidents.length, 1, 'still one incident');
  assert.equal(store.incidents[0].occurrences, 2, 'still counting');
  reconcile(store, detect(health()));
  assert.equal(store.incidents[0].state, 'resolved', 'and it can still resolve on its own');
});

// ── What leaves the building ────────────────────────────────────────────────
test('a notification carries enough to act on and no payload, id or secret', () => {
  const store = emptyStore();
  reconcile(store, detect(health(), { membershipExceptions: [
    // A subscription id is a reference an operator needs in order to trace the
    // alert — the same class of thing as an event id, and deliberately kept.
    // The assertion below is about credentials, so the fixture must not use a
    // business id that merely looks like one.
    { contactId: 'ghl-abc-123', subscriptionId: 'sub_9f2c', status: 'active', email: 'buyer@example.invalid' },
  ] }));
  const msg = renderNotification(store.incidents[0], 'opened');
  assert.match(msg.subject, /Gaia/);
  assert.match(msg.text, /Paid subscription with no membership/);
  assert.match(msg.text, /bu\*+@example\.invalid/, 'the address is masked');
  assert.ok(!msg.text.includes('buyer@example.invalid'), 'never the raw address');
  assert.ok(!msg.text.includes('ghl-abc-123'), 'never the raw contact id');
  assert.ok(!/signature|x-webhook|token|Bearer|password/i.test(msg.text), 'never a credential');
  assert.ok(!/\b\+?\d{10,}\b/.test(msg.text), 'never a phone number');
  assert.ok(msg.text.includes('sub_9f2c'), 'but the subscription reference IS kept — it is how you trace it');
});

// ── The complete off-site backup ────────────────────────────────────────────
// The failure this guards against is the comfortable one: a green backup light
// over an archive that never left the machine, or that cannot be read back.
// `health()` only overlays components it already lists, so this one is added.
const backupHealth = (over) => {
  const h = health();
  h.components.push({ key: 'full_backup', kind: 'job', ...over });
  return h;
};

test('a verified off-site backup raises nothing', () => {
  const d = detect(backupHealth({
    state: 'ok', encryptionConfigured: true, offsiteConfigured: true,
    lastSuccessAt: '2026-09-05T02:04:00Z',
  }));
  assert.deepEqual(keys(d), [], 'a backup that reached the far end is not an incident');
});

test('a backup that never leaves the server is critical, not OK', () => {
  const d = detect(backupHealth({
    state: 'degraded', encryptionConfigured: false, offsiteConfigured: false,
    localNewest: 'gaia-production-2026-09-05.tar.gz',
  }));
  assert.deepEqual(keys(d), ['backup:no-offsite']);
  assert.equal(d[0].severity, 'critical');
  assert.match(d[0].why, /only on the machine it protects|stored only on the machine/);
});

test('each backup failure stage names its own distinct incident', () => {
  const stages = {
    sqlite_snapshot: 'backup:snapshot-failed',
    sqlite_integrity: 'backup:database-corrupt',
    collect_state: 'backup:state-unreadable',
    archive: 'backup:archive-failed',
    verify_gzip: 'backup:archive-unreadable',
    verify_listing: 'backup:archive-incomplete',
    verify_database_in_archive: 'backup:archive-database-bad',
    encrypt: 'backup:encryption-failed',
    upload: 'backup:upload-failed',
    verify_remote: 'backup:remote-verify-failed',
  };
  for (const [stage, key] of Object.entries(stages)) {
    const d = detect(backupHealth({
      state: 'failed', lastFailureStage: stage, lastFailureReason: 'reason recorded',
      encryptionConfigured: true, offsiteConfigured: true,
    }));
    assert.deepEqual(keys(d), [key], `${stage} should raise ${key}`);
    assert.equal(d[0].severity, 'critical');
  }
});

test('an unrecognised failure stage still raises, rather than passing silently', () => {
  const d = detect(backupHealth({
    state: 'failed', lastFailureStage: 'something_new', encryptionConfigured: true, offsiteConfigured: true,
  }));
  assert.deepEqual(keys(d), ['backup:failure']);
});

test('a backup gone quiet is a warning, and yesterday is still protected', () => {
  const d = detect(backupHealth({
    state: 'stale', encryptionConfigured: true, offsiteConfigured: true,
    lastSuccessAt: '2026-09-02T02:00:00Z',
  }));
  assert.deepEqual(keys(d), ['backup:stale']);
  assert.equal(d[0].severity, 'warning');
});

test('a failing backup is one incident however many nights it fails', () => {
  const store = emptyStore();
  const failing = backupHealth({
    state: 'failed', lastFailureStage: 'upload', lastFailureReason: 'destination unreachable',
    encryptionConfigured: true, offsiteConfigured: true,
  });
  for (let night = 0; night < 5; night += 1) reconcile(store, detect(failing));
  assert.equal(store.incidents.length, 1, 'five failed nights are one problem');
  assert.equal(store.incidents[0].key, 'backup:upload-failed');
});

test('a backup incident carries no credential, path secret or environment value', () => {
  const store = emptyStore();
  reconcile(store, detect(backupHealth({
    state: 'failed', lastFailureStage: 'upload',
    lastFailureReason: 'the upload to the off-site destination did not complete',
    encryptionConfigured: true, offsiteConfigured: true,
  })));
  const msg = renderNotification(store.incidents[0], 'opened');
  assert.ok(!/access[_-]?key|secret|token|password|R2_|rclone\.conf/i.test(msg.text),
    'a backup alert must never quote what it uses to authenticate');
});
