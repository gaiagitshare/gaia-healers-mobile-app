/**
 * Partner adapter. Two implementations:
 *   - unavailableAdapter (default): every call is PROVIDER_UNAVAILABLE. No
 *     production partner integration exists until the contract is confirmed.
 *   - mockAdapter(fixtures): in-memory fixtures for development and tests.
 * A real HTTP adapter is added only after the partner confirms the contract,
 * and it is read-only towards the partner.
 */
import { fail } from '../errors.js';
import { validatePractitionerIdentity, validateSubscription, validateCoinLedger } from './contract.js';

const METHODS = ['getPractitioner', 'listSubscriptions', 'getCoinLedger', 'listModuleEntitlements'];

export const unavailableAdapter = Object.freeze(Object.fromEntries(METHODS.map((m) => [m, async () => fail('PROVIDER_UNAVAILABLE', 'partner integration not configured')]))) ;

export function mockAdapter({ practitioners = [], subscriptions = [], coinLedgers = {} } = {}) {
  const byId = new Map(practitioners.map((p) => [p.practitioner_account_id, validatePractitionerIdentity(p)]));
  subscriptions.forEach(validateSubscription);
  return {
    async getPractitioner(id) { return byId.get(id) || fail('NOT_FOUND', 'practitioner not found'); },
    async listSubscriptions(id) { return subscriptions.filter((s) => s.practitioner_account_id === id); },
    async getCoinLedger(id) { const l = coinLedgers[id]; if (!l) fail('NOT_FOUND', 'no coin ledger'); return validateCoinLedger(l); },
    async listModuleEntitlements(id) { return [...new Set(subscriptions.filter((s) => s.practitioner_account_id === id && ['trialing', 'active', 'past_due'].includes(s.status)).flatMap((s) => s.modules))]; },
  };
}
