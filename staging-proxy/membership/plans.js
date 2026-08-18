/**
 * Public plan catalogue — presentation only.
 *
 * This module holds no plan data of its own any more: it renders whatever the
 * membership policy says into the shape the Store page expects. One place now
 * decides what a plan is called, costs and promises, and editing it in the
 * Membership Control Center changes the public catalogue too.
 *
 * It is still never imported by the resolver, and a contract test still asserts
 * that. Prices and marketing copy must not be able to reach an authorization
 * decision, even by accident.
 */

import { MEMBERSHIP_ORDER } from './config.js';
import { defaultPolicy } from './policy.js';

/**
 * The catalogue as the public endpoint serves it.
 *
 * `displayBenefits` are marketing claims about a plan. They are NOT
 * entitlements and must never be rendered inside a member's own access view —
 * "Included in your access" comes from the ledger.
 */
export function membershipPlans(policy = defaultPolicy()) {
  return MEMBERSHIP_ORDER.map((key) => {
    const plan = policy?.plans?.[key] || {};
    return {
      key,
      label: plan.label || key,
      subtitle: plan.subtitle || null,
      prices: {
        monthly: plan.prices?.monthly || null,
        annual: plan.prices?.annual || null,
      },
      displayBenefits: Array.isArray(plan.displayBenefits) ? plan.displayBenefits : [],
      checkoutUrl: plan.checkoutUrl || null,
    };
  });
}
