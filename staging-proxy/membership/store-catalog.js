/**
 * Gaia store shadow catalogue.
 *
 * Gaia keeps its own copy of what Shopify sells so the store can be browsed,
 * searched and organised the way Gaia wants — while Shopify stays the authority
 * for price, stock, checkout and payment. Buying always leaves for Shopify; no
 * payment detail ever enters Gaia.
 *
 * The sync is an observation, never a decision:
 *
 *   - it never overwrites a mapping a person made in the product registry
 *   - it never deletes. A product that stops appearing is marked unobserved,
 *     because a transient Shopify hiccup must not empty the Gaia store
 *   - it produces a diff, so a price change is something an operator is told
 *     about rather than something that silently happens
 *
 * It grants nothing. A catalogue entry is a thing for sale, not a right anybody
 * holds; entitlements only ever come from an order, through the pipeline.
 */

const CONTROL = /[\x00-\x1F\x7F]/g;
const clean = (value, max = 400) => String(value ?? '').replace(CONTROL, '').trim().slice(0, max);

/**
 * Categories Gaia presents, in Gaia's order.
 *
 * Deliberately not Shopify's structure. The audit found sixteen Bio-Well
 * listings and 102 products with no useful grouping — a customer should meet a
 * short, honest shelf, not the raw catalogue.
 */
const STORE_CATEGORIES = [
  { key: 'devices-biowell', label: 'Bio-Well', family: 'bio-well', order: 1 },
  { key: 'devices-biopulsar', label: 'BioPulsar', family: 'biopulsar', order: 2 },
  { key: 'devices-biotekna', label: 'BioTekna', family: 'biotekna', order: 3 },
  { key: 'devices-healeex', label: 'Healeex', family: 'healeex', order: 4 },
  { key: 'training', label: 'Courses & Training', family: 'training', order: 5 },
  { key: 'events', label: 'Events', family: 'event', order: 6 },
  { key: 'accessories', label: 'Accessories', family: 'accessory', order: 7 },
  { key: 'therapy-tools', label: 'Light & Sound Therapy', family: 'therapy', order: 8 },
  { key: 'colour-energy', label: 'Colour Energy', family: 'colour', order: 9 },
  { key: 'oils', label: 'Essential Oils & Blends', family: 'oils', order: 10 },
  { key: 'sprays', label: 'Sprays & Mists', family: 'sprays', order: 11 },
  { key: 'crystals', label: 'Crystals & Malas', family: 'crystals', order: 12 },
  { key: 'supplements', label: 'Supplements', family: 'supplements', order: 13 },
  { key: 'jiva', label: 'Jiva & Water', family: 'jiva', order: 14 },
  { key: 'wellbeing', label: 'Wellbeing & Tools', family: 'retail', order: 15 },
];

/**
 * A display-only shelf guess, used when nobody has mapped a product yet.
 *
 * This is presentation and nothing else. It decides which heading a card sits
 * under; it can never decide what a purchase grants — that comes only from a
 * canonical mapping a person confirmed. Keeping the two apart is the whole
 * point: guessing a shelf from a title is harmless, guessing an entitlement
 * from a title is how somebody gets a device they never bought.
 */
const DISPLAY_FAMILY_HINTS = [
  // Ordered: the device families win before the generic words. "Bio-Well Water
  // Sensor" must shelve under Bio-Well, not under water.
  ['bio-well', /bio-?well|bio-?cor|sputnik/i],
  ['biopulsar', /biopulsar/i],
  ['biotekna', /biotekna|regmatex|bia-acc|tomeex/i],
  ['healeex', /healeex/i],
  ['event', /elevate|conference|admission|\bvip\b/i],
  ['training', /certificat|course|training/i],
  ['colour', /colour|chakra (tool|kit)|personality test|booklet/i],
  ['therapy', /chromalight|light therapy|tachyon|braintap|sound|biophoton|heartmath|smart ring|pointoselect|auriculo/i],
  ['supplements', /stemregen|gematria|phyto|nitroxx|methusalife|systema|micro daily/i],
  ['sprays', /spray|mist|inhaler/i],
  ['oils', /essential oil|roll-on|blend/i],
  ['crystals', /crystal|mala|geometry|necklace|quartz/i],
  ['jiva', /jiva|yami|dihanga|jahnavi|vipasa|water/i],
];

