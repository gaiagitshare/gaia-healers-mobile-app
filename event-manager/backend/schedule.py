"""My Schedule — the sessions an attendee has chosen, and where they collide.

Two decisions worth stating.

**It is stored against the person, not the device.** Someone plans their
conference on a laptop the night before and works from their phone in the
corridor the next morning. A schedule in localStorage would not make that trip,
and a hallway between talks is exactly when nobody will rebuild it.

**Clashes are surfaced, not prevented.** Two talks at the same hour is a normal
thing to want: you are deciding between them, or you plan to catch the first
half of one. Refusing the save would be the system overruling a choice it does
not understand. So both are saved and the overlap is shown.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session as DbSession

import models


def save_session(db: DbSession, attendee: models.Attendee, session_id: int) -> dict:
    """Add a session to this attendee's schedule.

    Refuses across events: a session belongs to one event, and saving another
    event's programme into your own would produce a schedule you cannot attend.
    """
    session = db.query(models.Session).filter(models.Session.id == session_id).first()
    if not session:
        return {"ok": False, "reason": "session_not_found"}
    if session.event_id != attendee.event_id:
        return {"ok": False, "reason": "session_not_in_this_event"}
    if not session.is_published:
        # An unpublished session is still being written. Letting people save it
        # means their schedule changes under them when it is edited or dropped.
        return {"ok": False, "reason": "session_not_published"}

    existing = db.query(models.SavedSession).filter(
        models.SavedSession.attendee_id == attendee.id,
        models.SavedSession.session_id == session_id,
    ).first()
    if existing:
        # Saving twice is not an error worth showing a person.
        return {"ok": True, "saved": True, "already": True}

    db.add(models.SavedSession(attendee_id=attendee.id, session_id=session_id))
    db.commit()
    return {"ok": True, "saved": True, "already": False}


def unsave_session(db: DbSession, attendee: models.Attendee, session_id: int) -> dict:
    row = db.query(models.SavedSession).filter(
        models.SavedSession.attendee_id == attendee.id,
        models.SavedSession.session_id == session_id,
    ).first()
    if row:
        db.delete(row)
        db.commit()
    # Removing something already absent is the state the caller wanted.
    return {"ok": True, "saved": False}


def _overlaps(a: models.Session, b: models.Session) -> bool:
    """Do two sessions collide in time?

    Touching ends do not count: a talk ending at 11:00 and the next starting at
    11:00 is the normal shape of a conference, not a clash.
    """
    if not (a.start_time and a.end_time and b.start_time and b.end_time):
        return False
    return a.start_time < b.end_time and b.start_time < a.end_time


def my_schedule(db: DbSession, attendee: models.Attendee) -> dict:
    """This attendee's saved sessions, in the order they will live them.

    Grouped by venue-local day, because that is how a person reads a conference
    day — and the times are already stored venue-local, so no conversion is
    applied here.
    """
    rows = db.query(models.SavedSession).filter(
        models.SavedSession.attendee_id == attendee.id
    ).all()
    sessions = [row.session for row in rows if row.session and row.session.is_published]
    sessions.sort(key=lambda s: (s.start_time is None, s.start_time or datetime.max, s.sort_order or 0))

    # Which saved sessions collide with which. Computed pairwise over one
    # person's own saved list, which is small by nature — nobody saves hundreds.
    clashes = {}
    for i, first in enumerate(sessions):
        for second in sessions[i + 1:]:
            if _overlaps(first, second):
                clashes.setdefault(first.id, []).append(second.id)
                clashes.setdefault(second.id, []).append(first.id)

    days = {}
    for session in sessions:
        key = session.start_time.date().isoformat() if session.start_time else "unscheduled"
        days.setdefault(key, []).append({
            "id": session.id,
            "title": session.title or "",
            "description": session.description or "",
            "session_type": session.session_type or "talk",
            "track": session.track or "",
            "room": session.room or "",
            "start_time": session.start_time,
            "end_time": session.end_time,
            "speakers": [
                {"id": sp.id, "name": sp.name or "", "role": sp.role or "",
                 "photo_url": sp.photo_url or ""}
                for sp in (session.speakers or []) if sp.is_published
            ],
            # The ids this one runs into, so the client can say which rather
            # than only that something clashes.
            "clashes_with": clashes.get(session.id, []),
        })

    return {
        "ok": True,
        "event_id": attendee.event_id,
        "saved_count": len(sessions),
        "clash_count": len(clashes),
        "days": [{"date": key, "sessions": value} for key, value in sorted(days.items())],
    }


def saved_ids(db: DbSession, attendee: models.Attendee) -> list:
    """Just the ids — what the agenda needs to draw its save buttons."""
    return [
        row.session_id
        for row in db.query(models.SavedSession).filter(
            models.SavedSession.attendee_id == attendee.id
        ).all()
    ]
