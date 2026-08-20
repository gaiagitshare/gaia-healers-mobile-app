/** Gaia — signed-in member layer (Phase 5).
 * Reads the LIVE normalized /api/member/* endpoints and renders the Home
 * dashboard. No fake data: legacy demo tiles are hidden; signed-out users see a
 * public welcome, signed-in users see their real memberships/bookings/messages.
 */
(function () {
  'use strict';
  if (!document.querySelector('.gaia-main--today')) return; // home.html only

  // Self-contained styles for the in-app booking modal (avoids touching shared CSS).
  if (!document.getElementById('gaia-booking-modal-styles')) {
    const st = document.createElement('style');
    st.id = 'gaia-booking-modal-styles';
    st.textContent = `
.gaia-booking-modal{position:fixed;inset:0;z-index:100;display:flex;align-items:flex-end;justify-content:center;}
.gaia-booking-modal__backdrop{position:absolute;inset:0;background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
.gaia-booking-modal__sheet{position:relative;width:100%;max-width:480px;height:92vh;height:92dvh;display:flex;flex-direction:column;
  background:#fff;border-radius:20px 20px 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.18);overflow:hidden;
  animation:gaia-booking-up .25s ease-out;}
@keyframes gaia-booking-up{from{transform:translateY(100%)}to{transform:translateY(0)}}
.gaia-booking-modal__head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;
  border-bottom:1px solid rgba(0,0,0,.07);flex-shrink:0;}
.gaia-booking-modal__title{font-size:1.05rem;font-weight:600;color:#1C1C1E;margin:0;}
.gaia-booking-modal__close{flex-shrink:0;width:44px;height:44px;border:none;border-radius:50%;background:#F5F5F7;
  color:#636366;font-size:1.4rem;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;
  -webkit-tap-highlight-color:transparent;}
.gaia-booking-modal__close:active{background:#EFEFF0;}
.gaia-booking-modal__body{flex:1;position:relative;overflow:auto;-webkit-overflow-scrolling:touch;}
.gaia-booking-modal__body iframe{position:absolute;inset:0;width:100%;height:100%;border:none;}
.gaia-reader__body{padding:0;}
.gaia-reader__loading,.gaia-reader__fallback{padding:36px 22px;text-align:center;color:#636366;}
.gaia-reader__cta{display:inline-block;margin-top:14px;padding:11px 20px;border-radius:999px;
  background:#1C1C1E;color:#fff;text-decoration:none;font-weight:600;font-size:.92rem;}
.gaia-reader__list{display:flex;flex-direction:column;padding:8px 0;}
.gaia-reader__item{display:flex;flex-direction:column;gap:5px;padding:16px 20px;text-decoration:none;
  color:inherit;border-bottom:1px solid rgba(0,0,0,.06);}
.gaia-reader__item:last-child{border-bottom:none;}
.gaia-reader__item strong{font-size:1rem;line-height:1.35;font-weight:600;}
.gaia-reader__item span{font-size:.86rem;line-height:1.45;color:#636366;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.gaia-reader__article{padding:20px 22px 40px;font-size:1rem;line-height:1.62;}
.gaia-reader__article h1,.gaia-reader__article h2,.gaia-reader__article h3{
  line-height:1.25;margin:26px 0 10px;font-weight:600;}
.gaia-reader__article h1{font-size:1.5rem;} .gaia-reader__article h2{font-size:1.24rem;}
.gaia-reader__article h3{font-size:1.06rem;}
.gaia-reader__article > *:first-child{margin-top:0;}
.gaia-reader__article p,.gaia-reader__article ul,.gaia-reader__article ol{margin:0 0 15px;}
.gaia-reader__article ul,.gaia-reader__article ol{padding-left:22px;}
.gaia-reader__article li{margin-bottom:6px;}
.gaia-reader__article img{max-width:100%;height:auto;border-radius:12px;display:block;margin:18px 0;}
.gaia-reader__article a{color:#2A7F62;text-decoration:underline;text-underline-offset:2px;}
.gaia-reader__article table{width:100%;border-collapse:collapse;font-size:.9rem;}
.gaia-reader__article td,.gaia-reader__article th{border:1px solid rgba(0,0,0,.1);padding:7px 9px;text-align:left;}
.gaia-booking-modal__loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;
  color:#AEAEB2;font-size:.9rem;background:#fff;}
.gaia-booking-modal__spinner{width:18px;height:18px;border:2px solid #E5E5EA;border-top-color:#5CB82E;border-radius:50%;animation:gaia-spin .8s linear infinite;}
@keyframes gaia-spin{to{transform:rotate(360deg)}}
.gaia-booking-modal__fallback{display:block;text-align:center;padding:12px;font-size:.9rem;color:#5CB82E;
  background:#F6FBF3;border-top:1px solid rgba(92,184,46,.25);text-decoration:none;flex-shrink:0;font-weight:500;
  -webkit-tap-highlight-color:transparent;}
.gaia-booking-modal__fallback:active{background:#ECF7E6;}
body.gaia-booking-open{overflow:hidden;}
/* iOS safe-area so the modal clears the notch/home indicator. */
.gaia-booking-modal__sheet{padding-bottom:env(safe-area-inset-bottom,0);}
.gaia-booking-modal__head{padding-top:max(14px,env(safe-area-inset-top,0));}
/* Auth overlay — shown when an auth-dependent portal iframe stays blank (the
   portal couldn't establish its session inside the iframe). Replaces the blank
   screen with a clear, in-app sign-in path. */
.gaia-booking-modal__auth{position:absolute;inset:0;background:#FAFCF7;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;}
.gaia-booking-modal__auth[hidden]{display:none;}
.gaia-booking-modal__auth-card{max-width:320px;display:flex;flex-direction:column;gap:12px;align-items:stretch;}
.gaia-booking-modal__auth-title{font-size:1.15rem;font-weight:700;color:#1C1C1E;margin:0;}
.gaia-booking-modal__auth-body{font-size:.95rem;color:#545458; line-height:1.5;margin:0;}
.gaia-booking-modal__auth-hint{font-size:.8rem;color:#86868B;margin:0;}
.gaia-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 18px;border-radius:12px;
  background:#5CB82E;color:#fff;font-weight:600;font-size:1rem;text-decoration:none;-webkit-tap-highlight-color:transparent;
  border:none;cursor:pointer;}
.gaia-btn:active{background:#4A9324;}
@media(min-width:640px){.gaia-booking-modal{align-items:center;}.gaia-booking-modal__sheet{height:88vh;height:88dvh;border-radius:20px;}}
`;
    document.head.appendChild(st);
  }

  const state = { authed: false, data: {}, event: null, announcements: [], adminEvents: [], catalog: null };
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
      const r = await fetch(proxyBase() + path, {
        headers: { Accept: 'application/json' },
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function plainDescription(html, maxLength = 220) {
    try {
      const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      const text = String(doc.body.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length <= maxLength) return text;
      return text.slice(0, maxLength).replace(/\s+\S*$/, '').trimEnd() + '…';
    } catch (_) {
      return '';
    }
  }
  function el(id) { return document.getElementById(id); }
  function portalBase() {
    return String((window.GAIA && (window.GAIA.clientPortal && window.GAIA.clientPortal.url || window.GAIA.portalUrl)) || 'https://education.gaiahealers.com').replace(/\/+$/, '');
  }

  /**
   * The public plan catalogue.
   *
   * Loaded on its own, from the public endpoint, with no dependency on any
   * /api/member/* call. This used to live inside loadMember(), which only runs
   * once a visitor is authenticated — so a signed-out visitor was told
   * "Membership plans are unavailable" while the endpoint sat there returning
   * all four plans quite happily.
   *
   * Presentation only. It never decides what anyone has access to; that answer
   * comes from the ledger via /api/member/access.
   */
  async function loadPlans() {
    const plans = await getJson('/api/membership/plans');
    state.plans = (plans && Array.isArray(plans.plans)) ? plans.plans : [];
    render();
  }

  async function loadMember() {
    const [profile, access, appts, notif, devices, purchases, forms, courses, products, activity, events] = await Promise.all([
      getJson('/api/member/profile'), getJson('/api/member/access'),
      getJson('/api/member/appointments'), getJson('/api/member/notifications'),
      getJson('/api/member/devices'), getJson('/api/member/purchases'),
      getJson('/api/member/forms'), getJson('/api/member/courses'),
      getJson('/api/member/products'), getJson('/api/member/activity'),
      getJson('/api/member/events'),
    ]);
    state.authed = !!(profile && profile.ok && profile.authenticated);
    state.data = { profile, access, appts, notif, devices, purchases, forms, courses, products, activity, events };
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
    if (box._chakraTimer) clearInterval(box._chakraTimer);
    if (box._chakraRestart) clearTimeout(box._chakraRestart);
    const chs = window.GAIA_CHAKRAS || [];
    const hits = chs.map((c, i) => '<button type="button" class="g-chakra-hero__hit" data-ck="' + esc(c.id)
      + '" style="top:' + c.top + '%;left:' + c.left + '%;--ck:' + esc(c.color) + ';--i:' + i + '" aria-label="' + esc(c.name) + ' chakra"></button>').join('');
    box.innerHTML =
      '<div class="g-chakra-hero__stage"><div class="g-chakra-hero__fig">'
      + '<picture><source srcset="assets/gaia-chakra-meditation.webp" type="image/webp" />'
      + '<img src="assets/gaia-chakra-meditation.png" width="621" height="906" loading="lazy" alt="A meditating figure with seven glowing energy centres" /></picture>'
      + hits
      + '</div></div>'
      + '<div class="g-chakra-hero__scrim"></div>'
      + '<div class="g-chakra-hero__overlay">'
      + '<p class="g-chakra-hero__kicker">Guided chakra focus</p>'
      + '<h2 class="g-chakra-hero__title">Explore your <em>energy</em></h2>'
      + '<p class="g-chakra-hero__caption">Tap a centre for its practice and journal prompt.</p>'
      + '</div>'
      + '<div class="g-chakra-guide" aria-live="polite">'
      + '<div class="g-chakra-guide__body"><p class="g-chakra-guide__kicker">Current focus</p>'
      + '<strong class="g-chakra-guide__name"></strong><span class="g-chakra-guide__meta"></span></div>'
      + '<a class="g-btn g-btn--secondary g-btn--sm g-chakra-guide__shop" href="#" data-external>Support this centre →</a>'
      + '<div class="g-chakra-guide__rituals">'
      + '<div><span><i class="ph ph-sparkle" aria-hidden="true"></i> Try now</span><p data-guide-practice></p></div>'
      + '<div><span><i class="ph ph-note-pencil" aria-hidden="true"></i> Journal</span><p data-guide-journal></p></div>'
      + '</div><button type="button" class="g-btn g-btn--ghost g-btn--sm g-chakra-guide__ask" data-guide-ask>Ask Gaia about this centre</button>'
      + '<div class="g-chakra-guide__steps" role="group" aria-label="Choose chakra">'
      + chs.map((c) => '<button type="button" data-guide-ck="' + esc(c.id) + '" aria-label="Show ' + esc(c.name) + '"></button>').join('')
      + '</div></div>';

    const guideName = box.querySelector('.g-chakra-guide__name');
    const guideMeta = box.querySelector('.g-chakra-guide__meta');
    const guideShop = box.querySelector('.g-chakra-guide__shop');
    const guidePractice = box.querySelector('[data-guide-practice]');
    const guideJournal = box.querySelector('[data-guide-journal]');
    const guideAsk = box.querySelector('[data-guide-ask]');
    let activeIndex = Math.max(0, chs.findIndex((c) => c.id === 'heart'));
    let activeChakra = chs[activeIndex] || chs[0];

    const selectChakra = (c) => {
      if (!c) return;
      activeChakra = c;
      activeIndex = Math.max(0, chs.findIndex((x) => x.id === c.id));
      box.style.setProperty('--active-chakra', c.color || 'var(--g-accent)');
      box.querySelectorAll('.g-chakra-hero__hit').forEach((x) => x.classList.toggle('is-active', x.dataset.ck === c.id));
      box.querySelectorAll('[data-guide-ck]').forEach((x) => {
        const on = x.dataset.guideCk === c.id;
        x.classList.toggle('is-active', on);
        x.setAttribute('aria-pressed', String(on));
        x.style.setProperty('--ck', c.color || 'var(--g-accent)');
      });
      if (guideName) guideName.textContent = c.name;
      if (guideMeta) guideMeta.textContent = [c.focus, c.element].filter(Boolean).join(' · ');
      if (guidePractice) guidePractice.textContent = c.practice || 'Pause and take five slow breaths.';
      if (guideJournal) guideJournal.textContent = c.journalPrompt || 'What would bring me toward balance today?';
      const shop = (window.GaiaStore && window.GaiaStore.chakraShopUrl && window.GaiaStore.chakraShopUrl(c.id)) || '';
      if (guideShop) {
        guideShop.href = shop || 'home.html?view=store';
        guideShop.textContent = shop ? 'Support this centre →' : 'Explore the store →';
      }
    };

    box.querySelectorAll('.g-chakra-hero__hit').forEach((n) => {
      n.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = chs.find((x) => x.id === n.dataset.ck); if (!c) return;
        selectChakra(c);
      });
    });
    box.querySelectorAll('[data-guide-ck]').forEach((n) => {
      n.addEventListener('click', () => {
        selectChakra(chs.find((x) => x.id === n.dataset.guideCk));
      });
    });
    guideAsk?.addEventListener('click', () => {
      if (!activeChakra) return;
      window.dispatchEvent(new CustomEvent('gaia:open-assist', {
        detail: { prompt: 'Guide me through the ' + activeChakra.name + ' chakra theme. Use this practice: ' + (activeChakra.practice || 'a gentle breathing pause') + ' Then ask me one reflective question.' },
      }));
    });
    selectChakra(chs[activeIndex] || chs[0]);
  }

  function homeEventCard() {
    const ev = state.event;
    if (!ev || !ev.name) {
      return '<div class="g-event-hero__content">'
        + '<p class="g-event-hero__kicker">Upcoming gathering</p>'
        + '<h1 class="g-event-hero__title">Gaia Healers <em>gatherings</em></h1>'
        + '<p class="g-event-hero__summary">Connect with healers, practitioners, and conscious leaders. The next confirmed gathering will appear here.</p>'
        + '<span class="g-event-hero__status">Event details coming soon</span></div>';
    }
    const when = fmtEventDate(ev);
    const url = String(ev.sourceUrl || '').trim();
    const words = String(ev.name || '').trim().split(/\s+/);
    const last = words.length > 1 ? words.pop() : '';
    const title = esc(words.join(' ')) + (last ? ' <em>' + esc(last) + '</em>' : '');
    const titleClass = String(ev.name || '').length > 28 ? ' g-event-hero__title--long' : '';
    return '<div class="g-event-hero__content">'
      + '<p class="g-event-hero__kicker">Upcoming gathering</p>'
      + '<h1 class="g-event-hero__title' + titleClass + '">' + title + '</h1>'
      + (ev.summary ? '<p class="g-event-hero__summary">' + esc(ev.summary) + '</p>' : '')
      + '<p class="g-event-hero__meta">' + [when && esc(when), ev.venue && esc(ev.venue)].filter(Boolean).join(' · ') + '</p>'
      + (url ? '<div class="g-event-hero__actions"><button type="button" class="g-btn g-btn--primary" data-open-in-app="' + esc(url) + '" data-in-app-title="' + esc(ev.name) + '">View event →</button></div>' : '')
      + '</div>';
  }

  function membersCard() {
    if (state.authed && state.data.profile) {
      const profile = (state.data.profile && state.data.profile.profile) || {};
      const unlocked = (state.data.access && state.data.access.communities && state.data.access.communities.unlocked) || [];
      const courses = (state.data.courses && state.data.courses.courses) || [];
      const accessSummary = [];
      if (courses.length) accessSummary.push(courses.length + (courses.length === 1 ? ' course' : ' courses'));
      if (unlocked.length) accessSummary.push(unlocked.length + (unlocked.length === 1 ? ' community' : ' communities'));
      return '<div class="g-member-access__body"><p class="g-member-access__kicker">Your Gaia Healers</p>'
        + '<p class="g-member-access__title">' + esc(profile.membershipTier ? profile.membershipTier + ' Member' : 'Member Access') + '</p>'
        + '<p class="g-member-access__meta">' + esc(accessSummary.join(' · ') || 'No courses or communities yet.') + '</p></div>'
        + '<a class="g-btn g-btn--secondary g-btn--sm" href="home.html?view=community">View access →</a>';
    }
    return '<div class="g-member-access__body"><p class="g-member-access__kicker">Unlock your Gaia Healers</p>'
      + '<p class="g-member-access__title">Member Access</p>'
      + '<p class="g-member-access__meta">New here? Join free or explore membership. Already a member? Sign in to see the courses and communities in your account.</p></div>'
      + '<div class="g-member-access__actions">'
      + '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-native-signin>Sign in</button>'
      + '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-open-in-app="https://join.gaiahealers.com/onboarding" data-in-app-title="Free Gaia Healers Membership">Join free</button>'
      + '<a class="g-btn g-btn--ghost g-btn--sm" href="home.html?view=store&tab=membership">Memberships</a></div>';
  }

  // Admin-published announcements (from /api/app/bootstrap → gaia.announcements).
  function announcementsHtml(list) {
    if (!list || !list.length) return '';
    const item = (a) => {
      const inner = '<span class="g-ann__title">' + esc(a.title) + '</span>'
        + (a.body ? '<span class="g-ann__body">' + esc(a.body) + '</span>' : '');
      const cls = 'g-ann g-ann--' + (['info', 'success', 'warn'].includes(a.tone) ? a.tone : 'info');
      return a.link
        ? '<a class="' + cls + '" href="' + esc(a.link) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>'
        : '<div class="' + cls + '">' + inner + '</div>';
    };
    return '<div class="g-anns">' + list.map(item).join('') + '</div>';
  }

  // Book a session / work with us — real GHL booking + form widgets (public).
  // Book a 1:1 with Dr. Nima Farshid (founder) via Calendly. Sits at the top of
  // the "Book a session" section on Home so it is the first booking members see.
  // Links verified live on gaiahealers.com/pages/bio-well-demo.
  function nimaBookingCard(home) {
    const nima = 'https://calendly.com/nimafarshid/gaia-healers-meeting';
    return '<article class="g-founder-row' + (home ? ' g-founder-row--home' : '') + '"><div><p class="g-founder-row__kicker">Meet the founder</p>'
      + '<p class="g-founder-row__title">Dr. Nima Farshid</p>'
      + '<p class="g-founder-row__meta">Personal guidance from Gaia Healers’ founder and Bio-Well educator.</p></div>'
      + '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-book-inline="' + esc(nima) + '" data-book-title="Book with Dr. Nima">Book →</button></article>';
  }

  function bookCard() {
    const bk = 'https://api.leadconnectorhq.com/widget/bookings/';
    const fm = 'https://api.leadconnectorhq.com/widget/form/';
    const items = [
      { name: 'Bio-Well energy scan', href: bk + 'scans', meta: 'Biofield reading' },
      { name: 'Bio-Well demo', href: bk + 'bio-welldemo', meta: 'See it in action' },
      { name: 'Free discovery call', href: fm + 'mgf6oviyhPwrLBi03gzq', meta: 'Intro chat' },
      { name: 'Wellness coaching', href: fm + 'gVzfo7sRfbLnMzQqSnJL', meta: 'Work with us' },
    ];
    return '<article class="g-card"><p class="g-card__label">Book a session</p>'
      + '<div class="g-rows">'
      + items.map((b) => '<button type="button" class="g-row g-row--link" data-book-inline="' + esc(b.href) + '" data-book-title="' + esc(b.name) + '">'
        + '<span>' + esc(b.name) + '</span><span class="g-row__meta">' + esc(b.meta) + ' →</span></button>').join('')
      + '</div></article>';
  }

  // ── In-app modal (reusable) ────────────────────────────────
  // Opens any embeddable page (booking widgets, the education portal, the
  // practitioner directory, event pages) inside a full-screen overlay so members
  // never leave the app. Calendly/GHL widgets and education.gaiahealers.com all
  // allow iframe embedding; a new-tab fallback is always shown at the bottom.
  let inAppModal = null;



  // Hosts whose pages REQUIRE their own auth (login/session). When embedded as
  // a cross-origin iframe, the portal's session cookies may be partitioned or
  // blocked (iOS Safari ITP, Firefox strict mode). We STILL try the iframe
  // first — the user wants to stay in-app — but we request Storage Access and
  // surface a clear "Sign in to continue" prompt if the page stays blank.
  const AUTH_DEPENDENT_HOSTS = [
    'education.gaiahealers.com',
  ];

  /* Hosts that actually permit being framed.
   *
   * Anything not on this list opens as a real tab. Verified by response
   * headers, not by assumption: gaiahealers.com (Shopify) sends
   * `X-Frame-Options: DENY` and `frame-ancestors 'none'`, so framing it
   * produced a blank panel — the app looked broken while the site was fine.
   * Sites that own a login (the GHL CRM, funnels) also belong in a tab, so
   * their cookie is first-party. */
  const EMBEDDABLE_HOSTS = [
    'education.gaiahealers.com',
    'gaiapractitioners.com',
    'elevate.gaiahealers.com',
    'api.leadconnectorhq.com',
    'calendly.com',
    // Verified frameable and not login-gated: both are marketing funnels.
    'join.gaiahealers.com',
    'nextlevel.gaiahealers.com',
  ];
  /* Shopify refuses framing outright, so these are READ rather than embedded —
   * fetched through the proxy and rendered in Gaia's own shell, the same way
   * the Store renders the Shopify catalogue natively. */
  const READABLE_HOSTS = ['gaiahealers.com'];
  const canRead = (u) => {
    const h = hostOf(u);
    return READABLE_HOSTS.some((allowed) => h === allowed || h.endsWith('.' + allowed));
  };
  const canEmbed = (u) => {
    const h = hostOf(u);
    return EMBEDDABLE_HOSTS.some((allowed) => h === allowed || h.endsWith('.' + allowed));
  };

  function hostOf(u) {
    try { return new URL(u, window.location.href).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  }

  function openInApp(rawUrl, title) {
    const url = String(rawUrl || '').trim();
    if (!url) return;
    const host = hostOf(url);
    const isAuthPortal = AUTH_DEPENDENT_HOSTS.includes(host);

    // GHL's portal owns its own authentication cookie. Opening it inside a
    // cross-origin iframe makes that cookie third-party storage, which is
    // blocked or partitioned by many mobile browsers. Course grant webhooks can
    // also supply a contact-specific GHL magic-login URL; that URL must be
    // opened as a top-level page so GHL can establish the member session and
    // enforce the offer/course access attached to that contact.
    if (isAuthPortal) {
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) window.location.assign(url);
      return;
    }

    // Shopify content: read it in-app instead of framing it.
    if (!canEmbed(url) && canRead(url)) {
      openReader(url, title);
      return;
    }

    // Anything else that refuses framing opens as a real tab.
    if (!canEmbed(url)) {
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) window.location.assign(url);
      return;
    }

    // Calendly inline embeds use query flags; everything else embeds as-is.
    const embedUrl = url.includes('calendly.com')
      ? url + (url.includes('?') ? '&' : '?') + 'embed_logo=false&embed_type=Inline'
      : url;

    actuallyOpenInApp(url, embedUrl, title);
  }

  /** Open Gaia's own content inside the app, rendered rather than framed.
   * Shopify sends X-Frame-Options: DENY, so the storefront cannot be embedded.
   * The proxy fetches and sanitises the page and we render it in Gaia's own
   * sheet — the same principle the Store already uses for the catalogue. */
  async function openReader(url, title) {
    closeInApp();
    const lastTrigger = document.activeElement;
    inAppModal = document.createElement('div');
    inAppModal.className = 'gaia-booking-modal gaia-reader';
    inAppModal.setAttribute('role', 'dialog');
    inAppModal.setAttribute('aria-modal', 'true');
    inAppModal.innerHTML = '<div class="gaia-booking-modal__backdrop" data-reader-close></div>'
      + '<div class="gaia-booking-modal__sheet">'
      + '<div class="gaia-booking-modal__head">'
      + '<p class="gaia-booking-modal__title">' + escapeHtml(title || 'Gaia Healers') + '</p>'
      + '<button type="button" class="gaia-booking-modal__close" data-reader-close aria-label="Close">&times;</button>'
      + '</div>'
      + '<div class="gaia-booking-modal__body gaia-reader__body">'
      + '<p class="gaia-reader__loading">Loading\u2026</p></div></div>';
    document.body.appendChild(inAppModal);
    document.body.classList.add('gaia-booking-open');

    const close = () => {
      if (inAppModal) inAppModal.remove();
      inAppModal = null;
      document.body.classList.remove('gaia-booking-open');
      document.removeEventListener('keydown', onKey);
      if (lastTrigger && lastTrigger.focus) lastTrigger.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    inAppModal.addEventListener('click', (e) => {
      if (e.target.closest('[data-reader-close]')) close();
    });
    const sheet = inAppModal.querySelector('.gaia-booking-modal__sheet');
    const body = inAppModal.querySelector('.gaia-reader__body');

    let data = null;
    try {
      const response = await fetch(readerProxyBase() + '/api/reader?url=' + encodeURIComponent(url),
        { headers: { Accept: 'application/json' } });
      data = await response.json();
    } catch (_) { data = null; }
    if (!inAppModal || !document.body.contains(inAppModal)) return;

    if (data && data.ok && data.title) {
      const heading = sheet.querySelector('.gaia-booking-modal__title');
      if (heading) heading.textContent = data.title;
    }

    if (data && data.ok && data.kind === 'list' && data.articles.length) {
      body.innerHTML = '<div class="gaia-reader__list">'
        + data.articles.map((a) => '<a class="gaia-reader__item" href="' + escapeHtml(a.url)
          + '"><strong>' + escapeHtml(a.title) + '</strong>'
          + (a.summary ? '<span>' + escapeHtml(a.summary) + '</span>' : '') + '</a>').join('')
        + '</div>';
      // Reading an article should stay in the app, not hand off to a browser tab.
      body.addEventListener('click', (e) => {
        const link = e.target.closest('.gaia-reader__item');
        if (!link) return;
        e.preventDefault();
        openReader(link.getAttribute('href'), link.querySelector('strong').textContent);
      });
    } else if (data && data.ok && data.html) {
      // Sanitised on the server; rendered inside Gaia's own typography.
      body.innerHTML = '<article class="gaia-reader__article">' + data.html + '</article>';
      const article = body.firstElementChild;
      stripTemplateChrome(article, data.title);
      // Source pages hotlink third-party logos that no longer resolve. A broken-image
      // icon looks like our failure, so drop images that do not load.
      article.querySelectorAll('img').forEach((img) => {
        const drop = () => img.remove();
        img.addEventListener('error', drop, { once: true });
        if (img.complete && img.naturalWidth === 0) drop();
      });
    } else {
      // Never a dead end: the page still exists, so offer the real thing.
      body.innerHTML = '<div class="gaia-reader__fallback">'
        + '<p>This page could not be loaded inside the app.</p>'
        + '<a class="gaia-reader__cta" href="' + escapeHtml(url)
        + '" target="_blank" rel="noopener noreferrer">Open in a new tab</a></div>';
    }
  }

  /* Shopify's page and article templates open with their own furniture — the
   * page title repeated, a share row, prev/next nav. In the app's sheet the
   * header already carries the title and there is nothing to navigate, so it
   * reads as a bug. Matching on the elements themselves rather than on where
   * they sit: the wrapper depth differs between templates, and an earlier
   * version that walked down from the root matched on neither. */
  const CHROME = /^(share|prev|previous|next|back|home|menu|search)$/i;
  function stripTemplateChrome(article, title) {
    const heading = String(title || '').trim().toLowerCase();
    const norm = (el) => el.textContent.replace(/\s+/g, ' ').trim();

    // The title, wherever the theme put it.
    if (heading) {
      const lead = article.querySelector('h1, h2');
      if (lead && norm(lead).toLowerCase() === heading) lead.remove();
    }

    // Navigation furniture, but only near the top: further down, a line reading
    // "Share" is far more likely to be the author's own word.
    const blocks = [...article.querySelectorAll('p, div, span, a, nav')].slice(0, 25);
    for (const block of blocks) {
      if (!block.isConnected || block.querySelector('img, h1, h2, h3, p')) continue;
      const text = norm(block);
      if (CHROME.test(text) || (heading && /^article:\s*/i.test(text)
        && text.toLowerCase().replace(/^article:\s*/i, '') === heading)) block.remove();
    }

    // Whatever that leaves behind: empty wrappers holding nothing but space.
    for (const block of [...article.querySelectorAll('div, p, section')]) {
      if (block.isConnected && !block.textContent.trim() && !block.querySelector('img')) block.remove();
    }
  }

  function readerProxyBase() {
    return String((window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || 'https://api.gaiahealers.app').replace(/\/+$/, '');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function actuallyOpenInApp(url, embedUrl, title) {
    closeInApp();
    const lastTrigger = document.activeElement; // for focus restore on close
    inAppModal = document.createElement('div');
    inAppModal.className = 'gaia-booking-modal';
    inAppModal.innerHTML =
      '<div class="gaia-booking-modal__backdrop" data-book-close></div>'
      + '<div class="gaia-booking-modal__sheet" role="dialog" aria-modal="true" aria-label="' + esc(title || 'Open') + '">'
      + '<div class="gaia-booking-modal__head">'
      + '<h2 class="gaia-booking-modal__title">' + esc(title || 'Open') + '</h2>'
      + '<button type="button" class="gaia-booking-modal__close" data-book-close aria-label="Close">&times;</button>'
      + '</div>'
      + '<div class="gaia-booking-modal__body">'
      + '<iframe src="' + esc(embedUrl) + '" title="' + esc(title || 'Content') + '" scrolling="yes" allow="camera; microphone; fullscreen" loading="lazy"></iframe>'
      + '<div class="gaia-booking-modal__loading"><span class="gaia-booking-modal__spinner"></span>Loading…</div>'
      + '<a class="gaia-booking-modal__fallback" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Open in a new tab →</a>'
      + '</div></div>';
    document.body.appendChild(inAppModal);
    document.body.classList.add('gaia-booking-open');

    // A11y: focus the close button on open, trap Tab inside the modal, restore
    // focus to the trigger element on close, and allow ESC to dismiss.
    const sheet = inAppModal.querySelector('.gaia-booking-modal__sheet');
    const closeBtn = inAppModal.querySelector('.gaia-booking-modal__close');
    if (closeBtn) closeBtn.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeInApp(); return; }
      if (e.key !== 'Tab' || !sheet) return;
      const focusables = sheet.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])');
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    inAppModal._cleanup = () => {
      document.removeEventListener('keydown', onKey);
      if (lastTrigger && typeof lastTrigger.focus === 'function') {
        try { lastTrigger.focus(); } catch (_) {}
      }
    };

    const iframe = inAppModal.querySelector('iframe');
    let loaded = false;
    if (iframe) {
      iframe.addEventListener('load', () => {
        loaded = true;
        const ld = inAppModal.querySelector('.gaia-booking-modal__loading');
        if (ld) ld.style.display = 'none';
      });
      setTimeout(() => {
        if (!inAppModal || loaded) return;
        const fb = inAppModal.querySelector('.gaia-booking-modal__fallback');
        if (fb) { fb.style.padding = '16px'; fb.style.fontWeight = '600'; fb.textContent = 'Taking a while? Open in a new tab →'; }
      }, 8000);
    }
    inAppModal.querySelectorAll('[data-book-close]').forEach((el) => {
      el.addEventListener('click', closeInApp);
    });
  }
  function closeInApp() {
    if (inAppModal) {
      if (typeof inAppModal._cleanup === 'function') inAppModal._cleanup();
      inAppModal.remove(); inAppModal = null;
    }
    document.body.classList.remove('gaia-booking-open');
  }
  // Delegate: any element with data-open-in-app (or the legacy data-book-inline)
  // opens the in-app modal instead of navigating away.
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-open-in-app], [data-book-inline]');
    if (!trigger) return;
    event.preventDefault();
    const url = trigger.getAttribute('data-open-in-app') || trigger.getAttribute('data-book-inline') || '';
    const title = trigger.getAttribute('data-book-title') || trigger.getAttribute('data-in-app-title') || 'Open';
    openInApp(url, title);
  });
  // Global interceptor: route supported external links through one safe opener.
  // Public tools can use the in-app modal; authentication-dependent GHL links
  // are promoted to a top-level tab by openInApp so their login cookie works.
  // Shopify and the GHL CRM are not intercepted.
  const IN_APP_HOSTS = EMBEDDABLE_HOSTS;   // one list, one behaviour
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    // Skip links that already opted into the data-open-in-app / data-book-inline
    // path (handled above), and links explicitly marked to stay external.
    if (link.hasAttribute('data-open-in-app') || link.hasAttribute('data-book-inline')) return;
    if (link.hasAttribute('data-external')) return;
    let href = '';
    try { href = new URL(link.href, window.location.href).href; } catch (_) { return; }
    const isEmbeddable = IN_APP_HOSTS.some((h) => {
      try { return new URL(href).hostname.replace(/^www\./, '') === h; } catch (_) { return false; }
    });
    if (!isEmbeddable) return;
    event.preventDefault();
    const title = link.textContent.trim().replace(/[→\s]+$/, '') || 'Open';
    openInApp(href, title);
  });
  // Expose globally: GaiaInApp (generic) + GaiaBooking (backward-compat alias).
  window.GaiaInApp = { open: openInApp, close: closeInApp };
  window.GaiaBooking = { open: openInApp, close: closeInApp };

  function renderHome() {
    window.GaiaSuperApp?.render?.();
    renderChakraHero();
    const eventHero = el('home-event-hero');
    if (eventHero) eventHero.innerHTML = homeEventCard();
    const anns = el('home-announcements');
    if (anns) anns.innerHTML = announcementsHtml(state.announcements);
    const access = el('home-member-access');
    if (access) {
      access.innerHTML = membersCard();
      access.querySelector('[data-native-signin]')?.addEventListener('click', () => window.GaiaAuth?.open?.());
    }
    const founder = el('home-founder');
    if (founder) founder.innerHTML = nimaBookingCard(true);
    const book = el('home-book');
    if (book) book.innerHTML = nimaBookingCard() + bookCard();
    // #home-wellness is owned by gaia-wellness.js
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

  // Profile = the member pass. Free discovery belongs on Today/Journey;
  // this screen keeps GHL identity and entitlements in one intentional place.
  function renderMe() {
    const box = el('member-me');
    if (!box) return;
    const d = state.data;
    const title = el('profile-title');
    const sub = el('profile-sub');
    const kicker = el('profile-kicker');

    if (!(state.authed && d.profile)) {
      if (kicker) kicker.textContent = 'Gaia Healers member pass';
      if (title) title.textContent = 'Member Pass';
      if (sub) sub.textContent = 'One secure sign-in for everything in your account.';
      box.innerHTML =
        '<article class="g-card g-card--feature"><p class="g-card__label">Existing members</p>'
        + '<p class="g-card__value g-card__value--lg">Sync your Gaia Healers access</p>'
        + '<p class="g-card__meta">Courses, communities, devices, purchases, bookings and messages reflect your Gaia Healers plan.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-native-signin>Sign in securely →</button>'
        + '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-open-in-app="https://join.gaiahealers.com/onboarding" data-in-app-title="Join Gaia Healers">Join free</button>'
        + '<a class="g-btn g-btn--ghost g-btn--sm" href="home.html?view=store&tab=membership">Compare plans</a></div></article>';
      box.querySelector('[data-native-signin]')?.addEventListener('click', () => window.GaiaAuth?.open?.());
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

    // Member Pass + My Access + Included + Next Level, rendered entirely from
    // the v2 read model. Nothing below infers a benefit from the tier name.
    if (window.GaiaMembershipUI) {
      const serials = {};
      for (const device of ((d.devices && d.devices.devices) || [])) {
        if (device && device.serialNumber) serials[String(device.name || device.id || '').toLowerCase()] = device.serialNumber;
      }
      cards.push(window.GaiaMembershipUI.renderMembershipScreen(state.data.access, state.plans, { serials }));
    }

    // The legacy "My devices" card used to read /api/member/devices directly,
    // which meant this screen could show two different answers about the same
    // hardware — My Access saying "1 owned" while this card said "none". The
    // ledger is now the single authority; serial numbers, which the ledger does
    // not carry yet, are passed through as display enrichment only.

    const pcnt = (d.purchases && d.purchases.counts) || {};
    cards.push(gMeCard('Purchases & subscriptions', (pcnt.orders || pcnt.subscriptions)
      ? gRows([gRow((pcnt.orders || 0) + ' order' + ((pcnt.orders === 1) ? '' : 's'), (pcnt.subscriptions || 0) + ' subscription' + ((pcnt.subscriptions === 1) ? '' : 's'))])
      : '<p class="g-empty">No purchases yet.</p>'));

    const appts = (d.appts && d.appts.appointments) || [];
    const now = Date.now();
    const upcoming = appts.filter((a) => { const x = Date.parse(a.startTime || ''); return isFinite(x) && x > now; });
    const booking = Array.isArray(d.appts && d.appts.bookingLinks) ? d.appts.bookingLinks : [];
    // Render each upcoming appointment with date/time +, if it has a video
    // meeting link (Zoom/Google Meet), a "Join meeting" button.
    const apptRow = (a) => {
      const dt = new Date(a.startTime);
      const dateStr = isFinite(dt) ? dt.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
      const meet = a.meetingLocation || '';
      const isVideo = a.isVideo || /^(https?:)?\/\//.test(meet);
      const meetType = a.meetingLocationType || '';
      const meetLabel = meetType === 'zoom' ? 'Join Zoom' : meetType === 'gmeet' ? 'Join Google Meet' : meetType === 'phone' ? 'Phone call' : isVideo ? 'Join meeting' : '';
      const joinBtn = (isVideo && meet)
        ? '<a class="g-btn g-btn--primary g-btn--sm" href="' + esc(meet) + '" target="_blank" rel="noopener noreferrer">' + esc(meetLabel) + ' →</a>'
        : (meetType === 'phone' && meet) ? '<span class="g-row__meta">' + esc(meet) + '</span>' : '';
      return '<div class="g-row"><div class="flex-1"><p class="text-headline text-ink">' + esc(a.title || 'Appointment') + '</p><p class="gaia-caption">' + esc(dateStr) + (a.address ? ' · ' + esc(a.address) : '') + '</p></div>' + joinBtn + '</div>';
    };
    cards.push(gMeCard('My bookings',
      (upcoming.length
        ? upcoming.slice(0, 3).map(apptRow).join('')
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
    window.GaiaMembershipUI?.bind?.(box);
  }

  // Academy = honest course portal. Lesson progress isn't exposed by GHL, so we
  // deep-link into the portal instead of faking progress bars.
  // ACCESS GATING: a course opens only when the signed-in contact has an exact
  // GHL offer/course grant mirrored to Gaia. Tier labels never imply course
  // authorization; GHL remains the source of truth for the actual grant.
  function renderAcademy() {
    const box = el('member-academy');
    if (!box) return;
    const cap = el('academy-summary-caption');
    const courses = state.data.courses || {};
    const grants = state.authed && Array.isArray(courses.courses) ? courses.courses : [];
    const hasAccess = grants.length > 0;
    if (cap) cap.textContent = hasAccess
      ? grants.length + ' course' + (grants.length === 1 ? '' : 's') + ' available in your Academy.'
      : (state.authed ? 'No courses yet.' : 'Sign in to see your courses.');
    const hub = courses.portalUrl || (portalBase() + '/courses/library-v2');
    const academyEntry = grants.find((grant) => grant && grant.openUrl)?.openUrl || hub;
    const cat = (state.catalog && Array.isArray(state.catalog.courses) && state.catalog.courses.length)
      ? state.catalog.courses.slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
      : [];
    const key = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const findGrant = (course) => grants.find((grant) =>
      (grant.id && course.id && String(grant.id) === String(course.id))
      || (key(grant.title || grant.name) && key(grant.title || grant.name) === key(course.title || course.name)));
    const tracks = cat.map((c) => ({
      id: c.id, name: c.title, desc: plainDescription(c.description), image: c.image, category: c.category,
      accessLevel: c.accessLevel, price: c.price, portalUrl: c.portalUrl,
      memberCount: Number(c.memberCount) || 0, grant: findGrant(c),
    }));
    grants.forEach((grant) => {
      if (!tracks.some((track) => track.grant === grant)) {
        tracks.unshift({ id: grant.id, name: grant.title || grant.name, desc: plainDescription(grant.description) || 'Available in your Gaia Healers Academy.', image: grant.image, grant });
      }
    });
    const trackCard = (t) => {
      const openable = Boolean(state.authed && t.grant);
      const url = t.grant?.openUrl || t.portalUrl || hub;
      const badge = openable
        ? '<span class="g-chip g-chip--on" style="margin-left:.5rem">Your access</span>'
        : (t.accessLevel ? '<span class="g-chip" style="margin-left:.5rem">' + esc(t.accessLevel.charAt(0).toUpperCase() + t.accessLevel.slice(1)) + '</span>' : '');
      const count = Number(t.memberCount) || 0;
      const countChip = count > 0 ? '<span class="g-chip" style="margin-left:.35rem;opacity:.85">' + count + ' learners</span>' : '';
      const img = t.image ? '<img src="' + esc(t.image) + '" alt="" class="g-access__img" style="width:48px;height:48px;border-radius:8px;object-fit:cover;flex-shrink:0" />' : '';
      return openable
        ? '<button type="button" class="g-access g-access--unlocked g-access--link" data-course-open="' + esc(url) + '" data-course-title="' + esc(t.name) + '">'
          + img
          + '<div class="g-access__body"><span class="g-access__name">' + esc(t.name) + badge + countChip + '</span><span class="g-access__meta">' + esc(t.desc) + '</span></div>'
          + '<span class="g-chip g-chip--on g-access__act">Open →</span></button>'
        : '<button type="button" class="g-access g-access--locked g-access--link" ' + (state.authed ? 'data-track-cta' : 'data-academy-signin') + '>'
          + img
          + '<div class="g-access__body"><span class="g-access__name">' + esc(t.name) + badge + countChip + '</span><span class="g-access__meta">' + esc(t.desc) + '</span></div>'
          + '<span class="g-chip g-access__act">' + (state.authed ? 'Get access →' : 'Sign in →') + '</span></button>';
    };
    const academyHead = hasAccess
      ? '<article class="g-card g-card--feature"><p class="g-card__label">Academy</p>'
        + '<p class="g-card__value g-card__value--lg">Continue learning</p>'
        + '<p class="g-card__meta">These are the courses in your account. Lessons and certificates open securely in the Gaia Healers Academy.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-course-open="' + esc(academyEntry) + '" data-course-title="Gaia Healers Academy">Open Academy →</button></div></article>'
      : '<article class="g-card g-card--feature"><p class="g-card__label">Academy</p>'
        + '<p class="g-card__value g-card__value--lg">Learn & get certified</p>'
        + '<p class="g-card__meta">Your courses and certifications appear here automatically. Browse the catalogue below, or explore a membership to unlock more.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" ' + (state.authed ? 'data-track-cta' : 'data-academy-signin') + '>' + (state.authed ? 'View memberships →' : 'Sign in →') + '</button></div></article>';
    const parts = [
      academyHead,
      gSec(hasAccess ? ('Your courses · ' + grants.length) : (cat.length ? ('Course catalog · ' + tracks.length) : 'Course catalog'),
        tracks.length ? '<div class="g-access-grid">' + tracks.map(trackCard).join('') + '</div>' : '<article class="g-card"><p class="g-card__meta">The catalogue is syncing.</p></article>'),
    ];
    if (!state.authed) {
      parts.push('<article class="g-card"><p class="g-card__label">Already a member?</p>'
        + '<p class="g-card__meta">Sign in with your Gaia Healers email to open your courses and see what your membership unlocks.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-academy-signin>Sign in</button></div></article>');
    } else if (!hasAccess) {
      parts.push('<article class="g-card"><p class="g-card__label">No course grant found</p>'
        + '<p class="g-card__meta">You are signed in, but no course or offer has been added to your account yet. If you just joined, it can take a few minutes to appear.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-track-cta>View memberships →</button></div></article>');
    }
    box.innerHTML = parts.join('');
    box.querySelectorAll('[data-track-cta]').forEach((b) => {
      b.addEventListener('click', () => window.GaiaAppShell?.go?.('store', { tab: 'membership' }));
    });
    box.querySelectorAll('[data-academy-signin]').forEach((button) => button.addEventListener('click', () => window.GaiaAuth?.open?.()));
    box.querySelectorAll('[data-course-open]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!state.authed) {
          window.GaiaAuth?.open?.();
          return;
        }
        window.GaiaInApp?.open?.(button.dataset.courseOpen, button.dataset.courseTitle || 'Gaia Healers Academy');
      });
    });
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
      meta = c.openUrlIsFallback ? 'Opens in the Gaia Healers portal' : 'Your community';
      act = '<button type="button" class="g-btn g-btn--secondary g-btn--sm g-access__act" data-open-in-app="' + esc(c.openUrl || portalBase()) + '" data-in-app-title="' + esc(c.name) + '">Open →</button>';
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
  // Find a Healer — opens the real Gaia Healers practitioner directory.
  function findHealerCard() {
    return '<article class="g-card"><div class="g-tier__head"><p class="g-card__label">Find a Healer</p></div>'
      + '<p class="g-card__value">Connect with a practitioner</p>'
      + '<p class="g-card__meta">Browse the Gaia Healers practitioner directory to find a certified healer.</p>'
      + '<div class="g-card__actions"><a class="g-btn g-btn--secondary g-btn--sm" href="https://gaiapractitioners.com" target="_blank" rel="noopener noreferrer">Open the directory →</a></div></article>';
  }

  function renderCommunity() {
    const box = el('community-body');
    if (!box) return;
    const sub = el('community-sub');
    const acc = state.data.access;

    if (!(state.authed && acc && acc.communities)) {
      if (sub) sub.textContent = 'Sign in to see which circles your membership opens.';
      const preview = ['All Gaia Healers', 'Bio-Well Practitioners', 'BioPulsar Practitioners', 'BioTekna Practitioners', 'ASEA Community', 'BrainTap Community', 'LifeWave Community', 'Golden Practitioner Circle']
        .map((name) => accessItem({ name: name, reason: 'Sign in to check your access' }, 'locked')).join('');
      box.innerHTML =
        announcementsHtml(state.announcements)
        + findHealerCard()
        + '<article class="g-card g-card--feature"><p class="g-card__label">Community</p>'
        + '<p class="g-card__value g-card__value--lg">Open your circles</p>'
        + '<p class="g-card__meta">Sign in to see which Gaia Healers communities your membership unlocks — and open them in one tap.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-native-signin>Sign in securely →</button></div></article>'
        + gSec('What’s inside', '<div class="g-access-grid">' + preview + '</div>');
      box.querySelector('[data-native-signin]')?.addEventListener('click', () => window.GaiaAuth?.open?.());
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

    const parts = [announcementsHtml(state.announcements), findHealerCard(), '<div class="g-stats">'
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
        '<button type="button" class="g-btn g-btn--ghost g-btn--sm g-section__action" data-membership-cta>Become a member →</button>'));
    }
    if (soon.length) {
      parts.push(gSec('Coming soon', '<div class="g-access-grid">' + soon.map((x) => accessItem(x, 'soon')).join('') + '</div>'));
    }
    box.innerHTML = parts.join('');
    box.querySelector('[data-membership-cta]')?.addEventListener('click', () => window.GaiaMembership?.open?.());
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
  // Birth-date chakra reading — a self-contained card that can appear in more
  // than one place (Home + Profile), so it uses classes/data-attrs (not ids)
  // and a shared lastDob so both instances stay in sync.
  let lastDob = '';
  function chakraReadingCard(dobVal) {
    if (!chakras().length) return '';
    const todayISO = new Date().toISOString().slice(0, 10);
    return '<article class="g-card gaia-chakra-reading"><p class="g-card__label">Your birth-date chakra</p>'
      + '<input type="date" class="g-dob" data-dob name="bday" autocomplete="bday" value="' + esc(dobVal || '') + '" max="' + todayISO + '" aria-label="Your date of birth" />'
      + '<div class="g-chakra-read" data-chakra-out>' + readingInner(chakraForDate(dobVal)) + '</div>'
      + '<p class="g-hint">Wellness guidance, not medical advice.</p></article>';
  }
  function renderMeWellness() {
    // Intentionally a no-op. #me-wellness is owned by gaia-wellness.js,
    // which writes the daily body point, wellness horoscope, 8-week Chakra
    // Challenge, and signup form. Calling this from render() previously
    // clobbered that rich content with a bare chakra card on every sign-in.
  }

  function bindWellness() {
    if (document.body.dataset.wellnessBound) return; document.body.dataset.wellnessBound = '1';
    document.addEventListener('input', (e) => {
      if (e.target && e.target.matches && e.target.matches('[data-dob]')) {
        lastDob = e.target.value;
        const reading = readingInner(chakraForDate(lastDob));
        // update every reading card + keep the other date input in sync
        document.querySelectorAll('.gaia-chakra-reading').forEach((c) => {
          const out = c.querySelector('[data-chakra-out]'); if (out) out.innerHTML = reading;
          const inp = c.querySelector('[data-dob]'); if (inp && inp !== e.target) inp.value = lastDob;
        });
      }
    });
  }

  let lastEventRefreshAt = 0;
  let eventRefreshTimer = 0;
  async function loadEvent(force = false) {
    const now = Date.now();
    if (!force && now - lastEventRefreshAt < 30000) return;
    lastEventRefreshAt = now;
    const boot = await getJson('/api/app/bootstrap?eventRefresh=' + now);
    if (!boot) return;
    const g = (boot && boot.gaia) || {};
    state.announcements = Array.isArray(g.announcements) ? g.announcements : [];
    state.adminEvents = Array.isArray(g.adminEvents) ? g.adminEvents : [];
    // A featured admin event takes the Home card; else fall back to the
    // auto-synced (scraped) event from the Event Manager.
    const featured = state.adminEvents.find((e) => e.featured && e.title);
    if (featured) {
      state.event = { name: featured.title, date: featured.date, venue: featured.venue, summary: featured.summary, sourceUrl: featured.registerUrl, timeline: Array.isArray(featured.timeline) ? featured.timeline : [], live: featured.live };
    } else if (g.event && g.event.name) {
      state.event = g.event;
    } else {
      state.event = null;
    }
    document.dispatchEvent(new CustomEvent('gaia:event', { detail: { event: state.event, announcements: state.announcements } }));
    renderHome(); renderStore(); renderCommunity();
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

  // Official Gaia 2.0 tiers from join.gaiahealers.com/membership.
  // Membership tier card = g-card composition (g-tier list + g-badge).
  function tierCard(o) {
    return '<article class="g-card' + (o.active ? ' g-card--feature' : '') + '">'
      + '<div class="g-tier__head"><p class="g-card__label">' + esc(o.name) + '</p>'
      + (o.statusLabel ? '<span class="g-badge' + (o.active ? ' g-badge--on' : '') + '">' + esc(o.statusLabel) + '</span>' : '') + '</div>'
      + '<ul class="g-tier__list">' + o.abilities.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ul>'
      + (o.note ? '<p class="g-card__meta">' + esc(o.note) + '</p>' : '')
      + (o.ctaAction ? '<div class="g-card__actions"><button type="button" class="g-btn ' + (o.active ? 'g-btn--secondary' : 'g-btn--primary') + ' g-btn--sm" data-open-in-app="' + esc(o.ctaUrl) + '" data-in-app-title="' + esc(o.name + ' Membership') + '">' + esc(o.ctaLabel) + '</button></div>' : '')
      + (o.ctaHref ? '<div class="g-card__actions"><a class="g-btn ' + (o.active ? 'g-btn--secondary' : 'g-btn--primary') + ' g-btn--sm" href="' + esc(o.ctaHref) + '" target="_blank" rel="noopener noreferrer">' + esc(o.ctaLabel) + '</a></div>' : '')
      + '</article>';
  }
  // Store "Membership" tab content. Plan copy, prices and checkout links come
  // from GET /api/membership/plans so there is exactly one source for them.
  // `membership.key` is used only to mark which card is the member's current
  // plan — it never decides what any plan contains.
  function membershipCards() {
    // Only a live membership marks a plan as "current". A cancelled or expired
    // Gold should show Gold's price again, because buying it back is exactly
    // what that member may want to do.
    const membership = (state.data.access && state.data.access.membership) || null;
    const currentKey = membership && ['active', 'trialing', 'past_due'].includes(membership.status)
      ? membership.key : null;
    const plans = Array.isArray(state.plans) ? state.plans : [];
    if (!plans.length) {
      return '<article class="g-card"><p class="g-card__meta">Membership plans are unavailable right now.</p></article>';
    }
    const intro = '<article class="g-card"><p class="g-card__label">Gaia 2.0 Practitioners</p>'
      + '<p class="g-card__meta">Choose a practitioner path that matches your stage.</p></article>';
    return intro + plans.map((plan) => {
      const isCurrent = currentKey && plan.key === currentKey;
      const price = (plan.prices && (plan.prices.monthly || plan.prices.annual)) || '';
      return tierCard({
        name: plan.label,
        statusLabel: isCurrent ? 'Current plan' : price,
        active: isCurrent,
        abilities: Array.isArray(plan.displayBenefits) ? plan.displayBenefits : [],
        ctaLabel: isCurrent ? '' : ('Choose ' + plan.label),
        ctaAction: isCurrent ? '' : 'membership',
        ctaUrl: plan.checkoutUrl || '',
      });
    }).join('');
  }

  // Store "Membership" tab. Products live in the "Shop" tab (gaia-store.js);
  // personal entitlements (orders, bookings) move to Profile in its redesign.
  function renderStore() {
    const box = el('store-memberships'); if (!box) return;
    box.innerHTML = membershipCards();
  }

  function render() {
    renderHome(); renderMe(); renderStore(); renderAcademy(); renderCommunity();
    // NOTE: do NOT call renderHomeWellness / renderMeWellness here.
    // #me-wellness (and the legacy #home-wellness) are owned by gaia-wellness.js.
  }

  // Public course catalog (synced from GHL via the daily workflow webhook).
  // Fetch on load so the Academy shows real courses whether signed in or not.
  async function loadCatalog() {
    const r = await getJson('/api/courses');
    if (r && r.ok && Array.isArray(r.courses)) {
      state.catalog = r;
      renderAcademy();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    render(); // public first paint
    bindWellness(); // wire the DOB input → chakra reading (was missing → input was dead)
    loadEvent(); // live Next Event from the Event Manager (public)
    eventRefreshTimer = window.setInterval(() => loadEvent(true), 5 * 60 * 1000);
    window.addEventListener('focus', () => loadEvent());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') loadEvent();
    });
    loadCatalog(); // live course catalog from the GHL webhook sync (public)
    loadPlans(); // public plan catalogue — must not wait on a signed-in member
  });
  document.addEventListener('gaia:auth', (e) => {
    if (e && e.detail && e.detail.authenticated) loadMember();
    else { state.authed = false; state.data = {}; render(); }
  });
})();
