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

/** gaia-ui.js when the app is checked out beside us, else null. */
function readUi() {
  for (const rel of ['../../gaia-ui.js', '../../../gaia-healers-mobile-app-1/gaia-ui.js']) {
    try { return fs.readFileSync(new URL(rel, import.meta.url), 'utf8'); } catch { /* next */ }
  }
  return null;
}

function section(src, start, length) {
  const i = src.indexOf(start);
  return i < 0 ? '' : src.slice(i, i + length);
}

test('turning the sound off stops the live voice, not just the old audio paths', () => {
  const src = readUi();
  if (src === null) return;                 // deployed proxy: the app is not beside it
  const setMuted = section(src, 'function setMuted', 1500);
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
  if (src === null) return;
  const setMuted = section(src, 'function setMuted', 1500);
  assert.match(setMuted, /type your question below/i,
    'turning voice off without pointing at the text box leaves somebody stuck');
});

test('the orb says what the next tap will do', () => {
  const src = readUi();
  if (src === null) return;
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
  if (src === null) return;
  const tap = section(src, 'async function onAssistTap', 1400);
  assert.match(tap, /if \(muted && !realtimeVoice\?\.isActive\?\.\(\)\) setMuted\(false\)/,
    'otherwise the orb starts a session nobody can hear');
});

test('the orb still ends a live session on a second tap', () => {
  // The one control that always worked. Nothing here may take it away.
  const src = readUi();
  if (src === null) return;
  const tap = section(src, 'async function onAssistTap', 1400);
  assert.match(tap, /const voiceLive = !!realtimeVoice\?\.isActive\?\.\(\)/);
  assert.match(tap, /realtimeVoice\.stop\(\)/);
});

test('the only working Stop button is still hidden, so the visible ones must work', () => {
  // Not a failure to fix here -- it belongs to the retired fallback UI -- but if
  // somebody un-hides that block, this test is where the reason is written down.
  const src = readUi();
  if (src === null) return;
  const i = src.indexOf('gaia-assist__voice--fallback');
  if (i < 0) return;                        // the fallback block is gone entirely
  const block = src.slice(i, i + 600);
  assert.ok(/hidden/.test(block),
    'if the fallback block is shown again, revisit which controls stop the voice');
  assert.ok(/gaia-assist__stop/.test(block),
    'the Stop button lives in there; the visible controls are what people use');
});
