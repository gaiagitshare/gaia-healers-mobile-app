"""Attendee networking: a directory people join, and handshakes people accept.

Every rule here is a consent rule:

- Nobody is listed by virtue of buying a ticket. The directory contains only
  attendees who explicitly turned themselves visible, at events whose
  organiser explicitly enabled networking at all.
- The directory shows what a conference badge shows — name, company, role, and
  a line they wrote about themselves. Email and phone are never in it.
- Contact details move only through an accepted connection, in both directions
  at once: an exchange, not an extraction. A declined request reveals nothing.
- Turning visibility off removes a person from the directory immediately.
  Accepted connections keep what was already exchanged — you cannot unshake a
  hand — but no new requests can reach them.
"""

from datetime import datetime

from sqlalchemy.orm import Session as DbSession

import models


def _event_allows(db: DbSession, event_id: int) -> bool:
    event = db.query(models.Event).filter(models.Event.id == event_id).first()
    return bool(event and event.networking_enabled)


def _profile(db: DbSession, attendee: models.Attendee):
    return db.query(models.NetworkingProfile).filter(
        models.NetworkingProfile.attendee_id == attendee.id
    ).first()


def set_profile(db: DbSession, attendee: models.Attendee, *, visible: bool, bio: str = "") -> dict:
    if not _event_allows(db, attendee.event_id):
        return {"ok": False, "reason": "networking_disabled"}
    profile = _profile(db, attendee)
    if not profile:
        profile = models.NetworkingProfile(attendee_id=attendee.id)
        db.add(profile)
    profile.visible = bool(visible)
    profile.bio = (bio or "").strip()[:400]
    profile.updated_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "visible": profile.visible, "bio": profile.bio}


def _card(attendee: models.Attendee, profile: models.NetworkingProfile) -> dict:
    """A directory entry: what a badge says, plus their own line. Nothing else."""
    return {
        "attendee_id": attendee.id,
        "name": f"{attendee.first_name or ''} {attendee.last_name or ''}".strip(),
        "company": attendee.company or "",
        "job_title": attendee.job_title or "",
        "bio": (profile.bio or "") if profile else "",
    }


def directory(db: DbSession, attendee: models.Attendee) -> dict:
    """Everyone at this event who chose to be found. Never includes the viewer."""
    if not _event_allows(db, attendee.event_id):
        return {"ok": False, "reason": "networking_disabled"}
    me = _profile(db, attendee)

    rows = db.query(models.NetworkingProfile).join(
        models.Attendee, models.NetworkingProfile.attendee_id == models.Attendee.id
    ).filter(
        models.Attendee.event_id == attendee.event_id,
        models.NetworkingProfile.visible == True,
        models.NetworkingProfile.attendee_id != attendee.id,
    ).all()

    # Existing relationships, so the client can label buttons truthfully.
    mine = db.query(models.Connection).filter(
        (models.Connection.requester_id == attendee.id)
        | (models.Connection.target_id == attendee.id),
        models.Connection.event_id == attendee.event_id,
    ).all()
    status_by_attendee = {}
    for connection in mine:
        other = (connection.target_id if connection.requester_id == attendee.id
                 else connection.requester_id)
        direction = "sent" if connection.requester_id == attendee.id else "received"
        status_by_attendee[other] = {"id": connection.id, "status": connection.status,
                                     "direction": direction}

    people = []
    for profile in rows:
        card = _card(profile.attendee, profile)
        card["connection"] = status_by_attendee.get(profile.attendee_id)
        people.append(card)
    people.sort(key=lambda c: c["name"].lower())

    return {
        "ok": True,
        "me": {"visible": bool(me and me.visible), "bio": (me.bio if me else "") or ""},
        "people": people,
    }


def connect(db: DbSession, attendee: models.Attendee, target_id: int) -> dict:
    """Ask another attendee to exchange contact details."""
    if not _event_allows(db, attendee.event_id):
        return {"ok": False, "reason": "networking_disabled"}
    me = _profile(db, attendee)
    if not (me and me.visible):
        # Symmetry: you cannot ask to be let in while staying hidden yourself.
        return {"ok": False, "reason": "join_directory_first"}
    if target_id == attendee.id:
        return {"ok": False, "reason": "cannot_connect_to_self"}

    target = db.query(models.Attendee).filter(models.Attendee.id == target_id).first()
    target_profile = target and _profile(db, target)
    # One refusal for "no such person", "different event" and "not visible":
    # the directory is the only legitimate source of targets, so anything else
    # is a guess, and a distinct answer would confirm it.
    if (not target or target.event_id != attendee.event_id
            or not (target_profile and target_profile.visible)):
        return {"ok": False, "reason": "not_available"}

    existing = db.query(models.Connection).filter(
        ((models.Connection.requester_id == attendee.id) & (models.Connection.target_id == target_id))
        | ((models.Connection.requester_id == target_id) & (models.Connection.target_id == attendee.id)),
    ).first()
    if existing:
        return {"ok": True, "status": existing.status, "already": True, "connection_id": existing.id}

    connection = models.Connection(
        event_id=attendee.event_id, requester_id=attendee.id, target_id=target_id,
    )
    db.add(connection)
    db.commit()
    db.refresh(connection)
    return {"ok": True, "status": "pending", "already": False, "connection_id": connection.id}


