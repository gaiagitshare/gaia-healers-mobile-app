/**
 * Approved partner recommendations -> the member's Personal Path (6 Oct 2026).
 *
 * Source: the Gaia Practitioners MEMBER tool `get_my_recommendations`
 * (staging, measured 6 Oct): recommendations the practitioner APPROVED, each
 * with up to 5 ranked items {rank, type product|service, id, title, summary
 * (client-safe), action {label, url}}. No scan values; no input arguments --
 * the one-member token scopes it to the member.
 *
 * WHAT THIS IS ALLOWED TO DO: retrieve and DISPLAY. Nothing here feeds an AI
 * provider; the Personal Path gives Gaia's model only a generic line for these
 * items (personal-path.js assistView). There is no flag that changes that.
 *
 * GATE (GAIA_PARTNER_RECS, fail-closed):
 *   off (default) ............ never called
 *   staging .................. only when GAIA_DEPLOYMENT=staging AND the
 *                              partner environment is staging (QA servers).
 *                              The production server never sets
 *                              GAIA_DEPLOYMENT=staging, so production members
 *                              can never see staging partner data.
 *   production ............... only when the partner environment is
 *                              production AND GAIA_PARTNER_BAA_CONFIRMED is
 *                              set ("YYYY-MM-DD: reference") -- the BAA gate.
 * Anything else is off.
 *
 * KEPT per item: recommendation id, approval status/date, created date,
 * practitioner id and name, rank, type, item id, title, client-safe summary,
 * and a canonical link rebuilt from validated parts. EVERYTHING ELSE the
 * partner sends (reasoning, relevance, body systems, scripts, video, flags,
 * any scan data, unknown fields) is discarded before it is stored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mcpCall, unwrapMcp } from './practitioners-oauth.js';
import { memberToken, memberBackend, linkFor } from './member-link.js';

export const PARTNER_HOSTS = Object.freeze({
  staging: ['staging.gaiapractitioners.com'],
  production: ['gaiapractitioners.com', 'www.gaiapractitioners.com'],
});
const TTL_MS = 10 * 60 * 1000;            // re-read at most every 10 minutes per member
const STALE_MAX_MS = 24 * 60 * 60 * 1000; // after an outage, last good list is kept up to a day
const cacheFile = () => process.env.GAIA_PARTNER_RECS_CACHE || path.join(process.cwd(), 'data', 'partner-recs-cache.json');

/** Is retrieval/display allowed here, and against which partner environment? */
export function partnerRecsGate(env = process.env, partnerEnvironment = '') {
  const mode = String(env.GAIA_PARTNER_RECS || 'off').trim().toLowerCase();
  if (mode === 'staging') {
    if (env.GAIA_DEPLOYMENT !== 'staging') return { enabled: false, mode, reason: 'staging_source_outside_staging_deployment' };
    if (partnerEnvironment !== 'staging') return { enabled: false, mode, reason: 'partner_not_staging' };
    return { enabled: true, mode, hosts: PARTNER_HOSTS.staging };
  }
  if (mode === 'production') {
    if (partnerEnvironment !== 'production') return { enabled: false, mode, reason: 'partner_not_production' };
    if (!/^\d{4}-\d{2}-\d{2}:\s*\S.{2,}$/.test(String(env.GAIA_PARTNER_BAA_CONFIRMED || ''))) return { enabled: false, mode, reason: 'baa_not_confirmed' };
    return { enabled: true, mode, hosts: PARTNER_HOSTS.production };
  }
  return { enabled: false, mode: 'off', reason: 'off' };
}

// ── shaping ─────────────────────────────────────────────────────────────────

const ID = /^[A-Za-z0-9_-]{1,40}$/;
/** Plain, bounded text; markup stripped; null when it carries a link or nothing. */
function plain(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /https?:|www\.|javascript:|data:/i.test(s)) return null;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/**
 * The partner's link, checked and REBUILT: https, an allowed host for this
 * environment, path exactly /shop, only the parameter that names THIS item
 * (product=<id> [&buy=1] or service=<id>). Anything else -- another host,
 * scheme, credentials, port, path, extra parameters (a redirect), or an id
 * that is not this item's -- and the item has no action.
 */
