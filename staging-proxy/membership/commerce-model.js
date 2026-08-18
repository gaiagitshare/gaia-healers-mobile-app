/**
 * The Gaia canonical commerce model.
 *
 * What Gaia sells, expressed in Gaia's own vocabulary, so Shopify, GHL, a point
 * of sale or a future vendor only ever has to translate into this — never the
 * other way round.
 *
 * The audit is what shaped it. "Bio-Well" turned out to be a brand containing
 * devices, accessories, bundles, courses and a software subscription; 29 order
 * lines turned out not to be products at all; and four BioPulsar listings that
 * looked like duplicates were four different machines. So:
 *
 *   BRAND      groups products for display. Implies nothing about access.
 *   PRODUCT    a stable Gaia identity with a type.
 *   VARIANT    size, model, delivery mode, term — never changes what it IS.
 *   COMPONENT  a bundle is composed of products Gaia already sells.
 *   EFFECT     what buying it may propose — with a policy state of its own.
 *
 * Two separations are load-bearing and enforced here rather than documented:
 *
 *   1. Identity and access are different decisions. A product can be perfectly
 *      well identified and still have no approved access policy. `pending` is
 *      structurally incapable of producing a proposal — not by convention, by
 *      the shape of the code.
 *
 *   2. Navigation is not authorization. A product may carry a destination so
 *      the app can send someone to the right place; that field can never
 *      become a right.
 */

const CONTROL = /[\x00-\x1F\x7F]/g;
const clean = (value, max = 200) => String(value ?? '').replace(CONTROL, '').trim().slice(0, max);

/**
 * What a product IS. Type drives everything downstream, which is why it is a
 * closed set — an unrecognised type must fail rather than default.
 */
const PRODUCT_TYPES = [
  'device',      // primary hardware — the only type that confers device ownership
  'accessory',   // sold separately, owns nothing of the primary device
  'course',      // training and certification
  'ticket',      // event admission and exhibitor packages
  'membership',  // defers entirely to the membership pipeline
  'session',     // a booked appointment. Commerce records it; the ledger does not
  'consumable',  // supplements, oils — retail with no access meaning
  'software',    // an explicitly sold licence or subscription
  'bundle',      // a commercial package of other products
  'non_product', // tax, instalments, "Custom Item", a customer's name at a till
];

/** Types that may never carry an effect, no matter what anyone approves. */
const EFFECTLESS_TYPES = ['non_product', 'session', 'consumable'];

/**
 * The state of an access policy, which is deliberately not the state of the
 * mapping. A product can be confidently identified while what it grants is
 * still an open business question.
 */
const EFFECT_POLICY_STATES = [
  'approved',  // reviewed and live — may produce a proposal
  'pending',   // identified, undecided — may produce navigation, never a right
  'none',      // decided: this product grants nothing
];

/**
 * How long an effect lasts. Structured because the alternative is reading
 * "1 Year" out of a product title and treating marketing copy as authorization.
 */
const DURATION_KINDS = ['perpetual', 'term', 'explicit', 'billing', 'event', 'period'];

function normalizeDuration(input) {
  if (!input || typeof input !== 'object') return { kind: 'perpetual' };
  const kind = clean(input.kind, 20);
  if (!DURATION_KINDS.includes(kind)) return { kind: 'perpetual' };
  switch (kind) {
    case 'term': return {
      kind,
      months: Number.isFinite(Number(input.months)) ? Number(input.months) : 12,
      from: clean(input.from, 20) || 'purchase',
    };
    case 'explicit': return { kind, startsAt: input.startsAt || null, endsAt: input.endsAt || null };
    case 'billing': return { kind, until: clean(input.until, 20) || 'period_end' };
    case 'event': return { kind, eventKey: clean(input.eventKey, 60) || null };
    case 'period': return { kind, period: clean(input.period, 20) || 'month' };
    default: return { kind: 'perpetual' };
  }
}

