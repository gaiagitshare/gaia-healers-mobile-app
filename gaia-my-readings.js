/**
 * MY READINGS — a member's own Bio-Well results, inside You.
 *
 * Phase 1: no AI involved. The member asks for a code (that is their consent),
 * reads it to their practitioner, and once the practitioner confirms, the
 * member's latest reading, trend and shared documents are shown straight from
 * the server. The member can stop sharing at any time.
 *
 * Everything comes from /api/practitioners/member-link/* and
 * /api/practitioners/my-readings; nothing is cached in the browser.
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

  const card = (inner) => `<article class="g-card g-readings"><p class="g-card__label">My readings</p>${inner}</article>`;
  const fmt = (v, d = 0) => (typeof v === 'number' ? v.toFixed(d) : '—');
  const signed = (v, d = 1, goodWhenNegative = false) => {
    if (typeof v !== 'number') return '<span class="g-readings__delta">—</span>';
    const good = goodWhenNegative ? v < 0 : v > 0;
    const cls = v === 0 ? '' : (good ? ' is-good' : ' is-bad');
    return `<span class="g-readings__delta${cls}">${v > 0 ? '+' : ''}${v.toFixed(d)}</span>`;
  };

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
    const latest = r.latest;
    const chakra = (c) => {
      const v = typeof c.value === 'number' ? c.value : null;
      const w = v == null ? 0 : Math.max(4, Math.min(100, Math.round((v / 10) * 100)));
      return `<li class="g-readings__chakra"><span class="g-readings__chakra-name">${esc(c.name)}</span><span class="g-readings__bar" aria-hidden="true"><span style="width:${w}%"></span></span><span class="g-readings__chakra-val">${esc(fmt(v, 2))}</span></li>`;
    };
    const sev = (f) => `<li class="g-readings__flag"><span>${esc(f.name)}${f.area ? ` <span class="g-readings__muted">${esc(f.area)}</span>` : ''}</span><span class="g-readings__pill${f.severity === 'high' ? ' is-high' : (f.severity === 'elevated' ? ' is-elevated' : '')}">${esc(f.direction || '')}${f.severity ? ` · ${esc(f.severity)}` : ''}</span></li>`;
    const worst = (d) => `<li class="g-readings__flag"><span>${esc(d.name)} <span class="g-readings__muted">${esc(d.area)}</span></span><span class="g-readings__pill">${esc(fmt(d.disbalance))}%</span></li>`;
    const compare = (c) => `<li class="g-readings__pair"><span class="g-readings__pair-when">${esc(c.from)} → ${esc(c.to)}<span class="g-readings__muted"> · ${esc(c.basis)}</span></span><span class="g-readings__pair-deltas">stress ${signed(c.stress_change, 2, true)} · energy ${signed(c.energy_change, 1)}</span></li>`;
    const file = (f) => f.url
      ? `<a class="g-row g-row--link" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(f.name)}</span><span class="g-row__meta">${esc(f.uploaded_at || 'open')}</span></a>`
      : `<div class="g-row"><span>${esc(f.name)}</span><span class="g-row__meta">${esc(f.uploaded_at || '')}</span></div>`;
    const practitioner = r.practitioner || {};
    return card(`
      <p class="g-card__meta">Shared by <strong>${esc(practitioner.name || 'your practitioner')}</strong>${practitioner.specialty ? ` · ${esc(practitioner.specialty)}` : ''}${practitioner.location ? ` · ${esc(practitioner.location)}` : ''}<br>since ${esc(when(r.linked_at))}${r.scans_on_file != null ? ` · ${esc(r.scans_on_file)} reading${r.scans_on_file === 1 ? '' : 's'} on file` : ''}</p>
      ${latest ? `
      <div class="g-readings__sec">
        <p class="g-readings__kicker">Latest reading <span class="g-readings__muted">· ${esc(when(latest.scanned_at))}</span></p>
        ${latest.source === 'trend' ? '<p class="g-readings__muted">Taken from your reading history; the full detail of this scan was not available.</p>' : ''}
        <div class="g-readings__stats">
          <div class="g-readings__stat"><span class="g-readings__stat-n">${esc(fmt(latest.energy))}</span><span class="g-readings__stat-l">Energy</span></div>
          <div class="g-readings__stat"><span class="g-readings__stat-n">${esc(fmt(latest.stress, 2))}</span><span class="g-readings__stat-l">Stress</span></div>
        </div>
        ${(latest.chakras || []).length ? `<ul class="g-readings__chakras">${latest.chakras.map(chakra).join('')}</ul>` : ''}
        ${(latest.most_out_of_balance || []).length ? `<p class="g-readings__kicker">Most out of balance</p><ul class="g-readings__flags">${latest.most_out_of_balance.map(worst).join('')}</ul>` : ''}
      </div>` : '<p class="g-empty">No reading on file yet.</p>'}
      ${r.trend && (r.trend.energy || r.trend.stress) ? `
      <div class="g-readings__sec">
        <p class="g-readings__kicker">Last 90 days</p>
        <div class="g-readings__stats">
          <div class="g-readings__stat"><span class="g-readings__stat-n">${esc(fmt(r.trend.energy?.lowest, 1))}–${esc(fmt(r.trend.energy?.highest, 1))}</span><span class="g-readings__stat-l">Energy range · latest ${esc(fmt(r.trend.energy?.latest, 1))}</span></div>
          <div class="g-readings__stat"><span class="g-readings__stat-n">${esc(fmt(r.trend.stress?.lowest, 1))}–${esc(fmt(r.trend.stress?.highest, 1))}</span><span class="g-readings__stat-l">Stress range · latest ${esc(fmt(r.trend.stress?.latest, 1))}</span></div>
        </div>
        ${(r.trend.flagged || []).length ? `<ul class="g-readings__flags">${r.trend.flagged.map(sev).join('')}</ul>` : '<p class="g-readings__muted">Nothing flagged in this period.</p>'}
      </div>` : ''}
      ${(r.comparisons || []).length ? `
      <div class="g-readings__sec">
        <p class="g-readings__kicker">Before and after sessions</p>
        <ul class="g-readings__pairs">${r.comparisons.map(compare).join('')}</ul>
      </div>` : ''}
      ${(r.files || []).length ? `
      <div class="g-readings__sec">
        <p class="g-readings__kicker">Documents from your practitioner</p>
        <div class="g-rows">${r.files.map(file).join('')}</div>
      </div>` : ''}
      <p class="g-readings__muted g-readings__note">These are the readings your practitioner recorded. They are reflective wellness measurements, not a diagnosis; questions about them belong with your practitioner.</p>
      <div class="g-card__actions"><button type="button" class="g-btn g-btn--ghost g-btn--sm" data-readings-action="unlink">Stop sharing</button></div>`);
  }
  const note = (text, action) => card(`<p class="g-readings__lead">${esc(text)}</p>${action ? `<div class="g-card__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-readings-action="${esc(action.id)}">${esc(action.label)}</button></div>` : ''}`);

  async function render(root) {
    const st = await api('/api/practitioners/member-link/status');
    if (!st.ok) { root.hidden = true; return; }             // not signed in, or feature off (404)
    root.hidden = false;
    const status = st.body;
    if (!status.linked) { root.innerHTML = consentCard(status); return; }
    root.innerHTML = note('Loading your readings… this fetches live from Bio-Well and can take about 20 seconds.');
    const r = await api('/api/practitioners/my-readings');
    if (r.ok) { root.innerHTML = readingsCard(r.body); return; }
    if (r.body.error === 'member_not_linked' || r.body.error === 'link_revoked') { root.innerHTML = consentCard({ ...status, linked: false }); return; }
    root.innerHTML = note('Your readings are not available right now. Please try again in a moment.', { id: 'refresh', label: 'Try again' });
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
    await render(root);
    window.addEventListener('gaia:signed-out', () => { root.hidden = true; root.innerHTML = ''; });
  }

  window.GaiaMyReadings = { mount, render };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
