/**
 * GAIA PRACTITIONERS — connecting a practitioner's account, and holding the token.
 *
 * Gaia Practitioners exposes a read-only MCP server at POST /api/mcp, guarded by
 * OAuth 2.1. There is no service credential and cannot be one: their authorization
 * server supports only the authorization_code grant, so no single key lets Gaia
 * read every practitioner's data. Each practitioner authorizes Gaia individually
 * and we hold one token per practitioner.
 *
 * That shape is a gift rather than an obstacle. Because the token IS the
 * practitioner, their server decides what it returns — every tool is documented
 * as returning "your" customers. Gaia cannot reach practitioner B's clients with
 * practitioner A's token even if a model asks for them in those words. The
 * authorization boundary is theirs, enforced server to server, and no prompt can
 * argue with it.
 *
 * What this file is responsible for is the half they cannot enforce: making sure
 * the token we send is the token belonging to the person actually signed in.
 *
 *   - Identity comes from the signed session cookie, read server-side. Never from
 *     a query parameter, a body field, or anything a model produced.
 *   - The state parameter is single-use, short-lived, and bound to the contact id
 *     that started the flow, so a code cannot be redeemed into somebody else's row.
 *   - Tokens are written to disk with mode 600 and never leave this process. The
 *     browser sees the consent screen on THEIR domain and nothing else.
 *
 * Everything here is inert until GAIA_PRACTITIONERS_ENABLED is 'true'.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TOKEN_FILE = '/root/gaia-staging-proxy/data/practitioner-tokens.json';
// A scan legitimately takes nine to twelve seconds, because their side fetches
// it live from Bio-Well -- so a timeout has to be generous enough not to cut off
// a call that is working. Without one at all, a hung server holds the card in
// "loading" for ever and the "Bio-Well did not answer" state can never be
// reached: the one place the practitioner is already waiting is the one place a
// missing timeout costs most.
const MCP_TIMEOUT_MS = 30000;
const TOKEN_TIMEOUT_MS = 15000;

// Their side flaps. Every call we make under mcp.read is a read, so repeating
// one is free of consequence, and a refused connection or a 503 comes back in
// milliseconds -- one more attempt costs the practitioner almost nothing and
// turns most of the flapping into a slightly slower answer instead of a failed
// card.
//
// A TIMEOUT is deliberately not retried. The card tells the practitioner about
// ten seconds and counts the elapsed time; a second thirty-second wait on top
// of the first is a worse answer than saying it did not come back.
//
// This applies to MCP calls ONLY. The token endpoints are deliberately left
// alone: their refresh tokens are single-use and rotating, so if a refresh
// succeeded upstream and only the response was lost, retrying with the token we
// still hold would present an already-spent one -- turning a dropped packet
// into a practitioner who has to reconnect. validAccessToken already shares one
// in-flight refresh for exactly that reason.
const MCP_ATTEMPTS = 2;
const MCP_RETRY_DELAY_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE_TTL_MS = 10 * 60 * 1000;      // their code is short-lived; so is our state
const PENDING_MAX = 200;                   // a bounded map cannot be grown into a leak

/**
 * The two Gaia Practitioners environments. Accounts, OAuth clients and tokens
 * are separate on each: a practitioner registered on production cannot sign in
 * on staging and vice versa. Until their production MCP exists (4 Oct 2026:
 * staging only), Gaia points at staging.
 */
export const PRACTITIONERS_HOSTS = Object.freeze({
  staging: 'https://staging.gaiapractitioners.com',
  production: 'https://gaiapractitioners.com',
});

/**
 * Config, read per call so a restart is all that is needed to change it.
 *
 * GAIA_PRACTITIONERS_ENV=staging|production picks the host; an explicit
 * GAIA_PRACTITIONERS_OAUTH_BASE / _MCP_URL still wins, so nothing that works
 * today changes. `warnings` names the combinations that cannot be right.
 */