/** Resolve a duration into concrete dates at the moment of a purchase. */
function resolveDuration(duration, { now = new Date() } = {}) {
  const d = normalizeDuration(duration);
  const startsAt = now.toISOString();
  switch (d.kind) {
    case 'term': {
      const end = new Date(now);
      end.setMonth(end.getMonth() + d.months);
      return { startsAt, expiresAt: end.toISOString(), basis: `term:${d.months}m` };
    }
    case 'explicit':
      return { startsAt: d.startsAt || startsAt, expiresAt: d.endsAt || null, basis: 'explicit' };
    case 'billing':
      // The membership pipeline owns the real end date; commerce only says it
      // is bound to the billing period rather than perpetual.
      return { startsAt, expiresAt: null, basis: 'billing_period' };
    case 'event':
      // Bound to the event, not to a date this file invents. The Event system
      // knows when it ends.
      return { startsAt, expiresAt: null, basis: `event:${d.eventKey || 'unknown'}` };
    case 'period':
      return { startsAt, expiresAt: null, basis: `period:${d.period}` };
    default:
      return { startsAt, expiresAt: null, basis: 'perpetual' };
  }
}

/** What a refund does, decided per product type rather than by one blanket rule. */
const REFUND_RULES = ['revoke', 'revoke_remaining_term', 'propose_revoke', 'revoke_if_before_event', 'keep'];

const DEFAULT_REFUND_BY_TYPE = {
  device: 'revoke',                   // the hardware went back
  accessory: 'revoke',
  software: 'revoke_remaining_term',
  membership: 'revoke_remaining_term',
  course: 'propose_revoke',           // the material may already be consumed
  ticket: 'revoke_if_before_event',
  bundle: 'revoke',
};

function normalizeEffect(input, productType) {
  if (!input || typeof input !== 'object') return null;
  const entitlementType = clean(input.entitlementType, 40);
  if (!entitlementType) return null;
  // A type that cannot carry access does not get to carry one by mistake.
  if (EFFECTLESS_TYPES.includes(productType)) return null;
  const policy = EFFECT_POLICY_STATES.includes(input.policy) ? input.policy : 'pending';
  return {
    entitlementType,
    key: clean(input.key, 120),
    value: input.value && typeof input.value === 'object' ? input.value : {},
    duration: normalizeDuration(input.duration),
    refundRule: REFUND_RULES.includes(input.refundRule)
      ? input.refundRule
      : (DEFAULT_REFUND_BY_TYPE[productType] || 'keep'),
    policy,
    note: clean(input.note, 300),
  };
}

/**
 * Navigation, kept deliberately apart from effects.
 *
 * When a policy is pending the app still needs somewhere to send a member —
 * the vendor's software page, the event, the promotion. That is presentation.
 * These fields are never read by anything that decides access.
 */
function normalizePresentation(input) {
  if (!input || typeof input !== 'object') return {};
  const url = (value) => {
    const raw = clean(value, 300);
    return /^https:\/\//.test(raw) ? raw : null;
  };
  return {
    destination: url(input.destination),
    learnMoreUrl: url(input.learnMoreUrl),
    manageUrl: url(input.manageUrl),
    note: clean(input.note, 200),
  };
}

function normalizeProduct(key, input = {}) {
  const productKey = clean(key, 60);
  const type = clean(input.type, 20);
  if (!productKey || !PRODUCT_TYPES.includes(type)) return null;

  const effects = Array.isArray(input.effects)
    ? input.effects.map((e) => normalizeEffect(e, type)).filter(Boolean)
    : [];

  return {
    key: productKey,
    brand: clean(input.brand, 40) || null,
    type,
    label: clean(input.label, 120) || productKey,
    status: clean(input.status, 20) || 'active',
    variants: Array.isArray(input.variants)
      ? input.variants.map((v) => ({ key: clean(v.key, 40), label: clean(v.label, 120) })).filter((v) => v.key)
      : [],
    // Components belong to bundles alone. Anything else declaring them is a
    // modelling mistake, so they are dropped rather than half-honoured.
    components: type === 'bundle' && Array.isArray(input.components)
      ? input.components
        .map((c) => ({ productKey: clean(c.productKey, 60), quantity: Number(c.quantity) || 1 }))
        .filter((c) => c.productKey)
      : [],
    effects,
    presentation: normalizePresentation(input.presentation),
  };
}

/**
 * What buying this product proposes, right now.
 *
 * The single most important function here. It returns proposals ONLY for
 * approved effects; a pending policy comes back in `pending` with its
 * navigation, and can never appear in `proposals`. A bundle contributes
 * nothing of its own and resolves through its components instead.
 */
