/**
 * Personal Path storage (V1). Three small JSON files, written atomically:
 *
 *   path-recommendations.json  what practitioners confirmed for a member
 *                              (who, for whom, which resource, the member-safe
 *                              reason and optional note, catalogue version,
 *                              revoked). Never a reading value or a trigger.
 *   path-state.json            per member, per item key: opened / completed /
 *                              dismissed, and whether the member said so
 *                              ('user') or the server knows it ('backend').
 *   path-events.jsonl          analytics, the onboarding-funnel pattern: a
 *                              hashed contact, a whitelisted event and public
 *                              ids. Never values, signals, notes or reasons.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.join(process.cwd(), 'data');
const recsFile = () => process.env.GAIA_PATH_RECS_FILE || path.join(DATA, 'path-recommendations.json');
const stateFile = () => process.env.GAIA_PATH_STATE_FILE || path.join(DATA, 'path-state.json');
const eventsFile = () => process.env.GAIA_PATH_EVENTS_FILE || path.join(DATA, 'path-events.jsonl');

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── text a practitioner writes for a member ─────────────────────────────────

export const REASON_MAX = 240;
export const NOTE_MAX = 280;
export const DEFAULT_REASON = 'Your practitioner recommended this as part of your current wellness plan.';
/**
 * Plain text only: no markup, no links, no control characters, bounded. A
 * rejected value is an error the practitioner sees, never silently altered.
 */
export function cleanText(value, max) {
  const s = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!s) return { ok: true, text: '' };
  if (s.length > max) return { ok: false, error: 'too_long' };
  if (/[<>]|https?:|www\.|javascript:|data:|\]\(/i.test(s)) return { ok: false, error: 'no_links_or_markup' };
  return { ok: true, text: s };
}

// ── practitioner recommendations ───────────────────────────────────────────

export function listRecommendations() { return readJson(recsFile(), { recommendations: [] }).recommendations || []; }

/** Confirmed by a human practitioner: the only way an item becomes "Recommended by your practitioner". */
export function createRecommendation({ practitionerContactId, practitionerId, practitionerName, memberId, customerId, resource, memberSafeReason, note, catalogueVersion, now = new Date() }) {
  const store = readJson(recsFile(), { recommendations: [] });
  const rec = {
    id: 'rec_' + crypto.randomBytes(9).toString('base64url'),
    source_type: 'practitioner_manual', review_state: 'approved',
    practitioner_contact_id: String(practitionerContactId), practitioner_id: String(practitionerId), practitioner_name: String(practitionerName || '').slice(0, 80),
    member_id: String(memberId), customer_id: String(customerId),
    resource: { kind: resource.kind, id: String(resource.id ?? ''), title: String(resource.title || '').slice(0, 120), ...(resource.catalogue_id ? { catalogue_id: resource.catalogue_id } : {}), ...(resource.target ? { target: resource.target } : {}) },
    member_safe_reason: memberSafeReason || DEFAULT_REASON, note: note || '',
    catalogue_version: catalogueVersion, created_at: now.toISOString(), revoked_at: null,
  };
  store.recommendations = [...(store.recommendations || []), rec];
  writeJson(recsFile(), store);
  return rec;
}

/** Only the practitioner who made it (same partner practitioner id) can revoke it. */
export function revokeRecommendation(id, practitionerId, now = new Date()) {
  const store = readJson(recsFile(), { recommendations: [] });
  const rec = (store.recommendations || []).find((r) => r.id === String(id));
  if (!rec) return { ok: false, error: 'not_found' };
  if (rec.practitioner_id !== String(practitionerId)) return { ok: false, error: 'forbidden' };
  if (rec.revoked_at) return { ok: true, rec };
  rec.revoked_at = now.toISOString(); rec.review_state = 'revoked';
  writeJson(recsFile(), store);
  return { ok: true, rec };
}

export const activeForMember = (memberId) => listRecommendations().filter((r) => r.member_id === String(memberId) && !r.revoked_at && r.review_state === 'approved');
export const forPractitionerClient = (practitionerId, customerId) => listRecommendations().filter((r) => r.practitioner_id === String(practitionerId) && r.customer_id === String(customerId));

// ── member item state ──────────────────────────────────────────────────────

export function stateFor(memberId) { return (readJson(stateFile(), { members: {} }).members || {})[String(memberId)] || {}; }
/**
 * Record what happened to an item. `by` is 'user' (they said so) or 'backend'
 * (the server confirmed it). A user-side "opened" never overwrites a
 * completion, and nothing the page reports can mark a backend-completed item
 * (a course, a reading, a scan) as complete -- those come from the server.
 */
export function setItemState(memberId, key, next, by = 'user', now = new Date()) {
  if (!['opened', 'completed', 'dismissed'].includes(next)) return null;
  const store = readJson(stateFile(), { members: {} });
  store.members = store.members || {};
  const m = store.members[String(memberId)] || {};
  const cur = m[key];
  if (cur && (cur.state === 'completed' || cur.state === 'dismissed') && next === 'opened') return cur;
  m[key] = { state: next, by, at: now.toISOString() };
  store.members[String(memberId)] = m;
  writeJson(stateFile(), store);
  return m[key];
}

// ── analytics ──────────────────────────────────────────────────────────────

export const PATH_EVENTS = Object.freeze(['path_viewed', 'recommendation_opened', 'recommendation_completed', 'recommendation_dismissed',
  'free_alternative_selected', 'membership_required_shown', 'membership_opened', 'scan_rebook_opened']);
const FIELDS = { item_id: /^(P-[A-Z]+|R|rec_[A-Za-z0-9_-]{6,20}|cat:R-[A-Z0-9-]+)$/, stage: /^(start_now|coming_up|keep_going|recheck)$/, surface: /^(you|home|avatar|assist)$/,
  items: /^\d{1,2}$/, level: /^(free|silver|gold|diamond)$/, via: /^(user|backend)$/, route: /^(practitioner|directory|booking)$/, source: /^(platform_rule|practitioner_manual)$/ };
export function hashContact(id) { return crypto.createHash('sha256').update('gaia-path:' + String(id)).digest('hex').slice(0, 16); }

/** One event: whitelisted name and fields only; anything else is dropped, never stored. */
export function recordEvent(contactId, event, fields = {}, now = new Date()) {
  if (!PATH_EVENTS.includes(event) || !contactId) return null;
  const row = { t: now.toISOString(), who: hashContact(contactId), event };
  for (const [k, re] of Object.entries(FIELDS)) {
    const v = fields[k]; if (v === undefined || v === null) continue;
    const s = String(k === 'item_id' ? String(v).split(':')[0] === 'R' ? 'R' : String(v).split(':')[0] : v);
    if (re.test(s)) row[k] = s;
  }
  try { fs.mkdirSync(path.dirname(eventsFile()), { recursive: true }); fs.appendFileSync(eventsFile(), JSON.stringify(row) + '\n', { mode: 0o600 }); } catch { /* analytics never breaks the path */ }
  return row;
}
