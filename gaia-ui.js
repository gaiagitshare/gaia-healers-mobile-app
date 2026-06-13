/* Gaia Healers V2 — prototype interactions */
(function () {
  if (new URLSearchParams(window.location.search).has('store')) {
    sessionStorage.setItem('gaia-coach-v2', '1');
    sessionStorage.setItem('gaia-entered', '1');
    sessionStorage.setItem('gaia-onboarded', '1');
  }

  const COACH_KEY = 'gaia-coach-v2';

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

  function initCommunityTabs() {
    const bar = document.getElementById('community-tabs');
    if (!bar) return;
    const panels = { feed: 'panel-feed', groups: 'panel-groups', events: 'panel-events', directory: 'panel-directory' };
    const buttons = bar.querySelectorAll('[data-tab]');
    function activate(btn) {
        const tab = btn.getAttribute('data-tab');
        buttons.forEach((b) => {
          const on = b === btn;
          b.classList.toggle('bg-gaia', on);
          b.classList.toggle('text-white', on);
          b.classList.toggle('bg-surface-muted', !on);
          b.classList.toggle('text-ink-secondary', !on);
        });
        Object.entries(panels).forEach(([k, id]) => {
          const el = document.getElementById(id);
          if (el) el.classList.toggle('hidden', k !== tab);
        });
    }
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        activate(btn);
      });
    });
    const requestedTab = new URLSearchParams(window.location.search).get('tab');
    const requestedButton = requestedTab && bar.querySelector(`[data-tab="${requestedTab}"]`);
    if (requestedButton) activate(requestedButton);
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
          <div>
            <p class="gaia-eyebrow">${assistant.mode || 'Push-to-talk'}</p>
            <h2>${assistant.name || 'Gaia Assist'}</h2>
          </div>
          <button type="button" class="gaia-assist__close" aria-label="Close Gaia Assist">Close</button>
        </div>
        <div class="gaia-assist__voice" data-assist-state="idle">
          <button type="button" class="gaia-assist__mic" aria-label="Start voice prompt">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-12 0v1.5a6 6 0 006 6m0 0v3m-3 0h6M12 15a2.25 2.25 0 002.25-2.25v-6a2.25 2.25 0 00-4.5 0v6A2.25 2.25 0 0012 15z"/></svg>
          </button>
          <div class="gaia-assist__wave" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <p class="gaia-assist__status">Tap to speak</p>
        </div>
        <div class="gaia-assist__transcript">
          <p class="gaia-assist__bubble gaia-assist__bubble--user">What should I focus on today?</p>
          <p class="gaia-assist__bubble gaia-assist__bubble--bot">Your portal is ready. I can help with Bio-Well scans, Academy progress, Elevate event check-in, and GHL follow-up workflows.</p>
        </div>
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

    const suggestionMap = [
      { label: assistant.suggestions?.[0] || 'Prepare my badge', reply: assistant.responses?.event, intent: 'event' },
      { label: assistant.suggestions?.[1] || 'Explain my scan', reply: assistant.responses?.scan, intent: 'scan' },
      { label: assistant.suggestions?.[2] || 'Next course step', reply: assistant.responses?.academy, intent: 'academy' },
      { label: assistant.suggestions?.[3] || 'GHL follow-up', reply: assistant.responses?.ghl, intent: 'ghl' },
    ];
    chips.innerHTML = suggestionMap.map((item) => `<button type="button" data-intent="${item.intent}">${item.label}</button>`).join('');

    function setOpen(open) {
      panel.hidden = !open;
      orb.setAttribute('aria-expanded', String(open));
      root.classList.toggle('gaia-assist--open', open);
    }

    function answer(intent) {
      const item = suggestionMap.find((entry) => entry.intent === intent) || suggestionMap[0];
      transcript.innerHTML = `
        <p class="gaia-assist__bubble gaia-assist__bubble--user">${item.label}</p>
        <p class="gaia-assist__bubble gaia-assist__bubble--bot">${item.reply || 'I can guide that workflow and ask before making changes.'}</p>`;
      status.textContent = 'Ready for next prompt';
    }

    orb.addEventListener('click', () => setOpen(panel.hidden));
    close.addEventListener('click', () => setOpen(false));
    mic.addEventListener('click', () => {
      root.classList.add('gaia-assist--listening');
      status.textContent = 'Listening...';
      window.setTimeout(() => {
        root.classList.remove('gaia-assist--listening');
        status.textContent = 'Analyzing Gaia context...';
      }, 900);
      window.setTimeout(() => answer('event'), 1600);
    });
    chips.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => answer(button.dataset.intent));
    });

    document.querySelectorAll('[data-gaia-open-assist]').forEach((button) => {
      button.addEventListener('click', () => setOpen(true));
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initCoachMark();
    initSplashSteps();
    initCommunityTabs();
    initGaiaAssist();
  });
})();
