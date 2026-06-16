/** Gaia live sync shim.
 * Reads app data only from the staging proxy. Never call GHL/Event/OpenAI directly here.
 */
(function () {
  const DEFAULT_PROXY = 'https://ba2ki.com/gaia-proxy';
  const params = new URLSearchParams(window.location.search);
  const queryProxy = params.get('proxy') || params.get('gaia_proxy') || '';
  const explicit = window.GAIA_SYNC_PROXY_URL || queryProxy || localStorage.getItem('gaia-sync-proxy-url') || '';
  const proxyBase = (explicit || DEFAULT_PROXY).replace(/\/+$/, '');

  window.GAIA_SYNC = {
    enabled: true,
    proxyBase,
    defaultProxy: DEFAULT_PROXY,
    isDefault: !explicit,
    status: 'checking',
  };

  async function syncBootstrap() {
    try {
      const health = await fetch(`${proxyBase}/health`, {
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      if (!health.ok) throw new Error(`Proxy health returned ${health.status}`);

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
