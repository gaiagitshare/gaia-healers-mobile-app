/** Gaia — Colour Personality Test.
 * A short, one-question-at-a-time quiz that maps you to a chakra colour and
 * recommends the matching Colour Energy spray (real Shopify cross-sell via
 * window.GaiaStore.chakraShopUrl). Client-side only, no backend.
 */
(function () {
  'use strict';
  const box = document.getElementById('home-colourtest');
  if (!box) return;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // chakra id → colour name + a short "you are…" line
  const COLOURS = {
    root: { name: 'Red', chakra: 'Root', hex: '#E53935', line: 'grounded, secure and strong' },
    sacral: { name: 'Orange', chakra: 'Sacral', hex: '#FB8C00', line: 'creative, passionate and flowing' },
    solar: { name: 'Yellow', chakra: 'Solar Plexus', hex: '#FDD835', line: 'confident, bright and driven' },
    heart: { name: 'Green', chakra: 'Heart', hex: '#43A047', line: 'loving, balanced and open' },
    throat: { name: 'Blue', chakra: 'Throat', hex: '#1E88E5', line: 'expressive, honest and clear' },
    'third-eye': { name: 'Indigo', chakra: 'Third Eye', hex: '#3949AB', line: 'intuitive, insightful and calm' },
    crown: { name: 'Violet', chakra: 'Crown', hex: '#8E24AA', line: 'spiritual, peaceful and connected' },
  };
  const ORDER = ['root', 'sacral', 'solar', 'heart', 'throat', 'third-eye', 'crown'];

  const QUESTIONS = [
    { q: 'Which colour are you drawn to right now?', a: [['Deep red', 'root'], ['Warm orange', 'sacral'], ['Bright yellow', 'solar'], ['Fresh green', 'heart'], ['Sky blue', 'throat'], ['Deep indigo', 'third-eye'], ['Soft violet', 'crown']] },
    { q: 'What do you need more of?', a: [['Security', 'root'], ['Creativity', 'sacral'], ['Confidence', 'solar'], ['Love', 'heart'], ['Expression', 'throat'], ['Clarity', 'third-eye'], ['Peace', 'crown']] },
    { q: 'A free evening — you’d…', a: [['Rest & recharge', 'root'], ['Make something', 'sacral'], ['Chase a goal', 'solar'], ['Be with someone', 'heart'], ['Write or sing', 'throat'], ['Meditate or read', 'third-eye'], ['Simply be still', 'crown']] },
    { q: 'Where do you hold tension?', a: [['Legs & base', 'root'], ['Hips & belly', 'sacral'], ['Stomach', 'solar'], ['Chest', 'heart'], ['Throat & neck', 'throat'], ['Head & eyes', 'third-eye'], ['A busy mind', 'crown']] },
    { q: 'Friends would call you…', a: [['Dependable', 'root'], ['Playful', 'sacral'], ['Ambitious', 'solar'], ['Warm', 'heart'], ['Honest', 'throat'], ['Insightful', 'third-eye'], ['Serene', 'crown']] },
  ];

  const state = { step: -1, scores: {} }; // step -1 = intro

  function reset() { state.step = -1; state.scores = {}; render(); }
  function start() { state.step = 0; state.scores = {}; render(); }
  function answer(ck) {
    state.scores[ck] = (state.scores[ck] || 0) + 1;
    state.step += 1;
    render();
  }
  function winner() {
    let best = ORDER[0]; let max = -1;
    ORDER.forEach((ck) => { const v = state.scores[ck] || 0; if (v > max) { max = v; best = ck; } });
    return best;
  }

  function render() {
    if (state.step === -1) { box.innerHTML = introHtml(); }
    else if (state.step >= QUESTIONS.length) { box.innerHTML = resultHtml(winner()); }
    else { box.innerHTML = questionHtml(state.step); }
    bind();
  }

  function introHtml() {
    return '<article class="g-card g-quiz"><p class="g-card__label">Colour Personality Test</p>'
      + '<p class="g-quiz__title">Which colour are you?</p>'
      + '<p class="g-card__meta">Five quick questions to reveal your Colour Energy — and the spray that matches your chakra today.</p>'
      + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-quiz-start>Start the test →</button></div></article>';
  }
  function questionHtml(i) {
    const Q = QUESTIONS[i];
    const opts = Q.a.map(([label, ck]) => '<button type="button" class="g-quiz-opt" data-ck="' + esc(ck) + '"><span class="g-quiz-dot" style="background:' + esc(COLOURS[ck].hex) + '"></span>' + esc(label) + '</button>').join('');
    return '<article class="g-card g-quiz"><p class="g-card__label">Colour test · ' + (i + 1) + ' of ' + QUESTIONS.length + '</p>'
      + '<p class="g-quiz__q">' + esc(Q.q) + '</p>'
      + '<div class="g-quiz-opts">' + opts + '</div></article>';
  }
  function resultHtml(ck) {
    const c = COLOURS[ck];
    const shop = (window.GaiaStore && window.GaiaStore.chakraShopUrl && window.GaiaStore.chakraShopUrl(ck)) || 'https://gaiahealers.com/collections/colour-energy';
    return '<article class="g-card g-quiz" style="--ck:' + esc(c.hex) + '">'
      + '<div class="g-quiz-result"><div class="g-well-orb" style="--ck:' + esc(c.hex) + '"><span></span></div>'
      + '<div><p class="g-quiz__kicker">Your colour</p><p class="g-quiz__result-name">' + esc(c.name) + '</p>'
      + '<p class="g-card__meta">You’re ' + esc(c.line) + ' — your ' + esc(c.chakra) + ' energy is shining.</p></div></div>'
      + '<div class="g-card__actions"><a class="g-btn g-btn--primary g-btn--sm" href="' + esc(shop) + '" target="_blank" rel="noopener noreferrer">Shop your ' + esc(c.name) + ' spray →</a>'
      + '<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-quiz-retake>Retake</button></div></article>';
  }

  function bind() {
    const s = box.querySelector('[data-quiz-start]'); if (s) s.addEventListener('click', start);
    const r = box.querySelector('[data-quiz-retake]'); if (r) r.addEventListener('click', reset);
    box.querySelectorAll('.g-quiz-opt').forEach((b) => b.addEventListener('click', () => answer(b.dataset.ck)));
  }

  render();
})();
