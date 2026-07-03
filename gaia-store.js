/** Gaia — live Shopify shop (public, no login).
 * Reads the gaiahealers.com Shopify catalog DIRECTLY from the browser (its
 * products.json is CORS-open, access-control-allow-origin: *), categorises it,
 * and renders scrollable product rows into #store-shop. "Buy" deep-links to the
 * Shopify product page — Shopify owns cart/checkout/payment, we don't rebuild it.
 * No backend, no API keys. Lazy-loads the first time the Store view opens.
 */
(function () {
  'use strict';
  const shop = document.getElementById('store-shop');
  if (!shop) return; // store screen only

  const SHOP = 'https://gaiahealers.com';
  // Curated categories → real Shopify collection handles (verified live).
  const COLLECTIONS = [
    { title: 'Featured', handle: 'avada-best-sellers', limit: 12 },
    { title: 'Colour Energy', handle: 'colour-energy', limit: 12 },
    { title: 'Courses & certification', handle: 'biowell-courses', limit: 12 },
    { title: 'Bio-Well devices', handle: 'biowell-products', limit: 12 },
    { title: 'BioPulsar', handle: 'biopulsar', limit: 8 },
    { title: 'BioTekna', handle: 'biotekna-advanced-technologies', limit: 8 },
    { title: 'Crystals & tools', handle: 'crystals', limit: 12 },
  ];

  let loaded = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function firstImage(p) {
    const img = (p.images || [])[0];
    return img && img.src ? img.src : '';
  }
  // NOTE: we intentionally do NOT show the products.json price. That endpoint
  // returns a different Shopify Market's price than the retail page (observed a
  // consistent ~3.7x inflation, e.g. json $8,573 vs page $2,299). Correct
  // in-app pricing needs the Shopify Storefront API @inContext(country). Until
  // then we link out and the accurate price shows on the Shopify page.
  function productCard(p) {
    const src = firstImage(p);
    const url = SHOP + '/products/' + p.handle;
    return '<a class="gaia-shop-card" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">'
      + '<span class="gaia-shop-card__imgwrap">' + (src ? '<img loading="lazy" src="' + esc(src) + '" alt="" />' : '') + '</span>'
      + '<span class="gaia-shop-card__title">' + esc(p.title) + '</span>'
      + '<span class="gaia-shop-card__price">View →</span>'
      + '</a>';
  }

  async function fetchCollection(handle, limit) {
    try {
      const r = await fetch(SHOP + '/collections/' + handle + '/products.json?limit=' + limit, { headers: { Accept: 'application/json' } });
      if (!r.ok) return [];
      const d = await r.json();
      return Array.isArray(d.products) ? d.products : [];
    } catch (_) { return []; }
  }

  async function loadShop() {
    if (loaded) return;
    loaded = true;
    shop.innerHTML = '<p class="gaia-me-empty">Loading the Gaia store…</p>';
    const results = await Promise.all(COLLECTIONS.map((c) => fetchCollection(c.handle, c.limit)));

    const seen = new Set();
    const html = [];
    COLLECTIONS.forEach((c, i) => {
      const ps = (results[i] || []).filter((p) => {
        if (!p || !p.handle || seen.has(p.handle)) return false;   // de-dupe across categories
        const buyable = (p.variants || []).some((v) => v.available !== false);
        return buyable;
      });
      // keep at most `limit`, mark seen so a product shows once
      const take = ps.slice(0, c.limit);
      take.forEach((p) => seen.add(p.handle));
      if (!take.length) return;
      html.push(
        '<section class="gaia-shop-cat">'
        + '<div class="gaia-shop-cat__head">'
        + '<p class="gaia-me-card__label">' + esc(c.title) + '</p>'
        + '<a class="gaia-shop-cat__all" href="' + SHOP + '/collections/' + esc(c.handle) + '" target="_blank" rel="noopener noreferrer">All →</a>'
        + '</div>'
        + '<div class="gaia-shop-row">' + take.map(productCard).join('') + '</div>'
        + '</section>');
    });

    if (html.length) {
      shop.innerHTML = html.join('');
    } else {
      // network/blocked — never leave a dead section; link out to the shop.
      loaded = false;
      shop.innerHTML = '<article class="gaia-card gaia-card-pad gaia-me-card"><p class="gaia-me-card__label">Shop</p>'
        + '<p class="gaia-me-empty">Browse Bio-Well devices, courses, Colour Energy, crystals, and more at the Gaia Healers store.</p>'
        + '<a class="gaia-member-card__cta" href="' + SHOP + '" target="_blank" rel="noopener noreferrer">Open the store →</a></article>';
    }
    window.dispatchEvent(new CustomEvent('gaia:shop-loaded', { detail: { categories: html.length } }));
  }

  function currentView() {
    return (window.GaiaAppShell && window.GaiaAppShell.currentView && window.GaiaAppShell.currentView())
      || new URLSearchParams(window.location.search).get('view') || 'today';
  }
  function maybeLoad() { if (currentView() === 'store') loadShop(); }

  window.addEventListener('gaia:route', maybeLoad);
  document.addEventListener('DOMContentLoaded', maybeLoad);

  // HOME "From the store" rail — real product tiles (new g-* system, image only,
  // no price). Lightweight: one collection, lazy after first paint.
  let homeLoaded = false;
  async function loadHomeFeatured() {
    const box = document.getElementById('home-store');
    if (!box || homeLoaded) return;
    homeLoaded = true;
    const ps = (await fetchCollection('avada-best-sellers', 12))
      .filter((p) => p && p.handle && (p.variants || []).some((v) => v.available !== false))
      .slice(0, 8);
    if (!ps.length) { homeLoaded = false; return; }
    const tiles = ps.map((p) => {
      const src = firstImage(p);
      const url = SHOP + '/products/' + p.handle;
      return '<a class="g-tile" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">'
        + '<span class="g-tile__media">' + (src ? '<img loading="lazy" src="' + esc(src) + '" alt="" />' : '') + '</span>'
        + '<span class="g-tile__title">' + esc(p.title) + '</span>'
        + '<span class="g-tile__meta">View →</span></a>';
    }).join('');
    box.innerHTML = '<div class="g-section"><div class="g-section__lead">'
      + '<span class="g-section__kicker">Discover</span><h2 class="g-section__title">From the store</h2></div>'
      + '<a class="g-btn g-btn--ghost g-btn--sm g-section__action" href="home.html?view=store">All →</a></div>'
      + '<div class="g-rail">' + tiles + '</div>';
    box.hidden = false;
  }
  document.addEventListener('DOMContentLoaded', () => { window.setTimeout(loadHomeFeatured, 300); });

  // Chakra → Colour Energy cross-sell. Maps a chakra id to its Colour Energy
  // spray colour, and returns a Shopify link to the matching products (search is
  // robust regardless of what colours are in stock; falls back to the collection).
  const CHAKRA_COLOUR = {
    root: 'Red', sacral: 'Orange', solar: 'Yellow', heart: 'Green',
    throat: 'Blue', 'third-eye': 'Indigo', crown: 'Violet',
  };
  function chakraShopUrl(id) {
    const colour = CHAKRA_COLOUR[String(id || '').toLowerCase()];
    return colour
      ? SHOP + '/search?q=' + encodeURIComponent(colour + ' spray') + '&type=product'
      : SHOP + '/collections/colour-energy';
  }

  // expose for the chakra→Colour-Energy cross-sell and future callers
  window.GaiaStore = { load: loadShop, shopBase: SHOP, chakraShopUrl: chakraShopUrl, colourFor: (id) => CHAKRA_COLOUR[String(id || '').toLowerCase()] || '' };
})();
