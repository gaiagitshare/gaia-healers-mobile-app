/* Gaia Home v3 (12 Nov 2026): the hero search and "Recommended for you".
 *
 * Everything shown comes from the live practitioner directory (gaia-directory.js
 * -> /api/directory): real names, photos, cities, the next open time from the
 * hourly booking check. A distance appears only when the member has given a
 * location (Near me or a place they typed); without one the cards are the
 * soonest open times, and the heading says so. Nothing is invented.
 */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function initials(n) { var p = String(n || '').trim().split(/\s+/); return ((p[0] || '')[0] || '') + ((p[1] || '')[0] || ''); }

  // One consistent placeholder for a practitioner without a photo: a soft
  // silhouette on the card's green, never initials or a stock face.
  var PLACEHOLDER = '<span class="g-home3__rec-ph" aria-hidden="true"><svg viewBox="0 0 64 64"><circle cx="32" cy="24" r="11" fill="currentColor"/><path d="M12 58c2-12 10-19 20-19s18 7 20 19z" fill="currentColor"/></svg></span>';
  async function fillRecs(root) {
    var box = root.querySelector('[data-home3-recs]'); if (!box) return;
    var title = root.querySelector('#home3-recs-title');
    var whereSlot = root.querySelector('[data-home3-where]');
    if (!window.GaiaDirectory || !window.GaiaDirectory.recommend) { box.innerHTML = ''; return; }
    var r;
    try { r = await window.GaiaDirectory.recommend(3); }
    catch (e) {
      box.innerHTML = '<p class="g-home3__muted">The practitioner directory is unavailable right now. <a href="home.html?view=directory">Try the directory</a>.</p>';
      return;
    }
    if (!box.isConnected) return;
    if (title) title.textContent = r.origin ? 'Recommended near you' : 'Available soon';
    if (whereSlot) whereSlot.innerHTML = r.origin
      ? '<button type="button" class="g-home3__chip" data-home3-near aria-label="Change location"><i class="ph ph-map-pin"></i> ' + esc(r.origin.label || 'Your location') + ' <i class="ph ph-caret-down"></i></button>'
      : '<button type="button" class="g-home3__chip" data-home3-near><i class="ph ph-map-pin"></i> Set your location <i class="ph ph-caret-down"></i></button>';
    if (!r.items.length) {
      box.innerHTML = '<p class="g-home3__muted">' + (r.origin ? 'No Bio-Well practitioner who books online within 100 miles.' : 'No open times right now.') + ' <a href="home.html?view=directory">See everyone in the directory</a>.</p>';
      return;
    }
    box.innerHTML = '<div class="g-home3__recs-grid">' + r.items.map(function (p) {
      var photo = p.image
        ? '<img src="' + esc(p.image) + '" alt="" decoding="async" referrerpolicy="no-referrer" onerror="this.outerHTML=window.GaiaHome3Placeholder" />'
        : PLACEHOLDER;
      var loc = [p.city, p.state].filter(Boolean).join(', ') + (p.distance ? ' (' + p.distance + ')' : '');
      return '<article class="g-home3__rec">'
        + '<div class="g-home3__rec-top"><span class="g-home3__rec-photo">' + photo + '</span><div class="g-home3__rec-info"><h3>' + esc(p.name) + '</h3>'
        + (loc ? '<p class="g-home3__rec-loc"><i class="ph ph-map-pin"></i> ' + esc(loc) + '</p>' : '')
        + '<p class="g-home3__rec-next"><i class="ph ph-calendar-blank"></i><span><b>' + (p.next ? 'Next available' : 'Books online') + '</b>' + (p.next ? esc(p.next) : 'Choose a time') + '</span></p></div></div>'
        + '<button type="button" class="g-home3__btn g-home3__btn--lime g-home3__btn--sm" data-home3-open="' + esc(p.id) + '">Book now <i class="ph ph-arrow-right"></i></button>'
        + '</article>';
    }).join('') + '</div>';
  }
  window.GaiaHome3Placeholder = PLACEHOLDER;

  function bind(root) {
    if (root.__home3) return; root.__home3 = true;
    root.addEventListener('submit', function (e) {
      var f = e.target.closest('[data-home3-search]'); if (!f) return;
      e.preventDefault();
      var q = String((f.elements.q && f.elements.q.value) || '').trim();
      if (window.GaiaDirectory) window.GaiaDirectory.open({ q: q });
    });
    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-home3-near]')) { e.preventDefault(); if (window.GaiaDirectory) window.GaiaDirectory.open({ intent: 'scan', near: true }); return; }
      var o = e.target.closest('[data-home3-open]');
      if (o && window.GaiaDirectory) { e.preventDefault(); window.GaiaDirectory.openProfile(o.getAttribute('data-home3-open')); }
    });
  }

  function onRender() {
    var root = document.querySelector('.g-home3'); if (!root) return;
    bind(root.parentElement || root);
    fillRecs(root);
  }
  document.addEventListener('gaia:superapp-rendered', function () { setTimeout(onRender, 0); });
  if (document.readyState !== 'loading') setTimeout(onRender, 0); else document.addEventListener('DOMContentLoaded', onRender);
})();
