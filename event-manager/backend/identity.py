"""Linking a signed-in Gaia person to the attendee records that are theirs.

An attendee row is event-scoped, and that is right: a ticket is for one event.
But a person is not. Someone who came to Elevate 2026 and books again next year
should sign in once and see both. This module is the bridge, and it is the only
place allowed to decide that a given Gaia session owns a given attendee record.

The rule it exists to enforce: **only deterministic evidence links an identity.**
Never a name, never a fuzzy match, never a "probably the same person". Two
attendees called Sarah Miller at one conference is not a hypothetical, and
showing one of them the other's QR code — which is also their check-in
credential and their lead-capture identity — is the worst thing this system
could do. When the evidence is ambiguous the answer is UNRESOLVED, and an
unresolved person sees nothing rather than something plausible.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

import models

# Evidence strengths, strongest first. A stronger link supersedes a weaker one
# for the same attendee; a weaker one never overwrites a stronger.
EVIDENCE_RANK = {"contact_id": 3, "verified_email": 2, "claimed": 1}


def normalize_email(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def normalize_contact_id(value: Optional[str]) -> str:
    return (value or "").strip()


def _attendee_contact_id(attendee: models.Attendee) -> str:
    """The GHL contact id the registration webhook stored, if any."""
    return normalize_contact_id((attendee.custom_data or {}).get("contact_id"))


def resolve_attendees(
    db: Session,
    *,
    contact_id: Optional[str] = None,
    email: Optional[str] = None,
    email_verified: bool = False,
):
    """Every attendee record belonging to this person, across all events.

    Returns ``(attendees, report)``. The report says which evidence matched and
    names anything that was deliberately refused, so an operator can tell the
    difference between "this person has no ticket" and "we would not guess".

    `email_verified` matters. The Gaia session proves an email because the
    person followed a magic link to it; a merely *claimed* email — typed into a
    form, passed as a query parameter — proves nothing and must not unlock a
    ticket. Callers pass the session's own verification state and this function
    refuses to fall back.
    """
    contact_id = normalize_contact_id(contact_id)
    email = normalize_email(email)

    report = {
        "matched_by": [],
        "refused": [],
        "unresolved": [],
    }
    found: dict[int, tuple[models.Attendee, str]] = {}

    # 1. Contact id — the strongest evidence available. It comes from the ticket
    #    sale itself, so it ties the badge to the purchase rather than to
    #    whatever address the person later signed in with.
    if contact_id:
        for attendee in db.query(models.Attendee).all():
            if _attendee_contact_id(attendee) and _attendee_contact_id(attendee) == contact_id:
                found[attendee.id] = (attendee, "contact_id")
        if found:
            report["matched_by"].append("contact_id")

    # 2. Verified email — exact, case-insensitive, and only when the session
    #    actually proved it.
    if email:
        if not email_verified:
            report["refused"].append("unverified_email")
        else:
            rows = db.query(models.Attendee).filter(
                func.lower(models.Attendee.email) == email
            ).all()

            # One person, one ticket, per event. More than one row for the same
            # email in the same event means the data is ambiguous — two sales,
            # a bad import, a merge gone wrong — and we will not pick. The
            # event is reported unresolved and an operator resolves it.
            by_event: dict[int, list[models.Attendee]] = {}
            for attendee in rows:
                by_event.setdefault(attendee.event_id, []).append(attendee)

            for event_id, group in by_event.items():
                if len(group) > 1:
                    report["unresolved"].append({
                        "event_id": event_id,
                        "reason": "duplicate_email_in_event",
                        "count": len(group),
                    })
                    continue
                attendee = group[0]
                # Do not downgrade a contact_id match to an email one.
                if attendee.id not in found:
                    found[attendee.id] = (attendee, "verified_email")
            if any(a for a, e in found.values() if e == "verified_email"):
                report["matched_by"].append("verified_email")

    attendees = [a for a, _ in found.values()]
    evidence = {a.id: e for a, e in found.values()}
    return attendees, evidence, report


def record_links(db: Session, attendees, evidence: dict, *, contact_id=None, email=None) -> int:
    """Persist the links so they are auditable rather than recomputed silently.

    Idempotent: re-resolving the same person does not accumulate rows, and an
    existing link is only ever upgraded to stronger evidence, never downgraded.
    """
    contact_id = normalize_contact_id(contact_id)
    email = normalize_email(email)
    written = 0

    for attendee in attendees:
        how = evidence.get(attendee.id, "verified_email")
        existing = db.query(models.AttendeeIdentity).filter(
            models.AttendeeIdentity.attendee_id == attendee.id,
            (models.AttendeeIdentity.gaia_contact_id == (contact_id or None))
            | (models.AttendeeIdentity.gaia_email == (email or None)),
        ).first()

        if existing:
            if EVIDENCE_RANK.get(how, 0) > EVIDENCE_RANK.get(existing.evidence, 0):
                existing.evidence = how
                written += 1
            continue

        db.add(models.AttendeeIdentity(
            attendee_id=attendee.id,
            gaia_contact_id=contact_id or None,
            gaia_email=email or None,
            evidence=how,
            created_at=datetime.utcnow(),
        ))
        written += 1

    if written:
        db.commit()
    return written


def pass_label(attendee: models.Attendee) -> str:
    """What to *show* for this person's pass.

    Display only. The structural ticket type is the authority for access; this
    falls back to whatever the seller called it purely so a migrated attendee
    with no ticket type yet still sees something truthful on their ticket.
    """
    if attendee.ticket_type and attendee.ticket_type.name:
        return attendee.ticket_type.name
    custom = attendee.custom_data or {}
    return custom.get("pass_type") or custom.get("Pass Type") or "General admission"


def attendee_grants(attendee: models.Attendee) -> dict:
    """Access this attendee actually holds.

    Reads the ticket type only. An attendee with no ticket type assigned holds
    no special access — the safe answer while events are migrated, and the
    reason the flags live on the row rather than being parsed out of a name.
    """
    ticket = attendee.ticket_type
    return {
        "is_vip": bool(ticket and ticket.is_vip),
        "workshops": bool(ticket and ticket.grants_workshops),
    }
