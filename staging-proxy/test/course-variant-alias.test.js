import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/* Community/cohort-suffix course variants ("…-Bio-Well Practitioners",
 * "…-BioPulsar Practitioners") are the SAME course as an existing in-app course.
 * These tests pin the approved fix:
 *   - grant of a variant resolves to the canonical course (authority alias),
 *   - revoke of the SAME variant lands on the SAME canonical row (symmetry),
 *   - AMBIGUOUS_RESOURCE, UNKNOWN_RESOURCE, content-gap and fake resources are
 *     UNCHANGED (no leak, no broad fuzzy fallback).
 * Pure functions are extracted from server.js and given INJECTED indexes, so
 * there is no file I/O and no dependency on production data. */

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'server.js'), 'utf8');
const grab = (name) => {
  const m = src.match(new RegExp('function ' + name + '[\\s\\S]*?\\n}\\n'));
  if (!m) throw new Error('could not extract ' + name);
  return m[0];
};
const mod = await import('data:text/javascript;base64,' + Buffer.from(
  // A throwing stub guarantees the tests never silently fall back to real file
  // I/O — every case here MUST inject its authority index.
  'function buildCourseAuthorityIndex(){throw new Error("inject authAliasIndex in tests");}\n'
  + grab('courseGroupKey') + grab('aliasKeyForId') + grab('aliasIdForKey')
  + grab('learnCourseAlias') + grab('resolveEntitlementMatch') + grab('resolveCourseGrant')
  + '\nexport { courseGroupKey, resolveEntitlementMatch, resolveCourseGrant };'
).toString('base64'));
const { courseGroupKey, resolveEntitlementMatch, resolveCourseGrant } = mod;

// Exact verified production canonicals.
const CANON = {
  chakra: { id: 'lms-export:60ec120d546b8c7e', title: '9-Week Chakra Challenge' },
  crm:    { id: 'lms-export:0ba947237412ebbb', title: 'GaiaPractitioners CRM Mastery: Organize, Connect, Grow' },
  basic:  { id: 'lms-export:e6bcba1b904df0e9', title: 'Bio-Well Basic Certification Training' },
};
const VARIANTS = [
  { name: '9-Week Chakra Challenge-BioPulsar Practitioners', canon: CANON.chakra },
  { name: 'GaiaPractitioners CRM Mastery: Organize, Connect, Grow -Bio-Well Practitioners', canon: CANON.crm },
  { name: 'Bio-Well Basic Certification Training-Bio-Well Practitioners', canon: CANON.basic },
];
const aliasEntry = (c) => ({ id: c.id, title: c.title, method: 'community_cohort_suffix_alias' });

// Fixture authority index mirroring buildCourseAuthorityIndex()'s shape, with the
// three approved aliases, the real ambiguous key, and the canonical byKey rows.
function fixtureIdx() {
  const aliasByKey = new Map(VARIANTS.map((v) => [courseGroupKey(v.name), aliasEntry(v.canon)]));
  const byKey = new Map(Object.values(CANON).map((c) => [courseGroupKey(c.title), { id: c.id, title: c.title }]));
  return {
    byId: new Map(Object.values(CANON).map((c) => [c.id.toLowerCase(), { id: c.id, title: c.title }])),
    byKey,
    ambiguousKeys: new Set(['level 1 certification training']), // real 4-way collision
    aliasByKey,
    aliasById: new Map(),
  };
}

