# -*- coding: utf-8 -*-
"""Bio-Well station and dashboard (10 Nov 2026).

What the station does, using only what already exists:

  ticket QR / badge  ->  the person (the ticket's PROFILE card, as everywhere)
  their email        ->  shown; corrected as a PENDING profile email that takes
                         effect only when the person enters the code sent there
                         (at the station, or when they activate on their phone)
  their profile      ->  the existing activation (badge -> code -> password)
  their results      ->  the existing consent code ("Get my code" in their
                         profile) that their practitioner redeems at Gaia
                         Practitioners; readings stay with the partner

Rules kept here:
  * the ticket itself is never edited: not its email, holder, buyer, payment
    or pass. Only the person's profile email/GHL contact changes, and only
    after the person proves the address;
  * an address that another profile already uses is refused: different people
    are never merged;
  * a new address becomes a NEW identity: readings linked to the old one do not
    follow (the person links again with a new consent code);
  * nothing about results is stored or shown here -- only whether a consent
    code was requested and whether a link exists, read from the proxy's link
    store (no customer ids, no practitioner, no readings);
  * a GHL contact is created for a new address only when the server allows it
    (BIOWELL_CREATE_CONTACTS=1): creating contacts can start GHL workflows.
"""
import html as _html
import json
import os
import re
import secrets
import urllib.error
import urllib.request
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

import authz
import badge_card
import main as M
import models

router = APIRouter()

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
SEAT_TAG = re.compile(r"\+seat\d+@", re.I)
LINK_FILE = os.environ.get("BIOWELL_LINK_FILE") or "/root/gaia-staging-proxy/data/member-links.json"
PROXY_ENV = os.environ.get("BIOWELL_PROXY_ENV") or "/root/gaia-staging-proxy/.env"
ENSURE_URL = os.environ.get("BIOWELL_ENSURE_CONTACT_URL", "http://127.0.0.1:8787/api/event/ensure-contact")
NOTIFY_URL = os.environ.get("GAIA_NOTIFY_URL", "http://127.0.0.1:8787/api/event/notify")
REQUEST_TTL_HOURS = 24
CARD_BASE = (os.environ.get("CARD_PUBLIC_BASE") or "https://card.gaiahealers.app").rstrip("/")


def _now():
    return datetime.utcnow()


def _iso(v):
    return v.isoformat() + "Z" if isinstance(v, datetime) else v


def _who(u):
    return getattr(u, "full_name", None) or getattr(u, "email", None) or "staff"


def norm_email(e):
    return (e or "").strip().lower()


def mask(e):
    import member_auth
    return member_auth.mask_email(e)


# ---------------------------------------------------------------------------
# Outside world: the proxy's link store (read-only), GHL contacts, email.
# BIOWELL_FAKE=<dir> (staging/tests): no network; sends land in <dir>/outbox.jsonl
# ---------------------------------------------------------------------------
def _fake():
    return os.environ.get("BIOWELL_FAKE")


def _fake_cfg():
    try:
        return json.load(open(os.path.join(_fake(), "fake.json")))
    except Exception:
        return {}


def link_state(contact_id):
    """Only: is there a confirmed link, is a consent code waiting. Never the
    customer, the practitioner or any reading."""
    cid = (contact_id or "").strip()
    out = {"linked": False, "code_active": False, "ever_code": False}
    if not cid:
        return out
    try:
        d = json.load(open(LINK_FILE))
    except Exception:
        out["unavailable"] = True
        return out
    link = (d.get("links") or {}).get(cid) or {}
    out["linked"] = link.get("status") == "confirmed"
    now_ms = datetime.utcnow().timestamp() * 1000
    out["code_active"] = any(r.get("memberId") == cid and (r.get("exp") or 0) > now_ms for r in (d.get("codes") or {}).values())
    out["ever_code"] = out["code_active"] or any(a.get("memberId") == cid and a.get("event") == "consent_code_issued"
                                                 for a in (d.get("audit") or []))
    return out


