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
 *   2. The QR is fetched only when a ticket is opened, never with the list.
 *      The one place it persists is the deliberate offline copy below — kept
 *      so the ticket still renders in a hall with no signal, and removed the
 *      moment the person signs out.
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

  /* Offline copies.
   *
   * Originally the ticket was held only for the life of the sheet — the safest
   * possible handling. But the moment a QR is needed most is a concrete hall
   * with two thousand phones on one access point, and a ticket that needs the
   * network right then is not a ticket. So the last successfully loaded ticket
   * is kept on the device, the same trust model as a boarding pass in a wallet
   * app (the code is printed on physical badges anyway), and every copy is
   * removed the moment the person signs out.
   */
  const TICKET_KEY = (eventId) => 'gaia:ticket:' + eventId;
  const MINE_KEY = 'gaia:myevents';

  function keepCopy(key, value) {
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), value })); }
    catch (_) { /* full or private-mode storage loses offline, nothing else */ }
  }
  function readCopy(key) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || 'null');
      return raw && raw.value ? raw : null;
    } catch (_) { return null; }
  }
  function clearOfflineCopies() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('gaia:ticket:') || k === MINE_KEY)
        .forEach((k) => localStorage.removeItem(k));
    } catch (_) { /* nothing to clear */ }
  }
  // Signing out removes every saved ticket: they are copies of a session's
  // answers, and the session is gone.
  window.addEventListener('gaia:signed-out', clearOfflineCopies);

  async function api(path, body) {
    const options = {
      headers: { Accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
    };
    if (body !== undefined) {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    try {
      const response = await fetch(proxyBase() + path, options);
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
      const result = await api('/api/events/mine');
      if (result && result.ok === true && result.authenticated) {
        keepCopy(MINE_KEY, result);
        state.mine = result;
      } else if (result && result.ok === false && result.authenticated !== false) {
        // Could not reach the event system. A saved list beats an apology.
        const copy = readCopy(MINE_KEY);
        state.mine = copy ? { ...copy.value, offline: true, offlineAt: copy.at } : result;
      } else {
        state.mine = result;
      }
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
      const s = String(iso);
      // checked_in_at is stored naive UTC (datetime.utcnow). Mark it UTC before
      // parsing, then present it in the event's local timezone — without the 'Z'
      // the browser reads it as local time and the label is doubly off.
      const abs = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z';
      return new Intl.DateTimeFormat(undefined, {
        timeZone: item.timezone || 'UTC', hour: 'numeric', minute: '2-digit',
      }).format(new Date(abs));
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
      // Rating appears once there is something to rate — during and after,
      // never before. Pre-filled with their own stars; a change updates the
      // same opinion rather than stacking a new one.
      + (item.phase !== 'upcoming'
        ? '<div class="g-mye__rate" data-rate-event="' + esc(item.id) + '">'
          + '<span class="g-mye__ratelabel">' + (item.phase === 'past' ? 'How was it?' : 'How is it so far?') + '</span>'
          + '<span class="g-mye__stars" role="radiogroup" aria-label="Rate this event">'
          + [1, 2, 3, 4, 5].map((n) => '<button type="button" class="g-mye__star" data-rate-star="'
            + n + '" aria-label="' + n + ' of 5">☆</button>').join('')
          + '</span><span class="g-mye__ratedone" hidden>Thank you</span></div>'
        : '')
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
        + '<p>Sign in and Gaia Healers will show every event you hold a ticket for — '
        + 'your pass, your QR code for the door, and your check-in status.</p>'
        + '<a class="g-btn g-btn--primary" href="home.html?view=profile">Sign in</a>'
        + '</section>';
    }

    if (data.ok === false) {
      // An outage is not the same as having no tickets, and must never be
      // shown as one to somebody standing at a door.
      return '<section class="g-mye g-mye--problem">'
        + '<h2>Tickets are temporarily unavailable</h2>'
        + '<p>Gaia Healers could not reach the event system just now. Your ticket is safe — '
        + 'try again in a moment, and staff can always find you by name at the desk.</p>'
        + '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-mye-retry>Try again</button>'
        + '</section>';
    }

    const offlineNote = data.offline
      ? '<p class="g-mye__offline">Shown from a saved copy — no connection right now.</p>' : '';
    const events = Array.isArray(data.events) ? data.events : [];
    if (!events.length) {
      return '<section class="g-mye g-mye--empty">'
        + '<h2>No tickets yet</h2>'
        + '<p>When you register for a Gaia Healers gathering, your ticket appears here automatically.</p>'
        + '<a class="g-btn g-btn--secondary g-btn--sm" href="home.html?view=events">Browse events</a>'
        + '</section>';
    }

    const live = events.filter((e) => e.phase === 'live');
    const upcoming = events.filter((e) => e.phase === 'upcoming');
    const past = events.filter((e) => e.phase === 'past');

    return '<div class="g-mye">' + offlineNote
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
    const notifyBlock = (window.GaiaPush && window.GaiaPush.supported())
      ? '<div class="g-ticket__notify"><button type="button" class="g-btn g-btn--secondary g-btn--sm" data-push-toggle data-event-id="' + esc(String(event.id || '')) + '"><i class="ph ph-bell" aria-hidden="true"></i> Get event alerts</button>'
        + '<p class="g-ticket__notify-hint">Schedule changes, reminders and important updates. On iPhone, add the app to your Home Screen first.</p></div>'
      : '';

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
      + notifyBlock
      + '<p class="g-ticket__hint">Show this at the door. Your screen brightness may need turning up.</p>'
      + '</div>';
  }

  function priceLabel(u) {
    if (u && u.price && typeof u.price.amount === 'number') {
      const cur = u.price.currency || 'USD';
      return cur === 'USD' ? '$' + u.price.amount : u.price.amount + ' ' + cur;
    }
    return 'See price';
  }

  function upgradesHtml(up) {
    const cur = (up.current && up.current.tier_name) ? esc(up.current.tier_name) : 'your pass';
    const items = (up.upgrades || []).map((u) => {
      const url = u.checkout_url || '';
      const name = esc(u.tier_name || u.label || 'Upgrade');
      const price = esc(priceLabel(u));
      const cta = url
        ? '<a class="g-btn g-btn--primary g-btn--sm g-upg__cta" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Upgrade &middot; ' + price + '</a>'
        : '<span class="g-upg__soon">Ask at the desk</span>';
      return '<li class="g-upg__item"><span class="g-upg__name">' + name + '</span>' + cta + '</li>';
    }).join('');
    return '<div class="g-upg">'
      + '<h3 class="g-upg__title">Upgrade your pass</h3>'
      + '<p class="g-upg__cur">Current: ' + cur + '</p>'
      + '<ul class="g-upg__list">' + items + '</ul>'
      + '<p class="g-upg__note">You keep the same QR. Your new access applies automatically after payment.</p>'
      + '</div>';
  }

  async function injectUpgrades(eventId, shell) {
    try {
      const up = await api('/api/events/' + encodeURIComponent(eventId) + '/upgrades');
      const panel = shell.querySelector('.g-ticket__panel');
      if (up && up.ok && Array.isArray(up.upgrades) && up.upgrades.length && panel
          && !panel.querySelector('.g-upg')) {
        panel.insertAdjacentHTML('beforeend', upgradesHtml(up));
      }
    } catch (_) { /* upgrades are additive; never block the ticket */ }
  }

  async function refreshTicketPanel(eventId, shell) {
    if (!document.body.contains(shell)) return;
    const data = await api('/api/events/' + encodeURIComponent(eventId) + '/ticket');
    if (data && data.ok === true) {
      keepCopy(TICKET_KEY(eventId), data);
      state.ticket = data;
      shell.innerHTML = ticketHtml(data);
      injectUpgrades(eventId, shell);
    }
  }

  function closeTicket() {
    const open = document.querySelector('.g-ticket');
    if (open) open.remove();
    // Held only for the life of the sheet: a door credential has no business
    // outliving the screen showing it.
    state.ticket = null;
    if (state._onVis) { document.removeEventListener('visibilitychange', state._onVis); state._onVis = null; }
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

    let data = await api('/api/events/' + encodeURIComponent(eventId) + '/ticket');
    if (data && data.ok === true) {
      keepCopy(TICKET_KEY(eventId), data);
    } else if (data && data.reason !== 'no_ticket_for_event' && data.authenticated !== false) {
      // Unreachable, not refused: the saved copy is the whole point of keeping one.
      const copy = readCopy(TICKET_KEY(eventId));
      if (copy) data = { ...copy.value, offline: true, offlineAt: copy.at };
    }
    if (!data || data.ok !== true) {
      shell.innerHTML = '<div class="g-ticket__panel">'
        + '<button type="button" class="g-ticket__close" data-ticket-close aria-label="Close">&times;</button>'
        + '<p class="g-ticket__event">Ticket unavailable</p>'
        + '<p class="g-ticket__hint">'
        + (data && data.reason === 'no_ticket_for_event'
          ? 'This account does not hold a ticket for that event.'
          : 'Gaia Healers could not load your ticket just now. Staff can find you by name at the desk.')
        + '</p></div>';
    } else {
      state.ticket = data;
      shell.innerHTML = ticketHtml(data);
      injectUpgrades(eventId, shell);
      // Returning from the external checkout: re-fetch so a newly paid tier shows.
      state._onVis = () => { if (document.visibilityState === 'visible') refreshTicketPanel(eventId, shell); };
      document.addEventListener('visibilitychange', state._onVis);
      if (data.offline) {
        const note = document.createElement('p');
        note.className = 'g-ticket__offline';
        note.textContent = 'Saved copy — shown without a connection. Check-in status may be out of date.';
        shell.querySelector('.g-ticket__panel')?.appendChild(note);
      }
    }

    shell.addEventListener('click', (event) => {
      if (event.target === shell || event.target.closest('[data-ticket-close]')) closeTicket();
    });
    document.addEventListener('keydown', onKey);
    shell.querySelector('.g-ticket__close')?.focus();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  const myRatings = {};   // eventId -> rating for the event overall

  function paintStars(block, rating) {
    block.querySelectorAll('[data-rate-star]').forEach((star) => {
      star.textContent = Number(star.dataset.rateStar) <= rating ? '★' : '☆';
      star.classList.toggle('is-on', Number(star.dataset.rateStar) <= rating);
    });
  }

  async function bindRating(host) {
    host.querySelectorAll('[data-rate-event]').forEach(async (block) => {
      const eventId = block.dataset.rateEvent;
      if (!(eventId in myRatings)) {
        const mine = await api('/api/events/' + encodeURIComponent(eventId) + '/feedback', { mine: true });
        const overall = mine && mine.ok && (mine.ratings || []).find((r) => r.session_id == null);
        myRatings[eventId] = overall ? overall.rating : 0;
      }
      paintStars(block, myRatings[eventId]);
      block.querySelectorAll('[data-rate-star]').forEach((star) => {
        star.addEventListener('click', async () => {
          const rating = Number(star.dataset.rateStar);
          paintStars(block, rating);   // instant; the network confirms after
          const result = await api('/api/events/' + encodeURIComponent(eventId) + '/feedback',
            { rating });
          if (result && result.ok === true) {
            myRatings[eventId] = rating;
            const done = block.querySelector('.g-mye__ratedone');
            if (done) { done.hidden = false; setTimeout(() => { done.hidden = true; }, 2500); }
          } else {
            paintStars(block, myRatings[eventId] || 0);   // truthfully revert
          }
        });
      });
    });
  }

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
      bindRating(host);
    });
  }

  document.addEventListener('gaia:superapp-rendered', render);
  document.addEventListener('DOMContentLoaded', render);

  // Push-notification opt-in for one event, from the ticket sheet. Idempotent;
  // subscribing is browser-wide but the server records it per attendee/event.
  let pushBusy = false;
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-push-toggle]');
    if (!btn || pushBusy || !window.GaiaPush) return;
    ev.preventDefault();
    const eventId = btn.getAttribute('data-event-id');
    const hint = btn.parentElement && btn.parentElement.querySelector('.g-ticket__notify-hint');
    pushBusy = true; btn.disabled = true;
    try {
      if (btn.getAttribute('data-on') === '1') {
        await window.GaiaPush.disable(eventId);
        btn.removeAttribute('data-on');
        btn.innerHTML = '<i class="ph ph-bell" aria-hidden="true"></i> Get event alerts';
      } else {
        btn.innerHTML = 'Enabling…';
        const r = await window.GaiaPush.enable(eventId);
        if (r && r.ok) {
          btn.setAttribute('data-on', '1');
          btn.innerHTML = '<i class="ph ph-bell-ringing" aria-hidden="true"></i> Alerts on';
          if (hint) hint.textContent = 'You will get schedule changes, reminders and important updates for this event.';
        } else {
          btn.innerHTML = '<i class="ph ph-bell" aria-hidden="true"></i> Get event alerts';
          const reason = (r && r.reason) || '';
          if (hint) hint.textContent = reason === 'denied' ? 'Notifications are blocked — enable them in your browser settings.'
            : reason === 'no_attendee_for_event' ? 'Alerts are available once you are a registered attendee for this event.'
            : reason === 'unsupported' ? 'Add the app to your Home Screen first, then turn on alerts.'
            : reason === 'not_configured' ? 'Alerts are not available for this event yet.'
            : 'Could not enable alerts — please try again.';
        }
      }
    } catch (e) {
      btn.innerHTML = '<i class="ph ph-bell" aria-hidden="true"></i> Get event alerts';
    }
    btn.disabled = false; pushBusy = false;
  });

  window.GaiaMyEvents = { render, openTicket, closeTicket, panelHtml, ticketStatus, dateRange };
}());
