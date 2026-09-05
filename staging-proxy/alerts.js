/**
 * System alerts — turning health evidence into incidents somebody will notice.
 *
 * The reliability work before this made every failure *visible*. It did not make
 * any of them *arrive*: a stopped pipeline announced itself only to whoever
 * happened to open System Map. This module closes that, and the shape it takes
 * is deliberate.
 *
 * An INCIDENT is a problem, not an occurrence. The same job failing every five
 * minutes for a day is one incident with 288 occurrences — never 288 alerts and
 * never 288 emails. That is what `key` is for: a stable string like
 * `event-backup:failure` that identifies the PROBLEM, so a repeat updates the
 * open record rather than creating another.
 *
 * Detection is separate from delivery on purpose. An incident is real whether or
 * not an email went out, so `notified` is tracked beside the incident and a
 * delivery failure never resolves anything or suppresses the record.
 *
 * Nothing here decides that silence is a problem. The course webhook is idle
 * because no course has sold; that is not a fault and does not alert.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const SEVERITIES = ['critical', 'warning', 'info'];
export const STATES = ['open', 'acknowledged', 'resolved'];

const nowIso = () => new Date().toISOString();
const ageMs = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? Date.now() - t : null; };

/** Masked for anything that leaves Gaia. Enough to act on, not enough to leak. */
export function maskEmail(email = '') {
  const [user = '', domain = ''] = String(email).split('@');
  if (!domain) return '';
  const head = user.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

/**
 * Read the health payload and say what is wrong.
 *
 * Returns detections, not incidents: this function has no memory and no side
 * effects, so it can be tested against a health object directly.
 */
export function detect(health, extra = {}) {
  const out = [];
  const byKey = {};
  for (const c of (health && health.components) || []) byKey[c.key] = c;
  const add = (d) => out.push(d);

  // ── Course access ────────────────────────────────────────────────────────
  // Idle is NOT a fault: no course has sold, so nothing arrives. Only an actual
  // refusal or a failed write is a problem.
  const cw = byKey.course_webhook;
  if (cw) {
    if (cw.state === 'auth_failure') {
      add({ key: 'course-webhook:auth', severity: 'critical', subsystem: 'Course access',
        title: 'Course webhook authentication is failing',
        why: 'A delivery reached Gaia but its signature or shared secret did not verify, so nothing was granted. A real buyer would not receive their course.',
        evidence: `last rejection ${cw.lastRejectedAt || 'unknown'} · reason ${cw.lastRejectionReason || 'unrecorded'}`,
        affected: null });
    }
    if (cw.state === 'mapping_failure') {
      add({ key: 'course-webhook:unknown-resource', severity: 'critical', subsystem: 'Course access',
        title: 'A purchased course could not be resolved',
        why: 'An authenticated delivery named a course or product Gaia does not recognise, so no access was granted. The catalogue or the offer mapping is behind.',
        evidence: `last rejection ${cw.lastRejectedAt || 'unknown'} · reason ${cw.lastRejectionReason || 'unrecorded'}`,
        affected: null });
    }
    if (cw.state === 'identity_failure') {
      add({ key: 'course-webhook:unresolved-contact', severity: 'critical', subsystem: 'Course access',
        title: 'A course was bought by somebody Gaia could not identify',
        why: 'The course was valid but no contact could be resolved safely, so nothing was granted. Gaia will not guess who a purchase belongs to.',
        evidence: `last rejection ${cw.lastRejectedAt || 'unknown'}`,
        affected: null });
    }
    if (cw.state === 'processing_failure') {
      add({ key: 'course-webhook:write-failed', severity: 'critical', subsystem: 'Course access',
        title: 'A valid course grant could not be written',
        why: 'Authentication, catalogue and identity all succeeded and the ledger write failed. This is the one failure class that loses a grant outright.',
        evidence: `last rejection ${cw.lastRejectedAt || 'unknown'} · reason ${cw.lastRejectionReason || 'unrecorded'}`,
        affected: null });
    }
    // Repeated refusals, whatever the class, when nothing is getting through.
    const co = cw.counters || {};
    const refused = (co.rejected_auth || 0) + (co.unknown_resource || 0)
      + (co.unknown_contact || 0) + (co.rejected_other || 0);
    if (refused >= 5 && (co.accepted || 0) === 0) {
      add({ key: 'course-webhook:repeated-failures', severity: 'critical', subsystem: 'Course access',
        title: `${refused} course deliveries refused and none accepted`,
        why: 'Every delivery this monitor has seen was refused. The pipeline is reachable and nothing is getting through it.',
        evidence: `refused ${refused} · accepted ${co.accepted || 0} · since ${cw.telemetrySince || 'unknown'}`,
        affected: null });
    }
  }

  // ── Membership ───────────────────────────────────────────────────────────
  const mr = byKey.membership_reconcile;
  if (mr) {
    if (mr.state === 'failed') {
      add({ key: 'membership-reconcile:failure', severity: 'critical', subsystem: 'Membership',
        title: 'Membership reconciliation is failing',
        why: 'The sweep that turns GHL subscriptions into verified memberships exited with an error. New paid members will not be recognised while this continues.',
        evidence: `result ${mr.lastRunResult || '?'}${mr.lastRunExitCode != null ? ` (exit ${mr.lastRunExitCode})` : ''} at ${mr.lastRunAt || 'unknown'}`,
        affected: null });
    } else if (mr.state === 'stale') {
      add({ key: 'membership-reconcile:stale', severity: 'warning', subsystem: 'Membership',
        title: 'Membership reconciliation has stopped running',
        why: 'The sweep runs every few minutes and has not completed recently. A new subscription would not become a membership.',
        evidence: `last success ${mr.lastSuccessAt || 'never observed'}`,
        affected: null });
    }
  }

  // A sweep can exit cleanly and still skip somebody. This compares live paid
  // subscriptions against the ledger and names anyone paying without a
  // membership record — evidence of a gap, never an instruction to grant one.
  for (const m of (extra.membershipExceptions || [])) {
    add({ key: `membership:missing:${m.contactId}`, severity: 'warning', subsystem: 'Membership',
      title: 'Paid subscription with no membership record',
      why: 'An active subscription exists in GHL billing and the ledger holds no membership for that person. They may be paying without access. Gaia does not grant it automatically — the evidence needs a human.',
      evidence: `subscription ${m.subscriptionId || 'unknown'} · status ${m.status || '?'}`
        + (m.amount != null ? ` · ${m.amount}` : ''),
      affected: { kind: 'contact', id: m.contactId, label: maskEmail(m.email || '') || m.contactId } });
  }

  // ── Event mirror ─────────────────────────────────────────────────────────
  const em = byKey.event_mirror;
  if (em) {
    if (em.state === 'failed') {
      add({ key: 'event-mirror:failure', severity: 'critical', subsystem: 'Events',
        title: 'Event order mirror is failing',
        why: 'The hourly recovery pass that catches orders the webhook missed is exiting with an error. A missed ticket sale would stay missed.',
        evidence: `result ${em.lastRunResult || '?'}${em.lastRunExitCode != null ? ` (exit ${em.lastRunExitCode})` : ''} at ${em.lastRunAt || 'unknown'}`,
        affected: null });
    } else if (em.state === 'stale') {
      add({ key: 'event-mirror:stale', severity: 'warning', subsystem: 'Events',
        title: 'Event order mirror has stopped running',
        why: 'It should complete hourly. While it is stopped, only the live webhook is reconciling orders — nothing is catching what that misses.',
        evidence: `last success ${em.lastSuccessAt || 'never observed'}`,
        affected: null });
    }
  }

  // ── Event backup ─────────────────────────────────────────────────────────
  const eb = byKey.event_backup;
  if (eb) {
    if (eb.state === 'failed') {
      add({ key: 'event-backup:failure', severity: 'critical', subsystem: 'Backups',
        title: 'Event database backup is failing',
        why: eb.detail || 'The backup job failed or produced no usable archive. Restore capability is untested regardless, so a gap here is unrecoverable data.',
        evidence: `result ${eb.lastRunResult || '?'} · newest archive ${eb.latestArtifact || 'none'}${eb.latestArtifactBytes != null ? ` (${eb.latestArtifactBytes} bytes)` : ''}`,
        affected: null });
    } else if (eb.state === 'stale') {
      add({ key: 'event-backup:stale', severity: 'warning', subsystem: 'Backups',
        title: 'No fresh event backup',
        why: 'The daily snapshot has not produced a new archive. Yesterday’s data is still held, today’s is not.',
        evidence: `newest archive ${eb.latestArtifactAt || 'unknown'} · last success ${eb.lastSuccessAt || 'never observed'}`,
        affected: null });
    }
  }

  // ── Payments ─────────────────────────────────────────────────────────────
  // Money arriving and a ticket existing are separate facts; the alert is for
  // where they disagree past a grace period, not for every pending checkout.
  const pay = extra.payments || null;
  if (pay) {
    if (pay.paidWithoutTicket > 0) {
      add({ key: 'payments:paid-no-ticket', severity: 'critical', subsystem: 'Payments',
        title: `${pay.paidWithoutTicket} paid ${pay.paidWithoutTicket === 1 ? 'person has' : 'people have'} no ticket`,
        why: `Money was received more than ${pay.graceHours}h ago and no attendee record exists. These people cannot get in.`,
        evidence: `providers ${(pay.providers || []).join(', ') || 'unknown'} · oldest ${pay.oldest || 'unknown'}`,
        affected: pay.sample ? { kind: 'contact', id: pay.sample.id, label: maskEmail(pay.sample.email || '') } : null });
    }
    if (pay.refundedStillActive > 0) {
      add({ key: 'payments:refunded-active', severity: 'critical', subsystem: 'Payments',
        title: `${pay.refundedStillActive} refunded ${pay.refundedStillActive === 1 ? 'ticket is' : 'tickets are'} still valid`,
        why: 'A payment was reversed and the attendee can still be admitted. This is access somebody has stopped paying for.',
        evidence: `refunded payments with a live ticket: ${pay.refundedStillActive}`,
        affected: null });
    }
    if (pay.unmatched > 0) {
      add({ key: 'payments:unmatched', severity: 'warning', subsystem: 'Payments',
        title: `${pay.unmatched} payment${pay.unmatched === 1 ? '' : 's'} could not be matched to a product`,
        why: 'A provider event arrived that Gaia could not resolve to a mapped product, so it reconciled to nothing.',
        evidence: `unmatched payment events: ${pay.unmatched}`,
        affected: null });
    }
  }

  return out;
}

/**
 * Fold detections into the stored incidents.
 *
 * The rules that matter:
 *  - a detection whose key is already open UPDATES it (lastDetectedAt, occurrences)
 *  - an open incident whose key is no longer detected RESOLVES automatically
 *  - a resolved incident that recurs becomes a NEW incident, so the history of
 *    "it broke again" is not flattened into one endless record
 */
export function reconcile(store, detections, { now = nowIso() } = {}) {
  const incidents = Array.isArray(store.incidents) ? store.incidents : [];
  const detectedKeys = new Set(detections.map((d) => d.key));
  const opened = [], resolved = [], updated = [];

  for (const d of detections) {
    const existing = incidents.find((i) => i.key === d.key && i.state !== 'resolved');
    if (existing) {
      existing.lastDetectedAt = now;
      existing.occurrences = (existing.occurrences || 1) + 1;
      // Keep the newest wording and evidence; the problem may have moved on.
      existing.title = d.title; existing.why = d.why;
      existing.evidence = d.evidence; existing.severity = d.severity;
      if (d.affected) existing.affected = d.affected;
      updated.push(existing);
    } else {
      const inc = {
        id: `inc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        key: d.key, severity: d.severity, subsystem: d.subsystem,
        title: d.title, why: d.why, evidence: d.evidence, affected: d.affected || null,
        state: 'open', firstDetectedAt: now, lastDetectedAt: now, occurrences: 1,
        acknowledgedAt: null, resolvedAt: null,
        notified: { sentAt: null, attempts: 0, lastError: null, lastAttemptAt: null, resolvedNoticeAt: null },
      };
      incidents.push(inc);
      opened.push(inc);
    }
  }

  for (const inc of incidents) {
    if (inc.state !== 'resolved' && !detectedKeys.has(inc.key)) {
      inc.state = 'resolved';
      inc.resolvedAt = now;
      resolved.push(inc);
    }
  }

  // Keep the record bounded without losing anything current.
  store.incidents = incidents
    .sort((a, b) => String(b.lastDetectedAt).localeCompare(String(a.lastDetectedAt)))
    .slice(0, 500);
  store.updatedAt = now;
  return { opened, updated, resolved, store };
}

/**
 * Which incidents warrant an external message right now.
 *
 * One notification when a critical incident opens. Silence while it stays open,
 * however many times it recurs — that is the whole point of the incident model.
 * A re-notification only after a long interval, so a problem left unattended for
 * a day says so once more rather than every five minutes.
 */
export function notificationsDue(store, { now = Date.now(), renotifyAfterMs = DAY, notifyResolved = true } = {}) {
  const due = [];
  for (const inc of store.incidents || []) {
    if (inc.severity !== 'critical') continue;
    const n = inc.notified || {};
    if (inc.state === 'open') {
      if (!n.sentAt) { due.push({ incident: inc, kind: 'opened' }); continue; }
      const since = now - Date.parse(n.sentAt);
      if (Number.isFinite(since) && since >= renotifyAfterMs) due.push({ incident: inc, kind: 'ongoing' });
    } else if (inc.state === 'resolved' && notifyResolved && n.sentAt && !n.resolvedNoticeAt) {
      // Only worth saying if the opening was announced.
      due.push({ incident: inc, kind: 'resolved' });
    }
  }
  return due;
}

/** Record the outcome of an attempt. A failure never changes the incident state. */
export function recordNotification(incident, kind, result, { now = nowIso() } = {}) {
  const n = incident.notified || (incident.notified = { sentAt: null, attempts: 0, lastError: null, lastAttemptAt: null, resolvedNoticeAt: null });
  n.attempts = (n.attempts || 0) + 1;
  n.lastAttemptAt = now;
  if (result && result.ok) {
    n.lastError = null;
    if (kind === 'resolved') n.resolvedNoticeAt = now;
    else n.sentAt = now;
  } else {
    n.lastError = String((result && (result.reason || result.error)) || 'unknown').slice(0, 120);
  }
  return incident;
}

/** The message body. Enough to act on; never a payload, an id or a secret. */
export function renderNotification(incident, kind) {
  const when = kind === 'resolved' ? incident.resolvedAt : incident.firstDetectedAt;
  const head = kind === 'resolved' ? 'RESOLVED' : (kind === 'ongoing' ? 'STILL FAILING' : 'CRITICAL');
  const lines = [
    `${head} — ${incident.subsystem}`,
    '',
    incident.title,
    '',
    incident.why,
    '',
    `Evidence: ${incident.evidence || 'not recorded'}`,
    `First detected: ${incident.firstDetectedAt}`,
    `Occurrences: ${incident.occurrences}`,
  ];
  if (incident.affected && incident.affected.label) lines.push(`Affected: ${incident.affected.label}`);
  if (kind === 'resolved') lines.push(`Resolved: ${when}`);
  lines.push('', 'Open Gaia Admin → System Alerts for the full picture.');
  const subject = `[Gaia ${head}] ${incident.title}`.slice(0, 160);
  return { subject, text: lines.join('\n'), html: lines.map((l) => (l ? `<p>${l}</p>` : '')).join('') };
}
