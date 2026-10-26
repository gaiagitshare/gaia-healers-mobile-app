/**
 * GHL workflow reconciliation: compare Gaia's desired `gaia-m:` tags with the
 * tags actually present on each linked contact and report drift.
 *
 *   missing  desired Gaia tags the contact does not carry
 *   extra    Gaia-prefixed tags the contact carries that Gaia does not want
 *            (held legacy tags are not "extra")
 *   foreign  tags outside the prefix (ahc-*, marketing, …): COUNTED, never
 *            reported as drift and never touched
 *
 * Report-only by default. mode 'apply' re-runs syncPersonToGhl for drifted
 * people (same safe ordering and dead letters); tests run it against fakes only.
 * Only linked contacts are read (no email search), sequentially, under a cap.
 */
import { identitiesOf } from '../../identity.js';
import { fail } from '../../errors.js';
import { DEFAULT_TAG_PREFIX } from './desired-state.js';
import { desiredForPerson, syncPersonToGhl, MAX_BATCH } from './sync.js';

const norm = (t) => String(t || '').trim().toLowerCase();

/** Pure drift for one contact. */
export function tagDrift(contactTags, desired, { prefix = DEFAULT_TAG_PREFIX } = {}) {
  const have = new Set((contactTags || []).map(norm));
  const want = new Set(desired.tags.map(norm));
  const hold = new Set((desired.holdTags || []).map(norm));
  return {
    missing: [...want].filter((t) => !have.has(t)).sort(),
    extra: [...have].filter((t) => t.startsWith(prefix) && !want.has(t) && !hold.has(t)).sort(),
    foreignIgnored: [...have].filter((t) => !t.startsWith(prefix)).length,
  };
}

/**
 * reconcileGhlTags(deps, personIds, { mode: 'report' | 'apply', max })
 * -> { mode, checked, inSync, drifted, unlinked, errors, applied, people: [{ personId, contactId, status, missing, extra, foreignIgnored }] }
 */
export async function reconcileGhlTags(deps, personIds, { mode = 'report', max = MAX_BATCH } = {}) {
  const { pool, ghl, prefix = DEFAULT_TAG_PREFIX, now = new Date(), legacyStatuses } = deps;
  if (!['report', 'apply'].includes(mode)) fail('INVALID_INPUT', 'mode must be report or apply');
  if (!Array.isArray(personIds)) fail('INVALID_INPUT', 'personIds must be an array');
  if (personIds.length > max) fail('INVALID_INPUT', `batch of ${personIds.length} exceeds the cap of ${max}`);
  const out = { mode, checked: 0, inSync: 0, drifted: 0, unlinked: 0, errors: 0, applied: 0, people: [] };
  for (const personId of personIds) {
    out.checked++;
    const linked = (await identitiesOf(pool, personId)).filter((i) => i.platform === 'ghl' && i.kind === 'contact').map((i) => i.external_id);
    if (linked.length !== 1) { out.unlinked++; out.people.push({ personId, status: linked.length ? 'several_contacts' : 'unlinked' }); continue; }
    let contact;
    try { contact = await ghl.getContact(linked[0]); } catch (e) {
      if (!e?.code) throw e;
      out.errors++; out.people.push({ personId, contactId: linked[0], status: 'error', errorCode: e.code }); continue;
    }
    const desired = await desiredForPerson(pool, personId, { prefix, now, legacyStatuses });
    const d = tagDrift(contact?.tags, desired, { prefix });
    const drift = d.missing.length + d.extra.length > 0;
    const row = { personId, contactId: linked[0], status: drift ? 'drift' : 'in_sync', ...d };
    if (drift) {
      out.drifted++;
      if (mode === 'apply') {
        const r = await syncPersonToGhl(deps, personId);
        row.applyStatus = r.status;
        if (r.status === 'synced') out.applied++;
      }
    } else out.inSync++;
    out.people.push(row);
  }
  return out;
}
