const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dsp = require('../gaia-pulse-dsp.js');

function seededNoise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000 - 0.5;
  };
}

function makeFrames({
  bpm = 72,
  fps = 30,
  duration = 12,
  mode = 'ppg',
  jitter = true,
  seed = 7,
} = {}) {
  const random = seededNoise(seed);
  const frames = [];
  let t = 0;
  for (let index = 0; t < duration * 1000; index += 1) {
    const cadence = 1000 / fps;
    t += cadence + (jitter ? ((index % 7) - 3) * 0.22 : 0);
    if (index % 53 === 0 && index > 0) t += cadence; // a dropped camera frame
    const phase = 2 * Math.PI * (bpm / 60) * t / 1000;
    const wave = Math.sin(phase) + 0.22 * Math.sin(2 * phase + 0.4);
    let amplitudes = [0.009, 0.004, 0.00025];
    if (mode === 'common') amplitudes = [0.009, 0.009, 0.009];
    if (mode === 'noise') amplitudes = [0, 0, 0];
    const noise = mode === 'noise' ? random() * 9 : random() * 0.08;
    frames.push({
      t,
      r: (mode === 'iphone-yellow' ? 218 : 185) * (1 + amplitudes[0] * wave) + noise,
      g: (mode === 'iphone-yellow' ? 224 : 82) * (1 + amplitudes[1] * wave) + noise,
      b: (mode === 'iphone-yellow' ? 142 : 42) * (1 + amplitudes[2] * wave) + noise,
      spatialCv: 0.06,
      motion: 0.004,
    });
  }
  return frames;
}

function makeFaceFrames({ bpm = 72, fps = 30, duration = 12, mode = 'face', seed = 19 } = {}) {
  const random = seededNoise(seed);
  const frames = [];
  for (let index = 0; index < fps * duration; index += 1) {
    const t = index * (1000 / fps);
    const phase = 2 * Math.PI * (bpm / 60) * t / 1000;
    const pulse = Math.sin(phase) + 0.16 * Math.sin(2 * phase + 0.3);
    const exposure = 0.0015 * Math.sin(2 * Math.PI * 0.22 * t / 1000);
    const common = mode === 'common' ? 0.008 * pulse : exposure;
    const greenPulse = mode === 'face' ? 0.0022 * pulse : 0;
    const redPulse = mode === 'face' ? 0.0007 * pulse : 0;
    const noise = random() * 0.035;
    frames.push({
      t,
      r: 154 * (1 + common + redPulse) + noise,
      g: 121 * (1 + common + greenPulse) + noise,
      b: 91 * (1 + common) + noise,
      spatialCv: 0.12,
      motion: mode === 'moving' ? 0.22 : 0.004,
    });
  }
  return frames;
}

test('accepts a yellow/pink iPhone-white-balanced fingertip signal', () => {
  const frames = makeFrames({ bpm: 78, mode: 'iphone-yellow', seed: 78 });
  const result = dsp.analyzePulse(frames);
  assert.equal(result.ok, true, result.reason);
  assert.ok(Math.abs(result.bpm - 78) < 2);
  const preview = dsp.previewPulse(frames);
  assert.equal(preview.ok, true, preview.reason);
  assert.ok(Math.abs(preview.bpm - 78) < 2);
});

test('face beta recovers a weak green-channel facial pulse', () => {
  const frames = makeFaceFrames({ bpm: 76 });
  const preview = dsp.previewFace(frames);
  assert.equal(preview.ok, true, preview.reason);
  assert.ok(Math.abs(preview.bpm - 76) < 3, `${preview.bpm} vs 76`);
  const result = dsp.analyzeFace(frames);
  assert.equal(result.ok, true, result.reason);
  assert.ok(Math.abs(result.bpm - 76) < 3, `${result.bpm} vs 76`);
});

test('face beta rejects common-mode light cadence and excessive motion', () => {
  const cadence = dsp.analyzeFace(makeFaceFrames({ bpm: 90, mode: 'common' }));
  assert.equal(cadence.ok, false, 'locked onto whole-frame light cadence');
  assert.equal(cadence.reason, 'common_mode_artifact');
  const moving = dsp.analyzeFace(makeFaceFrames({ mode: 'moving' }));
  assert.equal(moving.ok, false);
  assert.equal(moving.reason, 'motion');
});

test('local texture ignores a smooth flash hotspot but catches a detailed scene', () => {
  const smoothHotspot = [];
  const checkerboard = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const distance = Math.hypot(x - 3.5, y - 3.5);
      smoothHotspot.push(210 - distance * 18);
      checkerboard.push((x + y) % 2 ? 180 : 45);
    }
  }
  assert.ok(dsp.spatialTexture(smoothHotspot, 8, 8) < 0.2);
  assert.ok(dsp.spatialTexture(checkerboard, 8, 8) > 0.8);
});

