/**
 * Gaia's canonical products, as the audit established them.
 *
 * Every entry here is grounded in observed evidence — a SKU, a price identity,
 * an order count — rather than in a product title. Where the business rule is
 * genuinely undecided the effect is `pending`, which means the product is fully
 * identified and grants nothing.
 *
 * Three policies are pending by decision, not by omission:
 *   - the Bio-Well software subscription
 *   - what an Elevate ticket unlocks inside the app
 *   - promotional membership on a device purchase
 * Each carries a destination so a member can still be sent somewhere useful.
 */

const GAIA = 'https://gaiahealers.com';

/** A device: the only type that confers ownership of itself. */
const device = (key, brand, label, extra = {}) => ({
  key, brand, type: 'device', label,
  effects: [{
    entitlementType: 'device_owner', key, duration: { kind: 'perpetual' },
    policy: 'approved', refundRule: 'revoke',
    note: 'primary hardware — ownership is the whole point of the purchase',
  }],
  ...extra,
});

/**
 * An accessory: separately sold, and deliberately grants nothing.
 * A $99 glove must not make somebody a Bio-Well owner.
 */
const accessory = (key, brand, label) => ({
  key, brand, type: 'accessory', label,
  effects: [{
    entitlementType: 'device_owner', key, duration: { kind: 'perpetual' },
    policy: 'none',
    note: 'an accessory is not the primary device; it confers no ownership of one',
  }],
});

const retail = (key, label, brand = null) => ({ key, brand, type: 'consumable', label });

