/**
 * GHL admin setup spec for Membership 2.0, and a READ-ONLY dry-run report of
 * what Membership 2.0 would write to GHL for the people in the legacy mirror.
 *
 * Nothing here talks to GHL. The report reads only the membership database
 * (legacy_memberships, filled by the read-only legacy import, plus Gaia's own
 * subscriptions and entitlements) and runs the SAME pure functions the sync
 * uses (desiredGhlState / diffGhlState), against the baseline "no gaia-m:
 * tags and no gaia_membership_* values yet": Membership 2.0 has never written
 * to GHL, so every planned write is an addition. Before the first real sync a
 * read-only contact fetch (approved separately) replaces that baseline.
 */
import { FIELD_SPECS, MIRRORED_ENTITLEMENT_PREFIXES, DEFAULT_TAG_PREFIX, desiredGhlState, diffGhlState } from './desired-state.js';
import { desiredForPerson } from './sync.js';
import { classifyStatus, LEGACY_BILLING } from './legacy-config.js';
import { TIERS } from '../../catalog.js';

/** The five custom fields. `key` is what field-ids.js resolves (GHL shows it as contact.<key>). */
export const GHL_FIELDS = Object.freeze([
  { key: 'gaia_membership_tier', name: 'Gaia Membership Tier', type: 'Single line text',
    values: ['none', ...TIERS.map((t) => t.key)], note: 'highest live Membership 2.0 plan; text (not a dropdown) so a new plan key never fails the write' },
  { key: 'gaia_membership_status', name: 'Gaia Membership Status', type: 'Dropdown (single)',
    values: ['none', 'trialing', 'active', 'past_due'], note: 'status of that plan' },
  { key: 'gaia_membership_access_until', name: 'Gaia Membership Access Until', type: 'Date',
    values: ['YYYY-MM-DD', '(empty)'], note: 'end of paid access incl. grace; empty when none' },
  { key: 'gaia_membership_plans', name: 'Gaia Membership Plans', type: 'Single line text',
    values: ['comma-separated plan keys, sorted', '(empty)'], note: 'every live Membership 2.0 plan' },
  { key: 'gaia_membership_cancel_scheduled', name: 'Gaia Membership Cancel Scheduled', type: 'Dropdown (single)',
    values: ['yes', 'no'], note: 'yes while a cancel at period end is pending' },
]);

/** Every tag Membership 2.0 can write (all under the gaia-m: prefix; nothing else is ever sent). */
export function allTagNames(prefix = DEFAULT_TAG_PREFIX) {
  const plans = TIERS.map((t) => t.key);
  const benefits = [...new Set(TIERS.flatMap((t) => Object.entries(t.entitlements).filter(([, v]) => v !== false && v != null).map(([k]) => k)))]
    .filter((k) => MIRRORED_ENTITLEMENT_PREFIXES.some((x) => k.startsWith(x))).sort();
  return {
    tier: ['none', ...plans].map((p) => `${prefix}tier:${p}`),
    status: ['none', 'trialing', 'active', 'past_due'].map((s) => `${prefix}status:${s}`),
    plan: plans.map((p) => `${prefix}plan:${p}`),
    cancel: [`${prefix}cancel-scheduled`],
    benefit: benefits.map((k) => `${prefix}benefit:${k}`),
    legacy: Object.keys(LEGACY_BILLING).map((t) => `${prefix}legacy:${t}`),
  };
}

/** What the GHL admin changes. Membership 2.0 makes none of these changes itself. */
export const WORKFLOW_CHANGES = Object.freeze([
  { id: 'W1', what: 'For each benefit that maps to a course offer: workflow "Tag added gaia-m:benefit:<key>" -> Grant Offer <offer>; workflow "Tag removed gaia-m:benefit:<key>" -> Revoke Offer <offer>.', when: 'before BENEFIT_GRANTS is filled' },
  { id: 'W2', what: 'For each benefit that maps to a community group: "Tag added" -> Add to Group; "Tag removed" -> Remove from Group.', when: 'before BENEFIT_GRANTS is filled' },
  { id: 'W3', what: 'Keep the existing "Course Access Granted/Removed Mirror" webhooks active and add the same mirror for group access, so grants are confirmed back (grants.js recordGrantConfirmation).', when: 'with W1/W2' },
  { id: 'W4', what: 'No workflow may act on gaia-m:tier:none or gaia-m:status:none (every legacy member carries them); access workflows trigger on gaia-m:benefit:* and gaia-m:legacy:* only.', when: 'always' },
  { id: 'W5', what: 'Do NOT change the existing ahc-* grant workflows or the legacy Silver/Gold/Diamond payment workflows. Retire an ahc-* grant only per tier, after its gaia-m: replacement is confirmed for every member of that tier (owner approval per tier).', when: 'later, per tier' },
  { id: 'W6', what: 'Send the offer / group ids for W1/W2 to the developer (ids are not secrets); they go into BENEFIT_GRANTS in providers/ghl/grants.js by a reviewed change.', when: 'after W1/W2' },
]);

