/**
 * The Gaia Assist ↔ GaiaTools contract.
 *
 * Three files, in two deploy units, have to agree on one list of Energy tools:
 *
 *   1. gaia-toolkit.js   — ASSIST_TOOLS, the dispatcher's own declaration of
 *                          what Assist may open, plus TOOL_HOST, which decides
 *                          what can actually be opened at all.
 *   2. gaia-realtime-voice.js — the navigate tool's `tool` enum, which is what
 *                          the model is physically able to emit.
 *   3. staging-proxy/server.js — ASSIST_TOOL_IDS, which builds the &tool= line
 *                          in GAIA_KNOWLEDGE, i.e. what Assist is told it can do.
 *
 * They cannot share an import: the app ships to Pages and the proxy runs on a
 * VPS. So this compares them instead. The failure it exists to catch is the
 * quiet one — a tool added or renamed in one place and not the others, leaving
 * Assist either promising something it cannot do or unable to open something
 * that is right there.
 *
 * Deliberately not a regex over the knowledge prose. The prose is generated
 * from ASSIST_TOOL_IDS, so this reads the list itself.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { appPresent, appRoot, appTest } from './_app-present.js';

const proxyRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const readApp = (file) => fs.readFileSync(path.join(appRoot, file), 'utf8');

/**
 * Parse a flat single-quoted string array literal assigned to `name`.
 *
 * `allowEmpty` distinguishes a list that is empty on purpose from one that has
 * been renamed or deleted. NOT_ASSIST_TOOLS is empty now that every panel on
 * the Energy screen is Assist-facing, but it still has to exist: it is where a
 * future tool goes when it should not be routed to.
 */
function arrayLiteral(source, name, label, allowEmpty = false) {
  const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  assert.ok(m, `${label}: could not find ${name} — has it been renamed or restructured?`);
  const items = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (!allowEmpty) assert.ok(items.length, `${label}: ${name} parsed as empty`);
  return items;
}

/**
 * The `enum` of the navigate tool's `tool` parameter.
 *
 * Scoped to that parameter on purpose: the same schema has a `screen` enum a
 * few lines above, and a looser match would happily compare the tool contract
 * against the list of screens and pass for the wrong reason.
 */
function navigateToolEnum(source) {
  const block = /tool:\s*\{([\s\S]*?)\},/.exec(source);
  assert.ok(block, 'voice navigate schema: the tool parameter is gone from the navigate tool');
  const m = /enum:\s*\[([^\]]*)\]/.exec(block[1]);
  assert.ok(m, 'voice navigate schema: the tool parameter has no enum, so any string would be accepted');
  const items = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(items.length, 'voice navigate schema: the tool enum parsed as empty');
  return items;
}

/** Parse the keys of a flat `const NAME = { a: '..', b: '..' }` object literal. */
function objectKeys(source, name, label) {
  const m = new RegExp(`${name}\\s*=\\s*\\{([^}]*)\\}`).exec(source);
  assert.ok(m, `${label}: could not find ${name}`);
  return [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[1]);
}

const sorted = (a) => [...a].sort();

// ── the proxy half, which is present wherever this suite runs ────────────────

const proxySource = fs.readFileSync(path.join(proxyRoot, 'server.js'), 'utf8');
const proxyIds = arrayLiteral(proxySource, 'ASSIST_TOOL_IDS', 'proxy');

test('the knowledge does not disclaim an ability Assist now has', () => {
  // It used to say, correctly, that Cosmic Map and Moon Rituals could not be
  // opened by name. Now they can, and a leftover disclaimer would make Assist
  // talk someone through scrolling to a card it could have opened for them.
  [/cannot open it by name/i, /not openable by name/i].forEach((re) => {
    assert.doesNotMatch(proxySource, re,
      'GAIA_KNOWLEDGE still tells Assist it cannot open a tool it can now open');
  });
});

test('the proxy declares its tool list once and builds the prose from it', () => {
  assert.ok(proxyIds.length >= 1);
  // A hardcoded &tool=a|b|c list would drift silently the moment the array
  // changed. The knowledge string must be generated from the array instead.
  assert.match(proxySource, /&tool=' \+ ASSIST_TOOL_IDS\.join\('\|'\) \+ '/,
    'the &tool= line in GAIA_KNOWLEDGE must be built from ASSIST_TOOL_IDS, not written out by hand');
  assert.equal(new Set(proxyIds).size, proxyIds.length, 'no duplicate tool ids');
});

// ── the three-way comparison, only where the app is checked out ──────────────

