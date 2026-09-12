/**
 * A practitioner row must not carry a photo URL we know is dead.
 *
 * gaiapractitioners.com returns uploaded photos as bare filenames and, as of
 * 2026-09-12, serves them from nowhere public. Resolving them against the site
 * root produced 140 URLs that 404'd; the app showed initials only after each
 * failed fetch. Bare filenames now resolve only against a base the upstream
 * has published (DIRECTORY_UPLOAD_BASE_URL). Absolute URLs pass through.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DIRECTORY_UPLOAD_BASE_URL;
const { directoryImage } = await import('../directory-router.js');

test('an absolute photo URL passes through untouched', () => {
  assert.equal(directoryImage('https://biohackingcongress.com/storage/users/x.png'), 'https://biohackingcongress.com/storage/users/x.png');
});

test('a bare upload filename is dropped while no upload base is published', () => {
  assert.equal(directoryImage('image-1724780140069-623732947.jpeg'), '');
  assert.equal(directoryImage('/image-1724780140069-623732947.jpeg'), '');
});

test('null-ish values are empty, not the string "null"', () => {
  assert.equal(directoryImage(null), '');
  assert.equal(directoryImage('null'), '');
  assert.equal(directoryImage('https://gaiapractitioners.com/null'), '');
  assert.equal(directoryImage('   '), '');
});
