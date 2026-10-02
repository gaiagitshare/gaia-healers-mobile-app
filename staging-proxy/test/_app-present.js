/**
 * Is the Gaia app checked out next to the proxy?
 *
 * The app deploys to Cloudflare Pages from its own repository, so on the VPS
 * that runs the proxy these files genuinely are not there. Tests that read app
 * source are real and valuable — they are how we assert the frontend carries no
 * tier-name regex and no hardcoded prices — but they can only run where both
 * halves are present.
 *
 * They skip there rather than fail. A suite that reports red because of
 * deployment layout teaches people to stop reading red, which costs more than
 * the tests are worth.
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Where the app actually is, decided rather than assumed.
 *
 * Two layouts: in CI the proxy is `staging-proxy/` inside the app repo, so two
 * levels up IS the app. On the server the two are sibling checkouts under
 * /root. Only the first was known here, so every suite that reads app source
 * skipped on the server with a reason that said the app "genuinely is not
 * there" -- 38 tests and 778 assertions sitting out a layout assumption.
 *
 * And there can be MORE THAN ONE checkout. This server has two, one of them a
 * month stale. Picking the wrong one would assert tonight's contracts against
 * September's source and pass, which is worse than skipping. So the newest wins
 * and test/app-file-access.test.js checks that the newest is what got picked.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SENTINEL = 'gaia-superapp.js';

function candidates() {
  const parent = path.resolve(here, '..', '..');
  const dirs = [parent];
  try {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('gaia-healers-mobile-app')) {
        dirs.push(path.join(parent, entry.name));
      }
    }
  } catch { /* unreadable parent: the single candidate stands */ }
  return dirs.filter((dir) => fs.existsSync(path.join(dir, SENTINEL)));
}

/** Every app checkout we can see, newest first. */
function appRoots() {
  return candidates()
    .map((dir) => ({ dir, at: fs.statSync(path.join(dir, SENTINEL)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .map((x) => x.dir);
}

const appRoot = appRoots()[0] || path.resolve(here, '..', '..');

/** True when the app sources sit alongside the proxy, in either layout. */
const appPresent = (file = SENTINEL) => appRoots().some((dir) => fs.existsSync(path.join(dir, file)));

/**
 * Read an app file. THROWS when it is not there.
 *
 * It used to return '' so callers could carry on. They did: every regex ran
 * against an empty string, `assert.ok(!/x/.test(src))` passed, and twelve
 * assertions reported green without opening anything. A test that cannot find
 * its subject has to say so.
 */
const readApp = (file) => {
  for (const dir of appRoots()) {
    const full = path.join(dir, file);
    if (fs.existsSync(full)) return fs.readFileSync(full, 'utf8');
  }
  throw new Error(`${file} not found in any app checkout beside the proxy (looked in: ${appRoots().join(', ') || 'none'})`);
};

/** A test that runs only where the app is available. */
function appTest(name, fn, file = 'gaia-superapp.js') {
  return test(name, { skip: appPresent(file) ? false : 'Gaia app not checked out beside the proxy' }, fn);
}

export { appRoot, appRoots, appPresent, readApp, appTest };
