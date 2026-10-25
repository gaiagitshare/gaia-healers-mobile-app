/**
 * Access follows the person when GHL merges two contacts.
 *
 * 22 Oct 2026: a practitioner's two GHL contacts were merged; 15 of her 16
 * courses stayed on the id GHL deleted and she signed in to one course. The
 * scan finds such contacts (old id gone + exactly one live contact carrying
 * its email), an operator moves the access in one tap, and the move is
 * audited, idempotent and never a guess.
 *
 * Offline: fake GHL, in-memory ledgers, temp files. No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  scanForMerges, applyContactMerge, pendingSuggestions, emptyMergeState, dueForCheck,
  loadMergeState, saveMergeState, markSuggestion,
} from '../membership/contact-merges.js';
import { migrateContactRecord } from '../membership/ledger.js';
import { alertExtras } from '../admin-router.js';
import { detect as detectAlerts } from '../alerts.js';

const course = (name, extra = {}) => ({ id: name.toLowerCase(), name, state: 'unlocked', updatedAt: '2026-08-19T06:00:00.000Z', ...extra });
const ent = (name) => ({ type: 'course_access', key: name.toLowerCase(), value: { name }, status: 'active', source: 'ghl_offer', evidence_id: name.toLowerCase(), starts_at: '2026-08-19T06:00:00.000Z', expires_at: null, observed_at: '2026-08-19T06:00:00.000Z' });

function ledger() {
  return {
    contacts: {
      OLD: { contactId: 'OLD', courses: [course('Bio-Well Basic'), course('Chakra 9 Week'), course('Sales')],
        communities: [], entitlements: [ent('Bio-Well Basic'), ent('Chakra 9 Week'), ent('Sales')],
        order: { 'course:bio well basic': { at: '2026-08-19T06:00:00.000Z', action: 'grant' }, membership: { at: 'x' } } },
      NEW: { contactId: 'NEW', courses: [course('Sales')], communities: [], entitlements: [ent('Sales')] },
      LIVE: { contactId: 'LIVE', courses: [course('Bio-Well Basic')], communities: [], entitlements: [ent('Bio-Well Basic')] },
      TWIN: { contactId: 'TWIN', courses: [course('Sales')], communities: [], entitlements: [ent('Sales')] },
      FLAKY: { contactId: 'FLAKY', courses: [course('Sales')], communities: [], entitlements: [ent('Sales')] },
      NOMAIL: { contactId: 'NOMAIL', courses: [course('Sales')], communities: [], entitlements: [ent('Sales')] },
    },
    auditLog: [],
  };
}
const emails = new Map([['OLD', 'pati@example.invalid'], ['NEW', 'pati@example.invalid'], ['LIVE', 'live@example.invalid'],
  ['TWIN', 'twin@example.invalid'], ['FLAKY', 'flaky@example.invalid']]);
const ghl = {
  calls: 0,
  async getContact(id) {
    this.calls++;
    if (id === 'OLD' || id === 'TWIN') return { status: 400, contact: null };
    if (id === 'FLAKY') return { status: 503, contact: null };
    return { status: 200, contact: { id } };
  },
  async findByEmail(email) {
    if (email === 'pati@example.invalid') return [{ id: 'NEW', firstName: 'Pati', lastName: 'Example', email }];
    if (email === 'twin@example.invalid') return [{ id: 'T1', email }, { id: 'T2', email }];
    return [];
  },
};

test('scan: a deleted contact whose email is on exactly one live contact is a merge; nothing else is', async () => {
  const store = ledger();
  const state = emptyMergeState();
  const stats = await scanForMerges(store, emails, state, ghl, { pauseMs: 0 });
  assert.equal(stats.merged, 1);
  assert.equal(stats.gone_no_survivor, 1, 'two live contacts share the email: no guess');
  assert.equal(stats.errors, 1, 'a 503 is an outage, not evidence');
  const pend = pendingSuggestions(state, store);
  assert.deepEqual(pend.map((s) => [s.old, s.survivor]), [['OLD', 'NEW']]);
  assert.equal(pend[0].courses.length, 3);
  assert.equal(pend[0].alreadyOnSurvivor, 1, 'Sales is already on the survivor');
  assert.equal(state.checked.FLAKY, undefined, 'an outage leaves the contact due for the next run');
  assert.ok(!('NOMAIL' in state.checked), 'no email on file: never checked, never guessed');
});

test('scan: a checked contact is not asked again for a week, and runs are capped', async () => {
  const store = ledger();
  const state = emptyMergeState();
  const now = new Date('2026-10-25T12:00:00Z');
  await scanForMerges(store, emails, state, ghl, { pauseMs: 0, now, maxChecks: 2 });
  assert.equal(Object.keys(state.checked).length <= 2, true, 'capped at maxChecks');
  await scanForMerges(store, emails, state, ghl, { pauseMs: 0, now });
  const due = dueForCheck(store, emails, state, { now: new Date('2026-10-26T12:00:00Z') });
  assert.deepEqual(due, ['FLAKY'], 'only the contact the outage left unanswered is still due');
  const later = dueForCheck(store, emails, state, { now: new Date('2026-11-02T13:00:00Z') });
  assert.ok(later.includes('LIVE'), 'rechecked after seven days');
});

test('apply: courses and their entitlements move to the survivor; the old rows are revoked with a pointer', () => {
  const store = ledger();
  const r = applyContactMerge(store, 'OLD', 'NEW', { now: new Date('2026-10-25T12:00:00Z'), note: 'test' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.moved.courses.sort(), ['Bio-Well Basic', 'Chakra 9 Week']);
  const neu = migrateContactRecord(store.contacts.NEW).record;
  const active = neu.entitlements.filter((e) => e.type === 'course_access' && e.status === 'active').map((e) => e.key).sort();
  assert.deepEqual(active, ['bio-well basic', 'chakra 9 week', 'sales']);
  assert.equal(store.contacts.NEW.courses.filter((c) => c.id === 'sales').length, 1, 'no duplicate of a course already held');
  const old = migrateContactRecord(store.contacts.OLD).record;
  assert.equal(old.entitlements.filter((e) => e.status === 'active').length, 0, 'nothing stays active on the deleted id');
  assert.ok(old.entitlements.every((e) => e.status === 'revoked'), 'kept, revoked, never deleted');
  assert.equal(store.contacts.OLD.mergedInto, 'NEW');
  assert.ok(store.contacts.NEW.order['course:bio well basic'], 'ordering stamps travel with the grant');
  assert.ok(!store.contacts.NEW.order.membership, 'membership ordering is the sweep\'s, not moved');
  assert.deepEqual(store.auditLog.map((a) => [a.action, a.contactId]), [['contact.merge_out', 'OLD'], ['contact.merge_in', 'NEW']]);
});

test('apply: running it twice moves nothing twice; a different survivor is refused', () => {
  const store = ledger();
  applyContactMerge(store, 'OLD', 'NEW');
  const before = JSON.stringify(store.contacts.NEW.courses);
  const again = applyContactMerge(store, 'OLD', 'NEW');
  assert.equal(again.ok, true);
  assert.equal(again.moved.courses.length, 0);
  assert.equal(JSON.stringify(store.contacts.NEW.courses), before);
  assert.equal(store.auditLog.length, 2, 'no second audit pair');
  assert.equal(applyContactMerge(store, 'OLD', 'LIVE').ok, false);
});

test('state file round-trips; a dismissed suggestion leaves the list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merges-'));
  const file = path.join(dir, 'contact-merges.json');
  const state = emptyMergeState();
  state.suggestions.push({ old: 'OLD', survivor: 'NEW', courses: ['x'], communities: [], state: 'pending', detectedAt: '2026-10-25' });
  saveMergeState(file, state);
  const back = loadMergeState(file);
  assert.equal(back.suggestions.length, 1);
  assert.ok(markSuggestion(back, 'OLD', 'dismissed', { note: 'different people' }));
  assert.equal(pendingSuggestions(back, ledger()).length, 0);
});

test('alert: pending merges raise one warning naming the course count; none when clear', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merges-'));
  const file = path.join(dir, 'contact-merges.json');
  const state = emptyMergeState();
  state.suggestions.push({ old: 'OLD', survivor: 'NEW', courses: ['a', 'b', 'c'], communities: [], state: 'pending', detectedAt: '2026-10-25' });
  saveMergeState(file, state);
  const extra = await alertExtras({ contactMergesFile: file, loadLedger: () => ({ contacts: {} }), ghlGet: async () => null, ghlConfig: () => ({ enabled: false }) });
  assert.deepEqual(extra.contactMerges, { pending: 1, courses: 3, oldest: '2026-10-25' });
  const hits = detectAlerts({ jobs: [] }, extra).filter((a) => a.key === 'membership:merged-contact');
  assert.equal(hits.length, 1);
  assert.match(hits[0].title, /1 merged contact still holding access \(3 courses\)/);
  markSuggestion(state, 'OLD', 'applied'); saveMergeState(file, state);
  const extra2 = await alertExtras({ contactMergesFile: file, loadLedger: () => ({ contacts: {} }), ghlGet: async () => null, ghlConfig: () => ({ enabled: false }) });
  assert.equal(detectAlerts({ jobs: [] }, extra2).filter((a) => a.key === 'membership:merged-contact').length, 0);
});
