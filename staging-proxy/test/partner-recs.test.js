/**
 * Approved partner recommendations (get_my_recommendations) -> Personal Path.
 * Gate, URL validation, field whitelist, lifecycle, engine placement, routes,
 * and the AI boundary. Fake partner, temp files; no network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-prec-'));
process.env.GAIA_PARTNER_RECS_CACHE = path.join(DIR, 'cache.json');
const LINKS = path.join(DIR, 'links.json');
const ml = await import('../member-link.js');
const { partnerRecsGate, safeAction, shapeApproved, approvedForMember, PARTNER_HOSTS } = await import('../partner-recs.js');
const { buildPath, assistView, assistLine, RULE_IDS, memberMayComplete } = await import('../personal-path.js');
const tools = await import('../assist-tools.js');

const S = PARTNER_HOSTS.staging, P = PARTNER_HOSTS.production;
const STAGING_ENV = { GAIA_PARTNER_RECS: 'staging', GAIA_DEPLOYMENT: 'staging', GAIA_PRACTITIONERS_MEMBER_API_KEY: 'k', GAIA_PRACTITIONERS_MEMBER_BACKEND: 'https://staging-backend.gaiapractitioners.com' };
const CFG = { environment: 'staging', base: 'https://staging.gaiapractitioners.com', mcpUrl: 'https://staging.gaiapractitioners.com/api/mcp' };

// Planted hidden fields: none of these may survive shaping or reach Gaia.
const HIDDEN = { reasoning: 'SENTINEL_REASONING liver 32%', relevance: 0.9137, relevance_score: 0.9137, body_systems: ['SENTINEL_BODY_SYSTEM'], matched_systems: ['SENTINEL_BODY_SYSTEM'],
  script: 'SENTINEL_SCRIPT', video_url: 'https://evil.example/v.mp4', video_status: 'ready', scan_id: 'EXP-SENTINEL', energy: 54.321, stress: 3.987, flags: ['SENTINEL_FLAG'], trend: { energy: 61.61 } };
const item = (o = {}) => ({ rank: 1, type: 'service', id: 7, title: 'Chakra balancing session', summary: 'A gentle session to help you relax and reset.', action: { label: 'Book', url: 'https://staging.gaiapractitioners.com/shop?service=7' }, ...HIDDEN, ...o });
const rec = (items, o = {}) => ({ recommendation_id: 31, approval_status: 'approved', approved_at: '2026-10-05T10:00:00Z', created_at: '2026-10-04T10:00:00Z', practitioner: { id: 55, name: 'Sam Rivera' }, ...HIDDEN, items, ...o });

test('gate: off by default; staging only on a staging deployment against staging; production only with a confirmed BAA against production', () => {
  assert.equal(partnerRecsGate({}, 'staging').enabled, false);
  assert.equal(partnerRecsGate({ GAIA_PARTNER_RECS: 'staging' }, 'staging').reason, 'staging_source_outside_staging_deployment', 'the production server never sets GAIA_DEPLOYMENT=staging');
  assert.equal(partnerRecsGate({ GAIA_PARTNER_RECS: 'staging', GAIA_DEPLOYMENT: 'staging' }, 'production').enabled, false);
  assert.equal(partnerRecsGate({ GAIA_PARTNER_RECS: 'staging', GAIA_DEPLOYMENT: 'staging' }, 'staging').enabled, true);
  assert.equal(partnerRecsGate({ GAIA_PARTNER_RECS: 'production' }, 'production').reason, 'baa_not_confirmed');
  assert.equal(partnerRecsGate({ GAIA_PARTNER_RECS: 'production', GAIA_PARTNER_BAA_CONFIRMED: 'yes' }, 'production').enabled, false, 'a vague value is not a confirmation');
  assert.equal(partnerRecsGate({ GAIA_PARTNER_RECS: 'production', GAIA_PARTNER_BAA_CONFIRMED: '2026-11-01: signed BAA ref ABC' }, 'staging').enabled, false, 'never production mode against staging data');
  const on = partnerRecsGate({ GAIA_PARTNER_RECS: 'production', GAIA_PARTNER_BAA_CONFIRMED: '2026-11-01: signed BAA ref ABC' }, 'production');
  assert.equal(on.enabled, true); assert.deepEqual(on.hosts, P);
  assert.equal(partnerRecsGate({ GAIA_PARTNER_RECS: 'on' }, 'production').enabled, false, 'unknown modes are off');
});

test('URLs are untrusted: only the exact partner shop link for THIS item, rebuilt canonically', () => {
  assert.deepEqual(safeAction(item(), S), { label: 'Book', url: 'https://staging.gaiapractitioners.com/shop?service=7' });
  assert.deepEqual(safeAction(item({ type: 'product', id: 12, action: { url: 'https://staging.gaiapractitioners.com/shop?product=12&buy=1' } }), S), { label: 'Buy', url: 'https://staging.gaiapractitioners.com/shop?product=12&buy=1' });
  assert.deepEqual(safeAction(item({ type: 'product', id: 12, action: { url: 'https://staging.gaiapractitioners.com/shop?product=12' } }), S).label, 'View');
  const bad = ['http://staging.gaiapractitioners.com/shop?service=7', 'https://evil.example/shop?service=7', 'https://staging.gaiapractitioners.com.evil.example/shop?service=7',
    'https://user:pw@staging.gaiapractitioners.com/shop?service=7', 'https://staging.gaiapractitioners.com:8443/shop?service=7', 'https://staging.gaiapractitioners.com/shop/x?service=7',
    'https://staging.gaiapractitioners.com/shop?service=7&next=https://evil.example', 'https://staging.gaiapractitioners.com/shop?service=8', 'javascript:alert(1)', 'data:text/html,x',
    '//staging.gaiapractitioners.com/shop?service=7', 'https://staging.gaiapractitioners.com/shop?service=7#x', 'https://staging.gaiapractitioners.com/shop?service=7&service=9', '', null];
  for (const url of bad) assert.equal(safeAction(item({ action: { url } }), S), null, String(url));
  assert.equal(safeAction(item(), P), null, 'a staging link is never valid for production');
  assert.equal(safeAction(item({ type: 'product', id: 12, action: { url: 'https://staging.gaiapractitioners.com/shop?product=12&buy=yes' } }), S), null);
});

test('whitelist: only the kept fields survive; hidden fields, markup, links in text and unapproved records do not', () => {
  const data = { count: 3, recommendations: [
    rec([item(), item({ rank: 2, type: 'product', id: 12, title: '<b>Calming</b> spray', summary: 'Visit https://evil.example now', action: { label: 'Buy', url: 'https://staging.gaiapractitioners.com/shop?product=12&buy=1' } }), item() /* duplicate */, item({ id: 9, action: { url: 'https://evil.example/shop?service=9' } }), item({ title: '' })]),
    rec([item({ id: 99 })], { recommendation_id: 40, approval_status: 'pending' }),
  ] };
  const { items, dropped } = shapeApproved(data, S);
  assert.equal(items.length, 2, 'two kept: the duplicate collapses, the unsafe link and the untitled item drop');
  assert.equal(dropped, 3, 'unsafe link + untitled + one pending item');
  assert.deepEqual(Object.keys(items[0]).sort(), ['action', 'approved_at', 'created_at', 'id', 'key', 'practitioner_id', 'practitioner_name', 'rank', 'recommendation_id', 'summary', 'title', 'type']);
  assert.equal(items[1].title, 'Calming spray', 'markup stripped'); assert.equal(items[1].summary, null, 'a summary carrying a link is not shown');
  const blob = JSON.stringify(items);
  for (const bad of ['SENTINEL', '0.9137', '54.321', '3.987', '61.61', 'evil.example', 'script', 'reasoning', 'relevance']) assert.ok(!blob.includes(bad), bad);
});

