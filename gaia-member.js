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
      + '<p class="g-chakra-hero__caption">Tap a centre or let Gaia guide you.</p>'
      + '</div>'
      + '<div class="g-chakra-guide" aria-live="polite">'
      + '<div class="g-chakra-guide__body"><p class="g-chakra-guide__kicker">Current focus</p>'
      + '<strong class="g-chakra-guide__name"></strong><span class="g-chakra-guide__meta"></span></div>'
      + '<a class="g-btn g-btn--secondary g-btn--sm g-chakra-guide__shop" href="#" data-external>Support this centre →</a>'
      + '<div class="g-chakra-guide__steps" role="group" aria-label="Choose chakra">'
      + chs.map((c) => '<button type="button" data-guide-ck="' + esc(c.id) + '" aria-label="Show ' + esc(c.name) + '"></button>').join('')
      + '</div></div>';

    const guideName = box.querySelector('.g-chakra-guide__name');
    const guideMeta = box.querySelector('.g-chakra-guide__meta');
    const guideShop = box.querySelector('.g-chakra-guide__shop');
    let activeIndex = Math.max(0, chs.findIndex((c) => c.id === 'heart'));

    const selectChakra = (c) => {
      if (!c) return;
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
      const shop = (window.GaiaStore && window.GaiaStore.chakraShopUrl && window.GaiaStore.chakraShopUrl(c.id)) || '';
      if (guideShop) {
        guideShop.href = shop || 'home.html?view=store';
        guideShop.textContent = shop ? 'Support this centre →' : 'Explore the store →';
      }
    };

    const startAuto = () => {
      if (box._chakraTimer) clearInterval(box._chakraTimer);
      if (chs.length < 2) return;
      box._chakraTimer = setInterval(() => {
        activeIndex = (activeIndex + 1) % chs.length;
        selectChakra(chs[activeIndex]);
      }, 4400);
    };
    const pauseForExploration = () => {
      if (box._chakraTimer) clearInterval(box._chakraTimer);
      if (box._chakraRestart) clearTimeout(box._chakraRestart);
      box._chakraRestart = setTimeout(startAuto, 12000);
    };

    box.querySelectorAll('.g-chakra-hero__hit').forEach((n) => {
      n.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = chs.find((x) => x.id === n.dataset.ck); if (!c) return;
        selectChakra(c);
        pauseForExploration();
      });
    });
    box.querySelectorAll('[data-guide-ck]').forEach((n) => {
      n.addEventListener('click', () => {
        selectChakra(chs.find((x) => x.id === n.dataset.guideCk));
        pauseForExploration();
      });
    });
    selectChakra(chs[activeIndex] || chs[0]);
    startAuto();
  }

  function homeEventCard() {
    const ev = state.event;
    if (!ev || !ev.name) {
      return '<div class="g-event-hero__content">'
        + '<p class="g-event-hero__kicker">Upcoming gathering</p>'
        + '<h1 class="g-event-hero__title">Gaia <em>gatherings</em></h1>'
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
      const unlocked = (state.data.access && state.data.access.communities && state.data.access.communities.unlocked) || [];
      return '<div class="g-member-access__body"><p class="g-member-access__kicker">Your Gaia</p>'
        + '<p class="g-member-access__title">' + (unlocked.length ? unlocked.length + (unlocked.length === 1 ? ' circle' : ' circles') : 'Member access') + '</p>'
        + '<p class="g-member-access__meta">' + (unlocked.map((c) => esc(c.name)).slice(0, 2).join(', ') || 'Your practitioner network is ready.') + '</p></div>'
        + '<a class="g-btn g-btn--secondary g-btn--sm" href="home.html?view=community">View access →</a>';
    }
    return '<div class="g-member-access__body"><p class="g-member-access__kicker">Unlock your Gaia</p>'
      + '<p class="g-member-access__title">Member access</p>'
      + '<p class="g-member-access__meta">Courses, communities, bookings, and a Gaia that knows you.</p></div>'
      + '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-native-signin>Sign in →</button>';
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
  function nimaBookingCard() {
    const nima = 'https://calendly.com/nimafarshid/gaia-healers-meeting';
    return '<article class="g-founder-row"><div><p class="g-founder-row__kicker">Meet the founder</p>'
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

  function hostOf(u) {
    try { return new URL(u, window.location.href).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  }

  // Ask Safari/Firefox to grant this cross-origin iframe access to its own
  // first-party storage. Resolves true if granted (or unsupported = best effort).
  // Must be called from a user gesture (which openInApp is).
  function requestStorageAccessForHost(host) {
    return new Promise((resolve) => {
      try {
        const doc = document;
        if (typeof doc.requestStorageAccess === 'function') {
          // Modern API: per-host.
          Promise.resolve(doc.requestStorageAccess(host)).then(() => resolve(true)).catch(() => resolve(false));
          return;
        }
        if (typeof document.requestStorageAccess === 'function') {
          Promise.resolve(document.requestStorageAccess()).then(() => resolve(true)).catch(() => resolve(false));
          return;
        }
      } catch (_) {}
      resolve(false);
    });
  }

  function openInApp(rawUrl, title) {
    const url = String(rawUrl || '').trim();
    if (!url) return;
    const host = hostOf(url);
    const isAuthPortal = AUTH_DEPENDENT_HOSTS.includes(host);

    // Calendly inline embeds use query flags; everything else embeds as-is.
    const embedUrl = url.includes('calendly.com')
      ? url + (url.includes('?') ? '&' : '?') + 'embed_logo=false&embed_type=Inline'
      : url;

    // For auth-dependent portals, ask the browser to grant the iframe access to
    // its own cookies BEFORE we render it. This is the modern (Safari 16.4+,
    // Firefox 118+) way to make cross-domain iframes work in-app. If the user
    // grants it, the portal can read its session cookie inside the modal.
    if (isAuthPortal) {
      requestStorageAccessForHost(host).finally(() => actuallyOpenInApp(url, embedUrl, title, isAuthPortal));
    } else {
      actuallyOpenInApp(url, embedUrl, title, isAuthPortal);
    }
  }

  function actuallyOpenInApp(url, embedUrl, title, isAuthPortal) {
    closeInApp();
    const lastTrigger = document.activeElement; // for focus restore on close
    inAppModal = document.createElement('div');
    inAppModal.className = 'gaia-booking-modal';
    // The auth overlay is hidden initially — only shown if the iframe stays
    // blank past a grace period (i.e. the portal couldn't establish a session).
    const authOverlay = isAuthPortal
      ? '<div class="gaia-booking-modal__auth" data-auth-overlay>'
        + '<div class="gaia-booking-modal__auth-card">'
        + '<p class="gaia-booking-modal__auth-title">' + (state.authed ? 'Secure Academy access' : 'Sign in to continue') + '</p>'
        + '<p class="gaia-booking-modal__auth-body">' + (state.authed
          ? 'Your Gaia membership is verified. Protected lesson content remains in the Academy workspace; this in-app view prevents the blank external portal page while that connection is restored.'
          : 'Verify your Gaia email here in the app to see the courses and membership access connected to your account.') + '</p>'
        + (state.authed
          ? '<button type="button" class="gaia-btn gaia-btn--primary" data-portal-membership>View my membership →</button>'
          : '<button type="button" class="gaia-btn gaia-btn--primary" data-portal-native-signin>Sign in securely →</button>')
        + '<p class="gaia-booking-modal__auth-hint">You will stay inside the Gaia Healers app.</p>'
        + '</div></div>'
      : '';
    inAppModal.innerHTML =
      '<div class="gaia-booking-modal__backdrop" data-book-close></div>'
      + '<div class="gaia-booking-modal__sheet" role="dialog" aria-modal="true" aria-label="' + esc(title || 'Open') + '">'
      + '<div class="gaia-booking-modal__head">'
      + '<h2 class="gaia-booking-modal__title">' + esc(title || 'Open') + '</h2>'
      + '<button type="button" class="gaia-booking-modal__close" data-book-close aria-label="Close">&times;</button>'
      + '</div>'
      + '<div class="gaia-booking-modal__body">'
      + '<iframe ' + (isAuthPortal ? 'hidden ' : '') + 'src="' + esc(embedUrl) + '" title="' + esc(title || 'Content') + '" scrolling="yes" allow="camera; microphone; fullscreen; storage-access" loading="lazy"></iframe>'
      + '<div class="gaia-booking-modal__loading"' + (isAuthPortal ? ' hidden' : '') + '><span class="gaia-booking-modal__spinner"></span>Loading…</div>'
      + authOverlay
      + (!isAuthPortal ? '<a class="gaia-booking-modal__fallback" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Open in a new tab →</a>' : '')
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
      // For auth portals: if the iframe hasn't fired `load` after 4s (likely a
      // blocked cookie / silent auth failure), surface the "Sign in" overlay so
      // the user isn't stuck staring at a blank page. We DON'T auto-redirect —
      // the user asked to stay in-app — but we make the path forward obvious.
      if (!isAuthPortal) {
        // Non-auth iframe (Calendly etc.): just promote the fallback if it's slow.
        setTimeout(() => {
          if (!inAppModal || loaded) return;
          const fb = inAppModal.querySelector('.gaia-booking-modal__fallback');
          if (fb) { fb.style.padding = '16px'; fb.style.fontWeight = '600'; fb.textContent = 'Taking a while? Open in a new tab →'; }
        }, 8000);
      }
    }
    inAppModal.querySelector('[data-portal-native-signin]')?.addEventListener('click', () => {
      closeInApp();
      window.GaiaAuth?.open?.();
    });
    inAppModal.querySelector('[data-portal-membership]')?.addEventListener('click', () => {
      closeInApp();
      window.GaiaAppShell?.go?.('store', { tab: 'membership' });
    });
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
  // Global interceptor: catch clicks on <a> links to embeddable external sites
  // (the education portal, the practitioner directory, the event page) and open
  // them in the in-app modal instead of a new tab. Domains verified embeddable
  // (no X-Frame-Options restrictions). Shopify (gaiahealers.com) and the GHL CRM
  // (crm.gaiahealers.com) are NOT intercepted — they block iframes and must
  // open externally.
  const IN_APP_HOSTS = [
    'education.gaiahealers.com',
    'gaiapractitioners.com',
    'elevate.gaiahealers.com',
    'api.leadconnectorhq.com',
    'calendly.com',
  ];
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
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-native-signin>Sign in securely →</button></div></article>'
        + gMeCard('What you’ll see', gRows([
          gRow('Membership & communities', ''),
          gRow('Your devices', ''),
          gRow('Purchases & subscriptions', ''),
          gRow('Bookings', ''),
          gRow('Messages', ''),
        ]))
        + gMeCard('Shop', gRows([gRowLink('Store & memberships', 'Shop →', 'home.html?view=store', false)]));
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
  }

  // Academy = honest course portal. Lesson progress isn't exposed by GHL, so we
  // deep-link into the portal instead of faking progress bars.
  // ACCESS GATING: only paid members (Silver/Gold) or Practitioners see "Open"
  //   on courses. Everyone else (signed-out OR signed-in free users) sees
  //   "Get access" → buy membership, plus "Sign in" if not signed in.
  //   This prevents free users from hitting the portal's login wall, which
  //   happens because the app session and the GHL Client Portal session are
  //   separate — only paid members should be sent there.
  function renderAcademy() {
    const box = el('member-academy');
    if (!box) return;
    const cap = el('academy-summary-caption');
    const acc = (state.data.access && state.data.access.member) || {};
    const tier = String(acc.membershipTier || '').toLowerCase();
    // hasAccess = a paying member (Silver/Gold) or an earned practitioner.
    // A signed-in free Explorer does NOT get course access — they'd just hit
    // the portal login wall.
    const hasAccess = state.authed && (tier === 'silver' || tier === 'gold' || acc.practitioner);
    if (cap) cap.textContent = hasAccess
      ? 'Your courses live in the Gaia Healers portal.'
      : 'Become a member to unlock the full Academy.';
    const courses = state.data.courses || {};
    const hub = courses.portalUrl || (portalBase() + '/courses');
    // Dynamic catalog: real courses synced from GHL via the daily webhook.
    // Falls back to static tracks when no catalog data yet (before first sync).
    const cat = (state.catalog && Array.isArray(state.catalog.courses) && state.catalog.courses.length)
      ? state.catalog.courses.slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
      : null;
    const tracks = cat
      ? cat.map((c) => ({ id: c.id, name: c.title, desc: c.description, image: c.image, category: c.category, accessLevel: c.accessLevel, price: c.price, portalUrl: c.portalUrl, memberCount: Number(c.memberCount) || 0 }))
      : [
        { name: 'Bio-Well Certification', desc: 'Become a certified Bio-Well practitioner.' },
        { name: 'Colour Energy', desc: 'Colour therapy foundations & practitioner path.' },
        { name: 'BioPulsar Training', desc: 'Aura imaging & biofeedback device training.' },
      ];
    // Paid member / practitioner → "Open" the course in the portal (in-app modal).
    // Everyone else → "Get access" routes to Store → Membership tab (in-app).
    // Free-tier courses (accessLevel === 'free') are openable by anyone.
    const trackCard = (t) => {
      const isFree = t.accessLevel === 'free';
      const openable = hasAccess || isFree;
      const url = t.portalUrl || hub;
      const badge = t.accessLevel ? '<span class="g-chip ' + (isFree ? 'g-chip--on' : '') + '" style="margin-left:.5rem">' + (isFree ? 'Free' : esc(t.accessLevel.charAt(0).toUpperCase() + t.accessLevel.slice(1))) + '</span>' : '';
      // Member count from GHL — shown only when the catalog is live (dynamic).
      const count = Number(t.memberCount) || 0;
      const countChip = count > 0 ? '<span class="g-chip" style="margin-left:.35rem;opacity:.85">' + count + ' learners</span>' : '';
      const img = t.image ? '<img src="' + esc(t.image) + '" alt="" class="g-access__img" style="width:48px;height:48px;border-radius:8px;object-fit:cover;flex-shrink:0" />' : '';
      return openable
        ? '<button type="button" class="g-access g-access--unlocked g-access--link" data-course-open="' + esc(url) + '" data-course-title="' + esc(t.name) + '">'
          + img
          + '<div class="g-access__body"><span class="g-access__name">' + esc(t.name) + badge + countChip + '</span><span class="g-access__meta">' + esc(t.desc) + '</span></div>'
          + '<span class="g-chip g-chip--on g-access__act">Open →</span></button>'
        : '<button type="button" class="g-access g-access--locked g-access--link" data-track-cta>'
          + img
          + '<div class="g-access__body"><span class="g-access__name">' + esc(t.name) + badge + countChip + '</span><span class="g-access__meta">' + esc(t.desc) + '</span></div>'
          + '<span class="g-chip g-access__act">' + (t.price ? '$' + esc(t.price) + ' · ' : '') + 'Get access →</span></button>';
    };
    const academyHead = hasAccess
      ? '<article class="g-card g-card--feature"><p class="g-card__label">Academy</p>'
        + '<p class="g-card__value g-card__value--lg">Continue learning</p>'
        + '<p class="g-card__meta">Your courses, lessons, and certificates live in the Gaia Healers portal. You will sign in there with your Gaia email to open your lessons.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-course-open="' + esc(hub) + '" data-course-title="Gaia Academy">Open Academy →</button></div></article>'
      : '<article class="g-card g-card--feature"><p class="g-card__label">Academy</p>'
        + '<p class="g-card__value g-card__value--lg">Learn & get certified</p>'
        + '<p class="g-card__meta">Bio-Well certification, Colour Energy therapy, BioPulsar training, and more. Become a Silver member to unlock the full Academy — courses, certificates, and practitioner communities.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-track-cta>View memberships →</button></div></article>';
    const parts = [
      academyHead,
      gSec(cat ? ('Courses · ' + tracks.length + ' live') : 'Explore tracks', '<div class="g-access-grid">' + tracks.map(trackCard).join('') + '</div>'),
    ];
    // The bottom card adapts to the user's state:
    //  - Not signed in → "Already a member? Sign in"
    //  - Signed in but no paid access → "Upgrade to unlock the Academy"
    if (!state.authed) {
      parts.push('<article class="g-card"><p class="g-card__label">Already a member?</p>'
        + '<p class="g-card__meta">Sign in with your Gaia email to open your courses and see what your membership unlocks.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-academy-signin>Sign in</button></div></article>');
    } else if (!hasAccess) {
      parts.push('<article class="g-card"><p class="g-card__label">Unlock the Academy</p>'
        + '<p class="g-card__meta">You are signed in on a free account. Upgrade to Silver to unlock all courses, certificates, and practitioner communities.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-track-cta>View memberships →</button></div></article>');
    }
    box.innerHTML = parts.join('');
    // Wire the membership / sign-in CTAs for non-members.
    box.querySelectorAll('[data-track-cta]').forEach((b) => {
      b.addEventListener('click', () => window.GaiaAppShell?.go?.('store', { tab: 'membership' }));
    });
    const si = box.querySelector('[data-academy-signin]');
    if (si) si.addEventListener('click', () => window.GaiaAuth?.open?.());
    box.querySelectorAll('[data-course-open]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!state.authed) {
          window.GaiaAuth?.open?.();
          return;
        }
        window.GaiaInApp?.open?.(button.dataset.courseOpen, button.dataset.courseTitle || 'Gaia Academy');
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
      meta = c.openUrlIsFallback ? 'Opens in the Gaia portal' : 'Your community';
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
    const box = el('me-wellness'); if (!box) return;
    box.innerHTML = chakras().length ? chakraReadingCard(lastDob) : '';
  }
  function renderHomeWellness() {
    const box = el('home-wellness'); if (!box) return;
    box.innerHTML = chakras().length ? chakraReadingCard(lastDob) : '';
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
    // Re-position the chakra body map whenever the Profile view is opened.
    window.addEventListener('gaia:route', () => {
      const view = (window.GaiaAppShell && window.GaiaAppShell.currentView && window.GaiaAppShell.currentView()) || '';
      if (view === 'today') refreshChakraMap();
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
      state.event = { name: featured.title, date: featured.date, venue: featured.venue, summary: featured.summary, sourceUrl: featured.registerUrl, live: featured.live };
    } else if (g.event && g.event.name) {
      state.event = g.event;
    } else {
      state.event = null;
    }
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
      + (o.ctaAction ? '<div class="g-card__actions"><button type="button" class="g-btn ' + (o.active ? 'g-btn--secondary' : 'g-btn--primary') + ' g-btn--sm" data-open-in-app="https://join.gaiahealers.com/membership" data-in-app-title="Gaia 2.0 Membership">' + esc(o.ctaLabel) + '</button></div>' : '')
      + (o.ctaHref ? '<div class="g-card__actions"><a class="g-btn ' + (o.active ? 'g-btn--secondary' : 'g-btn--primary') + ' g-btn--sm" href="' + esc(o.ctaHref) + '" target="_blank" rel="noopener noreferrer">' + esc(o.ctaLabel) + '</a></div>' : '')
      + '</article>';
  }
  function membershipCards() {
    const acc = (state.data.access && state.data.access.member) || {};
    const authed = state.authed;
    const hasSilver = /silver/i.test(acc.membershipTier || '');
    const hasGold = /gold/i.test(acc.membershipTier || '');
    const hasDiamond = /diamond/i.test(acc.membershipTier || '');
    const baseline = !authed || (!hasSilver && !hasGold && !hasDiamond);

    const intro = '<article class="g-card"><p class="g-card__label">Gaia 2.0 Practitioners</p>'
      + '<p class="g-card__meta">Choose a practitioner path that matches your stage. Official membership enrolment opens here inside the app.</p></article>';
    const free = tierCard({
      name: 'Free', statusLabel: baseline ? 'Available' : 'Included', active: baseline,
      abilities: ['Online community access', 'State of the Union calls', 'Lightworker Creed resources', 'Monthly community newsletter'],
      ctaLabel: baseline ? 'Join free' : '', ctaAction: baseline ? 'membership' : '',
    });
    const silver = tierCard({
      name: 'Silver', statusLabel: hasSilver ? 'Active' : '$97/mo', active: hasSilver,
      abilities: ['Everything in Free', 'Practitioner education', 'Directory listing', 'Practice-growth training', 'GaiaPractitioners Software + CRM access'],
      ctaLabel: hasSilver ? '' : 'Choose Silver', ctaAction: hasSilver ? '' : 'membership',
    });
    const gold = tierCard({
      name: 'Gold', statusLabel: hasGold ? 'Active' : '$497/mo', active: hasGold,
      abilities: ['Everything in Silver', 'Premium sales education', 'Custom landing page', 'Managed CRM support', 'Starter AI leads', '20% off certification programs'],
      ctaLabel: hasGold ? '' : 'Choose Gold', ctaAction: hasGold ? '' : 'membership',
    });
    const diamond = tierCard({
      name: 'Diamond', statusLabel: hasDiamond ? 'Active' : '$997/mo', active: hasDiamond,
      abilities: ['Everything in Gold', 'Prosperity engine', 'Level 1 directory exposure', 'Business accelerator', 'Conference benefits', 'Speaking and early-access opportunities'],
      ctaLabel: hasDiamond ? '' : 'Choose Diamond', ctaAction: hasDiamond ? '' : 'membership',
    });
    return intro + free + silver + gold + diamond;
  }

  // Store "Membership" tab. Products live in the "Shop" tab (gaia-store.js);
  // personal entitlements (orders, bookings) move to Profile in its redesign.
  function renderStore() {
    const box = el('store-memberships'); if (!box) return;
    box.innerHTML = membershipCards();
  }

  function render() {
    renderHome(); renderMe(); renderStore(); renderAcademy(); renderCommunity();
    renderHomeWellness(); renderMeWellness();
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
  });
  document.addEventListener('gaia:auth', (e) => {
    if (e && e.detail && e.detail.authenticated) loadMember();
    else { state.authed = false; state.data = {}; render(); }
  });
})();
