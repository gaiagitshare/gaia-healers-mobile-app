/**
 * Membership policy — what a plan PROMISES.
 *
 * This is deliberately a different thing from what a member HAS. "Gold includes
 * 5 leads a month" is policy; "Bob has 3 of 5 delivered in August" is a grant,
 * and it lives in the ledger with its own evidence. Collapsing the two is the
 * mistake this whole architecture exists to avoid — it is how a tier name ends
 * up silently granting access again.
 *
 * Nothing here grants anything. The only way policy becomes access is an
 * explicit, audited "apply policy" action that writes real entitlement records
 * with source: membership_policy, so a member's rights always trace to a record
 * someone can point at.
 */

import { MEMBERSHIP_ORDER, MEMBERSHIP_PRESENTATION, ENTITLEMENT_TYPES } from './config.js';

export const POLICY_VERSION = 1;

/**
 * The seed matrix. Editable from Membership Admin; this is only what a fresh
 * install starts with, drawn from the published plan pages.
 *
 * `benefits` entries are shaped like the entitlements they would produce, so
 * applying policy is a copy rather than a translation.
 */
export function defaultPolicy() {
  return {
    version: POLICY_VERSION,
    updatedAt: null,
    plans: {
      free: {
        key: 'free',
        label: 'Free', subtitle: 'Gaia Network',
        description: 'Community access and the public wellness tools.',
        prices: { monthly: '$0', annual: '$0' },
        checkoutUrl: 'https://join.gaiahealers.com/onboarding',
        displayBenefits: [
          'Community access',
          'State of the Union calls',
          'Lightworker Creed resources',
          'Newsletter and community updates',
        ],
        active: true, displayOrder: 1, upgradeTo: 'silver',
        benefits: [],
      },
      silver: {
        key: 'silver',
        label: 'Silver', subtitle: 'Gaia Practitioner',
        description: 'Certifications, directory listing and the DIY practice platform.',
        prices: { monthly: '$97/mo', annual: '$997/yr' },
        checkoutUrl: 'https://join.gaiahealers.com/silver',
        displayBenefits: [
          'Everything in Free',
          'Certifications and courses',
          'Directory listing',
          'DIY practice platform and CRM',
          'Monthly marketing coaching',
        ],
        active: true, displayOrder: 2, upgradeTo: 'gold',
        benefits: [
          { type: 'crm_access', key: 'diy', value: { level: 'diy' } },
          { type: 'directory_level', key: '3', value: { level: 3 } },
        ],
      },
      gold: {
        key: 'gold',
        label: 'Gold', subtitle: 'Gaia Practice Pro',
        description: 'Managed CRM, monthly leads and a certification discount.',
        prices: { monthly: '$497/mo', annual: '$4,997/yr' },
        checkoutUrl: 'https://join.gaiahealers.com/gold',
        displayBenefits: [
          'Everything in Silver',
          'Custom landing page',
          'Managed CRM and support',
          'Monthly AI leads',
          'Certification discount',
        ],
        active: true, displayOrder: 3, upgradeTo: 'diamond',
        benefits: [
          { type: 'crm_access', key: 'managed', value: { level: 'managed' } },
          { type: 'directory_level', key: '2', value: { level: 2 } },
          { type: 'lead_allocation', key: 'monthly', value: { monthly: 5, delivered: 0 } },
          { type: 'discount', key: 'certification', value: { percent: 20, scope: 'certification' } },
        ],
      },
      diamond: {
        key: 'diamond',
        label: 'Diamond', subtitle: 'Gaia Leader',
        description: 'Leader CRM, top directory placement and leadership benefits.',
        prices: { monthly: '$997/mo', annual: '$9,997/yr' },
        checkoutUrl: 'https://join.gaiahealers.com/diamond',
        displayBenefits: [
          'Everything in Gold',
          'Higher monthly AI lead allocation',
          'Top directory placement',
          'Business accelerator and retreats',
          'Conference and speaking opportunities',
        ],
        active: true, displayOrder: 4, upgradeTo: null,
        benefits: [
          { type: 'crm_access', key: 'leader', value: { level: 'leader' } },
          { type: 'directory_level', key: '1', value: { level: 1 } },
          { type: 'lead_allocation', key: 'monthly', value: { monthly: 25, delivered: 0 } },
          { type: 'discount', key: 'certification', value: { percent: 20, scope: 'certification' } },
        ],
      },
    },
  };
}

const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
const str = (value, max = 300) => String(value ?? '').replace(CONTROL_CHARS, '').trim().slice(0, max);