const mask = (id) => (id ? `…${String(id).slice(-4)}` : '(none)');

/**
 * planLegacyGhlWrites(pool, { now, showIds }) -> { contacts: [...], summary }
 * Reads the legacy mirror and Gaia state; never writes, never calls GHL.
 */
export async function planLegacyGhlWrites(pool, { now = new Date(), showIds = false, prefix = DEFAULT_TAG_PREFIX } = {}) {
  const rows = (await pool.query(
    `SELECT external_contact_id, person_id, tier, mapping, payment_provider, reported_status, review_state, review_reasons, stale_suspected
       FROM legacy_memberships ORDER BY external_contact_id NULLS LAST, external_subscription_id`)).rows;
  const fieldIds = Object.fromEntries(Object.keys(FIELD_SPECS).map((k) => [k, k]));   // baseline: every field present and empty
  const byContact = new Map();
  const summary = { rows: rows.length, contacts: 0, noContactId: 0, legacyTagged: 0, held: 0, unclassified: 0, ended: 0, needsReview: 0, paypal: 0,
    tagAdds: {}, fieldSets: {} };
  for (const r of rows) {
    if (!r.external_contact_id) { summary.noContactId++; continue; }
    if (!byContact.has(r.external_contact_id)) byContact.set(r.external_contact_id, []);
    byContact.get(r.external_contact_id).push(r);
  }
  const contacts = [];
  for (const [contactId, list] of byContact) {
    const personId = list.find((r) => r.person_id)?.person_id || null;
    let desired;
    if (personId) desired = await desiredForPerson(pool, personId, { prefix, now });
    else {
      const live = new Set(); const hold = new Set();
      for (const r of list.filter((x) => x.mapping === 'mapped' && x.tier)) {
        const c = classifyStatus(r.reported_status);
        if (c === 'live') live.add(r.tier); else if (c === 'unknown') hold.add(r.tier);
      }
      desired = desiredGhlState({ plans: [], entitlements: {} }, { prefix, legacy: { live: [...live].sort(), hold: [...hold].filter((t) => !live.has(t)).sort() } });
    }
    const diff = diffGhlState({ tags: [], customFields: [] }, desired, { prefix, fieldIds });
    const notes = [];
    for (const r of list) {
      const cls = classifyStatus(r.reported_status);
      if (r.mapping !== 'mapped') { notes.push(`${r.mapping} price (${r.payment_provider}, ${r.reported_status}): no tag, unchanged until classified`); if (cls === 'live') summary.unclassified++; }
      else if (cls === 'ended') summary.ended++;
      if (r.payment_provider === 'paypal' && cls === 'live') { summary.paypal++; notes.push(`PayPal ${r.tier || 'unmapped'}: observed through GHL only, never changed`); }
      if (r.stale_suspected) notes.push('stale suspected (review flag only; the tag is still written while GHL reports it live)');
      if (r.review_state === 'needs_review') { summary.needsReview++; notes.push(`needs review: ${(r.review_reasons || []).join(',')}`); }
    }
    if (desired.tags.some((t) => t.startsWith(`${prefix}legacy:`))) summary.legacyTagged++;
    if (desired.holdTags.length) summary.held++;
    for (const t of diff.addTags) summary.tagAdds[t] = (summary.tagAdds[t] || 0) + 1;
    for (const f of diff.fieldUpdates) summary.fieldSets[`${f.key}=${f.field_value}`] = (summary.fieldSets[`${f.key}=${f.field_value}`] || 0) + 1;
    contacts.push({ contact: showIds ? contactId : mask(contactId), linkedPerson: Boolean(personId), addTags: diff.addTags, holdTags: desired.holdTags,
      setFields: diff.fieldUpdates.map((f) => `${f.key}=${f.field_value}`), removeTags: diff.removeTags, notes: [...new Set(notes)] });
  }
  summary.contacts = contacts.length;
  return { generatedAt: now, baseline: 'no gaia-m: tags or gaia_membership_* values in GHL yet (Membership 2.0 has never written)', contacts, summary };
}
