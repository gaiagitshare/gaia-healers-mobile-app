/** Gaia Healers — production URLs for app, API proxy, and embeds. */
(function () {
  const PRODUCTION_APP_HOSTS = new Set([
    'gaiahealers.app',
    'www.gaiahealers.app',
    'app.gaiahealers.app',
  ]);

  const hostname = window.location.hostname || '';
  const isProductionApp = PRODUCTION_APP_HOSTS.has(hostname);

  window.GAIA_APP_URLS = {
    production: {
      app: 'https://gaiahealers.app',
      home: 'https://gaiahealers.app/home.html',
      proxy: 'https://api.gaiahealers.app',
      proxyFallback: 'https://ba2ki.com/gaia-proxy',
    },
    staging: {
      app: 'https://gaiagitshare.github.io/gaia-healers-mobile-app',
      home: 'https://gaiagitshare.github.io/gaia-healers-mobile-app/home.html',
      proxy: 'https://ba2ki.com/gaia-proxy',
    },
    isProductionApp,
    current: {
      origin: window.location.origin,
      home: `${window.location.origin}/home.html`,
    },
  };
})();