// ── GRANT authority gate (resolveCourseGrant) ──────────────────────────────
for (const v of VARIANTS) {
  test(`GRANT: variant "${v.name.slice(0, 32)}…" resolves to canonical`, () => {
    const r = resolveCourseGrant(fixtureIdx(), { name: v.name, rawId: '' });
    assert.ok(r.course, 'should resolve');
    assert.equal(r.course.id, v.canon.id);
    assert.equal(r.course.title, v.canon.title);
    assert.equal(r.method, 'community_cohort_suffix_alias');
  });
}
test('GRANT: exact canonical name still resolves (via byKey, unchanged)', () => {
  const r = resolveCourseGrant(fixtureIdx(), { name: '9-Week Chakra Challenge', rawId: '' });
  assert.equal(r.course.id, CANON.chakra.id);
  assert.equal(r.method, 'exact_authoritative_name');
});
test('AMBIGUOUS resource stays AMBIGUOUS (guard preserved)', () => {
  const r = resolveCourseGrant(fixtureIdx(), { name: 'Level 1 Certification Training', rawId: '' });
  assert.equal(r.reject, 'AMBIGUOUS_RESOURCE');
});
test('FAKE/garbage resource stays UNKNOWN_RESOURCE', () => {
  assert.equal(resolveCourseGrant(fixtureIdx(), { name: 'Free Diamond Membership Hack', rawId: '' }).reject, 'UNKNOWN_RESOURCE');
  assert.equal(resolveCourseGrant(fixtureIdx(), { name: 'totally-fake-id-xyz-000', rawId: '' }).reject, 'UNKNOWN_RESOURCE');
});
test('CONTENT-GAP courses stay UNKNOWN_RESOURCE (Auriculo, Tachyon — untouched)', () => {
  assert.equal(resolveCourseGrant(fixtureIdx(), { name: 'Auriculo Therapy', rawId: '' }).reject, 'UNKNOWN_RESOURCE');
  assert.equal(resolveCourseGrant(fixtureIdx(), { name: 'Tachyon Stress Relief Certification', rawId: '' }).reject, 'UNKNOWN_RESOURCE');
});
test('BUNDLE-ish "Advanced Level 1 & 2" stays unresolved (not a title variant)', () => {
  const r = resolveCourseGrant(fixtureIdx(), { name: 'Advanced Level 1 & 2 Training-Bio-Well Practitioners', rawId: '' });
  assert.ok(r.reject, 'must not resolve a bundle');
});
test('no alias collision — each of the 3 alias keys maps to exactly one canonical', () => {
  const idx = fixtureIdx();
  const targets = VARIANTS.map((v) => idx.aliasByKey.get(courseGroupKey(v.name)).id);
  assert.equal(new Set(targets).size, 3, 'three distinct canonicals');
});

// ── REVOKE / existing-row symmetry (resolveEntitlementMatch) ────────────────
for (const v of VARIANTS) {
  const idx = fixtureIdx();
  const store = { courseAliases: { byId: {}, byKey: {} } };
  const canonicalRow = () => [{ id: v.canon.id, name: v.canon.title, state: 'unlocked' }];
  test(`SYMMETRY: variant grant re-resolves to the canonical row "${v.canon.title.slice(0, 24)}…"`, () => {
    const i = resolveEntitlementMatch(canonicalRow(), { name: v.name, rawId: courseGroupKey(v.name) }, store, idx);
    assert.equal(i, 0, 'variant must land on the canonical row (grant)');
  });
  test(`SYMMETRY: same variant REVOKE lands on the same canonical row`, () => {
    const i = resolveEntitlementMatch(canonicalRow(), { name: v.name, rawId: courseGroupKey(v.name) }, store, idx);
    assert.equal(i, 0, 'variant revoke must remove the SAME canonical row');
  });
}
test('canonical name still matches its own row (unchanged)', () => {
  const i = resolveEntitlementMatch([{ id: CANON.chakra.id, name: CANON.chakra.title }],
    { name: CANON.chakra.title, rawId: '' }, { courseAliases: { byId: {}, byKey: {} } }, fixtureIdx());
  assert.equal(i, 0);
});
test('unrelated course never matches the canonical row (no wrong-course removal)', () => {
  const i = resolveEntitlementMatch([{ id: CANON.chakra.id, name: CANON.chakra.title }],
    { name: 'Tachyon Stress Relief Certification', rawId: '' }, { courseAliases: { byId: {}, byKey: {} } }, fixtureIdx());
  assert.equal(i, -1);
});
