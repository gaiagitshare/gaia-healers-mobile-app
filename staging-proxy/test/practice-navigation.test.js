/**
 * ASSIST → PRACTICE — what a question turns into.
 *
 * A practitioner asks about a client; the model picks a destination; the screen
 * opens on it. Three things have to hold for that to be worth having, and none
 * of them is visible from reading any single file:
 *
 *   THE DESTINATION EXISTS. Practice is a tab inside You, not a route, so it is
 *   reached through the hooks that screen already listens on. A second
 *   navigation mechanism would be a second thing to keep in step.
 *
 *   ONLY A PRACTITIONER IS OFFERED IT. navigate declares itself differently by
 *   role: a member is never told "practice" is a screen, because for them it is
 *   not one.
 *
 *   A GUESSED CLIENT ID REACHES A REFUSAL, NOT DATA. The model is told to use an
 *   id from the listing tools. If it invents one anyway, the card's own fetch
 *   goes out with this practitioner's token and their server answers "not owned
 *   by this practitioner" -- which we verified against eight ids that were not
 *   theirs. The navigation layer is not the boundary and does not pretend to be.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const t = await import('../assist-tools.js');
const { toolDeclarationsFor, TOOLS } = t;

const MEMBER = { contactId: 'C-m', isPractitioner: false };
const PRACTITIONER = { contactId: 'C-p', isPractitioner: true };

/**
 * An app file, wherever the app sits relative to the proxy: inside the repo as
 * `staging-proxy/` in CI, or a sibling checkout under /root on the server.
 *
 * The sibling path used to carry one `../` too many and resolved to a
 * directory at the filesystem root that exists nowhere. Every read returned
 * null, every assertion returned early, and the suite REPORTED A PASS without
 * opening a single file. A test that cannot find its subject has to say so.
 */
function read(name) {
  for (const base of ['../../', '../../gaia-healers-mobile-app-1/']) {
    try { return fs.readFileSync(new URL(base + name, import.meta.url), 'utf8'); } catch { /* next */ }
  }
  throw new Error(`${name} not found beside the proxy; these assertions would otherwise pass without reading it`);
}
const navOf = (ctx) => toolDeclarationsFor(ctx).find((d) => d.name === 'navigate');

// ── what each role is offered ─────────────────────────────────────────────

test('a member is never told Practice is a screen', () => {
  const nav = navOf(MEMBER);
  assert.ok(!nav.parameters.properties.screen.enum.includes('practice'),
    'for a member it is not a screen, so offering it only invites a failed call');
  assert.deepEqual(Object.keys(nav.parameters.properties).sort(), ['screen', 'tab', 'tool']);
});

test('a practitioner is offered Practice and the three ways into it', () => {
  const nav = navOf(PRACTITIONER);
  assert.ok(nav.parameters.properties.screen.enum.includes('practice'));
  const props = nav.parameters.properties;
  assert.ok(props.client, 'a client to open');
  assert.ok(props.open, 'a result card to open on them');
  assert.ok(props.section, 'or a section of the list when there is no client');
  assert.deepEqual(props.open.enum.sort(), ['compare', 'latest', 'trend']);
  assert.deepEqual(props.section.enum.sort(), ['attention', 'clients', 'followups']);
});

test('the model is told where a client id may come from', () => {
  const nav = navOf(PRACTITIONER);
  const d = nav.parameters.properties.client.description;
  for (const tool of ['practitioner_list_clients', 'practitioner_find_client',
                      'practitioner_flagged_clients', 'practitioner_follow_ups']) {
    assert.ok(d.includes(tool), `the client parameter should name ${tool} as a source`);
  }
  assert.match(d, /Never invent one/i);
});