/** Validate one benefit row. Unknown entitlement types are refused outright. */
export function normalizeBenefit(input) {
  if (!input || typeof input !== 'object') return null;
  const type = str(input.type, 40);
  if (!Object.prototype.hasOwnProperty.call(ENTITLEMENT_TYPES, type)) return null;
  const key = str(input.key, 120);
  if (!key) return null;
  return { type, key, value: input.value && typeof input.value === 'object' ? input.value : {} };
}

/**
 * Validate an edited plan. Presentation is free-form; the plan KEY is not — an
 * operator cannot invent a fifth tier from the admin screen.
 */
export function normalizePlan(key, input, existing = {}) {
  if (!MEMBERSHIP_ORDER.includes(key)) return null;
  const presentation = MEMBERSHIP_PRESENTATION[key] || {};
  const benefits = Array.isArray(input?.benefits)
    ? input.benefits.map(normalizeBenefit).filter(Boolean)
    : (existing.benefits || []);
  // Marketing bullets for the public catalogue. Deliberately free text and
  // deliberately NOT entitlements: they describe a plan, they never grant it.
  const displayBenefits = Array.isArray(input?.displayBenefits)
    ? input.displayBenefits.map((line) => str(line, 120)).filter(Boolean).slice(0, 12)
    : (existing.displayBenefits || []);
  return {
    key,
    label: str(input?.label, 60) || existing.label || presentation.label || key,
    subtitle: str(input?.subtitle, 80) || existing.subtitle || presentation.subtitle || '',
    description: str(input?.description, 400) || existing.description || '',
    prices: {
      monthly: str(input?.prices?.monthly, 40) || existing.prices?.monthly || '',
      annual: str(input?.prices?.annual, 40) || existing.prices?.annual || '',
    },
    checkoutUrl: str(input?.checkoutUrl, 300) || existing.checkoutUrl || '',
    active: input?.active === undefined ? existing.active !== false : Boolean(input.active),
    displayOrder: Number.isFinite(Number(input?.displayOrder))
      ? Number(input.displayOrder) : (existing.displayOrder ?? 99),
    upgradeTo: MEMBERSHIP_ORDER.includes(input?.upgradeTo) ? input.upgradeTo : (existing.upgradeTo ?? null),
    benefits,
    displayBenefits,
  };
}

export function normalizePolicy(store) {
  const base = defaultPolicy();
  if (!store || typeof store !== 'object') return base;
  const plans = {};
  for (const key of MEMBERSHIP_ORDER) {
    plans[key] = normalizePlan(key, store.plans?.[key] || {}, base.plans[key]) || base.plans[key];
  }
  return { version: POLICY_VERSION, updatedAt: store.updatedAt || null, plans };
}

/** Plans in display order, for the public catalogue and the admin list. */
export function plansInOrder(policy) {
  return Object.values(policy.plans)
    .slice()
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
}

/**
 * What applying a plan's policy WOULD create for a member — a preview, so the
 * operator sees the exact records before any are written.
 */
export function benefitsToEntitlements(policy, planKey, { now = new Date(), period = null } = {}) {
  const plan = policy?.plans?.[planKey];
  if (!plan) return [];
  const stamp = now.toISOString();
  return plan.benefits.map((benefit) => {
    const value = { ...benefit.value };
    let key = benefit.key;
    // A lead allocation is always scoped to a period; "monthly" on its own is a
    // policy statement, not something a member can hold.
    if (benefit.type === 'lead_allocation') {
      const monthKey = period || stamp.slice(0, 7);
      key = monthKey;
      value.period = monthKey;
      if (value.delivered == null) value.delivered = 0;
    }
    return {
      type: benefit.type,
      key,
      value,
      status: 'active',
      source: 'membership_policy',
      evidence_id: `policy:${planKey}:${benefit.type}:${benefit.key}`,
      starts_at: stamp,
      expires_at: null,
      observed_at: stamp,
    };
  });
}

/**
 * The benefits matrix with every trace of money and marketing copy removed:
 * `{ planKey: { entitlementType: value } }`.
 *
 * This exists so the resolver can compare one plan against the next without
 * ever holding a price. An amount that can reach an authorization decision is
 * an amount that can eventually decide one, and the Next Level comparison is
 * the only place the two worlds nearly touch.
 */
export function benefitsMatrix(policy = defaultPolicy()) {
  const matrix = {};
  for (const key of MEMBERSHIP_ORDER) {
    const plan = policy?.plans?.[key];
    matrix[key] = {};
    for (const benefit of (plan?.benefits || [])) {
      const value = benefit.value || {};
      // Collapse to the single meaningful scalar so "5 leads vs 25 leads"
      // compares cleanly instead of comparing object shapes.
      matrix[key][benefit.type] = value.level ?? value.monthly ?? value.percent ?? benefit.key;
    }
  }
  return matrix;
}
