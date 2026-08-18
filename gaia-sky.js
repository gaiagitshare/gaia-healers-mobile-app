/** Gaia — Today's Sky.
 *
 * Every other tool in Gaia opens with a form. Energy Check wants a birth date,
 * the horoscope wants a birth city, the daily body point wants an account. Each
 * is a fair trade for a personal reading, and together they mean a first-time
 * visitor sees nothing until they have handed something over.
 *
 * This asks for nothing. The moon is the same for everyone, it is genuinely
 * different every day, and anyone can walk outside and check it. So it can be
 * given away: it earns a return visit on its own merits rather than on a
 * reminder email, and the personal version — how today's sky meets *your*
 * chart — is then a real step up instead of a paywall on the same thing.
 *
 * The moon is drawn, not picked from a set of emoji: the terminator is
 * positioned from the actual illuminated fraction the server computed, so the
 * shape on screen is the shape in the sky tonight.
 */
(function () {
  'use strict';

  function proxyBase() {
    const localOverride = /^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)
      ? new URLSearchParams(window.location.search).get('apiBase') : '';
    if (localOverride && /^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(localOverride)) return localOverride.replace(/\/+$/, '');
    return String((window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
      || 'https://api.gaiahealers.app').replace(/\/+$/, '');
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // One fetch per page load, shared by every host on the page.
  let pending = null;
  function fetchSky() {
    if (pending) return pending;
    pending = fetch(proxyBase() + '/api/wellness/sky', {
      method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include',
    }).then((r) => r.json()).catch(() => ({ ok: false, reason: 'network' }));
    return pending;
  }

  /**
   * The moon, drawn to its actual phase.
   *
   * Two circles: the lit disc, and a shadow whose horizontal radius is the
   * terminator. At half phase the terminator is a straight line, so the ellipse
   * collapses to rx=0 — hence the small floor, which keeps the SVG valid
   * without visibly changing the shape.
   *
   * Which side is lit depends on whether the moon is filling or emptying, so a
   * waxing crescent and a waning one are mirror images rather than the same
   * picture twice.
   */
  function moonSvg(illumination, waxing, tint) {
    const R = 42;
    // Clamped through a NaN check, not just a range: Math.min/max propagate NaN
    // rather than clipping it, so a malformed payload would reach the SVG as
    // rx="NaN" and the moon would silently fail to draw at all.
    const raw = Number(illumination) / 100;
    const f = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    // Terminator offset: 0 at half moon, ±R at new and full.
    const rx = Math.max(0.01, Math.abs(1 - 2 * f) * R);
    // Past half the ellipse is painted light rather than dark, so it spills the
    // lit side over the terminator instead of biting into it.
    const gibbous = f > 0.5;

    return '<svg class="g-sky__moon" viewBox="0 0 100 100" role="img"'
      + ' aria-label="' + esc(Math.round(f * 100) + '% illuminated') + '">'
      + '<defs>'
      + '<radialGradient id="gSkyGlow" cx="50%" cy="50%" r="50%">'
      + '<stop offset="60%" stop-color="' + esc(tint) + '" stop-opacity="0.35"/>'
      + '<stop offset="100%" stop-color="' + esc(tint) + '" stop-opacity="0"/>'
      + '</radialGradient>'
      + '<clipPath id="gSkyDisc"><circle cx="50" cy="50" r="' + R + '"/></clipPath>'
      + '</defs>'
      + '<circle cx="50" cy="50" r="49" fill="url(#gSkyGlow)"/>'
      + '<circle cx="50" cy="50" r="' + R + '" class="g-sky__moon-dark"/>'
      + '<g clip-path="url(#gSkyDisc)">'
      // The lit half, then the shadow ellipse carving the terminator across it.
      + '<path class="g-sky__moon-lit" d="M50 8 A ' + R + ' ' + R + ' 0 0 '
      + (waxing ? '1' : '0') + ' 50 92 Z"/>'
      + '<ellipse class="' + (gibbous ? 'g-sky__moon-lit' : 'g-sky__moon-dark') + '"'
      + ' cx="50" cy="50" rx="' + rx.toFixed(2) + '" ry="' + R + '"/>'
      + '</g>'
      + '<circle cx="50" cy="50" r="' + R + '" class="g-sky__moon-rim"/>'
      + '</svg>';
  }

  function countdownLine(up) {
    if (!up) return '';
    const soonest = (up.daysToFullMoon != null && up.daysToNewMoon != null)
      ? (up.daysToFullMoon <= up.daysToNewMoon
        ? { days: up.daysToFullMoon, what: 'full moon' }
        : { days: up.daysToNewMoon, what: 'new moon' })
      : null;
    if (!soonest) return '';
    if (soonest.days === 0) return 'Tonight is the ' + soonest.what + '.';
    if (soonest.days === 1) return 'The ' + soonest.what + ' is tomorrow.';
    return soonest.days + ' days to the ' + soonest.what + '.';
  }

  /** One line per phase — the strip's whole reading. Reflective, not predictive. */
  const PHASE_MOTTO = {
    'new': 'A dark sky is a blank one — name a beginning.',
    'waxing-crescent': 'A time for intention and planting new seeds.',
    'first-quarter': 'Beginnings meet friction here. Keep going.',
    'waxing-gibbous': 'Nearly full — refine what is already moving.',
    'full': 'Everything is lit. A night for seeing clearly.',
    'waning-gibbous': 'Pass on what this cycle taught you.',
    'last-quarter': 'The question turns to what to put down.',
    'waning-crescent': 'The fallow days. Do less, on purpose.',
  };

  /** The illumination, as a ring — the number with its shape around it. */
  function ringSvg(pct, tint) {
    const r = 24;
    const c = 2 * Math.PI * r;
    const lit = Math.max(0, Math.min(100, Number(pct) || 0));
    return '<svg class="g-sky__ring" viewBox="0 0 60 60" role="img" aria-label="'
      + esc(lit + '% illuminated') + '">'
      + '<circle cx="30" cy="30" r="' + r + '" class="g-sky__ring-track"/>'
      + '<circle cx="30" cy="30" r="' + r + '" class="g-sky__ring-fill" stroke="' + esc(tint) + '"'
      + ' stroke-dasharray="' + (c * lit / 100).toFixed(1) + ' ' + c.toFixed(1) + '"'
      + ' transform="rotate(-90 30 30)"/>'
      + '<text x="30" y="33" class="g-sky__ring-num">' + Math.round(lit) + '%</text>'
      + '</svg>';
  }

  function cardHtml(sky) {
    const tint = (sky.moon.chakra && sky.moon.chakra.colour) || '#8E4EC6';
    const pct = sky.moon.illumination;
    const personal = sky.personal;

    return '<article class="g-card g-sky" style="--sky-tint:' + esc(tint) + '">'
      + '<a class="g-sky__open" href="home.html?view=wellness&amp;tab=horoscope" aria-label="Open your full reading">'
      + '<p class="g-sky__kicker">Today’s sky</p>'
      + '<span class="g-sky__chev" aria-hidden="true">›</span></a>'
      + '<div class="g-sky__row">'
      + '<div class="g-sky__art">' + moonSvg(pct, sky.moon.waxing, tint) + '</div>'
      + '<div class="g-sky__lede">'
      + '<h2 class="g-sky__phase">' + esc(sky.moon.phaseLabel) + '</h2>'
      + '<p class="g-sky__motto">' + esc(PHASE_MOTTO[sky.moon.phase] || sky.guidance.theme) + '</p>'
      + '</div>'
      + '<span class="g-sky__gauge">' + ringSvg(pct, tint) + '<em>Illumination</em></span>'
      + '</div>'
      + (personal
        ? '<p class="g-sky__personal-line" style="--own:' + esc(personal.birthChakra.colour) + '">'
          + esc(personal.resonant
            ? 'Your ' + personal.birthChakra.name.toLowerCase() + ' centre is lit today.'
            : 'Today asks for your ' + ((sky.moon.chakra && sky.moon.chakra.name) || 'whole system').toLowerCase()
              + ' — yours is the ' + personal.birthChakra.name.toLowerCase() + '.')
          + '</p>'
        // The signup hook, one quiet line. The g-sky__invite class stays: it is
        // the contract the tests hold — the card offers more, never withholds.
        : '<a class="g-sky__invite" href="home.html?view=wellness&amp;tab=check">'
          + 'Add your birth date to see which of your centres this moon meets ›</a>')
      + '</article>';
  }

  async function render() {
    const hosts = document.querySelectorAll('[data-sky-host]');
    if (!hosts.length) return;
    const sky = await fetchSky();
    hosts.forEach((host) => {
      // A sky we could not compute is simply absent. An empty box with an
      // apology in it is worse than no box.
      host.innerHTML = (sky && sky.ok) ? cardHtml(sky) : '';
    });
  }

  document.addEventListener('gaia:superapp-rendered', render);
  document.addEventListener('DOMContentLoaded', render);

  window.GaiaSky = { render, moonSvg, countdownLine };
}());
