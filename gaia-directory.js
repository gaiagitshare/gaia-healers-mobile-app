/** Gaia — Find a Gaia Healer (real practitioner directory).
 *
 * 100% real data, mirrored live from gaiapractitioners.com via the Gaia proxy
 * (/api/directory, /api/directory/:id). No mock practitioners, bios, reviews,
 * ratings, locations or photos. A rating shows ONLY when review_cnt > 0. If the
 * upstream is unavailable and no real cache exists, a truthful message is shown.
 */
(function () {
  'use strict';

  function proxyBase() {
    return String((window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
      || 'https://api.gaiahealers.app').replace(/\/+$/, '');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var mount = function () { return document.getElementById('directory-body'); };
  var ALL = [];
  var filters = { q: '', availability: '', specialty: '' };
  var loaded = false, loading = false;
  var map = null, cluster = null;

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/);
    return ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '');
  }

  function matches(p) {
    if (filters.availability && p.availability !== filters.availability) return false;
    if (filters.specialty) {
      var hay = (p.specialty.join(' ') + ' ' + p.tags.join(' ')).toLowerCase();
      if (hay.indexOf(filters.specialty.toLowerCase()) === -1) return false;
    }
    if (filters.q) {
      var q = filters.q.toLowerCase();
      var blob = (p.name + ' ' + p.city + ' ' + p.state + ' ' + p.specialty.join(' ') + ' ' + p.tags.join(' ')).toLowerCase();
      if (blob.indexOf(q) === -1) return false;
    }
    return true;
  }
  function filtered() { return ALL.filter(matches); }

  // Top specialties by frequency, for quick-filter chips.
  function topSpecialties(n) {
    var counts = {};
    ALL.forEach(function (p) { p.specialty.forEach(function (s) { var k = s.trim(); if (k) counts[k] = (counts[k] || 0) + 1; }); });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, n);
  }

  function ratingHtml(p) {
    if (!(p.reviewCnt > 0)) return '';
    var avg = (Math.round(p.reviewAvg * 10) / 10).toFixed(1);
    return '<span class="g-dir-card__rating"><i class="ph-fill ph-star"></i>' + esc(avg) + ' <small>(' + p.reviewCnt + ')</small></span>';
  }
  function availabilityBadge(p) {
    if (!p.availability) return '';
    var icon = p.availability === 'Remote' ? 'ph-video-camera' : (p.availability === 'In-person' ? 'ph-map-pin' : 'ph-globe-hemisphere-west');
    return '<span class="g-dir-card__avail"><i class="ph ' + icon + '"></i>' + esc(p.availability) + '</span>';
  }
  function photoHtml(p, cls) {
    if (p.image) return '<img class="' + cls + '" src="' + esc(p.image) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';" />'
      + '<span class="' + cls + ' g-dir-avatar" style="display:none">' + esc(initials(p.name)) + '</span>';
    return '<span class="' + cls + ' g-dir-avatar">' + esc(initials(p.name)) + '</span>';
  }

  function cardHtml(p) {
    var loc = [p.city, p.state].filter(Boolean).join(', ');
    var specs = p.specialty.slice(0, 3).map(function (s) { return '<span class="g-dir-chip">' + esc(s) + '</span>'; }).join('');
    return '<button type="button" class="g-dir-card" data-dir-open="' + esc(p.id) + '">'
      + '<span class="g-dir-card__photo">' + photoHtml(p, 'g-dir-card__img') + '</span>'
      + '<span class="g-dir-card__body">'
      + '<span class="g-dir-card__top"><strong>' + esc(p.name) + '</strong>' + ratingHtml(p) + '</span>'
      + (loc ? '<span class="g-dir-card__loc"><i class="ph ph-map-pin"></i>' + esc(loc) + '</span>' : '')
      + '<span class="g-dir-card__specs">' + specs + '</span>'
      + availabilityBadge(p)
      + '</span></button>';
  }

  function controlsHtml() {
    var avail = ['In-person', 'Remote', 'Both'];
    var availChips = '<button type="button" class="g-dir-fchip' + (filters.availability === '' ? ' is-on' : '') + '" data-dir-avail="">All</button>'
      + avail.map(function (a) { return '<button type="button" class="g-dir-fchip' + (filters.availability === a ? ' is-on' : '') + '" data-dir-avail="' + esc(a) + '">' + esc(a) + '</button>'; }).join('');
    var specChips = topSpecialties(10).map(function (s) {
      return '<button type="button" class="g-dir-schip' + (filters.specialty === s ? ' is-on' : '') + '" data-dir-spec="' + esc(s) + '">' + esc(s) + '</button>';
    }).join('');
    return '<div class="g-dir__controls">'
      + '<div class="g-dir__search"><i class="ph ph-magnifying-glass"></i>'
      + '<input type="search" data-dir-search placeholder="Search name, city, specialty…" value="' + esc(filters.q) + '" aria-label="Search practitioners" /></div>'
      + '<div class="g-dir__fchips">' + availChips + '</div>'
      + '<div class="g-dir__schips">' + specChips + '</div>'
      + '</div>';
  }

  function paintList() {
    var host = mount(); if (!host) return;
    var list = filtered();
    var listEl = host.querySelector('[data-dir-list]');
    var countEl = host.querySelector('[data-dir-count]');
    if (countEl) countEl.textContent = list.length + (list.length === 1 ? ' practitioner' : ' practitioners');
    if (listEl) {
      listEl.innerHTML = list.length
        ? list.map(cardHtml).join('')
        : '<p class="g-dir__empty">No practitioners match your search. Try clearing a filter.</p>';
    }
    // reflect active states on chips
    host.querySelectorAll('[data-dir-avail]').forEach(function (b) { b.classList.toggle('is-on', b.getAttribute('data-dir-avail') === filters.availability); });
    host.querySelectorAll('[data-dir-spec]').forEach(function (b) { b.classList.toggle('is-on', b.getAttribute('data-dir-spec') === filters.specialty); });
    updateMarkers(list);
  }

  function ensureMap() {
    if (map || !window.L) return;
    var el = document.getElementById('g-dir-map'); if (!el) return;
    map = window.L.map(el, { scrollWheelZoom: false, worldCopyJump: true }).setView([20, 0], 1);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '© OpenStreetMap'
    }).addTo(map);
    cluster = window.L.markerClusterGroup ? window.L.markerClusterGroup({ maxClusterRadius: 45 }) : window.L.layerGroup();
    map.addLayer(cluster);
  }
  function updateMarkers(list) {
    ensureMap(); if (!map || !cluster) return;
    cluster.clearLayers();
    var pts = [];
    list.forEach(function (p) {
      if (p.lat == null || p.lng == null) return;
      var m = window.L.marker([p.lat, p.lng]);
      var loc = [p.city, p.state].filter(Boolean).join(', ');
      m.bindPopup('<div class="g-dir-pop"><strong>' + esc(p.name) + '</strong>'
        + (loc ? '<span>' + esc(loc) + '</span>' : '')
        + (p.specialty[0] ? '<em>' + esc(p.specialty.slice(0, 2).join(', ')) + '</em>' : '')
        + '<button type="button" data-dir-open="' + esc(p.id) + '">View profile</button></div>');
      cluster.addLayer(m);
      pts.push([p.lat, p.lng]);
    });
    if (pts.length) { try { map.fitBounds(pts, { padding: [30, 30], maxZoom: 11 }); } catch (e) {} }
    setTimeout(function () { try { map.invalidateSize(); } catch (e) {} }, 60);
  }

  async function openProfile(id) {
    var overlay = document.createElement('div');
    overlay.className = 'gaia-dirprofile-modal';
    overlay.innerHTML = '<div class="gaia-dirprofile__panel" role="dialog" aria-modal="true"><button type="button" class="gaia-sheet-close" data-dp-close aria-label="Close">×</button><div data-dp-body><p class="g-dir__loading">Loading…</p></div></div>';
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';
    function close() { overlay.remove(); document.documentElement.style.overflow = ''; }
    overlay.querySelector('[data-dp-close]').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    var p = null;
    try { var r = await fetch(proxyBase() + '/api/directory/' + encodeURIComponent(id)); var j = await r.json(); if (j && j.ok) p = j.practitioner; } catch (e) {}
    if (!p) p = ALL.filter(function (x) { return String(x.id) === String(id); })[0] || null;
    var body = overlay.querySelector('[data-dp-body]');
    if (!p) { body.innerHTML = '<p class="g-dir__empty">This profile is unavailable right now.</p>'; return; }
    var loc = [p.city, p.state].filter(Boolean).join(', ');
    var specs = (p.specialty || []).map(function (s) { return '<span class="g-dir-chip">' + esc(s) + '</span>'; }).join('');
    var actions = '';
    if (p.meetingLink) actions += '<a class="g-btn g-btn--primary" href="' + esc(p.meetingLink) + '" target="_blank" rel="noopener noreferrer"><i class="ph ph-calendar-check"></i> Book a session</a>';
    if (p.profileLink) actions += '<a class="g-btn g-btn--secondary" href="' + esc(p.profileLink) + '" target="_blank" rel="noopener noreferrer"><i class="ph ph-arrow-up-right"></i> Website</a>';
    actions += '<a class="g-btn ' + (actions ? 'g-btn--ghost' : 'g-btn--secondary') + '" href="https://gaiapractitioners.com" target="_blank" rel="noopener noreferrer">View in directory</a>';
    body.innerHTML = '<div class="gaia-dirprofile__hero">' + photoHtml(p, 'gaia-dirprofile__img')
      + '<div><h2>' + esc(p.name) + '</h2>'
      + (loc ? '<p class="gaia-dirprofile__loc"><i class="ph ph-map-pin"></i>' + esc(loc) + '</p>' : '')
      + (p.availability ? availabilityBadge(p) : '') + ratingHtml(p) + '</div></div>'
      + (specs ? '<div class="gaia-dirprofile__specs">' + specs + '</div>' : '')
      + '<div class="gaia-dirprofile__actions">' + actions + '</div>'
      + '<p class="gaia-dirprofile__src">Live from the Gaia Healers practitioner directory.</p>';
  }

  function bind(host) {
    var s = host.querySelector('[data-dir-search]');
    if (s) { var t; s.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { filters.q = s.value.trim(); paintList(); }, 180); }); }
    host.addEventListener('click', function (e) {
      var av = e.target.closest('[data-dir-avail]');
      if (av) { filters.availability = av.getAttribute('data-dir-avail'); paintList(); return; }
      var sp = e.target.closest('[data-dir-spec]');
      if (sp) { var v = sp.getAttribute('data-dir-spec'); filters.specialty = (filters.specialty === v ? '' : v); paintList(); return; }
      var op = e.target.closest('[data-dir-open]');
      if (op) { openProfile(op.getAttribute('data-dir-open')); return; }
    });
    // popups are added to document by Leaflet — delegate at document level once
  }

  async function load() {
    if (loading) return; loading = true;
    var host = mount(); if (!host) { loading = false; return; }
    host.innerHTML = '<p class="g-dir__loading">Loading the practitioner directory…</p>';
    try {
      var r = await fetch(proxyBase() + '/api/directory');
      var j = await r.json();
      if (!j || !j.ok || !Array.isArray(j.practitioners)) {
        host.innerHTML = '<div class="g-dir__unavailable"><i class="ph ph-cloud-slash"></i><p>The practitioner directory is temporarily unavailable. Please try again shortly.</p><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-dir-retry>Try again</button></div>';
        host.querySelector('[data-dir-retry]')?.addEventListener('click', function () { loaded = false; load(); });
        loading = false; return;
      }
      ALL = j.practitioners;
      loaded = true;
      host.innerHTML = controlsHtml()
        + '<p class="g-dir__count" data-dir-count></p>'
        + '<div class="g-dir__map" id="g-dir-map"></div>'
        + '<div class="g-dir__list" data-dir-list></div>';
      bind(host);
      paintList();
    } catch (e) {
      host.innerHTML = '<div class="g-dir__unavailable"><i class="ph ph-cloud-slash"></i><p>Could not reach the practitioner directory. Please try again shortly.</p><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-dir-retry>Try again</button></div>';
      host.querySelector('[data-dir-retry]')?.addEventListener('click', function () { loaded = false; load(); });
    }
    loading = false;
  }

  function ensure() {
    if (!mount()) return;
    if (!loaded) load();
    else setTimeout(function () { if (map) try { map.invalidateSize(); } catch (e) {} }, 60);
  }

  // Delegate marker-popup "View profile" clicks (popups render outside the mount).
  document.addEventListener('click', function (e) {
    var op = e.target.closest('.g-dir-pop [data-dir-open]');
    if (op) openProfile(op.getAttribute('data-dir-open'));
  });

  window.addEventListener('gaia:route', function (e) { if (e.detail && e.detail.view === 'directory') ensure(); });
  // If the page loads directly on the directory view.
  if (new URLSearchParams(location.search).get('view') === 'directory') {
    document.addEventListener('DOMContentLoaded', ensure);
    if (document.readyState !== 'loading') ensure();
  }
})();
