// The member's readings card, its walk-through and the chakra prompts say what the
// figures are, never what they mean: no ranges, judgements or reading-to-action rules
// until an approved source exists (docs/BIOWELL_INTERPRETATION_SOURCE_REQUIREMENTS.md).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// Member-facing strings only: template text and quoted copy, comments stripped.
const copyOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const INTERPRETIVE = /\b(normal|abnormal|healthy|unhealthy|comfortable|concerning|worth a conversation|quietest|most people|higher is not always better|where you are now|is stale)\b/i;

test('readings card and walk-through carry no unsourced interpretation', () => {
  const js = copyOf(read('gaia-my-readings.js'));
  assert.doesNotMatch(js, INTERPRETIVE);
  assert.doesNotMatch(js, /good:\s*\[/, 'no "comfortable" band on a gauge');
  assert.doesNotMatch(js, /CENTRE_CUES|centreOfTheWeek/, 'no reading-to-tool mapping without an approved source');
  assert.doesNotMatch(js, /is-good|is-bad/, 'no better/worse colouring of differences');
  assert.doesNotMatch(js, /\{\s*esc\(fmt\(d\.disbalance\)\)\s*\}%/, 'no assumed unit on disbalance');
});

test('the walk-through is descriptive and ends with the practitioner', () => {
  const js = read('gaia-my-readings.js');
  const guide = js.slice(js.indexOf('function guide()'), js.indexOf('const latest = () =>'));
  assert.ok(guide.length > 500, 'guide() found');
  assert.doesNotMatch(copyOf(guide), INTERPRETIVE);
  assert.match(guide, /recheckLine\(\)/, 'old scans use the recheck policy wording');
  assert.match(guide, /question for \$\{who\}/, 'meaning is a question for the practitioner');
});

test('recheck wording is Gaia policy from the server, not a Bio-Well expiry', () => {
  const js = read('gaia-my-readings.js');
  assert.match(js, /recheck_after_days/);
  assert.match(js, /A new scan may give you a more current point of comparison\./);
  assert.doesNotMatch(read('gaia-superapp.js'), /would show where you are now|age\.stale/);
});

test('chakra prompts never ask Gaia to interpret a scan', () => {
  const data = read('gaia-chakra-data.js');
  for (const m of data.matchAll(/assistPrompt: '([^']*)'/g)) assert.doesNotMatch(m[1], /scan|reading|bio-?well|improve|balance/i, m[1]);
  assert.doesNotMatch(data, /tab=biowell|community&tab=learning/, 'no links to tabs that do not exist');
});
