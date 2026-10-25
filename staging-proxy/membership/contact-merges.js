/**
 * Contact merges — access follows the person when GHL merges two contacts.
 *
 * The ledger is keyed by GHL contact id. When GHL merges two contacts, one id
 * stops existing and everything it held stays behind on it. Memberships repair
 * themselves (the subscription moves with the merge and the sweep follows it),
 * but courses are granted once, by a webhook, and nothing ever re-reads them.
 * On 22 Oct 2026 a practitioner's two contacts were merged and 15 of her 16
 * courses stayed on the id GHL had just deleted: she signed in and saw one.
 *
 * This is the operation, not a repair of one person:
 *   1. SCAN (scheduled, paced, read-only against GHL): for ledger contacts
 *      holding live access, ask GHL whether the contact still exists. A contact
 *      that answers "not found" and whose email now belongs to exactly ONE live
 *      contact is a merge, and that contact is the survivor. Anything less
 *      certain is recorded as gone with no survivor, never guessed.
 *   2. SUGGEST: each merge is listed for an operator with what would move.
 *   3. APPLY (one tap): unlocked courses and communities are copied to the
 *      survivor, the old rows are marked moved (so they read revoked, with a
 *      pointer), and the move is audited on both records. Idempotent.
 *
 * Names are never compared. The evidence is GHL's own: the old id is gone and
 * one live contact carries its email.
 */

import fs from 'node:fs';
import path from 'node:path';

import { audit } from './audit-log.js';

const clean = (value, max = 200) => String(value ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);
const norm = (value) => String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const RECHECK_DAYS = 7;
export const MAX_CHECKS_PER_RUN = 150;

export function emptyMergeState() {
  return { version: 1, checked: {}, suggestions: [], updatedAt: null };
}

export function loadMergeState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...emptyMergeState(), ...parsed,
      checked: parsed && typeof parsed.checked === 'object' && parsed.checked ? parsed.checked : {},
      suggestions: Array.isArray(parsed && parsed.suggestions) ? parsed.suggestions : [],
    };
  } catch (_) {
    return emptyMergeState();
  }
}

export function saveMergeState(file, state) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/** What a record holds that a merge would have to carry: unlocked courses and communities. */
export function liveAccess(record) {
  const courses = (Array.isArray(record && record.courses) ? record.courses : [])
    .filter((c) => c && (!c.state || c.state === 'unlocked'));
  const communities = (Array.isArray(record && record.communities) ? record.communities : [])
    .filter((c) => c && (!c.state || c.state === 'unlocked' || c.state === 'member' || c.state === 'active'));
  return { courses, communities };
}

/** Ledger contacts worth checking: live access, an email on file, not checked recently, not already merged. */
export function dueForCheck(store, emailByContact, state, { now = new Date(), recheckDays = RECHECK_DAYS } = {}) {
  const cutoff = now.getTime() - recheckDays * 86400000;
  const out = [];
  for (const [cid, record] of Object.entries((store && store.contacts) || {})) {
    if (!record || record.mergedInto) continue;
    const access = liveAccess(record);
    if (!access.courses.length && !access.communities.length) continue;
    if (!emailByContact.get(cid)) continue;
    const seen = state.checked[cid];
    if (seen && Date.parse(seen.at || '') > cutoff) continue;
    out.push(cid);
  }
  // Least recently checked first, so a capped run always makes progress.
  out.sort((a, b) => (Date.parse((state.checked[a] || {}).at || '') || 0) - (Date.parse((state.checked[b] || {}).at || '') || 0));
  return out;
}

/**
 * One scan pass. `ghl.getContact(id)` resolves to { status, contact };
 * `ghl.findByEmail(email)` resolves to an array of live contacts. Both are
 * read-only and supplied by the caller, so tests run with no network.
 */