test('differential color cancels rhythmic exposure and recovers a weak pulse', () => {
  const frames = [];
  for (let index = 0; index < 360; index += 1) {
    const t = index * (1000 / 30);
    const exposure = 0.006 * Math.sin(2 * Math.PI * 1.5 * t / 1000);
    const pulse = Math.sin(2 * Math.PI * 1.2 * t / 1000);
    frames.push({
      t,
      r: 190 * (1 + exposure + 0.0018 * pulse),
      g: 94 * (1 + exposure + 0.0008 * pulse),
      b: 48 * (1 + exposure),
      spatialCv: 0.05,
      motion: 0.004,
    });
  }
  const result = dsp.analyzePulse(frames);
  assert.equal(result.ok, true, result.reason);
  assert.ok(['redBlue', 'greenBlue'].includes(result.channel));
  assert.ok(Math.abs(result.bpm - 72) < 3, `${result.bpm} vs 72`);
});

for (const expected of [50, 72, 110, 150]) {
  test(`recovers ${expected} BPM from irregular camera timestamps`, () => {
    const result = dsp.analyzePulse(makeFrames({ bpm: expected, seed: expected }));
    assert.equal(result.ok, true, result.reason);
    assert.ok(Math.abs(result.bpm - expected) < 2, `${result.bpm} vs ${expected}`);
    assert.ok(Math.abs(result.spectralBpm - result.autocorrelationBpm) <= 5);
    assert.ok(result.segmentBpms.length >= 2);
  });
}

test('rejects periodic whole-scene RGB artifacts across the pulse band', () => {
  for (const cadence of [48, 60, 72, 90, 120, 150]) {
    const result = dsp.analyzePulse(makeFrames({ bpm: cadence, mode: 'common', seed: cadence }));
    assert.equal(result.ok, false, `false lock at ${cadence} CPM`);
    assert.equal(result.reason, 'common_mode_artifact');
  }
});

test('rejects structured cadence without fingertip color contact', () => {
  const frames = makeFrames({ bpm: 90, mode: 'common' }).map((frame) => ({
    ...frame,
    r: 104 + (frame.r - 185),
    g: 104 + (frame.g - 82),
    b: 104 + (frame.b - 42),
    spatialCv: 0.4,
  }));
  const result = dsp.analyzePulse(frames);
  assert.equal(result.ok, false);
  assert.ok(['no_finger_contact', 'scene_texture', 'unstable_contact'].includes(result.reason));
});

test('rejects random camera noise without false locks', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const result = dsp.analyzePulse(makeFrames({ mode: 'noise', seed }));
    assert.equal(result.ok, false, `false lock for noise seed ${seed}`);
  }
});

test('requires enough independent time coverage', () => {
  const result = dsp.analyzePulse(makeFrames({ duration: 6 }));
  assert.equal(result.ok, false);
  assert.ok(['need_more', 'need_more_stability'].includes(result.reason));
});

test('contact gate rejects darkness, scene texture, and motion', () => {
  const base = makeFrames({ duration: 2 });
  assert.equal(dsp.contactMetrics(base.map((f) => ({ ...f, r: 5, g: 4, b: 3 }))).reason, 'too_dark');
  assert.equal(dsp.contactMetrics(base.map((f) => ({ ...f, spatialCv: 0.5 }))).reason, 'scene_texture');
  assert.equal(dsp.contactMetrics(base.map((f) => ({ ...f, motion: 0.3 }))).reason, 'motion');
});

test('production capture is frame-clocked and has no timed BPM acceptance', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'gaia-pulse.js'), 'utf8');
  assert.match(source, /requestVideoFrameCallback/);
  assert.match(source, /useRafFallback/);
  assert.match(source, /receivedFrames/);
  assert.match(source, /frameWatchdog/);
  assert.match(source, /requestCamera\(\{ video: baseVideo, audio: false \}, 25000\)/);
  assert.equal((source.match(/mediaDevices\.getUserMedia\(/g) || []).length, 1, 'one camera request path only');
  assert.match(source, /cameraPolicyBlocked\(\)/);
  assert.match(source, /analyzePulse\(frames\)/);
  assert.match(source, /dsp\.analyzeFace\(frames\)/);
  assert.match(source, /gp-video--face/);
  assert.match(source, /if \(analysis\.ok\) \{ finish\(analysis\.bpm\)/);
  assert.doesNotMatch(source, /function estimateBpm/);
  assert.doesNotMatch(source, /elapsed\s*>\s*40000/);
  assert.match(source, /tapMode\(card, 'Couldn’t get a clean pulse/);
});

test('production shell loads the tested DSP before capture and caches both', () => {
  const home = fs.readFileSync(path.join(__dirname, '..', 'home.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.ok(home.indexOf('gaia-pulse-dsp.js') < home.indexOf('gaia-pulse.js'));
  assert.match(sw, /gaia-pulse-dsp\.js/);
  assert.match(sw, /gaia-pulse\.js/);
});
