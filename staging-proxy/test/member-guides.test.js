/**
 * The guides a practitioner writes for a member, read for Gaia Assist ONLY
 * with the member's own switch (guides_to_assist):
 *   - shapeGuides accepts the partner's likely spellings, drops lines that
 *     quote scan values, keeps three short items, newest first
 *   - memberGuides: the member road (their member-mcp, if it offers the tool)
 *     and the practitioner road (the practitioner's own link); no road → null
 *   - the server gates on the switch on every build, keys its cache on it,
 *     and forgets fetched guides when the switch changes
 *   - the Practice tab shows which clients switched it on
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ml = await import('../member-link.js');
const o = await import('../practitioners-oauth.js');
const read = (name) => fs.readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
const tmp = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guides-')), n);
const rpcText = (rpc, obj) => new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(obj) }] } }), { status: 200, headers: { 'content-type': 'application/json' } });

test('shapeGuides: likely spellings, newest first, three at most, value lines dropped, bounded text', () => {
  const s = ml.shapeGuides({ recommendations: [
    { title: 'Breathing before sleep', content: 'Ten slow breaths.\nYour energy was 54 today.\nThen rest.', created_at: '2026-09-01T10:00:00Z' },
    { name: 'Hydration', text: 'Two litres a day, more after sessions.', date: '2026-10-01' },
    { subject: 'Walks', script: 'A twenty-minute walk after lunch.', createdAt: '2026-08-01' },
    { title: 'Old one', body: 'x'.repeat(900), created_at: '2025-01-01' },
    { title: 'No text', created_at: '2026-10-02' },
  ] });
  assert.equal(s.count, 5);
  assert.deepEqual(s.items.map((g) => g.title), ['Hydration', 'Breathing before sleep', 'Walks']);
  assert.equal(s.items[1].text, 'Ten slow breaths. Then rest.', 'the line quoting a reading is gone');
  assert.equal(s.items[0].when, '2026-10-01');
  assert.ok(ml.shapeGuides([{ title: 'Long', content: 'y'.repeat(900) }]).items[0].text.length <= 400);
  assert.deepEqual(ml.shapeGuides({ content: 'one guide, as an object' }).items.map((g) => g.text), ['one guide, as an object']);
  assert.deepEqual(ml.shapeGuides(null), { count: 0, items: [] });
  assert.deepEqual(ml.shapeGuides({ unrelated: true }), { count: 0, items: [] });
  const block = ml.guidesForModel(s);
  assert.match(block, /^- Hydration \(2026-10-01\): Two litres/);
  assert.ok(block.length <= 1400);
  assert.equal(ml.guidesForModel({ count: 0, items: [] }), '');
});

test('memberGuides: practitioner road reads the customer\'s guides with the practitioner\'s own link; no link or no road is null', async () => {
  const links = tmp('links.json'), tokens = tmp('tokens.json');
  const c = ml.mintCode('member-1', { file: links }); ml.redeemCode(c.code, { customer_id: 'cust-7', practitioner_id: '477' }, { file: links });
  const cfg = { environment: 'staging', base: 'https://staging.example', mcpUrl: 'https://staging.example/api/mcp', clientId: 'x', clientSecret: 'y' };
  const seen = [];
  const fetchImpl = async (url, init) => {
    const rpc = JSON.parse(init.body); seen.push([rpc.params?.name, rpc.params?.arguments]);
    return rpcText(rpc, { recommendations: [{ title: 'Hydration', content: 'Two litres a day.', created_at: '2026-10-01' }] });
  };
  // nobody connected: nothing to read, not an error
  assert.equal(await ml.memberGuides(cfg, 'member-1', { env: {}, fetchImpl, file: links, tokenFile: tokens }), null);
  // a different practitioner connected: still nothing
  o.saveToken('prac-other', { access_token: 'tA', expires_at: Date.now() + 3600e3, practitioner_id: '999', verified: true }, tokens);
  assert.equal(await ml.memberGuides(cfg, 'member-1', { env: {}, fetchImpl, file: links, tokenFile: tokens }), null);
  // their practitioner connected: read with THAT token, for THAT customer
  o.saveToken('prac-477', { access_token: 'tB', expires_at: Date.now() + 3600e3, practitioner_id: '477', verified: true }, tokens);
  const g = await ml.memberGuides(cfg, 'member-1', { env: {}, fetchImpl, file: links, tokenFile: tokens });
  assert.deepEqual(seen, [['get_customer_recommendations', { customerId: 'cust-7' }]]);
  assert.equal(g.items[0].title, 'Hydration');
  // a rejected practitioner link never reads
  o.saveToken('prac-477', { access_token: 'tB', expires_at: Date.now() + 3600e3, practitioner_id: '477', verified: false }, tokens);
  assert.equal(await ml.memberGuides(cfg, 'member-1', { env: {}, fetchImpl, file: links, tokenFile: tokens }), null);
  // not linked at all
  assert.equal(await ml.memberGuides(cfg, 'nobody', { env: {}, fetchImpl, file: links, tokenFile: tokens }), null);
});

test('memberGuides: the member road is tried first when their member-mcp offers a recommendations tool', async () => {
  const links = tmp('links.json'), tokens = tmp('tokens.json');
  const c = ml.mintCode('member-2', { file: links }); ml.redeemCode(c.code, { customer_id: 'cust-8', practitioner_id: '477' }, { file: links });
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/gaia/member-token')) return new Response(JSON.stringify({ token: 'mt', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    const rpc = JSON.parse(init.body);
    if (rpc.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'get_my_profile' }, { name: 'get_my_recommendations' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    calls.push([u.includes('/api/member-mcp'), rpc.params.name]);
    return rpcText(rpc, [{ title: 'Walks', text: 'A short walk after lunch.' }]);
  };
  ml._resetServerTokenForTest?.();
  const cfg = { environment: 'staging', base: 'https://staging.example', mcpUrl: 'https://staging.example/api/mcp', clientId: 'x', clientSecret: 'y' };
  const g = await ml.memberGuides(cfg, 'member-2', { env: { GAIA_PRACTITIONERS_MEMBER_API_KEY: 'k', GAIA_PRACTITIONERS_MEMBER_BACKEND: 'https://backend.example' }, fetchImpl, file: links, tokenFile: tokens });
  assert.deepEqual(calls, [[true, 'get_my_recommendations']]);
  assert.equal(g.items[0].title, 'Walks');
});

test('linksForPractitioner carries each client\'s switch as a boolean, never the guides or the member id', () => {
  const links = tmp('links.json');
  for (const [m, cu] of [['m-a', 'c1'], ['m-b', 'c2']]) { const c = ml.mintCode(m, { file: links }); ml.redeemCode(c.code, { customer_id: cu, practitioner_id: 'p-1' }, { file: links }); }
  const rows = ml.linksForPractitioner('p-1', links, { consent: (mid) => mid === 'm-b' });
  assert.deepEqual(rows.map((r) => [r.customer_id, r.guides_to_assist]).sort(), [['c1', false], ['c2', true]]);
  assert.ok(rows.every((r) => !('memberId' in r) && !('guides' in r)));
  assert.equal(ml.linksForPractitioner('p-1', links)[0].guides_to_assist, false, 'no lookup given: off');
});

test('the server: consent gates every build and keys the cache; the switch forgets fetched guides; Practice sees the switch', () => {
  const srv = read('staging-proxy/server.js');
  const ctx = srv.slice(srv.indexOf('async function buildMemberVoiceContext'), srv.indexOf('async function assistContext'));
  assert.match(ctx, /Boolean\(getPrefs\(member\.contactId\)\.guides_to_assist\)\]\)/, 'the context cache key carries the switch');
  assert.match(ctx, /if \(getPrefs\(cid\)\.guides_to_assist\) \{\n\s+const text = await memberGuidesCached\(cid\);/, 'guides are read only behind the switch');
  assert.match(ctx, /PRACTITIONER GUIDES: not shared with you/, 'off: the model is told where the switch is, nothing else');
  assert.match(ctx, /never state scan values/);
  assert.match(srv, /_memberGuidesCache\.delete\(id\);\s+\/\/ a changed switch takes effect on the next turn/);
  assert.match(srv, /linksForPractitioner\(pid, undefined, \{ consent: \(mid\) => getPrefs\(mid\)\.guides_to_assist \}\)/);
  assert.match(srv, /guidesForModel\(await memberGuides\(practitionersConfig\(\), cid\)\)/);
  const ui = read('gaia-practitioner.js');
  assert.match(ui, /g-prac__tag--guides/);
  assert.match(ui, /let Gaia Assist use the guides you write for them/);
});
