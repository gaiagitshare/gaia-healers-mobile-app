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
 */
(function () {
  'use strict';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const proxyBase = () => (window.GaiaConfig && window.GaiaConfig.proxyBase) || window.GAIA_PROXY_BASE || 'https://api.gaiahealers.app';
  const api = async (path, opts = {}) => {
    const res = await fetch(`${proxyBase()}${path}`, { credentials: 'include', headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, method: opts.method || 'GET', body: opts.body ? JSON.stringify(opts.body) : undefined });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && body.ok !== false, status: res.status, body };
  };
  const when = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch { return ''; } };
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
      <p class="g-readings__code" aria-label="Link code">${groups.map(esc).join('<span class="g-readings__code-gap"> </span>')}</p>
      <p class="g-readings__muted">Read it to your practitioner. It works once and expires ${esc(when(out.expires_at))}. Your agreement to share was recorded ${esc(when(out.consent_recorded_at))}.</p>
      <div class="g-card__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-readings-action="refresh">I have given it — check</button></div>`);
  }
  function readingsCard(r) {
    const latest = r.latest, trend = r.trend, summary = r.summary || {};
    const practitioner = r.practitioner || {};
    const chakraRow = (c, i) => {
      const m = chakraMeta(c, i), v = typeof c.value === 'number' ? c.value : null;
      const w = v == null ? 0 : Math.max(4, Math.min(100, Math.round((v / 10) * 100)));
      return `<li class="g-readings__chakra"><span class="g-readings__chakra-name"><i class="g-readings__dot" style="background:${m.colour}"></i>${esc(c.name)}</span><span class="g-readings__bar" aria-hidden="true"><span style="width:${w}%;background:${m.colour}"></span></span><span class="g-readings__chakra-val">${esc(fmt(v, 2))}</span></li>`;
    };
    const sev = (f) => `<li class="g-readings__flag"><span>${esc(f.name)}${f.area ? ` <span class="g-readings__muted">${esc(f.area)}</span>` : ''}</span><span class="g-readings__pill${f.severity === 'high' ? ' is-high' : (f.severity === 'elevated' ? ' is-elevated' : '')}">${esc(f.direction || '')}${f.severity ? ` · ${esc(f.severity)}` : ''}</span></li>`;
    const worst = (d) => `<li class="g-readings__flag"><span>${esc(d.name)} <span class="g-readings__muted">${esc(d.area)}</span></span><span class="g-readings__pill">${esc(fmt(d.disbalance))}%</span></li>`;
    const compare = (c) => `<li class="g-readings__pair"><span class="g-readings__pair-when">${esc(c.from)} → ${esc(c.to)}<span class="g-readings__muted"> · ${esc(c.basis)}</span></span><span class="g-readings__pair-deltas">stress ${signed(c.stress_change, 2, true)} · energy ${signed(c.energy_change, 1)}</span></li>`;
    const file = (f) => f.url
      ? `<a class="g-row g-row--link" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(f.name)}</span><span class="g-row__meta">${esc(f.uploaded_at || 'open')}</span></a>`
      : `<div class="g-row"><span>${esc(f.name)}</span><span class="g-row__meta">${esc(f.uploaded_at || '')}</span></div>`;
    const sec = (kicker, inner, cls = '') => `<section class="g-readings__sec${cls}"><p class="g-readings__kicker">${kicker}</p>${inner}</section>`;

    const spark = sparkline(r.series);
    return card(`
      <p class="g-card__meta">Shared by <strong>${esc(practitioner.name || 'your practitioner')}</strong>${practitioner.specialty ? ` · ${esc(practitioner.specialty)}` : ''}${practitioner.location ? ` · ${esc(practitioner.location)}` : ''}<br>since ${esc(when(r.linked_at))}${r.scans_on_file != null ? ` · ${esc(r.scans_on_file)} reading${r.scans_on_file === 1 ? '' : 's'} on file` : ''}</p>

      ${summary.headline ? `<div class="g-readings__summary">
        <p class="g-readings__kicker">In short</p>
        <p class="g-readings__headline">${esc(summary.headline)}</p>
        <ul class="g-readings__lines">${(summary.lines || []).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        <div class="g-card__actions"><button type="button" class="g-btn g-btn--ghost g-btn--sm" data-readings-action="copy">Copy summary</button></div>
      </div>` : ''}

      ${latest ? `<div class="g-readings__hero">
        ${gauge({ value: latest.energy, min: 0, max: 100, label: 'Energy', unit: 'J ×10⁻²', good: [40, 70], decimals: 0 })}
        ${gauge({ value: latest.stress, min: 0, max: 10, label: 'Stress', unit: 'of 10', good: [2, 4], decimals: 2, lowerIsBetter: true })}
        ${spark || spectrum(latest.chakras)}
      </div>
      <p class="g-readings__muted g-readings__when">Latest reading ${esc(when(latest.scanned_at))}${latest.source === 'trend' ? ' · taken from your reading history; the full detail of this scan was not available' : ''}</p>` : '<p class="g-empty">No reading on file yet.</p>'}

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
        ${(r.files || []).length ? sec('Documents from your practitioner', `<div class="g-rows">${r.files.map(file).join('')}</div>`) : ''}
      </div>

      <p class="g-readings__muted g-readings__note">These are the readings your practitioner recorded. They are reflective wellness measurements, not a diagnosis; questions about them belong with your practitioner. Ask Gaia “open my readings” any time to come back here.</p>
      <div class="g-card__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-readings-action="refresh">Refresh</button><button type="button" class="g-btn g-btn--ghost g-btn--sm" data-readings-action="unlink">Stop sharing</button></div>`);
  }
  const note = (text, action) => card(`<p class="g-readings__lead">${esc(text)}</p>${action ? `<div class="g-card__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-readings-action="${esc(action.id)}">${esc(action.label)}</button></div>` : ''}`);

  let lastSummary = null;
  async function render(root) {
    const st = await api('/api/practitioners/member-link/status');
    if (!st.ok) { root.hidden = true; return; }             // not signed in, or feature off (404)
    root.hidden = false;
    const status = st.body;
    lastSummary = null;
    if (!status.linked) { root.innerHTML = consentCard(status); return; }
    root.innerHTML = note('Loading your readings… this fetches live from Bio-Well and can take about 20 seconds.');
    const r = await api('/api/practitioners/my-readings');
    if (r.ok) { lastSummary = r.body.summary || null; root.innerHTML = readingsCard(r.body); return; }
    if (r.body.error === 'member_not_linked' || r.body.error === 'link_revoked') { root.innerHTML = consentCard({ ...status, linked: false }); return; }
    root.innerHTML = note('Your readings are not available right now. Please try again in a moment.', { id: 'refresh', label: 'Try again' });
  }

  /** Bring the card into view and let it glow for a moment (Assist "open my readings", or ?section=readings). */
  function reveal(root) {
    if (!root || root.hidden) return false;
    try { root.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { root.scrollIntoView(); }
    root.classList.add('is-focus');
    window.setTimeout(() => root.classList.remove('is-focus'), 1800);
    return true;
  }

  async function mount() {
    const root = document.getElementById('member-readings');
    if (!root) return;
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-readings-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-readings-action');
      btn.disabled = true;
      try {
        if (action === 'copy') {
          const text = lastSummary ? [lastSummary.headline, ...(lastSummary.lines || [])].join('\n') : '';
          try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Could not copy'; }
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
    });
    let pendingReveal = false;
    window.addEventListener('gaia:open-readings', () => { if (!reveal(root)) pendingReveal = true; });
    window.addEventListener('gaia:signed-out', () => { root.hidden = true; root.innerHTML = ''; });
    try { if (new URLSearchParams(location.search).get('section') === 'readings') pendingReveal = true; } catch { /* ignore */ }
    await render(root);
    if (pendingReveal) { pendingReveal = false; window.setTimeout(() => reveal(root), 120); }
  }

  window.GaiaMyReadings = { mount, render, reveal };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
