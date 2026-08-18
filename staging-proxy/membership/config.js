/**
 * Canonical membership configuration — the single server-side source for
 * billing identity, tier presentation and the entitlement type registry.
 *
 * Nothing in here may be duplicated into resolver functions or shipped to the
 * frontend. Access decisions key off CANONICAL KEYS and explicit entitlement
 * records; the ids below exist only to recognise which product a subscription
 * actually is.
 *
 * Every id was verified against the live public checkout at
 * join.gaiahealers.com/{silver,gold,diamond} on 2026-08-17.
 */

// The only four public membership keys. Never add a fifth here without an
// explicit owner decision: the whole read model keys off this list.
const MEMBERSHIP_KEYS = ['free', 'silver', 'gold', 'diamond'];

// Upgrade order. Index position is the only ranking used anywhere.
const MEMBERSHIP_ORDER = ['free', 'silver', 'gold', 'diamond'];

const MEMBERSHIP_STATUSES = ['active', 'trialing', 'past_due', 'cancelled', 'expired', 'none'];
const BILLING_CYCLES = ['monthly', 'annual', 'none'];

// Presentation only. These strings must never be used to decide access.
const MEMBERSHIP_PRESENTATION = {
  free: { label: 'Free', subtitle: 'Gaia Network' },
  silver: { label: 'Silver', subtitle: 'Gaia Practitioner' },
  gold: { label: 'Gold', subtitle: 'Gaia Practice Pro' },
  diamond: { label: 'Diamond', subtitle: 'Gaia Leader' },
};

/**
 * Canonical paid billing map.
 *
 * `ghlProductId` is the GHL *catalog product* record — the one that resolves at
 * GET /products/{id}. The ids previously documented as "GHL product ID" are the
 * price/Stripe-mapping records; they are listed under `deprecatedIds` so an
 * audit trail survives, and they must never be used to identify a product.
 *
 * Free has no billing identity at all: no product, no price, no subscription.
 */
const MEMBERSHIP_BILLING = {
  silver: {
    ghlProductId: '69177f9c54010d18cf6a8aad',
    monthlyPriceId: '69177f9c54010d2bad6a8ac6',
    annualPriceId: '69177f9c54010d7d6f6a8abe',
    stripeProductId: 'prod_TQJ4ZnBePrYxbT',
    stripeMonthlyPriceId: 'price_1STSSWC410ERaiteUbF0RFEw',
    stripeAnnualPriceId: 'price_1STST0C410ERaiteVZYEV8re',
    deprecatedIds: ['69177f9c1bdd94edd9e837ad'],
  },
  gold: {
    ghlProductId: '691cbb523963872e3be0f660',
    monthlyPriceId: '691cbb52396387d816e0f670',
    annualPriceId: '691cbb5239638772cee0f66b',
    stripeProductId: 'prod_TRnGmfv0pZjdKM',
    stripeMonthlyPriceId: 'price_1SUtfsC410ERaiteINnWuhja',
    stripeAnnualPriceId: 'price_1SUtfrC410ERaiteYr7cMBSu',
    deprecatedIds: ['691cbb5259384859b30a8231'],
  },
  diamond: {
    ghlProductId: '691cbd1d396387d0eae141e3',
    monthlyPriceId: '691cbd1d396387281fe141f7',
    annualPriceId: '691cbd1d3963874f57e141f2',
    stripeProductId: 'prod_TRnOA5TGsiC6fx',
    stripeMonthlyPriceId: 'price_1SUtnHC410ERaitemgUNuCgK',
    stripeAnnualPriceId: 'price_1SUtnHC410ERaite317p1FJW',
    deprecatedIds: ['691cbd1e48ca08990aa1ebbc'],
  },
};

/**
 * A second Stripe product appears on the Diamond page. What it represents has
 * not been established, so it is recorded here and deliberately kept out of
 * MEMBERSHIP_BILLING: an unexplained id must not be able to grant Diamond.
 */
