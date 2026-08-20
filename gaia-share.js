/** Gaia — Shareable Energy Cards.
 *
 * Renders a premium, branded 9:16 card to a canvas and shares it via the Web
 * Share API (native sheet, Instagram Stories etc.), falling back to a PNG
 * download where sharing files is unsupported.
 *
 * Privacy by construction: a card can ONLY ever contain the day's focus chakra,
 * the intention, the date, and — only if the user opts in — their first name.
 * It never has access to email, date of birth, contact id, membership, or any
 * private field, because it is only ever passed the public daily payload.
 */
(function () {
  'use strict';

  var W = 1080, H = 1920;

  function firstNameOnly(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrap(ctx, text, x, y, maxW, lineH) {
    var words = String(text || '').split(' ');
    var line = '';
    var yy = y;
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, yy); line = words[i]; yy += lineH;
      } else { line = test; }
    }
    if (line) ctx.fillText(line, x, yy);
    return yy;
  }

  function hexToRgb(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '#A6E84B'));
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 166, g: 232, b: 75 };
  }

  function draw(canvas, opts) {
    var ctx = canvas.getContext('2d');
    var accent = opts.color || '#A6E84B';
    var c = hexToRgb(accent);
    canvas.width = W; canvas.height = H;

    // Ground
    ctx.fillStyle = '#070C08';
    ctx.fillRect(0, 0, W, H);

    // Chakra-coloured aura, top third
    var g = ctx.createRadialGradient(W / 2, H * 0.30, 60, W / 2, H * 0.30, W * 0.95);
    g.addColorStop(0, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0.42)');
    g.addColorStop(0.45, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0.10)');
    g.addColorStop(1, 'rgba(7,12,8,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // Soft vignette bottom
    var vg = ctx.createLinearGradient(0, H * 0.55, 0, H);
    vg.addColorStop(0, 'rgba(7,12,8,0)');
    vg.addColorStop(1, 'rgba(7,12,8,0.9)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    // Orb
    ctx.save();
    var og = ctx.createRadialGradient(W / 2, H * 0.30, 10, W / 2, H * 0.30, 190);
    og.addColorStop(0, 'rgba(255,255,255,0.95)');
    og.addColorStop(0.25, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0.95)');
    og.addColorStop(1, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0)');
    ctx.fillStyle = og;
    ctx.beginPath(); ctx.arc(W / 2, H * 0.30, 190, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.textAlign = 'center';

    // Eyebrow
    ctx.fillStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',1)';
    ctx.font = '600 30px Inter, system-ui, sans-serif';
    ctx.save(); ctx.letterSpacing = '8px';
    ctx.fillText((opts.eyebrow || 'MY ENERGY TODAY').toUpperCase(), W / 2, H * 0.46);
    ctx.restore();

    // Chakra name (serif)
    ctx.fillStyle = '#F4F7F1';
    ctx.font = '600 118px "Cormorant Garamond", Georgia, serif';
    ctx.fillText(opts.chakra || 'Heart', W / 2, H * 0.535);

    // Intention
    ctx.fillStyle = 'rgba(244,247,241,0.92)';
    ctx.font = '400 52px "Cormorant Garamond", Georgia, serif';
    var y = wrap(ctx, opts.intention || '', W / 2, H * 0.60, W - 220, 66);

    // Divider
    ctx.strokeStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(W / 2 - 60, y + 60); ctx.lineTo(W / 2 + 60, y + 60); ctx.stroke();

    // Meta (date + optional name)
    ctx.fillStyle = 'rgba(200,214,196,0.85)';
    ctx.font = '500 34px Inter, system-ui, sans-serif';
    var meta = opts.dateLabel || '';
    if (opts.name) meta = opts.name + ' · ' + meta;
    ctx.fillText(meta, W / 2, y + 130);

    // Footer wordmark
    ctx.fillStyle = '#F4F7F1';
    ctx.font = '700 40px Inter, system-ui, sans-serif';
    ctx.fillText('Gaia Healers', W / 2, H - 150);
    ctx.fillStyle = 'rgba(166,232,75,0.9)';
    ctx.font = '500 30px Inter, system-ui, sans-serif';
    ctx.fillText('gaiahealers.app', W / 2, H - 100);
  }

  function dateLabel(iso) {
    try {
      var d = iso ? new Date(iso + 'T00:00:00') : new Date();
      return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    } catch (e) { return ''; }
  }

  function optsFromDaily(daily, includeName) {
    return {
      eyebrow: daily.guest ? "Today's Energy" : 'My Energy Today',
      chakra: (daily.bodyPoint && daily.bodyPoint.chakra) || 'Heart',
      intention: daily.intention || '',
      color: (daily.bodyPoint && daily.bodyPoint.color) || '#A6E84B',
      dateLabel: dateLabel(daily.date),
      name: (includeName && !daily.guest && daily.name) ? firstNameOnly(daily.name) : ''
    };
  }

  async function exportBlob(canvas) {
    return new Promise(function (resolve) { canvas.toBlob(function (b) { resolve(b); }, 'image/png', 0.95); });
  }

  async function shareOrSave(canvas, showStatus) {
    var blob = await exportBlob(canvas);
    if (!blob) { showStatus('Could not build the image.'); return; }
    var file = new File([blob], 'gaia-energy.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'My Gaia Healers energy', text: 'Today’s energy from Gaia Healers' });
        showStatus('Shared.');
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    // Fallback: download the PNG (works in the installed app / desktop).
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'gaia-energy.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    showStatus('Saved to your device.');
  }

  function openDaily(daily) {
    var overlay = document.createElement('div');
    overlay.className = 'gaia-share-modal';
    var canDoName = !daily.guest && !!daily.name;
    overlay.innerHTML = ''
      + '<div class="gaia-share-modal__panel" role="dialog" aria-modal="true" aria-label="Share your energy">'
      + '<button type="button" class="gaia-sheet-close" data-share-close aria-label="Close">×</button>'
      + '<p class="gaia-share-modal__kicker">Share your energy</p>'
      + '<div class="gaia-share-modal__preview"><canvas data-share-canvas></canvas></div>'
      + (canDoName ? '<label class="gaia-share-modal__toggle"><input type="checkbox" data-share-name /> Include my first name</label>' : '')
      + '<p class="gaia-share-modal__note">Only the energy centre, intention and date appear. Never your email, birth date or account.</p>'
      + '<div class="gaia-share-modal__actions">'
      + '<button type="button" class="g-btn g-btn--primary" data-share-go><i class="ph ph-share-network"></i> Share</button>'
      + '</div>'
      + '<p class="gaia-share-modal__status" data-share-status role="status" aria-live="polite"></p>'
      + '</div>';
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';

    var canvas = overlay.querySelector('[data-share-canvas]');
    var nameToggle = overlay.querySelector('[data-share-name]');
    var status = overlay.querySelector('[data-share-status]');
    function showStatus(t) { if (status) status.textContent = t; }
    function repaint() {
      draw(canvas, optsFromDaily(daily, nameToggle && nameToggle.checked));
    }
    // Draw once fonts are ready so the serif renders correctly.
    if (document.fonts && document.fonts.ready) { document.fonts.ready.then(repaint); }
    repaint();

    if (nameToggle) nameToggle.addEventListener('change', repaint);
    overlay.querySelector('[data-share-go]').addEventListener('click', function () { shareOrSave(canvas, showStatus); });
    function close() { overlay.remove(); document.documentElement.style.overflow = ''; }
    overlay.querySelector('[data-share-close]').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  }

  window.GaiaShare = { openDaily: openDaily };
})();
