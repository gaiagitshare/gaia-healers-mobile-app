/** Gaia — "Add to Home Screen".
 *
 * The app is already a PWA; what was missing is that nobody was ever told. On
 * Android Chrome the browser hands us an install prompt we can trigger. iOS
 * Safari has no such API at all, so the only honest thing is to show the two
 * taps a person needs — the same approach Snapp and other installable web apps
 * take.
 *
 * It stays quiet unless it can actually help: never in an installed window,
 * never in an in-app browser that cannot install, and never again once someone
 * has dismissed it.
 */
(function () {
  'use strict';

  const DISMISSED = 'gaia:install-dismissed';
  const SEEN_AT = 'gaia:install-seen';

  function isStandalone() {
    try {
      return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
    } catch (_) { return false; }
  }

  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua)
    // iPadOS 13+ reports itself as a Mac, and is only distinguishable by touch.
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  // Instagram, Facebook and similar wrappers cannot install anything, so
  // offering would only frustrate.
  const inAppBrowser = /FBAN|FBAV|Instagram|Line|Twitter|WebView/i.test(ua);

  let deferredPrompt = null;

  function dismissed() {
    try { return localStorage.getItem(DISMISSED) === '1'; } catch (_) { return false; }
  }
  function remember(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* private mode */ }
  }

  function card(inner) {
    const el = document.createElement('div');
    el.className = 'g-install';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Install Gaia Healers');
    el.innerHTML = '<div class="g-install__panel">' + inner + '</div>';
    document.body.appendChild(el);
    el.querySelectorAll('[data-install-close]').forEach((b) => b.addEventListener('click', () => {
      remember(DISMISSED, '1');
      el.remove();
    }));
    return el;
  }

  function showIosGuide() {
    const el = card(
      '<div class="g-install__head">'
      + '<img class="g-install__icon" src="assets/apple-touch-icon.png" alt="" width="52" height="52" />'
      + '<div><p class="g-install__title">Keep Gaia Healers on your home screen</p>'
      + '<p class="g-install__sub">Opens full screen, like an app.</p></div></div>'
      + '<ol class="g-install__steps">'
      + '<li>Tap <b>Share</b> in the Safari toolbar</li>'
      + '<li>Choose <b>Add to Home Screen</b></li>'
      + '</ol>'
      + '<div class="g-install__actions">'
      + '<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-install-close>Not now</button>'
      + '</div>',
    );
    return el;
  }

  function showPrompt() {
    card(
      '<div class="g-install__head">'
      + '<img class="g-install__icon" src="assets/icon-192.png" alt="" width="52" height="52" />'
      + '<div><p class="g-install__title">Install Gaia Healers</p>'
      + '<p class="g-install__sub">Full screen, and one tap from your home screen.</p></div></div>'
      + '<div class="g-install__actions">'
      + '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-install-go>Install</button>'
      + '<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-install-close>Not now</button>'
      + '</div>',
    ).querySelector('[data-install-go]').addEventListener('click', async function () {
      this.disabled = true;
      const prompt = deferredPrompt;
      deferredPrompt = null;
      if (!prompt) return;
      prompt.prompt();
      const choice = await prompt.userChoice.catch(() => null);
      // Either way the card has done its job.
      remember(DISMISSED, choice && choice.outcome === 'accepted' ? '1' : '1');
      document.querySelector('.g-install')?.remove();
    });
  }

  // Android/desktop Chrome: the browser tells us when it is installable.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    if (!isStandalone() && !dismissed()) setTimeout(showPrompt, 2500);
  });

  window.addEventListener('appinstalled', () => {
    remember(DISMISSED, '1');
    document.querySelector('.g-install')?.remove();
  });

  document.addEventListener('DOMContentLoaded', () => {
    if (isStandalone() || dismissed() || inAppBrowser) return;
    // iOS never fires beforeinstallprompt, so the guide is the only route.
    // Held back until a second visit: a first-time visitor has not decided
    // they want this yet, and asking immediately is how banners get ignored.
    if (isIOS && isSafari) {
      let seen = 0;
      try { seen = Number(localStorage.getItem(SEEN_AT) || 0); } catch (_) { /* ignore */ }
      remember(SEEN_AT, String(seen + 1));
      if (seen >= 1) setTimeout(showIosGuide, 3000);
    }
  });

  window.GaiaInstall = { showIosGuide, isStandalone, isIOS };
}());
