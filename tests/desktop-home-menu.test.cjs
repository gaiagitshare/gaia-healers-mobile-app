const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('sidebar carries Meet the founder, opening the booking window', () => {
  const nav = read('shared-nav.js');
  assert.match(nav, /gaia-rail__founder" data-book-inline="https:\/\/calendly\.com\/nimafarshid\/gaia-healers-meeting"/);
  assert.match(nav, />Meet the founder</);
});

test('founder link is rail/sidebar only; Home menu button hidden there but keeps its slot', () => {
  const css = read('gaia-shell.css');
  assert.match(css, /@media \(max-width: 699px\) \{ body\.gaia-v2 \.gaia-rail__founder \{ display: none !important; \} \}/);
  assert.match(css, /\[data-screen="today"\] \.g-topbar__nav \{ visibility: hidden !important; pointer-events: none !important; \}/);
});

test('phone menu sheet still offers the founder link', () => {
  assert.match(read('gaia-ui.js'), /data-book-title="Meet Dr\. Nima Farshid">Meet the founder/);
});