export function practitionersConfig(env = process.env) {
  const named = String(env.GAIA_PRACTITIONERS_ENV || '').trim().toLowerCase();
  const known = Object.prototype.hasOwnProperty.call(PRACTITIONERS_HOSTS, named) ? named : null;
  const base = String(env.GAIA_PRACTITIONERS_OAUTH_BASE || (known ? PRACTITIONERS_HOSTS[known] : '')).trim().replace(/\/+$/, '');
  const mcpUrl = String(env.GAIA_PRACTITIONERS_MCP_URL || (base ? `${base}/api/mcp` : '')).trim();
  const detected = Object.entries(PRACTITIONERS_HOSTS).find(([, host]) => host === base)?.[0] || (base ? 'custom' : null);
  const warnings = [];
  if (named && !known) warnings.push(`GAIA_PRACTITIONERS_ENV=${named} is not staging or production`);
  if (known && detected && detected !== 'custom' && detected !== known) warnings.push(`GAIA_PRACTITIONERS_ENV=${known} but GAIA_PRACTITIONERS_OAUTH_BASE is the ${detected} host`);
  if (base && mcpUrl && !mcpUrl.startsWith(base + '/')) warnings.push('GAIA_PRACTITIONERS_MCP_URL is not under GAIA_PRACTITIONERS_OAUTH_BASE');
  if (base && !/^https:\/\//.test(base)) warnings.push('GAIA_PRACTITIONERS_OAUTH_BASE is not https');
  return {
    enabled: env.GAIA_PRACTITIONERS_ENABLED === 'true'
      && Boolean(env.GAIA_PRACTITIONERS_CLIENT_ID)
      && Boolean(base),
    environment: known || detected,
    warnings,
    base,
    mcpUrl,
    clientId: env.GAIA_PRACTITIONERS_CLIENT_ID || '',
    clientSecret: env.GAIA_PRACTITIONERS_CLIENT_SECRET || '',
    redirectUri: String(env.GAIA_PRACTITIONERS_REDIRECT_URI || '').trim(),
    scope: String(env.GAIA_PRACTITIONERS_SCOPE || 'mcp.read').trim(),
  };
}

/** One log line at boot: which environment, never a secret. */
export function practitionersBootLine(cfg = practitionersConfig()) {
  if (!cfg.enabled) return { level: 'log', message: '[Gaia Practitioners] OFF' + (cfg.warnings.length ? ' — ' + cfg.warnings.join('; ') : '') };
  return { level: cfg.warnings.length ? 'warn' : 'log',
           message: `[Gaia Practitioners] ON { environment: '${cfg.environment}', base: '${cfg.base}' }` + (cfg.warnings.length ? ' — ' + cfg.warnings.join('; ') : '') };
}

// ── PKCE ───────────────────────────────────────────────────────────────────
// S256 is the only method their server advertises, and the only one worth using:
// a plain verifier in a redirect is a verifier in somebody's browser history.
export function makePkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authorizeUrl(cfg, { state, challenge }) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${cfg.base}/api/oauth/authorize?${q.toString()}`;
}

// ── pending flows ──────────────────────────────────────────────────────────
// In memory on purpose. A flow that does not complete within ten minutes should
// be started again, and a restart losing them costs one extra click.
const pending = new Map();

export function rememberFlow(state, row) {
  if (pending.size >= PENDING_MAX) {
    for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
    if (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value);
  }
  pending.set(state, { ...row, exp: Date.now() + STATE_TTL_MS });
}

/**
 * Take a flow back, once. Returns null for unknown, expired or replayed state —
 * which is the whole job: an attacker who can make a practitioner's browser hit
 * the callback with their own code must not be able to bind it to this session.
 */
export function claimFlow(state) {
  const row = pending.get(String(state || ''));
  if (!row) return null;
  pending.delete(state);
  return row.exp < Date.now() ? null : row;
}

export function _pendingSize() { return pending.size; }
export function _resetFlows() { pending.clear(); }

// ── the token store ────────────────────────────────────────────────────────
// A JSON file beside the others in data/, keyed by GHL contact id, written 600.
// The contact id is the key because it is what the session cookie proves and what
// the rest of Gaia already identifies people by; an email would be a key that the
// owner can change out from under us.
export function readTokens(file = TOKEN_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export function writeTokens(all, file = TOKEN_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);        // atomic: a crash mid-write cannot truncate it
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

export function saveToken(contactId, row, file = TOKEN_FILE) {
  const all = readTokens(file);
  all[String(contactId)] = row;
  writeTokens(all, file);
  return row;
}

/**
 * The stored row, or null if this contact never connected.
 *
 * A row whose chain has broken still comes back, flagged. "Never connected" and
 * "connected, then the renewal was refused" need different words in front of the
 * practitioner -- Connect versus Reconnect -- and the second needs to name the
 * account it was, which a null would throw away.
 */
export function tokenFor(contactId, file = TOKEN_FILE) {
  const row = readTokens(file)[String(contactId)];
  if (!row) return null;
  return {
    ...row,
    expired: Boolean(row.expires_at && row.expires_at < Date.now()),
    usable: Boolean(row.access_token) && !row.needs_reconnect,
  };
}

export function forgetToken(contactId, file = TOKEN_FILE) {
  const all = readTokens(file);
  if (!(String(contactId) in all)) return false;
  delete all[String(contactId)];
  writeTokens(all, file);
  return true;
}

/**
 * Is the account they signed into a practitioner account? Gaia Practitioners
 * is the source of truth: `get_practitioner_profile` answers for a practitioner
 * with THEIR practitioner record. Measured on staging, 4 Oct 2026, that record
 * is: id (number), name, firstname, lastname, email, sex, specialty, city,
 * state, address, zipcode, tags, imageURL, status ("pending" on the test
 * account). There is no `role` and no `practitionerId` field, so the plain
 * `id` IS the practitioner id. A `role` that is present and not "practitioner"
 * (should the partner add one) is a client account; a status that says the
 * account is switched off is not a practitioner in our app either. A profile
 * we could not read is not a verdict either way.
 */
export const PROFILE_SOURCE = 'get_practitioner_profile';
export const VERIFICATION_VERSION = 3;
// Temporary compatibility policy: pending practitioner profiles may connect.
// This is not a confirmed partner entitlement rule; huMan must confirm it.
const ALLOWED_PROFILE_STATUSES = new Set(['active', 'pending']);
export const INACTIVE_STATUSES = new Set(['suspended', 'disabled', 'inactive', 'rejected', 'banned', 'deleted', 'blocked', 'archived']);
export function verifyPractitioner(who) {
  if (!who || who.raw_ok === false) return { verified: null, reason: 'profile_unreadable' };
  if (who.profile_source !== PROFILE_SOURCE) return { verified: null, reason: 'profile_unreadable' };
  if (who.profile_role && who.profile_role !== 'practitioner') return { verified: false, reason: 'no_practitioner_profile' };
  if (!String(who.practitioner_id || '').trim()) return { verified: null, reason: 'profile_unreadable' };
  if (INACTIVE_STATUSES.has(String(who.profile_status || '').toLowerCase())) return { verified: false, reason: 'account_not_active' };
  if (!ALLOWED_PROFILE_STATUSES.has(String(who.profile_status || '').toLowerCase())) return { verified: null, reason: 'profile_unreadable' };
  return { verified: true, reason: '' };
}

/**
 * THE link state, used by /status, by the role the tools run with, and by the
 * screen. One function, so the UI and the backend cannot disagree:
 *   not_connected     nothing stored
 *   connected         a usable token for a verified practitioner account
 *   needs_reconnect   token is broken, missing, or expired without refresh
 *   not_practitioner  signed in fine, but the account is not a practitioner
 *   unverified        signed in, profile could not be read (try again)
 */
export function linkState(contactId, file = TOKEN_FILE) {
  const row = tokenFor(contactId, file);
  const who = row ? { practitioner_name: row.practitioner_name || '', practitioner_email: row.practitioner_email || '', practitioner_id: row.practitioner_id || '', profile_status: row.profile_status || '' } : {};
  if (!row) return { state: 'not_connected' };
  const hasVerdict = Object.hasOwn(row, 'verified');
  const provenance = row.profile_source === PROFILE_SOURCE && row.verification_version === VERIFICATION_VERSION;
  const currentVerdict = provenance ? verifyPractitioner(row) : { verified: null };
  // Explicit null/false never inherits a legacy id. Unproven old records must
  // reconnect to re-read the practitioner-scoped tool, not silently promote.
  const verified = currentVerdict.verified === true
    && (hasVerdict ? row.verified === true : provenance);
  if (row.verified === false) return { state: 'not_practitioner', reason: row.verify_reason || 'no_practitioner_profile', ...who, connected_at: row.connected_at || '' };
  if (currentVerdict.verified === false) return { state: 'not_practitioner', reason: currentVerdict.reason, ...who };
  if (row.needs_reconnect || (row.expired && !row.refresh_token) || !row.usable) return { state: 'needs_reconnect', ...who, broken_at: row.broken_at || '', expired: Boolean(row.expired) };
  if (!verified) return { state: 'unverified', reason: row.verify_reason || 'profile_unreadable', ...who, connected_at: row.connected_at || '' };
  return { state: 'connected', ...who, connected_at: row.connected_at || '', expires_at: row.expires_at || 0 };
}
export const isLinkedPractitioner = (contactId, file = TOKEN_FILE) => linkState(contactId, file).state === 'connected';

/** Shared role policy. GHL is legacy evidence only before any link exists. */
export async function practitionerAuthorization(contactId, readGhlRole, file = TOKEN_FILE) {
  const state = linkState(contactId, file).state;
  if (state !== 'not_connected') return state === 'connected';
  try {
    const fallback = Boolean(await readGhlRole());
    // Consent may finish while the CRM read is in flight. Recheck precedence.
    const latest = linkState(contactId, file).state;
    return latest === 'not_connected' ? fallback : latest === 'connected';
  } catch { return false; }
}
export function applyPractitionerLink(access, contactId, file = TOKEN_FILE, ghlConfirmed = true) {
  const state = linkState(contactId, file).state;
  if (!ghlConfirmed && state === 'not_connected') {
    access.member.practitioner = false;
    access.member.practitionerCertified = false;
  }
  if (state !== 'not_connected') {
    access.member.practitioner = state === 'connected';
    access.member.practitionerCertified = access.member.practitioner && access.member.practitionerCertified;
  }
  return access;
}

/** The older shape the app reads (connected / needs_reconnect), derived from linkState so the two can never differ. */
export function connectionStatus(contactId, file = TOKEN_FILE) {
  const s = linkState(contactId, file);
  if (s.state === 'not_connected') return { connected: false, needs_reconnect: false };
  return {
    connected: s.state === 'connected',
    needs_reconnect: s.state === 'needs_reconnect',
    expired: Boolean(s.expired),
    practitioner_name: s.practitioner_name || '',
    practitioner_email: s.practitioner_email || '',
    connected_at: s.connected_at || '',
    expires_at: s.expires_at || 0,
    broken_at: s.broken_at || '',
  };
}

// ── talking to them ────────────────────────────────────────────────────────
export async function exchangeCode(cfg, { code, verifier }, fetchImpl = fetch) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  });
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);
  const r = await fetchImpl(`${cfg.base}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* their error bodies are not always JSON */ }
  if (!r.ok || !json.access_token) {
    const why = json.error_description || json.error || json.message || text.slice(0, 200);
    throw new Error(`token exchange failed (${r.status}): ${why}`);
  }
  return json;
}

