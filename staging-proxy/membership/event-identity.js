/**
 * My Events and My Ticket — the bridge between a signed-in Gaia person and
 * the Event Manager's attendee records.
 *
 * The shape here is deliberate. The browser never names an attendee, and never
 * sends an attendee id: it asks "what are mine?" and the proxy answers from
 * the session it already holds. An attendee id is a small integer, so any
 * design where the client supplies one is a design where a curious visitor can
 * count upwards and collect other people's QR codes.
 *
 * The Event Manager re-proves ownership on its side too. This file is not a
 * security boundary on its own — it is the half that knows *who is asking*,
 * and it passes that across a service token to the half that knows *what they
 * hold*.
 */

const IDENTITY_TIMEOUT_MS = 8000;

/** What the session can actually prove about this person. */
function identityFromSession(session) {
  const member = session && session.member ? session.member : null;
  if (!member) return null;
  const email = String(member.email || '').trim().toLowerCase();
  const contactId = String(member.contactId || member.memberId || '').trim();
  if (!email && !contactId) return null;
  return {
    email,
    contact_id: contactId,
    // Passed through rather than assumed. The Event Manager refuses to resolve
    // on an unverified address, so a session that never proved its email can
    // still resolve by contact id and no further.
    email_verified: session.emailVerified === true,
  };
}

/** The one place the service token is read. Everything that talks to the
 * Event Manager goes through here or through callEventIdentity below. */
function serviceCall() {
  const base = (process.env.EVENT_MANAGER_BASE_URL || '').replace(/\/+$/, '');
  const token = (process.env.IDENTITY_SERVICE_TOKEN || '').trim();
  if (!base || !token) return null;
  return { base, headers: { Authorization: 'Bearer ' + token } };
}

