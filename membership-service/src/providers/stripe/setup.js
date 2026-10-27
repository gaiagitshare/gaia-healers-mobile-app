/**
 * Stripe account setup for Membership 2.0: PLAN first, execute only on request.
 *
 * Three sections, each idempotent and never destructive:
 *   catalog  one Product per Gaia plan (`gaia_plan_<key>`) and one Price per
 *            published, sellable plan-version price, with the lookup key
 *            `gaia_<plan>_v<version>_<interval>_<currency>` (the same helpers
 *            the adapter uses at checkout, so setup and checkout can never
 *            disagree). Execution is ensureProductAndPrice(): an existing
 *            provider_price_refs row costs 0 requests; a mismatching Stripe
 *            price is a CONFLICT, never edited;
 *   webhook  one test-mode endpoint subscribed to EXACTLY the events the
 *            pipeline handles (src/stripe/handlers.js). An endpoint with the
 *            same URL but other events is reported as a conflict, never updated;
 *   portal   one Customer Portal configuration: payment method update,
 *            invoice history, cancel at period end. Plan switching is OFF
 *            until the owner decides the proration rule (INTEGRATIONS.md §6).
 *
 * Request counts are UPPER BOUNDS (retries are off in the CLI, so each counted
 * request is one HTTP request). Nothing here reads the environment or opens a
 * transport: the Stripe client is injected (providers-guard.test.js).
 */
import crypto from 'node:crypto';
import { stripeHandlers } from '../../stripe/handlers.js';
import { TIERS } from '../../catalog.js';
import { fail } from '../../errors.js';
import { productIdFor, lookupKeyFor, ensureProductAndPrice } from './adapter.js';

export const SECTIONS = Object.freeze(['catalog', 'webhook', 'portal']);
/** The exact event list: the keys of the handler table, nothing more. */
export const WEBHOOK_EVENTS = Object.freeze(Object.keys(stripeHandlers));
export const WEBHOOK_CONFIG_KEY = 'gaia_membership2_webhook_v1';
export const PORTAL_CONFIG_KEY = 'gaia_membership2_portal_v1';
/** Requests per section that are not per price: list existing (1) + create (1). */
export const FIXED_REQUESTS = Object.freeze({ webhook: 2, portal: 2 });

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);

function httpsUrl(u, what) {
  let url;
  try { url = new URL(u); } catch { fail('INVALID_INPUT', `${what} must be an absolute https URL`); }
  if (url.protocol !== 'https:') fail('INVALID_INPUT', `${what} must be https`);
  return url.toString();
}

/** Sellable prices from the DATABASE: published, not legacy, Gaia-owned, paid. Reads only. */
export async function loadSellablePrices(db, { livemode = false } = {}) {
  return (await db.query(
    `SELECT pvp.id, pvp.billing_interval, pvp.amount_cents, pvp.currency, v.version, p.key AS plan_key, p.name AS plan_name,
            EXISTS (SELECT 1 FROM provider_price_refs r WHERE r.plan_version_price_id = pvp.id AND r.provider = 'stripe' AND r.livemode = $1) AS ref_exists
       FROM plan_version_prices pvp JOIN plan_versions v ON v.id = pvp.plan_version_id JOIN plans p ON p.id = v.plan_id
      WHERE v.status = 'published' AND NOT v.is_legacy AND p.owner_type = 'gaia' AND pvp.amount_cents > 0
      ORDER BY p.rank, p.key, v.version, pvp.billing_interval`, [livemode])).rows;
}

/** The same list from the seed catalog (no database): version 1 of each paid tier. */
export function seedSellablePrices() {
  return TIERS.flatMap((t) => Object.entries(t.prices).filter(([, cents]) => cents > 0).map(([interval, cents]) => ({
    id: null, billing_interval: interval, amount_cents: cents, currency: 'USD', version: 1, plan_key: t.key, plan_name: t.name, ref_exists: false,
  })));
}

