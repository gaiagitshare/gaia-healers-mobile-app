// Signed-out redesign (15 Nov 2026): the guest Home, Join block, guest states
// and the intro/activate pages use the member design system.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('guest Home sheet is built on the --gh-* tokens, not the old v3 palette', () => {
  const css = read('gaia-guest-home.css');
  assert.match(css, /var\(--gh-serif\)/, 'serif headline like the member hero');
  assert.match(css, /var\(--gh-r-card, 14px\)/);
  assert.doesNotMatch(css, /--v3-/, 'no v3 tokens left in the guest sheet');
  assert.doesNotMatch(read('gaia-warm.css'), /\.g-guest \.gg-/, 'warm layer no longer restyles the guest Home');
});

test('guest cards reuse the kit artwork, and copy and actions are unchanged', () => {
  const js = read('gaia-superapp.js');
  assert.match(js, /gg-feature__art" src="assets\/home3\/ref-aura\.webp\?v=kit1"/);
  assert.match(js, /gg-join__art" src="assets\/home3\/ref-leaves\.webp\?v=kit1"/);
  for (const s of ['Check my energy', 'Reserve a biofield scan', 'Join free', 'data-super-signin', 'Compare membership plans', 'Event details']) assert.ok(js.includes(s), s);
});

test('guest Community shows the circles once, in the member card, with one sign-in', () => {
  const js = read('gaia-member.js');
  assert.match(js, /g-circles g-circles--guest/);
  assert.match(js, /data-native-signin>Sign in securely →/);
});

test('intro and activate pages use the app type and lime', () => {
  const idx = read('index.html');
  assert.match(idx, /family=Cormorant\+Garamond[^"]*Plus\+Jakarta\+Sans/);
  assert.match(read('gaia-splash.css'), /--sp-accent: #b7ff62/);
  assert.match(read('activate.html'), /--accent:#b7ff62/);
});

test('changed assets carry new version tags', () => {
  const html = read('home.html');
  for (const f of ['gaia-guest-home.css', 'gaia-warm.css', 'gaia-ds.css', 'gaia-member.js', 'gaia-superapp.js']) assert.match(html, new RegExp(f.replace('.', '\\.') + '\\?v=20261115so1'), f);
});
