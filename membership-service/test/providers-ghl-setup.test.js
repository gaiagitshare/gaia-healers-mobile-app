import './_providers-deny-network.mjs';
/**
 * GHL setup spec + read-only dry-run diff (cli/ghl-setup-report.js). No GHL
 * client exists in this path; the data is the legacy mirror in the database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshPool, SKIP, TEST_URL } from './_db.js';
import { GHL_FIELDS, WORKFLOW_CHANGES, allTagNames, planLegacyGhlWrites } from '../src/providers/ghl/setup-spec.js';
import { FIELD_SPECS } from '../src/providers/ghl/desired-state.js';
import { main } from '../src/cli/ghl-setup-report.js';

test('spec: exactly the five allowlisted fields; every listed value passes the field check', () => {
  assert.deepEqual(GHL_FIELDS.map((f) => f.key), Object.keys(FIELD_SPECS));
  for (const f of GHL_FIELDS) for (const v of f.values.filter((x) => !/[ (]/.test(x) && x !== 'YYYY-MM-DD')) assert.ok(FIELD_SPECS[f.key](v), `${f.key}=${v}`);
  assert.ok(FIELD_SPECS.gaia_membership_access_until('2027-01-31'));
});

test('spec: every tag is gaia-m: and lowercase; legacy tags only for silver/gold/diamond; no ahc-*', () => {
  const t = allTagNames();
  const all = Object.values(t).flat();
  assert.ok(all.every((x) => x.startsWith('gaia-m:') && x === x.toLowerCase()));
  assert.deepEqual(t.legacy, ['gaia-m:legacy:silver', 'gaia-m:legacy:gold', 'gaia-m:legacy:diamond']);
  assert.ok(t.benefit.includes('gaia-m:benefit:courses.core'));
  assert.ok(!t.benefit.some((x) => x.includes('software.')), 'software modules are not mirrored');
  assert.ok(WORKFLOW_CHANGES.some((w) => /tier:none/.test(w.what)));
});

test('the report path has no GHL client and no network transport', () => {
  for (const f of ['../src/cli/ghl-setup-report.js', '../src/providers/ghl/setup-spec.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /ghl\/client\.js|\.\/client\.js|fetch\(|GHL_TOKEN|LEADCONNECTOR/i, f);
  }
});

test('--spec needs no database; the diff refuses a non-loopback database', async () => {
  const lines = [];
  assert.equal(await main(['--spec'], { env: {}, out: (s) => lines.push(s), err: (s) => lines.push(s) }), 0);
  assert.match(lines.join('\n'), /gaia_membership_cancel_scheduled/);
  assert.equal(await main([], { env: { MEMBERSHIP_DATABASE_URL: 'postgres://u:p@db.example.invalid/x' }, out: () => {}, err: () => {} }), 2);
  assert.equal(await main([], { env: {}, out: () => {}, err: () => {} }), 2);
});

test('dry-run diff from the legacy mirror: legacy tags for live mapped rows, hold for unknown, nothing for unmapped / ended; writes nothing', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const row = (sub, contact, provider, tier, mapping, status, stale = false) => pool.query(
      `INSERT INTO legacy_memberships (external_subscription_id, external_contact_id, payment_provider, tier, mapping, reported_status, stale_suspected, review_state, review_reasons)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [sub, contact, provider, tier, mapping, status, stale, stale ? 'needs_review' : 'none', stale ? ['stale_suspected', 'paypal_no_recent_payment'] : []]);
    await row('s1', 'contact_aaaa1111', 'stripe', 'silver', 'mapped', 'active');
    await row('s2', 'contact_bbbb2222', 'paypal', 'diamond', 'mapped', 'active', true);
    await row('s3', 'contact_cccc3333', 'paypal', null, 'unmapped', 'active');
    await row('s4', 'contact_dddd4444', 'stripe', 'gold', 'mapped', 'canceled');
    await row('s5', 'contact_eeee5555', 'stripe', 'gold', 'mapped', 'weird_new_status');
    await row('s6', null, 'stripe', 'silver', 'mapped', 'active');
    const before = (await pool.query('SELECT md5(string_agg(t::text, \'|\' ORDER BY id)) AS h FROM legacy_memberships t')).rows[0].h;

    const r = await planLegacyGhlWrites(pool);
    const by = Object.fromEntries(r.contacts.map((c) => [c.contact, c]));
    assert.equal(r.summary.contacts, 5);
    assert.equal(r.summary.noContactId, 1);
    assert.ok(by['…1111'].addTags.includes('gaia-m:legacy:silver'));
    assert.ok(by['…2222'].addTags.includes('gaia-m:legacy:diamond'), 'a stale PayPal row is flagged, never treated as ended');
    assert.ok(by['…2222'].notes.some((n) => /PayPal/.test(n)) && by['…2222'].notes.some((n) => /stale suspected/.test(n)));
    assert.ok(!by['…3333'].addTags.some((t) => t.includes('legacy:')));
    assert.ok(by['…3333'].notes.some((n) => /unchanged until classified/.test(n)));
    assert.ok(!by['…4444'].addTags.some((t) => t.includes('legacy:')));
    assert.deepEqual(by['…5555'].holdTags, ['gaia-m:legacy:gold']);
    for (const c of r.contacts) {
      assert.ok(c.addTags.every((t) => t.startsWith('gaia-m:')));
      assert.deepEqual(c.removeTags, []);
      assert.ok(c.addTags.includes('gaia-m:tier:none') && c.setFields.includes('gaia_membership_tier=none'));
    }
    assert.equal(r.summary.unclassified, 1);
    assert.equal(r.summary.paypal, 2);
    assert.equal(r.summary.legacyTagged, 2);
    assert.equal(r.summary.held, 1);

    const lines = [];
    assert.equal(await main([], { env: { MEMBERSHIP_DATABASE_URL: TEST_URL }, out: (s) => lines.push(s), err: (s) => lines.push(s) }), 0);
    const text = lines.join('\n');
    assert.match(text, /no GHL request was made/);
    assert.doesNotMatch(text, /contact_aaaa1111/, 'ids masked by default');
    const after = (await pool.query('SELECT md5(string_agg(t::text, \'|\' ORDER BY id)) AS h FROM legacy_memberships t')).rows[0].h;
    assert.equal(after, before, 'the legacy mirror is unchanged');
  } finally { await pool.end(); }
});
