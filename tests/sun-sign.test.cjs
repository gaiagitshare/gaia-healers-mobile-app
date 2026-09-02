const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* ---- Harness: run the real browser IIFEs under a minimal DOM stub ---------
 * gaia-wellness.js owns the one zodiac table and exports sunSignFromDob on
 * window.GaiaWellness; gaia-match.js consumes it. Loading both here means the
 * tests exercise the exact shipped code paths, including the match form's
 * parse -> compute -> render flow via the stubbed box.
 * ------------------------------------------------------------------------ */
function fakeEl() {
  return {
    value: '', textContent: '', innerHTML: '',
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    click() { (this.listeners.click || []).forEach((fn) => fn()); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollIntoView() {},
    getAttribute() { return null; },
    classList: { add() {}, contains() { return false; }, remove() {} },
    dataset: {},
  };
}

function loadApp() {
  const matchBox = fakeEl();
  const registry = new Map();
  const query = (sel) => { if (!registry.has(sel)) registry.set(sel, fakeEl()); return registry.get(sel); };
  matchBox.querySelector = query;

  const boxes = { 'home-match': matchBox, 'horoscope-wellness': fakeEl() };
  global.document = {
    getElementById: (id) => boxes[id] || null,
    addEventListener() {},
    dispatchEvent() {},
    readyState: 'loading', // load() defers; no network in tests
    querySelectorAll: () => [],
  };
  global.window = global;
  global.window.addEventListener = () => {};
  global.window.dispatchEvent = () => true;
  global.window.location = { search: '', origin: 'https://gaiahealers.app' };
  global.window.requestAnimationFrame = () => 0;
  global.CustomEvent = class CustomEvent { constructor(type, options) { this.type = type; this.detail = options && options.detail; } };

  const root = path.join(__dirname, '..');
  const iife = (file) => new Function('window', 'document', 'navigator', 'CustomEvent', 'requestAnimationFrame', 'URLSearchParams',
    fs.readFileSync(path.join(root, file), 'utf8'))(global.window, global.document, global.navigator, global.CustomEvent, global.window.requestAnimationFrame, URLSearchParams);
  iife('gaia-wellness.js');
  iife('gaia-match.js');
  return { matchBox, query, sunSignFromDob: global.window.GaiaWellness.sunSignFromDob };
}

function runMatch(harness, a, b) {
  harness.query('[data-a-m]').value = String(a[0]); harness.query('[data-a-d]').value = String(a[1]); harness.query('[data-a-y]').value = String(a[2]);
  harness.query('[data-b-m]').value = String(b[0]); harness.query('[data-b-d]').value = String(b[1]); harness.query('[data-b-y]').value = String(b[2]);
  harness.matchBox.innerHTML = '';
  harness.query('[data-match-go]').click();
  const html = harness.matchBox.innerHTML;
  const you = /You:<\/strong>\s*([A-Za-z- ]+) centre · ([A-Za-z]+) \(([A-Za-z]+)\)/.exec(html);
  const them = /Them:<\/strong>\s*([A-Za-z- ]+) centre · ([A-Za-z]+) \(([A-Za-z]+)\)/.exec(html);
  return { you, them, html };
}

/* ---- Boundaries: real tropical-zodiac ground truth, every transition ±1 day */
const BOUNDARIES = [
  ['01-19', 'Capricorn'], ['01-20', 'Aquarius'], ['02-18', 'Aquarius'], ['02-19', 'Pisces'],
  ['03-20', 'Pisces'], ['03-21', 'Aries'], ['04-19', 'Aries'], ['04-20', 'Taurus'],
  ['05-20', 'Taurus'], ['05-21', 'Gemini'], ['06-20', 'Gemini'], ['06-21', 'Cancer'],
  ['07-22', 'Cancer'], ['07-23', 'Leo'], ['08-22', 'Leo'], ['08-23', 'Virgo'],
  ['09-22', 'Virgo'], ['09-23', 'Libra'], ['10-22', 'Libra'], ['10-23', 'Scorpio'],
  ['11-21', 'Scorpio'], ['11-22', 'Sagittarius'], ['12-21', 'Sagittarius'], ['12-22', 'Capricorn'],
];

test('shared sun-sign function matches the real zodiac on every boundary', () => {
  const { sunSignFromDob } = loadApp();
  for (const [md, expected] of BOUNDARIES) {
    const dob = `1994-${md}`;
    assert.equal(sunSignFromDob(dob), expected, `${dob} should be ${expected}`);
  }
});

test('leap-year and impossible dates validate against the real calendar', () => {
  const { sunSignFromDob } = loadApp();
  assert.equal(sunSignFromDob('2024-02-29'), 'Pisces', '2024 Feb 29 exists');
  assert.equal(sunSignFromDob('2000-02-29'), 'Pisces', '2000 Feb 29 exists (400-year leap)');
  assert.equal(sunSignFromDob('2023-02-29'), '', '2023 Feb 31-style: no Feb 29');
  assert.equal(sunSignFromDob('1900-02-29'), '', '1900 is not a leap year');
  for (const bad of ['1990-02-31', '1990-04-31', '1990-06-31', '1990-09-31', '1990-11-31', '1990-13-01', '1990-00-10', '1899-06-15', 'garbage', '']) {
    assert.equal(sunSignFromDob(bad), '', `${bad} must be rejected`);
  }
  const year = new Date().getFullYear();
  assert.ok(sunSignFromDob(`${year}-01-15`), 'a birth earlier this year is accepted (no stale year cap)');
  assert.equal(sunSignFromDob(`${year + 5}-01-15`), '', 'future birth years rejected');
});

test('energy match shows the corrected sign for the audited cases', () => {
  const harness = loadApp();
  // Before this fix these rendered Aquarius and Gemini (one sign early).
  const first = runMatch(harness, [3, 5, 1990], [7, 20, 1992]);
  assert.ok(first.you, 'result rendered');
  assert.equal(first.you[2], 'Pisces', 'Mar 5, 1990 is Pisces');
  assert.equal(first.them[2], 'Cancer', 'Jul 20, 1992 is Cancer');
});

test('energy match and horoscope agree on every boundary date (one shared table)', () => {
  const harness = loadApp();
  for (const [md, expected] of BOUNDARIES) {
    const [m, d] = md.split('-').map(Number);
    const { you } = runMatch(harness, [m, d, 1994], [m, d, 1995]);
    assert.equal(you[2], expected, `match shows ${expected} for 1994-${md}`);
    assert.equal(you[2], harness.sunSignFromDob(`1994-${md}`), `match === horoscope for 1994-${md}`);
  }
});

test('energy match rejects impossible dates and stale-cap years through the form', () => {
  const harness = loadApp();
  const invalid = runMatch(harness, [2, 31, 1990], [7, 20, 1992]);
  assert.ok(!/You:<\/strong>/.test(invalid.html), 'no result rendered for Feb 31');
  assert.equal(harness.query('[data-match-err]').textContent, 'Please enter two full birth dates.');
  const futureYear = runMatch(harness, [3, 5, new Date().getFullYear() + 2], [7, 20, 1992]);
  assert.ok(!/You:<\/strong>/.test(futureYear.html), 'no result rendered for a future birth year');
  assert.equal(harness.query('[data-match-err]').textContent, 'Please enter two full birth dates.');
  const thisYear = runMatch(harness, [5, 10, new Date().getFullYear()], [7, 20, 1992]);
  assert.ok(thisYear.you, 'a birth earlier this year computes a result');
});

test('element derives from the corrected sign (compatibility inputs are right)', () => {
  const harness = loadApp();
  const { you, them } = runMatch(harness, [3, 5, 1990], [7, 20, 1992]);
  assert.equal(you[3], 'Water', 'Pisces is Water');
  assert.equal(them[3], 'Water', 'Cancer is Water');
});

test('source: one zodiac table, shared — no local table, no stale year cap', () => {
  const match = fs.readFileSync(path.join(__dirname, '..', 'gaia-match.js'), 'utf8');
  const wellness = fs.readFileSync(path.join(__dirname, '..', 'gaia-wellness.js'), 'utf8');
  assert.doesNotMatch(match, /const SIGNS = \[\[/, 'local zodiac table removed');
  assert.doesNotMatch(match, /yr >= 1900 && yr <= 2025/, 'fixed 2025 cap removed');
  assert.match(match, /window\.GaiaWellness && window\.GaiaWellness\.sunSignFromDob/);
  assert.match(wellness, /sunSignFromDob,/, 'wellness exports the shared function');
});

test('offline: every versioned home.html script is in the service worker shell', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'home.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  const referenced = new Set([...html.matchAll(/src="([a-z0-9-]+\.js)\?v=/g)].map((m) => m[1]));
  const shell = new Set([...sw.matchAll(/'\/([a-z0-9.-]+\.js)'/g)].map((m) => m[1]));
  assert.ok(referenced.size >= 20, 'sanity: found the script set');
  const missing = [...referenced].filter((name) => !shell.has(name));
  assert.deepEqual(missing, [], `scripts referenced by home.html but not precached (offline gap): ${missing.join(', ')}`);
});
