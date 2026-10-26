#!/usr/bin/env node
/**
 * Verify the GitHub Pages artifact built by scripts/pages-build.mjs.
 *
 * Fails (exit 1) when:
 *   (a) the artifact contains a file that must never be public: backend source,
 *       docs, ops, tests, scripts, Markdown, SQL, Python, tests, package files,
 *       env files, backups, migrations, agent instruction files;
 *   (b) a page, script, stylesheet, the service worker precache list or the web
 *       manifest references a same-origin file that is not in the artifact.
 *
 * Usage: node scripts/pages-check.mjs [siteDir]   (default: _site)
 * Uses only Node built-ins and runs no network calls.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.resolve(ROOT, process.argv[2] || '_site');

if (!fs.existsSync(SITE)) {
  console.error(`pages-check: ${SITE} does not exist; run scripts/pages-build.mjs first`);
  process.exit(1);
}

function walk(dir, base = '', out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(path.join(dir, ent.name), rel, out);
    else out.push(rel);
  }
  return out;
}

const files = walk(SITE).sort();
const fileSet = new Set(files);
const errors = [];

// ── (a) denylist ──────────────────────────────────────────────────────────
// Exact files allowed despite matching a denied directory. Keep in step with
// ALLOW_FILES in pages-build.mjs.
const DENY_EXCEPTIONS = new Set(['staging-proxy/assist-guide.js']);
const DENY = [
  [/^(staging-proxy|event-manager|membership-service|docs|ops|tests?|scripts|design-reference|ghl[^/]*|app-store|branding|admin|prototype|audits|output|NEW|secrets|node_modules|\.github|\.claude)\//i, 'non-frontend directory'],
  [/(^|\/)(AGENTS|CLAUDE|README)[^/]*$/i, 'agent / repo instruction file'],
  [/\.md$/i, 'Markdown'],
  [/\.(sql|py|pyc|sh|db|sqlite\d?|pem|key|p12|jks|keystore|zip|tar|gz|log|pid)$/i, 'server / data / key file'],
  [/\.test\.|\.spec\./i, 'test file'],
  [/(^|\/)package(-lock)?\.json$/i, 'package manifest'],
  [/(^|\/)\.env(\.|$)/i, 'env file'],
  [/(^|\/)\.git(ignore|attributes)?$/i, 'git metadata'],
  [/\.bak|\.orig$|\.old(\.|$)|~$/i, 'backup file'],
  [/\.pre[a-z0-9-]*\.|\.pre[a-z0-9-]*$/i, 'pre-change snapshot'],
  [/(^|\/)migrations?\//i, 'migration'],
];
for (const f of files) {
  if (DENY_EXCEPTIONS.has(f)) continue;
  for (const [re, why] of DENY) {
    if (re.test(f)) { errors.push(`DENIED  ${f}  (${why})`); break; }
  }
}

// ── (b) every local reference resolves inside the artifact ────────────────
const ASSET_EXT = 'js|mjs|css|html|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|json|webmanifest|mp3|mp4|webm|m4a|wav|vtt|txt|pdf';
const EXT_RE = new RegExp(`\\.(${ASSET_EXT})$`, 'i');

function isExternal(u) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{|\$)/i.test(u);
}

/** Resolve a reference found in `fromFile` to an artifact-relative path, or null. */
function resolveRef(raw, fromFile, { relativeToRoot = false } = {}) {
  let u = String(raw).trim();
  if (!u || isExternal(u)) return null;
  if (/[`${}<>\s'"+]/.test(u)) return null; // template / concatenation: not a literal path
  u = u.split('#')[0].split('?')[0];
  if (!u) return null;
  let target;
  if (u.startsWith('/')) target = u.slice(1);
  else {
    const base = relativeToRoot ? '' : path.posix.dirname(fromFile);
    target = path.posix.normalize(path.posix.join(base === '.' ? '' : base, u));
  }
  if (target.startsWith('..')) return { target, escapes: true };
  if (target === '' || target.endsWith('/')) target += 'index.html';
  return { target };
}

const refs = []; // { from, raw, target }
function add(from, raw, opts) {
  const r = resolveRef(raw, from, opts);
  if (r) refs.push({ from, raw, ...r });
}

for (const f of files) {
  const ext = path.extname(f).toLowerCase();
  if (!['.html', '.css', '.js', '.webmanifest'].includes(ext)) continue;
  const text = fs.readFileSync(path.join(SITE, f), 'utf8');

  if (ext === '.html') {
    // src / href / poster / data-src / srcset / <meta content="…png">
    for (const m of text.matchAll(/\s(?:src|href|poster|data-src|action)\s*=\s*["']([^"']+)["']/gi)) {
      const v = m[1];
      // Navigational hrefs to directories / routes are checked like files.
      add(f, v);
    }
    for (const m of text.matchAll(/\ssrcset\s*=\s*["']([^"']+)["']/gi)) {
      for (const part of m[1].split(',')) add(f, part.trim().split(/\s+/)[0]);
    }
    for (const m of text.matchAll(/<meta[^>]+content\s*=\s*["']([^"']+\.(?:png|jpe?g|webp|svg|ico))["']/gi)) add(f, m[1]);
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(f, m[1]);
  }

  if (ext === '.css') {
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      if (!m[1].startsWith('data:')) add(f, m[1]);
    }
    for (const m of text.matchAll(/@import\s+["']([^"']+)["']/gi)) add(f, m[1]);
  }

  if (ext === '.js' && !f.startsWith('vendor/')) {
    // Scripts run in the page's context, so a relative literal resolves from
    // the site root (every page lives at the root). Only string literals that
    // look like a file path are checked; built-up URLs are skipped.
    for (const m of text.matchAll(/(["'`])((?:\.{0,2}\/)?[A-Za-z0-9_.\-/]+)\1/g)) {
      const v = m[2];
      if (!EXT_RE.test(v)) continue;
      if (!v.includes('/') && !/\.(html|js|css|png|jpe?g|webp|svg|woff2?|webmanifest|json)$/i.test(v)) continue;
      // Bare module-ish names ("leaflet.js" in a comment string) still must exist.
      add(f, v, { relativeToRoot: true });
    }
  }

  if (ext === '.webmanifest') {
    const j = JSON.parse(text);
    const urls = [j.start_url, j.id, ...(j.icons || []).map((i) => i.src)];
    for (const s of j.shortcuts || []) urls.push(s.url, ...(s.icons || []).map((i) => i.src));
    for (const s of j.screenshots || []) urls.push(s.src);
    for (const u of urls.filter(Boolean)) add(f, u);
  }
}

