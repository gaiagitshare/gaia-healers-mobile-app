/* The same deterministic renderer powers the member gate and Assist cards. */
(function () {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { schema: [], answers: {}, step: null, mode: 'loading', busy: false, selected: [], text: '', error: '', authed: false, generation: 0, done: false };
  let overlay, embedded, checkPromise, lastFocus, renderedScene = '', branchNotice = '';
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const log = (event, stepKey) => console.info('[Gaia Onboarding]', { event, ...(stepKey ? { stepKey } : {}) });
  const base = () => (window.GaiaApi && window.GaiaApi.base && window.GaiaApi.base()) || String(window.GAIA_SYNC?.proxyBase || window.GAIA_APP_URLS?.production?.proxy || 'https://api.gaiahealers.app').replace(/\/+$/, '');
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
    document.dispatchEvent(new CustomEvent('gaia:onboarding-step', { detail: { screen: 'onboarding', step: key, branch: s?.showIf || '' } }));
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
    if (!document.getElementById('gaia-journey-defs')) document.body.insertAdjacentHTML('beforeend', DEFS);
    overlay.addEventListener('keydown', e => {
      if (e.key !== 'Tab' || document.querySelector('.gaia-assist--open')) return;
      const buttons = [...overlay.querySelectorAll('button:not(:disabled), textarea, a[href]')];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    });
  }
  /* ---- Display-only artwork. Option labels, keys and order still come from the server schema. ---- */
  const kindOf = label => /water/i.test(label) ? 'water' : /environ/i.test(label) ? 'environment' : 'beings';
  const BRANCH_ICON = { beings: 'plant', environment: 'mountains', water: 'drop' };
  const BRANCH_SUB = { 'Living Beings': 'People · Animals · Wellbeing', Environment: 'Spaces · Land · Energy', Water: 'Restore · Structure · Explore' };
  // One shared, never-hidden gradient sprite so every inline scene (gate, Assist, reveal) resolves its fills.
  const DEFS = '<svg id="gaia-journey-defs" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" focusable="false"><defs>'
    + '<linearGradient id="gj-sky-b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0c3020"/><stop offset=".7" stop-color="#05140c"/><stop offset="1" stop-color="#030c07"/></linearGradient>'
    + '<radialGradient id="gj-glow-b"><stop offset="0" stop-color="#42db86" stop-opacity=".55"/><stop offset=".55" stop-color="#42db86" stop-opacity=".12"/><stop offset="1" stop-color="#42db86" stop-opacity="0"/></radialGradient>'
    + '<linearGradient id="gj-leaf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b9ff9e"/><stop offset=".45" stop-color="#5fe58f"/><stop offset="1" stop-color="#1c7a48"/></linearGradient>'
    + '<linearGradient id="gj-leaf2" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8bff70"/><stop offset=".5" stop-color="#42db86"/><stop offset="1" stop-color="#15603a"/></linearGradient>'
    + '<linearGradient id="gj-hill-b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14492c"/><stop offset="1" stop-color="#061a0f"/></linearGradient>'
    + '<linearGradient id="gj-sky-e" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2a16"/><stop offset=".6" stop-color="#0f120a"/><stop offset="1" stop-color="#070906"/></linearGradient>'
    + '<radialGradient id="gj-glow-e"><stop offset="0" stop-color="#f3dc8c" stop-opacity=".6"/><stop offset=".5" stop-color="#c0bc88" stop-opacity=".14"/><stop offset="1" stop-color="#c0bc88" stop-opacity="0"/></radialGradient>'
    + '<radialGradient id="gj-sun" cx=".4" cy=".35"><stop offset="0" stop-color="#fffbe6"/><stop offset=".55" stop-color="#f1dc93"/><stop offset="1" stop-color="#c9b86a"/></radialGradient>'
    + '<linearGradient id="gj-mtn-far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6e6942"/><stop offset="1" stop-color="#22210f"/></linearGradient>'
    + '<linearGradient id="gj-mtn-near" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f4a24"/><stop offset="1" stop-color="#0d120a"/></linearGradient>'
    + '<linearGradient id="gj-sky-w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a3140"/><stop offset=".6" stop-color="#04161e"/><stop offset="1" stop-color="#020b10"/></linearGradient>'
    + '<radialGradient id="gj-glow-w"><stop offset="0" stop-color="#58c7e8" stop-opacity=".55"/><stop offset=".5" stop-color="#58c7e8" stop-opacity=".12"/><stop offset="1" stop-color="#58c7e8" stop-opacity="0"/></radialGradient>'
    + '<linearGradient id="gj-water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f6f8a" stop-opacity=".9"/><stop offset="1" stop-color="#03141b"/></linearGradient>'
    + '<linearGradient id="gj-drop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9fbff"/><stop offset=".4" stop-color="#7fd8f2"/><stop offset="1" stop-color="#1b6f8c"/></linearGradient>'
    + '</defs></svg>';
  const SCENES = {
    beings: '<rect width="320" height="200" fill="url(#gj-sky-b)"/><circle class="gj-pulse" cx="168" cy="96" r="104" fill="url(#gj-glow-b)"/>'
      + '<g fill="none" stroke="#b9ffa8" stroke-linecap="round" opacity=".55"><path class="gj-drift" d="M52 52q7-7 14 0q7-7 14 0"/><path class="gj-drift gj-d2" d="M250 40q5-5 10 0q5-5 10 0"/></g>'
      + '<path d="M0 148C58 120 118 126 168 138S266 118 320 128V200H0Z" fill="url(#gj-hill-b)" opacity=".85"/>'
      + '<g class="gj-sway"><path d="M160 168C157 146 163 120 160 88" fill="none" stroke="#4fe48f" stroke-width="3.2" stroke-linecap="round"/>'
      + '<path d="M160 136C138 140 110 130 102 104C128 98 152 110 160 136Z" fill="url(#gj-leaf2)"/><path d="M158 133C140 126 122 116 108 106" fill="none" stroke="#dcffd0" stroke-opacity=".5" stroke-width="1.1"/>'
      + '<path d="M161 116C182 120 210 108 218 78C190 74 166 90 161 116Z" fill="url(#gj-leaf)"/><path d="M163 113C182 104 198 94 212 82" fill="none" stroke="#f0ffe8" stroke-opacity=".55" stroke-width="1.1"/>'
      + '<path d="M160 92C150 78 152 62 160 50C168 62 170 78 160 92Z" fill="url(#gj-leaf)"/></g>'
      + '<g class="gj-flutter-wrap"><g class="gj-flutter"><path d="M122 66c-10-12-22-8-18 2c3 7 12 6 18-2Z" fill="#8bff70" opacity=".9"/><path d="M122 66c10-12 22-8 18 2c-3 7-12 6-18-2Z" fill="#42db86" opacity=".9"/></g></g>'
      + '<path d="M0 172C70 154 136 164 200 170S290 156 320 162V200H0Z" fill="#04120a"/>'
      + '<g fill="#3fbf72" opacity=".9"><path d="M60 174q-3-14 4-22q-1 12 2 22Z"/><path d="M70 174q2-12 10-16q-6 8-6 16Z"/><path d="M262 168q-2-12 5-18q-2 10 0 18Z"/><path d="M272 168q3-10 10-12q-5 6-6 12Z"/></g>'
      + '<g fill="#d4ffc4"><circle class="gj-spark" cx="96" cy="94" r="1.8"/><circle class="gj-spark gj-d2" cx="214" cy="128" r="1.5"/><circle class="gj-spark gj-d3" cx="128" cy="66" r="1.3"/><circle class="gj-spark gj-d4" cx="246" cy="112" r="1.8"/><circle class="gj-spark gj-d3" cx="80" cy="132" r="1.4"/></g>',
    environment: '<rect width="320" height="200" fill="url(#gj-sky-e)"/><circle class="gj-pulse" cx="206" cy="70" r="92" fill="url(#gj-glow-e)"/>'
      + '<g fill="none" stroke="#f1dc93"><circle class="gj-ring" cx="206" cy="70" r="34" stroke-opacity=".35"/><circle class="gj-ring gj-d2" cx="206" cy="70" r="48" stroke-opacity=".2"/></g><circle cx="206" cy="70" r="21" fill="url(#gj-sun)"/>'
      + '<path d="M0 146L46 102L80 126L136 62L190 128L226 104L320 150V200H0Z" fill="url(#gj-mtn-far)"/><path d="M136 62L124 80L136 75L146 88M226 104L218 114L228 111" fill="none" stroke="#f3e7b5" stroke-opacity=".55" stroke-width="1.4" stroke-linejoin="round"/>'
      + '<path d="M0 166C70 140 140 152 206 150S296 140 320 146V200H0Z" fill="url(#gj-mtn-near)"/>'
      + '<g fill="#0b0f08" stroke="#c0bc88" stroke-width="1.2" stroke-linejoin="round"><path d="M196 158V144L210 133L224 144V158Z"/></g><rect class="gj-flicker" x="206" y="146" width="8" height="7" rx="1" fill="#ffe69a"/>'
      + '<g fill="#1c2412"><path d="M232 156l7-20 7 20Z"/><path d="M246 157l6-16 6 16Z"/><path d="M96 160l6-17 6 17Z"/></g>'
      + '<g class="gj-grid" fill="none" stroke="#d8cb8a" stroke-width=".9"><path d="M0 168H320M0 178H320M0 192H320" stroke-opacity=".22"/><path d="M160 162L-80 200M160 162L0 200M160 162L80 200M160 162L160 200M160 162L240 200M160 162L320 200M160 162L400 200" stroke-opacity=".18"/></g>',
    water: '<rect width="320" height="200" fill="url(#gj-sky-w)"/><circle class="gj-pulse" cx="160" cy="112" r="110" fill="url(#gj-glow-w)"/>'
      + '<path d="M0 112C60 96 112 104 160 108S262 96 320 104V200H0Z" fill="#06232d"/><rect y="120" width="320" height="80" fill="url(#gj-water)"/>'
      + '<g fill="none" stroke="#9be7ff"><ellipse class="gj-ripple" cx="160" cy="150" rx="34" ry="8" stroke-opacity=".7"/><ellipse class="gj-ripple gj-d2" cx="160" cy="150" rx="34" ry="8" stroke-opacity=".7"/><ellipse class="gj-ripple gj-d3" cx="160" cy="150" rx="34" ry="8" stroke-opacity=".7"/></g>'
      + '<g class="gj-wave" fill="none" stroke="#8fe3ff" stroke-linecap="round"><path d="M14 132q16-5 32 0t32 0" stroke-opacity=".3"/><path d="M236 138q14-4 28 0t28 0" stroke-opacity=".28"/><path d="M40 176q18-5 36 0t36 0" stroke-opacity=".2"/><path d="M214 182q16-5 32 0t32 0" stroke-opacity=".18"/></g>'
      + '<ellipse cx="160" cy="150" rx="18" ry="4" fill="#bdf1ff" opacity=".45"/>'
      + '<g class="gj-bob"><path d="M160 34C160 34 134 68 134 86A26 26 0 0 0 186 86C186 68 160 34 160 34Z" fill="url(#gj-drop)"/><path d="M172 84Q174 98 162 104" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2.4" stroke-linecap="round"/><ellipse cx="150" cy="70" rx="3" ry="6" fill="#fff" opacity=".55" transform="rotate(24 150 70)"/></g>'
      + '<g fill="#e9fbff"><circle class="gj-spark" cx="92" cy="60" r="1.3"/><circle class="gj-spark gj-d3" cx="236" cy="72" r="1.6"/><circle class="gj-spark gj-d2" cx="210" cy="40" r="1.1"/></g>',
  };
  const scene = (label, fit = 'xMidYMid slice') => { const kind = kindOf(label); return `<span class="journey-art journey-art--${kind}" aria-hidden="true"><svg class="journey-scene" viewBox="0 0 320 200" preserveAspectRatio="${fit}" focusable="false">${SCENES[kind]}</svg></span>`; };
  const CHECK = '<span class="journey-check" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path class="journey-check-plus" d="M12 7.5v9M7.5 12h9"/><path class="journey-check-tick" d="M6.8 12.6l3.4 3.4 7-7.6"/></svg></span>';
  // Per-option icon map, keyed by step + the server's exact label text (display only).
  const ICONS = {
    why_join: [[/own healing/i, 'flower-lotus'], [/others/i, 'hand-heart']],
    living_beings_who: [[/^Myself/, 'user'], [/Other People/, 'users-three'], [/Pets/, 'paw-print'], [/Livestock/, 'cow'], [/Wildlife/, 'bird']],
    living_beings_support: [[/biofield/i, 'sparkle'], [/nervous/i, 'heartbeat'], [/brain health/i, 'brain'], [/body comp/i, 'person'], [/remote/i, 'broadcast'], [/all-in-one/i, 'cpu'], [/photo|light/i, 'sun'], [/inflammation|pain/i, 'first-aid'], [/meditation/i, 'person-simple-tai-chi'], [/colou?r/i, 'palette'], [/structured water/i, 'music-notes'], [/alkaline/i, 'drop']],
    environment_areas: [[/EMF/, 'wifi-high'], [/sound|frequency/i, 'waveform'], [/objects/i, 'diamond'], [/scalar/i, 'broadcast'], [/measuring/i, 'gauge']],
    environment_spaces: [[/home/i, 'house'], [/clinic/i, 'buildings'], [/land|farm/i, 'tree'], [/community|public/i, 'users-four'], [/remote/i, 'globe-hemisphere-west']],
    water: [[/drink/i, 'drop'], [/structur/i, 'spiral'], [/sound/i, 'music-notes'], [/crop|farm/i, 'plant'], [/measur/i, 'gauge']],
    business_length: [[/haven.t started/i, 'rocket-launch'], [/^</, 'plant'], [/^1 /, 'potted-plant'], [/^3 /, 'tree'], [/^5 /, 'tree-evergreen'], [/^10/, 'crown']],
    invest_timing: [[/ready now/i, 'lightning'], [/3.6/, 'calendar-check'], [/6.12/, 'calendar'], [/exploring/i, 'compass']],
    growth_needs: [[/infrastructure/i, 'browsers'], [/automation|software/i, 'robot'], [/visibility|referral/i, 'megaphone'], [/education/i, 'graduation-cap'], [/community/i, 'users-three'], [/none/i, 'circle-dashed']],
    client_needs: [[/cognitive/i, 'brain'], [/stress/i, 'heartbeat'], [/physical/i, 'barbell'], [/energy/i, 'hand-heart'], [/environment|water/i, 'leaf']],
    can_offer: [[/testimony/i, 'quotes'], [/center/i, 'storefront'], [/education|teaching/i, 'chalkboard-teacher'], [/leadership/i, 'flag'], [/volunteer/i, 'handshake'], [/offer/i, 'gift']],
    want_receive: [[/education/i, 'graduation-cap'], [/guidance|mentor/i, 'compass'], [/tools/i, 'toolbox'], [/personal healing/i, 'flower-lotus'], [/professional/i, 'chart-line-up'], [/community/i, 'users-three']],
  };
  function choiceIcon(step, label) {
    if (/^Other( \(|$)/i.test(label)) return '<i class="ph ph-pencil-simple-line"></i>';
    if (/still exploring|not sure/i.test(label)) return '<i class="ph ph-compass"></i>';
    if (step.key === 'devices_owned') {
      if (/^None/i.test(label)) return '<i class="ph ph-circle-dashed"></i>';
      const words = label.replace(/^BioTekna\s+/, '').split(/[\s-]+/).filter(Boolean);
      const mono = words.length > 1 ? words.map(w => w[0]).join('').slice(0, 3) : words[0].slice(0, 2);
      return `<b class="journey-mono">${esc(mono.toUpperCase())}</b>`;
    }
    const hit = (ICONS[step.key] || []).find(([re]) => re.test(label));
    return `<i class="ph ph-${hit ? hit[1] : step.showIf ? BRANCH_ICON[kindOf(step.showIf)] : 'sparkle'}"></i>`;
  }
  // The visual route mirrors path(); on the first step it previews the branches being chosen.
  function displayRoute() {
    const chosen = state.step === 'primary_interests' && state.mode === 'question' ? state.selected : state.answers.primary_interests || [];
    return state.schema.filter(s => !s.showIf || chosen.includes(s.showIf));
  }
  const groupOf = s => s.showIf ? s.showIf : /^(primary_interests|why_join)$/.test(s.key) ? 'Your path' : /offer|receive|notes/.test(s.key) ? 'Your community' : 'Your practice';
  const GROUP_ICON = { 'Your path': 'compass', 'Your practice': 'briefcase', 'Your community': 'users-three' };
  function pathNodes() {
    const route = displayRoute(), at = route.findIndex(x => x.key === state.step), groups = [];
    route.forEach((s, i) => { const g = groupOf(s); let last = groups[groups.length - 1]; if (!last || last.name !== g) groups.push(last = { name: g, first: i, steps: 0 }); last.steps++; });
    return groups.map(g => {
      const status = at >= g.first + g.steps ? 'is-done' : at >= g.first ? 'is-current' : '';
      const icon = GROUP_ICON[g.name] || BRANCH_ICON[kindOf(g.name)];
      const fill = status === 'is-current' ? (at - g.first + 1) / g.steps : status ? 1 : 0;
      return `<li class="${status}" data-group="${esc(GROUP_ICON[g.name] ? 'core' : kindOf(g.name))}" style="--fill:${fill.toFixed(3)}"><span class="journey-path-node"><i class="ph ph-${icon}"></i></span><span class="journey-path-label">${esc(g.name.replace(/^Your /, ''))}</span></li>`;
    }).join('');
  }
  const linksFor = (s, selected) => {
    const on = s.options.map(o => selected.includes(o.label));
    return on.map((v, i) => i < on.length - 1 && on.slice(0, i + 1).some(Boolean) && on.slice(i + 1).some(Boolean));
  };
  function questionMarkup() {
    const s = current(); if (!s) return '';
    const route = path(), index = route.findIndex(x => x.key === s.key);
    const primary = s.key === 'primary_interests';
    const other = s.freeText && state.selected.some(x => /^Other/.test(x));
    const canContinue = s.freeTextOnly || state.selected.length;
    const branchStart = !!s.showIf && route[index - 1]?.showIf !== s.showIf;
    const kind = s.showIf ? kindOf(s.showIf) : '';
    const links = primary ? linksFor(s, state.selected) : [];
    const variant = primary ? 'journey-choices--paths' : s.options.length > 10 && s.options.every(o => o.label.length <= 24) ? 'journey-choices--many' : 'journey-choices--tiles';
    return `<div class="journey-progress" role="progressbar" aria-label="Your Gaia journey" aria-valuemin="0" aria-valuemax="${route.length}" aria-valuenow="${index}"><ol class="journey-path" aria-hidden="true">${pathNodes()}</ol></div>
      <p class="journey-branch-notice ${branchStart ? 'journey-sr' : ''}" role="status">${esc(branchNotice)}</p>
      ${branchStart ? `<div class="journey-branch-intro journey-branch-intro--${kind}" aria-hidden="true"><span class="journey-branch-emblem"><i class="ph ph-${BRANCH_ICON[kind]}"></i><b></b><b></b></span><span><small>Now exploring</small><strong>${esc(s.showIf)}</strong></span><span class="journey-branch-sweep"></span></div><p class="journey-kicker journey-sr">${esc(s.showIf)}</p>` : `<p class="journey-kicker">${esc(groupOf(s))}</p>`}
      <h1 tabindex="-1">${esc(primary ? 'What calls to you?' : s.question)}</h1>
      <p class="journey-subtitle">${s.freeTextOnly ? 'Share a little more, or leave this blank. This part is optional.' : s.multi ? 'Choose everything that feels right for you.' : 'Choose the one that feels right for you.'}</p>
      ${s.options.length ? `<div class="journey-choices ${variant} ${s.multi ? '' : 'journey-choices--single'}" data-count="${state.selected.length}">${s.options.map((o, i) => {
        const active = state.selected.includes(o.label);
        return primary
          ? `<button type="button" class="journey-choice journey-path-card ${active ? 'is-selected' : ''} ${links[i] ? 'is-linked' : ''}" data-choice="${esc(o.label)}" data-motif="${esc(o.label)}" data-kind="${kindOf(o.label)}" style="--i:${i}" aria-pressed="${active}" ${state.busy ? 'disabled' : ''}>${scene(o.label)}<span class="journey-choice-copy"><span class="journey-path-icon" aria-hidden="true"><i class="ph ph-${BRANCH_ICON[kindOf(o.label)]}"></i></span><strong>${esc(o.label)}</strong><small>${BRANCH_SUB[o.label] || ''}</small></span>${CHECK}<span class="journey-link" aria-hidden="true"><b></b></span></button>`
          : `<button type="button" class="journey-choice journey-tile ${active ? 'is-selected' : ''}" data-choice="${esc(o.label)}" data-motif="${esc(s.showIf || s.key)}" style="--i:${Math.min(i, 11)}" aria-pressed="${active}" ${state.busy ? 'disabled' : ''}><span class="journey-tile-icon" aria-hidden="true">${choiceIcon(s, o.label)}</span><span class="journey-choice-copy"><strong>${esc(o.label)}</strong></span>${CHECK}</button>`;
      }).join('')}</div>` : ''}
      ${s.freeTextOnly || other ? `<label class="journey-text-label">${esc(s.freeTextOnly ? 'Your thoughts' : s.freeText)}<textarea maxlength="4000" rows="4" ${state.busy ? 'disabled' : ''}>${esc(state.text)}</textarea></label>` : ''}
      <div class="journey-footer"><p class="journey-error" role="alert">${esc(state.error)}</p>
      <div class="journey-actions"><button type="button" class="journey-secondary" data-back ${state.busy ? 'disabled' : ''}>← Back</button><button type="button" class="journey-primary" data-next ${!canContinue || state.busy ? 'disabled' : ''}>${state.busy ? 'Saving…' : state.error ? 'Try saving again →' : s.freeTextOnly ? 'Reveal my Gaia path →' : primary && state.selected.length ? `Continue with ${state.selected.length} ${state.selected.length === 1 ? 'path' : 'paths'} →` : 'Continue →'}</button></div></div>`;
  }
  function revealMarkup() {
    const chosen = state.answers.primary_interests || [];
    const list = (values, start) => `<ul>${values.map((v, i) => `<li style="--chip-index:${Math.min(start + i, 10)}"><i class="ph ph-check" aria-hidden="true"></i><span>${esc(v)}</span></li>`).join('')}</ul>`;
    const branchCards = chosen.map((label, n) => {
      const values = state.schema.filter(s => s.showIf === label).flatMap(s => state.answers[s.key] || []);
      return `<section class="journey-summary journey-summary--branch" data-kind="${kindOf(label)}" style="--card-index:${n}"><div class="journey-summary-banner">${scene(label)}<h2><i class="ph ph-${BRANCH_ICON[kindOf(label)]}" aria-hidden="true"></i>${esc(label)}</h2></div>${values.length ? list(values, 0) : ''}</section>`;
    }).join('');
    const looking = ['growth_needs', 'want_receive'].flatMap(k => state.answers[k] || []);
    const initial = (state.name || 'Friend').trim().charAt(0).toUpperCase();
    return `<div class="journey-constellation" style="--count:${chosen.length}" aria-hidden="true"><span class="journey-thread"><b></b></span>
        <span class="journey-node journey-node--you" style="--n:0"><span class="journey-node-dot">${esc(initial)}</span><em>You</em></span>
        ${chosen.map((label, i) => `<span class="journey-node journey-node--scene" data-kind="${kindOf(label)}" style="--n:${i + 1}"><span class="journey-node-dot">${scene(label)}</span><em>${esc(label)}</em></span>`).join('')}
        <span class="journey-node journey-node--gaia" style="--n:${chosen.length + 1}"><span class="journey-node-dot"><img src="assets/gaia-mark.svg" alt=""></span><em>Gaia</em></span></div>
      <p class="journey-kicker">Made from what you shared</p><h1 tabindex="-1">Your Gaia Path</h1><p class="journey-subtitle">Your journey is ready, ${esc(state.name || 'friend')}.</p>
      <div class="journey-summary-grid">${branchCards}${looking.length ? `<section class="journey-summary journey-summary--looking" style="--card-index:${chosen.length}"><h2><i class="ph ph-sparkle" aria-hidden="true"></i>You’re looking for</h2>${list(looking, 0)}</section>` : ''}</div>
      <div class="journey-enter-wrap"><button type="button" class="journey-primary journey-primary--glow" data-enter>Enter Gaia →</button></div>`;
  }
  const introMarkup = () => `<div class="journey-fan" aria-hidden="true">${['Living Beings', 'Environment', 'Water'].map((l, i) => `<span class="journey-fan-card" style="--i:${i}">${scene(l)}<i class="ph ph-${BRANCH_ICON[kindOf(l)]}"></i></span>`).join('')}</div><p class="journey-kicker">${Object.keys(state.answers).length ? 'Welcome back' : 'Welcome'}, ${esc(state.name || 'friend')}</p><h1 tabindex="-1">Let’s discover<br>your Gaia path.</h1><p class="journey-subtitle">A little about you. A world of possibilities.<br>Help Gaia connect you with the education, tools and community that feel right.</p><p class="journey-duration"><i class="ph ph-clock" aria-hidden="true"></i> About 2 minutes · Saved as you go</p><button type="button" class="journey-primary journey-primary--glow" data-begin>${Object.keys(state.answers).length ? 'Continue my journey' : 'Begin my journey'} →</button>`;
  const AMBIENT = {
    '': '<path d="M-100 450 Q250 50 550 360 T1000 140"/><path d="M-100 500 Q300 120 550 410 T1000 200"/><ellipse cx="570" cy="330" rx="260" ry="120"/>',
    beings: '<g class="gj-amb-float"><circle cx="160" cy="180" r="3"/><circle cx="720" cy="120" r="2.5"/><circle cx="820" cy="460" r="3.5"/><circle cx="90" cy="520" r="2.5"/><circle cx="460" cy="90" r="2"/></g><path d="M-60 640C120 420 300 380 420 230S700 40 980 -40"/><path d="M420 230C380 160 300 130 230 140M560 120C600 60 680 40 760 50M300 360C230 330 150 340 90 380M660 330C740 300 820 320 900 360"/><path d="M-40 700C200 520 420 520 600 420S860 300 980 320"/>',
    environment: '<g class="gj-amb-grid"><path d="M-100 470H1000M-100 520H1000M-100 590H1000M-100 680H1000"/><path d="M450 430L-500 700M450 430L-150 700M450 430L150 700M450 430L450 700M450 430L750 700M450 430L1050 700M450 430L1400 700"/></g><path d="M-40 400C140 330 300 360 450 320S760 250 960 300" /><path d="M-40 360C140 290 300 320 450 280S760 210 960 260" opacity=".6"/><circle cx="720" cy="150" r="60"/><circle cx="720" cy="150" r="100" opacity=".5"/>',
    water: '<g class="gj-amb-ripple"><ellipse cx="640" cy="460" rx="120" ry="34"/><ellipse cx="640" cy="460" rx="240" ry="68"/><ellipse cx="640" cy="460" rx="380" ry="108"/><ellipse cx="640" cy="460" rx="540" ry="152"/></g><path d="M-60 220q60-24 120 0t120 0t120 0t120 0t120 0t120 0t120 0t120 0"/><path d="M-60 270q60-24 120 0t120 0t120 0t120 0t120 0t120 0t120 0t120 0" opacity=".6"/>',
  };
  function render() {
    if ((!state.authed && state.mode !== 'error') || state.mode === 'bypass') return;
    ensure();
    const content = state.mode === 'question' ? questionMarkup() : state.mode === 'reveal' ? revealMarkup() : state.mode === 'intro' ? introMarkup() : `<p class="journey-kicker">Your Gaia profile</p><h1 tabindex="-1">${state.mode === 'loading' ? 'Finding your path…' : 'Let’s reconnect.'}</h1><p class="journey-subtitle" role="status">${esc(state.error || 'Checking your saved Gaia profile.')}</p>${state.mode === 'error' ? '<button class="journey-primary" data-retry>Try again →</button>' : ''}`;
    const scene = `${state.mode}:${state.step || ''}`;
    const enter = scene !== renderedScene;
    const departing = enter && !reduced() && overlay.querySelector('.journey-stage')?.cloneNode(true);
    const departingTop = overlay.querySelector('.journey-stage')?.offsetTop;
    renderedScene = scene;
    overlay.dataset.branch = current()?.showIf || '';
    const ambientKind = current()?.showIf && state.mode === 'question' ? kindOf(current().showIf) : '';
    overlay.dataset.kind = ambientKind; overlay.dataset.mode = state.mode;
    overlay.innerHTML = `<div class="journey-ambient journey-ambient--${ambientKind || 'core'}" aria-hidden="true"><span></span><span></span><svg viewBox="0 0 900 650" preserveAspectRatio="xMidYMid slice">${AMBIENT[ambientKind]}</svg></div><header class="journey-header"><img src="assets/gaia-mark.svg" alt="Gaia Healers"><span>Your Gaia journey</span><button type="button" data-logout class="journey-secondary">Sign out</button></header><div class="journey-stage ${enter ? 'journey-enter journey-enter--' + state.mode : ''} ${state.mode === 'intro' && Object.keys(state.answers).length ? 'journey-resume' : ''}" data-branch="${esc(current()?.showIf || '')}">${content}${state.mode === 'question' ? '<button type="button" class="journey-assist-link" data-assist>Answer with Gaia Assist ↗</button>' : ''}</div>`;
    if (departing) {
      departing.querySelectorAll('h1').forEach(heading => { const echo = document.createElement('p'); echo.className = 'journey-departing-title'; echo.innerHTML = heading.innerHTML; heading.replaceWith(echo); });
      departing.querySelectorAll('*').forEach(node => { for (const attr of [...node.attributes]) if (attr.name.startsWith('data-')) node.removeAttribute(attr.name); });
      departing.className = 'journey-stage journey-outgoing'; departing.inert = true; departing.setAttribute('aria-hidden', 'true');
      departing.style.top = departingTop + 'px'; departing.style.marginLeft = '-'+ (overlay.querySelector('.journey-stage').getBoundingClientRect().width / 2) + 'px'; overlay.appendChild(departing);
      const animation = departing.animate([{ opacity: .35, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-12px)' }], { duration: 200, easing: 'ease-out' });
      animation.onfinish = () => departing.remove();
    }
    bind(overlay);
    renderEmbedded();
  }
  function renderEmbedded() {
    const transcript = document.querySelector('.gaia-assist__transcript');
    if (!transcript || state.mode !== 'question') { embedded?.remove(); embedded = null; return; }
    if (!embedded?.isConnected) { embedded = document.createElement('section'); embedded.className = 'journey-embedded'; transcript.appendChild(embedded); }
    embedded.dataset.kind = current()?.showIf ? kindOf(current().showIf) : '';
    embedded.innerHTML = `<p class="journey-kicker">Let’s build your Gaia path</p>${questionMarkup()}`;
    bind(embedded);
  }
  function bind(root) {
    root.querySelectorAll('[data-choice]').forEach(b => b.addEventListener('click', () => {
      const s = current(), label = b.dataset.choice;
      state.selected = s.multi ? state.selected.includes(label) ? state.selected.filter(v => v !== label) : [...state.selected, label] : [label];
      state.error = '';
      const needsText = !!s.freeText && state.selected.some(v => /^Other/.test(v));
      if (needsText !== !!root.querySelector('textarea')) { render(); }
      else for (const context of [overlay, embedded].filter(Boolean)) {
        context.querySelectorAll('[data-choice]').forEach(choice => {
          const active = state.selected.includes(choice.dataset.choice);
          choice.classList.toggle('is-selected', active);
          choice.setAttribute('aria-pressed', String(active));
        });
        if (s.key === 'primary_interests') {
          const links = linksFor(s, state.selected);
          context.querySelectorAll('.journey-path-card').forEach((card, i) => card.classList.toggle('is-linked', !!links[i]));
          const nodes = context.querySelector('.journey-path'); if (nodes) nodes.innerHTML = pathNodes();
        }
        context.querySelector('.journey-choices')?.setAttribute('data-count', state.selected.length);
        const next = context.querySelector('[data-next]');
        next.disabled = !state.selected.length && !s.freeTextOnly;
        next.textContent = s.key === 'primary_interests' && state.selected.length ? `Continue with ${state.selected.length} ${state.selected.length === 1 ? 'path' : 'paths'} →` : 'Continue →';
        context.querySelector('.journey-error').textContent = '';
      }
      const target = root.querySelector(`[data-choice="${CSS.escape(label)}"]`);
      if (target && !reduced()) {
        target.animate([{ transform: 'scale(.985)' }, { transform: state.selected.includes(label) ? 'translateY(-2px)' : 'none' }], { duration: 280, easing: 'ease-out' });
        const ring = document.createElement('span'); ring.className = 'journey-tap-ring'; ring.setAttribute('aria-hidden', 'true'); (target.querySelector('.journey-art') || target).appendChild(ring);
        ring.addEventListener('animationend', () => ring.remove(), { once: true });
        target.querySelector('.journey-tile-icon, .journey-check')?.animate([{ transform: 'scale(.94)' }, { transform: 'scale(1.1)' }, { transform: 'none' }], { duration: 320, easing: 'ease-out' });
      }
      target?.focus();
    }));
    root.querySelector('textarea')?.addEventListener('input', e => { state.text = e.target.value; });
    root.querySelector('[data-next]')?.addEventListener('click', save);
    root.querySelector('[data-back]')?.addEventListener('click', () => {
      const route = path(), i = route.findIndex(s => s.key === state.step);
      if (i > 0) chooseStep(route[i - 1].key); else { state.mode = 'intro'; render(); }
    });
    root.querySelector('[data-begin]')?.addEventListener('click', () => { log(Object.keys(state.answers).length ? 'resumed' : 'started'); document.dispatchEvent(new CustomEvent('gaia:analytics',{detail:{event:'gaia_assist_test_started',source:document.querySelector('.gaia-assist--open')?'assist':'journey'}})); chooseStep(state.nextStep || 'primary_interests'); });
    root.querySelector('[data-retry]')?.addEventListener('click', () => state.authed ? check(true) : window.GaiaAuth?.refresh());
    root.querySelector('[data-enter]')?.addEventListener('click', () => {
      if (!state.done) return;
      state.mode = 'bypass'; lock(false); window.GaiaAppGuard?.set('ready');
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
    let advanced = false;
    state.busy = true; state.error = ''; render();
    try {
      const result = await request('POST', { stepKey: s.key, selections: state.selected, freeText: state.text, complete: !!s.freeTextOnly, source: 'visual' });
      if (generation !== state.generation) return;
      log(s.freeTextOnly ? 'completed' : s.key === 'primary_interests' ? 'branch_selected' : 'step_saved', s.key);
      state.answers = result.answers;
      if (s.freeTextOnly) {
        if (!result.complete) throw new Error('Your profile is saved. Please retry to confirm completion.');
        state.done = true; state.mode = 'reveal'; document.dispatchEvent(new CustomEvent('gaia:analytics',{detail:{event:'gaia_assist_test_completed'}}));
      } else {
        const route = path(), index = route.findIndex(x => x.key === s.key);
        const next = route[index + 1];
        branchNotice = s.showIf && s.showIf !== next.showIf ? `✓ ${s.showIf} · ${next.showIf ? 'Now exploring ' + next.showIf : 'Your path is taking shape'}` : '';
        state.busy = false; chooseStep(next.key); advanced = true;
      }
    } catch (e) { log('step_save_failed', s.key); if (generation === state.generation) state.error = e.message; }
    finally { if (generation === state.generation) { state.busy = false; if (!advanced) render(); } }
  }
  function check(force = false) {
    if (!state.authed) return Promise.resolve(true);
    if (state.done && !force) return Promise.resolve(state.mode === 'bypass');
    if (checkPromise && !force) return checkPromise;
    const generation = state.generation;
    window.GaiaAppGuard?.set('checking_profile');
    state.mode = 'loading'; state.error = ''; render();
    checkPromise = request('GET').then(data => {
      if (generation !== state.generation) return false;
      state.schema = data.schema; state.answers = data.answers; state.name = data.member.name.split(/\s+/)[0]; state.nextStep = data.nextStep;
      if (data.state === 'complete') { state.done = true; state.mode = 'bypass'; lock(false); window.GaiaAppGuard?.set('ready'); if (force) document.dispatchEvent(new CustomEvent('gaia:onboarding-complete')); return true; }
      window.GaiaAppGuard?.set('onboarding_required'); state.mode = 'intro'; render(); return false;
    }).catch(e => { if (generation === state.generation) { window.GaiaAppGuard?.set('unavailable'); state.mode = 'error'; state.error = e.message; render(); } return false; });
    return checkPromise;
  }
  document.addEventListener('gaia:auth', e => {
    state.generation++; checkPromise = null; state.done = false;
    state.authed = !!e.detail?.authenticated;
    if (e.detail?.unavailable) { state.mode = 'error'; state.error = 'We’re having trouble loading your Gaia profile. Reload to try again.'; render(); return; }
    state.answers = {}; state.selected = []; state.text = ''; state.busy = false;
    if (state.authed) { check(); overlay?.querySelector('h1')?.focus(); } else { state.mode = 'bypass'; lock(false); window.GaiaAppGuard?.set('visitor'); }
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
          if (data.completedByTag) { state.done = true; state.mode = 'reveal'; document.dispatchEvent(new CustomEvent('gaia:analytics',{detail:{event:'gaia_assist_test_completed'}})); render(); }
          else chooseStep(data.nextStep || 'final_notes');
        } catch (_) {}
      }, 1200);
    }).observe(transcript, { childList: true });
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (document.querySelector('.gaia-assist__transcript')) watchAssist();
    else { const observer = new MutationObserver(() => { if (document.querySelector('.gaia-assist__transcript')) { observer.disconnect(); watchAssist(); } }); observer.observe(document.body, { childList: true }); }
  });
  window.GaiaJourney = { check, get context() { return state.mode === 'question' ? { screen: 'onboarding', step: state.step, branch: current()?.showIf || '' } : null; }, get complete() { return state.done && state.mode === 'bypass'; } };
})();
