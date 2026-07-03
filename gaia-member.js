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

  // ── HOME (new g-* design system) ─────────────────────────────
  function heroGreeting() {
    if (state.authed && state.data.profile) {
      const p = (state.data.profile && state.data.profile.profile) || {};
      const first = String(p.name || 'there').trim().split(/\s+/)[0] || 'there';
      const h = new Date().getHours();
      const g = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
      return { kicker: g, title: 'Hi <em>' + esc(first) + '</em>' };
    }
    return { kicker: 'Your energy', title: 'Welcome to <em>Gaia&nbsp;Healers</em>' };
  }

  // The signature hero: the living chakra body (image carries the glowing
  // centres) + greeting; the centres are tappable to reveal their essence.
  function renderChakraHero() {
    const box = el('home-chakra-hero'); if (!box) return;
    const chs = window.GAIA_CHAKRAS || [];
    const g = heroGreeting();
    const hits = chs.map((c, i) => '<button type="button" class="g-chakra-hero__hit" data-ck="' + esc(c.id)
      + '" style="top:' + c.top + '%;left:' + c.left + '%;--ck:' + esc(c.color) + ';--i:' + i + '" aria-label="' + esc(c.name) + ' chakra"></button>').join('');
    box.innerHTML =
      '<div class="g-chakra-hero__stage"><div class="g-chakra-hero__fig">'
      + '<img src="assets/gaia-chakra-meditation.png" alt="A meditating figure with seven glowing energy centres" />'
      + hits + '</div></div>'
      + '<div class="g-chakra-hero__scrim"></div>'
      + '<div class="g-chakra-hero__overlay">'
      + '<p class="g-chakra-hero__kicker">' + esc(g.kicker) + '</p>'
      + '<h1 class="g-chakra-hero__title">' + g.title + '</h1>'
      + '<p class="g-chakra-hero__caption" id="chakra-caption">Tap a centre to explore your energy →</p>'
      + '</div>';
    box.querySelectorAll('.g-chakra-hero__hit').forEach((n) => {
      n.addEventListener('click', () => {
        const c = chs.find((x) => x.id === n.dataset.ck); if (!c) return;
        box.querySelectorAll('.g-chakra-hero__hit').forEach((x) => x.classList.toggle('is-active', x === n));
        const cap = el('chakra-caption'); if (!cap) return;
        const shop = (window.GaiaStore && window.GaiaStore.chakraShopUrl && window.GaiaStore.chakraShopUrl(c.id)) || '';
        cap.innerHTML = '<strong>' + esc(c.name) + '</strong> · ' + esc(c.focus || '')
          + (shop ? ' · <a href="' + esc(shop) + '" target="_blank" rel="noopener noreferrer">Shop this centre →</a>' : '');
      });
    });
  }

  function homeEventCard() {
    const ev = state.event;
    if (!ev || !ev.name) {
      return '<article class="g-card g-card--feature"><p class="g-card__label">Next event</p>'
        + '<p class="g-card__value g-card__value--lg">Coming soon</p>'
        + '<p class="g-card__meta">The next Gaia gathering will appear here.</p></article>';
    }
    const when = fmtEventDate(ev);
    const url = esc(ev.sourceUrl || 'https://elevate.gaiahealers.com/gaia-healers-elevate-conference-page');
    return '<article class="g-card g-card--feature">'
      + '<p class="g-card__label">Next event</p>'
      + '<p class="g-card__value g-card__value--lg">' + esc(ev.name) + '</p>'
      + '<p class="g-card__meta">' + [when && esc(when), ev.venue && esc(ev.venue)].filter(Boolean).join(' · ') + '</p>'
      + '<div class="g-card__actions"><a class="g-btn g-btn--primary" href="' + url + '" target="_blank" rel="noopener noreferrer">Register</a></div>'
      + '</article>';
  }

  function membersCard() {
    if (state.authed && state.data.profile) {
      const unlocked = (state.data.access && state.data.access.communities && state.data.access.communities.unlocked) || [];
      return '<article class="g-card">'
        + '<p class="g-card__label">Your membership</p>'
        + '<p class="g-card__value">' + (unlocked.length ? unlocked.length + (unlocked.length === 1 ? ' community' : ' communities') : 'Member') + '</p>'
        + '<p class="g-card__meta">' + (unlocked.map((c) => esc(c.name)).slice(0, 2).join(', ') || 'Explore your circle') + '</p>'
        + '<div class="g-card__actions"><a class="g-btn g-btn--secondary g-btn--sm" href="home.html?view=community">View access →</a></div>'
        + '</article>';
    }
    return '<article class="g-card">'
      + '<p class="g-card__label">Members</p>'
      + '<p class="g-card__value">Unlock your Gaia</p>'
      + '<p class="g-card__meta">Communities, courses, bookings, and a Gaia that knows you.</p>'
      + '<div class="g-card__actions"><a class="g-btn g-btn--primary g-btn--sm" href="' + esc(portalBase()) + '" target="_blank" rel="noopener noreferrer">Sign in</a></div>'
      + '</article>';
  }

  function renderHome() {
    renderChakraHero();
    const cards = el('home-cards');
    if (cards) cards.innerHTML = homeEventCard() + membersCard();
  }

  function meSection(title, inner) {
    return '<article class="gaia-card gaia-card-pad gaia-me-card"><p class="gaia-me-card__label">' + esc(title) + '</p>' + inner + '</article>';
  }
  function meRow(label, meta) {
    return '<div class="gaia-me-row"><span>' + esc(label) + '</span>' + (meta ? '<span class="gaia-me-row__meta">' + esc(meta) + '</span>' : '') + '</div>';
  }
  function meEmpty(t) { return '<p class="gaia-me-empty">' + esc(t) + '</p>'; }

  // ── g-* account helpers (Profile) ───────────────────────────
  function gMeCard(label, inner) {
    return '<article class="g-card"><p class="g-card__label">' + esc(label) + '</p>' + inner + '</article>';
  }
  function gRows(items) { return '<div class="g-rows">' + items.join('') + '</div>'; }
  function gRow(label, meta) {
    return '<div class="g-row"><span>' + esc(label) + '</span>' + (meta ? '<span class="g-row__meta">' + esc(meta) + '</span>' : '') + '</div>';
  }
  function gRowLink(label, meta, href, ext) {
    return '<a class="g-row g-row--link" href="' + esc(href) + '"' + (ext ? ' target="_blank" rel="noopener noreferrer"' : '')
      + '><span>' + esc(label) + '</span><span class="g-row__meta">' + esc(meta) + '</span></a>';
  }

  // Profile = live account from /api/member/*. Signed-out shows a sign-in card
  // + a preview of what appears; the birth-date chakra (below) is public.
  function renderMe() {
    const box = el('member-me');
    if (!box) return;
    const d = state.data;
    const title = el('profile-title');
    const sub = el('profile-sub');
    const kicker = el('profile-kicker');

    if (!(state.authed && d.profile)) {
      if (kicker) kicker.textContent = 'Your account';
      if (title) title.textContent = 'Profile';
      if (sub) sub.textContent = 'Sign in to see your memberships, devices, bookings, and messages.';
      box.innerHTML =
        '<article class="g-card g-card--feature"><p class="g-card__label">Members</p>'
        + '<p class="g-card__value g-card__value--lg">Your personal Gaia</p>'
        + '<p class="g-card__meta">Sign in to open your profile, devices, purchases, bookings, and a Gaia Assist that knows you.</p>'
        + '<div class="g-card__actions"><a class="g-btn g-btn--primary g-btn--sm" href="' + esc(portalBase()) + '" target="_blank" rel="noopener noreferrer">Sign in</a></div></article>'
        + gMeCard('What you’ll see', gRows([
          gRow('Membership & communities', ''),
          gRow('Your devices', ''),
          gRow('Purchases & subscriptions', ''),
          gRow('Bookings', ''),
          gRow('Messages', ''),
        ]))
        + gMeCard('Shop', gRows([gRowLink('Store & memberships', 'Shop →', 'home.html?view=store', false)]));
      return;
    }

    const p = (d.profile && d.profile.profile) || {};
    const first = String(p.name || 'Member').trim();
    if (kicker) kicker.textContent = 'Your account';
    if (title) title.textContent = first;
    const bits = [];
    if (p.membershipTier) bits.push(p.membershipTier + ' member');
    else bits.push('Member');
    if (p.practitioner) bits.push(p.practitionerCertified ? 'Certified practitioner' : 'Practitioner');
    if (p.email) bits.push(p.email);
    if (sub) sub.textContent = bits.join(' · ');

    const cards = [];

    // Membership status (feature card)
    const tierName = p.membershipTier ? p.membershipTier + ' member' : 'Free member';
    cards.push('<article class="g-card g-card--feature"><div class="g-tier__head"><p class="g-card__label">Membership</p>'
      + (p.membershipTier ? '<span class="g-badge g-badge--on">Active</span>' : '') + '</div>'
      + '<p class="g-card__value g-card__value--lg">' + esc(tierName) + '</p>'
      + (p.practitioner ? '<p class="g-card__meta">' + (p.practitionerCertified ? 'Certified Bio-Well practitioner' : 'Practitioner') + '</p>' : '')
      + '<div class="g-card__actions"><a class="g-btn g-btn--secondary g-btn--sm" href="home.html?view=store">View memberships →</a>'
      + '<a class="g-btn g-btn--ghost g-btn--sm" href="home.html?view=community">My access →</a></div></article>');

    const devices = (d.devices && d.devices.devices) || [];
    cards.push(gMeCard('My devices', devices.length
      ? gRows(devices.map((x) => gRow(x.name, x.serialNumber ? 'SN ' + x.serialNumber : '')))
      : '<p class="g-empty">No devices on record yet.</p>'));

    const pcnt = (d.purchases && d.purchases.counts) || {};
    cards.push(gMeCard('Purchases & subscriptions', (pcnt.orders || pcnt.subscriptions)
      ? gRows([gRow((pcnt.orders || 0) + ' order' + ((pcnt.orders === 1) ? '' : 's'), (pcnt.subscriptions || 0) + ' subscription' + ((pcnt.subscriptions === 1) ? '' : 's'))])
      : '<p class="g-empty">No purchases yet.</p>'));

    const appts = (d.appts && d.appts.appointments) || [];
    const now = Date.now();
    const upcoming = appts.filter((a) => { const x = Date.parse(a.startTime || ''); return isFinite(x) && x > now; });
    const booking = (d.appts && d.appts.bookingLinks) || [];
    cards.push(gMeCard('My bookings',
      (upcoming.length
        ? gRows(upcoming.slice(0, 3).map((a) => gRow(a.title || 'Appointment', new Date(a.startTime).toLocaleDateString())))
        : '<p class="g-empty">No upcoming appointments.</p>')
      + (booking[0] ? '<div class="g-card__actions"><a class="g-btn g-btn--secondary g-btn--sm" href="' + esc(booking[0].openUrl) + '" target="_blank" rel="noopener noreferrer">Book a ' + esc(booking[0].name) + ' →</a></div>' : '')));

    const fcnt = (d.forms && d.forms.counts) || {};
    cards.push(gMeCard('Forms & surveys', (fcnt.forms || fcnt.surveys)
      ? gRows([gRow((fcnt.forms || 0) + ' form' + ((fcnt.forms === 1) ? '' : 's') + ' submitted', (fcnt.surveys || 0) + ' survey' + ((fcnt.surveys === 1) ? '' : 's'))])
      : '<p class="g-empty">No submissions yet.</p>'));

    const ncnt = (d.notif && d.notif.counts) || {};
    cards.push(gMeCard('Messages', gRows([gRow(ncnt.unread ? ncnt.unread + ' unread' : 'All caught up', (ncnt.conversations || 0) + ' conversation' + ((ncnt.conversations === 1) ? '' : 's'))])));

    cards.push(gMeCard('Account', gRows([
      gRowLink('Store & memberships', 'Shop →', 'home.html?view=store', false),
      gRowLink('Open Gaia Healers portal', 'education.gaiahealers.com', portalBase(), true),
    ])));

    box.innerHTML = cards.join('');
  }

  // Academy = honest course portal. Lesson progress isn't exposed by GHL, so we
  // deep-link into the portal instead of faking progress bars.
  function renderAcademy() {
    const box = el('member-academy');
    if (!box) return;
    const cap = el('academy-summary-caption');
    if (cap) cap.textContent = state.authed ? 'Your courses live in the Gaia Healers portal.' : 'Sign in to continue where you left off.';
    const courses = state.data.courses || {};
    const hub = courses.portalUrl || (portalBase() + '/courses');
    const tracks = [
      { name: 'Bio-Well Certification', desc: 'Become a certified Bio-Well practitioner.' },
      { name: 'Colour Energy', desc: 'Colour therapy foundations & practitioner path.' },
      { name: 'BioPulsar Training', desc: 'Aura imaging & biofeedback device training.' },
    ];
    const trackCard = (t) => '<a class="g-access g-access--unlocked g-access--link" href="' + esc(hub) + '" target="_blank" rel="noopener noreferrer">'
      + '<div class="g-access__body"><span class="g-access__name">' + esc(t.name) + '</span><span class="g-access__meta">' + esc(t.desc) + '</span></div>'
      + '<span class="g-chip g-chip--on g-access__act">Open →</span></a>';
    const parts = [
      '<article class="g-card g-card--feature"><p class="g-card__label">Academy</p>'
      + '<p class="g-card__value g-card__value--lg">Continue learning</p>'
      + '<p class="g-card__meta">Your courses, lessons, and certificates live in the Gaia Healers portal. Gaia can guide you — lesson progress opens in the portal.</p>'
      + '<div class="g-card__actions"><a class="g-btn g-btn--primary g-btn--sm" href="' + esc(hub) + '" target="_blank" rel="noopener noreferrer">Open Academy →</a></div></article>',
      gSec('Explore tracks', '<div class="g-access-grid">' + tracks.map(trackCard).join('') + '</div>'),
    ];
    if (!state.authed) {
      parts.push('<article class="g-card"><p class="g-card__label">Members</p>'
        + '<p class="g-card__meta">Sign in to see which courses are included in your membership.</p>'
        + '<div class="g-card__actions"><a class="g-btn g-btn--secondary g-btn--sm" href="' + esc(portalBase()) + '" target="_blank" rel="noopener noreferrer">Sign in</a></div></article>');
    }
    box.innerHTML = parts.join('');
  }

  // ── g-* page helpers (Community / Academy) ──────────────────
  function gSec(title, inner, action) {
    return '<section class="g-page-sec">'
      + '<div class="g-section"><div class="g-section__lead"><h2 class="g-section__title">' + esc(title) + '</h2></div>'
      + (action || '') + '</div>' + inner + '</section>';
  }
  function accessItem(c, kind) {
    const cls = kind === 'unlocked' ? 'g-access--unlocked' : (kind === 'soon' ? 'g-access--soon' : 'g-access--locked');
    let meta;
    let act;
    if (kind === 'unlocked') {
      meta = c.openUrlIsFallback ? 'Opens in the Gaia portal' : 'Your community';
      act = '<a class="g-btn g-btn--secondary g-btn--sm g-access__act" href="' + esc(c.openUrl || portalBase()) + '" target="_blank" rel="noopener noreferrer">Open →</a>';
    } else if (kind === 'soon') {
      meta = c.reason || 'Coming soon to Gaia Healers';
      act = '<span class="g-chip g-access__act">Soon</span>';
    } else {
      meta = c.reason || 'Not included in your membership';
      act = '<span class="g-chip g-chip--lock g-access__act">Members</span>';
    }
    return '<div class="g-access ' + cls + '"><div class="g-access__body">'
      + '<span class="g-access__name">' + esc(c.name) + '</span>'
      + '<span class="g-access__meta">' + esc(meta) + '</span></div>' + act + '</div>';
  }

  // Community = the live "My Access" unlock grid (real GHL tags via
  // /api/member/access). Signed-out visitors see what circles exist + a
  // sign-in CTA; no fake unlocks.
  function renderCommunity() {
    const box = el('community-body');
    if (!box) return;
    const sub = el('community-sub');
    const acc = state.data.access;

    if (!(state.authed && acc && acc.communities)) {
      if (sub) sub.textContent = 'Sign in to see which circles your membership opens.';
      const preview = ['All Gaia Healers', 'Bio-Well Practitioners', 'BioPulsar Practitioners', 'BioTekna Practitioners', 'HealeeX Community', 'Abundant Healer Collective']
        .map((name) => accessItem({ name: name, reason: 'Sign in to check your access' }, 'locked')).join('');
      box.innerHTML =
        '<article class="g-card g-card--feature"><p class="g-card__label">Community</p>'
        + '<p class="g-card__value g-card__value--lg">Open your circles</p>'
        + '<p class="g-card__meta">Sign in to see which Gaia Healers communities your membership unlocks — and open them in one tap.</p>'
        + '<div class="g-card__actions"><a class="g-btn g-btn--primary g-btn--sm" href="' + esc(portalBase()) + '" target="_blank" rel="noopener noreferrer">Sign in</a></div></article>'
        + gSec('What’s inside', '<div class="g-access-grid">' + preview + '</div>');
      return;
    }

    const cm = acc.communities;
    const unlocked = cm.unlocked || [];
    const locked = (cm.locked || []).filter((x) => x.state !== 'unknown');
    const soon = (cm.locked || []).filter((x) => x.state === 'unknown');
    const m = acc.member || {};
    if (sub) {
      const bits = [m.name || 'Member'];
      if (m.membershipTier) bits.push(m.membershipTier + ' member');
      if (m.practitioner) bits.push(m.practitionerCertified ? 'Certified practitioner' : 'Practitioner');
      sub.textContent = bits.join(' · ');
    }

    const parts = ['<div class="g-stats">'
      + '<div class="g-stat"><span class="g-stat__n g-stat__n--accent">' + unlocked.length + '</span><span class="g-stat__l">Unlocked</span></div>'
      + '<div class="g-stat"><span class="g-stat__n">' + locked.length + '</span><span class="g-stat__l">To unlock</span></div>'
      + '<div class="g-stat"><span class="g-stat__n">' + soon.length + '</span><span class="g-stat__l">Coming soon</span></div></div>'];

    if (unlocked.length) {
      parts.push(gSec('Your communities', '<div class="g-access-grid">' + unlocked.map((x) => accessItem(x, 'unlocked')).join('') + '</div>'));
    } else {
      parts.push('<article class="g-card"><p class="g-card__label">Your communities</p><p class="g-card__meta">No communities unlocked yet — your membership will light them up here.</p></article>');
    }
    if (locked.length) {
      parts.push(gSec('Unlock with membership', '<div class="g-access-grid">' + locked.map((x) => accessItem(x, 'locked')).join('') + '</div>',
        '<a class="g-btn g-btn--ghost g-btn--sm g-section__action" href="' + esc(portalBase()) + '" target="_blank" rel="noopener noreferrer">Become a member →</a>'));
    }
    if (soon.length) {
      parts.push(gSec('Coming soon', '<div class="g-access-grid">' + soon.map((x) => accessItem(x, 'soon')).join('') + '</div>'));
    }
    box.innerHTML = parts.join('');
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

  function digitRoot(n) { n = Math.abs(n); while (n > 9) { n = String(n).split('').reduce((a, d) => a + (+d), 0); } return n; }
  function chakraForDate(str) {
    const chs = chakras(); if (!chs.length || !str) return null;
    const d = new Date(str + 'T00:00:00'); if (isNaN(+d)) return null;
    const sum = digitRoot(d.getFullYear() + (d.getMonth() + 1) + d.getDate());
    return chs[(sum - 1) % chs.length];
  }
  function readingInner(c) {
    if (!c) return '<p class="g-empty">Enter your birth date to see your chakra focus.</p>';
    const col = esc(c.color);
    return '<span class="g-chakra-dot" style="background:' + col + ';color:' + col + '"></span>'
      + '<div><p class="g-card__label" style="margin:0">' + esc(c.name) + (c.sanskrit ? ' · ' + esc(c.sanskrit) : '') + '</p>'
      + '<p class="g-empty" style="margin:.15rem 0 0">' + esc(c.focus || '') + (c.element ? ' · ' + esc(c.element) : '') + '</p></div>';
  }
  function chakraReadingCard(dobVal) {
    if (!chakras().length) return '';
    return '<article class="g-card"><p class="g-card__label">Your birth-date chakra</p>'
      + '<input type="date" id="dob-input" class="g-dob" value="' + esc(dobVal || '') + '" max="2035-12-31" aria-label="Your date of birth" />'
      + '<div id="chakra-read-out" class="g-chakra-read">' + readingInner(chakraForDate(dobVal)) + '</div>'
      + '<p class="g-hint">Wellness guidance, not medical advice.</p></article>';
  }

  // Me (personal): birth-date → chakra reading only. The chakra BODY MAP lives on
  // Home now.
  function renderMeWellness() {
    const box = el('me-wellness'); if (!box) return;
    if (!chakras().length) { box.innerHTML = ''; return; }
    const dob = (el('dob-input') && el('dob-input').value) || '';
    box.innerHTML = chakraReadingCard(dob);
  }

  // The body map (on Home) positions its nodes off the image size, which is 0
  // while Home is hidden OR the 417KB image is still loading — retry the
  // re-layout until the photo actually has width.
  function refreshChakraMap() {
    const api = window.GaiaChakraMaps;
    if (!api || !api.refresh) return;
    let tries = 0;
    const tick = () => {
      api.refresh();
      const img = document.querySelector('#home-chakra .gaia-chakra-map__photo');
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
      if (view === 'today') refreshChakraMap();
    });
  }

  async function loadEvent() {
    const boot = await getJson('/api/app/bootstrap');
    const ev = boot && boot.gaia && boot.gaia.event;
    if (ev && ev.name) { state.event = ev; renderHome(); renderStore(); }
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

  // Membership presented as UNLOCKED ABILITIES, not invented paid tiers.
  // Real model: Explorer (free/public, not a GHL tier) · Silver (the one paid
  // GHL membership tag) · Practitioner (earned via certification, not bought).
  // Membership tier card = g-card composition (g-tier list + g-badge).
  function tierCard(o) {
    return '<article class="g-card' + (o.active ? ' g-card--feature' : '') + '">'
      + '<div class="g-tier__head"><p class="g-card__label">' + esc(o.name) + '</p>'
      + (o.statusLabel ? '<span class="g-badge' + (o.active ? ' g-badge--on' : '') + '">' + esc(o.statusLabel) + '</span>' : '') + '</div>'
      + '<ul class="g-tier__list">' + o.abilities.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ul>'
      + (o.note ? '<p class="g-card__meta">' + esc(o.note) + '</p>' : '')
      + (o.ctaHref ? '<div class="g-card__actions"><a class="g-btn ' + (o.active ? 'g-btn--secondary' : 'g-btn--primary') + ' g-btn--sm" href="' + esc(o.ctaHref) + '" target="_blank" rel="noopener noreferrer">' + esc(o.ctaLabel) + '</a></div>' : '')
      + '</article>';
  }
  function membershipCards() {
    const acc = (state.data.access && state.data.access.member) || {};
    const authed = state.authed;
    const hasSilver = /silver/i.test(acc.membershipTier || '');
    const isCert = !!acc.practitionerCertified;
    const isPract = isCert || !!acc.practitioner;
    const shopBase = (window.GaiaStore && window.GaiaStore.shopBase) || 'https://gaiahealers.com';
    const baseline = !authed || (!hasSilver && !isPract);

    const intro = '<article class="g-card"><p class="g-card__label">Membership</p>'
      + '<p class="g-card__meta">Gaia Healers unlocks more as you grow — here’s what each level opens. This reflects your real access, not invented tiers.</p></article>';
    const explorer = tierCard({
      name: 'Explorer', statusLabel: baseline ? 'Current' : 'Included', active: baseline,
      abilities: ['Public Gaia Assist', 'Chakra experience & birth-date reading', 'Public events & articles', 'Browse the store'],
    });
    const silver = tierCard({
      name: 'Silver member', statusLabel: hasSilver ? 'Active' : '', active: hasSilver,
      abilities: ['Everything in Explorer', 'Your practitioner communities', 'Member pricing & event discounts', 'Personalized Gaia Assist', 'Bio-Well device sync', 'Exclusive content'],
      ctaLabel: hasSilver ? '' : 'Become a member', ctaHref: hasSilver ? '' : portalBase(),
    });
    const practitioner = tierCard({
      name: 'Practitioner', statusLabel: isCert ? 'Certified' : (isPract ? 'Practitioner' : ''), active: isPract,
      abilities: ['Everything in Silver', 'Practitioner directory listing', 'Practitioner communities', 'Certified badge'],
      note: 'Earned through Bio-Well certification — not a paid tier.',
      ctaLabel: isPract ? '' : 'Get certified', ctaHref: isPract ? '' : (shopBase + '/collections/biowell-courses'),
    });
    return intro + explorer + silver + practitioner;
  }

  // Store "Membership" tab. Products live in the "Shop" tab (gaia-store.js);
  // personal entitlements (orders, bookings) move to Profile in its redesign.
  function renderStore() {
    const box = el('store-memberships'); if (!box) return;
    box.innerHTML = membershipCards();
  }

  function render() { renderHome(); renderMe(); renderMeWellness(); renderStore(); renderAcademy(); renderCommunity(); }

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
