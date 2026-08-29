/** Gaia — Chakra Journey (8-week challenge).
 * Surfaces the existing server-side challenge (/api/wellness/challenge/*): join,
 * this week's chakra + practice + affirmation, a daily "mark complete" check-in,
 * and a streak. A recurring retention hook; joining tags the GHL contact.
 */
(function () {
  'use strict';
  const box = document.getElementById('home-challenge');
  if (!box) return;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function proxyBase() { return String((window.GAIA_SYNC && window.GAIA_SYNC.proxyBase) || 'https://api.gaiahealers.app').replace(/\/+$/, ''); }
  function post(path) { return fetch(proxyBase() + path, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } }).then((r) => r.json()).catch(() => ({ ok: false })); }
  function get() { return fetch(proxyBase() + '/api/wellness/me', { headers: { Accept: 'application/json' }, credentials: 'include', cache: 'no-store' }).then((r) => r.json()).catch(() => null); }

  function startPrompt() {
    return '<article class="g-card g-chal"><p class="g-card__label">Chakra Journey</p>'
      + '<p class="g-quiz__title">An 8-week journey through your chakras</p>'
      + '<p class="g-card__meta">One centre a week, a two-minute daily practice, and a streak that saves. Add your birth date to begin.</p>'
      + '<div class="g-card__actions"><a class="g-btn g-btn--primary g-btn--sm" href="home.html?view=wellness&tab=check">Add my birth date →</a></div></article>';
  }
  function joinHtml() {
    return '<article class="g-card g-chal"><p class="g-card__label">Chakra Journey</p>'
      + '<p class="g-quiz__title">Begin your 8-week Chakra Journey</p>'
      + '<p class="g-card__meta">One centre a week — Root to Crown — with a short daily practice and affirmation. Free, and your streak saves.</p>'
      + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-chal-join>Start the journey →</button></div></article>';
  }
  function joinedHtml(c) {
    const pct = Math.round((Math.min(8, c.week) / 8) * 100);
    return '<article class="g-card g-chal" style="--ck:' + esc(c.color || '#43A047') + '">'
      + '<div class="g-quiz-result"><div class="g-well-orb" style="--ck:' + esc(c.color || '#43A047') + '"><span></span></div>'
      + '<div><p class="g-quiz__kicker">Chakra Journey · Week ' + esc(c.week) + ' of 8</p><p class="g-quiz__result-name">' + esc(c.chakra) + (c.sanskrit ? ' <span>· ' + esc(c.sanskrit) + '</span>' : '') + '</p></div></div>'
      + '<div class="g-chal__bar"><i style="width:' + pct + '%"></i></div>'
      + (c.affirmation ? '<p class="g-chal__affirm">“' + esc(c.affirmation) + '”</p>' : '')
      + (c.practice ? '<div class="g-cq-try"><span class="g-cq-try__label">This week’s practice</span><p>' + esc(c.practice) + '</p></div>' : '')
      + '<div class="g-chal__foot">'
      + (c.doneToday
        ? '<span class="g-chal__done">✓ Done today</span>'
        : '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-chal-checkin>Mark today complete</button>')
      + '<span class="g-chal__streak">' + esc(c.totalDone || 0) + ' check-in' + ((c.totalDone === 1) ? '' : 's') + '</span>'
      + '</div></article>';
  }

  function render(me) {
    if (!me || !me.signedUp) { box.innerHTML = startPrompt(); return bind(); }
    const c = me.challenge || { joined: false };
    box.innerHTML = c.joined ? joinedHtml(c) : joinHtml();
    bind();
  }
  function refresh() { get().then((me) => render(me)); }
  function bind() {
    const j = box.querySelector('[data-chal-join]');
    if (j) j.addEventListener('click', () => { j.disabled = true; post('/api/wellness/challenge/join').then(refresh); });
    const ci = box.querySelector('[data-chal-checkin]');
    if (ci) ci.addEventListener('click', () => { ci.disabled = true; post('/api/wellness/challenge/checkin').then(refresh); });
  }

  box.innerHTML = '<article class="g-card g-chal"><p class="g-card__label">Chakra Journey</p><p class="g-card__meta">Loading your journey…</p></article>';
  get().then((me) => render(me));
})();
