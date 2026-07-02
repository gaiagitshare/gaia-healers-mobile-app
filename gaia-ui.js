/* Gaia Healers V2 — prototype interactions */
(function () {
  if (new URLSearchParams(window.location.search).has('store')) {
    sessionStorage.setItem('gaia-coach-v5', '1');
    sessionStorage.setItem('gaia-entered', '1');
    sessionStorage.setItem('gaia-onboarded', '1');
  }

  const COACH_KEY = 'gaia-coach-v5';
  const THEME_KEY = 'gaia-theme';
  const DEFAULT_PROXY = 'https://ba2ki.com/gaia-proxy';
  const VOICE_PROVIDER_KEY = 'gaia-assist-voice-provider';
  const VOICE_NAME_KEY = 'gaia-assist-voice-name';
  const VOICE_SPEED_KEY = 'gaia-assist-voice-speed';
  const ADMIN_MODE_KEY = 'gaia-admin-mode';
  const ADMIN_UNLOCK_PARAM = 'admin';
  const ADMIN_DEV_PASSCODE = 'gaia2026';
  const ASSIST_WELCOME_KEY = 'gaia-assist-welcome-v1';
  const GHL_CUSTOM_MENU_URL = 'https://crm.gaiahealers.com/v2/location/WkKl1K5RuZNQ60xR48k6/custom-menu-link/328efaea-4e94-42ec-9ce2-4358a64657db';
  const APP_VIEWS = new Set(['today', 'wellness', 'academy', 'community', 'profile', 'admin']);
  const AUTH_HINT_KEYS = ['memberId', 'contactId', 'email', 'name', 'displayName', 'role', 'cohort', 'locationId', 'bridge', 'sharedSecret'];
  const AUTH_STATE = {
    authenticated: false,
    checked: false,
    member: null,
  };
  let refreshChakraMaps = () => {};

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isGhlEmbeddedMode() {
    const params = new URLSearchParams(window.location.search);
    const mode = String(params.get('embedded') || params.get('host') || params.get('mode') || '').toLowerCase();
    if (['ghl', 'crm', 'gohighlevel', '1', 'true'].includes(mode)) return true;
    try {
      const referrer = document.referrer || '';
      return window.self !== window.top
        && /crm\.gaiahealers\.com|gohighlevel|leadconnectorhq|msgsndr/i.test(referrer);
    } catch {
      return false;
    }
  }

  function appHref(view = 'today', options = {}) {
    const params = new URLSearchParams(window.location.search);
    if (view === 'today') params.delete('view');
    else params.set('view', view);
    if (options.tab) params.set('tab', options.tab);
    else params.delete('tab');
    params.delete('screen');
    const query = params.toString();
    return `home.html${query ? `?${query}` : ''}`;
  }

  function syncProxyBase() {
    return (window.GAIA_SYNC?.proxyBase || DEFAULT_PROXY).replace(/\/+$/, '');
  }

  function authState() {
    return AUTH_STATE;
  }

  function authHintParams() {
    const params = new URLSearchParams(window.location.search);
    return AUTH_HINT_KEYS.reduce((acc, key) => {
      const value = String(params.get(key) || '').trim();
      if (!value) return acc;
      if (/^\{\{.*\}\}$/.test(value) || /^YOUR_[A-Z0-9_]+$/i.test(value)) return acc;
      acc[key] = value;
      return acc;
    }, {});
  }

  function hasAuthHints() {
    return Object.keys(authHintParams()).length > 0;
  }

  function portalBaseUrl() {
    return String(window.GAIA?.clientPortal?.url || window.GAIA?.portalUrl || 'https://education.gaiahealers.com').replace(/\/+$/, '');
  }

  function inferPortalSection(label = '') {
    const text = String(label || '').toLowerCase();
    if (/course|academy|learning|module|lesson|credential|certification/.test(text)) return 'academy';
    if (/community|discussion|member|directory|newsletter|event|calendar|badge|ticket/.test(text)) return 'community';
    if (/profile|portal|client|account|login|purchase|order|product|store|market/.test(text)) return 'profile';
    return 'home';
  }

  function portalWorkspaceUrl(section = 'home', explicitUrl = '') {
    const explicit = String(explicitUrl || '').trim();
    if (/^https:\/\/education\.gaiahealers\.com/i.test(explicit)) return explicit;
    const base = portalBaseUrl();
    const authenticated = authState().authenticated;
    const routes = {
      academy: authenticated ? '/products' : '/login',
      community: authenticated ? '/communities' : '/login',
      profile: authenticated ? '' : '/login',
      home: authenticated ? '' : '/login',
    };
    return `${base}${routes[section] || routes.home}`;
  }

  function ensurePortalWorkspace() {
    let root = document.getElementById('gaia-portal-workspace');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'gaia-portal-workspace';
    root.className = 'gaia-portal-workspace hidden';
    root.innerHTML = `
      <button type="button" class="gaia-portal-workspace__backdrop" aria-label="Close member workspace"></button>
      <section class="gaia-portal-workspace__sheet" role="dialog" aria-label="Gaia member workspace">
        <div class="gaia-portal-workspace__handle" aria-hidden="true"></div>
        <div class="gaia-portal-workspace__top">
          <div>
            <p class="gaia-mini-label">Member workspace</p>
            <h3 class="gaia-portal-workspace__title">Gaia Client Portal</h3>
            <p class="gaia-portal-workspace__note">Use your Gaia member login to continue secure courses, communities, purchases, and certificates without leaving the app shell.</p>
          </div>
          <button type="button" class="gaia-portal-workspace__close" aria-label="Close member workspace">×</button>
        </div>
        <div class="gaia-portal-workspace__actions">
          <button type="button" class="gaia-portal-workspace__chip" data-portal-shortcut="academy">Courses</button>
          <button type="button" class="gaia-portal-workspace__chip" data-portal-shortcut="community">Community</button>
          <button type="button" class="gaia-portal-workspace__chip" data-portal-shortcut="profile">Profile</button>
          <a class="gaia-portal-workspace__external" href="https://education.gaiahealers.com/login" target="_blank" rel="noreferrer">Open outside</a>
        </div>
        <div class="gaia-portal-workspace__frame-wrap">
          <iframe class="gaia-portal-workspace__frame" title="Gaia client portal" loading="eager" referrerpolicy="strict-origin-when-cross-origin" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
        </div>
      </section>`;
    document.body.appendChild(root);
    const close = () => {
      root.classList.add('hidden');
      document.body.classList.remove('gaia-portal-workspace-open');
    };
    root.querySelector('.gaia-portal-workspace__backdrop')?.addEventListener('click', close);
    root.querySelector('.gaia-portal-workspace__close')?.addEventListener('click', close);
    root.querySelectorAll('[data-portal-shortcut]').forEach((button) => {
      button.addEventListener('click', () => {
        openPortalWorkspace(button.dataset.portalShortcut || 'home');
      });
    });
    return root;
  }

  function openPortalWorkspace(section = 'home', explicitUrl = '') {
    const root = ensurePortalWorkspace();
    const title = root.querySelector('.gaia-portal-workspace__title');
    const note = root.querySelector('.gaia-portal-workspace__note');
    const frame = root.querySelector('.gaia-portal-workspace__frame');
    const external = root.querySelector('.gaia-portal-workspace__external');
    const targetUrl = portalWorkspaceUrl(section, explicitUrl);
    const labels = {
      academy: 'Gaia Academy',
      community: 'Gaia Community',
      profile: 'Gaia Member Access',
      home: 'Gaia Client Portal',
    };
    if (title) title.textContent = labels[section] || labels.home;
    if (note) {
      note.textContent = authState().authenticated
        ? 'Your Gaia proxy session is active. Use the secure portal below for member-only lessons, community access, purchases, and certificates.'
        : 'Log in with your existing Gaia member account below. Once authenticated, your courses and gated portal content stay inside this app experience.';
    }
    if (external) external.href = targetUrl;
    if (frame && frame.src !== targetUrl) frame.src = targetUrl;
    root.classList.remove('hidden');
    document.body.classList.add('gaia-portal-workspace-open');
  }

  function wirePortalWorkspaceLinks(root = document) {
    root.querySelectorAll('a[href*="education.gaiahealers.com"]').forEach((link) => {
      if (link.dataset.gaiaPortalLaunch) return;
      const label = `${link.textContent || ''} ${link.getAttribute('aria-label') || ''} ${link.href || ''}`;
      link.dataset.gaiaPortalLaunch = '1';
      link.dataset.gaiaPortalSection = inferPortalSection(label);
      link.removeAttribute('target');
    });
  }

  function embeddedPortalTarget(label = '') {
    const text = String(label || '').toLowerCase();
    if (/course|academy|learning|module|credential|certification/.test(text)) {
      return appHref('academy');
    }
    if (/market|product|bundle|store|gokollab/.test(text)) {
      return appHref('community', { tab: 'products' });
    }
    if (/event|calendar|elevate|badge|ticket/.test(text)) {
      return appHref('community', { tab: 'events' });
    }
    if (/member|directory|profile|login|portal|client/.test(text)) {
      return appHref('profile');
    }
    if (/newsletter|marketing|digest|email/.test(text)) {
      return appHref('community', { tab: 'newsletter' });
    }
    return appHref('community', { tab: 'discussion' });
  }

  function percentLabel(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0%';
    return `${Math.round(Math.max(0, Math.min(100, number)))}%`;
  }

  function compactDateTime(value) {
    if (!value) return '';
    try {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat('en', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
    } catch {
      return String(value);
    }
  }

  function parseEventHeroDate(event) {
    const raw = String(
      event?.startDate
      || event?.start_date
      || String(event?.date || '').split(' - ')[0]?.trim()
      || String(event?.date || '').split(',')[0]?.trim()
      || '',
    ).trim();
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      const [, year, monthNum, dayNum] = iso;
      const date = new Date(Number(year), Number(monthNum) - 1, Number(dayNum));
      if (!Number.isNaN(date.getTime())) {
        return {
          day: String(Number(dayNum)),
          month: date.toLocaleString('en', { month: 'short' }),
          year,
        };
      }
    }
    const friendly = raw.match(/([A-Za-z]{3,})\s+(\d{1,2})/);
    const yearMatch = String(event?.date || raw).match(/(20\d{2})/);
    if (friendly) {
      return {
        day: String(Number(friendly[2])),
        month: friendly[1].slice(0, 3),
        year: yearMatch?.[1] || String(new Date().getFullYear()),
      };
    }
    return { day: '20', month: 'Nov', year: '2026' };
  }

  function isCoarsePointer() {
    return window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  }

  function wireEmbeddedPortalLinks(root = document) {
    root.querySelectorAll('a[href*="education.gaiahealers.com"]').forEach((link) => {
      if (link.dataset.gaiaEmbeddedWired) return;
      const label = `${link.textContent || ''} ${link.getAttribute('aria-label') || ''} ${link.href || ''}`;
      link.dataset.gaiaEmbeddedWired = '1';
      link.dataset.gaiaPortalLaunch = '1';
      link.dataset.gaiaPortalSection = inferPortalSection(label);
      link.removeAttribute('target');
    });
    root.querySelectorAll('[data-ghl-custom-menu-link]').forEach((link) => {
      link.setAttribute('href', GHL_CUSTOM_MENU_URL);
    });
    wirePortalWorkspaceLinks(root);
  }

  function initGhlEmbeddedMode() {
    if (!isGhlEmbeddedMode()) return;
    document.body.classList.add('gaia-ghl-embedded');
    wireEmbeddedPortalLinks(document);
    document.addEventListener('gaia:sync', () => wireEmbeddedPortalLinks(document));
    window.addEventListener('gaia:route', () => wireEmbeddedPortalLinks(document));
  }

  function initCommunityHub() {
    let data = window.GAIA;
    if (!data) return;

    const groupsEl = document.getElementById('community-groups');
    const feedEl = document.getElementById('community-feed');
    const learningEl = document.getElementById('community-learning');
    const eventsEl = document.getElementById('community-events');
    const membersEl = document.getElementById('community-members');
    const newsletterEl = document.getElementById('community-newsletter');
    const productsEl = document.getElementById('community-products');
    if (!groupsEl && !feedEl && !learningEl) return;

    let portalUrl = data.clientPortal?.url || data.portalUrl || 'https://education.gaiahealers.com/';
    let communities = data.communities || [];
    let nameById = Object.fromEntries(communities.map((c) => [c.id, c.name]));
    let activeGroupId = 'all';

    function refreshState() {
      data = window.GAIA || data || {};
      portalUrl = data.clientPortal?.url || data.portalUrl || 'https://education.gaiahealers.com/';
      communities = data.communities || [];
      nameById = Object.fromEntries(communities.map((c) => [c.id, c.name]));
    }

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
      const heroDate = event ? parseEventHeroDate(event) : null;
      const hero = event ? `
        <a href="${escapeHtml(event.sourceUrl || 'https://elevate.gaiahealers.com/')}" class="gaia-row gaia-row--link gaia-event-flagship">
          <div class="gaia-event-date"><strong>${escapeHtml(heroDate.day)}</strong><span>${escapeHtml(heroDate.month)}</span></div>
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

    const NEWSLETTER_PREFS_KEY = 'gaia-newsletter-prefs';

    function loadNewsletterPrefs() {
      try {
        const raw = localStorage.getItem(NEWSLETTER_PREFS_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (_) {
        return {};
      }
    }

    function saveNewsletterPrefs(prefs) {
      try {
        localStorage.setItem(NEWSLETTER_PREFS_KEY, JSON.stringify(prefs));
      } catch (_) {
        /* storage unavailable (private mode) — prefs stay session-only */
      }
    }

    function renderNewsletter() {
      if (!newsletterEl) return;
      const segments = data.communityNewsletter || data.memberHub?.newsletters || [
        { title: 'Weekly practitioner digest', detail: 'Training reminders, community highlights, and CE deadlines', on: true },
        { title: 'Bio-Well device updates', detail: 'Firmware, calibration tips, and support announcements', on: true },
        { title: 'Elevate & event alerts', detail: 'Registration windows, agenda drops, and check-in codes', on: false },
        { title: 'Marketing & growth lab', detail: 'Follow-up templates and campaign ideas from faculty', on: false },
      ];
      const prefs = loadNewsletterPrefs();
      const segmentsWithPrefs = segments.map((seg) => {
        const title = seg.title || 'Newsletter segment';
        const stored = prefs[title];
        return { ...seg, title, on: stored === undefined ? !!seg.on : stored };
      });
      newsletterEl.innerHTML = segmentsWithPrefs.map((seg) => `
        <article class="gaia-row" data-newsletter-segment="${escapeHtml(seg.title)}">
          <div class="min-w-0 flex-1">
            <p class="text-headline text-ink">${escapeHtml(seg.title)}</p>
            <p class="gaia-caption mt-0.5">${escapeHtml(seg.detail || '')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked="${seg.on ? 'true' : 'false'}"
            aria-label="Toggle ${escapeHtml(seg.title)}"
            class="gaia-newsletter-toggle ${seg.on ? 'gaia-newsletter-toggle--on' : ''}"
            data-segment="${escapeHtml(seg.title)}"
          >
            <span class="gaia-newsletter-toggle__label">${seg.on ? 'Subscribed' : 'Off'}</span>
          </button>
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
      // Persist on toggle.
      newsletterEl.querySelectorAll('.gaia-newsletter-toggle').forEach((btn) => {
        btn.addEventListener('click', () => {
          const segment = btn.dataset.segment;
          const next = btn.getAttribute('aria-checked') !== 'true';
          const current = loadNewsletterPrefs();
          current[segment] = next;
          saveNewsletterPrefs(current);
          btn.setAttribute('aria-checked', next ? 'true' : 'false');
          btn.classList.toggle('gaia-newsletter-toggle--on', next);
          btn.querySelector('.gaia-newsletter-toggle__label').textContent = next ? 'Subscribed' : 'Off';
        });
      });
    }

    function renderProducts() {
      if (!productsEl) return;
      const products = data.products || data.memberHub?.products || [];
      const marketplace = data.marketplace || data.memberHub?.marketplace || {};
      productsEl.innerHTML = products.map((item) => `
        <a href="${escapeHtml(item.href || appHref('profile'))}" class="gaia-row gaia-row--link">
          <div class="gaia-tile-icon strip-biowell">${escapeHtml((item.category || 'GH').slice(0, 2).toUpperCase())}</div>
          <div class="min-w-0 flex-1">
            <p class="text-micro font-semibold text-gaia">${escapeHtml(item.category || 'Marketplace')}</p>
            <p class="text-headline text-ink mt-0.5">${escapeHtml(item.title || 'Offer')}</p>
            <p class="gaia-caption mt-0.5">${escapeHtml(item.detail || '')}</p>
          </div>
          <span class="gaia-link shrink-0">${escapeHtml(item.cta || 'Open')}</span>
        </a>
      `).join('') + `
        <article class="gaia-row">
          <div class="gaia-tile-icon strip-healeex">GK</div>
          <div class="min-w-0 flex-1">
            <p class="text-headline text-ink">${escapeHtml(marketplace.provider || 'Marketplace')}</p>
            <p class="gaia-caption mt-0.5">${escapeHtml(marketplace.note || 'Member products and digital offers sync from GHL Memberships.')}</p>
          </div>
          <span class="gaia-badge gaia-badge--subtle">${escapeHtml(marketplace.status || 'Live')}</span>
        </article>
      `;
    }

    function renderAll() {
      refreshState();
      renderGroups();
      renderFeed();
      renderLearning();
      renderEvents();
      renderMembers();
      renderNewsletter();
      renderProducts();
      wireEmbeddedPortalLinks(document);
    }

    renderAll();
    document.addEventListener('gaia:sync', renderAll);
    wireEmbeddedPortalLinks(document);
  }

  function initAcademyProgress() {
    const summaryCaption = document.getElementById('academy-summary-caption');
    const activeTitle = document.getElementById('academy-active-title');
    const activeDetail = document.getElementById('academy-active-detail');
    const activeProgress = document.getElementById('academy-active-progress');
    const activePercent = document.getElementById('academy-active-percent');
    const activeLessons = document.getElementById('academy-active-lessons');
    const continueLink = document.getElementById('academy-continue-link');
    const sourceNote = document.getElementById('academy-source-note');
    const roadmap = document.getElementById('academy-roadmap');
    const examCard = document.getElementById('academy-exam-card');
    const credentialsEl = document.getElementById('academy-credentials');
    const courseList = document.getElementById('academy-course-list');
    if (!summaryCaption || !activeTitle || !courseList) return;

    function courseStatusLabel(course) {
      const status = String(course.status || '').toLowerCase();
      if (status === 'completed') return 'Completed';
      if (status === 'locked') return 'Locked';
      if (Number(course.progressPercent) > 0) return `${percentLabel(course.progressPercent)} complete`;
      return 'Available';
    }

    function courseHref(course, academy) {
      const url = String(course.continueUrl || academy?.summary?.nextLessonUrl || '').trim();
      if (url) return url;
      return portalWorkspaceUrl('academy');
    }

    function renderRoadmap(courses = [], activeId = '') {
      if (!roadmap) return;
      const visible = courses.slice(0, 5);
      roadmap.innerHTML = visible.map((course, index) => {
        const status = String(course.status || '').toLowerCase();
        const done = status === 'completed' || Number(course.progressPercent) >= 100;
        const active = course.id === activeId || (Number(course.progressPercent) > 0 && Number(course.progressPercent) < 100);
        const locked = status === 'locked';
        const marker = done ? '✓' : locked ? String(index + 1) : String(index + 1);
        const markerClass = done
          ? 'bg-gaia text-white'
          : active
            ? 'border-2 border-gaia bg-white text-gaia'
            : 'bg-surface-muted text-ink-tertiary';
        const line = index < visible.length - 1
          ? '<span class="mt-2 w-px flex-1 bg-gaia/25 min-h-[1rem]"></span>'
          : '';
        return `<div class="flex gap-4">
          <div class="flex flex-col items-center"><span class="flex h-8 w-8 items-center justify-center rounded-full ${markerClass} text-micro font-bold">${marker}</span>${line}</div>
          <div class="pb-1 min-w-0">
            <p class="text-headline ${locked ? 'text-ink-tertiary' : 'text-ink'}">${escapeHtml(course.title)}</p>
            <p class="gaia-caption ${active ? 'text-gaia-dark' : ''}">${escapeHtml(courseStatusLabel(course))}${course.nextLessonTitle ? ` · ${escapeHtml(course.nextLessonTitle)}` : ''}</p>
          </div>
        </div>`;
      }).join('');
    }

    function renderRequirements(requirements = {}, activeCourse = {}) {
      if (!examCard) return;
      const scansCompleted = Number(requirements.scansCompleted || 0);
      const scansRequired = Number(requirements.scansRequired || 0);
      const currentCoursePercent = Number(requirements.currentCoursePercent ?? activeCourse.progressPercent ?? 0);
      const courseRequiredPercent = Number(requirements.courseRequiredPercent || 80);
      examCard.innerHTML = `<p class="text-headline text-ink">${escapeHtml(requirements.title || 'Proctored exam')}</p>
        <p class="gaia-caption mt-1">${escapeHtml(requirements.description || `${scansRequired} documented scans · ${courseRequiredPercent}% course completion`)}</p>
        <p class="text-micro text-gaia-dark mt-2 font-medium">${scansCompleted} / ${scansRequired} scans · ${percentLabel(currentCoursePercent)} course</p>
        <div class="gaia-progress gaia-progress--md mt-3"><div class="gaia-progress__fill" style="width:${Math.min(100, scansRequired ? (scansCompleted / scansRequired) * 100 : 0)}%"></div></div>`;
    }

    function renderCredentials(credentials = []) {
      if (!credentialsEl) return;
      if (!credentials.length) {
        credentialsEl.innerHTML = '<article class="gaia-row"><div class="flex-1 min-w-0"><p class="text-headline text-ink">No issued credentials yet</p><p class="gaia-caption">Complete eligible courses to unlock certificates.</p></div></article>';
        return;
      }
      credentialsEl.innerHTML = credentials.map((credential) => `
        <article class="gaia-row">
          <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-gaia text-white font-semibold">✓</div>
          <div class="flex-1 min-w-0">
            <p class="text-headline text-ink">${escapeHtml(credential.title || credential.name || 'Credential')}</p>
            <p class="gaia-caption">${escapeHtml(credential.issuer || 'Gaia Credentials')}${credential.issuedAt ? ` · ${escapeHtml(credential.issuedAt)}` : ''}</p>
          </div>
        </article>
      `).join('');
    }

    function renderCourseList(courses = [], academy = {}) {
      if (!courseList) return;
      const items = courses.filter((course) => course.id !== academy.activeCourseId).slice(0, 6);
      if (!items.length) {
        courseList.innerHTML = `
          <article class="gaia-row">
            <div class="flex-1 min-w-0">
              <p class="text-headline text-ink">${academy.memberResolved || academy.authenticated ? 'Secure Academy workspace ready' : 'Member login needed'}</p>
              <p class="gaia-caption">${academy.memberResolved || academy.authenticated ? 'Open the in-app GHL workspace for live lessons, locked modules, purchases, and certificates.' : 'Sign in once to open your secure course workspace inside the app.'}</p>
            </div>
            <a href="${escapeHtml(portalWorkspaceUrl('academy'))}" class="gaia-link shrink-0" data-gaia-portal-launch="1" data-gaia-portal-section="academy">${academy.memberResolved || academy.authenticated ? 'Open' : 'Log in'}</a>
          </article>`;
        return;
      }
      courseList.innerHTML = items.map((course) => `
        <a href="${escapeHtml(courseHref(course, academy))}" class="gaia-card gaia-card-pad gaia-course-card" ${course.continueUrl ? '' : 'data-gaia-portal-launch="1" data-gaia-portal-section="academy"'}>
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-micro font-semibold text-gaia">${escapeHtml(course.category || 'Academy')}</p>
              <h3 class="text-headline text-ink mt-0.5">${escapeHtml(course.title)}</h3>
              <p class="gaia-caption mt-1">${escapeHtml(courseStatusLabel(course))}${course.ceCredits ? ` · +${course.ceCredits} CE` : ''}</p>
            </div>
            <span class="gaia-badge ${course.status === 'completed' ? 'gaia-badge--live' : 'gaia-badge--subtle'}">${percentLabel(course.progressPercent)}</span>
          </div>
          <div class="gaia-progress gaia-progress--md mt-3"><div class="gaia-progress__fill" style="width:${Number(course.progressPercent || 0)}%"></div></div>
        </a>
      `).join('');
    }

    function renderAcademy(academy = window.GAIA?.academy) {
      if (!academy) return;
      const portalWorkspaceOnly = !academy.liveData
        && Array.isArray(academy.portalOnlyFields)
        && academy.portalOnlyFields.includes('academyProgress');
      const memberReady = Boolean(academy.memberResolved || academy.authenticated);
      if (portalWorkspaceOnly) {
        summaryCaption.textContent = memberReady
          ? 'Secure courses · GHL member workspace'
          : 'Sign in required · secure Academy workspace';
        activeTitle.textContent = memberReady ? 'Open your secure Academy workspace' : 'Log in to view your courses';
        activeDetail.textContent = memberReady
          ? 'Live lessons, locked modules, and certificates stay inside the in-app GHL portal.'
          : 'Use your Gaia member login once, then continue lessons and gated modules inside the in-app GHL portal.';
        if (activeProgress) activeProgress.style.width = '0%';
        if (activePercent) activePercent.textContent = memberReady ? 'Portal ready' : 'Log in';
        if (activeLessons) activeLessons.textContent = memberReady ? 'GHL member workspace' : 'Secure member access';
        if (continueLink) {
          continueLink.href = portalWorkspaceUrl('academy');
          continueLink.dataset.gaiaPortalLaunch = '1';
          continueLink.dataset.gaiaPortalSection = 'academy';
          continueLink.removeAttribute('data-app-nav');
          continueLink.textContent = memberReady ? 'Open Academy workspace' : 'Log in to Academy';
        }
        if (sourceNote) {
          sourceNote.textContent = memberReady
            ? 'Member verified · open the secure Academy workspace below for live lessons, locked modules, and certificates.'
            : 'Gaia courses stay protected by member login. Open the secure Academy workspace below to continue.';
        }
        renderRoadmap([], '');
        renderRequirements({
          title: memberReady ? 'Member workspace' : 'Member login required',
          description: memberReady
            ? 'Course progress and gated lessons stay inside the secure GHL member workspace.'
            : 'Sign in with your existing Gaia portal account to unlock your course progress, purchases, and credentials.',
          scansCompleted: 0,
          scansRequired: 0,
          currentCoursePercent: 0,
          courseRequiredPercent: 0,
        }, {});
        renderCredentials([]);
        renderCourseList([], { ...academy, authenticated: memberReady, memberResolved: memberReady });
        wireEmbeddedPortalLinks(document);
        window.GaiaAppShell?.wireLinks?.();
        return;
      }
      const courses = Array.isArray(academy.courses) ? academy.courses : [];
      const activeCourse = courses.find((course) => course.id === academy.activeCourseId)
        || courses.find((course) => Number(course.progressPercent) > 0 && Number(course.progressPercent) < 100)
        || courses[0]
        || {};
      const summary = academy.summary || {};
      summaryCaption.textContent = `${summary.enrolled ?? courses.length} courses · ${percentLabel(summary.averageProgress)} avg completion`;
      activeTitle.textContent = activeCourse.title || summary.nextCourseTitle || 'Academy progress';
      activeDetail.textContent = `${summary.nextLessonTitle || activeCourse.nextLessonTitle || 'Continue learning'}${activeCourse.instructor ? ` · ${activeCourse.instructor}` : ''}`;
      if (activeProgress) activeProgress.style.width = percentLabel(activeCourse.progressPercent || summary.averageProgress || 0);
      if (activePercent) activePercent.textContent = `${percentLabel(activeCourse.progressPercent || 0)} complete`;
      if (activeLessons) activeLessons.textContent = activeCourse.totalLessons ? `${activeCourse.completedLessons || 0} / ${activeCourse.totalLessons} lessons` : 'Progress synced';
      if (continueLink) {
        continueLink.href = courseHref(activeCourse, academy);
        if (!activeCourse.continueUrl && !summary.nextLessonUrl) {
          continueLink.dataset.gaiaPortalLaunch = '1';
          continueLink.dataset.gaiaPortalSection = 'academy';
          continueLink.removeAttribute('data-app-nav');
        } else {
          continueLink.removeAttribute('data-gaia-portal-launch');
          continueLink.removeAttribute('data-gaia-portal-section');
          continueLink.removeAttribute('data-app-nav');
        }
        continueLink.textContent = academy.liveData
          ? (activeCourse.status === 'locked' ? 'View unlock steps' : 'Continue where I left off')
          : 'Open secure Academy workspace';
      }
      if (sourceNote) {
        if (academy.liveData) {
          sourceNote.textContent = `Live course sync · ${academy.source || 'academy'}`;
        } else if (academy.memberResolved || academy.authenticated) {
          sourceNote.textContent = 'Member verified · open the secure Academy workspace below for live lessons, locked modules, and certificates.';
        } else {
          sourceNote.textContent = 'Log in to open your secure Academy workspace inside the app.';
        }
      }
      renderRoadmap(courses, academy.activeCourseId);
      renderRequirements(academy.requirements, activeCourse);
      renderCredentials(academy.credentials || []);
      renderCourseList(courses, academy);
      wireEmbeddedPortalLinks(document);
      window.GaiaAppShell?.wireLinks?.();
    }

    async function refreshAcademy() {
      renderAcademy(window.GAIA?.academy);
      try {
        const response = await fetch(`${syncProxyBase()}/api/academy/progress`, {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        if (!response.ok) throw new Error(`Academy progress returned ${response.status}`);
        const payload = await response.json();
        window.GAIA = { ...(window.GAIA || {}), academy: payload };
        renderAcademy(payload);
      } catch (error) {
        if (sourceNote) sourceNote.textContent = `Course sync unavailable · ${error.message}`;
      }
    }

    renderAcademy(window.GAIA?.academy);
    document.addEventListener('gaia:sync', () => refreshAcademy());
    window.addEventListener('gaia:route', () => {
      if (window.GaiaAppShell?.currentView?.() === 'academy') refreshAcademy();
    });
    if (window.GAIA_SYNC?.status === 'live' || window.GAIA_SYNC?.status === 'connected') refreshAcademy();
  }

  function initMemberHub() {
    const todayHeroGreeting = document.getElementById('today-hero-greeting');
    const todayHeroTitle = document.getElementById('today-hero-title');
    const todayHeroSub = document.getElementById('today-hero-sub');
    const todayAcademyTitle = document.getElementById('today-academy-title');
    const todayAcademyMeta = document.getElementById('today-academy-meta');
    const todayEventsTitle = document.getElementById('today-events-title');
    const todayEventsMeta = document.getElementById('today-events-meta');
    const todayJourneyTitle = document.getElementById('today-journey-title');
    const todayJourneyBadge = document.getElementById('today-journey-badge');
    const todayHubTitle = document.getElementById('today-hub-title');
    const todayHubBadge = document.getElementById('today-hub-badge');
    const todayNextLesson = document.getElementById('today-next-lesson');
    const todayNextMeeting = document.getElementById('today-next-meeting');
    const todayProductsSummary = document.getElementById('today-products-summary');
    const profilePortalUsers = document.getElementById('profile-portal-users');
    const profileAccessNote = document.getElementById('profile-access-note');
    const profileCeCredits = document.getElementById('profile-ce-credits');
    const profileCeDetail = document.getElementById('profile-ce-detail');
    const profileCeProgress = document.getElementById('profile-ce-progress');
    const profileMeetings = document.getElementById('profile-meetings');
    const profileEventPassTitle = document.getElementById('profile-event-pass-title');
    const profileEventPassDetail = document.getElementById('profile-event-pass-detail');
    const profileMarketplace = document.getElementById('profile-marketplace');
    if (!todayHeroGreeting && !profilePortalUsers) return;

    function renderHub() {
      const data = window.GAIA || {};
      const hub = data.memberHub || {};
      const academy = data.academy || {};
      const activeCourse = (academy.courses || []).find((course) => course.id === academy.activeCourseId)
        || (academy.courses || []).find((course) => Number(course.progressPercent) > 0 && Number(course.progressPercent) < 100)
        || (academy.courses || [])[0]
        || {};
      const dashboard = hub.dashboard || {};
      const products = data.products || hub.products || [];
      const meetings = data.meetings || hub.meetings || [];
      const portal = data.clientPortal || hub.portal || {};
      const communities = data.communities || hub.communities || [];
      const ceEarned = Number(dashboard.ceCreditsEarned ?? academy.summary?.ceCreditsEarned ?? 0);
      const ceRequired = Number(dashboard.ceCreditsRequired ?? academy.summary?.ceCreditsRequired ?? 24) || 24;
      const cePercent = ceRequired > 0 ? Math.max(0, Math.min(100, Math.round((ceEarned / ceRequired) * 100))) : 0;

      if (todayHeroGreeting) todayHeroGreeting.textContent = hub.member?.cohort || 'Client portal';
      if (todayHeroTitle) todayHeroTitle.innerHTML = escapeHtml(dashboard.welcomeTitle || 'Your Gaia dashboard is ready');
      if (todayHeroSub) todayHeroSub.textContent = dashboard.welcomeDetail || 'Courses, communities, live sessions, credentials, and products from GHL Memberships.';
      if (todayAcademyTitle) {
        todayAcademyTitle.textContent = activeCourse.title
          || academy.summary?.nextCourseTitle
          || dashboard.topCourse
          || 'Academy';
      }
      if (todayAcademyMeta) {
        if (Number(activeCourse.progressPercent) > 0) {
          todayAcademyMeta.textContent = `${percentLabel(activeCourse.progressPercent)} complete`;
        } else if (Number(academy.summary?.averageProgress) > 0) {
          todayAcademyMeta.textContent = `${percentLabel(academy.summary.averageProgress)} avg completion`;
        } else {
          todayAcademyMeta.textContent = dashboard.topCourseMeta || 'Continue learning';
        }
      }
      if (todayEventsTitle) todayEventsTitle.textContent = dashboard.eventPassTitle || data.event?.shortName || 'Events';
      if (todayEventsMeta) todayEventsMeta.textContent = dashboard.eventPassDetail || 'Badge ops ready';
      if (todayJourneyTitle) {
        todayJourneyTitle.textContent = activeCourse.title
          || academy.summary?.nextCourseTitle
          || dashboard.topCourse
          || 'Growth journey';
      }
      if (todayJourneyBadge) todayJourneyBadge.textContent = percentLabel(activeCourse.progressPercent || academy.summary?.averageProgress || 0);
      if (todayHubTitle) todayHubTitle.textContent = `${portal.adminSections?.length || 5} synced membership areas`;
      if (todayHubBadge) todayHubBadge.textContent = (portal.users || data.members) ? `${Number(portal.users || data.members).toLocaleString()} users` : 'GHL';
      if (todayNextLesson) todayNextLesson.textContent = dashboard.nextLessonTitle || academy.summary?.nextLessonTitle || 'Continue your active course';
      if (todayNextMeeting) {
        const meeting = meetings[0];
        todayNextMeeting.textContent = meeting
          ? `${meeting.title} · ${compactDateTime(meeting.startsAt) || dashboard.nextMeetingTime || ''}`
          : `${dashboard.nextMeetingTitle || 'No meeting scheduled'}${dashboard.nextMeetingTime ? ` · ${dashboard.nextMeetingTime}` : ''}`;
      }
      if (todayProductsSummary) {
        todayProductsSummary.textContent = products.length
          ? products.slice(0, 3).map((item) => item.title).join(' · ')
          : 'Bio-Well kits · Gokollab store · event passes';
      }

      if (profilePortalUsers) profilePortalUsers.textContent = Number(portal.users || data.members || 0).toLocaleString();
      if (profileAccessNote) {
        const notes = hub.access?.notes || [];
        profileAccessNote.textContent = notes[0]
          || 'Member login should use GHL Client Portal or a backend-generated magic link through the staging proxy.';
      }
      if (profileCeCredits) profileCeCredits.textContent = String(ceEarned || 0);
      if (profileCeDetail) profileCeDetail.textContent = `of ${ceRequired} required · live Academy sync when member identity is verified`;
      if (profileCeProgress) profileCeProgress.style.width = `${cePercent}%`;
      if (profileEventPassTitle) profileEventPassTitle.textContent = dashboard.eventPassTitle || 'Elevate 2026';
      if (profileEventPassDetail) profileEventPassDetail.textContent = dashboard.eventPassDetail || data.event?.date || 'Badge ops ready';

      if (profileMeetings) {
        profileMeetings.innerHTML = (meetings.length ? meetings : [{
          title: dashboard.nextMeetingTitle || 'No live session scheduled',
          startsAt: dashboard.nextMeetingTime || '',
          provider: 'ghl',
          group: 'Client portal',
        }]).map((meeting) => `
          <a href="${escapeHtml(appHref('community', { tab: 'events' }))}" class="gaia-row gaia-row--link">
            <div class="gaia-tile-icon strip-biotekna">${escapeHtml((meeting.provider || 'ME').slice(0, 2).toUpperCase())}</div>
            <div class="min-w-0 flex-1">
              <p class="text-headline text-ink">${escapeHtml(meeting.title || 'Live session')}</p>
              <p class="gaia-caption mt-0.5">${escapeHtml(compactDateTime(meeting.startsAt) || '')}${meeting.group ? ` · ${escapeHtml(meeting.group)}` : ''}</p>
            </div>
            <span class="gaia-badge gaia-badge--subtle">${escapeHtml((meeting.provider || 'live').replace('_', ' '))}</span>
          </a>
        `).join('');
      }

      if (profileMarketplace) {
        profileMarketplace.innerHTML = (products.length ? products : [{
          title: 'Client portal storefront',
          category: 'Store',
          detail: marketplace.note || 'Products and member checkout routes live inside GHL Memberships.',
          href: portal.url || appHref('community', { tab: 'products' }),
          cta: 'Open',
        }]).map((item) => `
          <a href="${escapeHtml(item.href || appHref('community', { tab: 'products' }))}" class="gaia-row gaia-row--link">
            <div class="gaia-tile-icon strip-biowell">${escapeHtml((item.category || 'GH').slice(0, 2).toUpperCase())}</div>
            <div class="min-w-0 flex-1">
              <p class="text-micro font-semibold text-gaia">${escapeHtml(item.category || 'Offer')}</p>
              <p class="text-headline text-ink mt-0.5">${escapeHtml(item.title || 'Product')}</p>
              <p class="gaia-caption mt-0.5">${escapeHtml(item.detail || '')}</p>
            </div>
            <span class="gaia-link shrink-0">${escapeHtml(item.cta || 'Open')}</span>
          </a>
        `).join('') + `
          <article class="gaia-row">
            <div class="gaia-tile-icon strip-healeex">GH</div>
            <div class="min-w-0 flex-1">
              <p class="text-headline text-ink">Community access</p>
              <p class="gaia-caption mt-0.5">${communities.length} active groups inside GHL Memberships</p>
            </div>
            <span class="gaia-badge">${communities.length}</span>
          </article>
        `;
      }
    }

    renderHub();
    document.addEventListener('gaia:sync', renderHub);
    window.addEventListener('gaia:route', renderHub);
  }

  function initMemberAuth() {
    const portalOrigin = 'https://education.gaiahealers.com/';
    const profileTitle = document.querySelector('.gaia-profile-hero .gaia-page-title');
    const profileCaption = document.querySelector('.gaia-profile-hero .gaia-caption');
    const signOutBtn = document.querySelector('[data-sign-out]');
    const accessNote = document.getElementById('profile-access-note');
    let modal;
    let emailInput;
    let statusEl;
    let submitBtn;

    function ensureModal() {
      if (modal) return modal;
      modal = document.createElement('div');
      modal.className = 'fixed inset-0 z-[90] hidden items-end justify-center bg-black/45 px-4 pb-6 pt-16';
      modal.innerHTML = `
        <div class="gaia-card gaia-card-pad w-full max-w-md rounded-[28px] shadow-lift">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="gaia-section-label !mb-1">Member access</p>
              <h2 class="gaia-section-title">Sign in to Gaia</h2>
              <p class="gaia-caption mt-1">Use your Gaia member email. If the app is launched from GHL, access can be claimed automatically.</p>
            </div>
            <button type="button" class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xl text-ink-secondary" data-auth-close aria-label="Close sign in">&times;</button>
          </div>
          <form class="mt-4 space-y-3" data-auth-form>
            <label class="block">
              <span class="gaia-caption mb-1.5 block">Member email</span>
              <input type="email" class="w-full rounded-2xl border border-black/8 bg-white px-4 py-3 text-body text-ink outline-none" placeholder="you@gaiahealers.com" autocomplete="email" required />
            </label>
            <button type="submit" class="gaia-btn gaia-btn-primary w-full">Send Gaia access link</button>
          </form>
          <p class="gaia-caption mt-3" data-auth-status>We will verify your member access through the Gaia proxy.</p>
          <a href="${portalOrigin}" class="gaia-link mt-3 inline-block">Open the current client portal</a>
        </div>`;
      document.body.appendChild(modal);
      emailInput = modal.querySelector('input');
      statusEl = modal.querySelector('[data-auth-status]');
      submitBtn = modal.querySelector('button[type="submit"]');
      modal.querySelector('[data-auth-close]').addEventListener('click', () => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
      });
      modal.addEventListener('click', (event) => {
        if (event.target === modal) {
          modal.classList.add('hidden');
          modal.classList.remove('flex');
        }
      });
      modal.querySelector('[data-auth-form]').addEventListener('submit', async (event) => {
        event.preventDefault();
        const email = emailInput.value.trim();
        if (!email) return;
        submitBtn.disabled = true;
        statusEl.textContent = 'Requesting your Gaia access link...';
        try {
          const response = await fetch(`${syncProxyBase()}/api/auth/magic-link/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              email,
              returnTo: window.location.href,
            }),
          });
          const payload = await response.json();
          if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Sign-in request failed.');
          statusEl.textContent = payload.delivery === 'debug-link'
            ? 'Opening your Gaia access link...'
            : 'Check your email for the Gaia access link.';
          if (payload.authUrl) window.location.href = payload.authUrl;
        } catch (error) {
          statusEl.textContent = error.message || 'Unable to request access right now.';
        } finally {
          submitBtn.disabled = false;
        }
      });
      return modal;
    }

    function openModal(prefill = '') {
      ensureModal();
      if (prefill) emailInput.value = prefill;
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      requestAnimationFrame(() => emailInput?.focus());
    }

    function cleanAuthHintsFromUrl() {
      const url = new URL(window.location.href);
      let changed = false;
      AUTH_HINT_KEYS.forEach((key) => {
        if (url.searchParams.has(key)) {
          url.searchParams.delete(key);
          changed = true;
        }
      });
      if (changed) history.replaceState({}, '', url.toString());
    }

    function renderAuthUi() {
      const session = authState();
      document.querySelectorAll('a.gaia-login-pill, a.gaia-login-btn').forEach((link) => {
        if (!link.dataset.gaiaAuthBound) return;
        link.textContent = session.authenticated ? 'Member access' : 'Log in';
      });
      if (profileTitle) profileTitle.textContent = session.authenticated ? (session.member?.displayName || 'Gaia member') : 'Practitioner';
      if (profileCaption) {
        profileCaption.textContent = session.authenticated
          ? `${session.member?.cohort || session.member?.role || 'Member'}${session.member?.email ? ` · ${session.member.email}` : ''}`
          : 'Bio-Well Practitioners · Since 2024';
      }
      if (accessNote && session.authenticated) {
        accessNote.textContent = `Signed in as ${session.member?.displayName || 'Gaia member'}${session.member?.email ? ` (${session.member.email})` : ''}. Member-specific lessons, purchases, certificates, and gated access now resolve through the Gaia proxy session.`;
      }
      if (signOutBtn) signOutBtn.hidden = !session.authenticated;
    }

    async function refreshSession() {
      try {
        const response = await fetch(`${syncProxyBase()}/api/auth/session`, {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        const payload = await response.json();
        AUTH_STATE.authenticated = Boolean(payload.authenticated);
        AUTH_STATE.checked = true;
        AUTH_STATE.member = payload.member || null;
        document.dispatchEvent(new CustomEvent('gaia:auth', { detail: { ...AUTH_STATE } }));
        renderAuthUi();
        return AUTH_STATE;
      } catch {
        AUTH_STATE.checked = true;
        AUTH_STATE.authenticated = false;
        AUTH_STATE.member = null;
        renderAuthUi();
        return AUTH_STATE;
      }
    }

    async function maybeClaimEmbeddedSession() {
      if (!hasAuthHints()) return false;
      if (!document.referrer || !/crm\.gaiahealers\.com|education\.gaiahealers\.com/i.test(document.referrer)) return false;
      const hints = authHintParams();
      if (!hints.email && !hints.contactId && !hints.memberId) return false;
      try {
        const response = await fetch(`${syncProxyBase()}/api/auth/embedded/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            ...hints,
            sharedSecret: hints.sharedSecret || hints.bridge || '',
            referrer: document.referrer,
          }),
        });
        const payload = await response.json();
        if (!response.ok || payload.ok === false) return false;
        AUTH_STATE.authenticated = true;
        AUTH_STATE.checked = true;
        AUTH_STATE.member = payload.member || null;
        cleanAuthHintsFromUrl();
        document.dispatchEvent(new CustomEvent('gaia:auth', { detail: { ...AUTH_STATE } }));
        renderAuthUi();
        return true;
      } catch {
        return false;
      }
    }

    async function handleLogout(event) {
      event?.preventDefault?.();
      await fetch(`${syncProxyBase()}/api/auth/logout`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      }).catch(() => null);
      AUTH_STATE.authenticated = false;
      AUTH_STATE.member = null;
      renderAuthUi();
      window.GAIA_SYNC?.refresh?.();
    }

    document.querySelectorAll('a.gaia-login-pill, a.gaia-login-btn').forEach((link) => {
      link.dataset.gaiaAuthBound = '1';
      link.addEventListener('click', (event) => {
        if (authState().authenticated) return;
        event.preventDefault();
        openModal(authState().member?.email || authHintParams().email || '');
      });
    });
    signOutBtn?.addEventListener('click', handleLogout);

    (async () => {
      const claimed = await maybeClaimEmbeddedSession();
      await refreshSession();
      if (claimed || AUTH_STATE.authenticated) window.GAIA_SYNC?.refresh?.();
    })();
  }

  function initTheme() {
    if (!document.body.classList.contains('gaia-page') && !document.body.classList.contains('gaia-app')) return;

    function themeColorFor(theme) {
      return theme === 'dark' ? '#060908' : '#eef4ea';
    }

    function updateThemeColorMeta(theme) {
      let meta = document.querySelector('meta[name="theme-color"]:not([media])');
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'theme-color';
        document.head.appendChild(meta);
      }
      meta.content = themeColorFor(theme);
    }

    function renderToggleIcon(button, theme) {
      button.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      button.setAttribute('aria-pressed', String(theme === 'dark'));
      button.innerHTML = theme === 'dark'
        ? '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m0 13.5V21m9-9h-2.25M5.25 12H3m15.364 6.364-1.591-1.591M7.227 7.227 5.636 5.636m12.728 0-1.591 1.591M7.227 16.773l-1.591 1.591M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/></svg>'
        : '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"/></svg>';
    }

    function apply(theme) {
      const next = theme === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      document.body.dataset.theme = next;
      document.documentElement.style.colorScheme = next;
      localStorage.setItem(THEME_KEY, next);
      updateThemeColorMeta(next);
      const appleMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (appleMeta) appleMeta.content = next === 'dark' ? 'black-translucent' : 'default';
      document.querySelectorAll('.gaia-theme-toggle').forEach((button) => {
        renderToggleIcon(button, next);
      });
    }

    function wireThemeToggles() {
      document.querySelectorAll('[data-gaia-header-actions]').forEach((slot) => {
        if (slot.querySelector('.gaia-theme-toggle')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'gaia-theme-toggle';
        button.addEventListener('click', () => {
          apply(document.body.dataset.theme === 'dark' ? 'light' : 'dark');
        });
        slot.insertBefore(button, slot.firstChild);
      });
      document.body.querySelector(':scope > .gaia-theme-toggle')?.remove();
    }

    const saved = localStorage.getItem(THEME_KEY);
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    wireThemeToggles();
    apply(saved || (prefersDark ? 'dark' : 'light'));

    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
      if (localStorage.getItem(THEME_KEY)) return;
      apply(event.matches ? 'dark' : 'light');
    });
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
      if (event.detail?.view === 'wellness' && event.detail?.tab === 'chakras') {
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
      <p class="gaia-coach__eyebrow">Quick guide</p>
      <p class="gaia-coach__body"><strong>Tap Gaia</strong> once for live voice — just speak naturally, like a phone call. Tap again to close.</p>
      <p class="gaia-coach__sub"><strong>Community</strong> is in the bottom bar. <strong>Profile</strong> and <strong>Log in</strong> are top right.</p>
      <button type="button" class="gaia-coach__btn">Got it</button>`;
    tip.querySelector('button').addEventListener('click', () => {
      sessionStorage.setItem(COACH_KEY, '1');
      tip.remove();
    });
    anchor.before(tip);
  }

  function initHeaderProfile() {
    function updateHeaderProfileActive() {
      const view = window.GaiaAppShell?.currentView?.()
        || new URLSearchParams(window.location.search).get('view');
      document.querySelectorAll('[data-gaia-header-profile]').forEach((link) => {
        const on = view === 'profile' || view === 'admin';
        link.classList.toggle('is-active', on);
        if (on) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
    }

    document.querySelectorAll('[data-gaia-header-actions]').forEach((slot) => {
      if (slot.querySelector('[data-gaia-header-profile]')) return;
      const link = document.createElement('a');
      link.href = 'home.html?view=profile';
      link.className = 'gaia-header-profile gaia-login-pill gaia-login-pill--compact';
      link.dataset.gaiaHeaderProfile = '';
      link.setAttribute('data-app-nav', 'profile');
      link.textContent = 'Profile';
      const login = slot.querySelector('a.gaia-login-pill[href*="education"]');
      if (login) slot.insertBefore(link, login);
      else slot.appendChild(link);
    });

    updateHeaderProfileActive();
    window.addEventListener('gaia:route', updateHeaderProfileActive);
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
      const rawView = String(params.get('view') || hash || 'today').toLowerCase();
      let view = normalizeView(rawView);
      let tab = params.get('tab') || '';
      if (rawView === 'biowell') {
        view = 'wellness';
        tab = tab || 'biowell';
      } else if (rawView === 'chakras') {
        view = 'wellness';
        tab = tab || 'chakras';
      } else if (view === 'wellness' && !tab) {
        tab = 'biowell';
      } else if (view === 'community' && !tab) {
        tab = 'discussion';
      }
      return { view, tab };
    }

    function tabForView(view, tab) {
      if (view === 'community') return tab || 'discussion';
      if (view === 'wellness') return tab || 'biowell';
      return '';
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
        wellness: 'Wellness',
        biowell: 'Wellness',
        chakras: 'Wellness',
        academy: 'Academy',
        community: 'Community',
        profile: 'Profile',
        admin: 'Admin',
      };
      document.title = `${labels[view] || 'Gaia'} · Gaia Healers`;
    }

    function showView(view, options = {}) {
      if (view === 'biowell' || view === 'chakras') {
        return showView('wellness', { ...options, tab: options.tab || view });
      }
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
      if (nextView === 'wellness') {
        window.GaiaWellnessTabs?.activate(options.tab || 'biowell');
      }
      if (options.adminBlocked) {
        const lockedPanel = document.querySelector('[data-admin-locked]');
        lockedPanel?.scrollIntoView?.({ block: 'center' });
      } else {
        const useInstantScroll = isCoarsePointer()
          || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: options.replace || useInstantScroll ? 'auto' : 'smooth' });
      }
      syncAdminUi();
      const routeTab = options.tab || tabForView(nextView, options.tab);
      window.dispatchEvent(new CustomEvent('gaia:route', { detail: { view: nextView, tab: routeTab } }));
      if (nextView === 'wellness' && (options.tab || 'biowell') === 'chakras') {
        requestAnimationFrame(() => requestAnimationFrame(() => refreshChakraMaps()));
      }
      return nextView;
    }

    function navigate(view, options = {}) {
      const nextView = showView(view, options);
      const nextUrl = urlFor(nextView, { tab: tabForView(nextView, options.tab) });
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
      const rawView = file === 'home.html' ? (url.searchParams.get('view') || 'today') : null;
      const routeMap = {
        'home.html': rawView || 'today',
        'biowell.html': 'biowell',
        'academy.html': 'academy',
        'community.html': 'community',
        'profile.html': 'profile',
        'admin.html': 'admin',
      };
      if (!routeMap[file]) return;

      event.preventDefault();
      let view = routeMap[file];
      let tab = url.searchParams.get('tab') || '';
      if (view === 'biowell') {
        view = 'wellness';
        tab = tab || 'biowell';
      } else if (view === 'chakras') {
        view = 'wellness';
        tab = tab || 'chakras';
      }
      navigate(view, { tab });
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

  function initWellnessTabs() {
    const bar = document.getElementById('wellness-tabs');
    if (!bar) return;
    const panels = {
      biowell: 'panel-biowell',
      chakras: 'panel-chakras',
    };
    const badge = document.querySelector('[data-wellness-badge]');
    const buttons = bar.querySelectorAll('[data-tab]');

    function activateButton(btn, updateHistory = false) {
      const tab = btn.getAttribute('data-tab');
      buttons.forEach((b) => {
        const on = b === btn;
        b.classList.toggle('bg-gaia', on);
        b.classList.toggle('text-white', on);
        b.classList.toggle('bg-surface-muted', !on);
        b.classList.toggle('text-ink-secondary', !on);
        b.setAttribute('aria-selected', String(on));
      });
      Object.entries(panels).forEach(([id, panelId]) => {
        const el = document.getElementById(panelId);
        if (!el) return;
        const on = id === tab;
        el.classList.toggle('hidden', !on);
        el.hidden = !on;
      });
      if (badge) {
        badge.textContent = tab === 'chakras' ? '7 pts' : 'Connected';
        badge.classList.toggle('gaia-badge--subtle', tab === 'chakras');
      }
      if (tab === 'chakras') {
        requestAnimationFrame(() => requestAnimationFrame(() => refreshChakraMaps()));
      }
      if (updateHistory && window.GaiaAppShell?.currentView?.() === 'wellness') {
        window.GaiaAppShell.go('wellness', { tab });
      }
    }

    buttons.forEach((btn) => {
      btn.addEventListener('click', () => activateButton(btn, true));
    });

    window.GaiaWellnessTabs = {
      activate(tab = 'biowell') {
        const requestedButton = bar.querySelector(`[data-tab="${tab}"]`) || bar.querySelector('[data-tab="biowell"]');
        if (requestedButton) activateButton(requestedButton, false);
      },
    };
    window.GaiaWellnessTabs.activate(new URLSearchParams(window.location.search).get('tab') || 'biowell');
  }

  function initWellnessPanel() {
    const panel = document.getElementById('panel-biowell');
    if (!panel || panel.dataset.gaiaWellnessWired) return;
    panel.dataset.gaiaWellnessWired = '1';

    const WELLNESS_TRENDS = {
      '7d': {
        labels: ['M', 'T', 'W', 'T', 'F', 'S', 'Today'],
        values: [48, 52, 58, 65, 74, 80, 87],
        avg: 82,
      },
      '30d': {
        labels: ['W1', 'W2', 'W3', 'W4', 'Now'],
        values: [68, 72, 76, 79, 87],
        avg: 76,
      },
    };

    let activeRange = '7d';
    const chartEl = panel.querySelector('[data-wellness-chart]');
    const avgEl = panel.querySelector('[data-wellness-trend-avg]');
    const ringEl = panel.querySelector('[data-wellness-ring]');
    const sourceNote = document.getElementById('wellness-source-note');

    function renderTrendChart(range) {
      const trend = WELLNESS_TRENDS[range];
      if (!chartEl || !trend) return;
      chartEl.innerHTML = trend.labels.map((label, index) => {
        const value = trend.values[index];
        const active = index === trend.labels.length - 1;
        return `<div class="flex flex-1 flex-col items-center">
          <div class="gaia-chart__bar w-full${active ? ' gaia-chart__bar--active' : ''}" style="height:${value}%"></div>
          <span class="gaia-chart__label${active ? ' font-semibold text-gaia-dark' : ''}">${label}</span>
        </div>`;
      }).join('');
      if (avgEl) avgEl.textContent = String(trend.avg);
    }

    function updateEnergyRing(score) {
      if (!ringEl) return;
      const circumference = 2 * Math.PI * 42;
      const offset = circumference - (Math.max(0, Math.min(100, score)) / 100) * circumference;
      ringEl.style.strokeDasharray = `${circumference}`;
      ringEl.style.strokeDashoffset = `${offset}`;
    }

    function refreshWellness() {
      const gaia = window.GAIA || {};
      const wellness = gaia.wellness || {};
      const academy = gaia.academy || {};
      const requirements = academy.requirements || {};
      const responses = gaia.assistant?.responses || {};
      const authenticated = Boolean(gaia.sync?.authenticated || gaia.sync?.memberResolved);
      const live = Boolean(wellness.liveData);

      const energyIndex = wellness.energyIndex ?? 87;
      const delta = wellness.deltaVsAvg ?? 5;
      const avg7 = wellness.avg7Day ?? 82;

      const energyEl = panel.querySelector('[data-wellness-energy-index]');
      const heroCopy = panel.querySelector('[data-wellness-hero-copy]');
      const insight = panel.querySelector('[data-wellness-insight]');
      const practicum = panel.querySelector('[data-wellness-practicum]');
      const practicumProgress = panel.querySelector('[data-wellness-practicum-progress]');
      const stressEl = panel.querySelector('[data-wellness-stress]');
      const vitalityEl = panel.querySelector('[data-wellness-vitality]');
      const coherenceEl = panel.querySelector('[data-wellness-coherence]');
      const badge = document.querySelector('[data-wellness-badge]');

      if (energyEl) energyEl.textContent = String(energyIndex);
      updateEnergyRing(energyIndex);
      if (heroCopy) {
        heroCopy.innerHTML = `Optimal for sessions · <span class="font-semibold text-gaia-dark">+${delta}</span> vs 7-day avg (${avg7})`;
      }
      if (stressEl && wellness.stress) stressEl.textContent = wellness.stress;
      if (vitalityEl && wellness.vitality) vitalityEl.textContent = wellness.vitality;
      if (coherenceEl && wellness.coherence != null) coherenceEl.textContent = `${wellness.coherence}%`;
      if (insight && responses.scan) insight.textContent = responses.scan;

      const scansDone = Number(requirements.scansCompleted ?? wellness.scansCompleted ?? 14);
      const scansReq = Number(requirements.scansRequired ?? wellness.scansRequired ?? 20);
      if (practicum && scansReq > 0) {
        practicum.innerHTML = `${scansDone} of ${scansReq} scans toward <strong class="text-ink">Advanced Level 1</strong>`;
      }
      if (practicumProgress && scansReq > 0) {
        practicumProgress.style.width = `${Math.round((scansDone / scansReq) * 100)}%`;
      }

      if (badge) {
        badge.textContent = live ? 'Live sync' : (authenticated ? 'Member · demo scans' : 'Demo data');
        badge.classList.toggle('gaia-badge--live', live);
        badge.classList.toggle('gaia-badge--subtle', !live);
      }

      if (sourceNote) {
        sourceNote.hidden = false;
        if (live) {
          sourceNote.textContent = 'Bio-Well scan readings synced from your device account.';
        } else if (authenticated) {
          sourceNote.textContent = 'Energy trends use sample readings. GHL tracks your courses and practicum scans — not live Bio-Well charts yet.';
        } else {
          sourceNote.textContent = 'Sample wellness data shown. Log in for your practicum progress from Academy; live Bio-Well charts need device sync.';
        }
      }

      renderTrendChart(activeRange);
    }

    panel.querySelectorAll('[data-wellness-range]').forEach((button) => {
      button.addEventListener('click', () => {
        activeRange = button.dataset.wellnessRange || '7d';
        panel.querySelectorAll('[data-wellness-range]').forEach((item) => {
          const on = item === button;
          item.classList.toggle('gaia-segment__item--active', on);
          item.setAttribute('aria-selected', String(on));
        });
        renderTrendChart(activeRange);
      });
    });

    panel.querySelector('[data-wellness-new-scan]')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('gaia:open-assist', {
        detail: {
          prompt: 'Guide me through documenting a new Bio-Well scan for my practicum: prep, capture, and what to log for Advanced Level 1.',
          speak: true,
        },
      }));
    });

    panel.querySelectorAll('[data-wellness-tech]').forEach((button) => {
      button.addEventListener('click', () => {
        const tech = button.dataset.wellnessTech;
        if (tech === 'biowell') {
          panel.querySelector('[data-wellness-new-scan]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        if (tech === 'biopulsar') {
          window.GaiaAppShell?.go('wellness', { tab: 'chakras' });
          return;
        }
        window.dispatchEvent(new CustomEvent('gaia:open-assist', {
          detail: {
            prompt: 'Explain how BioTekna ANS mapping fits into my Gaia practitioner workflow.',
          },
        }));
      });
    });

    document.addEventListener('gaia:sync', refreshWellness);
    window.addEventListener('gaia:route', (event) => {
      if (event.detail?.view === 'wellness') refreshWellness();
    });

    refreshWellness();
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
      products: 'panel-products',
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
    indicator.innerHTML = '<span aria-hidden="true"></span><strong>Proxy connected</strong>';

    function placeIndicator() {
      const view = window.GaiaAppShell?.currentView?.()
        || new URLSearchParams(window.location.search).get('view')
        || 'today';
      const hero = document.querySelector('.gaia-screen[data-screen="today"] .gaia-dash-hero');
      const headerActions = document.querySelector('.gaia-screen.is-active [data-gaia-header-actions]');

      indicator.classList.remove('gaia-live-sync--hero', 'gaia-live-sync--header');

      if (view === 'today' && hero) {
        hero.appendChild(indicator);
        indicator.classList.add('gaia-live-sync--hero');
        return;
      }

      if (headerActions) {
        headerActions.insertBefore(indicator, headerActions.firstChild);
        indicator.classList.add('gaia-live-sync--header');
        return;
      }

      document.body.appendChild(indicator);
    }

    function refresh() {
      const status = window.GAIA_SYNC?.status;
      const connected = status === 'live' || status === 'connected';
      indicator.hidden = !connected;
      indicator.classList.toggle('gaia-live-sync--live', status === 'live');
      const label = status === 'live' ? 'Live sync' : 'Proxy';
      const text = indicator.querySelector('strong');
      if (text) text.textContent = label;
      if (connected) placeIndicator();
    }

    refresh();
    document.addEventListener('gaia:sync', refresh);
    document.addEventListener('gaia:sync-error', refresh);
    window.addEventListener('gaia:route', () => {
      refresh();
    });
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
      <button type="button" class="gaia-assist__backdrop" hidden aria-label="Close Gaia Assist"></button>
      <div class="gaia-assist__panel" role="dialog" aria-label="${assistant.name || 'Gaia Assist'}" hidden>
        <div class="gaia-assist__sheet">
          <div class="gaia-assist__handle" aria-hidden="true"></div>
          <details class="gaia-assist__settings">
            <summary aria-label="Voice settings">⚙</summary>
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
          <button type="button" class="gaia-assist__close" aria-label="Close Gaia Assist">×</button>
          <div class="gaia-assist__aura">
            <button type="button" class="gaia-assist__orb-visual" data-gaia-orb-tap aria-label="Start voice conversation with Gaia">
              <span class="gaia-assist__orb-ring gaia-assist__orb-ring--1" aria-hidden="true"></span>
              <span class="gaia-assist__orb-ring gaia-assist__orb-ring--2" aria-hidden="true"></span>
              <img class="gaia-assist__orb-icon" src="assets/gaia-logo.png" alt="Gaia" />
            </button>
            <div class="gaia-assist__wave" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span>
            </div>
          </div>
          <div class="gaia-assist__headline">
            <h2>${assistant.name || 'Gaia'}</h2>
            <p class="gaia-assist__status" data-assist-state="idle">Tap Gaia for live voice</p>
          </div>
          <div class="gaia-assist__transcript"></div>
          <div class="gaia-assist__chips"></div>
          <form class="gaia-assist__form">
            <label class="gaia-assist__label" for="gaia-assist-prompt">Ask Gaia</label>
            <div class="gaia-assist__input-row">
              <input id="gaia-assist-prompt" name="prompt" type="text" autocomplete="off" placeholder="Ask about my scan, badge, or course…" />
              <button type="submit" aria-label="Send">↑</button>
            </div>
          </form>
          <div class="gaia-assist__toolbar">
            <p class="gaia-assist__hint-line">Speak naturally · tap Gaia again to close</p>
          </div>
          <p class="gaia-assist__error" role="alert" hidden></p>
          <div class="gaia-assist__voice gaia-assist__voice--fallback" hidden aria-hidden="true">
            <audio class="gaia-assist__audio" playsinline webkit-playsinline preload="auto"></audio>
            <button type="button" class="gaia-assist__mic" aria-label="Start voice prompt"></button>
            <button type="button" class="gaia-assist__mute" aria-pressed="false">Mute</button>
            <button type="button" class="gaia-assist__stop">Stop</button>
            <button type="button" class="gaia-assist__play" hidden>Hear Gaia</button>
            <span class="gaia-assist__provider">Voice: browser</span>
          </div>
        </div>
      </div>`;

    document.body.appendChild(root);

    const backdrop = root.querySelector('.gaia-assist__backdrop');
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
    let realtimeWelcomeSent = false;
    let passiveWelcomeShown = false;
    let autoGeminiStarted = false;
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
        audio.setAttribute('playsinline', '');
        audio.setAttribute('webkit-playsinline', 'true');
        await audio.play();
        audio.pause();
        audio.currentTime = 0;
        audio.volume = 1;
        audio.src = previousSrc || '';
        markVoiceUnlocked();
        if (realtimeVoice?.resumePlayback) {
          await realtimeVoice.resumePlayback();
        }
        assistLog('voice unlocked', { userAgent, forced: force });
        return true;
      } catch (err) {
        assistLog('voice unlock pending', { error: err.message });
        return false;
      }
    }

    async function ensureMobileVoiceReady() {
      await unlockVoicePlayback(true);
      if (realtimeVoice?.resumePlayback) {
        await realtimeVoice.resumePlayback();
      }
    }

    const suggestionMap = [
      { label: 'Elevate badge', reply: assistant.responses?.event, intent: 'event' },
      { label: 'Bio-Well scan', reply: assistant.responses?.scan, intent: 'devices' },
      { label: 'Academy next step', reply: assistant.responses?.academy, intent: 'academy' },
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

    function currentAssistView() {
      return window.GaiaAppShell?.currentView?.()
        || new URLSearchParams(window.location.search).get('view')
        || 'today';
    }

    function passiveWelcomeText() {
      const embedded = isGhlEmbeddedMode();
      return embedded
        ? 'Welcome to the Gaia Healers app inside GHL. Tap Gaia once and I can guide courses, community, events, Bio-Well, devices, and member support without sending you to another portal.'
        : 'Welcome to Gaia Healers. Tap Gaia once for live voice, or ask about Bio-Well, Academy, communities, events, devices, or your member profile.';
    }

    function liveWelcomePrompt() {
      const view = currentAssistView();
      const embedded = isGhlEmbeddedMode()
        ? 'You are inside the Gaia Healers GHL custom menu.'
        : 'The app is running from GitHub Pages with the staging proxy.';
      return `Start the live app session now. Speak directly to the member only, without mentioning instructions, planning, or drafting. Say this welcome in your own natural voice: ${welcomeTranscriptText()}. ${embedded}`;
    }

    function welcomeTranscriptText() {
      return `Hello, I'm Gaia Assist, live inside the app. You're on the ${currentAssistView()} screen. I can help with Bio-Well scans, chakra body points, Academy courses, community, events, devices, memberships, and GHL follow-up drafts. What would you like to handle first?`;
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
      const started = performance.now();
      const audioBase64 = await blobToBase64(blob);
      const response = await fetch(`${base}/api/assist/transcribe`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ audioBase64, mimeType: blob.type || 'audio/webm' }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `Transcription returned ${response.status}`);
      }
      assistLog('transcription received', {
        provider: payload.provider || 'unknown',
        model: payload.model || 'unknown',
        latencyMs: Math.round(performance.now() - started),
      });
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
      if (!voiceProvider) return;
      voiceProvider.textContent = `Voice: ${provider}${name ? ` · ${name}` : ''}`;
      voiceProvider.dataset.provider = provider;
    }

    function setRealtimeVoiceProvider() {
      const live = realtimeConfig();
      setVoiceProvider('gemini live', live.voice || 'Puck');
    }

    function clearPendingVoice(revoke = true) {
      if (revoke && pendingVoice?.url) URL.revokeObjectURL(pendingVoice.url);
      pendingVoice = null;
      if (!playButton) return;
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
      if (muteButton) {
        muteButton.textContent = muted ? 'Unmute' : 'Mute';
        muteButton.setAttribute('aria-pressed', String(muted));
      }
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
          credentials: 'include',
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
      initRealtimeVoice();
      if (canUseRealtimeVoice()) {
        setRealtimeVoiceProvider();
      }
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
      if (!canUseRealtimeVoice()) {
        setVoiceProvider(provider === 'browser' ? 'browser' : provider, provider === 'auto' ? 'auto' : label);
      }
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
      await unlockVoicePlayback(true);
      const audio = getSharedAudio();
      audio.muted = false;
      audio.volume = 1;
      audio.src = audioUrl;
      audio.load();
      let playbackStarted = false;
      const onPlay = () => {
        playbackStarted = true;
        clearPendingVoice(false);
        if (playButton) {
          playButton.hidden = true;
          playButton.classList.remove('is-pending');
        }
        setVoiceHint('');
        setVoiceProvider(provider, voice);
        status.textContent = 'Speaking…';
        assistLog('speech started', { provider, voice, speed: selectedSpeed() });
      };
      audio.onplay = onPlay;
      audio.onended = () => {
        if (!isMobileWebKit) URL.revokeObjectURL(audioUrl);
        setAssistVoiceState('idle', REALTIME_STATUS_COPY.idle);
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
      if (playButton) {
        playButton.hidden = false;
        playButton.classList.add('is-pending');
        playButton.textContent = 'Hear Gaia';
      }
      setVoiceProvider(provider, voice || 'ready');
      status.textContent = 'Voice ready — tap Hear Gaia';
      setVoiceHint('Tap Hear Gaia if playback is blocked.');
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
      if (clean.length <= 360) return clean;
      const sentenceCut = clean.slice(0, 360).match(/^(.+[.!?])\s+/);
      return `${(sentenceCut?.[1] || clean.slice(0, 320)).trim()} I can keep the full answer on screen.`;
    }

    async function speakReply(text, options = {}) {
      const cleanText = String(text || '').trim();
      if (!cleanText || muted) return;
      const voiceText = speechPreviewText(cleanText);
      const fromVoice = options.fromVoice === true;
      stopSpeaking();
      await unlockVoicePlayback(isMobileWebKit || fromVoice);
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
        const ttsStarted = performance.now();
        activeTtsController?.abort();
        activeTtsController = new AbortController();
        const response = await fetch(`${base}/api/assist/tts`, {
          method: 'POST',
          headers: {
            Accept: 'audio/mpeg,application/json',
            'Content-Type': 'application/json',
          },
          credentials: 'include',
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
        assistLog('TTS audio received', {
          provider: response.headers.get('X-Gaia-Voice-Provider') || providerSetting,
          bytes: blob.size,
          latencyMs: Math.round(performance.now() - ttsStarted),
        });
        const audioUrl = URL.createObjectURL(blob);
        const provider = response.headers.get('X-Gaia-Voice-Provider') || (providerSetting === 'auto' ? 'hosted' : providerSetting);
        const voice = response.headers.get('X-Gaia-Voice-Name') || '';
        try {
          await playAudioElement(audioUrl, provider, voice);
        } catch (playError) {
          assistError('speech error', { provider, error: playError.message || 'autoplay blocked' });
          if (playButton) playButton.hidden = false;
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
        if (!pendingVoice && audio.paused && !activeWebAudio) setAssistVoiceState('idle', REALTIME_STATUS_COPY.idle);
      }
    }

    function dockButtons() {
      return document.querySelectorAll('[data-gaia-tab-assist]');
    }

    function setOpen(open, options = {}) {
      if (open && !options.passive) {
        void ensureMobileVoiceReady();
      }
      if (backdrop) backdrop.hidden = !open;
      panel.hidden = !open;
      root.classList.toggle('gaia-assist--open', open);
      document.body.classList.toggle('gaia-assist-panel-open', open);
      dockButtons().forEach((button) => {
        button.setAttribute('aria-expanded', String(open));
        button.classList.toggle('is-active', open);
      });
      if (open) {
        const voiceStatus = realtimeVoice?.status || 'idle';
        if (voiceStatus === 'idle' || voiceStatus === 'error') {
          setAssistVoiceState(voiceStatus, REALTIME_STATUS_COPY[voiceStatus] || REALTIME_STATUS_COPY.idle);
        }
      }
    }

    const REALTIME_STATUS_COPY = {
      idle: isCoarsePointer() ? 'Tap Gaia above to begin' : 'Tap Gaia to start Gemini Live',
      ready: 'Listening… speak naturally',
      connecting: 'Connecting…',
      holding: 'Listening…',
      listening: 'Listening… speak naturally',
      thinking: 'Gaia is thinking…',
      speaking: 'Gaia is speaking…',
      error: 'Voice unavailable — type your question',
    };

    function showPassiveWelcome() {
      if (passiveWelcomeShown || sessionStorage.getItem(ASSIST_WELCOME_KEY) === '1') return;
      if (!document.body.classList.contains('gaia-v2')) return;
      passiveWelcomeShown = true;
      sessionStorage.setItem(ASSIST_WELCOME_KEY, '1');
      // Always open the panel so the assistant greets first — on touch devices
      // the orb shows a "tap to begin" state (iOS blocks auto-audio until gesture).
      setOpen(true, { passive: true });
      if (!canUseRealtimeVoice() && !transcript.querySelector('[data-gaia-welcome-bubble]')) {
        const welcomeText = passiveWelcomeText();
        const bubble = appendMessage('bot', welcomeText);
        bubble.dataset.gaiaWelcomeBubble = '1';
      }
      const onMobile = isCoarsePointer();
      const idleCopy = onMobile
        ? (canUseRealtimeVoice() ? 'Tap Gaia to begin' : 'Tap Gaia to start')
        : (canUseRealtimeVoice() ? 'Starting Gemini Live…' : 'Tap Gaia to start Gemini Live');
      setAssistVoiceState('idle', idleCopy);
      if (canUseRealtimeVoice()) {
        setRealtimeVoiceProvider();
        // Pre-warm: fetch the Gemini token + init the audio worklet NOW, before
        // the user taps the orb. When they do tap, start() skips the token
        // round-trip and audio setup, going straight to the WebSocket connect.
        initRealtimeVoice();
        realtimeVoice?.prewarm?.();
      }
    }

    function sendRealtimeWelcome(reason = 'start') {
      if (!realtimeVoice || realtimeWelcomeSent) return false;
      realtimeWelcomeSent = true;
      const prompt = liveWelcomePrompt();
      const sent = realtimeVoice.sendText(prompt, { silent: true });
      if (!sent) realtimeWelcomeSent = false;
      else assistLog('realtime welcome sent', { reason, view: currentAssistView(), embedded: isGhlEmbeddedMode() });
      return sent;
    }

    function shouldAutoStartGemini() {
      const params = new URLSearchParams(window.location.search);
      if (params.has('no_autostart') || params.has('no_welcome')) return false;
      if (isCoarsePointer()) return false;
      return true;
    }

    async function autoStartGeminiWelcome(reason = 'auto') {
      if (!shouldAutoStartGemini() || autoGeminiStarted || realtimeWelcomeSent) return;
      initRealtimeVoice();
      if (!realtimeVoice) return;
      autoGeminiStarted = true;
      setOpen(true, { passive: true });
      setError('');
      setRealtimeVoiceProvider();
      setAssistVoiceState('connecting', 'Starting Gemini Live…');
      try {
        await realtimeVoice.start();
        sendRealtimeWelcome(reason);
      } catch (err) {
        autoGeminiStarted = false;
        assistError('gemini live autostart failed', err);
        setError('Tap Gaia once to start Gemini Live. Some iPhone browsers block automatic microphone/audio until the first tap.');
        setAssistVoiceState('idle', 'Tap Gaia to start Gemini Live');
      }
    }

    let assistSessionBusy = false;

    function canCloseAssistSession() {
      if (!realtimeVoice?.isActive()) return !panel.hidden;
      const voiceStatus = realtimeVoice.status;
      return voiceStatus === 'listening'
        || voiceStatus === 'ready'
        || voiceStatus === 'speaking'
        || voiceStatus === 'thinking';
    }

    async function onAssistTap() {
      if (assistSessionBusy) return;

      initRealtimeVoice();
      if (canUseRealtimeVoice()) setRealtimeVoiceProvider();

      if (!realtimeVoice) {
        if (panel.hidden) {
          assistSessionBusy = true;
          setOpen(true);
          setError('');
          setAssistVoiceState('connecting', 'Opening Gaia Assist…');
          await ensureMobileVoiceReady();
          try {
            await startVoicePrompt();
          } finally {
            assistSessionBusy = false;
          }
        } else {
          setOpen(false);
        }
        return;
      }

      if (!panel.hidden && canCloseAssistSession()) {
        realtimeVoice.stop();
        setOpen(false);
        setAssistVoiceState('idle', REALTIME_STATUS_COPY.idle);
        return;
      }

      if (!panel.hidden && realtimeVoice.status === 'connecting') {
        return;
      }

      assistSessionBusy = true;
      const wasClosed = panel.hidden;
      setOpen(true);
      setAssistVoiceState('connecting', REALTIME_STATUS_COPY.connecting);
      setError('');
      await ensureMobileVoiceReady();

      try {
        if (!realtimeVoice.isActive()) {
          await realtimeVoice.start();
          sendRealtimeWelcome(wasClosed ? 'first-open' : 'resume');
        } else if (realtimeVoice.status !== 'connecting') {
          sendRealtimeWelcome('resume');
        }
      } catch (err) {
        assistError('assist start failed', err);
        setError('Voice is unavailable right now. You can still type your question below.');
        setAssistVoiceState('idle', 'Type your question below');
      } finally {
        assistSessionBusy = false;
      }
    }

    function bindAssistDock() {
      if (root.dataset.gaiaAssistDockBound) return;
      root.dataset.gaiaAssistDockBound = '1';

      const handleAssistTap = (event) => {
        const button = event.target.closest('[data-gaia-tab-assist]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        void onAssistTap();
      };

      document.addEventListener('pointerup', handleAssistTap, { capture: true, passive: false });
      document.addEventListener('click', (event) => {
        if (!event.target.closest('[data-gaia-tab-assist]')) return;
        event.preventDefault();
        event.stopPropagation();
      }, { capture: true });
    }

    function wireGaiaDock() {
      syncDockVoiceState();
    }

    function syncDockVoiceState() {
      const nextStatus = realtimeVoice?.status || 'idle';
      setAssistVoiceState(nextStatus, REALTIME_STATUS_COPY[nextStatus] || REALTIME_STATUS_COPY.idle);
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
      root.classList.toggle('gaia-assist--connecting', state === 'connecting');
      root.classList.toggle('gaia-assist--holding', state === 'holding');
      root.classList.toggle('gaia-assist--ready', state === 'ready');
      document.body.classList.toggle('gaia-voice-holding', state === 'holding');
      document.body.classList.toggle('gaia-voice-speaking', state === 'speaking');
      document.body.classList.toggle('gaia-voice-thinking', state === 'thinking');
      dockButtons().forEach((button) => {
        button.dataset.state = state;
      });
      if (status) status.dataset.assistState = state;
      if (message && status) status.textContent = message;
    }

    let realtimeVoice = null;
    let realtimeEnabled = false;
    const streamBubbleMap = { user: null, assistant: null };
    const MAX_ASSIST_TURNS = 24;

    function realtimeConfig() {
      return window.GAIA?.sync?.voice?.live
        || window.GAIA?.sync?.voice?.realtime
        || {};
    }

    function canUseRealtimeVoice() {
      return Boolean(window.GaiaRealtimeVoice && realtimeConfig().enabled);
    }

    function trimAssistBubbles() {
      const turnBubbles = [...transcript.querySelectorAll('.gaia-assist__bubble[data-turn-id]')];
      const genericBubbles = [...transcript.querySelectorAll(
        '.gaia-assist__bubble:not([data-turn-id]):not([data-gaia-welcome-bubble]):not(.gaia-assist__bubble--live)',
      )];
      const excessTurns = turnBubbles.length - MAX_ASSIST_TURNS;
      if (excessTurns > 0) {
        for (let i = 0; i < excessTurns; i += 1) turnBubbles[i].remove();
      }
      const excessGeneric = genericBubbles.length - MAX_ASSIST_TURNS;
      if (excessGeneric > 0) {
        for (let i = 0; i < excessGeneric; i += 1) genericBubbles[i].remove();
      }
    }

    function renderAssistMessageList(messages, options = {}) {
      clearLiveTranscript();
      streamBubbleMap.user = null;
      streamBubbleMap.assistant = null;

      const existing = new Map();
      transcript.querySelectorAll('.gaia-assist__bubble[data-turn-id]').forEach((node) => {
        existing.set(node.dataset.turnId, node);
      });

      const activeIds = new Set();
      for (let index = 0; index < messages.length; index += 1) {
        const item = messages[index];
        const rawText = String(item?.text || '').trim();
        if (!item?.id || !rawText) continue;
        const role = item.role === 'user' ? 'user' : 'assistant';
        const isLast = index === messages.length - 1;
        const stillStreaming = isLast
          && !options.finalize
          && options.streamingRole === item.role;
        const clean = role === 'user'
          ? rawText
          : sanitizeRealtimeTranscript('assistant', rawText, !stillStreaming);
        if (!clean) continue;

        activeIds.add(item.id);
        const kind = role === 'user' ? 'user' : 'bot';
        let bubble = existing.get(item.id);
        if (!bubble) {
          bubble = document.createElement('p');
          bubble.className = `gaia-assist__bubble gaia-assist__bubble--${kind}`;
          bubble.dataset.turnId = item.id;
          transcript.appendChild(bubble);
          existing.set(item.id, bubble);
        } else {
          bubble.className = `gaia-assist__bubble gaia-assist__bubble--${kind}`;
        }
        bubble.textContent = clean;
      }

      existing.forEach((node, id) => {
        if (!activeIds.has(id)) node.remove();
      });

      trimAssistBubbles();
      transcript.scrollTop = transcript.scrollHeight;
    }

    function syncRealtimeBubble(role, text, finalize) {
      const kind = role === 'user' ? 'user' : 'bot';
      if (streamBubbleMap[role] && !finalize) {
        const current = streamBubbleMap[role].textContent || '';
        updateBubble(streamBubbleMap[role], normalizeRealtimeBubbleText(role, joinRealtimeText(current, text)));
        return;
      }
      if (streamBubbleMap[role] && finalize) {
        updateBubble(streamBubbleMap[role], normalizeRealtimeBubbleText(role, text));
        streamBubbleMap[role] = null;
        return;
      }
      streamBubbleMap[role] = appendMessage(kind, normalizeRealtimeBubbleText(role, text));
      if (finalize) streamBubbleMap[role] = null;
    }

    function joinRealtimeText(previous, next) {
      const left = String(previous || '');
      const right = String(next || '');
      if (!left) return right;
      if (!right) return left;
      if (/[\s"'([{/<-]$/.test(left) || /^[\s.,!?;:)'"\]}]/.test(right)) return `${left}${right}`;
      return `${left} ${right}`;
    }

    function normalizeRealtimeBubbleText(role, text) {
      const clean = String(text || '').trim();
      if (role !== 'assistant' || !clean) return clean;
      const alphaCompact = clean.replace(/[^a-z0-9]+/gi, '').toLowerCase();
      if (alphaCompact.includes('gaiaassist') && alphaCompact.includes('biowell') && alphaCompact.includes('whatwould')) {
        return welcomeTranscriptText();
      }
      return clean;
    }

    function initRealtimeVoice() {
      if (!canUseRealtimeVoice() || realtimeVoice) return;
      realtimeEnabled = true;
      realtimeVoice = window.GaiaRealtimeVoice.create();
      realtimeVoice.on('status', (nextStatus) => {
        setRealtimeVoiceProvider();
        setAssistVoiceState(nextStatus, REALTIME_STATUS_COPY[nextStatus] || REALTIME_STATUS_COPY.idle);
        if (nextStatus === 'speaking') {
          void realtimeVoice.resumePlayback();
        }
        if ((nextStatus === 'listening' || nextStatus === 'ready') && !realtimeWelcomeSent && !panel.hidden) {
          window.setTimeout(() => sendRealtimeWelcome('status-ready'), 120);
        }
      });
      realtimeVoice.on('message', ({ role, text, finalize, messages }) => {
        if (Array.isArray(messages) && messages.length) {
          renderAssistMessageList(messages, { streamingRole: role, finalize });
          return;
        }
        const cleanText = sanitizeRealtimeTranscript(role, text, finalize);
        if (!cleanText) return;
        if (role === 'user') syncRealtimeBubble('user', cleanText, finalize);
        else syncRealtimeBubble('assistant', cleanText, finalize);
      });
      realtimeVoice.on('error', (message) => {
        if (message) {
          setError(message);
          setOpen(true);
        }
      });
      assistLog('realtime voice ready');
    }

    function sanitizeRealtimeTranscript(role, text, finalize) {
      let clean = String(text || '').trim();
      if (!clean) return '';
      if (role !== 'assistant') return clean;
      const alphaCompact = clean.replace(/[^a-z0-9]+/gi, '').toLowerCase();

      if (/^\*\*(?:initiating|commencing|formulating|acknowledge|delivering|crafting|creating|finalizing|refining|thinking|analyzing)/i.test(clean)) {
        return '';
      }
      if (/^(?:I(?:'| a)m|I have|I've)\s+(?:starting|started|crafted|created|structured|introducing|noted|ready|now)|^The goal is/i.test(clean)) {
        return '';
      }
      if (alphaCompact.includes('gaiaassist') && alphaCompact.includes('biowell') && alphaCompact.includes('whatwould')) {
        return welcomeTranscriptText();
      }

      clean = clean
        .replace(/^\*\*(?:initiating|commencing|formulating|acknowledge|delivering|crafting|creating|finalizing|refining|thinking|analyzing)[^*]{0,100}\*\*\s*/i, '')
        .replace(/^I must (?:say|acknowledge)[\s\S]*?(?=Welcome to Gaia Healers\.|$)/i, '')
        .replace(/^The user wants me[\s\S]*?(?=Welcome to Gaia Healers\.|$)/i, '')
        .replace(/^\*\*(?:delivering|crafting|creating|finalizing|refining|thinking|analyzing)[^*]{0,90}\*\*\s*/i, '')
        .replace(/^(?:initiating|commencing|formulating|acknowledging|acknowledge|delivering|crafting|creating|finalizing|refining|thinking|analyzing)(?: the)?(?: live session| initial greeting| app introduction| instructions| request| welcome| response)?[:.\-\s]+/i, '')
        .trim();

      const welcomeIndex = clean.indexOf('Welcome to Gaia Healers.');
      if (welcomeIndex > 0 && /deliver|craft|request|analysis|finaliz|refin/i.test(clean.slice(0, welcomeIndex))) {
        clean = clean.slice(welcomeIndex).trim();
      }
      if (/^(?:I must|The user wants me|provided text|strict instructions)/i.test(clean)) return '';

      if (finalize) {
        clean = clean
          .replace(/\s*Context:\s*(?:You are inside|The app is running)[\s\S]*$/i, '')
          .trim();
      }
      return clean;
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
        setAssistVoiceState('idle', REALTIME_STATUS_COPY.idle);
      }
    }

    function appendMessage(kind, text) {
      const bubble = document.createElement('p');
      bubble.className = `gaia-assist__bubble gaia-assist__bubble--${kind}`;
      bubble.innerHTML = escapeHtml(text);
      transcript.appendChild(bubble);
      trimAssistBubbles();
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
      const started = performance.now();
      let firstDeltaLogged = false;

      const response = await fetch(`${base}/api/assist/chat/stream`, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        credentials: 'include',
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
          if (!firstDeltaLogged) {
            firstDeltaLogged = true;
            assistLog('first streamed token received', { latencyMs: Math.round(performance.now() - started) });
          }
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
          credentials: 'include',
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
          const speechThreshold = isIOS ? 0.006 : 0.018;
          const silenceMs = isIOS ? 850 : 1100;

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
          }, isIOS ? 6500 : 12000);
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
          }, isIOS ? 6500 : 6500);
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
          setAssistVoiceState('idle', REALTIME_STATUS_COPY.idle);
          setError('I could not hear enough audio. Hold the phone close, tap mic again, or use the iPhone keyboard microphone in the text box.');
          return;
        }

        setAssistVoiceState('thinking', 'Transcribing…');
        const transcript = await transcribeAudioBlob(blob);
        if (!transcript) {
          setAssistVoiceState('idle', REALTIME_STATUS_COPY.idle);
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
        setAssistVoiceState('idle', REALTIME_STATUS_COPY.idle);
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

    bindAssistDock();
    window.addEventListener('gaia:open-assist', (event) => {
      unlockVoicePlayback();
      setOpen(true);
      if (event.detail?.welcome) {
        if (realtimeVoice?.isActive()) sendRealtimeWelcome('event');
        return;
      }
      if (event.detail?.prompt) {
        if (event.detail.speak) {
          sendPrompt(event.detail.prompt, 'chakra', 'quick-action');
          return;
        }
        promptInput.value = event.detail.prompt;
        promptInput.focus();
      }
    });
    close.addEventListener('click', () => {
      if (realtimeVoice?.isActive()) realtimeVoice.stop();
      setOpen(false);
      setAssistVoiceState('idle', REALTIME_STATUS_COPY.idle);
    });
    backdrop?.addEventListener('click', () => {
      if (realtimeVoice?.isActive()) realtimeVoice.stop();
      setOpen(false);
      setAssistVoiceState('idle', REALTIME_STATUS_COPY.idle);
    });
    // The big orb inside the panel is the primary tap target on mobile —
    // it doubles as the iOS audio-unlock gesture and starts Gemini Live.
    root.querySelector('[data-gaia-orb-tap]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      onAssistTap();
    });
    if (mic) {
      mic.addEventListener('click', async () => {
        await unlockVoicePlayback(true);
        await startVoicePrompt();
      });
    }
    if (muteButton) muteButton.addEventListener('click', () => {
      if (realtimeVoice?.isActive()) {
        const nextMuted = realtimeVoice.toggleMute();
        setMuted(nextMuted);
        return;
      }
      setMuted(!muted);
    });
    if (stopButton) stopButton.addEventListener('click', () => {
      if (realtimeVoice?.isActive()) {
        realtimeVoice.stop();
        setAssistVoiceState('idle', REALTIME_STATUS_COPY.idle);
        return;
      }
      stopSpeaking();
    });
    if (playButton) playButton.addEventListener('click', async () => {
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
    document.addEventListener('gaia:sync', () => {
      if (passiveWelcomeShown) window.setTimeout(() => autoStartGeminiWelcome('sync'), 120);
    });
    voiceSpeed.addEventListener('input', () => {
      localStorage.setItem(VOICE_SPEED_KEY, voiceSpeed.value);
      voiceSpeedLabel.textContent = `${Number(voiceSpeed.value).toFixed(2)}x`;
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      unlockVoicePlayback();
      const prompt = promptInput.value;
      promptInput.value = '';
      if (realtimeVoice?.isActive()) {
        if (!realtimeVoice.sendText(prompt)) {
          setError('Voice session is still connecting. Try again in a moment.');
        }
        return;
      }
      sendPrompt(prompt, 'typed', 'text');
    });
    chips.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        unlockVoicePlayback();
        const item = suggestionMap.find((entry) => entry.intent === button.dataset.intent) || suggestionMap[0];
        if (realtimeVoice?.isActive()) {
          setOpen(true);
          realtimeVoice.sendText(item.label);
          return;
        }
        sendPrompt(item.label, item.intent, 'quick-action');
      });
    });

    document.querySelectorAll('[data-gaia-open-assist]').forEach((button) => {
      button.addEventListener('click', () => {
        void onAssistTap();
      });
    });
    bindAssistDock();
    wireGaiaDock();
    window.addEventListener('gaia:tabbar-ready', wireGaiaDock);
    window.addEventListener('gaia:route', wireGaiaDock);
    setMuted(muted);
    initVoiceSettings();
    setVoiceProvider(selectedProvider() === 'auto' ? 'auto' : selectedProvider());
    if (!new URLSearchParams(window.location.search).has('no_welcome')) {
      window.setTimeout(() => {
        showPassiveWelcome();
        window.setTimeout(() => autoStartGeminiWelcome('entry'), 180);
      }, isGhlEmbeddedMode() ? 650 : 950);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('a[data-gaia-portal-launch], button[data-gaia-portal-launch]');
      if (!trigger) return;
      event.preventDefault();
      openPortalWorkspace(trigger.dataset.gaiaPortalSection || 'home', trigger.getAttribute('href') || '');
    });
    initTheme();
    initMemberAuth();
    initHeaderProfile();
    initCoachMark();
    initSplashSteps();
    initChakraMaps();
    initWellnessTabs();
    initWellnessPanel();
    initCommunityTabs();
    initAcademyProgress();
    initMemberHub();
    initAppShellNavigation();
    initCommunityHub();
    initLiveSyncIndicator();
    ensurePortalWorkspace();
    wirePortalWorkspaceLinks(document);
    initGhlEmbeddedMode();
    initGaiaAssist();
  });
})();
