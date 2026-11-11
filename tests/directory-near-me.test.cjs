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
  assert.match(SRC, /doesn\\'t take online bookings right now/);
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

test('booking status: only a calendar with open times is promised', () => {
  const t = load('en-US');
  assert.ok(t.booksOnline({ booking: 'online' }));
  assert.ok(!t.booksOnline({ booking: 'unavailable', meetingLink: 'https://x' }));
  assert.ok(!t.booksOnline({ booking: 'none' }));
  assert.ok(t.booksOnline({ meetingLink: 'https://x' }), 'an older server without the field still books');
  assert.match(SRC, /var own = p\.meetingLink && bk !== 'unavailable'/, 'a dead calendar never gets a Book button');
  assert.match(SRC, /intent === 'scan' && scanTeamOk\(\)/, 'the scan-team calendar is offered only when it works');
  assert.match(SRC, /Books online/);
});

test('scan bookings from Bookings and the voice assistant start at the directory', () => {
  const sa = fs.readFileSync(path.join(__dirname, '..', 'gaia-superapp.js'), 'utf8');
  assert.match(sa, /item\.id === 'biowell-scan' \? 'data-dir-intent="scan"'/);
  const voice = fs.readFileSync(path.join(__dirname, '..', 'gaia-realtime-voice.js'), 'utf8');
  assert.match(voice, /key === 'scan' && window\.GaiaDirectory/);
});
