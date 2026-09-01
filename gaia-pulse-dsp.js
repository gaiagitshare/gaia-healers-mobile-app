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
  // A fingertip lit by a nearby flash often has a bright hotspot and dark edge;
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

  function resampleUniform(inputFrames, maxSeconds = 12) {
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

  function contactMetrics(frames) {
    const recent = frames.slice(-Math.min(frames.length, 180));
    if (!recent.length) return { valid: false, reason: 'no_frames', score: 0 };
    let contactFrames = 0;
    const brightness = []; const redRatios = []; const textures = []; const motions = [];
    recent.forEach((frame) => {
      const bright = (frame.r + frame.g + frame.b) / 3;
      const maxChannel = Math.max(frame.r, frame.g, frame.b, 1);
      const minChannel = Math.min(frame.r, frame.g, frame.b);
      const redRatio = frame.r / Math.max(1, frame.g + frame.b);
      const saturation = (maxChannel - minChannel) / maxChannel;
      const texture = Number.isFinite(frame.spatialCv) ? frame.spatialCv : 1;
      const motion = Number.isFinite(frame.motion) ? frame.motion : 1;
      brightness.push(bright); redRatios.push(redRatio); textures.push(texture); motions.push(motion);
      // iPhone auto-white-balance can make a torch-lit fingertip yellow/pink
      // rather than strongly red. Keep the gate tolerant to that variation;
      // spatial uniformity, motion and the later cross-channel DSP still reject
      // ordinary scenes and rhythmic whole-frame movement.
      if (bright >= 10 && bright <= 253 && frame.r >= frame.g * 0.96 && frame.r >= frame.b * 1.08
        && saturation >= 0.06 && texture <= 0.42 && motion <= 0.16) contactFrames += 1;
    });
    const fraction = contactFrames / recent.length;
    const metrics = {
      fraction,
      brightness: median(brightness),
      redRatio: median(redRatios),
      spatialCv: median(textures),
      motion: median(motions),
    };
    let reason = '';
    if (metrics.brightness < 10) reason = 'too_dark';
    else if (metrics.brightness > 253) reason = 'overexposed';
    else if (metrics.redRatio < 0.46) reason = 'no_finger_contact';
    else if (metrics.spatialCv > 0.42) reason = 'scene_texture';
    else if (metrics.motion > 0.16) reason = 'motion';
    else if (fraction < 0.6) reason = 'unstable_contact';
    // A graded score makes the live meter react while the user is finding the
    // active lens. Passing BPM remains fail-closed on every binary gate above.
    const exposureScore = clamp((metrics.brightness - 6) / 28, 0, 1)
      * clamp((255 - metrics.brightness) / 20, 0, 1);
    const colorScore = clamp((metrics.redRatio - 0.36) / 0.28, 0, 1);
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
    if (!autocorrelation || autocorrelation.quality < minAutocorrelation) return null;
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

  function differentialChannel(primary, reference) {
    const primaryMean = mean(primary);
    const referenceMean = mean(reference);
    if (!primaryMean || !referenceMean || primary.length !== reference.length) return [];
    // Keep a positive baseline because estimateChannel works in relative units.
    return primary.map((value, index) => 1 + value / primaryMean - reference[index] / referenceMean);
  }

  function channelCandidates(uniform, thresholds) {
    const red = estimateChannel(uniform.r, uniform.fps, thresholds);
    const green = estimateChannel(uniform.g, uniform.fps, thresholds);
    const redBlueValues = differentialChannel(uniform.r, uniform.b);
    const greenBlueValues = differentialChannel(uniform.g, uniform.b);
    const redBlue = redBlueValues.length ? estimateChannel(redBlueValues, uniform.fps, thresholds) : null;
    const greenBlue = greenBlueValues.length ? estimateChannel(greenBlueValues, uniform.fps, thresholds) : null;
    return {
      red,
      green,
      redBlue,
      greenBlue,
      values: { red: uniform.r, green: uniform.g, redBlue: redBlueValues, greenBlue: greenBlueValues },
      ranked: [['red', red], ['green', green], ['redBlue', redBlue], ['greenBlue', greenBlue]]
        .filter((entry) => entry[1]).sort((a, b) => b[1].score - a[1].score),
    };
  }

  function segmentEstimates(values, fps) {
    const segmentLength = Math.round(fps * 6);
    if (values.length < segmentLength + Math.round(fps * 2)) return [];
    const lastStart = values.length - segmentLength;
    const starts = [0, Math.round(lastStart / 2), lastStart];
    return starts.map((start) => estimateChannel(values.slice(start, start + segmentLength), fps)).filter(Boolean);
  }

  function analyzePulse(frames) {
    const contact = contactMetrics(frames);
    if (!contact.valid) return { ok: false, reason: contact.reason, contact };
    const uniform = resampleUniform(frames);
    if (!uniform || uniform.duration < 8) return { ok: false, reason: 'need_more', contact, duration: uniform ? uniform.duration : 0 };
    const channels = channelCandidates(uniform);
    const { red, green } = channels;
    const candidates = channels.ranked;
    if (!candidates.length) return { ok: false, reason: 'weak_or_irregular_signal', contact, fps: uniform.measuredFps };
    if (red && green && red.score >= candidates[0][1].score * 0.65
      && green.score >= candidates[0][1].score * 0.65 && Math.abs(red.bpm - green.bpm) > 7) {
      return { ok: false, reason: 'channel_disagreement', contact, fps: uniform.measuredFps };
    }
    const [channel, chosen] = candidates[0];
    const blue = estimateChannel(uniform.b, uniform.fps);
    // Whole-scene movement changes R/G/B together. A fingertip PPG signal should
    // be materially stronger in red/green than in blue.
    if ((channel === 'red' || channel === 'green') && blue
      && blue.pulsatility >= chosen.pulsatility * 0.65 && Math.abs(blue.bpm - chosen.bpm) <= 6) {
      return { ok: false, reason: 'common_mode_artifact', contact, fps: uniform.measuredFps };
    }
    const channelValues = channels.values[channel];
    const segments = segmentEstimates(channelValues, uniform.fps);
    if (segments.length < 2) return { ok: false, reason: 'need_more_stability', contact, fps: uniform.measuredFps };
    const segmentBpms = segments.map((item) => item.bpm);
    if (Math.max(...segmentBpms) - Math.min(...segmentBpms) > 7) {
      return { ok: false, reason: 'unstable_rate', contact, fps: uniform.measuredFps };
    }
    const bpm = median([chosen.bpm, ...segmentBpms]);
    const quality = clamp(0.35 * contact.score
      + 0.35 * clamp((chosen.autocorrelationQuality - 0.35) / 0.55, 0, 1)
      + 0.3 * clamp((chosen.spectralSnr - 3) / 9, 0, 1), 0, 1);
    return {
      ok: true,
      bpm,
      quality,
      channel,
      fps: uniform.measuredFps,
      duration: uniform.duration,
      contact,
      spectralBpm: chosen.spectralBpm,
      autocorrelationBpm: chosen.autocorrelationBpm,
      segmentBpms,
    };
  }

  function previewPulse(frames) {
    const contact = contactMetrics(frames);
    if (!contact.valid) return { ok: false, reason: contact.reason, contact };
    const uniform = resampleUniform(frames, 8);
    if (!uniform || uniform.duration < 4.8) return { ok: false, reason: 'need_more', contact };
    const thresholds = { minSnr: 2.2, minAutocorrelation: 0.25 };
    const channels = channelCandidates(uniform, thresholds);
    const { red, green } = channels;
    const candidates = channels.ranked;
    if (!candidates.length) return { ok: false, reason: 'weak_or_irregular_signal', contact };
    if (red && green && red.score >= candidates[0][1].score * 0.65
      && green.score >= candidates[0][1].score * 0.65 && Math.abs(red.bpm - green.bpm) > 8) {
      return { ok: false, reason: 'channel_disagreement', contact };
    }
    const [channel, chosen] = candidates[0];
    const blue = estimateChannel(uniform.b, uniform.fps);
    if ((channel === 'red' || channel === 'green') && blue
      && blue.pulsatility >= chosen.pulsatility * 0.65 && Math.abs(blue.bpm - chosen.bpm) <= 6) {
      return { ok: false, reason: 'common_mode_artifact', contact };
    }
    return { ok: true, bpm: chosen.bpm, channel, contact, duration: uniform.duration };
  }

  return {
    analyzePulse,
    previewPulse,
    contactMetrics,
    resampleUniform,
    estimateChannel,
    differentialChannel,
    spectralEstimate,
    autocorrelationEstimate,
    spatialTexture,
    _internal: { bandpass, powerAtBpm, median },
  };
}));
