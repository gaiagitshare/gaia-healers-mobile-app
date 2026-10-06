/* Floating tab bar — single-app mobile nav */
(function () {
  // Each tab is a fresh app screen. Prevent mobile Safari from restoring the
  // previous screen's scroll position when users move between query routes.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  if (!window.location.hash) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });

  const tabs = [
    { id: 'daily', href: 'home.html?view=daily', label: 'Today', icon: 'ph-sun' },
    { id: 'wellness', href: 'home.html?view=wellness', label: 'Energy', icon: 'ph-sparkle' },
    { id: 'academy', href: 'home.html?view=academy', label: 'Academy', icon: 'ph-graduation-cap' },
    { id: 'community', href: 'home.html?view=community', label: 'Community', icon: 'ph-users-three' },
    { id: 'store', href: 'home.html?view=store', label: 'Shop', icon: 'ph-shopping-bag' },
    { id: 'profile', href: 'home.html?view=profile', label: 'You', icon: 'ph-user' },
  ];

  // Compatibility map: which bottom-tab lights up for every current view.
  // Relocated/child screens (events, directory, inbox -> Community; bookings,
  // store, journey -> You) highlight their new parent hub, so old routes and
  // bookmarks resolve to a screen with the correct tab active. Canonical homes
  // are built stage by stage; until then the child screens still render in place.
  const VIEW_TO_TAB = {
    today: 'today',
    daily: 'daily',
    wellness: 'wellness', biowell: 'wellness', chakras: 'wellness',
    academy: 'academy',
    community: 'community', events: 'community', directory: 'community', inbox: 'community',
    profile: 'profile', bookings: 'profile', journey: 'profile',
    store: 'store',
  };

  function currentView() {
    return window.GaiaAppShell?.currentView?.() || new URLSearchParams(window.location.search).get('view') || 'today';
  }

  function activeTabId() {
    const view = currentView();
    if (VIEW_TO_TAB[view]) return VIEW_TO_TAB[view];
    if (tabs.some((tab) => tab.id === view)) return view;
    return null;
  }

  function tabLink(t, on) {
    return `
      <a href="${t.href}" data-app-nav="${t.id}" class="gaia-tabbar__link ${on ? 'is-active' : ''}" ${on ? 'aria-current="page"' : ''}>
        <i class="ph ${t.icon} gaia-tabbar__icon" aria-hidden="true"></i>
        <span class="gaia-tabbar__label">${t.label}</span>
      </a>`;
  }

  function setLinkActive(link, on) {
    link.classList.toggle('is-active', on);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  // One nav, three shapes (gaia-shell.css): a bottom bar on phones, a compact
  // rail on tablets, a sidebar with labels on desktop. The brand and the Home
  // and Practice labels only show where there is room for them.
  function buildTabbar(inner, active) {
    const left = tabs.slice(0, 3);
    const right = tabs.slice(3);
    inner.innerHTML = `
      <a class="gaia-rail__brand" href="home.html?view=today" aria-label="Gaia Healers home">
        <img src="assets/gaia-mark.svg" alt="" aria-hidden="true" width="32" height="32" />
        <span>Gaia Healers</span>
      </a>
      <div class="gaia-tabbar__group gaia-tabbar__group--left">${left.map((t) => tabLink(t, active === t.id)).join('')}</div>
      <a class="gaia-tabbar__assist gaia-tabbar__home" href="home.html?view=today" data-app-nav="today" aria-label="Home">
        <span class="gaia-tabbar__assist-pulse" aria-hidden="true"></span>
        <img class="gaia-tabbar__assist-mark" src="assets/gaia-mark.svg" alt="" aria-hidden="true" />
        <i class="ph ph-house gaia-tabbar__icon gaia-rail__home-icon" aria-hidden="true"></i>
        <span class="gaia-rail__home-label" aria-hidden="true">Home</span>
      </a>
      <div class="gaia-tabbar__group gaia-tabbar__group--right">${right.map((t) => tabLink(t, active === t.id)).join('')}</div>
      <button type="button" class="gaia-tabbar__link gaia-rail__practice" data-rail-practice hidden>
        <i class="ph ph-stethoscope gaia-tabbar__icon" aria-hidden="true"></i>
        <span class="gaia-tabbar__label">Practice</span>
      </button>`;
  }

  // Practice is a section of You; practitioners get a direct way in. Shown
  // from the same state the Practice tab uses (gaia-practitioner.js).
  document.addEventListener('gaia:practitioner-state', (e) => {
    const d = e.detail || {};
    const show = Boolean(d.isPractitioner || ['connected', 'needs_reconnect', 'unverified', 'not_practitioner'].includes(d.state));
    document.querySelectorAll('[data-rail-practice]').forEach((b) => { b.hidden = !show; });
  });
  // On You → Practice, the rail says Practice, not You.
  let profileTab = 'me';
  function markPractice() {
    const on = profileTab === 'practice' && activeTabId() === 'profile';
    document.querySelectorAll('[data-rail-practice]').forEach((b) => setLinkActive(b, on));
    document.querySelectorAll('.gaia-tabbar__link[data-app-nav="profile"]').forEach((a) => { if (on) setLinkActive(a, false); });
  }
  document.addEventListener('gaia:profile-tab', (e) => { profileTab = (e.detail && e.detail.tab) || 'me'; render(); markPractice(); });
  window.addEventListener('gaia:route', () => setTimeout(markPractice, 0));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-rail-practice]')) return;
    window.GaiaAppShell?.go?.('profile');
    setTimeout(() => window.dispatchEvent(new CustomEvent('gaia:open-client', { detail: {} })), 60);
  });

  // Home sits in the middle of the phone bar but first in the rail; move it in
  // the DOM to match, so the tab order is the order on screen.
  const railQuery = window.matchMedia('(min-width: 700px)');
  function placeHome() {
    const inner = document.querySelector('.gaia-tabbar__inner'); if (!inner) return;
    const home = inner.querySelector('.gaia-tabbar__home');
    const left = inner.querySelector('.gaia-tabbar__group--left');
    const right = inner.querySelector('.gaia-tabbar__group--right');
    if (!home || !left || !right) return;
    if (railQuery.matches) { if (home.nextElementSibling !== left) inner.insertBefore(home, left); }
    else if (home.nextElementSibling !== right) inner.insertBefore(home, right);
  }
  if (railQuery.addEventListener) railQuery.addEventListener('change', placeHome);

  function render() {
    const active = activeTabId();
    const inner = document.querySelector('.gaia-tabbar__inner');
    if (!inner) return;

    const centre = inner.querySelector('.gaia-tabbar__home');
    if (!centre) {
      buildTabbar(inner, active);
      const home = inner.querySelector('.gaia-tabbar__home');
      if (home) setLinkActive(home, active === 'today');
      placeHome();
      window.dispatchEvent(new CustomEvent('gaia:tabbar-ready'));
      return;
    }

    inner.querySelectorAll('.gaia-tabbar__link[data-app-nav], .gaia-tabbar__home').forEach((link) => {
      setLinkActive(link, link.dataset.appNav === active);
    });
  }

  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Main');
  nav.className = 'gaia-tabbar fixed bottom-0 left-0 right-0 z-50 px-4 pointer-events-none';
  nav.style.paddingBottom = 'max(0.75rem, env(safe-area-inset-bottom))';
  nav.innerHTML = '<div class="gaia-tabbar__inner mx-auto flex max-w-md items-end justify-between gap-1 rounded-2xl px-1 py-1.5 backdrop-blur-xl pointer-events-auto"></div>';

  // In the page's reading order the nav comes before the content (after the
  // skip link), so keyboard users meet it first, as they see it on desktop.
  const skip = document.querySelector('.skip-link, a[href^="#"][class*="skip"]');
  if (skip && skip.parentNode === document.body) skip.insertAdjacentElement('afterend', nav);
  else document.body.insertBefore(nav, document.body.firstChild);
  document.body.classList.add('gaia-has-tabbar');
  render();
  window.dispatchEvent(new CustomEvent('gaia:tabbar-ready'));
  window.addEventListener('gaia:route', render);
})();
