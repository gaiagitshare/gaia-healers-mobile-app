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
  const APP_VIEWS = new Set(['today', 'biowell', 'academy', 'community', 'profile', 'admin']);

  function initTheme() {
    if (!document.body.classList.contains('gaia-page') && !document.body.classList.contains('gaia-app')) return;
    const saved = localStorage.getItem(THEME_KEY);
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const initial = saved || (prefersDark ? 'dark' : 'light');

    function apply(theme) {
      document.body.dataset.theme = theme;
      localStorage.setItem(THEME_KEY, theme);
      const button = document.querySelector('.gaia-theme-toggle');
      if (button) {
        button.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
        button.innerHTML = theme === 'dark'
          ? '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m0 13.5V21m9-9h-2.25M5.25 12H3m15.364 6.364-1.591-1.591M7.227 7.227 5.636 5.636m12.728 0-1.591 1.591M7.227 16.773l-1.591 1.591M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/></svg>'
          : '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"/></svg>';
      }
    }

    if (!document.querySelector('.gaia-theme-toggle')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gaia-theme-toggle';
      button.addEventListener('click', () => apply(document.body.dataset.theme === 'dark' ? 'light' : 'dark'));
      document.body.appendChild(button);
    }
    apply(initial);
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
      groups: 'panel-groups',
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
      <button type="button" class="gaia-assist__orb" aria-label="Open Gaia Assist" aria-expanded="false">
        <span class="gaia-assist__pulse"></span>
        <span class="gaia-assist__mark">G</span>
      </button>
      <div class="gaia-assist__panel" role="dialog" aria-label="${assistant.name || 'Gaia Assist'}" hidden>
        <div class="gaia-assist__handle"></div>
        <div class="gaia-assist__top">
          <div class="min-w-0">
            <p class="gaia-eyebrow">Smart Gaia concierge</p>
            <h2>${assistant.name || 'Gaia Assist'}</h2>
            <p class="gaia-assist__mini">GHL, courses, devices, events, scans</p>
          </div>
          <button type="button" class="gaia-assist__close" aria-label="Close Gaia Assist">Close</button>
        </div>
        <div class="gaia-assist__voice" data-assist-state="idle">
          <button type="button" class="gaia-assist__mic" aria-label="Start voice prompt">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-12 0v1.5a6 6 0 006 6m0 0v3m-3 0h6M12 15a2.25 2.25 0 002.25-2.25v-6a2.25 2.25 0 00-4.5 0v6A2.25 2.25 0 0012 15z"/></svg>
          </button>
          <div class="gaia-assist__wave" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <p class="gaia-assist__status">Tap to speak</p>
          <div class="gaia-assist__speak-controls">
            <button type="button" class="gaia-assist__mute" aria-pressed="false">Mute</button>
            <button type="button" class="gaia-assist__stop">Stop</button>
            <button type="button" class="gaia-assist__play" hidden>Play voice</button>
            <span class="gaia-assist__provider">Voice: browser</span>
          </div>
        </div>
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
        <div class="gaia-assist__transcript">
          <p class="gaia-assist__bubble gaia-assist__bubble--bot">Ask me about Gaia services, GHL communities, Bio-Well devices, courses, events, badges, or follow-up workflows.</p>
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
        <p class="gaia-assist__promise">${assistant.promise || 'Review before anything is saved.'}</p>
      </div>`;

    document.body.appendChild(root);

    const orb = root.querySelector('.gaia-assist__orb');
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
    const voiceProvider = root.querySelector('.gaia-assist__provider');
    const voiceProviderSelect = root.querySelector('.gaia-assist__voice-provider');
    const voiceNameSelect = root.querySelector('.gaia-assist__voice-name');
    const voiceSpeed = root.querySelector('.gaia-assist__voice-speed');
    const voiceSpeedLabel = root.querySelector('.gaia-assist__speed span');
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;
    let recognizing = false;
    let muted = localStorage.getItem('gaia-assist-muted') === '1';
    let currentAudio = null;
    let pendingVoice = null;
    let browserVoices = [];

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
    }

    function stopSpeaking() {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
      }
      if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) {
        window.speechSynthesis.cancel();
      }
      assistLog('speech ended', { reason: 'stopped' });
      status.textContent = 'Speech stopped';
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

    function refreshBrowserVoices() {
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

    function initVoiceSettings() {
      const savedProvider = localStorage.getItem(VOICE_PROVIDER_KEY);
      voiceProviderSelect.value = savedProvider && savedProvider !== 'browser' ? savedProvider : 'auto';
      localStorage.setItem(VOICE_PROVIDER_KEY, voiceProviderSelect.value);
      voiceSpeed.value = localStorage.getItem(VOICE_SPEED_KEY) || '1';
      voiceSpeedLabel.textContent = `${Number(voiceSpeed.value).toFixed(2)}x`;
      refreshBrowserVoices();
      window.speechSynthesis?.addEventListener?.('voiceschanged', refreshBrowserVoices);
    }

    function selectedBrowserVoice() {
      const selected = voiceNameSelect.value || localStorage.getItem(VOICE_NAME_KEY);
      return browserVoices.find((voice) => voice.name === selected) || bestBrowserVoice();
    }

    function speakWithBrowser(text) {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
        setVoiceProvider('browser');
        setError('This browser cannot speak responses aloud. You can still read the reply.');
        assistError('speech error', { provider: 'browser', error: 'speechSynthesis unavailable' });
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = selectedBrowserVoice();
      if (voice) utterance.voice = voice;
      utterance.lang = 'en-US';
      utterance.rate = selectedSpeed();
      utterance.pitch = 1;
      utterance.onstart = () => {
        setVoiceProvider('browser', voice?.name || 'system');
        status.textContent = 'Speaking...';
        assistLog('speech started', { provider: 'browser', voice: voice?.name || 'system', speed: selectedSpeed() });
      };
      utterance.onend = () => {
        status.textContent = 'Ready for next prompt';
        assistLog('speech ended', { provider: 'browser' });
      };
      utterance.onerror = (event) => {
        setVoiceProvider('browser');
        setError(`Speech failed: ${event.error || 'browser speech error'}`);
        assistError('speech error', { provider: 'browser', error: event.error });
      };
      window.speechSynthesis.speak(utterance);
    }

    async function playAudioElement(audio, provider, voice, audioUrl) {
      currentAudio = audio;
      currentAudio.onplay = () => {
        clearPendingVoice(false);
        setVoiceProvider(provider, voice);
        status.textContent = 'Speaking...';
        assistLog('speech started', { provider, voice, speed: selectedSpeed() });
      };
      currentAudio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        currentAudio = null;
        status.textContent = 'Ready for next prompt';
        assistLog('speech ended', { provider });
      };
      currentAudio.onerror = () => {
        URL.revokeObjectURL(audioUrl);
        currentAudio = null;
        setVoiceProvider('browser');
        assistError('speech error', { provider, error: 'audio playback failed' });
      };
      await currentAudio.play();
    }

    function showManualVoicePlayback(audioUrl, provider, voice) {
      pendingVoice = { url: audioUrl, provider, voice };
      playButton.hidden = false;
      setVoiceProvider(provider, voice || 'ready');
      status.textContent = 'Tap Play voice';
      setError('Mobile browser blocked autoplay. Tap Play voice once to hear Gaia.');
    }

    async function speakReply(text) {
      const cleanText = String(text || '').trim();
      if (!cleanText || muted) return;
      stopSpeaking();
      const providerSetting = selectedProvider();
      if (providerSetting === 'browser') {
        speakWithBrowser(cleanText);
        return;
      }
      const base = proxyBase();
      if (!base) {
        speakWithBrowser(cleanText);
        return;
      }

      try {
        const response = await fetch(`${base}/api/assist/tts`, {
          method: 'POST',
          headers: {
            Accept: 'audio/mpeg,application/json',
            'Content-Type': 'application/json',
          },
          credentials: 'omit',
          body: JSON.stringify({
            text: cleanText,
            provider: providerSetting,
            voice: voiceNameSelect.value || undefined,
            speed: selectedSpeed(),
          }),
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('audio')) {
          throw new Error(`TTS returned ${response.status}`);
        }
        const blob = await response.blob();
        const audioUrl = URL.createObjectURL(blob);
        const provider = response.headers.get('X-Gaia-Voice-Provider') || (providerSetting === 'auto' ? 'hosted' : providerSetting);
        const voice = response.headers.get('X-Gaia-Voice-Name') || '';
        const audio = new Audio(audioUrl);
        audio.preload = 'auto';
        audio.playsInline = true;
        try {
          await playAudioElement(audio, provider, voice, audioUrl);
        } catch (playError) {
          assistError('speech error', { provider, error: playError.message || 'autoplay blocked' });
          showManualVoicePlayback(audioUrl, provider, voice);
        }
      } catch (err) {
        setVoiceProvider('browser');
        assistError('speech error', { provider: providerSetting, error: err.message });
        speakWithBrowser(cleanText);
      }
    }

    function setOpen(open) {
      panel.hidden = !open;
      orb.setAttribute('aria-expanded', String(open));
      root.classList.toggle('gaia-assist--open', open);
      document.body.classList.toggle('gaia-assist-panel-open', open);
    }

    function setError(message) {
      error.hidden = !message;
      error.textContent = message || '';
    }

    function setBusy(busy, label = 'Working...') {
      mic.disabled = busy;
      form.querySelector('button').disabled = busy;
      chips.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
      status.textContent = busy ? label : 'Ready for next prompt';
      root.classList.toggle('gaia-assist--thinking', busy);
    }

    function appendMessage(kind, text) {
      const bubble = document.createElement('p');
      bubble.className = `gaia-assist__bubble gaia-assist__bubble--${kind}`;
      bubble.innerHTML = escapeHtml(text);
      transcript.appendChild(bubble);
      const bubbles = transcript.querySelectorAll('.gaia-assist__bubble');
      if (bubbles.length > 7) bubbles[0].remove();
      transcript.scrollTop = transcript.scrollHeight;
    }

    async function sendPrompt(prompt, intent = 'general', source = 'text') {
      const cleanPrompt = String(prompt || '').trim();
      if (!cleanPrompt) {
        setError('Type or speak a prompt first.');
        return;
      }
      const base = proxyBase();
      if (!base) {
        setError('Gaia Assist could not find the staging proxy URL.');
        assistError('proxy missing', { prompt: cleanPrompt, intent, source });
        return;
      }

      setError('');
      appendMessage('user', cleanPrompt);
      setBusy(true, 'Sending to Gaia proxy...');
      assistLog('request sent to proxy', { endpoint: `${base}/api/assist/chat`, intent, source });

      try {
        const response = await fetch(`${base}/api/assist/chat`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          credentials: 'omit',
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
        if (payload.warning) {
          setError(payload.warning);
          assistLog('OpenAI/voice warning', { warning: payload.warning, provider: payload.provider });
        }
        const reply = payload.reply || 'Gaia Assist received the prompt but did not return a message.';
        appendMessage('bot', reply);
        await speakReply(reply);
      } catch (err) {
        assistError('OpenAI/voice error', err);
        setError(err.message || 'Gaia Assist could not reach the proxy.');
        appendMessage('bot', 'I could not complete that request. The proxy or voice backend returned an error, and no data was changed.');
      } finally {
        setBusy(false);
      }
    }

    function stopRecognition() {
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

      setError('');
      try {
        await ensureMicPermission();
      } catch (err) {
        assistError('mic permission error', err);
        setError('Microphone permission was blocked. Allow microphone access in the browser, or use the text box to test Gaia Assist.');
        return;
      }

      if (!SpeechRecognition) {
        setError('Speech recognition is not available in this browser. Use the text box to test the same proxy path.');
        assistError('speech recognition unavailable', { userAgent: navigator.userAgent });
        return;
      }

      recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.continuous = false;

      let finalTranscript = '';
      recognition.onstart = () => {
        recognizing = true;
        root.classList.add('gaia-assist--listening');
        status.textContent = 'Listening...';
        assistLog('recording started');
      };
      recognition.onresult = (event) => {
        const spoken = Array.from(event.results)
          .map((result) => result[0]?.transcript || '')
          .join(' ')
          .trim();
        if (spoken) {
          status.textContent = event.results[event.results.length - 1].isFinal ? 'Voice captured' : `Hearing: ${spoken}`;
          finalTranscript = spoken;
        }
      };
      recognition.onerror = (event) => {
        assistError('OpenAI/voice error', { type: 'speech-recognition', error: event.error });
        setError(`Voice capture failed: ${event.error}. You can type the same prompt below.`);
      };
      recognition.onend = () => {
        recognizing = false;
        root.classList.remove('gaia-assist--listening');
        assistLog('recording stopped', { hasTranscript: Boolean(finalTranscript) });
        if (finalTranscript) {
          sendPrompt(finalTranscript, 'voice', 'voice');
        } else {
          status.textContent = 'No speech captured';
        }
      };

      recognition.start();
    }

    orb.addEventListener('click', () => setOpen(panel.hidden));
    close.addEventListener('click', () => setOpen(false));
    mic.addEventListener('click', startVoicePrompt);
    muteButton.addEventListener('click', () => setMuted(!muted));
    stopButton.addEventListener('click', stopSpeaking);
    playButton.addEventListener('click', async () => {
      if (!pendingVoice) return;
      setError('');
      const audio = new Audio(pendingVoice.url);
      audio.preload = 'auto';
      audio.playsInline = true;
      try {
        await playAudioElement(audio, pendingVoice.provider, pendingVoice.voice, pendingVoice.url);
      } catch (err) {
        assistError('speech error', { provider: pendingVoice.provider, error: err.message });
        setError('Voice playback is still blocked. Turn off silent mode, raise volume, or try Safari/Chrome microphone permission settings.');
      }
    });
    voiceProviderSelect.addEventListener('change', () => {
      localStorage.setItem(VOICE_PROVIDER_KEY, voiceProviderSelect.value);
      setVoiceProvider(voiceProviderSelect.value === 'auto' ? 'auto' : voiceProviderSelect.value);
    });
    voiceNameSelect.addEventListener('change', () => {
      localStorage.setItem(VOICE_NAME_KEY, voiceNameSelect.value);
    });
    voiceSpeed.addEventListener('input', () => {
      localStorage.setItem(VOICE_SPEED_KEY, voiceSpeed.value);
      voiceSpeedLabel.textContent = `${Number(voiceSpeed.value).toFixed(2)}x`;
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const prompt = promptInput.value;
      promptInput.value = '';
      sendPrompt(prompt, 'typed', 'text');
    });
    chips.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        const item = suggestionMap.find((entry) => entry.intent === button.dataset.intent) || suggestionMap[0];
        sendPrompt(item.label, item.intent, 'quick-action');
      });
    });

    document.querySelectorAll('[data-gaia-open-assist]').forEach((button) => {
      button.addEventListener('click', () => setOpen(true));
    });
    setMuted(muted);
    initVoiceSettings();
    setVoiceProvider(selectedProvider() === 'auto' ? 'auto' : selectedProvider());
  }

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initCoachMark();
    initSplashSteps();
    initAppShellNavigation();
    initCommunityTabs();
    initLiveSyncIndicator();
    initGaiaAssist();
  });
})();
