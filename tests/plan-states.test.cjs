const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
test('Next Level says gains in words, not raw keys', () => {
  const ui = read('gaia-membership-ui.js');
  assert.match(ui, /TITLES\[type\] \|\| type\.replace/, 'labels fall back to the shared titles');
  assert.match(ui, /'Level ' \+ to/); assert.match(ui, /to \+ ' a month'/); assert.match(ui, /% off certifications/);
  assert.match(ui, /toLowerCase\(\) === 'diy'\) return 'DIY'/);
});
test('the Membership tab: real access values, no downgrade buttons', () => {
  const m = read('gaia-member.js');
  assert.match(m, /GaiaMembershipUI\?\.summaryFor\?\.\(access, s\.type\)/, 'Your access uses the My Access values');
  assert.match(m, /ctaAction: isCurrent \|\| below \? ''/, 'no Choose button on plans below the current one');
  assert.match(m, /'Included in your ' \+ currentLabel \+ ' plan\.'/);
});
