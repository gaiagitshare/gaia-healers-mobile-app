/**
 * Benefit -> GHL offer / community mapping, expected grants, confirmations.
 *
 * Gaia only sets tags. A GHL workflow triggered by "tag added <viaTag>" grants
 * the offer or adds the contact to the community group; "tag removed" revokes.
 * After Gaia changes a mapped tag it records an EXPECTED grant or revoke; the
 * existing mirror workflows ("Gaia App - Course Access Granted/Removed
 * Mirror", community mirrors) post back to the proxy, which calls
 * recordGrantConfirmation(). findUnconfirmedGrants() alerts on any expectation
 * GHL never confirmed. The confirmation is evidence that GHL acted, never a
 * source of entitlement truth.
 */
import { fail } from '../../errors.js';
import { DEFAULT_TAG_PREFIX, checkPrefix } from './desired-state.js';

/** Bump when the mapping below changes meaning; stored on every expectation. */
export const BENEFIT_MAP_VERSION = 1;

/**
 * The real map is EMPTY until a GHL admin creates the offers / groups and the
 * tag-triggered workflows; their ids are then listed here (key -> target).
 *   { 'courses.core': { type: 'offer', ghlId: '<offer id>', viaTag: 'gaia-m:benefit:courses.core' } }
 */
export const BENEFIT_GRANTS = Object.freeze({});

const GHL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Validate and freeze a benefit map. viaTag must be a Gaia-owned tag. */
export function validateBenefitMap(map, { prefix = DEFAULT_TAG_PREFIX } = {}) {
  checkPrefix(prefix);
  if (!map || typeof map !== 'object') fail('INVALID_INPUT', 'benefit map must be an object');
  const out = {};
  const seenTargets = new Set();
  for (const [key, v] of Object.entries(map)) {
    if (!/^[a-z][a-z0-9_.:]{1,79}$/.test(key)) fail('INVALID_INPUT', 'invalid benefit key: ' + key);
    if (!v || !['offer', 'community'].includes(v.type)) fail('INVALID_INPUT', `${key}: type must be offer or community`);
    if (!GHL_ID.test(String(v.ghlId || ''))) fail('INVALID_INPUT', `${key}: invalid ghlId`);
    const viaTag = String(v.viaTag || '').toLowerCase();
    if (!viaTag.startsWith(prefix)) fail('INVALID_INPUT', `${key}: viaTag must start with ${prefix}`);
    const target = `${v.type}:${v.ghlId}:${viaTag}`;
    if (seenTargets.has(target)) fail('INVALID_INPUT', `${key}: duplicate mapping`);
    seenTargets.add(target);
    out[key] = Object.freeze({ type: v.type, ghlId: String(v.ghlId), viaTag });
  }
  return Object.freeze(out);
}

/** Pure: which grants / revokes a tag change should cause. */
export function expectedGrantsFor({ addTags = [], removeTags = [] }, map) {
  const out = [];
  const add = new Set(addTags.map((t) => t.toLowerCase()));
  const rem = new Set(removeTags.map((t) => t.toLowerCase()));
  for (const [key, m] of Object.entries(map)) {
    if (add.has(m.viaTag)) out.push({ entitlementKey: key, ...m, action: 'grant' });
    if (rem.has(m.viaTag)) out.push({ entitlementKey: key, ...m, action: 'revoke' });
  }
  return out;
}

