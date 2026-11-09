/**
 * Profile activation (badge -> code -> password) at the proxy.
 *
 * A loopback fake Event Manager stands in for the real one; GHL email is a
 * recording stub. Checks: the code reaches only the profile's own contact and
 * never the browser; a session is minted only after the Event Manager says
 * yes; identity follows the profile's contact id; forgot-password never
 * reveals whether an address exists; rate limits hold.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createActivation } from '../membership/member-activation.js';

function fakeEm(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = b ? JSON.parse(b) : {};
      calls.push({ path: req.url, body, auth: req.headers.authorization });
      const [status, data] = handler(req.url, body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, calls, url: 'http://127.0.0.1:' + srv.address().port })));
}

function harness() {
  const emails = [];
  const sessions = [];
  const deps = {
    readJsonBody: async (req) => req._body,
    sendJson: (res, status, data, _origin, headers = {}) => { res.status = status; res.data = data; res.headers = headers; },
    buildSetCookie: (_req, token) => 'gaia_session=' + token,
    signTokenPayload: (s) => 'signed.' + s.sub,
    createMemberSession: (m, source, opts) => { const s = { sub: m.contactId || m.email, member: m, source, emailVerified: opts.emailVerified, exp: 1 }; sessions.push(s); return s; },
    resolveMemberRecord: async ({ email, contactId }) => (email === 'near@x.test' ? { contactId: 'c-buyer', email: 'buyer@x.test' } : contactId ? { contactId, memberId: contactId, email: 'ghl@x.test', displayName: 'GHL Name' }
      : email === 'known@x.test' ? { contactId: 'c-by-email', email } : null),
    normalizeMemberIdentity: (i) => ({ contactId: i.contactId, memberId: i.memberId, email: i.email, displayName: i.displayName }),
    ghlSendEmail: async (m) => { emails.push(m); return { ok: true }; },
    firstNonEmptyString: (...v) => v.find((x) => typeof x === 'string' && x.trim()) || '',
  };
  const act = createActivation(deps);
  async function call(pathname, body, ip = '10.0.0.1') {
    const req = { method: 'POST', headers: { 'cf-connecting-ip': ip }, socket: {}, _body: body };
    const res = {};
    const handled = await act.handle(req, res, 'https://gaiahealers.app', new URL('http://x' + pathname));
    return { handled, ...res };
  }
  return { call, emails, sessions };
}

let em;
let lastBody = {};
test.before(async () => {
  em = await fakeEm((p, body) => {
    lastBody = body;
    if (p === '/identity/activate/start') {
      if (body.token === 'NOEMAIL2') return [200, { ok: true, first_name: 'Ana', has_password: false, email_masked: '', desk_only: true }];
      if (body.token === 'HASPASS2') return [200, { ok: true, first_name: 'Ben', has_password: true, email_masked: 'b•••@x.test', desk_only: false }];
      if (body.token === 'BADBADBA') return [200, { ok: false, reason: 'unknown_badge' }];
      return [200, { ok: true, first_name: 'Cy', has_password: false, email_masked: 'c•••@x.test', desk_only: false,
        ...(body.send_code ? { code: '482913', deliver_to: { contact_id: 'c-1', email: 'c@x.test' } } : {}) }];
    }
    if (p === '/identity/activate/verify') return body.code === '482913' ? [200, { ok: true, permit: 'P1' }] : [200, { ok: false, reason: 'code_incorrect' }];
    if (p === '/identity/activate/complete') {
      if (String(body.password).length < 8) return [400, { detail: 'Please use at least 8 characters.' }];
      return body.permit === 'P1' ? [200, { ok: true, identity: { contact_id: 'c-1', email: 'c@x.test', name: 'Cy Doe' } }] : [200, { ok: false, reason: 'verification_expired' }];
    }
    if (p === '/identity/activate/login' && body.token === 'SEATGST2') {
      return [200, { ok: true, identity: { contact_id: '', email: 'buyer+seat2@x.test', name: 'Guest', ghl_lookup: false } }];
    }
    if (p === '/identity/activate/login' && body.token === 'OTHERML2') {
      return [200, { ok: true, identity: { contact_id: '', email: 'near@x.test', name: 'Near' } }];
    }
    if (p === '/identity/activate/login' || p === '/identity/password/login') {
      return body.password === 'correct horse' ? [200, { ok: true, identity: { contact_id: '', email: 'known@x.test', name: 'K' } }]
        : [200, { ok: false, reason: p.includes('password') ? 'wrong_email_or_password' : 'wrong_password' }];
    }
    if (p === '/identity/password/forgot') return body.email === 'known@x.test' ? [200, { ok: true, code: '111222', deliver_to: { contact_id: '', email: 'known@x.test' } }] : [200, { ok: true }];
    if (p === '/identity/password/reset') return body.code === '111222' ? [200, { ok: true, identity: { contact_id: 'c-9', email: 'known@x.test', name: 'K' } }] : [200, { ok: false, reason: 'code_incorrect' }];
    return [404, {}];
  });
  process.env.EVENT_MANAGER_BASE_URL = em.url;
  process.env.IDENTITY_SERVICE_TOKEN = 'svc-test-token';
});
test.after(() => em.srv.close());

test('other routes are not touched', async () => {
  const h = harness();
  assert.equal((await h.call('/api/auth/magic-link/request', {})).handled, false);
});

test('badge scan emails the code to the profile contact, never to the browser', async () => {
  const h = harness();
  const r = await h.call('/api/activate/start', { token: 'abcd2345', send_code: true });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.code_sent, true);
  assert.equal(r.data.email_masked, 'c•••@x.test');
  assert.ok(!JSON.stringify(r.data).includes('482913'), 'the code never goes back to the page');
  assert.equal(h.emails.length, 1);
  assert.equal(h.emails[0].contactId, 'c-1');
  assert.ok(h.emails[0].html.includes('482913'));
  assert.equal(lastBody.token, 'ABCD2345', 'badge code normalised');
  assert.equal(em.calls.at(-1).auth, 'Bearer svc-test-token');
});

test('looking without asking sends nothing', async () => {
  const h = harness();
  const r = await h.call('/api/activate/start', { token: 'ABCD2345' });
  assert.equal(r.data.code_sent, false);
  assert.equal(h.emails.length, 0);
});

test('no-email profile is sent to the help desk, nothing is emailed', async () => {
  const h = harness();
  const r = await h.call('/api/activate/start', { token: 'NOEMAIL2', send_code: true });
  assert.equal(r.data.desk_only, true);
  assert.equal(h.emails.length, 0);
});

test('a profile with a password is offered sign-in, no code', async () => {
  const h = harness();
  const r = await h.call('/api/activate/start', { token: 'HASPASS2', send_code: true });
  assert.equal(r.data.has_password, true);
  assert.equal(h.emails.length, 0);
});

test('unknown badge gets a plain message', async () => {
  const h = harness();
  const r = await h.call('/api/activate/start', { token: 'BADBADBA', send_code: true });
  assert.equal(r.data.ok, false);
  assert.match(r.data.error, /help desk/);
});

test('wrong code: no permit, no session', async () => {
  const h = harness();
  const r = await h.call('/api/activate/verify', { token: 'ABCD2345', code: '000000' });
  assert.equal(r.data.ok, false);
  assert.equal(r.data.permit, undefined);
  assert.equal(h.sessions.length, 0);
});

test('code -> password -> the normal member session on the profile contact', async () => {
  const h = harness();
  const v = await h.call('/api/activate/verify', { token: 'ABCD2345', code: '482913' });
  assert.equal(v.data.permit, 'P1');
  const short = await h.call('/api/activate/complete', { token: 'ABCD2345', permit: 'P1', password: 'short' });
  assert.equal(short.data.ok, false);
  assert.match(short.data.error, /8 characters/);
  const c = await h.call('/api/activate/complete', { token: 'ABCD2345', permit: 'P1', password: 'long enough pw' });
  assert.equal(c.data.ok, true);
  assert.match(c.headers['Set-Cookie'], /^gaia_session=signed\.c-1/);
  assert.equal(h.sessions[0].member.contactId, 'c-1', 'kept the profile GHL contact');
  assert.equal(h.sessions[0].emailVerified, true);
});

test('expired permit cannot set a password', async () => {
  const h = harness();
  const c = await h.call('/api/activate/complete', { token: 'ABCD2345', permit: 'OLD', password: 'long enough pw' });
  assert.equal(c.data.ok, false);
  assert.equal(h.sessions.length, 0);
});

test('password sign-in: right opens, wrong refuses', async () => {
  const h = harness();
  assert.equal((await h.call('/api/auth/password/login', { email: 'Known@X.test', password: 'nope nope' })).data.ok, false);
  assert.equal(lastBody.email, 'known@x.test');
  const ok = await h.call('/api/auth/password/login', { email: 'known@x.test', password: 'correct horse' });
  assert.equal(ok.data.ok, true);
  assert.equal(h.sessions.length, 1);
  assert.equal((await h.call('/api/activate/login', { token: 'HASPASS2', password: 'correct horse' })).data.ok, true);
});

test('forgot password answers the same for known and unknown addresses', async () => {
  const h = harness();
  const a = await h.call('/api/auth/password/forgot', { email: 'known@x.test' });
  const b = await h.call('/api/auth/password/forgot', { email: 'nobody@x.test' });
  assert.deepEqual(a.data, b.data);
  assert.equal(h.emails.length, 1, 'only the known address got a code');
  assert.equal(h.emails[0].contactId, 'c-by-email');
  assert.ok(!JSON.stringify(a.data).includes('111222'));
  const r = await h.call('/api/auth/password/reset', { email: 'known@x.test', code: '111222', password: 'new password 1' });
  assert.equal(r.data.ok, true);
  assert.equal(h.sessions[0].member.contactId, 'c-9');
});

test('repeated attempts from one place are rate limited', async () => {
  const h = harness();
  let last;
  for (let i = 0; i < 13; i += 1) last = await h.call('/api/activate/verify', { token: 'ABCD2345', code: '000000' }, '10.9.9.9');
  assert.equal(last.status, 429);
  let start;
  for (let i = 0; i < 6; i += 1) start = await h.call('/api/activate/start', { token: 'RPTSCAN2' }, '10.9.9.8');
  assert.equal(start.status, 429, 'repeated badge scans are capped');
});

test('the module never logs', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../membership/member-activation.js', import.meta.url), 'utf8');
  assert.ok(!/console\./.test(src));
});

test('a guest seat signs in as itself, never as the buyer contact', async () => {
  const h = harness();
  const r = await h.call('/api/activate/login', { token: 'SEATGST2', password: 'x' });
  assert.equal(r.data.ok, true);
  assert.equal(h.sessions[0].member.contactId, '', 'no contact id');
  assert.equal(h.sessions[0].member.email, 'buyer+seat2@x.test');
});

test('a GHL contact with a different address is not adopted', async () => {
  const h = harness();
  await h.call('/api/activate/login', { token: 'OTHERML2', password: 'x' });
  assert.notEqual(h.sessions[0].member.contactId, 'c-buyer');
  assert.equal(h.sessions[0].member.email, 'near@x.test');
});