/**
 * Renew an access token. Their refresh tokens are SINGLE USE: the response
 * carries a new one, and the old one is dead the moment this succeeds.
 */
export async function refreshAccess(cfg, refreshToken, fetchImpl = fetch) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  });
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);
  const r = await fetchImpl(`${cfg.base}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not always JSON on error */ }
  if (!r.ok || !json.access_token) {
    const why = json.error_description || json.error || json.message || text.slice(0, 200);
    throw Object.assign(new Error(`refresh failed (${r.status}): ${why}`), { status: r.status });
  }
  return json;
}

// One refresh per practitioner at a time.
//
// A single-use refresh token punishes races specifically. Two requests arriving
// together would both read the same stored token, both spend it, and one of them
// would be told it is already used -- and because the winner has already written
// its replacement, the loser can overwrite that replacement with nothing. The
// chain would then be broken permanently and the practitioner would have to
// consent again, for no reason other than having been busy. So concurrent
// callers wait on the same refresh rather than starting their own.
const refreshing = new Map();

/**
 * The access token to use for this practitioner right now, renewed if it is
 * spent or nearly spent. Returns null when they have never connected, and throws
 * `needs_reconnect` when the chain is broken and only a human can fix it.
 */
export async function validAccessToken(cfg, contactId, { file = TOKEN_FILE, fetchImpl = fetch,
                                                         marginMs = 5 * 60 * 1000 } = {}) {
  const key = String(contactId);
  const row = tokenFor(key, file);
  if (!row) return null;
  if (row.needs_reconnect) {
    throw Object.assign(new Error('reconnect required'), { code: 'needs_reconnect' });
  }

  const expiringSoon = row.expires_at && row.expires_at - marginMs < Date.now();
  if (!expiringSoon) return row.access_token;
  if (!row.refresh_token) {
    throw Object.assign(new Error('token expired and no refresh token held'), { code: 'needs_reconnect' });
  }

  if (refreshing.has(key)) return refreshing.get(key);
  const work = (async () => {
    try {
      const fresh = await refreshAccess(cfg, row.refresh_token, fetchImpl);
      saveToken(key, {
        ...row,
        access_token: fresh.access_token,
        // Keep the old one only if they sent none back; losing a rotated token
        // because the response shape surprised us is the one unrecoverable bug.
        refresh_token: fresh.refresh_token || row.refresh_token,
        scope: fresh.scope || row.scope,
        expires_at: Date.now() + (Number(fresh.expires_in || 0) * 1000),
        refreshed_at: new Date().toISOString(),
      }, file);
      return fresh.access_token;
    } catch (e) {
      // A refusal means the chain is done: the stored token is spent and no new
      // one arrived. Say so plainly rather than leaving a dead token in place
      // for every later call to rediscover.
      if (e.status === 400 || e.status === 401) {
        saveToken(key, { ...row, access_token: '', refresh_token: '', needs_reconnect: true,
                         broken_at: new Date().toISOString(), broke_because: String(e.message).slice(0, 160) }, file);
        throw Object.assign(new Error('reconnect required'), { code: 'needs_reconnect' });
      }
      throw e;                      // a network blip is not a broken chain
    } finally {
      refreshing.delete(key);
    }
  })();
  refreshing.set(key, work);
  return work;
}

export function _refreshingSize() { return refreshing.size; }

/** One MCP tools/call. The token is chosen by the caller, never by an argument. */
/** Their answer, classified. `retryable` is the only judgement made here. */
function mcpFailure(name, { timedOut = false, status = 0, detail = '' } = {}) {
  const message = timedOut
    ? `${name}: Bio-Well did not answer within ${MCP_TIMEOUT_MS / 1000}s`
    : status
      ? `${name}: Gaia Practitioners answered ${status}${detail ? ' — ' + detail : ''}`
      : `${name}: could not reach Gaia Practitioners`;
  return Object.assign(new Error(message), {
    code: 'upstream_unavailable',
    status: status || undefined,
    // A timeout is not retried: see MCP_ATTEMPTS. A transport error, a 5xx and
    // a 429 are all their side being briefly unavailable, which is what a
    // retry is for. A 4xx is an answer about the request itself.
    retryable: !timedOut && (status === 0 || status === 429 || status >= 500),
  });
}

async function mcpAttempt(cfg, accessToken, name, args, fetchImpl) {
  let r;
  try {
    r = await fetchImpl(cfg.mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });
  } catch (e) {
    // A timeout and a refused connection are the same thing to the person
    // waiting, and both have to end the spinner.
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw mcpFailure(name, { timedOut });
  }

  const text = await r.text();
  if (r.status === 401) throw Object.assign(new Error('practitioner token rejected'), { code: 401 });
  // Anything else that is not a success has to FAIL rather than fall through.
  // It used to fall through: a 503 left json as {}, the handler saw no scans
  // and told the practitioner their client had none on file. A wrong answer
  // about a client's readings is worse than a card that says it could not load.
  if (!r.ok) throw mcpFailure(name, { status: r.status, detail: text.trim().slice(0, 120) });

  let json = {};
  try { json = JSON.parse(text); } catch {
    // Streamable HTTP may answer as SSE; take the last data: line.
    const last = text.trim().split('\n').filter((l) => l.startsWith('data:')).pop();
    if (last) { try { json = JSON.parse(last.slice(5).trim()); } catch { /* fall through */ } }
  }
  if (json.error) throw new Error(`${name}: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result ?? json;
}

