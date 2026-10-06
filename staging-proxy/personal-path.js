/**
 * Personal Path V1: a member's ranked next steps, from rules that interpret
 * NOTHING about their readings (owner brief, 6 Oct 2026).
 *
 * Two kinds of item, never mixed:
 *   - "Suggested by Gaia": platform rules (onboarding, a new reading, the
 *     recheck policy, a confirmed session, a course in progress, sharing).
 *   - "Recommended by your practitioner": only what a human practitioner
 *     explicitly chose and confirmed for this member (practitioner_manual,
 *     review_state approved). Partner AI output is a disabled source and can
 *     never become this label.
 *
 * Every rule and every selectable resource is a catalogue entry with a SOURCE
 * and an APPROVAL; only status=approved, active=true, approved at the current
 * version is served. This module is pure: signals in, items out. No reading
 * values ever enter it -- only dates, link state and counts.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SOURCE_TYPES = Object.freeze(['platform_rule', 'practitioner_manual', 'practitioner_service', 'partner_deterministic', 'partner_ai', 'gaia_catalogue']);
/** What a catalogue entry's evidence can be (separate from who produced an item). */
export const SOURCE_REF_TYPES = Object.freeze(['biowell_official', 'gaia_practitioner', 'gaia_content', 'business_rule']);
export const REVIEW_STATES = Object.freeze(['not_required', 'pending', 'approved', 'rejected', 'revoked']);
export const ITEM_STATES = Object.freeze(['active', 'opened', 'completed', 'dismissed', 'expired']);
export const STAGES = Object.freeze({
  start_now: 'Start now', coming_up: 'Coming up', keep_going: 'Keep going', recheck: 'Recheck',
});
export const MAX_ITEMS = 5;

/**
 * HOW EACH KIND OF STEP IS COMPLETED (owner acceptance pass, 6 Oct 2026).
 * Decided by the action/resource KIND only; a catalogue entry cannot choose
 * its own strategy, so a future entry cannot inherit a weaker one. Only
 * 'member' lets the member say "I did this"; everything else is completed by
 * an authoritative server fact (or, where we have none, not at all: the
 * member may still set it aside with "Not now"). An unknown kind gets 'none'.
 *
 *   member            self-guided practice or activity: the member says so
 *   course_progress   the academy progress store reaches 100% (opening is not completion)
 *   reading_seen      the readings card was opened (link status "seen"); never "Gaia understood it"
 *   link_confirmed    the practitioner confirmed the readings link
 *   appointment_status  a booking/session: the appointment's own status/time
 *   practitioner_booking  a practitioner's service: NO authoritative completion signal today
 *                     (their bookings are on the partner platform and not linked to
 *                     the service recommended), so it is never completed by a claim
 *   new_scan          a newer scan arrives (opening the booking page is not booking)
 *   entitlement       the membership/entitlement ledger
 *   onboarding_gate   the onboarding gate's own state
 *   order             a purchase/order record (products, when added later)
 *   none              no completion; dismiss only
 */
export const COMPLETION_BY_KIND = Object.freeze({
  tool: 'member', practice: 'member', view: 'member',
  course: 'course_progress', readings: 'reading_seen', share_readings: 'link_confirmed',
  bookings: 'appointment_status', service: 'practitioner_booking', scan: 'new_scan',
  plans: 'entitlement', onboarding: 'onboarding_gate', product: 'order',
});
export const completionFor = (kind) => COMPLETION_BY_KIND[kind] || 'none';
export const memberMayComplete = (kind) => completionFor(kind) === 'member';
const PLAN_ORDER = ['free', 'silver', 'gold', 'diamond'];
const DAY = 86400000;

// ── catalogue ───────────────────────────────────────────────────────────────

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const CATALOGUE_FILE = path.join(HERE, 'path-catalogue.json');

/** The catalogue in force: the repo file, or GAIA_PATH_CATALOGUE_FILE (tests, staging). */
export function loadCatalogue(file = process.env.GAIA_PATH_CATALOGUE_FILE || CATALOGUE_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: Number(raw.version) || 0, entries: Array.isArray(raw.entries) ? raw.entries : [] };
  } catch { return { version: 0, entries: [] }; }
}

/** May this entry reach a member? Approved, active, approved AT this version, with a source. */
export function servable(entry) {
  return Boolean(entry && entry.status === 'approved' && entry.active === true
    && entry.approval && entry.approval.by && entry.approval.version === entry.version
    && Array.isArray(entry.sources) && entry.sources.length
    && entry.sources.every((s) => SOURCE_REF_TYPES.includes(s?.type) && s.ref)
    && entry.source_type !== 'partner_ai');   // a disabled source, whatever its paperwork says
}

export function servableEntries(catalogue) { return (catalogue?.entries || []).filter(servable); }
export const entryById = (catalogue, id) => servableEntries(catalogue).find((e) => e.id === id) || null;