function displayFamily(product) {
  const haystack = `${product.title} ${product.productType || ''}`;
  for (const [family, pattern] of DISPLAY_FAMILY_HINTS) {
    if (pattern.test(haystack)) return family;
  }
  return null;
}

/**
 * Ask Shopify's CDN for an image the size we actually render.
 *
 * The feed links full-resolution originals — the first product's photo is
 * 3,360px wide for a card that displays it at about 200. Shopify resizes on
 * request, so asking costs nothing and saves the member megabytes per shelf.
 */
function sizedImage(src, width = 600) {
  const url = clean(src, 400);
  if (!url || !url.includes('cdn.shopify.com')) return url;
  return url + (url.includes('?') ? '&' : '?') + `width=${width}`;
}

/**
 * Decode the handful of entities Shopify descriptions actually contain.
 *
 * Not a general HTML parser — just enough that "FAST &amp; FREE Shipping" reads
 * as a person wrote it rather than as markup.
 */
const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—', '&hellip;': '…', '&rsquo;': '’', '&lsquo;': '‘',
};

function decodeEntities(text) {
  return String(text)
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp|ndash|mdash|hellip|rsquo|lsquo);/g, (m) => ENTITIES[m] || m)
    .replace(/&#(\d{2,5});/g, (_, code) => {
      const n = Number(code);
      return n > 31 && n < 0x10ffff ? String.fromCodePoint(n) : '';
    });
}

