/**
 * MEMBER ↔ PRACTITIONER LINK — consent code, redeem, revoke, and the member's
 * own readings through a confirmed link. Offline: the partner is a local fake
 * (token endpoint + MCP), the member is a forged session cookie, nothing is
 * paid and no real site is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlink-'));
const LINK_FILE = path.join(dir, 'member-links.json');
const SECRET = 'member-link-session-secret-'.padEnd(48, 'x');
const LINK_SECRET = 'partner-shared-link-secret-0123456789';
const PORT = 8971;

// ── a fake Gaia Practitioners backend, to huMan's contract of 4 Oct ──────────
//   POST /api/gaia/member-token { gaiaMemberId } -> 1-hour token for ONE member
//   GET/DELETE /api/gaia/member-links/{id}        link status / unlink
//   POST /api/member-mcp                           member-only MCP with that token
// `shape` switches the tool names the fake offers: the member-named ones we
// proposed, or the practitioner-named ones scoped by the member token.
const partner = { tokens: 0, calls: [], backend: [], shape: 'member' };
const API_KEY = 'gaia-member-api-key-for-staging';
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/gaia/')) {
      partner.backend.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
      if (req.headers.authorization !== `Bearer ${API_KEY}`) { res.statusCode = 401; res.end('{"error":"unauthorized"}'); return; }
      if (req.method === 'POST' && req.url === '/api/gaia/member-token') {
        const { gaiaMemberId } = JSON.parse(body || '{}');
        if (gaiaMemberId !== 'member-A' && gaiaMemberId !== 'member-C') { res.statusCode = 404; res.end('{"code":"member_not_linked"}'); return; }
        partner.tokens += 1; res.end(JSON.stringify({ token: `mt-${gaiaMemberId}`, expires_in: 3600 })); return;
      }
      const m = /^\/api\/gaia\/member-links\/([^/?]+)$/.exec(req.url);
      if (m && req.method === 'GET') { res.end(JSON.stringify({ gaia_member_id: m[1], customer_id: 'cust-1', practitioner_id: 'prac-9', status: 'confirmed' })); return; }
      if (m && req.method === 'DELETE') { res.end('{"ok":true}'); return; }
      res.statusCode = 404; res.end('{}'); return;
    }
    if (req.url === '/api/member-mcp') {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer mt-')) { res.statusCode = 401; res.end('{}'); return; }
      const who = auth.slice('Bearer mt-'.length);
      const rpc = JSON.parse(body);
      if (rpc.method === 'tools/list') {
        const names = partner.shape === 'member' ? ['get_my_profile', 'get_my_latest_scan', 'get_my_scan_trend', 'get_my_before_after', 'list_my_shared_files'] : ['get_customer', 'get_customer_scan', 'get_scan_trend', 'get_customer_files'];
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: names.map((n) => ({ name: n })) } })); return;
      }
      const { name, arguments: args } = rpc.params; partner.calls.push({ name, args, who });
      const text = (o) => JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(o) }] } });
      const SCAN = { scanned_at: '2026-09-24T10:00:00Z', labeled: { stress: 3.91, energy: 54.2, chakras: [{ name: 'Root', value: 4.12, align: -0.8 }], organs: [{ name: 'Liver', disbalance: 2.4 }], meridians: [], systems: [] } };
      if (name === 'get_my_profile') { res.end(text({ member: { name: 'Test Member', linked_at: '2026-10-04T13:17:50.000Z' }, practitioner: { name: 'Dr Test', specialty: 'Yoga', city: 'San Dimas', state: 'CA' } })); return; }
      if (name === 'get_customer') { res.end(text({ customer_id: 'cust-1', id: 'cust-1', practitioner: { id: 'prac-9', name: 'Dr Test' }, has_biowell_card: true, scans_on_file: 3 })); return; }
      // their real shape (4 Oct): values under `values`, count beside it
      if (name === 'get_my_latest_scan') { res.end(text({ scan: { exp_id: 1, scanned_at: SCAN.scanned_at, values: SCAN.labeled }, scanCount: 3 })); return; }
      if (name === 'get_my_before_after') { res.end(text({ comparisons: [{ source: 'time', protocol: null, before: { date: '2026-08-01' }, after: { date: '2026-09-24' }, deltas: { stress: -0.4, energy: 6.2, disbalance: [{ name: 'Liver', before: 4, after: 2, delta: -2 }] } }] })); return; }
      if (name === 'list_my_shared_files') { res.end(text({ count: 1, files: [{ id: 'f1', name: 'Protocol.pdf', download_url: 'https://x/f1', uploaded_at: '2026-09-25' }] })); return; }
      if (name === 'get_customer_scan') { res.end(text({ customer: { id: 'cust-1' }, scans: [{ ...SCAN, scanned_at: '2026-08-01T10:00:00Z', labeled: { ...SCAN.labeled, stress: 9 } }, SCAN] })); return; }
      if (name === 'get_my_scan_trend' || name === 'get_scan_trend') { res.end(text({ scanCount: 3, summary: { energy: { min: 40, max: 60, avg: 50, latest: 54 }, stress: { min: 2, max: 4, avg: 3, latest: 3.9 } }, flags: [{ category: 'organs', name: 'Heart', direction: 'worsening', flagReason: 'disbalance_high', severity: 'high', delta: 12.3 }] })); return; }
      if (name === 'get_member_files' || name === 'get_customer_files') { res.end(text({ files: [{ id: 'f1', name: 'Protocol.pdf', shareable: true, uploaded_at: '2026-09-25' }, { id: 'f2', name: 'private.pdf', shareable: false }] })); return; }
      res.statusCode = 404; res.end('{}'); return;
    }
    res.statusCode = 404; res.end();
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${fake.address().port}`;

Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1', GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9', GAIA_DISABLE_ALERT_TIMER: '1', STORE_SYNC_ENABLED: 'false', GAIA_USAGE_LOG: '',
  AUTH_SESSION_SECRET: SECRET, COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, GHL_WORKFLOW_WEBHOOK_SECRET: SECRET,
  GAIA_MEMBER_READINGS_ENABLED: 'true', GAIA_MEMBER_LINK_FILE: LINK_FILE, GAIA_PRACTITIONERS_LINK_SECRET: LINK_SECRET,
  GAIA_PRACTITIONERS_MEMBER_API_KEY: API_KEY, GAIA_PRACTITIONERS_MEMBER_BACKEND: BASE,
  GAIA_PRACTITIONERS_ENABLED: 'true', GAIA_PRACTITIONERS_CLIENT_ID: 'cid', GAIA_PRACTITIONERS_CLIENT_SECRET: 'csecret',
  GAIA_PRACTITIONERS_OAUTH_BASE: BASE, GAIA_PRACTITIONERS_MCP_URL: `${BASE}/api/mcp`, GAIA_PRACTITIONERS_REDIRECT_URI: 'https://api.gaiahealers.app/api/practitioners/callback',
});
process.chdir(dir);
const ml = await import('../member-link.js');
const srv = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => { srv.closeServer?.(); fake.close(); });

const session = (contactId) => { const b = Buffer.from(JSON.stringify({ member: { contactId, email: `${contactId}@example.test` }, exp: Date.now() + 3600_000 })).toString('base64url'); return `gaia_member_session=${b}.${crypto.createHmac('sha256', SECRET).update(b).digest('base64url')}`; };
async function call(pathname, { method = 'GET', headers = {}, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// ── unit ──────────────────────────────────────────────────────────────────
test('a code is 8 unambiguous characters, lives 24 hours, works once, and replaces an earlier code', () => {
  assert.equal(ml.CODE_TTL_MS, 24 * 60 * 60 * 1000);
  const f = path.join(dir, 'unit.json');
  const a = ml.mintCode('m1', { file: f });
  assert.match(a.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  assert.ok(a.consent_recorded_at);
  const b = ml.mintCode('m1', { file: f });
  assert.notEqual(a.code, b.code);
  assert.throws(() => ml.redeemCode(a.code, { customer_id: 'c', practitioner_id: 'p' }, { file: f }), (e) => e.code === 'code_invalid', 'the replaced code is dead');
  const out = ml.redeemCode(b.code.toLowerCase(), { customer_id: 'c', practitioner_id: 'p', practitioner_name: 'Dr X' }, { file: f });
  assert.deepEqual([out.gaia_member_id, out.status], ['m1', 'confirmed']);
  assert.throws(() => ml.redeemCode(b.code, { customer_id: 'c2', practitioner_id: 'p' }, { file: f }), (e) => e.code === 'code_invalid', 'single use');
  assert.throws(() => ml.mintCode('m1', { file: f }), (e) => e.code === 'already_linked');
  const st = ml.linkStatus('m1', { file: f });
  assert.equal(st.linked, true); assert.equal(st.practitioner_name, 'Dr X');
  const c = ml.mintCode('m2', { now: 1000, file: f });
  assert.throws(() => ml.redeemCode(c.code, { customer_id: 'c3', practitioner_id: 'p' }, { now: 1000 + ml.CODE_TTL_MS + 1, file: f }), (e) => e.code === 'code_expired');
  assert.throws(() => ml.redeemCode('ABCD1234', { customer_id: 'c', practitioner_id: 'p' }, { file: f }), (e) => e.code === 'code_invalid', 'a typo can only fail');
});

test('unlink works from either side and is idempotent; the audit names who', () => {
  const f = path.join(dir, 'unit2.json');
  const a = ml.mintCode('m1', { file: f }); ml.redeemCode(a.code, { customer_id: 'c', practitioner_id: 'p' }, { file: f });
  assert.deepEqual(ml.revokeLink({ customer_id: 'c' }, 'practitioner', { file: f }).revoked, true);
  assert.equal(ml.revokeLink({ memberId: 'm1' }, 'member', { file: f }).revoked, false, 'already revoked');
  assert.equal(ml.linkStatus('m1', { file: f }).status, 'revoked');
  const store = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(store.audit.map((e) => e.event), ['consent_code_issued', 'link_confirmed', 'link_revoked']);
  assert.equal(store.audit[2].by, 'practitioner');
  assert.ok(!JSON.stringify(store).includes('stress'), 'the store never holds clinical data');
  assert.equal((fs.statSync(f).mode & 0o777), 0o600);
});

test('the partner bearer is checked in constant time and only with a real secret', () => {
  const env = { GAIA_PRACTITIONERS_LINK_SECRET: LINK_SECRET };
  assert.equal(ml.partnerAuthorized({ headers: { authorization: `Bearer ${LINK_SECRET}` } }, env), true);
  assert.equal(ml.partnerAuthorized({ headers: { authorization: `Bearer ${LINK_SECRET}x` } }, env), false);
  assert.equal(ml.partnerAuthorized({ headers: {} }, env), false);
  assert.equal(ml.partnerAuthorized({ headers: { authorization: 'Bearer short' } }, { GAIA_PRACTITIONERS_LINK_SECRET: 'short' }), false, 'a short secret is no secret');
});

// ── routes ────────────────────────────────────────────────────────────────
test('member routes need a session; partner routes need the link secret and nothing else', async () => {
  assert.equal((await call('/api/practitioners/member-link/status')).status, 401);
  assert.equal((await call('/api/practitioners/member-link/code', { method: 'POST', body: {} })).status, 401);
  assert.equal((await call('/api/practitioners/member-link/redeem', { method: 'POST', body: { code: 'ABCD2345', customer_id: 'c', practitioner_id: 'p' } })).status, 401);
  assert.equal((await call('/api/practitioners/member-link/redeem', { method: 'POST', headers: { cookie: session('member-A') }, body: { code: 'ABCD2345', customer_id: 'c', practitioner_id: 'p' } })).status, 401, 'a member cookie does not authorise the partner route');
  assert.equal((await call('/api/practitioners/my-readings', { headers: { cookie: session('member-A') } })).status, 404, 'not linked yet');
});

test('the whole flow: consent code -> partner redeems -> readings served from the partner for that member only', async () => {
  const st0 = await call('/api/practitioners/member-link/status', { headers: { cookie: session('member-A') } });
  assert.equal(st0.json.linked, false); assert.equal(st0.json.available, true);
  const code = await call('/api/practitioners/member-link/code', { method: 'POST', headers: { cookie: session('member-A') }, body: {} });
  assert.equal(code.status, 200); assert.match(code.json.code, /^[A-Z2-9]{8}$/);
  const bad = await call('/api/practitioners/member-link/redeem', { method: 'POST', headers: { authorization: `Bearer ${LINK_SECRET}` }, body: { code: 'ZZZZ9999', customer_id: 'cust-1', practitioner_id: 'prac-9' } });
  assert.equal(bad.status, 404); assert.equal(bad.json.error, 'code_invalid');
  const ok = await call('/api/practitioners/member-link/redeem', { method: 'POST', headers: { authorization: `Bearer ${LINK_SECRET}` }, body: { code: code.json.code, customer_id: 'cust-1', practitioner_id: 'prac-9', practitioner_name: 'Dr Test' } });
  assert.equal(ok.status, 200); assert.equal(ok.json.gaia_member_id, 'member-A');
  const st1 = await call('/api/practitioners/member-link/status', { headers: { cookie: session('member-A') } });
  assert.equal(st1.json.linked, true); assert.equal(st1.json.practitioner_name, 'Dr Test');
  const r = await call('/api/practitioners/my-readings', { headers: { cookie: session('member-A') } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.practitioner.name, 'Dr Test');
  assert.equal(r.json.latest.stress, 3.91); assert.equal(r.json.latest.energy, 54);
  assert.deepEqual(r.json.latest.chakras, [{ name: 'Root', value: 4.12, alignment: -1 }]);
  assert.deepEqual(r.json.latest.most_out_of_balance, [{ area: 'organ', name: 'Liver', disbalance: 2 }]);
  assert.equal(r.json.trend.energy.latest, 54); assert.equal(r.json.trend.flagged[0].name, 'Heart');
  assert.deepEqual(r.json.files.map((f) => f.name), ['Protocol.pdf']);
  const names = partner.calls.map((c) => c.name);
  assert.ok(['get_my_profile', 'get_my_latest_scan', 'get_my_scan_trend', 'get_my_before_after', 'list_my_shared_files'].every((n) => names.includes(n)), names.join(','));
  assert.equal(r.json.practitioner.specialty, 'Yoga'); assert.equal(r.json.practitioner.location, 'San Dimas, CA');
  assert.equal(r.json.scans_on_file, 3);
  assert.deepEqual(r.json.trend.flagged[0], { name: 'Heart', area: 'organ', direction: 'worsening', severity: 'high', change: 12, reason: 'disbalance_high' });
  assert.equal(r.json.comparisons[0].energy_change, 6.2); assert.equal(r.json.comparisons[0].biggest_changes[0].name, 'Liver');
  assert.equal(r.json.files[0].url, 'https://x/f1');
  assert.ok(partner.calls.every((c) => c.who === 'member-A'), 'every read is made with the one-member token');
  assert.ok(!names.includes('list_customers') && !names.includes('search_customers'));
  assert.equal(partner.tokens, 1, 'one member token, reused within its hour');
  assert.ok(partner.backend.every((b) => b.auth === `Bearer ${API_KEY}`), 'their backend is always called with the API key as a bearer');
  // another member, same cookie mechanism, cannot see member-A
  assert.equal((await call('/api/practitioners/my-readings', { headers: { cookie: session('member-B') } })).status, 404);
});

test('the member stops sharing: local revoke first, partner told, readings gone', async () => {
  const before = partner.calls.length;
  const out = await call('/api/practitioners/member-link/unlink', { method: 'POST', headers: { cookie: session('member-A') }, body: {} });
  assert.equal(out.status, 200); assert.equal(out.json.revoked, true);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(partner.backend.some((b) => b.method === 'DELETE' && b.url === '/api/gaia/member-links/member-A'), 'their backend was told: DELETE /api/gaia/member-links/{gaia_member_id}');
  assert.equal((await call('/api/practitioners/my-readings', { headers: { cookie: session('member-A') } })).status, 404);
  const st = await call('/api/practitioners/member-link/status', { headers: { cookie: session('member-A') } });
  assert.equal(st.json.linked, false); assert.equal(st.json.status, 'revoked');
});

test('the practitioner can revoke from their side with the link secret', async () => {
  const code = await call('/api/practitioners/member-link/code', { method: 'POST', headers: { cookie: session('member-C') }, body: {} });
  await call('/api/practitioners/member-link/redeem', { method: 'POST', headers: { authorization: `Bearer ${LINK_SECRET}` }, body: { code: code.json.code, customer_id: 'cust-C', practitioner_id: 'prac-9' } });
  const rv = await call('/api/practitioners/member-link/revoke', { method: 'POST', headers: { authorization: `Bearer ${LINK_SECRET}` }, body: { customer_id: 'cust-C' } });
  assert.equal(rv.status, 200); assert.equal(rv.json.revoked, true);
  assert.equal((await call('/api/practitioners/member-link/status', { headers: { cookie: session('member-C') } })).json.status, 'revoked');
});

test('the flag off means the routes do not exist', async () => {
  const { memberReadingsEnabled } = ml;
  assert.equal(memberReadingsEnabled({}), false);
  assert.equal(memberReadingsEnabled({ GAIA_MEMBER_READINGS_ENABLED: 'true' }), true);
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!memberReadingsEnabled\(\)\) \{ sendJson\(res, 404/);
});

test('if their member MCP offers practitioner-named tools scoped by the token, the same screen is served', async () => {
  partner.shape = 'practitioner'; ml._resetServerTokenForTest();
  const code = await call('/api/practitioners/member-link/code', { method: 'POST', headers: { cookie: session('member-A') }, body: {} });
  // member-A was revoked above; a new code and redeem re-links
  await call('/api/practitioners/member-link/redeem', { method: 'POST', headers: { authorization: `Bearer ${LINK_SECRET}` }, body: { code: code.json.code, customer_id: 'cust-1', practitioner_id: 'prac-9', practitioner_name: 'Dr Test' } });
  const r = await call('/api/practitioners/my-readings', { headers: { cookie: session('member-A') } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.latest.scanned_at, '2026-09-24', 'the newest of the history is shown');
  assert.equal(r.json.latest.stress, 3.91);
  assert.equal(r.json.scans_on_file, 3);
  const used = partner.calls.filter((c) => c.who === 'member-A').map((c) => c.name);
  assert.ok(used.includes('get_customer_scan') && used.includes('get_scan_trend') && used.includes('get_customer_files'));
  assert.ok(partner.calls.filter((c) => c.name === 'get_customer_scan').every((c) => c.args.customerId === 'cust-1'), 'scoped by the customer the link names');
  partner.shape = 'member';
});

test('memberBackend: staging by default, production host for the production environment, explicit override wins', async () => {
  assert.equal(ml.memberBackend({ environment: 'staging' }, {}), 'https://staging-backend.gaiapractitioners.com');
  assert.equal(ml.memberBackend({ environment: 'production' }, {}), 'https://backend.gaiapractitioners.com');
  assert.equal(ml.memberBackend({ environment: 'production' }, { GAIA_PRACTITIONERS_MEMBER_BACKEND: 'https://x.example/' }), 'https://x.example');
});

test('the allow-list: named members see the feature, everyone else gets 404 (so the panel stays hidden)', async () => {
  assert.equal(ml.memberAllowed('x', {}), true, 'unset = everyone');
  assert.equal(ml.memberAllowed('x', { GAIA_MEMBER_READINGS_MEMBERS: 'a, x ,b' }), true);
  assert.equal(ml.memberAllowed('y', { GAIA_MEMBER_READINGS_MEMBERS: 'a,x' }), false);
  process.env.GAIA_MEMBER_READINGS_MEMBERS = 'member-A';
  try {
    assert.equal((await call('/api/practitioners/member-link/status', { headers: { cookie: session('member-Z') } })).status, 404);
    assert.equal((await call('/api/practitioners/member-link/status', { headers: { cookie: session('member-A') } })).status, 200);
  } finally { delete process.env.GAIA_MEMBER_READINGS_MEMBERS; }
});

test('an empty latest scan is replaced by the newest trend point, labelled as such', async () => {
  const { memberReadings } = ml;
  // a fake partner right here: empty latest scan, full trend
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/api/gaia/member-token')) return json({ token: 'mt', expires_in: 3600 });
    const rpc = JSON.parse(init.body);
    if (rpc.method === 'tools/list') return json({ jsonrpc: '2.0', id: 1, result: { tools: ['get_my_profile', 'get_my_latest_scan', 'get_my_scan_trend', 'get_my_before_after', 'list_my_shared_files'].map((n) => ({ name: n })) } });
    const name = rpc.params.name; calls.push(name);
    const text = (o) => json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(o) }] } });
    if (name === 'get_my_latest_scan') return text({ scan: { exp_id: 1, scanned_at: '2026-06-14T14:49:28Z', values: { stress: null, energy: null, chakras: [], organs: [], meridians: [], systems: [] } }, scanCount: 104 });
    if (name === 'get_my_scan_trend') return text({ scanCount: 104, points: [{ scanned_at: '2024-09-16T17:16:38Z', energy: null, stress: null }, { scanned_at: '2026-06-14T14:49:28Z', energy: 53.597, stress: 3.0091 }, { scanned_at: '2026-05-01T10:00:00Z', energy: 60, stress: 2 }], summary: { energy: { min: 53.6, max: 76.8, avg: 59.5, latest: 53.6 }, stress: { min: 1.4, max: 3, avg: 1.9, latest: 3 } }, organTrends: [{ category: 'organs', name: 'Kidneys', latest: 46.06, delta: 33.56, direction: 'worsening', flagged: true, flagReason: 'disbalance_high', severity: 'high' }, { category: 'systems', name: 'Nervous system', latest: 7.2 }], flags: [] });
    return text({});
  };
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mlink2-')); const f = path.join(dir2, 'links.json');
  const c = ml.mintCode('m9', { file: f }); ml.redeemCode(c.code, { customer_id: 'c9', practitioner_id: 'p9' }, { file: f });
  ml._resetServerTokenForTest();
  const cfg = { environment: 'staging', base: 'https://staging.example', mcpUrl: 'https://staging.example/api/mcp', clientId: 'x', clientSecret: 'y' };
  const r = await memberReadings(cfg, 'm9', { env: { GAIA_PRACTITIONERS_MEMBER_API_KEY: 'k', GAIA_PRACTITIONERS_MEMBER_BACKEND: 'https://backend.example' }, fetchImpl, file: f });
  assert.equal(r.latest.source, 'trend');
  assert.equal(r.latest.scanned_at, '2026-06-14'); assert.equal(r.latest.energy, 54); assert.equal(r.latest.stress, 3.01);
  assert.deepEqual(r.latest.chakras, []);
  assert.deepEqual(r.latest.most_out_of_balance[0], { area: 'organ', name: 'Kidneys', disbalance: 46 });
  assert.equal(r.scans_on_file, 104);
});

test('the server writes the "In short" summary from plain rules and a dated series for the sparkline', async () => {
  const { readingSummary } = ml;
  // No model anywhere: the same input always gives the same words.
  const s = readingSummary({
    latest: { scanned_at: '2026-06-14', energy: 54, stress: 3.9, chakras: [{ name: 'Root', value: 6.1 }, { name: 'Heart', value: 8.4 }, { name: 'Crown', value: 5.2 }] },
    trend: { energy: { lowest: 40, highest: 60, average: 50 }, stress: { lowest: 2, highest: 4, average: 3 }, flagged: [{ name: 'Heart', severity: 'high' }, { name: 'Kidneys', severity: 'elevated' }] },
    comparisons: [{ from: '2026-05-01', to: '2026-06-14', stress_change: -0.4, energy_change: 3.2 }],
    practitioner: 'Dr Test',
  });
  assert.equal(s.headline, 'Energy around your recent average · stress higher than usual');
  assert.ok(s.lines.some((l) => l.startsWith('Latest reading 2026-06-14: energy 54 (your 90-day range 40–60), stress 3.9 (range 2–4).')));
  assert.ok(s.lines.some((l) => l === '2 areas are flagged in the last 90 days, 1 of them high: Heart, Kidneys.'));
  assert.ok(s.lines.some((l) => l === 'Heart was your most active centre, Crown the quietest.'));
  assert.ok(s.lines.some((l) => l.includes('stress -0.40, energy +3.2')));
  assert.match(s.lines[s.lines.length - 1], /not a diagnosis/);
  assert.deepEqual(readingSummary({}), { headline: 'No reading yet', lines: ['These are reflective measurements, not a diagnosis — your practitioner is the person to ask about them.'] });
  assert.deepEqual(readingSummary({ latest: { scanned_at: '2026-01-01', energy: 50 }, trend: { flagged: [] } }).lines[1], 'Nothing was flagged by your practitioner\'s system in the last 90 days.');
});

test('memberReadings carries the summary and a sorted, numeric-only series (newest 24 points)', async () => {
  const { memberReadings } = ml;
  const points = [{ scanned_at: '2024-09-16T17:16:38Z', energy: null, stress: null }];
  for (let i = 0; i < 30; i++) points.push({ scanned_at: `2026-0${1 + (i % 6)}-${String(1 + i % 28).padStart(2, '0')}T10:00:00Z`, energy: 50 + i, stress: 2 + i / 10 });
  const fetchImpl = async (url, init) => {
    const u = String(url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/api/gaia/member-token')) return json({ token: 'mt', expires_in: 3600 });
    const rpc = JSON.parse(init.body);
    if (rpc.method === 'tools/list') return json({ jsonrpc: '2.0', id: 1, result: { tools: ['get_my_profile', 'get_my_latest_scan', 'get_my_scan_trend', 'get_my_before_after', 'list_my_shared_files'].map((n) => ({ name: n })) } });
    const text = (o) => json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(o) }] } });
    if (rpc.params.name === 'get_my_latest_scan') return text({ scan: { exp_id: 1, scanned_at: '2026-06-14T14:49:28Z', values: { stress: 3.9, energy: 54, chakras: [{ name: 'Root', value: 6.1, align: 1 }, { name: 'Heart', value: 8.4, align: 0 }], organs: [], meridians: [], systems: [] } }, scanCount: 31 });
    if (rpc.params.name === 'get_my_scan_trend') return text({ scanCount: 31, points, summary: { energy: { min: 40, max: 80, avg: 60, latest: 54 }, stress: { min: 2, max: 5, avg: 3, latest: 3.9 } }, organTrends: [], flags: [] });
    return text({});
  };
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'mlink3-')); const f = path.join(dir3, 'links.json');
  const c = ml.mintCode('m10', { file: f }); ml.redeemCode(c.code, { customer_id: 'c10', practitioner_id: 'p10', practitioner_name: 'Dr Series' }, { file: f });
  ml._resetServerTokenForTest();
  const cfg = { environment: 'staging', base: 'https://staging.example', mcpUrl: 'https://staging.example/api/mcp', clientId: 'x', clientSecret: 'y' };
  const r = await memberReadings(cfg, 'm10', { env: { GAIA_PRACTITIONERS_MEMBER_API_KEY: 'k', GAIA_PRACTITIONERS_MEMBER_BACKEND: 'https://backend.example' }, fetchImpl, file: f });
  assert.equal(r.series.length, 24, 'capped at 24');
  assert.equal(r.average_recent.count, 3);
  assert.equal(r.average_recent.energy, r.series.slice(-3).reduce((n,p)=>n+p.e,0)/3);
  assert.equal(r.average_recent.stress, r.series.slice(-3).reduce((n,p)=>n+p.s,0)/3);
  assert.ok(r.series.every(p=>p.id && p.at), 'scan identity and timestamp preserved');
  assert.ok(r.series.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.d) && typeof p.e === 'number' && typeof p.s === 'number'), 'dated, numeric only; the null 2024 point is dropped');
  assert.ok(r.series.every((p, i, a) => i === 0 || a[i - 1].d <= p.d), 'oldest to newest');
  assert.equal(r.summary.headline, 'Energy below your recent average · stress higher than usual');
  assert.ok(r.summary.lines.some((l) => l === 'Heart was your most active centre, Root the quietest.'));
  assert.match(r.summary.lines[r.summary.lines.length - 1], /Dr Series is the person to ask/);
});

test('a newer reading than the member has opened: remembered from any fetch, cleared by seen, refreshed from their side at most every six hours', async () => {
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'mlink4-')); const f = path.join(dir4, 'links.json');
  const c = ml.mintCode('m11', { file: f }); ml.redeemCode(c.code, { customer_id: 'c11', practitioner_id: 'p11' }, { file: f });
  assert.equal(ml.linkStatus('m11', { file: f }).new_reading, false, 'nothing known yet');
  assert.equal(ml.rememberLatest('nobody', '2026-06-14', { file: f }), false, 'only a confirmed link remembers');
  ml.rememberLatest('m11', '2026-06-14', { file: f });
  let st = ml.linkStatus('m11', { file: f });
  assert.equal(st.latest_scanned_at, '2026-06-14'); assert.equal(st.seen_scanned_at, null); assert.equal(st.new_reading, true);
  ml.markSeen('m11', '2026-06-14', { file: f });
  st = ml.linkStatus('m11', { file: f }); assert.equal(st.new_reading, false);
  ml.markSeen('m11', '2026-01-01', { file: f });
  assert.equal(ml.linkStatus('m11', { file: f }).seen_scanned_at, '2026-06-14', 'seen never goes backwards');
  assert.equal(ml.markSeen('m11', 'junk', { file: f }), false);
  // refresh: one small call, then none for six hours
  let calls = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/api/gaia/member-token')) return json({ token: 'mt', expires_in: 3600 });
    const rpc = JSON.parse(init.body);
    if (rpc.method === 'tools/list') return json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'get_my_latest_scan' }] } });
    calls++; assert.equal(rpc.params.name, 'get_my_latest_scan', 'only the latest scan is asked for');
    return json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ scan: { scanned_at: '2026-07-01T09:00:00Z', values: {} } }) }] } });
  };
  ml._resetServerTokenForTest();
  const cfg = { environment: 'staging', base: 'https://staging.example', mcpUrl: 'https://staging.example/api/mcp', clientId: 'x', clientSecret: 'y' };
  const env = { GAIA_PRACTITIONERS_MEMBER_API_KEY: 'k', GAIA_PRACTITIONERS_MEMBER_BACKEND: 'https://backend.example' };
  const t0 = Date.parse('2026-07-02T00:00:00Z');
  // the remembered date was written just now, so the first refresh is still inside the window
  assert.equal(await ml.refreshLatest(cfg, 'm11', { env, fetchImpl, file: f, now: Date.now() }), '2026-06-14'); assert.equal(calls, 0);
  assert.equal(await ml.refreshLatest(cfg, 'm11', { env, fetchImpl, file: f, now: Date.now() + ml.LATEST_CHECK_TTL_MS + 1000 }), '2026-07-01'); assert.equal(calls, 1);
  assert.equal(ml.linkStatus('m11', { file: f }).new_reading, true, 'newer than what was seen');
  assert.equal(await ml.refreshLatest(cfg, 'm11', { env, fetchImpl, file: f, now: Date.now() + ml.LATEST_CHECK_TTL_MS + 2000 }), '2026-07-01'); assert.equal(calls, 1, 'no second call inside six hours');
  // a failing partner keeps the remembered date and waits another six hours
  const failing = async () => { throw new Error('down'); };
  assert.equal(await ml.refreshLatest(cfg, 'm11', { env, fetchImpl: failing, file: f, now: Date.now() + 2 * ml.LATEST_CHECK_TTL_MS + 5000 }), '2026-07-01');
  assert.equal(await ml.refreshLatest(cfg, 'nobody', { env, fetchImpl, file: f }), null);
  void t0;
});

test('a practitioner note travels with the scan when their side sends one; absent otherwise', () => {
  const { memberScanView } = ml;
  assert.equal(memberScanView({ scanned_at: '2026-06-14', values: { stress: 3, energy: 50 } }).note, null);
  assert.equal(memberScanView({ scanned_at: '2026-06-14', practitioner_note: '  Rest more this week.  ', values: {} }).note, 'Rest more this week.');
  assert.equal(memberScanView({ scanned_at: '2026-06-14', values: { notes: 'x'.repeat(700) } }).note.length, 600);
  assert.equal(memberScanView({ scanned_at: '2026-06-14', values: { comment: 42 } }).note, null, 'only a string is a note');
});

test('"read this first": a pinned document, in any spelling, comes first and is marked', () => {
  const { readFirst } = ml;
  assert.equal(readFirst({ name: 'a.pdf' }), false);
  for (const f of [{ read_first: true }, { readFirst: 1 }, { pinned: true }, { featured: true }, { primary: true }, { tags: ['Read First'] }, { tags: ['pinned'] }]) assert.equal(readFirst(f), true, JSON.stringify(f));
  assert.equal(readFirst({ tags: ['notes'] }), false);
});

test('a practitioner sees which of THEIR clients share their readings, by customer id only, never a Gaia member id', () => {
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'mlink5-')); const f = path.join(dir5, 'links.json');
  for (const [m, c, p] of [['mA', 'c1', 'p-9'], ['mB', 'c2', 'p-9'], ['mC', 'c3', 'p-other']]) { const code = ml.mintCode(m, { file: f }); ml.redeemCode(code.code, { customer_id: c, practitioner_id: p }, { file: f }); }
  ml.rememberLatest('mA', '2026-06-14', { file: f }); ml.markSeen('mA', '2026-06-14', { file: f });
  ml.rememberLatest('mB', '2026-06-14', { file: f });
  const mine = ml.linksForPractitioner('p-9', f);
  assert.deepEqual(mine.map((x) => x.customer_id).sort(), ['c1', 'c2']);
  const a = mine.find((x) => x.customer_id === 'c1'), b = mine.find((x) => x.customer_id === 'c2');
  assert.equal(a.opened, true); assert.equal(a.opened_latest, true); assert.equal(b.opened, false);
  assert.ok(mine.every((x) => !('gaia_member_id' in x) && !('memberId' in x)));
  assert.deepEqual(ml.linksForPractitioner('', f), []);
  ml.revokeLink({ memberId: 'mA' }, 'member', { file: f });
  assert.deepEqual(ml.linksForPractitioner('p-9', f).map((x) => x.customer_id), ['c2'], 'a revoked link is gone from the practitioner view');
});

test('the offline member flow check walks the whole path and passes', async () => {
  const { spawn } = await import('node:child_process');
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL('../tools/member-flow-check.mjs', import.meta.url).pathname, '--json'], { env: { ...process.env, GAIA_MEMBER_LINK_FILE: '', GAIA_MEMBER_PREFS_FILE: '' } });
    let s = ''; p.stdout.on('data', (d) => { s += d; }); p.on('close', (code) => resolve({ code, s }));
  });
  assert.equal(out.code, 0, out.s.slice(-600));
  const j = JSON.parse(out.s.slice(out.s.indexOf('{')));
  assert.equal(j.ok, true); assert.ok(j.steps.length >= 18); assert.ok(j.steps.every((x) => x.ok));
});

test('the first opening of each reading date is audited (counts for the daily line), later openings are not', () => {
  const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'mlink6-')); const f = path.join(dir6, 'links.json');
  const c = ml.mintCode('m12', { file: f }); ml.redeemCode(c.code, { customer_id: 'c12', practitioner_id: 'p12' }, { file: f });
  ml.markSeen('m12', '2026-06-14', { file: f }); ml.markSeen('m12', '2026-06-14', { file: f }); ml.markSeen('m12', '2026-06-01', { file: f });
  const audit = JSON.parse(fs.readFileSync(f, 'utf8')).audit.filter((a) => a.event === 'reading_opened');
  assert.equal(audit.length, 1); assert.equal(audit[0].scanned_at, '2026-06-14');
  ml.markSeen('m12', '2026-07-01', { file: f });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).audit.filter((a) => a.event === 'reading_opened').length, 2, 'a newer reading opened is a new event');
});

test("linkDayCounts: today's events and the standing totals, counts only", () => {
  const dir7 = fs.mkdtempSync(path.join(os.tmpdir(), 'mlink7-')); const f = path.join(dir7, 'links.json');
  const c = ml.mintCode('m13', { file: f }); ml.redeemCode(c.code, { customer_id: 'c13', practitioner_id: 'p13' }, { file: f });
  ml.markSeen('m13', '2026-06-14', { file: f }); ml.revokeLink({ memberId: 'm13' }, 'member', { file: f });
  const t = ml.linkDayCounts({ file: f });
  assert.deepEqual(t, { day: new Date().toISOString().slice(0, 10), codes_issued: 1, links_confirmed: 1, readings_opened: 1, links_revoked: 1, confirmed: 0, revoked: 1 });
  assert.equal(ml.linkDayCounts({ file: f, now: Date.parse('2020-01-01T00:00:00Z') }).links_confirmed, 0, 'another day: nothing');
  assert.ok(!JSON.stringify(t).includes('m13'));
});
