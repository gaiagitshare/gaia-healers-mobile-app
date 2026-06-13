/** Gaia live sync shim.
 * Reads app data only from the staging proxy. Never call GHL/Event/OpenAI directly here.
 */
(function () {
  const params = new URLSearchParams(window.location.search);
  const queryProxy = params.get('proxy') || params.get('gaia_proxy') || '';
  const explicit = window.GAIA_SYNC_PROXY_URL || queryProxy || localStorage.getItem('gaia-sync-proxy-url') || '';
  const proxyBase = explicit.replace(/\/+$/, '');

  window.GAIA_SYNC = {
    enabled: Boolean(proxyBase),
    proxyBase,
    status: proxyBase ? 'configured' : 'static-fallback',
  };

  if (!proxyBase) return;

  async function syncBootstrap() {
    try {
      const response = await fetch(`${proxyBase}/api/app/bootstrap`, {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
      });
      if (!response.ok) throw new Error(`Proxy returned ${response.status}`);
      const payload = await response.json();
      window.GAIA = { ...(window.GAIA || {}), ...(payload.gaia || payload) };
      window.GAIA_SYNC.status = 'live';
      document.dispatchEvent(new CustomEvent('gaia:sync', { detail: window.GAIA }));
    } catch (error) {
      window.GAIA_SYNC.status = 'error';
      window.GAIA_SYNC.error = error.message;
      console.warn('[Gaia] live sync failed; using static fallback.', error);
    }
  }

  document.addEventListener('DOMContentLoaded', syncBootstrap);
})();
