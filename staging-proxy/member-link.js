import { readingSeries, recentAverage } from './reading-history.js';
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
import { mcpCall, unwrapMcp, readTokens, validAccessToken } from './practitioners-oauth.js';

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
    // Newest reading we know of vs the newest the member has opened: the
    // Today nudge and the dot on the You tab come from these two dates only.
    latest_scanned_at: link?.status === 'confirmed' ? (link.latest_scanned_at || null) : null,
    seen_scanned_at: link?.status === 'confirmed' ? (link.seen_scanned_at || null) : null,
    new_reading: Boolean(link?.status === 'confirmed' && link.latest_scanned_at && link.latest_scanned_at > (link.seen_scanned_at || '')),
  };
}

/** Remember the newest reading date for a linked member (from any fetch that learned it). */
export function rememberLatest(memberId, scannedAt, { now = Date.now(), file = LINK_FILE } = {}) {
  const id = String(memberId || '').trim(); const d = String(scannedAt || '').slice(0, 10);
  const store = load(file); const link = store.links[id];
  if (!link || link.status !== 'confirmed') return false;
  link.latest_checked_at = new Date(now).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d !== link.latest_scanned_at) { link.latest_scanned_at = d; }
  save(store, file);
  return true;
}
/** The member has looked at the reading of this date; the nudge and the dot go away. */
export function markSeen(memberId, scannedAt, { file = LINK_FILE } = {}) {
  const id = String(memberId || '').trim(); const d = String(scannedAt || '').slice(0, 10);
  const store = load(file); const link = store.links[id];
  if (!link || link.status !== 'confirmed' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  if ((link.seen_scanned_at || '') < d) { link.seen_scanned_at = d; audit(store, 'reading_opened', { memberId: id, customer_id: link.customer_id, scanned_at: d }); save(store, file); }
  return true;
}
export const LATEST_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * The date of the member's newest reading, refreshed from their side at most
 * every six hours (one small call: the latest scan only). Anything that
 * fails leaves the remembered date alone; the status route never waits on
 * their server for more than the call's own timeout.
 */
export async function refreshLatest(cfg0, memberId, { env = process.env, fetchImpl = fetch, file = LINK_FILE, now = Date.now() } = {}) {
  const link = linkFor(memberId, file);
  if (!link) return null;
  const checked = Date.parse(link.latest_checked_at || '') || 0;
  if (now - checked < LATEST_CHECK_TTL_MS) return link.latest_scanned_at || null;
  try {
    const viaKey = Boolean(memberApiKey(env));
    const cfg = viaKey ? { ...cfg0, mcpUrl: `${memberBackend(cfg0, env)}/api/member-mcp` } : cfg0;
    const token = viaKey ? await memberToken(cfg0, memberId, { env, fetchImpl }) : await serverAccessToken(cfg0, env, fetchImpl);
    const names = await memberToolNames(cfg, token, fetchImpl);
    const has = (n) => names.size === 0 || names.has(n);
    const [tool, args] = has('get_my_latest_scan') ? ['get_my_latest_scan', {}] : has('get_member_scan') ? ['get_member_scan', { gaia_member_id: memberId, which: 'latest' }] : ['get_customer_scan', { customerId: link.customer_id }];
    const out = unwrapMcp(await mcpCall(cfg, token, tool, args, fetchImpl));
    const scan = out?.scan || (Array.isArray(out?.scans) ? [...out.scans].sort((a, b) => String(b.scanned_at || '').localeCompare(String(a.scanned_at || '')))[0] : out);
    const d = String(scan?.scanned_at || '').slice(0, 10);
    rememberLatest(memberId, d, { now, file });
    return d || link.latest_scanned_at || null;
  } catch {
    rememberLatest(memberId, '', { now, file });   // tried; try again in six hours
    return link.latest_scanned_at || null;
  }
}
export function linkFor(memberId, file = LINK_FILE) {
  const link = load(file).links[String(memberId || '').trim()];
  return link && link.status === 'confirmed' ? link : null;
}

/**
 * For a practitioner: which of THEIR clients share their readings through
 * Gaia, and whether each has opened them. Keyed by their customer id, which
 * is theirs already; the Gaia member id is never returned.
 */
export function linksForPractitioner(practitionerId, file = LINK_FILE, { consent = null } = {}) {
  const pid = String(practitionerId || '').trim();
  if (!pid) return [];
  return Object.entries(load(file).links)
    .filter(([, l]) => l.status === 'confirmed' && String(l.practitioner_id || '') === pid)
    .map(([memberId, l]) => ({ customer_id: String(l.customer_id), linked_at: l.linked_at, latest_scanned_at: l.latest_scanned_at || null,
      opened: Boolean(l.seen_scanned_at), opened_latest: Boolean(l.seen_scanned_at && l.latest_scanned_at && l.seen_scanned_at >= l.latest_scanned_at),
      // Whether this client lets Gaia Assist use the guides written for them (their own switch; a boolean, never the guides).
      guides_to_assist: typeof consent === 'function' ? Boolean(consent(memberId)) : false }))
    .sort((a, b) => String(b.linked_at || '').localeCompare(String(a.linked_at || '')));
}

/** Today's link events and the standing totals, counts only (for the alert sweep and the daily line). */
export function linkDayCounts({ now = Date.now(), file = LINK_FILE } = {}) {
  const store = load(file);
  const day = new Date(now).toISOString().slice(0, 10);
  const todays = store.audit.filter((r) => String(r?.at || '').slice(0, 10) === day);
  const count = (ev) => todays.filter((r) => r.event === ev).length;
  const links = Object.values(store.links);
  return { day, codes_issued: count('consent_code_issued'), links_confirmed: count('link_confirmed'), readings_opened: count('reading_opened'), links_revoked: count('link_revoked'), guides_read: count('guides_read'),
    confirmed: links.filter((l) => l.status === 'confirmed').length, revoked: links.filter((l) => l.status === 'revoked').length };
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
    // A practitioner's own words about this scan, if their side sends any
    // (none of their current tools do; shown the day they add it).
    note: practitionerNote(scan) || practitionerNote(l),
  };
}
const practitionerNote = (o) => {
  for (const k of ['practitioner_note', 'practitionerNote', 'note', 'notes', 'comment', 'comments']) {
    const v = o?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 600);
  }
  return null;
};

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
  // Their latest-scan tool can answer with a scan whose values are all empty
  // (seen on staging, 4 Oct: scan 2026-06-14, every value null) while the
  // trend for the same member is complete. The newest trend point with
  // numbers, plus the per-area latest disbalance, is then the latest reading
  // -- said so with `source: 'trend'`, and without chakras, which the trend
  // does not carry.
  const emptyScan = (v) => !v || (v.stress == null && v.energy == null && !(v.chakras || []).length && !(v.most_out_of_balance || []).length);
  const latestFromTrend = (t) => {
    const pts = (t?.points || []).filter((p) => typeof p?.energy === 'number' || typeof p?.stress === 'number')
      .sort((a, b) => String(b.scanned_at || '').localeCompare(String(a.scanned_at || '')));
    if (!pts.length) return null;
    const p = pts[0];
    const worst = (t.organTrends || []).filter((o) => typeof o?.latest === 'number')
      .map((o) => ({ area: String(o.category || '').replace(/s$/, ''), name: o.name, disbalance: num(o.latest) }))
      .sort((a, b) => b.disbalance - a.disbalance).slice(0, 6);
    return { scanned_at: String(p.scanned_at || '').slice(0, 10), stress: num(p.stress, 2), energy: num(p.energy), chakras: [], most_out_of_balance: worst, source: 'trend' };
  };
  const prac = customer?.practitioner || {};
  const comparisons = (compare?.comparisons || []).slice(0, 2).map((c) => ({
    basis: c.source === 'time' ? 'consecutive sessions' : (c.protocol || 'a labelled protocol'),
    from: String(c.before?.date || '').slice(0, 10), to: String(c.after?.date || '').slice(0, 10),
    stress_change: num(c.deltas?.stress, 2), energy_change: num(c.deltas?.energy, 1),
    biggest_changes: (Array.isArray(c.deltas?.disbalance) ? c.deltas.disbalance : []).slice(0, 4).map((d) => ({ name: d.name, before: num(d.before), after: num(d.after), change: num(d.delta) })),
  }));
  const latestView = (() => { const v = latestOf(scan) ? memberScanView(latestOf(scan)) : null; return emptyScan(v) ? (latestFromTrend(trend) || v) : { ...v, source: 'scan' }; })();
  const trendView = trend ? { energy: band(trend.summary?.energy), stress: band(trend.summary?.stress),
      flagged: (trend.flags || []).slice(0, 6).map((t) => ({ name: t.name, area: String(t.category || '').replace(/s$/, ''), direction: t.direction, severity: t.severity || '', change: num(t.delta), reason: t.flagReason || '' })) } : null;
  // A small series for a sparkline: newest 24 dated points with numbers.
  const series = readingSeries(trend?.points || [], 24);
  const practitionerName = prac.name || link.practitioner_name || 'your practitioner';
  return {
    practitioner: { id: String(prac.id ?? link.practitioner_id), name: prac.name || link.practitioner_name || '', specialty: prac.specialty || '', location: [prac.city, prac.state].filter(Boolean).join(', ') },
    summary: readingSummary({ latest: latestView, trend: trendView, comparisons, practitionerName }),
    recheck_after_days: recheckAfterDays(env),
    series,
    average_recent: recentAverage(series),
    linked_at: customer?.member?.linked_at || link.linked_at,
    scans_on_file: scan?.scanCount ?? customer?.scans_on_file ?? trend?.scanCount ?? (Array.isArray(scan?.scans) ? scan.scans.length : null),
    latest: latestView,
    trend: trendView,
    comparisons,
    files: (files?.files || []).filter((f) => f?.shareable !== false).slice(0, 20).map((f) => ({ id: String(f.id ?? ''), name: f.name || f.filename || f.original_name || 'document', uploaded_at: String(f.uploaded_at || f.created_at || f.uploadedAt || '').slice(0, 10), url: f.download_url || f.url || null, first: readFirst(f) }))
      .sort((a, b) => Number(b.first) - Number(a.first)),
  };
}
/**
 * The guides their practitioner wrote for them ("AI-generated
 * recommendations/scripts" on the partner side: `get_customer_recommendations`,
 * text per customer). Read ONLY when the member switched `guides_to_assist`
 * on — the caller checks that; this function only fetches and shapes.
 *
 * Two roads, in order: the member road (their member-mcp, if it ever offers
 * a recommendations tool) and the practitioner road: if the practitioner who
 * recorded the link has connected their own Gaia Practitioners account in our
 * app, their token reads their customer's guides — the same data they see in
 * their own Practice tab. No road: null (not an error; nothing to say).
 *
 * The partner's response shape for this tool is NOT measured yet (no linked
 * practitioner had a Gaia-member client on 5 Oct 2026); shapeGuides accepts
 * the likely spellings and ignores the rest.
 */
