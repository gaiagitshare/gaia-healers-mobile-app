// ?view=store&tab=membership must keep its tab: the router used to drop tabs
// for every screen except Community and Energy, so direct links, reloads and
// shared "Compare membership plans" links opened the Shop tab (15 Nov 2026).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'gaia-ui.js'), 'utf8');

test('tabForView keeps the requested tab for every screen', () => {
  const m = src.match(/function tabForView\(view, tab\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'tabForView found');
  const tabForView = new Function('view', 'tab', m[1]);
  assert.strictEqual(tabForView('store', 'membership'), 'membership');
  assert.strictEqual(tabForView('store', ''), '');
  assert.strictEqual(tabForView('community', ''), 'discussion');
  assert.strictEqual(tabForView('wellness', ''), 'check');
  assert.strictEqual(tabForView('wellness', 'horoscope'), 'horoscope');
});
