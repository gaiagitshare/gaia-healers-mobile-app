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
  const eventDetail = { id: null, data: null, loading: false };

  function proxyBase() {
    return String(
      (window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
      || 'https://api.gaiahealers.app',
    ).replace(/\/+$/, '');
  }

  // Bootstrap ids look like "event-1"; the API wants the number.
  const eventNumericId = (event) => String(event?.id || '').replace(/^event-/, '').trim();

  function loadEventDetail(event) {
    const id = eventNumericId(event);
    if (!id || !/^\d+$/.test(id)) return;
    if (eventDetail.loading || eventDetail.id === id) return;
    eventDetail.loading = true;
    fetch(proxyBase() + '/api/events/' + encodeURIComponent(id), {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (payload && payload.ok) {
          eventDetail.id = id;
          eventDetail.data = payload;
          render();
        }
      })
      .catch(() => { /* the event card still renders without the agenda */ })
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

  function agendaSection(detail) {
    const days = Array.isArray(detail?.agenda?.days) ? detail.agenda.days : [];
    if (!days.length) return '';
    const zone = detail?.event?.timezone ? ' · times shown in ' + esc(detail.event.timezone.replace(/_/g, ' ')) : '';
    return '<section class="g-event-timeline"><p class="g-super-kicker">Published schedule' + zone + '</p><h2>Agenda</h2>'
      + days.map((day) => '<div class="g-event-day"><h3>' + esc(day.label || day.date) + '</h3>'
        + (day.sessions || []).map((session) => {
          const when = [sessionTime(session.start_time), sessionTime(session.end_time)].filter(Boolean).join(' – ');
          const meta = [session.room, session.track].filter(Boolean).join(' · ');
          const who = (session.speakers || []).map((speaker) => speaker.name).filter(Boolean).join(', ');
          return '<div class="g-event-timeline__item"><time>' + esc(when) + '</time><div><strong>' + esc(session.title) + '</strong>'
            + (who ? '<span>' + esc(who) + '</span>' : '')
            + (meta ? '<span>' + esc(meta) + '</span>' : '')
            + (session.description ? '<span>' + esc(session.description) + '</span>' : '')
            + '</div></div>';
        }).join('')
        + '</div>').join('')
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
    return '<section class="g-super-auth' + (compact ? ' g-super-auth--compact' : '') + '">'
      + '<div><p class="g-super-kicker">Member Pass</p><h2>Already part of Gaia?</h2>'
      + '<p>Sign in once to sync the courses, communities and plan access attached to your GHL record.</p></div>'
      + '<div class="g-super-actions"><button type="button" class="g-btn g-btn--primary" data-super-signin>Sign in</button>'
      + '<button type="button" class="g-btn g-btn--secondary" data-open-in-app="https://join.gaiahealers.com/onboarding" data-in-app-title="Join Gaia Healers">Join free</button>'
      + '<a class="g-btn g-btn--ghost" href="home.html?view=store&tab=membership">Compare plans</a></div>'
      + '</section>';
  }

  function freeTools() {
    const tools = [
      ['wellness&tab=check', 'sparkle', 'Energy check', 'Today’s body point and practice'],
      ['wellness&tab=horoscope', 'moon-stars', 'Horoscope', 'Your reflective daily guidance'],
      ['wellness&tab=chakras', 'circles-three-plus', 'Chakra match', 'Explore centres and products'],
      ['profile&tool=colour', 'palette', 'Colour test', 'Five free questions'],
      ['events', 'calendar-dots', 'Events', 'Gatherings and live sessions'],
      ['store', 'bag', 'Gaia Store', 'Sprays, tools and memberships'],
    ];
    return '<section class="g-free-tools"><div class="g-super-section-head"><div><p class="g-super-kicker">Explore free</p><h2>Try Gaia today</h2></div></div><div class="g-free-tools__grid">'
      + tools.map((item) => '<a class="g-free-tool" href="home.html?view=' + item[0] + '"><span>' + icon(item[1]) + '</span><strong>' + esc(item[2]) + '</strong><small>' + esc(item[3]) + '</small></a>').join('')
      + '</div></section>';
  }

  function discoverGaia() {
    const items = [
      ['heartbeat', 'Bio-Well demo', 'See energy technology in action', 'https://api.leadconnectorhq.com/widget/bookings/bio-welldemo'],
      ['map-pin', 'Find a practitioner', 'Browse the verified Gaia directory', 'https://gaiapractitioners.com'],
      ['flask', 'Bio-Well research', 'Explore Gaia’s public research library', 'https://gaiahealers.com/pages/bio-well-research'],
      ['newspaper', 'Gaia articles', 'Read current wellness and technology insights', 'https://gaiahealers.com/blogs/news'],
      ['book-open', 'Education & community', 'Start free or enter the learning portal', 'https://join.gaiahealers.com/'],
      ['briefcase', 'Practitioner tools', 'Open CRM, software and practice support', 'https://nextlevel.gaiahealers.com/'],
    ];
    return '<section class="g-super-discover-gaia"><div class="g-super-section-head"><div><p class="g-super-kicker">Across Gaia Healers</p><h2>Discover the ecosystem</h2></div></div><div class="g-super-discover-gaia__grid">'
      + items.map((item) => '<button type="button" class="g-super-resource" data-open-in-app="' + esc(item[3]) + '" data-in-app-title="' + esc(item[1]) + '"><span>' + icon(item[0]) + '</span><strong>' + esc(item[1]) + '</strong><small>' + esc(item[2]) + '</small>' + icon('arrow-up-right') + '</button>').join('')
      + '</div></section>';
  }

  function journeyRail() {
    const learn = courseGrants().length > 0;
    const practice = upcomingAppointments().length > 0;
    const connect = communities().length > 0;
    const item = (label, iconName, active) => '<div class="g-journey-step' + (active ? ' is-ready' : '') + '">'
      + '<span>' + icon(iconName) + '</span><strong>' + esc(label) + '</strong><small>' + (active ? 'Ready' : 'Explore') + '</small></div>';
    return '<div class="g-journey-rail" aria-label="Your Gaia journey">'
      + item('Learn', 'book-open', learn) + item('Practice', 'sparkle', practice) + item('Connect', 'users-three', connect) + '</div>';
  }

  function primaryMemberAction() {
    const firstCourse = courseGrants()[0];
    const nextAppointment = upcomingAppointments()[0];
    if (firstCourse?.openUrl) {
      return '<section class="g-super-primary"><p class="g-super-kicker">Continue learning</p>'
        + '<h2>' + esc(firstCourse.title || firstCourse.name || 'Your course') + '</h2>'
        + '<p>Your GHL access is active. Lessons and verified progress open in your secure Academy workspace.</p>'
        + '<button type="button" class="g-btn g-btn--primary g-super-primary__button" data-super-course="' + esc(firstCourse.openUrl) + '" data-super-course-title="' + esc(firstCourse.title || firstCourse.name || 'Gaia Academy') + '">'
        + icon('book-open') + ' Open course ' + icon('arrow-right') + '</button></section>';
    }
    if (nextAppointment) {
      return '<section class="g-super-primary"><p class="g-super-kicker">Coming up</p><h2>' + esc(nextAppointment.title || 'Your appointment') + '</h2>'
        + '<p>' + esc(appointmentWhen(nextAppointment)) + '</p><a class="g-btn g-btn--primary g-super-primary__button" href="home.html?view=bookings">'
        + icon('calendar-check') + ' View booking ' + icon('arrow-right') + '</a></section>';
    }
    return '<section class="g-super-primary"><p class="g-super-kicker">Your journey</p><h2>Your Gaia access is ready</h2>'
      + '<p>No course or appointment is currently attached to this GHL contact. Explore your verified access or choose your next step.</p>'
      + '<a class="g-btn g-btn--primary g-super-primary__button" href="home.html?view=journey">'
      + icon('path') + ' Open your journey ' + icon('arrow-right') + '</a></section>';
  }

  function eventRow() {
    const event = eventData();
    if (!event?.name) {
      return '<section class="g-super-event g-super-event--empty"><div><p class="g-super-kicker">Events</p><h2>Next gathering</h2>'
        + '<p>The next confirmed Gaia event will appear here when it is published.</p></div><a href="home.html?view=events" class="g-btn g-btn--secondary">View events</a></section>';
    }
    const location = event.location || event.venue || '';
    return '<a class="g-super-event" href="home.html?view=events">'
      + '<img src="assets/gaia-event-hero.webp" alt="" width="180" height="180" loading="lazy" />'
      + '<span class="g-super-event__copy"><small>Upcoming gathering</small><strong>' + esc(event.name) + '</strong>'
      + '<span>' + [eventDate(event), location].filter(Boolean).map(esc).join(' · ') + '</span></span>'
      + icon('caret-right') + '</a>';
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
      + '<section class="g-super-hero"><div class="g-super-hero__intro"><p class="g-super-date">' + esc(dateLabel()) + '</p>'
      + '<h1>' + greeting + '</h1><p>' + (authed ? 'Your healing journey is waiting.' : 'What does your energy need today?') + '</p>'
      + (authed ? journeyRail() + primaryMemberAction() : '<div class="g-super-discover"><a class="g-btn g-btn--primary" href="home.html?view=wellness&tab=check">' + icon('sparkle') + ' Check my energy</a><button type="button" class="g-btn g-btn--secondary" data-gaia-open-assist>' + icon('microphone') + ' Ask Gaia</button></div>') + '</div><div class="g-super-hero__art" aria-hidden="true"></div></section>'
      + freeTools()
      + (authed ? '<section class="g-super-services"><div class="g-super-section-head"><div><p class="g-super-kicker">Your access</p><h2>Everything Gaia</h2></div><a href="home.html?view=journey">View journey</a></div><div class="g-super-services__grid">' + services + '</div></section>' : '')
      + discoverGaia()
      + eventRow()
      + (!authed ? authPrompt(true) : '')
      + (authed ? '<section class="g-super-sync">' + icon('check-circle') + '<div><strong>Your access is synced</strong><span>Courses, communities, plans and purchases reflect your GHL member record.</span></div></section>' : '')
      + '</div>';
    bind(root);
  }

  function renderJourney() {
    const root = $('journey-body');
    if (!root) return;
    if (!memberState().authed) {
      root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Learn · practice · connect</p><h1>Choose your path</h1><p>Explore Gaia freely. Your Member Pass adds the courses and communities included with your plan.</p></div>'
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
    const courseRows = courses.length ? courses.map((course) => '<button type="button" class="g-super-row" data-super-course="' + esc(course.openUrl || memberState().data?.courses?.portalUrl || '') + '" data-super-course-title="' + esc(course.title || course.name || 'Gaia Academy') + '"><span class="g-super-row__icon">' + icon('book-open') + '</span><span><small>Course access</small><strong>' + esc(course.title || course.name || 'Course') + '</strong><em>Open your verified GHL workspace</em></span>' + icon('caret-right') + '</button>').join('') : '<p class="g-super-empty">No course grants are attached to this GHL contact.</p>';
    const apptRows = appts.length ? appts.slice(0, 3).map((item) => '<a class="g-super-row" href="home.html?view=bookings"><span class="g-super-row__icon">' + icon('calendar-check') + '</span><span><small>Practice</small><strong>' + esc(item.title || 'Appointment') + '</strong><em>' + esc(appointmentWhen(item)) + '</em></span>' + icon('caret-right') + '</a>').join('') : '<p class="g-super-empty">No upcoming appointments.</p>';
    const circleRows = circles.length ? circles.map((item) => '<button type="button" class="g-super-row" data-open-in-app="' + esc(item.openUrl || 'https://education.gaiahealers.com') + '" data-in-app-title="' + esc(item.name || 'Gaia Community') + '"><span class="g-super-row__icon">' + icon('users-three') + '</span><span><small>Community access</small><strong>' + esc(item.name || 'Community') + '</strong><em>Open your authorized circle</em></span>' + icon('caret-right') + '</button>').join('') : '<p class="g-super-empty">No community grants are attached to this GHL contact.</p>';
    root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Learn · practice · connect</p><h1>Your journey</h1><p>Only actions and access verified from your Gaia member record appear here.</p></div>'
      + journeyRail()
      + '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Learn</p><h2>Your courses</h2></div><a href="home.html?view=academy">Academy</a></div>' + courseRows + '</section>'
      + '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Practice</p><h2>Upcoming sessions</h2></div><a href="home.html?view=bookings">Bookings</a></div>' + apptRows + '</section>'
      + '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Connect</p><h2>Your communities</h2></div><a href="home.html?view=community">Community</a></div>' + circleRows + '</section>';
    bind(root);
  }

  function renderEvents() {
    const root = $('events-body');
    if (!root) return;
    const event = eventData();
    loadEventDetail(event);
    const detail = eventDetail.data && eventDetail.id === eventNumericId(event) ? eventDetail.data : null;
    const timeline = Array.isArray(event?.timeline) && event.timeline.length ? '<section class="g-event-timeline"><p class="g-super-kicker">Published schedule</p><h2>Event timeline</h2>' + event.timeline.map((item) => '<div class="g-event-timeline__item"><time>' + esc(item.time) + '</time><div><strong>' + esc(item.title) + '</strong>' + (item.detail ? '<span>' + esc(item.detail) + '</span>' : '') + '</div></div>').join('') + '</section>' : '';
    const publicEvent = event?.name ? '<article class="g-event-detail"><img src="assets/gaia-event-hero.webp" alt="" width="1200" height="720" />'
      + '<div><p class="g-super-kicker">Featured gathering</p><h2>' + esc(event.name) + '</h2><p>' + esc(event.summary || event.description || '') + '</p>'
      + '<dl><div><dt>Date</dt><dd>' + esc(eventDate(event) || 'To be announced') + '</dd></div><div><dt>Location</dt><dd>' + esc([event.venue, event.location].filter(Boolean).join(', ') || 'To be announced') + '</dd></div></dl>'
      + (event.sourceUrl ? '<button type="button" class="g-btn g-btn--primary" data-open-in-app="' + esc(event.sourceUrl) + '" data-in-app-title="' + esc(event.name) + '">View event details ' + icon('arrow-right') + '</button>' : '') + '</div></article>' + timeline
      : '<section class="g-super-empty-panel"><h2>No event is currently published</h2><p>Confirmed event details will appear here from Gaia’s live event service.</p></section>';
    root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Gather in person and online</p><h1>Events</h1><p>Confirmed Gaia gatherings and your member appointments, without placeholder schedules.</p></div>'
      + publicEvent + agendaSection(detail) + speakersSection(detail) + directorySection(detail)
      + (memberState().authed ? '<section class="g-super-list"><div class="g-super-section-head"><div><p class="g-super-kicker">Your calendar</p><h2>Member sessions</h2></div><a href="home.html?view=bookings">View bookings</a></div>'
      + (upcomingAppointments().length ? upcomingAppointments().slice(0, 3).map((item) => '<a class="g-super-row" href="home.html?view=bookings"><span class="g-super-row__icon">' + icon('calendar-check') + '</span><span><strong>' + esc(item.title || 'Appointment') + '</strong><em>' + esc(appointmentWhen(item)) + '</em></span>' + icon('caret-right') + '</a>').join('') : '<p class="g-super-empty">No upcoming member sessions.</p>') + '</section>' : '');
    bind(root);
  }

  function renderBookings() {
    const root = $('bookings-body');
    if (!root) return;
    if (!memberState().authed) {
      root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Sessions and consultations</p><h1>Book your next step</h1><p>Explore real Gaia sessions now. Member appointments appear after you connect your Member Pass.</p></div>' + bookingCatalog() + authPrompt(true);
      bind(root); return;
    }
    const rows = upcomingAppointments().length ? upcomingAppointments().map((item) => {
      const meeting = item.meetingLocation || '';
      const join = item.isVideo && meeting ? '<a class="g-btn g-btn--primary g-btn--sm" href="' + esc(meeting) + '" target="_blank" rel="noopener noreferrer">Join meeting</a>' : '';
      return '<article class="g-booking-item"><div><p class="g-super-kicker">' + esc(item.status || 'Scheduled') + '</p><h2>' + esc(item.title || 'Appointment') + '</h2><p>' + esc(appointmentWhen(item)) + (item.address ? ' · ' + esc(item.address) : '') + '</p></div>' + join + '</article>';
    }).join('') : '<section class="g-super-empty-panel"><h2>No upcoming appointments</h2><p>Choose a verified Gaia booking option below when you are ready.</p></section>';
    root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Your schedule</p><h1>Bookings</h1><p>Appointments are read directly from the GHL contact signed into this app.</p></div>' + rows + bookingCatalog();
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
      root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Member messages</p><h1>Inbox</h1><p>Sign in to see conversation summaries associated with your GHL contact.</p></div>' + authPrompt(false);
      bind(root); updateInboxBadge(); return;
    }
    const items = notifications();
    const rows = items.length ? items.map((item) => '<article class="g-super-row g-super-row--static' + (item.unread ? ' is-unread' : '') + '"><span class="g-super-row__icon">' + icon(item.unread ? 'chat-circle-dots' : 'chat-circle') + '</span><span><small>' + (item.unread ? esc(item.unread + ' unread') : 'Conversation') + '</small><strong>' + esc(item.lastMessage || 'Open your Gaia portal to continue this conversation.') + '</strong><em>' + esc(item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '') + '</em></span></article>').join('')
      : '<section class="g-super-empty-panel"><h2>You’re all caught up</h2><p>No conversations were returned for this GHL contact.</p></section>';
    root.innerHTML = '<div class="g-super-page-head"><p class="g-super-kicker">Member messages</p><h1>Inbox</h1><p>Read-only conversation summaries from GHL. Continue securely in the member portal.</p></div>'
      + '<section class="g-super-list">' + rows + '<div class="g-super-list__footer"><button type="button" class="g-btn g-btn--secondary" data-open-in-app="' + esc('https://education.gaiahealers.com') + '" data-in-app-title="Gaia member portal">Open member portal</button></div></section>';
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
    root.querySelectorAll('[data-super-signin]').forEach((button) => button.addEventListener('click', () => window.GaiaAuth?.open?.()));
    root.querySelectorAll('[data-gaia-open-assist]').forEach((button) => button.addEventListener('click', () => {
      document.querySelector('[data-gaia-tab-assist]')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    }));
    root.querySelectorAll('[data-super-course]').forEach((button) => button.addEventListener('click', () => {
      const url = button.dataset.superCourse;
      if (!url) return;
      window.GaiaInApp?.open?.(url, button.dataset.superCourseTitle || 'Gaia Academy');
    }));
  }

  function render() {
    renderHome();
    renderJourney();
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
    if (['today', 'journey', 'events', 'bookings', 'inbox'].includes(event.detail?.view)) render();
  });
})();
