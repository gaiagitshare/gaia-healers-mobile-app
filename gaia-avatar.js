/**
 * GAIA AVATAR — the character as a layer on top of what already exists.
 *
 * A floating Gaia (the approved sprout design, six states) that:
 *   - floats above the tab bar on phones and bottom-right on desktop,
 *     draggable, and remembers its side and height on this device;
 *   - on tap shows a speech bubble with three quick actions for THIS screen
 *     and THIS member, from a fixed table; a second tap opens Gaia Assist;
 *   - on press-and-hold starts voice, through the same path the orb uses;
 *   - mirrors the live Assist state (listening / thinking / speaking) by
 *     watching the orb's own data-state, so there is one source of truth;
 *   - points: when Assist opens something (readings, a screen) the avatar
 *     slides next to it with a guide ring, then goes home;
 *   - runs the tour on request, for members as well as guests.
 *
 * Nothing here calls a model or a server. Chips, bubbles, tours and
 * pointing are tables and DOM. Only a conversation the member starts, by
 * opening chat or holding to talk, reaches Gaia Assist, which bills as it
 * always has. The existing navigation, Assist, voice, readings and tab bar
 * are reused through their events and globals, never re-implemented:
 *   gaia:open-assist (chat), gaia:assist-voice (voice), GaiaAppShell.go,
 *   gaia:open-readings, GaiaTour.run, GaiaTools.open, GaiaAuth.open.
 */
