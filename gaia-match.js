/** Gaia — Energy Match (compatibility).
 * Two birth dates -> each person's birth chakra + sun sign + element -> a
 * playful energy-compatibility score, a shareable card, and a paired-crystal
 * gift idea. Reflective/entertainment, not a prediction. Client-side only.
 * The viral loop: every share/invite is an acquisition moment.
 */
(function () {
  'use strict';
  const box = document.getElementById('home-match');
  if (!box) return;
  const SHOP = (window.GaiaStore && window.GaiaStore.shopBase) || 'https://gaiahealers.com';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  const CHAKRAS = [
    { id: 'root', name: 'Root', hex: '#E53935' }, { id: 'sacral', name: 'Sacral', hex: '#FB8C00' },
    { id: 'solar', name: 'Solar Plexus', hex: '#FDD835' }, { id: 'heart', name: 'Heart', hex: '#43A047' },
    { id: 'throat', name: 'Throat', hex: '#1E88E5' }, { id: 'third-eye', name: 'Third Eye', hex: '#3949AB' },
    { id: 'crown', name: 'Crown', hex: '#8E24AA' },
  ];
  const SIGNS = [['Capricorn', 1, 20], ['Aquarius', 2, 19], ['Pisces', 3, 20], ['Aries', 4, 20], ['Taurus', 5, 21], ['Gemini', 6, 21], ['Cancer', 7, 23], ['Leo', 8, 23], ['Virgo', 9, 23], ['Libra', 10, 23], ['Scorpio', 11, 22], ['Sagittarius', 12, 22]];
  const ELEMENT = { Aries: 'Fire', Leo: 'Fire', Sagittarius: 'Fire', Taurus: 'Earth', Virgo: 'Earth', Capricorn: 'Earth', Gemini: 'Air', Libra: 'Air', Aquarius: 'Air', Cancer: 'Water', Scorpio: 'Water', Pisces: 'Water' };

  function digitRoot(n) { n = Math.abs(n); while (n > 9) { n = String(n).split('').reduce((a, c) => a + (+c), 0); } return n; }
  function birthChakra(y, m, d) { return CHAKRAS[((digitRoot(y + m + d) - 1) % 7 + 7) % 7]; }
  function sunSign(m, d) { for (let i = SIGNS.length - 1; i >= 0; i--) { const [name, mo, day] = SIGNS[i]; if (m > mo || (m === mo && d >= day)) return name; } return 'Capricorn'; }

  // Playful element harmony (0..1). Same element = warm; Fire/Air & Earth/Water
  // = flowing; the crossed pairs = growthful friction (still positive).
  function elementScore(a, b) {
    if (a === b) return 0.85;
    const flow = { Fire: 'Air', Air: 'Fire', Earth: 'Water', Water: 'Earth' };
    if (flow[a] === b) return 1;
    return 0.62;
  }
  function chakraScore(ai, bi) { const d = Math.min((ai - bi + 7) % 7, (bi - ai + 7) % 7); return d === 0 ? 1 : d === 1 ? 0.8 : d === 2 ? 0.68 : 0.58; }

  const state = { step: 0 }; // 0 = form, 1 = result
  let A = null; let B = null; let SCORE = 0;

  function parse(prefix) {
    const mo = +box.querySelector('[data-' + prefix + '-m]').value;
    const day = +box.querySelector('[data-' + prefix + '-d]').value;
    const yr = +box.querySelector('[data-' + prefix + '-y]').value;
    if (!mo || !(day >= 1 && day <= 31) || !(yr >= 1900 && yr <= 2025)) return null;
    return { ck: birthChakra(yr, mo, day), sign: sunSign(mo, day), y: yr, m: mo, d: day };
  }
  function person(p) { p.element = ELEMENT[p.sign]; p.ci = CHAKRAS.indexOf(p.ck); return p; }

  function compute() {
    const a = parse('a'); const b = parse('b');
    const err = box.querySelector('[data-match-err]');
    if (!a || !b) { if (err) err.textContent = 'Please enter two full birth dates.'; return; }
    A = person(a); B = person(b);
    const s = 0.55 * elementScore(A.element, B.element) + 0.45 * chakraScore(A.ci, B.ci);
    SCORE = Math.round((0.55 + s * 0.44) * 100); // 55..~99, always encouraging
    state.step = 1; render();
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function dobFields(prefix, label) {
    const opts = MONTHS.map((n, i) => '<option value="' + (i + 1) + '">' + n + '</option>').join('');
    return '<div class="g-match-person"><span class="g-label">' + esc(label) + '</span>'
      + '<div class="g-match-dob">'
      + '<select class="g-input" data-' + prefix + '-m aria-label="Month"><option value="">Month</option>' + opts + '</select>'
      + '<input class="g-input" data-' + prefix + '-d type="text" inputmode="numeric" maxlength="2" placeholder="DD" aria-label="Day">'
      + '<input class="g-input" data-' + prefix + '-y type="text" inputmode="numeric" maxlength="4" placeholder="YYYY" aria-label="Year">'
      + '</div></div>';
  }
  function formHtml() {
    return '<article class="g-card g-match"><p class="g-card__label">Energy Match</p>'
      + '<p class="g-quiz__title">How do your energies meet?</p>'
      + '<p class="g-card__meta">Two birth dates reveal your chakra and element match — for a partner, a friend, or someone new.</p>'
      + dobFields('a', 'You') + dobFields('b', 'Them')
      + '<p class="g-match-err" data-match-err aria-live="polite"></p>'
      + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-match-go>See our match →</button></div></article>';
  }
  function orb(hex) { return '<div class="g-well-orb" style="--ck:' + esc(hex) + '"><span></span></div>'; }
  function resultHtml() {
    const band = SCORE >= 88 ? 'Radiant harmony' : SCORE >= 76 ? 'Warm and flowing' : SCORE >= 66 ? 'Growthful and magnetic' : 'Different grounds, real chemistry';
    const line = A.element === B.element
      ? 'You share the ' + A.element + ' element — a familiar, easy resonance.'
      : 'Your ' + A.element + ' meets their ' + B.element + ' — different grounds that can balance each other beautifully.';
    const giftUrl = SHOP + '/search?q=' + encodeURIComponent('chakra crystal set') + '&type=product';
    return '<article class="g-card g-match g-match-result">'
      + '<div class="g-match-orbs">' + orb(A.ck.hex) + '<div class="g-match-score"><strong>' + SCORE + '<i>%</i></strong><span>' + esc(band) + '</span></div>' + orb(B.ck.hex) + '</div>'
      + '<p class="g-card__meta"><strong>You:</strong> ' + esc(A.ck.name) + ' centre · ' + esc(A.sign) + ' (' + esc(A.element) + ')<br><strong>Them:</strong> ' + esc(B.ck.name) + ' centre · ' + esc(B.sign) + ' (' + esc(B.element) + ')</p>'
      + '<p class="g-card__meta">' + esc(line) + ' This is a reflection for fun and connection, not a prediction.</p>'
      + '<div class="g-cq-recs"><a class="g-cq-rec g-cq-rec--primary" href="' + esc(giftUrl) + '" target="_blank" rel="noopener noreferrer"><strong>Paired Chakra Crystal Sets</strong><small>A grounding gift for you both</small></a></div>'
      + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-match-share>Share our match</button>'
      + '<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-match-retake>Try another</button></div></article>';
  }
  function shareResult() {
    const url = 'https://gaiahealers.app/home.html?view=wellness&tool=match';
    const text = 'Our Gaia Energy Match is ' + SCORE + '%. Find yours:';
    if (navigator.share) { navigator.share({ title: 'Gaia Energy Match', text, url }).catch(() => {}); return; }
    try { navigator.clipboard.writeText(text + ' ' + url); } catch (_) { /* ignore */ }
  }

  function render() {
    box.innerHTML = state.step === 0 ? formHtml() : resultHtml();
    const go = box.querySelector('[data-match-go]'); if (go) go.addEventListener('click', compute);
    const rt = box.querySelector('[data-match-retake]'); if (rt) rt.addEventListener('click', () => { state.step = 0; render(); });
    const sh = box.querySelector('[data-match-share]'); if (sh) sh.addEventListener('click', shareResult);
  }
  render();
  if (new URLSearchParams(window.location.search).get('tool') === 'match') {
    window.requestAnimationFrame(() => box.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }
})();
