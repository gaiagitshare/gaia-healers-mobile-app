// Community must not say "not in a circle" (or list the member's own circle as
// locked) when the access lookup failed, is stale, or is still loading.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'gaia-member.js'), 'utf8');
const fn = src.slice(src.indexOf('function renderCommunity()'), src.indexOf('function circlesRetryCard('));

test('loading state while member data is in flight', () => {
  assert.match(src, /state\.memberLoading = true; renderCommunity\(\);/);
  assert.match(fn, /state\.memberLoading && !state\.authed/);
  assert.match(fn, /Checking your circles/);
});

test('signed in with no access payload shows a retry, not the sign-in card', () => {
  const i = fn.indexOf('state.authed && !(acc && acc.communities)');
  assert.ok(i > 0 && i < fn.indexOf('data-native-signin'));
});

test('a degraded or session-fallback read never claims "not in a circle"', () => {
  const unsure = fn.indexOf("acc.source === 'session-fallback'");
  assert.ok(unsure > 0 && unsure < fn.indexOf('You are not in a circle yet'));
  assert.match(fn, /acc\.meta && acc\.meta\.degraded/);
});

test('retry re-reads only member access, on a tap', () => {
  const r = src.slice(src.indexOf('function bindCirclesRetry('), src.indexOf('function bindCirclesRetry(') + 1200);
  assert.match(r, /addEventListener\('click'/);
  assert.match(r, /getJson\('\/api\/member\/access'\)/);
  assert.doesNotMatch(r, /setInterval|setTimeout/);
});
