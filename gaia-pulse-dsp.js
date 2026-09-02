/** Gaia Pulse DSP — deterministic, fail-closed camera PPG analysis.
 * Browser global: window.GaiaPulseDSP. The file intentionally has no DOM or
 * camera dependency so the exact production algorithm can run in Node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GaiaPulseDSP = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_BPM = 40;
  const MAX_BPM = 180;

  function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }
  function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
  function standardDeviation(values) {
    if (!values.length) return 0;
    const average = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
  }

  // Measures local high-frequency variation, not the overall light gradient.
  // Palm skin lit by a nearby flash often has a bright hotspot and dark edge;
  // global variance mistakes that smooth gradient for scene detail. Adjacent
  // block differences preserve the useful "is this a textured scene?" signal.
  function spatialTexture(grid, width = 8, height = 8) {
    if (!Array.isArray(grid) || grid.length < width * height) return 1;
    const diffs = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = Number(grid[y * width + x]) || 0;
        if (x) diffs.push(Math.abs(value - (Number(grid[y * width + x - 1]) || 0)));
        if (y) diffs.push(Math.abs(value - (Number(grid[(y - 1) * width + x]) || 0)));
      }
    }
    return mean(diffs) / Math.max(1, mean(grid));
  }

  function biquad(values, type, cutoff, fps, q = 0.707) {
    const w0 = 2 * Math.PI * cutoff / fps;
    const cosine = Math.cos(w0);
    const sine = Math.sin(w0);
    const alpha = sine / (2 * q);
    const a0 = 1 + alpha;
    const a1 = -2 * cosine / a0;
    const a2 = (1 - alpha) / a0;
    let b0; let b1; let b2;
    if (type === 'highpass') {
      b0 = ((1 + cosine) / 2) / a0;
      b1 = (-(1 + cosine)) / a0;
      b2 = b0;
    } else {
      b0 = ((1 - cosine) / 2) / a0;
      b1 = (1 - cosine) / a0;
      b2 = b0;
    }
    const output = new Array(values.length);
    let x1 = values[0] || 0; let x2 = x1; let y1 = 0; let y2 = 0;
    for (let i = 0; i < values.length; i += 1) {
      const x = values[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      output[i] = y;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
    }
    return output;
  }

  function bandpass(values, fps) {
    if (values.length < 4 || fps < 12) return [];
    let filtered = biquad(values, 'highpass', 0.6, fps);
    filtered = biquad(filtered, 'lowpass', 3.5, fps);
    const warmup = Math.min(filtered.length - 1, Math.round(fps * 0.5));
    return filtered.slice(warmup);
  }

  function normalized(values) {
    const average = mean(values);
    const deviation = standardDeviation(values) || 1e-9;
    return values.map((value) => (value - average) / deviation);
  }

  function powerAtBpm(values, fps, bpm) {
    const frequency = bpm / 60;
    let real = 0; let imaginary = 0;
    const n = values.length;
    for (let i = 0; i < n; i += 1) {
      const window = n > 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) : 1;
      const angle = 2 * Math.PI * frequency * i / fps;
      real += values[i] * window * Math.cos(angle);
      imaginary -= values[i] * window * Math.sin(angle);
    }
    return (real * real + imaginary * imaginary) / Math.max(1, n * n);
  }

  function spectralEstimate(filtered, fps) {
    if (filtered.length < fps * 4) return null;
    const signal = normalized(filtered);
    const bins = [];
    for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.5) bins.push({ bpm, power: powerAtBpm(signal, fps, bpm) });
    let peak = bins.reduce((best, item) => item.power > best.power ? item : best, bins[0]);
    // A pulse waveform often has a strong second harmonic. Prefer a plausible
    // fundamental at half the peak only when it has substantial independent power.
    if (peak.bpm >= 80) {
      const half = bins.reduce((best, item) => Math.abs(item.bpm - peak.bpm / 2) < Math.abs(best.bpm - peak.bpm / 2) ? item : best, bins[0]);
      if (half.bpm >= MIN_BPM && half.power >= peak.power * 0.32) peak = half;
    }
    const floor = median(bins.filter((item) => Math.abs(item.bpm - peak.bpm) > 8
      && Math.abs(item.bpm - peak.bpm * 2) > 8).map((item) => item.power)) || 1e-12;
    // `snr` is deliberately a LINEAR peak-to-floor power ratio, not dB.
    // Thresholds such as 3.2 must therefore never be described or tuned as
    // "3.2 dB" (which would be a different value and acceptance boundary).
    return { bpm: peak.bpm, power: peak.power, snr: peak.power / floor, signal };
  }

  function autocorrelationEstimate(filtered, fps, targetBpm) {
    if (filtered.length < fps * 4) return null;
    const signal = normalized(filtered);
    const minLag = Math.max(2, Math.floor(fps * 60 / MAX_BPM));
    const maxLag = Math.min(signal.length - 2, Math.ceil(fps * 60 / MIN_BPM));
    const candidates = [];
    const acf = new Array(maxLag + 2).fill(0);
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let sum = 0;
      for (let i = 0; i + lag < signal.length; i += 1) sum += signal[i] * signal[i + lag];
      acf[lag] = sum / (signal.length - lag);
    }
    for (let lag = minLag + 1; lag < maxLag; lag += 1) {
      if (acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1] && acf[lag] > 0) {
        let refinedLag = lag;
        const denominator = acf[lag - 1] - 2 * acf[lag] + acf[lag + 1];
        if (denominator) refinedLag += 0.5 * (acf[lag - 1] - acf[lag + 1]) / denominator;
        candidates.push({ bpm: 60 * fps / refinedLag, quality: acf[lag] });
      }
    }
    if (!candidates.length) return null;
    // The spectral estimate disambiguates fundamental vs harmonic; never choose
    // a peak merely because it is the first/smallest lag.
    candidates.sort((a, b) => {
      const distance = Math.abs(a.bpm - targetBpm) - Math.abs(b.bpm - targetBpm);
      return distance || b.quality - a.quality;
    });
    return candidates[0];
  }

  function interpolate(left, right, t, key) {
    if (right.t <= left.t) return Number(left[key]) || 0;
    const ratio = (t - left.t) / (right.t - left.t);
    return (Number(left[key]) || 0) + ((Number(right[key]) || 0) - (Number(left[key]) || 0)) * ratio;
  }

  function resampleUniform(inputFrames, maxSeconds = 15) {
    const frames = inputFrames.filter((frame) => frame && Number.isFinite(frame.t)
      && Number.isFinite(frame.r) && Number.isFinite(frame.g) && Number.isFinite(frame.b))
      .sort((a, b) => a.t - b.t)
      .filter((frame, index, rows) => !index || frame.t > rows[index - 1].t);
    if (frames.length < 8) return null;
    const end = frames[frames.length - 1].t;
    const startLimit = end - maxSeconds * 1000;
    const kept = frames.filter((frame) => frame.t >= startLimit);
    if (kept.length < 8) return null;
    const deltas = [];
    for (let i = 1; i < kept.length; i += 1) {
      const delta = kept[i].t - kept[i - 1].t;
      if (delta > 4 && delta < 250) deltas.push(delta);
    }
    const step = median(deltas);
    if (!step) return null;
    const measuredFps = 1000 / step;
    const fps = clamp(measuredFps, 15, 60);
    const gridStep = 1000 / fps;
    const start = kept[0].t;
    const result = { r: [], g: [], b: [], fps, measuredFps, duration: (end - start) / 1000 };
    let cursor = 1;
    for (let t = start; t <= end; t += gridStep) {
      while (cursor < kept.length && kept[cursor].t < t) cursor += 1;
      if (cursor >= kept.length) break;
      const left = kept[Math.max(0, cursor - 1)];
      const right = kept[cursor];
      result.r.push(interpolate(left, right, t, 'r'));
      result.g.push(interpolate(left, right, t, 'g'));
      result.b.push(interpolate(left, right, t, 'b'));
    }
    return result;
  }

  function contactMetrics(frames, options = {}) {
    // Reflectance off the volar wrist (over the radial artery) is dimmer and much
    // less red-saturated than a torch-lit fingertip, so the wrist relaxes the
    // colour/saturation part of the contact gate. Spatial uniformity, motion and
    // the downstream cross-channel/agreement/stability checks still hold.
    const wrist = options.site === 'wrist';
    const recent = frames.slice(-Math.min(frames.length, 180));
    if (!recent.length) return { valid: false, reason: 'no_frames', score: 0 };
    let contactFrames = 0;
    const brightness = []; const redRatios = []; const textures = []; const motions = [];
    const greens = []; const clips = []; // per-pixel red-saturation fraction (0..1), if the capture reports it
    recent.forEach((frame) => {
      const bright = (frame.r + frame.g + frame.b) / 3;
      greens.push(frame.g); clips.push(Number.isFinite(frame.satR) ? frame.satR : 0);
      const maxChannel = Math.max(frame.r, frame.g, frame.b, 1);
      const minChannel = Math.min(frame.r, frame.g, frame.b);
      const redRatio = frame.r / Math.max(1, frame.g + frame.b);
      const saturation = (maxChannel - minChannel) / maxChannel;
      const texture = Number.isFinite(frame.spatialCv) ? frame.spatialCv : 1;
      const motion = Number.isFinite(frame.motion) ? frame.motion : 1;
      brightness.push(bright); redRatios.push(redRatio); textures.push(texture); motions.push(motion);
      // iPhone auto-white-balance can make torch-lit skin yellow/pink
      // rather than strongly red. Keep the gate tolerant to that variation;
      // spatial uniformity, motion and the later cross-channel DSP still reject
      // ordinary scenes and rhythmic whole-frame movement.
      if (bright >= 10 && bright <= 253 && frame.r >= frame.g * (wrist ? 0.85 : 0.96) && frame.r >= frame.b * (wrist ? 1.0 : 1.08)
        && saturation >= (wrist ? 0.03 : 0.06) && texture <= 0.42 && motion <= 0.16) contactFrames += 1;
    });
    const fraction = contactFrames / recent.length;
    const metrics = {
      fraction,
      brightness: median(brightness),
      redRatio: median(redRatios),
      spatialCv: median(textures),
      motion: median(motions),
      greenMedian: median(greens),
      redClip: median(clips),
    };
    let reason = '';
    if (metrics.brightness < 10) reason = 'too_dark';
    else if (metrics.brightness > 253) reason = 'overexposed';
    // Flash can pin the red channel at 255 (no usable AC) while the mean brightness
    // still looks fine. If green is blown too, nothing is recoverable.
    else if (metrics.redClip > 0.5 && metrics.greenMedian > 248) reason = 'clipped';
    else if (metrics.redRatio < (wrist ? 0.40 : 0.46)) reason = 'no_finger_contact';
    else if (metrics.spatialCv > 0.42) reason = 'scene_texture';
    else if (metrics.motion > 0.16) reason = 'motion';
    else if (fraction < 0.6) reason = 'unstable_contact';
    // A graded score makes the live meter react while the user is finding the
    // active lens. Passing BPM remains fail-closed on every binary gate above.
    const exposureScore = clamp((metrics.brightness - 6) / 28, 0, 1)
      * clamp((255 - metrics.brightness) / 20, 0, 1);
    const colorScore = clamp((metrics.redRatio - (wrist ? 0.30 : 0.36)) / 0.28, 0, 1);
    const textureScore = clamp((0.56 - metrics.spatialCv) / 0.4, 0, 1);
    const motionScore = clamp((0.23 - metrics.motion) / 0.2, 0, 1);
    const fractionScore = clamp((fraction - 0.2) / 0.65, 0, 1);
    const score = clamp(0.2 * exposureScore + 0.3 * colorScore + 0.2 * textureScore
      + 0.15 * motionScore + 0.15 * fractionScore, 0, 1);
    return { valid: !reason, reason, score, ...metrics };
  }

  function estimateChannel(values, fps, thresholds = {}) {
    const average = mean(values);
    if (!average) return null;
    const relative = values.map((value) => value / average - 1);
    const filtered = bandpass(relative, fps);
    if (filtered.length < fps * 4) return null;
    const pulsatility = standardDeviation(filtered);
    if (pulsatility < 0.00015 || pulsatility > 0.12) return null;
    const spectral = spectralEstimate(filtered, fps);
    const minSnr = Number.isFinite(thresholds.minSnr) ? thresholds.minSnr : 3.2;
    const minAutocorrelation = Number.isFinite(thresholds.minAutocorrelation) ? thresholds.minAutocorrelation : 0.38;
    if (!spectral || spectral.snr < minSnr) return null;
    const autocorrelation = autocorrelationEstimate(filtered, fps, spectral.bpm);
    if (autocorrelation && autocorrelation.quality >= minAutocorrelation) {
      const agreement = Math.abs(spectral.bpm - autocorrelation.bpm);
      if (agreement > 5) return null;
      return {
        bpm: (spectral.bpm + autocorrelation.bpm) / 2,
        spectralBpm: spectral.bpm,
        autocorrelationBpm: autocorrelation.bpm,
        spectralSnr: spectral.snr,
        autocorrelationQuality: autocorrelation.quality,
        pulsatility,
        filtered,
        power: spectral.power,
        score: Math.min(20, spectral.snr) * autocorrelation.quality,
      };
    }
    // iOS Safari's temporal noise reduction and tone mapping preserve the pulse
    // FREQUENCY while erasing cycle-to-cycle shape: on a real iPhone (18.7,
    // Back Triple Camera) every channel measured autocorrelation quality
    // 0.002-0.14 — an order of magnitude below any usable bar — with the only
    // remaining peak at the 40 BPM band edge. Discarding the channel there made
    // the verifier fail closed 100% of the time on iOS. Instead expose the
    // spectral estimate as a frequency-only candidate (spectralOnly); callers
    // must then corroborate it with raw-tissue confirmation, beat-count
    // agreement and independent half-window estimates before it can finalise
    // or preview. Shape-verified candidates keep every original gate.
    return {
      bpm: spectral.bpm,
      spectralBpm: spectral.bpm,
      autocorrelationBpm: autocorrelation ? autocorrelation.bpm : null,
      autocorrelationQuality: autocorrelation ? autocorrelation.quality : null,
      spectralSnr: spectral.snr,
      pulsatility,
      filtered,
      power: spectral.power,
      score: Math.min(20, spectral.snr) * 0.45,
      spectralOnly: true,
    };
  }

  function differentialChannel(primary, reference) {
    const primaryMean = mean(primary);
    const referenceMean = mean(reference);
    if (!primaryMean || !referenceMean || primary.length !== reference.length) return [];
    // Keep a positive baseline because estimateChannel works in relative units.
    return primary.map((value, index) => 1 + value / primaryMean - reference[index] / referenceMean);
  }

  // HSV hue of an (r,g,b) mean, 0..1. Hue barely moves with overall brightness,
  // so on iOS Safari — where we cannot lock exposure the way a native app does —
  // the hue of the torch-lit fingertip carries the pulse even while auto-exposure
  // swings the raw intensity. (Technique from isahutch/bpm_from_camera.)
  function rgbToHue(r, g, b) {
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn;
    if (d < 1e-6) return 0;
    let h;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6; if (h < 0) h += 1;
    return h;
  }
  // Continuous (phase-unwrapped) hue series, so a hue that sits near the red 0/1
  // boundary doesn't produce fake jumps.
  function hueSeries(rArr, gArr, bArr) {
    const n = rArr.length; if (n < 2) return [];
    const out = new Array(n); let prev = rgbToHue(rArr[0], gArr[0], bArr[0]); out[0] = prev;
    for (let i = 1; i < n; i++) {
      const raw = rgbToHue(rArr[i], gArr[i], bArr[i]);
      let dd = raw - prev; if (dd > 0.5) dd -= 1; else if (dd < -0.5) dd += 1;
      out[i] = out[i - 1] + dd; prev = raw;
    }
    return out;
  }

  function channelCandidates(uniform, thresholds) {
    const red = estimateChannel(uniform.r, uniform.fps, thresholds);
    const green = estimateChannel(uniform.g, uniform.fps, thresholds);
    const redBlueValues = differentialChannel(uniform.r, uniform.b);
    const greenBlueValues = differentialChannel(uniform.g, uniform.b);
    const hueValues = hueSeries(uniform.r, uniform.g, uniform.b);
    // Normalised green = G/(R+G+B): a global exposure/gain change scales R,G,B
    // together and cancels in the ratio, so this survives Safari's auto-exposure.
    const gNormValues = uniform.g.map((g, i) => g / Math.max(1, uniform.r[i] + g + uniform.b[i]));
    const redBlue = redBlueValues.length ? estimateChannel(redBlueValues, uniform.fps, thresholds) : null;
    const greenBlue = greenBlueValues.length ? estimateChannel(greenBlueValues, uniform.fps, thresholds) : null;
    const hue = hueValues.length ? estimateChannel(hueValues, uniform.fps, thresholds) : null;
    const gNorm = gNormValues.length ? estimateChannel(gNormValues, uniform.fps, thresholds) : null;
    return {
      red,
      green,
      redBlue,
      greenBlue,
      hue,
      gNorm,
      values: { red: uniform.r, green: uniform.g, redBlue: redBlueValues, greenBlue: greenBlueValues, hue: hueValues, gNorm: gNormValues },
      ranked: [['red', red], ['green', green], ['redBlue', redBlue], ['greenBlue', greenBlue], ['hue', hue], ['gNorm', gNorm]]
        .filter((entry) => entry[1]).sort((a, b) => b[1].score - a[1].score),
    };
  }

  /* ---- Safety layer -------------------------------------------------------
   * Closes the ratio-channel false-lock path: a colour/white-balance swing with
   * red pinned by the flash could win via green-blue/hue/gNorm and skip the
   * artifact check that only covered raw red/green. Every winner now passes a
   * physiological classifier, ratio winners need raw-tissue confirmation, a
   * third (time-domain) estimator must agree, and stability uses two
   * NON-overlapping windows over 10 s. A strong blue channel is NOT by itself
   * treated as an artifact — blue can carry a genuine pulse on some phones.
   * ----------------------------------------------------------------------- */
  const RATIO_CHANNELS = ['redBlue', 'greenBlue', 'hue', 'gNorm'];

  // Spectral power of `values` at `bpm` versus the median power across the
  // heart-rate band ("local SNR"). Lets a raw channel confirm a candidate rate
  // even when a larger exposure component dominates that channel's own peak.
  function bandPowerAt(values, fps, bpm) {
    const average = mean(values);
    if (!average) return { snr: 0 };
    const filtered = bandpass(values.map((value) => value / average - 1), fps);
    if (filtered.length < fps * 4) return { snr: 0 };
    const signal = normalized(filtered);
    const bins = [];
    for (let candidate = MIN_BPM; candidate <= MAX_BPM; candidate += 1) bins.push(powerAtBpm(signal, fps, candidate));
    const floor = median(bins) || 1e-12;
    return { snr: powerAtBpm(signal, fps, bpm) / floor, filtered };
  }

  // Classify raw R,G,B behaviour in the pulse band. Tissue pulse: the channels
  // move IN PHASE with DIFFERENT relative amplitudes (haemoglobin absorbs each
  // wavelength differently). Global exposure/gain or light flicker: in phase
  // with near-EQUAL amplitudes. Auto-white-balance gain redistribution: channels
  // move in OPPOSITE directions. Only the last two are rejected.
  function classifyArtifact(uniform, fps, bpm) {
    // Narrow-band projection AT the candidate rate, so an unrelated exposure
    // component at another frequency cannot dominate the verdict. A channel only
    // "counts" when its component at the rate stands clear of its OWN noise
    // floor (local SNR) — otherwise the noise phase of a dim channel (blue) can
    // masquerade as an anti-phase partner and mislabel a real pulse.
    const ch = ['r', 'g', 'b'].map((key) => {
      const p = projectAt(uniform[key], fps, bpm);
      const { snr } = bandPowerAt(uniform[key], fps, bpm);
      // Live bar sits BELOW the most lenient candidate threshold (preview 2.2),
      // so no candidate can exist in a window the classifier cannot see.
      return { amp: p.amp, phase: p.phase, live: p.amp > 0.0006 && snr >= 2.0 };
    });
    const dphase = (a, b) => { const d = Math.abs(a.phase - b.phase) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
    const pairs = [[0, 1], [1, 2], [0, 2]];
    for (const [i, j] of pairs) {
      if (ch[i].live && ch[j].live && dphase(ch[i], ch[j]) > 2.4) return 'awb_artifact';
    }
    const amps = ch.map((c) => c.amp);
    // Two common-mode signatures, both in phase across R,G,B:
    //  - multiplicative gain / exposure / flicker: equal RELATIVE amplitudes;
    //  - additive light leak / sensor offset: equal ABSOLUTE amplitudes (which
    //    look UNequal in relative terms — largest on the dimmest channel).
    // A tissue pulse has wildly unequal absolute amplitudes (r >> g >> b).
    const absAmps = ch.map((c, k) => c.amp * mean(uniform[['r', 'g', 'b'][k]]));
    // Judge whichever channels are live (>= 2) — a dim channel dropping below
    // the SNR bar must not switch the common-mode check off.
    const live = ch.map((c, k) => (c.live ? k : -1)).filter((k) => k >= 0);
    if (live.length >= 2) {
      const livePairs = pairs.filter(([i, j]) => ch[i].live && ch[j].live);
      const inPhase = livePairs.every(([i, j]) => dphase(ch[i], ch[j]) < 0.9);
      const rel = live.map((k) => amps[k]); const abs = live.map((k) => absAmps[k]);
      if (inPhase && (Math.max(...rel) / Math.min(...rel) < 1.3
        || Math.max(...abs) / Math.min(...abs) < 1.3)) return 'common_mode_artifact';
    }
    return null;
  }

  // A ratio-derived channel may propose a rate but may not finalise alone: at
  // least one unclipped RAW channel must carry energy at that rate.
  // Narrow-band amplitude (relative units) and phase of `values` at `bpm`.
  function projectAt(values, fps, bpm) {
    const average = mean(values); if (!average) return { amp: 0, phase: 0 };
    const f = bpm / 60; const n = values.length; let inPhase = 0; let quadrature = 0;
    for (let i = 0; i < n; i += 1) {
      const x = values[i] / average - 1; const w = 2 * Math.PI * f * i / fps;
      inPhase += x * Math.cos(w); quadrature += x * Math.sin(w);
    }
    inPhase *= 2 / n; quadrature *= 2 / n;
    return { amp: Math.hypot(inPhase, quadrature), phase: Math.atan2(quadrature, inPhase) };
  }

  function rawConfirms(uniform, bpm, redClipped) {
    // A raw channel confirms only if it carries a MEANINGFUL amplitude at the
    // rate (a real tissue pulse is >= ~0.06 % relative) AND that component
    // stands clear of the band's noise floor. Noise alone can clear a bare
    // local-SNR bar, which is how a noise-only ratio channel previewed a fake.
    const keys = redClipped ? ['g', 'b'] : ['r', 'g', 'b'];
    let best = { snr: 0, amp: 0 };
    for (const key of keys) {
      const { snr, filtered } = bandPowerAt(uniform[key], uniform.fps, bpm);
      const { amp } = projectAt(uniform[key], uniform.fps, bpm);
      // Spectral concentration: a genuine periodic component projects to many
      // times the projection that pure noise of the same power would give
      // (std * sqrt(2/n)). Noise sits at ~1x, so chance alignment can't confirm.
      const noiseProjection = filtered && filtered.length ? standardDeviation(filtered) * Math.sqrt(2 / filtered.length) : Infinity;
      if (amp >= 0.0006 && amp >= 3 * noiseProjection && snr >= 2.5 && snr > best.snr) best = { snr, amp };
    }
    return { confirmed: best.snr > 0, snr: best.snr, amp: best.amp };
  }

  // A frequency-only candidate may not stand alone: at least two OTHER usable
  // channels' spectral peaks must land within `tolerance` BPM of it. The
  // max-energy bin of pure noise does not coincide across differently-constructed
  // channels, while every real-device diagnostic with unusable autocorrelation
  // still showed 2-4 channels agreeing on the true rate (e.g. green 73.5,
  // blue 73.5, hue 72). Corroborators may themselves carry an artifact flag —
  // a flag means "cannot be the WINNER", not "wrong about the rate" — because
  // the candidate itself has already passed the classifier at this rate.
  function spectralConsensus(channels, name, bpm, tolerance = 6) {
    let agreeing = 0;
    for (const [other, est] of channels.ranked) {
      if (other !== name && est && Math.abs(est.bpm - bpm) <= tolerance) agreeing += 1;
    }
    return agreeing >= 2;
  }

  // Third, time-domain estimator independent of the FFT/autocorrelation pair:
  // adaptive-threshold peak picking with a 0.3 s refractory, then inter-beat
  // regularity and agreement with the candidate rate.
  function peakTimingEstimate(filtered, fps, candidateBpm) {
    if (!filtered || filtered.length < fps * 4) return null;
    // Light smoothing (~0.13 s, like the 5-sample window in isahutch/bpm_from_
    // camera) so per-sample noise doesn't spawn false peaks; a pulse's >= 0.3 s
    // period is untouched.
    const win = Math.max(2, Math.round(fps * 0.13));
    const smooth = new Array(filtered.length); let acc = 0;
    for (let i = 0; i < filtered.length; i += 1) { acc += filtered[i]; if (i >= win) acc -= filtered[i - win]; smooth[i] = acc / Math.min(i + 1, win); }
    const rms = Math.sqrt(mean(smooth.map((value) => value * value))) || 1e-9;
    const threshold = 0.25 * rms; const refractory = Math.round(fps * 0.3);
    const peaks = [];
    for (let i = 1; i < smooth.length - 1; i += 1) {
      if (smooth[i] > threshold && smooth[i] >= smooth[i - 1] && smooth[i] > smooth[i + 1]
        && (!peaks.length || i - peaks[peaks.length - 1] >= refractory)) peaks.push(i);
    }
    const expected = (smooth.length / fps) * candidateBpm / 60;
    if (peaks.length < Math.max(4, Math.floor(expected * 0.6))) return { ok: false, beats: peaks.length };
    const ibis = []; for (let i = 1; i < peaks.length; i += 1) ibis.push(peaks[i] - peaks[i - 1]);
    const cv = standardDeviation(ibis) / (mean(ibis) || 1);
    const bpm = 60 * fps / (median(ibis) || 1);
    return { ok: cv < 0.35 && Math.abs(bpm - candidateBpm) <= 8, bpm, beats: peaks.length, cv };
  }

  // Time-domain corroboration for frequency-only candidates. Autocorrelation
  // compares waveform SHAPE cycle-to-cycle, which iOS smoothing destroys, but
  // simply COUNTING peaks survives it. The number of beats observed in the
  // window must plausibly match the claimed rate: 18 beats in 15 s cannot
  // belong to a 58 BPM claim, so an in-band wander peak riding a real 72 BPM
  // waveform is rejected by the evidence of its own channel.
  function beatCountCorroborates(filtered, fps, bpm) {
    const timing = peakTimingEstimate(filtered, fps, bpm);
    if (!timing) return false;
    const durationS = filtered.length / fps;
    const expected = durationS * bpm / 60;
    if (timing.beats < Math.max(4, Math.floor(expected * 0.6))) return false;
    const countBpm = (timing.beats / durationS) * 60;
    return Math.abs(countBpm - bpm) <= 10;
  }

  // Two NON-overlapping ~5 s segments over a 10 s capture must independently
  // support the same rate. This keeps the safety check independent while making
  // a handheld capture achievable; the artifact, dual-estimator and beat-timing
  // gates above remain unchanged. A shape-verified winner requires
  // shape-verified segments; a frequency-only winner accepts either, because
  // the halves of an iOS-smoothed window are smoothed too.
  function segmentEstimates(values, fps, thresholds, requireStrict) {
    const segmentLength = Math.floor(values.length / 2);
    if (segmentLength < fps * 4) return [];
    return [0, 1].map((k) => estimateChannel(values.slice(k * segmentLength, (k + 1) * segmentLength), fps, thresholds))
      .filter(Boolean).filter((estimate) => (requireStrict ? !estimate.spectralOnly : true));
  }

  function analyzePulse(frames, options = {}) {
    // options.site === 'wrist' relaxes the contact colour gate and the channel
    // SNR/autocorrelation thresholds for the dimmer volar-wrist reflectance
    // signal. With no options the behaviour is identical to before (fingertip).
    const thresholds = options.thresholds
      || (options.site === 'wrist' ? { minSnr: 2.8, minAutocorrelation: 0.34 } : undefined);
    const contact = contactMetrics(frames, options);
    if (!contact.valid) return { ok: false, reason: contact.reason, contact };
    const uniform = resampleUniform(frames, 10);
    // ECG-referenced smartphone PPG datasets include 10 s recordings. Require
    // the full practical window (~9.97 s at 30 fps), then verify two separate
    // halves rather than asking a handheld user to remain perfect for 15 s.
    if (!uniform || uniform.duration < 9.5) return { ok: false, reason: 'need_more', contact, duration: uniform ? uniform.duration : 0 };
    const redClipped = contact.redClip > 0.5;
    const channels = channelCandidates(uniform, thresholds);
    const { red, green } = channels;
    // A red channel pinned at 255 has no real AC; anything derived from it is unusable.
    const candidates = channels.ranked.filter(([name]) => !(redClipped && (name === 'red' || name === 'redBlue' || name === 'hue')));
    if (!candidates.length) return { ok: false, reason: 'weak_or_irregular_signal', contact, fps: uniform.measuredFps };
    // Tone-mapped iOS video can leave raw red's SPECTRAL peak off the true rate
    // while its beats stay on it (diagnostic: red FFT 58.5 vs 18 beats/15 s =
    // 72 BPM). With frequency-only candidates the per-candidate walk below
    // corroborates each rate individually, so the blunt red-vs-green guard
    // applies only when both raw channels are shape-verified.
    if (!redClipped && red && green && !red.spectralOnly && !green.spectralOnly
      && red.score >= candidates[0][1].score * 0.65
      && green.score >= candidates[0][1].score * 0.65 && Math.abs(red.bpm - green.bpm) > 7) {
      return { ok: false, reason: 'channel_disagreement', contact, fps: uniform.measuredFps };
    }
    // Walk candidates in rank order. Each is classified AT ITS OWN rate, so an
    // exposure artifact that tops the ranking (e.g. green@90) is skipped and a
    // genuine pulse carried by an exposure-cancelling channel (e.g. red-blue@72)
    // can still be chosen — while every candidate individually must pass the
    // classifier, ratio-confirmation, timing and stability gates below. A
    // frequency-only candidate must ALSO be raw-confirmed in tissue, backed by
    // at least two other channels' spectral peaks, and carry a beat count
    // matching its claimed rate, since its autocorrelation corroboration does
    // not exist on smoothed iOS video. A shape-verified candidate that fails
    // its own beat-timing check is skipped, not fatal — one channel's
    // irregularity does not veto a corroborated sibling.
    let chosenEntry = null; let firstRejection = null;
    for (const entry of candidates) {
      const [name, est] = entry;
      const artifact = classifyArtifact(uniform, uniform.fps, est.bpm);
      if (artifact) { if (!firstRejection) firstRejection = artifact; continue; }
      if (RATIO_CHANNELS.includes(name) && !rawConfirms(uniform, est.bpm, redClipped).confirmed) {
        if (!firstRejection) firstRejection = 'ratio_unconfirmed'; continue;
      }
      if (est.spectralOnly && !rawConfirms(uniform, est.bpm, redClipped).confirmed) {
        if (!firstRejection) firstRejection = 'unconfirmed'; continue;
      }
      if (est.spectralOnly && !spectralConsensus(channels, name, est.bpm)) {
        if (!firstRejection) firstRejection = 'no_spectral_consensus'; continue;
      }
      if (est.spectralOnly && !beatCountCorroborates(est.filtered, uniform.fps, est.bpm)) {
        if (!firstRejection) firstRejection = 'beat_count_mismatch'; continue;
      }
      if (!est.spectralOnly && !peakTimingEstimate(est.filtered, uniform.fps, est.bpm).ok) {
        if (!firstRejection) firstRejection = 'irregular_beats'; continue;
      }
      chosenEntry = entry; break;
    }
    if (!chosenEntry) return { ok: false, reason: firstRejection || 'weak_or_irregular_signal', contact, fps: uniform.measuredFps };
    const [channel, chosen] = chosenEntry;
    // Independent time-domain check for shape-verified candidates (re-checked
    // here for the peak-rate readout; the walk above already enforced it). A
    // frequency-only winner cannot rely on beat-to-beat regularity (iOS
    // smoothing destroys cycle shape); its time-domain evidence is the beat
    // COUNT from the walk plus the two independent half-window rates below.
    let peakBpm = null;
    if (!chosen.spectralOnly) {
      const timing = peakTimingEstimate(chosen.filtered, uniform.fps, chosen.bpm);
      if (!timing || !timing.ok) return { ok: false, reason: 'irregular_beats', contact, fps: uniform.measuredFps };
      peakBpm = timing.bpm;
    }
    const channelValues = channels.values[channel];
    const segments = segmentEstimates(channelValues, uniform.fps, thresholds, !chosen.spectralOnly);
    if (segments.length < 2) return { ok: false, reason: 'need_more_stability', contact, fps: uniform.measuredFps };
    const segmentBpms = segments.map((item) => item.bpm);
    // A frequency-only winner's half-window FFTs are noisier than a
    // shape-verified waveform's (that is exactly why autocorrelation failed),
    // so the inter-half spread bar matches that estimator's variance.
    if (Math.max(...segmentBpms) - Math.min(...segmentBpms) > (chosen.spectralOnly ? 10 : 7)
      || (chosen.spectralOnly && segmentBpms.some((value) => Math.abs(value - chosen.bpm) > 10))) {
      return { ok: false, reason: 'unstable_rate', contact, fps: uniform.measuredFps };
    }
    const bpm = median([chosen.bpm, ...segmentBpms]);
    // Frequency-only confirmation is honest but weaker evidence than a
    // shape-verified waveform: the quality score reflects that, and the result
    // names the estimator used.
    const quality = chosen.spectralOnly
      ? clamp(0.4 * contact.score + 0.6 * clamp((chosen.spectralSnr - 3) / 9, 0, 1), 0, 0.7)
      : clamp(0.35 * contact.score
        + 0.35 * clamp((chosen.autocorrelationQuality - 0.35) / 0.55, 0, 1)
        + 0.3 * clamp((chosen.spectralSnr - 3) / 9, 0, 1), 0, 1);
    return {
      ok: true,
      bpm,
      quality,
      channel,
      estimator: chosen.spectralOnly ? 'spectral-consensus' : 'shape-verified',
      fps: uniform.measuredFps,
      duration: uniform.duration,
      contact,
      spectralBpm: chosen.spectralBpm,
      autocorrelationBpm: chosen.autocorrelationBpm,
      peakBpm,
      segmentBpms,
    };
  }

  function previewPulse(frames, options = {}) {
    const contact = contactMetrics(frames, options);
    if (!contact.valid) return { ok: false, reason: contact.reason, contact };
    const uniform = resampleUniform(frames, 8);
    if (!uniform || uniform.duration < 4.8) return { ok: false, reason: 'need_more', contact };
    const thresholds = { minSnr: 2.2, minAutocorrelation: 0.25 };
    const redClipped = contact.redClip > 0.5;
    const channels = channelCandidates(uniform, thresholds);
    const { red, green } = channels;
    const candidates = channels.ranked.filter(([name]) => !(redClipped && (name === 'red' || name === 'redBlue' || name === 'hue')));
    if (!candidates.length) return { ok: false, reason: 'weak_or_irregular_signal', contact };
    if (!redClipped && red && green && !red.spectralOnly && !green.spectralOnly
      && red.score >= candidates[0][1].score * 0.65
      && green.score >= candidates[0][1].score * 0.65 && Math.abs(red.bpm - green.bpm) > 8) {
      return { ok: false, reason: 'channel_disagreement', contact };
    }
    // The provisional number goes through the same per-candidate artifact
    // classifier and ratio-confirmation as the final result, so it can't show a
    // fake either; an artifact-classified leader is skipped, not fatal. A
    // frequency-only candidate needs the same raw-tissue and beat-count
    // corroboration as in the final path; sustained agreement across previews
    // (previewConsensus) then guards the provisional number over real time.
    let chosenEntry = null; let firstRejection = null;
    for (const entry of candidates) {
      const [name, est] = entry;
      const artifact = classifyArtifact(uniform, uniform.fps, est.bpm);
      if (artifact) { if (!firstRejection) firstRejection = artifact; continue; }
      if (RATIO_CHANNELS.includes(name) && !rawConfirms(uniform, est.bpm, redClipped).confirmed) {
        if (!firstRejection) firstRejection = 'ratio_unconfirmed'; continue;
      }
      if (est.spectralOnly && !rawConfirms(uniform, est.bpm, redClipped).confirmed) {
        if (!firstRejection) firstRejection = 'unconfirmed'; continue;
      }
      if (est.spectralOnly && !spectralConsensus(channels, name, est.bpm)) {
        if (!firstRejection) firstRejection = 'no_spectral_consensus'; continue;
      }
      if (est.spectralOnly && !beatCountCorroborates(est.filtered, uniform.fps, est.bpm)) {
        if (!firstRejection) firstRejection = 'beat_count_mismatch'; continue;
      }
      chosenEntry = entry; break;
    }
    if (!chosenEntry) return { ok: false, reason: firstRejection || 'weak_or_irregular_signal', contact };
    const [channel, chosen] = chosenEntry;
    return { ok: true, bpm: chosen.bpm, channel, contact, duration: uniform.duration, estimator: chosen.spectralOnly ? 'spectral-consensus' : 'shape-verified' };
  }

  // A provisional estimate is deliberately easier to obtain than a final
  // beat-by-beat verification.  It may become a result only when many
  // consecutive, independently recomputed previews agree over real time.
  // Keeping this rule pure makes the safety boundary directly testable.
  function previewConsensus(samples, options = {}) {
    const minSamples = options.minSamples || 8;
    const minSpanMs = options.minSpanMs || 5000;
    const maxSpreadBpm = options.maxSpreadBpm || 5;
    const maxGapMs = options.maxGapMs || 1200;
    const valid = (Array.isArray(samples) ? samples : [])
      .filter((sample) => sample && Number.isFinite(sample.bpm) && Number.isFinite(sample.at))
      .sort((a, b) => a.at - b.at)
      .slice(-minSamples);
    if (valid.length < minSamples) return { ok: false, reason: 'too_few_previews' };
    const spanMs = valid[valid.length - 1].at - valid[0].at;
    if (spanMs < minSpanMs) return { ok: false, reason: 'preview_span_too_short', spanMs };
    for (let i = 1; i < valid.length; i += 1) {
      if (valid[i].at - valid[i - 1].at > maxGapMs) return { ok: false, reason: 'preview_gap', spanMs };
    }
    const bpms = valid.map((sample) => sample.bpm).sort((a, b) => a - b);
    const spread = bpms[bpms.length - 1] - bpms[0];
    if (spread > maxSpreadBpm) return { ok: false, reason: 'preview_spread', spanMs, spread };
    return { ok: true, bpm: median(bpms), samples: valid.length, spanMs, spread };
  }

  // Contactless facial rPPG is much weaker than palm contact PPG. Keep it in
  // this DOM-free module so the exact production path is testable. This gate
  // only checks that a well-lit, still, skin-toned region is centered; the
  // spectral/autocorrelation and stability gates below decide whether a pulse
  // is present. It intentionally fails closed when they do not agree.
  function faceContactMetrics(frames) {
    const recent = frames.slice(-Math.min(frames.length, 90));
    if (recent.length < 8) return { valid: false, reason: 'no_frames', score: 0 };
    const reds = recent.map((frame) => frame.r);
    const greens = recent.map((frame) => frame.g);
    const blues = recent.map((frame) => frame.b);
    const motions = recent.map((frame) => Number.isFinite(frame.motion) ? frame.motion : 1);
    const r = median(reds); const g = median(greens); const b = median(blues);
    const brightness = (r + g + b) / 3;
    const motion = median(motions);
    let reason = '';
    if (brightness < 35) reason = 'too_dark';
    else if (brightness > 245) reason = 'overexposed';
    // Broad enough for varied skin tones and camera white balance, but rejects
    // strongly blue/green backgrounds in the center sampling region.
    else if (!(r >= g * 0.85 && g >= b * 0.72 && r >= b * 0.92)) reason = 'no_face';
    else if (motion > 0.12) reason = 'motion';
    const exposureScore = clamp((brightness - 25) / 55, 0, 1) * clamp((252 - brightness) / 35, 0, 1);
    const motionScore = clamp((0.15 - motion) / 0.13, 0, 1);
    const colorScore = clamp((r / Math.max(1, b) - 0.85) / 0.55, 0, 1);
    return { valid: !reason, reason, score: clamp(0.4 * exposureScore + 0.4 * motionScore + 0.2 * colorScore, 0, 1), brightness, motion, r, g, b };
  }

  function faceCandidate(frames, maxSeconds, minDuration, thresholds) {
    const contact = faceContactMetrics(frames);
    if (!contact.valid) return { ok: false, reason: contact.reason, contact };
    const uniform = resampleUniform(frames, maxSeconds);
    if (!uniform || uniform.duration < minDuration) {
      return { ok: false, reason: 'need_more', contact, duration: uniform ? uniform.duration : 0 };
    }
    const channels = channelCandidates(uniform, thresholds);
    if (!channels.ranked.length) return { ok: false, reason: 'weak_or_irregular_signal', contact, fps: uniform.measuredFps };
    // Same per-candidate safety walk as the fingertip paths: every candidate is
    // classified at its own rate, and a ratio channel needs raw confirmation —
    // so the face path can't finalise or preview on a colour/light artifact.
    // Frequency-only candidates need raw confirmation and beat-count agreement
    // exactly like the fingertip path (iOS smoothing affects faces too).
    let chosenEntry = null; let firstRejection = null;
    for (const entry of channels.ranked) {
      const [name, est] = entry;
      const artifact = classifyArtifact(uniform, uniform.fps, est.bpm);
      if (artifact) { if (!firstRejection) firstRejection = artifact; continue; }
      if (RATIO_CHANNELS.includes(name) && !rawConfirms(uniform, est.bpm, false).confirmed) {
        if (!firstRejection) firstRejection = 'ratio_unconfirmed'; continue;
      }
      if (est.spectralOnly && !rawConfirms(uniform, est.bpm, false).confirmed) {
        if (!firstRejection) firstRejection = 'unconfirmed'; continue;
      }
      if (est.spectralOnly && !spectralConsensus(channels, name, est.bpm)) {
        if (!firstRejection) firstRejection = 'no_spectral_consensus'; continue;
      }
      if (est.spectralOnly && !beatCountCorroborates(est.filtered, uniform.fps, est.bpm)) {
        if (!firstRejection) firstRejection = 'beat_count_mismatch'; continue;
      }
      chosenEntry = entry; break;
    }
    if (!chosenEntry) return { ok: false, reason: firstRejection || 'weak_or_irregular_signal', contact, fps: uniform.measuredFps };
    const [channel, chosen] = chosenEntry;
    return { ok: true, contact, uniform, channels, channel, chosen };
  }

  function previewFace(frames) {
    const candidate = faceCandidate(frames, 8, 5, { minSnr: 2.2, minAutocorrelation: 0.25 });
    if (!candidate.ok) return candidate;
    return { ok: true, bpm: candidate.chosen.bpm, channel: candidate.channel, contact: candidate.contact, duration: candidate.uniform.duration, estimator: candidate.chosen.spectralOnly ? 'spectral-consensus' : 'shape-verified' };
  }

  function analyzeFace(frames) {
    const thresholds = { minSnr: 2.6, minAutocorrelation: 0.3 };
    const candidate = faceCandidate(frames, 10, 9.5, thresholds);
    if (!candidate.ok) return candidate;
    const { contact, uniform, channels, channel, chosen } = candidate;
    const values = channels.values[channel];
    const segmentLength = Math.floor(values.length / 2);
    const segments = [0, 1]
      .map((part) => estimateChannel(values.slice(part * segmentLength, (part + 1) * segmentLength), uniform.fps, thresholds))
      .filter(Boolean).filter((estimate) => (chosen.spectralOnly ? true : !estimate.spectralOnly));
    if (segments.length < 2) return { ok: false, reason: 'need_more_stability', contact, fps: uniform.measuredFps };
    const segmentBpms = segments.map((item) => item.bpm);
    if (Math.max(...segmentBpms) - Math.min(...segmentBpms) > 8
      || (chosen.spectralOnly && segmentBpms.some((value) => Math.abs(value - chosen.bpm) > 10))) {
      return { ok: false, reason: 'unstable_rate', contact, fps: uniform.measuredFps };
    }
    const bpm = median([chosen.bpm, ...segmentBpms]);
    const quality = chosen.spectralOnly
      ? clamp(0.4 * contact.score + 0.6 * clamp((chosen.spectralSnr - 2.2) / 8, 0, 1), 0, 0.7)
      : clamp(0.3 * contact.score
        + 0.35 * clamp((chosen.autocorrelationQuality - 0.25) / 0.55, 0, 1)
        + 0.35 * clamp((chosen.spectralSnr - 2.2) / 8, 0, 1), 0, 1);
    return { ok: true, bpm, quality, channel, estimator: chosen.spectralOnly ? 'spectral-consensus' : 'shape-verified', contact, fps: uniform.measuredFps, duration: uniform.duration, segmentBpms };
  }

  /* ---- Read-only diagnostic -------------------------------------------------
   * Per-channel measurements BEFORE any threshold rejection, so a real-device
   * session can show exactly which guard is over-rejecting. This is a pure
   * observer: it never changes candidate ranking, thresholds or results.
   * ----------------------------------------------------------------------- */
  function diagnoseChannels(frames, options = {}) {
    const contact = contactMetrics(frames, options);
    const uniform = resampleUniform(frames);
    const out = { contact, duration: uniform ? uniform.duration : 0, fps: uniform ? uniform.measuredFps : 0, channels: {}, drift: null };
    if (!uniform) return out;
    const fps = uniform.fps;
    const series = {
      red: uniform.r, green: uniform.g, blue: uniform.b,
      redBlue: differentialChannel(uniform.r, uniform.b),
      greenBlue: differentialChannel(uniform.g, uniform.b),
      hue: hueSeries(uniform.r, uniform.g, uniform.b),
      gNorm: uniform.g.map((g, i) => g / Math.max(1, uniform.r[i] + g + uniform.b[i])),
    };
    const thr = options.thresholds || { minSnr: 3.2, minAutocorrelation: 0.38 };
    const redClipped = contact.redClip > 0.5;
    for (const [name, values] of Object.entries(series)) {
      const average = mean(values);
      if (!average || values.length < fps * 4) { out.channels[name] = { usable: false }; continue; }
      const filtered = bandpass(values.map((v) => v / average - 1), fps);
      if (filtered.length < fps * 4) { out.channels[name] = { usable: false }; continue; }
      const pulsatility = standardDeviation(filtered);
      const spectral = spectralEstimate(filtered, fps);
      const autocorrelation = spectral ? autocorrelationEstimate(filtered, fps, spectral.bpm) : null;
      const agreement = spectral && autocorrelation ? Math.abs(spectral.bpm - autocorrelation.bpm) : null;
      const timing = spectral ? peakTimingEstimate(filtered, fps, spectral.bpm) : null;
      out.channels[name] = {
        usable: true,
        spectralBpm: spectral ? spectral.bpm : null,
        snr: spectral ? spectral.snr : null,
        autocorrBpm: autocorrelation ? autocorrelation.bpm : null,
        autocorrQuality: autocorrelation ? autocorrelation.quality : null,
        agreement,
        pulsatility,
        peakBpm: timing && timing.ok ? timing.bpm : null,
        beats: timing ? timing.beats : null,
        pass: {
          pulsatility: pulsatility >= 0.00015 && pulsatility <= 0.12,
          snr: !!spectral && spectral.snr >= thr.minSnr,
          autocorr: !!autocorrelation && autocorrelation.quality >= thr.minAutocorrelation,
          agreement: agreement != null && agreement <= 5,
          timing: !!(timing && timing.ok),
        },
        artifact: spectral ? classifyArtifact(uniform, fps, spectral.bpm) : null,
        rawConfirm: spectral ? rawConfirms(uniform, spectral.bpm, redClipped) : null,
        excludedByClipping: redClipped && (name === 'red' || name === 'redBlue' || name === 'hue'),
      };
    }
    // Low-frequency colour drift over the window (white-balance movement).
    const rg = uniform.r.map((r, i) => r / Math.max(1, uniform.g[i]));
    const gb = uniform.g.map((g, i) => g / Math.max(1, uniform.b[i]));
    const drift = (arr) => { const k = Math.max(1, Math.floor(arr.length / 4)); return (mean(arr.slice(-k)) - mean(arr.slice(0, k))) / (mean(arr) || 1); };
    out.drift = { rgOverWindow: drift(rg), gbOverWindow: drift(gb) };
    return out;
  }

  return {
    analyzePulse,
    previewPulse,
    previewConsensus,
    diagnoseChannels,
    analyzeFace,
    previewFace,
    contactMetrics,
    faceContactMetrics,
    resampleUniform,
    estimateChannel,
    differentialChannel,
    spectralEstimate,
    autocorrelationEstimate,
    spatialTexture,
    classifyArtifact,
    rawConfirms,
    peakTimingEstimate,
    beatCountCorroborates,
    spectralConsensus,
    bandPowerAt,
    channelCandidates,
    _internal: { bandpass, powerAtBpm, median },
  };
}));