appTest('Assist advertises exactly the tools the app dispatcher supports', () => {
  const toolkit = readApp('gaia-toolkit.js');
  const voice = readApp('gaia-realtime-voice.js');

  const assistTools = arrayLiteral(toolkit, 'ASSIST_TOOLS', 'app dispatcher');
  const notAssist = arrayLiteral(toolkit, 'NOT_ASSIST_TOOLS', 'app dispatcher', true);
  const panelKeys = objectKeys(toolkit, 'TOOL_HOST', 'app dispatcher');
  const voiceEnum = navigateToolEnum(voice);

  // 1. Every tool Assist is told about must be one the dispatcher supports:
  //    either an accordion panel in TOOL_HOST, or one of the two modals the
  //    dispatcher special-cases by name.
  const modals = ['pulse', 'breath'];
  const openable = new Set([...panelKeys, ...modals]);
  assistTools.forEach((id) => {
    assert.ok(openable.has(id),
      `Assist advertises "${id}" but GaiaTools.open() cannot open it — add it to TOOL_HOST or stop advertising it`);
  });

  // 2. The model can only emit what is in the enum, so the enum is the real
  //    boundary of what Assist can do. It must equal the declared contract.
  assert.deepEqual(sorted(voiceEnum), sorted(assistTools),
    'the navigate tool enum and ASSIST_TOOLS disagree — a tool was changed in one file and not the other');

  // 3. And what the proxy tells Assist it can do must equal what it can do.
  assert.deepEqual(sorted(proxyIds), sorted(assistTools),
    'the proxy ASSIST_TOOL_IDS and the app ASSIST_TOOLS disagree — Assist is being told about a tool it cannot open, or not told about one it can');

  // 4. No phantoms: nothing advertised that is neither a panel nor a modal.
  const everySupported = new Set([...panelKeys, ...modals]);
  proxyIds.forEach((id) => {
    assert.ok(everySupported.has(id), `the proxy advertises a tool "${id}" that does not exist in the app at all`);
  });

  // 5. The split is deliberate. Tools the dispatcher can open but Assist does
  //    not route to have to be named as such, so an omission is a decision
  //    rather than an oversight.
  const accountedFor = new Set([...assistTools, ...notAssist]);
  [...panelKeys, ...modals].forEach((id) => {
    assert.ok(accountedFor.has(id),
      `"${id}" can be opened by GaiaTools.open() but appears in neither ASSIST_TOOLS nor NOT_ASSIST_TOOLS — decide which it is`);
  });
  assistTools.forEach((id) => {
    assert.ok(!notAssist.includes(id), `"${id}" is in both ASSIST_TOOLS and NOT_ASSIST_TOOLS`);
  });

  // 6. The nine tools Assist is expected to reach. Named rather than counted:
  //    three lists agreeing with each other would still agree if a tool were
  //    dropped from all three at once, and this is the list people care about.
  ['pulse', 'breath', 'numerology', 'sky', 'colour', 'chakra', 'match', 'cosmic', 'moon']
    .forEach((id) => {
      assert.ok(assistTools.includes(id), `"${id}" is no longer an Assist-facing tool`);
      assert.ok(voiceEnum.includes(id), `"${id}" is missing from the navigate tool enum`);
      assert.ok(proxyIds.includes(id), `"${id}" is missing from the proxy's ASSIST_TOOL_IDS`);
    });
  assert.equal(assistTools.length, 9, 'expected nine Assist-facing tools');
});

appTest('the two newest Assist tools resolve to real panels', () => {
  // Cosmic Map and Moon Rituals were promoted from NOT_ASSIST_TOOLS. They are
  // ordinary accordion panels, so they need no new opener -- but they do need
  // hosts that exist, which is the thing that was wrong with 'journey'.
  const toolkit = readApp('gaia-toolkit.js');
  const home = readApp('home.html');
  const m = /TOOL_HOST\s*=\s*\{([^}]*)\}/.exec(toolkit);
  assert.ok(m, 'TOOL_HOST not found');
  const map = Object.fromEntries([...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([^']+)'/g)]
    .map(([, k, v]) => [k, v]));
  [['cosmic', 'home-cosmic'], ['moon', 'home-moon']].forEach(([id, host]) => {
    assert.equal(map[id], host, `"${id}" must map to #${host}`);
    assert.ok(home.includes(`id="${host}"`), `#${host} is not in home.html`);
  });
});

appTest('every TOOL_HOST panel actually exists in the app shell', () => {
  // The bug this catches really happened: TOOL_HOST carried a 'journey' key
  // pointing at #home-challenge, which is not on the Energy screen, so
  // open('journey') could only ever return false while reading as supported.
  const toolkit = readApp('gaia-toolkit.js');
  const home = readApp('home.html');
  const m = /TOOL_HOST\s*=\s*\{([^}]*)\}/.exec(toolkit);
  assert.ok(m, 'TOOL_HOST not found');
  const pairs = [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([^']+)'/g)];
  assert.ok(pairs.length, 'TOOL_HOST parsed as empty');
  pairs.forEach(([, key, host]) => {
    const needle = host.startsWith('data-') ? host : `id="${host}"`;
    assert.ok(home.includes(needle),
      `TOOL_HOST maps "${key}" to ${host}, which is not in home.html — open("${key}") can only return false`);
  });
});

appTest('the dispatcher fails safely on an unknown tool id', () => {
  // open() must return false for anything it does not know, never throw: it is
  // called straight from a model-emitted tool call.
  const toolkit = readApp('gaia-toolkit.js');
  assert.match(toolkit, /open\(name\)\s*\{/, 'GaiaTools.open(name) not found');
  assert.match(toolkit, /return\s+opened;/,
    'open() must return the result of the panel lookup rather than assuming success');
  // An unrecognised key falls through to openPanel(), which returns false when
  // itemFor() finds nothing. Assert that path exists rather than trusting it.
  assert.match(toolkit, /if\s*\(!it\)\s*return false;/,
    'openPanel() must return false when the tool has no panel');

  // Regression. TOOL_HOST is a plain object, so a truthy lookup resolves
  // inherited names: TOOL_HOST['constructor'] is a function, not undefined.
  // ?tool=constructor built the selector '#function Object() { [native code] }',
  // threw during module init, and left every panel on the Energy screen dead.
  // The lookup must be an own-property check.
  assert.match(toolkit, /Object\.prototype\.hasOwnProperty\.call\(TOOL_HOST, name\)/,
    'itemFor() must use hasOwnProperty, or an inherited key like "constructor" reaches the selector and throws');
});

appTest('the navigate tool only accepts a tool argument for the Energy screen', () => {
  const voice = readApp('gaia-realtime-voice.js');
  assert.match(voice, /if \(tool && screen === 'wellness'\)/,
    'a tool argument on any other screen must be ignored, not applied to whatever is on screen');
});

if (!appPresent('gaia-toolkit.js')) {
  test('app not checked out beside the proxy — contract comparison skipped', { skip: true }, () => {});
}