def link_store_summary():
    try:
        d = json.load(open(LINK_FILE))
    except Exception:
        return {"available": False}
    audit = d.get("audit") or []
    last = lambda ev: max([a.get("at") or "" for a in audit if a.get("event") == ev] or [""]) or None  # noqa: E731
    links = d.get("links") or {}
    return {"available": True, "links_confirmed": sum(1 for v in links.values() if v.get("status") == "confirmed"),
            "links_revoked": sum(1 for v in links.values() if v.get("status") == "revoked"),
            "codes_issued_total": sum(1 for a in audit if a.get("event") == "consent_code_issued"),
            "last_code_issued": last("consent_code_issued"), "last_link_confirmed": last("link_confirmed"),
            "last_reading_opened": last("reading_opened"),
            "last_partner_check": max([v.get("latest_checked_at") or "" for v in links.values()] or [""]) or None}


def partner_config():
    """Which Gaia Practitioners environment the proxy uses (names, hosts; never a secret)."""
    try:
        from dotenv import dotenv_values
        env = dict(dotenv_values(PROXY_ENV))
    except Exception:
        env = {}
    from urllib.parse import urlparse
    base = env.get("GAIA_PRACTITIONERS_OAUTH_BASE") or ""
    named = (env.get("GAIA_PRACTITIONERS_ENV") or "").lower()
    host = urlparse(base).netloc
    envname = named or ("staging" if host.startswith("staging.") else "production" if host else "unknown")
    allow = [x for x in (env.get("GAIA_MEMBER_READINGS_MEMBERS") or "").split(",") if x.strip()]
    enabled = env.get("GAIA_MEMBER_READINGS_ENABLED") == "true"
    return {"environment": envname, "host": host or None, "readings_enabled": enabled,
            "readings_limited_to_test_members": bool(allow), "test_members": len(allow),
            # Attendees can share results only when the readings are open to
            # everyone AND come from the partner's production system.
            "results_available": enabled and not allow and envname == "production",
            "connected": bool(env.get("GAIA_PRACTITIONERS_ENABLED") in ("true", "1") or base)}


def _ghl_lookup(email):
    """('found', contact_id) | ('none', None) | ('several', None) | ('dnd', None) | ('error', None)."""
    if _fake():
        f = _fake_cfg()
        if email in f.get("several", []):
            return "several", None
        if email in f.get("dnd", []):
            return "dnd", None
        if email in f.get("lookup_error", []):
            return "error", None
        if email in f.get("existing", {}):
            return "found", f["existing"][email]
        return "none", None
    import volunteer_invites as V
    cfg = V._cfg()
    try:
        import urllib.parse
        data = V._ghl("/contacts/?locationId=%s&query=%s&limit=10" % (cfg.get("GHL_LOCATION_ID", ""), urllib.parse.quote(email)))
    except Exception:
        return "error", None
    exact = [c for c in data.get("contacts", []) if norm_email(c.get("email")) == email]
    if not exact:
        return "none", None
    if len(exact) > 1:
        return "several", None
    c = exact[0]
    if c.get("dnd") or ((c.get("dndSettings") or {}).get("Email") or {}).get("status") == "active":
        return "dnd", None
    return "found", c.get("id")


