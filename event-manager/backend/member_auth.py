# -*- coding: utf-8 -*-
"""Profile activation and password sign-in for the EXISTING Gaia identity
(9 Nov 2026).

Badge QR -> 6-digit code -> create password -> signed in. The person is their
member card (and GHL contact) exactly as before; this adds only a password.

Security rules, all enforced here:
  * the public badge code alone never sets a password: it can only (a) send a
    code to the email ALREADY on the profile, or (b) ask for the password of a
    profile that already has one;
  * a code is 6 digits, single use, 10 minutes, 5 tries, at most 5 issued per
    hour per profile; codes are never stored in plain text, never logged and
    never put in a URL;
  * a guest seat stored under the buyer's mailbox ("+seatN") is never emailed
    a code (it would reach the buyer): the help desk issues one instead;
  * a help-desk code is issued only by signed-in door/admin staff, and the
    ticket history records who issued one and when (never the code);
  * passwords: at least 8 characters, bcrypt, 5 wrong tries lock for 15 min.

Every route here except the desk code is service-token only (called by the
proxy, which turns a verified identity into the normal member session).
Nothing here touches tickets, admission, check-in or printing.
"""
import re
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
from database import get_db

MIN_PASSWORD = 8
MAX_FAILS = 5
LOCK_MINUTES = 15
CODES_PER_HOUR = 5
SEAT_TAG = re.compile(r"\+seat\d+@", re.I)
TOKEN_RE = re.compile(r"^[A-Z2-9]{8}$")


def _now():
    return datetime.utcnow()


def mask_email(email):
    e = (email or "").strip()
    if "@" not in e:
        return ""
    local, dom = e.split("@", 1)
    return (local[:1] + "•••@" + dom) if local else ""


