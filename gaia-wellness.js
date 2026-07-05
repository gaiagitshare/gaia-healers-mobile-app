/** Gaia — Birth-date chakra + daily wellness (public reveal → sign-up → daily).
 * Owns #home-wellness and #me-wellness. The chakra reveal is public (client-side
 * numerology); the daily body point + wellness horoscope come from the real
 * profile via /api/wellness/* after sign-up. No mock data.
 */
(function () {
  'use strict';
  const boxes = ['home-wellness', 'me-wellness'].map((id) => document.getElementById(id)).filter(Boolean);
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
  // Client-side birth chakra for the live reveal (same numerology as the server).
  function birthChakra(str) {
    const chs = CH(); if (!chs.length || !str) return null;
    const d = new Date(str + 'T00:00:00'); if (isNaN(+d)) return null;
    const s = digitRoot(d.getFullYear() + (d.getMonth() + 1) + d.getDate());
    return chs[(s - 1) % chs.length];
  }

  const state = { loaded: false, signedUp: false, profile: null, today: null, challenge: null, dob: '' };

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
    return c ? energyCard(c, 'Your birth chakra') : '<div class="g-energy g-energy--empty">' + orb('') + '<p class="g-empty">Pick your date and your chakra lights up.</p></div>';
  }

  // ── public (not signed up): live reveal + sign-up ────────
  function publicHtml() {
    const c = birthChakra(state.dob);
    return '<article class="g-card g-well">'
      + '<p class="g-card__label">Your birth-date chakra</p>'
      + '<p class="g-well__lead">Enter your birth date to reveal your chakra — then unlock your <strong>daily body point</strong> and <strong>wellness horoscope</strong>.</p>'
      + '<div class="g-field"><label class="g-label">Date of birth</label>'
      + '<input type="date" class="g-input g-dob" data-wdob value="' + esc(state.dob) + '" max="2035-12-31" aria-label="Date of birth" /></div>'
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

  function renderInto(box) { box.innerHTML = state.signedUp ? signedUpHtml() : publicHtml(); bind(box); }

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
    const dob = box.querySelector('[data-wdob]');
    if (dob) {
      dob.addEventListener('input', () => {
        state.dob = dob.value;
        const html = revealHtml(birthChakra(state.dob));
        boxes.forEach((b) => {
          const inp = b.querySelector('[data-wdob]'); if (inp && inp.value !== state.dob) inp.value = state.dob;
          const rev = b.querySelector('[data-reveal]'); if (rev) rev.innerHTML = html;
        });
      });
    }
    const btn = box.querySelector('[data-wsignup]');
    if (btn) btn.addEventListener('click', () => signup(box));
    const out = box.querySelector('[data-wsignout]');
    if (out) out.addEventListener('click', signout);
    const cj = box.querySelector('[data-chal-join]');
    if (cj) cj.addEventListener('click', () => challengeCall(cj, '/api/wellness/challenge/join'));
    const cc = box.querySelector('[data-chal-checkin]');
    if (cc) cc.addEventListener('click', () => challengeCall(cc, '/api/wellness/challenge/checkin'));
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
    const dob = val(box, '[data-wdob]') || state.dob;
    if (!name) return set('Please enter your name.', true);
    if (!dob) return set('Please pick your birth date.', true);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return set('Please enter a valid email.', true);
    set('Aligning your energy…');
    const r = await api('POST', '/api/wellness/signup', { name, dob, location, email });
    if (r && r.ok && r.signedUp) { state.signedUp = true; state.profile = r.profile; state.today = r.today; state.challenge = r.challenge || { joined: false }; renderAll(); return; }
    set(r && r.reason === 'email_invalid' ? 'That email looks off — please check it.'
      : r && r.reason === 'dob_invalid' ? 'That birth date looks off — please check it.'
        : 'Could not save just now. Please try again.', true);
  }

  async function signout() {
    await api('POST', '/api/wellness/logout');
    state.signedUp = false; state.profile = null; state.today = null; renderAll();
  }

  // Keep the header name correct as the profile injects late / member signs in.
  window.addEventListener('gaia:route', updateHeaderName);
  document.addEventListener('gaia:member', updateHeaderName);
  document.addEventListener('gaia:auth', () => setTimeout(updateHeaderName, 300));

  // Let Gaia Assist perform wellness actions on the member's behalf. Join/check-in
  // click the real buttons (so they keep their confirm-by-tap + state handling);
  // if the member is not signed up yet, they are guided to the sign-up form.
  function focusSignup() {
    const f = document.querySelector('[data-wname]');
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
