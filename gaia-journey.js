/* The same deterministic renderer powers the member gate and Assist cards. */
(function () {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { schema: [], answers: {}, step: null, mode: 'loading', busy: false, selected: [], text: '', error: '', authed: false, generation: 0, done: false };
  let overlay, embedded, checkPromise, lastFocus;
  const log = (event, stepKey) => console.info('[Gaia Onboarding]', { event, ...(stepKey ? { stepKey } : {}) });
  const base = () => String(window.GAIA_SYNC?.proxyBase || window.GAIA_APP_URLS?.production?.proxy || 'https://api.gaiahealers.app').replace(/\/+$/, '');
  async function request(method, body) {
    const r = await fetch(base() + '/api/assist/onboarding', { method, credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(r.status === 401 ? 'Your session has expired. Sign out and sign in again.' : 'We couldn’t connect to your Gaia profile. Your choices are still here. Please try again.');
    return data;
  }
  function path() { return state.schema.filter(s => !s.showIf || (state.answers.primary_interests || []).includes(s.showIf)); }
  function current() { return state.schema.find(s => s.key === state.step); }
  function chooseStep(key) {
    log('step_loaded', key);
    state.step = key; state.mode = 'question'; state.error = '';
    const s = current();
    state.selected = Array.isArray(state.answers[key]) ? [...state.answers[key]] : [];
    state.text = s?.freeTextOnly ? state.answers[key] || '' : key === 'devices_owned' ? state.answers.devices_other || '' : '';
    render();
    overlay?.querySelector('h1')?.focus();
  }
  const background = new Map();
  function blockBackground() {
    for (const child of document.body.children) {
      if (child === overlay || child.id === 'gaia-assist' || /^(SCRIPT|STYLE|SVG)$/.test(child.tagName)) continue;
      if (!background.has(child)) background.set(child, { inert: child.inert, aria: child.getAttribute('aria-hidden') });
      child.inert = true; child.setAttribute('aria-hidden', 'true');
    }
  }
  const backgroundObserver = new MutationObserver(() => { if (overlay) blockBackground(); });
  function lock(on) {
    document.body.classList.toggle('gaia-journey-open', on);
    if (on) { blockBackground(); backgroundObserver.observe(document.body, { childList: true }); }
    else {
      backgroundObserver.disconnect();
      for (const [child, original] of background) { child.inert = original.inert; if (original.aria === null) child.removeAttribute('aria-hidden'); else child.setAttribute('aria-hidden', original.aria); }
      background.clear(); overlay?.remove(); overlay = null; embedded?.remove(); embedded = null; lastFocus?.focus?.();
    }
  }
  function ensure() {
    if (overlay) return;
    lastFocus = document.activeElement;
    overlay = document.createElement('section'); overlay.className = 'gaia-journey';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Your Gaia journey');
    document.body.appendChild(overlay); lock(true);
    overlay.addEventListener('keydown', e => {
      if (e.key !== 'Tab' || document.querySelector('.gaia-assist--open')) return;
      const buttons = [...overlay.querySelectorAll('button:not(:disabled), textarea, a[href]')];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    });
  }
  const visual = (label) => {
    const icon = label === 'Living Beings' ? 'plant' : label === 'Environment' ? 'mountains' : 'drop';
    return `<span class="journey-art journey-art--${icon}" aria-hidden="true"><i class="ph ph-${icon}"></i><span></span></span>`;
  };
  function questionMarkup() {
    const s = current(); if (!s) return '';
    const route = path(), index = route.findIndex(x => x.key === s.key);
    const primary = s.key === 'primary_interests';
    const other = s.freeText && state.selected.some(x => /^Other/.test(x));
    const canContinue = s.freeTextOnly || state.selected.length;
    return `<div class="journey-progress" role="progressbar" aria-label="Your Gaia journey" aria-valuemin="0" aria-valuemax="${route.length}" aria-valuenow="${index}"><span style="width:${index / route.length * 100}%"></span></div>
      <p class="journey-kicker">${esc(s.showIf || (index < 2 ? 'Your path' : /offer|receive|notes/.test(s.key) ? 'Your community' : 'Your practice'))}</p>
      <h1 tabindex="-1">${esc(primary ? 'What calls to you?' : s.question)}</h1>
      <p class="journey-subtitle">${s.freeTextOnly ? 'Share a little more, or leave this blank. This part is optional.' : s.multi ? 'Choose everything that feels right for you.' : 'Choose the one that feels right for you.'}</p>
      <div class="journey-choices ${primary ? 'journey-choices--paths' : s.key === 'living_beings_who' ? 'journey-choices--compact' : ''}">${s.options.map(o => {
        const active = state.selected.includes(o.label);
        const sub = { 'Living Beings': 'People · Animals · Wellbeing', Environment: 'Spaces · Land · Energy', Water: 'Restore · Structure · Explore' }[o.label];
        return `<button type="button" class="journey-choice ${active ? 'is-selected' : ''}" data-choice="${esc(o.label)}" aria-pressed="${active}" ${state.busy ? 'disabled' : ''}>${primary ? visual(o.label) : s.key === 'living_beings_who' ? `<i class="ph ph-${({ Myself: 'user', 'Other People': 'users', Pets: 'paw-print', 'Livestock or farm animals': 'cow', 'Wildlife or sanctuaries': 'bird' }[o.label] || 'sparkle')} journey-choice-icon" aria-hidden="true"></i>` : ''}<span class="journey-choice-copy"><strong>${esc(o.label)}</strong>${primary ? `<small>${sub}</small>` : ''}</span><span class="journey-check" aria-hidden="true">${active ? '✓' : '+'}</span></button>`;
      }).join('')}</div>
      ${s.freeTextOnly || other ? `<label class="journey-text-label">${esc(s.freeTextOnly ? 'Your thoughts' : s.freeText)}<textarea maxlength="4000" rows="4" ${state.busy ? 'disabled' : ''}>${esc(state.text)}</textarea></label>` : ''}
      <p class="journey-error" role="alert">${esc(state.error)}</p>
      <div class="journey-actions"><button type="button" class="journey-secondary" data-back ${state.busy ? 'disabled' : ''}>← Back</button><button type="button" class="journey-primary" data-next ${!canContinue || state.busy ? 'disabled' : ''}>${state.busy ? 'Saving…' : state.error ? 'Try saving again →' : s.freeTextOnly ? 'Reveal my Gaia path →' : primary && state.selected.length ? `Continue with ${state.selected.length} ${state.selected.length === 1 ? 'path' : 'paths'} →` : 'Continue →'}</button></div>`;
  }
  function revealMarkup() {
    const groups = [['Your path', ['primary_interests']], ['You’re here to explore', ['living_beings_support', 'environment_areas', 'water']], ['You’re looking for', ['growth_needs', 'want_receive']]];
    return `<div class="journey-reveal-art">${visual('Living Beings')}</div><p class="journey-kicker">Made from what you shared</p><h1 tabindex="-1">Your Gaia Path</h1><p class="journey-subtitle">Your journey is ready, ${esc(state.name || 'friend')}.</p>${groups.map(([title, keys]) => {
      const values = keys.flatMap(k => state.answers[k] || []);
      return values.length ? `<section class="journey-summary"><h2>${title}</h2><div>${values.map(v => `<span>${esc(v)}</span>`).join('')}</div></section>` : '';
    }).join('')}<button type="button" class="journey-primary" data-enter>Enter Gaia →</button>`;
  }
  function render() {
    if (!state.authed || state.mode === 'bypass') return;
    ensure();
    const content = state.mode === 'question' ? questionMarkup() : state.mode === 'reveal' ? revealMarkup() : state.mode === 'intro' ? `<div class="journey-intro-art">${visual('Water')}</div><p class="journey-kicker">${Object.keys(state.answers).length ? 'Welcome back' : 'Welcome'}, ${esc(state.name || 'friend')}</p><h1 tabindex="-1">Let’s discover<br>your Gaia path.</h1><p class="journey-subtitle">A little about you. A world of possibilities.<br>Help Gaia connect you with the education, tools and community that feel right.</p><p class="journey-duration">About 2 minutes · Saved as you go</p><button type="button" class="journey-primary" data-begin>${Object.keys(state.answers).length ? 'Continue my journey' : 'Begin my journey'} →</button>` : `<p class="journey-kicker">Your Gaia profile</p><h1 tabindex="-1">${state.mode === 'loading' ? 'Finding your path…' : 'Let’s reconnect.'}</h1><p class="journey-subtitle" role="status">${esc(state.error || 'Checking your saved Gaia profile.')}</p>${state.mode === 'error' ? '<button class="journey-primary" data-retry>Try again →</button>' : ''}`;
    overlay.innerHTML = `<header class="journey-header"><img src="assets/gaia-mark.svg" alt="Gaia Healers"><span>Your Gaia journey</span><button type="button" data-logout class="journey-secondary">Sign out</button></header><div class="journey-stage" data-branch="${esc(current()?.showIf || '')}">${content}${state.mode === 'question' ? '<button type="button" class="journey-assist-link" data-assist>Answer with Gaia Assist ↗</button>' : ''}</div>`;
    bind(overlay);
    renderEmbedded();
  }
  function renderEmbedded() {
    const transcript = document.querySelector('.gaia-assist__transcript');
    if (!transcript || state.mode !== 'question') { embedded?.remove(); embedded = null; return; }
    if (!embedded?.isConnected) { embedded = document.createElement('section'); embedded.className = 'journey-embedded'; transcript.appendChild(embedded); }
    embedded.innerHTML = `<p class="journey-kicker">Let’s build your Gaia path</p>${questionMarkup()}`;
    bind(embedded);
  }
  function bind(root) {
    root.querySelectorAll('[data-choice]').forEach(b => b.addEventListener('click', () => {
      const s = current(), label = b.dataset.choice;
      state.selected = s.multi ? state.selected.includes(label) ? state.selected.filter(v => v !== label) : [...state.selected, label] : [label];
      state.error = ''; render();
      root.querySelector(`[data-choice="${CSS.escape(label)}"]`)?.focus();
    }));
    root.querySelector('textarea')?.addEventListener('input', e => { state.text = e.target.value; });
    root.querySelector('[data-next]')?.addEventListener('click', save);
    root.querySelector('[data-back]')?.addEventListener('click', () => {
      const route = path(), i = route.findIndex(s => s.key === state.step);
      if (i > 0) chooseStep(route[i - 1].key); else { state.mode = 'intro'; render(); }
    });
    root.querySelector('[data-begin]')?.addEventListener('click', () => { log(Object.keys(state.answers).length ? 'resumed' : 'started'); chooseStep(state.nextStep || 'primary_interests'); });
    root.querySelector('[data-retry]')?.addEventListener('click', () => check(true));
    root.querySelector('[data-enter]')?.addEventListener('click', () => {
      state.mode = 'bypass'; lock(false);
      document.dispatchEvent(new CustomEvent('gaia:onboarding-complete'));
    });
    root.querySelector('[data-logout]')?.addEventListener('click', () => document.querySelector('[data-sign-out]')?.click());
    root.querySelector('[data-assist]')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('gaia:open-assist', { detail: { speak: false } })); renderEmbedded();
    });
  }
  async function save() {
    if (state.busy) return;
    const generation = state.generation, s = current();
    state.busy = true; state.error = ''; render();
    try {
      const result = await request('POST', { stepKey: s.key, selections: state.selected, freeText: state.text, complete: !!s.freeTextOnly, source: 'visual' });
      if (generation !== state.generation) return;
      log(s.freeTextOnly ? 'completed' : s.key === 'primary_interests' ? 'branch_selected' : 'step_saved', s.key);
      state.answers = result.answers;
      if (s.freeTextOnly) {
        if (!result.complete) throw new Error('Your profile is saved. Please retry to confirm completion.');
        state.done = true; state.mode = 'reveal';
      } else {
        const route = path(), index = route.findIndex(x => x.key === s.key);
        state.busy = false; chooseStep(route[index + 1].key);
      }
    } catch (e) { log('step_save_failed', s.key); if (generation === state.generation) state.error = e.message; }
    finally { if (generation === state.generation) { state.busy = false; render(); } }
  }
  function check(force = false) {
    if (!state.authed) return Promise.resolve(true);
    if (state.done && !force) return Promise.resolve(state.mode === 'bypass');
    if (checkPromise && !force) return checkPromise;
    const generation = state.generation;
    state.mode = 'loading'; state.error = ''; render();
    checkPromise = request('GET').then(data => {
      if (generation !== state.generation) return false;
      state.schema = data.schema; state.answers = data.answers; state.name = data.member.name.split(/\s+/)[0]; state.nextStep = data.nextStep;
      if (data.state === 'complete') { state.done = true; state.mode = 'bypass'; lock(false); if (force) document.dispatchEvent(new CustomEvent('gaia:onboarding-complete')); return true; }
      state.mode = 'intro'; render(); return false;
    }).catch(e => { if (generation === state.generation) { state.mode = 'error'; state.error = e.message; render(); } return false; });
    return checkPromise;
  }
  document.addEventListener('gaia:auth', e => {
    state.generation++; checkPromise = null; state.done = false;
    state.authed = !!e.detail?.authenticated;
    state.answers = {}; state.selected = []; state.text = ''; state.busy = false;
    if (state.authed) { check(); overlay?.querySelector('h1')?.focus(); } else { state.mode = 'bypass'; lock(false); }
  });
  window.addEventListener('gaia:signed-out', () => { state.authed = false; state.generation++; checkPromise = null; lock(false); });
  // Voice and free-form chat continue using their existing tools/markers. Refresh
  // their saved result when a new assistant bubble arrives, without overwriting
  // an unsaved visual choice.
  let refreshTimer;
  function watchAssist() {
    const transcript = document.querySelector('.gaia-assist__transcript');
    if (!transcript) return;
    new MutationObserver(records => {
      if (!records.some(r => [...r.addedNodes].some(n => n.nodeType === 1 && n.classList?.contains('gaia-assist__bubble')))) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        if (!state.authed || state.busy || state.done || state.mode !== 'question') return;
        if (JSON.stringify(state.selected) !== JSON.stringify(state.answers[state.step] || []) || state.text) return;
        try {
          const data = await request('GET');
          state.answers = data.answers;
          if (data.completedByTag) { state.done = true; state.mode = 'reveal'; render(); }
          else chooseStep(data.nextStep || 'final_notes');
        } catch (_) {}
      }, 1200);
    }).observe(transcript, { childList: true });
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (document.querySelector('.gaia-assist__transcript')) watchAssist();
    else { const observer = new MutationObserver(() => { if (document.querySelector('.gaia-assist__transcript')) { observer.disconnect(); watchAssist(); } }); observer.observe(document.body, { childList: true }); }
  });
  window.GaiaJourney = { check, get complete() { return state.done && state.mode === 'bypass'; } };
})();
