/** Gaia — Daily Energy.
 *
 * One premium daily surface, composed entirely from REAL data already computed
 * by /api/wellness/* (personal focus chakra, sun sign, AI daily note) plus the
 * per-chakra intention/practice/journal. Adds a real, server-persisted ritual
 * streak. No mock data, no random. Owns [data-daily-host] on the Home screen.
 *
 * Two states, one card:
 *   - A signed-up wellness profile → personalised daily + streak + complete.
 *   - Everyone else → a real, date-derived collective preview + a gentle
 *     "add your birth date" path into the existing wellness sign-up.
 */
(function () {
  'use strict';

  function proxyBase() {
    return String((window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
      || 'https://api.gaiahealers.app').replace(/\/+$/, '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  async function api(method, path, body) {
    var opt = { method: method, credentials: 'include', headers: { 'Content-Type': 'application/json' } };
    if (body) opt.body = JSON.stringify(body);
    var r = await fetch(proxyBase() + path, opt);
    return r.json().catch(function () { return { ok: false }; });
  }

  // Chakra glyph colours are already carried in the payload (chakra.color).
  function chakraName(d) { return (d.bodyPoint && d.bodyPoint.chakra) || 'Heart'; }
  function chakraColor(d) { return (d.bodyPoint && d.bodyPoint.color) || '#A6E84B'; }
  function chakraSanskrit(d) { return (d.bodyPoint && d.bodyPoint.sanskrit) || ''; }

  function orb(color) {
    return '<span class="g-de__orb" style="--de-c:' + esc(color) + '" aria-hidden="true">'
      + '<span class="g-de__orb-core"></span></span>';
  }

  function streakStrip(ritual) {
    if (!ritual || !Array.isArray(ritual.last7)) return '';
    var dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    var cells = ritual.last7.map(function (day) {
      var d = new Date(day.date + 'T00:00:00Z');
      var letter = dow[d.getUTCDay()];
      return '<span class="g-de__day' + (day.done ? ' is-done' : '') + '"><i></i><em>' + letter + '</em></span>';
    }).join('');
    var flame = ritual.current > 0
      ? '<span class="g-de__streak"><i class="ph-fill ph-flame"></i>' + ritual.current + '<small>day' + (ritual.current === 1 ? '' : 's') + '</small></span>'
      : '<span class="g-de__streak g-de__streak--rest">Begin your streak today</span>';
    return '<div class="g-de__track">' + flame + '<div class="g-de__days">' + cells + '</div></div>';
  }

  function milestoneNote(ritual) {
    if (!ritual) return '';
    var marks = [7, 21, 30, 56, 90];
    for (var i = 0; i < marks.length; i++) {
      if (ritual.current === marks[i]) return '<p class="g-de__milestone">' + marks[i] + ' days of showing up. Beautifully done.</p>';
    }
    return '';
  }

  function personalisedHtml(d) {
    var name = d.name ? esc(d.name) : '';
    var done = !!(d.ritual && d.ritual.doneToday);
    return '<section class="g-de" style="--de-c:' + esc(chakraColor(d)) + '">'
      + '<div class="g-de__aura" aria-hidden="true"></div>'
      + '<div class="g-de__head">'
      + '<p class="g-de__kicker">Your daily energy</p>'
      + streakActions(d)
      + '</div>'
      + '<div class="g-de__focus">'
      + orb(chakraColor(d))
      + '<div class="g-de__focus-body">'
      + '<h2 class="g-de__title">' + esc(d.intention || 'Today’s focus') + '</h2>'
      + '<p class="g-de__chakra">' + esc(chakraName(d)) + ' centre'
      + (chakraSanskrit(d) ? ' · ' + esc(chakraSanskrit(d)) : '')
      + (d.sunSign ? ' · ' + esc(d.sunSign) : '') + '</p>'
      + '</div></div>'
      + (d.tip ? '<p class="g-de__tip">' + esc(d.tip) + '</p>' : '')
      + '<div class="g-de__practice"><p class="g-de__label">Today’s 2-minute practice</p><p>' + esc(d.practice || '') + '</p></div>'
      + streakStrip(d.ritual)
      + milestoneNote(d.ritual)
      + '<div class="g-de__actions">'
      + '<button type="button" class="g-btn g-btn--primary g-de__done' + (done ? ' is-done' : '') + '" data-de-complete>'
      + (done ? '<i class="ph-fill ph-check-circle"></i> Completed today' : '<i class="ph ph-check-circle"></i> Mark today complete')
      + '</button>'
      + '<button type="button" class="g-btn g-btn--secondary g-de__share" data-de-share><i class="ph ph-share-network"></i> Share</button>'
      + '</div>'
      + (d.journal ? '<details class="g-de__journal"><summary>Reflection prompt</summary><p>' + esc(d.journal) + '</p></details>' : '')
      + '<p class="g-de__source">Reflective guidance from your birth date &amp; today’s date — a wellness practice, not a measurement.</p>'
      + '</section>';
  }

  function streakActions() { return ''; }

  function guestHtml(d) {
    return '<section class="g-de g-de--preview" style="--de-c:' + esc(chakraColor(d)) + '">'
      + '<div class="g-de__aura" aria-hidden="true"></div>'
      + '<div class="g-de__head"><p class="g-de__kicker">Today’s energy · everyone</p></div>'
      + '<div class="g-de__focus">'
      + orb(chakraColor(d))
      + '<div class="g-de__focus-body">'
      + '<h2 class="g-de__title">' + esc(d.intention || 'Today’s focus') + '</h2>'
      + '<p class="g-de__chakra">' + esc(chakraName(d)) + ' centre in focus today</p>'
      + '</div></div>'
      + '<div class="g-de__practice"><p class="g-de__label">Try this today</p><p>' + esc(d.practice || '') + '</p></div>'
      + '<div class="g-de__personalise">'
      + '<p>Add your birth date to get a <strong>daily energy made for you</strong> — your focus centre, a personal note, and a streak that saves.</p>'
      + '<div class="g-de__actions">'
      + '<button type="button" class="g-btn g-btn--primary" data-de-personalise><i class="ph ph-sparkle"></i> Personalise my energy</button>'
      + '<button type="button" class="g-btn g-btn--secondary g-de__share" data-de-share><i class="ph ph-share-network"></i> Share</button>'
      + '</div></div>'
      + '</section>';
  }

  var lastDaily = null;

  function paint(host, d) {
    lastDaily = d;
    host.innerHTML = d.guest ? guestHtml(d) : personalisedHtml(d);
    bind(host);
  }

  function bind(host) {
    var complete = host.querySelector('[data-de-complete]');
    if (complete) {
      complete.addEventListener('click', async function () {
        if (complete.classList.contains('is-done')) return;
        complete.disabled = true;
        var r = await api('POST', '/api/wellness/daily/complete');
        complete.disabled = false;
        if (r && r.ok && r.ritual) {
          lastDaily.ritual = r.ritual;
          paint(host, lastDaily);
          host.querySelector('.g-de')?.classList.add('g-de--celebrate');
        }
      });
    }
    var pers = host.querySelector('[data-de-personalise]');
    if (pers) {
      pers.addEventListener('click', function () {
        if (window.GaiaOnboard) window.GaiaOnboard.openQuickStart();
        else location.href = 'home.html?view=wellness&tab=check';
      });
    }
    var share = host.querySelector('[data-de-share]');
    if (share) {
      share.addEventListener('click', function () {
        if (window.GaiaShare && lastDaily) window.GaiaShare.openDaily(lastDaily);
      });
    }
  }

  async function load() {
    var host = document.querySelector('[data-daily-host]');
    if (!host) return;
    host.innerHTML = '<section class="g-de g-de--loading" aria-busy="true"><div class="g-de__aura" aria-hidden="true"></div><p class="g-de__kicker">Your daily energy</p><div class="g-de__skeleton"></div></section>';
    try {
      var d = await api('GET', '/api/wellness/daily');
      if (!d || !d.ok) { host.innerHTML = ''; return; }
      paint(host, d);
    } catch (e) { host.innerHTML = ''; }
  }

  document.addEventListener('gaia:superapp-rendered', function () {
    if (document.querySelector('[data-daily-host]')) load();
  });
  // A wellness sign-up elsewhere should refresh the card.
  window.addEventListener('gaia:wellness-updated', load);
})();