/**
 * Partner AI recommendations ("guides", get_customer_recommendations) are a
 * DISABLED source (owner, 6 Oct 2026). The partner describes them as
 * AI-generated, probably from scan values, with no practitioner approval
 * state; until the partner answers how they are made, reviewed and processed,
 * nothing reads them -- whatever the member's switch says, and even when the
 * partner has records. GAIA_PARTNER_AI_RECOMMENDATIONS=on is the only way on.
 */
export function partnerAiRecommendationsEnabled(env = process.env) { return env.GAIA_PARTNER_AI_RECOMMENDATIONS === 'on'; }

export async function memberGuides(cfg0, memberId, { env = process.env, fetchImpl = fetch, file = LINK_FILE, tokenFile } = {}) {
  if (!partnerAiRecommendationsEnabled(env)) return null;   // disabled source: no partner call at all
  const link = linkFor(memberId, file);
  if (!link) return null;
  // Member road.
  if (memberApiKey(env)) {
    try {
      const cfg = { ...cfg0, mcpUrl: `${memberBackend(cfg0, env)}/api/member-mcp` };
      const token = await memberToken(cfg0, memberId, { env, fetchImpl });
      const names = await memberToolNames(cfg, token, fetchImpl);
      const tool = ['get_my_recommendations', 'get_my_guides', 'get_member_recommendations'].find((n) => names.has(n));
      if (tool) return counted(shapeGuides(unwrapMcp(await mcpCall(cfg, token, tool, tool === 'get_member_recommendations' ? { gaia_member_id: memberId } : {}, fetchImpl))), memberId, 'member', file);
    } catch { /* fall through to the practitioner road */ }
  }
  // Practitioner road.
  const pid = String(link.practitioner_id || '');
  const tokens = tokenFile ? readTokens(tokenFile) : readTokens();
  const contactId = Object.keys(tokens).find((cid) => String(tokens[cid]?.practitioner_id || '') === pid && tokens[cid]?.verified !== false);
  if (!pid || !contactId) return null;
  try {
    const token = await validAccessToken(cfg0, contactId, tokenFile ? { file: tokenFile, fetchImpl } : { fetchImpl });
    if (!token) return null;
    return counted(shapeGuides(unwrapMcp(await mcpCall(cfg0, token, 'get_customer_recommendations', { customerId: link.customer_id }, fetchImpl))), memberId, 'practitioner', file);
  } catch { return null; }
}
/** Each read is one audit event — a count and the road, never the guides — so the usage report can say whether the feature is used. */
function counted(shaped, memberId, road, file) {
  try { const store = load(file); audit(store, 'guides_read', { memberId: String(memberId), road, items: shaped.items.length }); save(store, file); } catch { /* counting never blocks reading */ }
  return shaped;
}

