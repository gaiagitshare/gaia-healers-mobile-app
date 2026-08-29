/** Gaia — Chakra Balance Quiz.
 * Eight questions reveal the chakra asking for your attention, then recommends
 * the real fix, education first: the Charged 7-Chakra Crystal Set (balance the
 * whole system), the matching Colour Energy for your focus centre, and an
 * optional Bio-Well scan to measure it for real. Real Shopify cross-sell via
 * window.GaiaStore. Lead capture is opt-in ("Save my result" → Join free).
 */
(function () {
  'use strict';
  const box = document.getElementById('home-chakraquiz');
  if (!box) return;

  const SHOP = (window.GaiaStore && window.GaiaStore.shopBase) || 'https://gaiahealers.com';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // chakra id → the reflection copy this quiz needs (self-contained, mirrors the
  // colour test; correspondences match gaia-chakra-data.js).
  const CH = {
    root: { name: 'Root', sanskrit: 'Muladhara', hex: '#E53935', colour: 'Red', governs: 'grounding, safety and vitality', body: 'the base of your spine, legs and feet', practice: 'Stand or sit with both feet supported. Take five slow breaths and feel the ground hold you.' },
    sacral: { name: 'Sacral', sanskrit: 'Svadhisthana', hex: '#FB8C00', colour: 'Orange', governs: 'creativity, emotion and flow', body: 'your lower belly and hips', practice: 'Put on one song and let your hips or shoulders move gently for two minutes.' },
    solar: { name: 'Solar Plexus', sanskrit: 'Manipura', hex: '#FDD835', colour: 'Yellow', governs: 'confidence, willpower and energy', body: 'your stomach and digestion', practice: 'Sit tall, hand on your stomach, and name one small thing you will do today.' },
    heart: { name: 'Heart', sanskrit: 'Anahata', hex: '#43A047', colour: 'Green', governs: 'love, compassion and connection', body: 'your heart, chest and shoulders', practice: 'Hand on heart, take three slow breaths, and send one kind thought to yourself.' },
    throat: { name: 'Throat', sanskrit: 'Vishuddha', hex: '#1E88E5', colour: 'Blue', governs: 'expression and truth', body: 'your throat, neck and jaw', practice: 'Hum softly on a long out-breath three times, feeling your throat open.' },
    'third-eye': { name: 'Third Eye', sanskrit: 'Ajna', hex: '#3949AB', colour: 'Indigo', governs: 'intuition and clarity', body: 'your forehead, eyes and head', practice: 'Close your eyes, soften your brow, and watch your breath for one quiet minute.' },
    crown: { name: 'Crown', sanskrit: 'Sahasrara', hex: '#8E24AA', colour: 'Violet', governs: 'awareness and connection', body: 'the crown of your head', practice: 'Sit in stillness for one minute with the simple thought: "I am part of something larger."' },
  };
  const ORDER = ['root', 'sacral', 'solar', 'heart', 'throat', 'third-eye', 'crown'];

  // Eight questions; each answer points to the centre that is asking for support.
  const QUESTIONS = [
    { q: 'Lately, what feels most out of balance?', a: [['Feeling safe & secure', 'root'], ['Joy & creativity', 'sacral'], ['Confidence & drive', 'solar'], ['Love & connection', 'heart'], ['Speaking my truth', 'throat'], ['Focus & clarity', 'third-eye'], ['Meaning & calm', 'crown']] },
    { q: 'Where does tension or heaviness sit in your body?', a: [['Legs, feet, lower back', 'root'], ['Hips & lower belly', 'sacral'], ['Stomach & digestion', 'solar'], ['Chest & shoulders', 'heart'], ['Throat & neck', 'throat'], ['Head & eyes', 'third-eye'], ['A restless mind', 'crown']] },
    { q: 'What are you craving more of right now?', a: [['Stability', 'root'], ['Pleasure & flow', 'sacral'], ['Personal power', 'solar'], ['Compassion', 'heart'], ['Honest expression', 'throat'], ['Insight', 'third-eye'], ['Peace', 'crown']] },
    { q: 'When life gets hard, you tend to…', a: [['Worry about security', 'root'], ['Numb out or overindulge', 'sacral'], ['Push harder or burn out', 'solar'], ['Give too much, forget yourself', 'heart'], ['Go quiet & hold it in', 'throat'], ['Overthink everything', 'third-eye'], ['Feel disconnected', 'crown']] },
    { q: 'Which would help you most today?', a: [['Feeling grounded', 'root'], ['Feeling inspired', 'sacral'], ['Feeling capable', 'solar'], ['Feeling loved', 'heart'], ['Feeling heard', 'throat'], ['Feeling clear', 'third-eye'], ['Feeling connected', 'crown']] },
    { q: 'What drains your energy fastest?', a: [['Instability & change', 'root'], ['Boredom & routine', 'sacral'], ['Feeling powerless', 'solar'], ['Conflict & loneliness', 'heart'], ['Being misunderstood', 'throat'], ['Confusion & noise', 'third-eye'], ['Meaninglessness', 'crown']] },
    { q: 'Your ideal reset would be…', a: [['Rest & good food', 'root'], ['Dance, art or water', 'sacral'], ['A win or a workout', 'solar'], ['Time with a loved one', 'heart'], ['Journaling or singing', 'throat'], ['Meditation', 'third-eye'], ['Stillness & silence', 'crown']] },
    { q: 'Which phrase feels most true?', a: [['I need firmer ground', 'root'], ['I want to feel alive again', 'sacral'], ['I want my confidence back', 'solar'], ['I need to open my heart', 'heart'], ['I need to speak up', 'throat'], ['I need clarity', 'third-eye'], ['I am seeking meaning', 'crown']] },
  ];

  const state = { step: -1, scores: {} };
  function reset() { state.step = -1; state.scores = {}; render(); }
  function start() { state.step = 0; state.scores = {}; render(); }
  function answer(ck) { state.scores[ck] = (state.scores[ck] || 0) + 1; state.step += 1; render(); }
  function winner() {
    let best = ORDER[0]; let max = -1;
    // Ties resolve to the earliest chakra in ORDER (root→crown) — deterministic.
    ORDER.forEach((ck) => { const v = state.scores[ck] || 0; if (v > max) { max = v; best = ck; } });
    return best;
  }

  function render() {
    if (state.step === -1) box.innerHTML = introHtml();
    else if (state.step >= QUESTIONS.length) box.innerHTML = resultHtml(winner());
    else box.innerHTML = questionHtml(state.step);
    bind();
  }

  function introHtml() {
    return '<article class="g-card g-quiz"><p class="g-card__label">Chakra Balance</p>'
      + '<p class="g-quiz__title">Which centre is asking for your attention?</p>'
      + '<p class="g-card__meta">Eight quick questions reveal your focus chakra — and the practice and Gaia support that bring it back into balance.</p>'
      + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-cq-start>Begin the check →</button></div></article>';
  }
  function questionHtml(i) {
    const Q = QUESTIONS[i];
    const opts = Q.a.map(([label, ck]) => '<button type="button" class="g-quiz-opt" data-ck="' + esc(ck) + '"><span class="g-quiz-dot" style="background:' + esc(CH[ck].hex) + '"></span>' + esc(label) + '</button>').join('');
    return '<article class="g-card g-quiz"><p class="g-card__label">Chakra balance · ' + (i + 1) + ' of ' + QUESTIONS.length + '</p>'
      + '<p class="g-quiz__q">' + esc(Q.q) + '</p>'
      + '<div class="g-quiz-opts">' + opts + '</div></article>';
  }
  function resultHtml(ck) {
    const c = CH[ck];
    const colourShop = (window.GaiaStore && window.GaiaStore.chakraShopUrl && window.GaiaStore.chakraShopUrl(ck)) || (SHOP + '/collections/colour-energy');
    const setUrl = SHOP + '/search?q=' + encodeURIComponent('chakra crystal set') + '&type=product';
    const scanUrl = SHOP + '/search?q=' + encodeURIComponent('bio-well scan') + '&type=product';
    return '<article class="g-card g-quiz g-cq-result" style="--ck:' + esc(c.hex) + '">'
      + '<div class="g-quiz-result"><div class="g-well-orb" style="--ck:' + esc(c.hex) + '"><span></span></div>'
      + '<div><p class="g-quiz__kicker">Your focus chakra</p><p class="g-quiz__result-name">' + esc(c.name) + ' <span>· ' + esc(c.sanskrit) + '</span></p></div></div>'
      + '<p class="g-card__meta">Your <strong>' + esc(c.name) + '</strong> centre — ' + esc(c.governs) + ' — is asking for your attention. You may feel it in ' + esc(c.body) + '. This is a gentle reflection, not a measurement.</p>'
      + '<div class="g-cq-try"><span class="g-cq-try__label">Try now</span><p>' + esc(c.practice) + '</p></div>'
      + '<p class="g-cq-recs__head">Bring it back into balance</p>'
      + '<div class="g-cq-recs">'
      +   '<a class="g-cq-rec g-cq-rec--primary" href="' + esc(setUrl) + '" target="_blank" rel="noopener noreferrer"><strong>Charged 7-Chakra Crystal Set</strong><small>Balance your whole system</small></a>'
      +   '<a class="g-cq-rec" href="' + esc(colourShop) + '" target="_blank" rel="noopener noreferrer"><strong>' + esc(c.colour) + ' Colour Energy</strong><small>Support your ' + esc(c.name) + ' centre</small></a>'
      +   '<a class="g-cq-rec" href="' + esc(scanUrl) + '" target="_blank" rel="noopener noreferrer"><strong>See it for real — Bio-Well scan</strong><small>Measure your energy field</small></a>'
      + '</div>'
      + '<div class="g-card__actions">'
      +   '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-cq-save>Save my result — Join free</button>'
      +   '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-cq-share>Share</button>'
      +   '<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-cq-retake>Retake</button>'
      + '</div></article>';
  }

  function shareResult(ck) {
    const c = CH[ck];
    const text = 'My Gaia focus chakra is ' + c.name + ' (' + c.sanskrit + '). Find yours:';
    const url = SHOP.replace(/\/+$/, '') === 'https://gaiahealers.com' ? 'https://gaiahealers.app/home.html?view=wellness&tool=chakra' : (window.location.origin + '/home.html?view=wellness&tool=chakra');
    if (navigator.share) { navigator.share({ title: 'My focus chakra: ' + c.name, text, url }).catch(() => {}); return; }
    try { navigator.clipboard.writeText(text + ' ' + url); } catch (_) { /* ignore */ }
  }

  function bind() {
    const s = box.querySelector('[data-cq-start]'); if (s) s.addEventListener('click', start);
    const r = box.querySelector('[data-cq-retake]'); if (r) r.addEventListener('click', reset);
    const share = box.querySelector('[data-cq-share]'); if (share) share.addEventListener('click', () => shareResult(winner()));
    const save = box.querySelector('[data-cq-save]');
    if (save) save.addEventListener('click', () => {
      if (window.GaiaAuth && window.GaiaAuth.open) window.GaiaAuth.open();
      else window.location.href = 'home.html?view=profile';
    });
    box.querySelectorAll('.g-quiz-opt').forEach((b) => b.addEventListener('click', () => answer(b.dataset.ck)));
  }

  window.GaiaChakraQuiz = { start };
  render();
  if (new URLSearchParams(window.location.search).get('tool') === 'chakra') {
    start();
    window.requestAnimationFrame(() => box.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }
})();
