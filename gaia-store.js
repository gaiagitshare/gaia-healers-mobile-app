/** Gaia — the Gaia store (public, no login).
 *
 * Renders Gaia's OWN catalogue, synced daily from the public Shopify storefront
 * by the proxy and organised into Gaia's categories — so sixteen Shopify
 * Bio-Well listings become one Bio-Well shelf, and the store still works when
 * Shopify is slow or briefly unreachable.
 *
 * Shopify remains the authority for price, stock and checkout: "Buy" opens the
 * real product page and the purchase completes there. No cart, no payment
 * detail and no card ever touches Gaia.
 *
 * If the Gaia catalogue is unavailable, it falls back to reading Shopify's
 * CORS-open products.json directly, exactly as this file used to.
 */
(function () {
  'use strict';
  if (!document.getElementById('store-products') && !document.getElementById('home-store')) return;

  const SHOP = 'https://gaiahealers.com';
  const GAIA_API = (function () {
    try { if (window.location.hostname === 'api.gaiahealers.app') return ''; } catch (_) { /* ignore */ }
    return 'https://api.gaiahealers.app';
  }());
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
  const productsByHandle = new Map();
  let productModal = null;
  let productKeyHandler = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function firstImage(p) {
    const img = (p.images || [])[0];
    return img && img.src ? img.src : '';
  }
  // Prices come from Gaia's synced catalogue and are always rendered with
  // their currency. The old note here warned that products.json disagreed with
  // the retail page; the cause turned out to be Shopify Markets serving a
  // different currency by region, and the feed carrying no currency field at
  // all. The proxy now pins a market and verifies it against the retail page —
  // and when it cannot, the catalogue sends no price and the card says so
  // rather than showing a figure that would not match checkout.
  // Canonical product tile (g-* system). Product details open in a native app
  // sheet because Shopify blocks iframe embedding.
  function gTile(p) {
    const src = firstImage(p);
    productsByHandle.set(p.handle, p);
    return '<button type="button" class="g-tile" data-store-product="' + esc(p.handle) + '">'
      + '<span class="g-tile__media">' + (src ? '<img loading="lazy" src="' + esc(src) + '" alt="" />' : '') + '</span>'
      + '<span class="g-tile__title">' + esc(p.title) + '</span>'
      + '<span class="g-tile__meta">View in app →</span></button>';
  }

  function plainDescription(html) {
    try {
      const text = new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
      return text.length > 900 ? text.slice(0, 900).replace(/\s+\S*$/, '') + '…' : text;
    } catch (_) { return ''; }
  }

  function closeProduct() {
    if (productKeyHandler) document.removeEventListener('keydown', productKeyHandler);
    productKeyHandler = null;
    if (productModal) productModal.remove();
    productModal = null;
    document.body.classList.remove('gaia-booking-open');
  }

  function openProduct(p) {
    if (!p || !p.handle) return;
    closeProduct();
    const image = firstImage(p);
    const description = plainDescription(p.body_html);
    const url = SHOP + '/products/' + p.handle;
    productModal = document.createElement('div');
    productModal.className = 'gaia-booking-modal gaia-product-modal';
    productModal.innerHTML = '<div class="gaia-booking-modal__backdrop" data-product-close></div>'
      + '<section class="gaia-booking-modal__sheet" role="dialog" aria-modal="true" aria-labelledby="gaia-product-title">'
      + '<div class="gaia-booking-modal__head"><p class="gaia-booking-modal__title">Gaia Store</p>'
      + '<button type="button" class="gaia-booking-modal__close" data-product-close aria-label="Close product">&times;</button></div>'
      + '<div class="gaia-product-modal__body">'
      + (image ? '<img class="gaia-product-modal__image" src="' + esc(image) + '" alt="" />' : '')
      + '<div class="gaia-product-modal__content"><p class="gaia-product-modal__kicker">Gaia Healers</p>'
      + '<h2 class="gaia-product-modal__title" id="gaia-product-title">' + esc(p.title) + '</h2>'
      + (description ? '<p class="gaia-product-modal__description">' + esc(description) + '</p>' : '')
      + '<p class="gaia-product-modal__note">Product details stay here. Shopify handles current local pricing and secure payment.</p>'
      + '<a class="g-btn g-btn--primary gaia-product-modal__buy" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" data-external>Continue to secure purchase →</a>'
      + '</div></div></section>';
    document.body.appendChild(productModal);
    document.body.classList.add('gaia-booking-open');
    productModal.querySelectorAll('[data-product-close]').forEach((button) => button.addEventListener('click', closeProduct));
    productKeyHandler = (event) => { if (event.key === 'Escape') closeProduct(); };
    document.addEventListener('keydown', productKeyHandler);
    productModal.querySelector('.gaia-booking-modal__close')?.focus();
  }

  async function fetchCollection(handle, limit) {
    try {
      const r = await fetch(SHOP + '/collections/' + handle + '/products.json?limit=' + limit, { headers: { Accept: 'application/json' } });
      if (!r.ok) return [];
      const d = await r.json();
      return Array.isArray(d.products) ? d.products : [];
    } catch (_) { return []; }
  }

  /**
   * Gaia's own shelf. One request, already grouped and already deduplicated,
   * so the app is not doing seven Shopify round-trips on every store open.
   */
  async function fetchGaiaCatalog() {
    try {
      const r = await fetch(GAIA_API + '/api/store/catalog', { headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      const d = await r.json();
      return d && d.ok && Array.isArray(d.sections) && d.sections.length ? d : null;
    } catch (_) { return null; }
  }

  function gaiaTile(card) {
    // Long Shopify titles are common here — 31 of 102 exceed 60 characters,
    // one runs to 200. The card clamps the visible title and keeps the full
    // text available to screen readers and on hover.
    const title = esc(card.title);
    return '<article class="g-tile g-store-tile">'
      + (card.image
        ? '<div class="g-tile__media"><img src="' + esc(card.image) + '" alt="' + title + '" loading="lazy" /></div>'
        : '<div class="g-tile__media g-tile__media--empty" aria-hidden="true"></div>')
      + '<div class="g-tile__body">'
      + '<h3 class="g-tile__title g-clamp-2" title="' + title + '">' + title + '</h3>'
      + (card.price
        ? '<p class="g-tile__price">' + esc(card.price)
          + (card.compareAt ? ' <s class="g-tile__was">' + esc(card.compareAt) + '</s>' : '') + '</p>'
        : '<p class="g-tile__price g-tile__price--muted">Price shown on Shopify</p>')
      + (card.available === false ? '<p class="g-tile__meta">Currently unavailable</p>' : '')
      + '<div class="g-card__actions">'
      + '<a class="g-btn g-btn--primary g-btn--sm" href="' + esc(card.url) + '"'
      + ' target="_blank" rel="noopener noreferrer">'
      + (card.available === false ? 'View on Shopify' : 'Buy on Shopify')
      + '<span class="g-sr-only"> — ' + title + ', opens gaiahealers.com in a new tab</span></a>'
      + '</div></div></article>';
  }

  // STORE — "Shop" tab: full catalogue by category, g-* rails (galleries on desktop).
  async function loadStoreProducts() {
    const box = document.getElementById('store-products');
    if (!box || loaded) return;
    loaded = true;
    box.innerHTML = '<div class="g-store-cat"><div class="g-sk"><div class="g-sk-b big"></div><div class="g-sk-b w8"></div></div></div>';

    const gaia = await fetchGaiaCatalog();
    if (gaia) {
      box.innerHTML = gaia.sections.map((section) => '<section class="g-store-cat">'
        + '<div class="g-section"><div class="g-section__lead">'
        + '<h2 class="g-section__title">' + esc(section.label) + '</h2>'
        + '<p class="g-section__meta">' + section.products.length + ' item'
        + (section.products.length === 1 ? '' : 's') + '</p></div></div>'
        + '<div class="g-rail g-store-rail">' + section.products.map(gaiaTile).join('') + '</div></section>').join('')
        + (gaia.priceNote
          ? '<p class="g-store-note">' + esc(gaia.priceNote) + '</p>'
          : '<p class="g-store-note">Prices and availability are confirmed on Shopify at checkout.</p>');
      window.dispatchEvent(new CustomEvent('gaia:shop-loaded', { detail: { categories: gaia.sections.length } }));
      return;
    }

    // Fallback: Shopify direct, the original path.
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
        + '<h2 class="g-section__title">' + esc(c.title) + '</h2></div></div>'
        + '<div class="g-rail g-store-rail">' + take.map(gTile).join('') + '</div></section>');
    });
    if (html.length) {
      box.innerHTML = html.join('');
    } else {
      loaded = false;
      box.innerHTML = '<article class="g-card"><p class="g-card__value">The Gaia Healers store</p>'
        + '<p class="g-card__meta">Bio-Well devices, courses, Colour Energy, crystals, and more.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-store-retry>Try again</button></div></article>';
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
  document.addEventListener('click', (event) => {
    const tile = event.target.closest('[data-store-product]');
    if (tile) {
      event.preventDefault();
      openProduct(productsByHandle.get(tile.dataset.storeProduct));
      return;
    }
    if (event.target.closest('[data-store-retry]')) loadStoreProducts();
  });

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
  window.GaiaStore = { load: loadStoreProducts, shopBase: SHOP, chakraShopUrl: chakraShopUrl, colourFor: (id) => CHAKRA_COLOUR[String(id || '').toLowerCase()] || '', openProduct, closeProduct };
})();