export function webhookEndpointParams({ url, apiVersion } = {}) {
  return {
    url: httpsUrl(url, 'webhook URL'),
    enabled_events: [...WEBHOOK_EVENTS],
    description: 'Gaia Membership 2.0 webhook pipeline (src/stripe/handlers.js)',
    ...(apiVersion ? { api_version: apiVersion } : {}),
    metadata: { gaia_config: WEBHOOK_CONFIG_KEY },
  };
}

/** Portal: card update, invoices, cancel at period end. Plan switching and profile edits OFF. */
export function portalConfigurationParams({ returnUrl, privacyUrl, termsUrl, headline } = {}) {
  return {
    business_profile: {
      ...(headline ? { headline: String(headline).slice(0, 60) } : {}),
      privacy_policy_url: httpsUrl(privacyUrl, 'privacy policy URL'),
      terms_of_service_url: httpsUrl(termsUrl, 'terms of service URL'),
    },
    default_return_url: httpsUrl(returnUrl, 'return URL'),
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      customer_update: { enabled: false },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: { enabled: false },          // owner decision pending: proration rule (INTEGRATIONS.md §6)
    },
    metadata: { gaia_config: PORTAL_CONFIG_KEY },
  };
}

/** Differences between an existing Stripe portal configuration and what we want (feature flags only). */
export function portalDifferences(existing, wanted) {
  const f = existing?.features || {};
  const w = wanted.features;
  const out = [];
  for (const k of ['payment_method_update', 'invoice_history', 'customer_update', 'subscription_cancel', 'subscription_update']) {
    if (Boolean(f[k]?.enabled) !== w[k].enabled) out.push(`${k}.enabled`);
  }
  if (w.subscription_cancel.enabled && f.subscription_cancel?.mode !== w.subscription_cancel.mode) out.push('subscription_cancel.mode');
  return out;
}

export function webhookDifferences(existing, wanted) {
  const have = new Set(existing?.enabled_events || []);
  const want = new Set(wanted.enabled_events);
  return {
    missing: [...want].filter((e) => !have.has(e)),
    extra: [...have].filter((e) => !want.has(e)),
  };
}

/**
 * planSetup({ prices, sections, webhook, portal }) -> { sections: {...}, total }
 * Pure. `webhook` / `portal` are the option objects; a missing required URL is
 * recorded as `missing` (the dry run shows it, the run refuses).
 */
export function planSetup({ prices = [], sections = SECTIONS, webhook = {}, portal = {} } = {}) {
  const bad = sections.filter((s) => !SECTIONS.includes(s));
  if (bad.length || !sections.length) fail('INVALID_INPUT', `sections must be some of ${SECTIONS.join(', ')}`);
  const plan = { sections: {}, total: 0 };
  if (sections.includes('catalog')) {
    const items = prices.map((p) => ({
      planVersionPriceId: p.id, plan: p.plan_key, version: p.version, interval: p.billing_interval, amountCents: Number(p.amount_cents),
      currency: p.currency, productId: productIdFor(p.plan_key), lookupKey: lookupKeyFor(p), action: p.ref_exists ? 'exists' : 'ensure',
    }));
    const ensure = items.filter((i) => i.action === 'ensure');
    const products = [...new Set(ensure.map((i) => i.productId))];
    // per price: GET product + GET price by lookup key + POST price; per product: at most one POST product
    const requests = 3 * ensure.length + products.length;
    plan.sections.catalog = { items, products, requests };
    plan.total += requests;
  }
  if (sections.includes('webhook')) {
    let params = null; const missing = [];
    try { params = webhookEndpointParams(webhook); } catch (e) { missing.push(e.message); }
    plan.sections.webhook = { params, events: [...WEBHOOK_EVENTS], missing, requests: FIXED_REQUESTS.webhook };
    plan.total += FIXED_REQUESTS.webhook;
  }
  if (sections.includes('portal')) {
    let params = null;
    const missing = [['returnUrl', '--return-url'], ['privacyUrl', '--privacy-url'], ['termsUrl', '--terms-url']]
      .filter(([k]) => { try { httpsUrl(portal[k], k); return false; } catch { return true; } }).map(([, flag]) => `${flag} (https) is required`);
    if (!missing.length) params = portalConfigurationParams(portal);
    plan.sections.portal = { params, missing, requests: FIXED_REQUESTS.portal };
    plan.total += FIXED_REQUESTS.portal;
  }
  return plan;
}

