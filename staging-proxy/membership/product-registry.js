/**
 * Canonical product registry — the bridge between what Gaia sells and what a
 * member ends up holding.
 *
 * The audit found one device answering to seventeen GHL product ids and
 * sixteen Shopify products, across two platforms, with names like "Custom Item"
 * on eleven orders over $1,000. No adapter can be correct against that. So an
 * external product id never means anything on its own: it must be mapped, by a
 * person, to a canonical Gaia key.
 *
 * Three rules the whole file exists to enforce:
 *
 *   1. An unmapped product proposes NOTHING. Silence is the safe default, and
 *      a product nobody has classified is not evidence of anything.
 *   2. A canonical key is a Gaia identity, never an external id. Shopify
 *      variant 45269826765087 and GHL product 6480f946… are both `biowell-3`.
 *   3. A purchase can never produce `device_software`. Marketing copy saying
 *      software is included is not a licence; only the vendor is.
 */

const CONTROL = /[\x00-\x1F\x7F]/g;
const clean = (value, max = 200) => String(value ?? '').replace(CONTROL, '').trim().slice(0, max);

/** Systems a product can come from. */
const PRODUCT_SYSTEMS = ['ghl', 'shopify', 'vendor', 'manual'];

/**
 * How sure we are that an external product means this canonical thing.
 *
 * `needs_review` is the default for everything the seed guessed from a title.
 * Only a person moves a row to `confirmed`, and only confirmed rows are allowed
 * to propose entitlements.
 */
const CONFIDENCE = ['confirmed', 'needs_review', 'rejected'];

/**
 * What an entitlement line is waiting on.
 *
 * `verified`        — the product unambiguously means this right
 * `policy_decision` — the business has not decided yet
 * `vendor_evidence` — only an external licence system can confirm it
 * `not_applicable`  — this product grants nothing of this kind
 */
const IMPLICATION_STATES = ['verified', 'policy_decision', 'vendor_evidence', 'not_applicable'];

/** Entitlement types a PURCHASE is ever allowed to propose. */
const PURCHASABLE_TYPES = [
  'device_owner', 'course_access', 'community_access', 'event_ticket', 'promo_membership', 'discount',
];

/**
 * Canonical Gaia products. Stable internal keys, chosen by us, that outlive
 * any catalogue tidy-up in GHL or Shopify.
 */
function defaultCanonicalProducts() {
  return {
    'biowell-3': { key: 'biowell-3', label: 'Bio-Well 3.0', family: 'bio-well', kind: 'device' },
    'biowell-element': { key: 'biowell-element', label: 'Bio-Well Element', family: 'bio-well', kind: 'device' },
    'biowell-biocor': { key: 'biowell-biocor', label: 'Bio-Well Bio-Cor', family: 'bio-well', kind: 'device' },
    'biowell-sputnik': { key: 'biowell-sputnik', label: 'Sputnik Environment Sensor', family: 'bio-well', kind: 'accessory' },
    'biowell-glove': { key: 'biowell-glove', label: 'Bio-Well Glove', family: 'bio-well', kind: 'accessory' },
    'biowell-water-sensor': { key: 'biowell-water-sensor', label: 'Bio-Well Water Sensor', family: 'bio-well', kind: 'accessory' },
    'biopulsar-organ': { key: 'biopulsar-organ', label: 'Biopulsar Organ Package', family: 'biopulsar', kind: 'device' },
    'biopulsar-aura-chakra': { key: 'biopulsar-aura-chakra', label: 'Biopulsar Chakra & Aura Package', family: 'biopulsar', kind: 'device' },
    'biopulsar-complete': { key: 'biopulsar-complete', label: 'Biopulsar Aura, Chakra & Organ', family: 'biopulsar', kind: 'device' },
    'biotekna-ans-control': { key: 'biotekna-ans-control', label: 'BioTekna Remote ANS Control', family: 'biotekna', kind: 'device' },
    'biotekna-regmatex': { key: 'biotekna-regmatex', label: 'BioTekna RegMatEx', family: 'biotekna', kind: 'device' },
    'biotekna-ppg': { key: 'biotekna-ppg', label: 'BioTekna PPG Stress Flow', family: 'biotekna', kind: 'device' },
    'biotekna-bia-acc': { key: 'biotekna-bia-acc', label: 'BioTekna BIA-ACC', family: 'biotekna', kind: 'device' },
    'biotekna-heg': { key: 'biotekna-heg', label: 'BioTekna HEG', family: 'biotekna', kind: 'device' },
    'biotekna-tomeex': { key: 'biotekna-tomeex', label: 'BioTekna TomEEX', family: 'biotekna', kind: 'device' },
    'healeex': { key: 'healeex', label: 'Hybrid Plasma Healeex Device', family: 'healeex', kind: 'device' },
    'elevate-2026-ga': { key: 'elevate-2026-ga', label: 'Elevate 2026 General Admission', family: 'event', kind: 'ticket' },
    'elevate-2026-vip': { key: 'elevate-2026-vip', label: 'Elevate 2026 VIP', family: 'event', kind: 'ticket' },
    'elevate-2026-exhibit': { key: 'elevate-2026-exhibit', label: 'Conference Exhibit Pass', family: 'event', kind: 'ticket' },
    'elevate-2026-speaker': { key: 'elevate-2026-speaker', label: 'Conference Speaker Access', family: 'event', kind: 'ticket' },
    'biowell-cert-l1': { key: 'biowell-cert-l1', label: 'Bio-Well Advanced Level 1 Certification', family: 'training', kind: 'course' },
    'nonaccess-retail': { key: 'nonaccess-retail', label: 'Retail — grants no access', family: 'retail', kind: 'none' },
  };
}

