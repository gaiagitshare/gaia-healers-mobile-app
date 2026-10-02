/* Eligibility is supplied by the authenticated server, never browser storage. */
(function () {
  'use strict';
  let status = 'authenticating';
  function set(next) {
    status = next;
    document.documentElement.dataset.gaiaEligibility = next;
    const blocked = !['ready', 'visitor'].includes(next);
    const shell = document.getElementById('gaia-app-shell');
    if (shell) { shell.hidden = blocked; shell.inert = blocked; }
    document.dispatchEvent(new CustomEvent('gaia:eligibility', { detail: { status: next } }));
  }
  document.addEventListener('gaia:auth', e => set(e.detail?.unavailable ? 'unavailable' : e.detail?.authenticated ? 'checking_profile' : 'visitor'));
  window.addEventListener('gaia:signed-out', () => set('visitor'));
  window.addEventListener('pageshow', e => { if (e.persisted) { set('checking_profile'); window.GaiaJourney?.check(true); } });
  window.GaiaAppGuard = Object.freeze({ set, get status() { return status; }, get canEnter() { return ['ready', 'visitor'].includes(status); } });
})();