const GUIDE_ITEMS = 3, GUIDE_CHARS = 400;
/** Shape the partner's recommendations into at most three short guides. Lines that carry scan values stay out. */
export function shapeGuides(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.recommendations) ? raw.recommendations
    : Array.isArray(raw?.items) ? raw.items
    : Array.isArray(raw?.guides) ? raw.guides
    : (raw && typeof raw === 'object' && (raw.content || raw.text || raw.script || raw.recommendation)) ? [raw] : [];
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const items = list.map((g) => {
    const text = str(g?.content) || str(g?.text) || str(g?.script) || str(g?.recommendation) || str(g?.body) || str(g?.summary);
    const title = str(g?.title) || str(g?.name) || str(g?.subject) || str(g?.type) || 'Guide';
    const when = String(g?.created_at || g?.createdAt || g?.date || g?.updated_at || '').slice(0, 10);
    return { title: title.slice(0, 80), when: /^\d{4}-\d{2}-\d{2}$/.test(when) ? when : '', text: clean(text).slice(0, GUIDE_CHARS) };
  }).filter((g) => g.text)
    .sort((a, b) => b.when.localeCompare(a.when))
    .slice(0, GUIDE_ITEMS);
  return { count: list.length, items };
}
// A guide is prose; a line that quotes a reading ("energy 54", "stress: 3.0")
// is a value, and values never reach the model. Those lines are dropped.
const clean = (text) => String(text || '').split(/\r?\n/)
  .filter((line) => !/\b(energy|stress|chakra|meridian|organ|disbalance)\b[^\n]{0,40}\d/i.test(line))
  .map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
