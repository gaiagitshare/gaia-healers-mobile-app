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

export { myEvents, myTicket, identityFromSession, phaseOf, toAppRow };
