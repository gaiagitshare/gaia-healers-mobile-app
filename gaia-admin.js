/** Gaia — Admin panel controller (operator-only).
 * Talks to /api/admin/* (password-gated by the server). Runs only when the
 * admin screen is opened. Manages events, announcements, and member tags.
 */
(function () {
  'use strict';
  const console_ = document.getElementById('admin-console');
  const loginBox = document.getElementById('admin-login');
  if (!console_ || !loginBox) return;

  function proxyBase() {
    return String(
      (window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
      || 'https://api.gaiahealers.app',
    ).replace(/\/+$/, '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  async function api(method, path, body) {
    const opt = { method, headers: { Accept: 'application/json' }, credentials: 'include' };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    try { const r = await fetch(proxyBase() + path, opt); return await r.json(); } catch (_) { return { ok: false, reason: 'network' }; }
  }
  const el = (id) => document.getElementById(id);
  const logoutBtn = el('admin-logout');
  const sub = el('admin-sub');
  let booted = false;

  // ── boot / auth ─────────────────────────────────────────────
  async function boot() {
    const s = await api('GET', '/api/admin/session');
    if (s && s.authed) { showConsole(); return; }
    showLogin(s && s.configured);
  }

  function showLogin(configured) {
    console_.hidden = true;
    logoutBtn.hidden = true;
    loginBox.hidden = false;
    if (sub) sub.textContent = 'Sign in to manage the app.';
    if (configured === false) {
      loginBox.innerHTML = '<div class="g-note g-note--warn"><b>Admin isn’t configured yet.</b><br>'
        + 'Set <code>GAIA_ADMIN_PASSWORD</code> in the proxy’s <code>.env</code> and restart the service, then reload this page.</div>';
      return;
    }
    loginBox.innerHTML =
      '<article class="g-card"><p class="g-card__label">Operator sign-in</p>'
      + '<div class="g-field"><label class="g-label" for="admin-pw">Admin password</label>'
      + '<input class="g-input" id="admin-pw" type="password" autocomplete="current-password" placeholder="••••••••" /></div>'
      + '<p class="g-admin-status" id="admin-login-status"></p>'
      + '<div class="g-card__actions"><button class="g-btn g-btn--primary g-btn--sm" id="admin-login-btn">Sign in</button></div></article>';
    const input = el('admin-pw');
    const status = el('admin-login-status');
    const submit = async () => {
      status.textContent = 'Signing in…'; status.className = 'g-admin-status';
      const r = await api('POST', '/api/admin/login', { password: input.value });
      if (r && r.ok) { showConsole(); return; }
      status.textContent = r && r.reason === 'not_configured' ? 'Admin isn’t configured on the server.' : 'Incorrect password.';
      status.className = 'g-admin-status g-admin-status--err';
    };
    el('admin-login-btn').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    input.focus();
  }

  function showConsole() {
    loginBox.hidden = true;
    console_.hidden = false;
    logoutBtn.hidden = false;
    if (sub) sub.textContent = 'Manage events, announcements, and members.';
    loadEvents(); loadContent(); bindMembers();
  }

  logoutBtn.addEventListener('click', async () => { await api('POST', '/api/admin/logout'); showLogin(true); });

  // ── tabs ────────────────────────────────────────────────────
  const tabs = console_.querySelectorAll('[data-admin-tab]');
  tabs.forEach((t) => t.addEventListener('click', () => {
    const key = t.dataset.adminTab;
    tabs.forEach((x) => { const on = x === t; x.classList.toggle('is-active', on); x.setAttribute('aria-selected', String(on)); });
    ['events', 'content', 'members'].forEach((k) => { const pane = el('admin-panel-' + k); if (pane) pane.hidden = k !== key; });
  }));

  // ── EVENTS ──────────────────────────────────────────────────
  let editEventId = '';
  function eventForm() {
    return '<article class="g-card"><p class="g-card__label" id="event-form-title">New event</p>'
      + '<div class="g-field"><label class="g-label" for="ev-title">Title</label><input class="g-input" id="ev-title" placeholder="Gaia Full Moon Circle" /></div>'
      + '<div class="g-field"><label class="g-label" for="ev-date">Date</label><input class="g-input" id="ev-date" placeholder="Aug 22, 2026" /></div>'
      + '<div class="g-field"><label class="g-label" for="ev-venue">Venue</label><input class="g-input" id="ev-venue" placeholder="Online / city" /></div>'
      + '<div class="g-field"><label class="g-label" for="ev-url">Register URL</label><input class="g-input" id="ev-url" placeholder="https://…" /></div>'
      + '<div class="g-field"><label class="g-label" for="ev-summary">Summary</label><textarea class="g-textarea" id="ev-summary" placeholder="One or two lines shown on the card."></textarea></div>'
      + '<div class="g-checks">'
      + '<label class="g-check"><input type="checkbox" id="ev-featured" /> Feature on Home</label>'
      + '<label class="g-check"><input type="checkbox" id="ev-live" /> Happening now</label>'
      + '<label class="g-check"><input type="checkbox" id="ev-published" checked /> Published</label></div>'
      + '<p class="g-admin-status" id="ev-status"></p>'
      + '<div class="g-card__actions"><button class="g-btn g-btn--primary g-btn--sm" id="ev-save">Save event</button>'
      + '<button class="g-btn g-btn--ghost g-btn--sm" id="ev-clear">Clear</button></div></article>';
  }
  function fillEventForm(ev) {
    editEventId = ev ? ev.id : '';
    el('event-form-title').textContent = ev ? 'Edit event' : 'New event';
    el('ev-title').value = ev ? ev.title : '';
    el('ev-date').value = ev ? ev.date : '';
    el('ev-venue').value = ev ? ev.venue : '';
    el('ev-url').value = ev ? ev.registerUrl : '';
    el('ev-summary').value = ev ? ev.summary : '';
    el('ev-featured').checked = ev ? !!ev.featured : false;
    el('ev-live').checked = ev ? !!ev.live : false;
    el('ev-published').checked = ev ? ev.published !== false : true;
  }
  async function loadEvents() {
    const pane = el('admin-panel-events');
    if (!pane.dataset.built) { pane.innerHTML = eventForm() + '<div id="event-list" class="g-admin-panel"></div>'; pane.dataset.built = '1'; bindEventForm(); }
    const r = await api('GET', '/api/admin/events');
    const list = el('event-list');
    const items = (r && r.events) || [];
    list.innerHTML = items.length ? items.map(eventItem).join('')
      : '<p class="g-empty">No events yet. Create one above.</p>';
    list.querySelectorAll('[data-ev-edit]').forEach((b) => b.addEventListener('click', () => {
      const ev = items.find((x) => x.id === b.dataset.evEdit); if (ev) { fillEventForm(ev); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    }));
    list.querySelectorAll('[data-ev-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm('Delete this event?')) return;
      await api('DELETE', '/api/admin/events?id=' + encodeURIComponent(b.dataset.evDel));
      if (editEventId === b.dataset.evDel) fillEventForm(null);
      loadEvents();
    }));
  }
  function eventItem(ev) {
    const flags = [ev.featured ? 'Featured' : '', ev.live ? 'Live' : '', ev.published ? 'Published' : 'Draft'].filter(Boolean).join(' · ');
    return '<div class="g-admin-item"><div class="g-admin-item__body">'
      + '<span class="g-admin-item__title">' + esc(ev.title) + '</span>'
      + '<span class="g-admin-item__meta">' + [esc(ev.date), esc(ev.venue)].filter(Boolean).join(' · ') + '</span>'
      + '<span class="g-admin-item__meta">' + esc(flags) + '</span></div>'
      + '<div class="g-admin-item__actions"><button class="g-btn g-btn--secondary g-btn--sm" data-ev-edit="' + esc(ev.id) + '">Edit</button>'
      + '<button class="g-btn g-btn--ghost g-btn--sm" data-ev-del="' + esc(ev.id) + '">Delete</button></div></div>';
  }
  function bindEventForm() {
    el('ev-clear').addEventListener('click', () => fillEventForm(null));
    el('ev-save').addEventListener('click', async () => {
      const status = el('ev-status');
      const payload = {
        id: editEventId || undefined,
        title: el('ev-title').value, date: el('ev-date').value, venue: el('ev-venue').value,
        registerUrl: el('ev-url').value, summary: el('ev-summary').value,
        featured: el('ev-featured').checked, live: el('ev-live').checked, published: el('ev-published').checked,
      };
      if (!payload.title.trim()) { status.textContent = 'Title is required.'; status.className = 'g-admin-status g-admin-status--err'; return; }
      status.textContent = 'Saving…'; status.className = 'g-admin-status';
      const r = await api('POST', '/api/admin/events', payload);
      if (r && r.ok) { status.textContent = 'Saved.'; status.className = 'g-admin-status g-admin-status--ok'; fillEventForm(null); loadEvents(); }
      else { status.textContent = 'Could not save.'; status.className = 'g-admin-status g-admin-status--err'; }
    });
  }

  // ── CONTENT ─────────────────────────────────────────────────
  let editContentId = '';
  function contentForm() {
    return '<article class="g-card"><p class="g-card__label" id="content-form-title">New announcement</p>'
      + '<div class="g-field"><label class="g-label" for="an-title">Title</label><input class="g-input" id="an-title" placeholder="New Colour Energy sprays in stock" /></div>'
      + '<div class="g-field"><label class="g-label" for="an-body">Body</label><textarea class="g-textarea" id="an-body" placeholder="One or two lines."></textarea></div>'
      + '<div class="g-field"><label class="g-label" for="an-link">Link (optional)</label><input class="g-input" id="an-link" placeholder="https://…" /></div>'
      + '<div class="g-field"><label class="g-label" for="an-tone">Tone</label><select class="g-input" id="an-tone"><option value="info">Info</option><option value="success">Good news</option><option value="warn">Heads up</option></select></div>'
      + '<div class="g-checks"><label class="g-check"><input type="checkbox" id="an-published" checked /> Published</label></div>'
      + '<p class="g-admin-status" id="an-status"></p>'
      + '<div class="g-card__actions"><button class="g-btn g-btn--primary g-btn--sm" id="an-save">Save</button>'
      + '<button class="g-btn g-btn--ghost g-btn--sm" id="an-clear">Clear</button></div></article>';
  }
  function fillContentForm(a) {
    editContentId = a ? a.id : '';
    el('content-form-title').textContent = a ? 'Edit announcement' : 'New announcement';
    el('an-title').value = a ? a.title : '';
    el('an-body').value = a ? a.body : '';
    el('an-link').value = a ? a.link : '';
    el('an-tone').value = a ? a.tone : 'info';
    el('an-published').checked = a ? a.published !== false : true;
  }
  async function loadContent() {
    const pane = el('admin-panel-content');
    if (!pane.dataset.built) { pane.innerHTML = contentForm() + '<div id="content-list" class="g-admin-panel"></div>'; pane.dataset.built = '1'; bindContentForm(); }
    const r = await api('GET', '/api/admin/content');
    const list = el('content-list');
    const items = (r && r.announcements) || [];
    list.innerHTML = items.length ? items.map(contentItem).join('')
      : '<p class="g-empty">No announcements yet.</p>';
    list.querySelectorAll('[data-an-edit]').forEach((b) => b.addEventListener('click', () => {
      const a = items.find((x) => x.id === b.dataset.anEdit); if (a) { fillContentForm(a); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    }));
    list.querySelectorAll('[data-an-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm('Delete this announcement?')) return;
      await api('DELETE', '/api/admin/content?id=' + encodeURIComponent(b.dataset.anDel));
      if (editContentId === b.dataset.anDel) fillContentForm(null);
      loadContent();
    }));
  }
  function contentItem(a) {
    return '<div class="g-admin-item"><div class="g-admin-item__body">'
      + '<span class="g-admin-item__title">' + esc(a.title) + '</span>'
      + '<span class="g-admin-item__meta">' + esc(a.body || '') + '</span>'
      + '<span class="g-admin-item__meta">' + (a.tone || 'info') + ' · ' + (a.published ? 'Published' : 'Draft') + '</span></div>'
      + '<div class="g-admin-item__actions"><button class="g-btn g-btn--secondary g-btn--sm" data-an-edit="' + esc(a.id) + '">Edit</button>'
      + '<button class="g-btn g-btn--ghost g-btn--sm" data-an-del="' + esc(a.id) + '">Delete</button></div></div>';
  }
  function bindContentForm() {
    el('an-clear').addEventListener('click', () => fillContentForm(null));
    el('an-save').addEventListener('click', async () => {
      const status = el('an-status');
      const payload = {
        id: editContentId || undefined,
        title: el('an-title').value, body: el('an-body').value, link: el('an-link').value,
        tone: el('an-tone').value, published: el('an-published').checked,
      };
      if (!payload.title.trim()) { status.textContent = 'Title is required.'; status.className = 'g-admin-status g-admin-status--err'; return; }
      status.textContent = 'Saving…'; status.className = 'g-admin-status';
      const r = await api('POST', '/api/admin/content', payload);
      if (r && r.ok) { status.textContent = 'Saved.'; status.className = 'g-admin-status g-admin-status--ok'; fillContentForm(null); loadContent(); }
      else { status.textContent = 'Could not save.'; status.className = 'g-admin-status g-admin-status--err'; }
    });
  }

  // ── MEMBERS ─────────────────────────────────────────────────
  let selectedMember = null;
  function bindMembers() {
    const pane = el('admin-panel-members');
    if (pane.dataset.built) return; pane.dataset.built = '1';
    pane.innerHTML =
      '<article class="g-card"><p class="g-card__label">Find a member</p>'
      + '<div class="g-field"><input class="g-input" id="mem-q" placeholder="Search by name or email" /></div>'
      + '<p class="g-admin-status" id="mem-status"></p>'
      + '<div class="g-card__actions"><button class="g-btn g-btn--primary g-btn--sm" id="mem-search">Search</button></div></article>'
      + '<div id="mem-results" class="g-admin-panel"></div>'
      + '<div id="mem-detail" class="g-admin-panel"></div>';
    const q = el('mem-q');
    const run = () => searchMembers(q.value);
    el('mem-search').addEventListener('click', run);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  }
  async function searchMembers(q) {
    const status = el('mem-status');
    el('mem-detail').innerHTML = '';
    if (!q.trim()) { status.textContent = 'Type a name or email.'; status.className = 'g-admin-status g-admin-status--err'; return; }
    status.textContent = 'Searching…'; status.className = 'g-admin-status';
    const r = await api('GET', '/api/admin/members/search?q=' + encodeURIComponent(q.trim()));
    if (r && r.reason === 'ghl_unconfigured') { status.textContent = 'GHL is not connected on the server.'; status.className = 'g-admin-status g-admin-status--err'; return; }
    const members = (r && r.members) || [];
    status.textContent = members.length ? members.length + ' found' : 'No members found.';
    status.className = 'g-admin-status';
    el('mem-results').innerHTML = members.map(memberItem).join('');
    el('mem-results').querySelectorAll('[data-mem]').forEach((b) => b.addEventListener('click', () => {
      const m = members.find((x) => x.id === b.dataset.mem); if (m) openMember(m);
    }));
  }
  function memberItem(m) {
    return '<div class="g-admin-item"><div class="g-admin-item__body">'
      + '<span class="g-admin-item__title">' + esc(m.name) + '</span>'
      + '<span class="g-admin-item__meta">' + esc(m.email || '') + ' · ' + (m.tags ? m.tags.length : 0) + ' tags</span></div>'
      + '<div class="g-admin-item__actions"><button class="g-btn g-btn--secondary g-btn--sm" data-mem="' + esc(m.id) + '">Open</button></div></div>';
  }
  function openMember(m) {
    selectedMember = m;
    renderMemberDetail();
    el('mem-detail').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function renderMemberDetail() {
    const m = selectedMember; if (!m) return;
    const tags = (m.tags || []).map((t) => '<span class="g-tag">' + esc(t) + '<button data-untag="' + esc(t) + '" title="Remove tag" aria-label="Remove ' + esc(t) + '">×</button></span>').join('') || '<span class="g-empty">No tags.</span>';
    el('mem-detail').innerHTML =
      '<article class="g-card"><p class="g-card__label">' + esc(m.name) + '</p>'
      + '<p class="g-card__meta">' + esc(m.email || '') + '</p>'
      + '<p class="g-label" style="margin-top:12px">Tags</p><div class="g-tagrow">' + tags + '</div>'
      + '<div class="g-field"><label class="g-label" for="mem-newtag">Add tag</label>'
      + '<input class="g-input" id="mem-newtag" placeholder="e.g. membership_silver" /></div>'
      + '<p class="g-admin-status" id="mem-tag-status"></p>'
      + '<div class="g-card__actions"><button class="g-btn g-btn--primary g-btn--sm" id="mem-addtag">Add tag</button></div>'
      + '<div class="g-note" style="margin-top:12px">Editing tags needs the GHL integration to have <b style="color:var(--g-text-muted)">contacts.write</b> scope. Until it does, changes return “scope required”.</div></article>';
    el('mem-addtag').addEventListener('click', () => writeTag(el('mem-newtag').value, true));
    el('mem-detail').querySelectorAll('[data-untag]').forEach((b) => b.addEventListener('click', () => writeTag(b.dataset.untag, false)));
  }
  async function writeTag(tag, add) {
    const status = el('mem-tag-status');
    if (!tag || !tag.trim()) { status.textContent = 'Enter a tag.'; status.className = 'g-admin-status g-admin-status--err'; return; }
    if (!selectedMember) return;
    status.textContent = add ? 'Adding…' : 'Removing…'; status.className = 'g-admin-status';
    const r = await api('POST', '/api/admin/members/tags', { contactId: selectedMember.id, tag: tag.trim(), add });
    if (r && r.ok) {
      const t = tag.trim();
      if (add) { if (!selectedMember.tags.includes(t)) selectedMember.tags.push(t); }
      else { selectedMember.tags = selectedMember.tags.filter((x) => x !== t); }
      renderMemberDetail();
      const s2 = el('mem-tag-status'); if (s2) { s2.textContent = 'Saved.'; s2.className = 'g-admin-status g-admin-status--ok'; }
    } else if (r && r.reason === 'scope_required') {
      status.textContent = 'GHL needs contacts.write scope to change tags (see note below).'; status.className = 'g-admin-status g-admin-status--err';
    } else {
      status.textContent = 'Could not update tag.'; status.className = 'g-admin-status g-admin-status--err';
    }
  }

  // ── open only when the admin view is active ─────────────────
  function currentView() {
    return (window.GaiaAppShell && window.GaiaAppShell.currentView && window.GaiaAppShell.currentView())
      || new URLSearchParams(window.location.search).get('view') || 'today';
  }
  function maybeBoot() { if (!booted && currentView() === 'admin') { booted = true; boot(); } }
  window.addEventListener('gaia:route', maybeBoot);
  document.addEventListener('DOMContentLoaded', maybeBoot);
  maybeBoot();
})();
