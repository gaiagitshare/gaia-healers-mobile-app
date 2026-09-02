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
  duration = 16, // final result needs the 15 s window (validated-study standard)
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
  for (let index = 0; index < 480; index += 1) {
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
  // any exposure-cancelling (ratio) channel is a legitimate winner here
  assert.ok(['redBlue', 'greenBlue', 'hue', 'gNorm'].includes(result.channel), result.channel);
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

test('rejects random camera noise without false locks (final AND provisional)', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const frames = makeFrames({ mode: 'noise', seed });
    const result = dsp.analyzePulse(frames);
    assert.equal(result.ok, false, `false lock for noise seed ${seed}`);
    const preview = dsp.previewPulse(frames);
    assert.equal(preview.ok, false, `PREVIEW false lock for noise seed ${seed} (${preview.bpm} via ${preview.channel})`);
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
  assert.match(source, /analyzePulse\(frames/); // may pass a site option (e.g. wrist)
  assert.match(source, /dsp\.analyzeFace\(frames\)/);
  assert.match(source, /gp-video--face/);
  assert.match(source, /if \(canAnalyzeSignal && analysis\.ok\) \{ finish\(analysis\.bpm\)/);
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

test('production UX keeps provisional estimates stable and saves only completed readings locally', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'gaia-pulse.js'), 'utf8');
  assert.match(source, /const PULSE_HISTORY_KEY = 'gaia:pulse:readings:v1'/);
  assert.match(source, /function saveCompletedReading\(bpm, method\)/);
  assert.match(source, /function result\(card, bpm, method\) \{\s*saveCompletedReading\(bpm, method\);/);
  assert.match(source, /recent\.length >= 2 && spread <= 8/);
  assert.match(source, /last estimate, reacquiring/);
  assert.doesNotMatch(source, /else if \(bpmEl\.textContent !== '– –'\)/);
  assert.match(source, /only completed readings are saved on this device/);
  assert.match(source, /you do not need to cover the whole cluster/);
});

test('production capture calibrates stable contact before starting the clean signal window', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'gaia-pulse.js'), 'utf8');
  const dspSource = fs.readFileSync(path.join(__dirname, '..', 'gaia-pulse-dsp.js'), 'utf8');
  assert.match(source, /let contactStableSince = 0/);
  assert.match(source, /calibratingFor < 2000/);
  assert.match(source, /frames\.splice\(0, Math\.max\(0, frames\.length - 1\)\)/);
  assert.match(source, /now - contactLostSince >= 1200/);
  assert.match(source, /if \(canAnalyzeSignal && analysis\.ok\)/);
  assert.match(source, /p\/n\s+ac/);
  assert.match(dspSource, /LINEAR peak-to-floor power ratio, not dB/);
  assert.doesNotMatch(source, /sendBeacon|WebSocket|fetch\s*\(/);
});

test('production timeout starts a full bounded verification attempt after calibration', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'gaia-pulse.js'), 'utf8');
  assert.match(source, /const CLEAN_ATTEMPT_MS = 25000/);
  assert.match(source, /const HARD_STOP_MS = 60000/);
  assert.match(source, /giveupAt = Math\.min\(hardStopAt, now \+ CLEAN_ATTEMPT_MS\)/);
  assert.match(source, /giveupAt = hardStopAt/);
  assert.match(source, /timeoutNow > giveupAt \|\| timeoutNow > hardStopAt/);
  assert.doesNotMatch(source, /performance\.now\(\) - startedAt > GIVEUP_MS/);
});

/* ---- Six-channel safety suite (Phase 1A) ---------------------------------
 * The ratio channels (red-blue, green-blue, hue, gNorm) must recover genuine
 * pulses but must NOT finalise or preview on colour / white-balance / exposure
 * artifacts. Real tissue moves all channels IN PHASE with different amplitudes.
 * ------------------------------------------------------------------------ */
function synth({ bpm = 72, seconds = 16, fps = 30, seed = 3, make }) {
  const random = seededNoise(seed);
  const frames = [];
  for (let i = 0; i < fps * seconds; i += 1) {
    const t = i / fps;
    const s = Math.sin(2 * Math.PI * (bpm / 60) * t);
    const c = make(s, t);
    const n = () => random() * 1.2;
    frames.push({ t: t * 1000, r: c.r + n(), g: c.g + n(), b: c.b + n(), spatialCv: 0.05, motion: 0.004, satR: c.satR || 0 });
  }
  return frames;
}
const tissue = (s) => ({ r: 200 * (1 + 0.009 * s), g: 62 * (1 + 0.004 * s), b: 50 * (1 + 0.00025 * s) });
const ARTIFACT_RATES = [48, 72, 120, 150];

