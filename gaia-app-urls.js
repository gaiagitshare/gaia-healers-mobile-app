/** Gaia Healers — production URLs for app, API proxy, and embeds. */
(function () {
  const PRODUCTION_APP_HOSTS = new Set([
    'gaiahealers.app',
    'www.gaiahealers.app',
    'app.gaiahealers.app',
  ]);

  const hostname = window.location.hostname || '';
  const isProductionApp = PRODUCTION_APP_HOSTS.has(hostname);

  /**
   * THE place the app learns where the API is. Every script asks here first;
   * their own fallbacks stay only for a page that loaded without this file.
   * (A script that guessed a global once resolved to '' and asked the website
   * for /api/..., which hid the Practice tab for everyone: 4 Oct 2026.)
   */
  window.GaiaApi = {
    base() {
      const pick = (window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
        || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
        || (window.GaiaConfig && window.GaiaConfig.proxyBase)
        || window.GAIA_PROXY_BASE
        || 'https://api.gaiahealers.app';
      return String(pick).replace(/\/+$/, '');
    },
  };

  window.GAIA_APP_URLS = {
    production: {
      app: 'https://gaiahealers.app',
      home: 'https://gaiahealers.app/home.html',
      proxy: 'https://api.gaiahealers.app',
      proxyFallback: 'https://api.gaiahealers.app',
    },
    staging: {
      app: 'https://gaiagitshare.github.io/gaia-healers-mobile-app',
      home: 'https://gaiagitshare.github.io/gaia-healers-mobile-app/home.html',
      proxy: 'https://api.gaiahealers.app',
    },
    isProductionApp,
    current: {
      origin: window.location.origin,
      home: `${window.location.origin}/home.html`,
    },
  };
})();
