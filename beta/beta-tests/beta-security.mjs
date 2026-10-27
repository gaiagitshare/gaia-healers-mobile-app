// Security / isolation attack run against the loopback beta (127.0.0.1:8800). Prints statuses and counts only.
// Secrets are read into memory (to sign test cookies and to grep responses for leaks) and never printed.
import net from 'node:net'; import fs from 'node:fs'; import crypto from 'node:crypto'; import http from 'node:http';
const OUTMD = process.argv[2];
const BETA = { host: '127.0.0.1', port: 8800 };
const readEnv = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').map((l) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')]));
const ENVF = ['/root/.config/gaia-membership-beta.env', '/root/.config/gaia-membership-staging-proxy.env', '/root/.config/gaia-membership-staging-operators.env', '/root/.config/gaia-membership-staging.env'];
const envs = Object.fromEntries(ENVF.map((f) => [f, readEnv(f)]));
const BETAENV = envs[ENVF[0]];
// Secret values to look for in responses: anything under a secret-looking name, plus passwords inside DB URLs.
const SECRETS = [];
for (const [f, e] of Object.entries(envs)) for (const [k, v] of Object.entries(e)) {
  if (!v || v.length < 8) continue;
  if (/SECRET|TOKEN|KEY|PASSWORD|TOTP/.test(k)) SECRETS.push({ name: `${f.split('/').pop()}:${k}`, v });
  if (/DATABASE_URL/.test(k)) { try { const u = new URL(v); if (u.password) SECRETS.push({ name: `${f.split('/').pop()}:${k}(password)`, v: decodeURIComponent(u.password) }); } catch { /* not a URL */ } }
}
const captured = [];   // every response (status line + headers + body), kept in memory for the leak grep
const rows = [];       // [section, request, expected, got, pass]
const rec = (section, request, expected, got, pass) => { rows.push([section, request, expected, got, pass]); };

