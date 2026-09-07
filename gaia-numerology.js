/** Gaia — Numerology.
 *
 * This tab used to leave the app. The card opened numerology.lightworkers.club
 * in a web view, which asked for a full birth name and a date of birth, printed
 * four bare numbers with no explanation of what any of them meant, and then said
 * the real reading was available on request. A person tapped a Gaia tool, typed
 * personal details into an unattributed page, and came back with less than they
 * arrived with.
 *
 * Every other tool on the Energy screen is native, so this one is too. It asks
 * for nothing new: the birth date is already in the wellness profile, so a
 * signed-up member sees their numbers immediately and everyone else can type a
 * date without it being stored anywhere.
 *
 * Only date-of-birth numbers are here. The other three the old page showed
 * (Expression, Soul Urge, Personality) are derived from a full birth name, and
 * collecting a legal name to compute a reflective prompt is not a trade worth
 * making. Better to give three numbers honestly than six with a form in front
 * of them.
 *
 * A note on the arithmetic: gaia-wellness.js already has digitRoot(), and it
 * reduces everything to 1-9. Numerology keeps 11, 22 and 33 unreduced, so this
 * file carries its own reduction rather than changing digitRoot -- the birth
 * chakra depends on that function's current behaviour on both the client and
 * the server, and altering it would quietly move people's chakra.
 */
