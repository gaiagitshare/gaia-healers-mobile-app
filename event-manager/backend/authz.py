"""Who may do what, at which event.

Two rules shape this module.

**Roles are per-event.** Door staff hired for one weekend conference must be
able to check people in at that conference and nowhere else — not at the event
in the next hall, not at next year's. So authorization is always asked as a
question about a pair: may this person do this thing *at this event*. There is
no global "staff" flag to leak sideways.

**It fails closed.** An unknown role, a missing event, a token that resolves to
nothing — all produce a refusal, never a default-allow. The only shortcut is
User.is_admin, the platform owner, checked before anything else.

The second half of this file governs what an exhibitor learns when they scan a
badge, which is a privacy question rather than an access one: buying a
conference ticket is not agreement to have your phone number handed to every
stand in the hall.
"""

from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

import models

# Roles that can be granted per event.
ORGANIZER = "organizer"
CHECKIN_STAFF = "checkin_staff"
EXHIBITOR_MANAGER = "exhibitor_manager"
GRANTABLE_ROLES = {ORGANIZER, CHECKIN_STAFF, EXHIBITOR_MANAGER}

# What each role may do. Listed explicitly rather than derived from a hierarchy:
# a hierarchy invites "staff is basically organizer minus a bit", and the minus
# is where the mistakes live.
CAPABILITIES = {
    ORGANIZER: {
        "event.read", "event.write",
        "attendee.read", "attendee.write", "attendee.export",
        "checkin.perform",
        "exhibitor.read", "exhibitor.write", "exhibitor.grant_scanning",
        "lead.read", "analytics.read",
    },
    CHECKIN_STAFF: {
        # Enough to work a door: find someone, admit them. Not enough to export
        # the attendee list or read anyone's leads.
        "attendee.read", "checkin.perform", "event.read",
    },
    EXHIBITOR_MANAGER: {
        "event.read", "exhibitor.read", "exhibitor.write", "lead.read",
    },
}


def roles_for(db: Session, user: models.User, event_id: int) -> set:
    """Every role this person holds at this event."""
    if not user or not event_id:
        return set()
    rows = db.query(models.EventRole).filter(
        models.EventRole.user_id == user.id,
        models.EventRole.event_id == event_id,
    ).all()
    return {row.role for row in rows if row.role in GRANTABLE_ROLES}


def capabilities_for(db: Session, user: models.User, event_id: int) -> set:
    """What this person may do at this event."""
    if not user:
        return set()
    if user.is_admin:
        # The platform owner. Every capability, at every event.
        return set().union(*CAPABILITIES.values())
    granted = set()
    for role in roles_for(db, user, event_id):
        granted |= CAPABILITIES.get(role, set())
    return granted


def can(db: Session, user: models.User, event_id: int, capability: str) -> bool:
    return capability in capabilities_for(db, user, event_id)


def require_cap(db: Session, user: models.User, event_id, capability: str) -> None:
    """Raise 403 unless the user may perform capability at event_id.

    is_admin passes everything (see capabilities_for); a per-event role passes
    only where granted; anyone else is refused. Endpoints that only carry a
    child id (an attendee, an exhibitor) resolve event_id from that row first."""
    if event_id is None or not can(db, user, event_id, capability):
        raise HTTPException(status_code=403, detail="Not permitted for this event")


def require_admin(user: models.User) -> None:
    """Require the platform-admin flag for operations that are not event-scoped.

    Creating/importing a brand-new event has no event id against which a role
    can be checked, so it must never be authorized merely by authentication.
    """
    if not user or not bool(getattr(user, "is_admin", False)):
        raise HTTPException(status_code=403, detail="Platform administrator required")


# ── What an exhibitor learns from a scan ────────────────────────────────────

# Always shared. These are what a person hands over on a business card at a
# stand, and the exchange is the point of scanning.
ALWAYS_SHARED = ("first_name", "last_name", "company", "job_title")


def lead_view(attendee: models.Attendee) -> dict:
    """The attendee, as an exhibitor is permitted to see them.

    Name, company and role always; email and phone only where that attendee has
    explicitly said yes. This is the function the scan endpoint must return
    through — returning the ORM object directly is how the previous version
    handed a full record, email and phone included, to any token holder.
    """
    view = {field: getattr(attendee, field, None) or "" for field in ALWAYS_SHARED}
    view["attendee_id"] = attendee.id
    view["email"] = attendee.email if attendee.share_email_with_exhibitors else None
    view["phone"] = attendee.phone if attendee.share_phone_with_exhibitors else None
    # Said out loud so an exhibitor understands why a field is blank, rather
    # than assuming the data is missing and chasing it another way.
    view["consent"] = {
        "email": bool(attendee.share_email_with_exhibitors),
        "phone": bool(attendee.share_phone_with_exhibitors),
    }
    return view


def lead_public_view(lead) -> Optional[dict]:
    """A captured lead as its own exhibitor may see it.

    Consent is honored from BOTH the snapshot taken at scan time and the
    attendee's current setting (most restrictive wins), so a lead list can never
    expose an email or phone the attendee did not agree to share, and a later
    withdrawal is respected. This is the list-endpoint counterpart to
    lead_view() and must be used instead of returning the ORM Lead (whose nested
    Attendee carries email and phone in full)."""
    attendee = getattr(lead, "attendee", None)
    if attendee is None:
        return None
    snap = getattr(lead, "consent_snapshot", None) or {}
    view = {field: getattr(attendee, field, None) or "" for field in ALWAYS_SHARED}
    view["attendee_id"] = attendee.id
    email_ok = bool(snap.get("email")) and bool(attendee.share_email_with_exhibitors)
    phone_ok = bool(snap.get("phone")) and bool(attendee.share_phone_with_exhibitors)
    view["email"] = attendee.email if email_ok else None
    view["phone"] = attendee.phone if phone_ok else None
    view["consent"] = {"email": email_ok, "phone": phone_ok}
    return view


def consent_snapshot(attendee: models.Attendee) -> dict:
    """What consent permitted at the moment of a scan.

    Stored on the lead rather than recomputed later: consent can be withdrawn,
    and the truthful record is what was agreed when the exchange happened — not
    what the attendee's settings say months afterwards.
    """
    return {
        "email": bool(attendee.share_email_with_exhibitors),
        "phone": bool(attendee.share_phone_with_exhibitors),
    }


def exhibitor_for_token(db: Session, access_token: str) -> Optional[models.Exhibitor]:
    """Resolve a scanner token to an exhibitor that is actually allowed to scan.

    A token alone is not permission. `can_scan_leads` is what an organiser sells
    and grants; without it the token resolves to nothing and the scanner page
    behaves exactly as it does for an invalid token.
    """
    token = (access_token or "").strip()
    if not token:
        return None
    exhibitor = db.query(models.Exhibitor).filter(
        models.Exhibitor.access_token == token
    ).first()
    if not exhibitor or not exhibitor.can_scan_leads:
        return None
    return exhibitor
