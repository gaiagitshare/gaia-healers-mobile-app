/**
 * Synthetic membership profiles for app-first development.
 *
 * Every contact id is prefixed `fixture-`, which the ledger refuses to write
 * into a production store and the resolver path refuses to serve unless
 * MEMBERSHIP_FIXTURES=1 is set on the process. No real contact is referenced,
 * copied or modified here.
 *
 * Profiles are built relative to a supplied clock so tests are deterministic:
 * "expires in 14 days" means 14 days from the reference, not from wall time.
 */

import { MEMBERSHIP_BILLING, FIXTURE_PREFIX } from './config.js';

const day = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** A subscription payload shaped like the GHL payments API returns. */
function subscription({ key, cycle, status, now, id, canceledAt = null }) {
  const map = MEMBERSHIP_BILLING[key];
  const priceId = cycle === 'annual' ? map.annualPriceId : map.monthlyPriceId;
  return {
    _id: id,
    status,
    // The canonical ids live inside the payload exactly as GHL nests them.
    entityId: map.ghlProductId,
    entityType: 'product',
    priceId,
    amount: 0, // deliberately meaningless: amount must never drive resolution
    currency: 'usd',
    createdAt: iso(now - 90 * day),
    updatedAt: iso(now - day),
    subscriptionStartDate: iso(now - 90 * day),
    currentPeriodEnd: iso(now + (cycle === 'annual' ? 275 : 26) * day),
    ...(canceledAt ? { canceledAt } : {}),
  };
}

const course = (key, name, { now, status = 'active', expires = null }) => ({
  type: 'course_access', key, value: { name },
  status, source: 'ghl_offer', evidence_id: key,
  starts_at: iso(now - 30 * day), expires_at: expires, observed_at: iso(now - 60 * 60 * 1000),
});

/**
 * Build every fixture profile.
 * Returns { store, subscriptionsByContact, expectations } — the store is a
 * standalone ledger document that never touches production storage.
 */