(function () {
  'use strict';

  const MASTER = new Set([11, 22, 33]);

  // Reduce to a single digit, but stop on a master number.
  function reduce(n) {
    n = Math.abs(Math.trunc(n));
    while (n > 9 && !MASTER.has(n)) {
      n = String(n).split('').reduce((a, c) => a + (+c), 0);
    }
    return n;
  }
  // Sum every digit of a number, once.
  const digits = (n) => String(Math.abs(Math.trunc(n))).split('').reduce((a, c) => a + (+c), 0);

  function parseDob(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
    // Reject a date the calendar does not have, so 31 February never reads.
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
    return { y, m: mo, d };
  }

  /**
   * Each component is reduced before they are added, which is the method that
   * keeps a master number visible instead of flattening it in the sum.
   */
  function lifePath(dob) { return reduce(reduce(dob.y) + reduce(dob.m) + reduce(dob.d)); }
  function birthDay(dob) { return reduce(dob.d); }
  // The personal year turns over on the birthday, not on 1 January -- which is
  // why this is worth showing in an app rather than printing once.
  function personalYear(dob, today) {
    const beforeBirthday = (today.getMonth() + 1) < dob.m
      || ((today.getMonth() + 1) === dob.m && today.getDate() < dob.d);
    const year = today.getFullYear() - (beforeBirthday ? 1 : 0);
    return { value: reduce(reduce(dob.m) + reduce(dob.d) + reduce(year)), year };
  }

  // Theme, a practice you can do today, and something to write about --
  // the same shape the zodiac table in gaia-wellness.js uses, so the app
  // speaks with one voice across its tools.
  const MEANING = {
    1: { theme: 'Beginning', practice: 'Start one thing today without asking whether you are ready.', journal: 'What am I waiting for permission to begin?' },
    2: { theme: 'Relationship', practice: 'Listen to someone for a whole minute before you reply.', journal: 'Where am I rushing past another person?' },
    3: { theme: 'Expression', practice: 'Say or make one thing badly rather than not at all.', journal: 'What wants to be expressed and keeps getting edited?' },
    4: { theme: 'Foundation', practice: 'Finish one small unfinished thing and leave it done.', journal: 'What would steady ground actually look like here?' },
    5: { theme: 'Change', practice: 'Take a different route to somewhere you go often.', journal: 'What am I calling freedom, and what am I calling escape?' },
    6: { theme: 'Care', practice: 'Do one caring thing for yourself before you do one for anyone else.', journal: 'Who am I carrying, and did they ask?' },
    7: { theme: 'Depth', practice: 'Sit for five minutes with no input at all.', journal: 'What do I already know and keep looking for elsewhere?' },
    8: { theme: 'Capacity', practice: 'Name one thing you want out loud, plainly.', journal: 'Where am I shrinking a request to make it easier to refuse?' },
    9: { theme: 'Completion', practice: 'Let one thing end without tidying it first.', journal: 'What is finished that I keep re-opening?' },
    11: { theme: 'Attunement', practice: 'Notice the first thing you felt today before you explain it.', journal: 'What am I sensing that I have not put into words?' },
    22: { theme: 'Building', practice: 'Take the smallest concrete step toward the largest thing you want.', journal: 'What am I imagining that I have not yet started?' },
    33: { theme: 'Offering', practice: 'Give something away today with no account kept of it.', journal: 'What do I have enough of to share?' },
  };
  const meaning = (n) => MEANING[n] || MEANING[reduce(n)] || MEANING[1];
  const label = (n) => (MASTER.has(n) ? n + ' · master number' : String(n));

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function savedDob() {
    try {
      const w = window.GaiaWellness;
      return (w && typeof w.savedDob === 'function' && w.savedDob()) || '';
    } catch (e) { return ''; }
  }

  const state = { dob: '', touched: false };

  // What each of the three is actually about. Without this the cards differ
  // only by a heading, and two that land on the same number look like the page
  // repeated itself.
  const KIND_NOTE = {
    'Life Path': 'The whole birth date. The long arc.',
    'Birth Day': 'The day of the month you arrived. A gift you lean on.',
    'Personal Year': 'Where this particular year sits in a nine-year cycle.',
  };

  function numberCard(kind, value, extra) {
    const m = meaning(value);
    return '<article class="g-num__card">'
      + '<div class="g-num__figure" aria-hidden="true">' + esc(value) + '</div>'
      + '<div class="g-num__body">'
      + '<p class="g-num__kind">' + esc(kind) + '</p>'
      + '<h4 class="g-num__theme">' + esc(m.theme) + '</h4>'
      + '<p class="g-num__value">' + esc(label(value)) + (extra ? ' <span class="g-num__extra">' + esc(extra) + '</span>' : '') + '</p>'
      + '<p class="g-num__kindnote">' + esc(KIND_NOTE[kind] || '') + '</p>'
      + '<p class="g-num__practice">' + esc(m.practice) + '</p>'
      + '<p class="g-num__journal">' + esc(m.journal) + '</p>'
      + '</div></article>';
  }

  function formHtml(prefilled) {
    return '<form class="g-num__form" data-num-form>'
      + '<label class="g-label" for="g-num-dob">Date of birth</label>'
      + '<div class="g-num__row">'
      + '<input class="g-input" type="date" id="g-num-dob" name="dob" value="' + esc(prefilled) + '"'
      + ' min="1900-01-01" max="2100-12-31" required />'
      + '<button class="g-btn g-btn--primary" type="submit">See my numbers</button>'
      + '</div>'
      + '<p class="g-num__note">Worked out on your device. Nothing is sent anywhere or saved.</p>'
      + '</form>';
  }

  function resultHtml(dob) {
    const py = personalYear(dob, new Date());
    const lp = lifePath(dob);
    const bd = birthDay(dob);
    // Two of the three landing on the same number is the sort of thing the
    // tradition treats as worth noticing, and saying so is the difference
    // between a resonance and an apparent copy-paste error.
    const echoes = [];
    if (py.value === lp) echoes.push('this year carries the same number as your life path');
    if (bd === lp && dob.d !== lp) echoes.push('your birth day reduces to your life path too');
    const echo = echoes.length
      ? '<p class="g-num__echo">Worth noticing: ' + esc(echoes.join(', and ')) + '.</p>' : '';
    return '<div class="g-num__cards">'
      + numberCard('Life Path', lp, '')
      + numberCard('Birth Day', bd, dob.d !== bd ? 'from day ' + dob.d : '')
      + numberCard('Personal Year', py.value, 'in ' + py.year)
      + '</div>'
      + echo
      + '<p class="g-num__foot">Your personal year turns over on your birthday, not in January.'
      + ' <button type="button" class="g-num__again" data-num-again>Use a different date</button></p>';
  }

  function render() {
    const hosts = document.querySelectorAll('[data-numerology-host]');
    if (!hosts.length) return;
    const prefill = state.touched ? state.dob : (state.dob || savedDob());
    const dob = parseDob(prefill);
    const body = dob ? resultHtml(dob) : formHtml(prefill);
    hosts.forEach((host) => {
      host.innerHTML = '<section class="g-num">'
        + '<p class="g-num__intro">Three numbers from your birth date. A reflective practice, not a measurement.</p>'
        + body + '</section>';
      bind(host);
    });
  }

  function bind(host) {
    const form = host.querySelector('[data-num-form]');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = form.querySelector('#g-num-dob').value;
        if (!parseDob(v)) {
          let err = host.querySelector('.g-num__err');
          if (!err) { err = document.createElement('p'); err.className = 'g-num__err'; form.appendChild(err); }
          err.textContent = 'That date does not look right. Check the day and month.';
          return;
        }
        state.dob = v; state.touched = true; render();
      });
    }
    const again = host.querySelector('[data-num-again]');
    if (again) again.addEventListener('click', () => { state.dob = ''; state.touched = false; render(); });
  }

  document.addEventListener('gaia:superapp-rendered', render);
  document.addEventListener('DOMContentLoaded', render);
  // A birth date added anywhere else in the app should fill this in too.
  window.addEventListener('gaia:wellness-updated', () => { if (!state.touched) render(); });

  window.GaiaNumerology = { render, reduce, lifePath, birthDay, personalYear, parseDob };
}());
