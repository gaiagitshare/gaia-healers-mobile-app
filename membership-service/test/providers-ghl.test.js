import './_providers-deny-network.mjs';
/**
 * GHL mirror: pure desired state, then sync against a LOOPBACK fake GHL.
 * GHL is CRM only (spec §16): these tests also prove the adapter cannot touch
 * billing and never writes outside the Gaia tag prefix / field allowlist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, actor } from './_db.js';
import { fakeGhl, fetchVia, noSleep } from './_providers-fakes.js';
import { desiredGhlState, diffGhlState, FIELD_SPECS, DEFAULT_TAG_PREFIX } from '../src/providers/ghl/desired-state.js';
import { createGhlClient, guardGhlPath } from '../src/providers/ghl/client.js';
import { syncPersonToGhl, syncPeopleToGhl, pgDeadLetterStore, memoryDeadLetterStore } from '../src/providers/ghl/sync.js';
import { computeEntitlements } from '../src/entitlements.js';
import { seedCatalog, currentVersion } from '../src/plans.js';
import { resolveOrCreatePerson, linkIdentity, identitiesOf } from '../src/identity.js';
import { createSubscription, scheduleCancel } from '../src/subscriptions.js';
import { TIERS } from '../src/catalog.js';

const P = DEFAULT_TAG_PREFIX;
const NOW = new Date('2026-12-01T00:00:00Z');
const tier = (k) => TIERS.find((t) => t.key === k);
const sub = (planKey, status = 'active', extra = {}) => ({ id: 's-' + planKey, plan_key: planKey, status, entitlements: tier(planKey).entitlements, current_period_end: '2026-12-31T00:00:00Z', ...extra });
const FIELD_IDS = Object.fromEntries(Object.keys(FIELD_SPECS).map((k, i) => [k, 'cf_' + i]));
const ghlClient = (srv, extra = {}) => createGhlClient({ token: 'ghl-fixture-token', locationId: 'loc_fixture', fetch: fetchVia, baseUrl: srv.url, sleep: noSleep, ...extra });

// ---- pure ----------------------------------------------------------------------

test('desired state: highest tier wins, each benefit once, deterministic order', () => {
  const ev = computeEntitlements({ subscriptions: [sub('standard'), sub('inner_circle')] }, NOW);
  const d = desiredGhlState(ev);
  assert.ok(d.tags.includes(`${P}tier:inner_circle`));
  assert.ok(d.tags.includes(`${P}status:active`));
  assert.ok(d.tags.includes(`${P}plan:standard`) && d.tags.includes(`${P}plan:inner_circle`));
  assert.ok(d.tags.includes(`${P}benefit:community.inner_circle_channel`));
  assert.ok(d.tags.includes(`${P}benefit:crm.ghl_subaccount`));
  assert.ok(!d.tags.some((t) => t.includes('software.') || t.includes('discount.')), 'modules and discounts are not marketing tags');
  assert.equal(new Set(d.tags).size, d.tags.length);
  assert.deepEqual(d.tags, [...d.tags].sort());
  assert.deepEqual(d.fields, { gaia_membership_tier: 'inner_circle', gaia_membership_status: 'active', gaia_membership_access_until: '2026-12-31',
    gaia_membership_plans: 'inner_circle,standard', gaia_membership_cancel_scheduled: 'no' });
});

test('desired state: no paid access -> tier none; past grace or incomplete grants nothing', () => {
  const none = desiredGhlState(computeEntitlements({ subscriptions: [sub('standard', 'incomplete'), sub('professional', 'past_due', { grace_until: '2026-11-01T00:00:00Z' })] }, NOW));
  assert.deepEqual(none.tags, [`${P}status:none`, `${P}tier:none`]);
  assert.equal(none.fields.gaia_membership_tier, 'none');
  const grace = desiredGhlState(computeEntitlements({ subscriptions: [sub('professional', 'past_due', { grace_until: '2026-12-05T00:00:00Z' })] }, NOW), { cancelScheduled: true });
  assert.ok(grace.tags.includes(`${P}status:past_due`) && grace.tags.includes(`${P}cancel-scheduled`));
  assert.equal(grace.fields.gaia_membership_access_until, '2026-12-05');
});

test('no wellness data can reach GHL: extra input is ignored and fields are allowlisted', () => {
  const ev = computeEntitlements({ subscriptions: [sub('standard')] }, NOW);
  const poisoned = { ...ev, scan: { chakras: 'imbalanced', aura: 42 }, survey: { symptoms: ['insomnia'] }, profile: { conditions: ['x'] } };
  assert.deepEqual(desiredGhlState(poisoned), desiredGhlState(ev));
  const out = JSON.stringify(desiredGhlState(poisoned));
  for (const w of ['chakras', 'aura', 'insomnia', 'symptom', 'condition']) assert.ok(!out.includes(w), w);
  assert.throws(() => diffGhlState({}, { tags: [], fields: { health_notes: 'x' } }, {}), /allowlist/);
  assert.throws(() => desiredGhlState(ev, { prefix: 'Gaia ' }), /prefix/);
});

test('diff only touches tags under the Gaia prefix; foreign tags and fields are never removed', () => {
  const desired = desiredGhlState(computeEntitlements({ subscriptions: [sub('standard')] }, NOW));
  const contact = { tags: ['silver', 'gaiapractitioner', `${P}tier:professional`, `${P}status:active`, 'GAIA-M:PLAN:STANDARD'],
    customFields: [{ id: FIELD_IDS.gaia_membership_status, value: 'active' }, { id: 'cf_foreign', value: 'keep me' }] };
  const d = diffGhlState(contact, desired, { fieldIds: FIELD_IDS });
  assert.deepEqual(d.removeTags, [`${P}tier:professional`]);
  assert.ok(d.addTags.includes(`${P}tier:standard`) && !d.addTags.includes(`${P}plan:standard`), 'tag comparison is case-insensitive like GHL');
  assert.ok(!d.removeTags.includes('silver') && !d.removeTags.includes('gaiapractitioner'));
  assert.ok(!d.fieldUpdates.some((f) => f.key === 'gaia_membership_status'), 'unchanged field not rewritten');
  assert.ok(!d.fieldUpdates.some((f) => f.id === 'cf_foreign'));
  assert.deepEqual(diffGhlState(contact, desired, { fieldIds: {} }).unmappedFields.sort(), Object.keys(FIELD_SPECS).sort(), 'unmapped fields are reported, never created');
});

test('the GHL client is structurally read-only towards billing', async () => {
  for (const [m, p] of [['GET', '/payments/subscriptions'], ['POST', '/payments/orders'], ['DELETE', '/contacts/abc'], ['POST', '/contacts/'], ['GET', '/products/'], ['PUT', '/payments/subscriptions/x'], ['POST', '/contacts/abc/workflow/x']]) {
    assert.throws(() => guardGhlPath(m, p), (e) => e.code === 'FORBIDDEN', `${m} ${p}`);
  }
  const srv = await fakeGhl();
  try {
    const c = ghlClient(srv);
    assert.deepEqual(Object.keys(c).sort(), ['addTags', 'findContactsByEmail', 'getContact', 'removeTags', 'updateCustomFields']);
    await assert.rejects(c.getContact('../payments/orders'), (e) => e.code === 'INVALID_INPUT');
    assert.equal(srv.requests.length, 0);
  } finally { await srv.close(); }
});

test('email search keeps EXACT matches only (main or additional email), never fuzzy hits', async () => {
  const srv = await fakeGhl({ contacts: [
    { id: 'c1', email: 'ana@example.invalid' }, { id: 'c2', email: 'ana@example.invalid.other' },
    { id: 'c3', email: 'old@example.invalid', additionalEmails: [{ email: 'ANA@example.invalid' }] }, { id: 'c4', email: 'anabel@example.invalid' }] });
  try {
    const found = await ghlClient(srv).findContactsByEmail('Ana@Example.invalid');
    assert.deepEqual(found.map((c) => c.id).sort(), ['c1', 'c3']);
    assert.equal(srv.requests[0].json.locationId, 'loc_fixture');
    assert.equal(srv.requests[0].headers.version, '2021-07-28');
  } finally { await srv.close(); }
});

// ---- sync + database ------------------------------------------------------------

async function member(pool, email, planKey) {
  await seedCatalog(pool);
  const pid = (await resolveOrCreatePerson(pool, { platform: 'email', kind: 'address', externalId: email })).personId;
  let sid = null;
  if (planKey) sid = await createSubscription(pool, { personId: pid, planVersionId: (await currentVersion(pool, planKey)).id, interval: 'month', status: 'active', periodStart: new Date('2026-11-01'), periodEnd: new Date('2026-12-31') }, actor);
  return { pid, sid };
}

test('sync: finds the contact by email, links it, writes prefixed tags + allowlisted fields, keeps foreign tags', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhl({ contacts: [{ id: 'gc_1', email: 'pro@example.invalid', tags: ['silver', `${P}tier:standard`], customFields: [{ id: 'cf_other', value: 'x' }] }] });
  try {
    const { pid, sid } = await member(pool, 'pro@example.invalid', 'professional');
    const deps = { pool, ghl: ghlClient(srv), fieldIds: FIELD_IDS, now: NOW };
    const r = await syncPersonToGhl(deps, pid);
    assert.equal(r.status, 'synced');
    const c = srv.db.get('gc_1');
    assert.ok(c.tags.includes('silver'), 'legacy tag untouched');
    assert.ok(c.tags.includes(`${P}tier:professional`) && !c.tags.includes(`${P}tier:standard`));
    assert.equal(c.customFields.find((f) => f.id === FIELD_IDS.gaia_membership_tier).value, 'professional');
    assert.equal(c.customFields.find((f) => f.id === 'cf_other').value, 'x');
    assert.ok((await identitiesOf(pool, pid)).some((i) => i.platform === 'ghl' && i.external_id === 'gc_1'));

    srv.requests.length = 0;
    const again = await syncPersonToGhl(deps, pid);
    assert.deepEqual([again.addTags, again.removeTags, again.fieldUpdates], [[], [], []], 'idempotent');
    assert.deepEqual(srv.requests.map((x) => x.method + ' ' + x.path), ['GET /contacts/gc_1'], 'a linked contact is read by id, nothing written');

    await scheduleCancel(pool, sid, { accessEndsAt: new Date('2026-12-31') }, actor);
    const canceling = await syncPersonToGhl(deps, pid);
    assert.deepEqual(canceling.addTags, [`${P}cancel-scheduled`]);
    assert.ok(srv.requests.every((x) => x.path.startsWith('/contacts')), 'never a billing route');
  } finally { await srv.close(); await pool.end(); }
});

test('sync: several contacts for one email are reported as a dead letter, never merged or guessed', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhl({ contacts: [{ id: 'gd_1', email: 'dup@example.invalid' }, { id: 'gd_2', email: 'x@example.invalid', additionalEmails: ['dup@example.invalid'] }] });
  try {
    const { pid } = await member(pool, 'dup@example.invalid', 'standard');
    const deps = { pool, ghl: ghlClient(srv), fieldIds: FIELD_IDS, now: NOW };
    const r = await syncPersonToGhl(deps, pid);
    assert.equal(r.status, 'dead_letter');
    assert.equal(r.reason, 'duplicate_contacts');
    assert.ok(srv.requests.every((x) => x.method === 'GET' || x.path === '/contacts/search'), 'nothing written to either contact');
    assert.equal((await identitiesOf(pool, pid)).filter((i) => i.platform === 'ghl').length, 0, 'not linked to either');
    await syncPersonToGhl(deps, pid);
    const open = await pgDeadLetterStore(pool).listOpen();
    assert.equal(open.length, 1, 'a repeat bumps the same open row');
    assert.equal(open[0].attempts, 2);
    assert.deepEqual(open[0].details.contactIds, ['gd_1', 'gd_2']);
  } finally { await srv.close(); await pool.end(); }
});

test('sync: GHL down -> bounded retries -> dead letter; a later success resolves it', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhl({ contacts: [{ id: 'ge_1', email: 'down@example.invalid' }] });
  try {
    const { pid } = await member(pool, 'down@example.invalid', 'standard');
    await linkIdentity(pool, pid, { platform: 'ghl', kind: 'contact', externalId: 'ge_1' }, { linkedBy: 'test' });
    const deps = { pool, ghl: ghlClient(srv, { retry: { maxRetries: 2 } }), fieldIds: FIELD_IDS, now: NOW };
    for (let i = 0; i < 3; i++) srv.faults.push({ status: 502, json: {} });
    const r = await syncPersonToGhl(deps, pid);
    assert.equal(r.status, 'dead_letter');
    assert.equal(r.reason, 'provider_unavailable');
    assert.equal(srv.requests.length, 3, 'exactly 1 + maxRetries attempts, no loop');
    const store = pgDeadLetterStore(pool);
    assert.equal((await store.listOpen())[0].error_code, 'PROVIDER_UNAVAILABLE');
    assert.equal((await syncPersonToGhl(deps, pid)).status, 'synced');
    assert.equal((await store.listOpen()).length, 0);
    assert.equal((await pool.query("SELECT resolved_by FROM ghl_sync_dead_letters")).rows[0].resolved_by, 'ghl-sync');
  } finally { await srv.close(); await pool.end(); }
});

test('sync: deleted contact, identity conflict, no contact, and the batch cap', { skip: SKIP }, async () => {
  const pool = await freshPool();
  const srv = await fakeGhl({ contacts: [{ id: 'gf_shared', email: 'b@example.invalid' }] });
  try {
    const dl = memoryDeadLetterStore();
    const deps = { pool, ghl: ghlClient(srv), deadLetters: dl, fieldIds: FIELD_IDS, now: NOW };
    const a = await member(pool, 'a@example.invalid', 'standard');
    await linkIdentity(pool, a.pid, { platform: 'ghl', kind: 'contact', externalId: 'gf_gone' }, { linkedBy: 'test' });
    assert.equal((await syncPersonToGhl(deps, a.pid)).reason, 'contact_missing');

    const owner = (await resolveOrCreatePerson(pool, { platform: 'ghl', kind: 'contact', externalId: 'gf_shared' })).personId;
    assert.ok(owner);
    const b = await member(pool, 'b@example.invalid', 'standard');
    assert.equal((await syncPersonToGhl(deps, b.pid)).reason, 'identity_conflict', 'a contact owned by another person is never re-keyed');
    assert.deepEqual(srv.db.get('gf_shared').tags, [], 'and nothing is written to it');

    const c = await member(pool, 'nobody@example.invalid', 'standard');
    assert.equal((await syncPersonToGhl(deps, c.pid)).status, 'no_contact', 'contacts are never created by the mirror');
    assert.deepEqual(dl.rows.map((r) => r.reason).sort(), ['contact_missing', 'identity_conflict']);

    const s = await syncPeopleToGhl(deps, [a.pid, c.pid]);
    assert.deepEqual([s.dead_letter, s.no_contact], [1, 1]);
    await assert.rejects(syncPeopleToGhl(deps, Array(201).fill(c.pid)), /exceeds the cap/, 'over the cap is refused, not trimmed');
  } finally { await srv.close(); await pool.end(); }
});
