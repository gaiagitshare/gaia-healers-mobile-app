/**
 * Gaia Practitioners HTTP adapter.
 *
 *   *** CONTRACT PROPOSED, NOT CONFIRMED ***
 *   The endpoints, envelopes and fields below are the PROPOSAL in
 *   docs/membership/PARTNER-INTEGRATION-REQUEST.md and
 *   docs/membership/partner-api.openapi.yaml. The partner has not confirmed
 *   them. This adapter must not be configured against the partner until they
 *   do; until then src/partner/adapter.js `unavailableAdapter` stays the default.
 *
 * Same interface as src/partner/adapter.js (getPractitioner, listSubscriptions,
 * getCoinLedger, listModuleEntitlements), so callers can swap mock <-> HTTP.
 * Read-only: GET only, service-token auth, every response validated by
 * src/partner/contract.js before it leaves this file. Cursor pagination is
 * bounded (maxPages) and refuses a cursor that does not advance.
 */
import { createHttpClient } from '../http.js';
import { MembershipError, fail } from '../../errors.js';
import { validatePractitionerIdentity, validateSubscription, validateCoinLedger } from '../../partner/contract.js';

export const CONTRACT_STATUS = 'proposed-not-confirmed';
export const ENTITLEMENT_SOURCES = Object.freeze(['subscription', 'grant', 'promotion', 'trial', 'legacy']);

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,200}$/;
const accountId = (id) => { if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) fail('INVALID_INPUT', 'invalid practitioner account id'); return encodeURIComponent(id); };

/** Shape of one item from GET /v1/practitioners/{id}/entitlements (proposed). */
export function validateModuleEntitlement(x) {
  const bad = (f) => fail('INVALID_INPUT', 'partner payload: invalid ' + f, { field: f });
  if (!x || typeof x.module !== 'string' || !x.module || x.module.length > 200) bad('module');
  if (!ENTITLEMENT_SOURCES.includes(x.source)) bad('source');
  if (x.subscription_id !== undefined && x.subscription_id !== null && (typeof x.subscription_id !== 'string' || !x.subscription_id)) bad('subscription_id');
  if (x.ends_at !== undefined && x.ends_at !== null && Number.isNaN(Date.parse(x.ends_at))) bad('ends_at');
  return x;
}

function envelope(r, what) {
  if (!r || !Array.isArray(r.data)) fail('INVALID_INPUT', `partner payload: ${what} must be { data: [], next_cursor }`, { field: 'data' });
  if (!('next_cursor' in r) || !(r.next_cursor === null || (typeof r.next_cursor === 'string' && r.next_cursor.length > 0 && r.next_cursor.length <= 500))) {
    fail('INVALID_INPUT', 'partner payload: invalid next_cursor', { field: 'next_cursor' });
  }
  return r;
}

export function createPractitionersAdapter({ baseUrl, serviceToken, fetch, pageSize = 100, maxPages = 50, retry, sleep, random } = {}) {
  if (!serviceToken || typeof serviceToken !== 'string' || serviceToken.length < 16) throw new MembershipError('INVALID_INPUT', 'partner service token is required');
  if (!baseUrl) throw new MembershipError('INVALID_INPUT', 'partner baseUrl is required');
  const u = new URL(baseUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !loopback) throw new MembershipError('INVALID_INPUT', 'partner baseUrl must be https');
  const request = createHttpClient({
    provider: 'gaia_practitioners', baseUrl, fetch, retry, sleep, random,
    headers: { Authorization: `Bearer ${serviceToken}` },
    guardPath: (method) => { if (method !== 'GET') throw new MembershipError('FORBIDDEN', 'the partner adapter is read-only'); },
  });

  async function* pages(path) {
    let cursor = null;
    const seen = new Set();
    for (let i = 0; i < maxPages; i++) {
      const r = await request('GET', path, { query: { limit: pageSize, cursor } });
      yield r;
      if (!r?.next_cursor) return;
      if (seen.has(r.next_cursor)) fail('PROVIDER_UNAVAILABLE', 'partner pagination repeated a cursor');
      seen.add(r.next_cursor);
      cursor = r.next_cursor;
    }
    fail('PROVIDER_UNAVAILABLE', `partner pagination exceeded ${maxPages} pages`);
  }

  return Object.freeze({
    contractStatus: CONTRACT_STATUS,

    async getPractitioner(id) {
      const p = validatePractitionerIdentity(await request('GET', `/v1/practitioners/${accountId(id)}`));
      if (p.practitioner_account_id !== id) fail('INVALID_INPUT', 'partner payload: practitioner_account_id does not match the request');
      return p;
    },

    async listSubscriptions(id) {
      const out = [];
      for await (const r of pages(`/v1/practitioners/${accountId(id)}/subscriptions`)) {
        for (const s of envelope(r, 'subscriptions').data) {
          validateSubscription(s);
          if (s.practitioner_account_id !== id) fail('INVALID_INPUT', 'partner payload: subscription for another practitioner');
          out.push(s);
        }
      }
      return out;
    },

    /** Balance + FULL history across pages; the balance must be identical on every page and equal the sum. */
    async getCoinLedger(id) {
      let balance = null;
      const transactions = [];
      for await (const r of pages(`/v1/practitioners/${accountId(id)}/coins`)) {
        envelope(r, 'coins');
        if (!r.balance) fail('INVALID_INPUT', 'partner payload: invalid balance', { field: 'balance' });
        if (balance && (balance.coins !== r.balance.coins || balance.as_of !== r.balance.as_of)) fail('CONFLICT', 'partner coin balance changed while paging; retry later');
        balance = balance || r.balance;
        transactions.push(...r.data);
      }
      if (balance?.practitioner_account_id !== id) fail('INVALID_INPUT', 'partner payload: balance for another practitioner');
      const ids = new Set(transactions.map((t) => t.transaction_id));
      if (ids.size !== transactions.length) fail('INVALID_INPUT', 'partner payload: duplicate transaction_id across pages');
      return validateCoinLedger({ balance, transactions });
    },

    /** Module keys the practitioner can use now (same output as mockAdapter). */
    async listModuleEntitlements(id, { now = new Date() } = {}) {
      const mods = new Set();
      for await (const r of pages(`/v1/practitioners/${accountId(id)}/entitlements`)) {
        for (const e of envelope(r, 'entitlements').data) {
          validateModuleEntitlement(e);
          if (e.ends_at && Date.parse(e.ends_at) <= now.getTime()) continue;
          mods.add(e.module);
        }
      }
      return [...mods];
    },
  });
}
