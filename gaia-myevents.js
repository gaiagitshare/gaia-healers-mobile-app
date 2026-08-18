/** Gaia — My Events and My Ticket.
 *
 * Until now the Events screen has been a programme browser: anyone could read
 * the agenda, and nobody could find their own ticket. The single most-used
 * screen at any conference — the one people open at the door with a queue
 * behind them — did not exist.
 *
 * This adds it. My Events lists what the signed-in person actually holds; the
 * ticket shows their QR large enough to scan off a cracked screen in bad light.
 *
 * Two rules shape the whole file:
 *
 *   1. The browser never names an attendee. It asks "what is mine?" and the
 *      proxy answers from the session cookie. There is no id to tamper with.
 *   2. The QR is fetched only when a ticket is opened, never with the list, and
 *      never written anywhere that outlives the screen.
 */
(function () {
  'use strict';

  function proxyBase() {
    const localOverride = /^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)
      ? new URLSearchParams(window.location.search).get('apiBase') : '';
    if (localOverride && /^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(localOverride)) return localOverride.replace(/\/+$/, '');
    return String((window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
      || 'https://api.gaiahealers.app').replace(/\/+$/, '');
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const state = { mine: null, loading: false, fetchedAt: 0, ticket: null };
  const MINE_TTL_MS = 60 * 1000;

  async function api(path) {
    try {
      const response = await fetch(proxyBase() + path, {
        headers: { Accept: 'application/json' },
        credentials: 'include',
        cache: 'no-store',
      });
      return await response.json();
    } catch (_) {
      return { ok: false, reason: 'network' };
    }
  }

  async function loadMine(force) {
    const fresh = state.mine && (Date.now() - state.fetchedAt) < MINE_TTL_MS;
    if (state.loading || (fresh && !force)) return state.mine;
    state.loading = true;
    try {
      state.mine = await api('/api/events/mine');
      state.fetchedAt = Date.now();
      return state.mine;
    } finally {
      state.loading = false;
    }
  }

  /** Venue-local date, because a ticket is used at the venue. */
  function dateRange(item) {
    const fmt = (value, opts) => {
      if (!value) return '';
      try {
        return new Intl.DateTimeFormat(undefined, { timeZone: item.timezone || 'UTC', ...opts })
          .format(new Date(value));
      } catch (_) { return ''; }
    };
    const start = fmt(item.startDate, { month: 'short', day: 'numeric' });
    const end = fmt(item.endDate, { month: 'short', day: 'numeric', year: 'numeric' });
    if (start && end) return start + ' – ' + end;
    return start || end || '';
  }

  function checkedInAtLabel(item, iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: item.timezone || 'UTC', hour: 'numeric', minute: '2-digit',
      }).format(new Date(iso));
    } catch (_) { return ''; }
  }

  /** The one-line status of a ticket, in the words a person would use. */
  function ticketStatus(ticket) {
    if (ticket.registrationStatus === 'cancelled') {
      return { text: 'Cancelled', tone: 'bad' };
    }
    if (ticket.checkedIn) return { text: 'Checked in', tone: 'good' };
    return { text: 'Not yet checked in', tone: 'idle' };
  }

  function eventRow(item) {
    const status = ticketStatus(item.ticket);
    const phaseChip = item.phase === 'live'
      ? '<span class="g-mye__chip is-live"><span class="g-live-dot" aria-hidden="true"></span> On now</span>'
      : item.phase === 'past' ? '<span class="g-mye__chip">Finished</span>' : '';

    return '<article class="g-mye__card' + (item.phase === 'past' ? ' is-past' : '') + '">'
      + '<div class="g-mye__head">'
      + '<div><p class="g-mye__when">' + esc(dateRange(item)) + '</p>'
      + '<h3 class="g-mye__name">' + esc(item.name) + '</h3>'
      + (item.location ? '<p class="g-mye__where">' + esc(item.location) + '</p>' : '')
      + '</div>' + phaseChip + '</div>'
      + '<div class="g-mye__pass">'
      + '<span class="g-mye__passname">' + esc(item.ticket.passLabel || 'Ticket') + '</span>'
      + (item.ticket.isVip ? '<span class="g-mye__vip">VIP</span>' : '')
      + '<span class="g-mye__status is-' + status.tone + '">' + esc(status.text) + '</span>'
      + '</div>'
      + '<div class="g-mye__actions">'
      + '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-mye-ticket="' + esc(item.id) + '">'
      + 'Show my ticket</button>'
      + '<a class="g-btn g-btn--ghost g-btn--sm" href="home.html?view=events&event=' + esc(item.id) + '">'
      + 'Programme</a>'
      + '</div>'
      + '</article>';
  }

  function group(title, items) {
    if (!items.length) return '';
    return '<section class="g-mye__group"><h2 class="g-mye__grouphead">' + esc(title) + '</h2>'
      + items.map(eventRow).join('') + '</section>';
  }

  function panelHtml(data) {
    if (!data) return '';

    if (data.authenticated === false) {
      // Not signed in. Say what signing in would give them, rather than
      // presenting an empty list that reads as "you have no tickets".
      return '<section class="g-mye g-mye--prompt">'
        + '<h2>Your tickets live here</h2>'
        + '<p>Sign in and Gaia will show every event you hold a ticket for — '
        + 'your pass, your QR code for the door, and your check-in status.</p>'
        + '<a class="g-btn g-btn--primary" href="home.html?view=profile">Sign in</a>'
        + '</section>';
    }

    if (data.ok === false) {
      // An outage is not the same as having no tickets, and must never be
      // shown as one to somebody standing at a door.
      return '<section class="g-mye g-mye--problem">'
        + '<h2>Tickets are temporarily unavailable</h2>'
        + '<p>Gaia could not reach the event system just now. Your ticket is safe — '
        + 'try again in a moment, and staff can always find you by name at the desk.</p>'
        + '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-mye-retry>Try again</button>'
        + '</section>';
    }

    const events = Array.isArray(data.events) ? data.events : [];
    if (!events.length) {
      return '<section class="g-mye g-mye--empty">'
        + '<h2>No tickets yet</h2>'
        + '<p>When you register for a Gaia gathering, your ticket appears here automatically.</p>'
        + '<a class="g-btn g-btn--secondary g-btn--sm" href="home.html?view=events">Browse events</a>'
        + '</section>';
    }

    const live = events.filter((e) => e.phase === 'live');
    const upcoming = events.filter((e) => e.phase === 'upcoming');
    const past = events.filter((e) => e.phase === 'past');

    return '<div class="g-mye">'
      + group('Happening now', live)
      + group('Coming up', upcoming)
      + group('Past events', past)
      + (data.unresolved && data.unresolved.length
        // Rare, and worth saying plainly rather than hiding: the person's
        // record is ambiguous and only a human can fix it.
        ? '<p class="g-mye__note">One of your registrations needs checking by the '
          + 'events team. Please see the registration desk.</p>'
        : '')
      + '</div>';
  }

  // ── The ticket sheet ──────────────────────────────────────────────────────

  function ticketHtml(data) {
    const event = data.event;
    const ticket = data.ticket;
    const status = ticketStatus(ticket);

    return '<div class="g-ticket__panel" role="dialog" aria-label="My ticket" aria-modal="true">'
      + '<button type="button" class="g-ticket__close" data-ticket-close aria-label="Close">&times;</button>'
      + '<p class="g-ticket__event">' + esc(event.name) + '</p>'
      + '<p class="g-ticket__when">' + esc(dateRange(event)) + (event.location ? ' · ' + esc(event.location) : '') + '</p>'

      // The QR is the reason this screen exists, so it gets the space.
      + '<div class="g-ticket__qr">'
      + (ticket.qrImage
        ? '<img src="' + esc(ticket.qrImage.startsWith('data:') ? ticket.qrImage : 'data:image/png;base64,' + ticket.qrImage)
          + '" alt="Your check-in QR code" />'
        : '<p class="g-ticket__noqr">QR unavailable — staff can find you by name.</p>')
      + '</div>'
      + '<p class="g-ticket__code">' + esc(ticket.qrCode || '') + '</p>'

      + '<p class="g-ticket__name">' + esc(ticket.name || '') + '</p>'
      + '<div class="g-ticket__meta">'
      + '<span class="g-ticket__pass">' + esc(ticket.passLabel || 'Ticket') + '</span>'
      + (ticket.isVip ? '<span class="g-ticket__vip">VIP</span>' : '')
      + '</div>'
      + '<p class="g-ticket__status is-' + status.tone + '">' + esc(status.text)
      + (ticket.checkedIn && ticket.checkedInAt
        ? ' · ' + esc(checkedInAtLabel(event, ticket.checkedInAt)) : '')
      + '</p>'
      + '<p class="g-ticket__hint">Show this at the door. Your screen brightness may need turning up.</p>'
      + '</div>';
  }

  function closeTicket() {
    const open = document.querySelector('.g-ticket');
    if (open) open.remove();
    // Held only for the life of the sheet: a door credential has no business
    // outliving the screen showing it.
    state.ticket = null;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(event) {
    if (event.key === 'Escape') closeTicket();
  }

  async function openTicket(eventId) {
    closeTicket();
    const shell = document.createElement('div');
    shell.className = 'g-ticket';
    shell.innerHTML = '<div class="g-ticket__panel g-ticket__panel--loading"><p>Loading your ticket…</p></div>';
    document.body.appendChild(shell);

    const data = await api('/api/events/' + encodeURIComponent(eventId) + '/ticket');
    if (!data || data.ok !== true) {
      shell.innerHTML = '<div class="g-ticket__panel">'
        + '<button type="button" class="g-ticket__close" data-ticket-close aria-label="Close">&times;</button>'
        + '<p class="g-ticket__event">Ticket unavailable</p>'
        + '<p class="g-ticket__hint">'
        + (data && data.reason === 'no_ticket_for_event'
          ? 'This account does not hold a ticket for that event.'
          : 'Gaia could not load your ticket just now. Staff can find you by name at the desk.')
        + '</p></div>';
    } else {
      state.ticket = data;
      shell.innerHTML = ticketHtml(data);
    }

    shell.addEventListener('click', (event) => {
      if (event.target === shell || event.target.closest('[data-ticket-close]')) closeTicket();
    });
    document.addEventListener('keydown', onKey);
    shell.querySelector('.g-ticket__close')?.focus();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  async function render() {
    const hosts = document.querySelectorAll('[data-myevents-host]');
    if (!hosts.length) return;
    const data = await loadMine();
    hosts.forEach((host) => {
      host.innerHTML = panelHtml(data);
      host.querySelectorAll('[data-mye-ticket]').forEach((button) => {
        button.addEventListener('click', () => openTicket(button.dataset.myeTicket));
      });
      host.querySelector('[data-mye-retry]')?.addEventListener('click', async () => {
        await loadMine(true);
        render();
      });
    });
  }

  document.addEventListener('gaia:superapp-rendered', render);
  document.addEventListener('DOMContentLoaded', render);

  window.GaiaMyEvents = { render, openTicket, closeTicket, panelHtml, ticketStatus, dateRange };
}());
