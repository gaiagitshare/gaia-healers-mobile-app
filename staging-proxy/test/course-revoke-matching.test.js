import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/* The historical backfill wrote course rows keyed by courseGroupKey(name) with
 * the human name attached — no real GHL product id. A live webhook may later
 * grant or revoke the same course carrying only a product id. These tests pin
 * the guarantee that grant AND revoke still land on the backfilled row, and
 * that an unmappable revoke NEVER removes the wrong course. */

// Load the pure matching functions straight out of server.js without booting it.
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'server.js'), 'utf8');
const grab = (name) => {
  const m = src.match(new RegExp('function ' + name + '[\\s\\S]*?\\n}\\n'));
  if (!m) throw new Error('could not extract ' + name);
  return m[0];
};
const mod = await import('data:text/javascript;base64,' + Buffer.from(
  grab('courseGroupKey') + grab('aliasKeyForId') + grab('aliasIdForKey') +
  grab('learnCourseAlias') + grab('resolveEntitlementMatch') +
  '\nexport { courseGroupKey, learnCourseAlias, resolveEntitlementMatch };'
).toString('base64'));
const { courseGroupKey, learnCourseAlias, resolveEntitlementMatch } = mod;

const backfillRow = () => ({ id: courseGroupKey('Bio-Well Orientation'), name: 'Bio-Well Orientation', state: 'unlocked' });
const REAL_ID = '690e4b4113902719e07bdc3d';

test('name-only revoke matches a name-keyed backfill row', () => {
  const store = { courseAliases: { byId: {}, byKey: {} } };
  const i = resolveEntitlementMatch([backfillRow()],
    { id: courseGroupKey('Bio-Well Orientation'), name: 'Bio-Well Orientation', rawId: '' }, store);
  assert.equal(i, 0);
});

test('id-only revoke with no learned alias does NOT match (safe no-op, gets logged)', () => {
  const store = { courseAliases: { byId: {}, byKey: {} } };
  const i = resolveEntitlementMatch([backfillRow()],
    { id: REAL_ID, name: REAL_ID, rawId: REAL_ID }, store);
  assert.equal(i, -1);
});

test('a grant carrying both id and name teaches the alias', () => {
  const store = { courseAliases: { byId: {}, byKey: {} } };
  learnCourseAlias(store, REAL_ID, 'Bio-Well Orientation');
  assert.equal(store.courseAliases.byId[REAL_ID], courseGroupKey('Bio-Well Orientation'));
});

test('id-only revoke matches the backfill row once the alias is learned', () => {
  const store = { courseAliases: { byId: {}, byKey: {} } };
  learnCourseAlias(store, REAL_ID, 'Bio-Well Orientation');
  const i = resolveEntitlementMatch([backfillRow()],
    { id: REAL_ID, name: REAL_ID, rawId: REAL_ID }, store);
  assert.equal(i, 0);
});

test('an unrelated course never matches (no wrong-course removal)', () => {
  const store = { courseAliases: { byId: {}, byKey: {} } };
  const i = resolveEntitlementMatch([backfillRow()],
    { id: 'tachyon stress relief certification', name: 'Tachyon Stress Relief Certification', rawId: '' }, store);
  assert.equal(i, -1);
});

test('exact product-id match still works for a normally id-keyed row', () => {
  const store = { courseAliases: { byId: {}, byKey: {} } };
  const i = resolveEntitlementMatch([{ id: 'abc123', name: 'Something' }],
    { id: 'abc123', name: 'Something', rawId: 'abc123' }, store);
  assert.equal(i, 0);
});

test('learnCourseAlias ignores a derived key masquerading as an id', () => {
  const store = { courseAliases: { byId: {}, byKey: {} } };
  learnCourseAlias(store, courseGroupKey('Bio-Well Orientation'), 'Bio-Well Orientation');
  assert.deepEqual(store.courseAliases.byId, {});   // id === its own key => not a real product id
});
