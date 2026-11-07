// Single sign-on from the Event Manager into this admin: only an Event
// Manager ADMINISTRATOR's login may open it. Door staff share the signing key
// for their own app but must never reach member/CRM admin (audit 7 Nov 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.EVENT_JWT_SECRET = 'test-event-jwt-secret-0123456789abcdef';
const { handle } = await import('../admin-router.js');

function jwt(payload, secret = process.env.EVENT_JWT_SECRET) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(head + '.' + body).digest('base64url');
  return head + '.' + body + '.' + sig;
}

async function session(token) {
  let out = null;
  const req = { method: 'GET', headers: token ? { authorization: 'Bearer ' + token } : {} };
  const deps = {
    origin: '', parseCookies: () => ({}), readSignedToken: () => null,
    sendJson: (_res, status, body) => { out = { status, body }; },
  };
  await handle(req, {}, new URL('http://x/api/admin/session'), deps);
  return out.body.authed;
}

const exp = Math.floor(Date.now() / 1000) + 600;

test('an Event Manager administrator login opens the admin', async () => {
  assert.equal(await session(jwt({ sub: '1', adm: true, exp })), true);
});

test('a door-staff login (no adm claim) does not', async () => {
  assert.equal(await session(jwt({ sub: '5', exp })), false);
});

test('a set-password link is never a session, even for an admin', async () => {
  assert.equal(await session(jwt({ sub: '1', adm: true, purpose: 'setpw', exp })), false);
});

test('expired, wrongly signed or missing tokens do not', async () => {
  assert.equal(await session(jwt({ sub: '1', adm: true, exp: 1 })), false);
  assert.equal(await session(jwt({ sub: '1', adm: true, exp }, 'another-secret')), false);
  assert.equal(await session(null), false);
});
