// "Try the Membership 2.0 beta" link: one switch, shipped OFF.
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const src = read('gaia-beta-link.js');
const load = (code) => { const window = {}; vm.runInNewContext(code, { window }); return window.GaiaBetaLink; };

test('the beta link ships switched OFF and then renders nothing', () => {
  assert.equal((src.match(/var BETA_LINK_ENABLED = (true|false);/g) || []).length, 1, 'exactly one on/off constant');
  assert.match(src, /var BETA_LINK_ENABLED = false;/, 'default is OFF: merging changes nothing visible');
  const link = load(src);
  assert.equal(link.enabled, false);
  assert.equal(link.html('you'), ''); assert.equal(link.html('store'), '');
});

test('switched ON, it is a real link to the public beta page with Gaia Healers branding', () => {
  const link = load(src.replace('var BETA_LINK_ENABLED = false;', 'var BETA_LINK_ENABLED = true;'));
  for (const where of ['you', 'store']) {
    const h = link.html(where);
    assert.match(h, /<a [^>]*href="https:\/\/beta\.gaiahealers\.app\/"[^>]*>Try the Membership 2\.0 beta/);
    assert.match(h, /rel="noopener"/);
    assert.match(h, /Gaia Healers Membership 2\.0/);
    assert.match(h, /Coming after Elevate 2026/);
    assert.doesNotMatch(h.replace(/Gaia Healers/g, ''), /Gaia/, 'no bare "Gaia" for the platform');
  }
});

test('You and Store › Membership show the card, and the switch file loads first', () => {
  const m = read('gaia-member.js');
  assert.match(m, /box\.innerHTML = betaLink\('you'\) \+ cards\.join\(''\);/);
  assert.match(m, /box\.innerHTML = betaLink\('store'\) \+ membershipCards\(\);/);
  assert.match(m, /function betaLink\(where\) \{ try \{ return \(window\.GaiaBetaLink && window\.GaiaBetaLink\.html\(where\)\) \|\| ''; \} catch \(_\) \{ return ''; \} \}/);
  const h = read('home.html');
  const a = h.indexOf('src="gaia-beta-link.js'); const b = h.indexOf('src="gaia-member.js');
  assert.ok(a > 0 && b > a, 'gaia-beta-link.js is included before gaia-member.js (both defer, so order holds)');
});
