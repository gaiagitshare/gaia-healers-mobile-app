# -*- coding: utf-8 -*-
"""Volunteer scheduling for an event (7 Nov 2026).

Admins (organisers / platform admins / volunteer coordinators) manage
volunteers, shifts and requests from the Event Manager. Volunteers use a
private personal link: no account, no password, revocable at any time. A
general "join the team" link lets new people apply; they wait as pending until
an admin approves them.

Rules, enforced here and nowhere else:
  * a shift never holds more active bookings (requested + confirmed) than its
    capacity -- the count happens under the database write lock, so two people
    cannot take the last place at the same moment;
  * a volunteer never holds two active bookings whose times overlap (all-day
    lead roles excepted);
  * a volunteer can request, and cancel, only their own shifts; only admins
    confirm, decline, assign, move or change anybody else's;
  * every change is logged with who made it, before and after.

Nothing here sends an email or an SMS, and nothing touches tickets, payments,
badges, stands or GHL.
"""
import csv
import io
import re
import secrets
from datetime import datetime
from typing import Optional

from fastapi import Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

import authz
import models
import volunteer_invites as INV
from database import get_db

ACTIVE = ("requested", "confirmed")
STATUSES = ("requested", "confirmed", "declined", "cancelled")
V_STATUSES = ("pending", "approved", "rejected")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,64}$")


def _now():
    return datetime.utcnow()


def new_token():
    return secrets.token_urlsafe(24)


