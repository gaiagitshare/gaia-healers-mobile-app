/**
 * MY READINGS — a member's own Bio-Well results, inside You.
 *
 * No AI is involved on this screen. The member asks for a code (that is their
 * consent), reads it to their practitioner, and once the practitioner confirms,
 * the member's latest reading, trend and shared documents are shown straight
 * from the server. The member can stop sharing at any time.
 *
 * Everything comes from /api/practitioners/member-link/* and
 * /api/practitioners/my-readings; nothing is cached in the browser. The
 * "In short" summary is written by the server from plain rules (no model).
 *
 * Gaia Assist can only OPEN this card: the voice page and the text chat
 * dispatch `gaia:open-readings` (also honoured as `?section=readings` in the
 * URL) and the card scrolls into view and glows for a moment.
 *
 * Around the card, all from the same two routes and the same numbers:
 *   - a one-line nudge on Today and a dot on the You tab while a reading is
 *     newer than the last one the member opened (status.new_reading); opening
 *     the card records it as seen;
 *   - "centre of the week": the quietest chakra of the latest reading and the
 *     Energy tool that suits it (a fixed table, no model);
 *   - "save as image": the summary and gauges drawn on a canvas, kept on the
 *     device (share sheet where there is one, otherwise a download);
 *   - "compare any two": the member picks two dates from their own series.
 */
