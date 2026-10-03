/**
 * WHAT GAIA ASSIST IS FOR — the prompt contract, so no token saving can
 * quietly turn it into a terse generic chatbot.
 *
 * Every behaviour below is a sentence that has to be IN the instructions a
 * model receives, for every role it applies to, in both channels. A Phase B
 * rewrite is free to say these things more compactly; it is not free to stop
 * saying them. The assertions are on meaning-carrying phrases, not exact
 * wording, so a careful consolidation passes and a deletion fails.
 *
 * Offline: the server module is loaded with the network sealed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-contract-')));
const S = 'behaviour-contract-secret-'.padEnd(48, 'b');
Object.assign(process.env, {
  PORT: '0', HOST: '127.0.0.1', GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9', GAIA_DISABLE_ALERT_TIMER: '1', STORE_SYNC_ENABLED: 'false',
  AUTH_SESSION_SECRET: S, COURSES_SYNC_SECRET: S, GHL_BACKFILL_SECRET: S, GHL_WORKFLOW_WEBHOOK_SECRET: S, GAIA_USAGE_LOG: '',
});
globalThis.fetch = async (u) => { if (!/^(127\.|localhost$)/.test(new URL(String(u)).hostname)) throw new Error('offline'); return new Response('{}'); };
const srv = await import(new URL('../server.js', import.meta.url).href);
test.after(() => srv.closeServer?.());

const CTX = {
  visitor: '',
  member: 'GAIA SESSION STATE: member\nMEMBER CONTEXT (private)\nStatus: Gold member.\nONBOARDING PROFILE: DONE',
  onboarding: 'GAIA SESSION STATE: onboarding\nONBOARDING PROFILE: NOT DONE. Resume at primary_interests.',
  practitioner: 'GAIA SESSION STATE: practitioner\nMEMBER CONTEXT (private)\nStatus: certified practitioner.\nONBOARDING PROFILE: DONE',
};
const prompts = (role) => ({
  voice: srv.buildGaiaLiveInstructions({ view: 'today', memberContext: CTX[role], appContext: { screen: 'today' } }),
  text: srv.assistSystemPrompt(CTX[role]),
});

// Each entry: a behaviour, the roles it applies to, and the phrases that
// evidence it (any ONE of the alternatives per line must appear).
const CONTRACT = [
  ['identifies the task and answers it, as a concierge, not a chatbot', ['visitor', 'member', 'onboarding', 'practitioner'],
    [/concierge/i, /identify the task|answer directly/i]],
  ['guides people around the platform by naming screens', ['visitor', 'member', 'onboarding', 'practitioner'],
    [/CURRENT APP:/, /academy = Academy/, /profile = You/, /store = Shop/]],
  ['encourages the right people to complete the Gaia assessment, without forcing it', ['visitor', 'member'],
    [/DISCOVERY:/, /Gaia Path|questionnaire|profile discovery/i]],
  ['explains membership value before options, and never invents a plan', ['visitor', 'member', 'practitioner'],
    [/CONVERSION:/, /membership/i]],
  ['helps members use what they already have', ['member'],
    [/COMPLETED MEMBER/, /verified access/i]],
  ['gives practitioners practice-oriented guidance without treating status as clinical credentials', ['practitioner'],
    [/VERIFIED PRACTITIONER/, /practice-oriented/i, /not admin access or evidence of clinical credentials/i]],
  ['handles support like a service agent: concrete problem, verified facts', ['visitor', 'member', 'onboarding', 'practitioner'],
    [/SUPPORT:/, /concrete problem/i]],
  ['keeps the safety boundary: crisis first, emergencies to 911/local, no diagnosis', ['visitor', 'member', 'onboarding', 'practitioner'],
    [/SAFETY FIRST/, /988/, /911/, /Never diagnose/i, /not medical devices|not a medical device/i]],
  ['never fabricates live prices or platform facts', ['visitor', 'member', 'onboarding', 'practitioner'],
    [/never a remembered price|only from live data|use only what it returns|use ONLY these/i]],
  ['keeps the onboarding gate: no selling or navigating away until the profile is done', ['onboarding'],
    [/ONBOARDING REQUIRED/, /do not sell|do not navigate/i]],
  ['treats a practitioner\'s own clients as theirs to ask about, with facts from tools', ['practitioner'],
    [/THEIR OWN CLIENTS ARE THEIRS TO ASK ABOUT/, /CLIENT FACTS COME FROM A TOOL/]],
  ['does not claim an action a tool did not do', ['visitor', 'member', 'onboarding', 'practitioner'],
    [/Never claim you booked|do not just describe it|never claim/i]],
  ['uses memory only for a verified member, never a visitor', ['member', 'practitioner'],
    [/MEMORY \(only for a verified member/]],
];

for (const [behaviour, roles, phrases] of CONTRACT) {
  for (const role of roles) {
    for (const channel of ['voice', 'text']) {
      test(`${channel} / ${role}: ${behaviour}`, () => {
        const p = prompts(role)[channel];
        for (const re of phrases) assert.match(p, re, `${channel} prompt for a ${role} no longer says it (${re})`);
      });
    }
  }
}

test('a visitor is not told about memory, and a finished member is not re-sent the survey', () => {
  const v = prompts('visitor');
  assert.ok(!/WHAT YOU REMEMBER|MEMORY \(only/.test(v.voice) && !/MEMORY \(only/.test(v.text));
  const m = prompts('member');
  assert.ok(!/save_onboarding_step/.test(m.voice), 'a finished member must not be told to run the survey');
});

test('the voice prompt still asks for a short, natural spoken reply -- brevity by instruction, not by truncation', () => {
  const v = prompts('member').voice;
  assert.match(v, /VOICE:.*One or two helpful sentences/);
  assert.match(v, /More detail only when asked/);
});

test('the text prompt still asks for warm, practical answers with useful detail', () => {
  const t = prompts('member').text;
  assert.match(t, /ANSWERS: concise, warm and practical/);
  assert.match(t, /name the exact screen and step/);
});