/** One bounded block for the context window. Empty string when there is nothing. */
export function guidesForModel(shaped) {
  if (!shaped?.items?.length) return '';
  return shaped.items.map((g) => `- ${g.title}${g.when ? ` (${g.when})` : ''}: ${g.text}`).join('\n').slice(0, 1400);
}

/** "Read this first": a document the practitioner pinned, in any of the spellings their side might use. */
export const readFirst = (f) => Boolean(f?.read_first || f?.readFirst || f?.pinned || f?.featured || f?.primary
  || (Array.isArray(f?.tags) && f.tags.some((t) => /read[\s_-]?first|pinned|featured/i.test(String(t)))));

/**
 * Gaia's product policy for suggesting another scan: days since the latest
 * one (GAIA_SCAN_RECHECK_DAYS, default 60). A Gaia policy, not a Bio-Well
 * rule: nothing says a reading expires. Sent with the link status and the
 * readings so the app never hard-codes it.
 */
export function recheckAfterDays(env = process.env) {
  const n = Number.parseInt(env.GAIA_SCAN_RECHECK_DAYS || '', 10);
  return Number.isFinite(n) && n >= 7 && n <= 730 ? n : 60;
}

/**
 * The at-a-glance summary -- plain rules, no model. Descriptive only: the
 * latest figures compared with the member's own 90-day average as signed
 * differences, what their practitioner's scan platform flagged (attributed
 * to it), and the highest and lowest centre values. No step sizes, ranges
 * or words such as "usual" or "comfortable": no approved source defines
 * them (docs/BIOWELL_INTERPRETATION_SOURCE_REQUIREMENTS.md). Exported for
 * the test and for the card.
 */
