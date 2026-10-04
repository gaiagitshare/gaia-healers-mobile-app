/**
 * MEMBER ↔ PRACTITIONER LINK — a member's consent to share their Bio-Well
 * results, and the member-only reads that consent allows.
 *
 * Agreed with Gaia Practitioners on 4 Oct 2026 (docs/PRACTITIONERS_MEMBER_RESULTS_SPEC.md):
 *
 *   1. The MEMBER asks for a short link code in the Gaia app. Asking is the
 *      consent (HIPAA authorization); the moment is recorded.
 *   2. The member reads the code to their PRACTITIONER, who enters it in the
 *      practitioner dashboard. Their server redeems it against us with the
 *      server credential. A code is 8 unambiguous characters, lives 15
 *      minutes, works once. A typo can only fail, never link the wrong person.
 *   3. Either side can unlink at any time.
 *   4. Reads are member-only tools on their MCP that answer for ONE member
 *      through a confirmed link -- no listing, no search.
 *
 * Nothing here is reachable unless GAIA_MEMBER_READINGS_ENABLED=true. Scan data
 * is never written to disk by this module; the store holds codes, links and the
 * consent/link/unlink audit, nothing clinical.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { mcpCall, unwrapMcp } from './practitioners-oauth.js';

export const LINK_FILE = process.env.GAIA_MEMBER_LINK_FILE || '/root/gaia-staging-proxy/data/member-links.json';
// 24 hours, at the partner's request (4 Oct): a member who is not in the
// clinic messages the code and the practitioner may not see it for hours.
// Still single use, still only redeemable by a practitioner against one of
// their own customers, so the longer window adds little.
export const CODE_TTL_MS = 24 * 60 * 60 * 1000;
export const CODE_LENGTH = 8;
// No 0/O/1/I/L: a code is read aloud and typed by somebody else.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const AUDIT_MAX = 5000;

export function memberReadingsEnabled(env = process.env) {
  return env.GAIA_MEMBER_READINGS_ENABLED === 'true';
}
/**
 * While the link is being proven on staging, only named members see it:
 * GAIA_MEMBER_READINGS_MEMBERS is a comma-separated list of Gaia member ids.
 * Empty or unset = every signed-in member (the eventual state).
 */