test('lifecycle: fresh cache, replace on success (revoked disappears, summary updates), keep on outage, then expire', async () => {
  const { code } = ml.mintCode('member-a', { file: LINKS }); ml.redeemCode(code, { customer_id: 'c-a', practitioner_id: '55', practitioner_name: 'Sam Rivera' }, { file: LINKS });
  let answer = { count: 1, recommendations: [rec([item(), item({ rank: 2, id: 8, action: { url: 'https://staging.gaiapractitioners.com/shop?service=8' } })])] };
  const calls = []; let fail = false;
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), body });
    if (fail) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    if (String(url).endsWith('/api/gaia/member-token')) return new Response(JSON.stringify({ token: 'tok-' + body.gaiaMemberId, expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(answer) }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  ml._resetServerTokenForTest?.();
  const t0 = Date.parse('2026-10-06T12:00:00Z');
  const r1 = await approvedForMember(CFG, 'member-a', { env: STAGING_ENV, fetchImpl, now: t0, linkFile: LINKS });
  assert.equal(r1.state, 'ok'); assert.equal(r1.items.length, 2);
  const tokenCall = calls.find((c) => c.url.endsWith('/api/gaia/member-token'));
  assert.equal(tokenCall.body.gaiaMemberId, 'member-a', 'the token is minted for the session member only');
  const toolCall = calls.find((c) => c.body?.method === 'tools/call');
  assert.equal(toolCall.body.params.name, 'get_my_recommendations'); assert.deepEqual(toolCall.body.params.arguments, {}, 'no client id is ever sent: the token scopes it');
  const n = calls.length;
  assert.equal((await approvedForMember(CFG, 'member-a', { env: STAGING_ENV, fetchImpl, now: t0 + 60000, linkFile: LINKS })).state, 'fresh'); assert.equal(calls.length, n, 'within 10 minutes: no partner call');
  answer = { count: 1, recommendations: [rec([item({ summary: 'An updated, approved summary.' })])] };   // item 8 revoked; summary changed
  const r3 = await approvedForMember(CFG, 'member-a', { env: STAGING_ENV, fetchImpl, now: t0 + 11 * 60000, linkFile: LINKS });
  assert.deepEqual(r3.items.map((i) => i.id), ['7']); assert.equal(r3.items[0].summary, 'An updated, approved summary.');
  fail = true;
  const r4 = await approvedForMember(CFG, 'member-a', { env: STAGING_ENV, fetchImpl, now: t0 + 30 * 60000, linkFile: LINKS });
  assert.equal(r4.state, 'stale'); assert.deepEqual(r4.items.map((i) => i.id), ['7'], 'an outage never erases the last good list');
  const r5 = await approvedForMember(CFG, 'member-a', { env: STAGING_ENV, fetchImpl, now: t0 + 25 * 3600000, linkFile: LINKS });
  assert.equal(r5.state, 'unavailable'); assert.deepEqual(r5.items, [], 'after a day without a good read, nothing old is shown');
  fail = false; answer = { count: 0, recommendations: [] };
  assert.deepEqual((await approvedForMember(CFG, 'member-a', { env: STAGING_ENV, fetchImpl, now: t0 + 26 * 3600000, linkFile: LINKS })).items, [], 'zero recommendations');
  const before = calls.length;
  assert.equal((await approvedForMember(CFG, 'member-unlinked', { env: STAGING_ENV, fetchImpl, now: t0, linkFile: LINKS })).state, 'not_linked');
  assert.equal((await approvedForMember(CFG, 'member-a', { env: {}, fetchImpl, now: t0 + 40 * 3600000, linkFile: LINKS })).state, 'disabled');
  assert.equal((await approvedForMember({ ...CFG, environment: 'staging' }, 'member-a', { env: { ...STAGING_ENV, GAIA_DEPLOYMENT: '' }, fetchImpl, now: t0 + 41 * 3600000, linkFile: LINKS })).state, 'disabled', 'the production server (no staging deployment) never reads staging');
  assert.equal(calls.length, before, 'unlinked, disabled and wrong-deployment members cause no partner call');
});

