/** Gaia — Energy Pulse.
 * A real 60-second body read. Primary method: camera photoplethysmography
 * (PPG) — the fingertip over the rear camera modulates the red channel with
 * each heartbeat; we recover BPM by autocorrelation and show the live wave so
 * you can see it working. Fallback (any device, no camera): tap along with
 * your heartbeat. No data leaves the phone; the camera frames are analysed in
 * memory and never uploaded. Honest by design: this estimates heart rate from
 * a real optical signal — it is not a medical device, not HRV/coherence, and
 * not a Bio-Well measurement.
 */
(function () {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* ---- one-time styles ------------------------------------------------- */
  function injectStyles() {
    if (document.getElementById('gaia-pulse-styles')) return;
    const st = document.createElement('style');
    st.id = 'gaia-pulse-styles';
    st.textContent = `
.gp-modal{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:max(14px,env(safe-area-inset-top)) 14px max(14px,env(safe-area-inset-bottom));}
.gp-modal__backdrop{position:absolute;inset:0;background:rgba(3,8,5,.82);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);}
.gp-card{position:relative;width:100%;max-width:26rem;max-height:calc(100dvh - 28px);overflow:auto;-webkit-overflow-scrolling:touch;
  background:radial-gradient(ellipse at 50% 0%,#12261a,#0a140d 70%);border:1px solid rgba(125,217,86,.18);border-radius:24px;color:#eaf4ea;
  box-shadow:0 24px 70px rgba(0,0,0,.55);padding:22px 20px calc(20px + env(safe-area-inset-bottom));text-align:center;}
.gp-close{position:absolute;top:10px;right:10px;width:40px;height:40px;border:none;border-radius:50%;background:rgba(255,255,255,.06);color:#cfe6c7;font-size:20px;cursor:pointer;}
.gp-eyebrow{font-size:.72rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#a7e97e;margin:0 0 6px;}
.gp-title{font-size:1.5rem;font-weight:800;letter-spacing:-.02em;margin:0 0 8px;color:#fff;}
.gp-lead{font-size:.92rem;line-height:1.55;color:rgba(234,244,234,.72);margin:0 auto 16px;max-width:22rem;}
.gp-note{font-size:.74rem;line-height:1.5;color:rgba(234,244,234,.5);margin:14px auto 0;max-width:23rem;}
.gp-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:50px;padding:.85rem 1.25rem;border:none;border-radius:999px;
  background:linear-gradient(145deg,#5cb82e,#449422);color:#fff;font-weight:700;font-size:1rem;cursor:pointer;text-decoration:none;box-shadow:0 8px 24px rgba(92,184,46,.32);}
.gp-btn--ghost{background:transparent;border:1px solid rgba(167,233,126,.3);color:#cfe6c7;box-shadow:none;min-height:46px;font-weight:600;}
.gp-btn--link{background:none;border:none;color:#a7e97e;box-shadow:none;min-height:40px;font-size:.9rem;font-weight:600;width:auto;}
.gp-actions{display:flex;flex-direction:column;gap:10px;margin-top:16px;}
.gp-stage{position:relative;width:170px;height:170px;margin:8px auto 6px;display:grid;place-items:center;}
.gp-ring{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(167,233,126,.16);}
.gp-heart{font-size:64px;color:#7dd956;line-height:1;filter:drop-shadow(0 0 18px rgba(92,184,46,.5));animation:gp-beat 1s ease-in-out infinite;}
@keyframes gp-beat{0%,100%{transform:scale(1)}18%{transform:scale(1.16)}32%{transform:scale(1)}}
@media (prefers-reduced-motion:reduce){.gp-heart{animation:none}}
.gp-bpm{font-size:3.4rem;font-weight:800;line-height:1;color:#fff;letter-spacing:-.03em;font-variant-numeric:tabular-nums;}
.gp-bpm small{display:block;font-size:.8rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(234,244,234,.55);margin-top:4px;}
.gp-wave{width:100%;height:64px;margin:6px 0 2px;display:block;}
.gp-video{position:absolute;width:2px;height:2px;opacity:0;pointer-events:none;left:-9999px;top:-9999px;}
.gp-status{font-size:.86rem;color:rgba(234,244,234,.75);min-height:1.3em;margin:8px 0 0;}
.gp-quality{display:flex;gap:4px;justify-content:center;margin:10px 0 2px;}
.gp-quality i{width:26px;height:5px;border-radius:99px;background:rgba(255,255,255,.14);transition:background .3s;}
.gp-quality i.on{background:#5cb82e;}
.gp-gauge{position:relative;height:8px;border-radius:99px;margin:14px 4px 6px;background:linear-gradient(90deg,#2e77c9,#5cb82e 50%,#e0912c);}
.gp-gauge__pin{position:absolute;top:50%;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid #0a140d;transform:translate(-50%,-50%);box-shadow:0 2px 8px rgba(0,0,0,.4);transition:left .6s cubic-bezier(.22,1,.36,1);}
.gp-gauge__labels{display:flex;justify-content:space-between;font-size:.7rem;color:rgba(234,244,234,.5);margin:0 4px;}
.gp-read{font-size:1.05rem;font-weight:700;color:#fff;margin:12px 0 2px;}
.gp-tap{width:150px;height:150px;border-radius:50%;border:2px solid rgba(167,233,126,.35);background:radial-gradient(circle,rgba(92,184,46,.22),rgba(92,184,46,.05));color:#eaf4ea;font-weight:700;font-size:1rem;margin:6px auto 4px;display:grid;place-items:center;cursor:pointer;user-select:none;-webkit-user-select:none;transition:transform .08s;}
.gp-tap:active{transform:scale(.94);}
`;
    document.head.appendChild(st);
  }

  /* ---- signal processing (real) --------------------------------------- */
  // Autocorrelation BPM over a detrended, roughly-uniformly-sampled signal.
  // Returns { bpm, quality } where quality is the normalised autocorr peak.
  function estimateBpm(values, fps) {
    const n = values.length;
    if (n < fps * 4) return null;
    // detrend with a ~0.6s moving average, then normalise
    const win = Math.max(3, Math.round(fps * 0.6));
    const d = new Array(n).fill(0);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += values[i];
      if (i >= win) acc -= values[i - win];
      const mean = acc / Math.min(i + 1, win);
      d[i] = values[i] - mean;
    }
    // zero-mean + std
    let m = 0; for (let i = 0; i < n; i++) m += d[i]; m /= n;
    let sd = 0; for (let i = 0; i < n; i++) { d[i] -= m; sd += d[i] * d[i]; }
    sd = Math.sqrt(sd / n) || 1e-6;
    for (let i = 0; i < n; i++) d[i] /= sd;
    // autocorrelation over lags for 40..180 BPM
    const minLag = Math.max(2, Math.floor(fps * 60 / 180));
    const maxLag = Math.min(n - 2, Math.ceil(fps * 60 / 40));
    if (maxLag <= minLag + 1) return null;
    const acf = new Array(maxLag + 2).fill(0);
    let gmax = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += d[i] * d[i + lag];
      s /= (n - lag);
      acf[lag] = s;
      if (s > gmax) gmax = s;
    }
    if (gmax <= 0) return null;
    // Pick the SMALLEST lag that is a local peak near the global max. This locks
    // onto the fundamental and avoids the classic octave error where a strong
    // 2×/3× period (a lower BPM) outscores the true rate.
    let bestLag = -1; let bestVal = -Infinity;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (acf[lag] >= 0.72 * gmax && acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1]) { bestLag = lag; bestVal = acf[lag]; break; }
    }
    if (bestLag < 0) { for (let lag = minLag; lag <= maxLag; lag++) if (acf[lag] > bestVal) { bestVal = acf[lag]; bestLag = lag; } }
    if (bestLag < 0) return null;
    // parabolic interpolation around the peak for sub-sample accuracy
    let lag = bestLag;
    if (bestLag > minLag && bestLag < maxLag) {
      const y0 = acf[bestLag - 1], y1 = bestVal, y2 = acf[bestLag + 1];
      const denom = (y0 - 2 * y1 + y2);
      if (denom !== 0) lag = bestLag + 0.5 * (y0 - y2) / denom;
    }
    const bpm = 60 * fps / lag;
    return { bpm, quality: Math.max(0, Math.min(1, gmax)) };
  }

  /* ---- the tool ------------------------------------------------------- */
  const BIOWELL_URL = 'home.html?view=wellness&tab=biowell';

  function open() {
    injectStyles();
    close(); // ensure single instance
    const modal = document.createElement('div');
    modal.className = 'gp-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Energy Pulse');
    modal.innerHTML = '<div class="gp-modal__backdrop" data-gp-close></div><div class="gp-card" data-gp-card></div>';
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';
    const card = modal.querySelector('[data-gp-card]');
    modal.querySelectorAll('[data-gp-close]').forEach((e) => e.addEventListener('click', close));
    document.addEventListener('keydown', onKey);
    window.__gpModal = modal;
    intro(card);
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    stopCamera();
    if (window.__gpTimer) { clearInterval(window.__gpTimer); window.__gpTimer = null; }
    if (window.__gpRAF) { cancelAnimationFrame(window.__gpRAF); window.__gpRAF = null; }
    document.removeEventListener('keydown', onKey);
    const m = window.__gpModal || document.querySelector('.gp-modal');
    if (m && m.parentNode) m.parentNode.removeChild(m);
    window.__gpModal = null;
    document.body.style.overflow = '';
  }

  function closeBtn() { return '<button type="button" class="gp-close" data-gp-close aria-label="Close">×</button>'; }

  function intro(card) {
    card.innerHTML = closeBtn()
      + '<p class="gp-eyebrow">Energy Pulse</p>'
      + '<div class="gp-stage"><span class="gp-ring"></span><i class="ph ph-heartbeat gp-heart" aria-hidden="true"></i></div>'
      + '<h2 class="gp-title">A 60-second pulse read</h2>'
      + '<p class="gp-lead">Rest a fingertip gently over your phone’s <strong>rear camera</strong> in good light and hold still. We estimate your heart rate from the tiny colour changes under your skin — you’ll see the live wave.</p>'
      + '<div class="gp-actions">'
      + '<button type="button" class="gp-btn" data-gp-start><i class="ph ph-camera" aria-hidden="true"></i> Start reading</button>'
      + '<button type="button" class="gp-btn--link" data-gp-tap>No camera? Tap with your heartbeat →</button>'
      + '</div>'
      + '<p class="gp-note">This estimates your heart rate for reflection — not a medical device, and not a Bio-Well scan. Nothing is recorded or uploaded; it all happens on your phone.</p>';
    card.querySelector('[data-gp-start]').addEventListener('click', () => measure(card));
    card.querySelector('[data-gp-tap]').addEventListener('click', () => tapMode(card));
  }

  /* ---- camera measurement --------------------------------------------- */
  let stream = null, video = null, sampleCanvas = null, sctx = null;
  function stopCamera() {
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { if (video) { video.pause(); video.srcObject = null; if (video.parentNode) video.parentNode.removeChild(video); } } catch (e) {}
    stream = null; video = null; sampleCanvas = null; sctx = null;
  }

  async function measure(card) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { tapMode(card, 'Camera isn’t available on this device.'); return; }
    card.innerHTML = closeBtn()
      + '<p class="gp-eyebrow">Reading your pulse</p>'
      + '<div class="gp-bpm"><span data-gp-bpm>– –</span><small>BPM</small></div>'
      + '<canvas class="gp-wave" data-gp-wave width="300" height="64" aria-hidden="true"></canvas>'
      + '<div class="gp-quality" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>'
      + '<p class="gp-status" data-gp-status>Requesting camera…</p>'
      + '<div class="gp-actions"><button type="button" class="gp-btn--link" data-gp-tap>Trouble? Tap with your heartbeat →</button></div>';
    card.querySelector('[data-gp-tap]').addEventListener('click', () => { stopCamera(); tapMode(card); });
    const statusEl = card.querySelector('[data-gp-status]');
    const bpmEl = card.querySelector('[data-gp-bpm]');
    const qEls = [...card.querySelectorAll('.gp-quality i')];
    const wave = card.querySelector('[data-gp-wave]');
    const wctx = wave.getContext('2d');

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 320 }, height: { ideal: 240 } }, audio: false });
    } catch (e1) {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
      catch (e2) { tapMode(card, 'Camera permission was blocked. You can still tap your pulse.'); return; }
    }
    // best-effort torch (works on some Android; silently ignored on iOS)
    try { const tr = stream.getVideoTracks()[0]; if (tr && tr.applyConstraints) await tr.applyConstraints({ advanced: [{ torch: true }] }); } catch (e) {}

    video = document.createElement('video');
    video.className = 'gp-video'; video.playsInline = true; video.muted = true; video.setAttribute('playsinline', ''); video.srcObject = stream;
    document.body.appendChild(video);
    try { await video.play(); } catch (e) {}
    sampleCanvas = document.createElement('canvas'); sampleCanvas.width = 40; sampleCanvas.height = 40; sctx = sampleCanvas.getContext('2d', { willReadFrequently: true });

    const samples = []; const times = [];
    const startedAt = performance.now();
    const DURATION = 32000; // ms of clean signal target
    let goodRun = 0;
    statusEl.textContent = 'Cover the camera fully with your fingertip…';

    function frame() {
      if (!video || !sctx) return;
      try {
        sctx.drawImage(video, 0, 0, 40, 40);
        const px = sctx.getImageData(12, 12, 16, 16).data; // centre ROI
        let r = 0; for (let i = 0; i < px.length; i += 4) r += px[i];
        r /= (px.length / 4);
        const t = performance.now();
        samples.push(r); times.push(t);
        while (times.length && t - times[0] > 10000) { times.shift(); samples.shift(); } // keep 10s
        // draw wave (last ~4s)
        drawWave(wctx, wave, samples.slice(-Math.min(samples.length, 240)));
        // estimate once we have enough
        if (samples.length > 90) {
          const dur = (times[times.length - 1] - times[0]) / 1000;
          const fps = samples.length / Math.max(dur, 0.001);
          const est = estimateBpm(samples, fps);
          if (est && est.bpm >= 40 && est.bpm <= 180) {
            const q = Math.round(est.quality * 5);
            qEls.forEach((el, i) => el.classList.toggle('on', i < q));
            if (est.quality > 0.35) {
              bpmEl.textContent = Math.round(est.bpm);
              statusEl.textContent = 'Hold still — reading your rhythm…';
              goodRun += 1;
              // finalise after enough steady good frames + minimum time
              if (goodRun > 45 && (t - startedAt) > 12000) { finish(est.bpm); return; }
            } else { goodRun = Math.max(0, goodRun - 2); statusEl.textContent = 'Searching for your pulse — press gently and stay still.'; }
          }
        }
        if (t - startedAt > DURATION + 8000) {
          // give up on camera after ~40s
          const dur = (times[times.length - 1] - times[0]) / 1000;
          const fps = samples.length / Math.max(dur, 0.001);
          const est = estimateBpm(samples, fps);
          if (est && est.quality > 0.28 && est.bpm >= 40 && est.bpm <= 180) { finish(est.bpm); return; }
          tapMode(card, 'Couldn’t get a clean pulse from the camera. Try tapping instead.');
          return;
        }
      } catch (e) {}
      window.__gpRAF = requestAnimationFrame(frame);
    }
    window.__gpRAF = requestAnimationFrame(frame);

    function finish(bpm) {
      stopCamera();
      if (window.__gpRAF) { cancelAnimationFrame(window.__gpRAF); window.__gpRAF = null; }
      result(card, Math.round(bpm), 'camera');
    }
  }

  function drawWave(ctx, cv, vals) {
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    if (vals.length < 4) return;
    let mn = Infinity, mx = -Infinity;
    for (const v of vals) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const rng = (mx - mn) || 1;
    ctx.beginPath();
    ctx.lineWidth = 2; ctx.strokeStyle = '#7dd956';
    for (let i = 0; i < vals.length; i++) {
      const x = (i / (vals.length - 1)) * w;
      const y = h - 6 - ((vals[i] - mn) / rng) * (h - 12);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /* ---- tap fallback (real, no camera) --------------------------------- */
  function tapMode(card, reason) {
    let taps = []; let done = false;
    card.innerHTML = closeBtn()
      + '<p class="gp-eyebrow">Tap your pulse</p>'
      + '<h2 class="gp-title">Tap with each beat</h2>'
      + '<p class="gp-lead">' + (reason ? esc(reason) + ' ' : '') + 'Find your pulse (wrist or neck), then tap the circle in time with each heartbeat. Keep going for ~15 seconds.</p>'
      + '<div class="gp-tap" data-gp-taparea>Tap</div>'
      + '<p class="gp-status" data-gp-status>0 taps</p>'
      + '<div class="gp-actions"><button type="button" class="gp-btn--ghost" data-gp-camera>Use the camera instead</button></div>';
    const area = card.querySelector('[data-gp-taparea]');
    const status = card.querySelector('[data-gp-status]');
    card.querySelector('[data-gp-camera]').addEventListener('click', () => measure(card));
    function onTap() {
      if (done) return;
      const t = performance.now(); taps.push(t);
      area.textContent = '♥';
      setTimeout(() => { if (!done) area.textContent = 'Tap'; }, 120);
      status.textContent = taps.length + ' tap' + (taps.length === 1 ? '' : 's');
      // need >=8 taps spanning >=10s
      if (taps.length >= 8 && (t - taps[0]) > 10000) {
        done = true;
        const ibis = []; for (let i = 1; i < taps.length; i++) ibis.push(taps[i] - taps[i - 1]);
        // trim outliers (double taps / long gaps) using median
        ibis.sort((a, b) => a - b); const med = ibis[Math.floor(ibis.length / 2)];
        const kept = ibis.filter((x) => x > med * 0.5 && x < med * 1.8);
        const meanIbi = kept.reduce((a, b) => a + b, 0) / kept.length;
        const bpm = Math.round(60000 / meanIbi);
        result(card, bpm, 'tap');
      }
    }
    area.addEventListener('click', onTap);
    area.addEventListener('touchstart', (e) => { e.preventDefault(); onTap(); }, { passive: false });
  }

  /* ---- result --------------------------------------------------------- */
  function result(card, bpm, method) {
    // Calm↔Activated is a plain-language reading of the *measured pulse rate*
    // only (lower rate → calmer end). It is not HRV, coherence, or a biofield.
    const pos = clamp((bpm - 55) / (95 - 55), 0, 1); // 55bpm→calm end, 95bpm→activated end
    const band = pos < 0.34 ? 'Calm' : pos < 0.67 ? 'Balanced' : 'Activated';
    const bandNote = pos < 0.34 ? 'A relatively low pulse right now — often how the body reads at rest.'
      : pos < 0.67 ? 'A middle-of-the-range pulse — steady and even.'
      : 'A higher pulse right now — a few slow breaths can help it settle.';
    card.innerHTML = closeBtn()
      + '<p class="gp-eyebrow">Your pulse</p>'
      + '<div class="gp-bpm"><span>' + bpm + '</span><small>BPM · ' + (method === 'tap' ? 'tapped' : 'camera') + '</small></div>'
      + '<div class="gp-gauge"><span class="gp-gauge__pin" style="left:' + (pos * 100) + '%"></span></div>'
      + '<div class="gp-gauge__labels"><span>Calm</span><span>Balanced</span><span>Activated</span></div>'
      + '<p class="gp-read">' + esc(band) + '</p>'
      + '<p class="gp-lead">' + esc(bandNote) + '</p>'
      + '<p class="gp-note" style="margin-top:0">Calm ↔ Activated is a simple reading of your <strong>pulse rate</strong> only — not HRV, coherence, stress, or a biofield measurement.</p>'
      + '<div class="gp-actions">'
      + '<button type="button" class="gp-btn" data-gp-breath><i class="ph ph-wind" aria-hidden="true"></i> Slow it down with breathing</button>'
      + '<a class="gp-btn--ghost" href="' + esc(BIOWELL_URL) + '">Explore a Bio-Well scan →</a>'
      + '<button type="button" class="gp-btn--link" data-gp-again>Measure again</button>'
      + '</div>'
      + '<p class="gp-note">A quick pulse estimate for reflection, not a diagnosis. A Bio-Well scan is a separate, in-depth session.</p>';
    card.querySelector('[data-gp-again]').addEventListener('click', () => intro(card));
    const b = card.querySelector('[data-gp-breath]');
    if (b) b.addEventListener('click', () => { close(); if (window.GaiaBreath && window.GaiaBreath.open) window.GaiaBreath.open(); else location.href = 'home.html?view=wellness&tool=breath'; });
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* ---- expose + auto-open --------------------------------------------- */
  window.GaiaPulse = { open, close };
  if (new URLSearchParams(window.location.search).get('tool') === 'pulse') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', open); else open();
  }
})();
