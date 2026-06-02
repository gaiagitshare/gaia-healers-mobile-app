/* Floating tab bar — premium mobile nav */
(function () {
  const path = window.location.pathname.split('/').pop() || 'home.html';
  const tabs = [
    { id: 'home', href: 'home.html', label: 'Today' },
    { id: 'biowell', href: 'biowell.html', label: 'Bio-Well' },
    { id: 'academy', href: 'academy.html', label: 'Academy' },
    { id: 'community', href: 'community.html', label: 'Circle' },
    { id: 'profile', href: 'profile.html', label: 'You' },
  ];
  const icons = {
    home: '<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 9.75L12 3l8.25 6.75V19.5a1.5 1.5 0 01-1.5 1.5H5.25A1.5 1.5 0 013.75 19.5V9.75z" />',
    biowell: '<path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />',
    academy: '<path stroke-linecap="round" stroke-linejoin="round" d="M4.26 10.065a8.978 8.978 0 011.614-4.12 9 9 0 1012.152 12.152 8.978 8.978 0 01-4.12 1.614M12 6v6l4 2" />',
    community: '<path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v11.18z" />',
    profile: '<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />',
  };
  const active = path.replace('.html', '') === 'index' ? 'home' : path.replace('.html', '');

  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Main');
  nav.className = 'gaia-tabbar fixed bottom-0 left-0 right-0 z-50 px-4 pointer-events-none';
  nav.style.paddingBottom = 'max(0.75rem, env(safe-area-inset-bottom))';
  nav.innerHTML = `
    <div class="gaia-tabbar__inner mx-auto flex max-w-md items-center justify-between rounded-2xl bg-white/90 px-1 py-1.5 shadow-[0_4px_24px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.04)] backdrop-blur-xl pointer-events-auto" style="backdrop-filter:saturate(180%) blur(20px)">
      ${tabs.map((t) => {
        const on = active === t.id;
        return `
          <a href="${t.href}" class="relative flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 transition-colors ${on ? 'text-gaia' : 'text-ink-tertiary'}" ${on ? 'aria-current="page"' : ''}>
            ${on ? '<span class="absolute inset-x-1.5 inset-y-1 rounded-xl bg-gaia/10"></span>' : ''}
            <svg class="relative h-[22px] w-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="${on ? '2' : '1.5'}">${icons[t.id]}</svg>
            <span class="relative text-[10px] font-medium tracking-tight">${t.label}</span>
          </a>`;
      }).join('')}
    </div>`;

  document.body.appendChild(nav);
  document.body.classList.add('gaia-has-tabbar');
})();