/** The resources a practitioner may choose from (approved Gaia catalogue entries). */
export function selectableResources(catalogue) {
  return servableEntries(catalogue).filter((e) => e.kind === 'resource').map((e) => ({
    key: 'cat:' + e.id, id: e.id, title: e.title, description: e.description || '', resource: e.resource,
    membership_requirement: e.membership_requirement || null, free_alternative: e.free_alternative || null,
  }));
}

// ── helpers ────────────────────────────────────────────────────────────────

const day = (iso) => { const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) ? iso + 'T12:00:00Z' : iso); return Number.isFinite(t) ? t : null; };
const planLabel = (key) => String(key || '').replace(/^./, (c) => c.toUpperCase());

/** What locks a resource for this member, if anything. Membership is a lock, never a recommendation. */
export function lockFor(resource, entry, signals) {
  if (resource?.kind === 'course') {
    const access = (signals.courseAccess || {})[resource.id];
    if (access === false) return { kind: 'course_access', label: 'This course needs access.', action: { kind: 'plans' } };
  }
  const need = entry?.membership_requirement;
  if (need && PLAN_ORDER.includes(need)) {
    const have = PLAN_ORDER.indexOf(signals.membership?.level || 'free');
    if (have < PLAN_ORDER.indexOf(need)) return { kind: 'plan', plan: need, label: `This is included with ${planLabel(need)}.`, action: { kind: 'plans' } };
  }
  return null;
}

// ── rules (each one is a catalogue entry; unapproved rules never run) ──────

const RULES = {
  'P-ONBOARD': (s) => (s.onboarding?.required ? [{ key: 'P-ONBOARD', priority: 100, stage: 'start_now',
    title: 'Finish your Gaia setup', reason: 'A few questions so Gaia can open the rest of the app for you.',
    action: { kind: 'onboarding', label: 'Continue setup' } }] : []),

  'P-NEW': (s) => (s.readings?.linked && s.readings.new_reading && s.readings.latest_scanned_at ? [{ key: `P-NEW:${s.readings.latest_scanned_at}`, priority: 80, stage: 'start_now',
    title: 'Open your latest reading', reason: 'A new Bio-Well reading has been shared with you.',
    action: { kind: 'readings', label: 'Open reading' } }] : []),

  'P-SESSION': (s, now) => {
    const soon = (s.appointments || [])
      .filter((a) => String(a.status || '').toLowerCase() === 'confirmed')
      .map((a) => ({ ...a, t: Date.parse(a.startTime) }))
      .filter((a) => Number.isFinite(a.t) && a.t > now && a.t - now <= 7 * DAY)
      .sort((a, b) => a.t - b.t)[0];
    if (!soon) return [];
    return [{ key: `P-SESSION:${soon.id || soon.t}`, priority: 70, stage: 'coming_up',
      title: 'Prepare for your upcoming session', reason: '', when: new Date(soon.t).toISOString(), session_title: String(soon.title || '').slice(0, 80),
      action: { kind: 'bookings', label: 'View session' } }];
  },

  'P-COURSE': (s) => {
    const c = (s.courses || []).filter((x) => x.accessible && x.started && !(x.pct >= 100))
      .sort((a, b) => (b.pct || 0) - (a.pct || 0))[0];
    if (!c) return [];
    return [{ key: `P-COURSE:${c.id}`, priority: 60, stage: 'keep_going',
      title: `Continue ${String(c.title || 'your course').slice(0, 80)}`, reason: '', progress: Math.round(c.pct || 0),
      action: { kind: 'course', label: 'Resume', course_id: c.id } }];
  },

  'P-SHARE': (s) => (s.readings?.enabled && !s.readings.linked ? [{ key: 'P-SHARE', priority: 50, stage: 'start_now',
    title: 'Connect your Bio-Well reading', reason: 'Ask your practitioner to share your readings with you here, or find a scan near you.',
    action: { kind: 'share_readings', label: 'How sharing works' } }] : []),

  'P-RECHECK': (s, now, ctx) => {
    const t = day(s.readings?.latest_scanned_at);
    if (!s.readings?.linked || t === null) return [];
    const days = ctx.recheckDays || 60;
    if ((now - t) / DAY < days) return [];
    return [{ key: `P-RECHECK:${s.readings.latest_scanned_at}`, priority: 40, stage: 'recheck',
      title: 'Consider a new Bio-Well scan',
      reason: `Your latest scan was over ${days} days ago. A new scan may give you a more current point of comparison.`,
      action: { kind: 'scan', label: 'Find a scan' } }];
  },
};
export const RULE_IDS = Object.freeze(Object.keys(RULES));

