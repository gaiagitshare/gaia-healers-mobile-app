/** Gaia — Coherence Breathing.
 * A guided paced-breathing session at ~6 breaths per minute (5s in / 5s out),
 * the "resonance" pace widely used to steady the heart rhythm and calm the
 * nervous system. This is a breathing *practice* — it does not measure your
 * heart-rate variability or a coherence score. Real timer, real durations,
 * pause/resume and tab-visibility handling; pure client-side, no data
 * collected. Pairs with Energy Pulse for an optional before/after pulse read.
 */
(function () {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function injectStyles() {
    if (document.getElementById('gaia-breath-styles')) return;
    const st = document.createElement('style');
    st.id = 'gaia-breath-styles';
    st.textContent = `
.gb-modal{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:max(14px,env(safe-area-inset-top)) 14px max(14px,env(safe-area-inset-bottom));}
.gb-modal__backdrop{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 30%,#0b2016,#050b07 75%);}
.gb-card{position:relative;width:100%;max-width:26rem;max-height:calc(100dvh - 28px);overflow:auto;-webkit-overflow-scrolling:touch;color:#eaf4ea;text-align:center;padding:22px 20px calc(20px + env(safe-area-inset-bottom));}
.gb-close{position:absolute;top:6px;right:6px;width:44px;height:44px;border:none;border-radius:50%;background:rgba(255,255,255,.06);color:#cfe6c7;font-size:22px;cursor:pointer;z-index:2;}
.gb-eyebrow{font-size:.72rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#a7e97e;margin:0 0 6px;}
.gb-title{font-size:1.55rem;font-weight:800;letter-spacing:-.02em;margin:0 0 8px;color:#fff;}
.gb-lead{font-size:.92rem;line-height:1.55;color:rgba(234,244,234,.72);margin:0 auto 16px;max-width:22rem;}
.gb-note{font-size:.74rem;line-height:1.5;color:rgba(234,244,234,.5);margin:14px auto 0;max-width:23rem;}
.gb-choices{display:flex;gap:10px;justify-content:center;margin:12px 0 6px;}
.gb-choice{flex:1;max-width:6rem;padding:.7rem .4rem;border-radius:16px;border:1px solid rgba(167,233,126,.28);background:rgba(92,184,46,.08);color:#eaf4ea;font-weight:700;cursor:pointer;}
.gb-choice.on{background:linear-gradient(145deg,#5cb82e,#449422);border-color:transparent;color:#fff;}
.gb-choice small{display:block;font-size:.66rem;font-weight:600;letter-spacing:.05em;color:rgba(234,244,234,.6);margin-top:2px;}
.gb-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:50px;padding:.85rem 1.25rem;border:none;border-radius:999px;background:linear-gradient(145deg,#5cb82e,#449422);color:#fff;font-weight:700;font-size:1rem;cursor:pointer;text-decoration:none;box-shadow:0 8px 24px rgba(92,184,46,.32);}
.gb-btn--ghost{background:transparent;border:1px solid rgba(167,233,126,.3);color:#cfe6c7;box-shadow:none;min-height:46px;font-weight:600;}
.gb-btn--link{background:none;border:none;color:#a7e97e;box-shadow:none;min-height:42px;font-size:.9rem;font-weight:600;width:auto;cursor:pointer;}
.gb-actions{display:flex;flex-direction:column;gap:10px;margin-top:16px;}
.gb-stage{position:relative;width:min(74vw,17rem);height:min(74vw,17rem);margin:10px auto;display:grid;place-items:center;}
.gb-orb{width:100%;height:100%;border-radius:50%;background:radial-gradient(circle at 50% 42%,#7dd956,#3f8c1f 72%);box-shadow:0 0 60px rgba(92,184,46,.5),0 0 0 1px rgba(255,255,255,.12) inset;transform:scale(.5);will-change:transform;}
.gb-ripple{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(167,233,126,.28);}
.gb-phase{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;}
.gb-phase span{font-size:1.35rem;font-weight:700;color:#062b0c;letter-spacing:.01em;text-shadow:0 1px 8px rgba(255,255,255,.35);}
.gb-meta{display:flex;justify-content:center;gap:18px;margin-top:6px;color:rgba(234,244,234,.7);font-size:.85rem;font-variant-numeric:tabular-nums;}
.gb-meta b{color:#fff;font-weight:700;}
@media (prefers-reduced-motion:reduce){.gb-orb{transition:none!important}}
`;
    document.head.appendChild(st);
  }

  const BIOWELL_URL = 'home.html?view=wellness&tab=biowell';
  const IN = 5000, OUT = 5000, CYCLE = IN + OUT; // 6 breaths/min

  let raf = null, timer = null, modal = null, sessionCtl = null;

  function open() {
    injectStyles();
    close();
    modal = document.createElement('div');
    modal.className = 'gb-modal';
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', 'Coherence Breath');
    modal.innerHTML = '<div class="gb-modal__backdrop"></div><div class="gb-card" data-gb-card></div>';
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    intro(modal.querySelector('[data-gb-card]'));
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  function close() {
    if (sessionCtl) { try { sessionCtl.teardown(); } catch (e) {} }
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (timer) { clearInterval(timer); timer = null; }
    document.removeEventListener('keydown', onKey);
    const m = modal || document.querySelector('.gb-modal');
    if (m && m.parentNode) m.parentNode.removeChild(m);
    modal = null; document.body.style.overflow = '';
  }
  function closeBtn() { return '<button type="button" class="gb-close" data-gb-close aria-label="Close">×</button>'; }

  let minutes = 3;
  function intro(card) {
    card.innerHTML = closeBtn()
      + '<p class="gb-eyebrow">Coherence Breathing</p>'
      + '<h2 class="gb-title">Find your resonant breath</h2>'
      + '<p class="gb-lead">Follow the orb: breathe <strong>in as it grows</strong>, <strong>out as it shrinks</strong> — about six slow breaths a minute. This resonance pace is widely used to steady the heart rhythm and settle the nervous system.</p>'
      + '<div class="gb-choices">'
      + [[1, 'quick'], [3, 'classic'], [5, 'deep']].map(([m, lbl]) => '<button type="button" class="gb-choice' + (m === minutes ? ' on' : '') + '" data-gb-min="' + m + '">' + m + ' min<small>' + lbl + '</small></button>').join('')
      + '</div>'
      + '<div class="gb-actions"><button type="button" class="gb-btn" data-gb-begin><i class="ph ph-wind" aria-hidden="true"></i> Begin</button></div>'
      + '<p class="gb-note">A guided breathing practice for calm — not a measurement and not medical treatment. Find a comfortable seat and relax your shoulders.</p>';
    card.querySelector('[data-gb-close]').addEventListener('click', close);
    card.querySelectorAll('[data-gb-min]').forEach((b) => b.addEventListener('click', () => { minutes = Number(b.getAttribute('data-gb-min')) || minutes; intro(card); }));
    card.querySelector('[data-gb-begin]').addEventListener('click', () => session(card));
  }

  function fmt(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  function session(card) {
    const total = minutes * 60 * 1000;
    card.innerHTML = closeBtn()
      + '<p class="gb-eyebrow" data-gb-phaselabel>Get ready…</p>'
      + '<div class="gb-stage"><span class="gb-ripple"></span><div class="gb-orb" data-gb-orb></div><div class="gb-phase"><span data-gb-word>Breathe</span></div></div>'
      + '<div class="gb-meta"><span>Breaths <b data-gb-count>0</b></span><span>Left <b data-gb-left>' + fmt(total) + '</b></span></div>'
      + '<div class="gb-actions">'
      + '<button type="button" class="gb-btn--ghost" data-gb-pause><i class="ph ph-pause" aria-hidden="true"></i> Pause</button>'
      + '<button type="button" class="gb-btn--link" data-gb-end>End session</button>'
      + '</div>';
    card.querySelector('[data-gb-close]').addEventListener('click', close);
    const orb = card.querySelector('[data-gb-orb]');
    const word = card.querySelector('[data-gb-word]');
    const eye = card.querySelector('[data-gb-phaselabel]');
    const countEl = card.querySelector('[data-gb-count]');
    const leftEl = card.querySelector('[data-gb-left]');
    const pauseBtn = card.querySelector('[data-gb-pause]');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ease = (p) => 0.5 - 0.5 * Math.cos(Math.PI * p); // smooth in/out
    // Timing is anchored to the real clock (performance.now), never to a frame
    // count — so the session lasts real wall-clock time even if frames drop.
    let start = performance.now();
    let pausedTotal = 0, pauseAt = 0, paused = false, lastPhase = '';
    if (reduce) orb.style.transition = 'transform ' + (IN / 1000) + 's ease-in-out';

    function draw(now) {
      const elapsed = now - start - pausedTotal;
      if (elapsed >= total) { teardown(); complete(card); return true; }
      const inCycle = elapsed % CYCLE;
      const inhaling = inCycle < IN;
      const p = inhaling ? inCycle / IN : (inCycle - IN) / OUT;
      if (!reduce) { const scale = inhaling ? 0.5 + 0.5 * ease(p) : 1 - 0.5 * ease(p); orb.style.transform = 'scale(' + scale.toFixed(3) + ')'; }
      const phase = inhaling ? 'in' : 'out';
      if (phase !== lastPhase) {
        lastPhase = phase;
        word.textContent = inhaling ? 'Breathe in' : 'Breathe out';
        eye.textContent = inhaling ? 'Fill up slowly' : 'Let it all go';
        if (reduce) orb.style.transform = 'scale(' + (inhaling ? 1 : 0.5) + ')'; // one gentle move per phase
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
      }
      countEl.textContent = Math.floor(elapsed / CYCLE);
      leftEl.textContent = fmt(total - elapsed);
      return false;
    }
    function tick(now) { if (paused) return; if (draw(now)) return; raf = requestAnimationFrame(tick); }
    function doPause() {
      if (paused) return; paused = true; pauseAt = performance.now();
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      pauseBtn.innerHTML = '<i class="ph ph-play" aria-hidden="true"></i> Resume';
      word.textContent = 'Paused'; eye.textContent = 'Paused — tap resume';
    }
    function doResume() {
      if (!paused) return; pausedTotal += performance.now() - pauseAt; paused = false; lastPhase = '';
      pauseBtn.innerHTML = '<i class="ph ph-pause" aria-hidden="true"></i> Pause';
      raf = requestAnimationFrame(tick);
    }
    // Leaving the tab/app auto-pauses, so away-time is never counted and the
    // orb never jumps on return; the user taps Resume to continue.
    function onVis() { if (document.hidden) doPause(); }
    function teardown() { if (raf) { cancelAnimationFrame(raf); raf = null; } document.removeEventListener('visibilitychange', onVis); sessionCtl = null; }

    pauseBtn.addEventListener('click', () => { paused ? doResume() : doPause(); });
    card.querySelector('[data-gb-end]').addEventListener('click', () => { teardown(); intro(card); });
    document.addEventListener('visibilitychange', onVis);
    sessionCtl = { teardown };
    raf = requestAnimationFrame(tick);
  }

  function complete(card) {
    if (sessionCtl) { try { sessionCtl.teardown(); } catch (e) {} }
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    card.innerHTML = closeBtn()
      + '<p class="gb-eyebrow">Session complete</p>'
      + '<div class="gb-stage" style="width:min(52vw,12rem);height:min(52vw,12rem)"><span class="gb-ripple"></span><div class="gb-orb" style="transform:scale(.9)"></div><div class="gb-phase"><i class="ph ph-check" style="font-size:2.6rem;color:#062b0c" aria-hidden="true"></i></div></div>'
      + '<h2 class="gb-title">Nicely done</h2>'
      + '<p class="gb-lead">Resonant breathing like this is widely used to steady the heart rhythm. Notice how you feel now versus a few minutes ago.</p>'
      + '<div class="gb-actions">'
      + '<button type="button" class="gb-btn" data-gb-measure><i class="ph ph-heartbeat" aria-hidden="true"></i> See the difference — read my pulse</button>'
      + '<a class="gb-btn--ghost" href="' + esc(BIOWELL_URL) + '">Go deeper with a Bio-Well scan →</a>'
      + '<button type="button" class="gb-btn--link" data-gb-again>Breathe again</button>'
      + '</div>'
      + '<p class="gb-note">A calming breathing practice for reflection — not a measurement or medical treatment.</p>';
    card.querySelector('[data-gb-close]').addEventListener('click', close);
    card.querySelector('[data-gb-again]').addEventListener('click', () => intro(card));
    const m = card.querySelector('[data-gb-measure]');
    if (m) m.addEventListener('click', () => { close(); if (window.GaiaPulse && window.GaiaPulse.open) window.GaiaPulse.open(); else location.href = 'home.html?view=wellness&tool=pulse'; });
  }

  window.GaiaBreath = { open, close };
  // The in-app router (gaia-ui.js) intercepts links, strips the ?tool= param and
  // switches views without a reload — so the auto-open below only fires on a
  // fresh page load / deep link. Catch clicks on any link to this tool (the home
  // free-tools grid) in the capture phase, ahead of the router, and open here.
  document.addEventListener('click', function (e) {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    if (/[?&]tool=breath(?:&|$)/.test(a.getAttribute('href') || '')) { e.preventDefault(); e.stopImmediatePropagation(); open(); }
  }, true);
  if (new URLSearchParams(window.location.search).get('tool') === 'breath') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', open); else open();
  }
})();
