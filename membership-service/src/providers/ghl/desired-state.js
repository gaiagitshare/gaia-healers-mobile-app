/**
 * Gaia membership state -> what GHL should show (spec v2.5 §16).
 *
 * GHL is the CRM, never the subscription truth: these tags and fields are a
 * one-way MIRROR of Gaia's entitlement evaluation, used to drive GHL
 * workflows (community access, course enrolment, emails). Nothing read back
 * from GHL ever changes Gaia state.
 *
 * Guarantees (tested):
 *   - only tags under the Gaia-owned prefix are ever added or removed; every
 *     other tag on a contact (legacy Silver/Gold/Diamond, `gaiapractitioner`,
 *     marketing tags) is left alone;
 *   - custom fields come from a fixed allowlist with strict value formats
 *     (enumerations, plan keys, dates). The input is the entitlement
 *     evaluation only — no profile, scan, survey or other wellness data can
 *     reach a marketing field, because there is no path for it;
 *   - legacy GHL-billed tiers (architecture C) appear ONLY as
 *     `<prefix>legacy:<tier>`, never as `<prefix>tier:*`. A legacy row whose
 *     GHL status is unknown is HELD: its tag is neither added nor removed, so
 *     an odd status string can never take access away;
 *   - pure: no I/O, deterministic output order.
 */
import { TIERS } from '../../catalog.js';
import { fail } from '../../errors.js';

export const DEFAULT_TAG_PREFIX = 'gaia-m:';

/** Entitlement families that GHL automations may act on. Software modules,
 * discounts and anything new are deliberately NOT mirrored until listed here. */
export const MIRRORED_ENTITLEMENT_PREFIXES = Object.freeze(['community.', 'courses.', 'certification.', 'listing.', 'support.', 'perk.', 'crm.']);

const PLAN_KEY = /^[a-z][a-z0-9_]{1,59}$/;
const LEGACY_TIER = /^[a-z][a-z0-9_]{1,39}$/;
const STATUSES = ['none', 'trialing', 'active', 'past_due'];

/** The only custom fields this adapter writes, each with a value check. */
export const FIELD_SPECS = Object.freeze({
  gaia_membership_tier: (v) => v === 'none' || PLAN_KEY.test(v),
  gaia_membership_status: (v) => STATUSES.includes(v),
  gaia_membership_access_until: (v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v),
  gaia_membership_plans: (v) => v === '' || v.split(',').every((k) => PLAN_KEY.test(k)),
  gaia_membership_cancel_scheduled: (v) => v === 'yes' || v === 'no',
});

const DEFAULT_RANKS = Object.freeze(Object.fromEntries(TIERS.map((t) => [t.key, t.rank])));

export function checkPrefix(prefix) {
  if (typeof prefix !== 'string' || !/^[a-z][a-z0-9-]{1,20}[:/-]$/.test(prefix)) fail('INVALID_INPUT', 'GHL tag prefix must be lowercase and end in ":", "/" or "-"');
  return prefix;
}

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/**
 * desiredGhlState({ entitlements, plans }, { prefix, ranks, cancelScheduled, legacy })
 *   evaluation: the output of entitlements.computeEntitlements / evaluate()
 *   legacy: { live: ['silver'], hold: ['gold'] } from legacy_memberships (mapped rows only)
 * -> { tags: string[], holdTags: string[], fields: { [key]: string } }
 */
export function desiredGhlState(evaluation, { prefix = DEFAULT_TAG_PREFIX, ranks = DEFAULT_RANKS, cancelScheduled = false, legacy = {} } = {}) {
  checkPrefix(prefix);
  const plans = (evaluation?.plans || []).filter((p) => PLAN_KEY.test(String(p.planKey || '')) && STATUSES.includes(p.status));
  const ranked = [...plans].sort((a, b) => ((ranks[b.planKey] ?? 0) - (ranks[a.planKey] ?? 0)) || a.planKey.localeCompare(b.planKey));
  const top = ranked[0] || null;

  const tags = new Set();
  tags.add(`${prefix}tier:${top ? top.planKey : 'none'}`);
  tags.add(`${prefix}status:${top ? top.status : 'none'}`);
  for (const p of plans) tags.add(`${prefix}plan:${p.planKey}`);
  if (top && cancelScheduled) tags.add(`${prefix}cancel-scheduled`);
  for (const [key, e] of Object.entries(evaluation?.entitlements || {})) {
    if (!MIRRORED_ENTITLEMENT_PREFIXES.some((x) => key.startsWith(x))) continue;
    if (!/^[a-z][a-z0-9_.]{1,79}$/.test(key) || e?.value === false || e?.value == null) continue;
    tags.add(`${prefix}benefit:${key}`);
  }
  const legacyTag = (t) => { if (!LEGACY_TIER.test(String(t))) fail('INVALID_INPUT', 'invalid legacy tier'); return `${prefix}legacy:${t}`; };
  for (const t of legacy.live || []) tags.add(legacyTag(t));
  const holdTags = [...new Set((legacy.hold || []).map(legacyTag))].filter((t) => !tags.has(t)).sort();

  const accessUntil = top?.accessUntil ? day(top.accessUntil) : '';
  const fields = {
    gaia_membership_tier: top ? top.planKey : 'none',
    gaia_membership_status: top ? top.status : 'none',
    gaia_membership_access_until: accessUntil,
    gaia_membership_plans: [...new Set(plans.map((p) => p.planKey))].sort().join(','),
    gaia_membership_cancel_scheduled: top && cancelScheduled ? 'yes' : 'no',
  };
  for (const [k, v] of Object.entries(fields)) if (!FIELD_SPECS[k](v)) fail('INVALID_INPUT', `GHL field ${k} has an invalid value`);
  return { tags: [...tags].sort(), holdTags, fields };
}

const norm = (t) => String(t || '').trim().toLowerCase();

/**
 * What to change on one contact.
 *   contact: { tags: string[], customFields: [{ id, value }] }
 *   fieldIds: { gaia_membership_tier: '<GHL custom field id>', ... }
 * -> { addTags, removeTags, fieldUpdates: [{ id, key, field_value }], unmappedFields }
 */
export function diffGhlState(contact, desired, { prefix = DEFAULT_TAG_PREFIX, fieldIds = {} } = {}) {
  checkPrefix(prefix);
  const have = new Set((contact?.tags || []).map(norm));
  const want = new Set(desired.tags.map(norm));
  const addTags = [...want].filter((t) => !have.has(t)).sort();
  const hold = new Set((desired.holdTags || []).map(norm));
  const removeTags = [...have].filter((t) => t.startsWith(prefix) && !want.has(t) && !hold.has(t)).sort();
  const current = new Map((contact?.customFields || []).map((f) => [String(f.id), f.value ?? f.field_value ?? '']));
  const fieldUpdates = [];
  const unmappedFields = [];
  for (const [key, value] of Object.entries(desired.fields)) {
    if (!(key in FIELD_SPECS)) fail('INVALID_INPUT', 'field not in the GHL allowlist: ' + key);
    const id = fieldIds[key];
    if (!id) { unmappedFields.push(key); continue; }
    if (String(current.get(String(id)) ?? '') !== value) fieldUpdates.push({ id: String(id), key, field_value: value });
  }
  return { addTags, removeTags, fieldUpdates, unmappedFields };
}