export async function scanForMerges(store, emailByContact, state, ghl,
  { now = new Date(), maxChecks = MAX_CHECKS_PER_RUN, pauseMs = 150, log = () => {} } = {}) {
  const due = dueForCheck(store, emailByContact, state, { now }).slice(0, maxChecks);
  const stats = { checked: 0, alive: 0, merged: 0, gone_no_survivor: 0, errors: 0 };
  for (const cid of due) {
    if (stats.checked && pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    stats.checked++;
    let res;
    try { res = await ghl.getContact(cid); } catch (err) { stats.errors++; log({ phase: 'error', contactId: cid, error: String(err && err.message).slice(0, 120) }); continue; }
    if (res && res.status === 200) {
      state.checked[cid] = { at: now.toISOString(), status: 'alive' };
      stats.alive++;
      continue;
    }
    if (!res || (res.status !== 400 && res.status !== 404)) {
      stats.errors++;      // an outage or a rate limit is not evidence of anything
      continue;
    }
    const email = emailByContact.get(cid);
    let live = [];
    try { live = (await ghl.findByEmail(email)) || []; } catch (_) { stats.errors++; continue; }
    const others = live.filter((c) => c && c.id && c.id !== cid);
    if (others.length === 1) {
      const survivor = others[0];
      upsertSuggestion(state, store, cid, survivor, now);
      state.checked[cid] = { at: now.toISOString(), status: 'merged', survivor: survivor.id };
      stats.merged++;
    } else {
      state.checked[cid] = { at: now.toISOString(), status: 'gone', candidates: others.length };
      stats.gone_no_survivor++;
    }
  }
  return stats;
}

function upsertSuggestion(state, store, oldId, survivor, now) {
  const record = store.contacts[oldId] || {};
  const access = liveAccess(record);
  const existing = state.suggestions.find((s) => s.old === oldId && s.state === 'pending');
  const row = {
    old: oldId,
    survivor: clean(survivor.id, 120),
    survivorName: clean([survivor.firstName, survivor.lastName].filter(Boolean).join(' ') || survivor.name || '', 120),
    survivorEmail: clean(survivor.email, 200),
    courses: access.courses.map((c) => clean(c.name || c.id, 120)),
    communities: access.communities.map((c) => clean(c.name || c.id, 120)),
    evidence: 'GHL no longer has the old contact; exactly one live contact carries its email',
    detectedAt: (existing && existing.detectedAt) || now.toISOString(),
    state: 'pending',
  };
  if (existing) Object.assign(existing, row);
  else state.suggestions.push(row);
}

export function pendingSuggestions(state, store) {
  return (state.suggestions || []).filter((s) => s.state === 'pending').map((s) => {
    const target = (store.contacts || {})[s.survivor] || null;
    const have = new Set(liveAccess(target).courses.flatMap((c) => [norm(c.id), norm(c.name)]).filter(Boolean));
    return { ...s, alreadyOnSurvivor: s.courses.filter((n) => have.has(norm(n))).length };
  });
}

/**
 * Move live access from a merged-away contact to its survivor.
 *
 * Copies unlocked course and community rows the survivor does not already hold
 * (with the webhook ordering stamps, so a later replay is still judged
 * correctly), marks the old rows `moved`, points the old record at the
 * survivor, and audits both sides. Running it twice moves nothing twice.
 */
export function applyContactMerge(store, oldId, survivorId, { actor = 'admin', now = new Date(), note = '' } = {}) {
  const from = clean(oldId, 120);
  const to = clean(survivorId, 120);
  if (!from || !to || from === to) return { ok: false, error: 'invalid_contacts' };
  const old = store.contacts && store.contacts[from];
  if (!old) return { ok: false, error: 'unknown_old_contact' };
  if (old.mergedInto && old.mergedInto !== to) return { ok: false, error: 'already_merged_elsewhere' };
  const at = now.toISOString();
  const target = store.contacts[to] || (store.contacts[to] = {
    contactId: to, tags: [], tier: null, courses: [], communities: [], subscriptions: [], entitlements: [],
    updatedAt: at,
  });
  target.courses = Array.isArray(target.courses) ? target.courses : [];
  target.communities = Array.isArray(target.communities) ? target.communities : [];
  const moved = { courses: [], communities: [] };

  for (const kind of ['courses', 'communities']) {
    const have = new Set(target[kind].filter((c) => c && (!c.state || c.state === 'unlocked' || c.state === 'member' || c.state === 'active'))
      .flatMap((c) => [norm(c.id), norm(c.name)]).filter(Boolean));
    for (const row of liveAccess(old)[kind]) {
      const keys = [norm(row.id), norm(row.name)].filter(Boolean);
      if (!keys.some((k) => have.has(k))) {
        // A locked or moved row for the same course on the survivor is replaced, not duplicated.
        target[kind] = target[kind].filter((c) => !c || ![norm(c.id), norm(c.name)].some((k) => k && keys.includes(k)));
        target[kind].push({ ...row, matchedBy: 'contact_merge', mergedFrom: from, updatedAt: at });
        keys.forEach((k) => have.add(k));
        moved[kind].push(row.name || row.id);
      }
      row.state = 'moved';
      row.movedTo = to;
      row.updatedAt = at;
    }
  }
  // The entitlement rows are what access is actually read from (the player, My
  // Access, the resolver). Active rows travel; the old ones are revoked with a
  // pointer, never deleted, so "where did this go" stays answerable.
  const identity = (e) => `${e && e.type}::${e && e.key}`;
  target.entitlements = Array.isArray(target.entitlements) ? target.entitlements : [];
  const held = new Map(target.entitlements.map((e) => [identity(e), e]));
  // The same course can be keyed differently on two contacts (an LMS export id
  // on one, the offer title on the other), so a course the survivor already
  // holds by NAME counts as held.
  const heldNames = new Map();
  for (const e of target.entitlements) {
    for (const n of [norm(e && e.key), norm(e && e.value && e.value.name)]) if (n) heldNames.set(`${e.type}::${n}`, e);
  }
  let entMoved = 0;
  for (const e of (Array.isArray(old.entitlements) ? old.entitlements : [])) {
    if (!e || e.status !== 'active') continue;
    if (e.type !== 'course_access' && e.type !== 'community_access') continue;
    const mine = held.get(identity(e))
      || [norm(e.key), norm(e.value && e.value.name)].filter(Boolean).map((n) => heldNames.get(`${e.type}::${n}`)).find(Boolean);
    if (!mine) {
      const copy = { ...e, observed_at: at, merged_from: from };
      target.entitlements.push(copy);
      held.set(identity(e), copy);
      entMoved++;
    } else if (mine.status !== 'active') {
      Object.assign(mine, { status: 'active', observed_at: at, merged_from: from });
      delete mine.revoked_at;
      entMoved++;
    }
    e.status = 'revoked';
    e.revoked_at = at;
    e.moved_to = to;
    e.observed_at = at;
  }

  // Webhook ordering stamps travel with the grants they order.
  if (old.order && typeof old.order === 'object') {
    target.order = target.order && typeof target.order === 'object' ? target.order : {};
    for (const [k, v] of Object.entries(old.order)) {
      if (k.startsWith('course:') || k.startsWith('community:')) {
        if (!target.order[k]) target.order[k] = v;
      }
    }
  }
  old.mergedInto = to;
  old.mergedAt = old.mergedAt || at;
  old.updatedAt = at;
  target.updatedAt = at;
  const detail = { from, to, courses: moved.courses.length, communities: moved.communities.length, entitlements: entMoved };
  if (moved.courses.length || moved.communities.length || entMoved || !old._mergeAudited) {
    audit(store, { at, actor, action: 'contact.merge_out', contactId: from, source: 'ghl_merge', detail, note });
    audit(store, { at, actor, action: 'contact.merge_in', contactId: to, source: 'ghl_merge', detail, note });
  }
  old._mergeAudited = true;
  return { ok: true, moved, detail };
}

export function markSuggestion(state, oldId, newState, extra = {}) {
  const s = (state.suggestions || []).find((x) => x.old === oldId && x.state === 'pending');
  if (!s) return null;
  Object.assign(s, extra, { state: newState, closedAt: new Date().toISOString() });
  return s;
}