/**
 * Execute a plan. Never updates or deletes anything in Stripe: an existing
 * object that differs is reported as a conflict for a person to resolve.
 * The webhook signing secret goes ONLY to `secretSink(secret)`; it is never
 * returned, logged or put in the result.
 */
export async function runSetup({ pool, stripe }, plan, { secretSink } = {}) {
  if (stripe?.livemode !== false) fail('FORBIDDEN', 'setup runs in Stripe test mode only');
  const result = {};
  const c = plan.sections.catalog;
  if (c) {
    const out = [];
    for (const i of c.items) {
      if (i.action === 'exists') { out.push({ lookupKey: i.lookupKey, status: 'exists' }); continue; }
      if (!pool || !i.planVersionPriceId) fail('INVALID_INPUT', 'the catalog section needs the membership database (plan version prices)');
      const r = await ensureProductAndPrice({ pool, stripe }, i.planVersionPriceId);
      out.push({ lookupKey: i.lookupKey, status: r.created ? 'created' : 'adopted', priceId: r.priceId });
    }
    result.catalog = out;
  }
  const w = plan.sections.webhook;
  if (w) {
    if (!w.params) fail('INVALID_INPUT', w.missing.join('; '));
    const list = await stripe.get('/v1/webhook_endpoints', { limit: 100 });
    if (list?.has_more) fail('CONFLICT', 'more than 100 webhook endpoints: check the Dashboard by hand');
    const same = (list?.data || []).find((e) => e.url === w.params.url);
    if (same) {
      const d = webhookDifferences(same, w.params);
      result.webhook = d.missing.length || d.extra.length
        ? { status: 'conflict', endpointId: same.id, ...d }
        : { status: 'exists', endpointId: same.id };
    } else {
      if (typeof secretSink !== 'function') fail('INVALID_INPUT', 'a secret sink is required to create a webhook endpoint');
      const ep = await stripe.post('/v1/webhook_endpoints', w.params, { idempotencyKey: `gaia-setup-webhook-${sha(JSON.stringify(w.params))}` });
      if (!ep?.id || !/^we_/.test(ep.id)) fail('PROVIDER_UNAVAILABLE', 'stripe returned no webhook endpoint');
      if (ep.secret) await secretSink(ep.secret);
      result.webhook = { status: 'created', endpointId: ep.id, secretStored: Boolean(ep.secret) };
    }
  }
  const p = plan.sections.portal;
  if (p) {
    if (!p.params) fail('INVALID_INPUT', p.missing.join('; '));
    const list = await stripe.get('/v1/billing_portal/configurations', { limit: 100 });
    if (list?.has_more) fail('CONFLICT', 'more than 100 portal configurations: check the Dashboard by hand');
    const ours = (list?.data || []).find((x) => x.metadata?.gaia_config === PORTAL_CONFIG_KEY);
    if (ours) {
      const diff = portalDifferences(ours, p.params);
      result.portal = diff.length ? { status: 'conflict', configurationId: ours.id, differences: diff } : { status: 'exists', configurationId: ours.id };
    } else {
      const cfg = await stripe.post('/v1/billing_portal/configurations', p.params, { idempotencyKey: `gaia-setup-portal-${sha(JSON.stringify(p.params))}` });
      if (!cfg?.id || !/^bpc_/.test(cfg.id)) fail('PROVIDER_UNAVAILABLE', 'stripe returned no portal configuration');
      result.portal = { status: 'created', configurationId: cfg.id };
    }
  }
  return result;
}