async function callEventIdentity(path, body) {
  const base = (process.env.EVENT_MANAGER_BASE_URL || '').replace(/\/+$/, '');
  const token = (process.env.IDENTITY_SERVICE_TOKEN || '').trim();
  if (!base || !token) {
    return { ok: false, reason: 'identity_not_configured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, reason: `event_manager_${response.status}` };
    }
    return await response.json();
  } catch (err) {
    // The Event Manager being unreachable must not take the app down; the
    // caller renders an "unavailable" state rather than an empty ticket list,
    // because those two mean very different things to someone at a door.
    return { ok: false, reason: 'event_manager_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Which phase an event is in, from the event's own dates. */
function phaseOf(row, now = new Date()) {
  const start = row.start_date ? new Date(row.start_date) : null;
  const end = row.end_date ? new Date(row.end_date) : null;
  if (start && now < start) return 'upcoming';
  if (end && now > end) return 'past';
  // Started, and either still inside its window or open-ended. An event with no
  // end date that has begun is running — calling it "upcoming" would tell
  // someone standing in the room that it has not started yet.
  if (start) return 'live';
  return 'upcoming';
}

/** Reshape one Event Manager row into what the app renders. */
function toAppRow(row, now) {
  const attendee = row.attendee || {};
  return {
    id: row.event_id,
    name: row.event_name || '',
    startDate: row.start_date || null,
    endDate: row.end_date || null,
    location: row.location || '',
    timezone: row.timezone || 'UTC',
    heroImageUrl: row.hero_image_url || '',
    isPublished: Boolean(row.is_published),
    phase: phaseOf(row, now),
    ticket: {
      name: [attendee.first_name, attendee.last_name].filter(Boolean).join(' '),
      passLabel: attendee.pass_label || '',
      passCode: attendee.ticket_type_code || null,
      isVip: Boolean(attendee.is_vip),
      grantsWorkshops: Boolean(attendee.grants_workshops),
      registrationStatus: attendee.registration_status || 'registered',
      checkedIn: Boolean(attendee.is_checked_in),
      checkedInAt: attendee.checked_in_at || null,
      // Straight from the Event Manager's ONE effective-access resolver.
      // The app renders this; it never recomputes access. Same source as Admin + Scanner.
      effectiveLabel: (attendee.effective_access && attendee.effective_access.effective_label) || attendee.pass_label || '',
      baseTicket: (attendee.effective_access && attendee.effective_access.base_ticket) || null,
      addons: (attendee.effective_access && attendee.effective_access.addons) || [],
      valid: attendee.effective_access ? attendee.effective_access.active !== false
        : !['refunded','revoked','cancelled'].includes((attendee.registration_status || 'registered')),
    },
  };
}

/**
 * Every event this person holds a ticket for.
 *
 * Note what is NOT here: the QR code. My Events is a list screen, and a list
 * screen has no use for a door credential. It is fetched only when the person
 * opens the one ticket they are looking at.
 */
async function announcements(session, eventId) {
  const numericId = Number(eventId);
  if (!Number.isInteger(numericId) || numericId <= 0) return { ok: false, announcements: [] };
  // A logged-out viewer resolves to no attendee, so the server returns only
  // untargeted announcements — the safe public set.
  const identity = identityFromSession(session) || { contact_id: null, email: null, email_verified: false };
  const result = await callEventIdentity('/identity/events/' + numericId + '/announcements', { ...identity, event_id: numericId });
  return (result && result.ok) ? result : { ok: false, announcements: [] };
}

async function myEvents(session) {
  const identity = identityFromSession(session);
  if (!identity) return { ok: true, authenticated: false, events: [] };

  const result = await callEventIdentity('/identity/my-events', identity);
  if (!result || result.ok === false) {
    return {
      ok: false,
      authenticated: true,
      reason: (result && result.reason) || 'identity_failed',
      events: [],
    };
  }

  const now = new Date();
  const events = (result.events || []).map((row) => toAppRow(row, now));
  return {
    ok: true,
    authenticated: true,
    events,
    // Surfaced so an operator can tell "no ticket" apart from "we would not
    // guess" — the second is a data problem someone has to fix.
    unresolved: (result.resolution && result.resolution.unresolved) || [],
  };
}

/** This person's ticket for one event, including the QR to show at the door. */
async function myTicket(session, eventId) {
  const identity = identityFromSession(session);
  if (!identity) return { ok: false, authenticated: false, reason: 'auth_required' };

  const numericId = Number(eventId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return { ok: false, authenticated: true, reason: 'bad_event_id' };
  }

  const result = await callEventIdentity('/identity/ticket', { ...identity, event_id: numericId });
  if (!result || result.ok !== true) {
    return {
      ok: false,
      authenticated: true,
      reason: (result && result.reason) || 'no_ticket_for_event',
    };
  }

  const now = new Date();
  const row = toAppRow(result, now);
  const attendee = result.attendee || {};
  return {
    ok: true,
    authenticated: true,
    event: row,
    ticket: {
      ...row.ticket,
      email: attendee.email || '',
      qrCode: attendee.qr_code || '',
      qrImage: result.qr_image || '',
    },
  };
}

/** Eligible upgrades from this person's current pass for one event. Resolution
 * and rank rules live in the Event Manager; price is filled in by the caller
 * from GHL so it is always the real configured amount. */
async function myUpgrades(session, eventId) {
  const identity = identityFromSession(session);
  if (!identity) return { ok: false, authenticated: false, reason: 'auth_required' };
  const numericId = Number(eventId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return { ok: false, authenticated: true, reason: 'bad_event_id' };
  }
  const result = await callEventIdentity('/identity/upgrades', { ...identity, event_id: numericId });
  if (!result || result.ok !== true) {
    return { ok: false, authenticated: true, reason: (result && result.reason) || 'no_ticket_for_event' };
  }
  return { ok: true, authenticated: true, status: result.status || 'active',
           current: result.current || null, upgrades: Array.isArray(result.upgrades) ? result.upgrades : [] };
}

/**
 * My Schedule: read, save, remove.
 *
 * Same shape as the ticket routes — the session names the person, the client
 * names only a session id, and the Event Manager re-proves ownership of the
 * event before touching anything.
 */
async function mySchedule(session, eventId) {
  const identity = identityFromSession(session);
  if (!identity) return { ok: false, authenticated: false, reason: 'auth_required' };
  const numericId = Number(eventId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return { ok: false, authenticated: true, reason: 'bad_event_id' };
  }
  const result = await callEventIdentity('/identity/schedule', { ...identity, event_id: numericId });
  return { authenticated: true, ...(result || { ok: false, reason: 'identity_failed' }) };
}

async function changeSchedule(session, eventId, sessionId, action) {
  const identity = identityFromSession(session);
  if (!identity) return { ok: false, authenticated: false, reason: 'auth_required' };
  const numericEvent = Number(eventId);
  const numericSession = Number(sessionId);
  if (!Number.isInteger(numericEvent) || numericEvent <= 0
    || !Number.isInteger(numericSession) || numericSession <= 0) {
    return { ok: false, authenticated: true, reason: 'bad_id' };
  }
  const path = action === 'save' ? '/identity/schedule/save' : '/identity/schedule/unsave';
  const result = await callEventIdentity(path, {
    ...identity, event_id: numericEvent, session_id: numericSession,
  });
  return { authenticated: true, ...(result || { ok: false, reason: 'identity_failed' }) };
}

/** Register for, or withdraw from, a workshop place. */
async function changeWorkshop(session, eventId, sessionId, action) {
  const identity = identityFromSession(session);
  if (!identity) return { ok: false, authenticated: false, reason: 'auth_required' };
  const numericEvent = Number(eventId);
  const numericSession = Number(sessionId);
  if (!Number.isInteger(numericEvent) || numericEvent <= 0
    || !Number.isInteger(numericSession) || numericSession <= 0) {
    return { ok: false, authenticated: true, reason: 'bad_id' };
  }
  const path = action === 'unregister' ? '/identity/workshops/unregister' : '/identity/workshops/register';
  const result = await callEventIdentity(path, {
    ...identity, event_id: numericEvent, session_id: numericSession,
  });
  return { authenticated: true, ...(result || { ok: false, reason: 'identity_failed' }) };
}

/**
 * Networking calls. One generic bridge: every route re-proves ownership on the
 * Event Manager side, and the browser can only ever act as the person the
 * session cookie says they are.
 */
async function networking(session, eventId, action, extra = {}) {
  const identity = identityFromSession(session);
  if (!identity) return { ok: false, authenticated: false, reason: 'auth_required' };
  const numericEvent = Number(eventId);
  if (!Number.isInteger(numericEvent) || numericEvent <= 0) {
    return { ok: false, authenticated: true, reason: 'bad_event_id' };
  }
  const paths = {
    profile: '/identity/networking/profile',
    directory: '/identity/networking/directory',
    connect: '/identity/networking/connect',
    respond: '/identity/networking/respond',
    connections: '/identity/networking/connections',
    connectByToken: '/identity/networking/connect-by-token',
  };
  if (!paths[action]) return { ok: false, authenticated: true, reason: 'bad_action' };
  const result = await callEventIdentity(paths[action], {
    ...identity, event_id: numericEvent, ...extra,
  });
  return { authenticated: true, ...(result || { ok: false, reason: 'identity_failed' }) };
}

/** Submit or read this person's own ratings. */
async function feedback(session, eventId, body) {
  const identity = identityFromSession(session);
  if (!identity) return { ok: false, authenticated: false, reason: 'auth_required' };
  const numericEvent = Number(eventId);
  if (!Number.isInteger(numericEvent) || numericEvent <= 0) {
    return { ok: false, authenticated: true, reason: 'bad_event_id' };
  }
  if (body && body.mine) {
    const result = await callEventIdentity('/identity/feedback/mine',
      { ...identity, event_id: numericEvent });
    return { authenticated: true, ...(result || { ok: false, reason: 'identity_failed' }) };
  }
  const rating = Number(body && body.rating);
  const result = await callEventIdentity('/identity/feedback', {
    ...identity,
    event_id: numericEvent,
    session_id: body && body.sessionId != null ? Number(body.sessionId) : null,
    rating,
    comment: String((body && body.comment) || '').slice(0, 1000),
  });
  return { authenticated: true, ...(result || { ok: false, reason: 'identity_failed' }) };
}

async function pushVapidKey() {
  const base = (process.env.EVENT_MANAGER_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return { ok: false, reason: 'identity_not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/public/push/vapid-key`, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) return { ok: false, reason: `event_manager_${response.status}` };
    const data = await response.json();
    return { ok: true, key: data.key || '', configured: !!data.configured };
  } catch (err) {
    return { ok: false, reason: 'event_manager_unreachable' };
  } finally { clearTimeout(timer); }
}

async function pushSubscribe(session, eventId, subscription) {
  const identity = identityFromSession(session);
  if (!identity) return { ok: false, authenticated: false, reason: 'auth_required' };
  const numericId = Number(eventId);
  if (!Number.isInteger(numericId) || numericId <= 0) return { ok: false, authenticated: true, reason: 'bad_event_id' };
  if (!subscription || !subscription.endpoint) return { ok: false, authenticated: true, reason: 'bad_subscription' };
  const result = await callEventIdentity('/identity/push/subscribe', { ...identity, event_id: numericId, subscription });
  return result || { ok: false, reason: 'event_manager_unreachable' };
}

async function pushUnsubscribe(session, endpoint) {
  const identity = identityFromSession(session);
  if (!identity) return { ok: false, authenticated: false, reason: 'auth_required' };
  const result = await callEventIdentity('/identity/push/unsubscribe', { ...identity, endpoint: String(endpoint || '') });
  return result || { ok: false, reason: 'event_manager_unreachable' };
}


/**
 * Community feed — a moderated public board per event. The browser never sends
 * an identity: the proxy attaches the session's contact id (the real person)
 * to every post/like/report, so nobody can post as someone else. The client
 * may only choose a *display name*, which is bounded here and stored alongside
 * the real contact id so an organiser always sees who actually posted.
 */
function boundedDisplayName(value, fallback) {
  const v = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return v || fallback || 'Member';
}

async function communityFeed(session, eventId, since = 0) {
  const numericId = Number(eventId);
  if (!Number.isInteger(numericId) || numericId <= 0) return { ok: false, posts: [] };
  const identity = identityFromSession(session) || { contact_id: null, email: null, email_verified: false };
  const member = (session && session.member) ? session.member : null;
  const authed = !!(identity && identity.contact_id);
  const result = await callEventIdentity('/identity/events/' + numericId + '/posts/feed',
    { ...identity, since: Number(since) || 0, limit: 60 });
  if (!result || result.ok !== true) return { ok: false, authenticated: authed, posts: [] };
  return {
    ok: true,
    authenticated: authed,
    suspended: !!result.suspended,
    canPost: authed && !result.suspended,
    me: authed ? { name: member ? member.displayName : 'Member', contactId: identity.contact_id } : null,
    posts: result.posts || [],
  };
}

async function createPost(session, eventId, body) {
  const identity = identityFromSession(session);
  if (!identity || !identity.contact_id) return { ok: false, authenticated: false, reason: 'auth_required' };
  const numericId = Number(eventId);
  if (!Number.isInteger(numericId) || numericId <= 0) return { ok: false, authenticated: true, reason: 'bad_event_id' };
  const member = session.member || {};
  const authorName = boundedDisplayName(body && body.displayName, member.displayName);
  const text = String((body && body.body) || '').slice(0, 1200);
  const imageUrl = String((body && body.imageUrl) || '').slice(0, 600);
  const parentId = Number(body && body.parentId) || null;
  const result = await callEventIdentity('/identity/events/' + numericId + '/posts',
    { ...identity, author_name: authorName, author_photo: '', body: text, image_url: imageUrl, parent_id: parentId });
  return { authenticated: true, ...(result || { ok: false, reason: 'identity_failed' }) };
}

async function postAction(session, eventId, postId, action, reason) {
  const identity = identityFromSession(session);
  if (!identity || !identity.contact_id) return { ok: false, authenticated: false, reason: 'auth_required' };
  const numericId = Number(eventId);
  const pid = Number(postId);
  if (!Number.isInteger(numericId) || numericId <= 0 || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, authenticated: true, reason: 'bad_id' };
  }
  const path = action === 'report' ? '/report' : '/like';
  const result = await callEventIdentity('/identity/events/' + numericId + '/posts/' + pid + path,
    { ...identity, reason: String(reason || '').slice(0, 200) });
  return { authenticated: true, ...(result || { ok: false, reason: 'identity_failed' }) };
}


async function uploadPostImage(session, eventId, contentType, buffer) {
  const identity = identityFromSession(session);
  if (!identity || !identity.contact_id) return { ok: false, authenticated: false, reason: 'auth_required' };
  const numericId = Number(eventId);
  if (!Number.isInteger(numericId) || numericId <= 0) return { ok: false, authenticated: true, reason: 'bad_event_id' };
  const svc = serviceCall();
  const base = svc ? svc.base : '';
  if (!svc) return { ok: false, authenticated: true, reason: 'identity_not_configured' };
  const url = base + '/identity/events/' + numericId + '/posts/image?contact_id=' + encodeURIComponent(identity.contact_id);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType || 'application/octet-stream', ...svc.headers },
      body: buffer,
      signal: controller.signal,
    });
    const data = await r.json().catch(() => ({ ok: false, reason: 'bad_response' }));
    return { authenticated: true, ...data };
  } catch (e) {
    return { ok: false, authenticated: true, reason: 'event_manager_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The digital badge card behind the printed QR: read, edit, photo.
 *
 * Same contract as the ticket: the session names the person, the Event
 * Manager re-proves ownership of the attendee row on every call, and nothing
 * the browser sends can make it act as anyone else.
 */
async function myCard(session, eventId) {
  const identity = identityFromSession(session);
  if (!identity) return { ok: false, authenticated: false, reason: 'auth_required' };
  // 0 means "my permanent card": the card belongs to the person, so it must
  // resolve with no event named — including when they hold no live ticket.
  const numericId = Number(eventId) || 0;
  if (!Number.isInteger(numericId) || numericId < 0) return { ok: false, authenticated: true, reason: 'bad_event_id' };
  const result = await callEventIdentity('/identity/card', { ...identity, event_id: numericId });
  return { authenticated: true, ...(result || { ok: false, reason: 'identity_failed' }) };
}

const CARD_FIELDS = ['public', 'bio', 'company', 'title', 'city', 'website', 'instagram', 'linkedin', 'whatsapp', 'photo_url', 'show_email', 'show_phone', 'tags'];

async function updateCard(session, eventId, body) {
  const identity = identityFromSession(session);
  if (!identity) return { ok: false, authenticated: false, reason: 'auth_required' };
  // 0 means "my permanent card": the card belongs to the person, so it must
  // resolve with no event named — including when they hold no live ticket.
  const numericId = Number(eventId) || 0;
  if (!Number.isInteger(numericId) || numericId < 0) return { ok: false, authenticated: true, reason: 'bad_event_id' };
  // Only known fields cross; booleans are booleans, everything else a string.
  const fields = {};
  for (const key of CARD_FIELDS) {
    if (!(key in (body || {}))) continue;
    const v = body[key];
    if (key === 'public' || key === 'show_email' || key === 'show_phone') fields[key] = v === true;
    else if (key === 'tags') fields[key] = Array.isArray(v) ? v.map((t) => String(t)).slice(0, 4) : String(v || '');
    else fields[key] = String(v == null ? '' : v).slice(0, 400);
  }
  const result = await callEventIdentity('/identity/card/update', { ...identity, event_id: numericId, ...fields });
  return { authenticated: true, ...(result || { ok: false, reason: 'identity_failed' }) };
}

async function uploadCardPhoto(session, eventId, contentType, buffer) {
  const identity = identityFromSession(session);
  if (!identity) return { ok: false, authenticated: false, reason: 'auth_required' };
  // 0 = the person's permanent card, with no event named.
  const numericId = Number(eventId) || 0;
  if (!Number.isInteger(numericId) || numericId < 0) return { ok: false, authenticated: true, reason: 'bad_event_id' };
  const svc = serviceCall();
  const base = svc ? svc.base : '';
  if (!svc) return { ok: false, authenticated: true, reason: 'identity_not_configured' };
  const qs = new URLSearchParams({
    event_id: String(numericId),
    contact_id: identity.contact_id || '',
    email: identity.email || '',
    email_verified: identity.email_verified ? '1' : '0',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(base + '/identity/card/photo?' + qs.toString(), {
      method: 'POST',
      headers: { 'Content-Type': contentType || 'application/octet-stream', ...svc.headers },
      body: buffer,
      signal: controller.signal,
    });
    const data = await r.json().catch(() => ({ ok: false, reason: 'bad_response' }));
    if (!r.ok && !data.reason) data.reason = data.detail || ('event_manager_' + r.status);
    return { authenticated: true, ...data, ok: r.ok && data.ok !== false };
  } catch (e) {
    return { ok: false, authenticated: true, reason: 'event_manager_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Who owns the badge behind a printed token? Answered from the SESSION, never
 * from the URL: the Event Manager re-proves the person (contact id, or an
 * email this session verified by magic link) against the rows carrying the
 * token. Signed out -> not authenticated, and nothing is looked up.
 */
async function cardOwner(session, token) {
  const identity = identityFromSession(session);
  const clean = String(token || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(clean)) return { ok: true, authenticated: Boolean(identity), owner: false };
  if (!identity) return { ok: true, authenticated: false, owner: false };
  const result = await callEventIdentity('/identity/card/owner', { ...identity, event_id: 0, token: clean });
  if (!result || result.ok !== true) return { ok: false, authenticated: true, owner: false, reason: (result && result.reason) || 'identity_failed' };
  return { ok: true, authenticated: true, owner: Boolean(result.owner), event_id: result.event_id || null,
           claimed: Boolean(result.claimed), public: Boolean(result.public) };
}

export { announcements, myEvents, myTicket, myUpgrades, mySchedule, changeSchedule, changeWorkshop, networking, feedback, pushVapidKey, pushSubscribe, pushUnsubscribe, identityFromSession, phaseOf, toAppRow , communityFeed, createPost, postAction , uploadPostImage, myCard, updateCard, uploadCardPhoto, cardOwner };
