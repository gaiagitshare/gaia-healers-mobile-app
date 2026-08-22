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
  const EVENT_LIVE_TTL_MS = 30 * 1000;

  function proxyBase() {
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
    const items = Array.isArray(detail?.announcements) ? detail.announcements : [];
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
    return '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Who is speaking</p><h2>Speakers</h2></div></div>'
      + speakers.map((speaker) => '<div class="g-super-row"><span class="g-super-row__icon">' + icon('microphone-stage') + '</span>'
        + '<span><strong>' + esc(speaker.name) + '</strong><em>' + esc([speaker.role, speaker.company].filter(Boolean).join(' · ')) + '</em></span></div>').join('')
      + '</section>';
  }

  function directorySection(detail) {
    const exhibitors = Array.isArray(detail?.exhibitors) ? detail.exhibitors : [];
    if (!exhibitors.length) return '';
    return '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Exhibit hall</p><h2>Vendor directory</h2></div></div>'
      + exhibitors.map((vendor) => {
        const meta = [vendor.booth_number ? 'Booth ' + vendor.booth_number : '', vendor.category].filter(Boolean).join(' · ');
        const row = '<span class="g-super-row__icon">' + icon('storefront') + '</span>'
          + '<span><strong>' + esc(vendor.company_name) + '</strong><em>' + esc(meta || vendor.description || '') + '</em></span>';
        return vendor.website
          ? '<a class="g-super-row" href="' + esc(vendor.website) + '" target="_blank" rel="noopener noreferrer">' + row + icon('arrow-up-right') + '</a>'
          : '<div class="g-super-row">' + row + '</div>';
      }).join('')
      + '</section>';
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

  function authPrompt(compact) {
    return '<section class="g-super-auth g-why-join' + (compact ? ' g-super-auth--compact' : '') + '">'
      + '<div class="g-why-join__intro"><p class="g-super-kicker">Join free</p><h2>Make Gaia Healers yours</h2>'
      + '<p>A free account saves your Daily Energy and streak, and brings your real courses, community and plan access into one place.</p></div>'
      + '<ul class="g-why-join__list">'
      + '<li>' + icon('check-circle') + '<span>Save your Daily Energy, streak &amp; readings</span></li>'
      + '<li>' + icon('check-circle') + '<span>Your real courses, certifications &amp; plan — synced automatically</span></li>'
      + '<li>' + icon('check-circle') + '<span>Events, bookings, community &amp; Store, all in one home</span></li>'
      + '</ul>'
      + '<div class="g-super-actions"><button type="button" class="g-btn g-btn--primary" data-super-join>' + icon('sparkle') + ' Join free</button>'
      + '<button type="button" class="g-btn g-btn--secondary" data-super-signin>Sign in</button>'
      + '<a class="g-btn g-btn--ghost" href="home.html?view=store&tab=membership">Compare plans</a></div>'
      + '<p class="g-why-join__note">Name and email only — we send a one-tap sign-in link, then you can add your birth date for a personal Daily Energy. No long forms.</p>'
      + '</section>';
  }

  function freeTools() {
    const tools = [
      ['wellness&tab=check', 'sparkle', 'Energy check', 'Today’s body point and practice'],
      ['wellness&tab=horoscope', 'moon-stars', 'Horoscope', 'Your reflective daily guidance'],
      ['wellness&tab=chakras', 'circles-three-plus', 'Chakra match', 'Explore centres and products'],
      ['wellness&tool=colour', 'palette', 'Colour test', 'Five free questions'],
      ['events', 'calendar-dots', 'Events', 'Gatherings and live sessions'],
      ['store', 'bag', 'Gaia Healers Store', 'Sprays, tools and memberships'],
    ];
    // The template's four doors, colour-coded: the icons are the wayfinding.
    const TINT = { 'Energy check': 'var(--g-accent)', Horoscope: 'var(--g-teal)',
      'Chakra match': 'var(--g-purple)', 'Colour test': 'var(--g-gold)' };
    const four = tools.filter((t) => TINT[t[2]]);
    return '<section class="g-free-tools"><div class="g-super-section-head"><div><p class="g-super-kicker">Explore free</p><h2>Try Gaia Healers today</h2></div></div><div class="g-free-tools__grid">'
      + four.map((item) => '<a class="g-free-tool" style="--tool:' + TINT[item[2]] + '" href="home.html?view=' + item[0] + '"><span>' + icon(item[1]) + '</span><strong>' + esc(item[2]) + '</strong><small>' + esc(item[3]) + '</small></a>').join('')
      + '</div></section>';
  }

  function journeyRail() {
    const learn = courseGrants().length > 0;
    const practice = upcomingAppointments().length > 0;
    const connect = communities().length > 0;
    const item = (label, iconName, active) => '<div class="g-journey-step' + (active ? ' is-ready' : '') + '">'
      + '<span>' + icon(iconName) + '</span><strong>' + esc(label) + '</strong><small>' + (active ? 'Ready' : 'Explore') + '</small></div>';
    return '<div class="g-journey-rail" aria-label="Your Gaia Healers journey">'
      + item('Learn', 'book-open', learn) + item('Practice', 'sparkle', practice) + item('Connect', 'users-three', connect) + '</div>';
  }

  function primaryMemberAction() {
    const firstCourse = courseGrants()[0];
    const nextAppointment = upcomingAppointments()[0];
    if (firstCourse?.openUrl) {
      return '<section class="g-super-primary"><p class="g-super-kicker">Continue learning</p>'
        + '<h2>' + esc(firstCourse.title || firstCourse.name || 'Your course') + '</h2>'
        + '<p>Your access is active. Lessons and verified progress open in your secure Academy workspace.</p>'
        + '<button type="button" class="g-btn g-btn--primary g-super-primary__button" data-super-course="' + esc(firstCourse.openUrl) + '" data-super-course-title="' + esc(firstCourse.title || firstCourse.name || 'Gaia Healers Academy') + '">'
        + icon('book-open') + ' Open course ' + icon('arrow-right') + '</button></section>';
    }
    if (nextAppointment) {
      return '<section class="g-super-primary"><p class="g-super-kicker">Coming up</p><h2>' + esc(nextAppointment.title || 'Your appointment') + '</h2>'
        + '<p>' + esc(appointmentWhen(nextAppointment)) + '</p><a class="g-btn g-btn--primary g-super-primary__button" href="home.html?view=bookings">'
        + icon('calendar-check') + ' View booking ' + icon('arrow-right') + '</a></section>';
    }
    return '<section class="g-super-primary"><p class="g-super-kicker">Your access</p><h2>Your Gaia Healers access is ready</h2>'
      + '<p>No course or appointment yet. Explore your verified access or choose your next step.</p>'
      + '<a class="g-btn g-btn--primary g-super-primary__button" href="home.html?view=profile">'
      + icon('user') + ' View your account ' + icon('arrow-right') + '</a></section>';
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
    const register = event.registrationUrl
      ? '<a class="g-btn g-btn--primary g-btn--sm" href="' + esc(event.registrationUrl) + '" target="_blank" rel="noopener noreferrer">'
        + esc(event.registrationLabel || 'Get tickets') + '</a>'
      : '';

    return '<section class="g-feature-event">'
      + '<div class="g-feature-event__art">'
      + '<img src="' + esc(art) + '" alt="' + esc(event.name) + '" width="426" height="358" loading="eager" /></div>'
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
    const greeting = authed ? ('Welcome back' + (firstName ? ', ' + esc(firstName) : '')) : dayGreeting;
    const services = serviceLink('academy', 'graduation-cap', 'Academy', stateMeta('Courses and certifications', courseGrants().length, 'course', 'courses'))
      + serviceLink('community', 'users-three', 'Community', stateMeta('Boards and circles', communities().length, 'community', 'communities'))
      + serviceLink('events', 'calendar-dots', 'Events', eventData()?.name ? 'Upcoming gathering available' : 'Gatherings and live sessions')
      + serviceLink('bookings', 'calendar-check', 'Bookings', stateMeta('Sessions and consultations', upcomingAppointments().length, 'upcoming booking', 'upcoming bookings'));

    root.innerHTML = '<div class="g-super-home">'
      // The greeting opens the card on its own; the date and the question sit
      // with the actions at the foot. Reordered here rather than with CSS
      // `order` so what a screen reader hears matches what the eye sees.
      + '<section class="g-super-hero"><div class="g-super-hero__intro">'
      + '<h1>' + greeting + '</h1>'
      + '<p class="g-super-date">' + esc(dateLabel()) + '</p>'
      + '<p>' + (authed ? 'Your healing journey is waiting.' : 'What does your energy need today?') + '</p>'
      + (authed ? '' : '<div class="g-super-discover g-super-discover--solo"><a class="g-btn g-btn--primary" href="home.html?view=wellness&tab=check">' + icon('sparkle') + ' Check my energy</a></div>') + '</div><div class="g-super-hero__art"><picture><source media="(min-width: 900px)" srcset="assets/gaia-hero-moon.png" /><img src="assets/gaia-hero-moon-wide.png" alt="Person meditating in lotus pose under a full moon over mountains" width="1024" height="576" loading="eager" /></picture></div></section>'
      + '<div data-daily-host></div>'
      + (authed
        // Member flow: lead with the next step and their real access, then the
        // daily sky, the event, the free wellness tools, and the sync note.
        ? primaryMemberAction()
          + (activeMembership() ? '' : upgradeCard())
          + '<section class="g-super-services"><div class="g-super-section-head"><div><p class="g-super-kicker">Your access</p><h2>Everything Gaia Healers</h2></div><a href="home.html?view=profile">Your account</a></div><div class="g-super-services__grid">' + services + '</div></section>'
          + '<div data-sky-host></div>'
          + eventFeatureCarousel()
          + nextBookingCard()
          + freeTools()
          + '<section class="g-super-sync">' + icon('check-circle') + '<div><strong>Your access is synced</strong><span>Courses, communities, plans and purchases reflect your Gaia Healers account.</span></div></section>'
        // Logged-out flow: the free tools first — the one thing a stranger can
        // use right now — then today's sky, the event, one clear way in, and the
        // wider ecosystem last so the top of the page stays short and focused.
        // Ecosystem links moved into the Menu — the guest home stays short.
        : eventFeatureCarousel()
          + freeTools()
          + '<div data-sky-host></div>'
          + authPrompt(true))
      + '</div>';
    bind(root);
    // Panels that live inside the home screen but are owned by their own files
    // follow this rather than the superapp having to know they exist.
    document.dispatchEvent(new CustomEvent('gaia:superapp-rendered', { detail: { authed } }));
  }

  /** The member's way back into their course — real grants only. No invented
   * lesson counts or progress bars until real progress data exists. */
  function continueJourney(authed) {
    if (!authed) return '';
    const course = courseGrants()[0];
    if (!course) return '';
    const title = course.title || course.name || 'Your course';
    const url = course.openUrl || memberState().data?.courses?.portalUrl || '';
    return '<section class="g-continue">'
      + '<p class="g-super-kicker">Continue your journey</p>'
      + '<div class="g-continue__row">'
      + '<span class="g-continue__art" aria-hidden="true">' + icon('book-open') + '</span>'
      + '<div class="g-continue__body"><h3>' + esc(title) + '</h3>'
      + '<p>Pick up where you left off</p></div>'
      + (url ? '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-super-course="' + esc(url) + '" data-super-course-title="' + esc(title) + '">Continue</button>' : '')
      + '</div></section>';
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

  // Real credentials only — derived from the member's actual GHL tags and
  // resolved membership. Never inferred from owning a course. Hidden if none.
  function credentialsSection() {
    const acc = memberState().data && memberState().data.access;
    const m = (acc && acc.member) || {};
    const mem = acc && acc.membership;
    const badges = [];
    if (m.practitionerCertified) badges.push(['seal-check', 'Certified Bio-Well Practitioner', 'Verified certification']);
    else if (m.practitioner) badges.push(['user-focus', 'Gaia Healers Practitioner', 'Practitioner status']);
    if (mem && mem.key && ['active', 'trialing', 'past_due'].includes(mem.status)) {
      let sub = mem.subtitle || 'Active membership';
      if (mem.started_at) { const d = new Date(mem.started_at); if (!isNaN(d.getTime())) sub = 'Member since ' + d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); }
      const label = mem.label || (mem.key.charAt(0).toUpperCase() + mem.key.slice(1));
      badges.push(['crown-simple', label + ' Member', sub]);
    }
    if (!badges.length) return '';
    return '<section class="g-jcreds"><p class="g-super-kicker">Your credentials</p><div class="g-jcreds__grid">'
      + badges.map((b) => '<div class="g-jcred"><span class="g-jcred__ic">' + icon(b[0]) + '</span><div class="g-jcred__body"><strong>' + esc(b[1]) + '</strong><small>' + esc(b[2]) + '</small></div></div>').join('')
      + '</div></section>';
  }

  // Academy SUMMARY (count + link) — the full library lives in the Academy
  // screen, so Journey never duplicates the course list.
  function academySummary() {
    const n = courseGrants().length;
    const inner = n
      ? '<a class="g-super-row" href="home.html?view=academy"><span class="g-super-row__icon">' + icon('graduation-cap') + '</span><span><small>Course access</small><strong>' + n + ' course' + (n === 1 ? '' : 's') + ' in your Academy</strong><em>Open the Academy for lessons &amp; certificates</em></span>' + icon('caret-right') + '</a>'
      : '<a class="g-super-row" href="home.html?view=academy"><span class="g-super-row__icon">' + icon('graduation-cap') + '</span><span><small>Academy</small><strong>Browse courses &amp; certifications</strong><em>See what your membership unlocks</em></span>' + icon('caret-right') + '</a>';
    return '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Academy</p><h2>Your courses</h2></div><a href="home.html?view=academy">Open Academy</a></div>' + inner + '</section>';
  }

  async function fillJourneyStreak() {
    const host = document.querySelector('[data-journey-streak]'); if (!host) return;
    try {
      const r = await fetch(proxyBase() + '/api/wellness/daily', { credentials: 'include' });
      const d = await r.json();
      if (d && !d.guest && d.ritual) {
        const cur = d.ritual.current || 0;
        host.innerHTML = '<div class="g-super-row"><span class="g-super-row__icon">' + icon('flame') + '</span><span><small>Daily Energy</small><strong>' + (cur > 0 ? cur + ' day streak' : 'Begin your streak today') + '</strong><em>' + (d.ritual.total || 0) + ' ritual' + ((d.ritual.total || 0) === 1 ? '' : 's') + ' completed</em></span></div>';
      } else {
        host.innerHTML = '<a class="g-super-row" href="home.html?view=today"><span class="g-super-row__icon">' + icon('sparkle') + '</span><span><small>Daily Energy</small><strong>Start your daily practice</strong><em>Personalise your energy on Today</em></span>' + icon('caret-right') + '</a>';
      }
    } catch (e) { host.innerHTML = ''; }
  }

  async function fillJourneyEvents() {
    const sec = document.querySelector('[data-journey-events-sec]');
    const host = document.querySelector('[data-journey-events]');
    if (!host) return;
    try {
      const r = await fetch(proxyBase() + '/api/events/mine', { credentials: 'include' });
      if (!r.ok) return;
      const d = await r.json();
      const rows = (d && (d.events || d.tickets || d.registrations)) || [];
      if (!Array.isArray(rows) || !rows.length) return; // hide when there is no real ticket
      const html = rows.map((ev) => {
        const t = ev.ticket || ev;
        const attended = !!t.checkedIn;
        const when = attended && t.checkedInAt ? ' · ' + new Date(t.checkedInAt).toLocaleDateString() : '';
        return '<div class="g-super-row"><span class="g-super-row__icon">' + icon(attended ? 'seal-check' : 'ticket') + '</span><span><small>' + (attended ? 'Attended' : 'Registered') + '</small><strong>' + esc(ev.name || ev.eventName || ev.title || 'Gaia Healers event') + '</strong><em>' + (attended ? 'Checked in' + when : 'You have a ticket') + '</em></span></div>';
      }).join('');
      host.innerHTML = html;
      if (sec) sec.hidden = false;
    } catch (e) { /* leave hidden */ }
  }

  function renderJourney() {
    const root = $('journey-body');
    if (!root) return;
    if (!memberState().authed) {
      root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Learn · practice · connect</p><h1>Choose your path</h1><p>Explore Gaia Healers freely. Your Member Pass adds the courses and communities included with your plan.</p></div>'
        + '<section class="g-super-services"><div class="g-super-services__grid">'
        + serviceLink('academy', 'book-open', 'Learn', 'Preview Academy and certifications')
        + serviceLink('wellness', 'sparkle', 'Practice', 'Energy, chakra and wellness tools')
        + serviceLink('events', 'users-three', 'Connect', 'Events, circles and practitioners')
        + serviceLink('bookings', 'calendar-check', 'Book', 'Sessions and consultations')
        + '</div></section>' + authPrompt(true);
      bind(root); return;
    }
    const courses = courseGrants();
    const appts = upcomingAppointments();
    const circles = communities();
    const courseRows = courses.length ? courses.map((course) => '<button type="button" class="g-super-row" data-super-course="' + esc(course.openUrl || memberState().data?.courses?.portalUrl || '') + '" data-super-course-title="' + esc(course.title || course.name || 'Gaia Healers Academy') + '"><span class="g-super-row__icon">' + icon('book-open') + '</span><span><small>Course access</small><strong>' + esc(course.title || course.name || 'Course') + '</strong><em>Open your member workspace</em></span>' + icon('caret-right') + '</button>').join('') : '<p class="g-super-empty">No courses yet.</p>';
    const apptRows = appts.length ? appts.slice(0, 3).map((item) => '<a class="g-super-row" href="home.html?view=bookings"><span class="g-super-row__icon">' + icon('calendar-check') + '</span><span><small>Practice</small><strong>' + esc(item.title || 'Appointment') + '</strong><em>' + esc(appointmentWhen(item)) + '</em></span>' + icon('caret-right') + '</a>').join('') : '<p class="g-super-empty">No upcoming appointments.</p>';
    const circleRows = circles.length ? circles.map((item) => '<button type="button" class="g-super-row" data-open-in-app="' + esc(item.openUrl || 'https://education.gaiahealers.com') + '" data-in-app-title="' + esc(item.name || 'Gaia Healers Community') + '"><span class="g-super-row__icon">' + icon('users-three') + '</span><span><small>Community access</small><strong>' + esc(item.name || 'Community') + '</strong><em>Open your authorized circle</em></span>' + icon('caret-right') + '</button>').join('') : '<p class="g-super-empty">No circles joined yet.</p>';
    root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Your Gaia Healers journey</p><h1>Your journey</h1><p>Everything here is verified from your real Gaia Healers record.</p></div>'
      + credentialsSection()
      + journeyRail()
      + '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Practice</p><h2>Daily practice</h2></div><a href="home.html?view=today">Today</a></div><div data-journey-streak><p class="g-super-empty">…</p></div>' + apptRows + '</section>'
      + academySummary()
      + '<section class="g-super-list" data-journey-events-sec hidden><div class="g-super-section-head"><div><p class="g-super-kicker">Events</p><h2>Your events</h2></div><a href="home.html?view=events">Events</a></div><div data-journey-events></div></section>'
      + '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Community</p><h2>Your communities</h2></div><a href="home.html?view=community">Community</a></div>' + circleRows + '</section>'
    bind(root);
    fillJourneyStreak();
    fillJourneyEvents();
  }

  // ---- Events: hub and per-event page -------------------------------------
  // The hub lists whatever the Event Manager publishes; ?event=N opens one.
  // Nothing about any particular event is written here.
  const eventUI = { tab: 'overview', past: null, pastLoading: false, live: {} };
  const EVENT_TABS = [
    ['overview', 'Overview'], ['agenda', 'Agenda'], ['speakers', 'Speakers'],
    ['exhibitors', 'Exhibitors'], ['map', 'Map'], ['people', 'People'],
    ['sponsors', 'Sponsors'], ['updates', 'Updates'],
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
      + '<a class="g-event-card__art" href="home.html?view=events&event=' + esc(item.id) + '">' + eventHero(item) + '</a>'
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
        + '<a class="g-event-card__art" href="home.html?view=events&event=' + esc(item.id) + '">' + eventHero(item) + '</a>'
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

  function eventTabPanel(tab, detail, live) {
    if (tab === 'agenda') return agendaSection(detail);
    if (tab === 'map') return mapSection(detail);
    if (tab === 'people') return window.GaiaPeople ? window.GaiaPeople.panelHtml() : '';
    if (tab === 'speakers') return speakersSection(detail);
    if (tab === 'exhibitors') return directorySection(detail);
    if (tab === 'sponsors') return sponsorsSection(detail);
    if (tab === 'updates') return updatesSection(detail, live);
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
    if (tab === 'updates') return Boolean(detail?.announcements?.length);
    return false;
  }

  // Which event's schedule we have already asked for, so the request fires once
  // per event rather than on every re-render.
  let scheduleLoadedFor = null;

  function renderEventDetail(root, eventId) {
    loadEventDetail(eventId);
    loadEventLive(eventId);
    scheduleEventRefresh(root, eventId);
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
      + (item.description ? '<p>' + esc(item.description) + '</p>' : '')
      + '<dl><div><dt>Dates</dt><dd>' + esc(humanDates(item) || 'To be announced') + '</dd></div>'
      + '<div><dt>Venue</dt><dd>' + esc(item.venue || 'To be announced') + '</dd></div>'
      + (item.timezone ? '<div><dt>Local time</dt><dd>' + esc(String(item.timezone).replace(/_/g, ' ')) + '</dd></div>' : '')
      + '</dl>' + registrationCta(item) + '</section>';

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
      + offlineLine
      + liveSection(live)
      + tabBar
      + '<div class="g-event-panel">' + (eventUI.tab === 'overview' ? overview : eventTabPanel(eventUI.tab, detail, live)) + '</div>';

    root.querySelectorAll('[data-event-tab]').forEach((button) => {
      button.addEventListener('click', () => { eventUI.tab = button.getAttribute('data-event-tab'); render(); });
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
      root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Sessions and consultations</p><h1>Book your next step</h1><p>Explore real Gaia Healers sessions now. Member appointments appear after you connect your Member Pass.</p></div>' + bookingCatalog() + authPrompt(true);
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

  function bookingCatalog() {
    const links = bookingLinks();
    const fallback = [
      { name: 'Bio-Well energy scan', openUrl: 'https://api.leadconnectorhq.com/widget/bookings/scans' },
      { name: 'Bio-Well demo', openUrl: 'https://api.leadconnectorhq.com/widget/bookings/bio-welldemo' },
      { name: 'Meet Dr. Nima Farshid', openUrl: 'https://calendly.com/nimafarshid/gaia-healers-meeting' },
    ];
    const verified = links.length ? links : fallback;
    return '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Schedule</p><h2>Book a session</h2></div></div>'
      + verified.map((item) => '<button type="button" class="g-super-row" data-book-inline="' + esc(item.openUrl || '') + '" data-book-title="' + esc(item.name || 'Book a session') + '"><span class="g-super-row__icon">' + icon('calendar-plus') + '</span><span><strong>' + esc(item.name || 'Book a session') + '</strong><em>Open the secure booking form</em></span>' + icon('caret-right') + '</button>').join('') + '</section>';
  }

  function renderInbox() {
    const root = $('inbox-body');
    if (!root) return;
    if (!memberState().authed) {
      root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Member messages</p><h1>Inbox</h1><p>Sign in to see your message summaries.</p></div>' + authPrompt(false);
      bind(root); updateInboxBadge(); return;
    }
    const items = notifications();
    const rows = items.length ? items.map((item) => '<article class="g-super-row g-super-row--static' + (item.unread ? ' is-unread' : '') + '"><span class="g-super-row__icon">' + icon(item.unread ? 'chat-circle-dots' : 'chat-circle') + '</span><span><small>' + (item.unread ? esc(item.unread + ' unread') : 'Conversation') + '</small><strong>' + esc(item.lastMessage || 'Open your Gaia Healers portal to continue this conversation.') + '</strong><em>' + esc(item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '') + '</em></span></article>').join('')
      : '<section class="g-super-empty-panel"><h2>You’re all caught up</h2><p>No messages yet.</p></section>';
    root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Member messages</p><h1>Inbox</h1><p>Read-only summaries of your messages. Continue securely in the member portal.</p></div>'
      + '<section class="g-super-list">' + rows + '<div class="g-super-list__footer"><button type="button" class="g-btn g-btn--secondary" data-open-in-app="' + esc('https://education.gaiahealers.com') + '" data-in-app-title="Gaia Healers member portal">Open member portal</button></div></section>';
    bind(root); updateInboxBadge();
  }

  function updateInboxBadge() {
    const link = document.querySelector('.gaia-tabbar__link[data-app-nav="inbox"]');
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
    root.querySelectorAll('[data-super-signin]').forEach((button) => button.addEventListener('click', () => window.GaiaAuth?.open?.()));
    root.querySelectorAll('[data-super-join]').forEach((button) => button.addEventListener('click', () => { window.GaiaAuth?.open?.(); setTimeout(() => document.querySelector('[data-join-toggle]')?.click(), 120); }));
    root.querySelectorAll('[data-gaia-open-assist]').forEach((button) => button.addEventListener('click', () => {
      document.querySelector('[data-gaia-tab-assist]')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
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
