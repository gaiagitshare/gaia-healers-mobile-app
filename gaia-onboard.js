/** Gaia — Quick personalisation ("aha" step).
 *
 * The frictionless bridge from Join Free → real personalised Daily Energy.
 * Birth date only (Month / Day / Year — no calendar scroll). A logged-in
 * member's real verified email + name come from their session, so members type
 * nothing but their birth date; a signed-out visitor adds name + email.
 *
 * Writes a REAL wellness profile via /api/wellness/quickstart and then lets the
 * existing Daily Energy card re-render with that real data. No mock, no preview.
 */
(function () {
  'use strict';

  function proxyBase() {
    return String((window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
      || 'https://api.gaiahealers.app').replace(/\/+$/, '');
  }
  function isMember() { return !!(window.GaiaMember && window.GaiaMember.authed); }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function fieldsHtml(member) {
    var monthOpts = MONTHS.map(function (m, i) {
      return '<option value="' + (i + 1) + '">' + m + '</option>';
    }).join('');
    var identity = member ? '' : (''
      + '<label class="g-onb__row"><span>Your name</span><input type="text" data-onb-name autocomplete="name" placeholder="First name" /></label>'
      + '<label class="g-onb__row"><span>Email</span><input type="email" data-onb-email autocomplete="email" inputmode="email" placeholder="you@example.com" /></label>');
    return identity
      + '<div class="g-onb__dob"><span class="g-onb__dob-label">Your birth date</span>'
      + '<div class="g-onb__dob-fields">'
      + '<select data-onb-month aria-label="Birth month"><option value="" disabled selected>Month</option>' + monthOpts + '</select>'
      + '<input type="number" data-onb-day min="1" max="31" inputmode="numeric" aria-label="Birth day" placeholder="Day" />'
      + '<input type="number" data-onb-year min="1900" max="' + new Date().getFullYear() + '" inputmode="numeric" aria-label="Birth year" placeholder="Year" />'
      + '</div></div>';
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function open() {
    var member = isMember();
    var overlay = document.createElement('div');
    overlay.className = 'gaia-onboard-modal';
    overlay.innerHTML = ''
      + '<div class="gaia-onboard-modal__panel" role="dialog" aria-modal="true" aria-label="Personalise your daily energy">'
      + '<button type="button" class="gaia-sheet-close" data-onb-close aria-label="Close">×</button>'
      + '<p class="g-onb__kicker">Your daily energy</p>'
      + '<h2 class="g-onb__title">Made just for you</h2>'
      + '<p class="g-onb__lead">' + (member ? 'Add your birth date to unlock your personal focus centre, a daily note, and a streak that saves.' : 'Your birth date reveals your personal focus centre and daily energy. Nothing is shared.') + '</p>'
      + '<form data-onb-form>' + fieldsHtml(member)
      + '<button type="submit" class="g-btn g-btn--primary g-onb__submit"><i class="ph ph-sparkle"></i> Reveal my daily energy</button>'
      + '</form>'
      + '<p class="g-onb__status" data-onb-status role="status" aria-live="polite"></p>'
      + '<p class="g-onb__note">Used only to personalise your reflective wellness guidance — never a measurement, never shared.</p>'
      + '</div>';
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';

    var status = overlay.querySelector('[data-onb-status]');
    function setStatus(t, err) { status.textContent = t; status.classList.toggle('is-error', !!err); }
    function close() { overlay.remove(); document.documentElement.style.overflow = ''; }
    overlay.querySelector('[data-onb-close]').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    overlay.querySelector('[data-onb-form]').addEventListener('submit', async function (e) {
      e.preventDefault();
      var mo = overlay.querySelector('[data-onb-month]').value;
      var day = parseInt(overlay.querySelector('[data-onb-day]').value, 10);
      var year = parseInt(overlay.querySelector('[data-onb-year]').value, 10);
      if (!mo || !(day >= 1 && day <= 31) || !(year >= 1900 && year <= new Date().getFullYear())) { setStatus('Please enter a full birth date.', true); return; }
      var dob = year + '-' + pad(parseInt(mo, 10)) + '-' + pad(day);
      var payload = { dob: dob };
      if (!member) {
        var nameEl = overlay.querySelector('[data-onb-name]');
        var emailEl = overlay.querySelector('[data-onb-email]');
        payload.name = nameEl ? nameEl.value.trim() : '';
        payload.email = emailEl ? emailEl.value.trim() : '';
        if (!payload.name) { setStatus('Please add your name.', true); return; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email)) { setStatus('Please add a valid email.', true); return; }
      }
      var btn = overlay.querySelector('.g-onb__submit'); btn.disabled = true;
      setStatus('Revealing your daily energy…');
      try {
        var r = await fetch(proxyBase() + '/api/wellness/quickstart', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        var data = await r.json();
        if (!data || !data.ok) {
          btn.disabled = false;
          setStatus(data && data.reason === 'dob_invalid' ? 'That birth date looks off — please check it.' : 'Could not save just now. Please try again.', true);
          return;
        }
        setStatus('Done ✓');
        close();
        // Let the Daily Energy card re-fetch and render the real personalised state.
        window.dispatchEvent(new CustomEvent('gaia:wellness-updated'));
        var host = document.querySelector('[data-daily-host]');
        if (host && host.scrollIntoView) setTimeout(function () { host.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 400);
      } catch (err) { btn.disabled = false; setStatus('Network error — please try again.', true); }
    });

    setTimeout(function () { var f = overlay.querySelector('input, select'); if (f) f.focus(); }, 60);
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  }

  window.GaiaOnboard = { openQuickStart: open };
})();
