// Isolated consent/link lifecycle regressions. No provider, real accounts or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-lifecycle-'));
process.env.GAIA_PARTNER_RECS_CACHE = path.join(dir, 'recommendations.json');
const ml = await import('../member-link.js');
const oauth = await import('../practitioners-oauth.js');
const { approvedForMember } = await import('../partner-recs.js');
const cfg = { environment: 'staging', base: 'https://partner.example.invalid', mcpUrl: 'https://partner.example.invalid/mcp' };
const env = { GAIA_PARTNER_RECS: 'staging', GAIA_DEPLOYMENT: 'staging', GAIA_PRACTITIONERS_MEMBER_API_KEY: 'fixture-key', GAIA_PRACTITIONERS_MEMBER_BACKEND: 'https://partner.example.invalid' };
let sequence = 0;
const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
const result = (v) => json({ result: { content: [{ type: 'text', text: JSON.stringify(v) }] } });
function fixture() {
  const id = 'member-' + ++sequence, file = path.join(dir, id + '.json');
  const link = (customer = 'customer-A', practitioner = 'practitioner-A') => {
    const code = ml.mintCode(id, { file });
    return ml.redeemCode(code.code, { customer_id: customer, practitioner_id: practitioner }, { file });
  };
  link();
  const relink = () => { ml.revokeLink({ memberId: id }, 'practitioner', { file }); link('customer-B', 'practitioner-B'); };
  return { id, file, link, relink };
}
const tokenReply = () => json({ token: 'fictional-token-' + ++sequence, expires_in: 3600 });
const recommendation = (name) => ({ recommendations: [{ recommendation_id: name, approval_status: 'approved', practitioner: { id: name }, items: [{ id: 'svc', type: 'service', title: name, action: { url: 'https://staging.gaiapractitioners.com/shop?service=svc' } }] }] });
const toolNames = ['get_my_profile', 'get_my_latest_scan', 'get_my_scan_trend', 'get_my_before_after', 'list_my_shared_files'];
function partner(answer) {
  return async (url, init) => {
    if (url.endsWith('/api/gaia/member-token')) return tokenReply();
    const rpc = JSON.parse(init.body);
    if (rpc.method === 'tools/list') return json({ result: { tools: toolNames.map(name => ({ name })) } });
    return answer(rpc.params.name, init);
  };
}

test('member token cache is reused only within the same link and backend', async () => {
  const f = fixture(); let calls = 0;
  const fetchImpl = async () => { calls++; return tokenReply(); };
  const a = await ml.memberToken(cfg, f.id, { env, file: f.file, fetchImpl });
  assert.equal(await ml.memberToken(cfg, f.id, { env, file: f.file, fetchImpl }), a);
  assert.equal(calls, 1);
  f.relink();
  assert.notEqual(await ml.memberToken(cfg, f.id, { env, file: f.file, fetchImpl }), a);
  assert.equal(calls, 2);
  await ml.memberToken(cfg, f.id, { env: { ...env, GAIA_PRACTITIONERS_MEMBER_BACKEND: 'https://other.example.invalid' }, file: f.file, fetchImpl });
  assert.equal(calls, 3);
});

test('an unlinked member never requests a token', async () => {
  await assert.rejects(ml.memberToken(cfg, 'not-linked', { env, file: path.join(dir, 'absent.json'), fetchImpl: () => { throw new Error('must not fetch'); } }), e => e.code === 'member_not_linked');
});