(function () {
  'use strict';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const proxyBase = () => (window.GaiaApi && window.GaiaApi.base && window.GaiaApi.base()) || (window.GaiaConfig && window.GaiaConfig.proxyBase) || window.GAIA_PROXY_BASE || 'https://api.gaiahealers.app';
  const api = async (path, opts = {}) => {
    const res = await fetch(`${proxyBase()}${path}`, { credentials: 'include', headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, method: opts.method || 'GET', body: opts.body ? JSON.stringify(opts.body) : undefined });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && body.ok !== false, status: res.status, body };
  };
  async function copyText(text) {
    if (!text) throw new Error('Nothing to copy');
    try { await navigator.clipboard.writeText(text); return; } catch { /* older browsers */ }
    const input = document.createElement('textarea'); input.value = text;
    input.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(input);
    const previous = document.activeElement;
    try { input.focus(); input.select(); if (!document.execCommand('copy')) throw new Error('Copy unavailable'); }
    finally { input.remove(); previous?.focus?.({ preventScroll: true }); }
  }
  // A bare "2026-10-02" is read as UTC midnight, which is the day before west
  // of Greenwich; date-only values are taken as midday local instead.
  const asDate = (iso) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) ? iso + 'T12:00:00' : iso);
  // How old a reading is, said plainly. A scan is a snapshot of the day it was
  // taken: an older one is "your latest reading", never "today's energy".
  function ageOf(iso) {
    if (!iso) return null;
    const d = asDate(iso); if (isNaN(d)) return null;
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const day = new Date(d); day.setHours(12, 0, 0, 0);
    const days = Math.round((today - day) / 86400000);
    const label = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 14 ? days + ' days ago' : days < 60 ? Math.round(days / 7) + ' weeks ago' : Math.round(days / 30) + ' months ago';
    return { days, label, stale: days > 30 };
  }
  const when = (iso) => { if (!iso) return ''; try { const d = asDate(iso); return isNaN(d) ? String(iso) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch { return ''; } };
  const short = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; } };
  const fmt = (v, d = 0) => (typeof v === 'number' ? v.toFixed(d) : '—');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const card = (inner, extra = '') => `<article class="g-card g-readings${extra}"><p class="g-card__label">My readings</p>${inner}</article>`;
  const signed = (v, d = 1, goodWhenNegative = false) => {
    if (typeof v !== 'number') return '<span class="g-readings__delta">—</span>';
    const good = goodWhenNegative ? v < 0 : v > 0;
    const cls = v === 0 ? '' : (good ? ' is-good' : ' is-bad');
    return `<span class="g-readings__delta${cls}">${v > 0 ? '+' : ''}${v.toFixed(d)}</span>`;
  };

  // ── the seven centres: traditional colours, matched by name, else by order ──
  const CHAKRAS = [
    { key: /root|muladhara|base/i, colour: '#e0463f', short: 'Root' },
    { key: /sacral|svadhisthana|swadhisthana/i, colour: '#f08a3c', short: 'Sacral' },
    { key: /solar|manipura|navel/i, colour: '#f2c94c', short: 'Solar plexus' },
    { key: /heart|anahata/i, colour: '#4fc27a', short: 'Heart' },
    { key: /throat|vishuddh/i, colour: '#4aa8e0', short: 'Throat' },
    { key: /third|brow|ajna/i, colour: '#5b5bd6', short: 'Third eye' },
    { key: /crown|sahasrara/i, colour: '#a060d8', short: 'Crown' },
  ];
  const chakraMeta = (c, i) => CHAKRAS.find((m) => m.key.test(String(c.name || ''))) || CHAKRAS[i] || { colour: 'var(--g-accent)', short: c.name };
  // Centre of the week: the quietest centre, and which Energy tool suits it. A fixed table.
  const CENTRE_CUES = {
    Root: { tool: 'breath', toolLabel: 'Breath', cue: 'Slow, grounding breaths with both feet on the floor.' },
    Sacral: { tool: 'colour', toolLabel: 'Colour', cue: 'Warm orange, and let the hips move a little today.' },
    'Solar plexus': { tool: 'breath', toolLabel: 'Breath', cue: 'A longer exhale than inhale, a few rounds, when the day gets busy.' },
    Heart: { tool: 'chakra', toolLabel: 'Chakra', cue: 'One kind thought for someone, and one for yourself.' },
    Throat: { tool: 'colour', toolLabel: 'Colour', cue: 'Hum, sing, or say the thing you have been holding.' },
    'Third eye': { tool: 'chakra', toolLabel: 'Chakra', cue: 'A quiet minute with your eyes closed, no screen.' },
    Crown: { tool: 'chakra', toolLabel: 'Chakra', cue: 'Sit still for a moment and let things be as they are.' },
  };
  function centreOfTheWeek(chakras) {
    const list = (chakras || []).map((c, i) => ({ c, m: chakraMeta(c, i) })).filter((x) => typeof x.c.value === 'number');
    if (list.length < 2) return '';
    const q = list.reduce((a, b) => (b.c.value < a.c.value ? b : a));
    const cue = CENTRE_CUES[q.m.short] || CENTRE_CUES.Heart;
    return `<section class="g-readings__sec g-readings__centre">
      <p class="g-readings__kicker">Centre of the week</p>
      <div class="g-readings__centre-row"><i class="g-readings__centre-disc" style="background:${q.m.colour}"></i>
        <div><p class="g-readings__lead">${esc(q.c.name)} was the quietest in your latest reading.</p><p class="g-readings__muted">${esc(cue.cue)}</p></div></div>
      <div class="g-card__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-readings-action="tool" data-tool="${esc(cue.tool)}">Open the ${esc(cue.toolLabel)} tool</button></div>
    </section>`;
  }
  /** The member picks any two dates from their own series; the difference is arithmetic on screen. */
  function comparePicker(series) {
    const pts = (series || []).filter((p) => p && p.d);
    if (pts.length < 2) return '';
    // The day is enough to tell scans apart; the time is added only when two
    // fall on the same day (a long date-time was cut off in the select).
    const dayOf = (p) => when(p.at || p.d);
    const sameDay = (p) => pts.filter((q) => dayOf(q) === dayOf(p)).length > 1;
    const label = (p) => (p.at && sameDay(p) ? dayOf(p) + ', ' + new Date(p.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : dayOf(p));
    const opt = (sel) => pts.map((p) => `<option value="${esc(p.id || p.d)}"${(p.id || p.d) === sel ? ' selected' : ''}>${esc(label(p))}</option>`).join('');
    return `<section class="g-readings__sec g-readings__pick" data-readings-pick>
      <p class="g-readings__kicker">Compare available scans</p><p class="g-readings__muted">Choose two readings from the recent history available here.</p>
      <div class="g-readings__pick-row">
        <label><span>From</span><select data-pick="from">${opt(pts[0].id || pts[0].d)}</select></label>
        <label><span>To</span><select data-pick="to">${opt(pts[pts.length - 1].id || pts[pts.length - 1].d)}</select></label>
      </div>
      <p class="g-readings__pick-out" aria-live="polite"></p>
    </section>`;
  }
  function pickOut(root, series) {
    const box = root.querySelector('[data-readings-pick]'); if (!box) return;
    const from = box.querySelector('[data-pick="from"]').value, to = box.querySelector('[data-pick="to"]').value;
    const a = series.find((p) => (p.id || p.d) === from), b = series.find((p) => (p.id || p.d) === to);
    const out = box.querySelector('.g-readings__pick-out');
    if (!a || !b) { out.textContent = ''; return; }
    if (from === to) { out.textContent = 'Choose two different scans.'; return; }
    const d = (x, y, dec) => (typeof x === 'number' && typeof y === 'number' ? y - x : null);
    out.innerHTML = `${esc(short(a.d))} → ${esc(short(b.d))}: stress ${signed(d(a.s, b.s), 2, true)} · energy ${signed(d(a.e, b.e), 1)}`;
  }

  /** The summary and gauges on a canvas, for the member's own camera roll or a message to their practitioner. Stays on the device. */
  async function saveImage(r) {
    const W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const cs = getComputedStyle(document.documentElement);
    const tok = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
    g.fillStyle = '#071009'; g.fillRect(0, 0, W, H);
    const accent = '#75f05a', text = '#f5f7f5', muted = '#a8b3ad', line = 'rgba(160,255,185,0.18)';
    const wrap = (s, x, y, max, lh, font, colour) => { g.font = font; g.fillStyle = colour; const words = String(s).split(' '); let ln = ''; for (const w of words) { const t = ln ? ln + ' ' + w : w; if (g.measureText(t).width > max && ln) { g.fillText(ln, x, y); y += lh; ln = w; } else ln = t; } if (ln) { g.fillText(ln, x, y); y += lh; } return y; };
    g.fillStyle = accent; g.font = '700 26px "Plus Jakarta Sans", sans-serif'; g.fillText('MY READINGS · GAIA HEALERS', 72, 96);
    g.fillStyle = muted; g.font = '400 26px "Plus Jakarta Sans", sans-serif'; g.fillText(`Shared by ${r.practitioner?.name || 'your practitioner'} · ${when(r.latest?.scanned_at)}`, 72, 140);
    let y = wrap(r.summary?.headline || '', 72, 220, W - 144, 60, '600 52px "Cormorant Garamond", serif', text);
    const arc = (cx, cy, val, min, max, good, label, unit, dec) => {
      const R = 120, s0 = Math.PI * 0.75, sw = Math.PI * 1.5;
      g.lineWidth = 22; g.lineCap = 'round';
      g.strokeStyle = line; g.beginPath(); g.arc(cx, cy, R, s0, s0 + sw); g.stroke();
      if (good) { g.strokeStyle = 'rgba(66,219,134,0.35)'; g.lineCap = 'butt'; g.beginPath(); g.arc(cx, cy, R, s0 + sw * (good[0] - min) / (max - min), s0 + sw * (good[1] - min) / (max - min)); g.stroke(); g.lineCap = 'round'; }
      if (typeof val === 'number') { const t = clamp((val - min) / (max - min), 0, 1); const ok = good && val >= good[0] && val <= good[1]; g.strokeStyle = ok ? '#42db86' : accent; g.beginPath(); g.arc(cx, cy, R, s0, s0 + sw * t); g.stroke(); }
      g.fillStyle = text; g.textAlign = 'center'; g.font = '600 64px "Cormorant Garamond", serif'; g.fillText(typeof val === 'number' ? val.toFixed(dec) : '—', cx, cy + 20);
      g.fillStyle = muted; g.font = '400 24px "Plus Jakarta Sans", sans-serif'; g.fillText(unit, cx, cy + 56); g.fillText(label, cx, cy + R + 60); g.textAlign = 'left';
    };
    y += 120; arc(W / 2 - 220, y + 40, r.latest?.energy, 0, 100, [40, 70], 'Energy', 'J ×10⁻²', 0); arc(W / 2 + 220, y + 40, r.latest?.stress, 0, 10, [2, 4], 'Stress', 'of 10', 2);
    y += 300;
    for (const l of (r.summary?.lines || [])) { y = wrap('• ' + l, 72, y, W - 144, 40, '400 28px "Plus Jakarta Sans", sans-serif', text) + 10; }
    g.fillStyle = muted; g.font = '400 22px "Plus Jakarta Sans", sans-serif'; g.fillText('Reflective wellness measurements, not a diagnosis. gaiahealers.app', 72, H - 60);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    const file = new File([blob], `gaia-readings-${r.latest?.scanned_at || 'latest'}.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'My readings' }); return; } catch { /* fall through to download */ } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ── Today nudge and the dot on the You tab: only "a newer reading exists", never a value ──
  let nudgeObserver = null, todayState = { linked: false, fresh: false, scannedAt: null };
  /** The Today shortcut: always there for a linked member, lit while a reading is newer than the last one opened. The dot on You only while new. */
  function setTodayLink(next) {
    todayState = { ...todayState, ...next };
    const { linked, fresh, scannedAt } = todayState;
    document.querySelectorAll('a[data-app-nav="profile"]').forEach((a) => a.classList.toggle('has-new-reading', linked && fresh));
    const place = () => {
      const home = document.querySelector('#daily-superapp [data-today-readings]') || document.querySelector('#home-superapp .g-super-home');
      let el = document.getElementById('readings-nudge');
      if (!linked) { el?.remove(); return; }
      if (!home) return;
      if (!el) {
        el = document.createElement('a');
        el.id = 'readings-nudge'; el.href = 'home.html?view=profile&section=readings';
        el.addEventListener('click', (e) => { e.preventDefault(); try { window.GaiaAppShell?.go?.('profile'); } catch { /* ignore */ } window.setTimeout(() => window.dispatchEvent(new CustomEvent('gaia:open-readings')), 80); });
        // On Today: its own slot under the greeting. On Home: right under the hero.
        const hero = home.matches('[data-today-readings]') ? null : home.querySelector('.g-super-hero');
        if (hero) hero.insertAdjacentElement('afterend', el); else home.prepend(el);
      }
      el.className = `g-readings-nudge${fresh ? ' is-new' : ''}`;
      // The two headline numbers ride along once the readings have loaded (they
      // are fetched for this page anyway; nothing is stored for it).
      const l = lastReadings?.latest;
      const nums = l && (typeof l.energy === 'number' || typeof l.stress === 'number')
        ? `<span class="g-readings-nudge__nums">${typeof l.energy === 'number' ? `<b>${esc(fmt(l.energy))}</b> energy` : ''}${typeof l.energy === 'number' && typeof l.stress === 'number' ? ' · ' : ''}${typeof l.stress === 'number' ? `<b>${esc(fmt(l.stress, 2))}</b> stress` : ''}</span>` : '';
      const age = ageOf(scannedAt);
      const ageText = age ? ` · ${esc(when(scannedAt))}, ${esc(age.label)}` : '';
      const html = fresh
        ? `<i class="ph ph-pulse" aria-hidden="true"></i><span><strong>A new reading from your practitioner</strong>${ageText}${nums}</span><em>Open</em>`
        : `<i class="ph ph-pulse" aria-hidden="true"></i><span><strong>${age && age.stale ? 'Your last reading' : 'Your latest reading'}</strong>${ageText}${nums}${age && age.stale ? '<small class="g-readings-nudge__hint">A new scan would show where you are now.</small>' : ''}</span><em>Open</em>`;
      // Only rewrite when something changed: the observer watches the screen's children and a rewrite must never re-trigger it.
      if (el.innerHTML !== html) el.innerHTML = html;
    };
    place();
    if (linked && !nudgeObserver) {
      const root = document.getElementById('daily-superapp') || document.getElementById('home-superapp');
      if (root && 'MutationObserver' in window) { nudgeObserver = new MutationObserver(place); nudgeObserver.observe(root, { childList: true }); }   // childList only: never the row's own contents
    }
    if (!linked && nudgeObserver) { nudgeObserver.disconnect(); nudgeObserver = null; }
  }
  const setNewReading = (fresh, scannedAt) => setTodayLink(scannedAt === undefined ? { fresh } : { fresh, scannedAt });

  // ── graphics: inline SVG, drawn to scale, coloured through the theme tokens ──
  /** A three-quarter arc gauge. `value` on [min,max]; `good` is the comfortable band, drawn under the arc. */
  function gauge({ value, min, max, label, unit, good, decimals = 0, lowerIsBetter = false }) {
    const has = typeof value === 'number';
    const t = has ? clamp((value - min) / (max - min), 0, 1) : 0;
    const R = 44, C = 56, start = 135, sweep = 270;
    const pt = (deg) => { const a = (deg * Math.PI) / 180; return [C + R * Math.cos(a), C + R * Math.sin(a)]; };
    const arc = (from, to) => { const [x1, y1] = pt(start + from * sweep), [x2, y2] = pt(start + to * sweep); return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 ${(to - from) * sweep > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`; };
    const band = good ? arc(clamp((good[0] - min) / (max - min), 0, 1), clamp((good[1] - min) / (max - min), 0, 1)) : '';
    const inBand = has && good && value >= good[0] && value <= good[1];
    const tone = !has ? '' : (inBand ? ' is-good' : (lowerIsBetter ? (value > good[1] ? ' is-high' : ' is-low') : (value < good[0] ? ' is-low' : ' is-high')));
    return `<figure class="g-readings__gauge${tone}" role="img" aria-label="${esc(label)} ${esc(has ? value.toFixed(decimals) : 'not available')}${unit ? ' ' + esc(unit) : ''}">
      <svg viewBox="0 0 112 96" aria-hidden="true">
        <path class="g-readings__gauge-track" d="${arc(0, 1)}"/>
        ${band ? `<path class="g-readings__gauge-band" d="${band}"/>` : ''}
        ${has && t > 0 ? `<path class="g-readings__gauge-fill" d="${arc(0, t)}"/>` : ''}
        <text class="g-readings__gauge-n" x="56" y="60" text-anchor="middle">${esc(has ? value.toFixed(decimals) : '—')}</text>
        <text class="g-readings__gauge-u" x="56" y="74" text-anchor="middle">${esc(unit || '')}</text>
        <text class="g-readings__gauge-min" x="22" y="92">${esc(min)}</text>
        <text class="g-readings__gauge-max" x="90" y="92" text-anchor="end">${esc(max)}</text>
      </svg>
      <figcaption>${esc(label)}${good ? `<span class="g-readings__muted"> · comfortable ${esc(good[0])}–${esc(good[1])}</span>` : ''}</figcaption>
    </figure>`;
  }
  /** Energy and stress over the dated points we were given: one line each, newest point emphasised. */
  function sparkline(series) {
    const pts = (series || []).filter((p) => p && p.d);
    if (pts.length < 2) return '';
    const W = 320, H = 96, padX = 8, top = 10, bottom = 22;
    const x = (i) => padX + (i * (W - 2 * padX)) / (pts.length - 1);
    const line = (key, lo, hi) => {
      const ys = pts.map((p) => (typeof p[key] === 'number' ? p[key] : null));
      if (ys.filter((v) => v != null).length < 2) return null;
      const vals = ys.filter((v) => v != null);
      const min = lo ?? Math.min(...vals), max = hi ?? Math.max(...vals), span = (max - min) || 1;
      const y = (v) => top + (1 - (v - min) / span) * (H - top - bottom);
      const d = ys.map((v, i) => (v == null ? null : `${x(i).toFixed(1)} ${y(v).toFixed(1)}`)).filter(Boolean);
      const last = ys.map((v, i) => [v, i]).filter(([v]) => v != null).pop();
      return { path: 'M' + d.join(' L'), end: [x(last[1]), y(last[0])], latest: last[0] };
    };
    const e = line('e'), s = line('s');
    if (!e && !s) return '';
    const first = pts[0].d, lastD = pts[pts.length - 1].d;
    return `<figure class="g-readings__spark" role="img" aria-label="Energy and stress across ${pts.length} readings from ${esc(first)} to ${esc(lastD)}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <line class="g-readings__spark-grid" x1="${padX}" x2="${W - padX}" y1="${top}" y2="${top}"/>
        <line class="g-readings__spark-grid" x1="${padX}" x2="${W - padX}" y1="${H - bottom}" y2="${H - bottom}"/>
        ${e ? `<path class="g-readings__spark-e" d="${e.path}"/><circle class="g-readings__spark-e-dot" cx="${e.end[0].toFixed(1)}" cy="${e.end[1].toFixed(1)}" r="3.5"/>` : ''}
        ${s ? `<path class="g-readings__spark-s" d="${s.path}"/><circle class="g-readings__spark-s-dot" cx="${s.end[0].toFixed(1)}" cy="${s.end[1].toFixed(1)}" r="3.5"/>` : ''}
      </svg>
      <figcaption><span>${esc(short(first))}</span><span class="g-readings__spark-key">${e ? '<i class="is-e"></i>energy' : ''}${s ? '<i class="is-s"></i>stress' : ''}</span><span>${esc(short(lastD))}</span></figcaption>
    </figure>`;
  }
  /** The seven centres as one row of discs, bigger when more active, in their own colours. */
  function spectrum(chakras) {
    const list = (chakras || []).slice(0, 7);
    if (!list.length) return '';
    // Disc size is relative to this reading's own spread, so the difference between
    // the most and least active centre is visible even when all seven sit close.
    const vals = list.map((c) => c.value).filter((v) => typeof v === 'number');
    const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1;
    return `<div class="g-readings__spectrum" role="img" aria-label="Seven energy centres, larger when more active">${list.map((c, i) => {
      const m = chakraMeta(c, i), v = typeof c.value === 'number' ? c.value : null;
      const size = v == null ? 10 : Math.round(14 + clamp((v - lo) / span, 0, 1) * 22);
      return `<span class="g-readings__disc" title="${esc(c.name)} ${esc(fmt(v, 2))}"><i style="width:${size}px;height:${size}px;background:${m.colour}"></i><b>${esc(m.short)}</b></span>`;
    }).join('')}</div>`;
  }

  // ── cards ──
  function consentCard(status) {
    return card(`
      <p class="g-readings__lead">See your own Bio-Well readings here, shared by your practitioner.</p>
      <p class="g-readings__muted">You ask for a code and give it to your practitioner. They enter it on their side and confirm it is you. You can stop sharing at any time. Your results are shown to you only; Gaia does not keep a copy.</p>
      ${status.code_active ? `<p class="g-readings__muted">A code is already active until ${esc(when(status.code_expires_at))}.</p>` : ''}
      <div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-readings-action="code">${status.code_active ? 'Show a new code' : 'Share with my practitioner'}</button></div>`);
  }
  function codeCard(out) {
    const groups = String(out.code || '').match(/.{1,4}/g) || [];
    return card(`
      <p class="g-readings__lead">Your link code</p>
      <p class="g-readings__code" data-link-code="${esc(out.code)}" aria-label="Link code">${groups.map(esc).join('<span class="g-readings__code-gap"> </span>')}</p>
      <p class="g-readings__muted">Read it to your practitioner. It works once and expires ${esc(when(out.expires_at))}. Your agreement to share was recorded ${esc(when(out.consent_recorded_at))}.</p>
      <div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-readings-action="copy-code">Copy code</button><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-readings-action="refresh">I have given it — check</button></div>`);
  }
  /** Three small cards on what the screen shows. Open on the member's first visit (nothing opened yet), folded afterwards. */
  function explainer(firstVisit) {
    return `<details class="g-readings__explain"${firstVisit ? ' open' : ''}>
      <summary>What these mean</summary>
      <div class="g-readings__explain-grid">
        <div class="g-readings__explain-card"><strong>Energy</strong><span>How much light your fingertips gave off in the scan, on a 0–100 scale. Most people sit between 40 and 70; higher is not always better.</span></div>
        <div class="g-readings__explain-card"><strong>Stress</strong><span>How much the pattern looks like a body under load, 0–10. Around 2–4 is comfortable; above 4 is worth a conversation with your practitioner.</span></div>
        <div class="g-readings__explain-card"><strong>Seven centres</strong><span>The seven chakras from root to crown, each 0–10 for how active it is, and whether it sits centred or pulled to one side. Balance matters more than any single number.</span></div>
      </div>
    </details>`;
  }
  /** Folded: the In short block and one button. The whole card is one tap away, and Gaia's "open my readings" unfolds it. */
  function averageCard(a, series) {
    if (!a || a.count < 3) return '<p class="g-readings__muted">A three-scan average needs three dated readings with both energy and stress.</p>';
    const metric = (label, value, max, decimals) => `<div><span>${label} average</span><strong>${esc(fmt(value, decimals))}</strong><span class="g-readings__bar"><span style="width:${clamp(value / max * 100, 0, 100)}%"></span></span></div>`;
    // Name the three scans the average is made of (the newest three of the
    // series, which is what the server averaged), so a wide range is not read
    // as "all of last winter". Same-day scans keep their own entry.
    const three = Array.isArray(series) ? series.slice(-3).map((p) => p && p.at).filter(Boolean) : [];
    // Two scans on one day read as "2 scans on Nov 8, 2025", not the date twice.
    const grouped = [];
    for (const at of three) { const day = when(at); const last = grouped[grouped.length - 1]; if (last && last.day === day) last.n += 1; else grouped.push({ day, n: 1 }); }
    const span = three.length === 3 ? grouped.map((g) => esc(g.n > 1 ? `${g.n} scans on ${g.day}` : g.day)).join(' · ') : `${esc(when(a.from))}–${esc(when(a.to))}`;
    return `<p class="g-readings__muted">Average of the latest 3 complete scans · <span class="g-readings__avg-dates">${span}</span></p><div class="g-readings__averages">${metric('Energy', a.energy, 100, 1)}${metric('Stress', a.stress, 10, 2)}</div>`;
  }
  function foldedCard(r) {
    const practitioner = r.practitioner || {}, summary = r.summary || {};
    return card(`
      <p class="g-card__meta">Shared by <strong>${esc(practitioner.name || 'your practitioner')}</strong> · since ${esc(when(r.linked_at))}${r.scans_on_file != null ? ` · ${esc(r.scans_on_file)} reading${r.scans_on_file === 1 ? '' : 's'} on file` : ''}</p>
      ${summary.headline ? `<div class="g-readings__summary"><p class="g-readings__kicker">In short</p><p class="g-readings__headline">${esc(summary.headline)}</p>${averageCard(r.average_recent, r.series)}</div>` : ''}
      <div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-readings-action="expand">Open my full readings</button></div>`, ' g-readings--folded');
  }
  function readingsCard(r, status = {}, prefs = {}) {
    const latest = r.latest, trend = r.trend, summary = r.summary || {};
    // "What these mean" stays open until the member folds it once; the choice
    // is kept on the server (prefs), so their phone and laptop agree.
    const firstVisit = !prefs.readings_explainer_collapsed;
    const readFirst = (r.files || []).filter((f) => f.first);
    const practitioner = r.practitioner || {};
    const chakraRow = (c, i) => {
      const m = chakraMeta(c, i), v = typeof c.value === 'number' ? c.value : null;
      const w = v == null ? 0 : Math.max(4, Math.min(100, Math.round((v / 10) * 100)));
      return `<li class="g-readings__chakra"><span class="g-readings__chakra-name"><i class="g-readings__dot" style="background:${m.colour}"></i>${esc(c.name)}</span><span class="g-readings__bar" aria-hidden="true"><span style="width:${w}%;background:${m.colour}"></span></span><span class="g-readings__chakra-val">${esc(fmt(v, 2))}</span></li>`;
    };
    const sev = (f) => `<li class="g-readings__flag"><span>${esc(f.name)}${f.area ? ` <span class="g-readings__muted">${esc(f.area)}</span>` : ''}</span><span class="g-readings__pill${f.severity === 'high' ? ' is-high' : (f.severity === 'elevated' ? ' is-elevated' : '')}">${esc(f.direction || '')}${f.severity ? ` · ${esc(f.severity)}` : ''}</span></li>`;
    const worst = (d) => `<li class="g-readings__flag"><span>${esc(d.name)} <span class="g-readings__muted">${esc(d.area)}</span></span><span class="g-readings__pill">${esc(fmt(d.disbalance))}%</span></li>`;
    const compare = (c) => `<li class="g-readings__pair"><span class="g-readings__pair-when">${esc(when(c.from))} → ${esc(when(c.to))}<span class="g-readings__muted"> · ${esc(c.basis)}</span></span><span class="g-readings__pair-deltas">stress ${signed(c.stress_change, 2, true)} · energy ${signed(c.energy_change, 1)}</span></li>`;
    const file = (f) => f.url
      ? `<a class="g-row g-row--link" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(f.name)}</span><span class="g-row__meta">${esc(when(f.uploaded_at) || 'open')}</span></a>`
      : `<div class="g-row"><span>${esc(f.name)}</span><span class="g-row__meta">${esc(when(f.uploaded_at))}</span></div>`;
    const sec = (kicker, inner, cls = '') => `<section class="g-readings__sec${cls}"><p class="g-readings__kicker">${kicker}</p>${inner}</section>`;

    const spark = sparkline(r.series);
    const note = latest?.note ? `<section class="g-readings__sec g-readings__pnote"><p class="g-readings__kicker">A note from ${esc(practitioner.name || 'your practitioner')}</p><p class="g-readings__lead g-readings__pnote-text">${esc(latest.note)}</p></section>` : '';
    return card(`
      <p class="g-card__meta">Shared by <strong>${esc(practitioner.name || 'your practitioner')}</strong>${practitioner.specialty ? ` · ${esc(practitioner.specialty)}` : ''}${practitioner.location ? ` · ${esc(practitioner.location)}` : ''}<br>since ${esc(when(r.linked_at))}${r.scans_on_file != null ? ` · ${esc(r.scans_on_file)} reading${r.scans_on_file === 1 ? '' : 's'} on file` : ''} · <button type="button" class="g-readings__linkbtn" data-readings-action="whosees" aria-expanded="false">What can they see?</button></p>
      <div class="g-readings__whosees" hidden>
        <p class="g-readings__kicker">What ${esc(practitioner.name || 'your practitioner')} can see</p>
        <ul class="g-readings__lines">
          <li>The readings they recorded in Bio-Well. They always had these; sharing changed nothing on their side.</li>
          <li>That you asked to see them in Gaia (since ${esc(when(r.linked_at))}) and whether you have opened the latest one.</li>
        </ul>
        <p class="g-readings__kicker">What they cannot see</p>
        <ul class="g-readings__lines">
          <li>Anything else in your Gaia app: your daily energy checks, journal, messages, courses or bookings.</li>
          <li>Your Gaia account itself. Their system knows you only as their client; Gaia never sends them your member details.</li>
        </ul>
        <p class="g-readings__muted">Gaia keeps no copy of the readings and no AI reads the values. Stop sharing below at any time; they are told the same minute.</p>
      </div>

      ${summary.headline ? `<div class="g-readings__summary">
        <p class="g-readings__kicker">In short</p>
        <p class="g-readings__headline">${esc(summary.headline)}</p>
        ${averageCard(r.average_recent, r.series)}<details><summary>Reading details</summary><ul class="g-readings__lines">${(summary.lines || []).map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details>
        <div class="g-card__actions"><button type="button" class="g-btn g-btn--ghost g-btn--sm" data-readings-action="copy">Copy summary</button><button type="button" class="g-btn g-btn--ghost g-btn--sm" data-readings-action="image">Save as image</button></div>
      </div>` : ''}

      ${latest ? `<div class="g-readings__hero">
        ${gauge({ value: latest.energy, min: 0, max: 100, label: 'Energy', unit: 'J ×10⁻²', good: [40, 70], decimals: 0 })}
        ${gauge({ value: latest.stress, min: 0, max: 10, label: 'Stress', unit: 'of 10', good: [2, 4], decimals: 2, lowerIsBetter: true })}
        ${spark || spectrum(latest.chakras)}
      </div>
      <p class="g-readings__muted g-readings__when">Latest reading ${esc(when(latest.scanned_at))}${latest.source === 'trend' ? ' · taken from your reading history; the full detail of this scan was not available' : ''}</p>` : '<p class="g-empty">No reading on file yet.</p>'}

      ${readFirst.length ? `<section class="g-readings__sec g-readings__first"><p class="g-readings__kicker">Read this first</p><div class="g-rows">${readFirst.map(file).join('')}</div><p class="g-readings__muted">Marked by ${esc(practitioner.name || 'your practitioner')} as the place to start.</p></section>` : ''}
      ${note}
      ${explainer(firstVisit)}
      <div class="g-readings__grid">
        ${latest && (latest.chakras || []).length ? sec('Your seven centres', `${spark ? spectrum(latest.chakras) : ''}<ul class="g-readings__chakras">${latest.chakras.map(chakraRow).join('')}</ul>`, ' g-readings__sec--wide') : ''}
        ${latest && (latest.most_out_of_balance || []).length ? sec('Most out of balance', `<ul class="g-readings__flags">${latest.most_out_of_balance.map(worst).join('')}</ul>`) : ''}
        ${trend && (trend.energy || trend.stress) ? sec('Last 90 days', `
          <div class="g-readings__stats">
            <div class="g-readings__stat"><span class="g-readings__stat-n">${esc(fmt(trend.energy?.lowest, 1))}–${esc(fmt(trend.energy?.highest, 1))}</span><span class="g-readings__stat-l">Energy range · avg ${esc(fmt(trend.energy?.average, 1))}</span></div>
            <div class="g-readings__stat"><span class="g-readings__stat-n">${esc(fmt(trend.stress?.lowest, 1))}–${esc(fmt(trend.stress?.highest, 1))}</span><span class="g-readings__stat-l">Stress range · avg ${esc(fmt(trend.stress?.average, 1))}</span></div>
          </div>
          ${(trend.flagged || []).length ? `<ul class="g-readings__flags">${trend.flagged.map(sev).join('')}</ul>` : '<p class="g-readings__muted">Nothing flagged in this period.</p>'}`) : ''}
        ${(r.comparisons || []).length ? sec('Before and after sessions', `<ul class="g-readings__pairs">${r.comparisons.map(compare).join('')}</ul>`) : ''}
        ${(r.files || []).some((f) => !f.first) ? sec('Documents from your practitioner', `<div class="g-rows">${r.files.filter((f) => !f.first).map(file).join('')}</div>`) : ''}
        ${latest ? centreOfTheWeek(latest.chakras) : ''}
        ${comparePicker(r.series)}
      </div>

      <p class="g-readings__muted g-readings__note">These are the readings your practitioner recorded. They are reflective wellness measurements, not a diagnosis; questions about them belong with your practitioner. Ask Gaia “open my readings” any time to come back here.</p>
      <div class="g-card__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-readings-action="refresh">Refresh</button><button type="button" class="g-btn g-btn--ghost g-btn--sm" data-readings-action="unlink">Stop sharing</button></div>`);
  }
  const note = (text, action) => card(`<p class="g-readings__lead">${esc(text)}</p>${action ? `<div class="g-card__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-readings-action="${esc(action.id)}">${esc(action.label)}</button></div>` : ''}`);

  /** One place under Account: what is shared with whom, how to stop, and the hidden cards. Plain words, no values. */
  function dataSharingCard(status, prefs) {
    const anyHidden = Object.values(prefs || {}).some((v) => v === true);
    const who = status.practitioner_name || 'your practitioner';
    const sharing = status.linked
      ? `<div class="g-row"><span>Bio-Well readings</span><span class="g-row__meta">shared by ${esc(who)} since ${esc(when(status.linked_at))}</span></div>`
      : `<div class="g-row"><span>Bio-Well readings</span><span class="g-row__meta">${status.code_active ? 'code waiting for your practitioner' : 'not shared'}</span></div>`;
    return `<article class="g-card g-readings g-datashare"><p class="g-card__label">Your data and sharing</p>
      <div class="g-rows">${sharing}
        <div class="g-row"><span>Daily energy, journal, messages, courses, bookings</span><span class="g-row__meta">only you</span></div>
        <div class="g-row"><span>Gaia Assist</span><span class="g-row__meta">never reads your reading values</span></div>
      </div>
      ${status.linked ? `<p class="g-readings__muted">${esc(who)} sees the readings they recorded, that you asked to see them in Gaia, and whether you opened the latest one. Nothing else in your app. Gaia keeps no copy.</p>` : '<p class="g-readings__muted">Sharing starts only when you ask for a code in My readings and your practitioner confirms it is you.</p>'}
      ${status.linked ? `<div class="g-rows g-datashare__consent"><div class="g-row"><span>Let Gaia Assist read the guides ${esc(who)} writes for you</span><button type="button" class="g-btn g-btn--ghost g-btn--sm g-pref-toggle" data-readings-action="toggle-guides" aria-pressed="${prefs && prefs.guides_to_assist ? 'true' : 'false'}">${prefs && prefs.guides_to_assist ? 'On' : 'Off'}</button></div></div>
      <p class="g-readings__muted">Off unless you choose it. Guide reading is still being built: until it is live, nothing is read either way, and when it is, only in your own conversations and never your scan values.</p>` : ''}
      <div class="g-card__actions">
        ${status.linked ? '<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-readings-action="unlink">Stop sharing</button>' : '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-readings-action="goto">Open My readings</button>'}
        ${anyHidden ? '<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-readings-action="reset-prefs">Show hidden cards again</button>' : ''}
      </div></article>`;
  }
  let lastSummary = null, lastReadings = null, lastStatus = null, expanded = false, lastPrefs = {};
  async function render(root) {
    const [st, pf] = await Promise.all([api('/api/practitioners/member-link/status'), api('/api/member/prefs').catch(() => ({ ok: false, body: {} }))]);
    const prefs = (pf.ok && pf.body.prefs) || {};
    const share = document.getElementById('member-data-sharing');
    if (!st.ok) { root.hidden = true; lastStatus = null; if (share) { share.hidden = true; share.innerHTML = ''; } setTodayLink({ linked: false, fresh: false }); return; }             // not signed in, or feature off (404)
    root.hidden = false;
    const status = st.body;
    lastStatus = status;
    window.dispatchEvent(new CustomEvent('gaia:readings-status', { detail: { linked: Boolean(status.linked), new_reading: Boolean(status.new_reading), latest_scanned_at: status.latest_scanned_at || null } }));
    if (share) { share.hidden = false; share.innerHTML = dataSharingCard(status, prefs); }
    lastSummary = null; lastReadings = null;
    setTodayLink({ linked: Boolean(status.linked), fresh: Boolean(status.new_reading), scannedAt: status.latest_scanned_at || null });
    if (!status.linked) { root.innerHTML = consentCard(status); return; }
    root.innerHTML = note('Loading your readings… this fetches live from Bio-Well and can take about 20 seconds.');
    const r = await api('/api/practitioners/my-readings');
    if (r.ok) {
      lastSummary = r.body.summary || null; lastReadings = r.body; lastPrefs = prefs;
      root.innerHTML = expanded ? readingsCard(r.body, status, prefs) : foldedCard(r.body);
      window.dispatchEvent(new CustomEvent('gaia:readings-loaded', { detail: { scanned_at: r.body.latest?.scanned_at || null } }));
      // The link record may hold no practitioner name (their redeem call sends
      // none); once the readings are in, the sharing card can say who.
      if (share && r.body.practitioner?.name && !status.practitioner_name) share.innerHTML = dataSharingCard({ ...status, practitioner_name: r.body.practitioner.name }, prefs);
      pickOut(root, r.body.series || []);
      setTodayLink({});   // the shortcut on Today picks up the two numbers
      // Seen means seen: recorded only once the card is actually on screen
      // (the script runs on every view of the shell, not just You).
      watchSeen(root);
      return;
    }
    if (r.body.error === 'member_not_linked' || r.body.error === 'link_revoked') { root.innerHTML = consentCard({ ...status, linked: false }); return; }
    root.innerHTML = note('Your readings are not available right now. Please try again in a moment.', { id: 'refresh', label: 'Try again' });
  }

  let seenObserver = null, seenFor = null;
  function markSeenNow() {
    const d = lastReadings?.latest?.scanned_at;
    if (!d || seenFor === d) return;
    seenFor = d; setNewReading(false);
    if (lastStatus) { lastStatus = { ...lastStatus, new_reading: false, seen_scanned_at: d }; window.dispatchEvent(new CustomEvent('gaia:readings-status', { detail: { linked: true, new_reading: false, latest_scanned_at: lastStatus.latest_scanned_at || null } })); }
    api('/api/practitioners/member-link/seen', { method: 'POST', body: { scanned_at: d } }).catch(() => {});
  }
  function watchSeen(root) {
    if (seenObserver) { seenObserver.disconnect(); seenObserver = null; }
    if (!('IntersectionObserver' in window)) { if (root.offsetParent !== null) markSeenNow(); return; }
    seenObserver = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { markSeenNow(); seenObserver.disconnect(); seenObserver = null; } }, { threshold: 0.2 });
    seenObserver.observe(root);
  }

  /** Bring the card into view and let it glow for a moment (Assist "open my readings", or ?section=readings). */
  function reveal(root) {
    if (!root || root.hidden) return false;
    if (!expanded && lastReadings) { expanded = true; root.innerHTML = readingsCard(lastReadings, lastStatus || {}, lastPrefs); pickOut(root, lastReadings.series || []); }
    try { root.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { root.scrollIntoView(); }
    root.classList.add('is-focus');
    window.setTimeout(() => root.classList.remove('is-focus'), 1800);
    return true;
  }

  async function mount() {
    const root = document.getElementById('member-readings');
    if (!root) return;
    const onClick = async (e) => {
      const btn = e.target.closest('[data-readings-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-readings-action');
      btn.disabled = true;
      try {
        if (action === 'image') {
          if (lastReadings) { try { await saveImage(lastReadings); } catch { btn.textContent = 'Could not save'; window.setTimeout(() => { btn.textContent = 'Save as image'; }, 1600); } }
          return;
        }
        if (action === 'tool') {
          const tool = btn.getAttribute('data-tool') || 'chakra';
          try { window.GaiaAppShell?.go?.('wellness'); } catch { /* ignore */ }
          window.requestAnimationFrame(() => { try { window.GaiaTools?.open?.(tool); } catch { /* ignore */ } });
          return;
        }
        if (action === 'expand') { expanded = true; if (lastReadings) { root.innerHTML = readingsCard(lastReadings, lastStatus || {}, lastPrefs); pickOut(root, lastReadings.series || []); } return; }
        if (action === 'goto') { reveal(root); return; }
        if (action === 'reset-prefs') {
          const cleared = {}; for (const k of ['next_level_collapsed', 'readings_explainer_collapsed', 'practitioner_card_dismissed']) cleared[k] = false;   // the avatar's own two switches are settings, not hidden cards
          await api('/api/member/prefs', { method: 'POST', body: { prefs: cleared } }).catch(() => {});
          document.dispatchEvent(new CustomEvent('gaia:prefs-reset'));
          await render(root);
          return;
        }
        if (action === 'whosees') {
          const box = root.querySelector('.g-readings__whosees');
          if (box) { box.hidden = !box.hidden; btn.setAttribute('aria-expanded', String(!box.hidden)); }
          return;
        }
        if (action === 'toggle-guides') {
          // A separate consent, recorded server-side, for a separate use of
          // their data. Nothing reads it until guide reading exists.
          const next = btn.getAttribute('aria-pressed') !== 'true';
          btn.setAttribute('aria-pressed', String(next)); btn.textContent = next ? 'On' : 'Off';
          lastPrefs = { ...(lastPrefs || {}), guides_to_assist: next };
          const out = await api('/api/member/prefs', { method: 'POST', body: { prefs: { guides_to_assist: next } } });
          if (!out.ok) { btn.setAttribute('aria-pressed', String(!next)); btn.textContent = next ? 'Off' : 'On'; lastPrefs.guides_to_assist = !next; }
          return;
        }
        if (action === 'copy-code') {
          const code = root.querySelector('[data-link-code]')?.dataset.linkCode || '';
          try { await copyText(code); btn.textContent = 'Copied'; } catch { btn.textContent = 'Select the code to copy'; }
          btn.setAttribute('aria-live', 'polite');
          window.setTimeout(() => { btn.textContent = 'Copy code'; }, 2000);
          return;
        }
        if (action === 'copy') {
          const text = lastSummary ? [lastSummary.headline, ...(lastSummary.lines || [])].join('\n') : '';
          try { await copyText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Could not copy'; }
          window.setTimeout(() => { btn.textContent = 'Copy summary'; }, 1600);
          return;
        }
        if (action === 'code') {
          const out = await api('/api/practitioners/member-link/code', { method: 'POST', body: {} });
          root.innerHTML = out.ok ? codeCard(out.body) : note(out.body.error === 'already_linked' ? 'You are already sharing with a practitioner.' : 'Could not create a code right now.', { id: 'refresh', label: 'Try again' });
          return;
        }
        if (action === 'unlink') {
          const ok = window.GaiaNotice?.confirm ? await window.GaiaNotice.confirm('Stop sharing your readings with your practitioner?') : window.confirm('Stop sharing your readings with your practitioner?');
          if (!ok) return;
          await api('/api/practitioners/member-link/unlink', { method: 'POST', body: {} });
        }
        await render(root);
      } finally { btn.disabled = false; }
    };
    root.addEventListener('click', onClick);
    // The data-and-sharing card under Account has the same buttons; same handler.
    document.getElementById('member-data-sharing')?.addEventListener('click', onClick);
    root.addEventListener('change', (e) => { if (e.target.matches('[data-pick]')) pickOut(root, lastReadings?.series || []); });
    root.addEventListener('toggle', (e) => {
      if (!e.target.matches('.g-readings__explain')) return;
      api('/api/member/prefs', { method: 'POST', body: { prefs: { readings_explainer_collapsed: !e.target.open } } }).catch(() => {});
    }, true);
    let pendingReveal = false;
    window.addEventListener('gaia:open-readings', () => { if (!reveal(root)) pendingReveal = true; });
    window.addEventListener('gaia:signed-out', () => { root.hidden = true; root.innerHTML = ''; const share = document.getElementById('member-data-sharing'); if (share) { share.hidden = true; share.innerHTML = ''; } setTodayLink({ linked: false, fresh: false }); });

    try { if (new URLSearchParams(location.search).get('section') === 'readings') pendingReveal = true; } catch { /* ignore */ }
    await render(root);
    if (pendingReveal) { pendingReveal = false; window.setTimeout(() => reveal(root), 120); }
  }

  // For Home: the latest numbers once they are loaded (nothing extra is fetched).
  /**
   * "What do these mean?": a short walk through the member's own card, one
   * section at a time. Each step says what that part of the screen shows and
   * points out what is already in the numbers (dates, highest and lowest,
   * the member's own average). It adds no ranges or meanings of its own and
   * involves no model; questions about meaning go to the practitioner.
   */
  function guide() {
    const r = lastReadings, root = document.getElementById('member-readings');
    if (!r || !root || root.hidden) return [];
    if (!expanded) reveal(root);
    const l = r.latest || null, a = r.average_recent, t = r.trend, who = r.practitioner?.name || 'your practitioner';
    const steps = [], has = (sel) => root.querySelector(sel);
    if (r.summary?.headline && has('.g-readings__summary')) {
      steps.push({ sel: '.g-readings__summary', text: 'This is the short version. It is written from your readings by simple fixed rules, not by AI.' + (a && a.count >= 3 ? ' The bars under it average your latest three complete scans.' : '') });
    }
    if (l && has('.g-readings__hero')) {
      const age = ageOf(l.scanned_at);
      const nums = [typeof l.energy === 'number' ? `energy ${fmt(l.energy)}` : '', typeof l.stress === 'number' ? `stress ${fmt(l.stress, 2)}` : ''].filter(Boolean).join(' and ');
      let text = `Your latest scan${l.scanned_at ? `, ${when(l.scanned_at)}${age ? ` (${age.label})` : ''}` : ''}${nums ? `: ${nums}` : ''}. The shaded part of each arc is the band this card marks as comfortable.`;
      if (a && a.count >= 3 && typeof a.energy === 'number' && typeof a.stress === 'number') text += ` Your own three-scan average is energy ${fmt(a.energy, 1)}, stress ${fmt(a.stress, 2)}.`;
      if (age && age.stale) text += ` It shows the day of the scan, not today; a new scan would show where you are now.`;
      steps.push({ sel: '.g-readings__hero', text });
    }
    const centres = (l?.chakras || []).filter((c) => typeof c.value === 'number');
    const section = (title) => [...root.querySelectorAll('.g-readings__sec')].find((s) => title.test(s.querySelector('.g-readings__kicker')?.textContent || ''));
    if (centres.length >= 2 && section(/seven centres/i)) {
      const hi = centres.reduce((x, y) => (y.value > x.value ? y : x)), lo = centres.reduce((x, y) => (y.value < x.value ? y : x));
      steps.push({ el: section(/seven centres/i), text: `Your seven centres, root to crown, each on a 0–10 scale. In this scan ${hi.name} was the most active (${fmt(hi.value, 2)}) and ${lo.name} the quietest (${fmt(lo.value, 2)}).` });
    }
    if ((l?.most_out_of_balance || []).length && section(/Most out of balance/)) {
      steps.push({ el: section(/Most out of balance/), text: 'These are the centres this scan lists as most out of balance, with the figure the scan gives for each.' });
    }
    if (t && (t.energy || t.stress)) {
      const sec = section(/Last 90 days/);
      if (sec) {
        const n = (t.flagged || []).length;
        steps.push({ el: sec, text: `Your last 90 days: the lowest and highest energy and stress across those scans, and their average.${n ? ` ${n} ${n === 1 ? 'item was' : 'items were'} flagged for this period; the label shows the direction and how strong.` : ' Nothing was flagged for this period.'}` });
      }
    }
    if ((r.comparisons || []).length) {
      const sec = section(/Before and after/);
      if (sec) steps.push({ el: sec, text: 'Scans taken around your sessions, side by side: how much stress and energy changed between them.' });
    }
    const ex = root.querySelector('.g-readings__explain');
    if (ex) steps.push({ el: ex, open: ex, text: `Short definitions of each measure are here. What your numbers mean for you is a question for ${who}; these are wellness readings, not a diagnosis.` });
    return steps;
  }
  const latest = () => (lastReadings && lastReadings.latest ? { latest: lastReadings.latest, summary: lastReadings.summary || null, average: lastReadings.average_recent || null, practitioner: lastReadings.practitioner?.name || '' } : null);
  window.GaiaMyReadings = { mount, render, reveal, latest, ageOf, guide, status: () => (lastStatus ? { linked: Boolean(lastStatus.linked), new_reading: Boolean(lastStatus.new_reading), latest_scanned_at: lastStatus.latest_scanned_at || null, code_active: Boolean(lastStatus.code_active) } : {}) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
