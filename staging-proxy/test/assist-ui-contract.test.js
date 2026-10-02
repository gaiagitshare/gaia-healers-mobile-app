/**
 * GAIA ASSIST UI — the controls have to do what they say.
 *
 * Someone asked Gaia a question, wanted it to stop talking, and could not make
 * it. Three controls looked like they would and none did:
 *
 *   "Sound off"       silenced the OLD audio paths -- the <audio> element,
 *                     speechSynthesis, the legacy TTS fetch -- and the live
 *                     voice uses none of them. It plays through an AudioWorklet
 *                     that never consulted the muted flag, so the icon changed
 *                     and Gaia kept talking.
 *   "Pause listening" mutes the microphone. Gaia can still speak.
 *   Close / Minimise  hides the panel. The session runs on.
 *
 * A fourth control did work -- tapping the orb a second time -- but it read
 * "Start voice conversation with Gaia" the whole time, so nobody knew.
 *
 * These assertions are about a promise to a person rather than about an API,
 * which is why they are worth pinning: all of it parsed and ran perfectly well
 * while being wrong.
 *
 * The file lives here because the app has no test runner of its own and the
 * proxy's suite already reads the orb's source the same way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * gaia-ui.js, wherever the app is checked out relative to the proxy.
 *
 * Two layouts: in CI the proxy is `staging-proxy/` inside the app repo, so the
 * file is two levels up; on the server the two are siblings under /root.
 *
 * The sibling path used to carry one `../` too many, which resolved to
 * /gaia-healers-mobile-app-1 at the filesystem root. It exists nowhere, so
 * every assertion in this file returned early and REPORTED A PASS -- including
 * the ones written after somebody could not stop Gaia talking. A test that
 * cannot find its subject has to say so, so a miss now throws.
 */
function readUi() {
  for (const rel of ['../../gaia-ui.js', '../../gaia-healers-mobile-app-1/gaia-ui.js']) {
    try { return fs.readFileSync(new URL(rel, import.meta.url), 'utf8'); } catch { /* next */ }
  }
  throw new Error('gaia-ui.js not found beside the proxy; these assertions would otherwise pass without reading anything');
}

function section(src, start, length) {
  const i = src.indexOf(start);
  return i < 0 ? '' : src.slice(i, i + length);
}

// ── one control instead of five ───────────────────────────────────────────
//
// The fix above worked but was still wearing a speaker icon, and it was one of
// FIVE controls that each did something different to the voice: the orb, Sound
// on/off, Pause listening, the send button (a microphone whenever the box was
// empty), and Close. Somebody who just wanted to type had to guess which.
//
// Talk / Chat replaces the speaker button. It is the same `muted` state, which
// already stopped the session and released the microphone -- said out loud,
// with the current mode visibly chosen. Verified in Chromium against the real
// panel: 21 checks, including that the choice survives a reload.

test('the panel offers an explicit Talk / Chat choice', () => {
  const src = readUi();
  assert.match(src, /data-assist-mode="talk"/, 'there has to be a Talk option');
  assert.match(src, /data-assist-mode="chat"/, 'and a Chat option');
  assert.match(src, /<span>Talk<\/span>/, 'labelled in words, not just an icon');
  assert.match(src, /<span>Chat<\/span>/);
  assert.ok(!/gaia-assist__sound-toggle/.test(src),
    'the speaker button it replaces must be gone, or there are two answers again');
});

