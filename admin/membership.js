/** Gaia — Membership Control Center (operator-only).
 *
 * The screen where a member's access is built by hand: plan, entitlements,
 * expiry, evidence, history. Talks only to /api/admin/membership/*.
 *
 * The layout carries the one distinction the system is built on. "Plan" and
 * "Entitlements" are separate panels, never one table: a plan is a PROMISE, an
 * entitlement is something the member HOLDS. Assigning Gold changes the first
 * and not the second, and the UI says so out loud, because an operator who
 * believes otherwise will hand out access that no record can explain.
 */
(function () {
  'use strict';

  const panel = document.getElementById('admin-panel-membership');
  if (!panel) return;

  function proxyBase() {
    try { if (window.location.hostname === 'api.gaiahealers.app') return ''; } catch (_) { /* ignore */ }
    return 'https://api.gaiahealers.app';
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
  const on = (id, event, fn) => { const node = el(id); if (node) node.addEventListener(event, fn); };
  const val = (id) => { const node = el(id); return node ? node.value.trim() : ''; };

  let schema = null;      // what can be granted at all
  let plans = [];         // the benefits matrix
  let view = 'members';   // members | plans | audit
  let current = null;     // the member on screen
  let loaded = false;

  const dateOnly = (iso) => (iso ? String(iso).slice(0, 10) : '—');
  const planLabel = (key) => (plans.find((p) => p.key === key) || {}).label || key || '—';
  const typeTitle = (key) => {
    const found = (schema && schema.entitlementTypes || []).find((t) => t.key === key);
    return found ? found.title : key;
  };

  function status(id, message, kind) {
    const node = el(id);
    if (!node) return;
    node.textContent = message || '';
    node.className = 'g-admin-status' + (kind ? ' g-admin-status--' + kind : '');
  }

  /** A value object is shown as compact JSON — it is data, not prose. */
  const showValue = (value) => {
    if (!value || typeof value !== 'object' || !Object.keys(value).length) return '';
    return esc(JSON.stringify(value));
  };

  // ── shell ───────────────────────────────────────────────────
  function render() {
    panel.innerHTML =
      '<div class="g-tabs g-tabs--3" role="tablist" aria-label="Membership sections">'
      + ['members', 'plans', 'audit'].map((key) => '<button type="button" class="g-tab'
        + (view === key ? ' is-active' : '') + '" data-ms-view="' + key + '" role="tab" aria-selected="'
        + (view === key) + '">' + (key === 'plans' ? 'Plans &amp; Benefits' : key[0].toUpperCase() + key.slice(1)) + '</button>').join('')
      + '</div><div id="ms-body"></div>';
    panel.querySelectorAll('[data-ms-view]').forEach((tab) => tab.addEventListener('click', () => {
      view = tab.dataset.msView; render();
    }));
    if (view === 'members') renderMembers();
    else if (view === 'plans') renderPlans();
    else renderAudit();
  }

  // ── members list ────────────────────────────────────────────
  async function renderMembers() {
    const body = el('ms-body');
    body.innerHTML =
      '<article class="g-card"><p class="g-card__label">Find a member</p>'
      + '<div class="g-field"><label class="g-label" for="ms-q">Contact ID</label>'
      + '<input class="g-input" id="ms-q" placeholder="Search by contact ID" /></div>'
      + '<div class="g-card__actions"><button class="g-btn g-btn--secondary g-btn--sm" id="ms-search">Search</button>'
      + '<button class="g-btn g-btn--ghost g-btn--sm" id="ms-clear">Show all</button></div>'
      + '<p class="g-admin-status" id="ms-list-status"></p></article>'
      + '<div id="ms-counts"></div><div id="ms-list"></div><div id="ms-member"></div>';

    on('ms-search', 'click', () => loadList(val('ms-q')));
    on('ms-clear', 'click', () => { el('ms-q').value = ''; loadList(''); });
    const input = el('ms-q');
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadList(val('ms-q')); });
    loadList('');
  }

  async function loadList(query) {
    status('ms-list-status', 'Loading…');
    const res = await api('GET', '/api/admin/membership/members?q=' + encodeURIComponent(query || ''));
    if (!res || !res.ok) { status('ms-list-status', 'Could not load members.', 'err'); return; }
    status('ms-list-status', '');

    const counts = res.counts || {};
    el('ms-counts').innerHTML = '<article class="g-card"><p class="g-card__label">Members by plan</p><div class="g-tagrow">'
      + ['free', 'silver', 'gold', 'diamond', 'none'].map((key) => '<span class="g-tag">'
        + esc(key === 'none' ? 'No plan' : planLabel(key)) + ': ' + (counts[key] || 0) + '</span>').join('')
      + '</div></article>';

    if (!res.members.length) {
      el('ms-list').innerHTML = '<p class="g-empty">No members yet. Grant one a plan below and it will appear here.</p>';
      return;
    }
    el('ms-list').innerHTML = '<article class="g-card"><p class="g-card__label">'
      + res.total + ' member' + (res.total === 1 ? '' : 's') + '</p>'
      + res.members.map((m) => '<div class="g-admin-item"><div><b>' + esc(m.contactId) + '</b>'
        + '<br><span class="g-text-muted">' + esc(m.plan ? planLabel(m.plan) + ' · ' + m.status : 'No plan')
        + ' · ' + m.entitlements + ' active entitlement' + (m.entitlements === 1 ? '' : 's') + '</span></div>'
        + '<button class="g-btn g-btn--ghost g-btn--sm" data-ms-open="' + esc(m.contactId) + '">Open</button></div>').join('')
      + '</article>';
    el('ms-list').querySelectorAll('[data-ms-open]').forEach((btn) => btn.addEventListener('click',
      () => openMember(btn.dataset.msOpen)));
  }

  // ── one member ──────────────────────────────────────────────
  async function openMember(contactId) {
    const target = el('ms-member');
    if (!target) return;
    target.innerHTML = '<p class="g-empty">Loading ' + esc(contactId) + '…</p>';
    const res = await api('GET', '/api/admin/membership/member?id=' + encodeURIComponent(contactId));
    if (!res || !res.ok) {
      target.innerHTML = '<article class="g-card"><p class="g-card__label">' + esc(contactId) + '</p>'
        + '<p class="g-empty">No ledger record yet. Assigning a plan will create one.</p>'
        + assignForm(contactId, null) + '</article>';
      bindAssign(contactId);
      return;
    }
    current = res.member;
    drawMember(current);
  }

  function assignForm(contactId, membership) {
    const keys = (schema && schema.membershipKeys) || ['free', 'silver', 'gold', 'diamond'];
    const statuses = (schema && schema.membershipStatuses) || ['active', 'trialing', 'past_due', 'cancelled', 'expired'];
    const cycles = (schema && schema.billingCycles) || ['none', 'monthly', 'annual'];
    const opt = (list, selected) => list.map((v) => '<option value="' + esc(v) + '"'
      + (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
    return '<div class="g-field"><label class="g-label" for="ms-plan">Plan</label>'
      + '<select class="g-input" id="ms-plan">' + opt(keys, membership && membership.key) + '</select></div>'
      + '<div class="g-field"><label class="g-label" for="ms-status">Status</label>'
      + '<select class="g-input" id="ms-status">' + opt(statuses, (membership && membership.status) || 'active') + '</select></div>'
      + '<div class="g-field"><label class="g-label" for="ms-cycle">Billing cycle</label>'
      + '<select class="g-input" id="ms-cycle">' + opt(cycles, (membership && membership.billing_cycle) || 'none') + '</select></div>'
      + '<div class="g-field"><label class="g-label" for="ms-evidence">Evidence (order, invoice, ticket)</label>'
      + '<input class="g-input" id="ms-evidence" placeholder="e.g. comped-retreat-2026" /></div>'
      + '<div class="g-field"><label class="g-label" for="ms-note">Note for the audit log</label>'
      + '<input class="g-input" id="ms-note" placeholder="Why, and who asked for it" /></div>'
      + '<p class="g-admin-status" id="ms-assign-status"></p>'
      + '<div class="g-card__actions"><button class="g-btn g-btn--primary g-btn--sm" id="ms-assign">Set plan</button>'
      + (membership ? '<button class="g-btn g-btn--ghost g-btn--sm" id="ms-end">End membership</button>' : '')
      + '</div>'
      + '<p class="g-text-muted">Setting a plan records the plan only. It grants nothing — '
      + 'use <b>Apply plan benefits</b> below to write the actual entitlements.</p>';
  }

  function bindAssign(contactId) {
    on('ms-assign', 'click', async () => {
      status('ms-assign-status', 'Saving…');
      const res = await api('POST', '/api/admin/membership/assign', {
        contactId, key: val('ms-plan'), status: val('ms-status'),
        billing_cycle: val('ms-cycle'), evidence_id: val('ms-evidence'), note: val('ms-note'),
      });
      if (!res.ok) { status('ms-assign-status', 'Refused: ' + esc(res.reason || 'unknown'), 'err'); return; }
      current = res.member;
      drawMember(current);
      loadList(val('ms-q'));
    });
    on('ms-end', 'click', async () => {
      status('ms-assign-status', 'Ending…');
      const res = await api('POST', '/api/admin/membership/end', { contactId, note: val('ms-note') });
      if (!res.ok) { status('ms-assign-status', 'Refused: ' + esc(res.reason || 'unknown'), 'err'); return; }
      current = res.member;
      drawMember(current);
      loadList(val('ms-q'));
    });
  }

  function drawMember(member) {
    const id = member.contactId;
    const m = member.membership;
    const active = (member.entitlements || []).filter((e) => e.status === 'active');
    const inactive = (member.entitlements || []).filter((e) => e.status !== 'active');
    const drift = member.drift || { missing: [], extra: [] };

    // Grouped by type so "what does this member have" reads as a list of
    // rights, not a flat log.
    const groups = {};
    active.forEach((e) => { (groups[e.type] = groups[e.type] || []).push(e); });

    const row = (e) => '<div class="g-admin-item"><div><b>' + esc(e.key) + '</b> '
      + (showValue(e.value) ? '<span class="g-text-muted">' + showValue(e.value) + '</span>' : '')
      + '<br><span class="g-text-muted">source: ' + esc(e.source)
      + (e.evidence_id ? ' · evidence: ' + esc(e.evidence_id) : '')
      + (e.expires_at ? ' · expires ' + dateOnly(e.expires_at) : ' · no expiry')
      + '</span></div>'
      + (e.status === 'active'
        ? '<button class="g-btn g-btn--ghost g-btn--sm" data-ms-revoke="' + esc(e.type) + '|' + esc(e.key) + '">Revoke</button>'
        : '<span class="g-tag">' + esc(e.status) + '</span>') + '</div>';

    el('ms-member').innerHTML =
      // 1. the plan — a promise
      '<article class="g-card"><p class="g-card__label">Plan · ' + esc(id) + '</p>'
      + (m
        ? '<p><b>' + esc(planLabel(m.key)) + '</b> — ' + esc(m.status)
          + ' · ' + esc(m.billing_cycle) + ' · source: ' + esc(m.source)
          + '<br><span class="g-text-muted">started ' + dateOnly(m.started_at)
          + (m.renews_at ? ' · renews ' + dateOnly(m.renews_at) : '')
          + (m.ends_at ? ' · ends ' + dateOnly(m.ends_at) : '') + '</span></p>'
        : '<p class="g-empty">No plan on record.</p>')
      + assignForm(id, m) + '</article>'

      // 2. the gap between promise and holding
      + (m ? '<article class="g-card"><p class="g-card__label">Plan benefits not yet granted</p>'
        + (drift.missing.length
          ? '<p class="g-text-muted">' + esc(planLabel(m.key)) + ' promises these. This member does not hold them yet.</p>'
            + drift.missing.map((d) => '<div class="g-admin-item"><div><b>' + esc(typeTitle(d.type))
              + '</b> <span class="g-text-muted">' + esc(d.key) + ' ' + showValue(d.value) + '</span></div></div>').join('')
            + '<p class="g-admin-status" id="ms-policy-status"></p>'
            + '<div class="g-card__actions"><button class="g-btn g-btn--primary g-btn--sm" id="ms-apply-policy">'
            + 'Apply plan benefits</button></div>'
          : '<p class="g-empty">This member holds everything ' + esc(planLabel(m.key)) + ' promises.</p>'
            + '<p class="g-admin-status" id="ms-policy-status"></p>')
        + (drift.extra && drift.extra.length
          ? '<p class="g-text-muted" style="margin-top:12px">Left over from a previous plan — '
            + esc(planLabel(m.key)) + ' does not include these. Revoke them below if that is wrong:</p>'
            + '<div class="g-tagrow">' + drift.extra.map((d) => '<span class="g-tag">'
              + esc(typeTitle(d.type)) + '</span>').join('') + '</div>'
          : '')
        + '</article>' : '')

      // 3. what the member actually holds
      + '<article class="g-card"><p class="g-card__label">Entitlements this member holds</p>'
      + (active.length
        ? Object.keys(groups).map((type) => '<p class="g-label">' + esc(typeTitle(type)) + '</p>'
          + groups[type].map(row).join('')).join('')
        : '<p class="g-empty">Nothing granted yet.</p>')
      + '</article>'

      + (inactive.length ? '<article class="g-card"><p class="g-card__label">Revoked and expired</p>'
        + '<p class="g-text-muted">Kept on record so the history can be read.</p>'
        + inactive.map(row).join('') + '</article>' : '')

      // 4. grant something new
      + '<article class="g-card"><p class="g-card__label">Grant an entitlement</p>' + grantForm() + '</article>'

      // 5. history
      + '<article class="g-card"><p class="g-card__label">History</p>'
      + (member.audit && member.audit.length
        ? member.audit.map(auditRow).join('')
        : '<p class="g-empty">No changes recorded.</p>')
      + '</article>';

    bindAssign(id);
    bindGrant(id);
    on('ms-apply-policy', 'click', async () => {
      status('ms-policy-status', 'Writing entitlement records…');
      const res = await api('POST', '/api/admin/membership/apply-policy', { contactId: id });
      if (!res.ok) { status('ms-policy-status', 'Refused: ' + esc(res.reason || 'unknown'), 'err'); return; }
      current = res.member;
      drawMember(current);
    });
    el('ms-member').querySelectorAll('[data-ms-revoke]').forEach((btn) => btn.addEventListener('click', async () => {
      const [type, key] = btn.dataset.msRevoke.split('|');
      const note = window.prompt('Why is this being revoked? (recorded in the audit log)', '');
      if (note === null) return;
      const res = await api('POST', '/api/admin/membership/revoke', { contactId: id, type, key, note });
      if (!res.ok) { window.alert('Refused: ' + (res.reason || 'unknown')); return; }
      current = res.member;
      drawMember(current);
    }));
  }

  function auditRow(entry) {
    return '<div class="g-admin-item"><div><b>' + esc(entry.action) + '</b> '
      + '<span class="g-text-muted">' + esc(entry.at.replace('T', ' ').slice(0, 16)) + ' · ' + esc(entry.actor)
      + '</span>' + (entry.note ? '<br><span class="g-text-muted">' + esc(entry.note) + '</span>' : '') + '</div></div>';
  }

  function grantForm() {
    const types = (schema && schema.entitlementTypes) || [];
    return '<div class="g-field"><label class="g-label" for="ms-gtype">What</label>'
      + '<select class="g-input" id="ms-gtype">'
      + types.map((t) => '<option value="' + esc(t.key) + '">' + esc(t.title) + '</option>').join('')
      + '</select></div>'
      + '<div class="g-field"><label class="g-label" for="ms-gkey">Identifier</label>'
      + '<input class="g-input" id="ms-gkey" placeholder="course id, device id, community id…" /></div>'
      + '<div class="g-field"><label class="g-label" for="ms-gvalue">Details (JSON, optional)</label>'
      + '<input class="g-input" id="ms-gvalue" placeholder=\'{"name":"Bio-Well 3.0"}\' /></div>'
      + '<div class="g-field"><label class="g-label" for="ms-gexpires">Expires (optional)</label>'
      + '<input class="g-input" id="ms-gexpires" type="date" /></div>'
      + '<div class="g-field"><label class="g-label" for="ms-gevidence">Evidence</label>'
      + '<input class="g-input" id="ms-gevidence" placeholder="order number, invoice, ticket" /></div>'
      + '<div class="g-field"><label class="g-label" for="ms-gnote">Note for the audit log</label>'
      + '<input class="g-input" id="ms-gnote" placeholder="Why this is being granted" /></div>'
      + '<p class="g-admin-status" id="ms-grant-status"></p>'
      + '<div class="g-card__actions"><button class="g-btn g-btn--primary g-btn--sm" id="ms-grant">Grant</button></div>'
      + '<p class="g-text-muted">Recorded as a manual grant by an operator — never disguised as a purchase or a sync.</p>';
  }

  function bindGrant(contactId) {
    on('ms-grant', 'click', async () => {
      const key = val('ms-gkey');
      if (!key) { status('ms-grant-status', 'An identifier is required.', 'err'); return; }
      let value = {};
      const rawValue = val('ms-gvalue');
      if (rawValue) {
        try { value = JSON.parse(rawValue); } catch (_) {
          status('ms-grant-status', 'Details must be valid JSON, or left empty.', 'err'); return;
        }
      }
      const expires = val('ms-gexpires');
      status('ms-grant-status', 'Granting…');
      const res = await api('POST', '/api/admin/membership/grant', {
        contactId, type: val('ms-gtype'), key, value,
        expires_at: expires ? new Date(expires + 'T23:59:59Z').toISOString() : null,
        evidence_id: val('ms-gevidence'), note: val('ms-gnote'),
      });
      if (!res.ok) { status('ms-grant-status', 'Refused: ' + esc(res.reason || 'unknown'), 'err'); return; }
      current = res.member;
      drawMember(current);
    });
  }

  // ── plans / benefits matrix ─────────────────────────────────
  function renderPlans() {
    el('ms-body').innerHTML =
      '<article class="g-card"><p class="g-card__label">What each plan promises</p>'
      + '<p class="g-text-muted">This is the benefits matrix, not member access. Editing it changes what new '
      + 'members are offered and what <b>Apply plan benefits</b> will write. It does not add or remove anything '
      + 'from anyone who already has a plan.</p></article>'
      + plans.map(planCard).join('')
      + '<p class="g-admin-status" id="ms-plan-status"></p>';

    plans.forEach((plan) => {
      on('ms-save-' + plan.key, 'click', async () => {
        let benefits;
        try { benefits = JSON.parse(val('ms-benefits-' + plan.key) || '[]'); } catch (_) {
          status('ms-plan-status', plan.label + ': benefits must be valid JSON.', 'err'); return;
        }
        status('ms-plan-status', 'Saving ' + plan.label + '…');
        const res = await api('POST', '/api/admin/membership/policy', {
          key: plan.key,
          plan: {
            label: val('ms-label-' + plan.key),
            subtitle: val('ms-subtitle-' + plan.key),
            description: val('ms-desc-' + plan.key),
            prices: { monthly: val('ms-monthly-' + plan.key), annual: val('ms-annual-' + plan.key) },
            checkoutUrl: val('ms-checkout-' + plan.key),
            benefits,
          },
        });
        if (!res.ok) { status('ms-plan-status', 'Refused: ' + esc(res.reason || 'unknown'), 'err'); return; }
        status('ms-plan-status', plan.label + ' saved. No member access changed.', 'ok');
        await loadPlans();
      });
    });
  }

  function planCard(plan) {
    const field = (id, label, value, placeholder) =>
      '<div class="g-field"><label class="g-label" for="' + id + '">' + label + '</label>'
      + '<input class="g-input" id="' + id + '" value="' + esc(value || '') + '" placeholder="' + esc(placeholder || '') + '" /></div>';
    return '<article class="g-card"><p class="g-card__label">' + esc(plan.label) + '</p>'
      + field('ms-label-' + plan.key, 'Name', plan.label)
      + field('ms-subtitle-' + plan.key, 'Subtitle', plan.subtitle)
      + field('ms-desc-' + plan.key, 'Description', plan.description)
      + field('ms-monthly-' + plan.key, 'Monthly price (display)', plan.prices && plan.prices.monthly, '$497/mo')
      + field('ms-annual-' + plan.key, 'Annual price (display)', plan.prices && plan.prices.annual, '$4,997/yr')
      + field('ms-checkout-' + plan.key, 'Checkout URL', plan.checkoutUrl)
      + '<div class="g-field"><label class="g-label" for="ms-benefits-' + plan.key + '">Benefits promised</label>'
      + '<textarea class="g-textarea" id="ms-benefits-' + plan.key + '" rows="6">'
      + esc(JSON.stringify(plan.benefits || [], null, 1)) + '</textarea></div>'
      + '<div class="g-card__actions"><button class="g-btn g-btn--secondary g-btn--sm" id="ms-save-' + plan.key + '">'
      + 'Save ' + esc(plan.label) + '</button></div></article>';
  }

  // ── audit ───────────────────────────────────────────────────
  async function renderAudit() {
    el('ms-body').innerHTML = '<p class="g-empty">Loading history…</p>';
    const res = await api('GET', '/api/admin/membership/audit');
    if (!res || !res.ok) { el('ms-body').innerHTML = '<p class="g-empty">Could not load the audit log.</p>'; return; }
    el('ms-body').innerHTML = '<article class="g-card"><p class="g-card__label">Every membership change</p>'
      + (res.entries.length
        ? res.entries.map((e) => '<div class="g-admin-item"><div><b>' + esc(e.action) + '</b> · '
          + esc(e.contactId) + '<br><span class="g-text-muted">'
          + esc(e.at.replace('T', ' ').slice(0, 16)) + ' · ' + esc(e.actor)
          + (e.note ? ' · ' + esc(e.note) : '') + '</span></div></div>').join('')
        : '<p class="g-empty">Nothing recorded yet.</p>')
      + '</article>';
  }

  async function loadPlans() {
    const res = await api('GET', '/api/admin/membership/policy');
    if (res && res.ok) plans = res.plans || [];
  }

  // ── boot ────────────────────────────────────────────────────
  async function load() {
    if (loaded) return;
    loaded = true;
    panel.innerHTML = '<p class="g-empty">Loading membership…</p>';
    const [schemaRes] = await Promise.all([api('GET', '/api/admin/membership/schema'), loadPlans()]);
    if (!schemaRes || !schemaRes.ok) {
      loaded = false;
      panel.innerHTML = '<div class="g-note g-note--warn">Membership admin is unavailable. '
        + 'Check that the proxy is running the current build.</div>';
      return;
    }
    schema = schemaRes;
    render();
  }

  window.GaiaMembershipAdmin = { load };
}());
