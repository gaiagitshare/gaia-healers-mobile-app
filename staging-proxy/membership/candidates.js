/**
 * Candidate mapping generation.
 *
 * Proposes which external product is which Gaia product, ranked by how good the
 * evidence is — and never approves anything. Every candidate lands in
 * `proposed`, and a person moves it to `mapped`.
 *
 * Evidence is used in order of how hard it is to fake:
 *
 *   1. SKU block — Shopify's own numbering separates atomic products
 *      (888333111100xx) from bundles (8888000012xx). Nobody wrote that for us.
 *   2. Exact price identity against a known canonical price.
 *   3. Composition arithmetic — a listed price equal to the sum of named parts.
 *   4. Title, last and lowest, because "Bio-Well Accessories … Learn about"
 *      is a course and "Golden Facial Nectar" matched a search for Gold.
 *
 * A candidate whose only evidence is its title is capped at low confidence,
 * which is the difference between a suggestion and a decision.
 */

const clean = (value, max = 200) => String(value ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);

const CONFIDENCE_ORDER = ['high', 'medium', 'low'];

/**
 * Known canonical prices, in cents, taken from the live catalogue. An exact
 * match is strong evidence; it is how the same device is recognised across two
 * platforms that share no identifiers at all.
 */
const PRICE_ANCHORS = {
  229900: 'biowell-3',
  500000: 'biowell-element',
  69900: 'biowell-biocor',
  34900: 'biowell-sputnik',
  9900: 'biowell-glove',
  16900: 'biowell-water-sensor',
  399900: 'healeex',
  999700: 'biopulsar-organ',
  1159700: 'biopulsar-aura-chakra',
  1619900: 'biopulsar-complete',
  799700: 'biopulsar-two-hand-upgrade',
  1899900: 'biotekna-tomeex',
  1599900: 'biotekna-regmatex',
  1499900: 'biotekna-bia-acc',
  1399900: 'biotekna-heg',
  999900: 'biotekna-ppg',
  49900: 'biotekna-ans-control',
};

/** Bundle SKUs observed in the live catalogue, with what they contain. */
const SKU_HINTS = {
  '888800001235': 'biowell-holiday-bundle',
  '888800001236': 'biowell-accessory-pack',
  '888800001238': 'biowell-water-sputnik',
  '888800009898': 'biowell-3-biocor-package',
  '888800005555': 'course-biowell-advanced-l1',
  '88833311110051': 'biowell-3',
  '88833311110039': 'biowell-sputnik',
  '88833311110052': 'biowell-glove',
  '88833311110053': 'biowell-water-sensor',
  '88833311110054': 'biowell-biocor',
};

/**
 * Titles that mean a line is not a product at all.
 *
 * The last pattern is the one that matters most: point-of-sale operators type
 * the customer's own name as the line item, so `Katarina @ 150.0` is a payment
 * record wearing a product's clothes.
 */
const NON_PRODUCT_PATTERNS = [
  [/^custom item/i, 'non-product-custom-item'],
  [/^tax$/i, 'non-product-tax'],
  [/\d(st|nd|rd|th)\s+payment|instal?ment|deposit|remaining for/i, 'non-product-instalment'],
];

/**
 * Point-of-sale lines are written as "X - X @ price", and X is sometimes the
 * customer's own name. Repetition alone proves nothing, though: "Healeex -
 * Healeex @ 3499.0" is a real device sold over a counter.
 *
 * So the discriminator is not the shape but whether the repeated text names
 * anything Gaia sells. If it does not, this is an ad-hoc till entry.
 */
const REPEATED_TITLE = /^(.{2,60}?)\s*-\s*\1(\s|@|$)/i;

/**
 * Words that mean the repeated text is describing a thing for sale rather than
 * naming a person. "High-Ticket Heart-Centered Sales" repeats like a till entry
 * and is a real programme with seven sales — an early version of this called it
 * a payment artifact with high confidence, which is exactly the confident wrong
 * answer the review boundary exists to prevent.
 */
const COMMERCE_VOCABULARY = /sales|course|training|package|device|pass|admission|session|therapy|sound|energy|health|combo|bundle|scan|event|learning|ticket|upgrade|subscription|program/i;

