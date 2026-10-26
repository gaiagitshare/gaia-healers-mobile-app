/* Gaia Healers: "Try the Membership 2.0 beta" link (You screen and Store › Membership).
 *
 * One switch: BETA_LINK_ENABLED. It ships OFF, so merging this file changes nothing anyone can see.
 * Turn it on only after the owner has approved going live with https://beta.gaiahealers.app
 * (DNS, nginx and HTTPS done; see the beta activation notes).
 *
 * The link goes to the PUBLIC beta landing page. The working preview behind it needs the staff password.
 */
(function () {
  'use strict';
  var BETA_LINK_ENABLED = false;
  var BETA_URL = 'https://beta.gaiahealers.app/';

  function html(where) {
    if (!BETA_LINK_ENABLED) return '';
    var label = where === 'store' ? 'membership-beta-store' : 'membership-beta-you';
    return '<article class="g-card g-beta-link" data-beta-link="' + label + '">'
      + '<p class="g-card__label">Coming after Elevate 2026</p>'
      + '<p class="g-card__value">Gaia Healers Membership 2.0</p>'
      + '<p class="g-card__meta">Take an early look at the new Gaia Healers membership. Nothing changes in your account.</p>'
      + '<div class="g-card__actions"><a class="g-btn g-btn--secondary g-btn--sm" href="' + BETA_URL + '" target="_blank" rel="noopener">Try the Membership 2.0 beta →</a></div>'
      + '</article>';
  }

  window.GaiaBetaLink = Object.freeze({ enabled: BETA_LINK_ENABLED, url: BETA_URL, html: html });
})();
