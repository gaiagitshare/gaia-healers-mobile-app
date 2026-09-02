const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/* The result screen turns a completed reading into something usable, and the
 * Assist has to know the tool exists. Both were gaps found on a real device:
 * readings were saved but never shown back, the gauge pinned at 95 so 96 and
 * 140 looked identical, and gaia-ui.js did not contain the word "pulse". */

test('the saved reading history is shown back to the person', () => {
  const src = read('gaia-pulse.js');
  assert.match(src, /function trendMarkup\(/, 'a trend view exists');
  assert.match(src, /trendMarkup\(\[\{ bpm: Math\.round\(bpm\)/, 'the result renders it, current reading first');
  assert.match(src, /gp-trend__spark/, 'the trend draws a sparkline');
  assert.ok(src.includes('This is your first saved reading on this device'),
    'a single reading still gets an honest empty state rather than a broken chart');
});

test('the activation gauge does not saturate at the top of the range', () => {
  const src = read('gaia-pulse.js');
  const m = src.match(/const pos = clamp\(\(bpm - (\d+)\) \/ \((\d+) - \d+\), 0, 1\)/);
  assert.ok(m, 'the gauge maps BPM onto a fixed range');
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  const pos = (bpm) => Math.max(0, Math.min(1, (bpm - lo) / (hi - lo)));
  assert.ok(hi >= 110, `the drawn range must reach an elevated pulse (got ${hi})`);
  assert.ok(pos(106) < 1, '106 BPM must not pin to the far end');
  assert.ok(pos(140) > pos(106), 'a higher reading must still read as higher');
});

test('the Calm/Balanced/Activated cut-offs are unchanged in BPM terms', () => {
  const src = read('gaia-pulse.js');
  // Originally derived from clamp((bpm-55)/40) at 0.34 / 0.67 -> 68.6 / 81.8.
  assert.match(src, /bpm < 68\.6 \? 'Calm' : bpm < 81\.8 \? 'Balanced' : 'Activated'/,
    'widening the gauge must not silently reband anyone');
});

test('a high camera reading invites a confirming re-measure', () => {
  const src = read('gaia-pulse.js');
  assert.match(src, /method === 'camera' && bpm >= 100/, 'camera-specific, not applied to tapped readings');
  assert.ok(src.includes('Worth confirming'), 'the prompt is shown');
  assert.ok(!/see a doctor|medical advice|diagnos/i.test(src.split('Worth confirming')[1].slice(0, 400)),
    'measurement hygiene only — never health advice');
});

test('Gaia Assist knows the two free tools and can answer from saved readings', () => {
  const src = read('gaia-ui.js');
  assert.match(src, /label: 'Check my Energy Pulse'/, 'Assist can open Energy Pulse');
  assert.match(src, /label: 'Start coherence breathing'/, 'Assist can open the breathing tool');
  assert.match(src, /function pulseReply\(/, 'Assist answers pulse questions itself');
  assert.match(src, /gaia:pulse:readings:v1/, 'from the same key the tool writes');
  assert.match(src, /const pulse = pulseReply\(prompt\);/, 'and it is consulted before the generic replies');
  assert.ok(/Energy Pulse heart-rate reading and coherence breathing/.test(src),
    'the "what is in this app" answer names the free tools');
  assert.ok(/never uploaded/.test(src.slice(src.indexOf('function pulseReply'))),
    'the reply states the device-only privacy promise');
});

test('the pulse history key stays in sync between the tool and the Assist', () => {
  const key = (read('gaia-pulse.js').match(/PULSE_HISTORY_KEY = '([^']+)'/) || [])[1];
  assert.ok(key, 'the tool defines a history key');
  assert.ok(read('gaia-ui.js').includes(`'${key}'`), 'the Assist reads that exact key');
});
