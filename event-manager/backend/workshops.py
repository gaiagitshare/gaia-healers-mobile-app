"""Workshop registration: twenty chairs, more people, and a fair queue.

The rules, stated once:

- Only sessions marked `requires_registration` take registrations at all.
  Ordinary talks stay walk-in, and registering for them is refused rather than
  silently recorded — a claimed place that means nothing teaches people the
  button is decorative.
- A session with a capacity fills in arrival order. When it is full, new
  registrations become waitlist entries — stated as such, never presented as a
  confirmed place.
- Cancelling a confirmed place promotes the earliest waitlisted person,
  first-come. Any cleverer promotion policy is a policy somebody has to defend
  to a queue at a registration desk.
- `needs_workshop_pass` gates registration on the ticket type's
  `grants_workshops` flag — the structural flag, never the pass name.
- Registering also saves the session into My Schedule: a claimed chair the
  schedule does not show is how people miss the thing they registered for.
"""

from datetime import datetime

from sqlalchemy.orm import Session as DbSession

import models
from identity import attendee_grants

REGISTERED = "registered"
WAITLISTED = "waitlisted"


def _counts(db: DbSession, session_id: int) -> dict:
    registered = db.query(models.SessionRegistration).filter(
        models.SessionRegistration.session_id == session_id,
        models.SessionRegistration.status == REGISTERED,
    ).count()
    waitlisted = db.query(models.SessionRegistration).filter(
        models.SessionRegistration.session_id == session_id,
        models.SessionRegistration.status == WAITLISTED,
    ).count()
    return {"registered": registered, "waitlisted": waitlisted}


def availability(session: models.Session, db: DbSession) -> dict:
    """The public shape of a session's capacity: enough to decide, no names."""
    counts = _counts(db, session.id)
    capacity = session.capacity if (session.capacity or 0) > 0 else None
    remaining = max(0, capacity - counts["registered"]) if capacity else None
    return {
        "requires_registration": bool(session.requires_registration),
        "needs_workshop_pass": bool(session.needs_workshop_pass),
        "capacity": capacity,
        "remaining": remaining,
        "full": bool(capacity and counts["registered"] >= capacity),
        "waitlist_count": counts["waitlisted"],
    }


def register(db: DbSession, attendee: models.Attendee, session_id: int) -> dict:
    session = db.query(models.Session).filter(models.Session.id == session_id).first()
    if not session:
        return {"ok": False, "reason": "session_not_found"}
    if session.event_id != attendee.event_id:
        return {"ok": False, "reason": "session_not_in_this_event"}
    if not session.is_published:
        return {"ok": False, "reason": "session_not_published"}
    if not session.requires_registration:
        # A walk-in session. Saying yes here would hand out meaningless
        # confirmations; the truthful answer is "just turn up".
        return {"ok": False, "reason": "registration_not_required"}
    if session.needs_workshop_pass and not attendee_grants(attendee)["workshops"]:
        return {"ok": False, "reason": "workshop_pass_required"}

    existing = db.query(models.SessionRegistration).filter(
        models.SessionRegistration.attendee_id == attendee.id,
        models.SessionRegistration.session_id == session_id,
    ).first()
    if existing:
        # Registering twice is not an error; they hold whatever they hold.
        return {"ok": True, "status": existing.status, "already": True,
                **availability(session, db)}

    state = availability(session, db)
    status = WAITLISTED if state["full"] else REGISTERED
    db.add(models.SessionRegistration(
        attendee_id=attendee.id, session_id=session_id, status=status,
    ))

    # A claimed chair belongs on the person's schedule. Best-effort and
    # duplicate-safe — they may have saved it already.
    saved = db.query(models.SavedSession).filter(
        models.SavedSession.attendee_id == attendee.id,
        models.SavedSession.session_id == session_id,
    ).first()
    if not saved:
        db.add(models.SavedSession(attendee_id=attendee.id, session_id=session_id))

    db.commit()
    return {"ok": True, "status": status, "already": False,
            **availability(session, db)}


def unregister(db: DbSession, attendee: models.Attendee, session_id: int) -> dict:
    session = db.query(models.Session).filter(models.Session.id == session_id).first()
    if not session:
        return {"ok": False, "reason": "session_not_found"}

    row = db.query(models.SessionRegistration).filter(
        models.SessionRegistration.attendee_id == attendee.id,
        models.SessionRegistration.session_id == session_id,
    ).first()
    if not row:
        # Cancelling something never held is the state they wanted.
        return {"ok": True, "status": None, "promoted": None,
                **availability(session, db)}

    freed_confirmed_place = row.status == REGISTERED
    db.delete(row)
    db.flush()

    promoted_id = None
    if freed_confirmed_place:
        # First-come promotion: the earliest waitlisted row takes the chair.
        next_up = db.query(models.SessionRegistration).filter(
            models.SessionRegistration.session_id == session_id,
            models.SessionRegistration.status == WAITLISTED,
        ).order_by(models.SessionRegistration.created_at.asc(),
                   models.SessionRegistration.id.asc()).first()
        if next_up:
            next_up.status = REGISTERED
            promoted_id = next_up.attendee_id

    db.commit()
    return {"ok": True, "status": None, "promoted": promoted_id,
            **availability(session, db)}


def my_registrations(db: DbSession, attendee: models.Attendee) -> dict:
    """session_id -> status, for painting the attendee's own buttons."""
    rows = db.query(models.SessionRegistration).filter(
        models.SessionRegistration.attendee_id == attendee.id
    ).all()
    return {row.session_id: row.status for row in rows}


def record_attendance(db: DbSession, session: models.Session,
                      attendee: models.Attendee) -> dict:
    """A staff scan at the session door.

    Verifies what there is to verify — event scope always; a confirmed place
    when the session requires one — and records the walk-in once. A second scan
    of the same badge reports "already inside" rather than a fresh welcome, for
    the same reason the event door does.
    """
    if attendee.event_id != session.event_id:
        return {"ok": False, "reason": "wrong_event"}

    if session.requires_registration:
        registration = db.query(models.SessionRegistration).filter(
            models.SessionRegistration.attendee_id == attendee.id,
            models.SessionRegistration.session_id == session.id,
        ).first()
        if not registration:
            return {"ok": False, "reason": "not_registered"}
        if registration.status == WAITLISTED:
            # The door is where the waitlist becomes real: they only enter if
            # staff decide there is room, and that decision is staff's, not
            # this function's.
            return {"ok": False, "reason": "waitlisted"}

    existing = db.query(models.SessionAttendance).filter(
        models.SessionAttendance.attendee_id == attendee.id,
        models.SessionAttendance.session_id == session.id,
    ).first()
    if existing:
        return {"ok": True, "already": True, "scanned_at": existing.scanned_at}

    row = models.SessionAttendance(attendee_id=attendee.id, session_id=session.id)
    db.add(row)
    db.commit()
    return {"ok": True, "already": False, "scanned_at": row.scanned_at}
