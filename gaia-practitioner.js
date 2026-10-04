/**
 * PRACTITIONER — a practitioner's clients, inside You / Profile.
 *
 * Named for the person, not the word "practice": gaia-practice.js is already the
 * member's personal practice journal, a different feature entirely. Sharing the
 * word would be a trap for whoever reads these filenames next.
 *
 * Everything here reads. Gaia Practitioners exposes one scope, mcp.read, so there
 * is no save button anywhere in this file and there should never be one: the
 * practitioner acts in their own platform and looks here.
 *
 * The shape of the screen is decided by two measurements rather than by taste.
 *
 * FIRST: the calls split cleanly. Listing clients, searching, opening one,
 * reading who is flagged and who is due a follow-up all answer in under a
 * second. Anything touching a Bio-Well scan takes nine to twelve, because their
 * side fetches it live. So the fast things load with the screen and the slow
 * things are cards with a button — nobody waits eleven seconds for a client they
 * only wanted the phone number of.
 *
 * SECOND: the raw scan is 1.6 MB of which most is a JSON-RPC envelope. None of
 * that is shaped here. The server returns about 850 characters already reduced to
 * what somebody reads, and the model is given the SAME shaped output from the
 * same handler, so the screen and the voice can never describe different numbers.
 *
 * Data arrives through /api/assist/tool — the registry that gates by role and
 * injects identity from the session cookie. No client id, practitioner id or
 * token is ever sent from here; the server knows who is asking.
 */
