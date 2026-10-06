/**
 * The member's own readings, trends and flags (from the partner's member
 * access) may be SHOWN to the member; they are never sent to Gaia's AI
 * provider (owner, 6 Oct 2026). Pins the boundary at every door to the model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readApp } from './_app-present.js';

const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('partner reading data is fetched only for the My readings route (member UI)', () => {
  const calls = srv.match(/await memberReadings\(/g) || [];
  assert.equal(calls.length, 1, 'one call site');
  const at = srv.indexOf('await memberReadings(');
  assert.ok(srv.lastIndexOf("sub === 'my-readings'", at) > srv.lastIndexOf('async function', at), 'it is the my-readings route');
});

test("Gaia's member context carries only that readings exist / a new one is waiting -- never values, trends or flags", () => {
  const start = srv.indexOf('async function buildMemberVoiceContext'), end = srv.indexOf('\nasync function ', start + 10);
  const block = srv.slice(start, end > 0 ? end : start + 20000);
  // Property reads of reading data (the prose describing the card is fine).
  assert.doesNotMatch(block, /memberReadings\(|\.latest\.|\.energy\b|\.stress\b|\.chakras\b|\.disbalance\b|\.flagged\b|\.most_out_of_balance|trend\.(energy|stress)/);
  assert.match(block, /linkStatus\(rid2\)/, 'link status only (linked, new_reading)');
});

test('what the page sends with a Gaia message is the screen and an item id, not page text', () => {
  const ui = readApp('gaia-ui.js');
  assert.match(ui, /const pageContext = \(\) => \{ const screen=window\.GaiaAppShell\?\.currentView\?\.\(\) \|\| 'today'; return window\.GaiaAssistGuide\.context\(window\.GaiaJourney\?\.context \|\| \{screen, itemId:/);
  assert.doesNotMatch(readApp('gaia-my-readings.js'), /api\/assist\/(chat|voice|tool)/);
});