/** A personal name: a few plain words, no digits, no commerce vocabulary. */
function looksLikePersonalName(text) {
  if (/\d/.test(text) || COMMERCE_VOCABULARY.test(text)) return false;
  const words = text.trim().split(/\s+/);
  return words.length >= 1 && words.length <= 4 && words.every((w) => /^[\p{L}'’.-]+$/u.test(w));
}

/**
 * Returns 'name' when the repeated title looks like a person, 'unknown' when it
 * repeats but names something we cannot classify, and null when it does not
 * repeat at all. Only the first is confident enough to call a non-product.
 */
function adHocTillEntry(title) {
  const match = REPEATED_TITLE.exec(title);
  if (!match) return null;
  const repeated = match[1].trim();
  if (titleKey(repeated) !== null) return null;   // a real product sold at a till
  return looksLikePersonalName(repeated) ? 'name' : 'unknown';
}

/**
 * Wording that means the product teaches something, even when its title is
 * full of component names. "Bio-Well Accessories by Dr. Nima Farshid — Learn
 * about Sputnik" is a course; matching it on the word Sputnik would sell it as
 * a sensor.
 */
const EDUCATIONAL_PHRASING = /learn about|how to use|masterclass|workshop|webinar|q&a/i;

const SESSION_PATTERN = /\(via calendars\)|^scan\b|consultation/i;

/**
 * Title hints, used last and never alone for a bundle or a course.
 * Order matters: the specific beats the generic.
 */
const TITLE_HINTS = [
  [/accessory pack/i, 'biowell-accessory-pack'],
  [/holiday bundle/i, 'biowell-holiday-bundle'],
  [/water sensor \+ sputnik/i, 'biowell-water-sputnik'],
  [/bio-?well 3\.0 \+ bio-?cor/i, 'biowell-3-biocor-package'],
  [/bio-?well.*sputnik.*package|bio-?well \+ sputnik/i, 'biowell-sputnik-package'],
  [/healeex.*bio-?well combo|bio-?well.*healeex/i, 'healeex-biowell-combo'],
  [/one year subscription/i, 'biowell-software-1y'],
  [/certificat|level 1 training|advanced level 1/i, 'course-biowell-advanced-l1'],
  [/bio-?well element/i, 'biowell-element'],
  [/bio-?cor/i, 'biowell-biocor'],
  [/sputnik/i, 'biowell-sputnik'],
  [/^glove$|bio-?well glove/i, 'biowell-glove'],
  [/water sensor/i, 'biowell-water-sensor'],
  [/bio-?well 3|bio-?well$/i, 'biowell-3'],
  [/exhibit pass|exhibit hall/i, 'elevate-2026-exhibit'],
  [/speaker/i, 'elevate-2026-speaker'],
  [/ambassador/i, 'elevate-2026-ambassador'],
  [/connector/i, 'elevate-2026-connector'],
  [/legacy partner/i, 'elevate-2026-legacy'],
  [/\bvip\b/i, 'elevate-2026-vip'],
  [/general admission|admission/i, 'elevate-2026-ga'],
  [/healeex/i, 'healeex'],
];

/**
 * Propose a canonical product for one observation.
 *
 * Returns null when nothing can be said, which is a perfectly good answer and
 * far better than a low-confidence guess dressed as a mapping.
 */
function candidateFor(observation, { priceCents = null, sku = null } = {}) {
  const title = clean(observation.title, 200);
  const evidence = [];

  // 1 — a SKU is Shopify's own classification and cannot be a coincidence
  const skuKey = clean(sku, 40);
  if (skuKey && SKU_HINTS[skuKey]) {
    return mk(SKU_HINTS[skuKey], 'high', [`sku ${skuKey}`]);
  }

  // 2 — non-products, checked early: a name typed at a till must never reach
  //     the price or title matchers below
  for (const [pattern, key] of NON_PRODUCT_PATTERNS) {
    if (pattern.test(title)) return mk(key, 'high', ['title matches a payment artifact, not a product']);
  }
  const tillEntry = adHocTillEntry(title);
  if (tillEntry === 'name') {
    return mk('non-product-custom-item', 'medium',
      ['a repeated title that reads as a personal name — an ad-hoc point-of-sale line']);
  }
  if (tillEntry === 'unknown') {
    // It repeats like a till entry but names something with commercial words in
    // it. Saying nothing is the honest answer; a person can see it in review.
    return null;
  }
  // A teaching product must not be matched on a component named in its title.
  if (EDUCATIONAL_PHRASING.test(title)) {
    const course = /certificat|level 1|advanced/i.test(title) ? 'course-biowell-advanced-l1' : null;
    return course
      ? mk(course, 'low', ['educational phrasing with a certification reference'])
      : null;
  }
  if (SESSION_PATTERN.test(title)) {
    return mk('session-consultation', 'high', ['a booked appointment, consumed on the day']);
  }

  // 3 — exact price identity
  if (priceCents && PRICE_ANCHORS[priceCents]) {
    evidence.push(`price exactly $${(priceCents / 100).toFixed(2)}`);
    // A price match plus an agreeing title is as good as it gets without a SKU.
    const byTitle = titleKey(title);
    if (byTitle === PRICE_ANCHORS[priceCents]) {
      return mk(PRICE_ANCHORS[priceCents], 'high', [...evidence, 'title agrees']);
    }
    return mk(PRICE_ANCHORS[priceCents], 'medium', [...evidence, 'title does not corroborate']);
  }

  // 4 — title alone. Capped at low, deliberately.
  const key = titleKey(title);
  if (!key) return null;
  return mk(key, 'low', ['title only — no sku, no price anchor']);

  function mk(canonical, confidence, why) {
    return {
      canonical,
      confidence,
      evidence: why,
      // Never `mapped`. A candidate is a suggestion awaiting a person.
      state: 'proposed',
    };
  }
}

function titleKey(title) {
  for (const [pattern, key] of TITLE_HINTS) {
    if (pattern.test(title)) return key;
  }
  return null;
}

/**
 * Generate candidates for a whole registry, ordered by commercial importance.
 *
 * Sales first, because a product 603 people bought deserves a decision before
 * one nobody has ever ordered.
 */
function generateCandidates(registry, { catalog = null } = {}) {
  const out = [];
  for (const mapping of Object.values(registry.mappings || {})) {
    if (mapping.canonical) continue;   // already decided by a person
    const product = catalog?.products?.[mapping.externalId];
    const candidate = candidateFor(mapping, {
      priceCents: product?.priceCents ?? null,
      sku: product?.variants?.[0]?.sku ?? null,
    });
    out.push({
      system: mapping.system,
      externalId: mapping.externalId,
      title: mapping.title,
      orders: mapping.orders || 0,
      customers: mapping.customers || 0,
      candidate,
    });
  }
  out.sort((a, b) => (b.orders - a.orders)
    || CONFIDENCE_ORDER.indexOf(a.candidate?.confidence ?? 'low') - CONFIDENCE_ORDER.indexOf(b.candidate?.confidence ?? 'low'));
  return out;
}

/** How much of the business a set of candidates would cover, by sales. */
function candidateCoverage(candidates) {
  const totalOrders = candidates.reduce((sum, c) => sum + c.orders, 0);
  const withCandidate = candidates.filter((c) => c.candidate);
  const byConfidence = {};
  for (const level of CONFIDENCE_ORDER) {
    const set = withCandidate.filter((c) => c.candidate.confidence === level);
    byConfidence[level] = { products: set.length, orders: set.reduce((s, c) => s + c.orders, 0) };
  }
  return {
    products: candidates.length,
    withCandidate: withCandidate.length,
    withoutCandidate: candidates.length - withCandidate.length,
    totalOrders,
    ordersWithCandidate: withCandidate.reduce((s, c) => s + c.orders, 0),
    byConfidence,
  };
}

export {
  PRICE_ANCHORS,
  SKU_HINTS,
  NON_PRODUCT_PATTERNS,
  candidateFor,
  generateCandidates,
  candidateCoverage,
};
