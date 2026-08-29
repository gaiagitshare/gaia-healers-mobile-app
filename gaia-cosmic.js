/** Gaia — Cosmic Map (birth chart -> stones).
 * Reads the birth date the member already saved (/api/wellness/me) — never
 * re-asks — and shows their birth chakra + sun sign + element, a "cosmic stones"
 * product match, and a progressive "unlock a more accurate chart" prompt (add
 * birth time + city). Reflective/entertainment, not a prediction.
 */
(function () {
  'use strict';
  const box = document.getElementById('home-cosmic');
  if (!box) return;
  const SHOP = (window.GaiaStore && window.GaiaStore.shopBase) || 'https://gaiahealers.com';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function proxyBase() { return String((window.GAIA_SYNC && window.GAIA_SYNC.proxyBase) || 'https://api.gaiahealers.app').replace(/\/+$/, ''); }
  const ELEMENT_STONE = { Fire: 'Carnelian & citrine', Earth: 'Hematite & smoky quartz', Air: 'Clear quartz & fluorite', Water: 'Moonstone & amethyst' };

  function needBirthDate() {
    return '<article class="g-card g-cosmic"><p class="g-card__label">Cosmic Map</p>'
      + '<p class="g-quiz__title">Reveal your cosmic map</p>'
      + '<p class="g-card__meta">Add your birth date and Gaia maps your chakra, sun sign and the stones that match your energy.</p>'
      + '<div class="g-card__actions"><a class="g-btn g-btn--primary g-btn--sm" href="home.html?view=wellness&tab=check">Add my birth date →</a></div></article>';
  }

  function render(me) {
    if (!me || !me.signedUp) { box.innerHTML = needBirthDate(); return; }
    const t = me.today || {};
    const bc = t.birthChakra || {};
    const sign = t.sunSign || '';
    const cm = t.cosmicMap;
    const bcColour = bc.color || '#8E24AA';
    const colourShop = (window.GaiaStore && window.GaiaStore.chakraShopUrl && bc.id) ? window.GaiaStore.chakraShopUrl(bc.id) : (SHOP + '/collections/colour-energy');
    const setUrl = SHOP + '/search?q=' + encodeURIComponent('chakra crystal set') + '&type=product';

    // Element(s): from the cosmic map if we have a birth place, else the birth chakra element.
    const element = (cm && cm.representedElement) || bc.element || 'Earth';
    const elementStone = ELEMENT_STONE[element] || 'your chakra crystal set';
    const dominant = cm ? cm.dominantSign : null;
    const rising = cm && cm.rising ? cm.rising.sign : null;
    const spotlight = cm && cm.spotlight ? cm.spotlight.name : bc.name;
    const precise = cm && cm.timeBasis === 'exact-local-time';
    const hasPlace = !!cm;
    const hasTime = !!(me.profile && me.profile.birthTime);

    let html = '<article class="g-card g-cosmic" style="--ck:' + esc(bcColour) + '">'
      + '<div class="g-quiz-result"><div class="g-well-orb" style="--ck:' + esc(bcColour) + '"><span></span></div>'
      + '<div><p class="g-quiz__kicker">Your cosmic map</p><p class="g-quiz__result-name">' + esc(spotlight || 'Your centre') + '</p></div></div>'
      + '<p class="g-card__meta"><strong>Birth chakra:</strong> ' + esc(bc.name || '—') + (bc.sanskrit ? ' (' + esc(bc.sanskrit) + ')' : '')
      + ' · <strong>Sun sign:</strong> ' + esc(sign || '—')
      + (rising ? ' · <strong>Rising:</strong> ' + esc(rising) : '')
      + (dominant ? ' · <strong>Dominant:</strong> ' + esc(dominant) : '')
      + ' · <strong>Element:</strong> ' + esc(element) + '. A reflection, not a prediction.</p>';

    if (cm) {
      html += '<p class="g-cosmic__note">' + (precise
        ? 'Calculated from your exact birth time and city — your most precise reading.'
        : 'Estimated from local noon. Add your birth time below to sharpen your Moon and placements.') + '</p>';
    }

    html += '<p class="g-cq-recs__head">Your cosmic stones</p><div class="g-cq-recs">'
      + '<a class="g-cq-rec g-cq-rec--primary" href="' + esc(setUrl) + '" target="_blank" rel="noopener noreferrer"><strong>Charged 7-Chakra Crystal Set</strong><small>Your full-spectrum support</small></a>'
      + '<a class="g-cq-rec" href="' + esc(colourShop) + '" target="_blank" rel="noopener noreferrer"><strong>' + esc(elementStone) + '</strong><small>For your ' + esc(element) + ' element</small></a>'
      + '</div>';

    if (!hasPlace || !hasTime) {
      html += '<div class="g-cosmic__unlock"><p class="g-cosmic__unlock-head">Unlock a more accurate chart</p>'
        + '<p>Add your <strong>birth time</strong> and <strong>birth city</strong> to sharpen your Moon and planetary placements' + (hasPlace ? '.' : ' and reveal your full cosmic map.') + '</p>'
        + '<a class="g-btn g-btn--secondary g-btn--sm" href="home.html?view=wellness&tab=chakras">Unlock my full chart →</a></div>';
    }

    html += '</article>';
    box.innerHTML = html;
  }

  box.innerHTML = '<article class="g-card g-cosmic"><p class="g-card__label">Cosmic Map</p><p class="g-card__meta">Reading your chart…</p></article>';
  fetch(proxyBase() + '/api/wellness/me', { headers: { Accept: 'application/json' }, credentials: 'include', cache: 'no-store' })
    .then((r) => r.json()).then((me) => render(me)).catch(() => { box.innerHTML = ''; });
})();