test('exactly one mode is ever shown as chosen', () => {
  const src = readUi();
  const setMuted = section(src, 'function setMuted', 2400);
  assert.match(setMuted, /modeButtons\.forEach/, 'both buttons are updated from the one state');
  assert.match(setMuted, /aria-selected', String\(isChat === muted\)/,
    'selected is derived from muted, so the two can never both look chosen');
  assert.match(setMuted, /gaia-assist--chat-mode', muted/, 'and the panel knows which mode it is in');
});

test('choosing Chat stops the voice; choosing Talk starts it', () => {
  const src = readUi();
  const handler = section(src, 'const wantChat = ', 900);
  assert.match(handler, /if \(!muted\) setMuted\(true\)/, 'Chat turns the voice off');
  assert.match(handler, /promptInput\?\.focus/, 'and puts the cursor where they are about to type');
  assert.match(handler, /if \(muted\) setMuted\(false\)/, 'Talk turns it back on');
  assert.match(handler, /if \(!realtimeVoice\?\.isActive\?\.\(\)\) void onAssistTap\(\)/,
    'and actually starts a session rather than only changing a label');
});

test('picking the mode you are already in does nothing', () => {
  // A segmented control that toggles itself off on a second tap is the
  // confusion this replaces, not a feature.
  const src = readUi();
  const handler = section(src, 'const wantChat = ', 900);
  assert.match(handler, /if \(!muted\) setMuted\(true\)/);
  assert.match(handler, /if \(muted\) setMuted\(false\)/);
  assert.ok(!/setMuted\(!muted\)/.test(handler), 'neither button may toggle');
});

test('stopping the voice at the orb moves the switch to Chat', () => {
  // Otherwise the control lies: "Talk" selected with nothing running.
  const src = readUi();
  const tap = section(src, 'async function onAssistTap', 1800);
  const i = tap.indexOf('if (voiceLive) {');
  assert.ok(i > 0);
  assert.match(tap.slice(i, i + 500), /if \(!muted\) setMuted\(true\)/,
    'the switch has to follow what the orb just did');
});

test('in Chat the send button never turns into a microphone', () => {
  // It used to, whenever the box was empty -- a sixth way to start the voice,
  // in the one place somebody who chose Chat would never expect one.
  const src = readUi();
  const sync = section(src, 'function syncAssistSendButton', 1200);
  assert.match(sync, /chatOnly = root\.classList\.contains\('gaia-assist--chat-mode'\)/);
  assert.match(sync, /dataset\.mode = \(typing \|\| chatOnly\) \? 'send' : 'voice'/);
  assert.match(sync, /if \(!typing && !chatOnly\)/, 'and it keeps the plain "Send" label');
});

test('turning the sound off stops the live voice, not just the old audio paths', () => {
  const src = readUi();
  const setMuted = section(src, 'function setMuted', 2400);
  assert.ok(setMuted, 'setMuted must exist');
  assert.match(setMuted, /realtimeVoice\?\.isActive\?\.\(\)/,
    'it has to ask whether a live session is running');
  assert.match(setMuted, /realtimeVoice\.stop\(\)/,
    'and stop it -- stopSpeaking() cannot, because the live voice plays through the worklet');
  assert.match(setMuted, /try \{[^}]*realtimeVoice\.stop\(\)[^}]*\} catch/,
    'guarded, so a session that already ended cannot throw inside a UI handler');
});

test('and it tells the person what to do instead of talking', () => {
  const src = readUi();
  const setMuted = section(src, 'function setMuted', 2400);
  assert.match(setMuted, /type your question below/i,
    'turning voice off without pointing at the text box leaves somebody stuck');
});

test('the orb says what the next tap will do', () => {
  const src = readUi();
  const state = section(src, 'function setAssistVoiceState', 2400);
  assert.match(state, /Stop talking with Gaia/,
    'while a session is live the orb must offer to stop it');
  assert.match(state, /Start voice conversation with Gaia/,
    'and offer to start one when it is not');
  assert.match(state, /setAttribute\('aria-label', label\)/, 'the accessible name has to change');
  assert.match(state, /setAttribute\('title', label\)/, 'and the hover title with it');
});

test('tapping the orb overrides a previous sound-off', () => {
  const src = readUi();
  const tap = section(src, 'async function onAssistTap', 1400);
  assert.match(tap, /if \(muted && !realtimeVoice\?\.isActive\?\.\(\)\) setMuted\(false\)/,
    'otherwise the orb starts a session nobody can hear');
});

test('the orb still ends a live session on a second tap', () => {
  // The one control that always worked. Nothing here may take it away.
  const src = readUi();
  const tap = section(src, 'async function onAssistTap', 1400);
  assert.match(tap, /const voiceLive = !!realtimeVoice\?\.isActive\?\.\(\)/);
  assert.match(tap, /realtimeVoice\.stop\(\)/);
});

test('the only working Stop button is still hidden, so the visible ones must work', () => {
  // Not a failure to fix here -- it belongs to the retired fallback UI -- but if
  // somebody un-hides that block, this test is where the reason is written down.
  const src = readUi();
  const i = src.indexOf('gaia-assist__voice--fallback');
  if (i < 0) return;                        // the fallback block is gone entirely
  const block = src.slice(i, i + 600);
  assert.ok(/hidden/.test(block),
    'if the fallback block is shown again, revisit which controls stop the voice');
  assert.ok(/gaia-assist__stop/.test(block),
    'the Stop button lives in there; the visible controls are what people use');
});
