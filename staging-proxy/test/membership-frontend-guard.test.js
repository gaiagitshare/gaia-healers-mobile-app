/**
 * Frontend guard tests.
 *
 * These scan the shipped app JavaScript for the patterns Phase 2 exists to
 * remove. They are the reason a tier regex cannot quietly come back: adding one
 * fails the build rather than shipping a UI that decides access for itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appTest, readApp } from './_app-present.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_FILES = ['gaia-member.js', 'gaia-membership-ui.js', 'gaia-ui.js', 'gaia-superapp.js'];
const read = (file) => readApp(file);

/* Comments are stripped before scanning: a guard that trips over its own
   explanatory prose teaches people to delete the explanation. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');

/* A line may opt out with `// tier-name-ok:` plus a reason. The only accepted
   reason so far is matching text a user typed, which is routing, not access. */
const allowedLines = (source) => new Set(
  source.split('\n').map((line, index) => (/tier-name-ok:/.test(line) ? index : -1)).filter((i) => i >= 0)
    .flatMap((i) => [i, i + 1, i + 2, i + 3, i + 4]),
);

appTest('no tier-name regex survives anywhere in the app JS', () => {
  for (const file of APP_FILES) {
    const source = read(file);
    const allowed = allowedLines(source);
    source.split('\n').forEach((line, index) => {
      if (allowed.has(index) || /^\s*\/\//.test(line)) return;
      const literals = line.match(/\/[^/\n*][^/\n]*\/[gimsuy]*/g) || [];
      for (const literal of literals) {
        assert.ok(
          !/(gold|silver|diamond|bronze|platinum)/i.test(literal),
          `${file}:${index + 1} must not match a tier name by regex: ${literal}`,
        );
      }
    });
  }
});

appTest('no tier name is ever tested against membership or access data', () => {
  for (const file of APP_FILES) {
    const code = stripComments(read(file));
    assert.ok(
      !/(membershipTier|membership\.key|access\.member)[^;\n]{0,80}(gold|silver|diamond)/i.test(code)
      || !/\.test\(/.test(code.match(/(membershipTier|membership\.key|access\.member)[^;\n]{0,80}(gold|silver|diamond)/i)?.[0] || ''),
      `${file} must not match a tier name against membership state`,
    );
  }
});

appTest('the membership UI contains no hardcoded plan prices', () => {
  const source = read('gaia-membership-ui.js');
  const prices = source.match(/\$\s?[0-9][0-9,]*/g) || [];
  assert.deepEqual(prices, [], `prices must come from the plan catalogue, found: ${prices.join(', ')}`);
});

appTest('the membership UI never hardcodes a lead count, directory level or discount', () => {
  const source = stripComments(read('gaia-membership-ui.js'));
  // The renderer may only read these from entitlement values.
  for (const forbidden of [/\b5\s*leads?\b/i, /\bleads?\s*:\s*\d/i, /\bLevel\s*[123]\b(?!\s*\$\{)/,
    /\b20\s*%/, /directory_level\s*[:=]\s*['"][123]['"]/]) {
    assert.ok(!forbidden.test(source), `hardcoded benefit value found: ${forbidden}`);
  }
  // and it must actually read them from `value`
  assert.ok(/value\?\.monthly/.test(source), 'lead allocation must be read from value.monthly');
  assert.ok(/value\?\.delivered/.test(source), 'lead allocation must be read from value.delivered');
});

appTest('gaia-member.js no longer carries the hardcoded tier catalogue', () => {
  const source = read('gaia-member.js');
  assert.ok(!/abilities:\s*\[\s*'Everything in/.test(source), 'hardcoded benefit bullets must be gone');
  assert.ok(!/\$97\/mo|\$497\/mo|\$997\/mo/.test(source), 'hardcoded prices must be gone');
  assert.ok(/api\/membership\/plans/.test(source), 'plans must come from the catalogue endpoint');
});

appTest('membership.key is used for presentation only, never to select benefits', () => {
  const source = read('gaia-membership-ui.js');
  // The only permitted uses are a CSS modifier and an upgrade lookup.
  const uses = source.match(/membership\.key/g) || [];
  assert.ok(uses.length > 0, 'the key is used for presentation');
  // No conditional that maps a key to a benefit.
  assert.ok(!/membership\.key\s*===\s*['"](gold|silver|diamond|free)['"]\s*\?/.test(source),
    'a tier key must not select what a member gets');
});

appTest('the UI reads its rows from sections, not from a hardcoded list', () => {
  const source = read('gaia-membership-ui.js');
  assert.ok(/access\?\.sections/.test(source), 'rows come from sections');
  // there must be no literal array of row titles
  assert.ok(!/\[\s*'Courses'\s*,\s*'Community'/.test(source), 'no hardcoded row list');
});

appTest('unknown entitlement types have a safe generic renderer', () => {
  const source = read('gaia-membership-ui.js');
  assert.ok(/genericRenderer/.test(source), 'a generic renderer exists');
  assert.ok(/RENDERERS\[section\.type\]\s*\|\|\s*genericRenderer/.test(source),
    'unknown types fall back rather than throwing or being interpreted');
});