function assertRejectedBothPaths(label, frames) {
  const final = dsp.analyzePulse(frames);
  assert.equal(final.ok, false, `${label}: FINAL false lock ${final.bpm} via ${final.channel}`);
  const preview = dsp.previewPulse(frames);
  assert.equal(preview.ok, false, `${label}: PREVIEW false lock ${preview.bpm} via ${preview.channel}`);
}

test('safety: genuine pulse survives slow exposure drift and slow white-balance drift', () => {
  const drifts = [
    ['exposure', (t) => ({ k: 1 + 0.18 * Math.sin(2 * Math.PI * 0.05 * t), rb: 1 })],
    ['awb', (t) => ({ k: 1, rb: 1 + 0.06 * Math.sin(2 * Math.PI * 0.04 * t) })],
  ];
  for (const [label, drift] of drifts) {
    const frames = synth({ bpm: 75, seed: 11, make: (s, t) => { const d = drift(t); const c = tissue(s); return { r: c.r * d.k * d.rb, g: c.g * d.k, b: c.b * d.k / d.rb }; } });
    const res = dsp.analyzePulse(frames);
    assert.equal(res.ok, true, `${label}: ${res.reason}`);
    assert.ok(Math.abs(res.bpm - 75) < 3, `${label}: ${res.bpm} vs 75`);
  }
});

test('safety: red pinned at 255 by the flash still recovers via a non-red channel', () => {
  const frames = synth({ bpm: 68, seed: 5, make: (s) => ({ r: 255, g: 62 * (1 + 0.006 * s), b: 50 * (1 + 0.0005 * s), satR: 1 }) });
  const res = dsp.analyzePulse(frames);
  assert.equal(res.ok, true, res.reason);
  assert.ok(Math.abs(res.bpm - 68) < 3, `${res.bpm} vs 68`);
  assert.ok(!['red', 'redBlue', 'hue'].includes(res.channel), `used clipped-red channel ${res.channel}`);
});

test('safety: darker baseline and dropped/repeated camera frames still recover', () => {
  const dark = synth({ bpm: 82, seed: 9, make: (s) => ({ r: 120 * (1 + 0.009 * s), g: 40 * (1 + 0.004 * s), b: 30 * (1 + 0.0003 * s) }) });
  const a = dsp.analyzePulse(dark);
  assert.equal(a.ok, true, a.reason);
  assert.ok(Math.abs(a.bpm - 82) < 3, `${a.bpm} vs 82`);
  const rough = synth({ bpm: 70, seed: 13, make: (s) => tissue(s) })
    .map((f, i) => (i % 9 === 0 ? { ...f, t: f.t - 1000 / 30 } : f)) // repeated timestamp
    .filter((f, i) => i % 41 !== 0); // dropped frame
  const b = dsp.analyzePulse(rough);
  assert.equal(b.ok, true, b.reason);
  assert.ok(Math.abs(b.bpm - 70) < 3, `${b.bpm} vs 70`);
});

test('safety: recovers the fundamental despite a strong second harmonic', () => {
  const frames = synth({ bpm: 64, seed: 17, make: (s, t) => {
    const w = s + 0.6 * Math.sin(2 * Math.PI * (64 / 60) * 2 * t);
    return { r: 200 * (1 + 0.009 * w), g: 62 * (1 + 0.004 * w), b: 50 * (1 + 0.0003 * w) };
  } });
  const res = dsp.analyzePulse(frames);
  assert.equal(res.ok, true, res.reason);
  assert.ok(Math.abs(res.bpm - 64) < 3, `${res.bpm} vs 64 (harmonic confusion)`);
});

test('safety: white-balance gain redistribution cannot finalise or preview', () => {
  for (const rate of ARTIFACT_RATES) {
    assertRejectedBothPaths(`awb ${rate}`, synth({ bpm: rate, seed: rate, make: (s) => ({ r: 200 * (1 + 0.02 * s), g: 62 * (1 - 0.02 * s), b: 50 * (1 - 0.03 * s) }) }));
  }
});

