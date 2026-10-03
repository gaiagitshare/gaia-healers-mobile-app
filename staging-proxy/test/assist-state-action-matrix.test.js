/**
 * STATE × ACTION MATRIX — offered to the model vs allowed by the server.
 *
 * Phase 1 scoped which actions each session is OFFERED. Permission is a
 * separate, older decision (allowed(), enforced in runTool). The two must
 * stay separate concepts and must never contradict each other in a way that
 * hurts a member: nothing offered may be refused for that same state, and
 * nothing a state needs may be withheld. This is the whole matrix, in one
 * place, so a future change to either side shows up here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, allowed, offered, toolDeclarationsFor, clientToolNames, runTool } from '../assist-tools.js';

const STATES = {
  visitor:              null,
  'member (finished)':  { contactId: 'm', isPractitioner: false, state: 'member' },
  'member (profile not done)': { contactId: 'm2', isPractitioner: false, state: 'member', surveyActive: true },
  onboarding:           { contactId: 'o', isPractitioner: false, state: 'onboarding' },
  practitioner:         { contactId: 'p', isPractitioner: true,  state: 'practitioner' },
  'unknown (GHL down)': { contactId: 'u', isPractitioner: false, state: 'unavailable' },
  'no state at all':    { contactId: 'n', isPractitioner: false },
};
const names = (ctx) => toolDeclarationsFor(ctx).map((d) => d.name).sort();
const MEMBER_ACTIONS = ['navigate', 'gaia_lookup', 'play_course', 'express_interest', 'register_event', 'find_practitioner', 'book_session', 'open_community', 'open_portal'].sort();
const PRACTITIONER_TOOLS = TOOLS.filter((t) => t.role === 'practitioner').map((t) => t.name).sort();

// The matrix. Every row is the complete, exact set.
const EXPECTED = {
  visitor:                      [...MEMBER_ACTIONS, 'sign_in'],
  'member (finished)':          [...MEMBER_ACTIONS, 'remember_member'],
  'member (profile not done)':  [...MEMBER_ACTIONS, 'remember_member', 'save_onboarding_step'],
  onboarding:                   [...MEMBER_ACTIONS, 'remember_member', 'save_onboarding_step'],
  practitioner:                 [...MEMBER_ACTIONS, 'remember_member', ...PRACTITIONER_TOOLS],
  'unknown (GHL down)':         [...MEMBER_ACTIONS, 'remember_member', 'save_onboarding_step', 'sign_in'],
  'no state at all':            [...MEMBER_ACTIONS, 'remember_member', 'save_onboarding_step', 'sign_in'],
};

for (const [state, ctx] of Object.entries(STATES)) {
  test(`matrix: ${state} is offered exactly its set`, () => {
    assert.deepEqual(names(ctx), [...EXPECTED[state]].sort());
  });
  test(`matrix: ${state} -- everything offered is allowed, so the server cannot refuse an action it suggested`, () => {
    for (const t of TOOLS) if (offered(t, ctx)) assert.ok(allowed(t, ctx), `${t.name} offered to ${state} but not allowed`);
  });
  test(`matrix: ${state} -- the page is told to run exactly the client-side actions that were offered`, () => {
    const client = TOOLS.filter((t) => offered(t, ctx) && t.where === 'client').map((t) => t.name).sort();
    assert.deepEqual(clientToolNames(ctx).sort(), client);
  });
}

// ── the security side, which must not have moved ──────────────────────────

test('a visitor is never offered, and never allowed, a practitioner tool or member memory', () => {
  for (const t of TOOLS.filter((x) => x.role === 'practitioner')) {
    assert.equal(offered(t, null), false);
    assert.equal(allowed(t, null), false);
  }
  assert.equal(offered(TOOLS.find((t) => t.name === 'remember_member'), null), false);
});

test('a member who is not a practitioner is never allowed a practitioner tool, offered or not', async () => {
  const ctx = { contactId: 'm', isPractitioner: false, state: 'member' };
  for (const t of TOOLS.filter((x) => x.role === 'practitioner')) {
    assert.equal(allowed(t, ctx), false, t.name);
    await assert.rejects(() => runTool(t.name, { clientId: '1' }, ctx), (e) => e.code === 'forbidden');
  }
});

test('a practitioner loses nothing a member has', () => {
  const member = names({ contactId: 'm', isPractitioner: false, state: 'member' });
  const prac = names({ contactId: 'p', isPractitioner: true, state: 'practitioner' });
  for (const n of member) assert.ok(prac.includes(n), `${n} missing for a practitioner`);
});

test('onboarding can always save a step', () => {
  for (const ctx of [STATES.onboarding, STATES['member (profile not done)']]) {
    assert.ok(names(ctx).includes('save_onboarding_step'));
  }
});

test('an unknown state is treated as the LEAST privileged for permission and the MOST generous for offering', () => {
  // GHL down must not promote anyone (isPractitioner stays false) and must
  // not cost anyone an action they may need (every member action is offered).
  const ctx = STATES['unknown (GHL down)'];
  for (const t of TOOLS.filter((x) => x.role === 'practitioner')) assert.equal(allowed(t, ctx), false);
  for (const n of [...MEMBER_ACTIONS, 'remember_member', 'save_onboarding_step', 'sign_in']) assert.ok(names(ctx).includes(n), n);
});

test('offering is decided only from the server-built context, never from the model or the page', () => {
  // offered() reads ctx.state / ctx.surveyActive / ctx.isPractitioner, which
  // assistLiveToken sets from the session; a tool's own declaration cannot
  // widen it.
  const widened = { contactId: 'x', isPractitioner: false, state: 'member', isAdmin: true, role: 'practitioner', scopes: ['*'] };
  for (const t of TOOLS.filter((x) => x.role === 'practitioner')) assert.equal(offered(t, widened), false);
});
