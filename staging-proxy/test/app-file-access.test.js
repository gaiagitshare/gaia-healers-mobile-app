/**
 * HOW TESTS REACH THE APP'S SOURCE — the rule, enforced.
 *
 * The app ships to Cloudflare Pages from its own repository and the proxy runs
 * on a VPS, so a suite that asserts things about the frontend has to find those
 * files first. There are two layouts: in CI the proxy is `staging-proxy/`
 * inside the app repo, and on the server the two are sibling checkouts under
 * /root. Every test that built its own path knew only the first.
 *
 * What that cost, found on 2 Oct 2026 by counting assertions actually executed
 * rather than by reading the files:
 *
 *   assist-ui-contract        reported 12 PASSES without opening a file --
 *                             including the five written after somebody could
 *                             not stop Gaia talking
 *   practice-navigation       19 assertions, never run on this server
 *   practitioner-ui-contract  12 assertions, never run on this server
 *   sky                       6 tests failing on a file sitting next door
 *   assist-tools-contract     7 of its 99 assertions reached
 *   practice-journal,
 *   membership-frontend-guard,
 *   membership-public-catalogue   skipped entirely, with a reason that said
 *                             the app "genuinely is not there". It was.
 *
 * 38 tests and 778 assertions, sitting out a layout assumption. The suite went
 * from 576 passing to 632 without a line of product code changing.
 *
 * Two rules now hold the line, and this file is both of them:
 *
 *   1. There is ONE way to read an app file: readApp() from _app-present.js,
 *      which knows both layouts. A test that builds its own path is the bug.
 *   2. A file that cannot be found THROWS. Returning null or '' and carrying
 *      on is how twelve assertions reported a pass while reading nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appPresent, readApp, appRoot, appRoots } from './_app-present.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const suites = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js') && f !== path.basename(fileURLToPath(import.meta.url)));

/** Files the proxy owns; reaching for these with a local path is fine. */
const PROXY_OWNED = /\b(proxyRoot|workdir|here|tmp|dir|outDir|base)\b/;

test('no suite builds its own path up and out to the app', () => {
  // `path.resolve(x, '..', 'gaia-foo.js')` and `path.join(appRoot, …)` are the
  // two shapes that broke. Reading a PROXY file relative to the test is fine --
  // the proxy is always where the test is.
  const offenders = [];
  for (const file of suites) {
    const src = fs.readFileSync(path.join(testDir, file), 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;                 // a comment about the rule
      const reachesOut = /(resolve|join)\([^)]*['"]\.\.['"][^)]*['"][\w.-]+\.(js|css|html)['"]/.test(line);
      const usesAppRoot = /(resolve|join)\(\s*appRoot\b/.test(line);
      if (!reachesOut && !usesAppRoot) continue;
      if (reachesOut && PROXY_OWNED.test(line) && !/gaia-|home\.html/.test(line)) continue;
      offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 96)}`);
    }
  }
  assert.deepEqual(offenders, [],
    'these reach for an app file on their own instead of readApp(), which is how\n'
    + '38 tests ended up running on no machine anybody looked at:\n  ' + offenders.join('\n  '));
});

test('a file that cannot be found is an error, never an empty string', () => {
  // The quiet failure mode: readApp() returning '' and every regex against it
  // matching nothing, or matching `!/x/` and passing.
  assert.throws(() => readApp('this-file-does-not-exist-anywhere.js'),
    /not found/i,
    'a missing app file has to stop the test, not feed it an empty string');
});

test('when there is more than one checkout, the newest is the one used', () => {
  // This server has two: /root/gaia-healers-mobile-app (4 Sep) and
  // /root/gaia-healers-mobile-app-1 (the mirror the deploy writes to). Asserting
  // tonight's contracts against September's source would PASS, which is worse
  // than skipping -- so the choice is by mtime and checked here rather than
  // left to which name sorts first.
  const roots = appRoots();
  if (roots.length < 2) return;
  const newest = roots[0];
  assert.equal(path.resolve(appRoot), path.resolve(newest),
    `${roots.length} app checkouts are visible and the stalest could be picked:\n  ` + roots.join('\n  '));
});

test('the helper finds the app wherever it is checked out', () => {
  // Independent of the helper's own search: if any directory at or beside the
  // proxy's parent holds the app, appPresent() must agree.
  const parent = path.resolve(testDir, '..', '..');
  const found = [parent, ...fs.readdirSync(parent, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(parent, d.name))]
    .filter((dir) => fs.existsSync(path.join(dir, 'gaia-superapp.js')));
  if (!found.length) return;                // genuinely no app here
  assert.ok(appPresent(),
    `the app is at ${found[0]} but appPresent() says it is not, so every suite that reads it will skip`);
  assert.ok(found.map((f) => path.resolve(f)).includes(path.resolve(appRoot)),
    `appRoot is ${appRoot}, which is not one of the checkouts that actually exist`);
  assert.ok(readApp('gaia-superapp.js').length > 0, 'and readApp must actually return it');
});

test('the suites that read the app are actually reading it here', () => {
  // The specific ones that were not. If the layout breaks again, this names
  // them rather than leaving them to report green.
  if (!appPresent()) return;
  for (const file of ['gaia-ui.js', 'gaia-realtime-voice.js', 'gaia-practitioner.js',
                      'gaia-practice.js', 'gaia-sky.js', 'gaia-wellness.js',
                      'gaia-toolkit.js', 'home.html']) {
    assert.ok(readApp(file).length > 0, `${file} is unreadable, so whatever asserts on it is not running`);
  }
});