(function () {
  'use strict';

  const TOOL_ENDPOINT = '/api/assist/tool';
  const SLOW_HINT_MS = 5000;        // when a wait earns an elapsed counter

  // The API lives on api.gaiahealers.app. This used to read a global that no
  // script defines, fell back to '' and asked the website for
  // /api/practitioners/status -- a 404, read as "not available", so the
  // Practice tab never appeared for anyone (found 4 Oct 2026 when a
  // practitioner signed in and saw only the member side). Same resolution
  // as the rest of the app now, with the production API as the last word.
  function proxyBase() {
    const shared = window.GaiaApi && window.GaiaApi.base && window.GaiaApi.base(); if (shared) return shared;
    return String(
      (window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
      || (window.GaiaConfig && window.GaiaConfig.proxyBase)
      || window.GAIA_PROXY_BASE
      || 'https://api.gaiahealers.app',
    ).replace(/\/+$/, '');
  }

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** One server-side tool call. Name and arguments only; the cookie says who. */
  async function tool(name, args) {
    const res = await fetch(`${proxyBase()}${TOOL_ENDPOINT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, args: args || {} }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return body.result;
    const err = new Error(body.detail || body.error || `HTTP ${res.status}`);
    err.code = body.error || 'failed';
    throw err;
  }

  /** The role, where the account is named: a small chip on the You header once the practitioner account is linked. */
  function badge(status) {
    const head = document.querySelector('.g-page__head--profile .g-page__sub, #profile-sub');
    if (!head) return;
    head.querySelector('.g-prac-badge')?.remove();
    if (status?.state !== 'connected') return;
    head.insertAdjacentHTML('beforeend', ` <span class="g-prac-badge">Practitioner${status.practitioner_name ? ' · ' + esc(status.practitioner_name) : ''}</span>`);
  }
  /** Which clients share their readings through Gaia (their customer id -> { opened, ... }). Local to our server, fast. */
  async function linkedClients() {
    try {
      const res = await fetch(`${proxyBase()}/api/practitioners/linked-clients`, { credentials: 'include', headers: { Accept: 'application/json' } });
      const j = await res.json();
      return new Map((j.clients || []).map((c) => [String(c.customer_id), c]));
    } catch (_) { return new Map(); }
  }
  const sharesTag = (l) => (l ? `<span class="g-prac__tag g-prac__tag--shares" title="This client asked to see their own readings in the Gaia app">Sees their readings${l.opened ? '' : ' · not opened yet'}</span>` : '');
  async function connection() {
    try {
      const res = await fetch(`${proxyBase()}/api/practitioners/status`,
        { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!res.ok) return { available: false, connected: false };
      return res.json();
    } catch (e) { return { available: false, connected: false, offline: true }; }
  }

  // ── small renderers, all on the existing g-* / gaia-* system ──────────────

  function skeleton(lines = 3) {
    return `<div class="g-skeleton" aria-hidden="true">${
      '<span class="g-skeleton__line"></span>'.repeat(lines)}</div>`;
  }

  function empty(message, action) {
    return `<div class="gaia-empty">
      <p class="gaia-empty__text">${esc(message)}</p>
      ${action ? `<button type="button" class="g-btn g-btn--sm" data-prac-action="${esc(action.action)}">${esc(action.label)}</button>` : ''}
    </div>`;
  }

  function severityClass(sev) {
    return sev === 'high' ? 'is-high' : sev === 'elevated' ? 'is-elevated' : '';
  }

  function clientRow(c, extra = '') {
    return `<button type="button" class="g-prac__client" data-prac-client="${esc(c.id)}">
      <span class="g-prac__client-name">${esc(c.name || 'Unnamed client')}</span>
      <span class="g-prac__client-meta">${esc(c.email || '')}</span>
      ${extra}
    </button>`;
  }

  /**
   * A wait with a number on it.
   *
   * Their side goes out to Bio-Well, so these take about ten seconds and no
   * spinner survives that honestly. Saying how long BEFORE it is long is what
   * separates waiting from deciding the app is broken, and after five seconds
   * the elapsed count proves something is still happening.
   */
  function loadingCard(label) {
    return `<div class="g-prac__loading" data-prac-loading>
      ${skeleton(2)}
      <p class="g-prac__loading-note">${esc(label)} — this usually takes about ten seconds.
        <span data-prac-elapsed></span></p>
    </div>`;
  }

  function startElapsed(host) {
    const slot = host.querySelector('[data-prac-elapsed]');
    if (!slot) return () => {};
    const began = Date.now();
    const id = window.setInterval(() => {
      const s = Math.round((Date.now() - began) / 1000);
      if (s >= SLOW_HINT_MS / 1000) slot.textContent = ` ${s}s`;
    }, 1000);
    return () => window.clearInterval(id);
  }

  // ── the screen ────────────────────────────────────────────────────────────

  function create(root) {
    if (!root) return null;
    let openClient = null;
    const loaded = new Map();        // clientId -> { latest, trend, compare }

    function paint(html) { root.innerHTML = html; }

    const REASONS = {
      access_denied: 'You cancelled on Gaia Practitioners.',
      denied: 'You cancelled on Gaia Practitioners.',
      bad_state: 'The sign-in did not come back to this session. Please try again.',
      session_changed: 'A different member was signed in when Gaia Practitioners answered. Please try again.',
      exchange_failed: 'Gaia Practitioners did not accept the sign-in. Please try again in a moment.',
      not_practitioner: 'That Gaia Practitioners account is not a practitioner account.',
      unverified: 'We could not read your practitioner profile. Please try again.',
    };
    // What the last connect attempt brought back, if the page was just returned to.
    function lastAttempt() {
      try {
        const p = new URLSearchParams(window.location.search);
        if (p.get('practitioners') !== 'failed') return '';
        const r = p.get('reason') || '';
        return `<p class="g-prac__attempt" role="alert">${esc(REASONS[r] || 'The connection did not complete.')}</p>`;
      } catch (e) { return ''; }
    }
    async function showGate(status) {
      if (status.offline) {
        paint(empty('Could not reach Gaia right now. Check your connection and try again.',
          { action: 'retry', label: 'Try again' }));
        return;
      }
      if (status.state === 'not_practitioner') {
        // Signed in fine; the account is not a practitioner. Say so, name the
        // account, and offer the two honest ways out.
        paint(`<div class="gaia-empty">
          ${lastAttempt()}
          <p class="gaia-empty__text">The Gaia Practitioners account you connected is not a practitioner account.</p>
          ${status.practitioner_email ? `<p class="g-prac__muted">Connected as ${esc(status.practitioner_email)}</p>` : ''}
          <p class="g-prac__muted">If you practise with Gaia, sign in with your practitioner account. If you are a client, your readings are under You.</p>
          <a class="g-btn g-btn--sm" href="${esc(proxyBase())}/api/practitioners/connect">Connect a different account</a>
          <button type="button" class="g-btn g-btn--ghost g-btn--sm" data-prac-action="disconnect">Disconnect</button>
        </div>`);
        return;
      }
      if (status.state === 'unverified') {
        paint(`<div class="gaia-empty">
          ${lastAttempt()}
          <p class="gaia-empty__text">Your account is connected, but we could not read your practitioner profile.</p>
          ${status.practitioner_email ? `<p class="g-prac__muted">Connected as ${esc(status.practitioner_email)}</p>` : ''}
          <a class="g-btn g-btn--sm" href="${esc(proxyBase())}/api/practitioners/connect">Try again</a>
        </div>`);
        return;
      }
      if (status.needs_reconnect || status.state === 'needs_reconnect') {
        // Deliberately distinct from never-connected: naming the account is how
        // somebody notices they connected the wrong one.
        paint(`<div class="gaia-empty">
          <p class="gaia-empty__text">Your connection to Gaia Practitioners expired.</p>
          ${status.practitioner_email ? `<p class="g-prac__muted">Connected as ${esc(status.practitioner_email)}</p>` : ''}
          <a class="g-btn g-btn--sm" href="${esc(proxyBase())}/api/practitioners/connect">Reconnect</a>
        </div>`);
        return;
      }
      paint(`<div class="gaia-empty">
        ${lastAttempt()}
        <p class="gaia-empty__text">Connect your Gaia Practitioners account to see your clients here.</p>
        <p class="g-prac__muted">Your Gaia login stays as it is. This links your practitioner account to it.</p>
        <a class="g-btn g-btn--sm" href="${esc(proxyBase())}/api/practitioners/connect">Connect</a>
      </div>`);
    }
    async function disconnect() {
      try { await fetch(`${proxyBase()}/api/practitioners/disconnect`, { method: 'POST', credentials: 'include' }); } catch (e) { /* ignore */ }
      start();
    }

    // —— Phase 1: the landing screen ——
    //
    // Who needs attention comes FIRST, deliberately. A practitioner knows who
    // their clients are; what they cannot know without looking is who has
    // deteriorated since they last met. Both answers cost under a second.
    async function showList() {
      openClient = null;
      paint(`
        <div class="g-prac">
          <section class="g-prac__sec" data-prac-flagged>
            <h3 class="g-prac__h">Needs attention</h3>${skeleton(2)}
          </section>
          <section class="g-prac__sec" data-prac-followups>
            <h3 class="g-prac__h">Due a follow-up</h3>${skeleton(1)}
          </section>
          <section class="g-prac__sec" data-prac-clients-sec>
            <h3 class="g-prac__h">Your clients</h3>
            <input type="search" class="g-input g-prac__search" placeholder="Search by name or email"
                   aria-label="Search your clients" data-prac-search />
            <div data-prac-client-list>${skeleton(3)}</div>
          </section>
        </div>`);

      const flaggedHost = root.querySelector('[data-prac-flagged]');
      const followHost = root.querySelector('[data-prac-followups]');
      const listHost = root.querySelector('[data-prac-client-list]');
      // Who shares their readings through Gaia: a local lookup, so it is used
      // the moment the list arrives, and a one-line count above the list.
      const linked = linkedClients();
      linked.then((m) => {
        if (openClient !== null || !m.size) return;
        const opened = [...m.values()].filter((l) => l.opened).length;
        const sec = root.querySelector('[data-prac-clients-sec] .g-prac__h');
        if (sec) sec.insertAdjacentHTML('afterend', `<p class="g-prac__muted" data-prac-linked-count>${m.size} client${m.size === 1 ? '' : 's'} can see their own readings in the Gaia app · ${opened} ${opened === 1 ? 'has' : 'have'} opened them</p>`);
      });

      // Three independent fast calls. One failing must not blank the other two.
      tool('practitioner_flagged_clients', {}).then((r) => {
        const rows = r.clients || [];
        flaggedHost.innerHTML = `<h3 class="g-prac__h">Needs attention</h3>` + (rows.length
          ? rows.map((c) => clientRow(c, `<span class="g-prac__flags">${
              (c.concerns || []).slice(0, 3).map((x) =>
                `<span class="g-prac__flag ${severityClass(x.severity)}">${esc(x.name)}</span>`).join('')
            }${(c.concerns || []).length > 3 ? `<span class="g-prac__flag">+${(c.concerns || []).length - 3}</span>` : ''}</span>`)).join('')
          : empty('Nobody is flagged right now.'));
      }).catch(() => { flaggedHost.innerHTML = `<h3 class="g-prac__h">Needs attention</h3>` + empty('Could not load this just now.', { action: 'retry', label: 'Try again' }); });

      tool('practitioner_follow_ups', {}).then((r) => {
        const rows = r.suggestions || [];
        followHost.innerHTML = `<h3 class="g-prac__h">Due a follow-up</h3>` + (rows.length
          ? rows.map((s) => clientRow(s, s.suggested_window
              ? `<span class="g-prac__when">${esc(s.suggested_window)}</span>` : '')).join('')
          : empty('No follow-ups suggested.'));
      }).catch(() => { followHost.innerHTML = `<h3 class="g-prac__h">Due a follow-up</h3>` + empty('Could not load this just now.'); });

      tool('practitioner_list_clients', {}).then(async (r) => {
        const rows = r.clients || [];
        const m = await linked;
        listHost.innerHTML = rows.length
          ? rows.map((c) => clientRow(c, (c.has_biowell
              ? '<span class="g-prac__tag">Bio-Well</span>' : '') + sharesTag(m.get(String(c.id))))).join('')
          : empty('No clients on your list yet.');
      }).catch((e) => { listHost.innerHTML = empty(e.code === 'not_connected'
          ? 'Connect your Gaia Practitioners account to see your clients.'
          : 'Could not load your clients just now.', { action: 'retry', label: 'Try again' }); });
    }

    let searchTimer = null;
    function onSearch(value) {
      const host = root.querySelector('[data-prac-client-list]');
      if (!host) return;
      window.clearTimeout(searchTimer);
      const q = String(value || '').trim();
      searchTimer = window.setTimeout(() => {
        const call = q ? tool('practitioner_find_client', { query: q })
          : tool('practitioner_list_clients', {});
        call.then((r) => {
          const rows = r.clients || [];
          host.innerHTML = rows.length ? rows.map((c) => clientRow(c)).join('')
            : empty(`No client matches “${q}”.`);
        }).catch(() => { host.innerHTML = empty('Search failed. Try again.'); });
      }, 250);
    }

    // —— Phase 2: one client ——
    async function showClient(clientId, openSection, awaiting) {
      openClient = String(clientId);
      loaded.set(openClient, loaded.get(openClient) || {});
      paint(`
        <div class="g-prac g-prac--client">
          <button type="button" class="g-btn g-btn--ghost g-btn--sm" data-prac-back>&larr; All clients</button>
          <div data-prac-header>${skeleton(2)}</div>
          <div data-prac-services></div>
          <section class="g-prac__sec">
            <h3 class="g-prac__h">Bio-Well</h3>
            <p class="g-prac__muted">Each of these is fetched live from Bio-Well and takes about ten seconds.</p>
            <div class="g-prac__cards">
              ${['latest', 'trend', 'compare'].map((k) => `
                <div class="g-prac__card" data-prac-card="${k}">
                  <button type="button" class="g-prac__card-head" data-prac-open="${k}">
                    <span>${k === 'latest' ? 'Latest reading' : k === 'trend' ? 'Trend over time' : 'Before and after'}</span>
                    <span class="g-prac__card-cta">Show</span>
                  </button>
                  <div class="g-prac__card-body" data-prac-body="${k}" hidden></div>
                </div>`).join('')}
            </div>
          </section>
          <section class="g-prac__sec">
            <h3 class="g-prac__h">Files</h3>
            <div data-prac-files>${skeleton(1)}</div>
          </section>
        </div>`);

      const head = root.querySelector('[data-prac-header]');
      const linkedOne = linkedClients().then((m) => m.get(String(clientId)) || null);
      tool('practitioner_get_client', { clientId }).then(async (c) => {
        if (openClient !== String(clientId)) return;
        const l = await linkedOne;
        head.innerHTML = c.found === false
          ? empty('That client is not on your list.')
          : `<div class="g-prac__profile">
               <h2 class="g-prac__name">${esc(c.name)}</h2>
               <p class="g-prac__muted">${[c.email, c.phone, c.city].filter(Boolean).map(esc).join(' · ')}</p>
               <p class="g-prac__muted">${[c.sex, c.date_of_birth ? `born ${esc(c.date_of_birth)}` : ''].filter(Boolean).join(' · ')}
                 ${c.has_biowell ? '<span class="g-prac__tag">Bio-Well linked</span>' : ''}</p>
               ${l ? `<p class="g-prac__shares">Also a Gaia member: they can see this reading too, in their own app${l.opened ? (l.opened_latest ? ' · they have opened the latest one' : ' · they have opened an earlier one') : ' · not opened yet'}.</p>` : ''}
             </div>`;
      }).catch(() => { head.innerHTML = empty('Could not load this client.'); });

      // Fast, and the most useful thing on the screen: what the practitioner
      // already offers that addresses what the readings show.
      const svcHost = root.querySelector('[data-prac-services]');
      tool('practitioner_suggested_services', { clientId }).then((r) => {
        if (openClient !== String(clientId)) return;
        if (!(r.services || []).length) { svcHost.innerHTML = ''; return; }
        svcHost.innerHTML = `<section class="g-prac__sec">
          <h3 class="g-prac__h">From your services</h3>
          ${r.services.map((s) => `<div class="g-prac__service">
            <span class="g-prac__service-name">${esc(s.name)}</span>
            <span class="g-prac__muted">addresses ${s.covers.map(esc).join(', ')}</span>
          </div>`).join('')}
        </section>`;
      }).catch(() => { svcHost.innerHTML = ''; });

      const filesHost = root.querySelector('[data-prac-files]');
      tool('practitioner_client_files', { clientId })
        .then((r) => { filesHost.innerHTML = (r.files || []).length
          ? r.files.map((f) => `<div class="g-prac__file">${esc(f.name || 'File')}</div>`).join('')
          : empty('No files for this client yet.'); })
        .catch(() => { filesHost.innerHTML = empty('No files for this client yet.'); });

      if (openSection) openCard(openSection, awaiting);
    }

    /**
     * Fill a card from a result somebody else already fetched.
     *
     * When Gaia asks for a scan, the page opens the card and the answer arrives
     * through the same call the model made. Re-fetching here would mean two
     * eleven-second calls for one question -- and, worse, two chances for the
     * screen and the spoken answer to disagree about the same numbers.
     */
    function fillCard(kind, payload) {
      const card = root.querySelector(`[data-prac-card="${kind}"]`);
      const body = root.querySelector(`[data-prac-body="${kind}"]`);
      if (!card || !body) return;
      body.hidden = false;
      const cta = card.querySelector('.g-prac__card-cta');
      if (cta) cta.textContent = 'Hide';
      if (payload && payload.error) {
        body.innerHTML = empty(payload.error === 'upstream_unavailable'
          ? 'Bio-Well did not answer. Try again.'
          : 'Could not load that just now.', { action: `retry-${kind}`, label: 'Try again' });
        return;
      }
      const html = renderCard(kind, payload.data);
      body.innerHTML = html;      // replaces the waiting state and its timer
      if (openClient) (loaded.get(openClient) || {})[kind] = html;
    }

    const CARD_TOOL = {
      latest: ['practitioner_client_latest_scan', 'Fetching the latest reading'],
      trend: ['practitioner_client_trend', 'Working out the trend'],
      compare: ['practitioner_compare_sessions', 'Comparing sessions'],
    };

    async function openCard(kind, awaiting) {
      const card = root.querySelector(`[data-prac-card="${kind}"]`);
      const body = root.querySelector(`[data-prac-body="${kind}"]`);
      if (!card || !body) return;
      const cta = card.querySelector('.g-prac__card-cta');
      if (!body.hidden) { body.hidden = true; if (cta) cta.textContent = 'Show'; return; }
      body.hidden = false;
      if (cta) cta.textContent = 'Hide';
      const cached = (loaded.get(openClient) || {})[kind];
      if (cached) { body.innerHTML = cached; return; }
      // Gaia opened this card and its own call is still in flight; let that one
      // land rather than starting a second eleven-second fetch beside it.
      if (body.querySelector('[data-prac-loading]')) return;

      const [toolName, label] = CARD_TOOL[kind];
      body.innerHTML = loadingCard(label);
      const stop = startElapsed(body);
      // Gaia is already fetching this. Show the wait; let its result fill the
      // card through gaia:client-data rather than asking their server twice.
      if (awaiting) return;
      const forClient = openClient;
      try {
        const data = await tool(toolName, { clientId: openClient });
        stop();
        if (openClient !== forClient) return;      // they moved on; do not paint
        const html = renderCard(kind, data);
        body.innerHTML = html;
        loaded.get(forClient)[kind] = html;        // one wait per client per card
      } catch (e) {
        stop();
        if (openClient !== forClient) return;
        body.innerHTML = empty(
          e.code === 'needs_reconnect' || e.code === 'not_connected'
            ? 'Your Gaia Practitioners connection needs attention.'
            : 'Bio-Well did not answer. Try again.',
          { action: `retry-${kind}`, label: 'Try again' });
      }
    }

    function bar(value, max = 50) {
      const pct = Math.max(0, Math.min(100, (Number(value) / max) * 100));
      return `<span class="g-prac__bar"><span style="width:${pct.toFixed(0)}%"></span></span>`;
    }

    function renderCard(kind, d) {
      if (kind === 'latest') {
        if (d.found === false) return empty(d.reason || 'No scans on file for this client yet.');
        const l = d.latest || {};
        return `<p class="g-prac__muted">Scanned ${esc(l.scanned_at)} · ${esc(d.scans_on_file)} on file</p>
          <div class="g-prac__metrics">
            <div class="gaia-metric"><span class="gaia-metric__v">${esc(l.energy)}</span><span class="gaia-metric__k">Energy</span></div>
            <div class="gaia-metric"><span class="gaia-metric__v">${esc(l.stress)}</span><span class="gaia-metric__k">Stress</span></div>
          </div>
          <h4 class="g-prac__h4">Furthest out of balance</h4>
          ${(l.most_out_of_balance || []).map((r) => `<div class="g-prac__row">
            <span>${esc(r.name)} <em class="g-prac__muted">${esc(r.area)}</em></span>
            ${bar(r.disbalance)}<span class="g-prac__num">${esc(r.disbalance)}</span></div>`).join('')}
          <h4 class="g-prac__h4">Chakras</h4>
          ${(l.chakras || []).map((c) => `<div class="g-prac__row">
            <span>${esc(c.name)}</span>${bar(c.alignment, 100)}<span class="g-prac__num">${esc(c.alignment)}</span></div>`).join('')}`;
      }
      if (kind === 'trend') {
        const band = (b, unit) => b ? `${esc(b.latest)}${unit} <em class="g-prac__muted">(${esc(b.lowest)}–${esc(b.highest)}, avg ${esc(b.average)})</em>` : '—';
        return `<p class="g-prac__muted">${esc(d.scans_on_file)} scans on file</p>
          <div class="g-prac__metrics">
            <div class="gaia-metric"><span class="gaia-metric__v">${band(d.energy, '')}</span><span class="gaia-metric__k">Energy</span></div>
            <div class="gaia-metric"><span class="gaia-metric__v">${band(d.stress, '')}</span><span class="gaia-metric__k">Stress</span></div>
          </div>
          <h4 class="g-prac__h4">Flagged</h4>
          ${(d.flagged || []).length ? (d.flagged || []).map((f) => `<div class="g-prac__row">
            <span>${esc(f.name)} <em class="g-prac__muted">${esc(f.area)}</em></span>
            <span class="g-prac__flag ${f.direction === 'worsening' ? 'is-elevated' : ''}">${esc(f.direction)} ${f.change > 0 ? '+' : ''}${esc(f.change)}</span>
          </div>`).join('') : '<p class="g-prac__muted">Nothing flagged.</p>'}
          ${(d.other_movements || []).length ? `<h4 class="g-prac__h4">Also moved</h4>${
            d.other_movements.map((f) => `<div class="g-prac__row"><span>${esc(f.name)}</span>
              <span class="g-prac__muted">${esc(f.direction)} ${f.change > 0 ? '+' : ''}${esc(f.change)}</span></div>`).join('')}` : ''}`;
      }
      if (d.found === false) return empty(d.reason || 'A comparison needs two scans; this client has one.');
      return (d.comparisons || []).map((c) => `<div class="g-prac__compare">
        <p class="g-prac__muted">${esc(c.from)} → ${esc(c.to)} · ${esc(c.basis)}</p>
        <div class="g-prac__metrics">
          <div class="gaia-metric"><span class="gaia-metric__v">${c.energy_change > 0 ? '+' : ''}${esc(c.energy_change)}</span><span class="gaia-metric__k">Energy</span></div>
          <div class="gaia-metric"><span class="gaia-metric__v">${c.stress_change > 0 ? '+' : ''}${esc(c.stress_change)}</span><span class="gaia-metric__k">Stress</span></div>
        </div>
        ${(c.biggest_changes || []).map((b) => `<div class="g-prac__row">
          <span>${esc(b.name)} <em class="g-prac__muted">${esc(b.area)}</em></span>
          <span class="g-prac__num">${esc(b.before)} → ${esc(b.after)}</span></div>`).join('')}
      </div>`).join('');
    }

    root.addEventListener('click', (event) => {
      const client = event.target.closest('[data-prac-client]');
      if (client) { showClient(client.getAttribute('data-prac-client')); return; }
      if (event.target.closest('[data-prac-back]')) { showList(); return; }
      const open = event.target.closest('[data-prac-open]');
      if (open) { openCard(open.getAttribute('data-prac-open')); return; }
      const action = event.target.closest('[data-prac-action]');
      if (action) {
        const a = action.getAttribute('data-prac-action');
        if (a === 'retry') { start(); return; }
        if (a === 'disconnect') { disconnect(); return; }
        if (a.startsWith('retry-')) {
          const kind = a.slice(6);
          const body = root.querySelector(`[data-prac-body="${kind}"]`);
          if (body) { body.hidden = true; }                 // force a re-fetch
          (loaded.get(openClient) || {})[kind] = null;
          openCard(kind);
        }
      }
    });

    root.addEventListener('input', (event) => {
      if (event.target.matches('[data-prac-search]')) onSearch(event.target.value);
    });

    // The result of the call Gaia just made, pushed in rather than fetched again.
    window.addEventListener('gaia:client-data', (event) => {
      const d = event.detail || {};
      if (!d.open || String(d.client) !== String(openClient)) return;
      fillCard(d.open, d);
    });

    async function start(deepLink) {
      paint(skeleton(4));
      const status = await connection();
      badge(status);
      if (status.state !== 'connected') { await showGate(status); return; }
      if (deepLink && deepLink.client) await showClient(deepLink.client, deepLink.open, deepLink.awaiting);
      else await showList();
      return true;
    }

    return { start, showClient, showList };
  }

  /**
   * Show the Practice tab only to a practitioner, and only on the SERVER's word.
   *
   * /api/practitioners/status answers 401 for anyone not signed in and
   * `available: false` when the integration is switched off. A member who is not
   * a practitioner never sees the tab row at all -- not a tab that explains why
   * they cannot use it, which is just a worse way of saying the same thing to
   * somebody it does not concern.
   */
  async function mount() {
    const tabs = document.querySelector('[data-profile-tabs]');
    const panel = document.getElementById('practitioner-panel');
    const me = document.getElementById('member-me');
    if (!tabs || !panel || !me) return;

    let status;
    try {
      const res = await fetch(`${proxyBase()}/api/practitioners/status`,
        { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!res.ok) return;                       // not signed in: nothing to show
      status = await res.json();
    } catch (e) { return; }                      // offline: leave Profile as it was
    if (!status || status.available === false) return;

    tabs.hidden = false;
    const view = create(panel);
    let started = false;

    // A deep link decides which tab opens, so Gaia can send somebody straight to
    // a client rather than to a tab they then have to find.
    const params = new URLSearchParams(window.location.search);
    const wantsPractice = params.get('tab') === 'practice' || params.has('client');

    function select(which) {
      const practice = which === 'practice';
      tabs.querySelectorAll('[data-profile-tab]').forEach((b) => {
        const on = b.getAttribute('data-profile-tab') === which;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', String(on));
      });
      me.hidden = practice;
      panel.hidden = !practice;
      // Their own Bio-Well card (a practitioner can be a linked member too)
      // belongs to the You tab. A class, not `hidden`: the panel's own
      // `hidden` means "feature off / not signed in" and must not be touched.
      document.getElementById('member-readings')?.classList.toggle('is-on-practice-tab', practice);
      document.getElementById('member-data-sharing')?.classList.toggle('is-on-practice-tab', practice);
      if (practice && !started) {
        started = true;
        view.start({ client: params.get('client'), open: params.get('open') });
      }
    }

    tabs.addEventListener('click', (event) => {
      const button = event.target.closest('[data-profile-tab]');
      if (button) select(button.getAttribute('data-profile-tab'));
    });

    // Gaia asks for a client, a card, or just a section of the list. One hook
    // for all three: a second navigation mechanism would be a second thing to
    // keep in step with the first.
    window.addEventListener('gaia:open-readings', () => select('me'));
    window.addEventListener('gaia:open-client', (event) => {
      const d = event.detail || {};
      select('practice');
      started = true;
      if (d.client) {
        view.start({ client: String(d.client), open: d.open || '', awaiting: Boolean(d.awaiting) });
        return;
      }
      view.start().then(() => {
        if (!d.section) return;
        // The landing sections are already on screen; bring the asked-for one
        // into view rather than reloading anything.
        const host = panel.querySelector(`[data-prac-${
          d.section === 'attention' ? 'flagged' : d.section === 'followups' ? 'followups' : 'clients-sec'}]`);
        if (host && host.scrollIntoView) host.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    });

    select(wantsPractice ? 'practice' : 'me');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.GaiaPractitioner = { create, mount };
})();
