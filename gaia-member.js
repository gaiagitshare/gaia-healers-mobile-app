/** Gaia — signed-in member layer (Phase 5).
 * Reads the LIVE normalized /api/member/* endpoints and renders the Home
 * dashboard. No fake data: legacy demo tiles are hidden; signed-out users see a
 * public welcome, signed-in users see their real memberships/bookings/messages.
 */
(function () {
  'use strict';
  if (!document.querySelector('.gaia-main--today')) return; // home.html only

  const state = { authed: false, data: {} };
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
    const [profile, access, appts, notif, devices, purchases, forms, courses] = await Promise.all([
      getJson('/api/member/profile'), getJson('/api/member/access'),
      getJson('/api/member/appointments'), getJson('/api/member/notifications'),
      getJson('/api/member/devices'), getJson('/api/member/purchases'),
      getJson('/api/member/forms'), getJson('/api/member/courses'),
    ]);
    state.authed = !!(profile && profile.ok && profile.authenticated);
    state.data = { profile, access, appts, notif, devices, purchases, forms, courses };
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

    out.push(card('<p class="gaia-member-card__label">Gaia AI</p><p class="gaia-member-card__value">Ask me anything</p><button type="button" class="gaia-member-card__cta" data-gaia-open-assist>Talk to Gaia →</button>'));
    return out.join('');
  }

  function publicCards() {
    return card('<p class="gaia-member-card__label">Members</p><p class="gaia-member-card__value">Unlock your Gaia</p><p class="gaia-member-card__meta">Your profile, memberships, courses, bookings, and a personalized Gaia — all in one place.</p><a class="gaia-member-card__cta" href="' + esc(portalBase()) + '" target="_blank" rel="noopener noreferrer">Sign in →</a>')
      + card('<p class="gaia-member-card__label">Gaia AI</p><p class="gaia-member-card__value">Try the assistant</p><button type="button" class="gaia-member-card__cta" data-gaia-open-assist>Ask Gaia →</button>');
  }

  function renderHome() {
    const dash = el('member-dashboard');
    const main = document.querySelector('.gaia-main--today');
    if (main) {
      Array.from(main.children).forEach((ch) => {
        if (ch === dash || ch.id === 'gaia-coach-anchor' || ch.classList.contains('gaia-dash-hero')) return;
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
        || ch.hasAttribute('data-sign-out') || ch.hasAttribute('data-admin-locked')
        || ch.hasAttribute('data-admin-entry') || ch.tagName === 'P';
      if (!keep) ch.style.display = 'none';
    });
    const heroTitle = main.querySelector('.gaia-profile-hero .gaia-page-title');
    const heroSub = main.querySelector('.gaia-profile-hero .gaia-caption');
    const d = state.data;

    if (!(state.authed && d.profile)) {
      if (heroTitle) heroTitle.textContent = 'Your profile';
      if (heroSub) heroSub.textContent = 'Sign in to see your memberships, devices, bookings, and more.';
      box.innerHTML = meSection('Members', '<p class="gaia-me-empty">Sign in to open your personal Gaia — profile, devices, purchases, bookings, and messages.</p><a class="gaia-member-card__cta" href="' + esc(portalBase()) + '" target="_blank" rel="noopener noreferrer">Sign in →</a>');
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
      '<a class="gaia-me-row gaia-me-row--link" href="' + esc(portalBase()) + '" target="_blank" rel="noopener noreferrer"><span>Open Gaia Healers portal</span><span class="gaia-me-row__meta">education.gaiahealers.com</span></a>'));

    box.innerHTML = rows.join('');
  }

  function render() { renderHome(); renderMe(); }

  document.addEventListener('DOMContentLoaded', render); // public first paint
  document.addEventListener('gaia:auth', (e) => {
    if (e && e.detail && e.detail.authenticated) loadMember();
    else { state.authed = false; state.data = {}; render(); }
  });
})();
