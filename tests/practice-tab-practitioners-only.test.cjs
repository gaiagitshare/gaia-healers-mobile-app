const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
// Babak, 5 Oct 2026: the Practice tab is for practitioners only.
test('the Practice tab shows only for practitioners, a linked account, a deep link or an opt-in', () => {
  const src = read('gaia-practitioner.js');
  assert.match(src, /const showPractice = Boolean\(status\.isPractitioner \|\| linkedState \|\| askedFor \|\| optedIn \|\| \(status\.offline && known\)\)/);
  assert.match(src, /if \(!showPractice\) \{[\s\S]*?tabs\.hidden = true; panel\.hidden = true; me\.hidden = false;/);
  assert.match(src, /\['connected', 'needs_reconnect', 'unverified', 'not_practitioner'\]\.includes\(status\.state\)/, 'an existing link stays reachable');
});
test('an untagged practitioner can still reach Connect from the Account card', () => {
  assert.match(read('gaia-member.js'), /data-prac-optin hidden><span>Already a practitioner\?<\/span>/);
  assert.match(read('gaia-practitioner.js'), /closest\('\[data-prac-optin\]'\)[\s\S]*?sessionStorage\.setItem\('gaia-prac-optin', '1'\)[\s\S]*?mounted\?\.select\('practice'\)/);
});
