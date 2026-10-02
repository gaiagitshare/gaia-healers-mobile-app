import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberOnboardingGuard, protectedMemberPath } from '../member-onboarding-guard.js';
test('session guard memoizes only complete states, refresh is authoritative, failure stays unavailable', async () => {
  let status = 'incomplete', reads = 0;
  const guard = createMemberOnboardingGuard({ key: r => r.session, resolveContact: async () => 'safe', store: { load: async () => { reads++; if (status === 'failure') throw Error(); return { state: status }; } } });
  const req = { session: 'signed-session' };
  assert.equal((await guard.check(req, {})).state, 'incomplete');
  status = 'complete'; assert.equal((await guard.check(req, {})).state, 'complete');
  status = 'failure'; assert.equal((await guard.check(req, {})).state, 'complete'); assert.equal(reads, 2);
  assert.equal((await guard.check(req, {}, true)).state, 'unavailable');
  assert.equal((await guard.check(req, {})).state, 'unavailable');
  assert.equal((await guard.check({ session: 'another-session' }, {})).state, 'unavailable');
});
test('central path classification covers member, academy, energy and unrestricted Assist actions', () => {
  for (const p of ['/api/member/profile', '/api/member/courses', '/api/academy/manifest', '/api/wellness/check', '/api/assist/lookup']) assert.ok(protectedMemberPath(p));
  for (const p of ['/api/auth/logout', '/api/assist/onboarding', '/api/assist/chat', '/api/assist/voice/token']) assert.equal(protectedMemberPath(p), false);
});

// ── a GHL outage must not lock out members GHL already confirmed ─────────────
test('a member GHL confirmed complete is recorded, and let through while GHL is down', async () => {
  const record = new Set();
  const completed = { has: (id) => record.has(id), add: (id) => record.add(id) };
  let ghlUp = true;
  const guard = createMemberOnboardingGuard({
    completed,
    key: (req) => req.k,
    resolveContact: async (m) => { if (!ghlUp) throw new Error('ghl down'); return m.contactId; },
    store: { load: async () => { if (!ghlUp) throw new Error('ghl down'); return { state: 'complete' }; } },
  });
  assert.equal((await guard.check({ k: 'a' }, { contactId: 'c-done' })).state, 'complete');
  assert.ok(record.has('c-done'), 'confirmed completion is recorded');
  ghlUp = false;
  const later = await guard.check({ k: 'new-session' }, { contactId: 'c-done' });
  assert.equal(later.state, 'complete', 'a finished member keeps access during an outage');
  assert.equal(later.source, 'record');
});

test('an outage never lets an unfinished member skip the gate', async () => {
  const guard = createMemberOnboardingGuard({
    completed: { has: () => false, add: () => {} },
    key: (req) => req.k,
    resolveContact: async () => { throw new Error('ghl down'); },
    store: { load: async () => ({ state: 'incomplete' }) },
  });
  const r = await guard.check({ k: 'b' }, { contactId: 'c-new' });
  assert.equal(r.state, 'unavailable');
});