test('safety: red clipped with oscillating green/blue cannot finalise or preview', () => {
  for (const rate of ARTIFACT_RATES) {
    assertRejectedBothPaths(`clipped ${rate}`, synth({ bpm: rate, seed: rate + 1, make: (s) => ({ r: 255, g: 60 * (1 + 0.04 * s), b: 55 * (1 - 0.04 * s), satR: 1 }) }));
  }
});

test('safety: hue rotation and alternating colour temperature cannot finalise or preview', () => {
  for (const rate of [60, 90, 150]) {
    assertRejectedBothPaths(`hue ${rate}`, synth({ bpm: rate, seed: rate + 2, make: (s) => ({ r: 200 - 3 * s, g: 60 + 2 * s, b: 55 + s }) }));
    assertRejectedBothPaths(`colourtemp ${rate}`, synth({ bpm: rate, seed: rate + 3, make: (s) => { const sq = s >= 0 ? 1 : -1; return { r: 200 * (1 + 0.015 * sq), g: 62, b: 50 * (1 - 0.02 * sq) }; } }));
  }
});

test('safety: rhythmic pressure (all channels scaled together) cannot finalise or preview', () => {
  for (const rate of ARTIFACT_RATES) {
    assertRejectedBothPaths(`pressure ${rate}`, synth({ bpm: rate, seed: rate + 4, make: (s) => ({ r: 200 * (1 + 0.012 * s), g: 62 * (1 + 0.012 * s), b: 50 * (1 + 0.012 * s) }) }));
  }
});

test('safety: fingertip paths classify every candidate, and ratio winners need raw confirmation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'gaia-pulse-dsp.js'), 'utf8');
  assert.match(src, /classifyArtifact\(uniform, uniform\.fps, est\.bpm\)/);
  assert.match(src, /RATIO_CHANNELS\.includes\(name\) && !rawConfirms/);
  assert.match(src, /peakTimingEstimate\(chosen\.filtered/);
  assert.match(src, /uniform\.duration < 14\.5/);
});

test('safety: face path cannot finalise or preview on a white-balance colour swing', () => {
  for (const rate of [60, 80, 120]) {
    const random = seededNoise(rate);
    const frames = [];
    for (let i = 0; i < 30 * 13; i += 1) {
      const t = i / 30; const s = Math.sin(2 * Math.PI * (rate / 60) * t);
      const n = () => random() * 0.4;
      // face-like skin, NO pulse: red up while blue down (AWB gain redistribution)
      frames.push({ t: t * 1000, r: 154 * (1 + 0.012 * s) + n(), g: 121 + n(), b: 91 * (1 - 0.014 * s) + n(), spatialCv: 0.12, motion: 0.004 });
    }
    const preview = dsp.previewFace(frames);
    assert.equal(preview.ok, false, `face PREVIEW false lock at ${rate}: ${preview.bpm} via ${preview.channel}`);
    const final = dsp.analyzeFace(frames);
    assert.equal(final.ok, false, `face FINAL false lock at ${rate}: ${final.bpm} via ${final.channel}`);
  }
});

test('safety: sustained guarded previews can form a narrow consensus', () => {
  const samples = [107, 108, 109, 108, 107, 109, 108, 108]
    .map((bpm, index) => ({ bpm, at: index * 750, channel: 'gNorm' }));
  const result = dsp.previewConsensus(samples);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.bpm, 108);
  assert.equal(result.samples, 8);
});

test('safety: preview consensus rejects short, scattered, or interrupted runs', () => {
  const stable = [107, 108, 109, 108, 107, 109, 108, 108]
    .map((bpm, index) => ({ bpm, at: index * 750 }));
  assert.equal(dsp.previewConsensus(stable.slice(1)).ok, false, 'accepted only seven previews');
  assert.equal(dsp.previewConsensus(stable.map((sample, index) => ({ ...sample, bpm: index === 4 ? 116 : sample.bpm }))).ok, false, 'accepted wide BPM spread');
  assert.equal(dsp.previewConsensus(stable.map((sample, index) => ({ ...sample, at: index < 4 ? sample.at : sample.at + 1500 }))).ok, false, 'accepted interrupted previews');
});

test('safety: consensus fallback is limited to the full-window weak-signal path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'gaia-pulse.js'), 'utf8');
  assert.match(src, /elapsedSignal >= 14\.5/);
  assert.match(src, /analysis\.reason === 'weak_or_irregular_signal'/);
  assert.match(src, /analysis\.contact && analysis\.contact\.valid && previewAgreement\.ok/);
  assert.match(src, /consensusSamples = \[\];/);
});