def register(app, M):
    """Mount the routes. M is the main module (helpers live there)."""

    def card_for_badge(db, token):
        token = (token or "").strip().upper()
        if not TOKEN_RE.match(token):
            return None
        card = db.query(models.MemberCard).filter(models.MemberCard.public_token == token).first()
        if card is None:
            row = db.query(models.Attendee).filter(func.upper(models.Attendee.public_token) == token).first()
            if row is not None:
                card = M._member_card_for_attendee(db, row, create=True)
                db.commit()
        return card

    def cards_for_email(db, email):
        email = (email or "").strip().lower()
        if not email:
            return []
        return db.query(models.MemberCard).filter(func.lower(models.MemberCard.email) == email).all()

    def cred(db, card):
        return db.query(models.MemberCredential).filter(models.MemberCredential.card_id == card.id).first()

    def own_contact(db, card):
        """The GHL contact id only when it is this person's alone. A guest seat
        (buyer+seatN@) or a household sharing one contact must never sign in as
        that contact: ticket lookup by contact would show them the other
        person's tickets. Then the session carries the profile's own email only."""
        cid = (card.contact_id or "").strip()
        if not cid or SEAT_TAG.search(card.email or ""):
            return ""
        others = db.query(models.MemberCard).filter(models.MemberCard.contact_id == cid,
                                                    models.MemberCard.id != card.id).count()
        if others:
            return ""
        # Tickets on this contact held under a different address = shared contact.
        em = (card.email or "").strip().lower()
        for a in db.query(models.Attendee).all():
            acid = str((a.custom_data or {}).get("contact_id") or getattr(a, "acq_contact_id", None) or "").strip()
            if acid == cid and (a.email or "").strip().lower() not in ("", em):
                return ""
        return cid

    def identity(card, db=None):
        cid = own_contact(db, card) if db is not None else ""
        return {"contact_id": cid, "email": (card.email or "").strip().lower(),
                "name": card.name or "", "card_token": card.public_token,
                "ghl_lookup": bool(cid) or not SEAT_TAG.search(card.email or "")}

    def first_name(card):
        return ((card.name or "").strip().split(" ") or [""])[0]

    def can_email(card):
        e = (card.email or "").strip()
        return bool(e and "@" in e and not SEAT_TAG.search(e))

    def too_many_codes(db, card, purposes):
        n = db.query(models.CardVerification).filter(
            models.CardVerification.card_id == card.id,
            models.CardVerification.purpose.in_(purposes),
            models.CardVerification.created_at >= _now() - timedelta(hours=1)).count()
        return n >= CODES_PER_HOUR

    def check_password_rules(pw):
        if len(pw or "") < MIN_PASSWORD:
            raise HTTPException(status_code=400, detail="Please use at least %d characters." % MIN_PASSWORD)
        if len(pw) > 200:
            raise HTTPException(status_code=400, detail="That password is too long.")

    def set_password(db, card, pw, via):
        c = cred(db, card)
        if c is None:
            c = models.MemberCredential(card_id=card.id)
            db.add(c)
        c.password_hash = M.get_password_hash(pw)
        c.set_at, c.set_via, c.failed_count, c.locked_until = _now(), via, 0, None
        if not card.card_claimed_at:
            card.card_claimed_at = _now()

    def try_password(db, card, pw):
        """(ok, reason). Counts failures and locks after MAX_FAILS."""
        c = cred(db, card)
        if c is None or not c.password_hash:
            return False, "no_password"
        if c.locked_until and _now() < c.locked_until:
            return False, "locked"
        if M.verify_password(pw or "", c.password_hash):
            c.failed_count, c.locked_until, c.last_login_at = 0, None, _now()
            return True, ""
        c.failed_count = (c.failed_count or 0) + 1
        if c.failed_count >= MAX_FAILS:
            c.locked_until, c.failed_count = _now() + timedelta(minutes=LOCK_MINUTES), 0
        return False, "wrong_password"

    svc = Depends(M.require_service_token)

    # ── badge scan -> activation ────────────────────────────────────────────
    @app.post("/identity/activate/start")
    def activate_start(body: dict, db: Session = Depends(get_db), _: bool = svc):
        """What the badge page should offer. Sends nothing by itself unless the
        profile has no password yet and its own email can receive a code; the
        plain code is returned only to the proxy (service channel) to deliver."""
        card = card_for_badge(db, body.get("token"))
        if card is None:
            return {"ok": False, "reason": "unknown_badge"}
        # A profile email entered at the Bio-Well station and not yet confirmed:
        # the code goes THERE, and confirming it is what makes it the profile's.
        import biowell
        req = biowell.pending_request(db, card)
        pending = req if (req and req.contact_id_new) else None
        target = pending.email_new if pending else card.email
        out = {"ok": True, "first_name": first_name(card), "has_password": cred(db, card) is not None,
               "email_masked": mask_email(target) if (pending or can_email(card)) else "",
               "desk_only": not (pending or can_email(card))}
        if out["has_password"] or out["desk_only"] or not body.get("send_code"):
            db.commit()
            return out
        if too_many_codes(db, card, ("activate",)):
            return dict(out, ok=False, reason="too_many_codes")
        _row, code = M._issue_otp(db, card, "activate", "email", out["email_masked"],
                                  pending_value=("email_request:%d" % pending.id) if pending else None)
        db.commit()
        deliver = ({"contact_id": pending.contact_id_new, "email": pending.email_new, "name": card.name or "",
                    "card_token": card.public_token, "ghl_lookup": False} if pending else identity(card, db))
        return dict(out, code=code, deliver_to=deliver)

    @app.post("/identity/activate/verify")
    def activate_verify(body: dict, db: Session = Depends(get_db), _: bool = svc):
        """Check an email code or a help-desk code; returns a 15-minute permit."""
        card = card_for_badge(db, body.get("token"))
        if card is None:
            return {"ok": False, "reason": "unknown_badge"}
        code = body.get("code")
        ok, reason, _row = M._check_otp(db, card, "activate", code)
        if ok and _row is not None and str(_row.pending_value or "").startswith("email_request:"):
            # The code went to a station-entered address: entering it proves it.
            import biowell
            req = db.query(models.CardEmailRequest).filter(
                models.CardEmailRequest.id == int(str(_row.pending_value).split(":")[1])).first()
            if req is not None and not biowell.apply_request(db, req, card, "activation_code"):
                db.commit()
                return {"ok": False, "reason": "verification_expired"}
        if not ok:
            ok2, reason2, _r2 = M._check_otp(db, card, "desk", code)
            if ok2:
                ok, reason = True, ""
            elif reason == "no_code_outstanding":
                reason = reason2
        if not ok:
            db.commit()
            return {"ok": False, "reason": reason}
        permit = M._mint_verification_session(db, card)
        db.commit()
        return {"ok": True, "permit": permit}

    @app.post("/identity/activate/complete")
    def activate_complete(body: dict, db: Session = Depends(get_db), _: bool = svc):
        """Permit + password -> saved; returns the identity for the session."""
        card = card_for_badge(db, body.get("token"))
        if card is None:
            return {"ok": False, "reason": "unknown_badge"}
        if not M._verification_session_valid(db, card, body.get("permit")):
            return {"ok": False, "reason": "verification_expired"}
        check_password_rules(body.get("password") or "")
        set_password(db, card, body.get("password"), body.get("via") or "email_code")
        import hashlib
        h = hashlib.sha256(str(body.get("permit")).encode()).hexdigest()
        for p in db.query(models.CardVerificationSession).filter(models.CardVerificationSession.card_id == card.id,
                                                                models.CardVerificationSession.token_hash == h).all():
            p.revoked_at = _now()
        db.commit()
        return {"ok": True, "identity": identity(card, db)}

    @app.post("/identity/activate/login")
    def activate_login(body: dict, db: Session = Depends(get_db), _: bool = svc):
        """Returning person on the badge page: password only."""
        card = card_for_badge(db, body.get("token"))
        if card is None:
            return {"ok": False, "reason": "unknown_badge"}
        ok, reason = try_password(db, card, body.get("password"))
        db.commit()
        return {"ok": True, "identity": identity(card, db)} if ok else {"ok": False, "reason": reason}

    # ── email + password sign-in, forgotten password ───────────────────────
    @app.post("/identity/password/login")
    def password_login(body: dict, db: Session = Depends(get_db), _: bool = svc):
        cards = [c for c in cards_for_email(db, body.get("email")) if cred(db, c) is not None]
        for card in cards:
            ok, reason = try_password(db, card, body.get("password"))
            if ok:
                db.commit()
                return {"ok": True, "identity": identity(card, db)}
        db.commit()
        return {"ok": False, "reason": "wrong_email_or_password"}

    @app.post("/identity/password/forgot")
    def password_forgot(body: dict, db: Session = Depends(get_db), _: bool = svc):
        """Code to the email on the profile. The caller always tells the person
        the same thing, whether or not the address is known."""
        for card in cards_for_email(db, body.get("email")):
            if can_email(card) and not too_many_codes(db, card, ("reset",)):
                _row, code = M._issue_otp(db, card, "reset", "email", mask_email(card.email))
                db.commit()
                return {"ok": True, "code": code, "deliver_to": identity(card, db)}
        return {"ok": True}

    @app.post("/identity/password/reset")
    def password_reset(body: dict, db: Session = Depends(get_db), _: bool = svc):
        check_password_rules(body.get("password") or "")
        for card in cards_for_email(db, body.get("email")):
            ok, reason, _row = M._check_otp(db, card, "reset", body.get("code"))
            if ok:
                set_password(db, card, body.get("password"), "reset")
                db.commit()
                return {"ok": True, "identity": identity(card, db)}
        db.commit()
        return {"ok": False, "reason": "code_incorrect"}

    # ── help desk ───────────────────────────────────────────────────────────
    @app.post("/events/{event_id}/attendees/{attendee_id}/activation-code")
    def desk_activation_code(event_id: int, attendee_id: int, request: Request, db: Session = Depends(get_db),
                             current_user=Depends(M.get_current_user)):
        """Signed-in desk staff, having checked the person, read out a code.
        Recorded on the ticket: who and when, never the code itself."""
        import authz
        authz.require_cap(db, current_user, event_id, "checkin.perform")
        att = db.query(models.Attendee).filter(models.Attendee.id == attendee_id,
                                               models.Attendee.event_id == event_id).first()
        if att is None:
            raise HTTPException(status_code=404, detail="Ticket not found")
        card = M._member_card_for_attendee(db, att, create=True)
        if card is None:
            raise HTTPException(status_code=409, detail="This ticket has no profile yet")
        if too_many_codes(db, card, ("desk",)):
            raise HTTPException(status_code=429, detail="Too many codes for this person in the last hour")
        _row, code = M._issue_otp(db, card, "desk", "desk", "help desk")
        M._lifecycle_append(att, "activation_code_issued", actor=(getattr(current_user, "email", None) or "staff"),
                            reason="Help-desk activation code (identity checked at the desk)")
        db.commit()
        return {"ok": True, "code": code, "minutes": 10, "first_name": first_name(card),
                "has_password": cred(db, card) is not None}