export async function mcpCall(cfg, accessToken, name, args = {}, fetchImpl = fetch) {
  let last;
  for (let attempt = 1; attempt <= MCP_ATTEMPTS; attempt += 1) {
    try {
      return await mcpAttempt(cfg, accessToken, name, args, fetchImpl);
    } catch (e) {
      last = e;
      if (!e?.retryable || attempt === MCP_ATTEMPTS) break;
      console.warn('[Gaia Practitioners]', JSON.stringify({
        event: 'mcp_retry', tool: name, attempt, of: MCP_ATTEMPTS, status: e.status || null,
      }));
      await sleep(MCP_RETRY_DELAY_MS);
    }
  }
  throw last;
}

/**
 * Who did this token turn out to be?
 *
 * Called once, right after consent. This is the identity mapping: rather than
 * matching records across two systems by name or email, we let the practitioner
 * prove both sides in one act — they were signed into Gaia when they started, and
 * they signed into Gaia Practitioners to approve it. Storing the pair records a
 * fact instead of a guess, and showing them the resolved name is what makes a
 * wrong-account connection visible to the one person who can tell.
 */
/**
 * Unwrap an MCP tool result into the object it is really carrying.
 *
 * Tools answer in an envelope: `{ content: [{ type: 'text', text: '<json>' }] }`,
 * where the payload is JSON encoded AS A STRING inside that text field. Reading
 * the envelope as though it were the data finds nothing, and reading it with a
 * regex finds the escaped form and still nothing. Every tool uses this shape, so
 * every caller needs this.
 */