function effectsForPurchase(model, productKey, { now = new Date(), _seen = new Set() } = {}) {
  const product = model.products?.[clean(productKey, 60)];
  if (!product) {
    return { ok: false, reason: 'unknown_product', proposals: [], pending: [], destination: null };
  }
  // A cyclic bundle would otherwise recurse forever.
  if (_seen.has(product.key)) {
    return { ok: false, reason: 'cyclic_bundle', proposals: [], pending: [], destination: null };
  }
  _seen.add(product.key);

  if (product.type === 'non_product') {
    return {
      ok: true, product: product.key, type: product.type, reason: 'non_product',
      proposals: [], pending: [], destination: null,
    };
  }

  if (product.type === 'bundle') {
    const proposals = [];
    const pending = [];
    const components = [];
    for (const component of product.components) {
      const inner = effectsForPurchase(model, component.productKey, { now, _seen });
      components.push({ productKey: component.productKey, resolved: inner.ok, reason: inner.reason });
      proposals.push(...inner.proposals.map((p) => ({ ...p, viaBundle: product.key })));
      pending.push(...inner.pending.map((p) => ({ ...p, viaBundle: product.key })));
    }
    // A bundle may still carry an approved effect of its own when Gaia sells
    // something genuinely unique with it — but never a duplicate of a component.
    for (const effect of product.effects) {
      (effect.policy === 'approved' ? proposals : pending).push(buildLine(product, effect, now));
    }
    return {
      ok: true, product: product.key, type: 'bundle', components,
      proposals, pending,
      destination: product.presentation.destination || null,
      reason: proposals.length ? 'ok' : (pending.length ? 'policy_decision_required' : 'no_entitlement'),
    };
  }

  const proposals = [];
  const pending = [];
  for (const effect of product.effects) {
    if (effect.policy === 'approved') proposals.push(buildLine(product, effect, now));
    else if (effect.policy === 'pending') pending.push(buildLine(product, effect, now));
    // 'none' is a decision that it grants nothing — it produces neither.
  }

  return {
    ok: true,
    product: product.key,
    type: product.type,
    proposals,
    pending,
    destination: product.presentation.destination || null,
    learnMoreUrl: product.presentation.learnMoreUrl || null,
    reason: proposals.length ? 'ok' : (pending.length ? 'policy_decision_required' : 'no_entitlement'),
  };
}

function buildLine(product, effect, now) {
  const resolved = resolveDuration(effect.duration, { now });
  return {
    fromProduct: product.key,
    type: effect.entitlementType,
    key: effect.key,
    value: effect.value,
    starts_at: resolved.startsAt,
    expires_at: resolved.expiresAt,
    durationBasis: resolved.basis,
    refundRule: effect.refundRule,
    policy: effect.policy,
    note: effect.note || null,
  };
}

/** Change one product's access policy. Identity is untouched by this. */
function setEffectPolicy(model, productKey, entitlementType, policy, { note = '' } = {}) {
  const product = model.products?.[clean(productKey, 60)];
  if (!product) return { ok: false, reason: 'unknown_product' };
  if (!EFFECT_POLICY_STATES.includes(policy)) return { ok: false, reason: 'unknown_policy_state' };
  if (EFFECTLESS_TYPES.includes(product.type) && policy === 'approved') {
    return { ok: false, reason: `${product.type}_cannot_carry_access` };
  }
  const effect = product.effects.find((e) => e.entitlementType === entitlementType);
  if (!effect) return { ok: false, reason: 'unknown_effect' };
  const from = effect.policy;
  effect.policy = policy;
  if (note) effect.note = clean(note, 300);
  return { ok: true, from, to: policy, effect };
}

function emptyModel() {
  return { version: 1, updatedAt: null, products: {} };
}

function normalizeModel(stored) {
  const model = emptyModel();
  if (!stored || typeof stored !== 'object') return model;
  model.updatedAt = stored.updatedAt || null;
  for (const [key, value] of Object.entries(stored.products || {})) {
    const product = normalizeProduct(key, value);
    if (product) model.products[product.key] = product;
  }
  return model;
}

export {
  PRODUCT_TYPES,
  EFFECTLESS_TYPES,
  EFFECT_POLICY_STATES,
  DURATION_KINDS,
  REFUND_RULES,
  DEFAULT_REFUND_BY_TYPE,
  normalizeDuration,
  resolveDuration,
  normalizeEffect,
  normalizePresentation,
  normalizeProduct,
  effectsForPurchase,
  setEffectPolicy,
  emptyModel,
  normalizeModel,
};
