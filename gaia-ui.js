/* Gaia Healers V2 — prototype interactions */
(function () {
  if (new URLSearchParams(window.location.search).has('store')) {
    sessionStorage.setItem('gaia-coach-v2', '1');
    sessionStorage.setItem('gaia-entered', '1');
    sessionStorage.setItem('gaia-onboarded', '1');
  }

  const COACH_KEY = 'gaia-coach-v2';
  const THEME_KEY = 'gaia-theme';
  const DEFAULT_PROXY = 'https://ba2ki.com/gaia-proxy';
  const VOICE_PROVIDER_KEY = 'gaia-assist-voice-provider';
  const VOICE_NAME_KEY = 'gaia-assist-voice-name';
  const VOICE_SPEED_KEY = 'gaia-assist-voice-speed';
  const ADMIN_MODE_KEY = 'gaia-admin-mode';
  const ADMIN_UNLOCK_PARAM = 'admin';
  const ADMIN_DEV_PASSCODE = 'gaia2026';
  const APP_VIEWS = new Set(['today', 'biowell', 'chakras', 'academy', 'community', 'profile', 'admin']);
  let refreshChakraMaps = () => {};

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function initCommunityHub() {
    const data = window.GAIA;
    if (!data) return;

    const groupsEl = document.getElementById('community-groups');
    const feedEl = document.getElementById('community-feed');
    const learningEl = document.getElementById('community-learning');
    const eventsEl = document.getElementById('community-events');
    const membersEl = document.getElementById('community-members');
    const newsletterEl = document.getElementById('community-newsletter');
    if (!groupsEl && !feedEl && !learningEl) return;

    const portalUrl = data.clientPortal?.url || data.portalUrl || 'https://education.gaiahealers.com/';
    const communities = data.communities || [];
    const nameById = Object.fromEntries(communities.map((c) => [c.id, c.name]));
    let activeGroupId = 'all';

    const strip = document.querySelector('.gaia-community-strip');
    if (strip) {
      const stats = strip.querySelectorAll('.gaia-community-strip__stat strong');
      if (stats[0]) stats[0].textContent = Number(data.members || 1252).toLocaleString();
      if (stats[1]) stats[1].textContent = String(communities.length);
      if (stats[2]) stats[2].textContent = `${(data.communityCourses || []).length}+`;
    }

    const postsBadge = document.querySelector('#panel-discussion .gaia-badge--live');
    if (postsBadge) {
      const totalPosts = communities.reduce((sum, c) => sum + (c.posts || 0), 0);
      postsBadge.textContent = `${totalPosts || 39}+ posts`;
    }

    function renderGroups() {
      if (!groupsEl) return;
      const allChip = `<button type="button" class="gaia-group-chip${activeGroupId === 'all' ? ' is-active' : ''}" data-group-id="all"><span class="gaia-group-chip__name">All groups</span><span class="gaia-group-chip__meta">${communities.length} communities</span></button>`;
      const chips = communities.map((c) => {
        const shortName = c.name.replace(/^\[Start Here\]\s*/, '');
        const tags = (c.channels || []).slice(0, 3).map((ch) => `<span class="gaia-group-chip__tag">${escapeHtml(ch)}</span>`).join('');
        const badge = c.badge ? `<span class="gaia-group-chip__badge">${escapeHtml(c.badge)}</span>` : '';
        return `<button type="button" class="gaia-group-chip${activeGroupId === c.id ? ' is-active' : ''}" data-group-id="${escapeHtml(c.id)}">
          <span class="gaia-group-chip__top">${badge}<span class="gaia-group-chip__privacy">${escapeHtml(c.privacy)}</span></span>
          <span class="gaia-group-chip__name">${escapeHtml(shortName)}</span>
          <span class="gaia-group-chip__meta">${c.members} members · ${c.posts || 0} posts</span>
          <span class="gaia-group-chip__tags">${tags}</span>
        </button>`;
      }).join('');
      groupsEl.innerHTML = allChip + chips;
      groupsEl.querySelectorAll('[data-group-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeGroupId = btn.getAttribute('data-group-id') || 'all';
          renderGroups();
          renderFeed();
        });
      });
    }

    function renderFeed() {
      if (!feedEl) return;
      const feed = data.communityFeed || [];
      const filtered = activeGroupId === 'all'
        ? feed
        : feed.filter((post) => post.group === nameById[activeGroupId]);
      if (!filtered.length) {
        feedEl.innerHTML = '<div class="gaia-feed-empty">No posts in this group yet. Log in to the client portal to join the discussion.</div>';
        return;
      }
      feedEl.innerHTML = filtered.map((post) => `
        <article class="gaia-feed-card">
          <header class="gaia-feed-card__head">
            <span class="gaia-feed-card__type">${escapeHtml(post.type)}</span>
            <time class="gaia-feed-card__time">${escapeHtml(post.time)}</time>
          </header>
          <h3 class="gaia-feed-card__title">${escapeHtml(post.title)}</h3>
          <p class="gaia-feed-card__meta">${escapeHtml(post.group)} · ${escapeHtml(post.channel)} · ${escapeHtml(post.author)}</p>
          <footer class="gaia-feed-card__foot">
            <span>${post.replies} replies</span>
            <span>${post.likes} likes</span>
            <a href="${escapeHtml(portalUrl)}" class="gaia-feed-card__link">Open in portal</a>
          </footer>
        </article>
      `).join('');
    }

    function renderLearning() {
      if (!learningEl) return;
      const courses = data.communityCourses || [];
      const byGroup = courses.reduce((acc, course) => {
        const key = course.groupId || 'all';
        if (!acc[key]) acc[key] = [];
        acc[key].push(course);
        return acc;
      }, {});
      learningEl.innerHTML = Object.entries(byGroup).map(([groupId, items]) => {
        const label = groupId === 'all' ? 'All Gaia Healers' : (communities.find((c) => c.id === groupId)?.name || groupId);
        const rows = items.map((course) => `
          <a href="${escapeHtml(course.href || 'home.html?view=academy')}" class="gaia-row gaia-row--link">
            <div class="min-w-0 flex-1">
              <p class="text-micro font-semibold text-gaia">${escapeHtml(label.replace(/^\[Start Here\]\s*/, ''))}</p>
              <p class="text-headline text-ink mt-0.5">${escapeHtml(course.title)}</p>
              <p class="gaia-caption mt-0.5">${escapeHtml(course.detail)}</p>
            </div>
            <span class="gaia-link shrink-0">Open</span>
          </a>
        `).join('');
        return `<div class="gaia-learning-group">${rows}</div>`;
      }).join('');
    }

    function renderEvents() {
      if (!eventsEl) return;
      const event = data.event;
      const items = data.communityEvents || [];
      const hero = event ? `
        <a href="${escapeHtml(event.sourceUrl || 'https://elevate.gaiahealers.com/')}" class="gaia-event-hero gaia-row gaia-row--link">
          <div class="gaia-event-hero__date"><strong>${escapeHtml(event.date?.split(',')[0] || 'Nov 20')}</strong><span>2026</span></div>
          <div class="min-w-0 flex-1">
            <p class="text-micro font-semibold text-gaia">Flagship event</p>
            <p class="text-headline text-ink mt-0.5">${escapeHtml(event.name)}</p>
            <p class="gaia-caption mt-0.5">${escapeHtml(event.venue || '')} · ${escapeHtml(event.location || '')}</p>
          </div>
          <span class="gaia-link shrink-0">Register</span>
        </a>
      ` : '';
      const rows = items.map((item) => `
        <article class="gaia-row">
          <div class="gaia-event-date"><strong>${item.day}</strong><span>${escapeHtml(item.month)}</span></div>
          <div class="min-w-0 flex-1">
            <p class="text-headline text-ink">${escapeHtml(item.title)}</p>
            <p class="gaia-caption mt-0.5">${escapeHtml(item.time)} · ${escapeHtml(item.group)}</p>
            <p class="gaia-caption">${escapeHtml(item.tz)}</p>
          </div>
        </article>
      `).join('');
      eventsEl.innerHTML = hero + rows;
    }

    function renderMembers() {
      if (!membersEl) return;
      const members = data.communityMembers || [];
      membersEl.innerHTML = members.map((member) => `
        <article class="gaia-row">
          <div class="gaia-avatar gaia-avatar--md bg-gaia-muted text-gaia-dark">${escapeHtml(member.initials)}</div>
          <div class="min-w-0 flex-1">
            <p class="text-headline text-ink">${escapeHtml(member.name)}</p>
            <p class="gaia-caption mt-0.5">${escapeHtml(member.role)} · ${escapeHtml(member.group)}</p>
            <p class="gaia-caption">${escapeHtml(member.activity)}</p>
          </div>
          <span class="gaia-badge gaia-badge--subtle">${escapeHtml(member.role)}</span>
        </article>
      `).join('') + `
        <a href="${escapeHtml(portalUrl)}" class="gaia-row gaia-row--link gaia-row--cta">
          <div class="min-w-0 flex-1">
            <p class="text-headline text-ink">Search full directory</p>
            <p class="gaia-caption mt-0.5">Member list syncs after GHL login</p>
          </div>
          <span class="gaia-link shrink-0">Log in</span>
        </a>
      `;
    }

    function renderNewsletter() {
      if (!newsletterEl) return;
      const segments = [
        { title: 'Weekly practitioner digest', detail: 'Training reminders, community highlights, and CE deadlines', on: true },
        { title: 'Bio-Well device updates', detail: 'Firmware, calibration tips, and support announcements', on: true },
        { title: 'Elevate & event alerts', detail: 'Registration windows, agenda drops, and check-in codes', on: false },
        { title: 'Marketing & growth lab', detail: 'Follow-up templates and campaign ideas from faculty', on: false },
      ];
      newsletterEl.innerHTML = segments.map((seg) => `
        <article class="gaia-row">
          <div class="min-w-0 flex-1">
            <p class="text-headline text-ink">${escapeHtml(seg.title)}</p>
            <p class="gaia-caption mt-0.5">${escapeHtml(seg.detail)}</p>
          </div>
          <span class="gaia-badge ${seg.on ? 'gaia-badge--live' : 'gaia-badge--subtle'}">${seg.on ? 'Subscribed' : 'Off'}</span>
        </article>
      `).join('') + `
        <a href="${escapeHtml(portalUrl)}" class="gaia-row gaia-row--link gaia-row--cta">
          <div class="min-w-0 flex-1">
            <p class="text-headline text-ink">Manage in client portal</p>
            <p class="gaia-caption mt-0.5">Preferences map to GHL Marketing segments</p>
          </div>
          <span class="gaia-link shrink-0">Open</span>
        </a>
      `;
    }

    renderGroups();
    renderFeed();
    renderLearning();
    renderEvents();
    renderMembers();
    renderNewsletter();
  }

  function initTheme() {
    if (!document.body.classList.contains('gaia-page') && !document.body.classList.contains('gaia-app')) return;
    const saved = localStorage.getItem(THEME_KEY);
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const initial = saved || (prefersDark ? 'dark' : 'light');

    function apply(theme) {
      document.body.dataset.theme = theme;
      localStorage.setItem(THEME_KEY, theme);
      document.querySelectorAll('.gaia-theme-toggle').forEach((button) => {
        button.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
        button.innerHTML = theme === 'dark'
          ? '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m0 13.5V21m9-9h-2.25M5.25 12H3m15.364 6.364-1.591-1.591M7.227 7.227 5.636 5.636m12.728 0-1.591 1.591M7.227 16.773l-1.591 1.591M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/></svg>'
          : '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"/></svg>';
      });
    }

    document.querySelectorAll('[data-gaia-header-actions]').forEach((slot) => {
      if (slot.querySelector('.gaia-theme-toggle')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gaia-theme-toggle';
      button.addEventListener('click', () => apply(document.body.dataset.theme === 'dark' ? 'light' : 'dark'));
      slot.insertBefore(button, slot.firstChild);
    });
    document.body.querySelector(':scope > .gaia-theme-toggle')?.remove();
    apply(initial);
  }

  function layoutChakraNodes(root, chakras) {
    const img = root.querySelector('.gaia-chakra-map__photo');
    const nodes = root.querySelector('.gaia-chakra-map__nodes');
    const canvas = root.querySelector('.gaia-chakra-map__canvas');
    if (!img || !nodes || !canvas) return;

    const apply = () => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      const canvasRect = canvas.getBoundingClientRect();
      const imgRect = img.getBoundingClientRect();
      if (!canvasRect.width || !imgRect.width) return;

      chakras.forEach((item) => {
        const node = nodes.querySelector(`[data-chakra-id="${item.id}"]`);
        if (!node) return;
        const x = imgRect.left - canvasRect.left + (item.left / 100) * imgRect.width;
        const y = imgRect.top - canvasRect.top + (item.top / 100) * imgRect.height;
        node.style.left = `${(x / canvasRect.width) * 100}%`;
        node.style.top = `${(y / canvasRect.height) * 100}%`;
      });
    };

    const schedule = () => requestAnimationFrame(() => requestAnimationFrame(apply));

    img.addEventListener('load', schedule, { once: true });
    schedule();
    if (typeof img.decode === 'function') {
      img.decode().then(schedule).catch(() => schedule());
    }
  }

  function updateChakraMapSelection(root, chakras, active) {
    root.querySelector('.gaia-chakra-map__figure')?.setAttribute('data-active-chakra', active.id);
    root.querySelectorAll('[data-chakra-id]').forEach((button) => {
      const selected = button.dataset.chakraId === active.id;
      button.classList.toggle('is-active', selected);
      if (button.classList.contains('gaia-chakra-map__list-item')) {
        button.setAttribute('aria-selected', String(selected));
      }
    });

    const detail = root.querySelector('.gaia-chakra-map__detail');
    if (!detail) return;
    detail.innerHTML = `
      <div class="gaia-chakra-map__detail-main">
        <p class="gaia-chakra-map__name">${active.name} <span>${active.sanskrit}</span></p>
        <p class="gaia-chakra-map__score gaia-tabular">${active.score} · ${active.element}</p>
        <p class="gaia-caption">${active.location}</p>
        <p class="gaia-chakra-map__focus">${active.focus}</p>
      </div>
      <div class="gaia-chakra-map__actions">
        <a href="${active.learnHref}" class="gaia-link">Learn more</a>
        <button type="button" class="gaia-link" data-chakra-assist>Ask Gaia</button>
      </div>`;
    detail.querySelector('[data-chakra-assist]')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('gaia:open-assist', { detail: { prompt: active.assistPrompt, speak: true } }));
    });
  }

  function initChakraMaps() {
    const chakras = window.GAIA_CHAKRAS || [];
    if (!chakras.length) return;

    document.querySelectorAll('[data-chakra-map]').forEach((root) => {
      let active = chakras.find((item) => item.id === root.dataset.chakraFocus) || chakras[0];
      const ordered = [...chakras].reverse();
      const figureSrc = 'assets/gaia-chakra-meditation.png';

      const render = () => {
        const listItems = ordered.map((item) => `
          <button type="button" class="gaia-chakra-map__list-item${item.id === active.id ? ' is-active' : ''}"
            style="--chakra-color:${item.color}" data-chakra-id="${item.id}"
            aria-selected="${item.id === active.id}">
            <span class="gaia-chakra-map__list-dot" aria-hidden="true"></span>
            <span class="gaia-chakra-map__list-label">
              <span class="gaia-chakra-map__list-name">${item.name}</span>
              <span class="gaia-chakra-map__list-theme">${item.theme || item.element}</span>
            </span>
            <span class="gaia-chakra-map__list-track"><i style="width:${item.score}%"></i></span>
            <span class="gaia-chakra-map__list-score gaia-tabular">${item.score}</span>
          </button>`).join('');

        root.innerHTML = `
          <div class="gaia-chakra-map__layout">
            <div class="gaia-chakra-map__figure" data-active-chakra="${active.id}" aria-hidden="false">
              <div class="gaia-chakra-map__canvas">
                <div class="gaia-chakra-map__stage">
                  <img class="gaia-chakra-map__photo" src="${figureSrc}" width="621" height="906" alt="" decoding="async" />
                </div>
                <div class="gaia-chakra-map__nodes">
                  ${chakras.map((item) => `
                    <button type="button" class="gaia-chakra-map__node${item.id === active.id ? ' is-active' : ''}"
                      style="--chakra-color:${item.color}"
                      data-chakra-id="${item.id}" aria-label="${item.name} chakra, score ${item.score}">
                      <span aria-hidden="true"></span>
                    </button>`).join('')}
                </div>
              </div>
            </div>
            <div class="gaia-chakra-map__list" role="listbox" aria-label="Chakra scores">${listItems}</div>
            <div class="gaia-chakra-map__detail">
              <div class="gaia-chakra-map__detail-main">
                <p class="gaia-chakra-map__name">${active.name} <span>${active.sanskrit}</span></p>
                <p class="gaia-chakra-map__score gaia-tabular">${active.score} · ${active.element}</p>
                <p class="gaia-caption">${active.location}</p>
                <p class="gaia-chakra-map__focus">${active.focus}</p>
              </div>
              <div class="gaia-chakra-map__actions">
                <a href="${active.learnHref}" class="gaia-link">Learn more</a>
                <button type="button" class="gaia-link" data-chakra-assist>Ask Gaia</button>
              </div>
            </div>
          </div>`;

        root.querySelectorAll('[data-chakra-id]').forEach((button) => {
          button.addEventListener('click', () => {
            active = chakras.find((item) => item.id === button.dataset.chakraId) || active;
            updateChakraMapSelection(root, chakras, active);
          });
        });
        root.querySelector('[data-chakra-assist]')?.addEventListener('click', () => {
          window.dispatchEvent(new CustomEvent('gaia:open-assist', { detail: { prompt: active.assistPrompt, speak: true } }));
        });

        layoutChakraNodes(root, chakras);
      };

      render();

    });

    refreshChakraMaps = () => {
      document.querySelectorAll('[data-chakra-map]').forEach((root) => layoutChakraNodes(root, chakras));
    };

    window.GaiaChakraMaps = { refresh: refreshChakraMaps };
    window.addEventListener('resize', refreshChakraMaps);
    window.addEventListener('gaia:route', (event) => {
      if (event.detail?.view === 'chakras') {
        requestAnimationFrame(() => requestAnimationFrame(refreshChakraMaps));
      }
    });
    refreshChakraMaps();
  }

  function initCoachMark() {
    if (window.location.pathname.split('/').pop() !== 'home.html') return;
    if (sessionStorage.getItem(COACH_KEY)) return;
    const anchor = document.getElementById('gaia-coach-anchor');
    if (!anchor) return;

    const tip = document.createElement('div');
    tip.className = 'gaia-coach';
    tip.innerHTML = `
      <p class="gaia-eyebrow !text-gaia-light">Client Portal</p>
      <p class="mt-2 text-body !text-white/90">Your <strong class="text-white">Today</strong> view unifies Bio-Well, certification, and community.</p>
      <button type="button" class="mt-4 text-caption font-semibold text-gaia-light">Dismiss</button>`;
    tip.querySelector('button').addEventListener('click', () => {
      sessionStorage.setItem(COACH_KEY, '1');
      tip.remove();
    });
    anchor.before(tip);
  }

  function initSplashSteps() {
    const root = document.getElementById('splash-flow');
    if (!root) return;
    const steps = root.querySelectorAll('.splash-step');
    const dots = root.querySelectorAll('[data-splash-dot]');
    const nextBtn = root.querySelector('[data-splash-next]');
    const enterLink = root.querySelector('[data-splash-enter]');
    let i = 0;

    function show(n) {
      steps.forEach((s, idx) => s.classList.toggle('active', idx === n));
      dots.forEach((d, idx) => {
        d.classList.toggle('bg-gaia', idx === n);
        d.classList.toggle('bg-neutral-200', idx !== n);
        d.classList.toggle('w-6', idx === n);
        d.classList.toggle('w-1.5', idx !== n);
      });
      if (nextBtn) nextBtn.textContent = n === steps.length - 1 ? 'Enter portal' : 'Continue';
      if (enterLink) enterLink.classList.toggle('hidden', n !== steps.length - 1);
      if (nextBtn) nextBtn.classList.toggle('hidden', n === steps.length - 1);
    }

    nextBtn?.addEventListener('click', () => {
      if (i < steps.length - 1) { i += 1; show(i); }
    });
    enterLink?.addEventListener('click', () => {
      sessionStorage.setItem('gaia-entered', '1');
      sessionStorage.setItem('gaia-onboarded', '1');
    });
    show(0);
  }

  function initAppShellNavigation() {
    const shell = document.getElementById('gaia-app-shell');
    if (!shell) return;

    const screens = Array.from(shell.querySelectorAll('[data-screen]'));
    const screenMap = new Map(screens.map((screen) => [screen.dataset.screen, screen]));
    const adminEntries = Array.from(document.querySelectorAll('[data-admin-entry]'));
    const adminUnlockButtons = Array.from(document.querySelectorAll('[data-admin-unlock]'));
    const adminLockedPanels = Array.from(document.querySelectorAll('[data-admin-locked]'));
    const signOut = document.querySelector('[data-sign-out]');
    let activeView = 'today';
    let adminBlocked = false;

    function adminMode() {
      return sessionStorage.getItem(ADMIN_MODE_KEY) === '1';
    }

    function adminUnlockAvailable() {
      const params = new URLSearchParams(window.location.search);
      return params.get(ADMIN_UNLOCK_PARAM) === '1' || adminMode();
    }

    function setAdminMode(enabled) {
      if (enabled) sessionStorage.setItem(ADMIN_MODE_KEY, '1');
      else sessionStorage.removeItem(ADMIN_MODE_KEY);
      adminBlocked = false;
      syncAdminUi();
    }

    function syncAdminUi() {
      const enabled = adminMode();
      const unlockAvailable = adminUnlockAvailable();
      adminEntries.forEach((entry) => { entry.hidden = !enabled; });
      adminUnlockButtons.forEach((button) => {
        button.hidden = !unlockAvailable;
        button.textContent = enabled ? 'Lock admin' : 'Unlock admin';
        button.setAttribute('aria-pressed', String(enabled));
      });
      adminLockedPanels.forEach((panel) => {
        panel.hidden = enabled || (!unlockAvailable && !adminBlocked);
      });
      document.body.classList.toggle('gaia-admin-mode', enabled);
    }

    function handleAdminUnlock() {
      if (adminMode()) {
        setAdminMode(false);
        if (activeView === 'admin') navigate('profile', { replace: true });
        return;
      }

      const passcode = window.prompt('Enter Gaia admin passcode');
      if (passcode === null) return;
      if (passcode.trim() === ADMIN_DEV_PASSCODE) {
        setAdminMode(true);
        navigate('admin');
        return;
      }
      adminBlocked = true;
      syncAdminUi();
      window.alert('Admin is not available.');
    }

    function normalizeView(value) {
      const view = String(value || 'today').toLowerCase();
      if (view === 'home') return 'today';
      if (view === 'events') return 'community';
      return APP_VIEWS.has(view) ? view : 'today';
    }

    function routeFromUrl() {
      const params = new URLSearchParams(window.location.search);
      const hash = window.location.hash.replace(/^#/, '');
      const view = normalizeView(params.get('view') || hash || 'today');
      const tab = params.get('tab') || (view === 'community' ? 'discussion' : '');
      return { view, tab };
    }

    function urlFor(view, options = {}) {
      const params = new URLSearchParams(window.location.search);
      if (view === 'today') params.delete('view');
      else params.set('view', view);
      if (options.tab) params.set('tab', options.tab);
      else params.delete('tab');
      params.delete('screen');
      const query = params.toString();
      return `${window.location.pathname}${query ? `?${query}` : ''}`;
    }

    function setDocumentTitle(view) {
      const labels = {
        today: 'Today',
        biowell: 'Bio-Well',
        chakras: 'Chakras',
        academy: 'Academy',
        community: 'Community',
        profile: 'Profile',
        admin: 'Admin',
      };
      document.title = `${labels[view] || 'Gaia'} · Gaia Healers`;
    }

    function showView(view, options = {}) {
      let nextView = normalizeView(view);
      if (nextView === 'admin' && !adminMode()) {
        nextView = 'profile';
        options = { ...options, adminBlocked: true };
      }
      adminBlocked = Boolean(options.adminBlocked);

      screens.forEach((screen) => {
        const on = screen.dataset.screen === nextView;
        screen.classList.toggle('is-active', on);
        screen.setAttribute('aria-hidden', String(!on));
      });

      activeView = nextView;
      setDocumentTitle(nextView);
      if (nextView === 'community') {
        window.GaiaCommunityTabs?.activate(options.tab || 'discussion');
      }
      if (options.adminBlocked) {
        const lockedPanel = document.querySelector('[data-admin-locked]');
        lockedPanel?.scrollIntoView?.({ block: 'center' });
      } else {
        window.scrollTo({ top: 0, behavior: options.replace ? 'auto' : 'smooth' });
      }
      syncAdminUi();
      window.dispatchEvent(new CustomEvent('gaia:route', { detail: { view: nextView, tab: options.tab || '' } }));
      if (nextView === 'chakras') {
        requestAnimationFrame(() => requestAnimationFrame(() => refreshChakraMaps()));
      }
      return nextView;
    }

    function navigate(view, options = {}) {
      const nextView = showView(view, options);
      const nextUrl = urlFor(nextView, { tab: nextView === 'community' ? options.tab : '' });
      if (options.replace) window.history.replaceState({ view: nextView, tab: options.tab || '' }, '', nextUrl);
      else window.history.pushState({ view: nextView, tab: options.tab || '' }, '', nextUrl);
    }

    function routeClick(event) {
      const link = event.target.closest('a[href]');
      if (!link) return;
      if (link.target || link.hasAttribute('download')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;

      const file = url.pathname.split('/').pop() || 'home.html';
      const routeMap = {
        'home.html': url.searchParams.get('view') || 'today',
        'biowell.html': 'biowell',
        'academy.html': 'academy',
        'community.html': 'community',
        'profile.html': 'profile',
        'admin.html': 'admin',
      };
      if (!routeMap[file]) return;

      event.preventDefault();
      const tab = url.searchParams.get('tab') || '';
      navigate(routeMap[file], { tab });
    }

    document.addEventListener('click', routeClick);
    adminUnlockButtons.forEach((button) => {
      button.addEventListener('click', handleAdminUnlock);
    });
    signOut?.addEventListener('click', () => {
      sessionStorage.clear();
      setAdminMode(false);
      navigate('today');
    });
    window.addEventListener('popstate', () => {
      const route = routeFromUrl();
      showView(route.view, { tab: route.tab, replace: true });
    });

    syncAdminUi();
    const route = routeFromUrl();
    navigate(route.view, { tab: route.tab, replace: true });

    window.GaiaAppShell = {
      go: navigate,
      currentView: () => activeView,
      adminMode,
    };
  }

  function initCommunityTabs() {
    const bar = document.getElementById('community-tabs');
    if (!bar) return;
    const panels = {
      feed: 'panel-discussion',
      discussion: 'panel-discussion',
      learning: 'panel-learning',
      events: 'panel-events',
      directory: 'panel-members',
      members: 'panel-members',
      newsletter: 'panel-newsletter',
    };
    const buttons = bar.querySelectorAll('[data-tab]');
    function activateButton(btn, updateHistory = false) {
        const tab = btn.getAttribute('data-tab');
        buttons.forEach((b) => {
          const on = b === btn;
          b.classList.toggle('bg-gaia', on);
          b.classList.toggle('text-white', on);
          b.classList.toggle('bg-surface-muted', !on);
          b.classList.toggle('text-ink-secondary', !on);
        });
        const activePanel = panels[tab];
        [...new Set(Object.values(panels))].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.classList.toggle('hidden', id !== activePanel);
        });
        if (updateHistory && window.GaiaAppShell?.currentView?.() === 'community') {
          window.GaiaAppShell.go('community', { tab });
        }
    }
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        activateButton(btn, true);
      });
    });
    window.GaiaCommunityTabs = {
      activate(tab = 'discussion') {
        const requestedButton = bar.querySelector(`[data-tab="${tab}"]`) || bar.querySelector('[data-tab="discussion"]');
        if (requestedButton) activateButton(requestedButton, false);
      },
    };
    window.GaiaCommunityTabs.activate(new URLSearchParams(window.location.search).get('tab') || 'discussion');
  }

  function initLiveSyncIndicator() {
    if (!document.body.classList.contains('gaia-page')) return;
    if (document.querySelector('.gaia-live-sync')) return;

    const indicator = document.createElement('div');
    indicator.className = 'gaia-live-sync';
    indicator.hidden = true;
    indicator.innerHTML = '<span></span><strong>Proxy connected</strong>';
    document.body.appendChild(indicator);

    function refresh() {
      const status = window.GAIA_SYNC?.status;
      const connected = status === 'live' || status === 'connected';
      indicator.hidden = !connected;
      indicator.classList.toggle('gaia-live-sync--live', status === 'live');
      const label = status === 'live' ? 'Live sync connected' : 'Proxy connected';
      const text = indicator.querySelector('strong');
      if (text) text.textContent = label;
    }

    refresh();
    document.addEventListener('gaia:sync', refresh);
    document.addEventListener('gaia:sync-error', refresh);
  }

  function initGaiaAssist() {
    if (!document.body.classList.contains('gaia-page')) return;
    if (document.getElementById('gaia-assist')) return;

    const data = window.GAIA || {};
    const assistant = data.assistant || {};
    const root = document.createElement('section');
    root.id = 'gaia-assist';
    root.className = 'gaia-assist';
    root.innerHTML = `
      <div class="gaia-assist__panel" role="dialog" aria-label="${assistant.name || 'Gaia Assist'}" hidden>
        <div class="gaia-assist__handle"></div>
        <div class="gaia-assist__top">
          <div class="min-w-0">
            <h2>${assistant.name || 'Gaia Assist'}</h2>
            <p class="gaia-assist__mini">Live captions · Gaia brain · ElevenLabs voice</p>
          </div>
          <button type="button" class="gaia-assist__close" aria-label="Close Gaia Assist">×</button>
        </div>
        <div class="gaia-assist__voice" data-assist-state="idle">
          <button type="button" class="gaia-assist__mic" aria-label="Start voice prompt">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-12 0v1.5a6 6 0 006 6m0 0v3m-3 0h6M12 15a2.25 2.25 0 002.25-2.25v-6a2.25 2.25 0 00-4.5 0v6A2.25 2.25 0 0012 15z"/></svg>
          </button>
          <div class="gaia-assist__wave" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <p class="gaia-assist__status">Tap to talk</p>
          <audio class="gaia-assist__audio" playsinline webkit-playsinline preload="auto"></audio>
          <div class="gaia-assist__speak-controls">
            <button type="button" class="gaia-assist__mute" aria-pressed="false">Mute</button>
            <button type="button" class="gaia-assist__stop">Stop</button>
            <button type="button" class="gaia-assist__play" hidden>Hear Gaia</button>
            <span class="gaia-assist__provider">Voice: browser</span>
          </div>
        </div>
        <div class="gaia-assist__transcript">
          <p class="gaia-assist__bubble gaia-assist__bubble--bot">Tap the mic and speak naturally. I will capture the question, stream the answer, and speak it back.</p>
        </div>
        <form class="gaia-assist__form">
          <label class="gaia-assist__label" for="gaia-assist-prompt">Type a prompt</label>
          <div class="gaia-assist__input-row">
            <input id="gaia-assist-prompt" name="prompt" type="text" autocomplete="off" placeholder="Ask about my Elevate badge" />
            <button type="submit">Send</button>
          </div>
        </form>
        <p class="gaia-assist__error" role="alert" hidden></p>
        <div class="gaia-assist__chips"></div>
        <details class="gaia-assist__settings">
          <summary>Voice settings</summary>
          <div class="gaia-assist__settings-grid">
            <label>Provider
              <select class="gaia-assist__voice-provider">
                <option value="auto">Auto</option>
                <option value="browser">Browser</option>
                <option value="openai">OpenAI</option>
                <option value="elevenlabs">ElevenLabs</option>
              </select>
            </label>
            <label>Voice
              <select class="gaia-assist__voice-name"></select>
            </label>
            <label class="gaia-assist__speed">Speed <span>1.00x</span>
              <input class="gaia-assist__voice-speed" type="range" min="0.75" max="1.25" step="0.05" value="1" />
            </label>
          </div>
        </details>
        <p class="gaia-assist__promise">${assistant.promise || 'Review before anything is saved.'}</p>
      </div>`;

    document.body.appendChild(root);

    const panel = root.querySelector('.gaia-assist__panel');
    const close = root.querySelector('.gaia-assist__close');
    const mic = root.querySelector('.gaia-assist__mic');
    const status = root.querySelector('.gaia-assist__status');
    const transcript = root.querySelector('.gaia-assist__transcript');
    const chips = root.querySelector('.gaia-assist__chips');
    const form = root.querySelector('.gaia-assist__form');
    const promptInput = root.querySelector('#gaia-assist-prompt');
    const error = root.querySelector('.gaia-assist__error');
    const muteButton = root.querySelector('.gaia-assist__mute');
    const stopButton = root.querySelector('.gaia-assist__stop');
    const playButton = root.querySelector('.gaia-assist__play');
    const voiceAudioEl = root.querySelector('.gaia-assist__audio');
    const voiceProvider = root.querySelector('.gaia-assist__provider');
    const voiceProviderSelect = root.querySelector('.gaia-assist__voice-provider');
    const voiceNameSelect = root.querySelector('.gaia-assist__voice-name');
    const voiceSpeed = root.querySelector('.gaia-assist__voice-speed');
    const voiceSpeedLabel = root.querySelector('.gaia-assist__speed span');
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;
    let recognizing = false;
    let activeRecorder = null;
    let activeRecordStream = null;
    let recordStopTimer = null;
    let recordVadFrame = null;
    let recordAudioCtx = null;
    let liveBubble = null;
    let speechFallbackTimer = null;
    const voiceRegion = root.querySelector('.gaia-assist__voice');
    let muted = localStorage.getItem('gaia-assist-muted') === '1';
    let currentAudio = null;
    let pendingVoice = null;
    let browserVoices = [];
    let hostedVoices = [];
    let activeChatController = null;
    let activeTtsController = null;
    let activeWebAudio = null;
    const userAgent = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/i.test(userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isMobileWebKit = isIOS || (/AppleWebKit/i.test(userAgent) && /Mobile/i.test(userAgent));
    const isIosInAppBrowser = isIOS && /(CriOS|FxiOS|EdgiOS|OPiOS|Instagram|FBAN|FBAV|Line|WhatsApp|GSA)/i.test(userAgent);
    const preferRecorderFirst = isIOS || isIosInAppBrowser;
    let sharedAudioCtx = null;
    let voiceUnlocked = false;
    let voiceUnlockAt = 0;
    const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

    function markVoiceUnlocked() {
      voiceUnlocked = true;
      voiceUnlockAt = Date.now();
    }

    function voiceUnlockIsFresh(maxAgeMs = 12000) {
      return voiceUnlocked && (Date.now() - voiceUnlockAt) <= maxAgeMs;
    }

    function getSharedAudio() {
      if (voiceAudioEl) {
        voiceAudioEl.playsInline = true;
        voiceAudioEl.setAttribute('playsinline', '');
        voiceAudioEl.setAttribute('webkit-playsinline', 'true');
        return voiceAudioEl;
      }
      if (!currentAudio) {
        currentAudio = new Audio();
        currentAudio.preload = 'auto';
        currentAudio.playsInline = true;
        currentAudio.setAttribute('playsinline', '');
        currentAudio.setAttribute('webkit-playsinline', 'true');
      }
      return currentAudio;
    }

    async function unlockAudioContext() {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
        sharedAudioCtx = new AudioCtx();
      }
      if (sharedAudioCtx.state === 'suspended') {
        try {
          await sharedAudioCtx.resume();
        } catch (err) {
          assistLog('audio context unlock pending', { error: err.message });
        }
      }
      return sharedAudioCtx;
    }

    async function unlockVoicePlayback(force = false) {
      if (!force && voiceUnlockIsFresh()) return true;
      try {
        await unlockAudioContext();
        const audio = getSharedAudio();
        const previousSrc = audio.src;
        audio.src = SILENT_WAV;
        audio.volume = 0.001;
        audio.muted = false;
        await audio.play();
        audio.pause();
        audio.currentTime = 0;
        audio.volume = 1;
        audio.src = previousSrc || '';
        markVoiceUnlocked();
        assistLog('voice unlocked', { userAgent, forced: force });
        return true;
      } catch (err) {
        assistLog('voice unlock pending', { error: err.message });
        return false;
      }
    }

    const suggestionMap = [
      { label: 'Gaia services', reply: assistant.responses?.event, intent: 'services' },
      { label: assistant.suggestions?.[0] || 'Prepare my badge', reply: assistant.responses?.event, intent: 'event' },
      { label: 'Devices', reply: assistant.responses?.scan, intent: 'devices' },
      { label: assistant.suggestions?.[2] || 'Next course step', reply: assistant.responses?.academy, intent: 'academy' },
      { label: assistant.suggestions?.[3] || 'GHL follow-up', reply: assistant.responses?.ghl, intent: 'ghl' },
    ];
    chips.innerHTML = suggestionMap.map((item) => `<button type="button" data-intent="${item.intent}">${item.label}</button>`).join('');

    function assistLog(event, detail = {}) {
      console.info(`[Gaia Assist] ${event}`, detail);
    }

    function assistError(event, err) {
      console.error(`[Gaia Assist] ${event}`, err);
    }

    function resolveLocalReply(prompt, intent = 'general') {
      const responses = assistant.responses || {};
      const intentReplies = {
        event: responses.event,
        devices: responses.scan,
        scan: responses.scan,
        biowell: responses.scan,
        chakra: responses.scan,
        academy: responses.academy,
        ghl: responses.ghl,
        services: responses.event,
        voice: responses.scan,
        general: null,
      };
      if (intentReplies[intent]) return intentReplies[intent];

      const normalized = `${intent} ${prompt}`.toLowerCase();
      if (/service|what do you do|device|bio-well|biowell|scan|chakra|energy/.test(normalized)) {
        return responses.scan || responses.event || 'Gaia Healers connects Bio-Well, certification, communities, and Elevate event operations.';
      }
      if (/badge|elevate|event|check-in/.test(normalized)) {
        return responses.event || 'I can help prepare your Elevate badge flow and check QR status in review mode.';
      }
      if (/course|academy|certification|module|exam/.test(normalized)) {
        return responses.academy || 'You are progressing through Advanced Level 1. I can point to the next module and practicum requirement.';
      }
      if (/ghl|follow-up|crm|registration/.test(normalized)) {
        return responses.ghl || 'GHL handles registration and tickets. I can draft follow-up copy for your review before anything is sent.';
      }
      return responses.scan || 'Gaia Assist is ready. Ask about Bio-Well scans, Academy progress, Elevate badges, or GHL follow-up.';
    }

    function ensureBrowserVoices() {
      return new Promise((resolve) => {
        browserVoices = window.speechSynthesis?.getVoices?.() || [];
        if (browserVoices.length) {
          resolve(browserVoices);
          return;
        }
        const finish = () => {
          browserVoices = window.speechSynthesis?.getVoices?.() || [];
          resolve(browserVoices);
        };
        window.speechSynthesis?.addEventListener?.('voiceschanged', finish, { once: true });
        setTimeout(finish, 300);
      });
    }

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    async function transcribeAudioBlob(blob) {
      const base = proxyBase();
      if (!base) throw new Error('Proxy unavailable for transcription');
      const audioBase64 = await blobToBase64(blob);
      const response = await fetch(`${base}/api/assist/transcribe`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({ audioBase64, mimeType: blob.type || 'audio/webm' }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `Transcription returned ${response.status}`);
      }
      return String(payload.transcript || '').trim();
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function proxyBase() {
      return (window.GAIA_SYNC?.proxyBase || DEFAULT_PROXY).replace(/\/+$/, '');
    }

    function setVoiceProvider(provider, name = '') {
      voiceProvider.textContent = `Voice: ${provider}${name ? ` · ${name}` : ''}`;
      voiceProvider.dataset.provider = provider;
    }

    function clearPendingVoice(revoke = true) {
      if (revoke && pendingVoice?.url) URL.revokeObjectURL(pendingVoice.url);
      pendingVoice = null;
      playButton.hidden = true;
      playButton.classList.remove('is-pending');
      playButton.textContent = 'Hear Gaia';
    }

    function stopSpeaking() {
      const audio = getSharedAudio();
      if (!audio.paused) {
        audio.pause();
        audio.currentTime = 0;
      }
      if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) {
        window.speechSynthesis.cancel();
      }
      if (activeWebAudio?.source) {
        try { activeWebAudio.source.stop(0); } catch (err) {
          assistLog('web audio stop skipped', { error: err.message });
        }
        activeWebAudio = null;
      }
      activeTtsController?.abort();
      activeTtsController = null;
      assistLog('speech ended', { reason: 'stopped' });
      status.textContent = 'Speech stopped';
    }

    function interruptAssistant(reason = 'interrupt') {
      activeChatController?.abort();
      activeChatController = null;
      activeTtsController?.abort();
      activeTtsController = null;
      stopSpeaking();
      clearPendingVoice(true);
      setError('');
      setAssistVoiceState('idle', reason === 'voice' ? 'Listening next…' : 'Stopped');
      assistLog('assistant interrupted', { reason });
    }

    function setMuted(nextMuted) {
      muted = nextMuted;
      localStorage.setItem('gaia-assist-muted', muted ? '1' : '0');
      muteButton.textContent = muted ? 'Unmute' : 'Mute';
      muteButton.setAttribute('aria-pressed', String(muted));
      if (muted) stopSpeaking();
    }

    function selectedProvider() {
      return voiceProviderSelect.value || 'auto';
    }

    function selectedSpeed() {
      const speed = Number(voiceSpeed.value);
      return Number.isFinite(speed) ? speed : 1;
    }

    function naturalVoiceScore(voice) {
      const name = `${voice.name} ${voice.voiceURI}`.toLowerCase();
      let score = 0;
      if (/samantha|ava|allison|susan|victoria|karen|moira|tessa|serena|google us english|microsoft .*natural|zira/.test(name)) score += 50;
      if (/enhanced|premium|natural|neural/.test(name)) score += 25;
      if (/en-us|en_us/.test(`${voice.lang} ${voice.name}`.toLowerCase())) score += 12;
      if (/en/.test(voice.lang.toLowerCase())) score += 6;
      if (voice.localService) score += 2;
      return score;
    }

    function bestBrowserVoice() {
      if (!browserVoices.length) return null;
      const saved = localStorage.getItem(VOICE_NAME_KEY);
      const savedVoice = browserVoices.find((voice) => voice.name === saved);
      if (savedVoice) return savedVoice;
      return [...browserVoices].sort((a, b) => naturalVoiceScore(b) - naturalVoiceScore(a))[0] || null;
    }

    function ttsConfig() {
      return window.GAIA?.sync?.voice?.tts || {};
    }

    function refreshBrowserVoicesOnly() {
      browserVoices = window.speechSynthesis?.getVoices?.() || [];
      const best = bestBrowserVoice();
      const selectedName = localStorage.getItem(VOICE_NAME_KEY) || best?.name || '';
      const options = browserVoices.length
        ? browserVoices.map((voice) => {
            const label = `${voice.name}${voice.lang ? ` (${voice.lang})` : ''}`;
            return `<option value="${escapeHtml(voice.name)}" ${voice.name === selectedName ? 'selected' : ''}>${escapeHtml(label)}</option>`;
          }).join('')
        : '<option value="">System default</option>';
      voiceNameSelect.innerHTML = options;
      if (selectedName) voiceNameSelect.value = selectedName;
    }

    function refreshVoiceOptions() {
      const provider = selectedProvider();
      const tts = ttsConfig();
      if (provider === 'elevenlabs' || (provider === 'auto' && tts.elevenLabsConfigured)) {
        const voices = hostedVoices.length
          ? hostedVoices
          : (tts.elevenLabsVoiceId
            ? [{ id: tts.elevenLabsVoiceId, name: tts.elevenLabsVoice || 'Gaia voice' }]
            : []);
        if (voices.length) {
          const saved = localStorage.getItem(VOICE_NAME_KEY);
          voiceNameSelect.innerHTML = voices.map((voice) => {
            const selected = voice.id === saved || voice.name === saved;
            return `<option value="${escapeHtml(voice.id)}" ${selected ? 'selected' : ''}>${escapeHtml(voice.name)}</option>`;
          }).join('');
          return;
        }
      }
      if (provider === 'openai') {
        const openaiVoice = tts.openaiVoice || 'alloy';
        const saved = localStorage.getItem(VOICE_NAME_KEY) || openaiVoice;
        voiceNameSelect.innerHTML = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'].map(
          (name) => `<option value="${name}" ${name === saved ? 'selected' : ''}>${name}</option>`,
        ).join('');
        return;
      }
      refreshBrowserVoicesOnly();
    }

    async function loadHostedVoices() {
      const base = proxyBase();
      if (!base) return;
      try {
        const response = await fetch(`${base}/api/assist/voices`, {
          headers: { Accept: 'application/json' },
          credentials: 'omit',
        });
        if (!response.ok) return;
        const payload = await response.json();
        hostedVoices = payload.voices || [];
        refreshVoiceOptions();
      } catch (err) {
        assistLog('hosted voices unavailable', { error: err.message });
      }
    }

    function configureVoiceFromBootstrap() {
      const tts = ttsConfig();
      const savedProvider = localStorage.getItem(VOICE_PROVIDER_KEY);
      if (tts.elevenLabsConfigured) {
        if (!savedProvider || savedProvider === 'auto' || savedProvider === 'browser') {
          voiceProviderSelect.value = 'elevenlabs';
          localStorage.setItem(VOICE_PROVIDER_KEY, 'elevenlabs');
        }
      } else if (tts.configured && (!savedProvider || savedProvider === 'browser')) {
        voiceProviderSelect.value = 'auto';
        localStorage.setItem(VOICE_PROVIDER_KEY, 'auto');
      }
      refreshVoiceOptions();
      const provider = voiceProviderSelect.value;
      const label = tts.elevenLabsVoice || tts.openaiVoice || 'hosted';
      setVoiceProvider(provider === 'browser' ? 'browser' : provider, provider === 'auto' ? 'auto' : label);
      if (tts.configured) loadHostedVoices();
    }

    function refreshBrowserVoices() {
      refreshVoiceOptions();
    }

    function initVoiceSettings() {
      const savedProvider = localStorage.getItem(VOICE_PROVIDER_KEY);
      voiceProviderSelect.value = savedProvider || 'auto';
      localStorage.setItem(VOICE_PROVIDER_KEY, voiceProviderSelect.value);
      voiceSpeed.value = localStorage.getItem(VOICE_SPEED_KEY) || '1';
      voiceSpeedLabel.textContent = `${Number(voiceSpeed.value).toFixed(2)}x`;
      refreshVoiceOptions();
      window.speechSynthesis?.addEventListener?.('voiceschanged', refreshBrowserVoicesOnly);
      ensureBrowserVoices().then(refreshBrowserVoicesOnly);
      configureVoiceFromBootstrap();
    }

    function selectedBrowserVoice() {
      const selected = voiceNameSelect.value || localStorage.getItem(VOICE_NAME_KEY);
      return browserVoices.find((voice) => voice.name === selected) || bestBrowserVoice();
    }

    async function speakWithBrowser(text) {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
        setVoiceProvider('browser');
        setError('This browser cannot speak responses aloud. You can still read the reply.');
        assistError('speech error', { provider: 'browser', error: 'speechSynthesis unavailable' });
        return;
      }
      await ensureBrowserVoices();
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = selectedBrowserVoice();
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang || 'en-US';
      utterance.rate = selectedSpeed();
      utterance.pitch = 1;
      let resumeTimer = null;
      utterance.onstart = () => {
        setVoiceProvider('browser', voice?.name || 'system');
        status.textContent = 'Speaking…';
        assistLog('speech started', { provider: 'browser', voice: voice?.name || 'system', speed: selectedSpeed() });
        resumeTimer = window.setInterval(() => {
          if (!window.speechSynthesis.speaking) {
            window.clearInterval(resumeTimer);
            resumeTimer = null;
            return;
          }
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        }, 8000);
      };
      utterance.onend = () => {
        if (resumeTimer) window.clearInterval(resumeTimer);
        status.textContent = 'Ready for next prompt';
        assistLog('speech ended', { provider: 'browser' });
      };
      utterance.onerror = (event) => {
        if (resumeTimer) window.clearInterval(resumeTimer);
        setVoiceProvider('browser');
        setError(`Speech failed: ${event.error || 'browser speech error'}`);
        assistError('speech error', { provider: 'browser', error: event.error });
      };
      window.speechSynthesis.speak(utterance);
    }

    async function playAudioElement(audioUrl, provider, voice) {
      const audio = getSharedAudio();
      audio.muted = false;
      audio.volume = 1;
      audio.src = audioUrl;
      audio.load();
      let playbackStarted = false;
      const onPlay = () => {
        playbackStarted = true;
        clearPendingVoice(false);
        playButton.hidden = true;
        playButton.classList.remove('is-pending');
        setVoiceHint('');
        setVoiceProvider(provider, voice);
        status.textContent = 'Speaking…';
        assistLog('speech started', { provider, voice, speed: selectedSpeed() });
      };
      audio.onplay = onPlay;
      audio.onended = () => {
        if (!isMobileWebKit) URL.revokeObjectURL(audioUrl);
        setAssistVoiceState('idle', 'Tap to talk');
        assistLog('speech ended', { provider });
      };
      audio.onerror = () => {
        if (!isMobileWebKit) URL.revokeObjectURL(audioUrl);
        setVoiceProvider('browser');
        assistError('speech error', { provider, error: 'audio playback failed' });
      };
      try {
        await audio.play();
        await new Promise((resolve, reject) => {
          if (playbackStarted) {
            resolve();
            return;
          }
          const timer = window.setTimeout(() => {
            if (playbackStarted) resolve();
            else reject(new Error('autoplay blocked'));
          }, 450);
          audio.addEventListener('playing', () => {
            window.clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      } catch (playError) {
        if (window.AudioContext || window.webkitAudioContext) {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          const ctx = await unlockAudioContext() || new AudioCtx();
          if (ctx.state === 'suspended') await ctx.resume();
          const buffer = await fetch(audioUrl).then((res) => res.arrayBuffer()).then((data) => ctx.decodeAudioData(data));
          await new Promise((resolve, reject) => {
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            activeWebAudio = { ctx, source };
            source.onended = () => {
              URL.revokeObjectURL(audioUrl);
              status.textContent = 'Ready for next prompt';
              assistLog('speech ended', { provider, mode: 'webaudio' });
              activeWebAudio = null;
              resolve();
            };
            source.onerror = reject;
            setVoiceProvider(provider, voice);
            status.textContent = 'Speaking…';
            playbackStarted = true;
            source.start(0);
          });
          return;
        }
        throw playError;
      }
    }

    function setVoiceHint(message) {
      if (!message) {
        error.hidden = true;
        error.classList.remove('gaia-assist__hint');
        error.textContent = '';
        return;
      }
      error.hidden = false;
      error.classList.add('gaia-assist__hint');
      error.textContent = message;
    }

    function showManualVoicePlayback(audioUrl, provider, voice) {
      clearPendingVoice(true);
      pendingVoice = { url: audioUrl, provider, voice };
      playButton.hidden = false;
      playButton.classList.add('is-pending');
      playButton.textContent = 'Hear Gaia';
      setVoiceProvider(provider, voice || 'ready');
      status.textContent = 'Voice ready — tap Hear Gaia';
      setVoiceHint('iPhone and in-app browsers may require one tap. Tap Hear Gaia to play the ElevenLabs voice.');
    }

    function buildTtsRequestBody(cleanText, providerSetting) {
      const tts = ttsConfig();
      const body = {
        text: cleanText,
        provider: providerSetting,
        speed: selectedSpeed(),
      };
      if (providerSetting === 'elevenlabs' || providerSetting === 'auto') {
        body.voiceId = voiceNameSelect.value || tts.elevenLabsVoiceId || undefined;
      } else if (providerSetting === 'openai') {
        body.voice = voiceNameSelect.value || tts.openaiVoice || undefined;
      } else if (voiceNameSelect.value && providerSetting !== 'browser') {
        body.voice = voiceNameSelect.value;
      }
      return body;
    }

    function speechPreviewText(text) {
      const clean = String(text || '').replace(/\s+/g, ' ').trim();
      if (clean.length <= 760) return clean;
      const sentenceCut = clean.slice(0, 760).match(/^(.+[.!?])\s+/);
      return `${(sentenceCut?.[1] || clean.slice(0, 720)).trim()} I can keep going on screen.`;
    }

    async function speakReply(text, options = {}) {
      const cleanText = String(text || '').trim();
      if (!cleanText || muted) return;
      const voiceText = speechPreviewText(cleanText);
      const fromVoice = options.fromVoice === true;
      stopSpeaking();
      if (!fromVoice || !voiceUnlockIsFresh()) {
        await unlockVoicePlayback(fromVoice);
      }
      setAssistVoiceState('speaking', 'Speaking with ElevenLabs…');
      const providerSetting = selectedProvider();
      if (providerSetting === 'browser') {
        await speakWithBrowser(cleanText);
        return;
      }
      const base = proxyBase();
      if (!base) {
        await speakWithBrowser(cleanText);
        return;
      }

      try {
        activeTtsController?.abort();
        activeTtsController = new AbortController();
        const response = await fetch(`${base}/api/assist/tts`, {
          method: 'POST',
          headers: {
            Accept: 'audio/mpeg,application/json',
            'Content-Type': 'application/json',
          },
          credentials: 'omit',
          signal: activeTtsController.signal,
          body: JSON.stringify(buildTtsRequestBody(voiceText, providerSetting)),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || `TTS returned ${response.status}`);
        }
        if (!response.headers.get('content-type')?.includes('audio')) {
          throw new Error('TTS returned a non-audio response');
        }
        const blob = await response.blob();
        const audioUrl = URL.createObjectURL(blob);
        const provider = response.headers.get('X-Gaia-Voice-Provider') || (providerSetting === 'auto' ? 'hosted' : providerSetting);
        const voice = response.headers.get('X-Gaia-Voice-Name') || '';
        try {
          await playAudioElement(audioUrl, provider, voice);
        } catch (playError) {
          assistError('speech error', { provider, error: playError.message || 'autoplay blocked' });
          showManualVoicePlayback(audioUrl, provider, voice);
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          assistLog('TTS request aborted', { provider: providerSetting });
          return;
        }
        setVoiceProvider('browser');
        assistError('speech error', { provider: providerSetting, error: err.message });
        await speakWithBrowser(cleanText);
      } finally {
        activeTtsController = null;
        const audio = getSharedAudio();
        if (!pendingVoice && audio.paused && !activeWebAudio) setAssistVoiceState('idle', 'Tap to talk');
      }
    }

    function setOpen(open) {
      if (open) unlockVoicePlayback();
      panel.hidden = !open;
      root.classList.toggle('gaia-assist--open', open);
      document.body.classList.toggle('gaia-assist-panel-open', open);
      document.querySelectorAll('[data-gaia-tab-assist]').forEach((button) => {
        button.setAttribute('aria-expanded', String(open));
        button.classList.toggle('is-active', open);
      });
    }

    function wireTabAssist() {
      document.querySelectorAll('[data-gaia-tab-assist]').forEach((button) => {
        if (button.dataset.gaiaAssistWired) return;
        button.dataset.gaiaAssistWired = '1';
        button.addEventListener('click', () => setOpen(panel.hidden));
      });
    }

    function setError(message) {
      error.classList.remove('gaia-assist__hint');
      error.hidden = !message;
      error.textContent = message || '';
    }

    function setAssistVoiceState(state, message = '') {
      if (voiceRegion) voiceRegion.dataset.assistState = state;
      root.classList.toggle('gaia-assist--listening', state === 'listening');
      root.classList.toggle('gaia-assist--thinking', state === 'thinking');
      root.classList.toggle('gaia-assist--speaking', state === 'speaking');
      if (message) status.textContent = message;
    }

    function updateLiveTranscript(text) {
      const clean = String(text || '').trim();
      if (!clean) {
        clearLiveTranscript();
        return;
      }
      if (!liveBubble) {
        liveBubble = document.createElement('p');
        liveBubble.className = 'gaia-assist__bubble gaia-assist__bubble--live';
        transcript.appendChild(liveBubble);
      }
      liveBubble.textContent = clean;
      transcript.scrollTop = transcript.scrollHeight;
      const preview = clean.length > 52 ? `${clean.slice(0, 52)}…` : clean;
      status.textContent = `Listening… ${preview}`;
    }

    function clearLiveTranscript() {
      if (liveBubble) {
        liveBubble.remove();
        liveBubble = null;
      }
    }

    function setBusy(busy, label = 'Thinking with Gaia…') {
      form.querySelector('button').disabled = busy;
      chips.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
      if (busy) {
        setAssistVoiceState('thinking', label);
      } else if (!pendingVoice && getSharedAudio().paused && !activeWebAudio && !recognizing && activeRecorder?.state !== 'recording') {
        setAssistVoiceState('idle', 'Tap to talk');
      }
    }

    function appendMessage(kind, text) {
      const bubble = document.createElement('p');
      bubble.className = `gaia-assist__bubble gaia-assist__bubble--${kind}`;
      bubble.innerHTML = escapeHtml(text);
      transcript.appendChild(bubble);
      const bubbles = transcript.querySelectorAll('.gaia-assist__bubble');
      if (bubbles.length > 7) bubbles[0].remove();
      transcript.scrollTop = transcript.scrollHeight;
      return bubble;
    }

    function updateBubble(bubble, text) {
      if (!bubble) return;
      bubble.innerHTML = escapeHtml(text);
      transcript.scrollTop = transcript.scrollHeight;
    }

    async function streamAssistantReply(base, cleanPrompt, intent, source, fromVoice) {
      const controller = new AbortController();
      activeChatController?.abort();
      activeChatController = controller;
      let botBubble = null;
      let eventName = 'message';
      let fullReply = '';
      let donePayload = null;

      const response = await fetch(`${base}/api/assist/chat/stream`, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        credentials: 'omit',
        signal: controller.signal,
        body: JSON.stringify({
          prompt: cleanPrompt,
          intent,
          source,
          page: window.location.pathname.split('/').pop() || 'home.html',
        }),
      });

      if (!response.ok || !response.body) return false;
      assistLog('proxy stream opened', { status: response.status });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const consumeEvent = (raw) => {
        const line = raw.trim();
        if (!line) return;
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim() || 'message';
          return;
        }
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data) return;
        const payload = JSON.parse(data);
        if (eventName === 'delta') {
          const text = payload.text || '';
          if (!text) return;
          if (!botBubble) botBubble = appendMessage('bot', '');
          fullReply += text;
          updateBubble(botBubble, fullReply);
          setAssistVoiceState('thinking', 'Answering live…');
        } else if (eventName === 'done') {
          donePayload = payload;
        }
      };

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          lines.forEach(consumeEvent);
        }
        if (buffer) buffer.split(/\r?\n/).forEach(consumeEvent);
      } finally {
        if (activeChatController === controller) activeChatController = null;
      }

      if (!fullReply && donePayload?.reply) {
        fullReply = donePayload.reply;
        botBubble = appendMessage('bot', fullReply);
      }
      if (!fullReply) return false;
      await speakReply(fullReply, { fromVoice });
      if (donePayload?.warning) setError(donePayload.warning);
      return true;
    }

    async function deliverReply(reply, options = {}) {
      appendMessage('bot', reply);
      await speakReply(reply, options);
      if (options.warning) setError(options.warning);
    }

    async function sendPrompt(prompt, intent = 'general', source = 'text') {
      const cleanPrompt = String(prompt || '').trim();
      if (!cleanPrompt) {
        setError('Type or speak a prompt first.');
        return;
      }
      const fromVoice = source === 'voice' || source === 'voice-recorder';
      if (!fromVoice) {
        await unlockVoicePlayback();
      }
      setError('');
      appendMessage('user', cleanPrompt);
      setBusy(true, 'Thinking with Gaia…');

      const base = proxyBase();
      if (!base) {
        const reply = resolveLocalReply(cleanPrompt, intent);
        assistLog('local reply (no proxy)', { intent, source });
        await deliverReply(reply, { fromVoice });
        setBusy(false);
        return;
      }

      assistLog('request sent to proxy', { endpoint: `${base}/api/assist/chat`, intent, source });

      try {
        const streamed = await streamAssistantReply(base, cleanPrompt, intent, source, fromVoice);
        if (streamed) return;
      } catch (err) {
        if (err.name === 'AbortError') {
          assistLog('proxy stream aborted', { intent, source });
          return;
        }
        assistLog('proxy stream unavailable', { error: err.message });
      }

      try {
        activeChatController?.abort();
        activeChatController = new AbortController();
        const response = await fetch(`${base}/api/assist/chat`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          credentials: 'omit',
          signal: activeChatController.signal,
          body: JSON.stringify({
            prompt: cleanPrompt,
            intent,
            source,
            page: window.location.pathname.split('/').pop() || 'home.html',
          }),
        });
        assistLog('proxy response received', { status: response.status });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error || `Proxy returned ${response.status}`);
        }
        const reply = payload.reply || resolveLocalReply(cleanPrompt, intent);
        await deliverReply(reply, { warning: payload.warning || '', fromVoice });
      } catch (err) {
        if (err.name === 'AbortError') {
          assistLog('proxy request aborted', { intent, source });
          return;
        }
        assistError('OpenAI/voice error', err);
        const reply = resolveLocalReply(cleanPrompt, intent);
        await deliverReply(reply, {
          warning: 'Proxy unavailable — using local Gaia voice responses.',
          fromVoice,
        });
      } finally {
        activeChatController = null;
        setBusy(false);
      }
    }

    function pickRecorderMimeType() {
      const preferred = isIOS
        ? ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm']
        : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      return preferred.find((type) => MediaRecorder.isTypeSupported(type)) || '';
    }

    function createVoiceRecorder(stream) {
      const preferred = isIOS
        ? ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm']
        : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
      const candidates = preferred.filter((type) => {
        try {
          return !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(type);
        } catch {
          return false;
        }
      });

      for (const type of candidates) {
        try {
          const recorder = new MediaRecorder(stream, { mimeType: type });
          return { recorder, mimeType: recorder.mimeType || type };
        } catch (err) {
          assistLog('recorder mime skipped', { type, error: err.message });
        }
      }

      try {
        const recorder = new MediaRecorder(stream);
        return { recorder, mimeType: recorder.mimeType || '' };
      } catch (err) {
        throw new Error(`Microphone recording is unavailable in this browser (${err.message || 'MediaRecorder failed'})`);
      }
    }

    function stopActiveRecording() {
      if (!activeRecorder || activeRecorder.state !== 'recording') return;
      try {
        activeRecorder.requestData?.();
      } catch (err) {
        assistLog('recorder requestData skipped', { error: err.message });
      }
      activeRecorder.stop();
    }

    function cleanupActiveRecording() {
      if (recordVadFrame) {
        cancelAnimationFrame(recordVadFrame);
        recordVadFrame = null;
      }
      if (recordStopTimer) {
        window.clearTimeout(recordStopTimer);
        recordStopTimer = null;
      }
      if (speechFallbackTimer) {
        window.clearTimeout(speechFallbackTimer);
        speechFallbackTimer = null;
      }
      recordAudioCtx?.close?.().catch(() => {});
      recordAudioCtx = null;
      activeRecordStream?.getTracks?.().forEach((track) => track.stop());
      activeRecordStream = null;
      activeRecorder = null;
      root.classList.remove('gaia-assist--listening');
    }

    function waitForRecorderStop(recorder, delayMs = 150) {
      return new Promise((resolve, reject) => {
        recorder.onerror = () => reject(new Error('Recording failed'));
        recorder.onstop = () => window.setTimeout(resolve, delayMs);
      });
    }

    async function recordLiveVoice() {
      if (!window.MediaRecorder) {
        setError('This browser blocks recording. Tap the text box and use the iPhone keyboard microphone, or open the app in Safari.');
        promptInput.focus();
        return;
      }

      setError('');
      clearLiveTranscript();
      try {
        await unlockVoicePlayback(true);
        setAssistVoiceState('listening', 'Opening microphone…');
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        activeRecordStream = stream;
        const { recorder, mimeType } = createVoiceRecorder(stream);
        activeRecorder = recorder;
        const chunks = [];

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          recordAudioCtx = new AudioCtx();
          if (recordAudioCtx.state === 'suspended') await recordAudioCtx.resume();
          const source = recordAudioCtx.createMediaStreamSource(stream);
          const analyser = recordAudioCtx.createAnalyser();
          analyser.fftSize = 2048;
          source.connect(analyser);

          let speechDetected = false;
          let silenceStart = 0;
          const speechThreshold = isIOS ? 0.012 : 0.018;
          const silenceMs = isIOS ? 1400 : 1100;

          setAssistVoiceState('listening', isIOS ? 'Listening — pause or tap mic to send' : 'Recording backup…');

          const monitorLevel = () => {
            if (recorder.state !== 'recording') return;
            const samples = new Uint8Array(analyser.fftSize);
            analyser.getByteTimeDomainData(samples);
            let sum = 0;
            for (let i = 0; i < samples.length; i += 1) {
              const sample = (samples[i] - 128) / 128;
              sum += sample * sample;
            }
            const rms = Math.sqrt(sum / samples.length);
            if (rms > speechThreshold) {
              speechDetected = true;
              silenceStart = 0;
              if (!liveBubble) status.textContent = isIOS ? 'Listening — pause to send' : 'Listening…';
            } else if (speechDetected) {
              if (!silenceStart) silenceStart = Date.now();
              else if (Date.now() - silenceStart >= silenceMs) {
                stopActiveRecording();
                return;
              }
            }
            recordVadFrame = requestAnimationFrame(monitorLevel);
          };

          recorder.ondataavailable = (event) => {
            if (event.data?.size) chunks.push(event.data);
          };
          if (isIOS) recorder.start(250);
          else recorder.start();
          recordStopTimer = window.setTimeout(() => {
            if (recorder.state === 'recording') stopActiveRecording();
          }, isIOS ? 9000 : 12000);
          monitorLevel();
          await waitForRecorderStop(recorder, isIOS ? 200 : 80);
        } else {
          setAssistVoiceState('listening', isIOS ? 'Listening — tap mic when done' : 'Recording backup…');
          recorder.ondataavailable = (event) => {
            if (event.data?.size) chunks.push(event.data);
          };
          if (isIOS) recorder.start(250);
          else recorder.start();
          recordStopTimer = window.setTimeout(() => {
            if (recorder.state === 'recording') stopActiveRecording();
          }, isIOS ? 9000 : 6500);
          await waitForRecorderStop(recorder, isIOS ? 200 : 50);
        }

        if (recordStopTimer) {
          window.clearTimeout(recordStopTimer);
          recordStopTimer = null;
        }
        if (recordVadFrame) {
          cancelAnimationFrame(recordVadFrame);
          recordVadFrame = null;
        }
        activeRecorder = null;
        stream.getTracks().forEach((track) => track.stop());
        activeRecordStream = null;
        recordAudioCtx?.close?.().catch(() => {});
        recordAudioCtx = null;

        const blobType = recorder.mimeType || mimeType || (isIOS ? 'audio/mp4' : 'audio/webm');
        const blob = new Blob(chunks, { type: blobType });
        const minSize = isIOS ? 80 : 800;
        assistLog('live recorder finished', { bytes: blob.size, type: blobType, isIOS });
        if (blob.size < minSize) {
          setAssistVoiceState('idle', 'Tap to talk');
          setError('I could not hear enough audio. Hold the phone close, tap mic again, or use the iPhone keyboard microphone in the text box.');
          return;
        }

        setAssistVoiceState('thinking', 'Transcribing…');
        const transcript = await transcribeAudioBlob(blob);
        if (!transcript) {
          setAssistVoiceState('idle', 'Tap to talk');
          setError('Could not understand that. Try again or type your prompt below.');
          return;
        }
        updateLiveTranscript(transcript);
        await sendPrompt(transcript, 'voice', 'voice-recorder');
        clearLiveTranscript();
      } catch (err) {
        cleanupActiveRecording();
        clearLiveTranscript();
        assistError('voice recorder error', err);
        const message = err.name === 'NotAllowedError'
          ? 'Microphone access is blocked. In Safari, allow Microphone for this website, then try again.'
          : `${err.message || 'Voice capture failed'}. If this is an in-app browser, open Safari or tap the text box and use iPhone dictation.`;
        setError(message);
        promptInput.focus();
        setAssistVoiceState('idle', 'Tap to talk');
      }
    }

    function beginSpeechRecognition() {
      recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.continuous = false;

      let finalTranscript = '';
      let recognitionHandled = false;

      if (speechFallbackTimer) window.clearTimeout(speechFallbackTimer);
      speechFallbackTimer = window.setTimeout(() => {
        if (finalTranscript || recognitionHandled) return;
        recognitionHandled = true;
        assistLog('speech recognition fallback', { reason: 'timeout' });
        try { recognition.stop(); } catch (err) {
          assistLog('recognition stop skipped', { error: err.message });
        }
        recordLiveVoice();
      }, isIOS ? 3500 : 8000);

      recognition.onstart = () => {
        recognizing = true;
        setAssistVoiceState('listening', 'Live captions on…');
        assistLog('recording started');
      };
      recognition.onresult = (event) => {
        let interim = '';
        let latestFinal = finalTranscript;
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const piece = event.results[i][0]?.transcript || '';
          if (!piece) continue;
          if (event.results[i].isFinal) latestFinal = `${latestFinal} ${piece}`.trim();
          else interim = `${interim} ${piece}`.trim();
        }
        if (latestFinal) finalTranscript = latestFinal;
        updateLiveTranscript(interim || finalTranscript);
      };
      recognition.onerror = (event) => {
        assistError('OpenAI/voice error', { type: 'speech-recognition', error: event.error });
        if (['network', 'service-not-allowed', 'aborted', 'audio-capture', 'no-speech'].includes(event.error)) {
          recognitionHandled = true;
          recognizing = false;
          if (speechFallbackTimer) {
            window.clearTimeout(speechFallbackTimer);
            speechFallbackTimer = null;
          }
          setAssistVoiceState('listening', 'Switching to recorder…');
          recordLiveVoice();
        } else {
          setError(`Voice capture failed: ${event.error}. You can type the same prompt below.`);
        }
      };
      recognition.onend = async () => {
        if (recognitionHandled) return;
        recognizing = false;
        if (speechFallbackTimer) {
          window.clearTimeout(speechFallbackTimer);
          speechFallbackTimer = null;
        }
        assistLog('recording stopped', { hasTranscript: Boolean(finalTranscript) });
        if (finalTranscript) {
          clearLiveTranscript();
          setAssistVoiceState('thinking', 'Thinking with Gaia…');
          await sendPrompt(finalTranscript, 'voice', 'voice');
        } else {
          await recordLiveVoice();
        }
      };

      try {
        recognition.start();
      } catch (err) {
        recognitionHandled = true;
        recognizing = false;
        assistLog('speech recognition start failed', { error: err.message });
        recordLiveVoice();
      }
    }

    function stopRecognition() {
      if (speechFallbackTimer) {
        window.clearTimeout(speechFallbackTimer);
        speechFallbackTimer = null;
      }
      if (recognition && recognizing) {
        assistLog('recording stopped', { reason: 'manual-stop' });
        recognition.stop();
      }
    }

    async function ensureMicPermission() {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser does not expose microphone permissions. Use the text box to test Gaia Assist.');
      }
      assistLog('mic permission requested');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      assistLog('mic permission granted');
    }

    async function startVoicePrompt() {
      if (recognizing) {
        stopRecognition();
        return;
      }
      if (activeRecorder?.state === 'recording') {
        stopActiveRecording();
        return;
      }

      if (pendingVoice || activeTtsController || activeChatController || window.speechSynthesis?.speaking || !getSharedAudio().paused) {
        interruptAssistant('voice');
      }
      setError('');
      clearLiveTranscript();
      await unlockVoicePlayback(true);

      if (SpeechRecognition && !preferRecorderFirst) {
        beginSpeechRecognition();
        return;
      }

      await recordLiveVoice();
    }

    wireTabAssist();
    window.addEventListener('gaia:route', wireTabAssist);
    window.addEventListener('gaia:open-assist', (event) => {
      unlockVoicePlayback();
      setOpen(true);
      if (event.detail?.prompt) {
        if (event.detail.speak) {
          sendPrompt(event.detail.prompt, 'chakra', 'quick-action');
          return;
        }
        promptInput.value = event.detail.prompt;
        promptInput.focus();
      }
    });
    close.addEventListener('click', () => setOpen(false));
    mic.addEventListener('click', async () => {
      await unlockVoicePlayback(true);
      await startVoicePrompt();
    });
    muteButton.addEventListener('click', () => setMuted(!muted));
    stopButton.addEventListener('click', stopSpeaking);
    playButton.addEventListener('click', async () => {
      if (!pendingVoice) return;
      setVoiceHint('');
      await unlockVoicePlayback(true);
      try {
        await playAudioElement(pendingVoice.url, pendingVoice.provider, pendingVoice.voice);
        clearPendingVoice(false);
      } catch (err) {
        assistError('speech error', { provider: pendingVoice.provider, error: err.message });
        setError('Voice playback is still blocked. Turn off silent mode or raise volume, then tap Hear Gaia again.');
      }
    });
    voiceProviderSelect.addEventListener('change', () => {
      localStorage.setItem(VOICE_PROVIDER_KEY, voiceProviderSelect.value);
      refreshVoiceOptions();
      setVoiceProvider(voiceProviderSelect.value === 'auto' ? 'auto' : voiceProviderSelect.value);
    });
    voiceNameSelect.addEventListener('change', () => {
      localStorage.setItem(VOICE_NAME_KEY, voiceNameSelect.value);
    });
    document.addEventListener('gaia:sync', configureVoiceFromBootstrap);
    voiceSpeed.addEventListener('input', () => {
      localStorage.setItem(VOICE_SPEED_KEY, voiceSpeed.value);
      voiceSpeedLabel.textContent = `${Number(voiceSpeed.value).toFixed(2)}x`;
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      unlockVoicePlayback();
      const prompt = promptInput.value;
      promptInput.value = '';
      sendPrompt(prompt, 'typed', 'text');
    });
    chips.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        unlockVoicePlayback();
        const item = suggestionMap.find((entry) => entry.intent === button.dataset.intent) || suggestionMap[0];
        sendPrompt(item.label, item.intent, 'quick-action');
      });
    });

    document.querySelectorAll('[data-gaia-open-assist]').forEach((button) => {
      button.addEventListener('click', () => {
        unlockVoicePlayback();
        setOpen(true);
      });
    });
    setMuted(muted);
    initVoiceSettings();
    setVoiceProvider(selectedProvider() === 'auto' ? 'auto' : selectedProvider());
    requestAnimationFrame(wireTabAssist);
    setTimeout(wireTabAssist, 0);
  }

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initCoachMark();
    initSplashSteps();
    initChakraMaps();
    initAppShellNavigation();
    initCommunityHub();
    initCommunityTabs();
    initLiveSyncIndicator();
    initGaiaAssist();
  });
})();