/** Record expectations; a newer one for the same contact + target supersedes the pending one. */
export async function recordExpectedGrants(pool, { personId, contactId, expected, now = new Date(), version = BENEFIT_MAP_VERSION }) {
  for (const g of expected) {
    await pool.query(
      `UPDATE ghl_expected_grants SET status = 'superseded' WHERE contact_id = $1 AND grant_type = $2 AND ghl_id = $3 AND status = 'pending'`,
      [contactId, g.type, g.ghlId]);
    await pool.query(
      `INSERT INTO ghl_expected_grants (person_id, contact_id, entitlement_key, grant_type, ghl_id, via_tag, action, map_version, expected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [personId, contactId, g.entitlementKey, g.type, g.ghlId, g.viaTag, g.action, version, now]);
  }
  return expected.length;
}

/**
 * GHL said it granted (granted=true) or removed (false) access.
 * -> { matched: boolean, id? }  An unmatched confirmation is drift for the reconcile report, not an error.
 */
export async function recordGrantConfirmation(pool, { contactId, type, ghlId, granted, source = 'ghl_mirror', at = new Date() }) {
  if (!contactId || !['offer', 'community'].includes(type) || !ghlId || typeof granted !== 'boolean') fail('INVALID_INPUT', 'contactId, type, ghlId and granted are required');
  const r = await pool.query(
    `UPDATE ghl_expected_grants SET status = 'confirmed', confirmed_at = $5, confirmation_source = $6
      WHERE contact_id = $1 AND grant_type = $2 AND ghl_id = $3 AND action = $4 AND status = 'pending' RETURNING id`,
    [contactId, type, String(ghlId), granted ? 'grant' : 'revoke', at, source]);
  return r.rowCount ? { matched: true, id: r.rows[0].id } : { matched: false };
}

/**
 * Parse a course/community mirror webhook body (same vocabulary as the proxy's
 * classifyEntitlementEvent) into a confirmation, or null if it is not one.
 */
export function confirmationFromMirror(body) {
  const first = (...v) => v.map((x) => (x == null ? '' : String(x).trim())).find(Boolean) || '';
  const raw = first(body?.type, body?.event, body?.eventType, body?.action, body?.customData?.event).toLowerCase().replace(/[\s.-]+/g, '_');
  const contactId = first(body?.contactId, body?.contact_id, body?.contact?.id, body?.data?.contact?.id);
  let type = null; let granted = null;
  if (/(community|group).*(remove|removed|revoke|revoked|delete|deleted)/.test(raw)) { type = 'community'; granted = false; }
  else if (/(community|group).*(grant|granted|add|added|access)/.test(raw)) { type = 'community'; granted = true; }
  else if (/(course|offer).*(remove|removed|revoke|revoked|delete|deleted)/.test(raw)) { type = 'offer'; granted = false; }
  else if (/(course|offer).*(grant|granted|add|added|access|enroll|enrolled)/.test(raw)) { type = 'offer'; granted = true; }
  if (!type || !contactId) return null;
  const ghlId = type === 'offer'
    ? first(body?.offerId, body?.offer_id, body?.offer?.id, body?.courseId, body?.course_id, body?.course?.id)
    : first(body?.groupId, body?.group_id, body?.communityId, body?.community_id, body?.group?.id);
  return ghlId ? { contactId, type, ghlId, granted } : null;
}

/**
 * Expectations still pending after `olderThanMs`. Each one is alerted ONCE
 * (alerted_at), and stays confirmable afterwards.
 *   alert(items) is required and injected (ops channel, log, …).
 */
export async function findUnconfirmedGrants(pool, { olderThanMs, now = new Date(), alert }) {
  if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) fail('INVALID_INPUT', 'olderThanMs must be > 0');
  if (typeof alert !== 'function') fail('INVALID_INPUT', 'alert() is required');
  const rows = (await pool.query(
    `SELECT id, person_id, contact_id, entitlement_key, grant_type, ghl_id, action, expected_at, alerted_at FROM ghl_expected_grants
      WHERE status = 'pending' AND expected_at < $1 ORDER BY expected_at`, [new Date(now.getTime() - olderThanMs)])).rows;
  const fresh = rows.filter((r) => !r.alerted_at);
  if (fresh.length) {
    await alert(fresh.map((r) => ({ id: r.id, personId: r.person_id, contactId: r.contact_id, entitlementKey: r.entitlement_key, type: r.grant_type, ghlId: r.ghl_id, action: r.action, expectedAt: r.expected_at })));
    await pool.query('UPDATE ghl_expected_grants SET alerted_at = $2 WHERE id = ANY($1)', [fresh.map((r) => r.id), now]);
  }
  return { unconfirmed: rows.length, alerted: fresh.length, items: rows };
}