export function memberAllowed(memberId, env = process.env) {
  const list = String(env.GAIA_MEMBER_READINGS_MEMBERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(String(memberId || ''));
}

// ── store ─────────────────────────────────────────────────────────────────
function load(file = LINK_FILE) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return { codes: d.codes || {}, links: d.links || {}, audit: d.audit || [] }; }
  catch { return { codes: {}, links: {}, audit: [] }; }
}
function save(store, file = LINK_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function audit(store, event, fields) {
  store.audit.push({ at: new Date().toISOString(), event, ...fields });
  if (store.audit.length > AUDIT_MAX) store.audit.splice(0, store.audit.length - AUDIT_MAX);
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ── codes ─────────────────────────────────────────────────────────────────
/** A fresh code for this member; any earlier unredeemed code is replaced. */
export function mintCode(memberId, { now = Date.now(), file = LINK_FILE } = {}) {
  const id = String(memberId || '').trim();
  if (!id) throw Object.assign(new Error('member required'), { code: 'bad_args' });
  const store = load(file);
  if (store.links[id] && store.links[id].status === 'confirmed') {
    throw Object.assign(new Error('already linked'), { code: 'already_linked' });
  }
  for (const [c, row] of Object.entries(store.codes)) if (row.memberId === id || row.exp < now) delete store.codes[c];
  let code;
  do { code = Array.from(crypto.randomBytes(CODE_LENGTH), (b) => ALPHABET[b % ALPHABET.length]).join(''); } while (store.codes[code]);
  store.codes[code] = { memberId: id, createdAt: new Date(now).toISOString(), exp: now + CODE_TTL_MS };
  audit(store, 'consent_code_issued', { memberId: id });
  save(store, file);
  return { code, expires_at: new Date(now + CODE_TTL_MS).toISOString(), consent_recorded_at: store.codes[code].createdAt };
}

/** Their server, with the practitioner's customer, redeems the member's code. */
export function redeemCode(rawCode, { customer_id, practitioner_id, practitioner_name = '' } = {}, { now = Date.now(), file = LINK_FILE } = {}) {
  const code = normCode(rawCode);
  const customerId = String(customer_id || '').trim();
  const practitionerId = String(practitioner_id || '').trim();
  if (code.length !== CODE_LENGTH || !customerId || !practitionerId) throw Object.assign(new Error('code, customer_id and practitioner_id required'), { code: 'bad_args' });
  const store = load(file);
  const row = store.codes[code];
  if (!row) throw Object.assign(new Error('unknown code'), { code: 'code_invalid' });
  if (row.exp < now) { delete store.codes[code]; save(store, file); throw Object.assign(new Error('code expired'), { code: 'code_expired' }); }
  delete store.codes[code];                                   // single use, whatever happens next
  if (store.links[row.memberId]?.status === 'confirmed') { save(store, file); throw Object.assign(new Error('already linked'), { code: 'already_linked' }); }
  store.links[row.memberId] = {
    status: 'confirmed', customer_id: customerId, practitioner_id: practitionerId,
    practitioner_name: String(practitioner_name || '').slice(0, 80),
    consent_at: row.createdAt, linked_at: new Date(now).toISOString(),
  };
  audit(store, 'link_confirmed', { memberId: row.memberId, customer_id: customerId, practitioner_id: practitionerId });
  save(store, file);
  return { gaia_member_id: row.memberId, status: 'confirmed', linked_at: store.links[row.memberId].linked_at };
}

/** Unlink by member (the app) or by customer (their server). Idempotent. */
export function revokeLink({ memberId = '', customer_id = '' } = {}, by = 'member', { now = Date.now(), file = LINK_FILE } = {}) {
  const store = load(file);
  let id = String(memberId || '').trim();
  if (!id && customer_id) id = Object.keys(store.links).find((m) => store.links[m].customer_id === String(customer_id)) || '';
  const link = id ? store.links[id] : null;
  if (!link || link.status !== 'confirmed') return { revoked: false, status: link ? link.status : 'none' };
  store.links[id] = { ...link, status: 'revoked', revoked_at: new Date(now).toISOString(), revoked_by: by === 'practitioner' ? 'practitioner' : 'member' };
  audit(store, 'link_revoked', { memberId: id, customer_id: link.customer_id, by: store.links[id].revoked_by });
  save(store, file);
  return { revoked: true, status: 'revoked', customer_id: link.customer_id, practitioner_id: link.practitioner_id };
}

/** What the member may see about their own link. Never the code store. */
export function linkStatus(memberId, { now = Date.now(), file = LINK_FILE } = {}) {
  const id = String(memberId || '').trim();
  const store = load(file);
  const link = store.links[id];
  const pending = Object.entries(store.codes).find(([, r]) => r.memberId === id && r.exp > now);
  return {
    linked: Boolean(link && link.status === 'confirmed'),
    status: link ? link.status : 'none',
    practitioner_name: link?.status === 'confirmed' ? (link.practitioner_name || '') : '',
    linked_at: link?.status === 'confirmed' ? link.linked_at : null,
    code_active: Boolean(pending),
    code_expires_at: pending ? new Date(pending[1].exp).toISOString() : null,
  };
}
export function linkFor(memberId, file = LINK_FILE) {
  const link = load(file).links[String(memberId || '').trim()];
  return link && link.status === 'confirmed' ? link : null;
}

// ── their server calling ours ─────────────────────────────────────────────
/** Bearer check for the redeem/revoke routes: constant-time, never logged. */
export function partnerAuthorized(req, env = process.env) {
  const secret = String(env.GAIA_PRACTITIONERS_LINK_SECRET || '');
  const header = String(req.headers?.authorization || '');
  if (secret.length < 16 || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7)); const want = Buffer.from(secret);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// ── their backend, as agreed 4 Oct 2026 ───────────────────────────────────
// All member calls go to their backend host with Gaia's API key as a bearer:
//   GET    /api/gaia/member-links/{gaia_member_id}     link status
//   DELETE /api/gaia/member-links/{gaia_member_id}     unlink (our "unlink_customer_member")
//   POST   /api/gaia/member-token { gaiaMemberId }     a 1-hour token for that ONE member
// and the member-only MCP at /api/member-mcp, called with that member token.
// The key is read from the environment per call and never leaves this module.
export function memberBackend(cfg, env = process.env) {
  const explicit = String(env.GAIA_PRACTITIONERS_MEMBER_BACKEND || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  if (cfg?.environment === 'production') return 'https://backend.gaiapractitioners.com';
  return 'https://staging-backend.gaiapractitioners.com';
}
const memberApiKey = (env = process.env) => String(env.GAIA_PRACTITIONERS_MEMBER_API_KEY || '').trim();

const _memberTokens = new Map();   // gaia_member_id -> { value, exp }
export function _resetServerTokenForTest() { _serverToken = null; _memberTokens.clear(); }
async function backendCall(cfg, method, pathname, { env = process.env, fetchImpl = fetch, body } = {}) {
  const key = memberApiKey(env);
  if (!key) throw Object.assign(new Error('no member api key'), { code: 'not_configured' });
  const r = await fetchImpl(`${memberBackend(cfg, env)}${pathname}`, {
    method, headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (!r.ok) throw Object.assign(new Error(`${method} ${pathname} ${r.status}`), { status: r.status, body: json, code: json?.code || json?.error || (r.status === 401 || r.status === 403 ? 'forbidden_scope' : r.status === 404 ? 'member_not_linked' : 'upstream_unavailable') });
  return json;
}
/** A one-member, one-hour token from their backend; cached until shortly before expiry. */
export async function memberToken(cfg, memberId, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const hit = _memberTokens.get(memberId);
  if (hit && hit.exp > now + 60_000) return hit.value;
  const j = await backendCall(cfg, 'POST', '/api/gaia/member-token', { env, fetchImpl, body: { gaiaMemberId: memberId } });
  const value = j?.token || j?.access_token || j?.memberToken;
  if (!value) throw Object.assign(new Error('no token in response'), { code: 'upstream_unavailable' });
  const ttl = Math.max(60, Number(j.expires_in || j.expiresIn || 3600)) * 1000;
  _memberTokens.set(memberId, { value, exp: now + ttl });
  return value;
}
/** Their record of the link, for reconciling ours. */
export async function partnerLinkStatus(cfg, memberId, opts = {}) {
  return backendCall(cfg, 'GET', `/api/gaia/member-links/${encodeURIComponent(memberId)}`, opts);
}

// ── Gaia's own OAuth client credential (members.read) — kept as the fallback
// when no member API key is configured. Never a practitioner's token and
// never anything the browser sees.
let _serverToken = null;
export async function serverAccessToken(cfg, env = process.env, fetchImpl = fetch) {
  if (_serverToken && _serverToken.exp > Date.now() + 30_000) return _serverToken.value;
  const clientId = env.GAIA_PRACTITIONERS_SERVER_CLIENT_ID || cfg.clientId;
  const clientSecret = env.GAIA_PRACTITIONERS_SERVER_CLIENT_SECRET || cfg.clientSecret;
  if (!clientId || !clientSecret) throw Object.assign(new Error('no server credential'), { code: 'not_configured' });
  const r = await fetchImpl(`${cfg.base}/api/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'members.read' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Object.assign(new Error(`server token ${r.status}`), { code: r.status === 401 || r.status === 403 ? 'forbidden_scope' : 'upstream_unavailable' });
  const j = await r.json();
  _serverToken = { value: j.access_token, exp: Date.now() + Math.max(60, Number(j.expires_in || 3600)) * 1000 };
  return _serverToken.value;
}

/** One scan, reduced to what the member's card shows (same shape as the practitioner's). */
export function memberScanView(scan = {}) {
  // Their member MCP sends the values under `values`; the practitioner MCP
  // under `labeled`; a flat scan is accepted too.
  const l = scan.values || scan.labeled || scan;
  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null);
  const rows = [];
  for (const group of ['organs', 'meridians', 'systems']) for (const r of l[group] || []) if (typeof r?.disbalance === 'number') rows.push({ area: group.replace(/s$/, ''), name: r.name, disbalance: num(r.disbalance) });
  return {
    scanned_at: String(scan.scanned_at || '').slice(0, 10),
    stress: num(l.stress, 2), energy: num(l.energy),
    chakras: (l.chakras || []).map((c) => ({ name: c.name, value: num(c.value, 2), alignment: num(c.align) })),
    most_out_of_balance: rows.sort((a, b) => b.disbalance - a.disbalance).slice(0, 6),
  };
}

const PARTNER_ERRORS = { member_not_linked: 404, link_pending: 409, link_revoked: 410, forbidden_scope: 403 };
function partnerError(e) {
  const code = String(e?.body?.code || e?.code || '');
  if (PARTNER_ERRORS[code]) return Object.assign(new Error(code), { code, status: PARTNER_ERRORS[code] });
  if (e?.status === 429) return Object.assign(new Error('rate_limited'), { code: 'rate_limited', status: 429 });
  return Object.assign(new Error('readings_unavailable'), { code: e?.code === 'not_configured' ? 'not_configured' : 'readings_unavailable', status: 503 });
}

/** The tool names their member-only MCP offers, learned once per token. */
async function memberToolNames(cfg, token, fetchImpl) {
  try {
    const r = await fetchImpl(cfg.mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    return new Set((j?.result?.tools || j?.tools || []).map((t) => t?.name).filter(Boolean));
  } catch { return new Set(); }
}

/**
 * Everything the member's "My readings" screen shows, from their member-only
 * MCP, for one confirmed link. With their API key configured the token is a
 * one-member token from their backend; otherwise the OAuth server credential.
 * Their member-only MCP may expose either the member-named tools we proposed
 * or the practitioner-named ones scoped by the token; both shapes are read.
 */
export async function memberReadings(cfg0, memberId, { env = process.env, fetchImpl = fetch, file = LINK_FILE } = {}) {
  const link = linkFor(memberId, file);
  if (!link) throw Object.assign(new Error('member_not_linked'), { code: 'member_not_linked', status: 404 });
  const viaKey = Boolean(memberApiKey(env));
  const cfg = viaKey ? { ...cfg0, mcpUrl: `${memberBackend(cfg0, env)}/api/member-mcp` } : cfg0;
  let token;
  try { token = viaKey ? await memberToken(cfg0, memberId, { env, fetchImpl }) : await serverAccessToken(cfg0, env, fetchImpl); } catch (e) { throw partnerError(e); }
  const names = await memberToolNames(cfg, token, fetchImpl);
  const has = (n) => names.size === 0 || names.has(n);
  const call = async (tool, args) => { try { return unwrapMcp(await mcpCall(cfg, token, tool, args, fetchImpl)); } catch (e) { throw partnerError(e); } };
  const scoped = { gaia_member_id: memberId };
  const byCustomer = { customerId: link.customer_id };
  // Three vocabularies, in order of preference: theirs as built on staging
  // (get_my_*, 4 Oct 2026), the member-named tools we proposed, and the
  // practitioner-named tools scoped by the member token.
  const pick = (mine, ours, theirs, args) =>
    (has(mine) ? call(mine, args.mine) : has(ours) ? call(ours, args.ours) : call(theirs, args.theirs));
  const [customer, scan, trend, compare, files] = await Promise.all([
    pick('get_my_profile', 'get_member_customer', 'get_customer', { mine: {}, ours: scoped, theirs: byCustomer }).catch((e) => (e.code === 'member_not_linked' ? Promise.reject(e) : null)),
    pick('get_my_latest_scan', 'get_member_scan', 'get_customer_scan', { mine: {}, ours: { ...scoped, which: 'latest' }, theirs: byCustomer }).catch((e) => (e.code === 'member_not_linked' ? Promise.reject(e) : null)),
    pick('get_my_scan_trend', 'get_member_scan_trend', 'get_scan_trend', { mine: {}, ours: { ...scoped, window: '90d' }, theirs: { ...byCustomer, summary_only: true } }).catch(() => null),
    pick('get_my_before_after', 'compare_member_before_after', 'compare_protocol_before_after', { mine: {}, ours: scoped, theirs: { ...byCustomer, limit: 2 } }).catch(() => null),
    pick('list_my_shared_files', 'get_member_files', 'get_customer_files', { mine: {}, ours: scoped, theirs: byCustomer }).catch(() => null),
  ]);
  // get_customer_scan answers with the whole history; take the newest.
  const latestOf = (s) => {
    if (!s) return null;
    if (s.scan) return s.scan;
    if (Array.isArray(s.scans)) return [...s.scans].sort((a, b) => String(b.scanned_at || '').localeCompare(String(a.scanned_at || '')))[0] || null;
    return (s.scanned_at || s.labeled) ? s : null;
  };
  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null);
  const band = (b) => (b ? { lowest: num(b.min, 1), highest: num(b.max, 1), average: num(b.avg, 1), latest: num(b.latest, 1) } : null);
  const prac = customer?.practitioner || {};
  const comparisons = (compare?.comparisons || []).slice(0, 2).map((c) => ({
    basis: c.source === 'time' ? 'consecutive sessions' : (c.protocol || 'a labelled protocol'),
    from: String(c.before?.date || '').slice(0, 10), to: String(c.after?.date || '').slice(0, 10),
    stress_change: num(c.deltas?.stress, 2), energy_change: num(c.deltas?.energy, 1),
    biggest_changes: (Array.isArray(c.deltas?.disbalance) ? c.deltas.disbalance : []).slice(0, 4).map((d) => ({ name: d.name, before: num(d.before), after: num(d.after), change: num(d.delta) })),
  }));
  return {
    practitioner: { id: String(prac.id ?? link.practitioner_id), name: prac.name || link.practitioner_name || '', specialty: prac.specialty || '', location: [prac.city, prac.state].filter(Boolean).join(', ') },
    linked_at: customer?.member?.linked_at || link.linked_at,
    scans_on_file: scan?.scanCount ?? customer?.scans_on_file ?? trend?.scanCount ?? (Array.isArray(scan?.scans) ? scan.scans.length : null),
    latest: latestOf(scan) ? memberScanView(latestOf(scan)) : null,
    trend: trend ? { energy: band(trend.summary?.energy), stress: band(trend.summary?.stress),
      flagged: (trend.flags || []).slice(0, 6).map((t) => ({ name: t.name, area: String(t.category || '').replace(/s$/, ''), direction: t.direction, severity: t.severity || '', change: num(t.delta), reason: t.flagReason || '' })) } : null,
    comparisons,
    files: (files?.files || []).filter((f) => f?.shareable !== false).slice(0, 20).map((f) => ({ id: String(f.id ?? ''), name: f.name || f.filename || f.original_name || 'document', uploaded_at: String(f.uploaded_at || f.created_at || f.uploadedAt || '').slice(0, 10), url: f.download_url || f.url || null })),
  };
}

/** Best effort: tell their server the member stopped sharing. Local revoke never waits on it. */
export async function notifyPartnerUnlink(cfg, { memberId, customerId }, { env = process.env, fetchImpl = fetch } = {}) {
  try {
    if (memberApiKey(env)) { await backendCall(cfg, 'DELETE', `/api/gaia/member-links/${encodeURIComponent(memberId)}`, { env, fetchImpl }); _memberTokens.delete(memberId); return true; }
    const token = await serverAccessToken(cfg, env, fetchImpl);
    await mcpCall(cfg, token, 'unlink_customer_member', { customer_id: customerId }, fetchImpl);
    return true;
  } catch (e) { console.warn('[Gaia Practitioners] member unlink not delivered to partner', { code: e.code || null }); return false; }
}
