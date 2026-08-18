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
  { key: 'wellbeing', label: 'Wellbeing & Tools', family: 'retail', order: 8 },
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
  ['bio-well', /bio-?well|bio-?cor|sputnik/i],
  ['biopulsar', /biopulsar/i],
  ['biotekna', /biotekna|regmatex|bia-acc|tomeex/i],
  ['healeex', /healeex/i],
  ['event', /elevate|conference|admission|\bvip\b/i],
  ['training', /certificat|course|training/i],
];

function displayFamily(product) {
  const haystack = `${product.title} ${product.productType || ''}`;
  for (const [family, pattern] of DISPLAY_FAMILY_HINTS) {
    if (pattern.test(haystack)) return family;
  }
  return null;
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

const money = (cents) => (cents == null ? null : `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`);

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
    // Tags become spaces so words never run together, then runs of whitespace
    // collapse — otherwise every bit of inline markup leaves a visible gap.
    description: clean(String(product.body_html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '), 1200),
    vendor: clean(product.vendor, 120),
    productType: clean(product.product_type, 120),
    tags: Array.isArray(product.tags) ? product.tags.slice(0, 20).map((t) => clean(t, 60)) : [],
    images: images.slice(0, 6).map((img) => clean(img?.src, 400)).filter(Boolean),
    priceCents: toCents(first.price),
    compareAtCents: toCents(first.compare_at_price),
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
  return { version: 1, syncedAt: null, origin: null, products: {}, lastDiff: null };
}

/**
 * Fold a freshly fetched catalogue into the stored one.
 *
 * Returns the next catalogue and a diff describing exactly what changed. The
 * diff is the point: an operator should hear "Shopify raised Bio-Well by $200"
 * rather than discover it later in a customer complaint.
 */
function syncCatalog(previous, fetched, { now = new Date(), origin = 'public-storefront' } = {}) {
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
      price: money(product.priceCents),
      compareAt: money(product.compareAtCents),
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
  return { sections: list, syncedAt: catalog.syncedAt || null };
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

export {
  STORE_CATEGORIES,
  displayFamily,
  emptyCatalog,
  normalizeShopifyProduct,
  syncCatalog,
  storeView,
  diffMessages,
  toCents,
  money,
};
