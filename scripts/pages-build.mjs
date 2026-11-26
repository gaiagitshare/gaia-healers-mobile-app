#!/usr/bin/env node
/**
 * Build the GitHub Pages artifact for gaiahealers.app from an explicit ALLOWLIST.
 *
 * Pages publishes exactly the directory it is given. Until this script existed
 * the workflow uploaded the whole checkout (`path: .`), so the proxy, the Event
 * Manager backend, docs, ops scripts and tests were all public on
 * gaiahealers.app. Now only what the member app loads is copied into _site/.
 *
 * Adding a frontend file:
 *   - a root-level page/script/stylesheet/icon is picked up by extension;
 *   - anything in a new directory, or a single file elsewhere, must be added
 *     to ALLOW_DIRS / ALLOW_FILES below on purpose.
 * scripts/pages-check.mjs then fails the build if the artifact contains a
 * denied file, or if any page references a local file that was not copied.
 *
 * Usage: node scripts/pages-build.mjs [outDir]   (default: _site)
 * Uses only Node built-ins and runs no network calls.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.argv[2] || '_site');

// Root-level files published by extension. Backups such as
// `gaia-myevents.js.prephase3.<date>` do not end in an allowed extension, and
// pages-check.mjs rejects anything that slips through anyway.
const ROOT_EXT = new Set(['.html', '.js', '.css', '.webmanifest', '.ico', '.png', '.svg', '.webp', '.jpg']);
// Root-level files published by exact name (no or unusual extension).
const ROOT_NAMES = new Set(['CNAME', '.nojekyll']);
// Root-level files that match ROOT_EXT but are NOT part of the site.
const ROOT_EXCLUDE = new Set([]);
// Whole directories published recursively.
const ALLOW_DIRS = ['assets', 'vendor'];
// Single files outside the root that the app loads by this exact path.
const ALLOW_FILES = [
  // Shared public Assist vocabulary. home.html and index.html load it from
  // this path and sw.js precaches it; the proxy imports the same file. It
  // carries no credentials (see the header comment in the file).
  'staging-proxy/assist-guide.js',
];

function copy(rel) {
  const src = path.join(ROOT, rel);
  const dst = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return rel;
}

function walk(relDir, out = []) {
  for (const ent of fs.readdirSync(path.join(ROOT, relDir), { withFileTypes: true })) {
    const rel = path.posix.join(relDir, ent.name);
    if (ent.isDirectory()) walk(rel, out);
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const copied = [];
for (const ent of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!ent.isFile()) continue;
  const name = ent.name;
  if (ROOT_EXCLUDE.has(name)) continue;
  if (ROOT_NAMES.has(name) || ROOT_EXT.has(path.extname(name).toLowerCase())) copied.push(copy(name));
}
for (const dir of ALLOW_DIRS) for (const rel of walk(dir)) copied.push(copy(rel));
for (const rel of ALLOW_FILES) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.error(`pages-build: allowlisted file is missing: ${rel}`);
    process.exit(1);
  }
  copied.push(copy(rel));
}

console.log(`pages-build: ${copied.length} files -> ${path.relative(ROOT, OUT) || OUT}`);
