/** Gaia — live Shopify shop (public, no login).
 * Reads the gaiahealers.com Shopify catalog DIRECTLY from the browser (its
 * products.json is CORS-open, access-control-allow-origin: *), categorises it,
 * and renders scrollable product rows into #store-shop. "Buy" deep-links to the
 * Shopify product page — Shopify owns cart/checkout/payment, we don't rebuild it.
 * No backend, no API keys. Lazy-loads the first time the Store view opens.
 */
(function () {
  'use strict';
  if (!document.getElementById('store-products') && !document.getElementById('home-store')) return;

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
  // Canonical product tile (g-* system). Image + title + "View →"; no price
  // until the Storefront API returns correct market prices. Links to Shopify.
  function gTile(p) {
    const src = firstImage(p);
    const url = SHOP + '/products/' + p.handle;
    return '<a class="g-tile" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">'
      + '<span class="g-tile__media">' + (src ? '<img loading="lazy" src="' + esc(src) + '" alt="" />' : '') + '</span>'
      + '<span class="g-tile__title">' + esc(p.title) + '</span>'
      + '<span class="g-tile__meta">View →</span></a>';
  }

  async function fetchCollection(handle, limit) {
    try {
      const r = await fetch(SHOP + '/collections/' + handle + '/products.json?limit=' + limit, { headers: { Accept: 'application/json' } });
      if (!r.ok) return [];
      const d = await r.json();
      return Array.isArray(d.products) ? d.products : [];
    } catch (_) { return []; }
  }

  // STORE — "Shop" tab: full catalogue by category, g-* rails (galleries on desktop).
  async function loadStoreProducts() {
    const box = document.getElementById('store-products');
    if (!box || loaded) return;
    loaded = true;
    box.innerHTML = '<div class="g-store-cat"><div class="g-sk"><div class="g-sk-b big"></div><div class="g-sk-b w8"></div></div></div>';
    const results = await Promise.all(COLLECTIONS.map((c) => fetchCollection(c.handle, c.limit)));
    const seen = new Set();
    const html = [];
    COLLECTIONS.forEach((c, i) => {
      const take = (results[i] || [])
        .filter((p) => p && p.handle && !seen.has(p.handle) && (p.variants || []).some((v) => v.available !== false))
        .slice(0, c.limit);
      take.forEach((p) => seen.add(p.handle));
      if (!take.length) return;
      html.push('<section class="g-store-cat">'
        + '<div class="g-section"><div class="g-section__lead">'
        + '<h2 class="g-section__title">' + esc(c.title) + '</h2></div>'
        + '<a class="g-btn g-btn--ghost g-btn--sm g-section__action" href="' + SHOP + '/collections/' + esc(c.handle) + '" target="_blank" rel="noopener noreferrer">All →</a></div>'
        + '<div class="g-rail g-store-rail">' + take.map(gTile).join('') + '</div></section>');
    });
    if (html.length) {
      box.innerHTML = html.join('');
    } else {
      loaded = false;
      box.innerHTML = '<article class="g-card"><p class="g-card__value">The Gaia Healers store</p>'
        + '<p class="g-card__meta">Bio-Well devices, courses, Colour Energy, crystals, and more.</p>'
        + '<div class="g-card__actions"><a class="g-btn g-btn--primary g-btn--sm" href="' + SHOP + '" target="_blank" rel="noopener noreferrer">Open the store</a></div></article>';
    }
    window.dispatchEvent(new CustomEvent('gaia:shop-loaded', { detail: { categories: html.length } }));
  }

  function currentView() {
    return (window.GaiaAppShell && window.GaiaAppShell.currentView && window.GaiaAppShell.currentView())
      || new URLSearchParams(window.location.search).get('view') || 'today';
  }
  function maybeLoad() { if (currentView() === 'store') loadStoreProducts(); }

  // Store tabs: Shop | Membership (only one panel visible → shorter page).
  // `activate(key)` programatically selects a tab; `bindStoreTabs()` wires clicks.
  function activateStoreTab(key) {
    if (!key) return;
    const tabs = document.querySelectorAll('.g-store [data-store-tab]');
    if (!tabs.length) return;
    let target = null;
    tabs.forEach((t) => { if (t.dataset.storeTab === key) target = t; });
    if (!target) return; // requested tab doesn't exist → leave current
    tabs.forEach((t) => { const on = t === target; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', String(on)); });
    const products = document.getElementById('store-products');
    const members = document.getElementById('store-memberships');
    if (products) products.hidden = key !== 'shop';
    if (members) members.hidden = key !== 'membership';
  }
  function bindStoreTabs() {
    const tabs = document.querySelectorAll('.g-store [data-store-tab]');
    if (!tabs.length) return;
    tabs.forEach((tab) => tab.addEventListener('click', () => activateStoreTab(tab.dataset.storeTab)));
  }
  // Respond to programmatic navigation (e.g. Academy "Get access" → store/membership).
  // Without this, navigate('store', { tab: 'membership' }) opened the Store screen
  // but left the Shop tab active.
  window.addEventListener('gaia:route', (e) => {
    const d = (e && e.detail) || {};
    if (d.view === 'store' && d.tab) activateStoreTab(d.tab);
  });
  // Expose for other modules to call directly.
  window.GaiaStoreTabs = { activate: activateStoreTab };

  window.addEventListener('gaia:route', maybeLoad);
  document.addEventListener('DOMContentLoaded', () => { maybeLoad(); bindStoreTabs(); });

  // HOME "From the store" rail — a few real tiles, lazy after first paint.
  let homeLoaded = false;
  async function loadHomeFeatured() {
    const box = document.getElementById('home-store');
    if (!box || homeLoaded) return;
    homeLoaded = true;
    const ps = (await fetchCollection('avada-best-sellers', 12))
      .filter((p) => p && p.handle && (p.variants || []).some((v) => v.available !== false))
      .slice(0, 8);
    if (!ps.length) { homeLoaded = false; return; }
    box.innerHTML = '<div class="g-section"><div class="g-section__lead">'
      + '<span class="g-section__kicker">Discover</span><h2 class="g-section__title">From the store</h2></div>'
      + '<a class="g-btn g-btn--ghost g-btn--sm g-section__action" href="home.html?view=store">All →</a></div>'
      + '<div class="g-rail">' + ps.map(gTile).join('') + '</div>';
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
  window.GaiaStore = { load: loadStoreProducts, shopBase: SHOP, chakraShopUrl: chakraShopUrl, colourFor: (id) => CHAKRA_COLOUR[String(id || '').toLowerCase()] || '' };
})();
