/**
 * Gaia Healers — interactive exhibit-hall map (Events → an event → Map).
 *
 * The hall is drawn as SVG from a small layout file that sits next to the
 * event's plan image (`…map.png` → `…map.layout.json`): walls, doors, windows,
 * the tables and the aisle centre lines. The layout knows only geometry. Who is
 * on which table comes from the Event Manager on every load (its map places
 * resolve "Booth N" to the stand the planning sheet puts there), so moving a
 * company in the sheet moves it here, and nothing about a stand is written in
 * this file.
 *
 * What it does: zoom and pan (pinch, drag, buttons, ctrl/⌘ + scroll, keys),
 * a profile per stand (side panel on desktop, bottom sheet on a phone), search
 * across names, products and booth numbers, a spotlight on the chosen stand, a
 * simple route from the main entrance along the aisles, an optional Featured
 * strip (only stands an organiser marked), and a link that opens straight onto
 * a stand. Every field shown is one the stand's own record carries; a missing
 * field is left out, never filled in.
 */
(function () {
  'use strict';

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (n) => '<i class="ph ph-' + n + '" aria-hidden="true"></i>';
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const MIN_K = 1;
  const MAX_K = 6;
  const LOGO_K = 1.7;          // from this zoom the tables carry their logos
  const FOCUS_K = 2.6;

  const layouts = {};           // url -> Promise<layout|null>
  const states = {};            // eventId -> view state that survives re-renders

  function stateFor(eventId) {
    if (!states[eventId]) {
      states[eventId] = { view: { k: 1, tx: 0, ty: 0 }, query: '', selected: null, route: false, pending: null };
    }
    return states[eventId];
  }

  function layoutUrl(detail) {
    const img = detail && detail.map && detail.map.map_image_url;
    if (!img || !/\.png(\?.*)?$/i.test(img)) return '';
    return img.replace(/\.png(\?.*)?$/i, '.layout.json');
  }

  function loadLayout(url) {
    if (!layouts[url]) {
      const get = (u) => fetch(u, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((l) => (l && l.booths && l.viewBox ? l : null))
        .catch(() => null);
      // The copy shipped with this page first (a preview or a newer build has
      // it), then the one beside the published plan image.
      let local = '';
      try { local = new URL('assets/events/' + url.split('/').pop(), document.baseURI).href; } catch (e) { local = ''; }
      layouts[url] = (local && local !== url ? get(local) : Promise.resolve(null)).then((l) => l || get(url));
    }
    return layouts[url];
  }

  // ── The stands and their tables, from the event payload ────────────────
  function model(detail) {
    const stands = (detail.exhibitors || []).slice();
    const byId = {};
    stands.forEach((s) => { byId[s.id] = s; });
    const owner = {};          // booth number -> stand id
    const booths = {};         // stand id -> [booth numbers]
    ((detail.map && detail.map.places) || []).forEach((p) => {
      if (p.kind !== 'booth' || !p.exhibitor_id || !byId[p.exhibitor_id]) return;
      const n = Number((String(p.name).match(/\d+/) || [0])[0]);
      if (!n) return;
      owner[n] = p.exhibitor_id;
      (booths[p.exhibitor_id] = booths[p.exhibitor_id] || []).push(n);
    });
    Object.keys(booths).forEach((id) => booths[id].sort((a, b) => a - b));
    stands.sort((a, b) => String(a.company_name || '').localeCompare(String(b.company_name || ''), undefined, { sensitivity: 'base' }));
    return { stands, byId, owner, booths };
  }

  function boothText(nums) {
    if (!nums || !nums.length) return '';
    return (nums.length > 1 ? 'Booths ' : 'Booth ') + nums.join(' & ');
  }

  function safeUrl(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    const withScheme = /^https?:\/\//i.test(s) ? s : (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s) ? 'https://' + s : '');
    try { const url = new URL(withScheme); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch (e) { return ''; }
  }

  function hostLabel(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  const SOCIAL = [
    [/instagram\.com/i, 'instagram-logo', 'Instagram'], [/facebook\.com|fb\.com/i, 'facebook-logo', 'Facebook'],
    [/youtube\.com|youtu\.be/i, 'youtube-logo', 'YouTube'], [/linkedin\.com/i, 'linkedin-logo', 'LinkedIn'],
    [/tiktok\.com/i, 'tiktok-logo', 'TikTok'], [/(^|\.)x\.com|twitter\.com/i, 'x-logo', 'X'],
    [/pinterest\./i, 'pinterest-logo', 'Pinterest'],
  ];
  function socialMeta(u) {
    const host = hostLabel(u);
    const hit = SOCIAL.find(([re]) => re.test(host));
    return hit ? { icon: hit[1], label: hit[2] } : { icon: 'globe-simple', label: host };
  }

  function haystack(s, booths) {
    return [s.company_name, s.tagline, s.description, s.category,
      (s.products || []).map((p) => (p.name || '') + ' ' + (p.description || '')).join(' '),
      (booths || []).map((n) => 'booth ' + n + ' #' + n).join(' ')].join(' ').toLowerCase();
  }

  function matches(m, query) {
    const q = query.trim().toLowerCase().replace(/^booth\s*#?\s*/, '').replace(/^#/, '');
    if (!q) return null;
    if (/^\d+$/.test(q)) {           // a number is a booth number, exactly
      const id = m.owner[Number(q)];
      return new Set(id ? [id] : []);
    }
    const words = q.split(/\s+/).filter(Boolean);
    const out = new Set();
    m.stands.forEach((s) => {
      const h = haystack(s, m.booths[s.id]);
      if (words.every((w) => h.indexOf(w) !== -1)) out.add(s.id);
    });
    return out;
  }

  function logoTile(s, cls) {
    const dark = s.logo_on_dark ? ' is-dark' : '';
    if (s.logo_url) {
      return '<span class="' + cls + dark + '"><img src="' + esc(s.logo_url) + '" alt="" loading="lazy" decoding="async"'
        + ' onerror="this.parentNode.classList.add(\'is-broken\');this.remove()"><b aria-hidden="true">'
        + esc((s.company_name || '?').trim().charAt(0).toUpperCase()) + '</b></span>';
    }
    return '<span class="' + cls + ' is-broken"><b aria-hidden="true">' + esc((s.company_name || '?').trim().charAt(0).toUpperCase()) + '</b></span>';
  }

  // ── Static shell (the SVG is drawn once the layout has loaded) ──────────
  function supports(detail) {
    return Boolean(layoutUrl(detail) && ((detail.map && detail.map.places) || []).some((p) => p.kind === 'booth'));
  }

  function html(detail) {
    const m = model(detail);
    const featured = m.stands.filter((s) => s.is_featured === true);
    const placed = m.stands.filter((s) => m.booths[s.id]);
    const card = (s) => {
      const nums = m.booths[s.id];
      const blurb = s.tagline || s.description || '';
      return '<article class="gx-card" data-gx-card="' + s.id + '">'
        + '<button type="button" class="gx-card__main" data-gx-open="' + s.id + '">'
        + logoTile(s, 'gx-logo') + '<span class="gx-card__text"><strong>' + esc(s.company_name) + '</strong>'
        + (nums ? '<em>' + esc(boothText(nums)) + '</em>' : '')
        + (blurb ? '<span class="gx-card__blurb">' + esc(blurb) + '</span>' : '') + '</span></button>'
        + '<div class="gx-card__actions">'
        + '<button type="button" class="gx-chip" data-gx-open="' + s.id + '">' + icon('identification-card') + 'View profile</button>'
        + (nums ? '<button type="button" class="gx-chip gx-chip--accent" data-gx-find="' + s.id + '">' + icon('map-pin') + 'Find on map</button>' : '')
        + '</div></article>';
    };
    return '<section class="gx" data-gx>'
      + '<header class="gx-head"><p class="g-super-kicker">Exhibit hall</p><h2>Explore the exhibitors</h2>'
      + '<p class="gx-sub">' + placed.length + (placed.length === 1 ? ' stand' : ' stands')
      + ' · tap a table or a company to see who they are and where to find them.</p></header>'
      + (featured.length
        ? '<div class="gx-featured" aria-label="Featured exhibitors"><p class="gx-label">Featured</p><div class="gx-featured__row">'
          + featured.map((s) => '<button type="button" class="gx-feat" data-gx-find="' + s.id + '">' + logoTile(s, 'gx-logo')
            + '<span><strong>' + esc(s.company_name) + '</strong>' + (m.booths[s.id] ? '<em>' + esc(boothText(m.booths[s.id])) + '</em>' : '')
            + '</span></button>').join('') + '</div></div>'
        : '')
      + '<div class="gx-search" role="search"><label class="g-sr-only" for="gx-q">Search exhibitors, products, or booth numbers</label>'
      + icon('magnifying-glass') + '<input id="gx-q" type="search" data-gx-q autocomplete="off" enterkeyhint="search"'
      + ' placeholder="Search exhibitors, products, or booth numbers…">'
      + '<button type="button" class="gx-search__clear" data-gx-clear aria-label="Clear search" hidden>' + icon('x') + '</button></div>'
      + '<p class="gx-count" data-gx-count aria-live="polite"></p>'
      + '<div class="gx-stage" data-gx-stage>'
      + '<div class="gx-map" data-gx-map tabindex="0" aria-label="Exhibit hall map. Use plus and minus to zoom, arrow keys to move, Tab to reach each stand.">'
      + '<div class="gx-map__loading" data-gx-loading>Loading the hall…</div>'
      + '<div class="gx-controls" role="group" aria-label="Map controls">'
      + '<button type="button" data-gx-zoom="in" aria-label="Zoom in">' + icon('plus') + '</button>'
      + '<button type="button" data-gx-zoom="out" aria-label="Zoom out">' + icon('minus') + '</button>'
      + '<button type="button" data-gx-zoom="reset" aria-label="Reset view">' + icon('arrows-in-simple') + '</button></div>'
      + '<p class="gx-legend"><span class="gx-legend__door"></span>Main entrance</p>'
      + '</div>'
      + '<aside class="gx-panel" data-gx-panel aria-label="Exhibitor profile" hidden></aside>'
      + '</div>'
      + '<p class="gx-hint">Pinch or use <b>+</b> / <b>−</b> to zoom · drag to move · <span class="gx-hint__desk">Ctrl or ⌘ + scroll zooms too</span></p>'
      + '<div class="gx-dir"><div class="gx-dir__head"><h3>Discover exhibitors</h3></div>'
      + '<div class="gx-grid" data-gx-grid>' + m.stands.map(card).join('') + '</div>'
      + '<p class="g-empty" data-gx-none hidden>No exhibitor matches that search. Try a product, a company or a booth number.</p></div>'
      + '<div class="gx-toast" data-gx-toast role="status" aria-live="polite" hidden></div>'
      + '</section>';
  }

  // ── Drawing ─────────────────────────────────────────────────────────────
  function el(name, attrs, parent) {
    const n = document.createElementNS(SVGNS, name);
    Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, attrs[k]));
    if (parent) parent.appendChild(n);
    return n;
  }

  function drawPlan(svg, L, m) {
    const vb = L.viewBox;
    svg.setAttribute('viewBox', vb.join(' '));
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.innerHTML = '';
    const defs = el('defs', {}, svg);
    defs.innerHTML = '<filter id="gx-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="14" result="b"/>'
      + '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
      + '<linearGradient id="gx-floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbf8ef"/><stop offset="1" stop-color="#f1ebdb"/></linearGradient>';
    const world = el('g', { class: 'gx-world' }, svg);
    const floor = el('g', { class: 'gx-floor' }, world);
    (L.floor || []).forEach((poly) => el('polygon', { points: poly.map((p) => p.join(',')).join(' ') }, floor));
    const walls = el('g', { class: 'gx-walls' }, world);
    (L.walls || []).forEach((w) => el('polyline', { points: w.map((p) => p.join(',')).join(' ') }, walls));
    const wins = el('g', { class: 'gx-windows' }, world);
    (L.windows || []).forEach((w) => el('line', { x1: w[0][0], y1: w[0][1], x2: w[1][0], y2: w[1][1] }, wins));
    const doors = el('g', { class: 'gx-doors' }, world);
    (L.doors || []).forEach((d) => {
      el('line', { x1: d.a[0], y1: d.a[1], x2: d.b[0], y2: d.b[1], class: d.main ? 'is-main' : '' }, doors);
      if (d.main) {
        const cx = (d.a[0] + d.b[0]) / 2;
        const cy = (d.a[1] + d.b[1]) / 2;
        el('path', { class: 'gx-door-arrow', d: 'M' + cx + ' ' + (cy + 14) + ' l-18 24 h11 v22 h14 v-22 h11 z' }, doors);
        const pill = el('g', { class: 'gx-door-pill', transform: 'translate(' + cx + ' ' + (cy + 92) + ')' }, doors);
        el('rect', { x: -150, y: -30, width: 300, height: 60, rx: 30 }, pill);
        const lab = el('text', { x: 0, y: 1 }, pill);
        lab.textContent = d.label || 'Main entrance';
      }
    });
    el('path', { class: 'gx-route', 'data-gx-route': '', d: '' }, world);
    const booths = el('g', { class: 'gx-booths' }, world);
    Object.keys(L.booths).sort((a, b) => a - b).forEach((key) => {
      const b = L.booths[key];
      const n = Number(key);
      const standId = m.owner[n];
      const s = standId ? m.byId[standId] : null;
      const g = el('g', {
        class: 'gx-booth' + (s ? ' is-taken' : ''), transform: 'translate(' + b.cx + ' ' + b.cy + ')', 'data-booth': n,
      }, booths);
      if (s) {
        g.setAttribute('data-stand', s.id);
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'button');
        g.setAttribute('aria-label', 'Booth ' + n + ', ' + s.company_name);
      } else {
        g.setAttribute('aria-hidden', 'true');
      }
      // Two chairs on the side the venue plan puts them, then the table.
      if (b.chairs) {
        const longV = b.h >= b.w;
        const half = (longV ? b.w : b.h) / 2;
        const len = longV ? b.h : b.w;
        const a2 = ((longV ? 90 : 0) + (b.rot || 0)) * Math.PI / 180;
        const lx = Math.cos(a2);
        const ly = Math.sin(a2);
        const [nx, ny] = b.chairs;
        const deg = (Math.atan2(ly, lx) * 180 / Math.PI).toFixed(1);
        [-0.24, 0.24].forEach((f) => {
          const x = nx * (half + 15) + lx * len * f;
          const y = ny * (half + 15) + ly * len * f;
          el('rect', { class: 'gx-chair', x: -13, y: -12, width: 26, height: 24, rx: 9,
            transform: 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') rotate(' + deg + ')' }, g);
        });
      }
      el('rect', { class: 'gx-booth__table', x: -b.w / 2, y: -b.h / 2, width: b.w, height: b.h, rx: 12, transform: 'rotate(' + (b.rot || 0) + ')' }, g);
      // Logo and number sit along the table's long axis so neither covers the other.
      const ang = ((b.h >= b.w ? 90 : 0) + (b.rot || 0)) * Math.PI / 180;
      const ux = Math.cos(ang);
      const uy = Math.sin(ang);
      const t = el('text', { class: 'gx-booth__num', x: 0, y: 0, 'data-dx': (ux * 40).toFixed(1), 'data-dy': (uy * 40).toFixed(1) }, g);
      t.textContent = String(n);
      if (s && s.logo_url) {
        g.setAttribute('data-logo', s.logo_url);
        g.setAttribute('data-lx', (-ux * 38).toFixed(1));
        g.setAttribute('data-ly', (-uy * 38).toFixed(1));
        if (s.logo_on_dark) g.setAttribute('data-logo-dark', '1');
      }
    });
    return world;
  }

  // Logos are fetched the first time anyone zooms in far enough to read them.
  function ensureLogos(svg) {
    if (svg.__gxLogos) return;
    svg.__gxLogos = true;
    svg.querySelectorAll('.gx-booth[data-logo]').forEach((g) => {
      const x = Number(g.getAttribute('data-lx'));
      const y = Number(g.getAttribute('data-ly'));
      const id = 'gx-clip-' + g.getAttribute('data-booth');
      const wrap = el('g', { class: 'gx-booth__logo' + (g.getAttribute('data-logo-dark') ? ' is-dark' : ''), transform: 'translate(' + x + ' ' + y + ')' });
      const clip = el('clipPath', { id }, wrap);
      el('circle', { r: 25 }, clip);
      el('circle', { class: 'gx-booth__logo-bg', r: 28 }, wrap);
      const img = el('image', { x: -22, y: -22, width: 44, height: 44, 'clip-path': 'url(#' + id + ')', preserveAspectRatio: 'xMidYMid meet' }, wrap);
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', g.getAttribute('data-logo'));
      img.setAttribute('href', g.getAttribute('data-logo'));
      img.addEventListener('error', () => wrap.remove());
      g.appendChild(wrap);
    });
  }

  function applyLogoMode(svg, k) {
    const on = k >= LOGO_K;
    svg.classList.toggle('is-logos', on);
    if (on) ensureLogos(svg);
    svg.querySelectorAll('.gx-booth__num').forEach((t) => {
      const g = t.parentNode;
      const shift = on && g.querySelector('.gx-booth__logo');
      t.setAttribute('x', shift ? t.getAttribute('data-dx') : 0);
      t.setAttribute('y', shift ? t.getAttribute('data-dy') : 0);
    });
  }

  // ── Route from the main entrance along the aisles (Dijkstra) ────────────
  function route(L, boothNo) {
    const W = L.walkways;
    const b = L.booths[String(boothNo)];
    if (!W || !b) return null;
    const N = W.nodes;
    const adj = {};
    const link = (a, c) => {
      const d = Math.hypot(N[a][0] - N[c][0], N[a][1] - N[c][1]);
      (adj[a] = adj[a] || []).push([c, d]);
      (adj[c] = adj[c] || []).push([a, d]);
    };
    W.edges.forEach(([a, c]) => link(a, c));
    const dist = {};
    const prev = {};
    const todo = new Set(Object.keys(N));
    Object.keys(N).forEach((k) => { dist[k] = Infinity; });
    dist[W.start] = 0;
    while (todo.size) {
      let u = null;
      todo.forEach((k) => { if (u === null || dist[k] < dist[u]) u = k; });
      if (dist[u] === Infinity) break;
      todo.delete(u);
      (adj[u] || []).forEach(([v, w]) => {
        if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
      });
    }
    let best = null;
    let bestD = Infinity;
    (b.via || []).forEach((v) => {
      const d = dist[v] + Math.hypot(N[v][0] - b.approach[0], N[v][1] - b.approach[1]);
      if (d < bestD) { bestD = d; best = v; }
    });
    if (!best) return null;
    const pts = [b.approach];
    for (let k = best; k; k = prev[k]) pts.push(N[k]);
    return pts.reverse();
  }

  // ── View (zoom / pan) ───────────────────────────────────────────────────
  function clampView(L, v) {
    const [x0, y0, w, h] = L.viewBox;
    v.k = Math.max(MIN_K, Math.min(MAX_K, v.k));
    const minX = (x0 + w) * (1 - v.k);
    const maxX = x0 * (1 - v.k);
    const minY = (y0 + h) * (1 - v.k);
    const maxY = y0 * (1 - v.k);
    v.tx = Math.min(maxX, Math.max(minX, v.tx));
    v.ty = Math.min(maxY, Math.max(minY, v.ty));
    return v;
  }

  // ── Bind: one call per render of the Map tab ────────────────────────────
  function bind(root, detail, eventId) {
    const sec = root.querySelector('[data-gx]');
    if (!sec) return;
    const st = stateFor(eventId);
    const m = model(detail);
    const mapEl = sec.querySelector('[data-gx-map]');
    const panel = sec.querySelector('[data-gx-panel]');
    const input = sec.querySelector('[data-gx-q]');
    const clear = sec.querySelector('[data-gx-clear]');
    const count = sec.querySelector('[data-gx-count]');
    const grid = sec.querySelector('[data-gx-grid]');
    const none = sec.querySelector('[data-gx-none]');
    const toast = sec.querySelector('[data-gx-toast]');
    // On a phone the profile is a bottom sheet over everything, so it lives on
    // <body>: inside the event screen a transformed ancestor would pin a
    // "fixed" sheet to the page instead of the screen.
    document.querySelectorAll('body > [data-gx-panel], body > [data-gx-toast]').forEach((old) => old.remove());
    document.body.appendChild(toast);
    if (!window.matchMedia('(min-width: 900px)').matches) document.body.appendChild(panel);
    let L = null;
    let svg = null;
    let world = null;
    let anim = 0;
    const desktop = () => window.matchMedia('(min-width: 900px)').matches;

    const showToast = (text) => {
      toast.textContent = text;
      toast.hidden = false;
      clearTimeout(toast.__t);
      toast.__t = setTimeout(() => { toast.hidden = true; }, 2200);
    };

    function paint() {
      if (!world) return;
      const v = st.view;
      world.setAttribute('transform', 'translate(' + v.tx.toFixed(2) + ' ' + v.ty.toFixed(2) + ') scale(' + v.k.toFixed(4) + ')');
      svg.classList.toggle('is-zoomed', v.k > 1.01);
      applyLogoMode(svg, v.k);
    }

    function animateTo(target) {
      cancelAnimationFrame(anim);
      clampView(L, target);
      if (reduced()) { st.view = target; paint(); return; }
      const from = Object.assign({}, st.view);
      const t0 = performance.now();
      const dur = 420;
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3);
        st.view = { k: from.k + (target.k - from.k) * e, tx: from.tx + (target.tx - from.tx) * e, ty: from.ty + (target.ty - from.ty) * e };
        paint();
        if (p < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    }

    function zoomAt(k2, px, py) {
      const v = st.view;
      const k = Math.max(MIN_K, Math.min(MAX_K, k2));
      return clampView(L, { k, tx: px - (px - v.tx) * (k / v.k), ty: py - (py - v.ty) * (k / v.k) });
    }

    function centerOf() {
      const [x0, y0, w, h] = L.viewBox;
      return [x0 + w / 2, y0 + h / 2];
    }

    function focusBooths(nums) {
      if (!L || !nums || !nums.length) return;
      const pts = nums.map((n) => L.booths[String(n)]).filter(Boolean);
      if (!pts.length) return;
      const cx = pts.reduce((a, b) => a + b.cx, 0) / pts.length;
      const cy = pts.reduce((a, b) => a + b.cy, 0) / pts.length;
      // Centre the stand in the part of the map the visitor can still see:
      // left of the floating panel on a wide screen, above the sheet on a phone.
      const r = mapEl.getBoundingClientRect();
      let right = r.right;
      let bottom = r.bottom;
      if (!panel.hidden) {
        const pr = panel.getBoundingClientRect();
        if (desktop()) right = Math.min(right, pr.left);
        else bottom = Math.min(bottom, pr.top);
      }
      const top = Math.max(r.top, 0);
      const [px, py] = (bottom - top > 80 && right - r.left > 80)
        ? svgPoint((r.left + right) / 2, (top + bottom) / 2) : centerOf();
      animateTo({ k: FOCUS_K, tx: px - FOCUS_K * cx, ty: py - FOCUS_K * cy });
    }

    function svgPoint(clientX, clientY) {
      const ctm = svg.getScreenCTM();
      if (!ctm) return centerOf();
      const p = svg.createSVGPoint();
      p.x = clientX; p.y = clientY;
      const q = p.matrixTransform(ctm.inverse());
      return [q.x, q.y];
    }

    // ── Highlighting: search matches, the chosen stand, the route ──────
    function refreshMarks() {
      if (!svg) return;
      const hits = matches(m, st.query);
      svg.classList.toggle('is-searching', Boolean(hits));
      svg.classList.toggle('is-spot', st.selected != null);
      svg.querySelectorAll('.gx-booth').forEach((g) => {
        const id = Number(g.getAttribute('data-stand'));
        g.classList.toggle('is-match', Boolean(hits && id && hits.has(id)));
        g.classList.toggle('is-selected', Boolean(id && id === st.selected));
      });
      const path = svg.querySelector('[data-gx-route]');
      const pts = st.route && st.selected != null && m.booths[st.selected] ? route(L, m.booths[st.selected][0]) : null;
      path.setAttribute('d', pts ? 'M' + pts.map((p) => p.join(' ')).join(' L') : '');
      path.classList.toggle('is-on', Boolean(pts));
    }

    function applySearch() {
      const hits = matches(m, st.query);
      let shown = 0;
      grid.querySelectorAll('[data-gx-card]').forEach((c) => {
        const ok = !hits || hits.has(Number(c.getAttribute('data-gx-card')));
        c.hidden = !ok;
        if (ok) shown += 1;
      });
      none.hidden = shown > 0;
      clear.hidden = !st.query;
      count.textContent = hits ? (shown === 1 ? '1 exhibitor matches' : shown + ' exhibitors match') : '';
      refreshMarks();
    }

    // ── Profile ─────────────────────────────────────────────────────────
    function profileHtml(s) {
      const nums = m.booths[s.id] || [];
      const site = safeUrl(s.website);
      const category = s.category && !/^exhibitors?$/i.test(String(s.category).trim()) ? s.category : '';
      const desc = s.description && s.description !== s.tagline ? s.description : '';
      const products = (s.products || []).filter((p) => p && p.name).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      const socials = (s.social_links || []).map(safeUrl).filter(Boolean);
      const email = String(s.contact_email || '').trim();
      const phone = String(s.contact_phone || '').trim();
      const base = (window.GaiaApi && window.GaiaApi.base && window.GaiaApi.base()) || '';
      return '<div class="gx-panel__grab" data-gx-grab aria-hidden="true"><span></span></div>'
        + '<button type="button" class="gx-panel__close" data-gx-close aria-label="Close profile">' + icon('x') + '</button>'
        + '<div class="gx-panel__scroll">'
        + '<div class="gx-prof__head">' + logoTile(s, 'gx-logo gx-logo--lg')
        + '<div><h3 tabindex="-1" data-gx-title>' + esc(s.company_name) + '</h3>'
        + '<div class="gx-prof__meta">' + nums.map((n) => '<span class="gx-booth-chip">Booth ' + n + '</span>').join('')
        + (category ? '<span class="gx-cat">' + esc(category) + '</span>' : '') + '</div></div></div>'
        + (s.tagline ? '<p class="gx-prof__tag">' + esc(s.tagline) + '</p>' : '')
        + (desc ? '<p class="gx-prof__desc">' + esc(desc) + '</p>' : '')
        + '<div class="gx-prof__actions">'
        + (nums.length ? '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-gx-route-btn>' + icon('path') + (st.route ? 'Hide the way' : 'Find this booth') + '</button>'
          + '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-gx-center>' + icon('crosshair-simple') + 'Find on map</button>' : '')
        + (site ? '<a class="g-btn g-btn--secondary g-btn--sm" href="' + esc(site) + '" target="_blank" rel="noopener noreferrer">' + icon('arrow-square-out') + 'Visit website</a>' : '')
        + '<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-gx-share>' + icon('share-network') + 'Share</button>'
        + '</div>'
        + (st.route && nums.length ? '<p class="gx-prof__note">' + icon('info') + 'A simple way along the aisles from the main entrance. Follow the hall signs on the day.</p>' : '')
        + (products.length
          ? '<div class="gx-prof__block"><p class="gx-label">What they bring</p><ul class="gx-products">'
            + products.slice(0, 6).map((p) => '<li><strong>' + esc(p.name) + '</strong>' + (p.description ? '<span>' + esc(p.description) + '</span>' : '') + '</li>').join('')
            + '</ul>' + (products.length > 6 ? '<p class="gx-more">+' + (products.length - 6) + ' more on their stand page</p>' : '') + '</div>'
          : '')
        + (email || phone || s.address
          ? '<div class="gx-prof__block"><p class="gx-label">Contact</p><ul class="gx-contact">'
            + (email ? '<li>' + icon('envelope-simple') + '<a href="mailto:' + esc(email) + '">' + esc(email) + '</a></li>' : '')
            + (phone ? '<li>' + icon('phone') + '<a href="tel:' + esc(phone.replace(/[^\d+]/g, '')) + '">' + esc(phone) + '</a></li>' : '')
            + (s.address ? '<li>' + icon('map-pin-line') + '<span>' + esc(s.address) + '</span></li>' : '')
            + '</ul></div>'
          : '')
        + (socials.length
          ? '<div class="gx-prof__block"><p class="gx-label">Follow</p><div class="gx-social">'
            + socials.map((u) => { const meta = socialMeta(u); return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" aria-label="' + esc(meta.label) + '">' + icon(meta.icon) + '</a>'; }).join('')
            + '</div></div>'
          : '')
        + (base ? '<a class="gx-prof__page" href="' + esc(base + '/v/' + s.id) + '" target="_blank" rel="noopener noreferrer">See their full stand page ' + icon('arrow-up-right') + '</a>' : '')
        + '</div>';
    }

    function setUrl(id) {
      try {
        const u = new URL(window.location.href);
        if (id == null) u.searchParams.delete('stand');
        else { u.searchParams.set('stand', String(id)); u.searchParams.set('tab', 'map'); }
        history.replaceState(history.state, '', u.toString());
      } catch (e) { /* the map still works without the address bar */ }
    }

    let lastFocus = null;
    function openProfile(id, opts) {
      const s = m.byId[id];
      if (!s) return;
      const o = opts || {};
      if (st.selected !== id) st.route = false;
      st.selected = id;
      if (o.route) st.route = true;
      lastFocus = document.activeElement;
      panel.innerHTML = profileHtml(s);
      panel.hidden = false;
      requestAnimationFrame(() => panel.classList.add('is-open'));
      sec.classList.add('has-panel');
      setUrl(id);
      refreshMarks();
      bindPanel(s);
      if (!desktop() || o.scroll) {
        mapEl.scrollIntoView({ behavior: 'auto', block: desktop() ? 'center' : 'start' });
      }
      if (o.fly !== false && m.booths[id]) requestAnimationFrame(() => setTimeout(() => focusBooths(m.booths[id]), reduced() ? 0 : 300));
      if (o.focusTitle !== false) setTimeout(() => { const t = panel.querySelector('[data-gx-title]'); if (t) t.focus({ preventScroll: true }); }, 60);
    }

    function closeProfile() {
      st.selected = null;
      st.route = false;
      panel.classList.remove('is-open');
      sec.classList.remove('has-panel');
      setTimeout(() => { if (!panel.classList.contains('is-open')) { panel.hidden = true; panel.innerHTML = ''; } }, reduced() ? 0 : 260);
      setUrl(null);
      refreshMarks();
      if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    }

    function bindPanel(s) {
      const q = (sel) => panel.querySelector(sel);
      q('[data-gx-close]').addEventListener('click', closeProfile);
      const rb = q('[data-gx-route-btn]');
      if (rb) rb.addEventListener('click', () => { const on = !st.route; openProfile(s.id, { route: on, fly: true }); if (!on) { st.route = false; openProfile(s.id, { fly: false }); } });
      const cb = q('[data-gx-center]');
      if (cb) cb.addEventListener('click', () => { focusBooths(m.booths[s.id]); if (!desktop()) mapEl.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' }); });
      q('[data-gx-share]').addEventListener('click', () => {
        const u = new URL(window.location.href);
        u.search = '';
        u.searchParams.set('view', 'events');
        u.searchParams.set('event', String(eventId));
        u.searchParams.set('tab', 'map');
        u.searchParams.set('stand', String(s.id));
        const link = u.toString();
        if (navigator.share && !desktop()) {
          navigator.share({ title: s.company_name, text: s.company_name + ' at ' + ((detail.event && detail.event.name) || 'the event'), url: link }).catch(() => {});
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(() => showToast('Link copied'), () => showToast(link));
        } else {
          showToast(link);
        }
      });
      // A bottom sheet closes with a downward swipe on its handle.
      const grab = q('[data-gx-grab]');
      let y0 = null;
      grab.addEventListener('pointerdown', (e) => { y0 = e.clientY; grab.setPointerCapture(e.pointerId); });
      grab.addEventListener('pointermove', (e) => { if (y0 != null) panel.style.transform = 'translateY(' + Math.max(0, e.clientY - y0) + 'px)'; });
      const end = (e) => {
        if (y0 == null) return;
        const dy = e.clientY - y0;
        y0 = null;
        panel.style.transform = '';
        if (dy > 80) closeProfile();
      };
      grab.addEventListener('pointerup', end);
      grab.addEventListener('pointercancel', end);
    }

    // ── Wire the static parts ───────────────────────────────────────────
    input.value = st.query;
    input.addEventListener('input', () => { st.query = input.value; applySearch(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const hits = matches(m, st.query);
        if (hits && hits.size === 1) openProfile(hits.values().next().value, { scroll: true });
      }
    });
    clear.addEventListener('click', () => { st.query = ''; input.value = ''; applySearch(); input.focus(); });
    sec.querySelectorAll('[data-gx-open]').forEach((b) => b.addEventListener('click', () => openProfile(Number(b.getAttribute('data-gx-open')), { fly: true })));
    sec.querySelectorAll('[data-gx-find]').forEach((b) => b.addEventListener('click', () => openProfile(Number(b.getAttribute('data-gx-find')), { fly: true, scroll: true })));
    sec.querySelectorAll('[data-gx-zoom]').forEach((b) => b.addEventListener('click', () => {
      if (!L) return;
      const kind = b.getAttribute('data-gx-zoom');
      if (kind === 'reset') { animateTo({ k: 1, tx: 0, ty: 0 }); return; }
      const [cx, cy] = centerOf();
      animateTo(zoomAt(st.view.k * (kind === 'in' ? 1.6 : 1 / 1.6), cx, cy));
    }));
    document.addEventListener('keydown', function onKey(e) {
      if (!document.contains(sec)) { document.removeEventListener('keydown', onKey); if (panel.parentNode === document.body) panel.remove(); return; }
      if (e.key === 'Escape' && st.selected != null) closeProfile();
    });

    // ── The plan itself ─────────────────────────────────────────────────
    const url = layoutUrl(detail);
    loadLayout(url).then((layout) => {
      if (!document.contains(sec)) return;
      const loading = sec.querySelector('[data-gx-loading]');
      if (!layout) {
        // No layout: the published plan image still answers "where".
        loading.innerHTML = '<img class="gx-fallback" src="' + esc(detail.map.map_image_url) + '" alt="Exhibit hall floor plan">';
        return;
      }
      L = layout;
      loading.remove();
      svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'gx-svg');
      svg.setAttribute('role', 'group');
      svg.setAttribute('aria-label', 'Floor plan with ' + Object.keys(L.booths).length + ' tables');
      mapEl.insertBefore(svg, mapEl.firstChild);
      world = drawPlan(svg, L, m);
      clampView(L, st.view);
      paint();
      bindGestures();
      applySearch();
      if (st.pending != null) {
        const p = st.pending;
        st.pending = null;
        openProfile(p, { fly: true, scroll: true });
        // Opening the Events screen scrolls the window to the top (smoothly, on
        // a desktop), which can land after this. A shared link should end on
        // the map, so bring it back once the screen has settled.
        setTimeout(() => {
          const r = mapEl.getBoundingClientRect();
          if (document.contains(mapEl) && (r.top > window.innerHeight * 0.6 || r.bottom < 0)) {
            mapEl.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: desktop() ? 'center' : 'start' });
            setTimeout(() => focusBooths(m.booths[p]), reduced() ? 0 : 450);
          }
        }, 1100);
      }
      else if (st.selected != null && m.byId[st.selected]) openProfile(st.selected, { fly: false, focusTitle: false });
    });

    function bindGestures() {
      const pts = new Map();
      let moved = false;
      let start = null;
      let pinch = null;
      let downBooth = null;
      const unit = () => {
        const r = svg.getBoundingClientRect();
        return Math.max(L.viewBox[2] / r.width, L.viewBox[3] / r.height);
      };
      const touchMode = () => svg.classList.toggle('is-pannable', st.view.k > 1.01);
      svg.addEventListener('pointerdown', (e) => {
        if (e.button > 0) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        downBooth = e.target.closest && e.target.closest('.gx-booth.is-taken');
        if (pts.size === 1) { moved = false; start = { x: e.clientX, y: e.clientY, v: Object.assign({}, st.view) }; }
        if (pts.size === 2) {
          const [a, b] = Array.from(pts.values());
          pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), v: Object.assign({}, st.view), mid: svgPoint((a.x + b.x) / 2, (a.y + b.y) / 2) };
          moved = true;
        }
        svg.setPointerCapture(e.pointerId);
      });
      svg.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size === 2 && pinch) {
          const [a, b] = Array.from(pts.values());
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const k = Math.max(MIN_K, Math.min(MAX_K, pinch.v.k * (d / pinch.d)));
          const [px, py] = pinch.mid;
          st.view = clampView(L, { k, tx: px - (px - pinch.v.tx) * (k / pinch.v.k), ty: py - (py - pinch.v.ty) * (k / pinch.v.k) });
          paint();
          return;
        }
        if (pts.size === 1 && start) {
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (!moved && Math.hypot(dx, dy) > 8) moved = true;
          if (moved && (st.view.k > 1.01 || e.pointerType === 'mouse')) {
            const u = unit();
            st.view = clampView(L, { k: start.v.k, tx: start.v.tx + dx * u, ty: start.v.ty + dy * u });
            paint();
          }
        }
      });
      const up = (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        if (pts.size < 2) pinch = null;
        if (pts.size === 0) {
          // A tap, not the end of a drag, chooses a stand.
          if (!moved && downBooth && e.type === 'pointerup') openProfile(Number(downBooth.getAttribute('data-stand')), { fly: true });
          else if (!moved && !downBooth && e.type === 'pointerup' && st.selected != null && desktop()) { /* keep the profile open */ }
          start = null;
          downBooth = null;
          touchMode();
        }
      };
      svg.addEventListener('pointerup', up);
      svg.addEventListener('pointercancel', up);
      svg.addEventListener('dblclick', (e) => {
        if (e.target.closest('.gx-booth.is-taken')) return;
        const [px, py] = svgPoint(e.clientX, e.clientY);
        animateTo(zoomAt(st.view.k * 1.8, px, py));
      });
      svg.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;    // plain scrolling keeps scrolling the page
        e.preventDefault();
        const [px, py] = svgPoint(e.clientX, e.clientY);
        st.view = zoomAt(st.view.k * Math.exp(-e.deltaY * 0.0022), px, py);
        paint();
        touchMode();
      }, { passive: false });
      svg.querySelectorAll('.gx-booth.is-taken').forEach((g) => g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProfile(Number(g.getAttribute('data-stand')), { fly: true }); }
      }));
      mapEl.addEventListener('keydown', (e) => {
        if (e.target !== mapEl) return;
        const step = L.viewBox[2] * 0.08;
        const v = Object.assign({}, st.view);
        const [cx, cy] = centerOf();
        if (e.key === '+' || e.key === '=') animateTo(zoomAt(v.k * 1.5, cx, cy));
        else if (e.key === '-' || e.key === '_') animateTo(zoomAt(v.k / 1.5, cx, cy));
        else if (e.key === '0') animateTo({ k: 1, tx: 0, ty: 0 });
        else if (e.key === 'ArrowLeft') animateTo(Object.assign(v, { tx: v.tx + step }));
        else if (e.key === 'ArrowRight') animateTo(Object.assign(v, { tx: v.tx - step }));
        else if (e.key === 'ArrowUp') animateTo(Object.assign(v, { ty: v.ty + step }));
        else if (e.key === 'ArrowDown') animateTo(Object.assign(v, { ty: v.ty - step }));
        else return;
        e.preventDefault();
      });
      touchMode();
    }
  }

  // Ask for a stand to be opened the next time this event's map is bound.
  function select(eventId, standId) {
    stateFor(eventId).pending = Number(standId);
  }

  window.GaiaExhibitMap = { supports, html, bind, select, _route: route, _matches: matches, _model: model };
}());