const UNRESOLVED_BILLING_IDS = [
  {
    id: 'prod_TRnOnug03GBUhM',
    seenOn: 'join.gaiahealers.com/diamond-cart-page',
    status: 'identified_not_approved',
    evidence: 'Appears in the cart payload immediately against price_1SUtnHC410ERaitemgUNuCgK '
      + '(the canonical Diamond monthly price), on GHL price-mapping record 691cbd1fb09bc275002cbcb2 — '
      + 'a different record from 691cbd1e48ca08990aa1ebbc, which carries prod_TRnOA5TGsiC6fx. '
      + 'Diamond monthly and annual therefore appear to sit on two separate Stripe products.',
    note: 'Deliberately NOT canonical pending owner confirmation. Resolution does not depend on it: '
      + 'a real Diamond subscription carries the price id, which is already mapped.',
  },
];

/**
 * Legacy membership tags.
 *
 * These are recorded so the resolver can *report* them, never so it can act on
 * them. Verified drift on 2026-08-17: 105 contacts carry ahc-gold-active and
 * 107 carry ahc-gold-trial, while the location has zero active Gold
 * subscriptions. A tag is therefore not evidence of billing.
 */
const LEGACY_MEMBERSHIP_TAGS = [
  'ahc-gold-active', 'ahc-gold-trial', 'ahc-gold-cancel', 'ahc-gold',
  'ahc-silver-active', 'ahc-diamond-active', 'ahc-trial',
  'membership_silver', 'membership_free', 'membership_gold', 'membership_diamond',
  'silver-membership', 'gold-membership', 'diamond-membership', 'free-membership',
  'gaia-free-active', 'ahc-free-active', 'gaia-diamond-active',
];

/**
 * Controlled entitlement type registry. The frontend gets a renderer per known
 * type; anything not in this list is diagnostics-only and never rendered as
 * access. `order` and `title` are presentation metadata for `sections`.
 */
const ENTITLEMENT_TYPES = {
  course_access:     { order: 2, title: 'Courses',        unit: 'course' },
  community_access:  { order: 3, title: 'Community',      unit: 'community' },
  crm_access:        { order: 4, title: 'Practice / CRM', unit: 'level' },
  directory_level:   { order: 5, title: 'Directory',      unit: 'level' },
  lead_allocation:   { order: 6, title: 'Monthly Leads',  unit: 'allocation' },
  discount:          { order: 7, title: 'Discounts',      unit: 'discount' },
  device_owner:      { order: 8, title: 'Devices',        unit: 'device' },
  device_software:   { order: 9, title: 'Software',       unit: 'licence' },
  event_ticket:      { order: 10, title: 'Events',        unit: 'ticket' },
  promo_membership:  { order: 11, title: 'Promotions',    unit: 'promotion' },
};

const ENTITLEMENT_STATUSES = ['active', 'expired', 'revoked', 'pending'];

/**
 * Allowed evidence sources.
 *
 * `legacy_tag` is not in the original proposal list. It exists because the only
 * evidence we hold today for device ownership and some community access is a
 * GHL tag, and calling that `shopify_order` or `ghl_group` would be a lie the
 * ledger then repeats to support and to the member. Legacy-sourced rights are
 * real enough to display and honest about where they came from.
 */
const ENTITLEMENT_SOURCES = [
  'ghl_subscription', 'ghl_offer', 'ghl_group', 'shopify_order', 'vendor_license',
  'membership_policy', 'manual', 'fixture', 'legacy_tag', 'ghl_onboarding',
];

const MEMBERSHIP_SOURCES = ['ghl_subscription', 'ghl_onboarding', 'manual', 'fixture'];

/**
 * What each tier is *promised*. This is policy, not grant: the resolver may use
 * it to describe an upgrade, never to manufacture an active entitlement. See
 * the ledger for what a member actually has.
 */
// How long a ledger observation stays trustworthy before the response is
// flagged stale. Conservative: a member should be told the data is old rather
// than have access silently withdrawn.
const LEDGER_STALE_AFTER_MS = Number(process.env.MEMBERSHIP_STALE_AFTER_MS || 24 * 60 * 60 * 1000);

