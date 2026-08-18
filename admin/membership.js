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
      '<div class="g-tabs g-tabs--6" role="tablist" aria-label="Membership sections">'
      + ['members', 'plans', 'products', 'commerce', 'sources', 'audit'].map((key) => '<button type="button" class="g-tab'
        + (view === key ? ' is-active' : '') + '" data-ms-view="' + key + '" role="tab" aria-selected="'
        + (view === key) + '">' + ({ plans: 'Plans &amp; Benefits', sources: 'Integrations', products: 'Products', commerce: 'Commerce' }[key]
        || key[0].toUpperCase() + key.slice(1)) + '</button>').join('')
      + '</div><div id="ms-body"></div>';
    panel.querySelectorAll('[data-ms-view]').forEach((tab) => tab.addEventListener('click', () => {
      view = tab.dataset.msView; render();
    }));
    if (view === 'members') renderMembers();
    else if (view === 'plans') renderPlans();
    else if (view === 'products') renderProducts();
    else if (view === 'commerce') renderCommerce();
    else if (view === 'sources') renderSources();
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
      + 'use <b>Apply plan benefits</b> below to write the actual entitlements.</p>'
      + (membership ? overrideBlock(membership) : '');
  }

  /**
   * A protected decision. Without this, the first reconciliation sweep would
   * quietly undo a comp or a correction and nobody would know why.
   */
  function overrideBlock(membership) {
    const until = membership.override_until;
    const standing = until && new Date(until) > new Date();
    return '<hr style="border:none;border-top:1px solid rgba(255,255,255,.08);margin:14px 0" />'
      + '<p class="g-label">Protect from automatic changes</p>'
      + (standing
        ? '<p><b>Protected until ' + esc(dateOnly(until)) + '</b>'
          + (membership.override_reason ? ' — ' + esc(membership.override_reason) : '')
          + '<br><span class="g-text-muted">No external system can change this membership until then.</span></p>'
        : '<p class="g-text-muted">Not protected. A future billing sync could change this membership.</p>')
      + '<div class="g-field"><label class="g-label" for="ms-ov-until">Protect until</label>'
      + '<input class="g-input" id="ms-ov-until" type="date" /></div>'
      + '<div class="g-field"><label class="g-label" for="ms-ov-reason">Reason</label>'
      + '<input class="g-input" id="ms-ov-reason" placeholder="Comped for the retreat" /></div>'
      + '<p class="g-admin-status" id="ms-ov-status"></p>'
      + '<div class="g-card__actions"><button class="g-btn g-btn--secondary g-btn--sm" id="ms-ov-set">Protect</button>'
      + (standing ? '<button class="g-btn g-btn--ghost g-btn--sm" id="ms-ov-clear">Remove protection</button>' : '')
      + '</div>';
  }

  function bindAssign(contactId) {
    const saveOverride = async (until) => {
      status('ms-ov-status', 'Saving…');
      const res = await api('POST', '/api/admin/membership/override', {
        contactId, resource: 'membership', until, reason: val('ms-ov-reason'),
      });
      if (!res.ok) { status('ms-ov-status', 'Refused: ' + esc(res.reason || 'unknown'), 'err'); return; }
      current = res.member;
      drawMember(current);
    };
    on('ms-ov-set', 'click', () => {
      const date = val('ms-ov-until');
      if (!date) { status('ms-ov-status', 'Choose the date the protection should end.', 'err'); return; }
      saveOverride(new Date(date + 'T23:59:59Z').toISOString());
    });
    on('ms-ov-clear', 'click', () => saveOverride(null));
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




  // ── canonical commerce model ─────────────────────────────────
  async function renderCommerce() {
    const body = el('ms-body');
    body.innerHTML = '<p class="g-empty">Loading the commerce model…</p>';
    const [model, cands, sim] = await Promise.all([
      api('GET', '/api/admin/commerce/model'),
      api('GET', '/api/admin/commerce/candidates'),
      api('POST', '/api/admin/commerce/simulate', { standard: true }),
    ]);
    if (!model || !model.ok) { body.innerHTML = '<p class="g-empty">Could not load the commerce model.</p>'; return; }

    body.innerHTML =
      '<article class="g-card"><p class="g-card__label">What Gaia sells</p>'
      + '<p class="g-text-muted">Two decisions live here and they are deliberately separate. '
      + '<b>Mapping</b> says which external product this is — that happens in the Products tab. '
      + '<b>Policy</b> says what buying it grants. A product can be perfectly identified while what it '
      + 'grants is still an open question, and in that state it grants nothing at all.</p></article>'
      + decisionsCard(model.decisions || [])
      + coverageCard(cands)
      + simulatorCard((sim && sim.scenarios) || [])
      + productsCard(model.products || []);

    (model.decisions || []).forEach((d, i) => {
      ['approved', 'none'].forEach((state) => {
        on('ms-dec-' + i + '-' + state, 'click', async () => {
          status('ms-dec-status', 'Saving…');
          const r = await api('POST', '/api/admin/commerce/policy',
            { product: d.product, entitlementType: d.entitlementType, policy: state });
          if (!r.ok) { status('ms-dec-status', 'Refused: ' + esc(r.reason || 'unknown'), 'err'); return; }
          renderCommerce();
        });
      });
    });
  }

  function decisionsCard(decisions) {
    return '<article class="g-card"><p class="g-card__label">Waiting on a business decision</p>'
      + (decisions.length
        ? '<p class="g-text-muted">Each of these is a product we have identified precisely and whose '
          + 'access rule nobody has decided yet. Until you decide, it grants nothing.</p>'
          + decisions.map((d, i) => '<div class="g-admin-item" style="display:block">'
            + '<div><b>' + esc(d.label) + '</b> <span class="g-tag">' + esc(d.type) + '</span><br>'
            + '<span class="g-text-muted">would propose <b>' + esc(d.entitlementType) + ':' + esc(d.key) + '</b>'
            + ' · ' + esc(durationText(d.duration)) + '</span>'
            + (d.note ? '<br><span class="g-text-muted">' + esc(d.note) + '</span>' : '')
            + (d.destination ? '<br><span class="g-text-muted">meanwhile sends the member to ' + esc(d.destination) + '</span>' : '')
            + '</div>'
            + '<div class="g-card__actions">'
            + '<button class="g-btn g-btn--primary g-btn--sm" id="ms-dec-' + i + '-approved">Approve this effect</button>'
            + '<button class="g-btn g-btn--ghost g-btn--sm" id="ms-dec-' + i + '-none">Grants nothing</button>'
            + '</div></div>').join('')
        : '<p class="g-empty">Nothing pending. Every identified product has a decided policy.</p>')
      + '<p class="g-admin-status" id="ms-dec-status"></p></article>';
  }

  function durationText(d) {
    if (!d) return 'no duration';
    if (d.kind === 'term') return d.months + ' months from ' + d.from;
    if (d.kind === 'event') return 'lasts for the event';
    if (d.kind === 'billing') return 'while the billing period lasts';
    if (d.kind === 'period') return 'per ' + d.period;
    if (d.kind === 'explicit') return 'explicit dates';
    return 'perpetual';
  }

  function coverageCard(cands) {
    if (!cands || !cands.ok) return '';
    const c = cands.coverage || {};
    const pct = c.totalOrders ? Math.round(100 * c.ordersWithCandidate / c.totalOrders) : 0;
    return '<article class="g-card"><p class="g-card__label">Suggested mappings</p>'
      + '<p class="g-text-muted">Generated from evidence — a SKU first, then an exact price, and a title '
      + 'last and lowest. Nothing here is applied; every suggestion waits for a person.</p>'
      + '<p>' + (c.withCandidate || 0) + ' of ' + (c.products || 0) + ' products have a suggestion, '
      + 'covering ' + pct + '% of everything ever sold.</p>'
      + '<div class="g-tagrow">'
      + ['high', 'medium', 'low'].map((k) => '<span class="g-tag">' + k + ': '
        + ((c.byConfidence && c.byConfidence[k] && c.byConfidence[k].products) || 0) + '</span>').join('')
      + '</div></article>';
  }

  function simulatorCard(scenarios) {
    if (!scenarios.length) return '';
    const badge = { proposal: 'good', no_entitlement: '', policy_decision_required: 'warn',
      unresolved_product: 'warn', unresolved_identity: 'crit', non_product: '' };
    return '<article class="g-card"><p class="g-card__label">If these purchases arrived right now</p>'
      + '<p class="g-text-muted">A dry run. It reads the ledger to work out who someone is and has no way '
      + 'to write to it.</p>'
      + scenarios.map((s) => '<div class="g-admin-item"><div><b>' + esc(s.label) + '</b> '
        + '<span class="g-tag">' + esc(String(s.outcome).replace(/_/g, ' ')) + '</span><br>'
        + '<span class="g-text-muted">'
        + (s.proposals.length
          ? 'would propose ' + esc(s.proposals.map((p) => p.type + ':' + p.key).join(', '))
          : 'proposes nothing')
        + (s.pending.length ? ' · ' + s.pending.length + ' awaiting a decision' : '')
        + (s.destination ? ' · sends to ' + esc(String(s.destination).replace(/^https?:\/\//, '')) : '')
        + '</span></div></div>').join('')
      + '</article>';
  }

  function productsCard(products) {
    const byType = {};
    for (const p of products) (byType[p.type] = byType[p.type] || []).push(p);
    return '<article class="g-card"><p class="g-card__label">Canonical products</p>'
      + Object.keys(byType).sort().map((type) => '<p class="g-label">' + esc(type)
        + ' (' + byType[type].length + ')</p>'
        + byType[type].map((p) => '<div class="g-admin-item"><div><b>' + esc(p.label) + '</b> '
          + '<span class="g-text-muted">' + esc(p.key) + '</span><br><span class="g-text-muted">'
          + (p.components && p.components.length
            ? 'contains ' + esc(p.components.map((c) => c.productKey).join(', '))
            : (p.effects || []).length
              ? (p.effects || []).map((e) => e.entitlementType + ':' + e.key + ' [' + e.policy + ']').join(', ')
              : 'grants nothing')
          + '</span></div></div>').join('')).join('')
      + '</article>';
  }

  // ── canonical product registry ───────────────────────────────
  let registry = { canonical: [], implications: {} };

  async function renderProducts() {
    const body = el('ms-body');
    body.innerHTML = '<p class="g-empty">Loading products…</p>';
    const [res, store] = await Promise.all([
      api('GET', '/api/admin/membership/products'),
      api('GET', '/api/admin/store/catalog'),
    ]);
    if (!res || !res.ok) { body.innerHTML = '<p class="g-empty">Could not load the product registry.</p>'; return; }
    registry = res;
    const h = res.health || {};

    body.innerHTML = storeCard(store) +
      '<article class="g-card"><p class="g-card__label">What each product means</p>'
      + '<p class="g-text-muted">One device can be sold under many product ids across Shopify and GHL. '
      + 'Mapping them to a single Gaia product is what lets a purchase become access. '
      + '<b>Nothing here grants anything on its own</b> — an unmapped product is silent, and so is one still '
      + 'waiting on a decision.</p>'
      + '<div class="g-tagrow">'
      + '<span class="g-tag">' + (h.mapped || 0) + ' mapped</span>'
      + '<span class="g-tag">' + (h.unmapped || 0) + ' unmapped</span>'
      + '<span class="g-tag">' + (h.ordersCovered || 0) + ' orders covered</span>'
      + '<span class="g-tag">' + (h.ordersUncovered || 0) + ' orders not yet covered</span>'
      + '</div><p class="g-admin-status" id="ms-prod-status"></p></article>'
      + clusterCard(h.clusters || [])
      + '<article class="g-card"><p class="g-card__label">Needs a decision — biggest sellers first</p>'
      + ((res.products || []).filter((p) => !p.canonical).length
        ? (res.products || []).filter((p) => !p.canonical).slice(0, 40).map(productRow).join('')
        : '<p class="g-empty">Everything observed has been classified.</p>')
      + '</article>'
      + '<article class="g-card"><p class="g-card__label">Already mapped</p>'
      + ((res.products || []).filter((p) => p.canonical).length
        ? (res.products || []).filter((p) => p.canonical).slice(0, 60).map(productRow).join('')
        : '<p class="g-empty">Nothing mapped yet.</p>')
      + '</article>';

    on('ms-store-sync', 'click', async () => {
      status('ms-store-status', 'Reading the Shopify storefront…');
      const r = await api('POST', '/api/admin/store/sync');
      if (!r.ok) {
        status('ms-store-status', r.reason === 'empty_response'
          ? 'Shopify returned nothing. The store is unchanged — nothing was removed.'
          : 'Could not reach Shopify. The store is unchanged.', 'err');
        return;
      }
      renderProducts();
    });

    (res.products || []).slice(0, 100).forEach((p) => {
      on('ms-map-' + rowId(p), 'click', async () => {
        const select = el('ms-canon-' + rowId(p));
        status('ms-prod-status', 'Saving ' + p.title + '…');
        const r = await api('POST', '/api/admin/membership/products/map', {
          system: p.system, externalId: p.externalId,
          canonical: select && select.value ? select.value : null,
          confidence: 'confirmed',
        });
        if (!r.ok) { status('ms-prod-status', 'Refused: ' + esc(r.reason || 'unknown'), 'err'); return; }
        renderProducts();
      });
    });
  }

  /** What the daily sync last saw, and what it changed. */
  function storeCard(store) {
    if (!store || !store.ok) {
      return '<article class="g-card"><p class="g-card__label">Gaia store</p>'
        + '<p class="g-empty">The store catalogue is not available.</p></article>';
    }
    const d = store.lastDiff || {};
    const c = store.counts || {};
    const changes = []
      .concat((d.added || []).map((x) => 'New: ' + x.title))
      .concat((d.priceChanged || []).map((x) => 'Price changed: ' + x.title))
      .concat((d.returned || []).map((x) => 'Listed again: ' + x.title))
      .concat((d.unobserved || []).map((x) => 'No longer on Shopify: ' + x.title));

    return '<article class="g-card"><p class="g-card__label">Gaia store</p>'
      + '<p class="g-text-muted">Gaia keeps its own copy of the Shopify shelf so the store works even when '
      + 'Shopify is slow, and can be grouped Gaia\'s way. <b>Shopify still takes every payment</b> — '
      + 'buying always opens the real product page.</p>'
      + '<p class="g-text-muted"><b>Display shelf</b> is where a card appears in the store — a title may decide it. '
      + '<b>Canonical mapping</b> is what a purchase will eventually mean — only a person decides that. '
      + 'They are not the same thing and a sync never changes the second.</p>'
      + '<p>' + (c.total || 0) + ' products · ' + (c.unmapped || 0) + ' not yet classified'
      + ((c.unobserved || 0) ? ' · ' + c.unobserved + ' no longer listed on Shopify' : '') + '</p>'
      + '<p class="g-text-muted">Last synced ' + esc(store.syncedAt ? store.syncedAt.replace('T', ' ').slice(0, 16) : 'never')
      + '. Syncs itself once a day.</p>'
      + (changes.length
        ? '<p class="g-label">Last sync changed</p>'
          + changes.slice(0, 10).map((line) => '<div class="g-admin-item"><div><span class="g-text-muted">'
            + esc(line) + '</span></div></div>').join('')
        : '<p class="g-text-muted">Nothing changed on the last sync.</p>')
      + '<p class="g-admin-status" id="ms-store-status"></p>'
      + '<div class="g-card__actions"><button class="g-btn g-btn--secondary g-btn--sm" id="ms-store-sync">Sync now</button></div>'
      + '</article>';
  }

  const rowId = (p) => (p.system + '-' + p.externalId).replace(/[^a-zA-Z0-9-]/g, '');

  function productRow(p) {
    const options = '<option value="">— not mapped —</option>'
      + (registry.canonical || []).map((c) => '<option value="' + esc(c.key) + '"'
        + (c.key === p.canonical ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('');
    const implied = p.canonical ? (registry.implications[p.canonical] || []) : [];
    return '<div class="g-admin-item" style="display:block">'
      + '<div><b>' + esc(p.title || '(untitled)') + '</b> <span class="g-tag">' + esc(p.system) + '</span>'
      + '<br><span class="g-text-muted">' + esc(p.externalId)
      + (p.orders ? ' · ' + p.orders + ' orders · ' + p.customers + ' customers' : ' · never ordered')
      + (p.domain ? ' · ' + esc(p.domain) : '') + '</span></div>'
      + '<div class="g-field" style="margin-top:8px"><select class="g-input" id="ms-canon-' + rowId(p) + '">'
      + options + '</select></div>'
      + (implied.length
        ? '<p class="g-text-muted">Would propose: '
          + implied.map((i) => esc(i.type) + ':' + esc(i.key)
            + (i.state === 'verified' ? '' : ' <b>(' + esc(i.state.replace("_", " ")) + ')</b>')).join(', ')
          + '</p>'
        : '')
      + '<div class="g-card__actions"><button class="g-btn g-btn--secondary g-btn--sm" id="ms-map-' + rowId(p) + '">Save</button></div>'
      + '</div>';
  }

  function clusterCard(clusters) {
    if (!clusters.length) return '';
    return '<article class="g-card"><p class="g-card__label">One product, many ids</p>'
      + '<p class="g-text-muted">These external products all mean the same thing to Gaia. '
      + 'That is the point of the registry.</p>'
      + clusters.map((c) => '<div class="g-admin-item"><div><b>' + esc(c.canonical) + '</b><br>'
        + '<span class="g-text-muted">' + c.external.length + ' ids — ' + esc(c.external.slice(0, 6).join(", "))
        + (c.external.length > 6 ? ' …' : '') + '</span></div></div>').join('')
      + '</article>';
  }

  // ── integrations ────────────────────────────────────────────
  const STATE_COPY = {
    disabled: 'Not connected. Nothing from this system reaches Gaia.',
    shadow: 'Watching only. Gaia records what it would change and changes nothing.',
    active: 'Live. Changes from this system are applied to member access.',
  };

  async function renderSources() {
    const body = el('ms-body');
    body.innerHTML = '<p class="g-empty">Loading integrations…</p>';
    const [res, unresolved, proposals] = await Promise.all([
      api('GET', '/api/admin/membership/sources'),
      api('GET', '/api/admin/membership/unresolved'),
      api('GET', '/api/admin/membership/proposals?state=shadow'),
    ]);
    if (!res || !res.ok) { body.innerHTML = '<p class="g-empty">Could not load integrations.</p>'; return; }

    body.innerHTML =
      '<article class="g-card"><p class="g-card__label">Where member access can come from</p>'
      + '<p class="g-text-muted">Every source — including this admin panel — writes through the same pipeline. '
      + 'A source in <b>watching</b> runs the whole thing and stops before the ledger, so you can see exactly what it '
      + 'would do before letting it do anything.</p></article>'
      + res.sources.map(sourceCard).join('')
      + shadowCard(proposals && proposals.proposals || [])
      + unresolvedCard(unresolved && unresolved.unresolved || [])
      + billingCard(res)
      + '<p class="g-admin-status" id="ms-source-status"></p>';

    res.sources.forEach((source) => {
      ['disabled', 'shadow', 'active'].forEach((state) => {
        on('ms-src-' + source.key + '-' + state, 'click', async () => {
          status('ms-source-status', 'Updating ' + source.label + '…');
          const r = await api('POST', '/api/admin/membership/sources/state', { key: source.key, state });
          if (!r.ok) {
            status('ms-source-status', r.reason === 'activation_requires_server_flag'
              ? 'Going live is not a web-form decision. It is enabled on the server once the adapter is reviewed.'
              : 'Refused: ' + esc(r.reason || 'unknown'), 'err');
            return;
          }
          renderSources();
        });
      });
    });
  }

  function sourceCard(source) {
    const c = source.counters || {};
    const dot = { disabled: '', shadow: 'watching', active: 'live' }[source.state];
    return '<article class="g-card"><p class="g-card__label">' + esc(source.label)
      + ' <span class="g-tag">' + esc(source.mode === 'snapshot' ? 'reconciles' : 'receives events') + '</span>'
      + (dot ? ' <span class="g-tag">' + dot + '</span>' : '') + '</p>'
      + '<p class="g-text-muted">' + esc(source.description || '') + '</p>'
      + '<p><b>' + esc(STATE_COPY[source.state] || source.state) + '</b></p>'
      + '<p class="g-text-muted">'
      + (source.lastObservedAt ? 'Last event ' + esc(source.lastObservedAt.replace('T', ' ').slice(0, 16)) : 'No events yet')
      + ' · applied ' + (c.applied || 0) + ' · watched ' + (c.shadow || 0)
      + ' · rejected ' + (c.rejected || 0) + ' · unresolved ' + (c.unresolved || 0)
      + ' · low confidence ' + (c.lowConfidence || 0) + '</p>'
      + (source.locked
        ? '<p class="g-text-muted">Always on — this is how the system is operated.</p>'
        : '<div class="g-card__actions">'
          + ['disabled', 'shadow', 'active'].map((state) => '<button class="g-btn g-btn--'
            + (source.state === state ? 'secondary' : 'ghost') + ' g-btn--sm" id="ms-src-'
            + source.key + '-' + state + '"' + (source.state === state ? ' disabled' : '') + '>'
            + ({ disabled: 'Disconnect', shadow: 'Watch only', active: 'Go live' }[state]) + '</button>').join('')
          + '</div>')
      + '</article>';
  }

  function shadowCard(proposals) {
    return '<article class="g-card"><p class="g-card__label">What watching sources would change</p>'
      + (proposals.length
        ? '<p class="g-text-muted">Nothing below has been applied.</p>'
          + proposals.slice(0, 40).map((p) => '<div class="g-admin-item"><div><b>' + esc(p.contactId || '—')
            + '</b> <span class="g-text-muted">' + esc(p.source) + ' · ' + esc(p.resource) + '</span><br>'
            + '<span class="g-text-muted">' + esc(describeDiff(p.diff)) + '</span></div></div>').join('')
        : '<p class="g-empty">Nothing pending. No source is watching yet.</p>')
      + '</article>';
  }

  function describeDiff(diff) {
    if (!diff) return 'no change computed';
    if (!diff.changed) return 'no change — Gaia already agrees';
    if (diff.kind === 'membership') {
      return 'would set membership ' + (diff.to ? (diff.to.key + ' / ' + diff.to.status) : 'none')
        + (diff.from ? ' (currently ' + diff.from.key + ' / ' + diff.from.status + ')' : ' (currently none)');
    }
    return 'would ' + (diff.to && diff.to.status === 'revoked' ? 'revoke ' : 'grant ') + esc(diff.identity || '');
  }

  function unresolvedCard(list) {
    return '<article class="g-card"><p class="g-card__label">Waiting to be identified</p>'
      + (list.length
        ? '<p class="g-text-muted">These arrived for someone Gaia could not identify with certainty. '
          + 'They are kept whole, so linking the person replays them.</p>'
          + list.slice(0, 25).map((u) => '<div class="g-admin-item"><div><b>' + esc(u.reason)
            + '</b> <span class="g-text-muted">' + esc(u.source) + '</span><br><span class="g-text-muted">'
            + esc(JSON.stringify(u.claim)) + (u.candidates && u.candidates.length
              ? ' · candidates: ' + esc(u.candidates.join(', ')) : '') + '</span></div></div>').join('')
        : '<p class="g-empty">Nothing waiting.</p>')
      + '</article>';
  }

  function billingCard(res) {
    return '<article class="g-card"><p class="g-card__label">Billing identity map</p>'
      + '<p class="g-text-muted">Which product and price ids mean which plan. <b>Read-only here on purpose:</b> '
      + 'whoever can edit this decides who gets Diamond, so it lives in reviewed, version-controlled code and is '
      + 'shown here for confidence. Gaia never maps by price amount or product name — Next Level bills the same '
      + '$97/month as Silver.</p>'
      + (res.billingMap || []).map((m) => '<div class="g-admin-item"><div><b>' + esc(m.key) + '</b><br>'
        + '<span class="g-text-muted">product ' + esc(m.ghlProductId) + '<br>monthly ' + esc(m.monthlyPriceId)
        + '<br>annual ' + esc(m.annualPriceId) + '</span></div></div>').join('')
      + ((res.quarantinedBillingIds || []).length
        ? '<p class="g-text-muted">Quarantined, never granted: ' + esc(res.quarantinedBillingIds.join(', ')) + '</p>'
        : '')
      + '</article>';
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