const ok = { by: 'r', version: 1, at: 'x' };
const CAT = { version: 1, entries: RULE_IDS.map((id) => ({ id, kind: 'rule', version: 1, status: 'approved', active: true, approval: ok, sources: [{ type: 'business_rule', ref: 't' }] })) };
const shaped = (list) => shapeApproved({ recommendations: [rec(list)] }, S).items;
const svc = (id, rank = 1) => item({ id, rank, action: { url: `https://staging.gaiapractitioners.com/shop?service=${id}` } });
const prod = (id, rank = 2) => item({ type: 'product', id, rank, title: 'Calming spray', action: { url: `https://staging.gaiapractitioners.com/shop?product=${id}&buy=1` } });

test('engine: services are steps; a product is never first; products alone are only "also recommended"', () => {
  const one = buildPath({}, { catalogue: CAT, partnerRecs: shaped([svc(7)]) });
  assert.equal(one.items[0].provenance.source_type, 'partner_approved'); assert.equal(one.items[0].provenance.label, 'Recommended by your practitioner');
  assert.equal(one.items[0].action.label, 'Book'); assert.equal(one.items[0].completion, 'practitioner_booking'); assert.equal(memberMayComplete(one.items[0].action.kind), false);
  const several = buildPath({}, { catalogue: CAT, partnerRecs: shaped([prod(12, 1), svc(7, 2), svc(8, 3)]) });
  assert.deepEqual(several.items.map((i) => i.action.kind), ['partner_service', 'partner_service', 'partner_product'], 'product ranked 1 by the partner still comes after the steps');
  const onlyProducts = buildPath({}, { catalogue: CAT, partnerRecs: shaped([prod(12), prod(13)]) });
  assert.equal(onlyProducts.caught_up, true); assert.deepEqual(onlyProducts.items, []); assert.equal(onlyProducts.also_recommended.length, 2);
  assert.equal(onlyProducts.also_recommended[0].completion, 'order', 'buying/opening never completes it');
  const noSummary = buildPath({}, { catalogue: CAT, partnerRecs: shaped([svc(7)]).map((i) => ({ ...i, summary: null })) }).items[0];
  assert.equal(noSummary.reason, 'Your practitioner recommended this as part of your current wellness plan.'); assert.equal(noSummary.reason_source, 'default');
});

