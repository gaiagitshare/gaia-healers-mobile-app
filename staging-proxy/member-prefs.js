/**
 * MEMBER PREFERENCES — tiny, server-kept, per member.
 *
 * The app keeps nothing in the browser (a member's phone and laptop should
 * agree), so the few things a member can fold away on their screens live
 * here: a flat map of allowed keys to booleans, keyed by contact id. Nothing
 * else is accepted -- no free text, no values a page could smuggle in.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PREFS_FILE = process.env.GAIA_MEMBER_PREFS_FILE || '/root/gaia-staging-proxy/data/member-prefs.json';
/** The only keys a member can set, and what they mean. (guides_to_assist was removed on 6 Oct 2026 with the guides route; stored values are ignored.) */
export const PREF_KEYS = Object.freeze({
  next_level_collapsed: 'the Next level card on You is folded to one line',
  readings_explainer_collapsed: 'the "What these mean" explainer on My readings is folded',
  practitioner_card_dismissed: 'the "Become a practitioner" card on You was dismissed',
  avatar_idle_off: "Gaia's idle animations are switched off",
  avatar_hello_chime: 'a soft chime plays with the hello (off unless chosen)',
});

function load(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d === 'object' ? d : {}; } catch { return {}; }
}
function save(store, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function getPrefs(memberId, { file = PREFS_FILE } = {}) {
  const id = String(memberId || '').trim();
  const rec = id ? load(file)[id] : null;
  const out = {};
  for (const k of Object.keys(PREF_KEYS)) out[k] = Boolean(rec?.[k]);
  return out;
}

/** Merge the allowed keys from `patch` (booleans only); returns the full set. Unknown keys are ignored, never stored. */
export function setPrefs(memberId, patch, { file = PREFS_FILE, now = Date.now() } = {}) {
  const id = String(memberId || '').trim();
  if (!id) return null;
  const store = load(file);
  const rec = store[id] && typeof store[id] === 'object' ? store[id] : {};
  let changed = false;
  for (const k of Object.keys(PREF_KEYS)) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k) && typeof patch[k] === 'boolean' && rec[k] !== patch[k]) { rec[k] = patch[k]; changed = true; }
  }
  if (changed) { rec.updated_at = new Date(now).toISOString(); store[id] = rec; save(store, file); }
  return getPrefs(id, { file });
}