function raw(text, { localAddress } = {}) {
  return new Promise((resolve) => {
    const s = net.connect({ ...BETA, localAddress }); let buf = Buffer.alloc(0);
    s.setTimeout(8000, () => s.destroy());
    s.on('connect', () => s.write(text)); s.on('data', (d) => { buf = Buffer.concat([buf, d]); });
    const done = () => { const t = buf.toString('latin1'); captured.push(t); const m = /^HTTP\/1\.[01] (\d{3})/.exec(t); const hdr = t.split('\r\n\r\n')[0];
      resolve({ status: m ? Number(m[1]) : 0, text: t, local: /x-gaia-beta-answer: local/i.test(hdr), headers: hdr, body: t.slice(hdr.length + 4) }); };
    s.on('end', done); s.on('close', () => { if (!s._done) { s._done = true; done(); } }); s.on('error', () => {});
  });
}
const H = (lines) => lines.filter(Boolean).join('\r\n') + '\r\n';
function req(method, path, { host = '127.0.0.1:8800', cookie, headers = [], body, localAddress, realIp = '198.51.100.40' } = {}) {
  const b = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return raw(H([`${method} ${path} HTTP/1.1`, host === null ? null : `Host: ${host}`, cookie ? `Cookie: ${cookie}` : null, realIp ? `X-Real-IP: ${realIp}` : null,
    'Origin: http://127.0.0.1:8800', b ? 'Content-Type: application/json' : null, `Content-Length: ${Buffer.byteLength(b)}`, 'Connection: close', ...headers]) + '\r\n' + b, { localAddress });
}
const cookiesFrom = (r) => [...r.headers.matchAll(/^set-cookie: ([^=]+)=([^;]*)/gim)].filter((m) => m[2]).map((m) => `${m[1]}=${m[2]}`);
const hmac = (s) => crypto.createHmac('sha256', BETAENV.BETA_COOKIE_SECRET).update(s).digest('base64url');
const sign = (payload, secret = null) => { const p = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${p}.${secret ? crypto.createHmac('sha256', secret).update(p).digest('base64url') : hmac(p)}`; };

// ---------- DB snapshot ----------
const SRC = '/root/gaia-membership-staging-src/membership-service/src';
const { createPool } = await import(`${SRC}/db.js`);
const pool = createPool(process.env.MEMBERSHIP_DATABASE_URL, { max: 1 });
const TABLES = ['payment_ledger', 'coin_transactions', 'coin_operations', 'coin_wallets', 'subscriptions', 'admin_action_requests', 'launch_history', 'pilot_members', 'migration_offers', 'legacy_memberships', 'persons', 'person_identities', 'audit_logs'];
const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await pool.query(`SELECT count(*)::int n FROM membership.${t}`)).rows[0].n])));
const maxAudit = (await pool.query('SELECT COALESCE(max(id),0)::bigint m FROM membership.audit_logs')).rows[0].m;
const before = await counts();
const launchBefore = (await pool.query('SELECT stage AS stored_stage, changed_at FROM membership.launch_state WHERE id').catch(() => ({ rows: [{}] }))).rows[0];

// ---------- sign in (as a visitor would) ----------
const login = await req('POST', '/login', { body: `password=${encodeURIComponent(BETAENV.BETA_PASSWORD)}`, headers: ['Content-Type: application/x-www-form-urlencoded'].slice(0, 0) });
// (form body: send with the right content type)
const lg = await raw(H(['POST /login HTTP/1.1', 'Host: 127.0.0.1:8800', 'Origin: http://127.0.0.1:8800', 'X-Real-IP: 198.51.100.40', 'Content-Type: application/x-www-form-urlencoded',
  `Content-Length: ${Buffer.byteLength('password=' + encodeURIComponent(BETAENV.BETA_PASSWORD))}`, 'Connection: close']) + '\r\npassword=' + encodeURIComponent(BETAENV.BETA_PASSWORD));
void login;
const betaCk = cookiesFrom(lg).find((c) => c.startsWith('gaia_beta='));
rec('setup', 'POST /login (right password)', '303 + gaia_beta', `${lg.status}${betaCk ? ' + gaia_beta' : ''}`, lg.status === 303 && !!betaCk);
const mem = await req('POST', '/enter/member/pilot', { cookie: betaCk });
const memCk = cookiesFrom(mem).find((c) => c.startsWith('gaia_member_session='));
const stf = await req('POST', '/enter/staff/owner', { cookie: betaCk });
const stfCks = cookiesFrom(stf).filter((c) => /^gaia_(admin|operator)=/.test(c));
rec('setup', 'POST /enter/member/pilot, POST /enter/staff/owner', '303 + member / admin + operator cookies', `${mem.status} ${stf.status} (${[memCk, ...stfCks].filter(Boolean).length} cookies)`, mem.status === 303 && stf.status === 303 && !!memCk && stfCks.length === 2);
const ALL = [betaCk, memCk, ...stfCks].join('; ');
const NOBETA = [memCk, ...stfCks].join('; ');   // valid member/staff cookies, but no beta cookie

// ---------- 1. gate ----------
const gatePaths = ['/choose', '/app/home.html', '/app/gaia-membership2.js', '/admin/', '/admin/gadmin.js', '/api/membership2/me', '/api/membership2/plans', '/api/membership2/checkout',
  '/api/admin/membership2/status', '/api/admin/membership2/me', '/api/admin/membership2/legacy', '/api/admin/membership2/actions', '/api/admin/membership2/login',
  '/api/auth/session', '/api/auth/logout', '/api/auth/magic-link/request', '/api/admin/login', '/api/admin/session', '/api/dev/fixture-session', '/api/member/profile', '/api/events', '/enter/member/free', '/enter/staff/owner', '/logout'];
for (const p of gatePaths) for (const m of ['GET', 'POST']) {
  for (const [label, ck] of [['no cookie', null], ['member+staff cookies, no beta cookie', NOBETA]]) {
    const r = await req(m, p, { cookie: ck, body: m === 'POST' ? {} : null });
    rec('1 gate', `${m} ${p} (${label})`, '401 or 303 to /, local', `${r.status}${r.local ? ' local' : ' FORWARDED'}`, (r.status === 401 || (r.status === 303 && /location: \/\r?\n/i.test(r.headers + '\n'))) && r.local);
  }
}
const now = Math.floor(Date.now() / 1000);
const badCookies = {
  'forged signature': betaCk.replace(/\.[^.]+$/, '.' + crypto.randomBytes(32).toString('base64url')),
  'tampered payload (exp +10 y, old signature)': 'gaia_beta=' + Buffer.from(JSON.stringify({ v: 1, exp: now + 3e8, n: 'x' })).toString('base64url') + '.' + betaCk.split('.')[1],
  'expired (validly signed, exp in the past)': 'gaia_beta=' + sign({ v: 1, exp: now - 60, n: 'x' }),
  'wrong version (validly signed)': 'gaia_beta=' + sign({ v: 2, exp: now + 3600, n: 'x' }),
  'signed with another secret': 'gaia_beta=' + sign({ v: 1, exp: now + 3600, n: 'x' }, 'not-the-secret-' + crypto.randomBytes(8).toString('hex')),
  'no signature': 'gaia_beta=' + Buffer.from(JSON.stringify({ v: 1, exp: now + 3600 })).toString('base64url'),
  'empty': 'gaia_beta=',
};
for (const [label, ck] of Object.entries(badCookies)) for (const p of ['/choose', '/api/membership2/me', '/api/admin/membership2/me']) {
  const r = await req('GET', p, { cookie: [ck, NOBETA].join('; ') });
  rec('1 cookie', `GET ${p} with ${label} beta cookie`, '401', `${r.status}${r.local ? ' local' : ' FORWARDED'}`, r.status === 401 && r.local);
}
const okC = await req('GET', '/choose', { cookie: betaCk }); rec('1 cookie', 'GET /choose with the real beta cookie (control)', '200', String(okC.status), okC.status === 200);

// ---------- 2. production / proxy tricks ----------
const prodReq = [
  ['GET http://api.gaiahealers.app/api/membership2/plans HTTP/1.1', 'Host: api.gaiahealers.app'],
  ['GET http://api.gaiahealers.app/api/membership2/plans HTTP/1.1', 'Host: 127.0.0.1:8800'],
  ['GET https://api.gaiahealers.app/api/membership2/plans HTTP/1.1', 'Host: 127.0.0.1:8800'],
  ['GET http://127.0.0.1:8787/api/membership2/plans HTTP/1.1', 'Host: 127.0.0.1:8800'],
  ['GET http://127.0.0.1:8002/api/health HTTP/1.1', 'Host: 127.0.0.1:8800'],
  ['CONNECT api.gaiahealers.app:443 HTTP/1.1', 'Host: api.gaiahealers.app:443'],
  ['CONNECT 127.0.0.1:8787 HTTP/1.1', 'Host: 127.0.0.1:8787'],
  ['OPTIONS * HTTP/1.1', 'Host: 127.0.0.1:8800'],
  ['GET /https://api.gaiahealers.app/api/membership2/plans HTTP/1.1', 'Host: 127.0.0.1:8800'],
  ['GET /api/../../127.0.0.1:8787/ HTTP/1.1', 'Host: 127.0.0.1:8800'],
];
for (const [line, host] of prodReq) {
  const r = await raw(H([line, host, `Cookie: ${ALL}`, 'Connection: close']) + '\r\n');
  const okk = r.status === 0 || (r.status >= 400 && r.status < 500 && (r.local || r.status === 400));
  rec('2 production', line, 'refused (4xx local, or connection closed)', r.status ? `${r.status}${r.local ? ' local' : ''}` : 'connection closed', okk);
}
const src = fs.readFileSync('/root/gaia-membership-staging-app/beta-server.mjs', 'utf8');
const ports = [...src.matchAll(/port:\s*(\d{2,5})/g)].map((m) => Number(m[1]));
const listenPort = /const PORT = (\d+)/.exec(src)[1];
rec('2 production', 'beta-server.mjs upstream allow-list (every `{ host, port }` target in the code)', '127.0.0.1:8797, 8798, 8799 only; no 8787 / 8002',
  [...new Set(ports)].sort().join(', ') + ` (listens ${listenPort})`, ports.every((p) => [8797, 8798, 8799].includes(p)) && !/8787|8002/.test(src.replace(/\/\/.*$/gm, '')));
rec('2 production', 'beta-server.mjs: any non-loopback upstream host', 'none', String((src.match(/host: '(?!127\.0\.0\.1')[^']+'/g) || []).length), !(src.match(/host: '(?!127\.0\.0\.1')[^']+'/g) || []).length);
const trav = ['/app/../../etc/passwd', '/app/..%2f..%2fetc%2fpasswd', '/app/%2e%2e/%2e%2e/etc/passwd', '/app/%252e%252e%252fetc%252fpasswd', '/app/..\\..\\etc\\passwd', '/app/%5c..%5cetc%5cpasswd',
  '/admin/..%2f..%2fgaia-membership-beta.env', '/admin/../../.config/gaia-membership-beta.env', '/app/%00/etc/passwd', '/app/home.html%00.png', '/app/./../web-server.mjs', '/app/..;/etc/passwd',
  '/beta-assets/../../../root/.config/gaia-membership-beta.env', '/app/..%c0%af..%c0%afetc/passwd', '/app//etc/passwd'];
for (const p of trav) {
  const r = await req('GET', p, { cookie: ALL });
  const leaked = /root:x:0:0|BETA_PASSWORD|BETA_COOKIE_SECRET|MEMBERSHIP_FIXTURE_KEY|import http from/.test(r.body);
  rec('2 traversal', `GET ${p}`, '400 / 404, no file content', `${r.status}${r.local ? ' local' : ' forwarded'}${leaked ? ' LEAK' : ''}`, !leaked && r.status >= 400 && r.status < 500);
}
{ const r = await raw(H(['GET /app/home.html\u0000 HTTP/1.1', 'Host: 127.0.0.1:8800', `Cookie: ${ALL}`, 'Connection: close']) + '\r\n');
  rec('2 traversal', 'GET /app/home.html<NUL> (raw NUL byte)', '400', String(r.status || 'closed'), r.status === 400 || r.status === 0); }

// ---------- 3. host and path tricks ----------
const hosts = [['unknown host', 'evil.example'], ['Host: api.gaiahealers.app', 'api.gaiahealers.app'], ['Host: 127.0.0.1:8787', '127.0.0.1:8787'], ['Host: 127.0.0.1:8002', '127.0.0.1:8002'],
  ['beta host with :443', 'beta.gaiahealers.app:443'], ['beta host with :8800', 'beta.gaiahealers.app:8800'], ['empty host', ''], ['no Host header', null]];
for (const [label, h] of hosts) for (const p of ['/', '/api/membership2/me']) {
  const r = await req('GET', p, { host: h, cookie: ALL });
  rec('3 host', `GET ${p} (${label})`, '421 / 400', String(r.status), [400, 421].includes(r.status));
}
{ const r = await raw(H(['GET /api/admin/membership2/me HTTP/1.1', 'Host: evil.example', 'Host: 127.0.0.1:8800', `Cookie: ${ALL}`, 'Connection: close']) + '\r\n');
  rec('3 host', 'GET /api/admin/membership2/me with duplicate Host (evil.example, then 127.0.0.1:8800)', '400 / 421', String(r.status), [400, 421].includes(r.status)); }
{ const r = await raw(H(['GET /api/admin/membership2/me HTTP/1.1', 'Host: 127.0.0.1:8800', 'Host: evil.example', 'Connection: close']) + '\r\n');
  rec('3 host', 'GET /api/admin/membership2/me with duplicate Host, no cookie', '400 / 401 / 421', String(r.status), [400, 401, 421].includes(r.status)); }
for (const [hname, val, p] of [['X-Forwarded-Host', 'api.gaiahealers.app', '/api/membership2/me'], ['X-Original-URL', '/api/dev/fixture-session', '/choose'], ['X-Rewrite-URL', '/api/dev/fixture-session', '/choose'],
  ['X-Original-URL', '/api/dev/fixture-session', '/api/membership2/plans'], ['X-Forwarded-Prefix', '/api/dev', '/api/membership2/plans']]) {
  const r1 = await req('GET', p, { headers: [`${hname}: ${val}`] });
  rec('3 forwarding', `GET ${p} + ${hname}: ${val} (no cookie)`, '401 / 303', String(r1.status), [401, 303].includes(r1.status));
  const r2 = await req('POST', '/api/dev/fixture-session?fixture=fixture-free', { cookie: ALL, headers: [`${hname}: ${val}`], body: {} });
  rec('3 forwarding', `POST /api/dev/fixture-session + ${hname} (beta cookie)`, '404 local', `${r2.status}${r2.local ? ' local' : ''}`, r2.status === 404 && r2.local);
}
const devVariants = ['/api/dev/fixture-session', '/API/dev/fixture-session', '/Api/Dev/fixture-session', '/api/DEV/fixture-session', '/api/dev/fixture-session/', '/api/dev/fixture-session.', '/api/dev./fixture-session',
  '//api/dev/fixture-session', '/api//dev/fixture-session', '/api/%64ev/fixture-session', '/api%2fdev%2ffixture-session', '/api/dev%2ffixture-session', '/api/dev;x=1/fixture-session', '/api/dev/fixture-session;x',
  '/api/%2564ev/fixture-session', '/api/dev/./fixture-session', '/api/x/../dev/fixture-session', '/api/dev', '/api/dev/', '/Api/Admin/membership2/actions'];
for (const p of devVariants) for (const m of ['GET', 'POST']) {
  const r = await req(m, p + (p.includes('?') ? '' : '?fixture=fixture-free'), { cookie: ALL, body: m === 'POST' ? {} : null, headers: [`x-gaia-fixture-key: guess-${crypto.randomBytes(4).toString('hex')}`] });
  const minted = /gaia_member_session=[^;\s]+/.test(r.headers) && /fixture/.test(r.body);
  rec('3 path', `${m} ${p}`, 'refused (400 / 404, local), no session minted', `${r.status}${r.local ? ' local' : ' forwarded'}${minted ? ' MINTED' : ''}`, !minted && r.status >= 400 && r.status < 500 && r.local);
}
// Rate limit: from a non-loopback peer, X-Real-IP / X-Forwarded-For are ignored. The beta listens on 127.0.0.1 only, so the
// test connects from source address 127.0.0.2 (also loopback on Linux, but NOT the trusted nginx peer 127.0.0.1 the code trusts).
{
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const b = 'password=wrong-' + i;
    const r = await raw(H(['POST /login HTTP/1.1', 'Host: 127.0.0.1:8800', 'Origin: http://127.0.0.1:8800', `X-Real-IP: 203.0.113.${100 + i}`, `X-Forwarded-For: 198.18.0.${i}`, 'Content-Type: application/x-www-form-urlencoded',
      `Content-Length: ${b.length}`, 'Connection: close']) + '\r\n' + b, { localAddress: '127.0.0.2' });
    codes.push(r.status);
  }
  rec('3 rate limit', '10 wrong passwords from peer 127.0.0.2, each with a new X-Real-IP and X-Forwarded-For', '401 ×8 then 429 (spoofed headers ignored)', codes.join(' '), codes.slice(0, 8).every((c) => c === 401) && codes.slice(8).every((c) => c === 429));
  const r = await raw(H(['GET /choose HTTP/1.1', 'Host: 127.0.0.1:8800', 'X-Forwarded-Proto: https', `Cookie: ${betaCk}`, 'Connection: close']) + '\r\n', { localAddress: '127.0.0.2' });
  const b2 = 'password=x';
  const r3 = await raw(H(['POST /login HTTP/1.1', 'Host: 127.0.0.1:8800', 'Origin: http://127.0.0.1:8800', 'X-Real-IP: 198.51.100.41', 'Content-Type: application/x-www-form-urlencoded', `Content-Length: ${b2.length}`, 'Connection: close']) + '\r\n' + b2);
  rec('3 rate limit', 'the same client limit does not block a different trusted (nginx) client IP', '401', String(r3.status), r3.status === 401);
  void r;
}

// ---------- 4. writes ----------
const paths = fs.readFileSync(new URL('./proxy-paths.txt', import.meta.url), 'utf8').split('\n').filter(Boolean).filter((p) => !p.endsWith('/'));
const UUID = '00000000-0000-4000-8000-000000000000';
const extra = ['/api/admin/membership2/actions', `/api/admin/membership2/persons/${UUID}/notes`, ...['approve', 'reject', 'cancel', 'execute'].map((v) => `/api/admin/membership2/requests/${UUID}/${v}`),
  '/api/admin/membership2/login', '/api/admin/membership2/password', '/api/admin/membership2/logout', `/api/membership2/subscriptions/${UUID}/cancel`, `/api/membership2/subscriptions/${UUID}/change`,
  `/api/membership2/subscriptions/${UUID}/change/cancel`, `/api/membership2/subscriptions/${UUID}/change-preview`, `/api/membership2/subscriptions/${UUID}/cancel-preview`,
  `/api/membership2/migration-offers/${UUID}/accept`, `/api/membership2/migration-offers/${UUID}/checkout`, `/api/membership2/migration/${UUID}/accept`, `/api/membership2/migration/${UUID}/checkout`];
const allPaths = [...new Set([...paths, ...extra])];
const LOCAL_OK = new Set(['/api/admin/logout', '/api/admin/membership2/logout', '/api/auth/logout', '/api/member/logout']);
let writeTotal = 0, writeLocal = 0, forwarded = [];
const writeBad = [];
for (const p of allPaths) for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  writeTotal++;
  const r = await req(m, p, { cookie: ALL, body: { action: 'launch.set', params: { stage: 'ALL_NEW_CUSTOMERS' }, reason: 'beta attack run', requestId: 'beta-sec-' + writeTotal, planKey: 'standard', interval: 'month', packKey: 'starter', coins: 5000, password: 'x', email: 'x@example.invalid' } });
  const isPreview = m === 'POST' && /\/cancel-preview$/.test(p);
  if (r.local) writeLocal++; else forwarded.push(`${m} ${p} -> ${r.status}`);
  const okk = isPreview ? true : (r.local && ((r.status >= 400 && r.status < 500) || (LOCAL_OK.has(p) && m === 'POST' && r.status === 200)));
  if (!okk) writeBad.push(`${m} ${p} ${r.status}${r.local ? ' local' : ' fwd'}`);
}
rec('4 writes', `${allPaths.length} routes (every '/api/…' literal in the staging proxy sources + Membership 2.0 admin and member gateway routes) × POST/PUT/PATCH/DELETE = ${writeTotal} requests`,
  'all answered by the beta itself (423 / 403 / 404 / 405, or a local logout); only POST …/cancel-preview (read-only) forwarded',
  `${writeLocal} local, ${forwarded.length} forwarded (${forwarded.join('; ').slice(0, 160)})${writeBad.length ? '; BAD: ' + writeBad.slice(0, 5).join(', ') : ''}`, writeBad.length === 0 && forwarded.every((f) => /cancel-preview/.test(f)));
for (const [label, method, p, headers] of [
  ['X-HTTP-Method-Override: POST on GET /api/admin/membership2/actions', 'GET', '/api/admin/membership2/actions', ['X-HTTP-Method-Override: POST']],
  ['X-HTTP-Method: PUT on GET /api/membership2/checkout', 'GET', '/api/membership2/checkout', ['X-HTTP-Method: PUT']],
  ['X-Method-Override: DELETE on GET /api/admin/membership2/actions', 'GET', '/api/admin/membership2/actions', ['X-Method-Override: DELETE']],
  ['GET /api/admin/membership2/actions?_method=POST', 'GET', '/api/admin/membership2/actions?_method=POST', []],
  ['POST /api/admin/membership2/actions?_method=GET', 'POST', '/api/admin/membership2/actions?_method=GET', []],
  ['HEAD /api/admin/membership2/actions', 'HEAD', '/api/admin/membership2/actions', []],
  ['OPTIONS /api/admin/membership2/actions', 'OPTIONS', '/api/admin/membership2/actions', []],
  ['TRACE /api/admin/membership2/me', 'TRACE', '/api/admin/membership2/me', []],
  ['PROPFIND /api/admin/membership2/me', 'PROPFIND', '/api/admin/membership2/me', []]]) {
  const r = await req(method, p, { cookie: ALL, headers, body: method === 'POST' ? { action: 'launch.set', params: { stage: 'OFF' }, reason: 'override attack', requestId: 'beta-sec-ovr' } : null });
  const fine = r.status >= 400 || r.status === 204 || (method === 'HEAD' && r.status === 404) || (method === 'GET' && r.status === 404);
  rec('4 overrides', label, 'no write (404 for GET on a POST-only route, 405 / 400 / 423, 204 for OPTIONS)', `${r.status}${r.local ? ' local' : ' forwarded as ' + method}`, fine);
}

// ---------- 5. data exposure ----------
const real = (await pool.query("SELECT external_contact_id c FROM membership.legacy_memberships WHERE coalesce(external_contact_id,'') NOT LIKE 'fixture-%'")).rows.map((r) => r.c).filter(Boolean);
const realPrices = (await pool.query("SELECT external_price_id p FROM membership.legacy_memberships WHERE coalesce(external_contact_id,'') NOT LIKE 'fixture-%' AND external_price_id IS NOT NULL")).rows.map((r) => r.p);
const readPaths = ['overview', 'persons', 'persons?q=', 'legacy', 'legacy?state=active', 'migration-offers', 'payments', 'coins', 'reconciliation', 'refund-reviews', 'refund-reviews?status=all', 'dead-letters', 'audit', 'audit?limit=200', 'health', 'launch', 'requests', 'requests?status=all', 'plans', 'me', 'status'];
let realHits = 0, emailHits = 0, readOk = 0;
for (const rp of readPaths) {
  const r = await req('GET', '/api/admin/membership2/' + rp, { cookie: ALL });
  if (r.status === 200) readOk++;
  realHits += real.filter((c) => r.body.includes(c)).length + realPrices.filter((p) => r.body.includes(p)).length;
  emailHits += (r.body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).filter((e) => !/\.invalid$/i.test(e)).length;
}
rec('5 customer data', `GET ${readPaths.length} Control Center Membership 2.0 read endpoints as the demo owner`, `0 of the ${real.length} real GHL contact ids / ${realPrices.length} price ids; 0 non-demo emails`,
  `${readOk} answered 200; ${realHits} real-id matches; ${emailHits} non-demo emails`, realHits === 0 && emailHits === 0);
const leg = await req('GET', '/api/admin/membership2/legacy', { cookie: ALL });
let legJ = {}; try { legJ = JSON.parse(leg.body.trim().startsWith('{') ? leg.body : leg.body.slice(leg.body.indexOf('{'))); } catch { /* chunked */ }
rec('5 customer data', 'GET /api/admin/membership2/legacy', 'only demo (fixture-…) rows', `${(legJ.items || []).length} rows: ${(legJ.items || []).map((x) => (x.external_contact_id || '').replace(/^fixture-/, 'fixture-…')).join(', ')}; hidden header ${/x-gaia-beta-hidden: (\d+)/i.exec(leg.headers)?.[1] ?? '?'}`,
  (legJ.items || []).length > 0 && (legJ.items || []).every((x) => /^fixture-/.test(x.external_contact_id || '')));
for (const p of ['/api/admin/contacts', '/api/admin/contacts/search?q=a', '/api/admin/surveys', '/api/admin/survey-map?id=x', '/api/admin/announcements', '/api/admin/events', '/api/admin/system', '/api/admin/membership', '/api/admin/tags']) {
  const r = await req('GET', p, { cookie: ALL });
  rec('5 customer data', `GET ${p} (Control Center areas outside Membership 2.0)`, '404 local (not in the beta)', `${r.status}${r.local ? ' local' : ' forwarded'}`, r.status === 404 && r.local);
}

// ---------- secrets in responses ----------
let hits = 0; const hitNames = new Set();
for (const t of captured) for (const s of SECRETS) if (t.includes(s.v)) { hits++; hitNames.add(s.name.split(':')[1]); }
rec('5 secrets', `${captured.length} captured responses (status line, headers, body) vs ${SECRETS.length} secret values from the 4 env files, compared in memory`, '0 matches', `${hits} matches${hitNames.size ? ' (' + [...hitNames].join(',') + ')' : ''}`, hits === 0);

// ---------- DB after ----------
const after = await counts();
const diff = TABLES.filter((t) => after[t] !== before[t]).map((t) => `${t} ${before[t]}→${after[t]}`);
const newAudit = (await pool.query('SELECT action, actor_type, actor_id, count(*)::int n FROM membership.audit_logs WHERE id > $1 GROUP BY 1,2,3 ORDER BY 1', [maxAudit])).rows;
const allowed = newAudit.every((a) => ['operator.login', 'operator.logout', 'identity.link', 'person.create'].includes(a.action) || a.action.startsWith('api.denied'));
const nonAudit = diff.filter((d) => !d.startsWith('audit_logs'));
rec('4 database', `row counts of ${TABLES.length} tables before vs after the whole run`, 'unchanged except audit_logs (sign-in and refused-request rows)', diff.length ? diff.join(', ') : 'all unchanged', nonAudit.length === 0 && allowed);
rec('4 database', 'new audit rows during the run', 'only demo-operator sign-ins and the service\'s own log of refused requests (api.denied)', newAudit.length ? newAudit.map((a) => `${a.action} ×${a.n} (${a.actor_type})`).join(', ') : 'none', allowed);
const launchAfter = (await pool.query('SELECT stage AS stored_stage, changed_at FROM membership.launch_state WHERE id').catch(() => ({ rows: [{}] }))).rows[0];
rec('4 database', 'stored launch stage', 'unchanged', `${launchBefore?.stored_stage ?? '?'} → ${launchAfter?.stored_stage ?? '?'}`, JSON.stringify(launchBefore) === JSON.stringify(launchAfter));
await pool.end();

const pass = rows.filter((r) => r[4]).length;
console.log(`${pass}/${rows.length} security checks passed`);
for (const r of rows.filter((x) => !x[4])) console.log('FAIL', r[0], '|', r[1], '|', r[3]);
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
fs.writeFileSync(OUTMD, ['| # | Area | Request | Expected | Result | Status |', '|---|---|---|---|---|---|', ...rows.map((r, i) => `| ${i + 1} | ${esc(r[0])} | \`${esc(r[1])}\` | ${esc(r[2])} | ${esc(r[3])} | ${r[4] ? 'PASS' : 'FAIL'} |`)].join('\n') + '\n');
