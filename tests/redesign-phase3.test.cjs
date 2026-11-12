// Full-app redesign, Phase 3: Today, Energy, Academy, Community.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the four screens opt into the design system; Energy and Academy carry their art', () => {
  const html = read('home.html');
  for (const s of ['daily', 'wellness', 'academy', 'community']) assert.match(html, new RegExp(`data-screen="${s}" data-ds-page`));
  assert.match(html, /g-ds-banner[^>]*>\s*<img class="g-ds-banner__art" src="assets\/home3\/ref-aura\.webp\?v=kit1"/);
  assert.match(html, /g-ds-banner--gold[^>]*>\s*<img class="g-ds-banner__art" src="assets\/home3\/ref-book\.webp\?v=kit1"/);
});

test('Academy covers: the real image when there is one, else the book art (never invented)', () => {
  const js = read('gaia-member.js');
  assert.match(js, /courseCover\(c\.poster \|\| catalogImage\(c\.title\), 'g-sync__poster'\)/);
  assert.match(js, /courseCover\(t\.image, 'g-access__img'\)/);
  assert.match(js, /var BOOK_ART = 'assets\/home3\/ref-book\.webp\?v=kit1'/);
});

test('Community: no counter bar, locked circles said once, requests still shown', () => {
  const js = read('gaia-member.js');
  const fn = js.slice(js.indexOf('function renderCommunity'), js.indexOf('/* ---------- Public, no-login features'));
  assert.doesNotMatch(fn, /g-stats/);
  assert.match(fn, /More circles with membership/);
  assert.match(fn, /Requested/);
  assert.match(fn, /data-membership-cta/);
  assert.match(fn, /accessItem\(x, 'unlocked'\)/, 'joined circles keep their Open button');
});
