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
  const base = (process.env.EVENT_MANAGER_BASE_URL || '').replace(/\/+$/, '');
  const token = (process.env.IDENTITY_SERVICE_TOKEN || '').trim();
  if (!base || !token) return { ok: false, authenticated: true, reason: 'identity_not_configured' };
  const url = base + '/identity/events/' + numericId + '/posts/image?contact_id=' + encodeURIComponent(identity.contact_id);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType || 'application/octet-stream', Authorization: 'Bearer ' + token },
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

export { announcements, myEvents, myTicket, myUpgrades, mySchedule, changeSchedule, changeWorkshop, networking, feedback, pushVapidKey, pushSubscribe, pushUnsubscribe, identityFromSession, phaseOf, toAppRow , communityFeed, createPost, postAction , uploadPostImage };