test('navigate tells the model it answers nothing, so it stops competing with the data tools', () => {
  // This assertion used to require "Prefer this over describing readings
  // aloud", which was wrong in a way that only showed up under repetition:
  // navigate returns no data, so preferring it for a reading left the model
  // with nothing to say but "it is on your screen" -- the exact failure the
  // acceptance test caught, at about a third of attempts. Measured over 8
  // repetitions of 19 phrasings, "compare his last two scans" and its
  // paraphrases went to navigate often enough to be the single biggest cause
  // of a practitioner question that fetched nothing.
  const nav = navOf(PRACTITIONER);
  assert.match(nav.description, /returns no data/i,
    'the model has to know a screen change is not an answer');
  assert.match(nav.description, /practitioner_ tool/,
    'and where the answer does come from');
  assert.ok(!/prefer this over describing readings/i.test(nav.description),
    'preferring a screen change over the tool is what made the tools feel optional');
  assert.match(nav.description, /say one short sentence/i,
    'the brevity it did get right is kept');
});

test('a practitioner is told their own clients are theirs to ask about', () => {
  // Several runs refused outright -- "I cannot track specific people", with a
  // line about consent -- because MEMBER CONTEXT says never to reference data
  // belonging to other members, and nothing distinguished a client of theirs
  // from another member. A refusal is a worse failure than a missing call.
  const src = fs.readFileSync(new URL('../assist-guide.js', import.meta.url), 'utf8');
  const sandbox = {};
  new Function('globalThis', src)(sandbox);
  const policy = sandbox.GaiaAssistGuide.statePolicy('practitioner');
  assert.match(policy, /THEIR OWN CLIENTS ARE THEIRS TO ASK ABOUT/);
  assert.match(policy, /never refuse, deflect/i);
});

test('a practitioner is told client facts come from a tool every time', () => {
  const src = fs.readFileSync(new URL('../assist-guide.js', import.meta.url), 'utf8');
  const sandbox = {};
  new Function('globalThis', src)(sandbox);
  const policy = sandbox.GaiaAssistGuide.statePolicy('practitioner');
  assert.match(policy, /NEVER FROM MEMORY/);
  assert.match(policy, /called in the same turn/,
    'a turn that only talks about fetching is the dead end we are closing');
  assert.match(policy, /follow-up about a client already discussed/,
    '"compare those two" is the case that failed most');
  assert.match(policy, /a scan already in this conversation/,
    'the model would otherwise answer "has he improved" from one reading it had');
});

test('the other roles are left exactly as they were', () => {
  // The fix is deliberately inside the practitioner branch: a member session
  // must not start calling tools during ordinary conversation because of it.
  const src = fs.readFileSync(new URL('../assist-guide.js', import.meta.url), 'utf8');
  const sandbox = {};
  new Function('globalThis', src)(sandbox);
  const { statePolicy } = sandbox.GaiaAssistGuide;
  assert.equal(statePolicy('member'),
    'COMPLETED MEMBER: help them use their verified access and preferences; do not offer the Gaia test again.');
  assert.match(statePolicy('visitor'), /^VISITOR: account and previous completion are unknown\./);
  for (const state of ['member', 'visitor', 'onboarding', 'unavailable']) {
    assert.ok(!/practitioner_ tool/.test(statePolicy(state)),
      `${state} must not be told about the practitioner tools`);
  }
});

test('a slow tool is told to call, not to announce', () => {
  // "tell the practitioner you are fetching it before you call it" described a
  // turn containing speech and no call, and that is what we got: "I'll check
  // what services address his readings", nothing fetched. The card shows its
  // own ten-second wait, so the preamble was never carrying anything.
  for (const name of ['practitioner_client_latest_scan', 'practitioner_client_trend',
                      'practitioner_compare_sessions']) {
    const d = toolDeclarationsFor(PRACTITIONER).find((x) => x.name === name).description;
    assert.match(d, /about ten seconds/, 'the practitioner still has to be told it is slow');
    assert.match(d, /Never say you are fetching it without calling it in the same turn/,
      `${name} must not invite a turn that speaks instead of calling`);
    assert.ok(!/(tell the practitioner you are fetching|say you are looking it up first|say you are checking first)/i.test(d),
      `${name} still asks for a preamble before the call`);
  }
});