(function () {
  'use strict';
  if (window.GaiaAvatar) return;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STORE = 'gaia-avatar-pos';   // { side: 'left'|'right', y: px from bottom } — this device only
  const HOLD_MS = 450;
  const SVG_DEFS = "<radialGradient id=\"gava-auraG\" cx=\"50%\" cy=\"50%\" r=\"50%\"><stop offset=\"0\" stop-color=\"#3fd9c8\" stop-opacity=\".55\"/><stop offset=\".55\" stop-color=\"#2fb9c9\" stop-opacity=\".22\"/><stop offset=\"1\" stop-color=\"#2fb9c9\" stop-opacity=\"0\"/></radialGradient>\n  <radialGradient id=\"gava-faceG\" cx=\"38%\" cy=\"30%\" r=\"80%\"><stop offset=\"0\" stop-color=\"#22395c\"/><stop offset=\".45\" stop-color=\"#121f36\"/><stop offset=\"1\" stop-color=\"#070d19\"/></radialGradient>\n  <linearGradient id=\"gava-ringG\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#8ff4ff\"/><stop offset=\".5\" stop-color=\"#4fc8ff\"/><stop offset=\"1\" stop-color=\"#3be0b8\"/></linearGradient>\n  <linearGradient id=\"gava-leafA\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#6ff0a0\"/><stop offset=\".55\" stop-color=\"#3fd9c8\"/><stop offset=\"1\" stop-color=\"#3aa7e8\"/></linearGradient>\n  <linearGradient id=\"gava-leafB\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#3fd1b8\"/><stop offset=\"1\" stop-color=\"#2b8fd6\"/></linearGradient>\n  <linearGradient id=\"gava-leafC\" x1=\"0\" y1=\"1\" x2=\"1\" y2=\"0\"><stop offset=\"0\" stop-color=\"#2a7fc0\"/><stop offset=\"1\" stop-color=\"#2fbfb0\"/></linearGradient>\n  <linearGradient id=\"gava-stemG\" x1=\"0\" y1=\"1\" x2=\"0\" y2=\"0\"><stop offset=\"0\" stop-color=\"#3fd9c8\"/><stop offset=\"1\" stop-color=\"#6ff0a0\"/></linearGradient>\n  <filter id=\"gava-soft\" x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\"><feGaussianBlur stdDeviation=\"6\"/></filter>\n  <filter id=\"gava-glowC\" x=\"-40%\" y=\"-40%\" width=\"180%\" height=\"180%\"><feGaussianBlur stdDeviation=\"2.2\" result=\"b\"/><feMerge><feMergeNode in=\"b\"/><feMergeNode in=\"b\"/><feMergeNode in=\"SourceGraphic\"/></feMerge></filter>\n  <filter id=\"gava-glowR\" x=\"-30%\" y=\"-30%\" width=\"160%\" height=\"160%\"><feGaussianBlur stdDeviation=\"3.5\" result=\"b\"/><feMerge><feMergeNode in=\"b\"/><feMergeNode in=\"SourceGraphic\"/></feMerge></filter>\n  <filter id=\"gava-leafShade\" x=\"-20%\" y=\"-20%\" width=\"140%\" height=\"140%\"><feDropShadow dx=\"0\" dy=\"2\" stdDeviation=\"2\" flood-color=\"#021018\" flood-opacity=\".55\"/></filter>";
  const SVG_BODY = "<svg viewBox=\"0 0 200 200\" aria-hidden=\"true\">\n  <!-- aura -->\n  <circle class=\"gava-aura\" cx=\"100\" cy=\"108\" r=\"74\" fill=\"url(#gava-auraG)\" filter=\"url(#gava-soft)\"/>\n  <circle class=\"gava-pulse p1\" cx=\"100\" cy=\"106\" r=\"66\"/><circle class=\"gava-pulse p2\" cx=\"100\" cy=\"106\" r=\"66\"/><circle class=\"gava-pulse p3\" cx=\"100\" cy=\"106\" r=\"66\"/>\n  <g class=\"gava-whole\">\n    <!-- back leaves: deeper blue-green, sit behind the face -->\n    <g class=\"gava-lb\" filter=\"url(#gava-leafShade)\">\n      <path d=\"M70 128 C 36 118, 12 150, 28 182 C 54 176, 76 154, 70 128 Z\" fill=\"url(#gava-leafC)\"/>\n      <path d=\"M130 128 C 164 118, 188 150, 172 182 C 146 176, 124 154, 130 128 Z\" fill=\"url(#gava-leafC)\"/>\n      <path d=\"M90 150 C 64 162, 56 192, 82 198 C 100 190, 102 168, 90 150 Z\" fill=\"url(#gava-leafB)\"/>\n      <path d=\"M110 150 C 136 162, 144 192, 118 198 C 100 190, 98 168, 110 150 Z\" fill=\"url(#gava-leafB)\"/>\n      <path d=\"M56 92 C 30 78, 10 92, 18 114 C 38 118, 54 110, 56 92 Z\" fill=\"url(#gava-leafC)\" opacity=\".9\"/>\n      <path d=\"M144 92 C 170 78, 190 92, 182 114 C 162 118, 146 110, 144 92 Z\" fill=\"url(#gava-leafC)\" opacity=\".9\"/>\n      <!-- midribs -->\n      <path d=\"M66 132 C 50 146, 38 162, 30 180\" fill=\"none\" stroke=\"#bff6ff\" stroke-width=\"1.4\" opacity=\".35\"/>\n      <path d=\"M134 132 C 150 146, 162 162, 170 180\" fill=\"none\" stroke=\"#bff6ff\" stroke-width=\"1.4\" opacity=\".35\"/>\n    </g>\n    <!-- front leaves: brighter green-to-cyan, overlapping the rim -->\n    <g class=\"gava-lf\" filter=\"url(#gava-leafShade)\">\n      <path d=\"M64 118 C 34 102, 8 124, 20 156 C 46 156, 66 140, 64 118 Z\" fill=\"url(#gava-leafA)\"/>\n      <path d=\"M136 118 C 166 102, 192 124, 180 156 C 154 156, 134 140, 136 118 Z\" fill=\"url(#gava-leafA)\"/>\n      <path d=\"M96 156 C 80 170, 82 194, 100 196 C 118 194, 120 170, 104 156 Z\" fill=\"url(#gava-leafA)\"/>\n      <path d=\"M60 126 C 46 136, 32 146, 24 154\" fill=\"none\" stroke=\"#e6fff8\" stroke-width=\"1.6\" opacity=\".45\"/>\n      <path d=\"M140 126 C 154 136, 168 146, 176 154\" fill=\"none\" stroke=\"#e6fff8\" stroke-width=\"1.6\" opacity=\".45\"/>\n      <path d=\"M100 160 L100 192\" fill=\"none\" stroke=\"#e6fff8\" stroke-width=\"1.6\" opacity=\".45\"/>\n      <!-- leaf highlights -->\n      <path d=\"M40 120 C 30 124, 22 132, 20 140\" fill=\"none\" stroke=\"#fff\" stroke-width=\"2\" opacity=\".18\" stroke-linecap=\"round\"/>\n      <path d=\"M160 120 C 170 124, 178 132, 180 140\" fill=\"none\" stroke=\"#fff\" stroke-width=\"2\" opacity=\".18\" stroke-linecap=\"round\"/>\n    </g>\n    <!-- the face: dark navy sphere with a luminous ring -->\n    <circle cx=\"100\" cy=\"106\" r=\"63\" fill=\"none\" stroke=\"#5fe4ff\" stroke-width=\"9\" opacity=\".32\" filter=\"url(#gava-glowR)\"/>\n    <circle cx=\"100\" cy=\"106\" r=\"60\" fill=\"url(#gava-faceG)\"/>\n    <circle cx=\"100\" cy=\"106\" r=\"60\" fill=\"none\" stroke=\"url(#gava-ringG)\" stroke-width=\"4.5\"/>\n    <circle cx=\"100\" cy=\"106\" r=\"55.5\" fill=\"none\" stroke=\"#9af6ff\" stroke-width=\"1.2\" opacity=\".35\"/>\n    <path d=\"M58 78 A 52 52 0 0 1 104 52\" fill=\"none\" stroke=\"#fff\" stroke-width=\"5\" opacity=\".10\" stroke-linecap=\"round\"/>\n    <ellipse cx=\"78\" cy=\"74\" rx=\"16\" ry=\"7\" fill=\"#fff\" opacity=\".07\" transform=\"rotate(-28 78 74)\"/>\n    <!-- sprout on top -->\n    <g class=\"gava-sprout\">\n      <path d=\"M100 48 C 100 40, 101 32, 104 24\" fill=\"none\" stroke=\"url(#gava-stemG)\" stroke-width=\"4.5\" stroke-linecap=\"round\"/>\n      <path d=\"M103 28 C 86 26, 70 10, 80 2 C 96 -2, 108 14, 103 28 Z\" fill=\"url(#gava-leafA)\" filter=\"url(#gava-leafShade)\"/>\n      <path d=\"M104 26 C 112 10, 132 2, 136 12 C 138 26, 118 32, 104 26 Z\" fill=\"url(#gava-leafA)\" filter=\"url(#gava-leafShade)\"/>\n      <path d=\"M102 26 C 94 18, 88 12, 84 6\" fill=\"none\" stroke=\"#e6fff8\" stroke-width=\"1.4\" opacity=\".5\"/>\n      <path d=\"M106 25 C 114 18, 122 12, 130 10\" fill=\"none\" stroke=\"#e6fff8\" stroke-width=\"1.4\" opacity=\".5\"/>\n      <circle cx=\"104\" cy=\"26\" r=\"3\" fill=\"#bfffe0\"/>\n    </g>\n    <!-- faces, in luminous cyan -->\n    <g class=\"gava-f gava-f-idle\" filter=\"url(#gava-glowC)\">\n      <path d=\"M68 108 q12 -14 24 0\" fill=\"none\" stroke=\"#86f0ff\" stroke-width=\"5\" stroke-linecap=\"round\"/>\n      <path d=\"M108 108 q12 -14 24 0\" fill=\"none\" stroke=\"#86f0ff\" stroke-width=\"5\" stroke-linecap=\"round\"/>\n    </g>\n    <g class=\"gava-f gava-f-speak\" filter=\"url(#gava-glowC)\">\n      <path d=\"M70 104 q11 -13 22 0\" fill=\"none\" stroke=\"#86f0ff\" stroke-width=\"5\" stroke-linecap=\"round\"/>\n      <path d=\"M108 104 q11 -13 22 0\" fill=\"none\" stroke=\"#86f0ff\" stroke-width=\"5\" stroke-linecap=\"round\"/>\n      <g class=\"gava-mouth\"><path d=\"M84 122 Q100 142 116 122 Z\" fill=\"#b57bff\"/><path d=\"M90 126 Q100 134 110 126 Z\" fill=\"#e3c6ff\" opacity=\".9\"/></g>\n      <g class=\"gava-marks\" stroke=\"#86f0ff\" stroke-width=\"3.5\" stroke-linecap=\"round\"><line x1=\"160\" y1=\"60\" x2=\"168\" y2=\"50\"/><line x1=\"166\" y1=\"74\" x2=\"178\" y2=\"70\"/></g>\n    </g>\n    <g class=\"gava-f gava-f-listen\" filter=\"url(#gava-glowC)\" stroke=\"#86f0ff\" stroke-width=\"5\" stroke-linecap=\"round\">\n      <line class=\"gava-bar\" x1=\"80\" y1=\"98\" x2=\"80\" y2=\"114\"/><line class=\"gava-bar\" x1=\"90\" y1=\"90\" x2=\"90\" y2=\"122\"/><line class=\"gava-bar\" x1=\"100\" y1=\"82\" x2=\"100\" y2=\"130\"/><line class=\"gava-bar\" x1=\"110\" y1=\"90\" x2=\"110\" y2=\"122\"/><line class=\"gava-bar\" x1=\"120\" y1=\"98\" x2=\"120\" y2=\"114\"/>\n    </g>\n    <g class=\"gava-f gava-f-think\" filter=\"url(#gava-glowC)\">\n      <ellipse cx=\"82\" cy=\"100\" rx=\"7\" ry=\"9\" fill=\"#86f0ff\"/><ellipse cx=\"118\" cy=\"100\" rx=\"7\" ry=\"9\" fill=\"#86f0ff\"/>\n      <circle cx=\"84\" cy=\"97\" r=\"2.2\" fill=\"#fff\"/><circle cx=\"120\" cy=\"97\" r=\"2.2\" fill=\"#fff\"/>\n      <path d=\"M88 124 q12 9 24 0\" fill=\"none\" stroke=\"#86f0ff\" stroke-width=\"4\" stroke-linecap=\"round\"/>\n      <circle class=\"gava-dot d1\" cx=\"150\" cy=\"52\" r=\"3.5\" fill=\"#86f0ff\"/><circle class=\"gava-dot d2\" cx=\"162\" cy=\"38\" r=\"4.5\" fill=\"#86f0ff\"/><circle class=\"gava-dot d3\" cx=\"178\" cy=\"22\" r=\"6\" fill=\"#86f0ff\"/>\n    </g>\n    <g class=\"gava-f gava-f-point\" filter=\"url(#gava-glowC)\">\n      <path d=\"M70 102 q11 -11 22 0\" fill=\"none\" stroke=\"#86f0ff\" stroke-width=\"5\" stroke-linecap=\"round\"/>\n      <path d=\"M112 92 l12 10 l-12 10\" fill=\"none\" stroke=\"#86f0ff\" stroke-width=\"5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\n      <path d=\"M88 124 q12 9 24 0\" fill=\"none\" stroke=\"#86f0ff\" stroke-width=\"4\" stroke-linecap=\"round\"/>\n    </g>\n    <!-- new-message badge and sparkles -->\n    <g class=\"gava-sparks\" stroke=\"#86f0ff\" stroke-width=\"3.5\" stroke-linecap=\"round\" filter=\"url(#gava-glowC)\"><line x1=\"158\" y1=\"66\" x2=\"168\" y2=\"58\"/><line x1=\"166\" y1=\"82\" x2=\"178\" y2=\"80\"/><line x1=\"30\" y1=\"60\" x2=\"22\" y2=\"52\"/></g>\n    <g class=\"gava-badge\"><path d=\"M138 22 h32 a10 10 0 0 1 10 10 v20 a10 10 0 0 1 -10 10 h-14 l-8 8 v-8 h-10 a10 10 0 0 1 -10 -10 v-20 a10 10 0 0 1 10 -10 z\" fill=\"#8b7cff\"/><text x=\"154\" y=\"52\" text-anchor=\"middle\" font-family=\"Plus Jakarta Sans, sans-serif\" font-weight=\"800\" font-size=\"26\" fill=\"#fff\">!</text></g>\n  </g>\n</svg>";

  // ── context: who is here, where, and what the app already knows ──────────
  const view = () => (window.GaiaAppShell?.currentView?.() || 'today');
  const authed = () => Boolean(window.GaiaMember?.authed);
  const profile = () => ((window.GaiaMember?.data?.profile?.profile) || {});
  const practitioner = () => Boolean(profile().practitioner);
  const readings = () => (window.GaiaMyReadings?.status?.() || {});
  const firstName = () => String(profile().name || '').trim().split(/\s+/)[0] || '';

  // ── actions: every chip maps to something the app already does ──────────
  const go = (v, opts) => { try { window.GaiaAppShell?.go?.(v, opts); } catch (_) { /* ignore */ } };
  const ACTIONS = {
    chat: { label: 'Chat with Gaia', icon: 'chat', run: () => openChat() },
    talk: { label: 'Talk to Gaia', icon: 'mic', run: () => startVoice() },
    energy: { label: 'Check my energy', icon: 'bolt', run: () => go('wellness', { tab: 'check' }) },
    tour: { label: 'Take a tour', icon: 'leaf', run: () => runTour() },
    signin: { label: 'Sign in', icon: 'user', run: () => { try { window.GaiaAuth?.open?.(); } catch (_) { /* ignore */ } } },
    readings: { label: 'Open my readings', icon: 'pulse', run: () => { go('profile'); setTimeout(() => window.dispatchEvent(new CustomEvent('gaia:open-readings')), 80); } },
    explain: { label: 'What do these mean?', icon: 'help', run: () => { go('profile'); setTimeout(() => { window.dispatchEvent(new CustomEvent('gaia:open-readings')); const d = document.querySelector('#member-readings .g-readings__explain'); if (d) d.open = true; }, 120); } },
    share: { label: 'Share my readings', icon: 'pulse', run: () => { go('profile'); setTimeout(() => window.dispatchEvent(new CustomEvent('gaia:open-readings')), 80); } },
    practice: { label: 'Open my practice', icon: 'users', run: () => { go('profile', { tab: 'practice' }); setTimeout(() => window.dispatchEvent(new CustomEvent('gaia:open-client', { detail: { section: 'clients' } })), 120); } },
    academy: { label: 'Continue learning', icon: 'book', run: () => go('academy') },
    community: { label: 'My communities', icon: 'users', run: () => go('community') },
    plans: { label: 'See membership plans', icon: 'star', run: () => go('store', { tab: 'membership' }) },
    breath: { label: 'A minute of breath', icon: 'leaf', run: () => { go('wellness'); requestAnimationFrame(() => { try { window.GaiaTools?.open?.('breath'); } catch (_) { /* ignore */ } }); } },
    later: { label: 'Later', icon: 'x', run: () => hideBubble() },
  };
  const ICONS = {
    chat: 'ph-chat-circle-dots', mic: 'ph-microphone', bolt: 'ph-lightning', leaf: 'ph-leaf', user: 'ph-user', pulse: 'ph-pulse',
    help: 'ph-question', users: 'ph-users-three', book: 'ph-book-open', star: 'ph-star', x: 'ph-x',
  };

  /** The bubble for this moment: text and up to three chips. A fixed table, never a model. */
  function bubbleFor() {
    const r = readings(), v = view(), name = firstName();
    if (r.new_reading) return { text: 'A new reading from your practitioner arrived. Want to see it?', chips: ['readings', 'later'], mood: 'new' };
    if (!authed()) return { text: 'Hi, I\'m Gaia. I can guide you around, or we can start with your energy.', chips: ['energy', 'tour', 'signin'] };
    const hello = name ? `Hi ${name}. ` : '';
    switch (v) {
      case 'profile': return r.linked
        ? { text: `${hello}Your readings are on this screen. What shall we do?`, chips: ['readings', 'explain', 'talk'] }
        : { text: `${hello}This is your account. Want to see your Bio-Well readings here?`, chips: ['share', practitioner() ? 'practice' : 'tour', 'talk'] };
      case 'wellness': return { text: `${hello}Choose what you need today.`, chips: ['energy', 'breath', 'talk'] };
      case 'academy': return { text: `${hello}Your courses live here.`, chips: ['academy', 'chat', 'talk'] };
      case 'community': return { text: `${hello}Your circles are here.`, chips: ['community', 'chat', 'talk'] };
      case 'store': return { text: `${hello}Looking for a plan or a product?`, chips: ['plans', 'chat', 'talk'] };
      default: return { text: `${hello}Ready when you are. What would you like to do?`, chips: [r.linked ? 'readings' : 'energy', practitioner() ? 'practice' : 'tour', 'talk'] };
    }
  }

  // ── the existing doors into Assist and voice ─────────────────────────────
  function openChat() { hideBubble(); window.dispatchEvent(new CustomEvent('gaia:open-assist', { detail: { source: 'avatar' } })); }
  function startVoice() { hideBubble(); window.dispatchEvent(new CustomEvent('gaia:assist-voice', { detail: { hold: 'start', source: 'avatar' } })); }
  function endVoiceHold() { window.dispatchEvent(new CustomEvent('gaia:assist-voice', { detail: { hold: 'end', source: 'avatar' } })); }

  /** The tour: the existing spotlight walk with steps for whoever is here. */
  function runTour() {
    hideBubble();
    const member = authed();
    const steps = [
      { sel: '.gaia-tabbar', eyebrow: 'Your navigation', title: 'Six places, one tap', body: 'Today, Energy, Academy, Community, Shop and You. Everything lives in the bar.' },
      { sel: '[data-app-nav="wellness"]', eyebrow: 'Energy', title: 'Your daily check', body: 'Energy, horoscope, chakras and the tools. Start the day here.' },
      { sel: '[data-app-nav="academy"]', eyebrow: 'Academy', title: 'Learn and get certified', body: member ? 'Your courses and progress.' : 'Courses open with a free account.' },
      { sel: '[data-app-nav="community"]', eyebrow: 'Community', title: 'Your circles', body: 'Boards and circles for the people on the same path.' },
      { sel: '[data-app-nav="profile"]', eyebrow: 'You', title: member ? 'Your account and readings' : 'Your account', body: member ? 'Your pass, your access, and My readings from your practitioner.' : 'Sign in to keep your readings and unlock more.' },
      { sel: '.gaia-tabbar__assist', eyebrow: 'Gaia', title: 'Ask me anything', body: 'The orb, or me: tap to chat, hold to talk. I can open any screen for you.' },
    ];
    if (window.GaiaTour?.run) window.GaiaTour.run(steps, { remember: !member });
  }

  // ── DOM ──────────────────────────────────────────────────────────────────
  let root, char, bubble, ring, pos = { side: 'right', y: null }, state = 'idle', bubbleTimer = null, pointing = false, homeTimer = null, pointedAt = 0;
  function build() {
    if (!document.getElementById('gava-defs')) {
      const d = document.createElement('div'); d.id = 'gava-defs'; d.setAttribute('aria-hidden', 'true');
      d.innerHTML = '<svg width="0" height="0" style="position:absolute"><defs>' + SVG_DEFS + '</defs></svg>';
      document.body.appendChild(d);
    }
    root = document.createElement('div'); root.className = 'gava'; root.dataset.side = 'right'; root.dataset.state = 'idle';
    root.innerHTML = '<div class="gava-bubble" role="dialog" aria-label="Gaia" hidden></div>'
      + '<button type="button" class="gava-char" aria-label="Gaia: tap for suggestions, hold to talk" aria-haspopup="dialog" aria-expanded="false">' + SVG_BODY + '</button>';
    document.body.appendChild(root);
    char = root.querySelector('.gava-char'); bubble = root.querySelector('.gava-bubble');
    ring = document.createElement('div'); ring.className = 'gava-ring'; ring.hidden = true; document.body.appendChild(ring);
  }

  // ── placement: phone above the tab bar, desktop bottom-right, remembered ─
  function tabbarInset() {
    const bar = document.querySelector('.gaia-tabbar');
    if (!bar) return 16;
    const r = bar.getBoundingClientRect();
    if (r.width < window.innerWidth * 0.5) return 16;              // the bar is a side rail: desktop
    return Math.max(16, Math.round(window.innerHeight - r.top) + 10);
  }
  function load() { try { const p = JSON.parse(localStorage.getItem(STORE) || 'null'); if (p && (p.side === 'left' || p.side === 'right')) pos = { side: p.side, y: Number.isFinite(p.y) ? p.y : null }; } catch (_) { /* ignore */ } }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(pos)); } catch (_) { /* ignore */ } }
  function home() {
    if (!root) return;
    const inset = tabbarInset();
    const minY = inset, maxY = Math.max(inset, window.innerHeight - 140);
    const y = pos.y == null ? inset : Math.min(maxY, Math.max(minY, pos.y));
    root.style.transition = reduced() ? 'none' : 'left .35s cubic-bezier(.2,.8,.3,1), right .35s cubic-bezier(.2,.8,.3,1), bottom .35s cubic-bezier(.2,.8,.3,1)';
    root.style.bottom = y + 'px'; root.style.top = 'auto';
    root.style.left = pos.side === 'left' ? '12px' : 'auto';
    root.style.right = pos.side === 'right' ? '12px' : 'auto';
    root.dataset.side = pos.side;
  }

  // ── states ───────────────────────────────────────────────────────────────
  function setState(s) { state = s; if (root) root.dataset.state = s; }
  /** Mirror the orb: the voice relay writes its state there, so the avatar never guesses. */
  function watchAssist() {
    const orb = document.querySelector('[data-gaia-tab-assist]');
    const map = { idle: 'idle', ready: 'listening', connecting: 'thinking', holding: 'listening', listening: 'listening', thinking: 'thinking', speaking: 'speaking', error: 'idle' };
    const sync = () => {
      if (pointing) return;
      const s = orb ? (orb.dataset.state || 'idle') : 'idle';
      setState(map[s] || 'idle');
      const open = document.body.classList.contains('gaia-assist-panel-open');
      root.classList.toggle('is-behind', open);
      if (open) hideBubble();
    };
    if (orb && 'MutationObserver' in window) new MutationObserver(sync).observe(orb, { attributes: true, attributeFilter: ['data-state'] });
    if ('MutationObserver' in window) new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    sync();
  }

  // ── bubble ───────────────────────────────────────────────────────────────
  function showBubble(spec, { sticky = false } = {}) {
    const b = spec || bubbleFor();
    bubble.innerHTML = '<button type="button" class="gava-bubble__x" aria-label="Close">×</button>'
      + '<p class="gava-bubble__text">' + esc(b.text) + '</p>'
      + '<div class="gava-bubble__chips">' + (b.chips || []).filter((k) => ACTIONS[k]).map((k) =>
        `<button type="button" class="gava-chip" data-act="${k}"><i class="ph ${ICONS[ACTIONS[k].icon] || 'ph-dot'}" aria-hidden="true"></i><span>${esc(ACTIONS[k].label)}</span><em aria-hidden="true">›</em></button>`).join('') + '</div>';
    bubble.hidden = false; char.setAttribute('aria-expanded', 'true');
    if (b.mood === 'new') setState('new'); else if (state === 'idle') setState('speaking');
    clearTimeout(bubbleTimer);
    if (!sticky) bubbleTimer = setTimeout(hideBubble, 25000);
  }
  function hideBubble() {
    if (!bubble || bubble.hidden) return;
    bubble.hidden = true; char.setAttribute('aria-expanded', 'false'); clearTimeout(bubbleTimer);
    if (!pointing && (state === 'speaking' || state === 'new')) setState('idle');
  }

  // ── pointing: slide next to a target with a guide ring, then go home ────
  function pointAt(target, { text = 'Here you go.', duration = 4200 } = {}) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el || !root) return false;
    // A tall target (the whole readings card) scrolls to its top; a small one to the middle.
    const tall = el.getBoundingClientRect().height > window.innerHeight * 0.6;
    try { el.scrollIntoView({ block: tall ? 'start' : 'center', behavior: reduced() ? 'auto' : 'smooth' }); } catch (_) { /* ignore */ }
    clearTimeout(homeTimer);
    pointedAt = Date.now();
    setTimeout(() => {
      const full = el.getBoundingClientRect();
      if (!full.width) return;
      // Ring the part that is on screen, so a card taller than the viewport is still ringed where the eye is.
      const top = Math.max(8, full.top), bottom = Math.min(window.innerHeight - 8, full.bottom);
      const r = { left: full.left, right: full.right, width: full.width, top, bottom, height: Math.max(40, bottom - top) };
      ring.hidden = false;
      ring.style.left = (r.left - 6) + 'px'; ring.style.top = (r.top - 6) + 'px'; ring.style.width = (r.width + 12) + 'px'; ring.style.height = (r.height + 12) + 'px';
      pointing = true; setState('pointing');
      // beside the target when there is room, otherwise just below it
      const size = root.getBoundingClientRect().width || 72;
      const left = r.left - size - 14 >= 8;
      root.style.transition = reduced() ? 'none' : 'left .4s cubic-bezier(.2,.8,.3,1), top .4s cubic-bezier(.2,.8,.3,1), bottom .4s, right .4s';
      root.style.bottom = 'auto'; root.style.right = 'auto';
      root.style.left = (left ? r.left - size - 14 : Math.min(window.innerWidth - size - 12, Math.max(12, r.right - size))) + 'px';
      root.style.top = (left ? Math.max(8, r.top + r.height / 2 - size / 2) : Math.min(window.innerHeight - size - 8, r.bottom + 10)) + 'px';
      root.dataset.side = left ? 'left' : 'right';
      showBubble({ text, chips: [] }, { sticky: true });
      homeTimer = setTimeout(unpoint, duration);
    }, reduced() ? 50 : 420);
    return true;
  }
  function unpoint() {
    clearTimeout(homeTimer);
    ring.hidden = true; pointing = false; hideBubble(); setState('idle'); home();
  }

  // ── gestures: tap, hold, drag ────────────────────────────────────────────
  function gestures() {
    let down = null, moved = false, holding = false, holdTimer = null, startPos = null;
    char.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, id: e.pointerId }; moved = false; holding = false;
      const r = root.getBoundingClientRect(); startPos = { left: r.left, top: r.top };
      try { char.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      holdTimer = setTimeout(() => { if (!moved && down) { holding = true; root.classList.add('is-holding'); if (pointing) unpoint(); startVoice(); } }, HOLD_MS);
    });
    char.addEventListener('pointermove', (e) => {
      if (!down || holding) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 7) return;
      if (!moved) { moved = true; clearTimeout(holdTimer); hideBubble(); if (pointing) { clearTimeout(homeTimer); ring.hidden = true; pointing = false; } root.classList.add('is-dragging'); root.style.transition = 'none'; }
      const size = root.getBoundingClientRect().width;
      root.style.right = 'auto'; root.style.bottom = 'auto';
      root.style.left = Math.min(window.innerWidth - size, Math.max(0, startPos.left + dx)) + 'px';
      root.style.top = Math.min(window.innerHeight - size, Math.max(0, startPos.top + dy)) + 'px';
    });
    const end = (e) => {
      if (!down) return;
      clearTimeout(holdTimer);
      const wasHold = holding, wasMove = moved; down = null; holding = false; moved = false;
      root.classList.remove('is-holding', 'is-dragging');
      if (wasHold) { endVoiceHold(); return; }
      if (wasMove) {
        const r = root.getBoundingClientRect();
        pos.side = (r.left + r.width / 2) < window.innerWidth / 2 ? 'left' : 'right';
        pos.y = Math.round(window.innerHeight - r.bottom);
        save(); setState('idle'); home(); return;
      }
      if (e.type === 'pointercancel') return;
      if (pointing) { unpoint(); return; }
      if (bubble.hidden) showBubble(); else openChat();
    };
    char.addEventListener('pointerup', end); char.addEventListener('pointercancel', end);
    char.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (bubble.hidden) showBubble(); else openChat(); } if (e.key === 'Escape') hideBubble(); });
    bubble.addEventListener('click', (e) => {
      const x = e.target.closest('.gava-bubble__x'); if (x) { hideBubble(); return; }
      const chip = e.target.closest('[data-act]'); if (!chip) return;
      const act = ACTIONS[chip.dataset.act]; if (!act) return;
      if (chip.dataset.act !== 'later') hideBubble();
      act.run();
    });
    document.addEventListener('pointerdown', (e) => { if (!root.contains(e.target)) hideBubble(); }, true);
  }

  // ── what the rest of the app tells us ─────────────────────────────────────
  function listen() {
    window.addEventListener('resize', () => { if (!pointing) home(); else unpoint(); });
    // The ring is fixed to where the target was; once the member scrolls on, it goes.
    window.addEventListener('scroll', () => { if (pointing && Date.now() - pointedAt > 1200) unpoint(); }, { passive: true });
    document.addEventListener('gaia:view-changed', () => { if (pointing) unpoint(); else hideBubble(); });
    // Assist opened the readings: point at them.
    window.addEventListener('gaia:open-readings', () => { setTimeout(() => pointAt('#member-readings', { text: 'Here are your readings.' }), 500); });
    // Assist moved the screen (voice or chat navigate): point at the page head.
    window.addEventListener('gaia:assist-minimize', (e) => {
      const d = e.detail || {}; if (!d.screen || d.screen === 'profile') return;
      setTimeout(() => { const s = document.querySelector('.gaia-screen.is-active .g-page__head, .gaia-screen.is-active .g-super-hero'); if (s) pointAt(s, { text: 'Here you go.', duration: 3200 }); }, 600);
    });
    // The readings panel tells us when a new reading is waiting.
    window.addEventListener('gaia:readings-status', (e) => { const d = e.detail || {}; if (d.new_reading && bubble.hidden && !document.body.classList.contains('gaia-assist-panel-open')) showBubble(bubbleFor()); });
    window.addEventListener('gaia:signed-out', () => { hideBubble(); setState('idle'); });
  }

  function mount() {
    if (!document.querySelector('.gaia-tabbar') && !document.querySelector('[data-gaia-tab-assist]')) { setTimeout(mount, 400); return; }
    load(); build(); home(); gestures(); listen(); watchAssist();
    setTimeout(home, 600);
  }
  window.GaiaAvatar = { pointAt, unpoint, showBubble, hideBubble, setState, bubbleFor, runTour, home };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