/**
 * What each canonical product may propose.
 *
 * Everything unresolved is stated as unresolved rather than guessed. Note that
 * no entry grants `device_software`: a device purchase and a software licence
 * are different rights with different authorities, which is the rule the
 * original proposal was most insistent about.
 */
function defaultImplications() {
  const device = (key) => [{ type: 'device_owner', key, state: 'verified' }];
  return {
    'biowell-3': [
      ...device('biowell-3'),
      { type: 'promo_membership', key: 'gold', state: 'policy_decision', note: 'duration and stacking undecided' },
      { type: 'device_software', key: 'biowell-suite', state: 'vendor_evidence', note: 'a purchase is not a licence' },
    ],
    'biowell-element': device('biowell-element'),
    'biowell-biocor': device('biowell-biocor'),
    'biowell-sputnik': [{ type: 'device_owner', key: 'biowell-sputnik', state: 'policy_decision', note: 'is an accessory device ownership?' }],
    'biowell-glove': [{ type: 'device_owner', key: 'biowell-glove', state: 'policy_decision', note: 'is an accessory device ownership?' }],
    'biowell-water-sensor': [{ type: 'device_owner', key: 'biowell-water-sensor', state: 'policy_decision', note: 'is an accessory device ownership?' }],
    'biopulsar-organ': device('biopulsar-organ'),
    'biopulsar-aura-chakra': device('biopulsar-aura-chakra'),
    'biopulsar-complete': device('biopulsar-complete'),
    'biotekna-ans-control': device('biotekna-ans-control'),
    'biotekna-regmatex': device('biotekna-regmatex'),
    'biotekna-ppg': device('biotekna-ppg'),
    'biotekna-bia-acc': device('biotekna-bia-acc'),
    'biotekna-heg': device('biotekna-heg'),
    'biotekna-tomeex': device('biotekna-tomeex'),
    'healeex': device('healeex'),
    'elevate-2026-ga': [{ type: 'event_ticket', key: 'elevate-2026-ga', state: 'verified' }],
    'elevate-2026-vip': [{ type: 'event_ticket', key: 'elevate-2026-vip', state: 'verified' }],
    'elevate-2026-exhibit': [{ type: 'event_ticket', key: 'elevate-2026-exhibit', state: 'verified' }],
    'elevate-2026-speaker': [{ type: 'event_ticket', key: 'elevate-2026-speaker', state: 'verified' }],
    'biowell-cert-l1': [{ type: 'course_access', key: 'biowell-cert-l1', state: 'policy_decision', note: 'which offer id does this unlock?' }],
    'nonaccess-retail': [],
  };
}

function emptyRegistry() {
  return {
    version: 1,
    updatedAt: null,
    canonical: defaultCanonicalProducts(),
    implications: defaultImplications(),
    mappings: {},        // `${system}:${externalId}` -> mapping
  };
}

const mappingId = (system, externalId) => `${clean(system, 20)}:${clean(externalId, 80)}`;

/**
 * Record that an external product exists.
 *
 * Observation is not classification: a discovered product lands unmapped, and
 * stays that way until a person decides. `orders` and `customers` are carried
 * so an operator can triage by what actually sold rather than by title.
 */
