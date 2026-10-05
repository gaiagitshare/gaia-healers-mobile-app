const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'gaia-my-readings.js'), 'utf8');
test('My readings shows every date one way', () => {
  assert.match(src, /\+ 'T12:00:00'/, 'a bare date is not shifted a day west of Greenwich');
  assert.ok(src.includes('${esc(when(c.from))} → ${esc(when(c.to))}'), 'before/after dates are readable');
  assert.doesNotMatch(src, /esc\(f\.uploaded_at/, 'file dates go through when()');
  assert.doesNotMatch(src, /new Date\(p\.at\)\.toLocaleString\(\)/, 'no long date-time in the compare selects');
});
test('the date helper keeps the calendar day of a bare date', () => {
  const asDate = new Function('return ' + src.match(/const asDate = (\(iso\) => [^;]+);/)[1])();
  const d = asDate('2026-10-02');
  assert.equal(d.getDate(), 2); assert.equal(d.getMonth(), 9);
});
