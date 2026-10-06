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
  /** Move the screen, then point at where the member landed: the page head of the active screen. */
  const goAndPoint = (v, opts, text) => { go(v, opts); setTimeout(() => { const s = document.querySelector('.gaia-screen.is-active .g-page__head, .gaia-screen.is-active .g-super-hero, .gaia-screen.is-active .gg-hero, .gaia-screen.is-active main'); if (s) pointAt(s, { text: text || 'Here you go.', duration: 3200 }); }, 520); };
  const ACTIONS = {
    chat: { label: 'Chat with Gaia', icon: 'chat', run: () => openChat() },
    talk: { label: 'Talk to Gaia', icon: 'mic', run: () => startVoice() },
    energy: { label: 'Check my energy', icon: 'bolt', run: () => goAndPoint('wellness', { tab: 'check' }, 'Your energy check is here.') },
    tour: { label: 'Take a tour', icon: 'leaf', run: () => runTour() },
    signin: { label: 'Sign in', icon: 'user', run: () => { try { window.GaiaAuth?.open?.(); } catch (_) { /* ignore */ } } },
    readings: { label: 'Open my readings', icon: 'pulse', run: () => { go('profile'); setTimeout(() => window.dispatchEvent(new CustomEvent('gaia:open-readings')), 80); } },
    explain: { label: 'What do these mean?', icon: 'help', run: () => explainReadings() },
    next: { label: 'Next', icon: 'next', run: () => guideStep(guide.i + 1) },
    done: { label: 'Done', icon: 'check', run: () => endGuide() },
    share: { label: 'Share my readings', icon: 'pulse', run: () => { go('profile'); setTimeout(() => window.dispatchEvent(new CustomEvent('gaia:open-readings')), 80); } },
    practice: { label: 'Open my practice', icon: 'users', run: () => { go('profile', { tab: 'practice' }); setTimeout(() => window.dispatchEvent(new CustomEvent('gaia:open-client', { detail: { section: 'clients' } })), 120); } },
    academy: { label: 'Continue learning', icon: 'book', run: () => goAndPoint('academy', undefined, 'Your courses are here.') },
    community: { label: 'My communities', icon: 'users', run: () => goAndPoint('community', undefined, 'Your circles are here.') },
    plans: { label: 'See membership plans', icon: 'star', run: () => goAndPoint('store', { tab: 'membership' }, 'The plans are here.') },
    breath: { label: 'A minute of breath', icon: 'leaf', run: () => { go('wellness'); requestAnimationFrame(() => { try { window.GaiaTools?.open?.('breath'); } catch (_) { /* ignore */ } }); } },
    later: { label: 'Not now', icon: 'x', run: () => hideBubble() },
    startfree: { label: 'Show me what is free', icon: 'book', run: () => { const h = [...document.querySelectorAll('[data-screen="academy"] .g-section__title, [data-screen="academy"] h2')].find((n) => /start free/i.test(n.textContent)); if (h) { h.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); pointAt(h, { text: 'Open to everyone.', duration: 2600 }); } } },
    nextlevel: { label: 'Show my next level', icon: 'star', run: () => { go('profile'); setTimeout(() => { const n = document.querySelector('[data-next-level]'); if (n) { n.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' }); pointAt(n, { text: 'What it would add for you.', duration: 3000 }); } }, 450); } },
    clientlatest: { label: 'Open the latest reading', icon: 'pulse', run: () => { const b = document.querySelector('[data-prac-open="latest"]'); const body = document.querySelector('[data-prac-body="latest"]'); if (b && body && body.hidden) b.click(); if (b) b.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' }); } },
  };
  const ICONS = {
    chat: 'ph-chat-circle-dots', mic: 'ph-microphone', bolt: 'ph-lightning', leaf: 'ph-leaf', user: 'ph-user', pulse: 'ph-pulse',
    help: 'ph-question', users: 'ph-users-three', book: 'ph-book-open', star: 'ph-star', x: 'ph-x', next: 'ph-arrow-right', check: 'ph-check',
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
      case 'daily': return { text: `${hello}This is your day: energy, sky, readings, your next session.`, chips: ['energy', r.linked ? 'readings' : 'breath', 'talk'] };
      case 'wellness': return { text: `${hello}Choose what you need today.`, chips: ['energy', 'breath', 'talk'] };
      case 'academy': return { text: `${hello}Your courses live here.`, chips: ['academy', 'chat', 'talk'] };
      case 'community': return { text: `${hello}Your circles are here.`, chips: ['community', 'chat', 'talk'] };
      case 'store': return { text: `${hello}Looking for a plan or a product?`, chips: ['plans', 'chat', 'talk'] };
      default: return { text: `${hello}Ready when you are. What would you like to do?`, chips: [r.linked ? 'readings' : 'energy', practitioner() ? 'practice' : 'tour', 'talk'] };
    }
  }

  // ── the existing doors into Assist and voice ─────────────────────────────
  /**
   * The conversation happens here, in her bubble. The engine behind it is the
   * existing Gaia Assist (history, tools, voice, billing, unchanged); its own
   * sheet stays hidden (body.gaia-assist-headless) and this bubble mirrors
   * the transcript and sends through the engine's doors.
   */
  function openChat(typed) {
    const text = String(typed || '').trim().slice(0, 1000);
    showConvo();
    if (text) { window.dispatchEvent(new CustomEvent('gaia:assist-send', { detail: { text, source: 'avatar' } })); setState('thinking'); }
    else window.dispatchEvent(new CustomEvent('gaia:open-assist', { detail: { source: 'avatar', greeting: greetingLine() } }));
  }
  let convoOpen = false, mirror = null, speakTimer = null, voiceOn = false;
  function convoStatusText() {
    const s = document.querySelector('.gaia-assist__status')?.textContent?.trim();
    return voiceOn ? (s || 'Listening…') : (state === 'thinking' ? 'Gaia is thinking…' : '');
  }
  function renderConvo() {
    const log = bubble.querySelector('.gava-log'); if (!log) return;
    const src = document.querySelector('.gaia-assist__transcript');
    const items = src ? [...src.querySelectorAll('.gaia-assist__bubble')].slice(-12) : [];
    log.innerHTML = items.map((b) => `<p class="gava-msg ${b.classList.contains('gaia-assist__bubble--user') ? 'is-me' : 'is-gaia'}">${esc(b.textContent)}</p>`).join('')
      || '<p class="gava-msg is-gaia is-faint">Say or type anything.</p>';
    // the engine's one-tap follow-up (open a screen, sign in, support), forwarded to the real button
    const route = document.querySelector('.gaia-assist__route:not([hidden]) .gaia-assist__route-btn');
    const rb = bubble.querySelector('.gava-route'); if (rb) { rb.hidden = !route; if (route) rb.textContent = route.textContent; }
    const st = bubble.querySelector('.gava-convo__status'); if (st) st.textContent = convoStatusText();
    const mic = bubble.querySelector('.gava-mic'); if (mic) { mic.classList.toggle('is-on', voiceOn); mic.setAttribute('aria-pressed', String(voiceOn)); mic.title = voiceOn ? 'Stop talking' : 'Talk to Gaia'; }
    log.scrollTop = log.scrollHeight;
  }
  function showConvo() {
    touched(); clearTimeout(bubbleTimer); convoOpen = true;
    bubble.className = 'gava-bubble gava-bubble--talk';
    bubble.innerHTML = '<div class="gava-convo__head"><span class="gava-convo__name">Gaia</span><span class="gava-convo__status" aria-live="polite"></span><button type="button" class="gava-bubble__x" aria-label="End the conversation">×</button></div>'
      + '<div class="gava-log" aria-live="polite"></div>'
      + '<button type="button" class="gava-route" hidden></button>'
      + '<form class="gava-bubble__ask"><input type="text" class="gava-bubble__input" placeholder="Type to Gaia…" aria-label="Type to Gaia" autocomplete="off" maxlength="1000"><button type="button" class="gava-mic" aria-label="Talk to Gaia" aria-pressed="false"><i class="ph ph-microphone" aria-hidden="true"></i></button><button type="submit" class="gava-bubble__send" aria-label="Send"><i class="ph ph-paper-plane-right" aria-hidden="true"></i></button></form>';
    bubble.hidden = false; char.setAttribute('aria-expanded', 'true');
    if (!mirror && 'MutationObserver' in window) {
      const src = document.querySelector('.gaia-assist__transcript');
      if (src) { mirror = new MutationObserver(() => { renderConvo(); if (!voiceOn) { setState('speaking'); clearTimeout(speakTimer); speakTimer = setTimeout(() => { if (!voiceOn && convoOpen) setState('idle'); }, 1400); } }); mirror.observe(src, { childList: true, subtree: true, characterData: true }); }
      const status = document.querySelector('.gaia-assist__status');
      if (status) new MutationObserver(renderConvo).observe(status, { childList: true, characterData: true, subtree: true });
    }
    renderConvo();
    setTimeout(() => { try { bubble.querySelector('.gava-bubble__input')?.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }, 80);
  }
  function endConvo() {
    convoOpen = false; voiceOn = false; bubble.className = 'gava-bubble';
    window.dispatchEvent(new CustomEvent('gaia:assist-close'));
    hideBubble(); setState('idle');
  }
  /** One local line so the sheet never opens empty. Written here, shown by the shell, never sent to a model. */
  function greetingLine() {
    const name = firstName(), r = readings(), v = view();
    const who = name ? `Hi ${name}. ` : 'Hi. ';
    if (r.new_reading) return who + 'A new reading from your practitioner is waiting. Ask me to open it, or ask me anything.';
    if (v === 'profile' && r.linked) return who + 'Your readings are on this screen. I can explain what the sections mean, or open anything for you.';
    if (v === 'daily') return who + 'This is your day. Ask me about your energy check, the sky, or anything in the app.';
    return who + 'I\'m here. Ask me anything about the app, your energy or your readings, or tell me where to go.';
  }
  /** The tap itself gets a reaction: a quick hop, whatever else follows. */
  function hop() { if (!root || reduced()) return; root.classList.add('is-hop'); setTimeout(() => root.classList.remove('is-hop'), 650); }
  function startVoice() { window.dispatchEvent(new CustomEvent('gaia:assist-voice', { detail: { hold: 'start', source: 'avatar' } })); }
  function endVoiceHold() { window.dispatchEvent(new CustomEvent('gaia:assist-voice', { detail: { hold: 'end', source: 'avatar' } })); }

  /** The tour: the existing spotlight walk with steps for whoever is here. */
  function runTour() {
    hideBubble();
    const member = authed();
    if (window.GaiaTour?.run) window.GaiaTour.run(undefined, { remember: !member });
  }

  // ── "What do these mean?": a step-by-step walk through the member's own readings card ──
  // The steps and their words come from GaiaMyReadings.guide() (fixed wording,
  // arithmetic on the screen's own numbers, no model). Gaia only points.
  const guide = { steps: [], i: -1 };
  function explainReadings() {
    go('profile');
    setTimeout(() => window.dispatchEvent(new CustomEvent('gaia:open-readings', { detail: { guide: true } })), 80);
    let tries = 0;
    const start = () => {
      const steps = window.GaiaMyReadings?.guide?.() || [];
      if (steps.length) { guide.steps = steps; guideStep(0); return; }
      // Readings still loading: wait a little (the first load can take ~20s), then fall back to the definitions.
      if (++tries < 40) { setTimeout(start, 500); return; }
      const d = document.querySelector('#member-readings .g-readings__explain'); if (d) { d.open = true; pointAt(d, { text: 'Short definitions of each measure are here.' }); }
    };
    setTimeout(start, 600);
  }
  function guideStep(i) {
    const step = guide.steps[i];
    if (!step) { endGuide(); return; }
    guide.i = i;
    const el = step.el && step.el.isConnected ? step.el : (step.sel ? document.querySelector('#member-readings ' + step.sel) : null);
    if (!el) { guideStep(i + 1); return; }
    if (step.open) step.open.open = true;
    const last = i === guide.steps.length - 1;
    pointAt(el, { text: `${i + 1} of ${guide.steps.length} · ${step.text}`, chips: last ? ['done'] : ['next', 'done'], duration: 0 });
  }
  const endGuide = () => unpoint();

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
  /** Mirror the shell: it announces every conversation state (gaia:assist-state), so the avatar never guesses. */
  function watchAssist() {
    document.body.classList.add('gaia-assist-headless');   // the engine's own sheet never shows; she is the surface
    const map = { idle: 'idle', ready: 'listening', connecting: 'thinking', holding: 'listening', listening: 'listening', thinking: 'thinking', speaking: 'speaking', error: 'idle' };
    let assistState = 'idle';
    const sync = () => {
      const open = document.body.classList.contains('gaia-assist-panel-open');
      // Something else opened the conversation (Today's Ask Gaia, a deep link): show it here.
      if (open && !convoOpen) showConvo();
      if (!open && convoOpen) { convoOpen = false; voiceOn = false; bubble.className = 'gava-bubble'; hideBubble(); }
      if (pointing) return;
      if (['listening', 'holding', 'ready'].includes(assistState)) voiceOn = true;
      if (assistState === 'idle' || assistState === 'error') voiceOn = false;
      setState(map[assistState] || 'idle');
      if (convoOpen) renderConvo();
    };
    document.addEventListener('gaia:assist-state', (e) => { assistState = e.detail?.state || 'idle'; sync(); });
    if ('MutationObserver' in window) new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    sync();
  }

  // ── bubble ───────────────────────────────────────────────────────────────
  function showBubble(spec, { sticky = false } = {}) {
    if (document.querySelector('.gaia-tour')) return;
    delete bubble.dataset.practiceWelcome;
    const b = spec || bubbleFor();
    touched();
    bubble.innerHTML = '<button type="button" class="gava-bubble__x" aria-label="Close">×</button>'
      + '<p class="gava-bubble__text">' + esc(b.text) + '</p>'
      + '<div class="gava-bubble__chips">' + (b.chips || []).filter((k) => ACTIONS[k]).map((k) =>
        `<button type="button" class="gava-chip${k === 'later' ? ' gava-chip--quiet' : ''}" data-act="${k}"><i class="ph ${ICONS[ACTIONS[k].icon] || 'ph-dot'}" aria-hidden="true"></i><span>${esc(ACTIONS[k].label)}</span><em aria-hidden="true">›</em></button>`).join('') + '</div>'
      // Typing here opens the conversation with the words already in the box; nothing is sent until the member sends it.
      + ((b.chips || []).length && !b.quiet ? '<form class="gava-bubble__ask"><input type="text" class="gava-bubble__input" placeholder="Or type to Gaia…" aria-label="Type to Gaia" autocomplete="off" maxlength="300"><button type="submit" class="gava-bubble__send" aria-label="Open the conversation"><i class="ph ph-paper-plane-right" aria-hidden="true"></i></button></form>' : '');
    bubble.hidden = false; char.setAttribute('aria-expanded', 'true');
    if (b.mood === 'new') setState('new'); else if (state === 'idle') setState('speaking');
    clearTimeout(bubbleTimer);
    if (!sticky) bubbleTimer = setTimeout(hideBubble, b.quiet ? 20000 : 25000);
  }
  function hideBubble() {
    if (!bubble || bubble.hidden) return;
    bubble.hidden = true; char.setAttribute('aria-expanded', 'false'); clearTimeout(bubbleTimer);
    if (!convoOpen) bubble.className = 'gava-bubble';
    if (!pointing && (state === 'speaking' || state === 'new')) setState('idle');
  }

  // ── pointing: slide next to a target with a guide ring, then go home ────
  function pointAt(target, { text = 'Here you go.', duration = 4200, chips = [] } = {}) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el || !root) return false;
    // A tall target (the whole readings card) scrolls to its top; a small one to the middle.
    const tall = el.getBoundingClientRect().height > window.innerHeight * 0.6;
    try { el.scrollIntoView({ block: tall ? 'start' : 'center', behavior: reduced() ? 'auto' : 'smooth' }); } catch (_) { /* ignore */ }
    clearTimeout(homeTimer);
    pointedAt = Date.now();
    // Measured after the scroll settles; may run twice when the target first has to move up to make room.
    let lastTop = null, waits = 0;
    const place = (canScroll) => {
      const full = el.getBoundingClientRect();
      if (!full.width) return;
      // A smooth scroll may still be moving the page: measure again until it stands still (bounded).
      if ((lastTop === null || Math.abs(full.top - lastTop) > 1) && waits++ < 8) { lastTop = full.top; setTimeout(() => place(canScroll), 120); return; }
      lastTop = null; waits = 0;
      // Ring the part that is on screen, so a card taller than the viewport is still ringed where the eye is.
      const top = Math.max(8, full.top), bottom = Math.min(window.innerHeight - 8, full.bottom);
      const r = { left: full.left, right: full.right, width: full.width, top, bottom, height: Math.max(40, bottom - top) };
      ring.hidden = false;
      ring.style.left = (r.left - 6) + 'px'; ring.style.top = (r.top - 6) + 'px'; ring.style.width = (r.width + 12) + 'px'; ring.style.height = (r.height + 12) + 'px';
      pointing = true; setState('pointing');
      // The bubble first, so the whole of her (bubble and character) can be
      // measured and placed clear of the target: beside it, then below, then
      // above; when the target fills the screen, in her usual corner.
      showBubble({ text, chips, quiet: chips.length > 0 }, { sticky: true });
      root.style.transition = 'none'; root.style.left = '0px'; root.style.top = '0px'; root.style.bottom = 'auto'; root.style.right = 'auto';
      const box = root.getBoundingClientRect(), w = box.width, h = box.height, gap = 12, vw = window.innerWidth, vh = window.innerHeight;
      const floor = vh - tabbarInset() + 6;   // keep above the phone tab bar
      const fitsY = (y) => y >= 8 && y + h <= floor;
      const midY = Math.min(floor - h, Math.max(8, r.top + r.height / 2 - h / 2));
      let spot = null;
      if (r.left - w - gap >= 8 && fitsY(midY)) spot = { left: r.left - w - gap, top: midY, side: 'left' };
      else if (r.right + gap + w <= vw - 8 && fitsY(midY)) spot = { left: r.right + gap, top: midY, side: 'right' };
      else if (fitsY(r.bottom + gap)) spot = { left: vw - w - 12, top: r.bottom + gap, side: 'right' };
      else if (fitsY(r.top - gap - h)) spot = { left: vw - w - 12, top: r.top - gap - h, side: 'right' };
      // No room on a phone: lift the target to just under the top bar so she fits below it, then place again.
      const head = Math.max(8, Math.round(document.querySelector('.g-topbar')?.getBoundingClientRect().bottom || 64)) + 8;
      if (!spot && canScroll && full.height + gap + h <= floor - head) {
        ring.hidden = true; root.style.left = (vw - w - 12) + 'px'; root.style.top = (floor - h) + 'px';
        pointedAt = Date.now();
        try { window.scrollBy({ top: full.top - head, behavior: reduced() ? 'auto' : 'smooth' }); } catch (_) { window.scrollBy(0, full.top - head); }
        setTimeout(() => place(false), reduced() ? 50 : 450);
        return;
      }
      root.style.transition = reduced() ? 'none' : 'left .4s cubic-bezier(.2,.8,.3,1), top .4s cubic-bezier(.2,.8,.3,1), bottom .4s, right .4s';
      if (spot) { root.style.left = Math.max(8, spot.left) + 'px'; root.style.top = spot.top + 'px'; root.dataset.side = spot.side; }
      else home();
      if (duration) homeTimer = setTimeout(unpoint, duration);
    };
    setTimeout(() => place(true), reduced() ? 50 : 420);
    return true;
  }
  function unpoint() {
    clearTimeout(homeTimer); guide.steps = []; guide.i = -1;
    ring.hidden = true; pointing = false; hideBubble(); setState('idle'); home();
  }

  // ── gestures: tap, hold, drag ────────────────────────────────────────────
  function gestures() {
    let down = null, moved = false, holding = false, holdTimer = null, startPos = null;
    char.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      touched();
      down = { x: e.clientX, y: e.clientY, id: e.pointerId }; moved = false; holding = false;
      const r = root.getBoundingClientRect(); startPos = { left: r.left, top: r.top };
      try { char.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      holdTimer = setTimeout(() => { if (!moved && down) { holding = true; root.classList.add('is-holding'); if (pointing) unpoint(); if (!convoOpen) showConvo(); voiceOn = true; renderConvo(); startVoice(); } }, HOLD_MS);
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
      hop();
      if (convoOpen) { if (bubble.hidden) { bubble.hidden = false; char.setAttribute('aria-expanded', 'true'); renderConvo(); } else { bubble.hidden = true; char.setAttribute('aria-expanded', 'false'); } return; }
      if (bubble.hidden) showBubble(); else openChat();
    };
    char.addEventListener('pointerup', end); char.addEventListener('pointercancel', end);
    char.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hop(); if (bubble.hidden) showBubble(); else openChat(); } if (e.key === 'Escape') hideBubble(); });
    bubble.addEventListener('submit', (e) => { e.preventDefault(); const input = bubble.querySelector('.gava-bubble__input'); const v = input?.value || ''; if (!v.trim()) return; if (input) input.value = ''; openChat(v); });
    bubble.addEventListener('click', (e) => {
      const x = e.target.closest('.gava-bubble__x'); if (x) { if (convoOpen) endConvo(); else hideBubble(); return; }
      const mic = e.target.closest('.gava-mic'); if (mic) { if (voiceOn) { voiceOn = false; window.dispatchEvent(new CustomEvent('gaia:assist-voice', { detail: { hold: 'stop', source: 'avatar' } })); } else { voiceOn = true; window.dispatchEvent(new CustomEvent('gaia:assist-voice', { detail: { hold: 'start', source: 'avatar' } })); } renderConvo(); return; }
      const route = e.target.closest('.gava-route'); if (route) { document.querySelector('.gaia-assist__route:not([hidden]) .gaia-assist__route-btn')?.click(); return; }
      const chip = e.target.closest('[data-act]'); if (!chip) return;
      const act = ACTIONS[chip.dataset.act]; if (!act) return;
      if (chip.dataset.act !== 'later') hideBubble();
      act.run();
    });
    // A tap elsewhere closes the bubble; during the readings walk-through it ends the walk (ring and all).
    document.addEventListener('pointerdown', (e) => { if (!root.contains(e.target)) { if (guide.i >= 0) unpoint(); else hideBubble(); } }, true);
  }

  // ── what the rest of the app tells us ─────────────────────────────────────
  function listen() {
    window.addEventListener('resize', () => { if (!pointing) home(); else unpoint(); });
    // The ring is fixed to where the target was; once the member scrolls on, it goes.
    window.addEventListener('scroll', () => { if (pointing && Date.now() - pointedAt > 1200) unpoint(); }, { passive: true });
    document.addEventListener('gaia:view-changed', () => { if (pointing) unpoint(); else hideBubble(); });
    // Assist opened the readings: point at them.
    window.addEventListener('gaia:open-readings', (e) => { if (e.detail?.guide) return; setTimeout(() => pointAt('#member-readings', { text: 'Here are your readings.' }), 500); });
    // Assist moved the screen (voice or chat navigate): point at the page head.
    window.addEventListener('gaia:assist-minimize', (e) => {
      const d = e.detail || {}; if (!d.screen || d.screen === 'profile') return;
      setTimeout(() => { const s = document.querySelector('.gaia-screen.is-active .g-page__head, .gaia-screen.is-active .g-super-hero, .gaia-screen.is-active .gg-hero'); if (s) pointAt(s, { text: 'Here you go.', duration: 3200 }); }, 600);
    });
    // The readings panel tells us when a new reading is waiting.
    window.addEventListener('gaia:readings-status', (e) => { const d = e.detail || {}; if (d.new_reading && bubble.hidden && !document.body.classList.contains('gaia-assist-panel-open')) showBubble(bubbleFor()); });
    window.addEventListener('gaia:signed-out', () => { hideBubble(); setState('idle'); });
    // A practitioner whose account is linked hears it once per session, in her words, with the one chip that matters.
    let saidPractice = false, practiceConnected = false, practiceGreetingTimer = null;
    document.addEventListener('gaia:practitioner-state', (e) => {
      practiceConnected = e.detail?.state === 'connected' && e.detail?.available !== false;
      if (!practiceConnected) {
        clearTimeout(practiceGreetingTimer); practiceGreetingTimer = null;
        if (bubble.dataset.practiceWelcome === 'true') hideBubble();
        return;
      }
      if (saidPractice || practiceGreetingTimer !== null || !bubble.hidden || document.body.classList.contains('gaia-assist-panel-open')) return;
      practiceGreetingTimer = setTimeout(() => {
        practiceGreetingTimer = null;
        if (!practiceConnected || !authed() || !bubble.hidden || document.querySelector('.gaia-tour') || document.body.classList.contains('gaia-assist-panel-open')) return;
        showBubble({ text: 'Your practice is connected. Ask me about your clients, or open them.', chips: ['practice', 'talk'] });
        if (!bubble.hidden) { saidPractice = true; bubble.dataset.practiceWelcome = 'true'; }
      }, 900);
    });
  }

  // ── idle personality ──────────────────────────────────────────────────
  // While nobody is talking to her, Gaia occasionally does one small thing
  // so people notice she is alive and tappable. Classes on the root, CSS
  // keyframes on the existing SVG parts: nothing here dispatches, fetches,
  // navigates or speaks. One animation at a time, never while anything
  // else is going on, and at least IDLE_RESUME_MS after the last touch.
  const IDLE_MIN_MS = 8000, IDLE_MAX_MS = 15000, IDLE_RESUME_MS = 8000;
  // Her two switches, as the app reports them (server preferences for a
  // member; a guest gets the defaults): idle on unless switched off, chime
  // off unless chosen. Nothing is fetched here.
  const prefs = { idleOff: false, chime: false };
  function readPrefs(p) { if (!p) return; prefs.idleOff = Boolean(p.avatar_idle_off); prefs.chime = Boolean(p.avatar_hello_chime); if (prefs.idleOff) stopIdleAnim(); }
  const HELLO_MIN_MS = 45000, HELLO_MAX_MS = 90000, HELLO_IGNORED_MAX = 2;
  const IDLE_ANIMS = [
    { name: 'peek', ms: 1700, weight: 3 },
    { name: 'wave', ms: 1500, weight: 3 },
    { name: 'look', ms: 1900, weight: 3 },
    { name: 'bounce', ms: 950, weight: 2 },
    { name: 'blinksmile', ms: 1500, weight: 3 },
    { name: 'wiggle', ms: 1300, weight: 2 },
    { name: 'curious', ms: 1200, weight: 2 },
  ];
  let lastTouch = Date.now(), animating = false, idleTimer = null, helloTimer = null, helloIgnored = 0, helloShowing = false, tourRunning = false;
  function touched() { lastTouch = Date.now(); if (helloShowing) { helloShowing = false; helloIgnored = 0; } stopIdleAnim(); }
  const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
  function idleEligible() {
    if (!root || document.hidden || prefs.idleOff) return false;
    if (state !== 'idle' || pointing || animating) return false;
    if (convoOpen || !bubble.hidden || root.classList.contains('is-dragging') || root.classList.contains('is-holding') || root.classList.contains('is-behind')) return false;
    if (document.body.classList.contains('gaia-assist-panel-open') || document.querySelector('.gaia-tour')) return false;
    return Date.now() - lastTouch >= IDLE_RESUME_MS;
  }
  function pickAnim() {
    const pool = reduced() ? IDLE_ANIMS.filter((a) => a.name === 'blinksmile') : IDLE_ANIMS;
    const total = pool.reduce((n, a) => n + a.weight, 0);
    let r = Math.random() * total;
    for (const a of pool) { r -= a.weight; if (r <= 0) return a; }
    return pool[pool.length - 1];
  }
  function stopIdleAnim() {
    if (!root) return;
    animating = false;
    [...root.classList].filter((c) => c.startsWith('is-anim-')).forEach((c) => root.classList.remove(c));
  }
  function runIdleAnim(a) {
    if (!idleEligible()) return;
    animating = true;
    root.classList.add('is-anim-' + a.name);
    setTimeout(() => { root.classList.remove('is-anim-' + a.name); animating = false; }, a.ms);
  }
  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { runIdleAnim(pickAnim()); scheduleIdle(); }, rnd(IDLE_MIN_MS, IDLE_MAX_MS));
  }
  let audioUnlocked = false;
  document.addEventListener('pointerdown', () => { audioUnlocked = true; }, { capture: true, passive: true, once: true });
  function chime() {
    if (!prefs.chime || !audioUnlocked || document.hidden) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const ctx = chime.ctx || (chime.ctx = new AC());
      if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
      const t = ctx.currentTime, g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.045, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55); g.connect(ctx.destination);
      for (const [f, at] of [[659.25, 0], [880, 0.16]]) { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(g); o.start(t + at); o.stop(t + at + 0.4); }
    } catch (_) { /* no sound is fine */ }
  }
  /** Much rarer: a small wave with a few words. Stops after being ignored twice. */
  function scheduleHello() {
    clearTimeout(helloTimer);
    helloTimer = setTimeout(() => {
      if (helloIgnored < HELLO_IGNORED_MAX && idleEligible() && !reduced()) {
        // A wave, no words: a bubble with nothing useful in it is noise
        // (contextual suggestions above speak when there is something to say).
        animating = true; root.classList.add('is-anim-wave');
        helloShowing = true; chime();
        setTimeout(() => { root.classList.remove('is-anim-wave'); animating = false; }, 1500);
        setTimeout(() => { if (helloShowing) { helloShowing = false; helloIgnored += 1; } }, 4200);
      }
      scheduleHello();
    }, rnd(HELLO_MIN_MS, HELLO_MAX_MS));
  }
  /** Desktop only: eyes follow a nearby cursor, the body tilts a few degrees. Nothing on touch. */
  function cursor() {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches || reduced()) return;
    let raf = null, last = null;
    const apply = () => {
      raf = null; if (!last || !root) return;
      const r = char.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const dx = last.x - cx, dy = last.y - cy, dist = Math.hypot(dx, dy);
      const near = dist < 260 && dist > 8 && state === 'idle' && !pointing && !root.classList.contains('is-dragging');
      root.classList.toggle('is-looking', near);
      if (near) {
        const k = Math.min(1, dist / 260);
        root.style.setProperty('--gava-ex', (dx / dist * 5 * k).toFixed(2));
        root.style.setProperty('--gava-ey', (dy / dist * 4 * k).toFixed(2));
        root.style.setProperty('--gava-tilt', (dx / dist * 4 * k).toFixed(2) + 'deg');
      } else { root.style.removeProperty('--gava-ex'); root.style.removeProperty('--gava-ey'); root.style.removeProperty('--gava-tilt'); }
    };
    window.addEventListener('mousemove', (e) => { last = { x: e.clientX, y: e.clientY }; if (!raf) raf = requestAnimationFrame(apply); }, { passive: true });
    window.addEventListener('mouseleave', () => { last = null; root.classList.remove('is-looking'); });
  }
  /** A moment of the member's own: one small reaction, gated like idle but without the wait. */
  function moment(name, ms) {
    if (!root || prefs.idleOff || reduced() || document.hidden) return;
    if (state !== 'idle' || pointing || animating || !bubble.hidden || root.classList.contains('is-behind') || root.classList.contains('is-dragging') || document.body.classList.contains('gaia-assist-panel-open') || document.querySelector('.gaia-tour')) return;
    animating = true; root.classList.add('is-anim-' + name);
    setTimeout(() => { root.classList.remove('is-anim-' + name); animating = false; }, ms);
  }
  /** Eyes toward an element on screen for a moment (the new-reading nudge on Today). */
  function glanceAt(el, ms = 1600) {
    if (!el || !root || prefs.idleOff || reduced() || state !== 'idle' || pointing || animating) return;
    const r = char.getBoundingClientRect(), t = el.getBoundingClientRect();
    const dx = (t.left + t.width / 2) - (r.left + r.width / 2), dy = (t.top + t.height / 2) - (r.top + r.height / 2), dist = Math.hypot(dx, dy) || 1;
    root.style.setProperty('--gava-ex', (dx / dist * 5).toFixed(2)); root.style.setProperty('--gava-ey', (dy / dist * 4).toFixed(2));
    root.classList.add('is-looking'); animating = true;
    setTimeout(() => { root.classList.remove('is-looking'); root.style.removeProperty('--gava-ex'); root.style.removeProperty('--gava-ey'); animating = false; }, ms);
  }
  function startIdle() {
    scheduleIdle(); scheduleHello(); cursor();
    document.addEventListener('gaia:prefs-changed', (e) => readPrefs(e.detail?.prefs));
    readPrefs(window.GaiaMember?.data?.prefs?.prefs);
    // the member's own moments
    window.addEventListener('gaia:readings-loaded', () => setTimeout(() => moment('bounce', 950), 300));
    window.addEventListener('gaia:readings-status', (e) => { if (e.detail?.new_reading && (view() === 'today' || view() === 'daily')) setTimeout(() => glanceAt(document.getElementById('readings-nudge')), 700); });
    // The tab the member is about to need, once per session each: You when a
    // reading waits, Today in the morning before the daily check.
    const glanced = { you: false, today: false };
    window.addEventListener('gaia:readings-status', (e) => { if (e.detail?.new_reading && !glanced.you && view() !== 'profile') { glanced.you = true; setTimeout(() => glanceAt(document.querySelector('[data-app-nav="profile"]'), 1800), 1500); } });
    document.addEventListener('gaia:superapp-rendered', () => { if (!glanced.today && new Date().getHours() < 11 && view() === 'today') { glanced.today = true; setTimeout(() => glanceAt(document.querySelector('[data-app-nav="daily"]'), 1800), 2500); } });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopIdleAnim(); });
    // Anything else happening to her ends an idle animation at once.
    if ('MutationObserver' in window) new MutationObserver(() => { if (state !== 'idle' || pointing || !bubble.hidden || root.classList.contains('is-behind') || root.classList.contains('is-dragging')) stopIdleAnim(); }).observe(root, { attributes: true, attributeFilter: ['data-state', 'class'] });
    document.addEventListener('gaia:view-changed', touched);
  }
  // ── end idle personality ──────────────────────────────────────────────

  /*
   * Contextual suggestions. One short line where Gaia has something useful to
   * offer, decided from what the page already knows -- a fixed table, never a
   * model call. Every action is local (navigate, open, scroll); none sends a
   * message or starts voice. Each suggestion appears at most once per device,
   * at most two in a session, never over another bubble, a tour or a
   * conversation, and only after the member has been on the page a while.
   */
  const SEEN_KEY = 'gaia-avatar-suggested';
  const seenSet = () => { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch (_) { return new Set(['*']); } };
  const markSeen = (k) => { try { const s = seenSet(); s.add(k); localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-40))); } catch (_) { /* ignore */ } };
  let suggestedThisSession = 0, suggestTimer = null;
  const pageLoadedAt = Date.now();
  const SUGGEST = [
    { key: 'energy-start', on: 'view', when: () => view() === 'wellness' && !authed(),
      text: () => 'Not sure where to begin? The energy check is the quickest way in, about two minutes.', chips: ['energy', 'later'] },
    { key: 'academy-start-guest', on: 'view', when: () => view() === 'academy' && !authed(),
      text: () => 'The Start free shelf is open to everyone, no membership needed.', chips: ['startfree', 'later'] },
    { key: 'academy-start-member', on: 'view', when: () => view() === 'academy' && authed() && !((window.GaiaMember?.data?.courses?.courses) || []).length,
      text: () => 'Not sure where to start? Tell me what you would like to learn and I will point you to a course.', chips: ['chat', 'later'] },
    { key: 'membership-next', on: 'view', when: () => view() === 'store' && authed() && /membership/.test(location.search + (document.querySelector('[data-store-tab="membership"].is-active, [data-store-tab="membership"][aria-selected="true"]') ? 'membership' : '')) && Boolean(window.GaiaMember?.data?.access?.upgrade?.next_key),
      text: () => 'Want to see what your next level would add for you?', chips: ['nextlevel', 'later'] },
    { key: 'readings-guide', on: 'readings', when: () => view() === 'profile' && readings().linked,
      text: () => 'New to these numbers? I can show you what each one means.', chips: ['explain', 'later'] },
    { key: 'practice-client', on: 'client', when: () => view() === 'profile' && Boolean(document.querySelector('[data-prac-open="latest"]')),
      text: () => 'Want to open this client’s latest reading?', chips: ['clientlatest', 'later'] },
  ];
  let pendingTrigger = null;
  function considerSuggestions(trigger) {
    clearTimeout(suggestTimer);
    pendingTrigger = trigger;
    const at = view();
    suggestTimer = setTimeout(() => {
      pendingTrigger = null;
      if (view() !== at || suggestedThisSession >= 2 || Date.now() - pageLoadedAt < 15000) return;
      if (!root || !bubble.hidden || convoOpen || pointing || document.querySelector('.gaia-tour') || document.body.classList.contains('gaia-assist-panel-open')) return;
      const seen = seenSet(); if (seen.has('*')) return;
      const s = SUGGEST.find((x) => x.on === trigger && !seen.has(x.key) && (() => { try { return x.when(); } catch (_) { return false; } })());
      if (!s) return;
      markSeen(s.key); suggestedThisSession += 1;
      showBubble({ text: s.text(), chips: s.chips, quiet: true });
      bubble.dataset.suggest = s.key;
    }, Math.max(trigger === 'view' ? 6000 : 2500, 15500 - (Date.now() - pageLoadedAt)));
  }
  document.addEventListener('gaia:view-changed', () => considerSuggestions('view'));
  window.addEventListener('gaia:readings-loaded', () => considerSuggestions('readings'));
  document.addEventListener('gaia:practice-client', () => considerSuggestions('client'));
  // While the member is busy on the page, wait: a tap postpones, it does not cancel.
  document.addEventListener('pointerdown', () => { if (pendingTrigger) considerSuggestions(pendingTrigger); }, { capture: true, passive: true });

  /** Once per device: how she works, in one bubble. */
  function meet() {
    try { if (localStorage.getItem('gaia-avatar-met')) return; } catch (_) { return; }
    setTimeout(() => {
      if (!idleEligibleSoft()) return;
      showBubble({ text: 'Hi, I\'m Gaia. Tap me for ideas or to type, hold me to talk, drag me anywhere.', chips: [] });
      try { localStorage.setItem('gaia-avatar-met', '1'); } catch (_) { /* ignore */ }
    }, 2500);
  }
  const idleEligibleSoft = () => root && bubble.hidden && !pointing && !document.body.classList.contains('gaia-assist-panel-open') && !document.querySelector('.gaia-tour');

  function mount() {
    if (!document.querySelector('.gaia-tabbar')) { setTimeout(mount, 400); return; }
    load(); build(); home(); gestures(); listen(); watchAssist(); startIdle(); meet(); considerSuggestions('view');
    setTimeout(home, 600);
  }
  window.GaiaAvatar = { openChat, pointAt, unpoint, showBubble, hideBubble, setState, bubbleFor, runTour, home, moment, glanceAt, prefs: () => ({ ...prefs }), idle: { anims: IDLE_ANIMS.map((a) => a.name), eligible: idleEligible, play: (name) => { const a = IDLE_ANIMS.find((x) => x.name === name); if (a) { lastTouch = 0; runIdleAnim(a); } } } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