test('a token response from an obsolete link is discarded', async () => {
  const f = fixture(); let finish;
  const pending = ml.memberToken(cfg, f.id, { env, file: f.file, fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  f.relink(); finish(tokenReply());
  await assert.rejects(pending, e => e.code === 'link_changed');
  let calls = 0; await ml.memberToken(cfg, f.id, { env, file: f.file, fetchImpl: async () => { calls++; return tokenReply(); } });
  assert.equal(calls, 1);
});

test('approved recommendations never carry over to a different practitioner', async () => {
  const f = fixture(); let name = 'practitioner-A', calls = 0;
  const fetchImpl = async (url) => { calls++; return url.endsWith('/api/gaia/member-token') ? tokenReply() : result(recommendation(name)); };
  assert.equal((await approvedForMember(cfg, f.id, { env, linkFile: f.file, fetchImpl })).items[0].title, name);
  f.relink(); name = 'practitioner-B';
  const n = calls, next = await approvedForMember(cfg, f.id, { env, linkFile: f.file, fetchImpl });
  assert.equal(next.items[0].title, name); assert.equal(calls, n + 2);
});

test('recommendations arriving after a link change are not cached or served', async () => {
  const f = fixture(); let finish;
  const pending = approvedForMember(cfg, f.id, { env, linkFile: f.file, fetchImpl: async (url) => url.endsWith('/api/gaia/member-token') ? tokenReply() : new Promise(resolve => { finish = resolve; }) });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  f.relink(); finish(result(recommendation('practitioner-A')));
  assert.deepEqual((await pending).items, []);
  const next = await approvedForMember(cfg, f.id, { env, linkFile: f.file, fetchImpl: async url => url.endsWith('/api/gaia/member-token') ? tokenReply() : result(recommendation('practitioner-B')) });
  assert.equal(next.items[0].title, 'practitioner-B');
});

test('a legacy recommendation cache without link provenance is not used on outage', async () => {
  const f = fixture();
  fs.writeFileSync(process.env.GAIA_PARTNER_RECS_CACHE, JSON.stringify({ members: { [f.id]: { ok_at: Date.now(), items: [{ title: 'obsolete private item' }] } } }));
  const r = await approvedForMember(cfg, f.id, { env, linkFile: f.file, fetchImpl: async () => { throw new Error('unavailable'); } });
  assert.deepEqual(r.items, []);
});

for (const outcome of ['success', 'refused']) {
  test(`OAuth disconnect survives an in-flight refresh ${outcome}`, async () => {
    const file = path.join(dir, 'oauth-' + ++sequence + '.json');
    oauth.saveToken('practitioner', { access_token: 'old', refresh_token: 'old-refresh', expires_at: Date.now() - 1 }, file);
    let finish;
    const pending = oauth.validAccessToken(cfg, 'practitioner', { file, fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
    oauth.forgetToken('practitioner', file);
    finish(outcome === 'success' ? json({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400));
    await assert.rejects(pending, e => e.code === 'connection_changed');
    assert.equal(oauth.tokenFor('practitioner', file), null);
  });
}

test('a newer OAuth connection cannot be overwritten by an older refresh', async () => {
  const file = path.join(dir, 'oauth-' + ++sequence + '.json');
  oauth.saveToken('practitioner', { access_token: 'old', refresh_token: 'old-refresh', expires_at: Date.now() - 1 }, file);
  let finish; const pending = oauth.validAccessToken(cfg, 'practitioner', { file, fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  oauth.saveToken('practitioner', { access_token: 'new-account', refresh_token: 'new-account-refresh', expires_at: Date.now() + 3600000 }, file);
  finish(json({ access_token: 'obsolete-response', refresh_token: 'obsolete-refresh', expires_in: 3600 }));
  await assert.rejects(pending, e => e.code === 'connection_changed');
  assert.equal(oauth.tokenFor('practitioner', file).access_token, 'new-account');
});

test('old customer, practitioner or generation revokes cannot remove the current link', () => {
  const f = fixture(), old = ml.linkFor(f.id, f.file); f.relink();
  assert.equal(ml.revokeLink({ memberId: f.id, customer_id: old.customer_id, practitioner_id: old.practitioner_id }, 'practitioner', { file: f.file }).revoked, false);
  assert.equal(ml.revokeLink({ memberId: f.id, customer_id: 'customer-B', practitioner_id: 'wrong' }, 'practitioner', { file: f.file }).revoked, false);
  assert.equal(ml.revokeLink({ memberId: f.id, link_id: old.link_id }, 'practitioner', { file: f.file }).revoked, false);
  assert.equal(ml.linkFor(f.id, f.file).customer_id, 'customer-B');
});

test('complete provider failure is an error rather than an empty history', async () => {
  const f = fixture();
  await assert.rejects(ml.memberReadings(cfg, f.id, { env, file: f.file, fetchImpl: partner(() => json({ error: { code: 'unavailable', message: 'fixture failure' } })) }), e => e.status === 503 && e.code === 'readings_unavailable');
});

test('partial failure is labelled while successful data remains available', async () => {
  const f = fixture();
  const r = await ml.memberReadings(cfg, f.id, { env, file: f.file, fetchImpl: partner(name => name === 'list_my_shared_files' ? json({ error: { code: 'unavailable' } }) : result(name === 'get_my_latest_scan' ? { scan: { scanned_at: '2026-10-01', values: { energy: 54 } } } : {})) });
  assert.equal(r.partial, true); assert.equal(r.latest.energy, 54); assert.equal(r.errors.files, 'readings_unavailable');
});

test('partner revocation codes survive MCP errors and are not swallowed', async () => {
  const f = fixture();
  await assert.rejects(ml.memberReadings(cfg, f.id, { env, file: f.file, fetchImpl: partner(() => json({ error: { message: 'revoked', code: -32000, data: { code: 'link_revoked' } } })) }), e => e.code === 'link_revoked' && e.status === 410);
});

test('MCP isError is a failure, not an empty successful tool result', async () => {
  const f = fixture();
  await assert.rejects(ml.memberReadings(cfg, f.id, { env, file: f.file, fetchImpl: partner(() => json({ result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'link_revoked' }) }] } })) }), e => e.code === 'link_revoked');
});

test('general file fallback requires explicit sharing and safe URLs', async () => {
  const f = fixture();
  const files = [{ id: 'unmarked' }, { id: 'private', shareable: false }, { id: 'malformed', shareable: 'false' }, { id: 'allowed', shareable: true, download_url: 'https://files.example.invalid/read.pdf' }, { id: 'bad-url', shareable: true, url: 'javascript:alert(1)' }];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/api/gaia/member-token')) return tokenReply();
    const rpc = JSON.parse(init.body);
    if (rpc.method === 'tools/list') return json({ result: { tools: [...toolNames.filter(n => n !== 'list_my_shared_files'), 'get_customer_files'].map(name => ({ name })) } });
    return result(rpc.params.name === 'get_customer_files' ? { files } : {});
  };
  const r = await ml.memberReadings(cfg, f.id, { env, file: f.file, fetchImpl });
  assert.deepEqual(r.files.map(f => f.id), ['allowed', 'bad-url']); assert.equal(r.files[1].url, null);
});

test('dedicated shared-files tool may omit the marker but rejects malformed false', async () => {
  const f = fixture();
  const r = await ml.memberReadings(cfg, f.id, { env, file: f.file, fetchImpl: partner(name => result(name === 'list_my_shared_files' ? { files: [{ id: 'shared' }, { id: 'bad', shareable: 'false' }] } : {})) });
  assert.deepEqual(r.files.map(f => f.id), ['shared']);
});

test('an obsolete latest-date response cannot overwrite a new link', async () => {
  const f = fixture(); let finish;
  const pending = ml.refreshLatest(cfg, f.id, { env, file: f.file, fetchImpl: partner(() => new Promise(resolve => { finish = resolve; })) });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  f.relink(); finish(result({ scan: { scanned_at: '2026-10-01' } }));
  await pending; assert.equal(ml.linkStatus(f.id, { file: f.file }).latest_scanned_at, null);
});

test('a failed latest read is not described as a successfully empty history', async () => {
  const f = fixture();
  const r = await ml.memberReadings(cfg, f.id, { env, file: f.file, fetchImpl: partner(name => name === 'get_my_latest_scan' ? json({ error: { code: 'unavailable' } }) : result({})) });
  assert.equal(r.partial, true); assert.equal(r.summary.headline, 'Your reading could not be loaded');
});


test('provider authorization refusal purges recommendations instead of using stale content', async () => {
  for (const status of [401, 403, 404, 410]) {
    const f = fixture(), now = Date.now();
    const first = await approvedForMember(cfg, f.id, {env,linkFile:f.file,now,fetchImpl:async url => url.endsWith('/member-token') ? tokenReply() : result(recommendation('allowed'))});
    assert.equal(first.items.length, 1);
    const denied = await approvedForMember(cfg, f.id, {env,linkFile:f.file,now:now+11*60_000,fetchImpl:async () => json({error:'forbidden_scope'},status)});
    assert.equal(denied.state,'access_denied'); assert.deepEqual(denied.items,[]);
    const offline = await approvedForMember(cfg, f.id, {env,linkFile:f.file,now:now+12*60_000,fetchImpl:async () => {throw Error('offline');}});
    assert.deepEqual(offline.items,[]);
  }
});

const termsReply = () => json({ error: { code: -32001, message: 'Accept the AI data-sharing terms in your Gaia Practitioners dashboard (MCP Connection) first.' } });
test('member discovery consent denial stops before requesting any readings', async () => {
  const f = fixture(); let discoveries = 0;
  await assert.rejects(ml.memberReadings(cfg, f.id, { env, file: f.file, fetchImpl: async url => {
    if (url.endsWith('/member-token')) return tokenReply();
    discoveries++; return termsReply();
  } }), e => e.code === 'partner_terms_required' && e.status === 409);
  assert.equal(discoveries, 1); assert(ml.linkFor(f.id, f.file));
});
test('member tool consent denial cannot become partial or empty successful readings', async () => {
  const f = fixture();
  await assert.rejects(ml.memberReadings(cfg, f.id, { env, file: f.file, fetchImpl: partner(() => termsReply()) }), e => e.code === 'partner_terms_required' && e.status === 409);
});
test('consent denial purges cached recommendations and cannot serve stale items', async () => {
  const f = fixture(), now = Date.now();
  const first = await approvedForMember(cfg, f.id, { env, linkFile: f.file, now, fetchImpl: async url => url.endsWith('/member-token') ? tokenReply() : result(recommendation('allowed')) });
  assert.equal(first.items.length, 1);
  const denied = await approvedForMember(cfg, f.id, { env, linkFile: f.file, now: now + 11*60_000, fetchImpl: async () => termsReply() });
  assert.equal(denied.state, 'partner_terms_required'); assert.deepEqual(denied.items, []);
  const offline = await approvedForMember(cfg, f.id, { env, linkFile: f.file, now: now + 12*60_000, fetchImpl: async () => { throw Error('offline'); } });
  assert.deepEqual(offline.items, []);
});
