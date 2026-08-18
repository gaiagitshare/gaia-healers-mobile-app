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

  function cardHtml(sky) {
    const tint = (sky.moon.chakra && sky.moon.chakra.colour) || '#8E4EC6';
    const pct = sky.moon.illumination;
    const personal = sky.personal;

    return '<article class="g-card g-sky" style="--sky-tint:' + esc(tint) + '">'
      + '<div class="g-sky__head">'
      + '<div class="g-sky__art">' + moonSvg(pct, sky.moon.waxing, tint) + '</div>'
      + '<div class="g-sky__lede">'
      + '<p class="g-sky__kicker">Today’s sky · everyone</p>'
      + '<h2 class="g-sky__phase">' + esc(sky.moon.phaseLabel) + '</h2>'
      + '<p class="g-sky__facts">'
      + '<span>' + esc(pct) + '% lit</span>'
      + '<span>in ' + esc(sky.moon.sign) + '</span>'
      + (sky.moon.chakra ? '<span class="g-sky__chakra">' + esc(sky.moon.chakra.name) + '</span>' : '')
      + '</p>'
      + '</div></div>'

      + '<p class="g-sky__theme">' + esc(sky.guidance.theme) + '</p>'
      + '<p class="g-sky__invitation">' + esc(sky.guidance.invitation) + '</p>'
      + '<p class="g-sky__practice"><strong>Try this</strong> ' + esc(sky.guidance.practice) + '</p>'

      + (personal
        // Signed up: the sky read against their own chart. No call to action —
        // they already did the thing we would be asking for.
        ? '<div class="g-sky__personal" style="--own:' + esc(personal.birthChakra.colour) + '">'
          + '<p class="g-sky__personal-head">'
          + (personal.resonant ? 'Your centre is lit today' : 'For you, ' + esc(personal.firstName))
          + '</p>'
          + '<p>' + esc(personal.note) + '</p>'
          + '<a class="g-sky__personal-link" href="home.html?view=wellness&amp;tab=horoscope">'
          + 'See your full chart today →</a>'
          + '</div>'
        // Not signed up: the honest version of the offer. It names exactly what
        // is added and what it costs — a birth date — rather than dangling a
        // vague "unlock more".
        : '<div class="g-sky__invite">'
          + '<p class="g-sky__invite-head">This is the sky for everyone today.</p>'
          + '<p>Add your birth date to see which of your centres this moon meets.</p>'
          + '<a class="g-btn g-btn--primary g-btn--sm" href="home.html?view=wellness&amp;tab=check">'
          + 'Read my chart</a>'
          + '</div>')

      + '<p class="g-sky__foot">'
      + '<span>' + esc(countdownLine(sky.upcoming)) + '</span>'
      // Said out loud, because the entire appeal is that it is checkable.
      + '<span class="g-sky__source">Calculated, not written in advance.</span>'
      + '</p>'
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
