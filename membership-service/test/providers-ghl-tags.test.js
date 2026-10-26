import './_providers-deny-network.mjs';
/**
 * GHL CRM-only mirror under architecture C, against a LOOPBACK fake GHL:
 * gaia-m:legacy:<tier> tags, foreign tags (ahc-* included) never touched, safe
 * tag transitions with resumable partial failures, custom-field discovery by
 * key, benefit -> offer/community expectations, confirmations and alerts,
 * workflow drift reconciliation. Fictional data and fixture ids only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, actor } from './_db.js';
import { fakeGhl, fetchVia, noSleep } from './_providers-fakes.js';
import { createGhlClient } from '../src/providers/ghl/client.js';
import { desiredGhlState, diffGhlState, FIELD_SPECS, DEFAULT_TAG_PREFIX } from '../src/providers/ghl/desired-state.js';
import { syncPersonToGhl, pgDeadLetterStore } from '../src/providers/ghl/sync.js';
import { mapFieldIds, createFieldIdResolver } from '../src/providers/ghl/field-ids.js';
import { validateBenefitMap, expectedGrantsFor, recordGrantConfirmation, findUnconfirmedGrants, confirmationFromMirror, BENEFIT_GRANTS } from '../src/providers/ghl/grants.js';
import { reconcileGhlTags, tagDrift } from '../src/providers/ghl/reconcile.js';
import { computeEntitlements } from '../src/entitlements.js';
import { seedCatalog, currentVersion } from '../src/plans.js';
import { resolveOrCreatePerson, linkIdentity } from '../src/identity.js';
import { createSubscription } from '../src/subscriptions.js';
import { MembershipError } from '../src/errors.js';

const P = DEFAULT_TAG_PREFIX;
const NOW = new Date('2026-12-01T00:00:00Z');
const AFTER_IC = new Date('2027-01-10T00:00:00Z');    // inner_circle period over (+ grace), standard still running
const FIELD_IDS = Object.fromEntries(Object.keys(FIELD_SPECS).map((k, i) => [k, 'cf_' + i]));
const FOREIGN = ['ahc-gold-active', 'ahc-gold-trial', 'ahc-gold-cancel', 'ahc-silver-active', 'ahc-diamond-active', 'membership_silver', 'silver-membership', 'gaia-community-x', 'newsletter'];
const client = (srv, extra = {}) => createGhlClient({ token: 'ghl-fixture-token', locationId: 'loc_fixture', fetch: fetchVia, baseUrl: srv.url, sleep: noSleep, ...extra });

async function person(pool, contactId) {
  await seedCatalog(pool);
  const pid = (await resolveOrCreatePerson(pool, { platform: 'email', kind: 'address', externalId: contactId + '@example.invalid' })).personId;
  await linkIdentity(pool, pid, { platform: 'ghl', kind: 'contact', externalId: contactId }, { linkedBy: 'test' });
  return pid;
}
const subscribe = async (pool, pid, planKey, periodEnd) => createSubscription(pool, { personId: pid, planVersionId: (await currentVersion(pool, planKey)).id, interval: 'month', status: 'active', periodStart: new Date('2026-11-01'), periodEnd: new Date(periodEnd) }, actor);
async function legacyRow(pool, pid, { id, tier, status = 'active', mapping = 'mapped' }) {
  await pool.query(`INSERT INTO legacy_memberships (external_subscription_id, external_contact_id, person_id, payment_provider, external_price_id, tier, mapping, reported_status)
                    VALUES ($1, $2, $3, 'stripe', 'pr_fx', $4, $5, $6)`, [id, 'gc_x', pid, mapping === 'mapped' ? tier : null, mapping, status]);
}
const tagWrites = (srv) => srv.requests.filter((r) => /\/tags$/.test(r.path));

// ---- pure -----------------------------------------------------------------------

test('legacy tiers become gaia-m:legacy:<tier> only; unknown status is held, never removed', () => {
  const ev = computeEntitlements({ subscriptions: [] }, NOW);
  const d = desiredGhlState(ev, { legacy: { live: ['silver'], hold: ['gold'] } });
  assert.ok(d.tags.includes(`${P}legacy:silver`));
  assert.ok(d.tags.includes(`${P}tier:none`), 'legacy is NOT mirrored into tier:*');
  assert.ok(!d.tags.some((t) => /tier:(silver|gold|diamond)/.test(t)));
  assert.deepEqual(d.holdTags, [`${P}legacy:gold`]);
  const diff = diffGhlState({ tags: [`${P}legacy:gold`, `${P}legacy:diamond`, 'ahc-gold-active'] }, d, { fieldIds: FIELD_IDS });
  assert.deepEqual(diff.removeTags, [`${P}legacy:diamond`], 'held tag kept, ended tier removed, ahc-* untouched');
  assert.ok(!diff.addTags.includes(`${P}legacy:gold`), 'held tag is not added either');
  assert.throws(() => desiredGhlState(ev, { legacy: { live: ['Bad Tier'] } }), /legacy tier/);
});

test('custom fields are resolved BY KEY; missing and duplicate keys are reported, never created', async () => {
  const defs = [
    { id: 'f1', fieldKey: 'contact.gaia_membership_tier' }, { id: 'f2', fieldKey: 'contact.gaia_membership_status' },
    { id: 'f3', fieldKey: 'contact.gaia_membership_access_until' }, { id: 'f3b', fieldKey: 'contact.gaia_membership_access_until' },
    { id: 'f4', fieldKey: 'contact.gaia_membership_plans' }, { id: 'fx', fieldKey: 'contact.ahc_level' },
  ];
  assert.deepEqual(mapFieldIds(defs), {
    fieldIds: { gaia_membership_tier: 'f1', gaia_membership_status: 'f2', gaia_membership_plans: 'f4' },
    missing: ['gaia_membership_cancel_scheduled'], duplicates: ['gaia_membership_access_until'] });

  const srv = await fakeGhl({ fieldDefinitions: defs });
  try {
    let t = 0; const reports = [];
    const r = createFieldIdResolver({ ghl: client(srv, { retry: { maxRetries: 0 } }), ttlMs: 1000, clock: () => t, onReport: (x) => reports.push(x) });
    assert.equal((await r.resolve()).fieldIds.gaia_membership_tier, 'f1');
    t = 999; await r.resolve();
    assert.equal(srv.requests.length, 1, 'cached within the TTL');
    t = 1000; await r.resolve();
    assert.equal(srv.requests.length, 2, 'refetched after the TTL');
    assert.equal(reports.length, 2);
    assert.deepEqual(reports[0], { missing: ['gaia_membership_cancel_scheduled'], duplicates: ['gaia_membership_access_until'] });
    srv.faults.push({ status: 503, json: {} });
    t = 5000;
    const stale = await r.resolve();
    assert.equal(stale.stale, true, 'a failed refresh serves the last good map');
    assert.equal(stale.fieldIds.gaia_membership_tier, 'f1');
    assert.ok(srv.requests.every((x) => x.method === 'GET' && x.path === '/locations/loc_fixture/customFields'), 'GET only: fields are never created');
  } finally { await srv.close(); }
});

test('benefit map: validated, gaia-m: viaTag only, expectations follow tag changes', () => {
  assert.deepEqual(BENEFIT_GRANTS, {}, 'real map stays empty until a GHL admin creates offers and workflows');
  const map = validateBenefitMap({
    'courses.core': { type: 'offer', ghlId: 'offer_fx_core', viaTag: `${P}benefit:courses.core` },
    'community.access': { type: 'community', ghlId: 'group_fx_main', viaTag: `${P}benefit:community.access` },
  });
  assert.throws(() => validateBenefitMap({ 'courses.core': { type: 'offer', ghlId: 'o1', viaTag: 'ahc-gold-active' } }), /viaTag/);
  assert.throws(() => validateBenefitMap({ 'courses.core': { type: 'invoice', ghlId: 'o1', viaTag: `${P}x` } }), /type/);
  assert.throws(() => validateBenefitMap({ 'courses.core': { type: 'offer', ghlId: '../x', viaTag: `${P}x` } }), /ghlId/);
  const e = expectedGrantsFor({ addTags: [`${P}benefit:courses.core`], removeTags: [`${P}benefit:community.access`, `${P}tier:standard`] }, map);
  assert.deepEqual(e.map((x) => [x.entitlementKey, x.type, x.action]), [['courses.core', 'offer', 'grant'], ['community.access', 'community', 'revoke']]);
  assert.deepEqual(confirmationFromMirror({ type: 'Course Access Granted', contactId: 'gc_1', offerId: 'offer_fx_core' }), { contactId: 'gc_1', type: 'offer', ghlId: 'offer_fx_core', granted: true });
  assert.deepEqual(confirmationFromMirror({ event: 'course.access.removed', contact: { id: 'gc_1' }, course: { id: 'offer_fx_core' } }).granted, false);
  assert.equal(confirmationFromMirror({ type: 'community_group_added', contactId: 'gc_1', groupId: 'group_fx_main' }).type, 'community');
  assert.equal(confirmationFromMirror({ type: 'Course Access Granted', offerId: 'o' }), null, 'no contact id -> not a confirmation');
  assert.equal(confirmationFromMirror({ type: 'contact_tag_added', contactId: 'gc_1' }), null);
});

test('drift: missing and extra Gaia tags; foreign tags only counted', () => {
  const d = tagDrift([`${P}tier:professional`, `${P}legacy:gold`, 'ahc-gold-active', 'Newsletter'], { tags: [`${P}tier:standard`], holdTags: [`${P}legacy:gold`] });
  assert.deepEqual(d, { missing: [`${P}tier:standard`], extra: [`${P}tier:professional`], foreignIgnored: 2 });
});

// ---- sync against the fake --------------------------------------------------------

test('sync never adds or removes a non-gaia-m: tag, across legacy and tier changes (ahc-* Gold tags included)', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhl({ contacts: [{ id: 'gt_1', email: 'gt_1@example.invalid', tags: [...FOREIGN, `${P}tier:professional`] }] });
  try {
    const pid = await person(pool, 'gt_1');
    await legacyRow(pool, pid, { id: 'ls_1', tier: 'silver' });
    const deps = { pool, ghl: client(srv), fieldIds: FIELD_IDS };
    await syncPersonToGhl({ ...deps, now: NOW }, pid);
    assert.ok(srv.db.get('gt_1').tags.includes(`${P}legacy:silver`));
    await pool.query("UPDATE legacy_memberships SET reported_status = 'canceled'");
    await subscribe(pool, pid, 'standard', '2027-06-30');
    await subscribe(pool, pid, 'inner_circle', '2026-12-31');
    await syncPersonToGhl({ ...deps, now: NOW }, pid);
    await syncPersonToGhl({ ...deps, now: AFTER_IC }, pid);
    await pool.query("UPDATE legacy_memberships SET reported_status = 'mystery_status'");
    await syncPersonToGhl({ ...deps, now: AFTER_IC }, pid);

    assert.ok(tagWrites(srv).length >= 4);
    for (const w of tagWrites(srv)) for (const t of w.json.tags) assert.ok(t.startsWith(P), `${w.method} sent foreign tag ${t}`);
    const tags = srv.db.get('gt_1').tags;
    for (const f of FOREIGN) assert.ok(tags.includes(f), `foreign tag ${f} kept`);
    assert.equal(tags.filter((t) => !t.startsWith(P)).length, FOREIGN.length, 'no foreign tag added');
    assert.ok(!tags.includes(`${P}legacy:silver`), 'removed once GHL reported the legacy subscription canceled');
    assert.ok(!tags.some((t) => /tier:(silver|gold|diamond)/.test(t)));
  } finally { await srv.close(); await pool.end(); }
});

test('grant new -> confirm -> revoke old: fields, add new, then remove old; idempotent; one tier at the end', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhl({ contacts: [{ id: 'gt_2', email: 'gt_2@example.invalid', tags: ['ahc-gold-active'] }] });
  try {
    const pid = await person(pool, 'gt_2');
    await subscribe(pool, pid, 'standard', '2027-06-30');
    await subscribe(pool, pid, 'inner_circle', '2026-12-31');
    const deps = { pool, ghl: client(srv), fieldIds: FIELD_IDS };
    await syncPersonToGhl({ ...deps, now: NOW }, pid);
    assert.ok(srv.db.get('gt_2').tags.includes(`${P}tier:inner_circle`));

    srv.requests.length = 0;
    const down = await syncPersonToGhl({ ...deps, now: AFTER_IC }, pid);                // downgrade to standard
    assert.equal(down.status, 'synced');
    assert.deepEqual(srv.requests.map((r) => r.method + ' ' + r.path), ['GET /contacts/gt_2', 'PUT /contacts/gt_2', 'POST /contacts/gt_2/tags', 'DELETE /contacts/gt_2/tags'],
      'fields first, then the NEW tags, then the old ones are removed');
    assert.ok(srv.requests[3].json.tags.includes(`${P}tier:inner_circle`));
    const tags = srv.db.get('gt_2').tags;
    assert.ok(tags.includes(`${P}tier:standard`) && !tags.includes(`${P}tier:inner_circle`));
    assert.equal(tags.filter((t) => t.startsWith(`${P}tier:`)).length, 1, 'exactly one tier tag at the end');
    assert.ok(tags.includes('ahc-gold-active'), 'existing GHL tags are never touched');

    srv.requests.length = 0;
    const again = await syncPersonToGhl({ ...deps, now: AFTER_IC }, pid);
    assert.deepEqual([again.addTags, again.removeTags, again.fieldUpdates], [[], [], []]);
    assert.deepEqual(srv.requests.map((r) => r.method), ['GET'], 'idempotent: nothing written');
  } finally { await srv.close(); await pool.end(); }
});

test('old access is revoked only after GHL confirms the new grant', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhl({ contacts: [{ id: 'gt_4', email: 'gt_4@example.invalid', tags: [] }] });
  try {
    const pid = await person(pool, 'gt_4');
    await subscribe(pool, pid, 'professional', '2026-12-31');
    await subscribe(pool, pid, 'standard', '2027-06-30');
    const benefitMap = { 'crm.ghl_subaccount': { type: 'offer', ghlId: 'offer-fixture-pro', viaTag: `${P}benefit:crm.ghl_subaccount` },
      'courses.core': { type: 'offer', ghlId: 'offer-fixture-core', viaTag: `${P}benefit:courses.core` } };
    const deps = { pool, ghl: client(srv), fieldIds: FIELD_IDS, benefitMap };
    await syncPersonToGhl({ ...deps, now: NOW }, pid);
    await recordGrantConfirmation(pool, { contactId: 'gt_4', type: 'offer', ghlId: 'offer-fixture-core', granted: true });
    await recordGrantConfirmation(pool, { contactId: 'gt_4', type: 'offer', ghlId: 'offer-fixture-pro', granted: true });
    // Professional ends; Standard remains. A NEW benefit tag for the remaining plan would need confirmation first:
    // simulate one by expecting a pending grant on a still-desired tag.
    await pool.query(`INSERT INTO ghl_expected_grants (person_id, contact_id, entitlement_key, grant_type, ghl_id, via_tag, action, map_version, expected_at)
                      VALUES ($1, 'gt_4', 'courses.core', 'offer', 'offer-fixture-core-v2', $2, 'grant', 1, now())`, [pid, `${P}benefit:courses.core`]);
    const r = await syncPersonToGhl({ ...deps, now: AFTER_IC }, pid);
    assert.equal(r.status, 'synced_revoke_deferred');
    assert.ok(r.deferredRemoveTags.includes(`${P}benefit:crm.ghl_subaccount`));
    assert.ok(srv.db.get('gt_4').tags.includes(`${P}benefit:crm.ghl_subaccount`), 'old access kept while the new grant is unconfirmed');
    await recordGrantConfirmation(pool, { contactId: 'gt_4', type: 'offer', ghlId: 'offer-fixture-core-v2', granted: true });
    const r2 = await syncPersonToGhl({ ...deps, now: AFTER_IC }, pid);
    assert.equal(r2.status, 'synced');
    assert.ok(!srv.db.get('gt_4').tags.includes(`${P}benefit:crm.ghl_subaccount`), 'revoked once the new grant is confirmed');
    const revokes = (await pool.query("SELECT count(*)::int n FROM ghl_expected_grants WHERE contact_id = 'gt_4' AND action = 'revoke'")).rows[0].n;
    assert.equal(revokes, 1, 'the revoke is tracked for confirmation too');
  } finally { await srv.close(); await pool.end(); }
});

test('partial failure: access is never lost; dead letter partial_apply; a re-run resumes and resolves it', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhl({ contacts: [{ id: 'gt_3', email: 'gt_3@example.invalid', tags: ['ahc-gold-cancel'] }] });
  try {
    const pid = await person(pool, 'gt_3');
    await subscribe(pool, pid, 'standard', '2027-06-30');
    await subscribe(pool, pid, 'inner_circle', '2026-12-31');
    const good = client(srv);
    const store = pgDeadLetterStore(pool);
    await syncPersonToGhl({ pool, ghl: good, fieldIds: FIELD_IDS, now: NOW }, pid);

    const down = () => { throw new MembershipError('PROVIDER_UNAVAILABLE', 'ghl down (fixture)'); };
    // 1. the REMOVE fails after fields + the new tags succeeded: both tiers for a moment, never none
    const r1 = await syncPersonToGhl({ pool, ghl: { ...good, removeTags: down }, fieldIds: FIELD_IDS, now: AFTER_IC }, pid);
    assert.deepEqual([r1.status, r1.reason], ['dead_letter', 'partial_apply']);
    let open = await store.listOpen();
    assert.deepEqual([open.length, open[0].reason, open[0].details.applied], [1, 'partial_apply', ['fields', 'add_tags']]);
    let tierTags = srv.db.get('gt_3').tags.filter((t) => t.startsWith(`${P}tier:`)).sort();
    assert.deepEqual(tierTags, [`${P}tier:inner_circle`, `${P}tier:standard`], 'new access granted, old not yet revoked: never without access');

    // 2. resume: only the removal is left, the dead letter resolves
    srv.requests.length = 0;
    const r2 = await syncPersonToGhl({ pool, ghl: good, fieldIds: FIELD_IDS, now: AFTER_IC }, pid);
    assert.equal(r2.status, 'synced');
    assert.deepEqual(r2.addTags, []);
    assert.ok(r2.removeTags.includes(`${P}tier:inner_circle`));
    assert.deepEqual(srv.requests.map((r) => r.method + ' ' + r.path), ['GET /contacts/gt_3', 'DELETE /contacts/gt_3/tags']);
    assert.equal((await store.listOpen()).length, 0);
    tierTags = srv.db.get('gt_3').tags.filter((t) => t.startsWith(`${P}tier:`));
    assert.deepEqual(tierTags, [`${P}tier:standard`]);

    // 3. the ADD fails: nothing is removed, so the contact keeps its old access
    const pid2 = await person(pool, 'gt_3b');
    srv.db.set('gt_3b', { id: 'gt_3b', email: 'gt_3b@example.invalid', tags: [`${P}tier:professional`, `${P}status:active`], customFields: [], additionalEmails: [] });
    await subscribe(pool, pid2, 'standard', '2027-06-30');
    let removed = 0;
    const r3 = await syncPersonToGhl({ pool, ghl: { ...good, addTags: down, removeTags: async () => { removed++; } }, fieldIds: {}, now: NOW }, pid2);
    assert.deepEqual([r3.status, r3.reason, removed], ['dead_letter', 'provider_unavailable', 0], 'remove never attempted before the new access exists');
    assert.deepEqual(srv.db.get('gt_3b').tags.filter((t) => t.startsWith(`${P}tier:`)), [`${P}tier:professional`]);
    assert.equal((await syncPersonToGhl({ pool, ghl: good, fieldIds: {}, now: NOW }, pid2)).status, 'synced');
    assert.deepEqual(srv.db.get('gt_3b').tags.filter((t) => t.startsWith(`${P}tier:`)), [`${P}tier:standard`]);
  } finally { await srv.close(); await pool.end(); }
});

test('sync with discovered field ids writes only to resolved fields', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhl({
    contacts: [{ id: 'gt_4', email: 'gt_4@example.invalid' }],
    fieldDefinitions: [{ id: 'cf_tier_fx', fieldKey: 'contact.gaia_membership_tier' }, { id: 'cf_status_fx', fieldKey: 'contact.gaia_membership_status' }],
  });
  try {
    const pid = await person(pool, 'gt_4');
    await subscribe(pool, pid, 'professional', '2026-12-31');
    const ghl = client(srv);
    const r = await syncPersonToGhl({ pool, ghl, fieldResolver: createFieldIdResolver({ ghl }), now: NOW }, pid);
    assert.equal(r.status, 'synced');
    assert.deepEqual(r.fieldUpdates.map((f) => f.id).sort(), ['cf_status_fx', 'cf_tier_fx']);
    assert.equal(r.unmappedFields.length, 3, 'missing fields reported');
    assert.equal(srv.db.get('gt_4').customFields.find((f) => f.id === 'cf_tier_fx').value, 'professional');
  } finally { await srv.close(); await pool.end(); }
});

test('expected grants: recorded on tag changes, confirmed by the mirror, unconfirmed ones alert once', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhl({ contacts: [{ id: 'gt_5', email: 'gt_5@example.invalid' }, { id: 'gt_6', email: 'gt_6@example.invalid' }] });
  try {
    const map = validateBenefitMap({
      'courses.core': { type: 'offer', ghlId: 'offer_fx_core', viaTag: `${P}benefit:courses.core` },
      'community.access': { type: 'community', ghlId: 'group_fx_main', viaTag: `${P}benefit:community.access` },
      'legacy:silver': { type: 'offer', ghlId: 'offer_fx_ahc_silver', viaTag: `${P}legacy:silver` },
    });
    const a = await person(pool, 'gt_5');
    const b = await person(pool, 'gt_6');
    await subscribe(pool, a, 'professional', '2026-12-31');
    await legacyRow(pool, b, { id: 'ls_b', tier: 'silver' });
    const deps = { pool, ghl: client(srv), fieldIds: FIELD_IDS, benefitMap: map, now: NOW };
    await syncPersonToGhl(deps, a);
    await syncPersonToGhl(deps, b);
    let exp = (await pool.query('SELECT contact_id, entitlement_key, grant_type, ghl_id, action, status FROM ghl_expected_grants ORDER BY contact_id, entitlement_key')).rows;
    assert.ok(exp.some((e) => e.contact_id === 'gt_5' && e.entitlement_key === 'courses.core' && e.action === 'grant'));
    assert.ok(exp.some((e) => e.contact_id === 'gt_6' && e.ghl_id === 'offer_fx_ahc_silver' && e.action === 'grant'));
    assert.ok(exp.every((e) => e.status === 'pending'));
    await syncPersonToGhl(deps, a);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ghl_expected_grants')).rows[0].n, exp.length, 'no change -> no new expectation');

    // the mirror confirms gt_5's course; gt_6's grant is never confirmed
    const c = confirmationFromMirror({ type: 'Course Access Granted', contactId: 'gt_5', offerId: 'offer_fx_core' });
    assert.deepEqual(await recordGrantConfirmation(pool, { ...c, at: new Date('2026-12-01T01:00:00Z') }), { matched: true, id: (await pool.query("SELECT id FROM ghl_expected_grants WHERE contact_id = 'gt_5' AND grant_type = 'offer'")).rows[0].id });
    assert.deepEqual(await recordGrantConfirmation(pool, { ...c, granted: false }), { matched: false }, 'an unexpected removal is not matched');

    const alerts = [];
    const alert = async (items) => alerts.push(items);
    const later = new Date('2026-12-02T12:00:00Z');
    const r = await findUnconfirmedGrants(pool, { olderThanMs: 24 * 3600000, now: later, alert });
    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0].map((x) => [x.contactId, x.ghlId]).sort(), [['gt_5', 'group_fx_main'], ['gt_6', 'offer_fx_ahc_silver']]);
    assert.equal(r.alerted, 2);
    const again = await findUnconfirmedGrants(pool, { olderThanMs: 24 * 3600000, now: later, alert });
    assert.deepEqual([alerts.length, again.unconfirmed, again.alerted], [1, 2, 0], 'alerted once, still listed');
    assert.equal((await findUnconfirmedGrants(pool, { olderThanMs: 72 * 3600000, now: later, alert })).unconfirmed, 0, 'not old enough');
    await assert.rejects(findUnconfirmedGrants(pool, { olderThanMs: 1, now: later }), /alert/);

    // a revoke before the grant was confirmed supersedes it: no false alert later
    await pool.query("UPDATE legacy_memberships SET reported_status = 'canceled'");
    await syncPersonToGhl({ ...deps, now: later }, b);
    exp = (await pool.query("SELECT action, status FROM ghl_expected_grants WHERE contact_id = 'gt_6' ORDER BY expected_at")).rows;
    assert.deepEqual(exp.map((e) => [e.action, e.status]), [['grant', 'superseded'], ['revoke', 'pending']]);
    assert.equal((await recordGrantConfirmation(pool, { contactId: 'gt_6', type: 'offer', ghlId: 'offer_fx_ahc_silver', granted: false })).matched, true);
    assert.ok(srv.requests.every((x) => x.path.startsWith('/contacts')), 'Gaia only sets tags; it never calls an offer or group API');
  } finally { await srv.close(); await pool.end(); }
});

test('workflow reconciliation: report-only by default; apply mode fixes drift on the fake', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhl({ contacts: [
    { id: 'gr_1', email: 'gr_1@example.invalid', tags: [`${P}tier:standard`, `${P}status:active`, `${P}plan:professional`, 'ahc-gold-active'] },
    { id: 'gr_2', email: 'gr_2@example.invalid' },
  ] });
  try {
    const a = await person(pool, 'gr_1');
    const b = await person(pool, 'gr_2');
    const c = (await resolveOrCreatePerson(pool, { platform: 'email', kind: 'address', externalId: 'gr_3@example.invalid' })).personId;
    await subscribe(pool, a, 'professional', '2026-12-31');
    await syncPersonToGhl({ pool, ghl: client(srv), fieldIds: FIELD_IDS, now: NOW }, b);
    srv.db.get('gr_1').tags.push(`${P}legacy:gold`);           // drift: workflow / human added a Gaia tag Gaia never set
    srv.requests.length = 0;

    const deps = { pool, ghl: client(srv), fieldIds: FIELD_IDS, now: NOW };
    const rep = await reconcileGhlTags(deps, [a, b, c]);
    assert.deepEqual([rep.mode, rep.checked, rep.drifted, rep.inSync, rep.unlinked], ['report', 3, 1, 1, 1]);
    const ra = rep.people.find((p) => p.personId === a);
    assert.ok(ra.missing.includes(`${P}tier:professional`));
    assert.deepEqual(ra.extra, [`${P}legacy:gold`, `${P}tier:standard`]);
    assert.equal(ra.foreignIgnored, 1, 'ahc-gold-active ignored');
    assert.ok(srv.requests.every((r) => r.method === 'GET'), 'report mode writes nothing');

    const applied = await reconcileGhlTags(deps, [a, b], { mode: 'apply' });
    assert.equal(applied.applied, 1);
    assert.equal((await reconcileGhlTags(deps, [a, b])).drifted, 0, 'no drift after apply');
    assert.ok(srv.db.get('gr_1').tags.includes('ahc-gold-active'));
    await assert.rejects(reconcileGhlTags(deps, [a], { mode: 'force' }), /mode/);
  } finally { await srv.close(); await pool.end(); }
});
