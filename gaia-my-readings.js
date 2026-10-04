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

  function consentCard(status) {
    return `<div class="g-card g-readings">
      <h2 class="g-card__title">My readings</h2>
      <p class="g-card__text">See your own Bio-Well readings here, shared by your practitioner.</p>
      <p class="g-prac__muted">To share, you ask for a code and give it to your practitioner. They enter it on their side and confirm it is you. You can stop sharing at any time. Your results are shown to you only; Gaia does not keep a copy.</p>
      ${status.code_active ? `<p class="g-prac__muted">A code is already active until ${esc(when(status.code_expires_at))}.</p>` : ''}
      <button type="button" class="g-btn g-btn--sm" data-readings-action="code">${status.code_active ? 'Show a new code' : 'Share with my practitioner'}</button>
    </div>`;
  }
  function codeCard(out) {
    const groups = String(out.code || '').match(/.{1,4}/g) || [];
    return `<div class="g-card g-readings">
      <h2 class="g-card__title">Your link code</h2>
      <p class="g-readings__code" aria-label="Link code">${groups.map(esc).join(' ')}</p>
      <p class="g-prac__muted">Read it to your practitioner. It works once and expires at ${esc(when(out.expires_at))}. Your agreement to share was recorded at ${esc(when(out.consent_recorded_at))}.</p>
      <button type="button" class="g-btn g-btn--ghost g-btn--sm" data-readings-action="refresh">I have given it — check</button>
    </div>`;
  }
  function readingsCard(r) {
    const latest = r.latest;
    const chakras = latest ? (latest.chakras || []).map((c) => `<li><span>${esc(c.name)}</span><span>${esc(c.value ?? '—')}</span></li>`).join('') : '';
    const worst = latest ? (latest.most_out_of_balance || []).map((d) => `<li>${esc(d.name)} <span class="g-prac__muted">(${esc(d.area)})</span></li>`).join('') : '';
    const flagged = r.trend ? (r.trend.flagged || []).map((f) => `<li>${esc(f.name)}: ${esc(f.direction)}${f.reason ? ` <span class="g-prac__muted">— ${esc(f.reason)}</span>` : ''}</li>`).join('') : '';
    const files = (r.files || []).map((f) => `<li>${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>` : esc(f.name)}${f.uploaded_at ? ` <span class="g-prac__muted">${esc(f.uploaded_at)}</span>` : ''}</li>`).join('');
    return `<div class="g-card g-readings">
      <h2 class="g-card__title">My readings</h2>
      <p class="g-prac__muted">Shared by ${esc(r.practitioner?.name || 'your practitioner')} since ${esc(when(r.linked_at))}${r.scans_on_file != null ? ` · ${esc(r.scans_on_file)} reading${r.scans_on_file === 1 ? '' : 's'} on file` : ''}.</p>
      ${latest ? `<h3 class="g-card__sub">Latest reading · ${esc(latest.scanned_at)}</h3>
        <p class="g-card__text">Energy ${esc(latest.energy ?? '—')} · Stress ${esc(latest.stress ?? '—')}</p>
        ${chakras ? `<ul class="g-readings__list g-readings__chakras">${chakras}</ul>` : ''}
        ${worst ? `<p class="g-card__text">Most out of balance</p><ul class="g-readings__list">${worst}</ul>` : ''}` : '<p class="g-card__text">No reading on file yet.</p>'}
      ${r.trend && (r.trend.energy || r.trend.stress) ? `<h3 class="g-card__sub">Last 90 days</h3>
        <p class="g-card__text">Energy ${esc(r.trend.energy?.lowest ?? '—')}–${esc(r.trend.energy?.highest ?? '—')} (latest ${esc(r.trend.energy?.latest ?? '—')}) · Stress ${esc(r.trend.stress?.lowest ?? '—')}–${esc(r.trend.stress?.highest ?? '—')} (latest ${esc(r.trend.stress?.latest ?? '—')})</p>
        ${flagged ? `<ul class="g-readings__list">${flagged}</ul>` : ''}` : ''}
      ${files ? `<h3 class="g-card__sub">Documents from your practitioner</h3><ul class="g-readings__list">${files}</ul>` : ''}
      <p class="g-prac__muted">These are the readings your practitioner recorded. They are reflective wellness measurements, not a diagnosis; questions about them belong with your practitioner.</p>
      <button type="button" class="g-btn g-btn--ghost g-btn--sm" data-readings-action="unlink">Stop sharing</button>
    </div>`;
  }
  const note = (text, action) => `<div class="g-card g-readings"><h2 class="g-card__title">My readings</h2><p class="g-card__text">${esc(text)}</p>${action ? `<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-readings-action="${esc(action.id)}">${esc(action.label)}</button>` : ''}</div>`;

  async function render(root) {
    const st = await api('/api/practitioners/member-link/status');
    if (!st.ok) { root.hidden = true; return; }             // not signed in, or feature off (404)
    root.hidden = false;
    const status = st.body;
    if (!status.linked) { root.innerHTML = consentCard(status); return; }
    root.innerHTML = note('Loading your readings…');
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
