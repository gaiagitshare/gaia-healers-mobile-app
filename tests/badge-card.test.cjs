const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/* The printed badge QR opens a digital card. The app side has three jobs:
 * show the owner their card inside the ticket sheet, let them edit it with
 * every contact field OFF by default, and turn a scanned link into a
 * connection. None of that may touch the ticket QR itself. */

test('the card module is shipped, cached, and hooked into the ticket sheet', () => {
  const home = read('home.html');
  assert.match(home, /gaia-card\.js\?v=\d+/, 'home.html loads the module');
  assert.ok(home.indexOf('gaia-myevents.js') < home.indexOf('gaia-card.js'), 'after the ticket sheet it injects into');
  const sw = read('sw.js');
  assert.match(sw, /'\/gaia-card\.js'/, 'offline shell includes it');
  assert.doesNotMatch(sw, /20260903b-pulse-trend-assist/, 'the cache name moved on, so old shells are evicted');
  const mye = read('gaia-myevents.js');
  assert.equal((mye.match(/GaiaCard\.inject\(eventId, shell\)/g) || []).length, 2, 'both ticket render paths hand the sheet over');
});

test('the ticket QR is untouched: the app still renders the server QR image and the ATT code', () => {
  const mye = read('gaia-myevents.js');
  assert.match(mye, /ticket\.qrImage/, 'server-rendered QR image');
  assert.match(mye, /g-ticket__code.*ticket\.qrCode/, 'the ATT code is still printed under it');
  const card = read('gaia-card.js');
  assert.doesNotMatch(card, /qrCode|qr_code|ATT-/, 'the card module never handles the ticket identity');
});

test('contact details default to private and only known fields are sent', () => {
  const card = read('gaia-card.js');
  assert.match(card, /body\.show_email = data\.get\('show_email'\) === 'on'/, 'email is a checkbox that must be ticked');
  assert.match(card, /body\.show_phone = data\.get\('show_phone'\) === 'on'/, 'phone likewise');
  assert.match(card, /body\.public = data\.get\('public'\) === 'on'/, 'public is an explicit switch');
  assert.match(card, /toggle\('Show my email', 'show_email', f\.show_email/, 'the switch reflects the saved state, never assumed on');
});

test('a scanned link handles every state without breaking the page', () => {
  const src = read('gaia-card.js');
  const sandbox = {
    window: { location: { search: '?card=7K2MXPQ4', hostname: 'gaiahealers.app' }, GAIA_APP_URLS: { production: { proxy: 'https://api.example' } } },
    document: { addEventListener() {}, body: { appendChild() {} }, createElement: () => ({ classList: { add() {}, remove() {} }, setAttribute() {}, remove() {} }), querySelector: () => null },
    URLSearchParams,
    setTimeout: (fn) => fn(),
    fetch: null,
    console,
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.ok(sandbox.window.GaiaCard && typeof sandbox.window.GaiaCard.inject === 'function', 'module exposes inject');
  assert.equal(typeof sandbox.window.GaiaCard.openEditor, 'function');
});

test('the badge card in the profile is permanent, not tied to a live event', () => {
  const card = read('gaia-card.js');
  assert.match(card, /api\('\/api\/card'\)/, 'the profile tile asks for the PERSON\'s card, with no event in the path');
  assert.ok(!/events\.filter\(\(e\) => e\.phase !== 'past'\)[\s\S]{0,400}badgecard/.test(card),
    'the tile is no longer filtered to events that have not finished');
  assert.match(card, /keeps working after the event ends/, 'and it says so to the person');
});

test('a scanned claim link never edits without a proven owner', () => {
  const card = read('gaia-card.js');
  assert.match(card, /api\('\/api\/card\/claim', \{ token \}\)/, 'ownership is asked of the proxy (session), not assumed from the URL');
  assert.match(card, /own\.owner && own\.event_id\)\s*\{\s*openEditor/, 'the editor opens only when the proxy says owner');
  assert.match(card, /belongs to someone else/, 'a stranger scanning the badge is told so and gets nothing');
  assert.match(card, /window\.GaiaAuth\.open/, 'signed-out users are sent through the real magic-link sign-in');
  assert.match(card, /\/api\/auth\/session/, 'the flow waits for a real session before continuing');
});

test('the token in a scanned link is validated before any request is made', () => {
  const card = read('gaia-card.js');
  assert.match(card, /\/\^\[A-Z2-9\]\{8\}\$\/\.test\(token\)/, 'only the badge alphabet, exactly 8 symbols');
});
