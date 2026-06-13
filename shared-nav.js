/* Floating tab bar — single-app mobile nav */
(function () {
  const tabs = [
    { id: 'today', href: 'home.html?view=today', label: 'Today' },
    { id: 'wellness', href: 'home.html?view=wellness&tab=biowell', label: 'Wellness' },
    { id: 'academy', href: 'home.html?view=academy', label: 'Academy' },
    { id: 'community', href: 'home.html?view=community', label: 'Community' },
  ];
  const icons = {
    today: '<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 9.75L12 3l8.25 6.75V19.5a1.5 1.5 0 01-1.5 1.5H5.25A1.5 1.5 0 013.75 19.5V9.75z" />',
    wellness: '<path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM12 3v18M8.25 6a3.75 3.75 0 107.5 0M8.25 18a3.75 3.75 0 107.5 0" />',
    academy: '<path stroke-linecap="round" stroke-linejoin="round" d="M4.26 10.065a8.978 8.978 0 011.614-4.12 9 9 0 1012.152 12.152 8.978 8.978 0 01-4.12 1.614M12 6v6l4 2" />',
    community: '<path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm3.75 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm3.75 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM21 12c0 4.142-4.03 7.5-9 7.5a10.6 10.6 0 01-2.62-.322L4.5 20.25l1.248-3.12C4.055 15.782 3 13.983 3 12c0-4.142 4.03-7.5 9-7.5s9 3.358 9 7.5z" />',
  };

  function currentView() {
    return window.GaiaAppShell?.currentView?.() || new URLSearchParams(window.location.search).get('view') || 'today';
  }

  function activeTabId() {
    const view = currentView();
    if (view === 'wellness' || view === 'biowell' || view === 'chakras') return 'wellness';
    if (tabs.some((tab) => tab.id === view)) return view;
    return null;
  }

  function tabLink(t, on) {
    return `
      <a href="${t.href}" data-app-nav="${t.id}" class="gaia-tabbar__link ${on ? 'is-active' : ''}" ${on ? 'aria-current="page"' : ''}>
        <svg class="gaia-tabbar__icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="${on ? '2' : '1.5'}">${icons[t.id]}</svg>
        <span class="gaia-tabbar__label">${t.label}</span>
      </a>`;
  }

  function render() {
    const active = activeTabId();
    const nav = document.querySelector('.gaia-tabbar');
    if (!nav) return;

    const left = tabs.slice(0, 2);
    const right = tabs.slice(2);
    const inner = nav.querySelector('.gaia-tabbar__inner');
    inner.innerHTML = `
      <div class="gaia-tabbar__group gaia-tabbar__group--left">${left.map((t) => tabLink(t, active === t.id)).join('')}</div>
      <button type="button" class="gaia-tabbar__assist" data-gaia-tab-assist data-state="idle" aria-label="Open Gaia Assist — live voice" aria-expanded="false">
        <span class="gaia-tabbar__assist-pulse" aria-hidden="true"></span>
        <svg class="gaia-tabbar__assist-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-12 0v1.5a6 6 0 006 6m0 0v3m-3 0h6M12 15a2.25 2.25 0 002.25-2.25v-6a2.25 2.25 0 00-4.5 0v6A2.25 2.25 0 0012 15z"/>
        </svg>
      </button>
      <div class="gaia-tabbar__group gaia-tabbar__group--right">${right.map((t) => tabLink(t, active === t.id)).join('')}</div>`;
  }

  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Main');
  nav.className = 'gaia-tabbar fixed bottom-0 left-0 right-0 z-50 px-4 pointer-events-none';
  nav.style.paddingBottom = 'max(0.75rem, env(safe-area-inset-bottom))';
  nav.innerHTML = '<div class="gaia-tabbar__inner mx-auto flex max-w-md items-end justify-between gap-1 rounded-2xl px-1 py-1.5 backdrop-blur-xl pointer-events-auto"></div>';

  document.body.appendChild(nav);
  document.body.classList.add('gaia-has-tabbar');
  render();
  window.addEventListener('gaia:route', render);
})();
