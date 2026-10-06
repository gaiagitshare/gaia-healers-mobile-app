/**
 * Personal Path V1 engine: deterministic scenarios (owner brief, 6 Oct 2026).
 * Pure: signals in, items out. No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPath, servable, selectableResources, assistView, assistLine, loadCatalogue, RULE_IDS, MAX_ITEMS } from '../personal-path.js';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const day = (n) => new Date(NOW + n * 86400000).toISOString();
const approved = (e) => ({ ...e, version: 1, status: 'approved', active: true, approval: { by: 'reviewer-1', role: 'path_reviewer', at: '2026-10-06', version: 1 }, sources: e.sources || [{ type: 'business_rule', ref: 'test' }] });
const CATALOGUE = { version: 7, entries: [
  ...RULE_IDS.map((id) => approved({ id, kind: 'rule' })),
  approved({ id: 'R-BREATH', kind: 'resource', title: 'Coherence breathing practice', resource: { kind: 'tool', id: 'breath' }, sources: [{ type: 'gaia_content', ref: 't' }] }),
  approved({ id: 'R-PRO-COURSE', kind: 'resource', title: 'Practice Builder (course)', resource: { kind: 'tool', id: 'pro' }, membership_requirement: 'silver', free_alternative: 'R-BREATH', sources: [{ type: 'gaia_content', ref: 't' }] }),
  { id: 'R-PENDING', kind: 'resource', version: 1, title: 'Not yet approved', resource: { kind: 'tool', id: 'x' }, status: 'pending', active: true, approval: null, sources: [{ type: 'gaia_content', ref: 't' }] },
] };
const linked = (o = {}) => ({ readings: { enabled: true, linked: true, new_reading: false, latest_scanned_at: day(-10).slice(0, 10), ...o } });
const keys = (p) => p.items.map((i) => i.key.split(':')[0]);
const rec = (o = {}) => ({ id: 'rec_test0001', source_type: 'practitioner_manual', review_state: 'approved', revoked_at: null, practitioner_name: 'Sam Rivera',
  resource: { kind: 'tool', id: 'breath', title: 'Coherence breathing practice', catalogue_id: 'R-BREATH' }, member_safe_reason: 'Your practitioner recommended this as part of your current wellness plan.', note: 'Twice a day', created_at: day(-1), ...o });
const run = (signals, opts = {}) => buildPath(signals, { catalogue: CATALOGUE, now: NOW, recheckDays: 60, ...opts });

test('no readings shared: connect your reading', () => {
  const p = run({ readings: { enabled: true, linked: false } });
  assert.deepEqual(keys(p), ['P-SHARE']);
  assert.equal(p.items[0].title, 'Connect your Bio-Well reading');
  assert.equal(p.items[0].provenance.label, 'Suggested by Gaia');
});

test('readings feature off for this member: nothing about readings', () => {
  assert.equal(run({ readings: { enabled: false, linked: false } }).caught_up, true);
});

test('new reading: review it, and never also "old"', () => {
  const p = run(linked({ new_reading: true, latest_scanned_at: day(-90).slice(0, 10) }));
  assert.deepEqual(keys(p), ['P-NEW'], 'a reading that just arrived is not also called old');
  assert.equal(p.items[0].title, 'Review your latest reading');
  assert.doesNotMatch(JSON.stringify(p.items[0]), /Gaia (has )?read|analy[sz]ed/i, 'never implies Gaia read it');
});

test('old reading: recheck with the policy wording, configurable days', () => {
  const p = run(linked({ latest_scanned_at: day(-61).slice(0, 10) }));
  assert.deepEqual(keys(p), ['P-RECHECK']);
  assert.equal(p.items[0].reason, 'Your latest scan was over 60 days ago. A new scan may give you a more current point of comparison.');
  assert.doesNotMatch(JSON.stringify(p), /stale|expired/i);
  assert.equal(run(linked({ latest_scanned_at: day(-61).slice(0, 10) }), { recheckDays: 90 }).caught_up, true, 'the window is configuration');
  assert.equal(run(linked({ latest_scanned_at: day(-30).slice(0, 10) })).caught_up, true);
});

test('upcoming session: only CONFIRMED, only within 7 days, the soonest', () => {
  const appointments = [
    { id: 'a1', title: 'Bio-Well follow-up', startTime: day(3), status: 'confirmed' },
    { id: 'a0', title: 'Not confirmed yet', startTime: day(1), status: 'new' },
    { id: 'a2', title: 'Too far', startTime: day(9), status: 'confirmed' },
    { id: 'a3', title: 'Past', startTime: day(-1), status: 'confirmed' },
  ];
  const p = run({ appointments });
  assert.deepEqual(p.items.map((i) => i.key), ['P-SESSION:a1']);
  assert.equal(p.items[0].stage_label, 'Coming up');
  assert.equal(run({ appointments: [{ id: 'x', startTime: day(2), status: 'cancelled' }] }).caught_up, true);
});

test('course in progress: accessible, actually started, not finished', () => {
  const courses = [
    { id: 'c-done', title: 'Done', pct: 100, accessible: true, started: true },
    { id: 'c-locked', title: 'Locked', pct: 30, accessible: false, started: true },
    { id: 'c-opened', title: 'Opened only', pct: 0, accessible: true, started: false },
    { id: 'c-1', title: 'Chakra Foundations', pct: 40, accessible: true, started: true },
  ];
  const p = run({ courses });
  assert.deepEqual(p.items.map((i) => i.key), ['P-COURSE:c-1']);
  assert.equal(p.items[0].title, 'Continue Chakra Foundations');
  assert.equal(p.items[0].completion, 'backend', 'opening a course never completes it');
});

test('several triggers: ranked onboarding → practitioner → new reading → session → learning → recheck; at most 5', () => {
  const s = { ...linked({ new_reading: true }), appointments: [{ id: 'a1', startTime: day(2), status: 'confirmed' }],
    courses: [{ id: 'c-1', title: 'C', pct: 10, accessible: true, started: true }] };
  const p = run(s, { practitionerRecs: [rec()] });
  assert.deepEqual(keys(p), ['R', 'P-NEW', 'P-SESSION', 'P-COURSE']);
  const s2 = { ...linked({ latest_scanned_at: day(-70).slice(0, 10) }), appointments: s.appointments, courses: s.courses };
  assert.deepEqual(keys(run(s2, { practitionerRecs: [rec()] })), ['R', 'P-SESSION', 'P-COURSE', 'P-RECHECK']);
  const many = Array.from({ length: 8 }, (_, n) => rec({ id: `rec_many000${n}` }));
  assert.equal(run(s2, { practitionerRecs: many }).items.length, MAX_ITEMS);
});

test('no triggers: caught up, nothing invented', () => {
  const p = run({ readings: { enabled: true, linked: true, latest_scanned_at: day(-5).slice(0, 10) } });
  assert.equal(p.caught_up, true); assert.deepEqual(p.items, []);
  assert.match(assistLine(p), /caught up/);
});

test('dismissed and completed items stay gone; a new scan is a new item', () => {
  const s = linked({ new_reading: true, latest_scanned_at: '2026-10-03' });
  assert.equal(run(s, { state: { 'P-NEW:2026-10-03': { state: 'dismissed' } } }).caught_up, true);
  assert.equal(run(s, { state: { 'P-NEW:2026-10-03': { state: 'completed' } } }).caught_up, true);
  assert.deepEqual(keys(run(linked({ new_reading: true, latest_scanned_at: '2026-10-05' }), { state: { 'P-NEW:2026-10-03': { state: 'dismissed' } } })), ['P-NEW']);
  assert.equal(run(s, { state: { 'P-NEW:2026-10-03': { state: 'opened' } } }).items[0].state, 'opened', 'opened is not completed');
  const r = rec();
  assert.equal(run({}, { practitionerRecs: [r], state: { [`R:${r.id}`]: { state: 'completed', by: 'user' } } }).caught_up, true);
});

test('required onboarding takes priority over everything', () => {
  const p = run({ onboarding: { required: true }, ...linked({ new_reading: true }) }, { practitionerRecs: [rec()] });
  assert.deepEqual(keys(p), ['P-ONBOARD']);
  assert.equal(p.items[0].title, 'Finish your Gaia setup');
});

test('catalogue: only approved, active, approved-at-this-version entries run or are selectable', () => {
  const noRules = { version: 1, entries: CATALOGUE.entries.filter((e) => e.kind !== 'rule') };
  assert.equal(buildPath(linked({ new_reading: true }), { catalogue: noRules, now: NOW }).caught_up, true, 'an unapproved rule never runs');
  assert.equal(servable({ ...CATALOGUE.entries[0], active: false }), false);
  assert.equal(servable({ ...CATALOGUE.entries[0], version: 2 }), false, 'an edit after approval needs approval again');
  assert.equal(servable({ ...CATALOGUE.entries[0], status: 'pending' }), false);
  assert.equal(servable({ ...CATALOGUE.entries[0], sources: [] }), false, 'no source, no service');
  assert.equal(servable({ ...CATALOGUE.entries[0], source_type: 'partner_ai' }), false, 'partner AI is a disabled source');
  assert.deepEqual(selectableResources(CATALOGUE).map((r) => r.id), ['R-BREATH', 'R-PRO-COURSE'], 'pending resources are not offered to practitioners');
});

test('the repo catalogue: V1 rules approved by the owner brief; Gaia resources pending review; no products', () => {
  const real = loadCatalogue();
  const rules = real.entries.filter((e) => e.kind === 'rule');
  assert.deepEqual(rules.map((e) => e.id).sort(), [...RULE_IDS].sort());
  assert.ok(rules.every(servable));
  assert.ok(real.entries.filter((e) => e.kind === 'resource').every((e) => !servable(e)), 'no resource is approved by default');
  assert.ok(!real.entries.some((e) => e.resource?.kind === 'product' || e.kind === 'product'), 'no products in V1');
});

test('practitioner items: only approved practitioner_manual becomes "Recommended by your practitioner"', () => {
  for (const bad of [rec({ source_type: 'partner_ai' }), rec({ review_state: 'pending' }), rec({ source_type: 'partner_deterministic' }), rec({ revoked_at: day(0), review_state: 'revoked' })]) {
    assert.equal(run({}, { practitionerRecs: [bad] }).caught_up, true, JSON.stringify(bad.source_type + '/' + bad.review_state));
  }
  const p = run({}, { practitionerRecs: [rec()] });
  assert.equal(p.items[0].provenance.label, 'Recommended by your practitioner');
  assert.equal(p.items[0].reason, 'Your practitioner recommended this as part of your current wellness plan.');
  assert.equal(run({}, { practitionerRecs: [rec({ resource: { kind: 'tool', id: 'x', title: 'Gone', catalogue_id: 'R-PENDING' } })] }).caught_up, true, 'a resource un-approved since is withdrawn');
});

test('membership: the recommendation comes first; the lock says what includes it and offers the free option', () => {
  const r = rec({ resource: { kind: 'tool', id: 'pro', title: 'Practice Builder (course)', catalogue_id: 'R-PRO-COURSE' } });
  const locked = run({ membership: { level: 'free' } }, { practitionerRecs: [r] }).items[0];
  assert.equal(locked.title, 'Practice Builder (course)');
  assert.equal(locked.lock.label, 'This is included with Silver.');
  assert.equal(locked.free_alternative.id, 'R-BREATH');
  assert.equal(run({ membership: { level: 'gold' } }, { practitionerRecs: [r] }).items[0].lock, null, 'accessible: no lock');
  const course = rec({ resource: { kind: 'course', id: 'c-9', title: 'Course', catalogue_id: 'R-BREATH' } });
  assert.equal(run({ courseAccess: { 'c-9': false } }, { practitionerRecs: [course] }).items[0].lock.kind, 'course_access');
  assert.ok(!run({ membership: { level: 'free' } }, { practitionerRecs: [r] }).items.some((i) => /upgrade/i.test(i.title)), 'membership is never the step itself');
});

test('Gaia sees only public path fields: never the note, a date of a scan, ids of people or anything from readings', () => {
  const s = { ...linked({ new_reading: true, latest_scanned_at: '2026-10-03' }), appointments: [{ id: 'a1', title: 'Private session title', startTime: day(2), status: 'confirmed' }] };
  const p = run(s, { practitionerRecs: [rec({ note: 'SENTINEL_NOTE', practitioner_id: 'PRAC-SENTINEL', member_id: 'MEMBER-SENTINEL' })] });
  const view = JSON.stringify(assistView(p)) + assistLine(p);
  for (const bad of ['SENTINEL_NOTE', 'PRAC-SENTINEL', 'MEMBER-SENTINEL', '2026-10-03', 'Private session title', 'Sam Rivera']) assert.ok(!view.includes(bad), `${bad} reached Gaia: ${view}`);
  assert.match(view, /Recommended by your practitioner/);
  assert.match(view, /Your practitioner recommended this as part of your current wellness plan\./, 'the approved member-safe reason may be explained');
  assert.match(view, /\[P-NEW\] "Review your latest reading"/);
});
