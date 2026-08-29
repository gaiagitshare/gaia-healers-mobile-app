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
    const localOverride = /^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)
      ? new URLSearchParams(window.location.search).get('apiBase') : '';
    if (localOverride && /^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(localOverride)) return localOverride.replace(/\/+$/, '');
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
  let locationUid = 0;
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

  const state = {
    loaded: false, signedUp: false, profile: null, today: null, challenge: null,
    dob: '', dobParts: { month: '', day: '', year: '' }, expandSignup: false,
    location: null, locationQuery: '', birthTime: '', cosmicMap: null, chartRequest: 0,
  };

  async function load() {
    const r = await api('GET', '/api/wellness/me');
    state.loaded = true;
    if (r && r.signedUp) { state.signedUp = true; state.profile = r.profile; state.today = r.today; state.challenge = r.challenge || { joined: false }; }
    renderAll();
  }
  function renderAll() {
    boxes.forEach(renderInto);
    updateHeaderName();
    const soHost = document.querySelector('[data-wellness-signout]');
    if (soHost) {
      soHost.innerHTML = state.signedUp ? '<button type="button" class="g-btn g-btn--ghost g-btn--sm g-well__signout" data-wsignout>Not you? Sign out</button>' : '';
      const so = soHost.querySelector('[data-wsignout]');
      if (so) so.addEventListener('click', signout);
    }
    // The practice journal draws itself into [data-practice-host]; it listens
    // rather than being called, so this file does not depend on it existing.
    document.dispatchEvent(new CustomEvent('gaia:wellness-rendered', {
      detail: { today: state.today || null, signedUp: state.signedUp },
    }));
  }

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
      + '<a class="g-btn g-btn--ghost g-btn--sm" href="' + esc(shop) + '" target="_blank" rel="noopener noreferrer">Matching Gaia Healers support</a>'
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

  function locationInputHtml() {
    const value = state.location ? state.location.label : state.locationQuery;
    const uid = 'gaia-birth-city-' + (++locationUid); const resultsUid = uid + '-results';
    return '<div class="g-field g-location-field"><label class="g-label" for="' + uid + '">Birth city</label>'
      + '<div class="g-location-combobox"><i class="ph ph-map-pin" aria-hidden="true"></i>'
      + '<input class="g-input" id="' + uid + '" data-wloc role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="' + resultsUid + '" autocomplete="off" placeholder="Start typing a city…" value="' + esc(value || '') + '" />'
      + '<span class="g-location-combobox__state" data-wloc-state aria-hidden="true"></span></div>'
      + '<div class="g-location-results" id="' + resultsUid + '" data-wloc-results role="listbox" hidden></div>'
      + '<p class="g-hint" data-wloc-hint>Type at least 3 letters, then choose your city. Worldwide search via Open-Meteo / GeoNames sets the correct time zone.</p></div>';
  }

  function cosmicMapHtml(map, loading) {
    if (loading) return '<article class="g-cosmic-map g-cosmic-map--loading" aria-live="polite"><i class="ph ph-spinner-gap" aria-hidden="true"></i><p>Reading the sky for your birth place…</p></article>';
    if (!map || !Array.isArray(map.placements)) return '<div class="g-cosmic-map g-cosmic-map--empty" data-cosmic-empty><p>Choose your birth city to reveal your seven-planet chakra reflection.</p></div>';
    const spotlight = map.spotlight || {};
    const path = map.energyPath || {};
    const planets = map.placements.map((planet) => '<li><span>' + esc(planet.name) + '</span><strong>' + esc(planet.sign) + ' ' + esc(planet.degree) + '°</strong><small>' + esc((CH().find((c) => c.id === planet.chakraId) || {}).name || '') + '</small></li>').join('');
    const shop = (window.GaiaStore && window.GaiaStore.chakraShopUrl && spotlight.id)
      ? window.GaiaStore.chakraShopUrl(spotlight.id) : 'https://gaiahealers.com/collections/all';
    const colour = path.colour || (window.GaiaStore && window.GaiaStore.colourFor ? window.GaiaStore.colourFor(spotlight.id) : '') || 'chakra';
    return '<article class="g-cosmic-map" style="--ck:' + esc(spotlight.color || '#7DD956') + '">'
      + '<div class="g-cosmic-map__head"><div><p class="g-energy__kicker">Your sky-to-chakra map</p><h3>' + esc(spotlight.name || 'Gaia') + ' spotlight</h3></div><i class="ph ph-planet" aria-hidden="true"></i></div>'
      + '<div class="g-birth-map__chips"><span>' + esc(map.dominantSign) + ' emphasis</span><span>' + esc(map.representedElement) + ' represented</span><span>Invite ' + esc(map.elementToInvite) + '</span></div>'
      + '<p class="g-birth-map__context">Seven astronomical planet positions are mapped through Gaia’s symbolic chakra lens. This is a reflective tradition—not a measured energy score, diagnosis, or prediction.</p>'
      + '<section class="g-energy-path" aria-labelledby="gaia-energy-path-title">'
      + '<div class="g-energy-path__head"><div><p class="g-energy__kicker">Your Gaia energy path</p><h4 id="gaia-energy-path-title">' + esc(path.intention || 'Pause, notice, choose') + '</h4></div><span>Reflection → action</span></div>'
      + '<p class="g-energy-path__summary">' + esc(path.summary || ('Use the ' + (spotlight.name || 'chakra') + ' spotlight as a prompt for one gentle action today.')) + '</p>'
      + '<ol class="g-energy-path__steps">'
      + '<li><span>1</span><div><strong>Begin with two minutes</strong><p>' + esc(path.practice || 'Take five slow breaths and notice what changes.') + '</p></div></li>'
      + '<li><span>2</span><div><strong>Invite ' + esc(map.elementToInvite) + '</strong><p>' + esc(path.invitation || 'Bring one balancing quality into the moment.') + '</p></div></li>'
      + '<li><span>3</span><div><strong>Carry one question</strong><p>' + esc(path.journal || 'What would bring me toward balance today?') + '</p></div></li>'
      + '</ol>'
      + '<div class="g-energy-path__support">'
      + '<a href="' + esc(shop) + '" target="_blank" rel="noopener noreferrer"><i class="ph ph-drop" aria-hidden="true"></i><span><strong>Explore ' + esc(colour) + ' Colour Energy</strong><small>Matching Gaia Healers store support</small></span><i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>'
      + '<a href="home.html?view=bookings"><i class="ph ph-wave-sine" aria-hidden="true"></i><span><strong>Choose a measured next step</strong><small>Book a Bio-Well scan, demo, or time with Dr. Nima</small></span><i class="ph ph-caret-right" aria-hidden="true"></i></a>'
      + '<a href="home.html?view=events"><i class="ph ph-calendar-dots" aria-hidden="true"></i><span><strong>Experience the work live</strong><small>Gaia Healers Elevate · Nov 20–22, 2026</small></span><i class="ph ph-caret-right" aria-hidden="true"></i></a>'
      + '</div>'
      + '<p class="g-energy-path__note"><i class="ph ph-info" aria-hidden="true"></i><span>This chart is for reflection. A Bio-Well session is the app’s separate route for device-based biofield measurement with a trained practitioner.</span></p>'
      + '</section>'
      + '<details class="g-cosmic-map__details"><summary><span>See all seven planet positions</span><i class="ph ph-caret-down" aria-hidden="true"></i></summary><ul class="g-cosmic-map__planets">' + planets + '</ul></details>'
      + '<p class="g-cosmic-map__basis"><i class="ph ph-clock" aria-hidden="true"></i> ' + (map.timeBasis === 'exact-local-time' ? 'Calculated from the birth time you entered' : 'Birth time unknown: calculated at local noon and labelled as an estimate') + ' · ' + esc(map.place || '') + '</p>'
      + '<div class="g-birth-map__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-gaia-ask-cosmic>Build my 7-day path with Gaia</button>'
      + '<a class="g-btn g-btn--ghost g-btn--sm" href="home.html?view=community">Join the free community</a></div></article>';
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
      + locationInputHtml()
      + '<div class="g-field g-birth-time"><label class="g-label">Birth time <span>Optional</span></label><input class="g-input" type="time" data-wtime aria-label="Birth time" autocomplete="bday" value="' + esc(state.birthTime) + '" />'
      + '<p class="g-hint">If you do not know it, Gaia Healers uses local noon and clearly labels the map as an estimate.</p></div>'
      + '<div data-cosmic-chart>' + cosmicMapHtml(state.cosmicMap, false) + '</div>'
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
    const eh = new Date().getHours();
    const greet = eh < 12 ? 'Good morning' : eh < 18 ? 'Good afternoon' : 'Good evening';
    return '<section class="g-well">'
      + '<div class="g-well__welcome"><p class="g-card__label">' + esc(greet) + '</p><p class="g-well__name">' + esc(pr.firstName || pr.name || 'friend') + '</p></div>'
      + memberBridgeHtml()
      + '<article class="g-card g-et" style="--ck:' + esc(bp.color || '#7DD956') + '">'
      + ((bc && bc.name) ? '<div class="g-et__row">' + orb(bc.color) + '<div class="g-et__body"><p class="g-et__k">Your birth chakra</p><p class="g-et__n">' + esc(bc.name) + (bc.sanskrit ? ' · <span>' + esc(bc.sanskrit) + '</span>' : '') + '</p><p class="g-et__m">' + esc(bc.focus || '') + (bc.element ? ' · ' + esc(bc.element) : '') + '</p></div></div>' : '')
      + '<div class="g-et__row">' + orb(bp.color) + '<div class="g-et__body"><p class="g-et__k">Today’s focus</p><p class="g-et__n">' + esc(bp.chakra || '') + (bp.sanskrit ? ' · <span>' + esc(bp.sanskrit) + '</span>' : '') + '</p><p class="g-et__m">' + esc(bp.area || '') + '</p></div></div>'
      + (bp.focus ? '<p class="g-et__note">Give attention to ' + esc(bp.focus) + '.</p>' : '')
      + '</article>'
      + '<details class="g-drop"><summary class="g-drop__head"><span class="g-drop__icon" style="--tint:#7DD956"><i class="ph ph-note-pencil" aria-hidden="true"></i></span><span class="g-drop__text"><strong>Your practice</strong><small>Reflection &amp; streak</small></span><i class="ph ph-caret-down g-drop__chev" aria-hidden="true"></i></summary><div class="g-drop__body"><div data-practice-host></div></div></details>'
      + '<details class="g-drop"><summary class="g-drop__head"><span class="g-drop__icon" style="--tint:#5C9EAD"><i class="ph ph-medal" aria-hidden="true"></i></span><span class="g-drop__text"><strong>Chakra Challenge</strong><small>Your 8-week journey</small></span><i class="ph ph-caret-down g-drop__chev" aria-hidden="true"></i></summary><div class="g-drop__body">' + challengeHtml() + '</div></details>'
      + '</section>';
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
      + (t.cosmicMap ? cosmicMapHtml(t.cosmicMap, false) : '')
      + '<div class="g-cosmic-checkin">'
      + '<article><i class="ph ph-wind" aria-hidden="true"></i><span>Energy reset</span><p>' + esc(guide.practice || 'Take three slow breaths and choose one gentle next step.') + '</p></article>'
      + '<article><i class="ph ph-note-pencil" aria-hidden="true"></i><span>Journal prompt</span><p>' + esc(guide.journal || 'What deserves my clearest attention today?') + '</p></article>'
      + '</div><div class="g-card__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-gaia-ask-horoscope>Turn this into a 2-minute ritual with Gaia</button></div>'
      + '</section>';
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
        + '<p class="g-chal__title">You’re already a Gaia Healers member</p>'
        + '<p class="g-card__meta">Sign in to sync your courses, communities, and membership into your profile.</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-well-signin>Sign in to sync →</button></div></article>';
    }
    // Existing contact without member access → a warm, honest welcome (no
    // membership claim), with a soft sign-in in case they do have an account.
    return '<article class="g-card" style="--ck:var(--g-accent);border-color:color-mix(in srgb,var(--g-accent) 30%,transparent)">'
      + '<p class="g-daily-card__kicker" style="--ck:var(--g-accent)">✨ Welcome back, ' + nm + '</p>'
      + '<p class="g-card__meta">Lovely to see you at Gaia Healers again — your daily wellness is ready below.</p>'
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
      if (state.dob && state.location) loadCosmicMap(box);
    }));
    bindLocationSearch(box);
    const birthTime = box.querySelector('[data-wtime]');
    if (birthTime) {
      let birthTimeTimer = 0;
      const updateBirthTime = () => {
        state.birthTime = birthTime.value || '';
        document.querySelectorAll('[data-wtime]').forEach((field) => { if (field !== birthTime && field.value !== state.birthTime) field.value = state.birthTime; });
        clearTimeout(birthTimeTimer);
        if (state.dob && state.location) birthTimeTimer = setTimeout(() => loadCosmicMap(box), 180);
      };
      // Android and iOS time pickers do not always emit `change` before the
      // result is viewed. `input` keeps the exact-time label and chart current.
      birthTime.addEventListener('input', updateBirthTime);
      birthTime.addEventListener('change', updateBirthTime);
      birthTime.addEventListener('blur', updateBirthTime);
    }
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
    root.querySelector('[data-gaia-ask-cosmic]')?.addEventListener('click', () => {
      const map = state.cosmicMap || (state.today && state.today.cosmicMap);
      if (!map) return;
      window.dispatchEvent(new CustomEvent('gaia:open-assist', {
        detail: { prompt: 'Build a gentle 7-day Gaia energy path from my sky-to-chakra map. My symbolic spotlight is ' + map.spotlight.name + ', my most represented element is ' + map.representedElement + ', and the element to gently invite is ' + map.elementToInvite + '. Include one two-minute daily practice, a journal prompt, and explain when a Bio-Well scan, Colour Energy support, a session with Dr. Nima, the free community, or Elevate could be a relevant optional next step. Clearly separate symbolic reflection from device measurement, and do not diagnose or predict.' },
      }));
    });
  }

  function closeLocationResults(box) {
    const list = box.querySelector('[data-wloc-results]'); const input = box.querySelector('[data-wloc]');
    if (list) { list.hidden = true; list.innerHTML = ''; }
    if (input) input.setAttribute('aria-expanded', 'false');
  }

  function renderLocationResults(box, results) {
    const list = box.querySelector('[data-wloc-results]'); const input = box.querySelector('[data-wloc]');
    if (!list || !input) return;
    if (!results.length) {
      list.innerHTML = '<p class="g-location-results__empty">No matching city yet. Try the city name plus country.</p>';
    } else {
      list.innerHTML = results.map((item, index) => '<button type="button" role="option" data-city-index="' + index + '"><i class="ph ph-map-pin" aria-hidden="true"></i><span><strong>' + esc(item.name) + '</strong><small>' + esc([item.region, item.country].filter(Boolean).join(', ')) + '</small></span><em>' + esc(item.countryCode) + '</em></button>').join('');
      list.querySelectorAll('[data-city-index]').forEach((button) => button.addEventListener('click', () => {
        const item = results[Number(button.dataset.cityIndex)]; if (!item) return;
        state.location = item; state.locationQuery = item.label; input.value = item.label;
        document.querySelectorAll('[data-wloc]').forEach((field) => { field.value = item.label; field.setAttribute('aria-invalid', 'false'); });
        closeLocationResults(box); loadCosmicMap(box);
      }));
    }
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
  }

  function bindLocationSearch(box) {
    const input = box.querySelector('[data-wloc]'); if (!input) return;
    let timer = 0; let active = -1;
    input.addEventListener('input', () => {
      state.location = null; state.cosmicMap = null; state.locationQuery = input.value.trim(); active = -1;
      document.querySelectorAll('[data-cosmic-chart]').forEach((target) => { target.innerHTML = cosmicMapHtml(null, false); });
      clearTimeout(timer);
      if (state.locationQuery.length < 3) return closeLocationResults(box);
      timer = setTimeout(async () => {
        const query = state.locationQuery; const stateMark = box.querySelector('[data-wloc-state]');
        if (stateMark) stateMark.className = 'g-location-combobox__state is-loading';
        const response = await api('GET', '/api/wellness/locations?q=' + encodeURIComponent(query));
        if (stateMark) stateMark.className = 'g-location-combobox__state';
        if (query !== state.locationQuery) return;
        renderLocationResults(box, response && Array.isArray(response.results) ? response.results : []);
      }, 260);
    });
    input.addEventListener('keydown', (event) => {
      const options = Array.from(box.querySelectorAll('[data-city-index]')); if (!options.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options.forEach((option, index) => option.classList.toggle('is-active', index === active)); options[active].scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); options[active].click(); }
      else if (event.key === 'Escape') closeLocationResults(box);
    });
    input.addEventListener('blur', () => setTimeout(() => closeLocationResults(box), 160));
  }

  async function loadCosmicMap(box) {
    if (!state.dob || !state.location) return;
    const request = ++state.chartRequest;
    const timeField = box.querySelector('[data-wtime]');
    state.birthTime = timeField ? (timeField.value || '') : (state.birthTime || '');
    document.querySelectorAll('[data-cosmic-chart]').forEach((target) => { target.innerHTML = cosmicMapHtml(null, true); });
    const response = await api('POST', '/api/wellness/chart', { dob: state.dob, birthTime: state.birthTime, place: state.location });
    if (request !== state.chartRequest) return;
    state.cosmicMap = response && response.ok ? response.cosmicMap : null;
    document.querySelectorAll('[data-cosmic-chart]').forEach((target) => { target.innerHTML = cosmicMapHtml(state.cosmicMap, false); bindBirthMap(target); });
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
    const birthTime = val(box, '[data-wtime]') || '';
    const dob = dobFromParts({ month: val(box, '[data-wdob-month]'), day: val(box, '[data-wdob-day]'), year: val(box, '[data-wdob-year]') }) || state.dob;
    if (!name) return set('Please enter your name.', true);
    if (!dob) return set('Please enter a real birth date using month, day, and a 4-digit year.', true);
    if (!state.location || state.location.label !== location) return set('Please choose your birth city from the suggestions.', true);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return set('Please enter a valid email.', true);
    set('Aligning your energy…');
    const r = await api('POST', '/api/wellness/signup', { name, dob, location, place: state.location, birthTime, email });
    if (r && r.ok && r.signedUp) { state.signedUp = true; state.profile = r.profile; state.today = r.today; state.challenge = r.challenge || { joined: false }; state.linkedMember = (r.existingMember || r.existingContact) ? { name: r.memberName || name, email, member: !!r.existingMember } : null; renderAll(); return; }
    set(r && r.reason === 'email_invalid' ? 'That email looks off — please check it.'
      : r && r.reason === 'dob_invalid' ? 'That birth date looks off — please check it.'
        : r && r.reason === 'place_invalid' ? 'Please choose your birth city from the suggestions.'
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