test('the member description is left exactly as it was', () => {
  const nav = navOf(MEMBER);
  const base = TOOLS.find((x) => x.name === 'navigate');
  assert.equal(nav.description, base.description, 'a role-aware tool must not change the other role');
});

// ── the mapping, question → destination ───────────────────────────────────

test('every documented destination is reachable and nothing else is', () => {
  const orb = read('gaia-realtime-voice.js');
  assert.match(orb, /const PRACTICE_CARDS = \['latest', 'trend', 'compare'\]/);
  assert.match(orb, /const PRACTICE_SECTIONS = \['attention', 'followups', 'clients'\]/);
  // Anything outside those lists is dropped rather than passed through, so a
  // hallucinated card name opens the client instead of a broken card.
  assert.match(orb, /PRACTICE_CARDS\.includes\(open\) \? open : ''/);
  assert.match(orb, /PRACTICE_SECTIONS\.includes\(section\) \? section : ''/);
});

test('Practice is reached through the existing hooks, not a new mechanism', () => {
  const orb = read('gaia-realtime-voice.js');
  const i = orb.indexOf("if (screen === 'practice')");
  assert.ok(i > 0, 'navigate must handle the practice screen');
  const body = orb.slice(i, i + 1600);
  assert.match(body, /gaia:open-client/, 'the hook the Practice panel already listens on');
  assert.match(body, /shell\.go\('profile'/, 'Practice is a tab inside You, so You is the route');
  assert.ok(!/location\.href|window\.open|history\.push/.test(body),
    'a second navigation mechanism would be a second thing to keep in step');
});

test('the panel accepts a client, a card and a section from the one hook', () => {
  const ui = read('gaia-practitioner.js');
  const i = ui.indexOf("addEventListener('gaia:open-client'");
  const body = ui.slice(i, i + 900);
  assert.match(body, /if \(d\.client\)/, 'a client opens that client');
  assert.match(body, /d\.open/, 'with a card when one was asked for');
  assert.match(body, /d\.section/, 'and a section when there is no client');
  assert.match(body, /select\('practice'\)/, 'the tab is switched either way');
});

test('a deep link does the same thing as the hook', () => {
  const ui = read('gaia-practitioner.js');
  assert.match(ui, /params\.get\('client'\)/);
  assert.match(ui, /params\.get\('open'\)/);
  assert.match(ui, /params\.get\('tab'\) === 'practice'/);
});

// ── what is said while the card is on screen ──────────────────────────────

test('opening a card tells the model to wait rather than invent readings', () => {
  const orb = read('gaia-realtime-voice.js');
  const i = orb.indexOf("if (screen === 'practice')");
  const body = orb.slice(i, i + 2000);
  assert.match(body, /do not read out any numbers yet/i,
    'the card takes ten seconds; anything said before it loads would be invented');
  assert.match(body, /ten seconds/, 'and the model should set the expectation aloud');
});

test('opening a client asks for brevity, not a summary of the screen', () => {
  const orb = read('gaia-realtime-voice.js');
  const i = orb.indexOf("if (screen === 'practice')");
  const body = orb.slice(i, i + 2200);
  assert.match(body, /do not list details that are already visible/i);
});

// ── the boundary ──────────────────────────────────────────────────────────

test('navigation is not the authorization boundary and does not pretend to be', () => {
  // The id the model passes is not trusted. Every card fetches through the
  // server with this practitioner's own token, and their side refuses anything
  // that is not theirs. This test pins that the fetch is what happens next --
  // not a client-side allow-list that could be edited in a browser.
  const ui = read('gaia-practitioner.js');
  const i = ui.indexOf('async function showClient');
  const body = ui.slice(i, i + 2600);
  assert.match(body, /tool\('practitioner_get_client', \{ clientId \}\)/,
    'opening a client must verify it by fetching it');
  assert.match(body, /not on your list/,
    'and say so plainly when it is not theirs');
});

test('the Practice screen is in the shared vocabulary both sides read', async () => {
  // The module ends with `})(globalThis)`, so give it a globalThis of our own
  // rather than rewriting its source to find out what it declares.
  const src = fs.readFileSync(new URL('../assist-guide.js', import.meta.url), 'utf8');
  const sandbox = {};
  new Function('globalThis', src)(sandbox);
  const screens = sandbox.GaiaAssistGuide.screens;
  assert.ok(Object.hasOwn(screens, 'practice'),
    'the app reads this map for its view list and the model reads it for its vocabulary');
  assert.match(screens.practice, /practitioner/i);
  assert.match(screens.practice, /Only exists for practitioners/i);
});

// ── the two faults the acceptance test found ──────────────────────────────

test('asking for a scan opens the card, without relying on the model to say so', () => {
  // The model fetched the data, described it, and said "it is on screen" when
  // nothing had opened. Telling it to call navigate as well would make that a
  // second thing it has to remember; the page does it instead, so it is a fact.
  const orb = read('gaia-realtime-voice.js');
  assert.match(orb, /const PRACTITIONER_CARD = \{/);
  for (const [tool, card] of [['practitioner_client_latest_scan', 'latest'],
                              ['practitioner_client_trend', 'trend'],
                              ['practitioner_compare_sessions', 'compare']]) {
    assert.ok(new RegExp(`${tool}: '${card}'`).test(orb), `${tool} must open the ${card} card`);
  }
  const i = orb.indexOf('async function runServerToolCall');
  assert.match(orb.slice(i, i + 200), /openPractitionerView\(name, args\)/,
    'every practitioner tool call opens its view first');
});

test('one question costs one ten-second call, not two', () => {
  const orb = read('gaia-realtime-voice.js');
  const ui = read('gaia-practitioner.js');
  assert.match(orb, /awaiting: true/, 'the page tells the panel an answer is coming');
  assert.match(orb, /gaia:client-data/, 'and hands it the same result the model got');
  const i = ui.indexOf('async function openCard');
  const body = ui.slice(i, i + 1400);
  assert.match(body, /if \(awaiting\) return;/,
    'the panel shows the wait but must not start a second fetch beside it');
  assert.match(ui, /addEventListener\('gaia:client-data'/, 'and fills from the pushed result');
});

test('the screen and the spoken answer come from the same fetch', () => {
  const ui = read('gaia-practitioner.js');
  const i = ui.indexOf('function fillCard');
  const body = ui.slice(i, i + 900);
  assert.match(body, /renderCard\(kind, payload\.data\)/,
    'two fetches would be two chances to disagree about the same numbers');
  assert.match(body, /Bio-Well did not answer/, 'and an upstream failure reaches the card');
});

test('an MCP call cannot hang for ever', () => {
  const src = fs.readFileSync(new URL('../practitioners-oauth.js', import.meta.url), 'utf8');
  assert.match(src, /const MCP_TIMEOUT_MS = \d+/, 'there has to be one');
  const ms = Number(/const MCP_TIMEOUT_MS = (\d+)/.exec(src)[1]);
  assert.ok(ms >= 20000, `${ms}ms would cut off a scan that legitimately takes twelve seconds`);
  assert.ok(ms <= 60000, `${ms}ms is longer than anybody waits`);
  assert.match(src, /signal: AbortSignal\.timeout\(MCP_TIMEOUT_MS\)/);
  assert.match(src, /code: 'upstream_unavailable'/,
    'the card needs to tell a hung server apart from an empty answer');
});

test('a token call has its own, shorter, limit', () => {
  const src = fs.readFileSync(new URL('../practitioners-oauth.js', import.meta.url), 'utf8');
  const ms = Number(/const TOKEN_TIMEOUT_MS = (\d+)/.exec(src)[1]);
  assert.ok(ms > 0 && ms < 20000, 'an OAuth exchange is not a Bio-Well fetch and should not wait like one');
  assert.equal((src.match(/AbortSignal\.timeout\(TOKEN_TIMEOUT_MS\)/g) || []).length, 2,
    'both the code exchange and the refresh need it');
});

test('an upstream that did not answer is a 504, not a generic failure', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /upstream_unavailable: 504/,
    'the page shows different words for "their server is down" and "you may not do that"');
});