export function safeAction(item, hosts) {
  let u; try { u = new URL(String(item?.action?.url || '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !hosts.includes(u.hostname) || u.pathname !== '/shop' || u.hash) return null;
  const keys = [...u.searchParams.keys()];
  const id = String(item.id);
  if (item.type === 'product') {
    if (!keys.every((k) => k === 'product' || k === 'buy') || u.searchParams.getAll('product').length !== 1 || u.searchParams.get('product') !== id) return null;
    const buy = u.searchParams.has('buy');
    if (buy && !['1', 'true'].includes(u.searchParams.get('buy'))) return null;
    return { label: buy ? 'Buy' : 'View', url: `https://${u.hostname}/shop?product=${encodeURIComponent(id)}${buy ? '&buy=1' : ''}` };
  }
  if (item.type === 'service') {
    if (keys.length !== 1 || keys[0] !== 'service' || u.searchParams.get('service') !== id) return null;
    return { label: 'Book', url: `https://${u.hostname}/shop?service=${encodeURIComponent(id)}` };
  }
  return null;
}

/** The partner's answer -> the fields we keep (whitelist). Returns { items, dropped }. */
export function shapeApproved(data, hosts) {
  const items = [], seen = new Set(); let dropped = 0;
  for (const rec of Array.isArray(data?.recommendations) ? data.recommendations : []) {
    if (String(rec?.approval_status || '').toLowerCase() !== 'approved') { dropped += (rec?.items || []).length || 1; continue; }   // defence in depth
    const recId = String(rec.recommendation_id ?? '');
    if (!ID.test(recId)) { dropped += 1; continue; }
    for (const it of Array.isArray(rec.items) ? rec.items : []) {
      const type = it?.type === 'product' || it?.type === 'service' ? it.type : null;
      const id = String(it?.id ?? '');
      const title = plain(it?.title, 120);
      if (!type || !ID.test(id) || !title) { dropped += 1; continue; }
      const action = safeAction({ ...it, type, id }, hosts);
      if (!action) { dropped += 1; continue; }   // no safe way to act on it: not shown
      const key = `PR:${recId}:${type}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        key, recommendation_id: recId, type, id, title,
        summary: plain(it?.summary, 300),
        rank: Number.isFinite(Number(it?.rank)) ? Number(it.rank) : 99,
        action,
        practitioner_id: rec.practitioner?.id != null ? String(rec.practitioner.id) : '',
        practitioner_name: plain(rec.practitioner?.name, 80) || '',
        approved_at: typeof rec.approved_at === 'string' ? rec.approved_at.slice(0, 25) : null,
        created_at: typeof rec.created_at === 'string' ? rec.created_at.slice(0, 25) : null,
      });
    }
  }
  return { items, dropped };
}

// ── lifecycle cache ──────────────────────────────────────────────────────────

function readCache() { try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return { members: {} }; } }
function writeCache(c) {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    const tmp = cacheFile() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 }); fs.renameSync(tmp, cacheFile());
  } catch { /* the cache is an optimisation */ }
}

/**
 * The member's approved items. Fresh within 10 minutes: from the cache. A
 * successful read REPLACES the list (so a revoked or no-longer-approved item
 * disappears, a changed summary updates, duplicates collapse). A failed read
 * never erases: the last good list is kept for up to a day, then nothing.
 * Never throws; the rest of the Path never depends on it.
 */
export async function approvedForMember(cfg0, memberId, { env = process.env, fetchImpl = fetch, now = Date.now(), linkFile, log = () => {} } = {}) {
  const gate = partnerRecsGate(env, cfg0?.environment);
  if (!gate.enabled) return { items: [], state: 'disabled', reason: gate.reason };
  const id = String(memberId || '').trim();
  if (!id || !(linkFile ? linkFor(id, linkFile) : linkFor(id))) return { items: [], state: 'not_linked' };
  const cache = readCache(); cache.members = cache.members || {};
  const prev = cache.members[id];
  if (prev && prev.ok_at && now - prev.ok_at < TTL_MS) return { items: prev.items || [], state: 'fresh' };
  try {
    const cfg = { ...cfg0, mcpUrl: `${memberBackend(cfg0, env)}/api/member-mcp` };
    const token = await memberToken(cfg0, id, { env, fetchImpl, now });
    const data = unwrapMcp(await mcpCall(cfg, token, 'get_my_recommendations', {}, fetchImpl));
    const { items, dropped } = shapeApproved(data, gate.hosts);
    cache.members[id] = { ok_at: now, items };
    writeCache(cache);
    log('approved recommendations read', { items: items.length, dropped });
    return { items, state: 'ok' };
  } catch (e) {
    log('approved recommendations unavailable', { code: e?.code || 'error' });
    if (prev && prev.ok_at && now - prev.ok_at < STALE_MAX_MS) return { items: prev.items || [], state: 'stale' };
    return { items: [], state: 'unavailable' };
  }
}
