const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'gaia-member.js'), 'utf8');
const fn = src.slice(src.indexOf('  async function renderSyncedAcademy()'), src.indexOf('  // Distinctive-token normalizer'));
test('an owned course without synced videos is still listed (it was dropped and hidden from the catalogue)', () => {
  assert.doesNotMatch(fn, /\.filter\(\(c\) => \(c\.sections \|\| \[\]\)\.some/, 'no filter that drops courses without lessons');
  assert.match(fn, /data-sync-portal/, 'unsynced courses open in the Academy portal');
});
test('"Your courses" is inserted once even when the Academy renders twice', () => {
  assert.match(fn, /renderSyncedAcademy\.run/, 'only the newest run inserts');
  assert.match(fn, /querySelectorAll\('\[data-acad-sync\]'\)\.forEach\(\(n\) => n\.remove\(\)\)/, 'an earlier block is replaced');
});