function buildFixtures({ now = Date.now() } = {}) {
  const observed = iso(now - 60 * 60 * 1000);
  const contacts = {};
  const subs = {};

  const put = (id, { membership = null, entitlements = [], tags = [], subscriptions = [] }) => {
    const contactId = `${FIXTURE_PREFIX}${id}`;
    contacts[contactId] = {
      contactId, tags, tier: null, courses: [], communities: [], subscriptions: [],
      domainUpdatedAt: {}, updatedAt: observed,
      membership, entitlements, ledgerVersion: 2,
    };
    subs[contactId] = subscriptions;
    return contactId;
  };

  // 1 — Free. Explicit onboarding evidence; nothing is inferred from existing.
  put('free', {
    membership: { key: 'free', status: 'active', billing_cycle: 'none',
      started_at: iso(now - 200 * day), source: 'fixture', evidence_id: 'fixture-onboarding-1' },
    entitlements: [
      { type: 'community_access', key: 'all-gaia', value: { name: 'All Gaia Healers' },
        status: 'active', source: 'fixture', evidence_id: 'fixture-group-1',
        starts_at: iso(now - 200 * day), expires_at: null, observed_at: observed },
    ],
  });

  // 2 — Silver monthly, resolved from real billing ids.
  put('silver-monthly', {
    subscriptions: [subscription({ key: 'silver', cycle: 'monthly', status: 'active', now, id: 'sub_fixture_silver' })],
    entitlements: [
      ...Array.from({ length: 9 }, (_, i) => course(`offer_silver_${i + 1}`, `Silver Course ${i + 1}`, { now })),
      { type: 'directory_level', key: '3', value: { level: 3 }, status: 'active',
        source: 'membership_policy', evidence_id: null, starts_at: iso(now - 30 * day), expires_at: null, observed_at: observed },
      { type: 'crm_access', key: 'diy', value: { level: 'diy' }, status: 'active',
        source: 'membership_policy', evidence_id: null, starts_at: iso(now - 30 * day), expires_at: null, observed_at: observed },
    ],
  });

  // 3 — Gold annual with a partially delivered lead allocation.
  put('gold-annual', {
    subscriptions: [subscription({ key: 'gold', cycle: 'annual', status: 'active', now, id: 'sub_fixture_gold' })],
    entitlements: [
      course('offer_gold_1', 'Gold Course 1', { now }),
      { type: 'directory_level', key: '2', value: { level: 2 }, status: 'active',
        source: 'membership_policy', evidence_id: null, starts_at: iso(now - 30 * day), expires_at: null, observed_at: observed },
      { type: 'crm_access', key: 'managed', value: { level: 'managed' }, status: 'active',
        source: 'membership_policy', evidence_id: null, starts_at: iso(now - 30 * day), expires_at: null, observed_at: observed },
      { type: 'lead_allocation', key: '2026-08', value: { monthly: 5, delivered: 3, period: '2026-08' },
        status: 'active', source: 'fixture', evidence_id: null, starts_at: iso(now - 17 * day), expires_at: null, observed_at: observed },
      { type: 'discount', key: 'certification', value: { percent: 20, scope: 'certification' },
        status: 'active', source: 'membership_policy', evidence_id: null, starts_at: iso(now - 30 * day), expires_at: null, observed_at: observed },
    ],
  });

  // 4 — Diamond.
  put('diamond', {
    subscriptions: [subscription({ key: 'diamond', cycle: 'monthly', status: 'active', now, id: 'sub_fixture_diamond' })],
    entitlements: [
      { type: 'lead_allocation', key: '2026-08', value: { monthly: 25, delivered: 0, period: '2026-08' },
        status: 'active', source: 'fixture', evidence_id: null, starts_at: iso(now - 17 * day), expires_at: null, observed_at: observed },
      { type: 'directory_level', key: '1', value: { level: 1 }, status: 'active',
        source: 'membership_policy', evidence_id: null, starts_at: iso(now - 30 * day), expires_at: null, observed_at: observed },
      { type: 'crm_access', key: 'leader', value: { level: 'leader' }, status: 'active',
        source: 'membership_policy', evidence_id: null, starts_at: iso(now - 30 * day), expires_at: null, observed_at: observed },
    ],
  });

  // 5 — Cancelled Gold. The lifetime course must survive; time-limited tier
  //     benefits must not.
  put('cancelled-gold', {
    subscriptions: [subscription({ key: 'gold', cycle: 'monthly', status: 'canceled', now, id: 'sub_fixture_cancelled', canceledAt: iso(now - 10 * day) })],
    membership: { key: 'gold', status: 'cancelled', billing_cycle: 'monthly',
      started_at: iso(now - 400 * day), ends_at: iso(now - 10 * day), source: 'fixture', evidence_id: 'sub_fixture_cancelled' },
    entitlements: [
      course('offer_lifetime_1', 'Lifetime Certification', { now }),
      { type: 'lead_allocation', key: '2026-07', value: { monthly: 5, delivered: 5, period: '2026-07' },
        status: 'expired', source: 'fixture', evidence_id: null, starts_at: iso(now - 48 * day), expires_at: iso(now - 10 * day), observed_at: observed },
      { type: 'directory_level', key: '2', value: { level: 2 }, status: 'revoked',
        source: 'membership_policy', evidence_id: null, starts_at: iso(now - 400 * day), expires_at: null, observed_at: observed },
      // Owned hardware is not a membership benefit and must outlive the
      // cancellation exactly as a lifetime course does.
      { type: 'device_owner', key: 'biowell-3', value: { name: 'Bio-Well 3.0' }, status: 'active',
        source: 'fixture', evidence_id: 'fixture-order-4', starts_at: iso(now - 500 * day), expires_at: null, observed_at: observed },
    ],
  });

  // 6 — Expired device software, device ownership untouched.
  put('expired-entitlement', {
    subscriptions: [subscription({ key: 'silver', cycle: 'monthly', status: 'active', now, id: 'sub_fixture_exp' })],
    entitlements: [
      { type: 'device_owner', key: 'biowell-3', value: { name: 'Bio-Well 3.0' }, status: 'active',
        source: 'fixture', evidence_id: 'fixture-order-1', starts_at: iso(now - 300 * day), expires_at: null, observed_at: observed },
      { type: 'device_software', key: 'biowell-cloud', value: { name: 'Bio-Well Cloud' }, status: 'active',
        source: 'fixture', evidence_id: 'fixture-licence-1', starts_at: iso(now - 400 * day), expires_at: iso(now - 5 * day), observed_at: observed },
    ],
  });

  // 7 — Lifetime course on a Free membership.
  put('lifetime-course', {
    membership: { key: 'free', status: 'active', billing_cycle: 'none',
      started_at: iso(now - 100 * day), source: 'fixture', evidence_id: 'fixture-onboarding-2' },
    entitlements: [course('offer_lifetime_2', 'Lifetime Workshop', { now, expires: null })],
  });

  // 8 — Revoked course: tier would normally include it, revocation still wins.
  put('revoked-course', {
    subscriptions: [subscription({ key: 'silver', cycle: 'monthly', status: 'active', now, id: 'sub_fixture_rev' })],
    entitlements: [course('offer_silver_1', 'Silver Course 1', { now, status: 'revoked' })],
  });

  // 9 — Device owner with no paid membership. Source is fixture, NOT
  //     shopify_order: no Shopify evidence exists yet and pretending otherwise
  //     would mislead support.
  put('device-owner', {
    membership: { key: 'free', status: 'active', billing_cycle: 'none',
      started_at: iso(now - 150 * day), source: 'fixture', evidence_id: 'fixture-onboarding-3' },
    entitlements: [
      { type: 'device_owner', key: 'biowell-3', value: { name: 'Bio-Well 3.0' }, status: 'active',
        source: 'fixture', evidence_id: 'fixture-order-2', starts_at: iso(now - 150 * day), expires_at: null, observed_at: observed },
    ],
  });

  // 10 — Software expiring in 14 days (still active).
  put('expiring-software', {
    subscriptions: [subscription({ key: 'gold', cycle: 'monthly', status: 'active', now, id: 'sub_fixture_soft' })],
    entitlements: [
      { type: 'device_owner', key: 'biowell-3', value: { name: 'Bio-Well 3.0' }, status: 'active',
        source: 'fixture', evidence_id: 'fixture-order-3', starts_at: iso(now - 200 * day), expires_at: null, observed_at: observed },
      { type: 'device_software', key: 'biowell-cloud', value: { name: 'Bio-Well Cloud' }, status: 'active',
        source: 'fixture', evidence_id: 'fixture-licence-2', starts_at: iso(now - 200 * day), expires_at: iso(now + 14 * day), observed_at: observed },
    ],
  });

  // 11 — Partial monthly lead allocation.
  put('partial-leads', {
    subscriptions: [subscription({ key: 'gold', cycle: 'monthly', status: 'active', now, id: 'sub_fixture_leads' })],
    entitlements: [
      { type: 'lead_allocation', key: '2026-08', value: { monthly: 5, delivered: 3, period: '2026-08' },
        status: 'active', source: 'fixture', evidence_id: null, starts_at: iso(now - 17 * day), expires_at: null, observed_at: observed },
    ],
  });

  // 12 — Upgrade available from Silver.
  put('upgrade-available', {
    subscriptions: [subscription({ key: 'silver', cycle: 'monthly', status: 'active', now, id: 'sub_fixture_upgrade' })],
    entitlements: [course('offer_silver_2', 'Silver Course 2', { now })],
  });

  // 13 — Degraded/stale: the observation is far older than the freshness window.
  put('degraded-stale', {
    subscriptions: [subscription({ key: 'gold', cycle: 'monthly', status: 'active', now, id: 'sub_fixture_stale' })],
    entitlements: [
      { ...course('offer_gold_1', 'Gold Course 1', { now }), observed_at: iso(now - 30 * day) },
    ],
  });

  // 14 — No membership at all. Must NOT become Free.
  put('no-membership', {
    tags: ['ahc-gold-active', 'ahc-gold-trial'], // legacy tags that must be ignored
    entitlements: [],
  });

  return {
    store: { version: 2, contacts, processedWebhookIds: [], updatedAt: observed },
    subscriptionsByContact: subs,
    ids: Object.keys(contacts),
  };
}

export { buildFixtures };
