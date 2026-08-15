/** Gaia — Birth-date chakra + daily wellness (public reveal → sign-up → daily).
 * Owns #home-wellness and #me-wellness. The chakra reveal is public (client-side
 * numerology); the daily body point + wellness horoscope come from the real
 * profile via /api/wellness/* after sign-up. No mock data.
 */
(function () {
  'use strict';
  const boxes = ['home-wellness', 'me-wellness', 'horoscope-wellness'].map((id) => document.getElementById(id)).filter(Boolean);
  if (!boxes.length) return;

  function proxyBase() {
    return String((window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
      || 'https://api.gaiahealers.app').replace(/\/+$/, '');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  async function api(method, path, body) {
    const opt = { method, headers: { Accept: 'application/json' }, credentials: 'include' };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    try { const r = await fetch(proxyBase() + path, opt); return await r.json(); } catch (_) { return { ok: false, reason: 'network' }; }
  }
  const CH = () => window.GAIA_CHAKRAS || [];
  function digitRoot(n) { n = Math.abs(n); while (n > 9) { n = String(n).split('').reduce((a, c) => a + (+c), 0); } return n; }
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const ZODIAC = {
    Aries: { element: 'Fire', theme: 'Initiative', practice: 'Choose one small action and begin before you overthink it.', journal: 'Where is my energy asking for a clear first step?' },
    Taurus: { element: 'Earth', theme: 'Steadiness', practice: 'Slow one ordinary moment down and notice all five senses.', journal: 'What deserves patient, grounded attention?' },
    Gemini: { element: 'Air', theme: 'Curiosity', practice: 'Write three uncensored lines before deciding what you think.', journal: 'What new perspective wants to be heard?' },
    Cancer: { element: 'Water', theme: 'Nourishment', practice: 'Create one quiet boundary that protects your energy.', journal: 'What would feeling cared for look like today?' },
    Leo: { element: 'Fire', theme: 'Expression', practice: 'Share one sincere appreciation—with yourself or someone else.', journal: 'Where can I lead with warmth instead of performance?' },
    Virgo: { element: 'Earth', theme: 'Discernment', practice: 'Improve one small thing, then let “enough” be enough.', journal: 'What can I simplify with kindness?' },
    Libra: { element: 'Air', theme: 'Harmony', practice: 'Pause before agreeing and notice what feels mutually fair.', journal: 'What would balanced connection ask of me?' },
    Scorpio: { element: 'Water', theme: 'Transformation', practice: 'Name the feeling beneath the first feeling—without fixing it.', journal: 'What am I ready to meet honestly?' },
    Sagittarius: { element: 'Fire', theme: 'Meaning', practice: 'Step outside or look farther than your usual horizon.', journal: 'What possibility makes me feel more alive?' },
    Capricorn: { element: 'Earth', theme: 'Devotion', practice: 'Choose the one task that serves your longer journey.', journal: 'What am I willing to build steadily?' },
    Aquarius: { element: 'Air', theme: 'Vision', practice: 'Imagine one kinder way the system around you could work.', journal: 'How can my difference become a contribution?' },
    Pisces: { element: 'Water', theme: 'Sensitivity', practice: 'Take two quiet minutes with music, breath, or water.', journal: 'What is my intuition whispering beneath the noise?' },
  };

  function parseDob(str) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
    if (!match) return null;
    const y = Number(match[1]); const m = Number(match[2]); const d = Number(match[3]);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (y < 1900 || y > new Date().getFullYear() || m < 1 || m > 12 || d < 1
      || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d
      || date.getTime() > Date.now()) return null;
    return { y, m, d };
  }
  function dobParts(str) {
    const parsed = parseDob(str);
    return parsed ? { month: String(parsed.m), day: String(parsed.d), year: String(parsed.y) } : { month: '', day: '', year: '' };
  }
  function dobFromParts(parts) {
    const month = Number(parts.month); const day = Number(parts.day); const year = Number(parts.year);
    if (!month || !day || String(parts.year || '').length !== 4) return '';
    const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return parseDob(value) ? value : '';
  }
  function sunSignFromDob(str) {
    const parsed = parseDob(str); if (!parsed) return '';
    const cutoff = [20, 19, 21, 20, 21, 21, 23, 23, 23, 23, 22, 22];
    const from = ['Capricorn', 'Aquarius', 'Pisces', 'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius'];
    const to = ['Aquarius', 'Pisces', 'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn'];
    return parsed.d < cutoff[parsed.m - 1] ? from[parsed.m - 1] : to[parsed.m - 1];
  }
  // Client-side birth chakra for the live reveal (same numerology as the server).
  function birthChakra(str) {
    const chs = CH(); const d = parseDob(str); if (!chs.length || !d) return null;
    const s = digitRoot(d.y + d.m + d.d);
    return chs[(s - 1) % chs.length];
  }

  const state = { loaded: false, signedUp: false, profile: null, today: null, challenge: null, dob: '', dobParts: { month: '', day: '', year: '' }, expandSignup: false };

  async function load() {
    const r = await api('GET', '/api/wellness/me');
    state.loaded = true;
    if (r && r.signedUp) { state.signedUp = true; state.profile = r.profile; state.today = r.today; state.challenge = r.challenge || { joined: false }; }
    renderAll();
  }
  function renderAll() { boxes.forEach(renderInto); updateHeaderName(); }

  // ── visuals ──────────────────────────────────────────────
  function orb(color) {
    if (!color) return '<div class="g-well-orb g-well-orb--empty" aria-hidden="true"></div>';
    return '<div class="g-well-orb" style="--ck:' + esc(color) + '" aria-hidden="true"><span></span></div>';
  }
  function energyCard(c, label) {
    if (!c || !c.name) return '';
    return '<div class="g-energy" style="--ck:' + esc(c.color || '#7DD956') + '">' + orb(c.color)
      + '<div class="g-energy__body"><p class="g-energy__kicker">' + esc(label || 'Your energy') + '</p>'
      + '<p class="g-energy__name">' + esc(c.name) + (c.sanskrit ? ' · <span>' + esc(c.sanskrit) + '</span>' : '') + '</p>'
      + '<p class="g-energy__meta">' + esc(c.focus || '') + (c.element ? ' · ' + esc(c.element) : '') + '</p></div></div>';
  }
  function revealHtml(c) {
    if (!c) return '<div class="g-energy g-energy--empty">' + orb('') + '<p class="g-empty">Your chakra and sun-sign reflection will appear here.</p></div>';
    const sign = sunSignFromDob(state.dob); const zodiac = ZODIAC[sign] || {};
    const shop = (window.GaiaStore && window.GaiaStore.chakraShopUrl)
      ? window.GaiaStore.chakraShopUrl(c.id) : 'https://gaiahealers.com/collections/all';
    return '<article class="g-birth-map" style="--ck:' + esc(c.color || '#7DD956') + '">'
      + '<div class="g-birth-map__top">' + orb(c.color)
      + '<div><p class="g-energy__kicker">Your Gaia birth map</p><p class="g-birth-map__title">' + esc(c.name) + ' <span>· ' + esc(c.sanskrit || '') + '</span></p></div></div>'
      + '<div class="g-birth-map__chips"><span>' + esc(sign) + '</span><span>' + esc(zodiac.element || c.element) + '</span><span>' + esc(c.theme || c.focus) + '</span></div>'
      + '<p class="g-birth-map__context">Your birth-date number points to the <strong>' + esc(c.name) + '</strong> centre; your sun sign adds a ' + esc((zodiac.theme || 'reflective').toLowerCase()) + ' lens. Use this as a personal reflection, not a scan or prediction.</p>'
      + '<div class="g-birth-map__grid">'
      + '<div><span><i class="ph ph-sparkle" aria-hidden="true"></i> Try now</span><p>' + esc(c.practice || zodiac.practice || 'Pause and take five slow breaths.') + '</p></div>'
      + '<div><span><i class="ph ph-note-pencil" aria-hidden="true"></i> Journal</span><p>' + esc(c.journalPrompt || zodiac.journal || 'What would bring me toward balance today?') + '</p></div>'
      + '</div><div class="g-birth-map__actions">'
      + '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-gaia-ask-birth>Ask Gaia about my map</button>'
      + '<a class="g-btn g-btn--ghost g-btn--sm" href="' + esc(shop) + '" target="_blank" rel="noopener noreferrer">Matching Gaia support</a>'
      + '</div></article>';
  }

  function dobInputHtml() {
    const parts = state.dobParts || dobParts(state.dob);
    const options = MONTHS.map((name, index) => '<option value="' + (index + 1) + '"' + (String(index + 1) === String(parts.month) ? ' selected' : '') + '>' + name + '</option>').join('');
    return '<fieldset class="g-dob-builder" data-wdob-group><legend class="g-label">Date of birth</legend>'
      + '<p class="g-dob-builder__hint">No calendar scrolling. Choose the month, then type the day and 4-digit year.</p>'
      + '<div class="g-dob-builder__fields">'
      + '<label><span>Month</span><select class="g-input" data-wdob-month autocomplete="bday-month"><option value="">Month</option>' + options + '</select></label>'
      + '<label><span>Day</span><input class="g-input" data-wdob-day type="text" inputmode="numeric" autocomplete="bday-day" maxlength="2" placeholder="DD" value="' + esc(parts.day) + '"></label>'
      + '<label><span>Year</span><input class="g-input" data-wdob-year type="text" inputmode="numeric" autocomplete="bday-year" maxlength="4" placeholder="YYYY" value="' + esc(parts.year) + '"></label>'
      + '</div><p class="g-dob-builder__error" data-wdob-error aria-live="polite"></p></fieldset>';
  }

  // ── public (not signed up): live reveal + sign-up ────────
  // Compact reminder shown when the member has NOT set up their wellness
  // profile yet. One line + one button — keeps the Home screen uncluttered.
  // Tapping "Set up" expands the full sign-up form in place.
  function publicHtml() {
    if (state.expandSignup) return signupFormHtml();
    return '<article class="g-card g-well g-well--nudge">'
      + '<p class="g-card__label">Personalise your day</p>'
      + '<p class="g-well__lead">Set up your birth-date chakra to unlock your <strong>daily body point</strong> and <strong>wellness horoscope</strong>.</p>'
      + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-wexpand>Set up my wellness →</button></div>'
      + '</article>';
  }

  // The full sign-up form (birth date, name, location, email). Shown when the
  // member taps "Set up" on the compact reminder, or via Gaia Assist.
  function signupFormHtml() {
    const c = birthChakra(state.dob);
    return '<article class="g-card g-well">'
      + '<p class="g-card__label">Your birth-date chakra</p>'
      + '<p class="g-well__lead">Enter your birth date to reveal your chakra — then unlock your <strong>daily body point</strong> and <strong>wellness horoscope</strong>.</p>'
      + dobInputHtml()
      + '<div class="g-well-reveal" data-reveal>' + revealHtml(c) + '</div>'
      + '<div class="g-field"><label class="g-label">Full name</label><input class="g-input" data-wname autocomplete="name" placeholder="Your name" /></div>'
      + '<div class="g-field"><label class="g-label">Location</label><input class="g-input" data-wloc autocomplete="address-level2" placeholder="City, country" /></div>'
      + '<div class="g-field"><label class="g-label">Email</label><input class="g-input" type="email" data-wemail autocomplete="email" placeholder="you@email.com" /></div>'
      + '<p class="g-admin-status" data-wstatus></p>'
      + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-wsignup>Unlock my daily wellness →</button></div>'
      + '<p class="g-hint">We save your details to personalise your daily guidance. Wellness support, not medical advice.</p>'
      + '</article>';
  }

  // ── signed up: daily content ─────────────────────────────
  function signedUpHtml() {
    const t = state.today || {}; const pr = state.profile || {};
    const bc = t.birthChakra || {}; const bp = t.bodyPoint || {};
    const h = new Date().getHours();
    const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    return '<section class="g-well">'
      + '<div class="g-well__welcome"><p class="g-card__label">' + esc(greet) + '</p><p class="g-well__name">' + esc(pr.firstName || pr.name || 'friend') + '</p></div>'
      + memberBridgeHtml()
      + energyCard(bc, 'Your birth chakra')
      + '<div class="g-daily">'
      + '<article class="g-card g-daily-card" style="--ck:' + esc(bp.color || '#7DD956') + '">'
      + '<p class="g-daily-card__kicker">Today’s body point</p>'
      + '<p class="g-daily-card__title">' + esc(bp.chakra || '') + (bp.sanskrit ? ' · <span>' + esc(bp.sanskrit) + '</span>' : '') + '</p>'
      + '<p class="g-daily-card__area">' + esc(bp.area || '') + '</p>'
      + (bp.focus ? '<p class="g-daily-card__meta">Give attention to ' + esc(bp.focus) + '.</p>' : '')
      + '</article>'
      + '<article class="g-card g-daily-card g-daily-card--horo">'
      + '<p class="g-daily-card__kicker">Wellness horoscope' + (t.sunSign ? ' · ' + esc(t.sunSign) : '') + '</p>'
      + '<p class="g-daily-card__tip">' + esc(t.tip || '') + '</p></article>'
      + '</div>'
      + challengeHtml()
      + '<button type="button" class="g-btn g-btn--ghost g-btn--sm g-well__signout" data-wsignout>Not you? Sign out</button>'
      + '</section>';
  }

  function energyCheckHtml() {
    if (!state.signedUp) return publicHtml();
    const t = state.today || {}; const pr = state.profile || {};
    const bc = t.birthChakra || {}; const bp = t.bodyPoint || {};
    return '<section class="g-well">'
      + '<div class="g-well__welcome"><p class="g-card__label">Today’s energy check</p><p class="g-well__name">' + esc(pr.firstName || pr.name || 'Your day') + '</p></div>'
      + memberBridgeHtml()
      + energyCard(bc, 'Your birth chakra')
      + '<article class="g-card g-daily-card" style="--ck:' + esc(bp.color || '#7DD956') + '">'
      + '<p class="g-daily-card__kicker">Today’s body point</p>'
      + '<p class="g-daily-card__title">' + esc(bp.chakra || '') + (bp.sanskrit ? ' · <span>' + esc(bp.sanskrit) + '</span>' : '') + '</p>'
      + '<p class="g-daily-card__area">' + esc(bp.area || '') + '</p>'
      + (bp.focus ? '<p class="g-daily-card__meta">Give attention to ' + esc(bp.focus) + '.</p>' : '')
      + '</article>' + challengeHtml()
      + '<button type="button" class="g-btn g-btn--ghost g-btn--sm g-well__signout" data-wsignout>Not you? Sign out</button></section>';
  }

  function horoscopeHtml() {
    if (!state.signedUp) {
      if (state.expandSignup) return signupFormHtml();
      return '<article class="g-card g-well g-well--nudge">'
        + '<p class="g-card__label">Your sign, your daily reflection</p>'
        + '<p class="g-well__lead">Add your birth date once to unlock a <strong>wellness horoscope</strong> made for reflection, not prediction.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-wexpand>Set up my horoscope →</button></div>'
        + '<p class="g-hint">No scan or paid membership is required.</p></article>';
    }
    const t = state.today || {}; const guide = ZODIAC[t.sunSign] || {};
    return '<section class="g-well">' + memberBridgeHtml()
      + '<article class="g-card g-daily-card g-daily-card--horo g-horoscope-card">'
      + '<div class="g-horoscope-card__mark" aria-hidden="true"><i class="ph ph-moon-stars"></i></div>'
      + '<p class="g-daily-card__kicker">Today’s wellness horoscope' + (t.sunSign ? ' · ' + esc(t.sunSign) : '') + '</p>'
      + (guide.element ? '<div class="g-horoscope-card__chips"><span>' + esc(guide.element) + '</span><span>' + esc(guide.theme) + '</span></div>' : '')
      + '<p class="g-daily-card__tip">' + esc(t.tip || 'Your daily guidance is preparing.') + '</p>'
      + '<p class="g-hint">A sun-sign reflection for journaling—not a birth chart, prediction, or medical reading.</p></article>'
      + '<div class="g-cosmic-checkin">'
      + '<article><i class="ph ph-wind" aria-hidden="true"></i><span>Energy reset</span><p>' + esc(guide.practice || 'Take three slow breaths and choose one gentle next step.') + '</p></article>'
      + '<article><i class="ph ph-note-pencil" aria-hidden="true"></i><span>Journal prompt</span><p>' + esc(guide.journal || 'What deserves my clearest attention today?') + '</p></article>'
      + '</div><div class="g-card__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-gaia-ask-horoscope>Turn this into a 2-minute ritual with Gaia</button></div>'
      + '<button type="button" class="g-btn g-btn--ghost g-btn--sm g-well__signout" data-wsignout>Not you? Sign out</button></section>';
  }

  // ── 8-week chakra challenge ──────────────────────────────
  function challengeHtml() {
    const c = state.challenge || {};
    if (!c.joined) {
      return '<article class="g-card g-chal"><p class="g-daily-card__kicker" style="--ck:var(--g-accent)">8-Week Chakra Challenge</p>'
        + '<p class="g-chal__title">One chakra a week</p>'
        + '<p class="g-card__meta">A gentle daily practice that moves through all seven centres — bringing your whole system into balance over eight weeks.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-chal-join>Join the challenge →</button></div></article>';
    }
    const dots = Array.from({ length: 8 }, (_, i) => '<span class="g-chal-dot' + ((i + 1) <= c.week ? ' is-on' : '') + '"' + ((i + 1) === c.week ? ' data-now' : '') + '></span>').join('');
    return '<article class="g-card g-chal" style="--ck:' + esc(c.color || '#7DD956') + '">'
      + '<p class="g-daily-card__kicker">Chakra Challenge · Week ' + esc(c.week) + ' of 8</p>'
      + '<p class="g-chal__title">' + esc(c.chakra) + (c.sanskrit ? ' · <span>' + esc(c.sanskrit) + '</span>' : '') + '</p>'
      + '<p class="g-card__meta">' + esc(c.focus || '') + '</p>'
      + '<div class="g-chal-dots">' + dots + '</div>'
      + '<p class="g-chal__practice"><strong>Today:</strong> ' + esc(c.practice || '') + '</p>'
      + '<p class="g-chal__aff">“' + esc(c.affirmation || '') + '”</p>'
      + '<div class="g-card__actions">'
      + (c.doneToday ? '<span class="g-chip g-chip--on">✓ Done today</span>'
        : '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-chal-checkin>Mark today complete</button>')
      + '<span class="g-chal__count">' + (c.totalDone === 1 ? '1 day' : (c.totalDone || 0) + ' days') + ' practised</span></div>'
      + (c.complete ? '<p class="g-hint">You completed the 8-week journey — beautiful work.</p>' : '')
      + '</article>';
  }

  // Bridge for people who sign up with an email that is ALREADY a real Gaia
  // member. We never expose their private access from an unverified email —
  // we invite them to sign in (one tap), which securely syncs their full
  // member profile (courses, communities, membership).
  function memberBridgeHtml() {
    const lm = state.linkedMember;
    if (!lm) return '';
    if (window.GaiaMember && window.GaiaMember.authed) return ''; // already signed in → already synced
    const nm = lm.name ? esc(String(lm.name).split(/\s+/)[0]) : 'there';
    if (lm.member) {
      // Real member with access → offer the sign-in that syncs their profile.
      return '<article class="g-card" style="--ck:var(--g-accent);border-color:color-mix(in srgb,var(--g-accent) 45%,transparent)">'
        + '<p class="g-daily-card__kicker" style="--ck:var(--g-accent)">✨ Welcome back, ' + nm + '</p>'
        + '<p class="g-chal__title">You’re already a Gaia member</p>'
        + '<p class="g-card__meta">Sign in to sync your courses, communities, and membership into your profile.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-well-signin>Sign in to sync →</button></div></article>';
    }
    // Existing contact without member access → a warm, honest welcome (no
    // membership claim), with a soft sign-in in case they do have an account.
    return '<article class="g-card" style="--ck:var(--g-accent);border-color:color-mix(in srgb,var(--g-accent) 30%,transparent)">'
      + '<p class="g-daily-card__kicker" style="--ck:var(--g-accent)">✨ Welcome back, ' + nm + '</p>'
      + '<p class="g-card__meta">Lovely to see you at Gaia again — your daily wellness is ready below.</p>'
      + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--ghost g-btn--sm" data-well-signin>Already a member? Sign in</button></div></article>';
  }

  function renderInto(box) {
    const mode = box.dataset.wellnessMode || '';
    box.innerHTML = mode === 'check' ? energyCheckHtml()
      : mode === 'horoscope' ? horoscopeHtml()
        : (state.signedUp ? signedUpHtml() : publicHtml());
    bind(box);
    // Show/hide the "Your day" section header: only when there is personalised
    // content to show (signed up). The compact reminder has its own mini-label.
    const head = document.getElementById('home-wellness-head');
    if (head) head.hidden = !state.signedUp;
  }

  // Show the member's first name in the header (where "Profile" sits). Prefers a
  // signed-in GHL member name, else the wellness profile name.
  function updateHeaderName() {
    const member = window.GaiaMember && window.GaiaMember.authed
      && window.GaiaMember.data && window.GaiaMember.data.profile && window.GaiaMember.data.profile.profile;
    const memberName = member && String(member.name || '').trim().split(/\s+/)[0];
    const wellName = state.signedUp && state.profile ? (state.profile.firstName || String(state.profile.name || '').trim().split(/\s+/)[0]) : '';
    const name = memberName || wellName || '';
    // Signed out → "Sign in" (the pill opens the sign-in modal); signed in →
    // the member's first name, or "Profile" if we don't have a name yet.
    const signedIn = !!(window.GaiaMember && window.GaiaMember.authed) || !!state.signedUp;
    const label = name || (signedIn ? 'Profile' : 'Sign in');
    document.querySelectorAll('[data-gaia-header-profile]').forEach((a) => { a.textContent = label; });
  }

  function bind(box) {
    const dobFields = ['month', 'day', 'year'].map((part) => box.querySelector('[data-wdob-' + part + ']'));
    if (dobFields.some(Boolean)) dobFields.forEach((field) => field && field.addEventListener(field.tagName === 'SELECT' ? 'change' : 'input', () => {
      const month = val(box, '[data-wdob-month]');
      const day = val(box, '[data-wdob-day]').replace(/\D/g, '').slice(0, 2);
      const year = val(box, '[data-wdob-year]').replace(/\D/g, '').slice(0, 4);
      state.dobParts = { month, day, year }; state.dob = dobFromParts(state.dobParts);
      const complete = Boolean(month && day && year.length === 4);
      boxes.forEach((b) => {
        const mm = b.querySelector('[data-wdob-month]'); if (mm && mm.value !== month) mm.value = month;
        const dd = b.querySelector('[data-wdob-day]'); if (dd && dd.value !== day) dd.value = day;
        const yy = b.querySelector('[data-wdob-year]'); if (yy && yy.value !== year) yy.value = year;
        const error = b.querySelector('[data-wdob-error]'); if (error) error.textContent = complete && !state.dob ? 'Please check that this is a real date in the past.' : '';
        const rev = b.querySelector('[data-reveal]'); if (rev) { rev.innerHTML = revealHtml(birthChakra(state.dob)); bindBirthMap(rev); }
      });
    }));
    // "Set up my wellness" on the compact reminder → expand the full form.
    const exp = box.querySelector('[data-wexpand]');
    if (exp) exp.addEventListener('click', () => {
      state.expandSignup = true;
      renderAll();
      setTimeout(() => { try { box.querySelector('[data-wdob-month]')?.focus(); } catch (_) {} }, 50);
    });
    const btn = box.querySelector('[data-wsignup]');
    if (btn) btn.addEventListener('click', () => signup(box));
    const out = box.querySelector('[data-wsignout]');
    if (out) out.addEventListener('click', signout);
    const cj = box.querySelector('[data-chal-join]');
    if (cj) cj.addEventListener('click', () => challengeCall(cj, '/api/wellness/challenge/join'));
    const cc = box.querySelector('[data-chal-checkin]');
    if (cc) cc.addEventListener('click', () => challengeCall(cc, '/api/wellness/challenge/checkin'));
    const si = box.querySelector('[data-well-signin]');
    if (si) si.addEventListener('click', () => {
      const email = (state.linkedMember && state.linkedMember.email) || (state.profile && state.profile.email) || '';
      if (window.GaiaAuth && window.GaiaAuth.open) window.GaiaAuth.open(email);
    });
    const askHoroscope = box.querySelector('[data-gaia-ask-horoscope]');
    if (askHoroscope) askHoroscope.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('gaia:open-assist', {
        detail: { prompt: 'Help me reflect on today’s wellness horoscope and suggest one gentle action.' },
      }));
    });
    bindBirthMap(box);
  }

  function bindBirthMap(root) {
    root.querySelector('[data-gaia-ask-birth]')?.addEventListener('click', () => {
      const chakra = birthChakra(state.dob); const sign = sunSignFromDob(state.dob);
      window.dispatchEvent(new CustomEvent('gaia:open-assist', {
        detail: { prompt: 'Help me reflect on my ' + (chakra ? chakra.name + ' birth chakra' : 'birth chakra') + (sign ? ' and ' + sign + ' sun sign' : '') + '. Give me one gentle practice and one journal question.' },
      }));
    });
  }

  async function challengeCall(btn, path) {
    btn.disabled = true;
    const r = await api('POST', path);
    if (r && r.ok && r.challenge) { state.challenge = r.challenge; renderAll(); }
    else btn.disabled = false;
  }

  const val = (box, sel) => { const e = box.querySelector(sel); return e ? e.value : ''; };

  async function signup(box) {
    const status = box.querySelector('[data-wstatus]');
    const set = (msg, err) => { if (status) { status.textContent = msg; status.className = 'g-admin-status' + (err ? ' g-admin-status--err' : ''); } };
    const name = val(box, '[data-wname]').trim();
    const email = val(box, '[data-wemail]').trim();
    const location = val(box, '[data-wloc]').trim();
    const dob = dobFromParts({ month: val(box, '[data-wdob-month]'), day: val(box, '[data-wdob-day]'), year: val(box, '[data-wdob-year]') }) || state.dob;
    if (!name) return set('Please enter your name.', true);
    if (!dob) return set('Please enter a real birth date using month, day, and a 4-digit year.', true);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return set('Please enter a valid email.', true);
    set('Aligning your energy…');
    const r = await api('POST', '/api/wellness/signup', { name, dob, location, email });
    if (r && r.ok && r.signedUp) { state.signedUp = true; state.profile = r.profile; state.today = r.today; state.challenge = r.challenge || { joined: false }; state.linkedMember = (r.existingMember || r.existingContact) ? { name: r.memberName || name, email, member: !!r.existingMember } : null; renderAll(); return; }
    set(r && r.reason === 'email_invalid' ? 'That email looks off — please check it.'
      : r && r.reason === 'dob_invalid' ? 'That birth date looks off — please check it.'
        : 'Could not save just now. Please try again.', true);
  }

  async function signout() {
    await api('POST', '/api/wellness/logout');
    state.signedUp = false; state.profile = null; state.today = null; state.expandSignup = false; renderAll();
  }

  // Keep the header name correct as the profile injects late / member signs in.
  window.addEventListener('gaia:route', updateHeaderName);
  document.addEventListener('gaia:member', updateHeaderName);
  document.addEventListener('gaia:auth', () => setTimeout(updateHeaderName, 300));

  // Let Gaia Assist perform wellness actions on the member's behalf. Join/check-in
  // click the real buttons (so they keep their confirm-by-tap + state handling);
  // if the member is not signed up yet, they are guided to the sign-up form.
  function focusSignup() {
    // If the compact reminder is showing, expand the full form first.
    if (!state.signedUp && !state.expandSignup) {
      state.expandSignup = true;
      renderAll();
    }
    const f = document.querySelector('[data-wdob-month]') || document.querySelector('[data-wname]');
    if (!f) return false;
    try { f.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
    f.focus();
    return true;
  }
  window.GaiaWellness = {
    isSignedUp: () => !!state.signedUp,
    focusSignup,
    joinChallenge: () => {
      const b = document.querySelector('[data-chal-join]');
      if (b) { b.click(); return true; }
      return focusSignup();
    },
    checkIn: () => {
      const b = document.querySelector('[data-chal-checkin]');
      if (b) { b.click(); return true; }
      return focusSignup();
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
