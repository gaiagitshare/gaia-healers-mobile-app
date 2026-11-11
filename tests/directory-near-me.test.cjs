// Directory "near me" / scan list (Nov 2026): miles in the US, Bio-Well by
// specialty (not a loose tag), honest fallback booking, public profile link.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'gaia-directory.js'), 'utf8');
function load(lang) {
  const window = { addEventListener() {} };
  const ctx = {
    window, navigator: { language: lang, languages: [lang] }, location: { search: '' },
    URLSearchParams, document: { addEventListener() {}, readyState: 'complete', getElementById() { return null; } },
    setTimeout, clearTimeout, console,
  };
  vm.createContext(ctx); vm.runInContext(SRC, ctx);
  return window.GaiaDirectory._test;
}

test('US members see miles, others km', () => {
  assert.strictEqual(load('en-US').fmtDist(16.09344), '10 mi');
  assert.strictEqual(load('en-US').fmtDist(0.5), 'under 1 mi');
  assert.strictEqual(load('de-DE').fmtDist(16.09344), '16 km');
  assert.strictEqual(load('en-US').fmtDist(8.0467), '5 mi');
});

test('distance maths is right (Orlando to Miami ≈ 330 km)', () => {
  const d = load('en-US').km({ lat: 28.5383, lng: -81.3792 }, { lat: 25.7617, lng: -80.1918 });
  assert.ok(d > 320 && d < 340, String(d));
});

test('the scan list needs Bio-Well as a specialty, not just a tag', () => {
  const t = load('en-US');
  assert.ok(t.isBioWell({ specialty: ['Bio-Well practitioner'], tags: [] }));
  assert.ok(t.isBioWell({ specialty: ['Biowell scans'], tags: [] }));
  assert.ok(!t.isBioWell({ specialty: ['Reiki Master'], tags: ['biowell'] }));
});

test('a practitioner without a calendar is never booked under their name', () => {
  assert.doesNotMatch(SRC, /data-book-title="Bio-Well scan with ' \+ esc\(p\.name\)/);
  assert.match(SRC, /Book with the Gaia Healers scan team/);
  assert.match(SRC, /doesn\\'t take online bookings yet/);
});

test('location: asked only on tap, failures explained, a city or zip works too', () => {
  assert.doesNotMatch(SRC.split('function nearMe')[0], /getCurrentPosition/);
  assert.match(SRC, /Location is turned off for this app/);
  assert.match(SRC, /data-dir-place-form/);
  assert.match(SRC, /nominatim\.openstreetmap\.org\/search/);
  assert.match(SRC, /countrycodes=us/, 'a bare 5-digit code searches US zips');
  assert.match(SRC, /data-dir-radius/);
});

test('profiles link to the public page on gaiapractitioners.com', () => {
  assert.match(SRC, /gaiapractitioners\.com\/practitioner\/profile\/' \+ encodeURIComponent/);
});

test('booking from a profile closes the profile so the calendar is on top', () => {
  assert.match(SRC, /closest\('\[data-book-inline\]'\)\) setTimeout\(close, 0\)/);
});
