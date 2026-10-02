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

function read(name) {
  for (const base of ['../../', '../../../gaia-healers-mobile-app-1/']) {
    try { return fs.readFileSync(new URL(base + name, import.meta.url), 'utf8'); } catch { /* next */ }
  }
  return null;
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

test('the practitioner description asks for the card instead of a recital', () => {
  const nav = navOf(PRACTITIONER);
  assert.match(nav.description, /open the card, then say one short sentence/i,
    'otherwise the model reads out what the practitioner is already looking at');
});

test('the member description is left exactly as it was', () => {
  const nav = navOf(MEMBER);
  const base = TOOLS.find((x) => x.name === 'navigate');
  assert.equal(nav.description, base.description, 'a role-aware tool must not change the other role');
});

// ── the mapping, question → destination ───────────────────────────────────

test('every documented destination is reachable and nothing else is', () => {
  const orb = read('gaia-realtime-voice.js');
  if (orb === null) return;
  assert.match(orb, /const PRACTICE_CARDS = \['latest', 'trend', 'compare'\]/);
  assert.match(orb, /const PRACTICE_SECTIONS = \['attention', 'followups', 'clients'\]/);
  // Anything outside those lists is dropped rather than passed through, so a
  // hallucinated card name opens the client instead of a broken card.
  assert.match(orb, /PRACTICE_CARDS\.includes\(open\) \? open : ''/);
  assert.match(orb, /PRACTICE_SECTIONS\.includes\(section\) \? section : ''/);
});

test('Practice is reached through the existing hooks, not a new mechanism', () => {
  const orb = read('gaia-realtime-voice.js');
  if (orb === null) return;
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
  if (ui === null) return;
  const i = ui.indexOf("addEventListener('gaia:open-client'");
  const body = ui.slice(i, i + 900);
  assert.match(body, /if \(d\.client\)/, 'a client opens that client');
  assert.match(body, /d\.open/, 'with a card when one was asked for');
  assert.match(body, /d\.section/, 'and a section when there is no client');
  assert.match(body, /select\('practice'\)/, 'the tab is switched either way');
});

test('a deep link does the same thing as the hook', () => {
  const ui = read('gaia-practitioner.js');
  if (ui === null) return;
  assert.match(ui, /params\.get\('client'\)/);
  assert.match(ui, /params\.get\('open'\)/);
  assert.match(ui, /params\.get\('tab'\) === 'practice'/);
});

// ── what is said while the card is on screen ──────────────────────────────

test('opening a card tells the model to wait rather than invent readings', () => {
  const orb = read('gaia-realtime-voice.js');
  if (orb === null) return;
  const i = orb.indexOf("if (screen === 'practice')");
  const body = orb.slice(i, i + 2000);
  assert.match(body, /do not read out any numbers yet/i,
    'the card takes ten seconds; anything said before it loads would be invented');
  assert.match(body, /ten seconds/, 'and the model should set the expectation aloud');
});

test('opening a client asks for brevity, not a summary of the screen', () => {
  const orb = read('gaia-realtime-voice.js');
  if (orb === null) return;
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
  if (ui === null) return;
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