def _ghl_create(email, first, last, source="Gaia Healers event - Bio-Well station", allow=False):
    """allow=True: a caller that has its own explicit authorisation (an admin
    creating a stand's contact) -- not governed by the station's switch."""
    if not allow and os.environ.get("BIOWELL_CREATE_CONTACTS") != "1":
        return None, "contact_creation_off"
    if _fake():
        if email in _fake_cfg().get("create_fail", []):
            return None, "ghl_error"
        cid = "fake-new-" + secrets.token_hex(5)
        _fake_log({"kind": "contact_created", "email": email, "contact_id": cid, "source": source})
        return cid, None
    token = os.environ.get("IDENTITY_SERVICE_TOKEN") or ""
    req = urllib.request.Request(ENSURE_URL, data=json.dumps({"email": email, "firstName": first, "lastName": last, "source": source}).encode(),
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            d = json.load(r)
        return (d.get("contactId") or None), (None if d.get("contactId") else d.get("reason") or "ghl_error")
    except Exception as e:
        return None, "proxy_unreachable:%s" % type(e).__name__


def _send_code(contact_id, email, first, code):
    subject = "Your Gaia Healers code"
    body = ("<p>Hello %s,</p><p>Your Gaia Healers code is:</p><p style=\"font-size:28px;font-weight:bold;letter-spacing:4px\">%s</p>"
            "<p>Enter it at the Bio-Well station or on your phone to confirm this is your email. It works once, for 10 minutes.</p>"
            "<p>If you did not ask for it, you can ignore this email.</p><p>Gaia Healers</p>") % (_html.escape(first or "there"), code)
    if _fake():
        _fake_log({"kind": "code_email", "to": email, "contact_id": contact_id, "code": code, "subject": subject})
        return True, None
    token = os.environ.get("IDENTITY_SERVICE_TOKEN") or ""
    req = urllib.request.Request(NOTIFY_URL, data=json.dumps({"contactId": contact_id, "subject": subject, "html": body}).encode(),
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=35) as r:
            d = json.load(r)
        return bool(d.get("ok")), (None if d.get("ok") else d.get("reason") or "send_failed")
    except urllib.error.HTTPError as e:
        return False, "send_failed:%d" % e.code
    except Exception as e:
        return False, "send_failed:%s" % type(e).__name__


def _fake_log(rec):
    with open(os.path.join(_fake(), "outbox.jsonl"), "a") as f:
        f.write(json.dumps(dict(rec, at=_iso(_now()))) + "\n")


# ---------------------------------------------------------------------------
# Profile email changes (shared with member_auth: activation uses them too)
# ---------------------------------------------------------------------------
def pending_request(db, card):
    if card is None:
        return None
    r = db.query(models.CardEmailRequest).filter(models.CardEmailRequest.card_id == card.id,
                                                 models.CardEmailRequest.status == "pending").order_by(
        models.CardEmailRequest.id.desc()).first()
    if r and r.expires_at and _now() > r.expires_at:
        r.status = "expired"
        db.flush()
        return None
    return r


def apply_request(db, req, card, via):
    """The person entered the code sent to the new address: the profile now
    uses it. Same card, same badge; the ticket is untouched."""
    if req.status != "pending":
        return False
    # Someone else may have taken the address meanwhile: never merge.
    other = db.query(models.MemberCard).filter(func.lower(models.MemberCard.email) == req.email_new,
                                               models.MemberCard.id != card.id).first()
    if other is not None:
        req.status, req.note = "cancelled", "Another profile uses this address now; not applied."
        db.flush()
        return False
    card.email = req.email_new
    card.contact_id = req.contact_id_new or None
    req.status, req.verified_at, req.verified_via = "verified", _now(), via
    for s in db.query(models.BiowellSession).filter(models.BiowellSession.email_request_id == req.id).all():
        s.email_status, s.updated_at = "verified", _now()
    att = db.query(models.Attendee).filter(models.Attendee.id == req.attendee_id).first() if req.attendee_id else None
    if att is not None:
        M._lifecycle_append(att, "profile_email_verified", actor=req.requested_by_name or "station",
                            reason="Profile email confirmed by the person (code via %s); the ticket's own email is unchanged" % via)
    db.flush()
    return True


def can_receive_code(card, req):
    return bool(req and req.contact_id_new)


# ---------------------------------------------------------------------------
# Station views
# ---------------------------------------------------------------------------
def _need(db, user, event_id, cap):
    M._get_event_or_404(event_id, db)
    authz.require_cap(db, user, event_id, cap)


def _person(db, event_id, att):
    import member_auth  # noqa: F401  (rules for 'own contact')
    card = M._member_card_for_attendee(db, att, create=True)
    db.flush()
    cd = att.custom_data or {}
    guest = bool(SEAT_TAG.search(att.email or "")) or att.registration_source in M.PARTY_SEAT_SOURCES
    buyer = None
    if cd.get("bought_by_attendee"):
        b = db.query(models.Attendee).filter(models.Attendee.id == int(cd["bought_by_attendee"])).first()
        if b is not None:
            buyer = ("%s %s" % (b.first_name or "", b.last_name or "")).strip()
    own = _own_contact(db, card)
    req = pending_request(db, card)
    activated = db.query(models.MemberCredential).filter(models.MemberCredential.card_id == card.id).first() is not None
    email = norm_email(card.email)
    usable = bool(email and EMAIL_RE.match(email) and not SEAT_TAG.search(email) and own)
    ls = link_state(own) if own else {"linked": False, "code_active": False, "ever_code": False}
    tt = db.query(models.TicketType).filter(models.TicketType.id == att.ticket_type_id).first()
    sessions = db.query(models.BiowellSession).filter(models.BiowellSession.attendee_id == att.id).order_by(models.BiowellSession.id.desc()).limit(5).all()
    return card, {
        "ticket_id": att.id, "name": ("%s %s" % (att.first_name or "", att.last_name or "")).strip(),
        "pass": M._pass_display(db, att) or (tt.name if tt else None), "ticket_status": M._ticket_status(att),
        "checked_in": bool(att.is_checked_in), "guest_of": buyer if guest else None, "is_guest": guest,
        "profile_email": email or None, "profile_email_usable": usable,
        "shared_contact": bool(card.contact_id) and not own,
        "email_problem": (None if usable else
                          "Guest ticket: the email is the buyer's. Enter the guest's own email." if (guest or SEAT_TAG.search(email or "")) else
                          "This email is shared with someone else's profile. Enter this person's own email." if (card.contact_id and not own) else
                          "No email on the profile. Enter the person's email." if not email else
                          "The profile email cannot be used yet. Enter or confirm the person's email."),
        "pending_email": {"email": req.email_new, "since": _iso(req.created_at), "can_send": can_receive_code(card, req)} if req else None,
        "profile_activated": activated, "profile_url": "%s/%s" % (CARD_BASE, card.public_token) if card.public_token else None,
        "results_link": "linked" if ls["linked"] else ("code_waiting" if ls["code_active"] else "not_linked"),
        "link_store_unavailable": bool(ls.get("unavailable")),
        "results_available": partner_config()["results_available"],
        "recent_sessions": [{"session_id": s.session_uid, "at": _iso(s.created_at), "station": s.station, "status": s.status} for s in sessions],
    }


def _own_contact(db, card):
    """Same rule as sign-in (member_auth.own_contact): the GHL contact counts
    only when it is this person's alone."""
    cid = (card.contact_id or "").strip()
    if not cid or SEAT_TAG.search(card.email or ""):
        return ""
    if db.query(models.MemberCard).filter(models.MemberCard.contact_id == cid, models.MemberCard.id != card.id).count():
        return ""
    em = norm_email(card.email)
    for a in db.query(models.Attendee).filter(models.Attendee.acq_contact_id == cid).all():
        if norm_email(a.email) not in ("", em):
            return ""
    for a in db.query(models.Attendee).filter(func.json_extract(models.Attendee.custom_data, "$.contact_id") == cid).all():
        if norm_email(a.email) not in ("", em):
            return ""
    return cid


def _session_view(db, s):
    att = db.query(models.Attendee).filter(models.Attendee.id == s.attendee_id).first()
    card, p = _person(db, s.event_id, att)
    s.profile_status = "activated" if p["profile_activated"] else "not_activated"
    s.consent_status = {"linked": "linked", "code_waiting": "code_issued"}.get(p["results_link"], s.consent_status or "none")
    if p["pending_email"]:
        s.email_status = "pending"
    elif p["profile_email_usable"] and s.email_status not in ("verified",):
        s.email_status = "ok"
    s.updated_at = _now()
    db.commit()
    return {"session_id": s.session_uid, "station": s.station, "staff": s.staff_name, "status": s.status, "created_at": _iso(s.created_at),
            "email_status": s.email_status, "profile_status": s.profile_status, "consent_status": s.consent_status,
            "error": s.error, "person": p,
            "next_step": _next_step(p, s)}


def _next_step(p, s):
    if p["ticket_status"] in ("refunded", "revoked", "cancelled"):
        return "This ticket is not valid. Send the person to the help desk."
    if p["pending_email"]:
        return "Ask the person for the 6-digit code we emailed to %s (or they enter it on their phone when they activate)." % p["pending_email"]["email"]
    if not p["profile_email_usable"]:
        return p["email_problem"]
    if not p["profile_activated"]:
        return "Let them scan the QR on this screen with their phone, tap 'Activate', enter the code from their email and choose a password."
    if not p.get("results_available"):
        return ("Done for now: their email and profile are ready. Sharing Bio-Well results opens when the "
                "practitioner connection goes live; nothing else to do today.")
    if p["results_link"] == "not_linked":
        return "On their phone: My profile → Your Bio-Well readings → 'Get my code', then give the code to the practitioner."
    if p["results_link"] == "code_waiting":
        return "Their code is waiting: the practitioner enters it in Gaia Practitioners."
    return "Linked. New readings appear in their profile when the practitioner publishes them."


# ---------------------------------------------------------------------------
# Routes: station (biowell.station)
# ---------------------------------------------------------------------------
P = "/events/{event_id}/biowell"


@router.post(P + "/lookup")
def bw_lookup(event_id: int, body: dict, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    """Ticket QR (ATT-...) or badge QR/code -> this event's ticket and person."""
    _need(db, current_user, event_id, "biowell.station")
    att, parsed = M._attendee_from_scan(db, body.get("code") or "", event_id)
    if not parsed:
        raise HTTPException(status_code=400, detail="That is not a Gaia Healers ticket or badge code.")
    if att is None:
        raise HTTPException(status_code=404, detail="No ticket for this event matches that code.")
    card, p = _person(db, event_id, att)
    db.commit()
    return p


@router.post(P + "/sessions")
def bw_start(event_id: int, body: dict, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    """Start (or, for the same tap, return) a station session. A double submit
    with the same client key returns the first session."""
    _need(db, current_user, event_id, "biowell.station")
    key = (body.get("client_key") or "").strip()[:80]
    if not key:
        raise HTTPException(status_code=400, detail="client_key required")
    s = db.query(models.BiowellSession).filter(models.BiowellSession.client_key == key).first()
    if s is not None:
        if s.event_id != event_id:
            raise HTTPException(status_code=409, detail="That key belongs to another event")
        return _session_view(db, s)
    att = db.query(models.Attendee).filter(models.Attendee.id == int(body.get("ticket_id") or 0),
                                           models.Attendee.event_id == event_id).first()
    if att is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if M._ticket_status(att) in ("refunded", "revoked", "cancelled"):
        raise HTTPException(status_code=409, detail="This ticket is not valid. Send the person to the help desk.")
    card = M._member_card_for_attendee(db, att, create=True)
    s = models.BiowellSession(session_uid="BW-" + secrets.token_hex(6).upper(), client_key=key, event_id=event_id,
                              attendee_id=att.id, card_id=card.id, station=(body.get("station") or "Bio-Well station")[:60],
                              staff_user_id=current_user.id, staff_name=_who(current_user), status="open",
                              email_status="needs_email", consent_status="none", created_at=_now(), updated_at=_now())
    db.add(s)
    try:
        db.commit()
    except Exception:
        db.rollback()          # a concurrent double submit won the unique key: return that one
        s = db.query(models.BiowellSession).filter(models.BiowellSession.client_key == key).first()
    M._lifecycle_append(att, "biowell_station_visit", actor=_who(current_user), reason="Bio-Well station session %s" % s.session_uid)
    db.commit()
    return _session_view(db, s)


def _session(db, event_id, uid):
    s = db.query(models.BiowellSession).filter(models.BiowellSession.session_uid == uid, models.BiowellSession.event_id == event_id).first()
    if s is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return s


@router.get(P + "/sessions/{uid}")
def bw_session(event_id: int, uid: str, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, "biowell.station")
    return _session_view(db, _session(db, event_id, uid))


@router.post(P + "/sessions/{uid}/email")
def bw_email(event_id: int, uid: str, body: dict, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    """Enter or correct the person's own email. Saved as PENDING on the profile
    (never on the ticket) and a code is emailed there; nothing changes until
    the person enters it."""
    _need(db, current_user, event_id, "biowell.station")
    s = _session(db, event_id, uid)
    att = db.query(models.Attendee).filter(models.Attendee.id == s.attendee_id).first()
    card = db.query(models.MemberCard).filter(models.MemberCard.id == s.card_id).first()
    email = norm_email(body.get("email"))
    if not EMAIL_RE.match(email) or len(email) > 254:
        raise HTTPException(status_code=400, detail="That does not look like an email address. Check the spelling.")
    if SEAT_TAG.search(email):
        raise HTTPException(status_code=400, detail="That is a guest-seat address of the buyer. Enter the person's own email.")
    if email == norm_email(card.email) and _own_contact(db, card):
        s.email_status, s.updated_at = "ok", _now()
        db.commit()
        return dict(_session_view(db, s), message="That is already this person's profile email.")
    other = db.query(models.MemberCard).filter(func.lower(models.MemberCard.email) == email, models.MemberCard.id != card.id).first()
    if other is None:
        # Someone else's TICKET may carry the address even before they have a profile.
        for t in db.query(models.Attendee).filter(func.lower(models.Attendee.email) == email).all():
            tc = M._find_member_card(db, contact_id=M._attendee_person(t)[0], email=email, name=M._attendee_person(t)[2], token=t.public_token)
            if tc is None or tc.id != card.id:
                other = tc or t
                break
    if other is not None:
        s.error = "email_used_by_another_profile"
        db.commit()
        raise HTTPException(status_code=409, detail="This email already belongs to another person's profile. Each person needs their own "
                                                    "email for their own results. Ask for a different address, or send them to the help desk.")
    status, cid = _ghl_lookup(email)
    created = False
    if status == "several":
        raise HTTPException(status_code=409, detail="Several CRM contacts use this email. Send the person to the help desk.")
    if status == "dnd":
        raise HTTPException(status_code=409, detail="This email has asked not to receive emails from us, so no code can be sent. "
                                                    "Use another address or the help desk.")
    if status == "error":
        s.error = "ghl_unreachable"
        db.commit()
        raise HTTPException(status_code=503, detail="The CRM could not be reached. Try again in a minute.")
    if cid:
        # A contact that already holds another person's ticket is not this person's.
        if db.query(models.MemberCard).filter(models.MemberCard.contact_id == cid, models.MemberCard.id != card.id).first():
            raise HTTPException(status_code=409, detail="This email's CRM contact belongs to another person's profile. "
                                                        "Use a different address or the help desk.")
    else:
        cid, why = _ghl_create(email, att.first_name or "", att.last_name or "")
        if not cid:
            s.error = why
            db.commit()
            raise HTTPException(status_code=409, detail=(
                "This email is new to Gaia Healers and new contacts are not being created from the station yet. "
                "Ask for an email they already use with Gaia Healers, or note it for the team." if why == "contact_creation_off"
                else "The email could not be prepared (%s). Try again." % why))
        created = True
    for old in db.query(models.CardEmailRequest).filter(models.CardEmailRequest.card_id == card.id,
                                                        models.CardEmailRequest.status == "pending").all():
        old.status = "superseded"
    req = models.CardEmailRequest(event_id=event_id, card_id=card.id, attendee_id=att.id, email_old=norm_email(card.email) or None,
                                  email_new=email, contact_id_old=card.contact_id, contact_id_new=cid, contact_created=created,
                                  source="biowell_station", status="pending", requested_by=current_user.id,
                                  requested_by_name=_who(current_user), created_at=_now(),
                                  expires_at=_now() + timedelta(hours=REQUEST_TTL_HOURS))
    db.add(req)
    db.flush()
    s.email_request_id, s.email_status, s.error, s.updated_at = req.id, "pending", None, _now()
    M._lifecycle_append(att, "profile_email_requested", actor=_who(current_user),
                        reason="Bio-Well station: profile email to confirm (%s); the ticket's own email is unchanged" % mask(email))
    db.commit()
    sent, why = _issue_and_send(db, card, req, att)
    out = _session_view(db, s)
    out["code_sent"] = sent
    if not sent:
        out["message"] = "The code email could not be sent (%s). Use 'Send the code again'." % why
    return out


def _issue_and_send(db, card, req, att):
    _row, code = M._issue_otp(db, card, "station_email", "email", mask(req.email_new), pending_value=str(req.id))
    db.commit()
    return _send_code(req.contact_id_new, req.email_new, att.first_name if att else "", code)


@router.post(P + "/sessions/{uid}/resend")
def bw_resend(event_id: int, uid: str, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, "biowell.station")
    s = _session(db, event_id, uid)
    card = db.query(models.MemberCard).filter(models.MemberCard.id == s.card_id).first()
    req = pending_request(db, card)
    if req is None:
        raise HTTPException(status_code=409, detail="No email is waiting to be confirmed.")
    import member_auth
    n = db.query(models.CardVerification).filter(models.CardVerification.card_id == card.id,
                                                 models.CardVerification.purpose == "station_email",
                                                 models.CardVerification.created_at >= _now() - timedelta(hours=1)).count()
    if n >= member_auth.CODES_PER_HOUR:
        raise HTTPException(status_code=429, detail="Too many codes for this person in the last hour. Use the help desk.")
    att = db.query(models.Attendee).filter(models.Attendee.id == s.attendee_id).first()
    sent, why = _issue_and_send(db, card, req, att)
    if not sent:
        raise HTTPException(status_code=502, detail="The code email could not be sent (%s)." % why)
    return dict(_session_view(db, s), code_sent=True)


@router.post(P + "/sessions/{uid}/verify")
def bw_verify(event_id: int, uid: str, body: dict, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    """The person reads out the code from their inbox: the address is theirs."""
    _need(db, current_user, event_id, "biowell.station")
    s = _session(db, event_id, uid)
    card = db.query(models.MemberCard).filter(models.MemberCard.id == s.card_id).first()
    req = pending_request(db, card)
    if req is None:
        raise HTTPException(status_code=409, detail="No email is waiting to be confirmed.")
    ok, reason, row = M._check_otp(db, card, "station_email", body.get("code"))
    if not ok:
        db.commit()
        msg = {"code_incorrect": "That code is not right. Check it and try again.", "code_expired": "That code has expired. Send a new one.",
               "too_many_attempts": "Too many tries. Send a new code.", "no_code_outstanding": "Send a code first."}.get(reason, reason)
        raise HTTPException(status_code=400, detail=msg)
    if row is not None and str(row.pending_value or "") != str(req.id):
        db.commit()
        raise HTTPException(status_code=409, detail="That code was for an earlier address. Send a new one.")
    if not apply_request(db, req, card, "station_code"):
        db.commit()
        raise HTTPException(status_code=409, detail=req.note or "The email could not be applied.")
    db.commit()
    return dict(_session_view(db, s), message="Email confirmed. The profile now uses %s." % req.email_new)


@router.post(P + "/sessions/{uid}/cancel-email")
def bw_cancel_email(event_id: int, uid: str, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, "biowell.station")
    s = _session(db, event_id, uid)
    card = db.query(models.MemberCard).filter(models.MemberCard.id == s.card_id).first()
    req = pending_request(db, card)
    if req is not None:
        req.status, req.note = "cancelled", "Cancelled at the station by %s" % _who(current_user)
    s.email_status = "needs_email"
    db.commit()
    return _session_view(db, s)


@router.post(P + "/sessions/{uid}/close")
def bw_close(event_id: int, uid: str, body: dict, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, "biowell.station")
    s = _session(db, event_id, uid)
    outcome = body.get("outcome") or "done"
    if outcome not in ("done", "abandoned"):
        raise HTTPException(status_code=400, detail="done or abandoned")
    s.status, s.closed_at, s.note = outcome, _now(), (body.get("note") or "")[:500] or None
    db.commit()
    return _session_view(db, s)


# ---------------------------------------------------------------------------
# Routes: dashboard (biowell.read)
# ---------------------------------------------------------------------------
@router.get(P + "/overview")
def bw_overview(event_id: int, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, "biowell.read")
    sessions = db.query(models.BiowellSession).filter(models.BiowellSession.event_id == event_id).all()
    reqs = db.query(models.CardEmailRequest).filter(models.CardEmailRequest.event_id == event_id).all()
    people = {}
    for s in sessions:
        people.setdefault(s.card_id, []).append(s)
    linked = code = activated = 0
    for card_id in people:
        card = db.query(models.MemberCard).filter(models.MemberCard.id == card_id).first()
        own = _own_contact(db, card) if card else ""
        ls = link_state(own) if own else {}
        linked += 1 if ls.get("linked") else 0
        code += 1 if ls.get("ever_code") else 0
        activated += 1 if card and db.query(models.MemberCredential).filter(models.MemberCredential.card_id == card.id).first() else 0
    by = lambda attr, val: sum(1 for x in reqs if getattr(x, attr) == val)  # noqa: E731
    return {
        "station": {"sessions": len(sessions), "people": len(people), "open": sum(1 for s in sessions if s.status == "open"),
                    "with_error": sum(1 for s in sessions if s.error)},
        "email": {"changes_requested": len(reqs), "verified": by("status", "verified"), "pending": by("status", "pending"),
                  "expired": by("status", "expired"), "cancelled": by("status", "cancelled") + by("status", "superseded"),
                  "contacts_created": sum(1 for r in reqs if r.contact_created)},
        "people_processed": {"profile_activated": activated, "consent_code_requested": code, "results_linked": linked,
                             "not_linked_yet": len(people) - linked},
        "partner": dict(partner_config(), **link_store_summary()),
        "contact_creation_enabled": os.environ.get("BIOWELL_CREATE_CONTACTS") == "1",
        "note": "Scans themselves are recorded by Bio-Well and Gaia Practitioners; Gaia does not know how many scans were done.",
    }


@router.get(P + "/sessions")
def bw_sessions(event_id: int, filter: str = "", db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, "biowell.read")
    rows = db.query(models.BiowellSession).filter(models.BiowellSession.event_id == event_id).order_by(models.BiowellSession.id.desc()).limit(500).all()
    out = []
    for s in rows:
        v = _session_view(db, s)
        p = v["person"]
        if filter == "problems" and not (s.error or v["email_status"] in ("pending", "needs_email") or v["consent_status"] != "linked"):
            continue
        out.append({"session_id": s.session_uid, "at": v["created_at"], "station": s.station, "staff": s.staff_name, "status": s.status,
                    "name": p["name"], "ticket_id": p["ticket_id"], "guest": p["is_guest"], "email_status": v["email_status"],
                    "profile": v["profile_status"], "results": v["consent_status"], "error": s.error, "next_step": v["next_step"]})
    return {"items": out, "count": len(out)}