function observeProduct(registry, { system, externalId, variantId = null, title = '', orders = 0, customers = 0, domain = null }) {
  const sys = clean(system, 20);
  if (!PRODUCT_SYSTEMS.includes(sys)) return { ok: false, reason: 'unknown_system' };
  const id = clean(externalId, 80);
  if (!id) return { ok: false, reason: 'external_id_required' };

  const key = mappingId(sys, id);
  const existing = registry.mappings[key];
  registry.mappings[key] = {
    id: key,
    system: sys,
    externalId: id,
    variantId: clean(variantId, 80) || null,
    title: clean(title, 200),
    orders: Number(orders) || existing?.orders || 0,
    customers: Number(customers) || existing?.customers || 0,
    domain: clean(domain, 120) || existing?.domain || null,
    // Never inherited from a guess — a new product grants nothing.
    canonical: existing?.canonical ?? null,
    confidence: existing?.confidence || 'needs_review',
    note: existing?.note || '',
  };
  return { ok: true, mapping: registry.mappings[key], isNew: !existing };
}

/** Map an external product to a canonical Gaia product, or unmap it. */
function mapProduct(registry, { system, externalId, canonical, confidence = 'confirmed', note = '' }) {
  const key = mappingId(system, externalId);
  const mapping = registry.mappings[key];
  if (!mapping) return { ok: false, reason: 'unknown_product' };
  if (canonical !== null && !registry.canonical[canonical]) return { ok: false, reason: 'unknown_canonical_product' };
  if (!CONFIDENCE.includes(confidence)) return { ok: false, reason: 'unknown_confidence' };

  const from = mapping.canonical;
  mapping.canonical = canonical;
  mapping.confidence = canonical === null ? 'needs_review' : confidence;
  mapping.note = clean(note, 300);
  registry.updatedAt = new Date().toISOString();
  return { ok: true, mapping, from, to: canonical };
}

/**
 * What a purchase of this external product should propose.
 *
 * Returns [] unless the product is mapped AND confirmed AND the implication is
 * settled. Everything else is deliberately silent — an unclassified product,
 * an undecided business rule and a right that needs vendor evidence all
 * produce nothing rather than a guess.
 */
function entitlementsForPurchase(registry, { system, externalId }) {
  const mapping = registry.mappings[mappingId(system, externalId)];
  if (!mapping || !mapping.canonical) return { entitlements: [], reason: 'unmapped_product' };
  if (mapping.confidence !== 'confirmed') return { entitlements: [], reason: 'awaiting_review' };

  const lines = registry.implications[mapping.canonical] || [];
  const grantable = lines.filter((line) => line.state === 'verified'
    && PURCHASABLE_TYPES.includes(line.type));
  const withheld = lines.filter((line) => line.state !== 'verified' || !PURCHASABLE_TYPES.includes(line.type));

  return {
    canonical: mapping.canonical,
    entitlements: grantable.map((line) => ({ type: line.type, key: line.key })),
    withheld: withheld.map((line) => ({ type: line.type, key: line.key, state: line.state, note: line.note || null })),
    reason: grantable.length ? 'ok' : 'nothing_verified_yet',
  };
}

/** Registry health, for the Admin screen and for deciding when we are ready. */
function registryHealth(registry) {
  const mappings = Object.values(registry.mappings);
  const mapped = mappings.filter((m) => m.canonical && m.confidence === 'confirmed');
  const unmapped = mappings.filter((m) => !m.canonical);
  // Ordered by orders so an operator triages what actually sold, not the tail.
  const priority = unmapped
    .slice()
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 40);

  const clusters = {};
  for (const m of mapped) {
    clusters[m.canonical] = clusters[m.canonical] || { canonical: m.canonical, systems: {}, external: [] };
    clusters[m.canonical].systems[m.system] = (clusters[m.canonical].systems[m.system] || 0) + 1;
    clusters[m.canonical].external.push(`${m.system}:${m.externalId}`);
  }

  return {
    total: mappings.length,
    mapped: mapped.length,
    unmapped: unmapped.length,
    ordersCovered: mapped.reduce((sum, m) => sum + m.orders, 0),
    ordersUncovered: unmapped.reduce((sum, m) => sum + m.orders, 0),
    priority,
    clusters: Object.values(clusters).filter((c) => c.external.length > 1),
  };
}

function normalizeRegistry(stored) {
  const base = emptyRegistry();
  if (!stored || typeof stored !== 'object') return base;
  return {
    version: base.version,
    updatedAt: stored.updatedAt || null,
    canonical: { ...base.canonical, ...(stored.canonical || {}) },
    implications: { ...base.implications, ...(stored.implications || {}) },
    mappings: stored.mappings && typeof stored.mappings === 'object' ? stored.mappings : {},
  };
}

export {
  PRODUCT_SYSTEMS,
  CONFIDENCE,
  IMPLICATION_STATES,
  PURCHASABLE_TYPES,
  defaultCanonicalProducts,
  defaultImplications,
  emptyRegistry,
  normalizeRegistry,
  observeProduct,
  mapProduct,
  entitlementsForPurchase,
  registryHealth,
  mappingId,
};