// Fixtures are opt-in per process and namespaced. Production never enables this.
const FIXTURE_PREFIX = 'fixture-';
const FIXTURES_ENABLED = String(process.env.MEMBERSHIP_FIXTURES || '').trim() === '1';

const isFixtureContactId = (id) => String(id || '').startsWith(FIXTURE_PREFIX);

/** Canonical key for a tier, or null. Never throws, never guesses. */
function normalizeMembershipKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return MEMBERSHIP_KEYS.includes(key) ? key : null;
}

/**
 * Identify a tier from billing identifiers only.
 *
 * Accepts any mix of product/price ids from GHL or Stripe and returns the tier
 * whose canonical mapping contains one. Deliberately ignores names, amounts and
 * currencies: $97 is Silver monthly today and might be something else tomorrow,
 * and "Gaia Healers 2.0 CRM Gold" is a label an operator can retype.
 */
function tierFromBillingIds(ids = []) {
  const wanted = new Set((Array.isArray(ids) ? ids : [ids])
    .map((id) => String(id || '').trim()).filter(Boolean));
  if (!wanted.size) return null;
  // Price ids are checked before product ids: both identify the tier, but only
  // a price id also tells us monthly vs annual. Matching the product first
  // would resolve the right tier with an unknown billing cycle.
  const priceFields = ['monthlyPriceId', 'annualPriceId', 'stripeMonthlyPriceId', 'stripeAnnualPriceId'];
  const productFields = ['ghlProductId', 'stripeProductId'];
  for (const fields of [priceFields, productFields]) {
    for (const key of MEMBERSHIP_KEYS) {
      const map = MEMBERSHIP_BILLING[key];
      if (!map) continue;
      for (const field of fields) {
        const id = map[field];
        if (id && wanted.has(id)) return { key, matchedId: id, cycle: billingCycleForId(key, id) };
      }
    }
  }
  return null;
}

function billingCycleForId(key, id) {
  const map = MEMBERSHIP_BILLING[key];
  if (!map) return 'none';
  if (id === map.monthlyPriceId || id === map.stripeMonthlyPriceId) return 'monthly';
  if (id === map.annualPriceId || id === map.stripeAnnualPriceId) return 'annual';
  return 'none';
}

/** True if the id is a retired price/mapping record we must not treat as a product. */
function isDeprecatedBillingId(id) {
  const wanted = String(id || '').trim();
  if (!wanted) return false;
  return MEMBERSHIP_KEYS.some((key) => (MEMBERSHIP_BILLING[key]?.deprecatedIds || []).includes(wanted));
}

const isLegacyMembershipTag = (tag) => LEGACY_MEMBERSHIP_TAGS.includes(String(tag || '').trim().toLowerCase());

function nextMembershipKey(key) {
  const index = MEMBERSHIP_ORDER.indexOf(normalizeMembershipKey(key) || 'free');
  return index >= 0 && index < MEMBERSHIP_ORDER.length - 1 ? MEMBERSHIP_ORDER[index + 1] : null;
}

export {
  MEMBERSHIP_KEYS,
  MEMBERSHIP_ORDER,
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_SOURCES,
  BILLING_CYCLES,
  MEMBERSHIP_PRESENTATION,
  MEMBERSHIP_BILLING,
  UNRESOLVED_BILLING_IDS,
  LEGACY_MEMBERSHIP_TAGS,
  ENTITLEMENT_TYPES,
  ENTITLEMENT_STATUSES,
  ENTITLEMENT_SOURCES,
  LEDGER_STALE_AFTER_MS,
  FIXTURE_PREFIX,
  FIXTURES_ENABLED,
  isFixtureContactId,
  normalizeMembershipKey,
  tierFromBillingIds,
  billingCycleForId,
  isDeprecatedBillingId,
  isLegacyMembershipTag,
  nextMembershipKey,
};
