/**
 * Public plan catalogue — presentation data only.
 *
 * This is what the marketing/Store page renders. It is deliberately a separate
 * module from config.js and is NEVER imported by the resolver: prices and
 * benefit copy must not be able to reach an authorization decision, even by
 * accident. A contract test asserts that resolver.js does not import this file.
 *
 * Prices here are display strings. The authorization system keys off the
 * canonical billing ids in config.js and never reads an amount.
 */

import { MEMBERSHIP_ORDER, MEMBERSHIP_PRESENTATION } from './config.js';

const CHECKOUT_BASE = 'https://join.gaiahealers.com';

/**
 * Display copy per plan. Bullets are marketing claims about what a tier
 * promises — they are NOT entitlements and must never be rendered inside the
 * member's own access view. "Included in your access" comes from the ledger.
 */
const PLAN_DISPLAY = {
  free: {
    prices: { monthly: '$0', annual: '$0' },
    displayBenefits: [
      'Community access',
      'State of the Union calls',
      'Lightworker Creed resources',
      'Newsletter and community updates',
    ],
    checkoutPath: '/onboarding',
  },
  silver: {
    prices: { monthly: '$97/mo', annual: '$997/yr' },
    displayBenefits: [
      'Everything in Free',
      'Certifications and courses',
      'Directory listing',
      'DIY practice platform and CRM',
      'Monthly marketing coaching',
    ],
    checkoutPath: '/silver',
  },
  gold: {
    prices: { monthly: '$497/mo', annual: '$4,997/yr' },
    displayBenefits: [
      'Everything in Silver',
      'Custom landing page',
      'Managed CRM and support',
      'Monthly AI leads',
      'Certification discount',
    ],
    checkoutPath: '/gold',
  },
  diamond: {
    prices: { monthly: '$997/mo', annual: '$9,997/yr' },
    displayBenefits: [
      'Everything in Gold',
      'Higher monthly AI lead allocation',
      'Top directory placement',
      'Business accelerator and retreats',
      'Conference and speaking opportunities',
    ],
    checkoutPath: '/diamond',
  },
};

/** The catalogue as the public endpoint serves it. */
export function membershipPlans() {
  return MEMBERSHIP_ORDER.map((key) => {
    const presentation = MEMBERSHIP_PRESENTATION[key] || {};
    const display = PLAN_DISPLAY[key] || {};
    return {
      key,
      label: presentation.label || key,
      subtitle: presentation.subtitle || null,
      prices: display.prices || { monthly: null, annual: null },
      displayBenefits: display.displayBenefits || [],
      checkoutUrl: display.checkoutPath ? `${CHECKOUT_BASE}${display.checkoutPath}` : null,
    };
  });
}
