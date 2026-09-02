/** Gaia — Energy Pulse.
 * A real camera pulse estimate. Primary method: camera photoplethysmography
 * (PPG) — a fingertip on the flash-lit rear camera reflects each heartbeat as a tiny colour change
 * each heartbeat; spectral and autocorrelation estimates must agree before we
 * you can see it working. Fallback (any device, no camera): tap along with
 * your heartbeat. No data leaves the phone; the camera frames are analysed in
 * memory and never uploaded. Honest by design: this estimates heart rate from
 * a real optical signal — it is not a medical device, not HRV/coherence, and
 * not a Bio-Well measurement.
 */
(function () {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // Reject after `ms` if a promise never settles. Cross-origin iframes without
  // allow="camera" (e.g. the GHL embed) can leave getUserMedia PENDING forever
  // on iOS WebKit rather than rejecting — this keeps the UI from hanging.
  function withTimeout(p, ms) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('timeout')), ms);
      Promise.resolve(p).then((v) => { clearTimeout(to); resolve(v); }, (e) => { clearTimeout(to); reject(e); });
    });
  }
  function requestCamera(constraints, ms) {
    let expired = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        expired = true;
        const error = new Error('camera_timeout');
        error.name = 'TimeoutError';
        reject(error);
      }, ms);
      navigator.mediaDevices.getUserMedia(constraints).then((cameraStream) => {
        if (expired) {
          // getUserMedia cannot be aborted. If WebKit resolves after our UI has
          // moved on, stop that orphaned camera immediately.
          cameraStream.getTracks().forEach((track) => track.stop());
          return;
        }
        clearTimeout(timer);
        resolve(cameraStream);
      }, (error) => {
        if (expired) return;
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  // Best-effort: are we running inside a (cross-origin) iframe?
  function isFramed() { try { return window.self !== window.top; } catch (e) { return true; } }
  function cameraPolicyBlocked() {
    try {
      const policy = document.permissionsPolicy || document.featurePolicy;
      return Boolean(isFramed() && policy && policy.allowsFeature && !policy.allowsFeature('camera'));
    } catch (e) { return false; }
  }

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
.gp-howto{width:190px;max-width:62vw;margin:2px auto 0;display:block;}
.gp-howto .gp-lensG circle{fill:#10241699;stroke:rgba(180,220,180,.4);stroke-width:1.5;}
.gp-ringpulse{transform-origin:100px 44px;animation:gp-ring 2.6s ease-out infinite;}
@keyframes gp-ring{0%{transform:scale(.55);opacity:.9}70%{opacity:0}100%{transform:scale(1.5);opacity:0}}
.gp-finger{transform-origin:100px 120px;animation:gp-press 2.6s ease-in-out infinite;}
@keyframes gp-press{0%,100%{transform:translateY(9px)}42%,66%{transform:translateY(0)}}
.gp-flash{animation:gp-flash 2.6s ease-in-out infinite;}
@keyframes gp-flash{0%,38%,100%{opacity:.45}52%{opacity:1}}
.gp-pill{display:inline-block;margin:8px auto 0;padding:5px 12px;border-radius:999px;background:rgba(92,184,46,.14);border:1px solid rgba(167,233,126,.3);color:#cfe6c7;font-size:.78rem;font-weight:700;}
@media (prefers-reduced-motion:reduce){.gp-ringpulse,.gp-finger,.gp-flash{animation:none}.gp-finger{transform:translateY(0)}}
.gp-bpm{font-size:3.4rem;font-weight:800;line-height:1;color:#fff;letter-spacing:-.03em;font-variant-numeric:tabular-nums;}
.gp-bpm small{display:block;font-size:.8rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(234,244,234,.55);margin-top:4px;}
.gp-wave{width:100%;height:64px;margin:6px 0 2px;display:block;}
.gp-video{position:fixed;width:2px;height:2px;opacity:.01;pointer-events:none;right:0;bottom:0;}
.gp-face-preview{width:150px;height:150px;margin:4px auto 10px;border-radius:50%;overflow:hidden;position:relative;background:#050a07;border:2px solid rgba(167,233,126,.38);box-shadow:0 0 0 5px rgba(92,184,46,.07);}
.gp-face-preview::after{content:'';position:absolute;inset:17px 24px;border:1px dashed rgba(255,255,255,.5);border-radius:48% 48% 44% 44%;pointer-events:none;}
.gp-video.gp-video--face{position:absolute;inset:0;width:100%;height:100%;opacity:1;right:auto;bottom:auto;object-fit:cover;transform:scaleX(-1);pointer-events:none;}
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

  /* ---- signal processing ---------------------------------------------- */
  function pulseDsp() {
    if (!window.GaiaPulseDSP) throw new Error('Pulse signal processing did not load. Refresh and try again.');
    return window.GaiaPulseDSP;
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
    // Delegate close so the × button works on every re-rendered screen (intro,
    // measure, tap, result) as well as the backdrop — not just the first render.
    modal.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('[data-gp-close]')) close(); });
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
      + '<svg class="gp-howto" viewBox="0 0 200 176" role="img" aria-label="Rest a fingertip flat over the phone rear camera and flash, covering the whole camera bump">'
      + '<defs>'
      + '<linearGradient id="gpSkin" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e7bf97"/><stop offset=".5" stop-color="#dcae82"/><stop offset="1" stop-color="#c39970"/></linearGradient>'
      + '<radialGradient id="gpFlash" cx="50%" cy="45%" r="55%"><stop offset="0" stop-color="#ff7a5c" stop-opacity=".85"/><stop offset="1" stop-color="#ff7a5c" stop-opacity="0"/></radialGradient>'
      + '</defs>'
      // phone back + rear camera cluster and flash
      + '<rect x="58" y="6" width="84" height="164" rx="18" fill="#0c1811" stroke="rgba(125,217,86,.28)" stroke-width="2"/>'
      + '<rect x="74" y="16" width="52" height="52" rx="15" fill="#050f09" stroke="rgba(255,255,255,.13)" stroke-width="1.5"/>'
      + '<g class="gp-lensG"><circle cx="90" cy="32" r="9"/><circle cx="110" cy="32" r="9"/><circle cx="90" cy="52" r="9"/></g>'
      + '<circle cx="90" cy="32" r="3.4" fill="#173521"/><circle cx="110" cy="32" r="3.4" fill="#173521"/><circle cx="90" cy="52" r="3.4" fill="#173521"/>'
      + '<circle class="gp-flash" cx="110" cy="52" r="4" fill="#ffe08a"/>'
      // fingertip pressing flat over the whole camera bump (lens + flash), flash-lit
      + '<g class="gp-finger"><path d="M60 176 L60 64 Q60 30 100 30 Q140 30 140 64 L140 176 Z" fill="url(#gpSkin)" fill-opacity="0.94" stroke="rgba(60,30,10,.28)" stroke-width="1"/>'
      + '<ellipse cx="100" cy="72" rx="20" ry="26" fill="rgba(255,255,255,.1)"/>'
      + '<ellipse cx="100" cy="46" rx="30" ry="22" fill="url(#gpFlash)"/>'
      + '<circle class="gp-ringpulse" cx="100" cy="44" r="16" fill="none" stroke="#7dd956" stroke-width="2"/></g>'
      + '</svg>'
      + '<span class="gp-pill">Cover the camera + flash with a fingertip</span>'
      + '<h2 class="gp-title">A careful pulse read</h2>'
      + '<p class="gp-lead">Rest a fingertip flat over the <strong>rear camera and flash</strong> — cover the whole camera bump, right on the skin. Keep the flash on (or sit in bright light), use <strong>light pressure</strong> — pressing hard hides the pulse — and hold still for ~15 seconds. The app returns a number only when the signal passes every quality check.</p>'
      + '<div class="gp-actions">'
      + '<button type="button" class="gp-btn" data-gp-start><i class="ph ph-camera" aria-hidden="true"></i> Read with fingertip</button>'
      + '<button type="button" class="gp-btn--ghost" data-gp-face><i class="ph ph-user-focus" aria-hidden="true"></i> Read with my face · beta</button>'
      + '<button type="button" class="gp-btn--link" data-gp-tap>Or tap along with your heartbeat →</button>'
      + '</div>'
      + '<p class="gp-note">Three ways to read — if one won’t catch, try another. All estimate your heart rate for reflection — not a medical device, not a Bio-Well scan. Nothing is recorded or uploaded; it all happens on your phone.</p>';
    card.querySelector('[data-gp-start]').addEventListener('click', () => measure(card, { mode: 'finger' }));
    card.querySelector('[data-gp-face]').addEventListener('click', () => measure(card, { mode: 'face' }));
    card.querySelector('[data-gp-tap]').addEventListener('click', () => tapMode(card));
  }

  /* ---- camera measurement --------------------------------------------- */
  let stream = null, video = null, sampleCanvas = null, sctx = null;
  let videoFrameCallbackId = null, captureActive = false, frameWatchdog = null;
  function stopCamera() {
    captureActive = false;
    if (frameWatchdog) { clearTimeout(frameWatchdog); frameWatchdog = null; }
    try { if (video && videoFrameCallbackId != null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoFrameCallbackId); } catch (e) {}
    videoFrameCallbackId = null;
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { if (video) { video.pause(); video.srcObject = null; if (video.parentNode) video.parentNode.removeChild(video); } } catch (e) {}
    stream = null; video = null; sampleCanvas = null; sctx = null;
  }

  // Shown when the camera can't be reached — most often because this is the GHL
  // in-app view, whose iframe must delegate camera access (allow="camera"). We
  // can't grant that from inside, so we offer the browser (where it works) and
  // the tap reading (which is just as real).
  function cameraUnavailable(card, framed) {
    stopCamera();
    const topUrl = 'https://gaiahealers.app/home.html?tool=pulse';
    card.innerHTML = closeBtn()
      + '<p class="gp-eyebrow">Camera unavailable</p>'
      + '<h2 class="gp-title">Can’t reach the camera here</h2>'
      + '<p class="gp-lead">' + (framed
        ? 'This in-app view isn’t permitted to use the camera. Open Gaia in your browser for the camera reading — or tap your pulse below, it’s just as real.'
        : 'The camera didn’t respond or was blocked. Tap your pulse below — it’s just as real a measurement.') + '</p>'
      + '<div class="gp-actions">'
      + (framed ? '<a class="gp-btn" href="' + esc(topUrl) + '" target="_blank" rel="noopener"><i class="ph ph-arrow-square-out" aria-hidden="true"></i> Open in browser</a>' : '')
      + '<button type="button" class="gp-btn' + (framed ? '--ghost' : '') + '" data-gp-tapnow>Tap your pulse instead</button>'
      + '</div>';
    const tp = card.querySelector('[data-gp-tapnow]');
    if (tp) tp.addEventListener('click', () => tapMode(card));
  }

  async function measure(card, opts) {
    const face = !!(opts && opts.mode === 'face');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { tapMode(card, 'Camera isn’t available on this device.'); return; }
    let dsp;
    try { dsp = pulseDsp(); } catch (error) { tapMode(card, error.message); return; }
    if (cameraPolicyBlocked()) { cameraUnavailable(card, true); return; }
    card.innerHTML = closeBtn()
      + '<p class="gp-eyebrow">' + (face ? 'Face pulse · beta' : 'Reading your pulse') + '</p>'
      + (face ? '<div class="gp-face-preview" data-gp-preview aria-label="Live front camera preview"></div>' : '')
      + '<div class="gp-bpm"><span data-gp-bpm>– –</span><small>BPM</small></div>'
      + '<canvas class="gp-wave" data-gp-wave width="300" height="64" aria-hidden="true"></canvas>'
      + '<div class="gp-quality" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>'
      + '<p class="gp-status" data-gp-status>Requesting camera…</p>'
      + '<p class="gp-note" data-gp-camera style="margin-top:5px"></p>'
      + '<div class="gp-actions">'
      + '<button type="button" class="gp-btn--link" data-gp-switch>' + (face ? 'Use fingertip + rear camera instead' : 'No luck? Use my face (front camera) instead') + '</button>'
      + '<button type="button" class="gp-btn--link" data-gp-tap>Or tap with your heartbeat →</button>'
      + '</div>';
    card.querySelector('[data-gp-tap]').addEventListener('click', () => { stopCamera(); tapMode(card); });
    card.querySelector('[data-gp-switch]').addEventListener('click', () => { stopCamera(); measure(card, { mode: face ? 'finger' : 'face' }); });
    const statusEl = card.querySelector('[data-gp-status]');
    const bpmEl = card.querySelector('[data-gp-bpm]');
    const qEls = [...card.querySelectorAll('.gp-quality i')];
    const cameraEl = card.querySelector('[data-gp-camera]');
    const wave = card.querySelector('[data-gp-wave]');
    const wctx = wave.getContext('2d');

    // Palm mode uses the rear (environment) camera; face mode the front (user)
    // camera. Delivered settings are read back and shown; no physical-lens claim.
    // Low resolution on purpose: reading frames from a big stream provokes iOS
    // thermal throttling that drops the frame rate mid-measurement. 320x240 is
    // plenty for a mean-colour PPG signal and keeps the rate steady.
    const baseVideo = { facingMode: { ideal: face ? 'user' : 'environment' }, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } };
    // Use one request only. Retrying while the iOS permission sheet is open can
    // leave two competing captures and prevent either from becoming readable.
    try {
      statusEl.textContent = face ? 'Allow camera access, then center your face in the guide.' : 'Allow camera access, then cover the rear camera and flash with a fingertip.';
      stream = await requestCamera({ video: baseVideo, audio: false }, 25000);
    } catch (error) { cameraUnavailable(card, isFramed()); return; }
    const track = stream.getVideoTracks()[0];

    video = document.createElement('video');
    video.className = face ? 'gp-video gp-video--face' : 'gp-video'; video.playsInline = true; video.muted = true;
    video.setAttribute('playsinline', ''); video.setAttribute('autoplay', ''); video.srcObject = stream;
    const preview = face && card.querySelector('[data-gp-preview]');
    (preview || document.body).appendChild(video);
    try { await withTimeout(video.play(), 5000); }
    catch (e) { cameraUnavailable(card, isFramed()); return; }

    // Torch AFTER the track is live and playing (some builds need that). Modern
    // WebKit and Chromium can expose it; applyConstraints resolving is the signal.
    let torchOn = false;
    if (!face) {
      try {
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        if (caps && caps.torch === true && track.applyConstraints) {
          await withTimeout(track.applyConstraints({ advanced: [{ torch: true }] }), 2500);
          torchOn = true;
        }
      } catch (e) {}
    }
    const settings = track && track.getSettings ? track.getSettings() : {};
    const deliveredFps = Number(settings.frameRate) || 0;
    const deliveredSize = settings.width && settings.height ? `${settings.width}×${settings.height}` : 'size unknown';
    const cameraName = String(track && track.label || (face ? 'front camera' : 'rear camera')).replace(/[<>]/g, '');
    const modeTag = face ? 'face mode' : (torchOn ? 'flash on' : 'flash unavailable');
    cameraEl.textContent = `${cameraName} · ${deliveredSize}${deliveredFps ? ` · ${deliveredFps.toFixed(0)} fps` : ''} · ${modeTag}`;

    sampleCanvas = document.createElement('canvas'); sampleCanvas.width = 48; sampleCanvas.height = 48; sctx = sampleCanvas.getContext('2d', { willReadFrequently: true });

    const frames = [];
    const startedAt = performance.now();
    const GIVEUP_MS = 35000;
    let previousGrid = null;
    let lastMediaTime = -1;
    let lastAnalysisAt = 0;
    let receivedFrames = 0;
    let useRafFallback = !video.requestVideoFrameCallback;
    captureActive = true;
    statusEl.textContent = face ? 'Center your face in the oval; hold still in bright, even light.'
      : (torchOn ? 'Flash on — cover the camera and flash with your fingertip, light pressure.' : 'Cover the rear camera with your fingertip; use bright, steady light.');

    const reasonCopy = {
      no_frames: 'Waiting for camera frames…',
      too_dark: 'Too dark — cover the main lens next to the flash, or add light.',
      overexposed: 'Pressing too hard, or too bright — ease off to a very light touch.',
      no_finger_contact: 'No fingertip yet — cover the rear camera and flash with the pad of your finger.',
      no_face: 'Center your face in the frame, in even light.',
      scene_texture: 'Cover the camera fully with the pad of your finger.',
      motion: 'Too much movement — rest your hand and hold still.',
      unstable_contact: 'Keep gentle, even fingertip contact — light pressure.',
      need_more: 'Contact found — collecting a clean pulse signal…',
      need_more_stability: 'Pulse found — hold still a few seconds longer…',
      weak_or_irregular_signal: 'Signal weak — press very gently (hard pressure hides the pulse) and hold still.',
      channel_disagreement: 'Light or movement is interfering — hold still and keep the lens covered.',
      common_mode_artifact: 'Movement detected instead of a pulse — rest your hand and retry.',
      unstable_rate: 'The rate is not stable yet — keep still and breathe normally.',
    };
    if (face) Object.assign(reasonCopy, {
      need_more: 'Face detected — measuring, hold still…',
      need_more_stability: 'Almost there — hold still a few seconds longer…',
      weak_or_irregular_signal: 'Signal weak — face brighter, even light, and hold very still.',
      channel_disagreement: 'Movement or light change — hold still.',
      motion: 'Hold your head still.',
    });

    function scheduleFrame() {
      if (!captureActive || !video) return;
      if (!useRafFallback && video.requestVideoFrameCallback) videoFrameCallbackId = video.requestVideoFrameCallback(processFrame);
      else window.__gpRAF = requestAnimationFrame((now) => processFrame(now, null));
    }

    function processFrame(now, metadata) {
      if (!captureActive || !video || !sctx) return;
      try {
        if (video.readyState < 2) { scheduleFrame(); return; }
        const mediaTime = metadata && Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : (Number.isFinite(video.currentTime) ? video.currentTime : NaN);
        // Only the rAF fallback can fire several times for one camera frame — skip
        // those duplicates. rVFC delivers exactly one callback per real frame, and
        // iOS mediaTime can repeat there, so we must NOT dedup the rVFC path.
        if (!metadata && Number.isFinite(mediaTime) && mediaTime === lastMediaTime) { scheduleFrame(); return; }
        if (Number.isFinite(mediaTime)) lastMediaTime = mediaTime;
        receivedFrames += 1;
        if (frameWatchdog) { clearTimeout(frameWatchdog); frameWatchdog = null; }
        sctx.drawImage(video, 0, 0, 48, 48);
        const px = sctx.getImageData(8, 8, 32, 32).data;
        let r = 0; let g = 0; let b = 0;
        const gridSums = new Array(64).fill(0);
        const gridCounts = new Array(64).fill(0);
        const cnt = px.length / 4;
        let satCount = 0; // pixels with red pinned by the flash (no usable AC there)
        for (let i = 0; i < px.length; i += 4) {
          const rr = px[i]; const gg = px[i + 1]; const bb = px[i + 2];
          if (rr >= 250) satCount += 1;
          const lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
          const pixelIndex = i / 4;
          const x = pixelIndex % 32;
          const y = Math.floor(pixelIndex / 32);
          const block = Math.floor(y / 4) * 8 + Math.floor(x / 4);
          r += rr; g += gg; b += bb;
          gridSums[block] += lum; gridCounts[block] += 1;
        }
        r /= cnt; g /= cnt; b /= cnt;
        const grid = gridSums.map((sum, index) => sum / Math.max(1, gridCounts[index]));
        const texture = dsp.spatialTexture(grid, 8, 8);
        const motion = previousGrid && previousGrid.length === grid.length
          ? grid.reduce((sum, value, index) => sum + Math.abs(value - previousGrid[index]), 0) / grid.length / 255 : 0;
        previousGrid = grid;
        // Timestamp every frame with the wall clock (ms). iOS Safari's mediaTime
        // for the tiny live <video> stalls/repeats, which froze the collection
        // timer at "0/8 seconds" and starved the resampler — `now` is monotonic.
        const t = now;
        frames.push({ t, r, g, b, spatialCv: texture, motion, satR: satCount / cnt });
        while (frames.length && t - frames[0].t > 17000) frames.shift(); // ~15 s analysed + margin
        drawWave(wctx, wave, frames.slice(-300).map((frame) => frame.r));

        if (now - lastAnalysisAt >= 700) {
          lastAnalysisAt = now;
          const analysis = face ? dsp.analyzeFace(frames) : dsp.analyzePulse(frames);
          const visibleQuality = analysis.ok ? analysis.quality : (analysis.contact && analysis.contact.score) || 0;
          qEls.forEach((el, index) => el.classList.toggle('on', index < Math.round(visibleQuality * 5)));
          const elapsedSignal = frames.length > 1 ? (frames[frames.length - 1].t - frames[0].t) / 1000 : 0;
          statusEl.textContent = analysis.ok ? 'Clean optical pulse confirmed.'
            : analysis.reason === 'need_more' ? `${face ? 'Face detected — measuring' : 'Contact found — collecting'} ${Math.min(15, Math.floor(elapsedSignal))}/15 seconds…`
              : (reasonCopy[analysis.reason] || 'Checking signal quality…');
          if (!analysis.ok && elapsedSignal >= 4.8) {
            const liveEstimate = face ? dsp.previewFace(frames) : dsp.previewPulse(frames);
            if (liveEstimate.ok) {
              bpmEl.textContent = Math.round(liveEstimate.bpm);
              const label = bpmEl.parentNode && bpmEl.parentNode.querySelector('small');
              if (label) label.textContent = 'BPM · checking';
              statusEl.textContent = 'Pulse found — confirming that it stays stable…';
            } else if (bpmEl.textContent !== '– –') {
              bpmEl.textContent = '– –';
              const label = bpmEl.parentNode && bpmEl.parentNode.querySelector('small');
              if (label) label.textContent = 'BPM';
            }
          }
          if (analysis.contact) {
            const c = analysis.contact;
            cameraEl.textContent = `${cameraName} · ${deliveredSize}${deliveredFps ? ` · ${deliveredFps.toFixed(0)} fps` : ''} · ${modeTag} · signal ${Math.round(visibleQuality * 100)}%`;
          }
          // analyzePulse already passed contact, artifact, dual-estimator and
          // multi-window stability gates. Do not silently add a second cutoff.
          if (analysis.ok) { finish(analysis.bpm); return; }
        }

        if (performance.now() - startedAt > GIVEUP_MS) {
          if (face) { tapMode(card, 'Couldn’t verify a face pulse — try the fingertip camera, or tap below.'); return; }
          tapMode(card, 'Couldn’t get a clean pulse from the camera. Try tapping instead.');
          return;
        }
      } catch (error) {
        captureActive = false;
        stopCamera();
        tapMode(card, 'The camera signal could not be analysed. Try tapping instead.');
        return;
      }
      scheduleFrame();
    }
    scheduleFrame();
    // WebKit can grant the stream yet never invoke rVFC for a tiny/off-screen
    // video. Fall back to rAF with currentTime de-duplication (still one sample
    // per actual camera frame), then fail clearly if no frame arrives at all.
    frameWatchdog = setTimeout(() => {
      if (!captureActive || receivedFrames) return;
      try { if (videoFrameCallbackId != null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoFrameCallbackId); } catch (e) {}
      videoFrameCallbackId = null;
      useRafFallback = true;
      scheduleFrame();
      frameWatchdog = setTimeout(() => {
        if (captureActive && !receivedFrames) cameraUnavailable(card, isFramed());
      }, 5000);
    }, 1800);

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
      + '<div class="gp-actions">'
      + '<button type="button" class="gp-btn--ghost" data-gp-camera>Use fingertip camera</button>'
      + '<button type="button" class="gp-btn--link" data-gp-faceb>Or read with my face (beta) →</button>'
      + '</div>';
    const area = card.querySelector('[data-gp-taparea]');
    const status = card.querySelector('[data-gp-status]');
    card.querySelector('[data-gp-camera]').addEventListener('click', () => measure(card, { mode: 'finger' }));
    card.querySelector('[data-gp-faceb]').addEventListener('click', () => measure(card, { mode: 'face' }));
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
  // The in-app router (gaia-ui.js) intercepts links, strips the ?tool= param and
  // switches views without a reload — so the auto-open below only fires on a
  // fresh page load / deep link. Catch clicks on any link to this tool (the home
  // free-tools grid) in the capture phase, ahead of the router, and open here.
  document.addEventListener('click', function (e) {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    if (/[?&]tool=pulse(?:&|$)/.test(a.getAttribute('href') || '')) { e.preventDefault(); e.stopImmediatePropagation(); open(); }
  }, true);
  if (new URLSearchParams(window.location.search).get('tool') === 'pulse') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', open); else open();
  }
})();