def _mins(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def overlaps(a, b):
    """Two shifts overlap: same day, intervals intersect, neither a lead role."""
    if a.id == b.id or a.day != b.day or a.lead_role or b.lead_role:
        return False
    return _mins(a.start_time) < _mins(b.end_time) and _mins(b.start_time) < _mins(a.end_time)


def short_name(v):
    """What other volunteers see: first name and last initial, nothing else."""
    last = (v.last_name or "").strip()
    return ("%s %s" % ((v.first_name or "").strip(), (last[:1] + ".") if last else "")).strip()


def full_name(v):
    return ("%s %s" % (v.first_name or "", v.last_name or "")).strip()


def log(db, event_id, actor, action, volunteer_id=None, shift_id=None, booking_id=None, before=None, after=None):
    db.add(models.VolunteerLog(event_id=event_id, at=_now(), actor=actor, action=action, volunteer_id=volunteer_id,
                               shift_id=shift_id, booking_id=booking_id, before=before, after=after))


def _write_lock(db):
    # A real write statement is what makes SQLite take the RESERVED lock; a
    # no-op UPDATE on a table that always exists does exactly that.
    db.execute(text("UPDATE volunteer_shifts SET id = id WHERE id = (SELECT MIN(id) FROM volunteer_shifts)"))


def active_count(db, shift_id, exclude_booking=None):
    q = db.query(models.VolunteerBooking).filter(models.VolunteerBooking.shift_id == shift_id,
                                                 models.VolunteerBooking.status.in_(ACTIVE))
    if exclude_booking:
        q = q.filter(models.VolunteerBooking.id != exclude_booking)
    return q.count()


def check_can_hold(db, shift, volunteer, exclude_booking=None):
    """Raise 409 unless this volunteer may hold a place on this shift now.
    Call only after _write_lock()."""
    if not shift.active:
        raise HTTPException(status_code=409, detail="This shift is no longer offered.")
    if volunteer.status == "rejected":
        raise HTTPException(status_code=409, detail="This volunteer is not on the team.")
    mine = db.query(models.VolunteerBooking).filter(models.VolunteerBooking.volunteer_id == volunteer.id,
                                                    models.VolunteerBooking.status.in_(ACTIVE)).all()
    for b in mine:
        if b.id == exclude_booking:
            continue
        if b.shift_id == shift.id:
            raise HTTPException(status_code=409, detail="Already on this shift.")
        other = db.query(models.VolunteerShift).filter(models.VolunteerShift.id == b.shift_id).first()
        if other is not None and overlaps(shift, other):
            raise HTTPException(status_code=409, detail="This overlaps another shift: %s %s-%s." % (
                other.role, fmt_time(other.start_time), fmt_time(other.end_time)))
    if active_count(db, shift.id, exclude_booking) >= int(shift.capacity or 0):
        raise HTTPException(status_code=409, detail="This shift is full.")


def fmt_time(hhmm):
    h, m = [int(x) for x in hhmm.split(":")]
    return "%d:%02d %s" % ((h % 12) or 12, m, "AM" if h < 12 else "PM")


def shift_view(db, s, bookings, vols, admin=False):
    act = [b for b in bookings if b.shift_id == s.id and b.status in ACTIVE]
    people = []
    for b in sorted(act, key=lambda b: (b.status != "confirmed", b.id)):
        v = vols.get(b.volunteer_id)
        if v is None:
            continue
        p = {"booking_id": b.id if admin else None, "name": full_name(v) if admin else short_name(v), "status": b.status}
        if admin:
            p.update({"volunteer_id": v.id, "note": b.note})
        people.append(p)
    return {"id": s.id, "day": s.day, "start_time": s.start_time, "end_time": s.end_time, "lead_role": bool(s.lead_role),
            "role": s.role, "location": s.location, "description": s.description, "capacity": s.capacity,
            "taken": len(act), "confirmed": sum(1 for b in act if b.status == "confirmed"),
            "requested": sum(1 for b in act if b.status == "requested"),
            "open": max(0, int(s.capacity or 0) - len(act)), "people": people, "active": bool(s.active)}


def register(app, get_current_user, rate_limited, client_ip):
    """Mount the endpoints. Called once from main.py."""

    # ── helpers needing the app's auth ──────────────────────────────────────
    def admin_only(db, user, event_id):
        if not db.query(models.Event).filter(models.Event.id == event_id).first():
            raise HTTPException(status_code=404, detail="Event not found")
        authz.require_cap(db, user, event_id, "volunteer.manage")

    def who(user):
        return getattr(user, "full_name", None) or getattr(user, "email", None) or "admin"

    def program(db, event_id, create=True):
        p = db.query(models.VolunteerProgram).filter(models.VolunteerProgram.event_id == event_id).first()
        if p is None and create:
            p = models.VolunteerProgram(event_id=event_id, title="Volunteer Team", intro="", join_open=False,
                                        expected_per_day=2, updated_at=_now())
            db.add(p)
            db.flush()
        if p is not None and create:
            # Two shared links: the read-only TEAM schedule for the group, and
            # REGISTRATION for new people (open or closed by an admin).
            if not p.join_token:
                p.join_token = new_token()
            if not getattr(p, "team_token", None):
                p.team_token = new_token()
        return p

    def vol_or_404(db, event_id, vid):
        v = db.query(models.Volunteer).filter(models.Volunteer.id == vid, models.Volunteer.event_id == event_id).first()
        if not v:
            raise HTTPException(status_code=404, detail="Volunteer not found")
        return v

    def shift_or_404(db, event_id, sid):
        s = db.query(models.VolunteerShift).filter(models.VolunteerShift.id == sid,
                                                   models.VolunteerShift.event_id == event_id).first()
        if not s:
            raise HTTPException(status_code=404, detail="Shift not found")
        return s

    def by_token(db, token):
        if not token or not TOKEN_RE.match(token):
            raise HTTPException(status_code=404, detail="This link is not valid. Ask the volunteer team for a new one.")
        v = db.query(models.Volunteer).filter(models.Volunteer.token == token).first()
        if not v or v.status == "rejected":
            raise HTTPException(status_code=404, detail="This link is not valid. Ask the volunteer team for a new one.")
        if v.status != "approved":
            raise HTTPException(status_code=403, detail="Thank you for signing up! The volunteer team will review it and send you your personal link.")
        return v

    def throttle(request, what):
        if rate_limited("vol:%s:%s" % (what, client_ip(request)), limit=120, window=60):
            raise HTTPException(status_code=429, detail="Too many requests. Wait a minute.")

    def vol_row(v, counts):
        return {"id": v.id, "first_name": v.first_name, "last_name": v.last_name, "email": v.email, "phone": v.phone,
                "notes": v.notes, "status": v.status, "source": v.source, "needs_review": v.needs_review,
                "has_link": bool(v.token), "token": v.token, "created_at": v.created_at,
                "invite_status": v.invite_status or "not_sent", "invite_sent_at": v.invite_sent_at,
                "invite_error": v.invite_error, "first_opened_at": v.first_opened_at, "last_seen_at": v.last_seen_at,
                "confirmed": counts.get((v.id, "confirmed"), 0), "requested": counts.get((v.id, "requested"), 0)}

    # ── ADMIN ───────────────────────────────────────────────────────────────
    @app.get("/events/{event_id}/volunteers/overview")
    def vol_overview(event_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        admin_only(db, current_user, event_id)
        p = program(db, event_id)
        db.commit()
        vols = {v.id: v for v in db.query(models.Volunteer).filter(models.Volunteer.event_id == event_id).all()}
        shifts = db.query(models.VolunteerShift).filter(models.VolunteerShift.event_id == event_id).order_by(
            models.VolunteerShift.day, models.VolunteerShift.lead_role, models.VolunteerShift.start_time,
            models.VolunteerShift.sort, models.VolunteerShift.id).all()
        bookings = db.query(models.VolunteerBooking).filter(models.VolunteerBooking.event_id == event_id).all()
        counts = {}
        for b in bookings:
            counts[(b.volunteer_id, b.status)] = counts.get((b.volunteer_id, b.status), 0) + 1
        sv = [shift_view(db, s, bookings, vols, admin=True) for s in shifts]
        live = [s for s in sv if s["active"]]
        requests = []
        for b in bookings:
            if b.status != "requested":
                continue
            s = next((x for x in shifts if x.id == b.shift_id), None)
            v = vols.get(b.volunteer_id)
            if s and v:
                requests.append({"booking_id": b.id, "volunteer_id": v.id, "volunteer": full_name(v), "shift_id": s.id,
                                 "day": s.day, "start_time": s.start_time, "end_time": s.end_time, "role": s.role,
                                 "lead_role": bool(s.lead_role), "requested_at": b.created_at, "note": b.note})
        recent = db.query(models.VolunteerLog).filter(models.VolunteerLog.event_id == event_id).order_by(
            models.VolunteerLog.id.desc()).limit(40).all()
        return {
            "program": {"title": p.title, "intro": p.intro, "join_open": bool(p.join_open), "join_token": p.join_token,
                        "team_token": p.team_token, "expected_per_day": p.expected_per_day,
                        "sending_enabled": INV.enabled()},
            "onboarding": {k: sum(1 for v in vols.values() if v.status == "approved" and (v.invite_status or "not_sent") == k)
                           for k in ("not_sent", "sent", "opened", "accepted", "failed")},
            "announcements": [{"id": a.id, "title": a.title, "body": a.body, "pinned": bool(a.pinned), "active": bool(a.active),
                               "created_by": a.created_by, "created_at": a.created_at}
                              for a in db.query(models.VolunteerAnnouncement).filter(
                                  models.VolunteerAnnouncement.event_id == event_id).order_by(
                                  models.VolunteerAnnouncement.id.desc()).all()],
            "stats": {"volunteers": sum(1 for v in vols.values() if v.status == "approved"),
                      "pending_volunteers": sum(1 for v in vols.values() if v.status == "pending"),
                      "shifts": len(live), "positions": sum(s["capacity"] for s in live),
                      "filled": sum(s["confirmed"] for s in live), "requested": sum(s["requested"] for s in live),
                      "open": sum(s["open"] for s in live),
                      "understaffed": sum(1 for s in live if s["confirmed"] < s["capacity"]),
                      "needs_review": sum(1 for v in vols.values() if v.needs_review)},
            "volunteers": sorted([vol_row(v, counts) for v in vols.values()],
                                 key=lambda r: (r["status"] != "pending", (r["first_name"] or "").lower())),
            "shifts": sv, "requests": sorted(requests, key=lambda r: r["requested_at"] or _now()),
            "log": [{"at": l.at, "actor": l.actor, "action": l.action, "after": l.after} for l in recent]}

    @app.put("/events/{event_id}/volunteers/program")
    def vol_program(event_id: int, body: dict, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        admin_only(db, current_user, event_id)
        p = program(db, event_id)
        before = {"title": p.title, "join_open": p.join_open, "expected_per_day": p.expected_per_day}
        for k in ("title", "intro"):
            if k in body:
                setattr(p, k, (body.get(k) or "")[:20000])
        if "expected_per_day" in body:
            p.expected_per_day = max(0, min(10, int(body.get("expected_per_day") or 0)))
        if "join_open" in body:
            p.join_open = bool(body.get("join_open"))
        if body.get("new_join_link") or not p.join_token:
            p.join_token = new_token()
        p.updated_at = _now()
        log(db, event_id, who(current_user), "program_updated", before=before,
            after={"title": p.title, "join_open": p.join_open, "expected_per_day": p.expected_per_day,
                   "new_join_link": bool(body.get("new_join_link"))})
        db.commit()
        return {"ok": True, "join_token": p.join_token, "join_open": p.join_open}

    @app.post("/events/{event_id}/volunteers")
    def vol_add(event_id: int, body: dict, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        admin_only(db, current_user, event_id)
        first = (body.get("first_name") or "").strip()
        if not first:
            raise HTTPException(status_code=400, detail="A first name is required")
        email = (body.get("email") or "").strip().lower() or None
        if email and not EMAIL_RE.match(email):
            raise HTTPException(status_code=400, detail="That email address does not look right")
        if email and db.query(models.Volunteer).filter(models.Volunteer.event_id == event_id,
                                                       models.Volunteer.email == email).first():
            raise HTTPException(status_code=409, detail="A volunteer with this email is already on the list")
        v = models.Volunteer(event_id=event_id, first_name=first, last_name=(body.get("last_name") or "").strip(),
                             email=email, phone=(body.get("phone") or "").strip() or None,
                             notes=(body.get("notes") or "").strip() or None, status="approved",
                             token=new_token(), token_created_at=_now(), source="admin",
                             created_at=_now(), updated_at=_now())
        db.add(v)
        db.flush()
        log(db, event_id, who(current_user), "volunteer_added", volunteer_id=v.id, after={"name": full_name(v)})
        db.commit()
        return {"ok": True, "id": v.id, "token": v.token}

    @app.patch("/events/{event_id}/volunteers/{vid}")
    def vol_edit(event_id: int, vid: int, body: dict, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        """Edit details; approve / reject; new or revoked link."""
        admin_only(db, current_user, event_id)
        _write_lock(db)
        v = vol_or_404(db, event_id, vid)
        before = {"first_name": v.first_name, "last_name": v.last_name, "email": v.email, "phone": v.phone,
                  "status": v.status, "has_link": bool(v.token)}
        if "email" in body and (body.get("email") or "").strip().lower() != (v.email or ""):
            v.ghl_contact_id = None     # a different address is a different contact
        for k in ("first_name", "last_name", "phone", "notes"):
            if k in body:
                setattr(v, k, (body.get(k) or "").strip() or (None if k in ("phone", "notes") else ""))
        if not (v.first_name or "").strip():
            raise HTTPException(status_code=400, detail="A first name is required")
        if "email" in body:
            email = (body.get("email") or "").strip().lower() or None
            if email and not EMAIL_RE.match(email):
                raise HTTPException(status_code=400, detail="That email address does not look right")
            if email and db.query(models.Volunteer).filter(models.Volunteer.event_id == event_id,
                                                           models.Volunteer.email == email,
                                                           models.Volunteer.id != v.id).first():
                raise HTTPException(status_code=409, detail="Another volunteer already uses this email")
            v.email = email
        released = 0
        if "status" in body:
            st = body.get("status")
            if st not in V_STATUSES:
                raise HTTPException(status_code=400, detail="Unknown status")
            v.status = st
            if st == "rejected":
                # Off the team: their places go back, their link stops working.
                for b in db.query(models.VolunteerBooking).filter(models.VolunteerBooking.volunteer_id == v.id,
                                                                  models.VolunteerBooking.status.in_(ACTIVE)).all():
                    b.status, b.decided_by, b.updated_at = "declined", who(current_user), _now()
                    released += 1
                v.token = None
        if body.get("new_link"):
            v.token, v.token_created_at = new_token(), _now()
            v.invite_status, v.invite_message_id, v.invite_error, v.first_opened_at = "not_sent", None, None, None
        if body.get("revoke_link"):
            v.token = None
            v.invite_status, v.invite_message_id = "not_sent", None
        if "needs_review" in body and not body.get("needs_review"):
            v.needs_review = None
        v.updated_at = _now()
        log(db, event_id, who(current_user), "volunteer_updated", volunteer_id=v.id, before=before,
            after={"first_name": v.first_name, "last_name": v.last_name, "email": v.email, "phone": v.phone,
                   "status": v.status, "has_link": bool(v.token), "places_released": released})
        db.commit()
        return {"ok": True, "token": v.token, "status": v.status, "released": released}

    @app.post("/events/{event_id}/volunteer-shifts")
    def shift_add(event_id: int, body: dict, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        admin_only(db, current_user, event_id)
        s = models.VolunteerShift(event_id=event_id, active=True, created_at=_now())
        _apply_shift(s, body, new=True)
        db.add(s)
        db.flush()
        log(db, event_id, who(current_user), "shift_added", shift_id=s.id, after=_shift_dict(s))
        db.commit()
        return {"ok": True, "id": s.id}

    @app.patch("/events/{event_id}/volunteer-shifts/{sid}")
    def shift_edit(event_id: int, sid: int, body: dict, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        admin_only(db, current_user, event_id)
        _write_lock(db)
        s = shift_or_404(db, event_id, sid)
        before = _shift_dict(s)
        _apply_shift(s, body, new=False)
        taken = active_count(db, s.id)
        if int(s.capacity) < taken:
            raise HTTPException(status_code=409, detail="%d people already hold this shift. Move or remove someone "
                                                        "before lowering the places below that." % taken)
        if "active" in body:
            s.active = bool(body.get("active"))
            if not s.active and taken:
                raise HTTPException(status_code=409, detail="People hold this shift. Move or remove them first.")
        # New times must not create an overlap for anybody already on it.
        if any(k in body for k in ("day", "start_time", "end_time", "lead_role")):
            for b in db.query(models.VolunteerBooking).filter(models.VolunteerBooking.shift_id == s.id,
                                                              models.VolunteerBooking.status.in_(ACTIVE)).all():
                for o in db.query(models.VolunteerBooking).filter(models.VolunteerBooking.volunteer_id == b.volunteer_id,
                                                                  models.VolunteerBooking.status.in_(ACTIVE),
                                                                  models.VolunteerBooking.id != b.id).all():
                    other = db.query(models.VolunteerShift).filter(models.VolunteerShift.id == o.shift_id).first()
                    if other is not None and overlaps(s, other):
                        raise HTTPException(status_code=409, detail="The new time would make a volunteer on this shift "
                                                                    "double-booked. Move them first.")
        log(db, event_id, who(current_user), "shift_updated", shift_id=s.id, before=before, after=_shift_dict(s))
        db.commit()
        return {"ok": True}

    @app.post("/events/{event_id}/volunteer-bookings")
    def booking_assign(event_id: int, body: dict, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        """An admin puts a volunteer on a shift (confirmed straight away)."""
        admin_only(db, current_user, event_id)
        _write_lock(db)
        s = shift_or_404(db, event_id, int(body.get("shift_id") or 0))
        v = vol_or_404(db, event_id, int(body.get("volunteer_id") or 0))
        check_can_hold(db, s, v)
        if v.status == "pending":
            v.status = "approved"
        b = models.VolunteerBooking(event_id=event_id, shift_id=s.id, volunteer_id=v.id, status="confirmed",
                                    note=(body.get("note") or "").strip() or None, created_by=who(current_user),
                                    decided_by=who(current_user), created_at=_now(), updated_at=_now())
        db.add(b)
        db.flush()
        log(db, event_id, who(current_user), "assigned", volunteer_id=v.id, shift_id=s.id, booking_id=b.id,
            after={"status": "confirmed", "volunteer": full_name(v), "shift": "%s %s %s" % (s.day, s.start_time, s.role)})
        db.commit()
        return {"ok": True, "booking_id": b.id}

    @app.patch("/events/{event_id}/volunteer-bookings/{bid}")
    def booking_decide(event_id: int, bid: int, body: dict, db: Session = Depends(get_db),
                       current_user=Depends(get_current_user)):
        """Approve, decline, release, or move a booking to another shift."""
        admin_only(db, current_user, event_id)
        _write_lock(db)
        b = db.query(models.VolunteerBooking).filter(models.VolunteerBooking.id == bid,
                                                     models.VolunteerBooking.event_id == event_id).first()
        if not b:
            raise HTTPException(status_code=404, detail="Request not found")
        v = vol_or_404(db, event_id, b.volunteer_id)
        before = {"status": b.status, "shift_id": b.shift_id, "note": b.note}
        if body.get("move_to_shift_id"):
            target = shift_or_404(db, event_id, int(body.get("move_to_shift_id")))
            if b.status not in ACTIVE:
                raise HTTPException(status_code=409, detail="Only an active booking can be moved")
            check_can_hold(db, target, v, exclude_booking=b.id)
            b.shift_id = target.id
            b.status = "confirmed"
        if body.get("status"):
            st = body.get("status")
            if st not in STATUSES:
                raise HTTPException(status_code=400, detail="Unknown status")
            if st in ACTIVE and b.status not in ACTIVE:
                check_can_hold(db, shift_or_404(db, event_id, b.shift_id), v, exclude_booking=b.id)
            b.status = st
            if st == "confirmed" and v.status == "pending":
                v.status = "approved"
        if "note" in body:
            b.note = (body.get("note") or "").strip() or None
        b.decided_by, b.updated_at = who(current_user), _now()
        log(db, event_id, who(current_user), "booking_updated", volunteer_id=v.id, shift_id=b.shift_id, booking_id=b.id,
            before=before, after={"status": b.status, "shift_id": b.shift_id, "note": b.note})
        db.commit()
        return {"ok": True, "status": b.status, "shift_id": b.shift_id}

    @app.get("/events/{event_id}/volunteers/export.csv")
    def vol_export(event_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        admin_only(db, current_user, event_id)
        vols = {v.id: v for v in db.query(models.Volunteer).filter(models.Volunteer.event_id == event_id).all()}
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["Day", "Start", "End", "Role", "Location", "Places", "Volunteer", "Status", "Email", "Phone"])
        for s in db.query(models.VolunteerShift).filter(models.VolunteerShift.event_id == event_id,
                                                        models.VolunteerShift.active == True).order_by(   # noqa: E712
                models.VolunteerShift.day, models.VolunteerShift.start_time, models.VolunteerShift.sort).all():
            act = db.query(models.VolunteerBooking).filter(models.VolunteerBooking.shift_id == s.id,
                                                           models.VolunteerBooking.status.in_(ACTIVE)).all()
            rows = [(vols.get(b.volunteer_id), b.status) for b in act] or [(None, "OPEN")]
            for v, st in rows:
                w.writerow([s.day, "all day" if s.lead_role else fmt_time(s.start_time),
                            "" if s.lead_role else fmt_time(s.end_time), s.role, s.location or "", s.capacity,
                            full_name(v) if v else "", st, (v.email or "") if v else "", (v.phone or "") if v else ""])
        return PlainTextResponse(out.getvalue(), media_type="text/csv",
                                 headers={"Content-Disposition": "attachment; filename=volunteer-schedule.csv"})

    # ── INVITATIONS (admin) ─────────────────────────────────────────────────
    def invite_check(db, v, resend=False):
        """(contact_id, None) if this person can be emailed now, else (None, why)."""
        if v.status != "approved":
            return None, "not approved yet"
        if not v.token:
            return None, "no personal link (make one first)"
        if not v.email:
            return None, "no email address"
        if (v.invite_status or "not_sent") in ("sent", "opened", "accepted") and not resend:
            return None, "already invited (use Resend)"
        if v.ghl_contact_id:
            return v.ghl_contact_id, None
        cid, why = INV.find_contact(v.email)
        if cid:
            v.ghl_contact_id = cid
        return cid, why

    @app.post("/events/{event_id}/volunteers/invite-preview")
    def invite_preview(event_id: int, body: dict, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        """Who would receive the invitation, and who cannot be emailed and why. Sends nothing."""
        admin_only(db, current_user, event_id)
        ids = [int(x) for x in (body.get("volunteer_ids") or [])][:200]
        out = []
        for v in db.query(models.Volunteer).filter(models.Volunteer.event_id == event_id, models.Volunteer.id.in_(ids)).all():
            cid, why = invite_check(db, v, resend=bool(body.get("resend")))
            out.append({"id": v.id, "name": full_name(v), "email": v.email, "can_send": bool(cid), "reason": why,
                        "invite_status": v.invite_status or "not_sent"})
        db.commit()
        return {"sending_enabled": INV.enabled(), "recipients": out,
                "can_send": sum(1 for r in out if r["can_send"])}

    @app.post("/events/{event_id}/volunteers/invite")
    def invite_send(event_id: int, body: dict, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        """Send (or resend) invitations to the reviewed recipients. The admin
        confirms the exact number shown in the preview. Refused entirely while
        sending is switched off."""
        admin_only(db, current_user, event_id)
        if not INV.enabled():
            raise HTTPException(status_code=423, detail="Sending invitations is switched off until the owner approves it. "
                                                        "You can copy each person's link instead.")
        ids = [int(x) for x in (body.get("volunteer_ids") or [])][:100]
        resend = bool(body.get("resend"))
        vols = db.query(models.Volunteer).filter(models.Volunteer.event_id == event_id, models.Volunteer.id.in_(ids)).all()
        ready = [(v,) + invite_check(db, v, resend) for v in vols]
        sendable = [r for r in ready if r[1]]
        if int(body.get("confirm_count") or -1) != len(sendable):
            raise HTTPException(status_code=409, detail="The recipients changed since the preview. Review them again.")
        ev = db.query(models.Event).filter(models.Event.id == event_id).first()
        p = program(db, event_id)
        base = (body.get("base_url") or "https://api.gaiahealers.app").rstrip("/")
        if not re.match(r"^https://[a-z0-9.-]+$", base):
            base = "https://api.gaiahealers.app"
        results = []
        for v, cid, why in ready:
            if not cid:
                results.append({"id": v.id, "name": full_name(v), "ok": False, "reason": why})
                continue
            subject, html = INV.render(v.first_name, "%s/event/volunteer/%s" % (base, v.token), ev.name if ev else "", p.title)
            r = INV.send(cid, subject, html)
            v.invite_sent_at, v.invite_checked_at = _now(), None
            if r["ok"]:
                v.invite_status = "accepted" if v.first_opened_at else "sent"
                v.invite_message_id, v.invite_error = r["message_id"], None
            else:
                v.invite_status, v.invite_error = "failed", r["reason"]
            log(db, event_id, who(current_user), "invitation_resent" if resend else "invitation_sent", volunteer_id=v.id,
                after={"ok": r["ok"], "reason": r["reason"]})
            db.commit()
            results.append({"id": v.id, "name": full_name(v), "ok": r["ok"], "reason": r["reason"]})
        return {"sent": sum(1 for r in results if r["ok"]), "results": results}

    @app.post("/events/{event_id}/volunteers/invite-status-refresh")
    def invite_refresh(event_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        """Ask GHL what happened to sent invitations (delivered / opened / failed)."""
        admin_only(db, current_user, event_id)
        n = 0
        for v in db.query(models.Volunteer).filter(models.Volunteer.event_id == event_id,
                                                   models.Volunteer.invite_status.in_(("sent", "opened"))).limit(60).all():
            st = INV.provider_status(v.invite_message_id)
            v.invite_checked_at = _now()
            if st == "opened" and v.invite_status == "sent":
                v.invite_status = "opened"
            elif st == "failed":
                v.invite_status, v.invite_error = "failed", "the email bounced or was rejected"
            n += 1
        db.commit()
        return {"checked": n}

    @app.post("/events/{event_id}/volunteer-announcements")
    def ann_add(event_id: int, body: dict, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        admin_only(db, current_user, event_id)
        title, text_ = (body.get("title") or "").strip()[:160], (body.get("body") or "").strip()[:5000]
        if not title:
            raise HTTPException(status_code=400, detail="Give the announcement a title")
        a = models.VolunteerAnnouncement(event_id=event_id, title=title, body=text_, pinned=bool(body.get("pinned")),
                                         active=True, created_by=who(current_user), created_at=_now())
        db.add(a); db.flush()
        log(db, event_id, who(current_user), "announcement_posted", after={"title": title})
        db.commit()
        return {"ok": True, "id": a.id}

    @app.patch("/events/{event_id}/volunteer-announcements/{aid}")
    def ann_edit(event_id: int, aid: int, body: dict, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        admin_only(db, current_user, event_id)
        a = db.query(models.VolunteerAnnouncement).filter(models.VolunteerAnnouncement.id == aid,
                                                          models.VolunteerAnnouncement.event_id == event_id).first()
        if not a:
            raise HTTPException(status_code=404, detail="Announcement not found")
        for k in ("title", "body"):
            if k in body:
                setattr(a, k, (body.get(k) or "").strip()[:5000])
        for k in ("pinned", "active"):
            if k in body:
                setattr(a, k, bool(body.get(k)))
        log(db, event_id, who(current_user), "announcement_updated", after={"title": a.title, "active": a.active})
        db.commit()
        return {"ok": True}

    # ── VOLUNTEER (private link) ────────────────────────────────────────────
    def portal_payload(db, v):
        p = program(db, v.event_id)
        ev = db.query(models.Event).filter(models.Event.id == v.event_id).first()
        vols = {x.id: x for x in db.query(models.Volunteer).filter(models.Volunteer.event_id == v.event_id).all()}
        shifts = db.query(models.VolunteerShift).filter(models.VolunteerShift.event_id == v.event_id,
                                                        models.VolunteerShift.active == True).order_by(   # noqa: E712
            models.VolunteerShift.day, models.VolunteerShift.lead_role, models.VolunteerShift.start_time,
            models.VolunteerShift.sort, models.VolunteerShift.id).all()
        bookings = db.query(models.VolunteerBooking).filter(models.VolunteerBooking.event_id == v.event_id).all()
        mine = [b for b in bookings if b.volunteer_id == v.id and b.status != "cancelled"]
        by_shift = {s.id: s for s in shifts}
        anns = db.query(models.VolunteerAnnouncement).filter(models.VolunteerAnnouncement.event_id == v.event_id,
                                                             models.VolunteerAnnouncement.active == True).order_by(   # noqa: E712
            models.VolunteerAnnouncement.pinned.desc(), models.VolunteerAnnouncement.id.desc()).all()
        return {"me": {"first_name": v.first_name, "last_name": v.last_name, "email": v.email, "phone": v.phone,
                       "status": v.status},
                "announcements": [{"id": a.id, "title": a.title, "body": a.body, "pinned": bool(a.pinned),
                                   "created_at": a.created_at} for a in anns],
                "event": {"name": ev.name if ev else "", "timezone": (ev.timezone if ev else None) or "America/New_York",
                          "location": getattr(ev, "location", None)},
                "program": {"title": p.title, "intro": p.intro, "expected_per_day": p.expected_per_day},
                "my_bookings": [{"booking_id": b.id, "status": b.status, "shift": shift_view(db, by_shift[b.shift_id], bookings, vols)}
                                for b in sorted(mine, key=lambda b: (by_shift[b.shift_id].day, by_shift[b.shift_id].start_time))
                                if b.shift_id in by_shift],
                "shifts": [shift_view(db, s, bookings, vols) for s in shifts]}

    @app.get("/volunteer/{token}")
    def portal(token: str, request: Request, db: Session = Depends(get_db)):
        throttle(request, "view")
        v = by_token(db, token)
        now = _now()
        if not v.first_opened_at:
            v.first_opened_at = now
            v.invite_status = "accepted"
            log(db, v.event_id, "volunteer: %s" % full_name(v), "opened_portal", volunteer_id=v.id)
        v.last_seen_at = now
        out = portal_payload(db, v)
        db.commit()
        return out

    @app.post("/volunteer/{token}/profile")
    def portal_profile(token: str, body: dict, request: Request, db: Session = Depends(get_db)):
        """A volunteer updates their own phone (and name spelling). Their email
        is the team's record and only an admin changes it."""
        throttle(request, "act")
        v = by_token(db, token)
        before = {"first_name": v.first_name, "last_name": v.last_name, "phone": v.phone}
        if "phone" in body:
            ph = (body.get("phone") or "").strip()[:40]
            if not re.search(r"\d{6,}", re.sub(r"\D", "", ph) or ""):
                raise HTTPException(status_code=400, detail="Please enter a phone number the team can text")
            v.phone = ph
        for k in ("first_name", "last_name"):
            if k in body:
                val = (body.get(k) or "").strip()[:80]
                if k == "first_name" and not val:
                    raise HTTPException(status_code=400, detail="Please enter your first name")
                setattr(v, k, val)
        v.updated_at = _now()
        log(db, v.event_id, "volunteer: %s" % full_name(v), "profile_updated", volunteer_id=v.id, before=before,
            after={"first_name": v.first_name, "last_name": v.last_name, "phone": v.phone})
        db.commit()
        return {"ok": True}

    @app.post("/volunteer/{token}/request")
    def portal_request(token: str, body: dict, request: Request, db: Session = Depends(get_db)):
        """Ask for a shift. It holds a place straight away and waits for an admin."""
        throttle(request, "act")
        _write_lock(db)
        v = by_token(db, token)
        s = db.query(models.VolunteerShift).filter(models.VolunteerShift.id == int(body.get("shift_id") or 0),
                                                   models.VolunteerShift.event_id == v.event_id).first()
        if not s:
            raise HTTPException(status_code=404, detail="Shift not found")
        check_can_hold(db, s, v)
        b = models.VolunteerBooking(event_id=v.event_id, shift_id=s.id, volunteer_id=v.id, status="requested",
                                    created_by="volunteer", created_at=_now(), updated_at=_now())
        db.add(b)
        db.flush()
        log(db, v.event_id, "volunteer: %s" % full_name(v), "requested", volunteer_id=v.id, shift_id=s.id, booking_id=b.id,
            after={"status": "requested", "shift": "%s %s %s" % (s.day, s.start_time, s.role)})
        db.commit()
        return {"ok": True, "booking_id": b.id, "status": "requested"}

    @app.post("/volunteer/{token}/cancel")
    def portal_cancel(token: str, body: dict, request: Request, db: Session = Depends(get_db)):
        """A volunteer cancels one of THEIR OWN shifts (requested or confirmed)."""
        throttle(request, "act")
        _write_lock(db)
        v = by_token(db, token)
        b = db.query(models.VolunteerBooking).filter(models.VolunteerBooking.id == int(body.get("booking_id") or 0),
                                                     models.VolunteerBooking.volunteer_id == v.id).first()
        if not b or b.status not in ACTIVE:
            raise HTTPException(status_code=404, detail="Nothing to cancel")
        before = b.status
        b.status, b.updated_at = "cancelled", _now()
        log(db, v.event_id, "volunteer: %s" % full_name(v), "cancelled", volunteer_id=v.id, shift_id=b.shift_id,
            booking_id=b.id, before={"status": before}, after={"status": "cancelled"})
        db.commit()
        return {"ok": True}

    # ── JOIN THE TEAM (general link) ────────────────────────────────────────
    def join_program(db, join_token):
        if not join_token or not TOKEN_RE.match(join_token):
            raise HTTPException(status_code=404, detail="This sign-up link is not valid.")
        p = db.query(models.VolunteerProgram).filter(models.VolunteerProgram.join_token == join_token).first()
        if not p:
            raise HTTPException(status_code=404, detail="This sign-up link is not valid.")
        return p

    @app.get("/volunteer-join/{join_token}")
    def join_info(join_token: str, request: Request, db: Session = Depends(get_db)):
        """Registration for NEW volunteers (open or closed by an admin)."""
        throttle(request, "join")
        p = join_program(db, join_token)
        ev = db.query(models.Event).filter(models.Event.id == p.event_id).first()
        return {"open": bool(p.join_open), "title": p.title, "intro": p.intro, "event": ev.name if ev else ""}

    @app.get("/volunteer-team/{team_token}")
    def team_info(team_token: str, request: Request, db: Session = Depends(get_db)):
        """The shared team link: the whole schedule (first name + last initial,
        never contact details) and announcements. READ-ONLY: requesting or
        cancelling a shift needs the volunteer's own invitation link."""
        throttle(request, "team")
        if not team_token or not TOKEN_RE.match(team_token):
            raise HTTPException(status_code=404, detail="This team link is not valid.")
        p = db.query(models.VolunteerProgram).filter(models.VolunteerProgram.team_token == team_token).first()
        if not p:
            raise HTTPException(status_code=404, detail="This team link is not valid.")
        ev = db.query(models.Event).filter(models.Event.id == p.event_id).first()
        vols = {x.id: x for x in db.query(models.Volunteer).filter(models.Volunteer.event_id == p.event_id).all()}
        shifts = db.query(models.VolunteerShift).filter(models.VolunteerShift.event_id == p.event_id,
                                                        models.VolunteerShift.active == True).order_by(   # noqa: E712
            models.VolunteerShift.day, models.VolunteerShift.lead_role, models.VolunteerShift.start_time,
            models.VolunteerShift.sort, models.VolunteerShift.id).all()
        bookings = db.query(models.VolunteerBooking).filter(models.VolunteerBooking.event_id == p.event_id).all()
        anns = db.query(models.VolunteerAnnouncement).filter(models.VolunteerAnnouncement.event_id == p.event_id,
                                                             models.VolunteerAnnouncement.active == True).order_by(   # noqa: E712
            models.VolunteerAnnouncement.pinned.desc(), models.VolunteerAnnouncement.id.desc()).all()
        return {"title": p.title, "intro": p.intro, "event": ev.name if ev else "", "expected_per_day": p.expected_per_day,
                "shifts": [shift_view(db, s, bookings, vols) for s in shifts],
                "announcements": [{"id": a.id, "title": a.title, "body": a.body, "pinned": bool(a.pinned),
                                   "created_at": a.created_at} for a in anns]}

    @app.post("/volunteer-join/{join_token}")
    def join_apply(join_token: str, body: dict, request: Request, db: Session = Depends(get_db)):
        if rate_limited("vol:apply:%s" % client_ip(request), limit=10, window=600):
            raise HTTPException(status_code=429, detail="Too many sign-ups from here. Try again later.")
        p = join_program(db, join_token)
        if not p.join_open:
            raise HTTPException(status_code=409, detail="Volunteer sign-up is closed. Contact the volunteer team.")
        first = (body.get("first_name") or "").strip()[:80]
        last = (body.get("last_name") or "").strip()[:80]
        email = (body.get("email") or "").strip().lower()[:160]
        phone = (body.get("phone") or "").strip()[:40]
        if not first or not last:
            raise HTTPException(status_code=400, detail="Please enter your first and last name")
        if not EMAIL_RE.match(email):
            raise HTTPException(status_code=400, detail="Please enter a valid email address")
        if not phone:
            raise HTTPException(status_code=400, detail="Please enter a phone number the team can text")
        existing = db.query(models.Volunteer).filter(models.Volunteer.event_id == p.event_id,
                                                     models.Volunteer.email == email).first()
        if existing:
            # Never hand out somebody's link to whoever types their email.
            if not existing.needs_review:
                existing.needs_review = "Signed up again through the general link; send them their personal link."
                log(db, p.event_id, "join form", "duplicate_signup", volunteer_id=existing.id)
                db.commit()
            return {"ok": True, "duplicate": True,
                    "message": "You are already on the volunteer list. The team will send you your personal link."}
        v = models.Volunteer(event_id=p.event_id, first_name=first, last_name=last, email=email, phone=phone,
                             notes=(body.get("note") or "").strip()[:1000] or None, status="pending",
                             token=new_token(), token_created_at=_now(), source="join_form",
                             created_at=_now(), updated_at=_now())
        db.add(v)
        db.flush()
        log(db, p.event_id, "join form", "applied", volunteer_id=v.id, after={"name": full_name(v)})
        db.commit()
        # No link yet: the team approves new volunteers first, then invites them.
        return {"ok": True, "message": "Thank you for signing up! The volunteer team will review it and send you your personal link."}


def _shift_dict(s):
    return {"day": s.day, "start_time": s.start_time, "end_time": s.end_time, "role": s.role, "location": s.location,
            "capacity": s.capacity, "lead_role": bool(s.lead_role), "active": bool(s.active)}


def _apply_shift(s, body, new):
    for k in ("role", "location", "description"):
        if k in body or new:
            setattr(s, k, (body.get(k) or "").strip() or None)
    if not s.role:
        raise HTTPException(status_code=400, detail="Give the shift a role")
    if "day" in body or new:
        s.day = (body.get("day") or "").strip()
        if not DAY_RE.match(s.day or ""):
            raise HTTPException(status_code=400, detail="Choose a day")
    if "lead_role" in body or new:
        s.lead_role = bool(body.get("lead_role"))
    for k in ("start_time", "end_time"):
        if k in body or new:
            val = (body.get(k) or "").strip()
            if not TIME_RE.match(val):
                raise HTTPException(status_code=400, detail="Times look like 09:00 or 13:30")
            setattr(s, k, val)
    if _mins(s.end_time) <= _mins(s.start_time):
        raise HTTPException(status_code=400, detail="The shift must end after it starts")
    if "capacity" in body or new:
        try:
            s.capacity = int(body.get("capacity") or 0)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Places must be a number")
        if s.capacity < 1 or s.capacity > 200:
            raise HTTPException(status_code=400, detail="Places must be between 1 and 200")
    if "sort" in body:
        s.sort = int(body.get("sort") or 0)