/** A practitioner's confirmed recommendation, as the member sees it. Only approved practitioner_manual records qualify. */
function practitionerItem(rec, catalogue, signals) {
  if (!rec || rec.source_type !== 'practitioner_manual' || rec.review_state !== 'approved' || rec.revoked_at) return null;
  const entry = rec.resource?.catalogue_id ? entryById(catalogue, rec.resource.catalogue_id) : null;
  if (rec.resource?.catalogue_id && !entry) return null;   // the resource was retired or un-approved since
  const lock = lockFor(rec.resource, entry, signals);
  const free = lock && entry?.free_alternative ? entryById(catalogue, entry.free_alternative) : null;
  return {
    key: `R:${rec.id}`, priority: 90, stage: 'start_now',
    title: rec.resource?.title || 'A recommendation from your practitioner',
    reason: rec.member_safe_reason || '', note: rec.note || '',
    practitioner_name: rec.practitioner_name || '',
    ...(rec.resource?.kind === 'service' && rec.resource.detail ? { service_detail: rec.resource.detail } : {}),
    action: { kind: rec.resource?.kind || 'none', label: actionLabel(rec.resource), ...(rec.resource?.target ? { target: rec.resource.target } : {}), ...(rec.resource?.id ? { resource_id: rec.resource.id } : {}) },
    lock, free_alternative: free ? { id: free.id, title: free.title, resource: free.resource, action_label: actionLabel(free.resource) } : null,
    provenance: { source_type: 'practitioner_manual', review_state: 'approved', label: 'Recommended by your practitioner' },
    completion: completionFor(rec.resource?.kind),
    recommended_at: rec.created_at,
  };
}

export function actionLabel(resource) {
  return ({ tool: 'Start practice', course: 'Open course', service: 'View service', view: 'Open', scan: 'Find a scan', readings: 'Open reading' })[resource?.kind] || 'Open';
}

/**
 * The path. `signals` carries only states and dates; `state` is the member's
 * per-item record ({key: {state, by}}). Dismissed and completed items stay
 * gone for that key; a new scan or session is a new key.
 */
export function buildPath(signals = {}, { catalogue = loadCatalogue(), state = {}, now = Date.now(), recheckDays = 60, practitionerRecs = [] } = {}) {
  const approvedRules = new Set(servableEntries(catalogue).filter((e) => e.kind === 'rule').map((e) => e.id));
  let items = [];
  // Required onboarding takes the whole path: nothing else is open yet.
  if (approvedRules.has('P-ONBOARD') && signals.onboarding?.required) items = RULES['P-ONBOARD'](signals, now, { recheckDays });
  else {
    for (const id of RULE_IDS) if (id !== 'P-ONBOARD' && approvedRules.has(id)) items.push(...RULES[id](signals, now, { recheckDays }).map((it) => ({ ...it, id })));
    for (const rec of practitionerRecs) { const it = practitionerItem(rec, catalogue, signals); if (it) items.push(it); }
  }
  // No contradictions: a reading that just arrived is not also "old".
  if (items.some((i) => i.key.startsWith('P-NEW:'))) items = items.filter((i) => !i.key.startsWith('P-RECHECK:'));
  items = items
    .map((i) => ({ ...i, completion: completionFor(i.action?.kind), id: i.id || i.key.split(':')[0], stage_label: STAGES[i.stage] || '', state: state[i.key]?.state || 'active',
      provenance: i.provenance || { source_type: 'platform_rule', review_state: 'not_required', label: 'Suggested by Gaia' } }))
    .filter((i) => i.state !== 'dismissed' && i.state !== 'completed' && i.state !== 'expired')
    .sort((a, b) => b.priority - a.priority || String(a.recommended_at || '').localeCompare(String(b.recommended_at || '')))
    .slice(0, MAX_ITEMS);
  return { items, caught_up: items.length === 0, catalogue_version: catalogue.version };
}

/**
 * What Gaia Assist may know about the path: public id, title, stage, state,
 * the approved member-safe reason, and the allowed action. Never a note, a
 * trigger, a date of a scan, a practitioner id or anything computed from a
 * reading. Pinned by test/personal-path.test.js.
 */
export function assistView(path) {
  return (path?.items || []).map((i) => ({
    id: i.key.startsWith('R:') ? i.key : i.id, title: i.title, stage: i.stage, state: i.state,
    from: i.provenance?.label || 'Suggested by Gaia',
    ...(i.provenance?.source_type === 'practitioner_manual' && i.reason ? { member_safe_reason: i.reason } : {}),
    action: i.action?.label || '', ...(i.lock ? { needs: i.lock.label } : {}),
  }));
}

/** One line for the prompt (~30-60 tokens). */
export function assistLine(path) {
  const v = assistView(path);
  if (!v.length) return 'PERSONAL PATH: caught up. If asked what is next, say so and offer the energy check, learning or a question; never invent steps.';
  return 'PERSONAL PATH (for "what next / my plan": item 1 is the next step; say it, offer to open it; give only a listed reason, else "Your practitioner recommended this after reviewing your information; I can open it or help you contact them"; never guess why or link it to readings): ' + v.map((x, n) => `${n + 1}. [${x.id}] "${x.title}" (${x.stage}, ${x.from}${x.member_safe_reason ? `; reason: ${x.member_safe_reason}` : ''}${x.needs ? `; ${x.needs}` : ''}; action: ${x.action})`).join(' ');
}
