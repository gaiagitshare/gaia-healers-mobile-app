/**
 * In-app reader for pages that refuse to be framed.
 *
 * gaiahealers.com is Shopify, and Shopify sends `X-Frame-Options: DENY` on
 * storefront pages. That is enforced by the browser, so no amount of client
 * code can put those pages in an iframe — an app that tries gets a blank
 * panel and looks broken while the site is perfectly fine.
 *
 * So instead of framing the page, this fetches it server-side and returns just
 * its readable content, which the app renders in Gaia's own shell. The result
 * is better than an iframe would have been: it inherits Gaia's typography, it
 * carries no third-party scripts, and it works offline once cached.
 *
 * Two hard rules:
 *   1. Only Gaia's own hosts may be fetched. A reader that takes an arbitrary
 *      URL is an open proxy — anyone could point it at an internal address and
 *      read the response through us.
 *   2. What comes back is sanitised, not trusted. It arrives as markup from a
 *      CMS anyone with store access can edit, so scripts, frames, event
 *      handlers and inline styles are stripped before it reaches a page that
 *      holds a member session.
 */

const ALLOWED_HOSTS = new Set([
  'gaiahealers.com',
  'www.gaiahealers.com',
]);

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

function allowed(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname);
  } catch (_) {
    return false;
  }
}

/** Strip everything executable or layout-hijacking. Deny-by-default on tags. */
function sanitize(html, baseUrl) {
  let out = String(html || '');

  // Whole elements whose content must never survive.
  for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'noscript',
    'form', 'svg', 'canvas', 'video', 'audio', 'template']) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'gi'), '');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), '');
  }
  // Head-only tags leak into Shopify page bodies; they render as stray text.
  for (const tag of ['meta', 'link', 'title', 'base', 'input', 'button', 'select', 'textarea']) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), '');
  }
  // Inline handlers and javascript: targets.
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/\s(?:href|src)\s*=\s*("|')\s*javascript:[^"']*\1/gi, ' href="#"');
  // Inline styles: a CMS author cannot be allowed to position things over the app.
  out = out.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, '');
  out = out.replace(/\s(?:class|id)\s*=\s*("[^"]*"|'[^']*')/gi, '');

  // Relative links and images must resolve against the source, not the app.
  out = out.replace(/\s(href|src)\s*=\s*"(?!https?:|data:|#|mailto:|tel:)([^"]*)"/gi,
    (m, attr, value) => {
      try { return ` ${attr}="${new URL(value, baseUrl).href}"`; } catch (_) { return ''; }
    });
  // Shopify's protocol-relative CDN URLs.
  out = out.replace(/\s(href|src)\s*=\s*"\/\//gi, ' $1="https://');
  // Every link leaves the app deliberately.
  out = out.replace(/<a\b/gi, '<a target="_blank" rel="noopener noreferrer"');

  return out.trim();
}

/** The readable body of a Shopify page, in preference order. */
function extractContent(html) {
  const patterns = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<div\b[^>]*class="[^"]*\brte\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
  ];
  for (const pattern of patterns) {
    const found = html.match(pattern);
    if (found && found[1] && found[1].replace(/<[^>]+>/g, '').trim().length > 200) {
      return found[1];
    }
  }
  return '';
}

function extractTitle(html) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return h1[1].replace(/<[^>]+>/g, '').trim().slice(0, 160);
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return title ? title[1].split('–')[0].split('|')[0].trim().slice(0, 160) : '';
}

/* Feed text arrives XML-escaped, and the app escapes again on render. Without
 * decoding here a title with an ampersand shows as "Rest &amp; Recovery". */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code) : whole;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** Blog index → a list of articles, read from Shopify's public Atom feed. */
function parseFeed(xml) {
  const entries = [];
  const blocks = String(xml).split(/<entry\b/i).slice(1);
  for (const block of blocks.slice(0, 20)) {
    const pick = (tag) => {
      const found = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      if (!found) return '';
      const text = found[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '');
      return decodeEntities(text).replace(/\s+/g, ' ').trim();
    };
    const link = block.match(/<link[^>]*href="([^"]+)"/i);
    const summary = pick('summary') || pick('content');
    entries.push({
      title: pick('title'),
      url: link ? link[1] : '',
      published: pick('published') || pick('updated'),
      summary: summary.slice(0, 260),
    });
  }
  return entries.filter((e) => e.title && e.url);
}

async function read(rawUrl) {
  if (!allowed(rawUrl)) return { ok: false, reason: 'host_not_allowed' };

  const hit = cache.get(rawUrl);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  let value;
  try {
    const response = await fetch(rawUrl, {
      headers: { 'User-Agent': 'GaiaHealersApp/1.0 (+https://gaiahealers.app)' },
      redirect: 'follow',
    });
    if (!response.ok) {
      value = { ok: false, reason: `source_${response.status}` };
    } else {
      const body = await response.text();
      // A blog index reads better as a list than as a wall of markup.
      const isBlogIndex = /\/blogs\/[^/]+\/?$/.test(new URL(rawUrl).pathname);
      if (isBlogIndex) {
        const feedUrl = rawUrl.replace(/\/?$/, '') + '.atom';
        const feed = await fetch(feedUrl).then((r) => (r.ok ? r.text() : '')).catch(() => '');
        const articles = parseFeed(feed);
        value = articles.length
          ? { ok: true, kind: 'list', title: extractTitle(body) || 'Gaia articles',
              articles, source: rawUrl }
          : { ok: false, reason: 'no_articles' };
      } else {
        const content = extractContent(body);
        value = content
          ? { ok: true, kind: 'page', title: extractTitle(body),
              html: sanitize(content, rawUrl), source: rawUrl }
          : { ok: false, reason: 'no_readable_content' };
      }
    }
  } catch (_) {
    value = { ok: false, reason: 'source_unreachable' };
  }

  cache.set(rawUrl, { at: Date.now(), value });
  return value;
}

export { read, allowed, sanitize, parseFeed, decodeEntities, extractContent, ALLOWED_HOSTS };