// The service worker precache list is the one place a missing file silently
// costs offline support, so it is checked explicitly as well.
if (fileSet.has('sw.js')) {
  const sw = fs.readFileSync(path.join(SITE, 'sw.js'), 'utf8');
  const shell = /APP_SHELL\s*=\s*\[([\s\S]*?)\]/.exec(sw);
  if (!shell) errors.push('sw.js: APP_SHELL list not found');
  else for (const m of shell[1].matchAll(/["']([^"']+)["']/g)) add('sw.js', m[1]);
}

// References that point at files which were never in the repository and also
// 404 on the live site before this check existed. Each is harmless, and listed
// so the check catches NEW gaps without failing on these. Key: "from -> raw".
const KNOWN_ABSENT = new Map([
  // A filename for a generated download / share, not a fetched URL.
  ['gaia-share.js -> gaia-energy.png', 'File() / download name for a canvas export'],
  // Leaflet's stock control and marker images. The directory map uses divIcon
  // pins and no layers control, so these are never requested.
  ['vendor/leaflet/leaflet.css -> images/layers.png', 'unused Leaflet layers control'],
  ['vendor/leaflet/leaflet.css -> images/layers-2x.png', 'unused Leaflet layers control'],
  ['vendor/leaflet/leaflet.css -> images/marker-icon.png', 'unused default Leaflet marker (divIcon is used)'],
  // Older-format fallbacks in the @font-face src list; every supported browser
  // takes Phosphor.woff2, which is shipped.
  ['vendor/phosphor/phosphor.css -> ./Phosphor.woff', 'font fallback; woff2 is shipped'],
  ['vendor/phosphor/phosphor.css -> ./Phosphor.ttf', 'font fallback; woff2 is shipped'],
  ['vendor/phosphor/phosphor.css -> ./Phosphor.svg#Phosphor', 'font fallback; woff2 is shipped'],
]);

const seen = new Set();
for (const r of refs) {
  const key = `${r.from}\0${r.target}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (r.escapes) { errors.push(`ESCAPES ${r.from} -> ${r.raw}`); continue; }
  if (!fileSet.has(r.target) && !KNOWN_ABSENT.has(`${r.from} -> ${r.raw}`)) errors.push(`MISSING ${r.from} -> ${r.raw}  (expected ${r.target})`);
}

console.log(`pages-check: ${files.length} files, ${seen.size} local references checked`);
if (errors.length) {
  for (const e of errors) console.error('  ' + e);
  console.error(`pages-check: FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log('pages-check: OK');
