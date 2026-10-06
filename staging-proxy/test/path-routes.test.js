/**
 * Personal Path V1 routes: authorization, provenance, completion and privacy.
 * Real link store and path storage (temp files); the partner and the session
 * are faked. No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-path-'));
process.env.GAIA_PATH_RECS_FILE = path.join(DIR, 'recs.json');
process.env.GAIA_PATH_STATE_FILE = path.join(DIR, 'state.json');
process.env.GAIA_PATH_EVENTS_FILE = path.join(DIR, 'events.jsonl');
const CAT = path.join(DIR, 'catalogue.json');
process.env.GAIA_PATH_CATALOGUE_FILE = CAT;
const LINKS = path.join(DIR, 'links.json');

const ml = await import('../member-link.js');
const { createPathRoutes } = await import('../path-routes.js');
const { RULE_IDS } = await import('../personal-path.js');

const ok = { by: 'reviewer-1', role: 'path_reviewer', at: '2026-10-06', version: 1 };
fs.writeFileSync(CAT, JSON.stringify({ version: 3, entries: [
  ...RULE_IDS.map((id) => ({ id, kind: 'rule', version: 1, status: 'approved', active: true, approval: ok, sources: [{ type: 'business_rule', ref: 't' }] })),
  { id: 'R-BREATH', kind: 'resource', version: 1, title: 'Coherence breathing practice', resource: { kind: 'tool', id: 'breath' }, status: 'approved', active: true, approval: ok, sources: [{ type: 'gaia_content', ref: 't' }] },
  { id: 'R-COURSE', kind: 'resource', version: 1, title: 'A course', resource: { kind: 'course', id: 'c-1' }, status: 'approved', active: true, approval: ok, sources: [{ type: 'gaia_content', ref: 't' }] },
  { id: 'R-SCAN', kind: 'resource', version: 1, title: 'A follow-up Bio-Well scan', resource: { kind: 'scan', id: 'scan' }, status: 'approved', active: true, approval: ok, sources: [{ type: 'business_rule', ref: 't' }] },
  { id: 'R-DRAFT', kind: 'resource', version: 1, title: 'Draft', resource: { kind: 'tool', id: 'x' }, status: 'pending', active: true, approval: null, sources: [{ type: 'gaia_content', ref: 't' }] },
] }));

// Two practitioners, each with one linked Gaia member client; a third member is nobody's.
const link = (member, customer, pid, name) => { const { code } = ml.mintCode(member, { file: LINKS }); ml.redeemCode(code, { customer_id: customer, practitioner_id: pid, practitioner_name: name }, { file: LINKS }); };
link('member-a', '101', 'P-A', 'Ana Practitioner');
link('member-b', '202', 'P-B', 'Ben Practitioner');
const PRACS = { 'contact-pa': { state: 'connected', practitioner_id: 'P-A', practitioner_name: 'Ana Practitioner' }, 'contact-pb': { state: 'connected', practitioner_id: 'P-B', practitioner_name: 'Ben Practitioner' },
  'contact-unverified': { state: 'unverified', practitioner_id: 'P-A' } };
const SERVICES = { 'contact-pa': [{ id: 7, name: 'Lymphatic massage', description: '<b>60 min</b>', duration: 60, price: 90 }], 'contact-pb': [{ id: 9, name: 'Reiki', duration: 45 }] };

const sent = [];
const sendJson = (res, status, data) => { res.status = status; res.data = data; sent.push({ status, data }); };
const routes = createPathRoutes({
  requireSessionMember: (req, res) => req.session || (sendJson(res, 401, { ok: false, reason: 'auth_required' }), null),
  sendJson, readJsonBody: async (req) => { if (req.body === 'bad') throw new Error('bad'); return req.body || {}; },
  linkState: (cid) => ({ state: PRACS[cid]?.state || 'not_connected' }),
  tokenFor: (cid) => (PRACS[cid] ? { practitioner_id: PRACS[cid].practitioner_id, practitioner_name: PRACS[cid].practitioner_name } : null),
  memberReadingsEnabled: () => true, memberAllowed: () => true,
  linkStatus: (cid) => ml.linkStatus(cid, { file: LINKS }),
  recheckAfterDays: () => 60,
  memberForPractitionerClient: (pid, cust) => ml.memberForPractitionerClient(pid, cust, LINKS),
  loadAcademyManifest: () => ({ courses: [{ id: 'c-1', title: 'A course' }] }),
  loadAcademyProgress: () => ({ byContact: { 'member-a': { 'c-1': { pct: 100, completed: ['l1'] } } } }),
  academyOwnedIdsForRequest: () => ({ ids: new Set(['c-1']) }),
  academyCourseOwned: (c, ids) => ids.has(c.id),
  appointmentsFor: async () => [], planLevelFor: async () => 'free',
  readMcp: async (ctx, tool) => (tool === 'list_services' ? { services: SERVICES[ctx.contactId] || [] } : {}),
});
const call = async (method, url, session, body) => {
  const res = {}; const u = new URL('https://api.example' + url);
  const handled = await routes.handle({ method, session: session ? { contactId: session } : null, body }, res, u, 'https://gaiahealers.app');
  return { handled, ...res };
};
const recommend = (who, body) => call('POST', '/api/practitioners/path/recommend', who, { confirm: true, customer_id: '101', resource_key: 'cat:R-BREATH', ...body });

test('visitor: no private path', async () => {
  const r = await call('GET', '/api/member/path', null);
  assert.equal(r.status, 401);
  const e = await call('POST', '/api/member/path/event', null, { event: 'path_viewed' });
  assert.equal(e.status, 401);
});

test('practitioner options: only a connected practitioner, only their own linked client', async () => {
  const mine = await call('GET', '/api/practitioners/path/options?customer_id=101', 'contact-pa');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.resources.map((r) => r.id), ['R-BREATH', 'R-COURSE', 'R-SCAN'], 'approved resources only (no drafts)');
  assert.deepEqual(mine.data.services.map((s) => s.title), ['Lymphatic massage']);
  assert.equal(mine.data.services[0].description, '60 min', 'markup stripped from service text');
  assert.equal((await call('GET', '/api/practitioners/path/options?customer_id=202', 'contact-pa')).status, 404, "A cannot reach B's client");
  assert.equal((await call('GET', '/api/practitioners/path/options?customer_id=999', 'contact-pa')).status, 404, 'a forged client id looks like nothing');
  assert.equal((await call('GET', '/api/practitioners/path/options?customer_id=101', 'contact-unverified')).status, 403, 'an unverified link is not a practitioner');
  assert.equal((await call('GET', '/api/practitioners/path/options?customer_id=101', 'member-a')).status, 403, 'a member is not a practitioner');
  assert.equal((await call('GET', '/api/practitioners/path/options?customer_id=101', null)).status, 401);
});

test('recommend: explicit confirm, approved resource or their own service, plain-text reason and note', async () => {
  assert.equal((await recommend('contact-pa', { confirm: false })).data.error, 'confirm_required');
  assert.equal((await recommend('contact-pa', { resource_key: 'cat:R-DRAFT' })).data.error, 'resource_not_selectable');
  assert.equal((await recommend('contact-pa', { resource_key: 'svc:9' })).data.error, 'resource_not_selectable', "B's service is not A's to recommend");
  assert.equal((await recommend('contact-pa', { note: 'see https://evil.example' })).data.error, 'note_no_links_or_markup');
  assert.equal((await recommend('contact-pa', { note: '<img src=x onerror=alert(1)>' })).data.error, 'note_no_links_or_markup');
  assert.equal((await recommend('contact-pa', { member_safe_reason: 'x'.repeat(500) })).data.error, 'reason_too_long');
  assert.equal((await recommend('contact-pb')).status, 404, "B cannot recommend to A's client");
  assert.equal((await recommend('contact-pa', { customer_id: '202' })).status, 404, "a forged client id (B's client) is refused");
  const okRec = await recommend('contact-pa', { note: 'Twice a day, before sessions.' });
  assert.equal(okRec.status, 200);
  assert.equal(okRec.data.recommendation.member_safe_reason, 'Your practitioner recommended this as part of your current wellness plan.', 'default member-safe reason');
  assert.equal((await recommend('contact-pa')).status, 409, 'no duplicate of an active recommendation');
  const svc = await recommend('contact-pa', { resource_key: 'svc:7', member_safe_reason: 'Part of your plan with me this month.' });
  assert.equal(svc.status, 200);
});

test('member sees "Recommended by your practitioner" with the approved reason and note; B never does', async () => {
  const a = await call('GET', '/api/member/path', 'member-a');
  const recs = a.data.items.filter((i) => i.key.startsWith('R:'));
  assert.ok(recs.length >= 2);
  assert.ok(recs.every((i) => i.provenance.label === 'Recommended by your practitioner' && i.provenance.source_type === 'practitioner_manual'));
  const breath = recs.find((i) => i.title === 'Coherence breathing practice');
  assert.equal(breath.note, 'Twice a day, before sessions.');
  assert.equal(breath.practitioner_name, 'Ana Practitioner');
  assert.ok(!JSON.stringify(a.data).includes('P-A') && !JSON.stringify(a.data).includes('contact-pa'), 'no practitioner ids reach the page');
  const b = await call('GET', '/api/member/path', 'member-b');
  assert.ok(!b.data.items.some((i) => i.key.startsWith('R:')), "another member never sees A's recommendations");
});

test('revoke: only the practitioner who made it; then it leaves the member path', async () => {
  const opts = await call('GET', '/api/practitioners/path/options?customer_id=101', 'contact-pa');
  const id = opts.data.recommendations.find((r) => r.title === 'Lymphatic massage').id;
  assert.equal((await call('POST', '/api/practitioners/path/revoke', 'contact-pb', { id })).status, 404, 'B cannot revoke A’s');
  assert.equal((await call('POST', '/api/practitioners/path/revoke', 'contact-pa', { id })).data.recommendation.state, 'revoked');
  const a = await call('GET', '/api/member/path', 'member-a');
  assert.ok(!a.data.items.some((i) => i.title === 'Lymphatic massage'));
});

test('completion: the member may complete a practice; a course is complete only when the server says so', async () => {
  const course = await recommend('contact-pa', { resource_key: 'cat:R-COURSE' });
  const key = `R:${course.data.recommendation.id}`;
  assert.equal((await call('POST', '/api/member/path/event', 'member-a', { event: 'recommendation_completed', key })).status, 409, 'opening or saying so never completes a course');
  // c-1 is at 100% in the progress store: the server completes it, so it is not on the path.
  const path1 = await call('GET', '/api/member/path', 'member-a');
  assert.ok(!path1.data.items.some((i) => i.key === key), 'backend confirmation completes it');
  const breath = path1.data.items.find((i) => i.title === 'Coherence breathing practice');
  assert.equal((await call('POST', '/api/member/path/event', 'member-a', { event: 'recommendation_opened', key: breath.key })).data.state.state, 'opened');
  assert.ok((await call('GET', '/api/member/path', 'member-a')).data.items.some((i) => i.key === breath.key), 'opened is not completed');
  assert.equal((await call('POST', '/api/member/path/event', 'member-a', { event: 'recommendation_completed', key: breath.key })).data.state.by, 'user');
  assert.ok(!(await call('GET', '/api/member/path', 'member-a')).data.items.some((i) => i.key === breath.key));
  assert.equal((await call('POST', '/api/member/path/event', 'member-b', { event: 'recommendation_completed', key: breath.key })).status, 404, "B cannot touch A's item");
  assert.equal((await call('POST', '/api/member/path/event', 'member-a', { event: 'recommendation_completed', key: 'P-NEW:2026-10-03' })).status, 409, 'a reading is reviewed by opening it, on the server');
  for (const k of ['P-SESSION:a1', 'P-RECHECK:2026-06-08', 'P-COURSE:c-1', 'P-SHARE']) assert.equal((await call('POST', '/api/member/path/event', 'member-a', { event: 'recommendation_completed', key: k })).status, 409, k);
});

test('a practitioner service cannot be completed by a claim; it carries its details for "View service"', async () => {
  const svc = await recommend('contact-pa', { resource_key: 'svc:7', note: '' });
  const id = svc.data.recommendation?.id || (await call('GET', '/api/practitioners/path/options?customer_id=101', 'contact-pa')).data.recommendations.find((r) => r.title === 'Lymphatic massage' && r.state === 'active').id;
  const item = (await call('GET', '/api/member/path', 'member-a')).data.items.find((i) => i.key === `R:${id}`);
  assert.equal(item.completion, 'practitioner_booking');
  assert.deepEqual(item.service_detail, { description: '60 min', duration: 60 });
  assert.equal((await call('POST', '/api/member/path/event', 'member-a', { event: 'recommendation_completed', key: item.key })).status, 409, 'no "I did this" for a booking');
  await call('POST', '/api/practitioners/path/revoke', 'contact-pa', { id });
});

test('dismissed recommendation stays dismissed', async () => {
  const r = await recommend('contact-pa', { resource_key: 'cat:R-BREATH' }).then(async (x) => x.status === 409 ? null : x);
  const items = (await call('GET', '/api/member/path', 'member-a')).data.items;
  const share = items.find((i) => i.key === 'P-NEW' || i.key.startsWith('P-'));
  if (share) {
    await call('POST', '/api/member/path/event', 'member-a', { event: 'recommendation_dismissed', key: share.key });
    assert.ok(!(await call('GET', '/api/member/path', 'member-a')).data.items.some((i) => i.key === share.key));
  }
  assert.ok(r === null || r.status === 200);
});

test('events: only whitelisted names and fields; unknown events and keys are refused', async () => {
  assert.equal((await call('POST', '/api/member/path/event', 'member-a', { event: 'energy_was_54' })).status, 400);
  assert.equal((await call('POST', '/api/member/path/event', 'member-a', { event: 'path_viewed', key: '<script>' })).status, 400);
  assert.equal((await call('POST', '/api/member/path/event', 'member-a', { event: 'path_viewed', surface: 'you', items: 3, note: 'SENTINEL_NOTE', energy: 54.321, stress: 3.987 })).status, 200);
  for (const e of ['membership_required_shown', 'membership_opened', 'free_alternative_selected']) assert.equal((await call('POST', '/api/member/path/event', 'member-a', { event: e, level: 'silver' })).status, 200);
  assert.equal((await call('POST', '/api/member/path/event', 'member-a', { event: 'scan_rebook_opened', key: 'P-RECHECK:2026-06-08', route: 'directory' })).status, 200);
});

test('privacy: no reading value, signal, note or reason in analytics; no reading value in path storage', async () => {
  const events = fs.readFileSync(process.env.GAIA_PATH_EVENTS_FILE, 'utf8');
  for (const bad of ['SENTINEL_NOTE', '54.321', '3.987', 'Twice a day', 'wellness plan', 'member-a', 'contact-pa', 'P-A', '2026-06-08', '2026-10-03']) assert.ok(!events.includes(bad), `${bad} in analytics`);
  for (const row of events.trim().split('\n').map((l) => JSON.parse(l))) {
    assert.ok(Object.keys(row).every((k) => ['t', 'who', 'event', 'item_id', 'stage', 'surface', 'items', 'level', 'via', 'route', 'source'].includes(k)), JSON.stringify(row));
    assert.match(row.who, /^[0-9a-f]{16}$/);
  }
  const storage = fs.readFileSync(process.env.GAIA_PATH_RECS_FILE, 'utf8') + fs.readFileSync(process.env.GAIA_PATH_STATE_FILE, 'utf8');
  assert.doesNotMatch(storage, /"(energy|stress|chakras?|disbalance|value|severity|flag|scan_id|exp_id)"/, 'no reading fields in path storage');
  const src = fs.readFileSync(new URL('../path-routes.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../personal-path.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /memberReadings\(|get_customer_scan|get_scan_trend|get_customer_recommendations|list_flagged_customers/, 'the path never reads scan values or partner AI');
});

test('Gaia context line: public fields and the approved reason only, never the note or ids', async () => {
  assert.equal((await recommend('contact-pa', { resource_key: 'svc:7', note: 'Twice a day, gently.' })).status, 200, 'a revoked service can be recommended again');
  const line = await routes.assistPathLine({}, { contactId: 'member-a' }, { appointments: [] });
  assert.match(line, /PERSONAL PATH/);
  assert.match(line, /Recommended by your practitioner/);
  for (const bad of ['Twice a day', 'P-A', 'contact-pa', 'Ana Practitioner', 'member-a']) assert.ok(!line.includes(bad), `${bad} reached Gaia: ${line}`);
});

test('the routes sit behind the session and the onboarding gate', async () => {
  const { protectedMemberPath } = await import('../member-onboarding-guard.js');
  assert.equal(protectedMemberPath('/api/member/path'), true, 'incomplete onboarding never reaches the path: the gate is the first step');
  const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(srv, /url\.pathname\.startsWith\('\/api\/member\/path'\) \|\| url\.pathname\.startsWith\('\/api\/practitioners\/path\/'\)/);
});

test('a recommended scan completes itself when a newer scan arrives (opening the booking page does not)', async () => {
  const r = await recommend('contact-pa', { resource_key: 'cat:R-SCAN' });
  const key = `R:${r.data.recommendation.id}`;
  await call('POST', '/api/member/path/event', 'member-a', { event: 'recommendation_opened', key });
  assert.ok((await call('GET', '/api/member/path', 'member-a')).data.items.some((i) => i.key === key), 'opened is not booked');
  assert.equal((await call('POST', '/api/member/path/event', 'member-a', { event: 'recommendation_completed', key })).status, 409);
  const later = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  ml.rememberLatest('member-a', later, { file: LINKS });
  assert.ok(!(await call('GET', '/api/member/path', 'member-a')).data.items.some((i) => i.key === key), 'a newer scan completes it');
});

test('#279 consumes no partner AI recommendations, scripts, videos or reading values', () => {
  const src = ['path-routes.js', 'personal-path.js', 'path-store.js'].map((f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(src, /get_customer_recommendations|get_my_recommendations|memberGuides|\.script\b|video_url|video_status|memberReadings\(|get_customer_scan|get_scan_trend|get_client_summary|compare_protocol_before_after/);
});
