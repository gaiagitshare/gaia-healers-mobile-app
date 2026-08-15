/* Floating tab bar — single-app mobile nav */
(function () {
  // Each tab is a fresh app screen. Prevent mobile Safari from restoring the
  // previous screen's scroll position when users move between query routes.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  if (!window.location.hash) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });

  const tabs = [
    { id: 'today', href: 'home.html?view=today', label: 'Today', icon: 'ph-sun' },
    { id: 'journey', href: 'home.html?view=journey', label: 'Journey', icon: 'ph-target' },
    { id: 'inbox', href: 'home.html?view=inbox', label: 'Inbox', icon: 'ph-chat-circle-dots' },
    { id: 'profile', href: 'home.html?view=profile', label: 'Profile', icon: 'ph-user' },
  ];

  function currentView() {
    return window.GaiaAppShell?.currentView?.() || new URLSearchParams(window.location.search).get('view') || 'today';
  }

  function activeTabId() {
    const view = currentView();
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

  function buildTabbar(inner, active) {
    const left = tabs.slice(0, 2);
    const right = tabs.slice(2);
    inner.innerHTML = `
      <div class="gaia-tabbar__group gaia-tabbar__group--left">${left.map((t) => tabLink(t, active === t.id)).join('')}</div>
      <button type="button" class="gaia-tabbar__assist" data-gaia-tab-assist data-state="idle" aria-label="Open Gaia Assist — live voice" aria-expanded="false">
        <span class="gaia-tabbar__assist-pulse" aria-hidden="true"></span>
        <img class="gaia-tabbar__assist-mark" src="assets/gaia-mark.svg" alt="" aria-hidden="true" />
        <span class="sr-only">Gaia Assist</span>
      </button>
      <div class="gaia-tabbar__group gaia-tabbar__group--right">${right.map((t) => tabLink(t, active === t.id)).join('')}</div>`;
  }

  function render() {
    const active = activeTabId();
    const inner = document.querySelector('.gaia-tabbar__inner');
    if (!inner) return;

    const assist = inner.querySelector('[data-gaia-tab-assist]');
    if (!assist) {
      buildTabbar(inner, active);
      window.dispatchEvent(new CustomEvent('gaia:tabbar-ready'));
      return;
    }

    inner.querySelectorAll('.gaia-tabbar__link').forEach((link) => {
      setLinkActive(link, link.dataset.appNav === active);
    });
  }

  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Main');
  nav.className = 'gaia-tabbar fixed bottom-0 left-0 right-0 z-50 px-4 pointer-events-none';
  nav.style.paddingBottom = 'max(0.75rem, env(safe-area-inset-bottom))';
  nav.innerHTML = '<div class="gaia-tabbar__inner mx-auto flex max-w-md items-end justify-between gap-1 rounded-2xl px-1 py-1.5 backdrop-blur-xl pointer-events-auto"></div>';

  document.body.appendChild(nav);
  document.body.classList.add('gaia-has-tabbar');
  render();
  window.dispatchEvent(new CustomEvent('gaia:tabbar-ready'));
  window.addEventListener('gaia:route', render);
})();
