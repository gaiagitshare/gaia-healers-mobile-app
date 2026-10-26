/**
 * Resolve the five gaia_membership_* custom-field ids BY KEY from the GHL
 * location (GET /locations/{id}/customFields), the way the proxy already does,
 * instead of hand-entered ids.
 *
 *   - missing fields are REPORTED, never created (a GHL admin creates them);
 *   - a key defined twice is reported as a duplicate and left unmapped, so a
 *     write can never land in the wrong field;
 *   - cached with a TTL; a failed refresh keeps serving the last good map
 *     (stale: true) rather than dropping every field write.
 */
import { FIELD_SPECS } from './desired-state.js';

export const DEFAULT_FIELD_TTL_MS = 60 * 60 * 1000;

const keyOf = (f) => String(f?.fieldKey || f?.key || '').trim().toLowerCase().replace(/^contact\./, '');

/** Pure: definitions -> { fieldIds, missing, duplicates } */
export function mapFieldIds(definitions, keys = Object.keys(FIELD_SPECS)) {
  const byKey = new Map();
  for (const f of definitions || []) {
    const k = keyOf(f);
    if (!keys.includes(k) || !f?.id) continue;
    byKey.set(k, [...(byKey.get(k) || []), String(f.id)]);
  }
  const fieldIds = {};
  const missing = [];
  const duplicates = [];
  for (const k of keys) {
    const ids = byKey.get(k) || [];
    if (ids.length === 0) missing.push(k);
    else if (ids.length > 1) duplicates.push(k);
    else fieldIds[k] = ids[0];
  }
  return { fieldIds, missing, duplicates };
}

/**
 * createFieldIdResolver({ ghl, ttlMs, clock, onReport })
 *   ghl: the contacts client (getLocationCustomFields)
 *   onReport({ missing, duplicates }) is called whenever a fetch finds gaps
 * -> { resolve() -> { fieldIds, missing, duplicates, fetchedAt, stale } , invalidate() }
 */
export function createFieldIdResolver({ ghl, ttlMs = DEFAULT_FIELD_TTL_MS, clock = () => Date.now(), onReport = () => {} } = {}) {
  let cache = null;
  return {
    async resolve() {
      const t = clock();
      if (cache && t - cache.fetchedAt < ttlMs) return { ...cache, stale: false };
      try {
        const m = mapFieldIds(await ghl.getLocationCustomFields());
        cache = { ...m, fetchedAt: t };
        if (m.missing.length || m.duplicates.length) onReport({ missing: m.missing, duplicates: m.duplicates });
        return { ...cache, stale: false };
      } catch (e) {
        if (cache && e?.code) return { ...cache, stale: true };
        throw e;
      }
    },
    invalidate() { cache = null; },
  };
}
