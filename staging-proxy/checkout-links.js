/**
 * Official checkout links for the app (28 Oct 2026).
 *
 * The event website is the source of truth, and its ticket buttons point at a
 * GHL *preview* address (sites.leadconnectorhq.com/preview/<pageId>, or
 * crm.gaiahealers.com/v2/preview/<pageId>) for a page that is also published
 * on the event's own domain (elevate.gaiahealers.com/cart). Both take the
 * same order: GHL records the same page and step either way. The published
 * address is the one buyers should see, so the app shows that one.
 *
 * Nothing on GHL changes. The website keeps its links; this only decides
 * which address the app's button opens:
 *   1. the link is a GHL preview of page P;
 *   2. GHL's funnel list (read only, the proxy's existing connection) gives
 *      the funnel step that serves P and that step's path;
 *   3. the candidate is that path on the host of the website page the link
 *      came from (the funnel's own domain);
 *   4. the candidate is used ONLY if it answers 200 and is page P (its HTML
 *      carries P's id). Anything else keeps the website's link unchanged.
 * Results are cached; a failure is never cached as a success.
 */

const PREVIEW_RE = /\/(?:v2\/)?preview\/([A-Za-z0-9]{12,})(?:[/?#]|$)/;

export function previewPageId(url) {
  try {
    const u = new URL(String(url || ''));
    if (!/^https?:$/.test(u.protocol)) return null;
    const m = u.pathname.match(PREVIEW_RE) || (u.pathname + '/').match(PREVIEW_RE);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

export function createCheckoutLinkResolver({ ghlGet, locationId, fetchPage, now = () => Date.now(),
  indexTtlMs = 6 * 3600 * 1000, linkTtlMs = 6 * 3600 * 1000, maxFunnelPages = 10 } = {}) {
  let index = null; // { at, byPage: Map(pageId -> { funnelId, path }) }
  const links = new Map(); // `${url}|${host}` -> { at, value }

  async function loadIndex() {
    if (index && now() - index.at < indexTtlMs) return index;
    const loc = typeof locationId === 'function' ? locationId() : locationId;
    if (!ghlGet || !loc) return null;
    const byPage = new Map();
    for (let p = 0; p < maxFunnelPages; p += 1) {
      const res = await ghlGet('/funnels/funnel/list', { locationId: loc, limit: 100, offset: p * 100 });
      const funnels = (res && Array.isArray(res.funnels)) ? res.funnels : null;
      if (!funnels) { if (p === 0) return null; break; }
      for (const f of funnels) {
        for (const step of (f.steps || [])) {
          for (const pid of (step.pages || [])) {
            if (pid && step.url) byPage.set(String(pid), { funnelId: f._id, path: String(step.url) });
          }
        }
      }
      if (funnels.length < 100) break;
    }
    index = { at: now(), byPage };
    return index;
  }

  /** The address the app should open for `url`, found on website page `sourceUrl`. */
  async function resolve(url, sourceUrl) {
    const pageId = previewPageId(url);
    if (!pageId) return url;
    let host = '';
    try { host = new URL(String(sourceUrl || '')).host; } catch (_) { host = ''; }
    if (!host) return url;
    const key = `${url}|${host}`;
    const hit = links.get(key);
    if (hit && now() - hit.at < linkTtlMs) return hit.value;
    let value = url;
    try {
      const idx = await loadIndex();
      const step = idx && idx.byPage.get(pageId);
      if (step && step.path.startsWith('/')) {
        const candidate = `https://${host}${step.path}`;
        const page = await fetchPage(candidate);
        if (page && page.status === 200 && typeof page.body === 'string' && page.body.includes(pageId)) {
          value = candidate;
        }
      }
    } catch (_) {
      value = url;
    }
    // Only a verified answer is kept; a miss is retried next time.
    if (value !== url) links.set(key, { at: now(), value });
    return value;
  }

  /** Rewrite the `url` of every site item; the website's own link stays in `site_url`. */
  async function correctSite(site) {
    if (!site || typeof site !== 'object') return site;
    const out = { ...site };
    for (const kind of ['tickets', 'packages', 'hotel']) {
      if (!Array.isArray(site[kind])) continue;
      out[kind] = await Promise.all(site[kind].map(async (item) => {
        if (!item || !item.url) return item;
        const official = await resolve(item.url, item.source_url);
        return official === item.url ? item : { ...item, url: official, site_url: item.url };
      }));
    }
    return out;
  }

  /** correctSite, but never slower than `ms`: on a slow GHL the website's links stand. */
  async function correctSiteWithin(site, ms = 4000) {
    let timer;
    const late = new Promise((res) => { timer = setTimeout(() => res(site), ms); });
    try { return await Promise.race([correctSite(site), late]); } finally { clearTimeout(timer); }
  }

  return { resolve, correctSite, correctSiteWithin };
}

/** Default page fetcher: a plain GET with a short timeout; never throws. */
export async function fetchPageText(url, timeoutMs = 10000) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'Mozilla/5.0 (GaiaCheckoutLinkCheck)' } });
    return { status: r.status, body: await r.text() };
  } catch (_) {
    return null;
  }
}
