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
export const CODE_TTL_MS = 15 * 60 * 1000;
export const CODE_LENGTH = 8;
// No 0/O/1/I/L: a code is read aloud and typed by somebody else.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const AUDIT_MAX = 5000;

export function memberReadingsEnabled(env = process.env) {
  return env.GAIA_MEMBER_READINGS_ENABLED === 'true';
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

// ── member-only reads on their MCP ────────────────────────────────────────
// Gaia's own server credential (client-credentials, scope members.read) --
// never a practitioner's token and never anything the browser sees.
let _serverToken = null;
export function _resetServerTokenForTest() { _serverToken = null; }
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
  const l = scan.labeled || scan;
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

/** Everything the member's "My readings" screen shows, from their MCP, for one confirmed link. */
export async function memberReadings(cfg, memberId, { env = process.env, fetchImpl = fetch, file = LINK_FILE } = {}) {
  const link = linkFor(memberId, file);
  if (!link) throw Object.assign(new Error('member_not_linked'), { code: 'member_not_linked', status: 404 });
  let token;
  try { token = await serverAccessToken(cfg, env, fetchImpl); } catch (e) { throw partnerError(e); }
  const call = async (tool, args) => { try { return unwrapMcp(await mcpCall(cfg, token, tool, { gaia_member_id: memberId, ...args }, fetchImpl)); } catch (e) { throw partnerError(e); } };
  const customer = await call('get_member_customer', {});
  const [scan, trend, files] = await Promise.all([
    call('get_member_scan', { which: 'latest' }).catch((e) => (e.code === 'member_not_linked' ? Promise.reject(e) : null)),
    call('get_member_scan_trend', { window: '90d' }).catch(() => null),
    call('get_member_files', {}).catch(() => null),
  ]);
  const band = (b) => (b ? { lowest: b.min ?? null, highest: b.max ?? null, average: b.avg ?? null, latest: b.latest ?? null } : null);
  return {
    practitioner: { id: String(customer?.practitioner?.id ?? link.practitioner_id), name: customer?.practitioner?.name || link.practitioner_name || '' },
    linked_at: link.linked_at,
    scans_on_file: customer?.scans_on_file ?? trend?.scanCount ?? null,
    latest: scan?.scan ? memberScanView(scan.scan) : (scan?.scanned_at || scan?.labeled ? memberScanView(scan) : null),
    trend: trend ? { energy: band(trend.summary?.energy), stress: band(trend.summary?.stress), flagged: (trend.flags || []).slice(0, 6).map((t) => ({ name: t.name, direction: t.direction, reason: t.flagReason || '' })) } : null,
    files: (files?.files || []).filter((f) => f?.shareable !== false).slice(0, 20).map((f) => ({ id: String(f.id ?? ''), name: f.name || f.filename || 'document', uploaded_at: String(f.uploaded_at || f.created_at || '').slice(0, 10), url: f.url || null })),
  };
}

/** Best effort: tell their server the member stopped sharing. Local revoke never waits on it. */
export async function notifyPartnerUnlink(cfg, customerId, { env = process.env, fetchImpl = fetch } = {}) {
  try { const token = await serverAccessToken(cfg, env, fetchImpl); await mcpCall(cfg, token, 'unlink_customer_member', { customer_id: customerId }, fetchImpl); return true; }
  catch (e) { console.warn('[Gaia Practitioners] member unlink not delivered to partner', { code: e.code || null }); return false; }
}
