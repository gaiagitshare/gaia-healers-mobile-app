/**
 * THE PRACTICE SCREEN — the promises it makes to a practitioner.
 *
 * Two measurements decide this screen, and both are easy to undo by accident:
 *
 *   The calls split. Listing clients, searching, opening one, reading who is
 *   flagged and who is due a follow-up all answer in under two seconds. Anything
 *   touching a Bio-Well scan takes nine to twelve, because their side fetches it
 *   live. So the fast things load with the screen and the slow things wait for a
 *   tap -- and a single stray call in the wrong place turns opening a client into
 *   an eleven-second wait that nobody asked for.
 *
 *   The raw scan is 1.6 MB, most of it a JSON-RPC envelope. The shaping happens
 *   on the server, and the screen renders the same shaped output the model gets,
 *   from the same handler, so the two cannot describe different numbers.
 *
 * Also pinned here: the file is named for the practitioner rather than for
 * "practice", because gaia-practice.js is the member's personal practice journal
 * and the two were confused once already.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(name) {
  for (const base of ['../../', '../../../gaia-healers-mobile-app-1/']) {
    try { return fs.readFileSync(new URL(base + name, import.meta.url), 'utf8'); } catch { /* next */ }
  }
  return null;
}

const ui = read('gaia-practitioner.js');
const home = read('home.html');

const SLOW = ['practitioner_client_latest_scan', 'practitioner_client_trend',
              'practitioner_compare_sessions'];
const FAST_ON_OPEN = ['practitioner_get_client', 'practitioner_suggested_services',
                      'practitioner_client_files'];

test('the practitioner screen is a separate file from the practice journal', () => {
  const journal = read('gaia-practice.js');
  if (journal === null || ui === null) return;
  assert.match(journal, /practice journal/i, 'gaia-practice.js is the member journal');
  assert.ok(!/GaiaPractitioner/.test(journal), 'the journal must not have been overwritten');
  assert.match(ui, /window\.GaiaPractitioner/, 'the practitioner screen owns its own global');
  assert.ok(!/window\.GaiaPractice\b/.test(ui), 'and must not claim the journal\'s');
});

test('opening a client fetches nothing slow', () => {
  if (ui === null) return;
  const i = ui.indexOf('async function showClient');
  const j = ui.indexOf('const CARD_TOOL');
  assert.ok(i > 0 && j > i, 'showClient must exist, and end before the card tools');
  const body = ui.slice(i, j);
  for (const slow of SLOW) {
    assert.ok(!body.includes(slow),
      `showClient calls ${slow} -- opening a client would cost about ten seconds`);
  }
  for (const fast of FAST_ON_OPEN) {
    assert.ok(body.includes(fast), `showClient should load ${fast}, which is fast`);
  }
});

test('the landing screen fetches nothing slow either', () => {
  if (ui === null) return;
  const i = ui.indexOf('async function showList');
  const j = ui.indexOf('function onSearch');
  const body = ui.slice(i, j);
  for (const slow of SLOW) {
    assert.ok(!body.includes(slow), `showList calls ${slow}`);
  }
  assert.match(body, /practitioner_flagged_clients/, 'who needs attention comes first');
  assert.match(body, /practitioner_follow_ups/);
  assert.match(body, /practitioner_list_clients/);
});

test('a slow card says how long before it is long', () => {
  if (ui === null) return;
  assert.match(ui, /about ten seconds/,
    'a spinner alone reads as broken at eleven seconds');
  assert.match(ui, /data-prac-elapsed/, 'and an elapsed count proves it is still working');
});

test('a card that is already loaded is not fetched twice', () => {
  if (ui === null) return;
  const i = ui.indexOf('async function openCard');
  const body = ui.slice(i, i + 1600);
  assert.match(body, /const cached = \(loaded\.get\(openClient\) \|\| \{\}\)\[kind\]/,
    'ten seconds is too long to pay twice for the same card');
  assert.match(body, /loaded\.get\(forClient\)\[kind\] = html/, 'and the result has to be kept');
});

test('a result that arrives after the practitioner moved on is discarded', () => {
  if (ui === null) return;
  const i = ui.indexOf('async function openCard');
  const body = ui.slice(i, i + 1800);
  assert.match(body, /if \(openClient !== forClient\) return/,
    'a ten-second call that lands on the wrong client would paint one person\'s readings under another\'s name');
});

test('every state a practitioner can be in has its own words', () => {
  if (ui === null) return;
  assert.match(ui, /Connect your Gaia Practitioners account/, 'never connected');
  assert.match(ui, /connection to Gaia Practitioners expired/, 'needs reconnect');
  assert.match(ui, /practitioner_email/, 'and names the account, so a wrong one is visible');
  assert.match(ui, /Bio-Well did not answer/, 'a failed fetch');
  assert.match(ui, /No files for this client yet/, 'honestly empty rather than hidden');
  assert.match(ui, /not on your list/, 'a client that is not theirs');
});

test('nothing in the screen sends an identity', () => {
  if (ui === null) return;
  const i = ui.indexOf('async function tool(');
  const body = ui.slice(i, i + 700);
  assert.match(body, /credentials: 'include'/, 'the cookie is what identifies the caller');
  assert.ok(!/contactId|practitionerId|practitioner_id|access_token/.test(body),
    'the request carries a tool name and arguments, nothing else');
});

test('the screen never offers to write anything', () => {
  if (ui === null) return;
  // The scope is mcp.read. A control that looks like it saves would be a lie,
  // and there is no endpoint behind it to make true later.
  assert.ok(!/>\s*(Save|Update|Delete|Edit|Book)\b/i.test(ui),
    'the practitioner acts in their own platform and looks here');
});

test('the Practice tab is hidden until the server says practitioner', () => {
  if (ui === null || home === null) return;
  assert.match(home, /data-profile-tabs hidden/,
    'the tab row ships hidden and is revealed by the status call');
  const i = ui.indexOf('async function mount');
  const body = ui.slice(i, i + 1200);
  assert.match(body, /\/api\/practitioners\/status/, 'the server decides, not the page');
  assert.match(body, /if \(!res\.ok\) return/, 'not signed in shows nothing');
  assert.match(body, /available === false/, 'and neither does the integration being off');
});

test('Gaia can open a client without a reload', () => {
  if (ui === null) return;
  assert.match(ui, /gaia:open-client/, 'the assistant needs a way in');
  assert.match(ui, /params\.get\('client'\)/, 'and a deep link has to work too');
});

test('the styles use the existing tokens rather than new colours', () => {
  const css = read('gaia-app-v3-shop-you.css');
  if (css === null) return;
  const i = css.indexOf('.g-prac {');
  if (i < 0) return;
  const block = css.slice(i);
  const literals = block.match(/:\s*#[0-9a-f]{3,8}\b/gi) || [];
  assert.deepEqual(literals, [],
    `the Practice styles introduce raw colours (${literals.join(', ')}) instead of --g-* tokens`);
  assert.match(block, /--g-surface/);
  assert.match(block, /--g-text-muted/);
});