def respond(db: DbSession, attendee: models.Attendee, connection_id: int, accept: bool) -> dict:
    """Answer a request. Only the person who was asked can answer it."""
    connection = db.query(models.Connection).filter(
        models.Connection.id == connection_id).first()
    if not connection or connection.target_id != attendee.id:
        # Includes the requester trying to accept their own request.
        return {"ok": False, "reason": "not_yours_to_answer"}
    if connection.status != "pending":
        return {"ok": True, "status": connection.status, "already": True}

    connection.status = "accepted" if accept else "declined"
    connection.responded_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "status": connection.status, "already": False}


def my_connections(db: DbSession, attendee: models.Attendee) -> dict:
    """Requests waiting on me, requests I sent, and the people I am connected to.

    Emails appear ONLY inside accepted entries — this is the single place in
    the whole networking surface where a contact detail crosses over.
    """
    rows = db.query(models.Connection).filter(
        (models.Connection.requester_id == attendee.id)
        | (models.Connection.target_id == attendee.id),
        models.Connection.event_id == attendee.event_id,
    ).order_by(models.Connection.created_at.desc()).all()

    def public_half(other: models.Attendee) -> dict:
        profile = _profile(db, other)
        return _card(other, profile)

    incoming, outgoing, accepted = [], [], []
    for connection in rows:
        other = connection.target if connection.requester_id == attendee.id else connection.requester
        if connection.status == "accepted":
            card = public_half(other)
            # The handshake happened; both sides get the address.
            card["email"] = other.email or ""
            card["connection_id"] = connection.id
            accepted.append(card)
        elif connection.status == "pending":
            card = public_half(other)
            card["connection_id"] = connection.id
            if connection.target_id == attendee.id:
                incoming.append(card)
            else:
                outgoing.append(card)
        # Declined requests are shown to nobody: the requester sees their
        # request simply never accepted, the decliner is done with it.

    return {"ok": True, "incoming": incoming, "outgoing": outgoing, "accepted": accepted}


def connect_by_token(db: DbSession, attendee: models.Attendee, token: str) -> dict:
    """Connect to the person whose badge was just scanned.

    The printed token names them; they must be at THIS event and must have
    made themselves reachable - either in the directory or by publishing their
    card. The requester does not have to be in the directory: scanning a badge
    someone handed you is already a face-to-face ask. Everything else is the
    same handshake as `connect`: pending until the other person accepts, and
    nothing crosses over until then.
    """
    if not _event_allows(db, attendee.event_id):
        return {"ok": False, "reason": "networking_disabled"}
    if not token:
        return {"ok": False, "reason": "not_available"}
    target = db.query(models.Attendee).filter(
        models.Attendee.public_token == token,
        models.Attendee.event_id == attendee.event_id,
    ).first()
    if not target:
        return {"ok": False, "reason": "not_available"}
    if target.id == attendee.id:
        return {"ok": False, "reason": "cannot_connect_to_self"}
    target_profile = _profile(db, target)
    if not (target_profile and (target_profile.visible or target_profile.card_public)):
        return {"ok": False, "reason": "not_available"}
    existing = db.query(models.Connection).filter(
        ((models.Connection.requester_id == attendee.id) & (models.Connection.target_id == target.id))
        | ((models.Connection.requester_id == target.id) & (models.Connection.target_id == attendee.id)),
    ).first()
    name = f"{target.first_name or ''} {target.last_name or ''}".strip()
    if existing:
        return {"ok": True, "status": existing.status, "already": True,
                "connection_id": existing.id, "target_name": name}
    connection = models.Connection(
        event_id=attendee.event_id, requester_id=attendee.id, target_id=target.id,
    )
    db.add(connection)
    db.commit()
    db.refresh(connection)
    return {"ok": True, "status": "pending", "already": False,
            "connection_id": connection.id, "target_name": name}
