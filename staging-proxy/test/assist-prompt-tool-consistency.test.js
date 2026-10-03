/**
 * THE PROMPT NEVER ASKS FOR AN ACTION THAT WAS NOT OFFERED.
 *
 * Scoping actions by session state (so a visitor is not handed member-only
 * tools) opened one way to go wrong: the prompt is built from the member
 * context and the tool list from the state, and the two could disagree. It
 * nearly did. A member whose profile still reads "ONBOARDING PROFILE: NOT DONE"
 * gets the survey script -- "call save_onboarding_step" -- while their state is
 * plain 'member', which would no longer have been offered that step. Caught in
 * review; pinned here for every session shape.
 *
 * Offline: the server module is loaded with every outbound call refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-prompt-tools-')));
const S = 'prompt-tool-consistency-'.padEnd(48, 'c');
Object.assign(process.env, {
  PORT: '0', HOST: '127.0.0.1', GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9', GAIA_DISABLE_ALERT_TIMER: '1', STORE_SYNC_ENABLED: 'false',
  AUTH_SESSION_SECRET: S, COURSES_SYNC_SECRET: S, GHL_BACKFILL_SECRET: S, GHL_WORKFLOW_WEBHOOK_SECRET: S,
  GAIA_USAGE_LOG: '',
});
globalThis.fetch = async (u) => {
  if (!/^(127\.|localhost$)/.test(new URL(String(u)).hostname)) throw new Error('offline test refused ' + u);
  return new Response('{}');
};
const srv = await import(new URL('../server.js', import.meta.url).href);
const { toolDeclarationsFor, TOOLS } = await import('../assist-tools.js');
test.after(() => srv.closeServer?.());
const guide = globalThis.GaiaAssistGuide;

// The same derivation assistLiveToken uses.
function toolsFor(accountContext, { practitioner = false } = {}) {
  const signedIn = Boolean(accountContext);
  const ctx = signedIn ? { contactId: 'c', isPractitioner: practitioner } : null;
  if (ctx) {
    ctx.state = guide.sessionState(accountContext);
    ctx.surveyActive = /ONBOARDING PROFILE:\s*NOT DONE/.test(accountContext);
  }
  return toolDeclarationsFor(ctx).map((d) => d.name);
}

const SHAPES = {
  visitor: [''],
  'completed member': ['GAIA SESSION STATE: member\nMEMBER CONTEXT (private)\nONBOARDING PROFILE: DONE — do NOT run the onboarding survey again.'],
  'member whose profile is unfinished': ['GAIA SESSION STATE: member\nMEMBER CONTEXT (private)\nONBOARDING PROFILE: NOT DONE — resume at goals.'],
  'onboarding (gated)': ['GAIA SESSION STATE: onboarding\nONBOARDING PROFILE: NOT DONE. onboarding_required=true.'],
  practitioner: ['GAIA SESSION STATE: practitioner\nMEMBER CONTEXT (private)\nONBOARDING PROFILE: DONE', { practitioner: true }],
  'state unavailable': ['GAIA SESSION STATE: unavailable'],
};

// Tool names the prompt tells the model to call. "sign_in only when they are
// signed out" is conditional on being signed out, which a signed-in session
// never is, so it is not an instruction to call it.
const INSTRUCTED = (prompt) => TOOLS.map((t) => t.name)
  .filter((n) => n !== 'sign_in' && new RegExp(`\\b${n}\\b`).test(prompt));

for (const [label, [ctx, opts]] of Object.entries(SHAPES)) {
  test(`${label}: every action the prompt asks for is offered`, () => {
    const prompt = srv.buildGaiaLiveInstructions({ view: 'today', memberContext: ctx, appContext: { screen: 'today' } });
    const offered = toolsFor(ctx, opts);
    const missing = INSTRUCTED(prompt).filter((n) => !offered.includes(n));
    assert.deepEqual(missing, [], `the prompt names ${missing.join(', ')} but it was not offered`);
  });
}

test('a member with an unfinished profile is offered the onboarding step', () => {
  assert.ok(toolsFor(SHAPES['member whose profile is unfinished'][0]).includes('save_onboarding_step'));
});

test('a completed member is not', () => {
  assert.ok(!toolsFor(SHAPES['completed member'][0]).includes('save_onboarding_step'));
});

test('the voice token computes surveyActive the same way the prompt does', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /toolCtx\.surveyActive = needsOnboardingSurvey\(accountContext\);/);
  assert.match(src, /const survey = needsOnboardingSurvey\(memberContext\);/);
});
