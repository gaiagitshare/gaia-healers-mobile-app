/** Gaia — Moon Rituals.
 * A recurring lunar hook: today's real moon phase (from the /api/wellness/sky
 * ephemeris) plus a reflective ritual, and — near the full moon — a "charge your
 * crystals" moment that ties to the Gaia crystal set. Reflective, not predictive.
 */
(function () {
  'use strict';
  const box = document.getElementById('home-moon');
  if (!box) return;
  const SHOP = (window.GaiaStore && window.GaiaStore.shopBase) || 'https://gaiahealers.com';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function proxyBase() { return String((window.GAIA_SYNC && window.GAIA_SYNC.proxyBase) || 'https://api.gaiahealers.app').replace(/\/+$/, ''); }

  const RITUALS = {
    'new': { title: 'Plant a seed', body: 'A dark sky is a blank page. Write one clear intention for this cycle and keep it somewhere you will see it.', crystal: 'Set your intention with your chakra set or a clear quartz nearby.' },
    'waxing-crescent': { title: 'Take the first step', body: 'The light is returning. Choose one small action toward what you are calling in — momentum beats intensity.', crystal: 'Keep an energising stone with you as you build.' },
    'first-quarter': { title: 'Push through friction', body: 'Half-lit is where beginnings meet resistance. Do the thing you have been avoiding, for two minutes only.', crystal: 'Carnelian and citrine support drive and confidence.' },
    'waxing-gibbous': { title: 'Refine and tend', body: 'Almost full. Adjust, tidy and tend what you have started rather than beginning something new.', crystal: 'A grounding stone keeps you steady as energy rises.' },
    'full': { title: 'Charge and release', body: 'Peak light — the most charged night of the cycle. Set your crystals on a windowsill overnight to cleanse and charge them, make moon water, and name one thing you are ready to release.', crystal: 'Tonight is the night to charge your whole chakra set.' },
    'waning-gibbous': { title: 'Share what you learned', body: 'The light begins to withdraw. Pass on something you learned this cycle — teaching is how it settles.', crystal: 'Cleanse your space with selenite.' },
    'last-quarter': { title: 'Let go', body: 'Time to clear. Forgive someone (including yourself), and close one open loop today.', crystal: 'Black tourmaline and selenite clear heavy energy.' },
    'waning-crescent': { title: 'Rest and restore', body: 'The quietest phase. Do less. Sleep, reflect, and let the ground go fallow before the new moon.', crystal: 'Amethyst supports deep rest.' },
  };

  function render(sky) {
    const m = (sky && sky.moon) || {};
    const up = (sky && sky.upcoming) || {};
    const key = m.phase || 'new';
    const r = RITUALS[key] || RITUALS['new'];
    const illum = (typeof m.illumination === 'number') ? m.illumination : 0;
    const nearFull = key === 'full' || (typeof up.daysToFullMoon === 'number' && up.daysToFullMoon <= 2);
    const crystalUrl = SHOP + '/search?q=' + encodeURIComponent('chakra crystal set') + '&type=product';
    const litSide = m.waxing ? 'right' : 'left';
    const countdown = (typeof up.daysToFullMoon === 'number')
      ? (up.daysToFullMoon === 0 ? 'Full moon tonight' : 'Full moon in ' + up.daysToFullMoon + ' day' + (up.daysToFullMoon === 1 ? '' : 's'))
      + (typeof up.daysToNewMoon === 'number' ? ' · new moon in ' + up.daysToNewMoon + ' day' + (up.daysToNewMoon === 1 ? '' : 's') : '')
      : '';
    return '<article class="g-card g-moon' + (nearFull ? ' is-full' : '') + '">'
      + '<div class="g-moon__top">'
      +   '<div class="g-moon__orb" style="--lit:' + esc(illum) + '%;--side:' + litSide + '"></div>'
      +   '<div><p class="g-card__label">Moon Rituals</p>'
      +   '<p class="g-moon__phase">' + esc(m.phaseLabel || 'Moon') + ' · ' + esc(Math.round(illum)) + '% lit</p>'
      +   (m.sign ? '<p class="g-moon__sign">Moon in ' + esc(m.sign) + '</p>' : '') + '</div>'
      + '</div>'
      + '<p class="g-moon__ritual-title">' + esc(r.title) + '</p>'
      + '<p class="g-card__meta">' + esc(r.body) + '</p>'
      + '<div class="g-moon__crystal">'
      +   '<p>' + esc(r.crystal) + '</p>'
      +   '<a class="g-btn ' + (nearFull ? 'g-btn--primary' : 'g-btn--secondary') + ' g-btn--sm" href="' + esc(crystalUrl) + '" target="_blank" rel="noopener noreferrer">' + (nearFull ? 'Charge your crystals →' : 'Explore Gaia crystals →') + '</a>'
      + '</div>'
      + (countdown ? '<p class="g-moon__next">' + esc(countdown) + '</p>' : '')
      + '</article>';
  }

  box.innerHTML = '<article class="g-card g-moon"><p class="g-card__label">Moon Rituals</p><p class="g-moon__phase">Reading tonight’s sky…</p></article>';
  fetch(proxyBase() + '/api/wellness/sky', { headers: { Accept: 'application/json' }, cache: 'no-store' })
    .then((r) => r.json())
    .then((sky) => { box.innerHTML = (sky && sky.ok) ? render(sky) : ''; })
    .catch(() => { box.innerHTML = ''; });
})();
