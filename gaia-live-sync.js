/** Gaia live sync shim.
 * Reads app data only from the staging proxy. Never call GHL/Event/OpenAI directly here.
 */
(function () {
  const STAGING_PROXY = 'https://api.gaiahealers.app';
  const params = new URLSearchParams(window.location.search);
  const queryProxy = params.get('proxy') || params.get('gaia_proxy') || '';
  const explicit = window.GAIA_SYNC_PROXY_URL || queryProxy || localStorage.getItem('gaia-sync-proxy-url') || '';
  const urls = window.GAIA_APP_URLS || {};
  const productionProxy = urls.production?.proxy || 'https://api.gaiahealers.app';
  const productionFallback = urls.production?.proxyFallback || STAGING_PROXY;
  const defaultProxy = urls.isProductionApp ? productionProxy : (urls.staging?.proxy || STAGING_PROXY);
  let proxyBase = (explicit || defaultProxy).replace(/\/+$/, '');

  window.GAIA_SYNC = {
    enabled: true,
    proxyBase,
    defaultProxy,
    proxyFallback: productionFallback,
    isDefault: !explicit,
    status: 'checking',
    host: urls.isProductionApp ? 'production' : 'staging',
  };

  async function probeProxy(base) {
    const response = await fetch(`${base}/health`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (!response.ok) throw new Error(`Proxy health returned ${response.status}`);
    return base;
  }

  async function resolveProxyBase() {
    if (explicit) return proxyBase;
    if (!urls.isProductionApp) return proxyBase;
    try {
      return await probeProxy(productionProxy);
    } catch (error) {
      console.warn('[Gaia] production API proxy unavailable; using staging fallback.', error);
      try {
        return await probeProxy(productionFallback);
      } catch (fallbackError) {
        throw fallbackError;
      }
    }
  }

  async function syncBootstrap() {
    try {
      proxyBase = await resolveProxyBase();
      window.GAIA_SYNC.proxyBase = proxyBase;

      const response = await fetch(`${proxyBase}/api/app/bootstrap`, {
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      if (!response.ok) throw new Error(`Proxy returned ${response.status}`);
      const payload = await response.json();
      window.GAIA = { ...(window.GAIA || {}), ...(payload.gaia || payload) };
      window.GAIA_SYNC.status = payload.gaia?.sync?.liveData ? 'live' : 'connected';
      window.GAIA_SYNC.liveData = Boolean(payload.gaia?.sync?.liveData);
      window.GAIA_SYNC.mode = payload.gaia?.sync?.mode || window.GAIA_SYNC.status;
      window.GAIA_SYNC.error = '';
      document.dispatchEvent(new CustomEvent('gaia:sync', { detail: window.GAIA }));
    } catch (error) {
      window.GAIA_SYNC.status = 'error';
      window.GAIA_SYNC.liveData = false;
      window.GAIA_SYNC.error = error.message;
      document.dispatchEvent(new CustomEvent('gaia:sync-error', { detail: window.GAIA_SYNC }));
      console.warn('[Gaia] staging proxy sync failed; live app data is unavailable.', error);
    }
  }

  window.GAIA_SYNC.refresh = syncBootstrap;
  document.addEventListener('DOMContentLoaded', syncBootstrap);
})();
