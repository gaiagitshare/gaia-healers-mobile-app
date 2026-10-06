/**
 * Personal Path (V1) in the app.
 *
 * Member: "Your Gaia Path" on You (the whole path) and one quiet row on Home
 * (the next step). A short, ranked journey -- never a wall of cards, no
 * scores, no red states, no pressure. "Recommended by your practitioner" only
 * for what a practitioner confirmed; everything else is "Suggested by Gaia".
 *
 * Practitioner: "Recommend to client" inside a linked client's Practice view.
 * Choose an approved resource or one of their own services, write the
 * member-facing reason and an optional note, preview, then Confirm. Partner
 * matches appear as "Suggested matches" and are never recommendations until
 * the practitioner confirms one.
 *
 * Everything the server returns is escaped; nothing here interprets readings.
 * Events go to /api/member/path/event (whitelisted analytics, no values).
 */
(function () {
  'use strict';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const proxyBase = () => (window.GaiaApi && window.GaiaApi.base && window.GaiaApi.base()) || (window.GaiaConfig && window.GaiaConfig.proxyBase) || window.GAIA_PROXY_BASE || 'https://api.gaiahealers.app';
  const api = async (path, opts = {}) => {
    try {
      const res = await fetch(`${proxyBase()}${path}`, { credentials: 'include', headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, method: opts.method || 'GET', body: opts.body ? JSON.stringify(opts.body) : undefined });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok && body.ok !== false, status: res.status, body };
    } catch { return { ok: false, status: 0, body: {} }; }
  };
  const go = (v, o) => { try { window.GaiaAppShell?.go?.(v, o); } catch { /* ignore */ } };
  const event = (name, extra = {}) => api('/api/member/path/event', { method: 'POST', body: { event: name, ...extra } });
  const when = (iso) => { try { return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

  // ── the member's path ─────────────────────────────────────────────────────
  let last = null, loading = null;
  async function load(force) {
    if (loading && !force) return loading;
    loading = api('/api/member/path').then((r) => { last = r.ok ? r.body : null; loading = null; return last; });
    return loading;
  }

  /** Perform an item's action. Opening is not completing (except where the server decides). */
  function perform(item, { surface = 'you', free = false } = {}) {
    const a = free ? { kind: item.free_alternative.resource.kind, resource_id: item.free_alternative.resource.id, target: item.free_alternative.resource.target } : (item.action || {});
    if (free) event('free_alternative_selected', { key: item.key, surface }); else event('recommendation_opened', { key: item.key, stage: item.stage, surface });
    const k = a.kind;
    if (k === 'readings' || k === 'share_readings') { go('profile'); setTimeout(() => window.dispatchEvent(new CustomEvent('gaia:open-readings')), 80); }
    else if (k === 'scan') { event('scan_rebook_opened', { key: item.key, route: 'directory' }); if (window.GaiaDirectory?.open) window.GaiaDirectory.open({ intent: 'scan' }); else go('directory'); }
    else if (k === 'bookings') go('bookings');
    else if (k === 'course') { const id = a.course_id || a.resource_id; if (window.GaiaAcademyPlayer?.open) window.GaiaAcademyPlayer.open(id); else go('academy'); }
    else if (k === 'tool') { go('wellness'); requestAnimationFrame(() => { try { window.GaiaTools?.open?.(a.resource_id); } catch { /* ignore */ } }); }
    else if (k === 'view') go(a.target?.view || 'today', a.target?.tab ? { tab: a.target.tab } : undefined);
    else if (k === 'service') { if (window.GaiaDirectory?.open) window.GaiaDirectory.open({ q: item.practitioner_name || '' }); else go('directory'); }
    else if (k === 'onboarding') { try { window.GaiaJourney?.check?.(true); } catch { /* ignore */ } }
    else if (k === 'plans') go('store', { tab: 'membership' });
  }

  function itemHtml(it, i) {
    const prac = it.provenance?.source_type === 'practitioner_manual';
    const lead = i === 0;
    const meta = [it.session_title ? esc(it.session_title) : '', it.when ? esc(when(it.when)) : '', typeof it.progress === 'number' && it.progress > 0 ? `${esc(it.progress)}% through` : ''].filter(Boolean).join(' · ');
    return `<li class="gpath__item${lead ? ' is-next' : ''}" data-path-key="${esc(it.key)}">
      <p class="gpath__stage">${esc(it.stage_label)}${prac ? ' · <span class="gpath__from"><i class="ph ph-leaf" aria-hidden="true"></i>Recommended by your practitioner</span>' : ''}</p>
      <p class="gpath__title">${esc(it.title)}</p>
      ${meta ? `<p class="gpath__meta">${meta}</p>` : ''}
      ${it.reason ? `<p class="gpath__reason">${esc(it.reason)}</p>` : ''}
      ${prac && it.note ? `<p class="gpath__note">“${esc(it.note)}”${it.practitioner_name ? ` <span>— ${esc(it.practitioner_name)}</span>` : ''}</p>` : ''}
      ${it.lock ? `<p class="gpath__lock">${esc(it.lock.label)}</p>` : ''}
      ${it.service_detail ? `<div class="gpath__detail" data-path-detail hidden>${it.service_detail.description ? `<p>${esc(it.service_detail.description)}</p>` : ''}${it.service_detail.duration ? `<p>${esc(it.service_detail.duration)} minutes</p>` : ''}<p>Booked with ${esc(it.practitioner_name || 'your practitioner')}.</p></div>` : ''}
      <div class="gpath__actions">
        ${it.lock
          ? `<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-path-do="plans">${it.lock.kind === 'plan' ? `See ${esc(it.lock.plan.replace(/^./, (c) => c.toUpperCase()))}` : 'See membership plans'}</button>${it.free_alternative ? '<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-path-do="free">Show me a free option</button>' : ''}`
          : it.action?.kind === 'service'
            ? `<button type="button" class="g-btn ${lead ? 'g-btn--primary' : 'g-btn--secondary'} g-btn--sm" data-path-do="detail" aria-expanded="false">View service</button><button type="button" class="g-btn g-btn--ghost g-btn--sm" data-path-do="open">Book with ${esc(it.practitioner_name || 'your practitioner')}</button>`
            : `<button type="button" class="g-btn ${lead ? 'g-btn--primary' : 'g-btn--secondary'} g-btn--sm" data-path-do="open">${esc(it.action?.label || 'Open')}</button>`}
        ${it.completion === 'member' && !it.lock ? '<button type="button" class="gpath__quiet" data-path-do="done">I did this</button>' : ''}
        <button type="button" class="gpath__quiet" data-path-do="dismiss">Not now</button>
      </div>
    </li>`;
  }

  function cardHtml(p) {
    if (!p) return '';
    if (p.caught_up) {
      return `<article class="g-card gpath gpath--calm"><p class="g-card__label">Your Gaia Path</p>
        <p class="gpath__title">You're caught up.</p>
        <p class="gpath__reason">Nothing is waiting for you. You can explore today's energy check, continue learning, or ask Gaia anything.</p>
        <div class="gpath__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-path-go="energy">Today's energy check</button><button type="button" class="g-btn g-btn--ghost g-btn--sm" data-path-go="academy">Learning</button></div></article>`;
    }
    return `<article class="g-card gpath"><p class="g-card__label">Your Gaia Path</p>
      <p class="gpath__intro">${p.items.length === 1 ? 'One next step for you.' : 'Your next steps, in order.'}</p>
      <ol class="gpath__list">${p.items.map(itemHtml).join('')}</ol></article>`;
  }

  /** Home: one quiet row, the next step only. */
  function rowHtml(p) {
    const it = p && p.items && p.items[0];
    if (!it) return '';
    return `<a class="g-readings-nudge gpath-row" href="home.html?view=profile&section=path" data-path-row><i class="ph ph-path" aria-hidden="true"></i><span><strong>Next on your path</strong><span class="gpath-row__t">${esc(it.title)}</span></span><em>Open</em></a>`;
  }

  const viewed = new Set();
  function wire(host, p, surface) {
    if (!p) return;
    if (!viewed.has(surface)) { viewed.add(surface); event('path_viewed', { surface, items: p.items.length }); }
    for (const it of p.items) if (it.lock) event('membership_required_shown', { key: it.key, level: it.lock.plan || undefined });
    host.onclick = async (e) => {
      const g = e.target.closest('[data-path-go]');
      if (g) { if (g.dataset.pathGo === 'energy') go('wellness', { tab: 'check' }); else go('academy'); return; }
      const b = e.target.closest('[data-path-do]'); if (!b) return;
      const li = b.closest('[data-path-key]'); const it = p.items.find((x) => x.key === li?.dataset.pathKey); if (!it) return;
      const what = b.dataset.pathDo;
      if (what === 'open') perform(it, { surface });
      else if (what === 'detail') { const d = li.querySelector('[data-path-detail]'); if (d) { d.hidden = !d.hidden; b.setAttribute('aria-expanded', String(!d.hidden)); if (!d.hidden) event('recommendation_opened', { key: it.key, stage: it.stage, surface }); } }
      else if (what === 'free') perform(it, { surface, free: true });
      else if (what === 'plans') { event('membership_opened', { key: it.key, level: it.lock?.plan }); go('store', { tab: 'membership' }); }
      else if (what === 'done' || what === 'dismiss') {
        b.disabled = true;
        if (!(await settle(it, what === 'done' ? 'done' : 'dismiss', surface))) b.disabled = false;
      }
    };
  }

  /** "I did this" (self-guided only; the server refuses anything else) or "Not now". */
  async function settle(it, how, surface = 'you') {
    if (how === 'done' && it.completion !== 'member') return false;
    const before = (last?.items || [])[0];
    const r = await event(how === 'done' ? 'recommendation_completed' : 'recommendation_dismissed', { key: it.key, stage: it.stage, surface });
    if (!r.ok) return false;
    await refresh();
    window.dispatchEvent(new CustomEvent('gaia:path-updated', { detail: { done: how === 'done' ? it : null, was_next: before?.key === it.key, next: (last?.items || [])[0] || null } }));
    return true;
  }

  async function render(force) {
    const p = await load(force);
    const you = document.getElementById('member-path');
    if (you) { you.hidden = !p; you.innerHTML = cardHtml(p); wire(you, p, 'you'); }
    placeHomeRow(p);
    window.dispatchEvent(new CustomEvent('gaia:path-loaded', { detail: { items: p?.items?.length || 0 } }));
    return p;
  }
  const refresh = () => render(true);

  function placeHomeRow(p) {
    const home = document.querySelector('#home-superapp .g-super-home, #home-superapp');
    if (!home) return;
    let row = document.getElementById('path-row');
    const html = rowHtml(p);
    if (!html) { row?.remove(); return; }
    if (!row) {
      row = document.createElement('div'); row.id = 'path-row';
      row.addEventListener('click', (e) => { const a = e.target.closest('[data-path-row]'); if (!a) return; e.preventDefault(); go('profile'); setTimeout(() => document.getElementById('member-path')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120); event('recommendation_opened', { key: last?.items?.[0]?.key, surface: 'home' }); });
    }
    if (row.innerHTML !== html) row.innerHTML = html;
    const anchor = home.querySelector('.g-home2__state') || home.querySelector('.g-super-hero');
    if (anchor && row.previousElementSibling !== anchor) anchor.insertAdjacentElement('afterend', row);
    else if (!anchor && !row.isConnected) home.prepend(row);
  }

  // ── practitioner: recommend to client ─────────────────────────────────────
  async function mountPractice(host, clientId, suggestedServices) {
    if (!host) return;
    host.innerHTML = '<section class="g-prac__sec gpath-rec"><h3 class="g-prac__h">Recommend to client</h3><p class="g-prac__muted">Loading…</p></section>';
    const r = await api(`/api/practitioners/path/options?customer_id=${encodeURIComponent(clientId)}`);
    if (!r.ok) { host.innerHTML = ''; return; }
    const o = r.body;
    const sugg = await Promise.resolve(suggestedServices).catch(() => null);
    const matches = (sugg?.services || []).filter((s) => (o.services || []).some((x) => x.id === String(s.id)));
    const opt = (x) => `<option value="${esc(x.key)}">${esc(x.title)}</option>`;
    const active = (o.recommendations || []).filter((x) => x.state === 'active');
    host.innerHTML = `<section class="g-prac__sec gpath-rec" data-gpath-rec>
      <h3 class="g-prac__h">Recommend to client</h3>
      <p class="g-prac__muted">What you confirm here appears on their Gaia Path as “Recommended by your practitioner”. Nothing is sent until you confirm.</p>
      ${matches.length ? `<div class="gpath-rec__matches"><p class="gpath-rec__k">Suggested matches</p><p class="g-prac__muted">Your services whose areas match flags on their platform. Not a recommendation until you choose and confirm one.</p>
        ${matches.map((s) => `<div class="g-prac__service"><span class="g-prac__service-name">${esc(s.name)}</span><span class="g-prac__muted">matches ${s.covers.map(esc).join(', ')}</span><button type="button" class="g-btn g-btn--ghost g-btn--sm" data-gpath-use="svc:${esc(s.id)}">Use this</button></div>`).join('')}</div>` : ''}
      <label class="gpath-rec__f"><span>Recommendation</span><select data-gpath-res>
        <option value="">Choose…</option>
        ${(o.services || []).length ? `<optgroup label="Your services">${o.services.map(opt).join('')}</optgroup>` : ''}
        ${(o.resources || []).length ? `<optgroup label="Gaia resources">${o.resources.map(opt).join('')}</optgroup>` : ''}
      </select></label>
      ${!(o.resources || []).length ? '<p class="g-prac__muted">Gaia resources appear here once they are approved for recommending.</p>' : ''}
      <label class="gpath-rec__f"><span>Member-facing reason <em>(they and Gaia may see this)</em></span><textarea rows="2" maxlength="${esc(o.limits.reason)}" data-gpath-reason>${esc(o.default_reason)}</textarea></label>
      <label class="gpath-rec__f"><span>Optional note to them <em>(plain text, no links)</em></span><textarea rows="2" maxlength="${esc(o.limits.note)}" data-gpath-note placeholder="e.g. Twice a day before our next session."></textarea></label>
      <div class="g-card__actions"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-gpath-preview>Preview for member</button><button type="button" class="g-btn g-btn--primary g-btn--sm" data-gpath-confirm disabled>Confirm recommendation</button></div>
      <p class="gpath-rec__msg" aria-live="polite" data-gpath-msg></p>
      <div data-gpath-previewbox hidden></div>
      ${active.length ? `<div class="gpath-rec__list"><p class="gpath-rec__k">Recommended to this client</p>${active.map((x) => `<div class="g-prac__service"><span class="g-prac__service-name">${esc(x.title)}</span><span class="g-prac__muted">${esc(new Date(x.created_at).toLocaleDateString())}</span><button type="button" class="g-btn g-btn--ghost g-btn--sm" data-gpath-revoke="${esc(x.id)}">Revoke</button></div>`).join('')}</div>` : ''}
    </section>`;
    const $ = (s) => host.querySelector(s);
    const sel = $('[data-gpath-res]'), reason = $('[data-gpath-reason]'), note = $('[data-gpath-note]'), confirm = $('[data-gpath-confirm]'), msg = $('[data-gpath-msg]'), box = $('[data-gpath-previewbox]');
    const all = [...(o.services || []), ...(o.resources || [])];
    const invalidate = () => { confirm.disabled = true; box.hidden = true; };
    [sel, reason, note].forEach((el) => el.addEventListener('input', invalidate));
    host.onclick = async (e) => {
      const use = e.target.closest('[data-gpath-use]'); if (use) { sel.value = use.dataset.gpathUse; invalidate(); sel.focus(); return; }
      if (e.target.closest('[data-gpath-preview]')) {
        const it = all.find((x) => x.key === sel.value);
        if (!it) { msg.textContent = 'Choose a recommendation first.'; return; }
        if (/https?:|www\.|[<>]/i.test(reason.value + note.value)) { msg.textContent = 'Plain text only: no links or markup.'; return; }
        msg.textContent = '';
        box.hidden = false;
        box.innerHTML = `<p class="gpath-rec__k">What they will see</p><ol class="gpath__list gpath__list--preview">${itemHtml({ key: 'preview', stage_label: 'Start now', title: it.title, reason: reason.value.trim(), note: note.value.trim(), practitioner_name: 'you', provenance: { source_type: 'practitioner_manual' }, action: { label: it.key.startsWith('svc:') ? 'View service' : 'Open' }, completion: 'user' }, 0)}</ol>`;
        confirm.disabled = false;
        return;
      }
      if (e.target.closest('[data-gpath-confirm]')) {
        confirm.disabled = true; msg.textContent = 'Saving…';
        const res = await api('/api/practitioners/path/recommend', { method: 'POST', body: { confirm: true, customer_id: String(clientId), resource_key: sel.value, member_safe_reason: reason.value, note: note.value } });
        if (res.ok) { msg.textContent = 'Recommended. It is on their Gaia Path now.'; mountPractice(host, clientId, suggestedServices).then(() => { const m = host.querySelector('[data-gpath-msg]'); if (m) m.textContent = 'Recommended. It is on their Gaia Path now.'; }); }
        else msg.textContent = ({ already_recommended: 'You already recommended this to them.', note_no_links_or_markup: 'The note must be plain text, without links.', reason_no_links_or_markup: 'The reason must be plain text, without links.', resource_not_selectable: 'That is not available to recommend.' })[res.body.error] || 'Could not save that. Try again.';
        return;
      }
      const rv = e.target.closest('[data-gpath-revoke]');
      if (rv) { rv.disabled = true; const res = await api('/api/practitioners/path/revoke', { method: 'POST', body: { id: rv.dataset.gpathRevoke } }); if (res.ok) mountPractice(host, clientId, suggestedServices); else rv.disabled = false; }
    };
  }

  // ── boot ────────────────────────────────────────────────────────────────
  document.addEventListener('gaia:member', () => render());
  // A reading opened (or a new one arrived) changes the path; refetch only when that flag changes.
  let lastNew = null;
  window.addEventListener('gaia:readings-status', (e) => { const n = Boolean(e.detail?.new_reading); if (last && lastNew !== null && n !== lastNew) render(true); lastNew = n; });
  document.addEventListener('gaia:superapp-rendered', () => placeHomeRow(last));
  document.addEventListener('gaia:view-changed', () => { if (last) placeHomeRow(last); });
  window.GaiaPath = { load, render, refresh, perform, settle, mountPractice, next: async () => { const p = last || await load(); return p ? { item: (p.items || [])[0] || null, after: (p.items || [])[1] || null, caught_up: Boolean(p.caught_up), count: (p.items || []).length } : null; } };
})();
