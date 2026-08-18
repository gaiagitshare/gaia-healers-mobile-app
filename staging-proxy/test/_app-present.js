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

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** True when the app sources sit alongside the proxy. */
const appPresent = (file = 'gaia-superapp.js') => fs.existsSync(path.join(appRoot, file));

/** Read an app file, or '' when the app is not alongside. */
const readApp = (file) => (appPresent(file) ? fs.readFileSync(path.join(appRoot, file), 'utf8') : '');

/** A test that runs only where the app is available. */
function appTest(name, fn, file = 'gaia-superapp.js') {
  return test(name, { skip: appPresent(file) ? false : 'Gaia app not checked out beside the proxy' }, fn);
}

export { appRoot, appPresent, readApp, appTest };