/** A price string from Shopify, normalised to a number of cents. */
function toCents(value) {
  const raw = String(value ?? '');
  // An unparseable price is unknown, not free. Stripping non-digits from
  // "free" leaves an empty string, and Number('') is 0 — which would put a
  // $2,299 device on the shelf at nothing.
  if (!/\d/.test(raw)) return null;
  const amount = Number(raw.replace(/[^0-9.]/g, ''));
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/**
 * Format a price WITH its currency, always.
 *
 * Shopify Markets serves a different currency depending on where the request
 * comes from, and products.json carries no currency field at all — so a bare
 * "2036.95" is genuinely ambiguous. The sync pins a market and records which,
 * and every rendered price says so, because an unlabelled number that turns
 * into a different figure at checkout is worse than no number.
 */
const money = (cents, currency = 'USD') => {
  if (cents == null) return null;
  const amount = (cents / 100).toFixed(2).replace(/\.00$/, '');
  return currency === 'USD' ? `$${amount} USD` : `${amount} ${currency}`;
};

/**
 * Normalise one Shopify product into the shape Gaia stores.
 *
 * Only what the public storefront actually exposes — nothing inferred. The
 * variant id is captured because it is what a future Orders adapter will map
 * to a canonical product.
 */
function normalizeShopifyProduct(product, { now = new Date() } = {}) {
  const id = clean(product?.id, 40);
  if (!id) return null;
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const images = Array.isArray(product?.images) ? product.images : [];
  const first = variants[0] || {};

  return {
    system: 'shopify',
    externalId: id,
    handle: clean(product.handle, 160),
    title: clean(product.title, 200),
    // Tags become spaces so words never run together, entities are decoded so a
    // member never reads "&amp;", then runs of whitespace collapse.
    description: clean(decodeEntities(String(product.body_html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' '), 1200),
    vendor: clean(product.vendor, 120),
    productType: clean(product.product_type, 120),
    tags: Array.isArray(product.tags) ? product.tags.slice(0, 20).map((t) => clean(t, 60)) : [],
    images: images.slice(0, 6).map((img) => sizedImage(img?.src)).filter(Boolean),
    // The lowest variant price, not merely the first. "Aura Cleanser 30ml /
    // 120ml" lists at 7.99 and 19.99; showing whichever happened to come first
    // would quote a price the customer may not be able to get.
    priceCents: (() => {
      const all = variants.map((v) => toCents(v.price)).filter((c) => c != null);
      return all.length ? Math.min(...all) : toCents(first.price);
    })(),
    priceVaries: (() => {
      const all = variants.map((v) => toCents(v.price)).filter((c) => c != null);
      return all.length > 1 && Math.min(...all) !== Math.max(...all);
    })(),
    // Shopify writes 0 when there is no "was" price. Rendering that gives a
    // struck-through "$0 USD" beside the real figure, which reads as broken at
    // best and deceptive at worst.
    compareAtCents: toCents(first.compare_at_price) || null,
    // Shopify's public feed reports availability per variant; absent means we
    // do not know, which is different from out of stock.
    available: variants.some((v) => v.available === true) ? true
      : (variants.every((v) => v.available === false) ? false : null),
    variants: variants.slice(0, 25).map((v) => ({
      variantId: clean(v.id, 40),
      title: clean(v.title, 120),
      priceCents: toCents(v.price),
      available: typeof v.available === 'boolean' ? v.available : null,
    })),
    url: `https://gaiahealers.com/products/${clean(product.handle, 160)}`,
    observed: true,
    firstObservedAt: now.toISOString(),
    lastObservedAt: now.toISOString(),
  };
}

function emptyCatalog() {
  return {
    version: 1, syncedAt: null, origin: null, products: {}, lastDiff: null,
    // Which market the prices belong to, and whether we confirmed it against
    // the storefront rather than assuming.
    currency: null, market: null, priceVerified: false,
  };
}

/**
 * Fold a freshly fetched catalogue into the stored one.
 *
 * Returns the next catalogue and a diff describing exactly what changed. The
 * diff is the point: an operator should hear "Shopify raised Bio-Well by $200"
 * rather than discover it later in a customer complaint.
 */
function syncCatalog(previous, fetched, {
  now = new Date(), origin = 'public-storefront',
  currency = null, market = null, priceVerified = false,
} = {}) {
  const catalog = {
    ...emptyCatalog(),
    ...previous,
    products: { ...(previous?.products || {}) },
  };
  const diff = { added: [], priceChanged: [], returned: [], unobserved: [], updated: 0 };
  const seen = new Set();

  for (const raw of fetched) {
    const next = normalizeShopifyProduct(raw, { now });
    if (!next) continue;
    seen.add(next.externalId);
    const before = catalog.products[next.externalId];

    if (!before) {
      catalog.products[next.externalId] = next;
      diff.added.push({ externalId: next.externalId, title: next.title, priceCents: next.priceCents });
      continue;
    }

    if (before.priceCents !== next.priceCents && before.priceCents != null && next.priceCents != null) {
      diff.priceChanged.push({
        externalId: next.externalId, title: next.title,
        fromCents: before.priceCents, toCents: next.priceCents,
      });
    }
    if (before.observed === false) {
      diff.returned.push({ externalId: next.externalId, title: next.title });
    }

    catalog.products[next.externalId] = {
      ...next,
      // Anything a person decided survives the sync untouched.
      firstObservedAt: before.firstObservedAt || next.firstObservedAt,
      canonical: before.canonical ?? null,
      curated: before.curated || null,
      hidden: before.hidden || false,
      previousPriceCents: before.priceCents !== next.priceCents ? before.priceCents : before.previousPriceCents || null,
    };
    diff.updated += 1;
  }

  // Nothing is ever deleted. A product Shopify stopped listing is marked
  // unobserved and keeps its history, so one bad fetch cannot empty the store.
  for (const [id, product] of Object.entries(catalog.products)) {
    if (seen.has(id)) continue;
    if (product.observed !== false) {
      diff.unobserved.push({ externalId: id, title: product.title });
    }
    catalog.products[id] = { ...product, observed: false };
  }

  catalog.syncedAt = now.toISOString();
  catalog.origin = clean(origin, 60);
  catalog.currency = currency ? clean(currency, 8) : null;
  catalog.market = market ? clean(market, 8) : null;
  catalog.priceVerified = Boolean(priceVerified);
  catalog.lastDiff = diff;
  return { catalog, diff };
}

/**
 * The catalogue as the app renders it.
 *
 * Grouped by Gaia's own categories via the canonical registry: sixteen Shopify
 * Bio-Well listings become one Bio-Well shelf. Products nobody has classified
 * still appear — under a general heading rather than hidden — because a
 * customer should never lose access to something Gaia genuinely sells just
 * because an operator has not filed it yet.
 */
function storeView(catalog, registry, { includeUnobserved = false } = {}) {
  // An unverified price is withheld rather than guessed at. The card still
  // sells the product; the figure simply comes from Shopify at the point it
  // can be trusted.
  const showPrices = catalog.priceVerified === true && Boolean(catalog.currency);
  const currency = catalog.currency || 'USD';
  const canonicalOf = (externalId) => {
    const mapping = registry?.mappings?.[`shopify:${externalId}`];
    return mapping?.canonical || null;
  };
  const familyOf = (canonicalKey) => registry?.canonical?.[canonicalKey]?.family || null;

  const sections = new Map(STORE_CATEGORIES.map((c) => [c.key, { ...c, products: [] }]));
  const other = { key: 'other', label: 'More from Gaia', order: 99, products: [] };

  for (const product of Object.values(catalog.products || {})) {
    if (product.hidden) continue;
    if (!product.observed && !includeUnobserved) continue;

    const canonicalKey = canonicalOf(product.externalId);
    // A confirmed mapping decides the shelf. Failing that, a title hint puts
    // the card somewhere sensible so the store is usable before anyone has
    // filed 102 products — and `shelvedBy` says which happened, so nobody
    // mistakes a display guess for a decision.
    const mapped = familyOf(canonicalKey);
    const family = mapped || displayFamily(product);
    const category = STORE_CATEGORIES.find((c) => c.family === family);
    const card = {
      externalId: product.externalId,
      title: product.title,
      // "From" is the honest word when the shelf cannot show every variant.
      price: showPrices
        ? (product.priceVaries
          ? `From ${money(product.priceCents, currency)}`
          : money(product.priceCents, currency))
        : null,
      // A "was" price is only shown when it is genuinely higher than the price,
      // and without repeating the currency — "$2500 USD $2648 USD" wrapped on a
      // phone and left a stray "USD" on its own line.
      compareAt: showPrices && product.compareAtCents > (product.priceCents || 0)
        ? money(product.compareAtCents, currency).replace(` ${currency}`, '') : null,
      priceUnavailable: !showPrices,
      image: product.images?.[0] || null,
      available: product.available,
      url: product.url,
      handle: product.handle,
      canonical: canonicalKey,
      shelvedBy: mapped ? 'registry' : (family ? 'title_hint' : 'none'),
      // Checkout is always Shopify. Gaia is the shelf, never the till.
      checkout: 'shopify',
    };
    (category ? sections.get(category.key) : other).products.push(card);
  }

  const list = [...sections.values(), other]
    .filter((section) => section.products.length)
    .sort((a, b) => a.order - b.order);
  for (const section of list) section.products.sort((a, b) => a.title.localeCompare(b.title));
  return {
    sections: list,
    syncedAt: catalog.syncedAt || null,
    currency: showPrices ? currency : null,
    // Shopify localises at checkout, so a member outside the synced market
    // will see their own currency there. Saying so is the honest framing.
    priceNote: showPrices ? `Prices shown in ${currency}. Your total is confirmed at checkout.` : null,
  };
}

/** A short, human sentence per change, for the audit log. */
function diffMessages(diff) {
  const out = [];
  for (const item of diff.added) out.push(`new Shopify product discovered, unmapped: ${item.title}`);
  for (const item of diff.priceChanged) {
    out.push(`price changed for ${item.title}: ${money(item.fromCents)} to ${money(item.toCents)}`);
  }

  for (const item of diff.returned) out.push(`${item.title} is listed again`);
  for (const item of diff.unobserved) out.push(`${item.title} no longer appears on Shopify — kept, marked unobserved`);
  return out;
}

/**
 * The action a member can take on a product.
 *
 * Navigation, never authorization. Which action appears is decided by what the
 * product IS and where Gaia can honestly send someone — never by what anybody
 * holds. A pending access policy changes the destination, never the entitlement.
 */
const MEMBER_ACTIONS = ['buy', 'learn_more', 'open_event', 'open_software', 'contact_gaia'];

function actionFor(product, canonical) {
  const type = canonical?.type || null;
  const destination = canonical?.presentation?.destination || null;

  if (type === 'ticket') {
    return { action: 'open_event', label: 'See the event', href: destination || null, external: false };
  }
  if (type === 'software') {
    return { action: 'open_software', label: 'Manage on Shopify', href: destination || product.url, external: true };
  }
  if (type === 'non_product' || type === 'session') {
    // Nothing to sell here. Say so rather than inventing a button.
    return { action: 'contact_gaia', label: 'Ask Gaia about this', href: null, external: false };
  }
  if (!product.url) {
    return { action: 'contact_gaia', label: 'Ask Gaia about this', href: null, external: false };
  }
  return product.available === false
    ? { action: 'learn_more', label: 'View on Shopify', href: product.url, external: true }
    : { action: 'buy', label: 'Buy on Shopify', href: product.url, external: true };
}

/**
 * One product, as a member should see it.
 *
 * Deliberately a hand-written projection rather than a spread of the stored
 * record: nothing internal can leak by being added upstream later. Mapping
 * status, confidence, canonical keys, policy states and evidence are all absent
 * by construction, and a test asserts it.
 */
function productDetail(catalog, registry, model, externalId, { currency = 'USD', showPrices = true } = {}) {
  const product = catalog.products?.[clean(externalId, 40)];
  if (!product || product.hidden) return null;

  const mapping = registry?.mappings?.[`shopify:${product.externalId}`];
  const canonical = mapping?.canonical ? model?.products?.[mapping.canonical] : null;

  // Bundle contents, named for a customer. What each part GRANTS is never
  // mentioned — composition is commerce, effects are the ledger's business.
  const contents = (canonical?.components || [])
    .map((component) => model?.products?.[component.productKey])
    .filter(Boolean)
    .map((component) => ({ title: component.label, quantity: 1 }));

  // Things from the same brand a member might reasonably want next. A family
  // relationship is presentational: it implies nothing about ownership.
  const related = canonical?.brand
    ? Object.values(model.products)
      .filter((other) => other.brand === canonical.brand && other.key !== canonical.key
        && ['device', 'accessory'].includes(other.type))
      .slice(0, 6)
      .map((other) => ({ title: other.label, kind: other.type }))
    : [];

  return {
    externalId: product.externalId,
    title: product.title,
    description: product.description || null,
    images: product.images || [],
    price: showPrices ? money(product.priceCents, currency) : null,
    compareAt: showPrices && product.compareAtCents > (product.priceCents || 0)
      ? money(product.compareAtCents, currency).replace(` ${currency}`, '') : null,
    priceVaries: Boolean(product.priceVaries),
    available: product.available,
    variants: (product.variants || []).slice(0, 12).map((v) => ({
      title: v.title,
      price: showPrices ? money(v.priceCents, currency) : null,
      available: v.available,
    })),
    // Customer-facing words only. "device" and "accessory" are things a person
    // recognises; canonical keys and policy states are not.
    kind: canonical ? canonical.type : null,
    brand: canonical?.brand || null,
    contents,
    related,
    ...actionFor(product, canonical),
  };
}

export {
  STORE_CATEGORIES,
  MEMBER_ACTIONS,
  decodeEntities,
  actionFor,
  productDetail,
  displayFamily,
  sizedImage,
  emptyCatalog,
  normalizeShopifyProduct,
  syncCatalog,
  storeView,
  diffMessages,
  toCents,
  money,
};