export function unwrapMcp(result) {
  if (result == null) return null;
  const content = result.content ?? result.result?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const text = part?.text;
      if (typeof text !== 'string') continue;
      try { return JSON.parse(text); } catch { return text; }
    }
  }
  if (result.structuredContent) return result.structuredContent;
  return result.result ?? result;
}

export async function resolveProfile(cfg, accessToken, fetchImpl = fetch) {
  try {
    const out = await mcpCall(cfg, accessToken, 'get_practitioner_profile', {}, fetchImpl);
    if (out?.isError) throw new Error('profile tool returned an error');
    const data = unwrapMcp(out);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid practitioner profile');
    const pick = (...keys) => {
      for (const k of keys) {
        const v = data?.[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number') return String(v);
      }
      return '';
    };
    return {
      practitioner_name: pick('name', 'fullName', 'displayName'),
      practitioner_email: pick('email'),
      // Their practitioner record's own id (a number on staging); explicit
      // practitioner fields win should the partner ever add them.
      practitioner_id: pick('practitionerId', 'practitioner_id', 'id'),
      profile_role: String(data?.role || '').toLowerCase(),
      profile_status: String(data?.status || '').toLowerCase(),
      profile_source: PROFILE_SOURCE,
      raw_ok: true,
    };
  } catch (e) {
    // A token that cannot read its own profile is still a token; record that we
    // could not confirm who it belongs to rather than inventing an identity.
    return { practitioner_name: '', practitioner_email: '', practitioner_id: '', profile_role: '', profile_status: '', raw_ok: false,
             note: String(e.message || e).slice(0, 140) };
  }
}