test('dedup: the same service of the same practitioner from both sources is one step (the partner item)', () => {
  const manual = { id: 'rec_manual0001', source_type: 'practitioner_manual', review_state: 'approved', practitioner_id: '55', practitioner_name: 'Sam Rivera', resource: { kind: 'service', id: '7', title: 'Chakra balancing session' }, member_safe_reason: 'x', created_at: '2026-10-01' };
  const p = buildPath({}, { catalogue: CAT, practitionerRecs: [manual, { ...manual, id: 'rec_manual0002', resource: { kind: 'service', id: '9', title: 'Other' } }], partnerRecs: shaped([svc(7)]) });
  assert.deepEqual(p.items.map((i) => i.provenance.source_type + ':' + (i.action.kind === 'partner_service' ? 'svc7' : i.title)).sort(), ['partner_approved:svc7', 'practitioner_manual:Other'], 'service 7 once (the partner item); service 9 (manual only) stays');
  const other = buildPath({}, { catalogue: CAT, practitionerRecs: [{ ...manual, practitioner_id: '77' }], partnerRecs: shaped([svc(7)]) });
  assert.equal(other.items.length, 2, 'a different practitioner is a different recommendation');
});

test('AI boundary: partner content never reaches the Gaia line; the tool can never be an Assist tool', async () => {
  const p = buildPath({}, { catalogue: CAT, partnerRecs: shaped([svc(7), prod(12)]) });
  const toAi = JSON.stringify(assistView(p)) + assistLine(p);
  for (const bad of ['Chakra balancing', 'Calming spray', 'gentle session', 'Sam Rivera', 'gaiapractitioners', 'shop?', 'SENTINEL', '55', '31']) assert.ok(!toAi.includes(bad), `${bad} reached Gaia: ${toAi}`);
  assert.match(toAi, /A recommendation from your practitioner \(details on their screen\)/);
  assert.ok(!tools.TOOLS.some((t) => /recommend/i.test(t.name) || /get_my_recommendations|get_customer_recommendations/.test(String(t.mcp || ''))), 'no Assist tool reads partner recommendations');
  await assert.rejects(() => tools.runTool('get_my_recommendations', {}, { contactId: 'x', isPractitioner: true }), (e) => e.code === 'unknown_tool');
  const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const srv = read('server.js');
  assert.equal((srv.match(/approvedForMember\(/g) || []).length, 1, 'one call site');
  assert.match(srv, /partnerRecsFor: \(member\) => approvedForMember\(/, '...and it only feeds the Personal Path routes');
  for (const f of ['server.js', 'assist-tools.js', 'assist-guide.js', 'member-link.js', 'qwen-voice-relay.js']) assert.doesNotMatch(read(f), /get_my_recommendations/, f + ' never names the tool');
  assert.doesNotMatch(read('personal-path.js') + read('path-routes.js'), /\.summary\b[^\n]*assist|\breasoning\b|\bbody_systems\b|\bscript\b|\bvideo(_url|_status)?\b/, 'path code never handles hidden partner fields');
});
