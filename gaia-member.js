/** Gaia — signed-in member layer (Phase 5).
 * Reads the LIVE normalized /api/member/* endpoints and renders the Home
 * dashboard. No fake data: legacy demo tiles are hidden; signed-out users see a
 * public welcome, signed-in users see their real memberships/bookings/messages.
 */
(function () {
  'use strict';
  if (!document.querySelector('.gaia-main--today')) return; // home.html only

  const state = { authed: false, data: {}, event: null };
  window.GaiaMember = state;

  function proxyBase() {
    return String(
      (window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
      || 'https://api.gaiahealers.app',
    ).replace(/\/+$/, '');
  }
  async function getJson(path) {
    try {
      const r = await fetch(proxyBase() + path, { headers: { Accept: 'application/json' }, credentials: 'include' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function el(id) { return document.getElementById(id); }
  function portalBase() {
    return String((window.GAIA && (window.GAIA.clientPortal && window.GAIA.clientPortal.url || window.GAIA.portalUrl)) || 'https://education.gaiahealers.com').replace(/\/+$/, '');
  }

  async function loadMember() {
    const [profile, access, appts, notif, devices, purchases, forms, courses, products] = await Promise.all([
      getJson('/api/member/profile'), getJson('/api/member/access'),
      getJson('/api/member/appointments'), getJson('/api/member/notifications'),
      getJson('/api/member/devices'), getJson('/api/member/purchases'),
      getJson('/api/member/forms'), getJson('/api/member/courses'),
      getJson('/api/member/products'),
    ]);
    state.authed = !!(profile && profile.ok && profile.authenticated);
    state.data = { profile, access, appts, notif, devices, purchases, forms, courses, products };
    document.dispatchEvent(new CustomEvent('gaia:member', { detail: state.data }));
    render();
  }

  function heroPublic() {
    const g = el('today-hero-greeting'), t = el('today-hero-title'), s = el('today-hero-sub');
    if (g) g.textContent = 'Gaia Healers';
    if (t) t.innerHTML = 'Welcome to <em>Gaia</em>';
    if (s) s.textContent = 'Explore freely — sign in to unlock your profile, memberships, courses, and a Gaia that knows you.';
  }
  function heroMember(p, access) {
    const g = el('today-hero-greeting'), t = el('today-hero-title'), s = el('today-hero-sub');
    const first = String(p.name || 'there').trim().split(/\s+/)[0] || 'there';
    const bits = [];
    if (p.membershipTier) bits.push(esc(p.membershipTier) + ' member');
    if (p.practitioner) bits.push(p.practitionerCertified ? 'Certified practitioner' : 'Practitioner');
    const nUnlocked = ((access && access.communities && access.communities.unlocked) || []).length;
    if (nUnlocked) bits.push(nUnlocked + (nUnlocked === 1 ? ' community' : ' communities'));
    if (g) g.textContent = 'Welcome back';
    if (t) t.innerHTML = 'Hi <em>' + esc(first) + '</em>';
    if (s) s.textContent = bits.join(' · ') || 'Your Gaia member hub';
  }

  function card(inner) { return '<article class="gaia-card gaia-card-pad gaia-member-card">' + inner + '</article>'; }

  function memberCards(d) {
    const out = [];
    const unlocked = (d.access && d.access.communities && d.access.communities.unlocked) || [];
    out.push(card(
      '<p class="gaia-member-card__label">My memberships</p>'
      + '<p class="gaia-member-card__value">' + unlocked.length + ' unlocked</p>'
      + '<p class="gaia-member-card__meta">' + (unlocked.map((c) => esc(c.name)).slice(0, 3).join(', ') || 'No communities yet') + '</p>'
      + '<a class="gaia-member-card__cta" href="home.html?view=community">View access →</a>',
    ));

    const appts = (d.appts && d.appts.appointments) || [];
    const now = Date.now();
    const upcoming = appts
      .filter((a) => { const x = Date.parse(a.startTime || ''); return isFinite(x) && x > now; })
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))[0];
    const booking = (d.appts && d.appts.bookingLinks && d.appts.bookingLinks[0]) || null;
    if (upcoming) {
      out.push(card('<p class="gaia-member-card__label">Next appointment</p><p class="gaia-member-card__value">' + esc(upcoming.title || 'Appointment') + '</p><p class="gaia-member-card__meta">' + esc(new Date(upcoming.startTime).toLocaleString()) + '</p>'));
    } else if (booking) {
      out.push(card('<p class="gaia-member-card__label">Book a session</p><p class="gaia-member-card__value">' + esc(booking.name) + '</p><a class="gaia-member-card__cta" href="' + esc(booking.openUrl) + '" target="_blank" rel="noopener noreferrer">Book now →</a>'));
    }

    const unread = (d.notif && d.notif.counts && d.notif.counts.unread) || 0;
    out.push(card('<p class="gaia-member-card__label">Messages</p><p class="gaia-member-card__value">' + (unread ? unread + ' unread' : 'All caught up') + '</p><a class="gaia-member-card__cta" href="home.html?view=community">Open →</a>'));
    // No "Gaia AI" card here — the assistant is always reachable from the orb.
    return out.join('');
  }

  function publicCards() {
    // One clear member CTA. The assistant lives in the orb, not a Home card.
    return card('<p class="gaia-member-card__label">Members</p><p class="gaia-member-card__value">Unlock your Gaia</p><p class="gaia-member-card__meta">Your profile, memberships, courses, bookings, and a personalized Gaia — all in one place.</p><a class="gaia-member-card__cta" href="' + esc(portalBase()) + '" target="_blank" rel="noopener noreferrer">Sign in →</a>');
  }

  function renderHome() {
    const dash = el('member-dashboard');
    const main = document.querySelector('.gaia-main--today');
    if (main) {
      Array.from(main.children).forEach((ch) => {
        if (ch === dash || ch.id === 'gaia-coach-anchor' || ch.id === 'public-features' || ch.classList.contains('gaia-dash-hero')) return;
        ch.style.display = 'none';
      });
    }
    if (state.authed && state.data.profile) {
      heroMember((state.data.profile && state.data.profile.profile) || {}, state.data.access);
      if (dash) { dash.innerHTML = memberCards(state.data); dash.hidden = false; }
    } else {
      heroPublic();
      if (dash) { dash.innerHTML = publicCards(); dash.hidden = false; }
    }
  }

  function meSection(title, inner) {
    return '<article class="gaia-card gaia-card-pad gaia-me-card"><p class="gaia-me-card__label">' + esc(title) + '</p>' + inner + '</article>';
  }
  function meRow(label, meta) {
    return '<div class="gaia-me-row"><span>' + esc(label) + '</span>' + (meta ? '<span class="gaia-me-row__meta">' + esc(meta) + '</span>' : '') + '</div>';
  }
  function meEmpty(t) { return '<p class="gaia-me-empty">' + esc(t) + '</p>'; }

  function renderMe() {
    const main = document.querySelector('.gaia-screen[data-screen="profile"] .gaia-main');
    const box = el('member-me');
    if (!main || !box) return;
    Array.from(main.children).forEach((ch) => {
      const keep = ch.classList.contains('gaia-profile-hero') || ch.id === 'member-me'
        || ch.id === 'me-wellness' || ch.id === 'me-chakra'
        || ch.hasAttribute('data-sign-out') || ch.hasAttribute('data-admin-locked')
        || ch.hasAttribute('data-admin-entry') || ch.tagName === 'P';
      if (!keep) ch.style.display = 'none';
    });
    const heroTitle = main.querySelector('.gaia-profile-hero .gaia-page-title');
    const heroSub = main.querySelector('.gaia-profile-hero .gaia-caption');
    const d = state.data;
    const storeRow = '<a class="gaia-me-row gaia-me-row--link" href="home.html?view=store"><span>Store &amp; memberships</span><span class="gaia-me-row__meta">Shop →</span></a>';

    if (!(state.authed && d.profile)) {
      if (heroTitle) heroTitle.textContent = 'Your profile';
      if (heroSub) heroSub.textContent = 'Sign in to see your memberships, devices, bookings, and more.';
      box.innerHTML = meSection('Members', '<p class="gaia-me-empty">Sign in to open your personal Gaia — profile, devices, purchases, bookings, and messages.</p><a class="gaia-member-card__cta" href="' + esc(portalBase()) + '" target="_blank" rel="noopener noreferrer">Sign in →</a>')
        + meSection('Shop', storeRow);
      return;
    }

    const p = (d.profile && d.profile.profile) || {};
    if (heroTitle) heroTitle.textContent = p.name || 'Member';
    const bits = [];
    if (p.membershipTier) bits.push(esc(p.membershipTier) + ' member');
    if (p.practitioner) bits.push(p.practitionerCertified ? 'Certified practitioner' : 'Practitioner');
    if (p.email) bits.push(esc(p.email));
    if (heroSub) heroSub.innerHTML = bits.join(' · ') || 'Gaia member';

    const rows = [];
    const devices = (d.devices && d.devices.devices) || [];
    rows.push(meSection('My devices', devices.length
      ? devices.map((x) => meRow(x.name, x.serialNumber ? 'SN ' + x.serialNumber : '')).join('')
      : meEmpty('No devices on record yet.')));

    const pcnt = (d.purchases && d.purchases.counts) || {};
    rows.push(meSection('Purchases & subscriptions', (pcnt.orders || pcnt.subscriptions)
      ? meRow((pcnt.orders || 0) + ' order' + ((pcnt.orders === 1) ? '' : 's'), (pcnt.subscriptions || 0) + ' subscription' + ((pcnt.subscriptions === 1) ? '' : 's'))
      : meEmpty('No purchases yet.')));

    const appts = (d.appts && d.appts.appointments) || [];
    const now = Date.now();
    const upcoming = appts.filter((a) => { const x = Date.parse(a.startTime || ''); return isFinite(x) && x > now; });
    const booking = (d.appts && d.appts.bookingLinks) || [];
    rows.push(meSection('My bookings',
      (upcoming.length
        ? upcoming.slice(0, 3).map((a) => meRow(a.title || 'Appointment', new Date(a.startTime).toLocaleDateString())).join('')
        : meEmpty('No upcoming appointments.'))
      + (booking[0] ? '<a class="gaia-member-card__cta" href="' + esc(booking[0].openUrl) + '" target="_blank" rel="noopener noreferrer">Book a ' + esc(booking[0].name) + ' →</a>' : '')));

    const fcnt = (d.forms && d.forms.counts) || {};
    rows.push(meSection('Forms & surveys', (fcnt.forms || fcnt.surveys)
      ? meRow((fcnt.forms || 0) + ' form' + ((fcnt.forms === 1) ? '' : 's') + ' submitted', (fcnt.surveys || 0) + ' survey' + ((fcnt.surveys === 1) ? '' : 's'))
      : meEmpty('No submissions yet.')));

    const ncnt = (d.notif && d.notif.counts) || {};
    rows.push(meSection('Messages', meRow(ncnt.unread ? ncnt.unread + ' unread' : 'All caught up', (ncnt.conversations || 0) + ' conversation' + ((ncnt.conversations === 1) ? '' : 's'))));

    rows.push(meSection('Account',
      storeRow
      + '<a class="gaia-me-row gaia-me-row--link" href="' + esc(portalBase()) + '" target="_blank" rel="noopener noreferrer"><span>Open Gaia Healers portal</span><span class="gaia-me-row__meta">education.gaiahealers.com</span></a>'));

    box.innerHTML = rows.join('');
  }

  function renderAcademy() {
    const main = document.querySelector('.gaia-screen[data-screen="academy"] .gaia-main');
    const box = el('member-academy');
    if (!main || !box) return;
    Array.from(main.children).forEach((ch) => { if (ch.id !== 'member-academy') ch.style.display = 'none'; });
    const cap = document.getElementById('academy-summary-caption');
    if (cap) cap.textContent = 'Your courses live in the Gaia Healers portal.';
    const courses = state.data.courses || {};
    const hub = courses.portalUrl || (portalBase() + '/courses');
    const rows = [meSection('Academy',
      '<p class="gaia-me-empty">Your courses, lessons, and certificates live in the Gaia Healers portal. Open the Academy to continue where you left off — Gaia can guide you, but lesson progress opens in the portal.</p>'
      + '<a class="gaia-member-card__cta" href="' + esc(hub) + '" target="_blank" rel="noopener noreferrer">Open Academy →</a>')];
    if (!state.authed) rows.push(meSection('Members', '<p class="gaia-me-empty">Sign in to see which courses are included in your membership.</p>'));
    box.innerHTML = rows.join('');
  }

  function renderCommunity() {
    const box = el('community-public');
    if (!box) return;
    if (state.authed && state.data.profile) {
      box.innerHTML = meSection('Community', '<a class="gaia-me-row gaia-me-row--link" href="' + esc(portalBase()) + '" target="_blank" rel="noopener noreferrer"><span>Open the community portal</span><span class="gaia-me-row__meta">education.gaiahealers.com</span></a>');
    } else {
      box.innerHTML = meSection('Communities', '<p class="gaia-me-empty">Sign in to see which Gaia Healers communities you are part of and open them.</p><a class="gaia-member-card__cta" href="' + esc(portalBase()) + '" target="_blank" rel="noopener noreferrer">Sign in →</a>');
    }
  }

  /* ---------- Public, no-login features ---------- */
  function chakras() { return (window.GAIA_CHAKRAS || []); }

  function fmtEventDate(ev) {
    const s = ev && ev.startDate ? new Date(ev.startDate) : null;
    const e = ev && ev.endDate ? new Date(ev.endDate) : null;
    if (s && e && isFinite(+s) && isFinite(+e)) {
      const md = { month: 'short', day: 'numeric' };
      return s.toLocaleDateString(undefined, md) + ' – ' + e.toLocaleDateString(undefined, md) + ', ' + e.getFullYear();
    }
    return (ev && ev.date) || '';
  }

  function nextEventCard() {
    const ev = state.event;
    if (!ev || !ev.name) return '';
    const when = fmtEventDate(ev);
    const url = esc(ev.sourceUrl || 'https://elevate.gaiahealers.com/gaia-healers-elevate-conference-page');
    return meSection('Next event',
      '<p class="gaia-me-card__value">' + esc(ev.name) + '</p>'
      + (when ? meRow('When', when) : '')
      + (ev.venue ? meRow('Where', ev.venue) : '')
      + '<a class="gaia-member-card__cta" href="' + url + '" target="_blank" rel="noopener noreferrer">View event &amp; register →</a>');
  }

  function digitRoot(n) { n = Math.abs(n); while (n > 9) { n = String(n).split('').reduce((a, d) => a + (+d), 0); } return n; }
  function chakraForDate(str) {
    const chs = chakras(); if (!chs.length || !str) return null;
    const d = new Date(str + 'T00:00:00'); if (isNaN(+d)) return null;
    const sum = digitRoot(d.getFullYear() + (d.getMonth() + 1) + d.getDate());
    return chs[(sum - 1) % chs.length];
  }
  function readingInner(c) {
    if (!c) return '<p class="gaia-me-empty">Enter your birth date to see your chakra focus.</p>';
    return '<span class="gaia-chakra-dot" style="background:' + esc(c.color) + '"></span>'
      + '<div><p class="gaia-me-card__label" style="margin:0">' + esc(c.name) + (c.sanskrit ? ' · ' + esc(c.sanskrit) : '') + '</p>'
      + '<p class="gaia-me-empty" style="margin:.15rem 0 0">' + esc(c.focus || '') + (c.element ? ' · ' + esc(c.element) : '') + '</p></div>';
  }
  function chakraReadingCard(dobVal) {
    if (!chakras().length) return '';
    return meSection('Your birth-date chakra',
      '<input type="date" id="dob-input" class="gaia-dob-input" value="' + esc(dobVal || '') + '" max="2035-12-31" aria-label="Your date of birth" />'
      + '<div id="chakra-read-out" class="gaia-chakra-read">' + readingInner(chakraForDate(dobVal)) + '</div>'
      + '<p class="gaia-me-hint">Wellness guidance, not medical advice.</p>');
  }

  // Home shows ONLY the live Next Event (kept simple).
  function renderHomeEvent() {
    const box = el('public-features'); if (!box) return;
    box.innerHTML = nextEventCard();
  }

  // Me (personal) birth-date chakra reading. The chakra BODY MAP is static markup
  // (#me-chakra) built by gaia-ui.js; we only re-position it when Profile is shown.
  function renderMeWellness() {
    const box = el('me-wellness'); if (!box) return;
    if (!chakras().length) { box.innerHTML = ''; return; }
    const dob = (el('dob-input') && el('dob-input').value) || '';
    box.innerHTML = chakraReadingCard(dob);
    refreshChakraMap(); // position the (statically built) body map, incl. direct load
  }

  // The body map's nodes are positioned off the image size, which is 0 while the
  // Profile screen is hidden OR the 417KB image is still loading — so retry the
  // re-layout until the photo actually has width.
  function refreshChakraMap() {
    const api = window.GaiaChakraMaps;
    if (!api || !api.refresh) return;
    let tries = 0;
    const tick = () => {
      api.refresh();
      const img = document.querySelector('#me-chakra .gaia-chakra-map__photo');
      const ready = img && img.clientWidth > 10;
      if (!ready && tries++ < 20) setTimeout(tick, 150);
    };
    requestAnimationFrame(() => requestAnimationFrame(tick));
  }

  function bindWellness() {
    if (document.body.dataset.wellnessBound) return; document.body.dataset.wellnessBound = '1';
    document.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'dob-input') {
        const out = el('chakra-read-out');
        if (out) out.innerHTML = readingInner(chakraForDate(e.target.value));
      }
    });
    // Re-position the chakra body map whenever the Profile view is opened.
    window.addEventListener('gaia:route', () => {
      const view = (window.GaiaAppShell && window.GaiaAppShell.currentView && window.GaiaAppShell.currentView()) || '';
      if (view === 'profile') refreshChakraMap();
    });
  }

  async function loadEvent() {
    const boot = await getJson('/api/app/bootstrap');
    const ev = boot && boot.gaia && boot.gaia.event;
    if (ev && ev.name) { state.event = ev; renderHomeEvent(); renderStore(); }
  }

  /* ---------- Store / sale surfaces (structure + live wiring) ---------- */
  function storeCta(label, href, ext) {
    return '<a class="gaia-member-card__cta" href="' + esc(href) + '"' + (ext ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + esc(label) + ' →</a>';
  }
  function money(amt, cur) {
    if (amt == null || amt === '') return '';
    const n = Number(amt); if (!isFinite(n)) return '';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(n); }
    catch (_) { return (cur || '$') + n; }
  }
  function saleRowLink(name, href) {
    return '<a class="gaia-me-row gaia-me-row--link" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer"><span>' + esc(name) + '</span><span class="gaia-me-row__meta">Open →</span></a>';
  }

  function renderStore() {
    const box = el('store-body'); if (!box) return;
    const d = state.data; const portal = portalBase();
    const rows = [];

    // 1) Memberships (from live access)
    const comm = (d.access && d.access.communities) || {};
    const unlocked = comm.unlocked || [];
    const joinable = (comm.locked || []).filter((c) => c.state !== 'unknown');
    if (state.authed) {
      const inner = unlocked.map((c) => meRow(c.name, 'Member')).join('')
        + joinable.map((c) => '<a class="gaia-me-row gaia-me-row--link" href="' + esc(c.openUrl || portal) + '" target="_blank" rel="noopener noreferrer"><span>' + esc(c.name) + '</span><span class="gaia-me-row__meta">Join →</span></a>').join('');
      rows.push(meSection('Memberships', inner || meEmpty('No memberships on record yet.')));
    } else {
      rows.push(meSection('Memberships', meEmpty('Practitioner communities and membership tiers.') + storeCta('Sign in to join', portal, true)));
    }

    // 2) Products (Bio-Well devices, tools)
    const prod = d.products || {};
    const owned = prod.ownedProducts || [];
    rows.push(meSection('Products',
      (owned.length ? owned.map((p) => meRow(p.name, 'Owned')).join('') : meEmpty('Bio-Well devices, add-ons, and practitioner tools.'))
      + storeCta('Browse the store', prod.storeUrl || portal, true)));

    // 3) Subscriptions
    const subs = (prod.subscriptions && prod.subscriptions.length) ? prod.subscriptions : ((d.purchases && d.purchases.subscriptions) || []);
    rows.push(meSection('Subscriptions',
      (subs.length ? subs.map((s) => meRow(s.status || 'Subscription', money(s.amount, s.currency))).join('') : meEmpty('No active subscriptions.'))
      + storeCta('Manage in portal', portal, true)));

    // 4) Event tickets / registration (live event)
    const ev = state.event;
    rows.push(meSection('Event tickets',
      (ev && ev.name)
        ? ('<p class="gaia-me-card__value">' + esc(ev.name) + '</p>' + (fmtEventDate(ev) ? meRow('When', fmtEventDate(ev)) : '')
           + storeCta('Register', ev.sourceUrl || 'https://elevate.gaiahealers.com/gaia-healers-elevate-conference-page', true))
        : meEmpty('No upcoming event on sale right now.')));

    // 5) Booking a scan / session (live booking links)
    const booking = (d.appts && d.appts.bookingLinks) || [];
    rows.push(meSection('Book a scan or session',
      booking.length
        ? booking.map((b) => '<a class="gaia-me-row gaia-me-row--link" href="' + esc(b.openUrl) + '" target="_blank" rel="noopener noreferrer"><span>' + esc(b.name) + '</span><span class="gaia-me-row__meta">Book →</span></a>').join('')
        : (meEmpty('Bio-Well scans and 1:1 sessions.') + storeCta('See booking options', portal, true))));

    box.innerHTML = rows.join('');
  }

  function render() { renderHome(); renderHomeEvent(); renderMe(); renderMeWellness(); renderStore(); renderAcademy(); renderCommunity(); }

  document.addEventListener('DOMContentLoaded', () => {
    render(); // public first paint
    bindWellness();
    loadEvent(); // live Next Event from the Event Manager (public)
  });
  document.addEventListener('gaia:auth', (e) => {
    if (e && e.detail && e.detail.authenticated) loadMember();
    else { state.authed = false; state.data = {}; render(); }
  });
})();
