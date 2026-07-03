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
    const [profile, access, appts, notif] = await Promise.all([
      getJson('/api/member/profile'), getJson('/api/member/access'),
      getJson('/api/member/appointments'), getJson('/api/member/notifications'),
    ]);
    state.authed = !!(profile && profile.ok && profile.authenticated);
    state.data = { profile, access, appts, notif };
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

  function render() {
    const dash = el('member-dashboard');
    // Home = hero + live dashboard only. Hide all legacy Today sections (they
    // contained demo/fake data: 87 readiness, 62% progress, "Module 4", etc.).
    const main = document.querySelector('.gaia-main--today');
    if (main) {
      Array.from(main.children).forEach((ch) => {
        if (ch === dash || ch.id === 'gaia-coach-anchor' || ch.classList.contains('gaia-dash-hero')) return;
        ch.style.display = 'none'; // inline beats class display rules (e.g. .gaia-bento{display:grid})
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

  document.addEventListener('DOMContentLoaded', render); // public first paint
  document.addEventListener('gaia:auth', (e) => {
    if (e && e.detail && e.detail.authenticated) loadMember();
    else { state.authed = false; state.data = {}; render(); }
  });
})();
