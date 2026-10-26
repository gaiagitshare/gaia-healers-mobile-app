/**
 * Control Center test stack: the real internal API on loopback, real Postgres,
 * real operators (scrypt + TOTP), a controllable clock. Stripe is not connected
 * unless a test passes its own provider stub.
 */
import crypto from 'node:crypto';
import { freshPool } from './_db.js';
import { createApiServer } from '../src/api/server.js';
import { createClient } from '../src/clients.js';
import { seedCatalog } from '../src/plans.js';
import { createOperator, totpAt, stepOf, base32Decode } from '../src/operators.js';

export const KEY = crypto.randomBytes(32).toString('base64');
export const PASSWORD = 'fixture-password-' + crypto.randomBytes(6).toString('hex');
export const ROLES_FIXTURE = { viewer: 'viewer', support: 'support', finance: 'finance', finance2: 'finance', owner: 'owner', owner2: 'owner' };

export const secretOf = (uri) => base32Decode(new URL(uri).searchParams.get('secret'));
export const codeAt = (secret, date, d = 0) => totpAt(secret, stepOf(date) + d);

export async function adminStack({ stripe = null, operators = ROLES_FIXTURE } = {}) {
  const pool = await freshPool();
  await seedCatalog(pool);
  const clock = { t: new Date('2026-10-26T10:00:00Z') };
  const env = { MEMBERSHIP_OPERATOR_KEY: KEY, MEMBERSHIP2_STAGE_CEILING: 'ALL_NEW_CUSTOMERS' };
  const api = createApiServer(pool, { env, stripe, clock: () => clock.t });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${api.address().port}`;
  const { token } = await createClient(pool, { name: 'gaia-healers-admin-test', scopes: ['admin:operate'] }, 'owner-fixture');
  const ops = {};
  for (const [name, role] of Object.entries(operators)) {
    const r = await createOperator(pool, { email: `${name}.fixture@example.invalid`, displayName: `${name} fixture`, role, password: PASSWORD }, 'test-owner', { env });
    ops[name] = { id: r.id, email: r.email, role, secret: secretOf(r.otpauthUri) };
  }
  const call = async (method, path, { body, session, raw } = {}) => {
    const headers = { authorization: `Bearer ${token}` };
    if (session) headers['x-operator-session'] = session;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: r.status, json: await r.json() };
  };
  const login = async (name, { password = PASSWORD, d = 0 } = {}) => call('POST', '/v1/admin/login', { body: { email: ops[name].email, password, totp: codeAt(ops[name].secret, clock.t, d) } });
  const sessions = {};
  const signIn = async (...names) => { for (const n of names) { const r = await login(n); if (r.status !== 200) throw new Error('login failed for ' + n + ': ' + JSON.stringify(r.json)); sessions[n] = r.json.session; } };
  const as = (name) => ({
    get: (path) => call('GET', path, { session: sessions[name] }),
    post: (path, body = {}) => call('POST', path, { session: sessions[name], body }),
    act: (action, params, { reason = 'fixture reason for the test', requestId = 'rq-' + crypto.randomBytes(6).toString('hex') } = {}) =>
      call('POST', '/v1/admin/actions', { session: sessions[name], body: { action, params, reason, requestId } }),
  });
  const advance = (ms) => { clock.t = new Date(clock.t.getTime() + ms); };
  return { pool, clock, env, base, token, ops, call, login, signIn, sessions, as, advance,
    close: async () => { await new Promise((r) => api.close(r)); await pool.end(); } };
}

export async function fixturePerson(pool, email = 'person.fixture@example.invalid') {
  const id = (await pool.query('INSERT INTO persons DEFAULT VALUES RETURNING id')).rows[0].id;
  await pool.query("INSERT INTO person_identities (person_id, platform, kind, external_id, linked_by) VALUES ($1, 'email', 'address', $2, 'test')", [id, email]);
  return id;
}