function defaultCatalogue() {
  const products = {};
  const add = (p) => { products[p.key] = p; };

  // ── Bio-Well ──────────────────────────────────────────────────────────────
  add(device('biowell-3', 'bio-well', 'Bio-Well 3.0'));
  add(device('biowell-element', 'bio-well', 'Bio-Well Element'));
  add(device('biowell-biocor', 'bio-well', 'Bio-Well Bio-Cor'));
  add(accessory('biowell-sputnik', 'bio-well', 'Sputnik Environment Sensor'));
  add(accessory('biowell-glove', 'bio-well', 'Bio-Well Glove'));
  add(accessory('biowell-water-sensor', 'bio-well', 'Bio-Well Water Sensor'));

  // Bundles. Composition comes from the products' own titles, descriptions and
  // SKU blocks — and the arithmetic agrees to the cent.
  add({
    key: 'biowell-accessory-pack', brand: 'bio-well', type: 'bundle',
    label: 'Bio-Well Accessory Pack',
    // Title, description and image filename all name four components; the
    // fourth is Bio-Cor, which is what closes the $617 → $1,316 gap exactly.
    components: [
      { productKey: 'biowell-sputnik' }, { productKey: 'biowell-glove' },
      { productKey: 'biowell-water-sensor' }, { productKey: 'biowell-biocor' },
    ],
  });
  add({
    key: 'biowell-holiday-bundle', brand: 'bio-well', type: 'bundle',
    label: 'Bio-Well Holiday Bundle',
    components: [
      { productKey: 'biowell-glove' }, { productKey: 'biowell-sputnik' },
      { productKey: 'biowell-water-sensor' },
    ],
  });
  add({
    key: 'biowell-3-biocor-package', brand: 'bio-well', type: 'bundle',
    label: 'Bio-Well 3.0 + Bio-Cor Package',
    components: [{ productKey: 'biowell-3' }, { productKey: 'biowell-biocor' }],
  });
  add({
    key: 'biowell-sputnik-package', brand: 'bio-well', type: 'bundle',
    label: 'Bio-Well + Sputnik Environment Package',
    components: [{ productKey: 'biowell-3' }, { productKey: 'biowell-sputnik' }],
  });
  add({
    key: 'biowell-water-sputnik', brand: 'bio-well', type: 'bundle',
    label: 'Water Sensor + Sputnik',
    components: [{ productKey: 'biowell-water-sensor' }, { productKey: 'biowell-sputnik' }],
  });

  // D3 — an explicitly sold licence. Identified precisely; grants nothing until
  // the duration and activation rules are approved.
  add({
    key: 'biowell-software-1y', brand: 'bio-well', type: 'software',
    label: 'Bio-Well One Year Subscription',
    effects: [{
      entitlementType: 'device_software', key: 'biowell-suite',
      duration: { kind: 'term', months: 12, from: 'purchase' },
      policy: 'pending', refundRule: 'revoke_remaining_term',
      note: 'D3 pending: a device purchase never implies software, but an explicitly sold licence may — awaiting approval of term and activation',
    }],
    presentation: { destination: `${GAIA}/products/bio-well-one-year-subscription`, note: 'send the member to the vendor software page meanwhile' },
  });

  // Courses. One canonical course, several delivery modes.
  add({
    key: 'course-biowell-advanced-l1', brand: 'bio-well', type: 'course',
    label: 'Bio-Well Advanced Level 1 Certification',
    variants: [
      { key: 'in_person', label: 'In person' },
      { key: 'virtual', label: 'Virtual' },
      { key: 'private', label: 'Private one-to-one' },
    ],
    effects: [{
      entitlementType: 'course_access', key: 'biowell-advanced-l1',
      duration: { kind: 'perpetual' }, policy: 'pending', refundRule: 'propose_revoke',
      note: 'the GHL offer id this unlocks is not readable from any commerce data — needs looking up in the GHL admin',
    }],
  });

  // ── other device families ─────────────────────────────────────────────────
  add(device('biopulsar-organ', 'biopulsar', 'Biopulsar Reflexograph — Organ'));
  add(device('biopulsar-aura-chakra', 'biopulsar', 'Biopulsar Reflexograph — Chakra & Aura'));
  add(device('biopulsar-complete', 'biopulsar', 'Biopulsar Reflexograph — Aura, Chakra & Organ'));
  add(device('biopulsar-two-hand-upgrade', 'biopulsar', 'Biopulsar Two-Hand-Plate Upgrade'));
  add(device('biotekna-tomeex', 'biotekna', 'BioTekna TomEEX'));
  add(device('biotekna-regmatex', 'biotekna', 'BioTekna RegMatEx'));
  add(device('biotekna-bia-acc', 'biotekna', 'BioTekna BIA-ACC'));
  add(device('biotekna-heg', 'biotekna', 'BioTekna HEG'));
  add(device('biotekna-ppg', 'biotekna', 'BioTekna PPG Stress Flow'));
  add(device('biotekna-ans-control', 'biotekna', 'BioTekna Remote ANS Control'));
  add(device('healeex', 'healeex', 'Hybrid Plasma Healeex Device'));
  add({
    key: 'healeex-biowell-combo', brand: 'healeex', type: 'bundle',
    label: 'Healeex + Bio-Well Combo',
    components: [{ productKey: 'healeex' }, { productKey: 'biowell-3' }],
  });

  // ── events ────────────────────────────────────────────────────────────────
  // D5 — tickets are identified precisely. What they unlock inside the app is
  // undecided, so the effect is pending and the member is sent to the event.
  const ticket = (key, label, tier) => ({
    key, brand: 'event', type: 'ticket', label,
    effects: [{
      entitlementType: 'event_ticket', key: 'elevate-2026',
      value: { tier },
      duration: { kind: 'event', eventKey: 'elevate-2026' },
      policy: 'pending', refundRule: 'revoke_if_before_event',
      note: 'D5 pending: the Event system already knows who holds a ticket — Gaia must not duplicate or replace that authority',
    }],
    presentation: { destination: 'https://gaiahealers.app/home.html?view=events' },
  });
  add(ticket('elevate-2026-ga', 'Elevate 2026 General Admission', 'ga'));
  add(ticket('elevate-2026-vip', 'Elevate 2026 VIP', 'vip'));
  add(ticket('elevate-2026-exhibit', 'Conference Exhibit Pass', 'exhibit'));
  add(ticket('elevate-2026-speaker', 'Conference Speaker Access', 'speaker'));
  add(ticket('elevate-2026-ambassador', 'The Ambassador', 'ambassador'));
  add(ticket('elevate-2026-connector', 'The Connector', 'connector'));
  add(ticket('elevate-2026-legacy', 'The Legacy Partner', 'legacy_partner'));

  // ── membership ────────────────────────────────────────────────────────────
  // Identified so a Silver subscription is describable in the same vocabulary,
  // but commerce never writes membership.key — the membership pipeline owns it.
  for (const [key, label] of [['silver', 'Silver'], ['gold', 'Gold'], ['diamond', 'Diamond']]) {
    add({
      key: `membership-${key}`, brand: 'membership', type: 'membership',
      label: `Gaia Healers ${label}`,
      variants: [{ key: 'monthly', label: 'Monthly' }, { key: 'annual', label: 'Annual' }],
      effects: [{
        entitlementType: 'membership_deferred', key,
        duration: { kind: 'billing' }, policy: 'none',
        note: 'membership is resolved from canonical billing ids by the membership pipeline, never from a product mapping',
      }],
    });
  }

  // ── sessions ──────────────────────────────────────────────────────────────
  // D8 — 82 observed bookings, all consumed on the day. Commerce records them;
  // the ledger does not. `session` cannot carry an effect at all.
  add({ key: 'session-consultation', brand: null, type: 'session', label: 'Booked consultation' });

  // ── non-products ──────────────────────────────────────────────────────────
  // 29 order lines: "Custom Item", a product called tax, instalments, and
  // several lines titled with the customer's own name at a point of sale.
  add({ key: 'non-product-custom-item', type: 'non_product', label: 'Custom item (point of sale)' });
  add({ key: 'non-product-tax', type: 'non_product', label: 'Tax line' });
  add({ key: 'non-product-instalment', type: 'non_product', label: 'Instalment / part payment' });

  add(retail('retail-general', 'Retail product'));
  return { version: 1, updatedAt: null, products };
}

export { defaultCatalogue };
