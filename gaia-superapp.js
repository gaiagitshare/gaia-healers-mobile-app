/** Gaia Healers super-app shell.
 * Renders only verified public data and authenticated /api/member/* responses.
 * GHL remains the source of truth; unsupported progress/feed data is never invented.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[char]));
  const icon = (name, extra = '') => '<i class="ph ph-' + esc(name) + (extra ? ' ' + esc(extra) : '') + '" aria-hidden="true"></i>';
  const memberState = () => window.GaiaMember || { authed: false, data: {}, event: null, announcements: [] };
  const profile = () => memberState().data?.profile?.profile || {};
  const courseGrants = () => Array.isArray(memberState().data?.courses?.courses) ? memberState().data.courses.courses : [];
  const communities = () => Array.isArray(memberState().data?.access?.communities?.unlocked) ? memberState().data.access.communities.unlocked : [];
  const appointments = () => Array.isArray(memberState().data?.appts?.appointments) ? memberState().data.appts.appointments : [];
  const bookingLinks = () => Array.isArray(memberState().data?.appts?.bookingLinks) ? memberState().data.appts.bookingLinks : [];
  const notifications = () => Array.isArray(memberState().data?.notif?.notifications) ? memberState().data.notif.notifications : [];
  const eventData = () => memberState().event || window.GAIA?.event || null;

  // Agenda, speakers and the exhibitor directory come from the Event Manager
  // through the proxy. Published rows only — drafts never reach this app.
  const eventDetail = { id: null, data: null, loading: false, fetchedAt: 0, timer: null };
  // What an operator publishes should show up while the app is open, not only
  // after a reload. The proxy caches for 60s, so polling faster buys nothing.
  const EVENT_DETAIL_TTL_MS = 60 * 1000;
  // The live panel carries countdowns and check-in numbers, so it refreshes far
  // more often than the agenda it sits above.
  const eventLive = { id: null, data: null, loading: false, fetchedAt: 0 };
  // Audience-filtered announcements for the signed-in viewer (VIP-only notes
  // never reach a General attendee — the server decides, not the app).
  const eventUpdates = { id: null, data: null, loading: false, fetchedAt: 0 };
  const EVENT_LIVE_TTL_MS = 30 * 1000;

  function proxyBase() {
    const shared = window.GaiaApi && window.GaiaApi.base && window.GaiaApi.base(); if (shared) return shared;
    return String(
      (window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
      || 'https://api.gaiahealers.app',
    ).replace(/\/+$/, '');
  }

  // Bootstrap ids look like "event-1"; the API wants the number.
  const eventNumericId = (event) => String(event?.id || '').replace(/^event-/, '').trim();

  // Every published event, so the app is a hub rather than a page pinned to one
  // conference. ?event=N chooses which one is open.
  const eventsList = { data: null, loading: false, fetchedAt: 0 };
  const EVENTS_LIST_TTL_MS = 5 * 60 * 1000;

  function activeEventId() {
    try {
      const wanted = new URLSearchParams(window.location.search).get('event');
      if (wanted && /^\d+$/.test(wanted)) return wanted;
    } catch (_) { /* fall through to the featured event */ }
    return eventNumericId(eventData());
  }

  function loadEventsList() {
    const fresh = eventsList.data && (Date.now() - eventsList.fetchedAt) < EVENTS_LIST_TTL_MS;
    if (eventsList.loading || fresh) return;
    eventsList.loading = true;
    fetch(proxyBase() + '/api/events', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (payload && payload.ok) {
          eventsList.data = Array.isArray(payload.events) ? payload.events : [];
          eventsList.fetchedAt = Date.now();
          render();
        }
      })
      .catch(() => { /* the featured event still renders */ })
      .finally(() => { eventsList.loading = false; });
  }

  function eventDateRange(item) {
    const start = item.startDate ? new Date(item.startDate) : null;
    const end = item.endDate ? new Date(item.endDate) : null;
    if (!start || !Number.isFinite(+start)) return '';
    const fmt = (date, withYear) => new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}),
    }).format(date);
    if (!end || !Number.isFinite(+end)) return fmt(start, true);
    return fmt(start, false) + ' – ' + fmt(end, true);
  }

  // Only rendered when there is more than one event to choose between; a single
  // event needs no picker above its own page.
  function upcomingEventsSection(currentId) {
    const items = Array.isArray(eventsList.data) ? eventsList.data : [];
    if (items.length < 2) return '';
    return '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Gaia Healers gatherings</p><h2>Upcoming events</h2></div></div>'
      + items.map((item) => {
        const active = String(item.id) === String(currentId);
        const meta = [eventDateRange(item), item.venue].filter(Boolean).join(' · ');
        return '<a class="g-super-row' + (active ? ' is-active' : '') + '" href="home.html?view=events&event=' + esc(item.id) + '">'
          + '<span class="g-super-row__icon">' + icon('calendar-blank') + '</span>'
          + '<span><strong>' + esc(item.name) + '</strong><em>' + esc(meta) + '</em></span>'
          + (active ? '<span class="g-event-current">Open</span>' : icon('caret-right')) + '</a>';
      }).join('')
      + '</section>';
  }

  function timeAgo(value) {
    const then = new Date(value);
    if (!Number.isFinite(+then)) return '';
    const minutes = Math.round((Date.now() - then.getTime()) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    const days = Math.round(hours / 24);
    if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(then);
  }

  // Organiser updates, shown whether or not live mode is on. The useful ones —
  // travel, hotel block, "the schedule is up" — go out weeks beforehand.
  // Which announcements this device has already seen, per event. Kept locally:
  // "seen" is a fact about this screen, not about the person's account, and it
  // must keep working for visitors who never sign in.
  const seenKey = (eventId) => 'gaia:updates-seen:' + eventId;
  function highestSeen(eventId) {
    try { return Number(localStorage.getItem(seenKey(eventId)) || 0); } catch (_) { return 0; }
  }
  function markUpdatesSeen(eventId, items) {
    const top = Math.max(0, ...(items || []).map((a) => Number(a.id) || 0));
    if (!top) return;
    try {
      if (top > highestSeen(eventId)) localStorage.setItem(seenKey(eventId), String(top));
    } catch (_) { /* private browsing */ }
  }
  function unseenCount(eventId, items) {
    const seen = highestSeen(eventId);
    return (items || []).filter((a) => Number(a.id) > seen).length;
  }

  /** A brief, self-dismissing notice for something that just changed. */
  function updateToast(title) {
    if (document.querySelector('.g-update-toast')) return;   // one at a time
    const el = document.createElement('div');
    el.className = 'g-update-toast';
    el.setAttribute('role', 'status');
    el.innerHTML = '<strong>Event update</strong><span>' + esc(title) + '</span>';
    document.body.appendChild(el);
    setTimeout(() => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 400); }, 6000);
  }

  function updatesSection(detail, live) {
    const eid = detail && detail.event && detail.event.id;
    const items = (String(eventUpdates.id) === String(eid) && Array.isArray(eventUpdates.data))
      ? eventUpdates.data
      : (Array.isArray(detail?.announcements) ? detail.announcements : []);
    if (!items.length) return '';
    // While the live panel is up it already carries the latest few; repeating
    // them immediately below would just be noise.
    const skip = live && live.live_enabled ? new Set((live.announcements || []).map((a) => a.id)) : new Set();
    const rest = items.filter((item) => !skip.has(item.id));
    if (!rest.length) return '';
    return '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">From the organisers</p><h2>Event updates</h2></div></div>'
      + rest.map((item) => '<div class="g-live-note">'
        + (item.is_pinned ? '<em class="g-update-pin">' + icon('push-pin') + ' Pinned</em>' : '')
        + '<strong>' + esc(item.title) + '</strong>'
        + (item.body ? '<span>' + esc(item.body) + '</span>' : '')
        + '<time>' + esc(timeAgo(item.created_at)) + '</time></div>').join('')
      + '</section>';
  }

  function sponsorsSection(detail) {
    const sponsors = Array.isArray(detail?.sponsors) ? detail.sponsors : [];
    if (!sponsors.length) return '';
    return '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Made possible by</p><h2>Sponsors</h2></div></div>'
      + '<div class="g-live-sponsor-row">' + sponsors.map((sponsor) => {
        const inner = (sponsor.logo_url ? '<img src="' + esc(sponsor.logo_url) + '" alt="' + esc(sponsor.name) + '" loading="lazy" />' : '')
          + '<span><strong>' + esc(sponsor.name) + '</strong><em>' + esc(sponsor.tier || 'partner') + '</em></span>';
        return sponsor.website
          ? '<a class="g-live-sponsor" href="' + esc(sponsor.website) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>'
          : '<div class="g-live-sponsor">' + inner + '</div>';
      }).join('') + '</div></section>';
  }

  function loadEventDetail(id) {
    if (!id || !/^\d+$/.test(id)) return;
    const fresh = eventDetail.id === id && (Date.now() - eventDetail.fetchedAt) < EVENT_DETAIL_TTL_MS;
    if (eventDetail.loading || fresh) return;
    eventDetail.loading = true;
    fetch(proxyBase() + '/api/events/' + encodeURIComponent(id), {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
      // A gateway 502 RESOLVES rather than rejects, and at a venue that is the
      // common failure — the phone has wifi, the upstream does not. Thrown here
      // so both kinds of unreachable land in the same fallback below.
      .then((response) => { if (!response.ok) throw new Error('http ' + response.status); return response.json(); })
      .then((payload) => {
        if (payload && payload.ok) {
          eventDetail.id = id;
          eventDetail.data = payload;
          eventDetail.fetchedAt = Date.now();
          // Snapshot for the hall with no signal: the agenda, the map and the
          // programme keep working from the last good copy. Same pattern and
          // same reasoning as the offline ticket in gaia-myevents.js.
          try {
            localStorage.setItem('gaia:event:' + id,
              JSON.stringify({ at: Date.now(), value: payload }));
          } catch (_) { /* storage full: offline degrades, nothing else */ }
          render();
        }
      })
      .catch(() => {
        // Unreachable — a venue basement, not a missing event. Fall back to the
        // snapshot so the person can still read where they need to be.
        if (eventDetail.id === id && eventDetail.data) return;
        try {
          const raw = JSON.parse(localStorage.getItem('gaia:event:' + id) || 'null');
          if (raw && raw.value) {
            eventDetail.id = id;
            eventDetail.data = { ...raw.value, offline: true, offlineAt: raw.at };
            eventDetail.fetchedAt = Date.now();
            render();
          }
        } catch (_) { /* no snapshot; the loading card stays */ }
      })
      .finally(() => { eventDetail.loading = false; });
  }

  // Session times are venue-local and must be shown as written — re-offsetting
  // them into the reader's timezone would move a 9:00 AM talk in Orlando.
  function sessionTime(value) {
    const time = String(value || '').split('T')[1];
    if (!time) return '';
    const [hourText, minute] = time.split(':');
    const hour = Number(hourText);
    if (!Number.isFinite(hour)) return '';
    const suffix = hour >= 12 ? 'PM' : 'AM';
    return (hour % 12 === 0 ? 12 : hour % 12) + ':' + minute + ' ' + suffix;
  }

  function loadEventUpdates(id) {
    const fresh = eventUpdates.id === id && (Date.now() - eventUpdates.fetchedAt) < EVENT_LIVE_TTL_MS;
    if (eventUpdates.loading || fresh) return;
    eventUpdates.loading = true;
    fetch(proxyBase() + '/api/events/' + encodeURIComponent(id) + '/updates', { headers: { Accept: 'application/json' }, credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        if (payload && payload.ok) {
          eventUpdates.id = id;
          eventUpdates.data = Array.isArray(payload.announcements) ? payload.announcements : [];
          eventUpdates.fetchedAt = Date.now();
          render();
        }
      })
      .catch(() => {})
      .finally(() => { eventUpdates.loading = false; });
  }

  function loadEventLive(id) {
    if (!id || !/^\d+$/.test(id)) return;
    const fresh = eventLive.id === id && (Date.now() - eventLive.fetchedAt) < EVENT_LIVE_TTL_MS;
    if (eventLive.loading || fresh) return;
    eventLive.loading = true;
    fetch(proxyBase() + '/api/events/' + encodeURIComponent(id) + '/live', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (payload && payload.ok) {
          eventLive.id = id;
          eventLive.data = payload.live;
          eventLive.fetchedAt = Date.now();
          maybeToastNew(id, payload.live);
          render();
        }
      })
      .catch(() => { /* the rest of the Events view still renders */ })
      .finally(() => { eventLive.loading = false; });
  }

  function minutesLabel(minutes) {
    if (minutes == null) return '';
    if (minutes < 1) return 'now';
    if (minutes < 60) return minutes + ' min';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours + 'h' + (rest ? ' ' + rest + 'm' : '');
  }

  // Only rendered once an operator switches the live page on, so a half-built
  // agenda never shows up as "happening now".
  // Announcements arriving mid-refresh get a toast — the person is looking at
  // some other tab, and a room change they do not see is a room they walk to
  // wrongly. Only genuinely new ids toast, and only while on this event.
  let toastedUpTo = 0;
  function maybeToastNew(eventId, live) {
    const items = (live && live.announcements) || [];
    const seen = highestSeen(eventId);
    const fresh = items.filter((a) => Number(a.id) > Math.max(seen, toastedUpTo));
    if (!fresh.length) return;
    toastedUpTo = Math.max(...fresh.map((a) => Number(a.id)));
    updateToast(fresh[0].title || 'Something changed');
  }

  function liveSection(live) {
    if (!live || !live.live_enabled) return '';
    const counters = live.counters || {};
    const banner = live.live_message
      ? '<p class="g-live-banner">' + esc(live.live_message) + '</p>' : '';

    const nowCards = (live.now || []).map((session) => {
      const who = (session.speakers || []).map((s) => s.name).filter(Boolean).join(', ');
      const meta = [session.room, session.track].filter(Boolean).join(' · ');
      const left = session.minutes_remaining;
      return '<article class="g-live-now"><p class="g-super-kicker">Happening now</p>'
        + '<h3>' + esc(session.title) + '</h3>'
        + (who ? '<p>' + esc(who) + '</p>' : '')
        + (meta ? '<p>' + esc(meta) + '</p>' : '')
        + (left != null ? '<p class="g-live-remaining">' + esc(minutesLabel(left)) + ' remaining</p>' : '')
        + '</article>';
    }).join('');

    const betweenSessions = live.status === 'ended'
      ? 'This gathering has finished.'
      : live.status === 'before'
        ? 'The programme has not started yet.'
        : 'Between sessions — the exhibit hall is open.';
    const nowBlock = nowCards || '<article class="g-live-now"><p class="g-super-kicker">Happening now</p><p>' + esc(betweenSessions) + '</p></article>';

    const nextBlock = (live.next || []).length
      ? '<div class="g-live-next"><p class="g-super-kicker">Up next</p>'
        + live.next.map((session) => {
          const when = session.minutes_until != null && session.minutes_until < 90
            ? 'in ' + minutesLabel(session.minutes_until)
            : sessionTime(session.start_time);
          const meta = [session.room, (session.speakers || []).map((s) => s.name).join(', ')].filter(Boolean).join(' · ');
          return '<div class="g-live-next__item"><time>' + esc(when) + '</time><div><strong>' + esc(session.title) + '</strong>'
            + (meta ? '<span>' + esc(meta) + '</span>' : '') + '</div></div>';
        }).join('') + '</div>'
      : '';

    const tiles = [
      { value: counters.checked_in, label: 'Checked in' },
      { value: counters.attendees, label: 'Registered' },
      { value: counters.exhibitors, label: 'Exhibitors' },
      { value: counters.sessions_today, label: 'Today' },
    ].map((tile) => '<div class="g-live-stat"><b>' + esc(tile.value == null ? 0 : tile.value) + '</b><span>' + esc(tile.label) + '</span></div>').join('');

    const announcements = (live.announcements || []).length
      ? '<div class="g-live-notes">' + live.announcements.map((item) => '<div class="g-live-note"><strong>'
        + esc(item.title) + '</strong>' + (item.body ? '<span>' + esc(item.body) + '</span>' : '') + '</div>').join('') + '</div>'
      : '';

    const sponsors = (live.sponsors || []).length
      ? '<div class="g-live-sponsors"><p class="g-super-kicker">With thanks to our sponsors</p><div class="g-live-sponsor-row">'
        + live.sponsors.map((sponsor) => {
          const inner = (sponsor.logo_url ? '<img src="' + esc(sponsor.logo_url) + '" alt="' + esc(sponsor.name) + '" loading="lazy" />' : '')
            + '<span><strong>' + esc(sponsor.name) + '</strong><em>' + esc(sponsor.tier || 'partner') + '</em></span>';
          return sponsor.website
            ? '<a class="g-live-sponsor" href="' + esc(sponsor.website) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>'
            : '<div class="g-live-sponsor">' + inner + '</div>';
        }).join('') + '</div></div>'
      : '';

    return '<section class="g-live-panel"><div class="g-live-head"><span class="g-live-dot" aria-hidden="true"></span>'
      + '<p class="g-super-kicker">Live now · ' + esc((live.timezone || '').replace(/_/g, ' ')) + '</p></div>'
      + banner + nowBlock + nextBlock + '<div class="g-live-stats">' + tiles + '</div>' + announcements + sponsors
      + '</section>';
  }

  // Refresh while the Events view is on screen and the tab is in the foreground,
  // so a backgrounded app is not making requests for nothing. The loop keeps
  // rescheduling either way: a phone that locks and wakes must start refreshing
  // again, not stay frozen on whatever it last saw.
  function scheduleEventRefresh(root, id) {
    if (eventDetail.timer) clearTimeout(eventDetail.timer);
    eventDetail.timer = setTimeout(() => {
      if (!root.isConnected) return; // view was replaced; the next render re-arms this
      if (root.offsetParent !== null && document.visibilityState === 'visible') {
        loadEventDetail(id);
        loadEventLive(id);
        loadEventUpdates(id);
      }
      scheduleEventRefresh(root, id);
    }, EVENT_LIVE_TTL_MS);
  }

  // Coming back to the app should show what changed while it was away, without
  // waiting out the poll interval.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const root = $('events-body');
    if (!root || !root.isConnected || root.offsetParent === null) return;
    loadEventDetail(activeEventId());
    loadEventLive(activeEventId());
  });

  function agendaSection(detail) {
    const days = Array.isArray(detail?.agenda?.days) ? detail.agenda.days : [];
    if (!days.length) return '';
    const zone = detail?.event?.timezone ? ' · times shown in ' + esc(detail.event.timezone.replace(/_/g, ' ')) : '';
    // A ticket holder's own picks come before the full programme: by the second
    // morning that shorter list is the only one anybody opens.
    const mine = window.GaiaMySchedule ? window.GaiaMySchedule.panelHtml(detail?.event?.timezone) : '';
    return mine + '<section class="g-event-timeline"><p class="g-super-kicker">Published schedule' + zone + '</p><h2>Agenda</h2>'
      + days.map((day) => '<div class="g-event-day"><h3>' + esc(day.label || day.date) + '</h3>'
        + (day.sessions || []).map((session) => {
          const when = [sessionTime(session.start_time), sessionTime(session.end_time)].filter(Boolean).join(' – ');
          const meta = [session.room, session.track].filter(Boolean).join(' · ');
          const who = (session.speakers || []).map((speaker) => speaker.name).filter(Boolean).join(', ');
          // The save control is rendered by gaia-myschedule.js, which returns an
          // empty string for anyone without a ticket — so the agenda stays a
          // plain programme for the public and gains a verb for attendees.
          const save = window.GaiaMySchedule ? window.GaiaMySchedule.saveButtonHtml(session.id) : '';
          // Register appears only on sessions that take registrations, and only
          // for ticket holders — the same rule as the save star.
          const reg = window.GaiaMySchedule ? window.GaiaMySchedule.registerButtonHtml(session) : '';
          return '<div class="g-event-timeline__item"><time>' + esc(when) + '</time><div><strong>' + esc(session.title) + '</strong>'
            + (who ? '<span>' + esc(who) + '</span>' : '')
            + (meta ? '<span>' + esc(meta) + '</span>' : '')
            + (session.description ? '<span>' + esc(session.description) + '</span>' : '')
            + (reg ? '<span class="g-event-timeline__reg">' + reg + '</span>' : '')
            + '</div>' + save + '</div>';
        }).join('')
        + '</div>').join('')
      + '</section>';
  }

  // Pin glyphs by kind — text labels ride along, the glyph is just a landmark.
  const PLACE_GLYPHS = {
    room: '🚪', booth: '🛍', stage: '🎤', registration: '🎫',
    restroom: '🚻', food: '🍽', entrance: '⬆', help: 'ℹ', other: '📍',
  };

  function mapSection(detail) {
    const venue = detail?.map;
    if (!venue) return '';
    const places = Array.isArray(venue.places) ? venue.places : [];
    const exhibitorsById = {};
    (detail.exhibitors || []).forEach((v) => { exhibitorsById[v.id] = v; });

    const pins = places.map((place) => {
      const exhibitor = place.exhibitor_id ? exhibitorsById[place.exhibitor_id] : null;
      const label = place.name + (exhibitor ? ' · ' + exhibitor.company_name : '');
      return '<button type="button" class="g-map__pin" style="left:' + Number(place.x)
        + '%;top:' + Number(place.y) + '%" data-map-place="' + esc(place.id) + '"'
        + ' aria-label="' + esc(label) + '">'
        + '<span class="g-map__glyph">' + (PLACE_GLYPHS[place.kind] || PLACE_GLYPHS.other) + '</span>'
        + '<span class="g-map__name">' + esc(place.name) + '</span>'
        + '</button>';
    }).join('');

    const legend = places.map((place) => {
      const exhibitor = place.exhibitor_id ? exhibitorsById[place.exhibitor_id] : null;
      return '<button type="button" class="g-map__row" data-map-place="' + esc(place.id) + '">'
        + '<span class="g-map__glyph">' + (PLACE_GLYPHS[place.kind] || PLACE_GLYPHS.other) + '</span>'
        + '<span><strong>' + esc(place.name) + '</strong>'
        + (exhibitor ? '<em>' + esc(exhibitor.company_name) + '</em>'
          : (place.description ? '<em>' + esc(place.description) + '</em>' : ''))
        + '</span></button>';
    }).join('');

    return '<section class="g-map"><p class="g-super-kicker">Find your way</p><h2>Venue map</h2>'
      + (venue.map_image_url
        ? '<div class="g-map__plan"><img src="' + esc(venue.map_image_url) + '" alt="Venue floor plan" />' + pins + '</div>'
        // No plan image yet: the list of places still answers the question.
        : '')
      + (legend ? '<div class="g-map__legend">' + legend + '</div>' : '')
      + '</section>';
  }

  function speakersSection(detail) {
    const speakers = Array.isArray(detail?.speakers) ? detail.speakers : [];
    if (!speakers.length) return '';
    // Cards rather than a stack of rows: a speaker is a face and a claim, and
    // at three columns on a laptop the whole line-up is one glance instead of
    // a scroll. The bio is clamped so one long paragraph cannot set the height
    // of every card beside it.
    return '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Who is speaking</p><h2>Speakers</h2>'
      + '<p class="g-super-count">' + speakers.length + (speakers.length === 1 ? ' speaker' : ' speakers') + '</p></div></div>'
      + '<div class="g-speaker-grid">'
      + speakers.map((speaker) => {
          const lead = speaker.photo_url
            ? '<span class="g-speaker__photo"><img src="' + esc(speaker.photo_url) + '" alt="" loading="lazy" decoding="async"></span>'
            : '<span class="g-speaker__photo g-speaker__photo--none">' + icon('microphone-stage') + '</span>';
          const meta = esc([speaker.role, speaker.company].filter(Boolean).join(' \u00b7 '));
          const bio = speaker.bio ? '<p class="g-speaker__bio">' + esc(speaker.bio) + '</p>' : '';
          return '<article class="g-speaker">' + lead
            + '<div class="g-speaker__text"><h3>' + esc(speaker.name) + '</h3>'
            + (meta ? '<p class="g-speaker__meta">' + meta + '</p>' : '') + bio + '</div></article>';
        }).join('')
      + '</div></section>';
  }

  function directorySection(detail) {
    const exhibitors = Array.isArray(detail?.exhibitors) ? detail.exhibitors : [];
    // The list arrives already filtered by the server: only stands an operator
    // has put in the directory are ever in this payload. Nothing here decides
    // who is visible, and nothing here can widen it.
    const rows = exhibitors.slice().sort((a, b) => String(a.company_name || '')
      .localeCompare(String(b.company_name || ''), undefined, { sensitivity: 'base' }));
    const head = '<section class="g-super-list" data-directory><div class="g-super-section-head"><div>'
      + '<p class="g-super-kicker">Exhibit hall</p><h2>Exhibitor directory</h2>'
      + '<p class="g-super-sub" data-dir-count>' + rows.length
      + (rows.length === 1 ? ' stand' : ' stands') + '</p>'
      + '</div></div>';

    if (!rows.length) {
      return head + '<p class="g-empty">No stands are listed yet. They appear here as each one '
        + 'is added to the directory.</p></section>';
    }

    // Each row opens the stand's OWN page rather than firing the attendee
    // straight out to a company website. Their page carries the booth number,
    // what they do and how to reach them; a link out loses all of that, and
    // loses the person too.
    const base = (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production
      && window.GAIA_APP_URLS.production.proxy) || '';
    const search = '<div class="g-dir-search">'
      + '<label class="g-sr-only" for="g-dir-q">Search exhibitors by name or booth</label>'
      + '<input class="g-input" type="search" id="g-dir-q" data-dir-q autocomplete="off"'
      + ' placeholder="Search by name or booth" enterkeyhint="search">'
      + '</div>';

    const cards = rows.map((vendor) => {
      const booth = vendor.booth_number ? String(vendor.booth_number).replace(/\.0$/, '') : '';
      const meta = [
        booth ? 'Booth ' + booth : '',
        vendor.tables ? vendor.tables + (vendor.tables > 1 ? ' tables' : ' table') : '',
      ].filter(Boolean).join(' \u00b7 ');
      const blurb = vendor.tagline || vendor.description || '';
      const name = vendor.company_name || '';
      // A logo is decorative beside the name it sits next to, so its alt is
      // empty on purpose. A photo of the stand is not decorative, so it is
      // described — and it only stands in where there is no logo at all.
      const photo = (Array.isArray(vendor.photos) && vendor.photos.length && vendor.photos[0].url)
        ? vendor.photos[0] : null;
      let tile;
      if (vendor.logo_url) {
        tile = '<img src="' + esc(vendor.logo_url) + '" alt="" loading="lazy">';
      } else if (photo) {
        tile = '<img class="is-photo" src="' + esc(photo.url) + '" loading="lazy" alt="'
          + esc(photo.caption || (name + ' at their stand')) + '">';
      } else {
        tile = '<b>' + esc((name || 'G').trim().charAt(0).toUpperCase()) + '</b>';
      }
      const inner = '<span class="g-vendor__logo' + (vendor.logo_on_dark ? ' is-dark' : '') + '">'
        + tile + '</span>'
        + '<span class="g-vendor__text"><strong>' + esc(name) + '</strong>'
        + (meta ? '<em>' + esc(meta) + '</em>' : '')
        + (blurb ? '<span class="g-vendor__blurb">' + esc(blurb) + '</span>' : '')
        + '</span>';
      // The searchable text is put on the element rather than read back out of
      // the DOM, so filtering never depends on how the row happens to be marked
      // up and a rename cannot quietly break search.
      const key = esc((name + ' ' + booth).toLowerCase());
      return base
        ? '<a class="g-vendor" data-dir-row data-dir-key="' + key + '" href="'
          + esc(base + '/v/' + vendor.id) + '" target="_blank" rel="noopener noreferrer">'
          + inner + icon('arrow-up-right') + '</a>'
        : '<div class="g-vendor" data-dir-row data-dir-key="' + key + '">' + inner + '</div>';
    }).join('');

    return head + search + '<div class="g-vendors">' + cards + '</div>'
      + '<p class="g-empty" data-dir-none hidden>Nothing matches that. Try part of a company name, '
      + 'or a booth number.</p></section>';
  }

  // Filtering happens in the DOM rather than through a re-render, so the caret
  // and the keyboard stay exactly where the person put them while they type.
  function bindDirectory(root) {
    const sec = root.querySelector('[data-directory]');
    if (!sec) return;
    const input = sec.querySelector('[data-dir-q]');
    if (!input) return;
    const rows = Array.prototype.slice.call(sec.querySelectorAll('[data-dir-row]'));
    const count = sec.querySelector('[data-dir-count]');
    const none = sec.querySelector('[data-dir-none]');
    const apply = () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      rows.forEach((row) => {
        const hit = !q || (row.getAttribute('data-dir-key') || '').indexOf(q) !== -1;
        row.hidden = !hit;
        if (hit) shown += 1;
      });
      if (none) none.hidden = shown !== 0;
      if (count) {
        count.textContent = q
          ? shown + ' of ' + rows.length + (rows.length === 1 ? ' stand' : ' stands')
          : rows.length + (rows.length === 1 ? ' stand' : ' stands');
      }
    };
    input.addEventListener('input', apply);
    input.addEventListener('search', apply);
  }

  function dateLabel() {
    return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());
  }

  function eventDate(event) {
    if (!event) return '';
    const start = event.startDate ? new Date(event.startDate) : null;
    const end = event.endDate ? new Date(event.endDate) : null;
    if (start && end && Number.isFinite(+start) && Number.isFinite(+end)) {
      return start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        + ' – ' + end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
    return String(event.date || '');
  }

  function upcomingAppointments() {
    const now = Date.now();
    return appointments()
      .filter((item) => Number.isFinite(Date.parse(item.startTime || '')) && Date.parse(item.startTime) > now)
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  }

  function appointmentWhen(item) {
    const date = new Date(item.startTime || '');
    if (!Number.isFinite(+date)) return '';
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      + ' · ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function stateMeta(base, count, singular, plural) {
    if (!memberState().authed) return base;
    if (!count) return 'Nothing available yet';
    return count + ' ' + (count === 1 ? singular : plural);
  }

  function serviceLink(view, iconName, title, detail) {
    return '<a class="g-super-service" href="home.html?view=' + esc(view) + '">'
      + '<span class="g-super-service__icon">' + icon(iconName) + '</span>'
      + '<span class="g-super-service__copy"><strong>' + esc(title) + '</strong><small>' + esc(detail) + '</small></span>'
      + icon('caret-right', 'g-super-service__arrow') + '</a>';
  }

  /*
   * GUEST HOME -- the signed-out landing, built as one page on one grid:
   *
   *   hero        what Gaia is, one action, and the artwork beside it
   *   explore     Energy check featured, the other free tools around it
   *   join        why sign up, one Join free, sign in and plans quieter
   *   gathering   the next event, with its artwork at a size it deserves
   *
   * Classes are g-guest / gg-* so none of the layered hero and tool rules
   * from earlier Home layouts reach it; its own sheet is gaia-guest-home.css.
   */
  function guestHero(dayGreeting) {
    const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
    return '<section class="gg-hero"><div class="gg-hero__copy">'
      + '<p class="gg-hero__greet">' + esc(dayGreeting) + ' <span aria-hidden="true">·</span> ' + esc(day) + '</p>'
      + '<h1>Understand your energy. <span>Find what supports you.</span></h1>'
      + '<p class="gg-hero__lede">Check in with yourself, explore free Gaia tools, and discover your next step.</p>'
      + '<div class="gg-hero__actions">'
      + '<a class="g-btn g-btn--primary gg-cta" href="home.html?view=wellness&tab=check">' + icon('sparkle') + ' Check my energy ' + icon('arrow-right', 'gg-cta__arrow') + '</a>'
      + '<a class="g-btn g-btn--secondary gg-cta-quiet" href="#gg-explore" data-gg-explore>Explore Gaia</a></div>'
      + '<p class="gg-hero__note">' + icon('check-circle') + ' Free — no account needed to start</p></div>'
      + '<div class="gg-hero__art"><picture>'
      + '<source media="(min-width: 1060px)" type="image/webp" srcset="assets/gaia-hero-moon.webp" />'
      + '<source type="image/webp" srcset="assets/gaia-hero-moon-wide.webp" />'
      + '<img src="assets/gaia-hero-moon-wide.png" alt="Person meditating in lotus pose under a full moon over mountains" width="1024" height="576" loading="eager" fetchpriority="high" /></picture></div></section>';
  }

  function guestExplore() {
    // Energy check leads; the rest are the same free doors as before, plus one
    // way to every tool so the grid ends on a full row.
    const tools = [
      ['wellness&tool=pulse', 'heartbeat', 'Energy Pulse', 'Camera or tap pulse read', 'var(--g-teal)'],
      ['wellness&tool=breath', 'wind', 'Coherence Breath', 'Paced resonance breathing', 'var(--g-accent)'],
      ['wellness&tab=horoscope', 'moon-stars', 'Horoscope', 'Your reflective daily guidance', 'var(--g-teal)'],
      ['wellness&tab=chakras', 'circles-three-plus', 'Chakra match', 'Explore centres and products', 'var(--g-purple)'],
      ['wellness&tool=colour', 'palette', 'Colour test', 'Five free questions', 'var(--g-gold)'],
      ['wellness&tool=chakra', 'circles-three-plus', 'Chakra Quiz', 'Find your focus centre', 'var(--g-gold)'],
      ['wellness&tool=match', 'heart', 'Energy Match', 'Your compatibility', 'var(--g-accent)'],
      ['wellness', 'squares-four', 'All energy tools', 'Everything in one place', 'var(--g-text-muted)'],
    ];
    return '<section class="gg-explore" id="gg-explore" aria-labelledby="gg-explore-title">'
      + '<div class="gg-head"><p class="g-super-kicker">Explore free</p><h2 id="gg-explore-title">Start with a two-minute check-in</h2></div>'
      + '<div class="gg-explore__grid">'
      + '<a class="gg-feature" href="home.html?view=wellness&tab=check"><span class="gg-feature__icon">' + icon('sparkle') + '</span>'
      + '<span class="gg-feature__copy"><small>Most people start here</small><strong>Energy check</strong>'
      + '<span>Today’s body point and a short practice to match how you feel.</span></span>'
      + '<span class="gg-feature__go">Start the check ' + icon('arrow-right', 'gg-cta__arrow') + '</span></a>'
      + tools.map((t) => '<a class="gg-tool" style="--tool:' + t[4] + '" href="home.html?view=' + t[0] + '"><span class="gg-tool__icon">' + icon(t[1]) + '</span>'
        + '<span class="gg-tool__copy"><strong>' + esc(t[2]) + '</strong><small>' + esc(t[3]) + '</small></span>' + icon('arrow-right', 'gg-tool__arrow') + '</a>').join('')
      + '</div></section>';
  }

  function guestJoin() {
    return '<section class="gg-join" aria-labelledby="gg-join-title">'
      + '<div class="gg-join__visual" aria-hidden="true"><span class="gg-join__orb"><img src="assets/gaia-mark.svg" alt="" width="64" height="64" /></span></div>'
      + '<div class="gg-join__body"><p class="g-super-kicker">Join free</p><h2 id="gg-join-title">Make Gaia Healers yours</h2>'
      + '<p class="gg-join__lede">A name and an email — we send a one-tap sign-in link. No password.</p>'
      + '<ul class="gg-join__list">'
      + '<li>' + icon('check-circle') + '<span>Save your Daily Energy, streak &amp; readings</span></li>'
      + '<li>' + icon('check-circle') + '<span>Your real courses, certifications &amp; plan — synced automatically</span></li>'
      + '<li>' + icon('check-circle') + '<span>Events, bookings, community &amp; Store, all in one home</span></li>'
      + '</ul>'
      + '<div class="gg-join__actions"><button type="button" class="g-btn g-btn--primary gg-cta" data-super-join>' + icon('sparkle') + ' Join free ' + icon('arrow-right', 'gg-cta__arrow') + '</button>'
      + '<button type="button" class="gg-link" data-super-signin>Already a member? <strong>Sign in</strong></button></div>'
      + '<a class="gg-join__plans" href="home.html?view=store&tab=membership">Compare membership plans ' + icon('caret-right') + '</a>'
      + '</div></section>';
  }

  /** The guest Join section on a page that is not the guest Home (Bookings,
   * Inbox): its own container so the section lays out by its own width. */
  function guestJoinBlock() {
    return '<div class="g-guest g-guest-inline">' + guestJoin() + '</div>';
  }

  function guestEvent() {
    loadEventsList();
    const event = upcomingFeatureEvents()[0] || eventData();
    if (!event?.name) return '';
    const art = event.heroImageUrl || 'assets/gaia-elevate-poster.jpg';
    const when = eventDate(event), location = event.location || event.venue || '', countdown = eventCountdown(event);
    const register = event.registrationUrl ? '<a class="g-btn g-btn--primary gg-cta" href="' + esc(event.registrationUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(event.registrationLabel || 'Get tickets') + ' ' + icon('arrow-up-right', 'gg-cta__arrow') + '</a>' : '';
    return '<section class="gg-event" aria-labelledby="gg-event-title"><div class="gg-event__art"><img src="' + esc(art) + '" alt="" width="760" height="639" loading="lazy" /></div>'
      + '<div class="gg-event__body"><p class="g-super-kicker">Next gathering' + (countdown ? ' <span class="gg-badge">' + esc(countdown) + '</span>' : '') + '</p>'
      + '<h2 id="gg-event-title">' + esc(event.name) + '</h2>'
      + (when ? '<p class="gg-event__meta">' + icon('calendar-dots') + '<span>' + esc(when) + '</span></p>' : '')
      + (location ? '<p class="gg-event__meta">' + icon('map-pin') + '<span>' + esc(location) + '</span></p>' : '')
      + '<div class="gg-event__actions">' + register + '<a class="g-btn g-btn--secondary gg-cta-quiet" href="home.html?view=events">Event details</a></div></div></section>';
  }

  /** "in 12 days", "Tomorrow", "Happening now" — whichever is true. */
  function eventCountdown(event) {
    const start = event.startAt || event.startDate;
    const end = event.endAt || event.endDate;
    const startMs = start ? Date.parse(start) : NaN;
    const endMs = end ? Date.parse(end) : NaN;
    if (!Number.isFinite(startMs)) return '';
    const now = Date.now();
    if (Number.isFinite(endMs) && now >= startMs && now <= endMs) return 'Happening now';
    if (now > startMs) return '';
    const days = Math.ceil((startMs - now) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days < 31) return 'In ' + days + ' days';
    const months = Math.round(days / 30);
    return 'In ' + months + ' month' + (months === 1 ? '' : 's');
  }

  /**
   * The next gathering, given the top of the home screen.
   *
   * Home uses the designated Elevate conference artwork. Copy, dates, and the
   * registration link still come from the published event — never invented.
   */
  // Upcoming events (not yet ended), earliest first — the slides of the home carousel.
  function upcomingFeatureEvents() {
    const list = Array.isArray(eventsList.data) ? eventsList.data.slice() : [];
    const now = Date.now();
    return list.filter((e) => {
      const end = Date.parse(e.endAt || e.endDate || e.startAt || e.startDate || '');
      return !Number.isFinite(end) || end >= now;
    }).sort((a, b) => (Date.parse(a.startDate || a.startAt || '') || 0) - (Date.parse(b.startDate || b.startAt || '') || 0));
  }

  // The home 'Next gathering' as a swipeable carousel when more than one event
  // is upcoming; a single event just renders its own card, no carousel chrome.
  function eventFeatureCarousel() {
    loadEventsList();
    const events = upcomingFeatureEvents();
    if (events.length === 0) return eventFeature();
    if (events.length === 1) return eventFeature(events[0]);
    const slides = events.map((e) => '<div class="g-event-carousel__slide">' + eventFeature(e) + '</div>').join('');
    const dots = events.map((_, i) => '<button type="button" class="g-event-carousel__dot' + (i === 0 ? ' is-active' : '')
      + '" data-carousel-dot="' + i + '" aria-label="Show event ' + (i + 1) + '"></button>').join('');
    return '<section class="g-event-carousel" data-event-carousel>'
      + '<div class="g-event-carousel__track" data-carousel-track>' + slides + '</div>'
      + '<div class="g-event-carousel__dots">' + dots + '</div>'
      + '</section>';
  }

  function eventFeature(event) {
    event = event || eventData();
    if (!event?.name) {
      return '<section class="g-super-event g-super-event--empty"><div><p class="g-super-kicker">Events</p><h2>Next gathering</h2>'
        + '<p>The next confirmed Gaia Healers event will appear here when it is published.</p></div><a href="home.html?view=events" class="g-btn g-btn--secondary">View events</a></section>';
    }
    const location = event.location || event.venue || '';
    const when = eventDate(event);
    const countdown = eventCountdown(event);
    const art = event.heroImageUrl || 'assets/gaia-elevate-hero.png';
    // Only our own artwork gets a WebP source. A heroImageUrl supplied by the
    // Event Manager is a URL we know nothing about, and guessing that a .webp
    // sits beside it would show a broken hero.
    const artSource = event.heroImageUrl
      ? '' : '<source type="image/webp" srcset="assets/gaia-elevate-hero.webp" />';
    const register = event.registrationUrl
      ? '<a class="g-btn g-btn--primary g-btn--sm" href="' + esc(event.registrationUrl) + '" target="_blank" rel="noopener noreferrer">'
        + esc(event.registrationLabel || 'Get tickets') + '</a>'
      : '';

    return '<section class="g-feature-event">'
      + '<div class="g-feature-event__art">'
      + '<picture>' + artSource
      + '<img src="' + esc(art) + '" alt="' + esc(event.name) + '" width="426" height="358" loading="eager" /></picture></div>'
      + '<div class="g-feature-event__body">'
      + '<p class="g-feature-event__kicker">' + icon('calendar-dots') + ' Next gathering'
      + (countdown ? '<span class="g-feature-event__badge">' + esc(countdown) + '</span>' : '') + '</p>'
      + '<h2 class="g-feature-event__title">' + esc(event.name) + '</h2>'
      + (when || location
        ? '<p class="g-feature-event__meta">' + [when, location].filter(Boolean).map(esc).join(' · ') + '</p>'
        : '')
      + '<div class="g-feature-event__actions">'
      + '<a class="g-btn g-btn--secondary g-btn--sm" href="home.html?view=events">Event details</a>'
      + register
      + '</div></div></section>';
  }

  // An active paid/trial membership, or null for a free member.
  function activeMembership() {
    const m = memberState().data && memberState().data.access && memberState().data.access.membership;
    return (m && ['active', 'trialing', 'past_due'].includes(m.status)) ? m : null;
  }

  // Membership encouragement — shown to signed-in members who are not yet on a
  // paid plan. Premium card that leads to the membership tiers in the Store.
  function upgradeCard() {
    const tiers = ['Free', 'Silver', 'Gold', 'Diamond'];
    return '<section class="g-upgrade">'
      + '<div class="g-upgrade__aura" aria-hidden="true"></div>'
      + '<p class="g-upgrade__kicker">Gaia 2.0 Membership</p>'
      + '<h2 class="g-upgrade__title">Unlock your full practice</h2>'
      + '<p class="g-upgrade__lede">Certifications, practitioner communities, a directory listing, and the CRM tools that grow your practice — start free, upgrade any time.</p>'
      + '<div class="g-upgrade__tiers">'
      + tiers.map((t, i) => '<span class="g-upgrade__tier' + (i === 0 ? ' is-current' : '') + '">' + t + '</span>').join('')
      + '</div>'
      + '<a class="g-btn g-btn--primary g-upgrade__cta" href="home.html?view=store&tab=membership">' + icon('sparkle') + ' See membership plans ' + icon('arrow-right') + '</a>'
      + '</section>';
  }

  function renderHome() {
    const root = $('home-superapp');
    if (!root) return;
    const authed = memberState().authed;
    const p = profile();
    const firstName = String(p.name || '').trim().split(/\s+/)[0];
    const hour = new Date().getHours();
    const dayGreeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const greeting = authed ? (dayGreeting + (firstName ? ', ' + esc(firstName) : '')) : dayGreeting;
    const services = serviceLink('academy', 'graduation-cap', 'Academy', stateMeta('Courses and certifications', courseGrants().length, 'course', 'courses'))
      + serviceLink('community', 'users-three', 'Community', stateMeta('Boards and circles', communities().length, 'community', 'communities'))
      + serviceLink('events', 'calendar-dots', 'Events', eventData()?.name ? 'Upcoming gathering available' : 'Gatherings and live sessions')
      + serviceLink('bookings', 'calendar-check', 'Bookings', stateMeta('Sessions and consultations', upcomingAppointments().length, 'upcoming booking', 'upcoming bookings'));

    if (authed) { renderHomeMember(root, greeting); renderToday(); document.dispatchEvent(new CustomEvent('gaia:superapp-rendered', { detail: { authed } })); return; }
    root.innerHTML = '<div class="g-super-home g-guest">'
      // Admin-published announcements (rendered by gaia-member.js from
      // /api/app/bootstrap) sit above everything, for members and guests alike.
      + '<div id="home-announcements"></div>'
      // A member never reaches this point (renderHomeMember above); this is the
      // guest on-ramp: what Gaia is, the tools a stranger can use now, one way
      // in, and the next gathering. The booking card host stays for Today.
      + guestHero(dayGreeting)
      + guestExplore()
      + guestJoin()
      + guestEvent()
      + '<div id="home-book" hidden></div>'
      + '</div>';
    root.querySelector('[data-gg-explore]')?.addEventListener('click', (e) => {
      const target = root.querySelector('#gg-explore');
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
    bind(root);
    renderToday();
    // Panels that live inside the home screen but are owned by their own files
    // follow this rather than the superapp having to know they exist.
    document.dispatchEvent(new CustomEvent('gaia:superapp-rendered', { detail: { authed } }));
  }

  /**
   * HOME for a member -- the dashboard, said once.
   *
   *   Welcome back, Name            the heading of the page, not text on art
   *   -> one next step              course / booking / readings / daily check
   *   -> the next gathering         compact, with its real buttons
   *   -> Your Gaia                  Academy, Community, Events, Bookings: whole rows tap
   *   -> Book a session             four actions, one line each (same links)
   *   -> membership, compact        the plan you have, or the plans
   *   -> sync, only when wrong      a normal sync says nothing
   *
   * Nothing is listed twice; every destination and link is the one that was
   * here before. The guest Home keeps its own on-ramp (the hero, free tools).
   */
  function renderHomeMember(root, greeting) {
    const d = memberState().data || {};
    const rows = [
      ['academy', 'graduation-cap', 'Academy', stateMeta('Courses and certifications', courseGrants().length, 'course', 'courses')],
      ['community', 'users-three', 'Community', stateMeta('Boards and circles', communities().length, 'community', 'communities')],
      ['events', 'calendar-dots', 'Events', eventData()?.name ? 'Next gathering is on' : 'Gatherings and live sessions'],
      ['bookings', 'calendar-check', 'Bookings', stateMeta('Sessions and consultations', upcomingAppointments().length, 'upcoming booking', 'upcoming bookings')],
    ].map(([v, i, t, m]) => serviceLink(v, i, t, m)).join('');
    const meta = (d.access && d.access.meta) || {};
    const sync = (meta.degraded || meta.stale)
      ? '<p class="g-home2__sync" role="status">' + icon('warning-circle') + ' Your access may not be up to date' + (meta.confirmed_at ? ' (last confirmed ' + esc(String(meta.confirmed_at).slice(0, 10)) + ')' : '') + '. Courses, communities and plans refresh on their own; nothing has been removed.</p>'
      : '';
    root.innerHTML = '<div class="g-super-home g-super-home--v2 g-home2">'
      + '<div id="home-announcements"></div>'
      + '<header class="g-home2__greet"><h1>' + greeting + '</h1><p>' + esc(homeLine()) + '</p></header>'
      // How am I doing -> what next -> what is happening for me.
      + stateHero()
      + forYou()
      + '<section class="g-home2__gaia" aria-label="Your Gaia"><p class="g-super-kicker">Your Gaia</p><div class="g-home2__rows">' + rows + '</div></section>'
      + bookActions()
      + membershipStrip()
      + sync
      + '<div id="home-book" hidden></div>'   // gaia-member still writes its booking card here; Today copies it
      + '</div>';
    bind(root);
  }
  /**
   * The first thing on a member's Home: their own state. With a practitioner
   * sharing readings, the latest energy and stress; otherwise today's check.
   */
  function stateHero() {
    const st = (window.GaiaMyReadings && window.GaiaMyReadings.status && window.GaiaMyReadings.status()) || {};
    const r = st.linked && window.GaiaMyReadings.latest ? window.GaiaMyReadings.latest() : null;
    if (st.linked && r && r.latest) {
      const l = r.latest;
      const fmt = (v, d) => (typeof v === 'number' ? v.toFixed(d) : '—');
      const day = l.scanned_at ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(l.scanned_at) ? l.scanned_at + 'T12:00:00' : l.scanned_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
      return '<section class="g-home2__state g-home2__state--reading" aria-label="Your latest reading">'
        + '<p class="g-super-kicker">' + (st.new_reading ? 'New reading' : 'Your latest reading') + (day ? ' · ' + esc(day) : '') + '</p>'
        + '<div class="g-home2__nums">'
        + '<div class="g-home2__num"><strong>' + esc(fmt(l.energy, 0)) + '</strong><span>Energy</span></div>'
        + '<div class="g-home2__num"><strong>' + esc(fmt(l.stress, 2)) + '</strong><span>Stress</span></div></div>'
        + (r.summary && r.summary.headline ? '<p class="g-home2__state-line">' + esc(r.summary.headline) + '</p>' : '')
        + '<div class="g-home2__actions"><a class="g-btn g-btn--primary g-btn--sm" href="home.html?view=profile&section=readings" data-open-readings>' + icon('pulse') + ' View reading</a>'
        + (window.GaiaAvatar && window.GaiaAvatar.openChat ? '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-ask-gaia="What changed in my latest reading?">' + icon('sparkle') + ' Ask Gaia what changed</button>' : '')
        + '</div></section>';
    }
    if (st.linked) {
      return '<section class="g-home2__state" aria-label="Your latest reading" aria-busy="true"><p class="g-super-kicker">Your latest reading</p>'
        + '<p class="g-home2__state-line">Fetching your latest reading from Bio-Well…</p></section>';
    }
    return '<section class="g-home2__state"><p class="g-super-kicker">Today</p><h2>Your daily energy check</h2>'
      + '<p class="g-home2__state-line">Which centre today asks for, a short practice, and a streak that saves.</p>'
      + '<div class="g-home2__actions"><a class="g-btn g-btn--primary g-btn--sm" href="home.html?view=daily" data-app-nav="daily">' + icon('sun') + ' Start today’s check</a></div></section>';
  }
  /** What is happening for me: a course, a booking, the next gathering — smaller than my own state. */
  function forYou() {
    const items = [];
    const course = courseGrants()[0];
    const appt = upcomingAppointments()[0];
    if (course && course.openUrl) items.push('<button type="button" class="g-home2__tile" data-super-course="' + esc(course.openUrl) + '" data-super-course-title="' + esc(course.title || course.name || 'Gaia Healers Academy') + '">'
      + '<span class="g-home2__tile-icon">' + icon('book-open') + '</span><span class="g-home2__tile-copy"><small>Continue learning</small><strong>' + esc(course.title || course.name || 'Your course') + '</strong></span></button>');
    if (appt) items.push('<a class="g-home2__tile" href="home.html?view=bookings"><span class="g-home2__tile-icon">' + icon('calendar-check') + '</span><span class="g-home2__tile-copy"><small>Coming up</small><strong>' + esc(appt.title || 'Your appointment') + '</strong><em>' + esc(appointmentWhen(appt)) + '</em></span></a>');
    const ev = eventCompact();
    if (!items.length && !ev) return '';
    return '<section class="g-home2__for" aria-label="For you"><p class="g-super-kicker">For you</p><div class="g-home2__for-grid">' + items.join('') + ev + '</div></section>';
  }
  window.addEventListener('gaia:readings-loaded', () => { if (memberState().authed && document.querySelector('.g-home2')) renderHome(); });
  document.addEventListener('click', (e) => {
    const ask = e.target.closest('[data-ask-gaia]');
    if (ask) { window.GaiaAvatar?.openChat?.(ask.getAttribute('data-ask-gaia')); return; }
    const open = e.target.closest('[data-open-readings]');
    if (open) { e.preventDefault(); window.GaiaAppShell?.go?.('profile'); setTimeout(() => window.dispatchEvent(new CustomEvent('gaia:open-readings')), 80); }
  });

  /** One short line under the greeting, only when there is something to say. */
  function homeLine() {
    const n = upcomingAppointments().length, c = courseGrants().length;
    if (n) return n === 1 ? 'One session coming up.' : n + ' sessions coming up.';
    if (c) return c === 1 ? 'Your course is waiting.' : c + ' courses in your account.';
    return dateLabel();
  }
  /** The one next step: a course, a booking, your readings, or today\u2019s check. Same destinations as before. */
  function nextStep() {
    const firstCourse = courseGrants()[0];
    const nextAppointment = upcomingAppointments()[0];
    if (firstCourse?.openUrl) {
      // Both a course and a booking: the course leads, the booking is named on a second line.
      const also = nextAppointment ? '<a class="g-home2__also" href="home.html?view=bookings">' + icon('calendar-check') + ' Also coming up: ' + esc(nextAppointment.title || 'your appointment') + ' · ' + esc(appointmentWhen(nextAppointment)) + '</a>' : '';
      return '<section class="g-home2__next"><p class="g-super-kicker">Continue learning</p><h2>' + esc(firstCourse.title || firstCourse.name || 'Your course') + '</h2>'
        + '<p>Lessons and verified progress open in your Academy workspace.</p>'
        + '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-super-course="' + esc(firstCourse.openUrl) + '" data-super-course-title="' + esc(firstCourse.title || firstCourse.name || 'Gaia Healers Academy') + '">' + icon('book-open') + ' Open course</button>' + also + '</section>';
    }
    if (nextAppointment) {
      return '<section class="g-home2__next"><p class="g-super-kicker">Coming up</p><h2>' + esc(nextAppointment.title || 'Your appointment') + '</h2>'
        + '<p>' + esc(appointmentWhen(nextAppointment)) + '</p><a class="g-btn g-btn--primary g-btn--sm" href="home.html?view=bookings">' + icon('calendar-check') + ' View booking</a></section>';
    }
    const r = (window.GaiaMyReadings && window.GaiaMyReadings.status && window.GaiaMyReadings.status()) || {};
    if (r.linked) {
      return '<section class="g-home2__next"><p class="g-super-kicker">' + (r.new_reading ? 'New reading' : 'Your readings') + '</p><h2>' + (r.new_reading ? 'A new reading from your practitioner' : 'Your Bio-Well readings') + '</h2>'
        + '<p>Summary, energy and stress, your seven centres, and how things moved.</p><a class="g-btn g-btn--primary g-btn--sm" href="home.html?view=profile&section=readings">' + icon('pulse') + ' Open my readings</a></section>';
    }
    return '<section class="g-home2__next"><p class="g-super-kicker">Today</p><h2>Your daily energy check</h2>'
      + '<p>Which centre today asks for, today\u2019s sky, and a streak that saves.</p><a class="g-btn g-btn--primary g-btn--sm" href="home.html?view=daily" data-app-nav="daily">' + icon('sun') + ' Start today\u2019s check</a></section>';
  }
  /** The next gathering, compact: thumbnail, name, when and where, the same two buttons. */
  function eventCompact() {
    loadEventsList();
    const event = upcomingFeatureEvents()[0] || eventData();
    if (!event?.name) return '';
    const art = event.heroImageUrl || 'assets/gaia-elevate-hero.png';
    const when = eventDate(event), location = event.location || event.venue || '', countdown = eventCountdown(event);
    const register = event.registrationUrl ? '<a class="g-btn g-btn--primary g-btn--sm" href="' + esc(event.registrationUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(event.registrationLabel || 'Get tickets') + '</a>' : '';
    return '<section class="g-home2__event"><img class="g-home2__event-art" src="' + esc(art) + '" alt="" width="426" height="358" loading="lazy" />'
      + '<div class="g-home2__event-body"><p class="g-super-kicker">Next gathering' + (countdown ? ' <span class="g-home2__badge">' + esc(countdown) + '</span>' : '') + '</p>'
      + '<h2>' + esc(event.name) + '</h2>'
      + (when || location ? '<p>' + [when, location].filter(Boolean).map(esc).join(' \u00b7 ') + '</p>' : '')
      + '<div class="g-home2__actions"><a class="g-btn g-btn--secondary g-btn--sm" href="home.html?view=events">Event details</a>' + register + '</div></div></section>';
  }
  /** Book a session: the same four links, each with one line that says what it is. */
  function bookActions() {
    // Same sessions as the Bookings page (bookingSet), in Home's card style.
    // The scan still starts at the directory (Bio-Well practitioners first).
    const LOOK = {
      'biowell-scan': { icon: 'pulse', what: 'Choose a practitioner near you, then a time.', intent: 'scan' },
      'biowell-demo': { icon: 'monitor-play', what: 'See the device in action, no commitment.' },
      'healeex-combo': { icon: 'sparkle', what: 'A Healeex session together with a Bio-Well scan.' },
    };
    const items = bookingSet().map((b) => ({ name: b.name || 'Book a session', href: b.openUrl || '', ...(LOOK[b.id] || { icon: 'calendar-plus', what: 'Open the secure booking form.' }) }));
    return '<section class="g-home2__book" aria-label="Book a session"><p class="g-super-kicker">Book a session</p><div class="g-home2__book-grid">'
      + items.map((b) => '<button type="button" class="g-home2__action" ' + (b.intent ? 'data-dir-intent="' + esc(b.intent) + '"' : 'data-book-inline="' + esc(b.href) + '" data-book-title="' + esc(b.name) + '"') + '><span class="g-home2__action-icon">' + icon(b.icon) + '</span><span class="g-home2__action-copy"><strong>' + esc(b.name) + '</strong><small>' + esc(b.what) + '</small></span>' + icon('caret-right', 'g-home2__action-arrow') + '</button>').join('')
      + '</div></section>';
  }

  /** Membership, in one strip: the plan you have and its next action, or the plans. */
  function membershipStrip() {
    const m = activeMembership();
    if (m) {
      return '<a class="g-home2__plan" href="home.html?view=profile"><span class="g-home2__plan-copy"><strong>' + esc(m.label || m.key || 'Member') + ' member</strong><small>Your pass, access and billing live in You.</small></span><span class="g-home2__plan-cta">Manage ' + icon('caret-right') + '</span></a>';
    }
    return '<a class="g-home2__plan" href="home.html?view=store&tab=membership"><span class="g-home2__plan-copy"><strong>Gaia 2.0 membership</strong><small>Certifications, practitioner communities, a directory listing, CRM tools. Start free, upgrade any time.</small></span><span class="g-home2__plan-cta">See plans ' + icon('caret-right') + '</span></a>';
  }

  /**
   * TODAY — the day itself, nothing that belongs to the account. The daily
   * energy check leads (the one thing that changed since yesterday), then
   * today's sky, the readings shortcut (the readings panel places it), the
   * next booking and the booking card. Everything here is owned by the file
   * that already renders it; this only lays the hosts out in order.
   */
  function renderToday() {
    const root = $('daily-superapp');
    if (!root) return;
    const authed = memberState().authed;
    const p = profile();
    const firstName = String(p.name || '').trim().split(/\s+/)[0];
    const hour = new Date().getHours();
    const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    // Signed out, Today shares the guest Home's container, rhythm and Join
    // section (gaia-guest-home.css), so the two pages read as one site.
    root.innerHTML = '<div class="g-super-home g-super-today' + (authed ? '' : ' g-guest g-guest-today') + '">'
      + '<section class="g-super-today__head"><p class="g-super-kicker">' + esc(dateLabel()) + '</p>'
      + '<h1>Good ' + part + (authed && firstName ? ', ' + esc(firstName) : '') + '</h1>'
      + '<p>' + (authed ? 'What does today ask for?' : 'What does your energy need today?') + '</p></section>'
      + '<div data-today-readings></div>'
      + '<div data-daily-host></div>'
      + (authed ? nextBookingCard() : '')
      + '<div data-sky-host></div>'
      + (authed ? '' : guestJoin())
      + '<div id="today-book"></div>'
      + '</div>';
    bind(root);
    const book = root.querySelector('#today-book'); const homeBook = $('home-book');
    if (book && homeBook && homeBook.innerHTML) book.innerHTML = homeBook.innerHTML;
  }

  // Next booking — the member's soonest real appointment (from the ledger).
  // Shown only when one exists; links to the Bookings screen (canonical home).
  function nextBookingCard() {
    const appts = upcomingAppointments();
    if (!appts.length) return '';
    const a = appts[0];
    return '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Next booking</p><h2>Upcoming session</h2></div><a href="home.html?view=bookings">Bookings</a></div>'
      + '<a class="g-super-row" href="home.html?view=bookings"><span class="g-super-row__icon">' + icon('calendar-check') + '</span><span><small>Scheduled</small><strong>' + esc(a.title || 'Appointment') + '</strong><em>' + esc(appointmentWhen(a)) + '</em></span>' + icon('caret-right') + '</a></section>';
  }

  /**
   * One fetch of the daily energy per day, shared by everything that wants it.
   *
   * This module and gaia-daily.js both asked for it on every render, and a
   * render happens on every screen change -- one browsing session made 76
   * identical requests, each costing 300-800ms of round trip for 442 bytes.
   * The value is by definition constant for the day.
   *
   * The day is taken from the device's own calendar, so it turns over at the
   * viewer's midnight rather than UTC's, matching how the rest of the app
   * already renders "MONDAY, SEPTEMBER 7". A failed request clears the entry
   * instead of becoming the answer until tomorrow.
   */
  const dailyCache = { day: null, promise: null, value: null };
  function localDayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }
  function clearDaily() { dailyCache.day = null; dailyCache.promise = null; dailyCache.value = null; }
  function getDaily(force) {
    const day = localDayKey();
    if (dailyCache.day !== day) clearDaily();            // the day turned over
    if (force) clearDaily();
    if (dailyCache.value) return Promise.resolve(dailyCache.value);
    if (dailyCache.promise) return dailyCache.promise;   // share the one in flight
    dailyCache.day = day;
    dailyCache.promise = fetch(proxyBase() + '/api/wellness/daily', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => { dailyCache.value = d; dailyCache.promise = null; return d; })
      .catch((e) => { clearDaily(); throw e; });
    return dailyCache.promise;
  }
  // Completing today's ritual changes the streak, so the holder of that action
  // invalidates rather than everyone polling in case it did.
  window.GaiaDaily = { get: getDaily, invalidate: clearDaily };

  // ── Notices: toast + confirm ─────────────────────────────────────────
  // The community board used to reach for window.alert / window.confirm on
  // its error and confirmation paths. Those are the browser's dialogs, not the
  // app's — a white system box over a dark screen, unstyled, and in the
  // installed PWA on iOS they carry the origin in the title. This is the
  // in-app equivalent: a toast that announces itself to screen readers and a
  // confirm sheet that returns a promise, both drawn from the same g-* tokens
  // as the rest of the shell.
  const notice = (() => {
    let toastEl = null; let toastTimer = 0;
    function toast(message, opts = {}) {
      const text = String(message || '').trim(); if (!text) return;
      const tone = opts.tone === 'ok' ? 'ok' : (opts.tone === 'error' ? 'error' : 'info');
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'g-toast';
        toastEl.setAttribute('role', 'status');
        toastEl.setAttribute('aria-live', 'polite');
        toastEl.hidden = true;
        document.body.appendChild(toastEl);
      }
      window.clearTimeout(toastTimer);
      toastEl.className = 'g-toast g-toast--' + tone;
      toastEl.innerHTML = '<span class="g-toast__text"></span><button type="button" class="g-toast__close" aria-label="Dismiss">' + icon('x') + '</button>';
      toastEl.querySelector('.g-toast__text').textContent = text;
      toastEl.querySelector('.g-toast__close').addEventListener('click', hideToast);
      toastEl.hidden = false;
      toastTimer = window.setTimeout(hideToast, opts.duration || 4500);
    }
    function hideToast() { if (toastEl) toastEl.hidden = true; window.clearTimeout(toastTimer); }

    function confirm(message, opts = {}) {
      return new Promise((resolve) => {
        const previous = document.activeElement;
        const sheet = document.createElement('div');
        sheet.className = 'g-confirm';
        sheet.innerHTML = '<div class="g-confirm__panel" role="dialog" aria-modal="true" aria-labelledby="g-confirm-title">'
          + '<p class="g-confirm__title" id="g-confirm-title"></p>'
          + (opts.detail ? '<p class="g-confirm__detail"></p>' : '')
          + '<div class="g-confirm__actions">'
          + '<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-confirm-no></button>'
          + '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-confirm-yes></button>'
          + '</div></div>';
        sheet.querySelector('.g-confirm__title').textContent = String(message || '');
        if (opts.detail) sheet.querySelector('.g-confirm__detail').textContent = String(opts.detail);
        const yes = sheet.querySelector('[data-confirm-yes]'); const no = sheet.querySelector('[data-confirm-no]');
        yes.textContent = opts.confirmLabel || 'Confirm'; no.textContent = opts.cancelLabel || 'Cancel';
        function close(result) {
          document.removeEventListener('keydown', onKey);
          sheet.remove();
          try { if (previous && previous.focus) previous.focus(); } catch (_) { /* gone */ }
          resolve(result);
        }
        function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(false); } }
        yes.addEventListener('click', () => close(true));
        no.addEventListener('click', () => close(false));
        sheet.addEventListener('click', (e) => { if (e.target === sheet) close(false); });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(sheet);
        window.requestAnimationFrame(() => yes.focus());
      });
    }
    return { toast, confirm };
  })();
  window.GaiaNotice = notice;

  // ---- Events: hub and per-event page -------------------------------------
  // The hub lists whatever the Event Manager publishes; ?event=N opens one.
  // Nothing about any particular event is written here.
  const eventUI = { tab: 'overview', past: null, pastLoading: false, live: {} };
  const EVENT_TABS = [
    ['overview', 'Overview'], ['agenda', 'Agenda'], ['speakers', 'Speakers'],
    ['exhibitors', 'Exhibitors'], ['map', 'Map'], ['people', 'People'],
    ['sponsors', 'Sponsors'], ['community', 'Community'], ['updates', 'Updates'], ['info', 'Info'],
  ];

  // The server states the time; the device only measures elapsed time since.
  const clock = { base: null, capturedAt: 0 };
  function noteServerTime(iso) {
    if (!iso) return;
    const parsed = new Date(iso).getTime();
    if (Number.isFinite(parsed)) { clock.base = parsed; clock.capturedAt = Date.now(); }
  }
  function serverNow() {
    return clock.base ? clock.base + (Date.now() - clock.capturedAt) : Date.now();
  }

  const instant = (value) => {
    const ms = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(ms) ? ms : null;
  };

  function eventPhase(item) {
    const start = instant(item.startAt);
    const end = instant(item.endAt);
    const now = serverNow();
    if (start && now < start) return 'upcoming';
    if (end && now > end) return 'past';
    if (start || end) return 'running';
    return 'upcoming';
  }

  // Countdown from authoritative instants only — never from the naive display dates.
  function countdownLabel(item) {
    const start = instant(item.startAt);
    if (!start) return '';
    const diff = start - serverNow();
    if (diff <= 0) return '';
    const minutes = Math.floor(diff / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    if (days > 0) return 'in ' + days + (days === 1 ? ' day' : ' days') + (hours ? ' ' + hours + 'h' : '');
    if (hours > 0) return 'in ' + hours + 'h ' + (minutes % 60) + 'm';
    return 'in ' + Math.max(1, minutes) + ' min';
  }

  function humanDates(item) {
    // Display only: these are venue-local wall-clock values.
    const start = item.startDate ? new Date(item.startDate) : null;
    const end = item.endDate ? new Date(item.endDate) : null;
    if (!start || !Number.isFinite(+start)) return '';
    const fmt = (date, withYear) => new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}),
    }).format(date);
    if (!end || !Number.isFinite(+end)) return fmt(start, true);
    return fmt(start, false) + ' – ' + fmt(end, true);
  }

  function registrationCta(item, extraClass) {
    if (!item || !item.registrationUrl) return '';
    const label = item.registrationLabel || 'Buy ticket';
    return '<a class="g-btn g-btn--primary' + (extraClass ? ' ' + extraClass : '') + '" href="'
      + esc(item.registrationUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + ' ' + icon('arrow-up-right') + '</a>';
  }

  // What this event IS, in four numbers, each one a way in. Only counts that
  // exist are shown -- an empty schedule says nothing rather than "0 sessions".
  function eventStats(item, detail) {
    const days = (() => {
      const a = item.startDate ? new Date(item.startDate) : null;
      const b = item.endDate ? new Date(item.endDate) : null;
      if (!a || !Number.isFinite(+a)) return 0;
      if (!b || !Number.isFinite(+b)) return 1;
      return Math.max(1, Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate())
        - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000) + 1);
    })();
    const sessions = (detail?.agenda?.days || []).reduce((n, d) => n + ((d.items || d.sessions || []).length), 0);
    const tiles = [
      days ? [days, days === 1 ? 'day' : 'days', ''] : null,
      sessions ? [sessions, sessions === 1 ? 'session' : 'sessions', 'agenda'] : null,
      (detail && detail.speakers && detail.speakers.length) ? [detail.speakers.length, 'speakers', 'speakers'] : null,
      (detail && detail.exhibitors && detail.exhibitors.length) ? [detail.exhibitors.length, 'stands', 'exhibitors'] : null,
      (detail && detail.sponsors && detail.sponsors.length) ? [detail.sponsors.length, 'sponsors', 'sponsors'] : null,
    ].filter(Boolean).slice(0, 4);
    if (!tiles.length) return '';
    return '<div class="g-event-stats">' + tiles.map(([n, label, tab]) => (tab
      ? '<button type="button" class="g-event-stat" data-event-tab="' + esc(tab) + '"><b>' + n + '</b><span>' + esc(label) + '</span></button>'
      : '<div class="g-event-stat is-static"><b>' + n + '</b><span>' + esc(label) + '</span></div>')).join('') + '</div>';
  }

  // Where it is and what to book, as links rather than as facts to copy out.
  function eventQuickLinks(item, detail) {
    const links = [];
    if (item.venue) {
      links.push(['map-pin', item.venue, 'Open in Maps',
        'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(item.venue)]);
    }
    (Array.isArray(detail && detail.resources) ? detail.resources : []).slice(0, 3).forEach((r) => {
      if (r && r.url) links.push(['link', r.title || 'Event resource', r.description || '', r.url]);
    });
    if (!links.length) return '';
    return '<div class="g-ev-links">' + links.map(([ico, title, note, href]) =>
      '<a class="g-ev-link" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">'
      + '<span class="g-ev-link__icon">' + icon(ico) + '</span>'
      + '<span class="g-ev-link__text"><strong>' + esc(title) + '</strong>'
      + (note ? '<em>' + esc(note) + '</em>' : '') + '</span>'
      + '<span class="g-ev-link__go" aria-hidden="true">' + icon('arrow-up-right') + '</span></a>').join('') + '</div>';
  }

  // Someone who already holds a ticket does not need "Buy ticket" — at a venue
  // they need the QR, and before it they want to know which pass they hold.
  // The list is the one GaiaMyEvents already caches, so this costs no extra
  // round trip, and the sheet it opens is the same one the Events hub opens:
  // one ticket screen, not two.
  function myTicketHtml(held) {
    const t = held.ticket || {};
    const status = (window.GaiaMyEvents && window.GaiaMyEvents.ticketStatus)
      ? window.GaiaMyEvents.ticketStatus(t) : { text: '', tone: 'idle' };
    const pass = (t.baseTicket && t.baseTicket.name) || t.passLabel || 'Ticket';
    const addons = (t.addons || []).map((a) => '<span class="g-mypass__addon">+ '
      + esc(a.label) + (a.day ? ' \u00b7 ' + esc(a.day) : '') + '</span>').join('');
    return '<section class="g-mypass" data-my-pass>'
      + '<div class="g-mypass__text">'
      + '<p class="g-mypass__kicker">Your ticket</p>'
      + '<p class="g-mypass__name">' + esc(pass)
      + (t.isVip ? '<span class="g-mypass__vip">VIP</span>' : '') + addons + '</p>'
      + (status.text ? '<p class="g-mypass__status is-' + esc(status.tone) + '">' + esc(status.text) + '</p>' : '')
      + '</div>'
      + '<button type="button" class="g-btn g-btn--primary g-mypass__go" data-my-ticket="' + esc(String(held.id)) + '">'
      + icon('qr-code') + ' Show my QR</button>'
      + '</section>';
  }

  async function injectMyTicket(root, eventId) {
    if (!memberState().authed || !window.GaiaMyEvents || !window.GaiaMyEvents.mine) return;
    try {
      const mine = await window.GaiaMyEvents.mine();
      const held = (mine && mine.ok === true && Array.isArray(mine.events))
        ? mine.events.find((e) => String(e.id) === String(eventId)) : null;
      // The page may have moved on while this was in flight.
      if (!held || !held.ticket || !document.body.contains(root)) return;
      const anchor = root.querySelector('.g-event-stats') || root.querySelector('.g-eventpage-hero');
      if (!anchor || root.querySelector('[data-my-pass]')) return;
      anchor.insertAdjacentHTML('afterend', myTicketHtml(held));
      root.querySelectorAll('[data-my-ticket]').forEach((button) => {
        button.addEventListener('click', () => window.GaiaMyEvents.openTicket(button.dataset.myTicket));
      });
      // They have one. Offering to sell them another is noise.
      if (held.ticket.valid !== false) {
        root.querySelectorAll('.g-event-overview .g-btn--primary[href]').forEach((cta) => cta.remove());
      }
    } catch (_) { /* the programme never waits on a member call */ }
  }

  function eventHero(item) {
    return item && item.heroImageUrl
      ? '<img src="' + esc(item.heroImageUrl) + '" alt="" loading="lazy" />'
      : '<img src="assets/gaia-event-hero.webp" alt="" loading="lazy" />';
  }

  function loadPastEvents() {
    if (eventUI.past || eventUI.pastLoading) return;
    eventUI.pastLoading = true;
    fetch(proxyBase() + '/api/events?include_past=1', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        if (payload && payload.ok) { eventUI.past = payload.events || []; render(); }
      })
      .catch(() => { eventUI.past = []; })
      .finally(() => { eventUI.pastLoading = false; });
  }

  // Live state for an event that is currently inside its own window. At most one
  // or two calls, and only while something could actually be running.
  function loadLiveFor(id) {
    if (!id || eventUI.live[id]) return;
    eventUI.live[id] = { loading: true };
    fetch(proxyBase() + '/api/events/' + encodeURIComponent(id) + '/live', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        eventUI.live[id] = payload && payload.ok ? payload.live : {};
        if (payload && payload.ok) noteServerTime(payload.live.server_time);
        render();
      })
      .catch(() => { eventUI.live[id] = {}; });
  }

  function eventCard(item, opts = {}) {
    const meta = [humanDates(item), item.venue].filter(Boolean).join(' · ');
    const countdown = opts.countdown === false ? '' : countdownLabel(item);
    return '<article class="g-event-card">'
      + '<a class="g-event-card__art" href="home.html?view=events&event=' + esc(item.id) + '" aria-label="' + esc(item.name || 'Event') + '">' + eventHero(item) + '</a>'
      + '<div class="g-event-card__body">'
      + (opts.kicker ? '<p class="g-super-kicker">' + esc(opts.kicker) + '</p>' : '')
      + '<h3>' + esc(item.name) + '</h3>'
      + (meta ? '<p class="g-event-card__meta">' + esc(meta) + '</p>' : '')
      + (countdown ? '<p class="g-event-card__countdown">' + icon('clock') + ' ' + esc(countdown) + '</p>' : '')
      + '<div class="g-event-card__actions">'
      + '<a class="g-btn g-btn--ghost g-btn--sm" href="home.html?view=events&event=' + esc(item.id) + '">View event ' + icon('arrow-right') + '</a>'
      + registrationCta(item, 'g-btn--sm')
      + '</div></div></article>';
  }

  function renderEventsHub(root) {
    loadEventsList();
    loadPastEvents();
    const all = Array.isArray(eventsList.data) ? eventsList.data : [];
    all.forEach((item) => noteServerTime(item.serverTime));

    const running = all.filter((item) => eventPhase(item) === 'running');
    running.forEach((item) => loadLiveFor(item.id));
    const upcoming = all.filter((item) => eventPhase(item) === 'upcoming');
    const knownIds = new Set(all.map((item) => String(item.id)));
    const past = (eventUI.past || []).filter((item) => !knownIds.has(String(item.id)) || eventPhase(item) === 'past');

    const liveCards = running.map((item) => {
      const live = eventUI.live[item.id];
      if (!live || !live.live_enabled) return eventCard(item, { kicker: 'Happening now' });
      const nowTitles = (live.now || []).map((s) => s.title).filter(Boolean);
      return '<article class="g-event-card g-event-card--live">'
        + '<a class="g-event-card__art" href="home.html?view=events&event=' + esc(item.id) + '" aria-label="' + esc(item.name || 'Event') + '">' + eventHero(item) + '</a>'
        + '<div class="g-event-card__body"><p class="g-super-kicker"><span class="g-live-dot" aria-hidden="true"></span> Live now</p>'
        + '<h3>' + esc(item.name) + '</h3>'
        + (nowTitles.length ? '<p class="g-event-card__meta">' + esc(nowTitles.join(' · ')) + '</p>'
          : '<p class="g-event-card__meta">' + esc(item.venue || '') + '</p>')
        + '<div class="g-event-card__actions">'
        + '<a class="g-btn g-btn--primary g-btn--sm" href="home.html?view=events&event=' + esc(item.id) + '">Open live ' + icon('arrow-right') + '</a>'
        + '</div></div></article>';
    }).join('');

    const section = (kicker, title, body) => body
      ? '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">' + esc(kicker)
        + '</p><h2>' + esc(title) + '</h2></div></div><div class="g-event-grid">' + body + '</div></section>'
      : '';

    const empty = !all.length && !past.length
      ? '<section class="g-super-empty-panel"><h2>No events published yet</h2><p>Gatherings appear here as soon as they are published.</p></section>'
      : '';

    root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Gather in person and online</p><h1>Events</h1>'
      + '<p>Every Gaia Healers gathering, its programme and who you will meet there.</p></div>'
      // Your own tickets first. Someone opening this screen at a venue is
      // looking for their QR code, not for the programme they already read.
      + '<div data-myevents-host></div>'
      + (liveCards ? '<section class="g-super-list g-super-list--live"><div class="g-super-section-head"><div><p class="g-super-kicker">On now</p><h2>Live</h2></div></div><div class="g-event-grid">' + liveCards + '</div></section>' : '')
      + section('Coming up', 'Upcoming events', upcoming.map((item) => eventCard(item)).join(''))
      + section('Archive', 'Past events', past.map((item) => eventCard(item, { countdown: false })).join(''))
      + empty;
    bind(root);
    document.dispatchEvent(new CustomEvent('gaia:superapp-rendered', { detail: { view: 'events' } }));
  }

  // FAQ / help / event-info cards, grouped and shown as an accordion so the
  // screen stays short until a question is opened. Native <details> = no JS.
  function infoSection(detail) {
    const items = Array.isArray(detail && detail.info) ? detail.info : [];
    const resources = Array.isArray(detail && detail.resources) ? detail.resources : [];
    if (!items.length && !resources.length) return '';
    const resBlock = resources.length
      ? '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Downloads</p><h2>Resources</h2></div></div><div class="g-info-list">'
        + resources.map((r) => '<a class="g-resource" href="' + esc(r.url || '#') + '" target="_blank" rel="noopener noreferrer"><span class="g-resource__body"><strong>' + esc(r.title || '') + '</strong>' + (r.description ? '<em>' + esc(r.description) + '</em>' : '') + '</span><span class="g-resource__go" aria-hidden="true">' + icon('arrow-up-right') + '</span></a>').join('')
        + '</div></section>'
      : '';
    const groups = { info: [], faq: [], help: [] };
    items.forEach((it) => { (groups[it.section] || groups.faq).push(it); });
    const heading = { info: 'Good to know', faq: 'Event FAQ', help: 'Need help?' };
    const kicker = { info: 'Information', faq: 'Questions', help: 'Support' };
    const block = (key) => {
      const list = groups[key];
      if (!list || !list.length) return '';
      return '<section class="g-super-list"><div class="g-super-section-head"><div>'
        + '<p class="g-super-kicker">' + esc(kicker[key]) + '</p><h2>' + esc(heading[key]) + '</h2></div></div>'
        + '<div class="g-info-list">'
        + list.map((it) => '<details class="g-info-item"><summary>' + esc(it.title || '')
          + '</summary><div class="g-info-item__body">' + esc(it.body || '') + '</div></details>').join('')
        + '</div></section>';
    };
    return resBlock + ['info', 'faq', 'help'].map(block).join('');
  }

  function eventTabPanel(tab, detail, live) {
    if (tab === 'agenda') return agendaSection(detail);
    if (tab === 'map') return mapSection(detail);
    if (tab === 'people') return window.GaiaPeople ? window.GaiaPeople.panelHtml() : '';
    if (tab === 'speakers') return speakersSection(detail);
    if (tab === 'exhibitors') return directorySection(detail);
    if (tab === 'sponsors') return sponsorsSection(detail);
    if (tab === 'community') return communitySection();
    if (tab === 'updates') return updatesSection(detail, live);
    if (tab === 'info') return infoSection(detail);
    return '';
  }

  function tabHasContent(tab, detail) {
    if (tab === 'overview') return true;
    if (tab === 'agenda') return Boolean(detail?.agenda?.days?.length);
    if (tab === 'speakers') return Boolean(detail?.speakers?.length);
    if (tab === 'exhibitors') return Boolean(detail?.exhibitors?.length);
    if (tab === 'map') return Boolean(detail?.map);
    if (tab === 'people') return Boolean(window.GaiaPeople && window.GaiaPeople.available());
    if (tab === 'sponsors') return Boolean(detail?.sponsors?.length);
    if (tab === 'community') return true;
    if (tab === 'updates') return Boolean((detail?.announcements?.length) || (eventUpdates.data && eventUpdates.data.length));
    if (tab === 'info') return Boolean((detail?.info?.length) || (detail?.resources?.length));
    return false;
  }

  // Which event's schedule we have already asked for, so the request fires once
  // per event rather than on every re-render.
  let scheduleLoadedFor = null;

  // ── Event community feed ─────────────────────────────────────────────
  // A moderated public board per event. Signed-in members post under a display
  // name; everyone reads; organisers pin announcements and moderate. The feed
  // polls every few seconds while its tab is open. Identity is attached by the
  // proxy from the session — the browser only ever chooses a display name.
  const eventFeed = { id: null, loadedFor: null, posts: [], me: null,
    authenticated: false, canPost: false, suspended: false,
    draft: '', displayName: null, pendingImage: '', replyingTo: null, replyDraft: '', timer: null };

  function feedTime(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 604800) return Math.floor(s / 86400) + 'd';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function feedItemHtml(p, isReply) {
    const name = p.author_name || 'Member';
    const initials = name.trim().slice(0, 1).toUpperCase() || 'M';
    const avatar = p.author_photo
      ? '<span class="g-feed-avatar"><img src="' + esc(p.author_photo) + '" alt=""></span>'
      : '<span class="g-feed-avatar g-feed-avatar--i">' + esc(initials) + '</span>';
    const badge = p.is_announcement
      ? '<span class="g-feed-badge">' + icon('megaphone') + ' Announcement</span>'
      : (p.is_pinned ? '<span class="g-feed-badge">' + icon('push-pin') + ' Pinned</span>' : '');
    const body = esc(p.body || '').split(String.fromCharCode(10)).join('<br>');
    const img = p.image_url ? '<div class="g-feed-img"><img src="' + esc(p.image_url) + '" alt="" loading="lazy"></div>' : '';
    let actions = '<div class="g-feed-actions">';
    if (!p.is_announcement) {
      actions += '<button type="button" class="g-feed-act' + (p.liked ? ' is-on' : '') + '" data-feed-like="' + p.id + '" aria-label="Like">'
        + icon('heart') + '<span>' + (p.like_count || 0) + '</span></button>'
        + (p.is_own ? '' : '<button type="button" class="g-feed-act" data-feed-report="' + p.id + '" aria-label="Report">' + icon('flag') + '</button>');
    }
    if (!isReply) {
      actions += '<button type="button" class="g-feed-act" data-feed-reply="' + p.id + '">' + icon('chat-circle')
        + '<span>' + (p.reply_count ? p.reply_count : 'Reply') + '</span></button>';
    }
    actions += '</div>';
    let sub = '';
    if (!isReply) {
      const replies = (p.replies || []).map((r) => feedItemHtml(r, true)).join('');
      const box = (eventFeed.replyingTo === p.id && eventFeed.authenticated && !eventFeed.suspended)
        ? '<div class="g-feed-reply-box"><textarea class="g-feed-reply-input" data-reply-input rows="1" maxlength="1200" placeholder="Write a reply…">' + esc(eventFeed.replyDraft || '') + '</textarea>'
          + '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-reply-send="' + p.id + '">Reply</button></div>'
        : '';
      if (replies || box) sub = '<div class="g-feed-replies">' + replies + box + '</div>';
    }
    return '<article class="g-feed-item' + (p.is_announcement ? ' is-announce' : '') + (isReply ? ' is-reply' : '') + '">'
      + avatar
      + '<div class="g-feed-body"><div class="g-feed-meta"><strong>' + esc(name) + '</strong>' + badge
      + '<em>' + esc(feedTime(p.created_at)) + '</em></div>'
      + '<div class="g-feed-text">' + body + '</div>' + img + actions + sub + '</div></article>';
  }

  function feedListHtml() {
    const posts = eventFeed.posts || [];
    if (!posts.length) return '<div class="g-feed-empty">' + icon('chat-circle-dots') + '<p>No posts yet. Be the first to say hello.</p></div>';
    return posts.map((p) => feedItemHtml(p, false)).join('');
  }

  function communitySection() {
    let composer;
    if (!eventFeed.authenticated) {
      composer = '<div class="g-feed-signin"><p>Sign in to join the conversation — everyone here will see your post.</p>'
        + '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-feed-signin>Sign in</button></div>';
    } else if (eventFeed.suspended) {
      composer = '<div class="g-feed-note">You’ve been suspended from posting in this event. You can still read the feed.</div>';
    } else {
      const nm = esc(eventFeed.displayName != null ? eventFeed.displayName : (eventFeed.me && eventFeed.me.name) || '');
      composer = '<div class="g-feed-composer">'
        + '<div class="g-feed-composer__id">Posting as <input class="g-feed-name" data-feed-name maxlength="40" value="' + nm + '" placeholder="Your name" /></div>'
        + '<textarea class="g-feed-input" data-feed-input rows="2" maxlength="1200" placeholder="Share something with everyone here…">' + esc(eventFeed.draft || '') + '</textarea>'
        + (eventFeed.pendingImage ? '<div class="g-feed-preview"><img src="' + esc(eventFeed.pendingImage) + '" alt="" /><button type="button" class="g-feed-preview__x" data-feed-rmimg aria-label="Remove photo">&times;</button></div>' : '')
        + '<div class="g-feed-hint">Be kind — posts are public and moderated.</div>'
        + '<div class="g-feed-composer__foot"><label class="g-feed-photo-btn">' + icon('image') + '<span>Photo</span><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-feed-file hidden /></label>'
        + '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-feed-post>Post</button></div></div>';
    }
    return '<section class="g-super-list g-feed-sec"><div class="g-super-section-head"><div>'
      + '<p class="g-super-kicker">Community</p><h2>Event feed</h2></div></div>'
      + composer
      + '<div class="g-feed" data-feed-list>' + feedListHtml() + '</div></section>';
  }

  function refreshFeedList() {
    const host = document.querySelector('[data-feed-list]');
    if (host) host.innerHTML = feedListHtml();
  }

  function loadEventFeed(eventId) {
    return fetch(proxyBase() + '/api/events/' + eventId + '/posts', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        if (!data || !data.ok) return false;
        const wasAuthed = eventFeed.authenticated, wasCanPost = eventFeed.canPost;
        eventFeed.id = eventId;
        eventFeed.me = data.me || null;
        eventFeed.authenticated = !!data.authenticated;
        eventFeed.canPost = !!data.canPost;
        eventFeed.suspended = !!data.suspended;
        eventFeed.posts = data.posts || [];
        if (eventFeed.displayName == null && eventFeed.me) eventFeed.displayName = eventFeed.me.name || '';
        if (!eventFeed.replyingTo) refreshFeedList();
        return (wasAuthed !== eventFeed.authenticated) || (wasCanPost !== eventFeed.canPost);
      })
      .catch(() => false);
  }

  function ensureFeed(eventId) {
    if (eventFeed.loadedFor !== eventId) {
      eventFeed.loadedFor = eventId;
      eventFeed.id = eventId;
      eventFeed.posts = [];
      loadEventFeed(eventId).then(() => render());
    }
    startFeedPolling(eventId);
  }

  function startFeedPolling(eventId) {
    stopFeedPolling();
    eventFeed.timer = setInterval(() => {
      if (document.hidden) return;
      if (eventUI.tab !== 'community' || !document.querySelector('[data-feed-list]')) { stopFeedPolling(); return; }
      loadEventFeed(eventId);
    }, 6000);
  }

  function stopFeedPolling() {
    if (eventFeed.timer) { clearInterval(eventFeed.timer); eventFeed.timer = null; }
  }

  function submitFeedPost(eventId) {
    const text = (eventFeed.draft || '').trim();
    if (!text && !eventFeed.pendingImage) return;
    const btn = document.querySelector('[data-feed-post]');
    if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }
    fetch(proxyBase() + '/api/events/' + eventId + '/posts', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text, displayName: (eventFeed.displayName || '').trim(), imageUrl: eventFeed.pendingImage || '' }),
    }).then((r) => r.json().then((d) => ({ status: r.status, d })))
      .then(({ status, d }) => {
        if (d && d.ok) {
          eventFeed.draft = '';
          eventFeed.pendingImage = '';
          const inp = document.querySelector('[data-feed-input]'); if (inp) inp.value = '';
          loadEventFeed(eventId);
        } else if (status === 401 || (d && d.authenticated === false)) {
          if (window.GaiaAuth && window.GaiaAuth.open) window.GaiaAuth.open();
        } else {
          notice.toast((d && d.detail) || 'Could not post. Please try again.', { tone: 'error' });
        }
      }).catch(() => {})
      .finally(() => { const b = document.querySelector('[data-feed-post]'); if (b) { b.disabled = false; b.textContent = 'Post'; } });
  }

  function submitReply(eventId, parentId) {
    const text = (eventFeed.replyDraft || '').trim();
    if (!text) return;
    fetch(proxyBase() + '/api/events/' + eventId + '/posts', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text, displayName: (eventFeed.displayName || '').trim(), parentId: parentId }),
    }).then((r) => r.json().then((d) => ({ status: r.status, d })))
      .then(({ status, d }) => {
        if (d && d.ok) { eventFeed.replyDraft = ''; eventFeed.replyingTo = null; loadEventFeed(eventId); }
        else if (status === 401 || (d && d.authenticated === false)) { if (window.GaiaAuth && window.GaiaAuth.open) window.GaiaAuth.open(); }
        else { notice.toast((d && d.detail) || 'Could not reply.', { tone: 'error' }); }
      }).catch(() => {});
  }

  function toggleFeedLike(eventId, postId) {
    fetch(proxyBase() + '/api/events/' + eventId + '/posts/' + postId + '/like', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then((r) => r.json().then((d) => ({ status: r.status, d })))
      .then(({ status, d }) => {
        if (d && d.ok) {
          const p = (eventFeed.posts || []).find((x) => String(x.id) === String(postId));
          if (p) { p.liked = d.liked; p.like_count = d.like_count; refreshFeedList(); }
        } else if (status === 401 || (d && d.authenticated === false)) {
          if (window.GaiaAuth && window.GaiaAuth.open) window.GaiaAuth.open();
        }
      }).catch(() => {});
  }

  async function reportFeedPost(eventId, postId) {
    const go = await notice.confirm('Report this post to the organizers?', { detail: 'They will review it and decide whether it stays.', confirmLabel: 'Report post' });
    if (!go) return;
    fetch(proxyBase() + '/api/events/' + eventId + '/posts/' + postId + '/report', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'reported' }),
    }).then((r) => r.json().then((d) => ({ status: r.status, d })))
      .then(({ status, d }) => {
        if (status === 401 || (d && d.authenticated === false)) {
          if (window.GaiaAuth && window.GaiaAuth.open) window.GaiaAuth.open();
          return;
        }
        notice.toast('Thanks — the organizers will review this post.', { tone: 'ok' });
      }).catch(() => {});
  }

  function uploadFeedImage(eventId, fileInput) {
    const f = fileInput && fileInput.files && fileInput.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { notice.toast('That image is too large (max 5MB).', { tone: 'error' }); fileInput.value = ''; return; }
    const label = fileInput.closest('.g-feed-photo-btn');
    if (label) label.classList.add('is-loading');
    const fd = new FormData();
    fd.append('file', f);
    fetch(proxyBase() + '/api/events/' + eventId + '/posts/image', { method: 'POST', credentials: 'include', body: fd })
      .then((r) => r.json().then((d) => ({ status: r.status, d })))
      .then(({ status, d }) => {
        if (d && d.ok && d.url) { eventFeed.pendingImage = d.url; render(); }
        else if (status === 401 || (d && d.authenticated === false)) { if (window.GaiaAuth && window.GaiaAuth.open) window.GaiaAuth.open(); }
        else { notice.toast((d && d.detail) || 'Could not upload that image.', { tone: 'error' }); }
      })
      .catch(() => { notice.toast('Could not upload that image.', { tone: 'error' }); })
      .finally(() => { if (label) label.classList.remove('is-loading'); });
  }

  function bindCommunity(root, eventId) {
    const sec = root.querySelector('.g-feed-sec');
    if (!sec) return;
    const nameEl = sec.querySelector('[data-feed-name]');
    const inputEl = sec.querySelector('[data-feed-input]');
    if (nameEl) nameEl.addEventListener('input', () => { eventFeed.displayName = nameEl.value; });
    if (inputEl) inputEl.addEventListener('input', () => { eventFeed.draft = inputEl.value; });
    const fileEl = sec.querySelector('[data-feed-file]');
    if (fileEl) fileEl.addEventListener('change', () => uploadFeedImage(eventId, fileEl));
    sec.addEventListener('input', (e) => { const ri = e.target.closest('[data-reply-input]'); if (ri) eventFeed.replyDraft = ri.value; });
    sec.addEventListener('click', (e) => {
      const si = e.target.closest('[data-feed-signin]');
      const post = e.target.closest('[data-feed-post]');
      const like = e.target.closest('[data-feed-like]');
      const rep = e.target.closest('[data-feed-report]');
      if (si) { if (window.GaiaAuth && window.GaiaAuth.open) window.GaiaAuth.open(); return; }
      const rmimg = e.target.closest('[data-feed-rmimg]'); if (rmimg) { eventFeed.pendingImage = ''; render(); return; }
      if (post) { submitFeedPost(eventId); return; }
      if (like) { toggleFeedLike(eventId, like.getAttribute('data-feed-like')); return; }
      if (rep) { reportFeedPost(eventId, rep.getAttribute('data-feed-report')); return; }
      const reply = e.target.closest('[data-feed-reply]');
      if (reply) { const pid = Number(reply.getAttribute('data-feed-reply')); eventFeed.replyingTo = (eventFeed.replyingTo === pid ? null : pid); eventFeed.replyDraft = ''; render(); return; }
      const rsend = e.target.closest('[data-reply-send]');
      if (rsend) { submitReply(eventId, Number(rsend.getAttribute('data-reply-send'))); return; }
    });
  }

  function renderEventDetail(root, eventId) {
    loadEventDetail(eventId);
    loadEventLive(eventId);
    loadEventUpdates(eventId);
    scheduleEventRefresh(root, eventId);
    if (eventUI._tabUrlFor !== eventId) {
      eventUI._tabUrlFor = eventId;
      try { const _t = new URLSearchParams(window.location.search).get('tab'); if (_t) eventUI.tab = _t; } catch (e) {}
    }
    // A ticket holder's saved sessions. Non-holders get a null result and the
    // agenda simply renders without save controls.
    if (window.GaiaMySchedule && scheduleLoadedFor !== eventId) {
      scheduleLoadedFor = eventId;
      window.GaiaMySchedule.load(eventId).then(() => render()).catch(() => {});
      // People rides the same cycle: it decides for itself whether this event
      // and this visitor get a directory at all.
      if (window.GaiaPeople) window.GaiaPeople.load(eventId).then(() => render()).catch(() => {});
    }
    const detail = eventDetail.data && eventDetail.id === eventId ? eventDetail.data : null;
    const live = eventLive.id === eventId ? eventLive.data : null;
    const item = detail?.event;
    noteServerTime(item?.serverTime || live?.server_time);

    if (!item) {
      root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Gather in person and online</p><h1>Events</h1></div>'
        + '<section class="g-super-empty-panel"><h2>Loading this event…</h2>'
        + '<p><a href="home.html?view=events">Back to all events</a></p></section>';
      bind(root); return;
    }

    // Sections with nothing in them are not offered as tabs at all.
    const tabs = EVENT_TABS.filter(([key]) => tabHasContent(key, detail));
    if (!tabs.some(([key]) => key === eventUI.tab)) eventUI.tab = 'overview';

    const phase = eventPhase(item);
    const countdown = countdownLabel(item);
    const statusChip = live && live.live_enabled
      ? '<span class="g-event-status is-live"><span class="g-live-dot" aria-hidden="true"></span> Live now</span>'
      : phase === 'past' ? '<span class="g-event-status">Finished</span>'
        : countdown ? '<span class="g-event-status">' + esc(countdown) + '</span>' : '';

    const overview = '<section class="g-event-overview">'
      // Long descriptions are the norm and they buried everything under them,
      // so the text is clamped with a way to open it where the screen is small.
      + (item.description ? '<div class="g-ev-about"><p>' + esc(item.description) + '</p>'
          + '<button type="button" class="g-ev-about__more" data-ev-more hidden>Read more</button></div>' : '')
      + '<dl><div><dt>Dates</dt><dd>' + esc(humanDates(item) || 'To be announced') + '</dd></div>'
      + '<div><dt>Venue</dt><dd>' + esc(item.venue || 'To be announced') + '</dd></div>'
      + (item.timezone ? '<div><dt>Local time</dt><dd>' + esc(String(item.timezone).replace(/_/g, ' ')) + '</dd></div>' : '')
      + '</dl>' + eventQuickLinks(item, detail) + registrationCta(item) + '</section>';

    // Marked seen BEFORE the tab bar is built: the dot is computed from the
    // same stored value, and marking afterwards leaves a stale dot standing
    // until some unrelated re-render.
    if (eventUI.tab === 'updates') markUpdatesSeen(eventId, detail?.announcements);
    const tabBar = tabs.length > 1
      ? '<nav class="g-event-tabs" role="tablist">' + tabs.map(([key, label]) =>
        '<button type="button" role="tab" class="g-event-tab' + (eventUI.tab === key ? ' is-active' : '')
        + '" data-event-tab="' + key + '" aria-selected="' + (eventUI.tab === key) + '">' + esc(label)
        // The dot says "something you have not read", quietly. Opening the tab
        // clears it; nothing nags.
        + (key === 'updates' && unseenCount(eventId, detail?.announcements)
          ? '<span class="g-tab-dot" aria-label="new updates"></span>' : '')
        + '</button>').join('') + '</nav>'
      : '';

    const offlineLine = detail?.offline
      ? '<p class="g-mye__offline">Shown from a saved copy — no connection right now. Times and rooms may have changed.</p>' : '';
    root.innerHTML = '<div class="g-super-page-head"><a class="g-event-back" href="home.html?view=events">' + icon('arrow-left') + ' All events</a>'
      + '<h1>' + esc(item.name) + '</h1>'
      + '<p class="g-event-headmeta">' + esc([humanDates(item), item.venue].filter(Boolean).join(' · ')) + ' ' + statusChip + '</p></div>'
      + '<div class="g-eventpage-hero">' + eventHero(item) + '</div>'
      + eventStats(item, detail)
      + offlineLine
      + liveSection(live)
      + tabBar
      + '<div class="g-event-panel">' + (eventUI.tab === 'overview' ? overview : eventTabPanel(eventUI.tab, detail, live)) + '</div>';

    // The strip is re-drawn on every tab change, which resets its sideways
    // scroll: on a phone, choosing Sponsors or Info left the selected tab
    // off-screen to the right. Centre it in the strip (the strip's own scroll
    // only, so the page does not jump).
    const tabStrip = root.querySelector('.g-event-tabs');
    const selectedTab = tabStrip && tabStrip.querySelector('[aria-selected="true"]');
    if (tabStrip && selectedTab && tabStrip.scrollWidth > tabStrip.clientWidth) {
      tabStrip.scrollLeft = Math.max(0, selectedTab.offsetLeft - (tabStrip.clientWidth - selectedTab.offsetWidth) / 2);
    }

    root.querySelectorAll('[data-event-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        eventUI.tab = button.getAttribute('data-event-tab');
        render();
        // A tile sits above the tab strip, so switching from one has to bring
        // the strip into view or the panel changes somewhere off-screen.
        if (!button.classList.contains('g-event-tab')) {
          const strip = document.querySelector('.g-event-tabs');
          if (strip) strip.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
    // The clamp only earns a button when there is something clamped.
    root.querySelectorAll('[data-ev-more]').forEach((button) => {
      const box = button.closest('.g-ev-about');
      const body = box && box.querySelector('p');
      if (!box || !body) return;
      if (body.scrollHeight - body.clientHeight > 4) button.hidden = false;
      button.addEventListener('click', () => {
        const open = box.classList.toggle('is-open');
        button.textContent = open ? 'Show less' : 'Read more';
      });
    });
    // Saving redraws only its own button, so the agenda does not jump under the
    // finger that tapped it. The My Schedule panel is refreshed on the next
    // visit to the tab rather than mid-tap.
    if (window.GaiaMySchedule) window.GaiaMySchedule.bind(root, eventId);
    if (window.GaiaPeople && eventUI.tab === 'people') window.GaiaPeople.bind(root, eventId, render);
    // Tapping a legend row (or a pin) highlights that pin and scrolls it into
    // view — the closest a flat plan gets to "take me there".
    root.querySelectorAll('[data-map-place]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.mapPlace;
        root.querySelectorAll('.g-map__pin').forEach((pin) => {
          pin.classList.toggle('is-active', pin.dataset.mapPlace === id);
        });
        const pin = root.querySelector('.g-map__pin[data-map-place="' + id + '"]');
        if (pin) pin.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      });
    });
    injectMyTicket(root, eventId);
    if (eventUI.tab === 'exhibitors') bindDirectory(root);
    if (eventUI.tab === 'community') { bindCommunity(root, eventId); ensureFeed(eventId); } else { stopFeedPolling(); }
    bind(root);
  }

  function renderEvents() {
    const root = $('events-body');
    if (!root) return;
    let explicit = '';
    try {
      const wanted = new URLSearchParams(window.location.search).get('event');
      if (wanted && /^\d+$/.test(wanted)) explicit = wanted;
    } catch (_) { /* hub */ }
    if (explicit) renderEventDetail(root, explicit);
    else renderEventsHub(root);
  }

  function renderBookings() {
    const root = $('bookings-body');
    if (!root) return;
    if (!memberState().authed) {
      root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Sessions and consultations</p><h1>Book your next step</h1><p>Explore real Gaia Healers sessions now. Member appointments appear after you connect your Member Pass.</p></div>' + bookingCatalog() + guestJoinBlock();
      bind(root); return;
    }
    const rows = upcomingAppointments().length ? upcomingAppointments().map((item) => {
      const meeting = item.meetingLocation || '';
      const join = item.isVideo && meeting ? '<a class="g-btn g-btn--primary g-btn--sm" href="' + esc(meeting) + '" target="_blank" rel="noopener noreferrer">Join meeting</a>' : '';
      return '<article class="g-booking-item"><div><p class="g-super-kicker">' + esc(item.status || 'Scheduled') + '</p><h2>' + esc(item.title || 'Appointment') + '</h2><p>' + esc(appointmentWhen(item)) + (item.address ? ' · ' + esc(item.address) : '') + '</p></div>' + join + '</article>';
    }).join('') : '<section class="g-super-empty-panel"><h2>No upcoming appointments</h2><p>Choose a verified Gaia Healers booking option below when you are ready.</p></section>';
    root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Your schedule</p><h1>Bookings</h1><p>Your appointments appear here automatically.</p></div>' + rows + bookingCatalog();
    bind(root);
  }

  /** The one list of bookable sessions, shared by Bookings and the member
   * Home: the server's curated calendars, or this fallback without them. */
  function bookingSet() {
    const links = bookingLinks();
    return links.length ? links : [
      { id: 'biowell-scan', name: 'Bio-Well energy scan', openUrl: 'https://api.leadconnectorhq.com/widget/bookings/scans' },
      { id: 'biowell-demo', name: 'Bio-Well demo', openUrl: 'https://api.leadconnectorhq.com/widget/bookings/bio-welldemo' },
      { name: 'Meet Dr. Nima Farshid', openUrl: 'https://calendly.com/nimafarshid/gaia-healers-meeting' },
    ];
  }

  window.GaiaBookingSet = bookingSet;   // Today's booking card (gaia-member.js) reads the same list

  function bookingCatalog() {
    const verified = bookingSet();
    return '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Schedule</p><h2>Book a session</h2></div></div>'
      + verified.map((item) => '<button type="button" class="g-super-row" data-book-inline="' + esc(item.openUrl || '') + '" data-book-title="' + esc(item.name || 'Book a session') + '"><span class="g-super-row__icon">' + icon('calendar-plus') + '</span><span><strong>' + esc(item.name || 'Book a session') + '</strong><em>Open the secure booking form</em></span>' + icon('caret-right') + '</button>').join('') + '</section>';
  }

  function renderInbox() {
    const root = $('inbox-body');
    if (!root) return;
    if (!memberState().authed) {
      root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Member messages</p><h1>Inbox</h1><p>Sign in to see your message summaries.</p></div>' + guestJoinBlock();
      bind(root); updateInboxBadge(); return;
    }
    const items = notifications();
    const rows = items.length ? items.map((item) => '<article class="g-super-row g-super-row--static' + (item.unread ? ' is-unread' : '') + '"><span class="g-super-row__icon">' + icon(item.unread ? 'chat-circle-dots' : 'chat-circle') + '</span><span><small>' + (item.unread ? esc(item.unread + ' unread') : 'Conversation') + '</small><strong>' + esc(item.lastMessage || 'Open your Gaia Healers portal to continue this conversation.') + '</strong><em>' + esc(item.updatedAt ? new Date(item.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '') + '</em></span></article>').join('')
      : '<section class="g-super-empty-panel"><h2>You’re all caught up</h2><p>No messages yet.</p></section>';
    root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Member messages</p><h1>Inbox</h1><p>Read-only summaries of your messages. Continue securely in the member portal.</p></div>'
      + '<section class="g-super-list">' + rows + '<div class="g-super-list__footer"><button type="button" class="g-btn g-btn--secondary" data-open-in-app="' + esc('https://education.gaiahealers.com') + '" data-in-app-title="Gaia Healers member portal">Open member portal</button></div></section>';
    bind(root); updateInboxBadge();
  }

  function updateInboxBadge() {
    // The tab bar has no Inbox tab: shared-nav.js maps the inbox view onto the
    // Community tab (VIEW_TO_TAB), so the unread badge lives there.
    const link = document.querySelector('.gaia-tabbar__link[data-app-nav="community"]');
    if (!link) return;
    link.querySelector('.gaia-tabbar__badge')?.remove();
    const unread = Number(memberState().data?.notif?.counts?.unread || 0);
    if (memberState().authed && unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'gaia-tabbar__badge';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.setAttribute('aria-label', unread + ' unread messages');
      link.appendChild(badge);
    }
  }

  function bind(root) {
    // Event carousel: dots reflect the swiped position and jump to a slide.
    root.querySelectorAll('[data-event-carousel]').forEach((car) => {
      const track = car.querySelector('[data-carousel-track]');
      const dots = Array.from(car.querySelectorAll('[data-carousel-dot]'));
      if (!track || !dots.length) return;
      const sync = () => {
        const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        dots.forEach((d, n) => d.classList.toggle('is-active', n === i));
      };
      track.addEventListener('scroll', () => window.requestAnimationFrame(sync), { passive: true });
      dots.forEach((dot, n) => dot.addEventListener('click', () => {
        track.scrollTo({ left: n * track.clientWidth, behavior: 'smooth' });
      }));
    });
    root.querySelectorAll('[data-dir-intent]').forEach((button) => button.addEventListener('click', (e) => { e.preventDefault(); if (window.GaiaDirectory?.open) window.GaiaDirectory.open({ intent: button.dataset.dirIntent }); else window.GaiaAppShell?.go?.('directory'); }));
    root.querySelectorAll('[data-super-signin]').forEach((button) => button.addEventListener('click', () => window.GaiaAuth?.open?.()));
    root.querySelectorAll('[data-super-join]').forEach((button) => button.addEventListener('click', () => { window.GaiaAuth?.open?.(); setTimeout(() => document.querySelector('[data-join-toggle]')?.click(), 120); }));
    // "Ask Gaia" on Today opens the conversation through the shell's own door (the avatar uses the same one).
    root.querySelectorAll('[data-gaia-open-assist]').forEach((button) => button.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('gaia:open-assist', { detail: { source: 'today' } }));
    }));
    root.querySelectorAll('[data-super-course]').forEach((button) => button.addEventListener('click', () => {
      const url = button.dataset.superCourse;
      if (!url) return;
      window.GaiaInApp?.open?.(url, button.dataset.superCourseTitle || 'Gaia Healers Academy');
    }));
  }

  function render() {
    renderHome();
    renderEvents();
    renderBookings();
    renderInbox();
    updateInboxBadge();
  }

  window.GaiaSuperApp = { render };
  document.addEventListener('DOMContentLoaded', render);
  document.addEventListener('gaia:member', render);
  document.addEventListener('gaia:event', render);
  document.addEventListener('gaia:sync', render);
  document.addEventListener('gaia:auth', () => window.setTimeout(render, 0));
  window.addEventListener('gaia:route', (event) => {
    if (['today', 'events', 'bookings', 'inbox'].includes(event.detail?.view)) render();
  });
})();