export function readingSummary({ latest, trend, comparisons = [], practitionerName = 'your practitioner' } = {}) {
  const lines = [];
  const e = latest?.energy, s = latest?.stress;
  const eAvg = trend?.energy?.average, sAvg = trend?.stress?.average;
  const diff = (v, avg, d) => (typeof v === 'number' && typeof avg === 'number' ? `${v - avg > 0 ? '+' : (v - avg < 0 ? '−' : '±')}${Math.abs(v - avg).toFixed(d)}` : null);
  const eD = diff(e, eAvg, 1), sD = diff(s, sAvg, 2);
  const parts = [eD ? `Energy ${eD}` : '', sD ? `${eD ? 'stress' : 'Stress'} ${sD}` : ''].filter(Boolean);
  const headline = parts.length ? `${parts.join(' · ')} vs your 90-day average` : (latest ? 'Your latest reading' : 'No reading yet');
  if (latest && (typeof e === 'number' || typeof s === 'number')) {
    const bits = [];
    if (typeof e === 'number') bits.push(`energy ${e}` + (trend?.energy ? ` (your 90-day range ${trend.energy.lowest}–${trend.energy.highest}, average ${trend.energy.average})` : ''));
    if (typeof s === 'number') bits.push(`stress ${s}` + (trend?.stress ? ` (range ${trend.stress.lowest}–${trend.stress.highest}, average ${trend.stress.average})` : ''));
    lines.push(`Latest reading ${latest.scanned_at}: ${bits.join(', ')}.`);
  }
  const flags = trend?.flagged || [];
  if (trend) {
    if (!flags.length) lines.push('Nothing was flagged by your practitioner\'s scan platform in the last 90 days.');
    else {
      const high = flags.filter((f) => f.severity === 'high');
      const names = flags.slice(0, 3).map((f) => f.name).join(', ');
      lines.push(`${flags.length} area${flags.length === 1 ? ' was' : 's were'} flagged by your practitioner's scan platform in the last 90 days${high.length ? `, ${high.length} of them labelled high` : ''}: ${names}${flags.length > 3 ? ' and more' : ''}.`);
    }
  }
  const ch = (latest?.chakras || []).filter((c) => typeof c.value === 'number');
  if (ch.length >= 2) {
    const sorted = [...ch].sort((a, b) => b.value - a.value);
    lines.push(`Highest centre value: ${sorted[0].name}. Lowest: ${sorted[sorted.length - 1].name}.`);
  }
  const c0 = comparisons[0];
  if (c0 && (typeof c0.stress_change === 'number' || typeof c0.energy_change === 'number')) {
    const sgn = (v, d) => (typeof v === 'number' ? `${v > 0 ? '+' : ''}${v.toFixed(d)}` : '—');
    lines.push(`Across your last pair of sessions (${c0.from} → ${c0.to}): stress ${sgn(c0.stress_change, 2)}, energy ${sgn(c0.energy_change, 1)}.`);
  }
  lines.push(`These are reflective measurements, not a diagnosis — ${practitionerName} is the person to ask about them.`);
  return { headline, lines };
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
