/**
 * Control Center operators (Membership 2.0, Phase 3): named accounts, sign-in
 * with password + mandatory TOTP, hashed sessions. node:crypto only.
 *
 *   - passwords: scrypt (N=2^15, r=8, p=1), compared with timingSafeEqual; an
 *     unknown email still runs one scrypt against a dummy hash (same timing);
 *   - TOTP: RFC 6238 (SHA-1, 30 s, 6 digits), +-1 step window, a step is never
 *     accepted twice (totp_last_step); the secret is AES-256-GCM encrypted
 *     with MEMBERSHIP_OPERATOR_KEY (32 bytes, base64), bound to the operator id;
 *   - sessions: an opaque token shown once, stored as SHA-256; 8 h absolute,
 *     30 min idle; revoked on logout, disable, role change and TOTP reset;
 *   - 5 failed sign-ins lock the account for 15 min. Every failure (unknown
 *     email, wrong password, wrong code, locked, disabled) is the same
 *     `invalid_login` answer.
 *
 *   - the initial password (and a CLI password reset) sets must_change_password:
 *     until the operator chooses a new one, a sign-in gives a RESTRICTED session
 *     that may only call POST /v1/admin/password, /me and /logout.
 *
 * Operators are created and managed only by the owner with src/cli/operators.js.
 * Nothing here logs an email, a password, a code or a token.
 */
import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { audit } from './audit.js';
import { fail, MembershipError } from './errors.js';

export const ROLES = Object.freeze(['viewer', 'support', 'finance', 'owner']);
export const roleRank = (r) => ROLES.indexOf(r);
export const SESSION_ABSOLUTE_MS = 8 * 3600 * 1000;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MS = 15 * 60 * 1000;
export const TOTP_STEP_S = 30;
export const TOTP_WINDOW = 1;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const ISSUER = 'Gaia Healers Control Center';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const operatorActor = (op, requestId = null) => ({ actorType: 'admin', actorId: 'operator:' + op.id, requestId });

// ---------- key ----------
export function operatorKey(env) {
  const raw = String(env?.MEMBERSHIP_OPERATOR_KEY || '');
  let key;
  try { key = Buffer.from(raw, 'base64'); } catch { key = Buffer.alloc(0); }
  if (key.length !== 32) return null;
  return key;
}
const needKey = (env) => operatorKey(env) || fail('PROVIDER_UNAVAILABLE', 'operator sign-in is not configured (MEMBERSHIP_OPERATOR_KEY)');

// ---------- scrypt ----------
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) fail('INVALID_INPUT', `password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`);
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
const DUMMY_HASH = hashPassword('dummy-password-for-timing-only');

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB, hashB] = parts;
  const expected = Buffer.from(hashB, 'base64');
  const got = crypto.scryptSync(String(password ?? ''), Buffer.from(saltB, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

export function generatePassword() {
  return crypto.randomBytes(18).toString('base64url');   // 24 characters, ~144 bits
}

// ---------- base32 + TOTP (RFC 4648 / RFC 6238) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
export const stepOf = (date) => Math.floor(date.getTime() / 1000 / TOTP_STEP_S);

/** The matching step within the window, or null. Every candidate is compared in constant time. */
export function matchTotp(secret, code, now, lastStep = null) {
  const okShape = /^\d{6}$/.test(String(code ?? ''));
  const given = Buffer.from(okShape ? String(code) : '------');
  const cur = stepOf(now);
  let found = null;
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = cur + d;
    const eq = crypto.timingSafeEqual(Buffer.from(totpAt(secret, step)), given);
    if (eq && okShape && (lastStep === null || step > Number(lastStep)) && found === null) found = step;
  }
  return found;
}

export const otpauthUri = (email, secretB32) =>
  `otpauth://totp/${encodeURIComponent(ISSUER)}:${encodeURIComponent(email)}?secret=${secretB32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_S}`;

// ---------- AES-256-GCM for the TOTP secret ----------
export function encryptSecret(key, operatorId, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from('operator:' + operatorId));
  const ct = Buffer.concat([c.update(secret), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
export function decryptSecret(key, operatorId, enc) {
  const [v, iv, tag, ct] = String(enc).split(':');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from('operator:' + operatorId));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]);
}

