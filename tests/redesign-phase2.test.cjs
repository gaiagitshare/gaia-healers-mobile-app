// Full-app redesign, Phase 2: phone bar, Discover and the shared design file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('phone bar: Discover, Bookings, Home, Academy, More', () => {
  const nav = read('shared-nav.js');
  for (const id of ['directory', 'bookings', 'academy']) assert.match(nav, new RegExp(`id: '${id}'[^}]*phone: true`), id + ' is on the phone bar');
  for (const id of ['daily', 'wellness', 'community', 'events', 'store', 'profile']) assert.doesNotMatch(nav, new RegExp(`id: '${id}'[^}]*phone: true`), id + ' lives in More');
  assert.match(nav, /const MORE = \['daily', 'wellness', 'community', 'events', 'store', 'profile'\]/);
  assert.match(nav, /data-tabbar-more/);
  assert.match(nav, /inbox: 'community'/, 'Inbox still belongs to Community');
});

test('More is phone-only and every tab still shows in the rail', () => {
  const ds = read('gaia-ds.css');
  assert.match(ds, /@media \(min-width: 700px\) \{ body\.gaia-v2 \.gaia-tabbar__more \{ display: none !important; \} \}/);
  assert.match(read('gaia-home3.css'), /@media \(max-width: 699px\) \{ body\.gaia-v2 \.gaia-tabbar__link--rail \{ display: none !important; \} \}/);
});

test('design tokens live in gaia-ds.css, loaded after gaia-home3.css', () => {
  const html = read('home.html');
  assert.ok(html.indexOf('gaia-ds.css?v=') > html.indexOf('gaia-home3.css?v='));
  assert.match(read('gaia-ds.css'), /--gh-accent: #b7ff62;/);
  assert.doesNotMatch(read('gaia-home3.css'), /--gh-accent:/);
});

test('Discover: map on request, one filter row, the scan offer, real data only', () => {
  const js = read('gaia-directory.js');
  assert.match(js, /id="g-dir-map" hidden/);
  assert.match(js, /data-dir-maptoggle/);
  assert.match(js, /data-dir-spec-select/);
  assert.doesNotMatch(js, /g-dir__schips/);
  assert.match(js, /data-dir-scan/);
  assert.match(js, /fetch\(proxyBase\(\) \+ '\/api\/directory'\)/, 'same directory API');
});
