/* Gaia Healers membership UI — renders the /api/member/access v2 read model.
 *
 * The one rule this file exists to enforce: the app RENDERS access, it never
 * decides it. There is no tier regex here, no benefit list, no lead count, no
 * directory level and no price. Every number and label a member sees comes from
 * `membership` or from an entitlement's own `value`.
 *
 * If Gold changes from 5 leads to 8, nothing in this file changes.
 */
(function () {
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  const DAY = 24 * 60 * 60 * 1000;

  function formatDate(value) {
    const time = Date.parse(value || '');
    if (!Number.isFinite(time)) return '';
    return new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  const daysUntil = (value) => {
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? Math.ceil((time - Date.now()) / DAY) : null;
  };

  const activeOf = (entitlements, type) => (entitlements || [])
    .filter((item) => item.type === type && item.status === 'active');
  const allOf = (entitlements, type) => (entitlements || []).filter((item) => item.type === type);

  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

  /* ── status vocabulary ──────────────────────────────────────────────────
   * Status is always written out as words. Colour alone never carries it.   */
  const MEMBERSHIP_STATUS_TEXT = {
    active: 'Active', trialing: 'Trial', past_due: 'Payment due',
    cancelled: 'Cancelled', expired: 'Expired', none: 'No membership',
  };
  const ENTITLEMENT_STATUS_TEXT = {
    active: 'Active', expired: 'Expired', revoked: 'Removed', pending: 'Pending',
  };
  const statusTone = (status) => ({
    active: 'on', trialing: 'on', past_due: 'warn',
    cancelled: 'off', expired: 'off', revoked: 'off', pending: 'warn', none: 'off',
  }[status] || 'off');

  const CYCLE_TEXT = { monthly: 'Monthly membership', annual: 'Annual membership', none: '' };

  /* ── renderer registry ──────────────────────────────────────────────────
   * One entry per known entitlement type. `summary` produces the value shown
   * on the My Access row; `detail` produces the expanded panel. Both read only
   * from the entitlement records they are handed.
   *
   * A type with no entry here is unknown to this build and is rendered by
   * `genericRenderer` — never interpreted.                                  */
  const TITLES = {
    course_access: 'Courses', community_access: 'Community', crm_access: 'Practice / CRM',
    directory_level: 'Directory', lead_allocation: 'Monthly Leads', discount: 'Discounts',
    device_owner: 'Devices', device_software: 'Software', event_ticket: 'Events',
    promo_membership: 'Promotions',
  };
  const ORDER = {
    course_access: 2, community_access: 3, crm_access: 4, directory_level: 5,
    lead_allocation: 6, discount: 7, device_owner: 8, device_software: 9,
    event_ticket: 10, promo_membership: 11,
  };

  const RENDERERS = {
    course_access: {
      summary: (items) => plural(activeCount(items), 'available'),
      detail: (items) => list(items.map((item) => row(
        item.value?.name || item.key,
        ENTITLEMENT_STATUS_TEXT[item.status] || item.status,
        item.status,
        item.expires_at ? `Until ${formatDate(item.expires_at)}` : 'Lifetime access',
      ))),
    },
    community_access: {
      summary: (items) => (activeCount(items) ? 'Active' : 'None'),
      detail: (items) => list(items.map((item) => row(
        item.value?.name || item.key,
        ENTITLEMENT_STATUS_TEXT[item.status] || item.status,
        item.status,
      ))),
    },
    crm_access: {
      summary: (items) => titleise(firstActiveKey(items)),
      detail: (items) => list(items.map((item) => row(
        titleise(item.value?.level || item.key), ENTITLEMENT_STATUS_TEXT[item.status], item.status,
      ))),
    },
    directory_level: {
      summary: (items) => {
        const key = firstActiveKey(items);
        return key ? `Level ${key}` : 'Not listed';
      },
      detail: (items) => list(items.map((item) => row(
        `Level ${item.value?.level ?? item.key}`, ENTITLEMENT_STATUS_TEXT[item.status], item.status,
      ))),
    },
    lead_allocation: {
      summary: (items) => {
        const item = activeOf(items, 'lead_allocation')[0];
        if (!item) return 'None';
        const monthly = Number(item.value?.monthly);
        const delivered = Number(item.value?.delivered);
        if (!Number.isFinite(monthly)) return 'None';
        return `${Number.isFinite(delivered) ? delivered : 0} of ${monthly} used`;
      },
      detail: (items) => items.map((item) => {
        const monthly = Number(item.value?.monthly) || 0;
        const delivered = Number(item.value?.delivered) || 0;
        const pct = monthly > 0 ? Math.min(100, Math.round((delivered / monthly) * 100)) : 0;
        const label = `${delivered} delivered of ${monthly} included`;
        return '<div class="g-ma-meter">'
          + (item.value?.period ? '<p class="g-ma-meter__period">' + esc(item.value.period) + '</p>' : '')
          + '<div class="g-ma-meter__track" role="img" aria-label="' + esc(label) + '">'
          + '<div class="g-ma-meter__fill" style="width:' + pct + '%"></div></div>'
          + '<p class="g-ma-meter__label">' + esc(label) + '</p>'
          + (item.status !== 'active'
            ? '<p class="g-ma-note">' + esc(ENTITLEMENT_STATUS_TEXT[item.status] || item.status) + '</p>' : '')
          + '</div>';
      }).join(''),
    },
    discount: {
      summary: (items) => {
        const item = activeOf(items, 'discount')[0];
        if (!item) return 'None';
        const percent = item.value?.percent;
        const scope = item.value?.scope || item.key;
        return percent != null ? `${percent}% ${scope}` : String(scope);
      },
      detail: (items) => list(items.map((item) => row(
        `${item.value?.percent != null ? item.value.percent + '% ' : ''}${item.value?.scope || item.key}`,
        ENTITLEMENT_STATUS_TEXT[item.status], item.status,
        item.expires_at ? `Until ${formatDate(item.expires_at)}` : '',
      ))),
    },
    device_owner: {
      summary: (items) => plural(activeCount(items), 'owned'),
      detail: (items) => list(items.map((item) => {
        const name = item.value?.name || item.key;
        // Serial numbers are enrichment from the member record; the ledger
        // decides WHICH devices exist, this only adds detail to them.
        const serial = (ENRICHMENT.serials || {})[String(name).toLowerCase()];
        return row(name, ENTITLEMENT_STATUS_TEXT[item.status], item.status,
          serial ? `Owned · SN ${serial}` : 'Owned');
      })),
    },
    device_software: {
      summary: (items) => plural(activeCount(items), 'active'),
      detail: (items) => list(items.map((item) => {
        const days = daysUntil(item.expires_at);
        const expiring = item.status === 'active' && days !== null && days <= 30;
        const meta = item.expires_at
          ? (item.status === 'expired' ? `Expired ${formatDate(item.expires_at)}` : `Active until ${formatDate(item.expires_at)}`)
          : '';
        return row(
          item.value?.name || item.key,
          ENTITLEMENT_STATUS_TEXT[item.status], item.status, meta,
          expiring ? `Expires in ${days} day${days === 1 ? '' : 's'}` : '',
        );
      })),
    },
    event_ticket: {
      summary: (items) => plural(activeCount(items), 'ticket'),
      detail: (items) => list(items.map((item) => row(
        item.value?.name || item.key, ENTITLEMENT_STATUS_TEXT[item.status], item.status,
      ))),
    },
    promo_membership: {
      summary: (items) => plural(activeCount(items), 'promotion'),
      detail: (items) => list(items.map((item) => row(
        item.value?.name || item.key, ENTITLEMENT_STATUS_TEXT[item.status], item.status,
        item.expires_at ? `Until ${formatDate(item.expires_at)}` : '',
      ))),
    },
  };

  /* An entitlement type this build does not know. Shown as an inert row so the
   * member is not silently missing something, but no meaning is invented. */
  const genericRenderer = {
    summary: (items) => plural(activeCount(items), 'item'),
    detail: (items) => list(items.map((item) => row(item.key, ENTITLEMENT_STATUS_TEXT[item.status], item.status))),
  };

  const activeCount = (items) => (items || []).filter((item) => item.status === 'active').length;
  const firstActiveKey = (items) => {
    const item = (items || []).find((entry) => entry.status === 'active');
    return item ? (item.value?.level || item.key) : '';
  };
  const titleise = (value) => {
    const text = String(value || '');
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'None';
  };

  const row = (label, statusText, status, meta, flag) =>
    '<li class="g-ma-item g-ma-item--' + esc(statusTone(status)) + '">'
    + '<span class="g-ma-item__name">' + esc(label) + '</span>'
    + '<span class="g-ma-item__status">' + esc(statusText || '') + '</span>'
    + (meta ? '<span class="g-ma-item__meta">' + esc(meta) + '</span>' : '')
    + (flag ? '<span class="g-ma-item__flag">' + esc(flag) + '</span>' : '')
    + '</li>';
  const list = (rows) => '<ul class="g-ma-list">' + rows.join('') + '</ul>';

  /* ── Member Pass ────────────────────────────────────────────────────────
   * Renders `membership` and nothing else. `key` is used for a presentation
   * modifier class only; it never decides what appears.                     */
  function memberPass(access) {
    const membership = access?.membership || null;
    const status = membership?.status || 'none';

    if (!membership || !membership.key || status === 'none') {
      return '<article class="g-pass g-pass--none">'
        + '<p class="g-pass__kicker">Member Pass</p>'
        + '<p class="g-pass__title">No membership detected</p>'
        + '<p class="g-pass__meta">We could not find an active Gaia Healers membership on your account.</p>'
        + '<div class="g-pass__actions"><a class="g-btn g-btn--primary g-btn--sm" href="home.html?view=store&tab=membership">View plans</a></div>'
        + '</article>';
    }

    const dateLine = status === 'cancelled' || status === 'expired'
      ? (membership.ends_at ? 'Ends ' + formatDate(membership.ends_at) : '')
      : (membership.renews_at ? 'Renews ' + formatDate(membership.renews_at) : '');

    return '<article class="g-pass g-pass--' + esc(membership.key) + '">'
      + '<p class="g-pass__kicker">Member Pass</p>'
      + '<h2 class="g-pass__title">' + esc(membership.label || membership.key) + '</h2>'
      + (membership.subtitle ? '<p class="g-pass__subtitle">' + esc(membership.subtitle) + '</p>' : '')
      + '<p class="g-pass__status"><span class="g-badge g-badge--' + esc(statusTone(status)) + '">'
      + esc(MEMBERSHIP_STATUS_TEXT[status] || status) + '</span></p>'
      + (CYCLE_TEXT[membership.billing_cycle] ? '<p class="g-pass__meta">' + esc(CYCLE_TEXT[membership.billing_cycle]) + '</p>' : '')
      + (dateLine ? '<p class="g-pass__meta">' + esc(dateLine) + '</p>' : '')
      + '<div class="g-pass__actions">'
      + '<a class="g-btn g-btn--secondary g-btn--sm" href="home.html?view=store&tab=membership">Manage membership</a>'
      + '</div></article>';
  }

  /* ── My Access ──────────────────────────────────────────────────────────
   * Built from `sections`, in the order the server gave. A type absent from
   * sections produces no row.                                               */
  function myAccess(access) {
    const sections = Array.isArray(access?.sections) ? access.sections : [];
    const entitlements = Array.isArray(access?.entitlements) ? access.entitlements : [];
    if (!sections.length && !entitlements.length) {
      return '<section class="g-ma"><h2 class="g-ma__title">My Access</h2>'
        + '<p class="g-empty">No access on record yet.</p></section>';
    }

    // Rows come from `sections` (what is active) PLUS any type the member holds
    // only in an ended state. A benefit that stopped should say so rather than
    // vanish — silence reads as "we lost your data", not "this ended".
    const rowTypes = new Map();
    for (const section of sections) {
      rowTypes.set(section.type, { type: section.type, title: section.title, order: section.order });
    }
    for (const item of entitlements) {
      if (rowTypes.has(item.type)) continue;
      rowTypes.set(item.type, {
        type: item.type,
        title: TITLES[item.type] || item.type.replace(/_/g, ' '),
        order: ORDER[item.type] || 99,
      });
    }

    const rows = [...rowTypes.values()].sort((a, b) => (a.order || 0) - (b.order || 0)).map((section) => {
      const items = allOf(entitlements, section.type);
      const renderer = RENDERERS[section.type] || genericRenderer;
      let summary;
      const anyActive = items.some((item) => item.status === 'active');
      try {
        summary = anyActive
          ? renderer.summary(items)
          : (ENTITLEMENT_STATUS_TEXT[items[0]?.status] || 'Ended');
      } catch (_) { summary = section.summary || ''; }
      const panelId = 'ma-panel-' + esc(section.type);
      return '<li class="g-ma-row">'
        + '<button type="button" class="g-ma-row__button" aria-expanded="false" aria-controls="' + panelId + '" data-ma-toggle="' + esc(section.type) + '">'
        + '<span class="g-ma-row__label">' + esc(section.title || section.type) + '</span>'
        + '<span class="g-ma-row__value">' + esc(summary || section.summary || '') + '</span>'
        + '<span class="g-ma-row__chev" aria-hidden="true">›</span>'
        + '</button>'
        + '<div class="g-ma-row__panel" id="' + panelId + '" hidden>' + safeDetail(renderer, items) + '</div>'
        + '</li>';
    }).join('');

    return '<section class="g-ma"><h2 class="g-ma__title">My Access</h2>'
      + '<ul class="g-ma-rows">' + rows + '</ul></section>';
  }

  function safeDetail(renderer, items) {
    try { return renderer.detail(items) || ''; }
    catch (_) { return '<p class="g-empty">This access could not be displayed.</p>'; }
  }

  /* ── Included in your access ────────────────────────────────────────────
   * Deliberately NOT "what your tier includes": every line here is an active
   * entitlement the member actually holds. A tier promise that was never
   * granted must not appear.                                                */
  function includedInYourAccess(access) {
    const entitlements = (access?.entitlements || []).filter((item) => item.status === 'active');
    if (!entitlements.length) return '';
    const byType = new Map();
    for (const item of entitlements) {
      if (!byType.has(item.type)) byType.set(item.type, []);
      byType.get(item.type).push(item);
    }
    const sections = Array.isArray(access?.sections) ? access.sections : [];
    const titleFor = (type) => (sections.find((s) => s.type === type)?.title) || type;

    const rows = [...byType.entries()].map(([type, items]) => {
      const renderer = RENDERERS[type] || genericRenderer;
      let value; try { value = renderer.summary(items); } catch (_) { value = ''; }
      return '<li class="g-inc__row"><span>' + esc(titleFor(type)) + '</span>'
        + '<span class="g-inc__value">' + esc(value) + '</span></li>';
    }).join('');

    return '<section class="g-inc"><h2 class="g-inc__title">Included in your access</h2>'
      + '<ul class="g-inc__list">' + rows + '</ul>'
      + '<p class="g-inc__note">Everything here is active on your account right now.</p></section>';
  }

  /* ── Next Level ─────────────────────────────────────────────────────────
   * Entirely from `access.upgrade`. No upgrade object, no block.            */
  function nextLevel(access, plans) {
    const upgrade = access?.upgrade;
    if (!upgrade || !upgrade.next_key) return '';
    const plan = (plans || []).find((item) => item.key === upgrade.next_key) || {};
    const gains = Array.isArray(upgrade.gains) ? upgrade.gains : [];
    const sections = Array.isArray(access?.sections) ? access.sections : [];
    const labelFor = (type) => (sections.find((s) => s.type === type)?.title) || type.replace(/_/g, ' ');

    const gainRows = gains.map((gain) => '<li>' + esc(labelFor(gain.type))
      + (gain.to != null ? ': <strong>' + esc(gain.to) + '</strong>' : '') + '</li>').join('');

    return '<section class="g-next"><p class="g-next__kicker">Next Level</p>'
      + '<h2 class="g-next__title">' + esc(plan.label || upgrade.next_key) + '</h2>'
      + (plan.subtitle ? '<p class="g-next__subtitle">' + esc(plan.subtitle) + '</p>' : '')
      + (gainRows ? '<p class="g-next__lead">Upgrade to unlock:</p><ul class="g-next__list">' + gainRows + '</ul>' : '')
      + (plan.checkoutUrl
        ? '<div class="g-next__actions"><a class="g-btn g-btn--primary g-btn--sm" href="' + esc(plan.checkoutUrl)
          + '" target="_blank" rel="noopener noreferrer">View ' + esc(plan.label || upgrade.next_key) + '</a></div>'
        : '')
      + '</section>';
  }

  /* ── degraded / stale ───────────────────────────────────────────────────
   * Informational only. Access is still shown: an unreachable source is not a
   * revocation, and pretending otherwise would be the worst possible lie to
   * tell a paying member.                                                   */
  function degradedNotice(access) {
    const meta = access?.meta || {};
    if (!meta.degraded && !meta.stale) return '';
    const observed = meta.ledger_observed_at ? formatDate(meta.ledger_observed_at) : null;
    return '<div class="g-degraded" role="status">'
      + '<p class="g-degraded__title">This may not be up to date</p>'
      + '<p class="g-degraded__meta">'
      + esc(observed ? `Your access was last confirmed on ${observed}. Nothing has been removed — we just could not re-check it right now.`
        : 'We could not re-check your access right now. Nothing has been removed.')
      + '</p></div>';
  }

  /* Wire the expand/collapse behaviour of My Access rows. */
  function bind(root) {
    if (!root) return;
    root.querySelectorAll('[data-ma-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const panel = root.querySelector('#ma-panel-' + button.getAttribute('data-ma-toggle'));
        if (!panel) return;
        const open = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', open ? 'false' : 'true');
        panel.hidden = open;
      });
    });
  }

  /** The whole signed-in membership screen. */
  let ENRICHMENT = {};
  function renderMembershipScreen(access, plans, enrichment) {
    ENRICHMENT = (enrichment && typeof enrichment === 'object') ? enrichment : {};
    return degradedNotice(access)
      + memberPass(access)
      + myAccess(access)
      + includedInYourAccess(access)
      + nextLevel(access, plans);
  }

  window.GaiaMembershipUI = {
    renderMembershipScreen,
    memberPass,
    myAccess,
    includedInYourAccess,
    nextLevel,
    degradedNotice,
    bind,
    RENDERERS,
  };
})();