// ---------- management (CLI) ----------
const cliActor = (actor) => {
  if (!actor || !/^[A-Za-z0-9_.@-]{2,80}$/.test(String(actor))) fail('INVALID_INPUT', '--actor <name> is required');
  return { actorType: 'admin', actorId: 'cli:' + actor };
};
const normEmail = (e) => {
  const v = String(e || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(v) || v.length > 254) fail('INVALID_INPUT', 'a valid email is required');
  return v;
};
const checkRole = (r) => { if (!ROLES.includes(r)) fail('INVALID_INPUT', 'role must be one of ' + ROLES.join(', ')); return r; };

/**
 * Returns the initial password and the otpauth URI ONCE; neither is stored in clear.
 * The operator must change that password at first sign-in. `mustChangePassword: false`
 * exists only for the test fixtures (the CLI never passes it).
 */
export async function createOperator(pool, { email, displayName, role, password = generatePassword(), mustChangePassword = true }, actor, { env }) {
  const key = needKey(env); const who = cliActor(actor);
  email = normEmail(email); checkRole(role);
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 120) fail('INVALID_INPUT', 'a display name is required');
  const id = crypto.randomUUID();
  const secret = crypto.randomBytes(20);
  const passwordHash = hashPassword(password);
  return withTransaction(pool, async (c) => {
    try {
      await c.query(`INSERT INTO operators (id, email, display_name, role, password_scrypt, totp_secret_enc, created_by, must_change_password) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, email, displayName.trim(), role, passwordHash, encryptSecret(key, id, secret), who.actorId, mustChangePassword !== false]);
    } catch (e) { if (e.code === '23505') fail('CONFLICT', 'an operator with this email exists'); throw e; }
    await audit(c, { ...who, action: 'operator.create', entityType: 'operator', entityId: id, after: { role, mustChangePassword: mustChangePassword !== false } });
    return { id, email, role, password, otpauthUri: otpauthUri(email, base32Encode(secret)) };
  });
}

async function byRef(c, ref) {
  const r = /^[0-9a-f-]{36}$/.test(String(ref)) ? await c.query('SELECT * FROM operators WHERE id = $1 FOR UPDATE', [ref])
    : await c.query('SELECT * FROM operators WHERE email = $1 FOR UPDATE', [normEmail(ref)]);
  return r.rows[0] || fail('NOT_FOUND', 'operator not found');
}

export async function listOperators(db) {
  return (await db.query(`SELECT id, email, display_name, role, status, (locked_until IS NOT NULL AND locked_until > now()) AS locked, must_change_password, last_login_at, created_at
                            FROM operators ORDER BY created_at`)).rows;
}

async function revokeSessions(c, operatorId) {
  return (await c.query('UPDATE operator_sessions SET revoked_at = now() WHERE operator_id = $1 AND revoked_at IS NULL', [operatorId])).rowCount;
}

/** Disable: sessions revoked and their pending requests cancelled. */
export async function disableOperator(pool, ref, actor) {
  const who = cliActor(actor);
  return withTransaction(pool, async (c) => {
    const op = await byRef(c, ref);
    if (op.status === 'disabled') return { id: op.id, replayed: true };
    await c.query("UPDATE operators SET status = 'disabled', disabled_at = now(), updated_at = now() WHERE id = $1", [op.id]);
    const sessions = await revokeSessions(c, op.id);
    const cancelled = (await c.query(`UPDATE admin_action_requests SET status = 'cancelled', decision_note = 'requester disabled', decided_at = now()
                                       WHERE requested_by = $1 AND status = 'pending' RETURNING id`, [op.id])).rows.map((r) => r.id);
    await audit(c, { ...who, action: 'operator.disable', entityType: 'operator', entityId: op.id, after: { sessionsRevoked: sessions, requestsCancelled: cancelled } });
    return { id: op.id, sessionsRevoked: sessions, requestsCancelled: cancelled.length };
  });
}

export async function setOperatorRole(pool, ref, role, actor) {
  const who = cliActor(actor); checkRole(role);
  return withTransaction(pool, async (c) => {
    const op = await byRef(c, ref);
    await c.query('UPDATE operators SET role = $2, updated_at = now() WHERE id = $1', [op.id, role]);
    const sessions = await revokeSessions(c, op.id);
    await audit(c, { ...who, action: 'operator.set_role', entityType: 'operator', entityId: op.id, before: { role: op.role }, after: { role, sessionsRevoked: sessions } });
    return { id: op.id, from: op.role, to: role };
  });
}

/** New TOTP secret (shown once), sessions revoked, lock cleared. */
export async function resetOperatorTotp(pool, ref, actor, { env }) {
  const key = needKey(env); const who = cliActor(actor);
  const secret = crypto.randomBytes(20);
  return withTransaction(pool, async (c) => {
    const op = await byRef(c, ref);
    await c.query('UPDATE operators SET totp_secret_enc = $2, totp_last_step = NULL, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1',
      [op.id, encryptSecret(key, op.id, secret)]);
    const sessions = await revokeSessions(c, op.id);
    await audit(c, { ...who, action: 'operator.reset_totp', entityType: 'operator', entityId: op.id, after: { sessionsRevoked: sessions } });
    return { id: op.id, otpauthUri: otpauthUri(op.email, base32Encode(secret)) };
  });
}

/** CLI password reset: a new initial password (shown once), must change at next sign-in, sessions revoked, lock cleared. */
export async function resetOperatorPassword(pool, ref, actor, { password = generatePassword() } = {}) {
  const who = cliActor(actor);
  const hash = hashPassword(password);
  return withTransaction(pool, async (c) => {
    const op = await byRef(c, ref);
    await c.query('UPDATE operators SET password_scrypt = $2, must_change_password = true, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [op.id, hash]);
    const sessions = await revokeSessions(c, op.id);
    await audit(c, { ...who, action: 'operator.reset_password', entityType: 'operator', entityId: op.id, after: { sessionsRevoked: sessions, mustChangePassword: true } });
    return { id: op.id, password };
  });
}

// ---------- sign-in ----------
const invalidLogin = () => { throw Object.assign(new MembershipError('AUTH_REQUIRED', 'invalid_login'), { expose: { error: 'invalid_login' } }); };
const hashMeta = (key, v) => (v ? crypto.createHmac('sha256', key).update(String(v)).digest('hex').slice(0, 32) : null);

export const operatorView = (op) => ({ id: op.id, email: op.email, displayName: op.display_name, role: op.role, mustChangePassword: op.must_change_password === true });

export async function login(pool, { email, password, totp }, { env, now = new Date(), ip = null, ua = null, requestId = null }) {
  const key = needKey(env);
  const e = String(email || '').trim().toLowerCase().slice(0, 254);
  return withTransaction(pool, async (c) => {
    const op = (await c.query('SELECT * FROM operators WHERE email = $1 FOR UPDATE', [e])).rows[0];
    const passOk = verifyPassword(password, op ? op.password_scrypt : DUMMY_HASH) && Boolean(op);
    let step = null;
    if (op) {
      let secret = null;
      try { secret = decryptSecret(key, op.id, op.totp_secret_enc); } catch { secret = null; }
      step = secret ? matchTotp(secret, totp, now, op.totp_last_step) : null;
    }
    if (!op) invalidLogin();
    const locked = op.locked_until && new Date(op.locked_until) > now;
    if (op.status !== 'active' || locked || !passOk || step === null) {
      if (op.status === 'active' && !locked) {
        const n = op.failed_logins + 1;
        if (n >= MAX_FAILED_LOGINS) await c.query('UPDATE operators SET failed_logins = 0, locked_until = $2, updated_at = now() WHERE id = $1', [op.id, new Date(now.getTime() + LOCK_MS)]);
        else await c.query('UPDATE operators SET failed_logins = $2, updated_at = now() WHERE id = $1', [op.id, n]);
        await audit(c, { actorType: 'admin', actorId: 'operator:' + op.id, requestId, action: 'operator.login_failed', entityType: 'operator', entityId: op.id,
          after: { failedLogins: n >= MAX_FAILED_LOGINS ? 0 : n, locked: n >= MAX_FAILED_LOGINS } });
      }
      // The failure is recorded (committed) before the uniform answer.
      return { failed: true };
    }
    const token = 'gop_' + crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
    await c.query('INSERT INTO operator_sessions (token_sha256, operator_id, created_at, last_seen_at, expires_at, ip_hash, ua_hash) VALUES ($1, $2, $3, $3, $4, $5, $6)',
      [sha(token), op.id, now, expiresAt, hashMeta(key, ip), hashMeta(key, ua)]);
    await c.query('UPDATE operators SET failed_logins = 0, locked_until = NULL, totp_last_step = $2, last_login_at = $3, updated_at = now() WHERE id = $1', [op.id, step, now]);
    await audit(c, { ...operatorActor(op, requestId), action: 'operator.login', entityType: 'operator', entityId: op.id });
    return { session: token, operator: operatorView(op), expiresAt };
  }).then((r) => (r.failed ? invalidLogin() : r));
}

const TOKEN_RE = /^gop_[A-Za-z0-9_-]{43}$/;

/** X-Operator-Session -> { operator, session } or AUTH_REQUIRED. Touches last_seen_at (idle limit). */
export async function authenticateOperator(db, token, now = new Date()) {
  if (!TOKEN_RE.test(String(token || ''))) fail('AUTH_REQUIRED', 'operator sign-in required');
  const r = (await db.query(
    `UPDATE operator_sessions s SET last_seen_at = $2
       FROM operators o
      WHERE s.token_sha256 = $1 AND o.id = s.operator_id AND s.revoked_at IS NULL AND o.status = 'active'
        AND s.expires_at > $2 AND s.last_seen_at + make_interval(secs => $3) > $2
      RETURNING s.token_sha256, s.expires_at, s.last_seen_at, o.id, o.email, o.display_name, o.role, o.status, o.must_change_password`,
    [sha(token), now, SESSION_IDLE_MS / 1000])).rows[0];
  if (!r) fail('AUTH_REQUIRED', 'operator sign-in required');
  const idle = new Date(Math.min(new Date(r.last_seen_at).getTime() + SESSION_IDLE_MS, new Date(r.expires_at).getTime()));
  return { operator: { id: r.id, email: r.email, display_name: r.display_name, role: r.role, status: r.status, must_change_password: r.must_change_password },
    restricted: r.must_change_password === true, tokenHash: r.token_sha256, idleExpiresAt: idle, expiresAt: r.expires_at };
}

export async function logout(pool, auth, requestId) {
  return withTransaction(pool, async (c) => {
    await c.query('UPDATE operator_sessions SET revoked_at = now() WHERE token_sha256 = $1 AND revoked_at IS NULL', [auth.tokenHash]);
    await audit(c, { ...operatorActor(auth.operator, requestId), action: 'operator.logout', entityType: 'operator', entityId: auth.operator.id });
  });
}

/**
 * POST /v1/admin/password { currentPassword, newPassword }. The new password is
 * 12-200 characters and differs from the current one; stored as scrypt. Clears
 * must_change_password and revokes every OTHER session of the operator. A wrong
 * current password counts as a failed sign-in: the 5th locks the account and
 * revokes its sessions (this one too).
 */
export async function changePassword(pool, auth, { currentPassword, newPassword }, { now = new Date(), requestId = null } = {}) {
  if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) fail('INVALID_INPUT', `the new password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`);
  if (newPassword === currentPassword) fail('INVALID_INPUT', 'the new password must differ from the current one');
  const hash = hashPassword(newPassword);
  const r = await withTransaction(pool, async (c) => {
    const op = (await c.query('SELECT * FROM operators WHERE id = $1 FOR UPDATE', [auth.operator.id])).rows[0];
    if (!op || op.status !== 'active') fail('AUTH_REQUIRED', 'operator sign-in required');
    const who = operatorActor(op, requestId);
    if (!verifyPassword(currentPassword, op.password_scrypt)) {
      const n = op.failed_logins + 1;
      if (n >= MAX_FAILED_LOGINS) {
        await c.query('UPDATE operators SET failed_logins = 0, locked_until = $2, updated_at = now() WHERE id = $1', [op.id, new Date(now.getTime() + LOCK_MS)]);
        await revokeSessions(c, op.id);
      } else await c.query('UPDATE operators SET failed_logins = $2, updated_at = now() WHERE id = $1', [op.id, n]);
      await audit(c, { ...who, action: 'operator.password_change_failed', entityType: 'operator', entityId: op.id, after: { locked: n >= MAX_FAILED_LOGINS } });
      return { failed: true };
    }
    if (verifyPassword(newPassword, op.password_scrypt)) fail('INVALID_INPUT', 'the new password must differ from the current one');
    await c.query('UPDATE operators SET password_scrypt = $2, must_change_password = false, password_changed_at = $3, failed_logins = 0, updated_at = now() WHERE id = $1', [op.id, hash, now]);
    const others = (await c.query('UPDATE operator_sessions SET revoked_at = now() WHERE operator_id = $1 AND revoked_at IS NULL AND token_sha256 <> $2', [op.id, auth.tokenHash])).rowCount;
    await audit(c, { ...who, action: 'operator.password_change', entityType: 'operator', entityId: op.id, after: { otherSessionsRevoked: others, wasRequired: op.must_change_password } });
    return { ok: true };
  });
  if (r.failed) fail('INVALID_INPUT', 'the current password is not correct');
  return { changed: true };
}
