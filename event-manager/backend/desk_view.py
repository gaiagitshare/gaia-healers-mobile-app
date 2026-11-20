# -*- coding: utf-8 -*-
"""What the registration desk needs to know about a ticket, at a glance
(18 Nov 2026, Babak: "make check-in extremely simple").

One answer per ticket:

  status      READY / VERIFY / MULTIPLE / BLOCKED (+ "statuses", every one that
              applies, so a person with two tickets AND a bounced email shows both)
  entitlement a plain sentence -- never an amount, a card or a transaction
  notes       short instructions for the desk, in the team's own words
  tickets     every ticket that belongs with this one: the same person's other
              tickets, the seats on their booking, the booking it is a seat of

Rules that matter:
  * a delivery problem is NOT a validity problem: a bounced or withheld email
    makes a ticket VERIFY, never BLOCKED;
  * several valid tickets for one person are normal (two purchases, different
    emails or dates): MULTIPLE, "do not cancel", never an error;
  * one person = the same email, or the same full name AND the same phone.
    A shared phone alone is a household, not a person; a shared name alone is
    only a POSSIBLE match, shown as such and never combined;
  * nothing here writes anything, and GHL is never consulted.
"""
import json
import re
from datetime import datetime

import models

BLOCKED = {"refunded", "cancelled", "revoked"}
SEAT_SOURCES = ("rebuilt_seat", "door_seat", "reconciled_seat")
_SEAT_TAG = re.compile(r"\+seat\d*@")
_BAD_PROVIDER = {"failed", "bounced", "rejected", "complained", "undelivered", "permanent_fail"}
_QR_RE = re.compile(r"^ATT-[0-9A-F]{6,}$")


def _norm_email(e):
    return _SEAT_TAG.sub("@", (e or "").strip().lower())


def _digits(p):
    d = re.sub(r"\D", "", p or "")
    return d[-10:] if len(d) >= 10 else ""


def _name(a):
    return ("%s %s" % (a.first_name or "", a.last_name or "")).strip()


def _norm_name(a):
    n = re.sub(r"[^a-z ]", "", _name(a).lower())
    return " ".join(n.split())


def _active(a):
    return (a.registration_status or "active").strip().lower() not in BLOCKED


def index(db, event_id):
    """Everything the desk view looks up, read once per request."""
    rows = db.query(models.Attendee).filter(models.Attendee.event_id == event_id).all()
    by_id = {a.id: a for a in rows}
    by_email, by_name = {}, {}
    for a in rows:
        e = _norm_email(a.email)
        if e:
            by_email.setdefault(e, []).append(a)
        n = _norm_name(a)
        if n:
            by_name.setdefault(n, []).append(a)
    seats_of = {}
    for a in rows:
        if a.registration_source in SEAT_SOURCES:
            b = int((a.custom_data or {}).get("bought_by_attendee") or 0)
            if b:
                seats_of.setdefault(b, []).append(a)
    delivered, failed, held_keys = set(), set(), set()
    try:
        from ticket_delivery import state as _tds
        s = _tds.DeliveryState()
        try:
            for _oid, st, prov, tids in s.db.execute(
                    "select order_id,state,provider_status,ticket_ids from order_ticket_delivery where event_id=?", (event_id,)):
                ids = [int(x) for x in str(tids or "").replace(",", ";").split(";") if x.strip().isdigit()]
                # Only an email GHL accepted (and did not later report failed)
                # reached them; refused, unknown or half-sent ones did not.
                bad = st != "accepted" or (prov or "").lower() in _BAD_PROVIDER
                for i in ids:
                    (failed if bad else delivered).add(i)
            try:
                held_keys = {r[0] for r in s.db.execute(
                    "select booking_key from ec_reviews where event_id=? and state='held'", (event_id,))}
            except Exception:
                held_keys = set()
        finally:
            s.close()
    except Exception:
        pass
    holds = {h.attendee_id for h in db.query(models.EmailHold).filter(
        models.EmailHold.event_id == event_id, models.EmailHold.state == "held").all()}
    paid_ids = {r[0] for r in db.query(models.PaymentEvent.attendee_id).filter(
        models.PaymentEvent.event_id == event_id, models.PaymentEvent.status == "paid",
        models.PaymentEvent.attendee_id.isnot(None)).all()}
    # Bookings whose extra payments an organiser decided were a double charge
    # (refund due in GHL), not extra seats: the desk must not name seats for them.
    double_charge = set()
    try:
        for (bid,) in db.query(models.ReconIssue.buyer_attendee_id).filter(
                models.ReconIssue.event_id == event_id,
                models.ReconIssue.kind == "possible_duplicate_payment",
                models.ReconIssue.resolution.like("%Double charge, not a seat%")).all():
            if bid:
                double_charge.add(int(bid))
    except Exception:
        pass
    types = {t.id: t for t in db.query(models.TicketType).filter(models.TicketType.event_id == event_id).all()}
    event = db.query(models.Event).filter(models.Event.id == event_id).first()
    return {"by_id": by_id, "by_email": by_email, "by_name": by_name, "seats_of": seats_of,
            "delivered": delivered, "failed": failed, "held_keys": held_keys, "holds": holds,
            "paid_ids": paid_ids, "types": types, "event": event, "double_charge": double_charge}


def _days(ix, a):
    t = ix["types"].get(a.ticket_type_id)
    vd = getattr(t, "valid_day", None) if t else None
    if vd:
        try:
            return datetime.strptime(str(vd)[:10], "%Y-%m-%d").strftime("%a %-d %b") + " only"
        except ValueError:
            return str(vd) + " only"
    ev = ix["event"]
    if ev and ev.start_date:
        s, e = ev.start_date, (ev.end_date or ev.start_date)
        return "All days, %s – %s" % (s.strftime("%a %-d"), e.strftime("%a %-d %b"))
    return "All event days"


def _order_ref(a):
    cd = a.custom_data or {}
    ref = a.acq_order_id or cd.get("order_id") or next(
        (e.get("order_id") or e.get("invoice_id") for e in (cd.get("entitlements") or [])
         if e.get("order_id") or e.get("invoice_id")), None)
    if not ref:
        return None
    return ("Order …" if not str(ref).startswith("ticket") else "") + str(ref)[-6:]


def _kind(a, ix):
    cd = a.custom_data or {}
    tt = ix["types"].get(a.ticket_type_id)
    code = (tt.code if tt else "") or ""
    if a.registration_source in SEAT_SOURCES:
        return "guest"
    if cd.get("transfers"):
        return "transferred"
    if code == "VOL" or (a.attendance_type or "") == "staff":
        return "staff"
    if code == "SPEAKER" or cd.get("source") == "speaker_badge":
        return "speaker"
    if (a.attendance_type or "") == "exhibitor":
        return "exhibitor"
    if (a.attendance_type or "") == "complimentary":
        return "complimentary"
    return "paid"


def entitlement(a, ix):
    if not _active(a):
        return "Not valid — ticket %s" % (a.registration_status or "").lower()
    k = _kind(a, ix)
    if k == "staff":
        return "Staff / volunteer badge"
    if k == "speaker":
        return "Speaker badge"
    if k == "exhibitor":
        return "Exhibitor badge"
    if k == "complimentary":
        return "Valid complimentary ticket"
    if k == "guest":
        return "Valid paid guest seat"
    cd = a.custom_data or {}
    paid = (a.id in ix["paid_ids"] or (a.door_payment_status or "") == "collected"
            or any(e.get("status") == "paid" for e in (cd.get("entitlements") or []))
            or "paid online" in str(cd.get("note") or "").lower())
    return "Valid paid ticket" if paid else "Requires administrator review"


_EMAIL_KINDS = ("paid", "guest", "transferred", "complimentary")


def email_state(a, ix):
    """Where this ticket's email stands, for the desk: sent / failed / held
    (asked not to be emailed) / not_sent / None (crew badges are not emailed)."""
    if _kind(a, ix) not in _EMAIL_KINDS:
        return None
    if a.id in ix["delivered"]:
        return "sent"
    if a.id in ix["failed"]:
        return "failed"
    cd = a.custom_data or {}
    buyer_id = int(cd.get("bought_by_attendee") or 0) if a.registration_source in SEAT_SOURCES else a.id
    if a.id in ix["holds"] or ("B%d" % buyer_id) in ix["held_keys"]:
        return "held"
    return "not_sent"


def _ticket_row(a, ix, label, own=None):
    cd = a.custom_data or {}
    tt = ix["types"].get(a.ticket_type_id)
    buyer = ix["by_id"].get(int(cd.get("bought_by_attendee") or 0)) if a.registration_source in SEAT_SOURCES else None
    t = (cd.get("transfers") or [None])[-1]
    purchaser = (_name(buyer) if buyer else
                 ((t.get("purchaser") or t.get("from") or {}).get("name") if isinstance(t, dict) else None))
    return {"id": a.id, "holder": _name(a) or "(no name)", "pass": tt.name if tt else None,
            "valid_days": _days(ix, a), "checked_in": bool(a.is_checked_in), "active": _active(a),
            "qr_ok": bool(a.qr_code and _QR_RE.match(a.qr_code) and a.public_token),
            "purchaser": purchaser if purchaser and purchaser != _name(a) else None,
            "kind": _kind(a, ix), "relation": label, "entitlement": entitlement(a, ix),
            "order_ref": _order_ref(a), "this": bool(own), "email": email_state(a, ix)}


def view(db, a, ix=None, party=None):
    ix = ix or index(db, a.event_id)
    cd = a.custom_data or {}
    notes, statuses = [], []
    if not _active(a):
        statuses.append("BLOCKED")
        notes.append("Ticket %s — not valid for entry." % (a.registration_status or "").lower())

    # The same person's other tickets: same email, or same name AND same phone.
    mine_e, mine_n, mine_p = _norm_email(a.email), _norm_name(a), _digits(a.phone)
    same = {}
    if a.registration_source not in SEAT_SOURCES and mine_e:
        for o in ix["by_email"].get(mine_e, []):
            if o.id != a.id and o.registration_source not in SEAT_SOURCES:
                same[o.id] = o
    for o in ix["by_name"].get(mine_n, []) if mine_n else []:
        if o.id != a.id and mine_p and _digits(o.phone) == mine_p:
            same[o.id] = o
    valid_same = [o for o in same.values() if _active(o)]
    if valid_same and _active(a) and _kind(a, ix) == "staff" and all(_kind(o, ix) == "staff" for o in valid_same):
        statuses.append("MULTIPLE")
        notes.append("Same person holds %d staff/volunteer badges (#%s). Hand over one badge only."
                     % (len(valid_same) + 1, ", #".join(str(i) for i in sorted([a.id] + [o.id for o in valid_same]))))
    elif valid_same and _active(a):
        statuses.append("MULTIPLE")
        n = len(valid_same) + 1
        notes.append(("Two separate valid tickets for this person (#%s). Do not cancel either ticket."
                      if n == 2 else "%d separate valid tickets for this person (#%%s). Do not cancel any of them." % n)
                     % ", #".join(str(i) for i in sorted([a.id] + [o.id for o in valid_same])))

    # Same name, different email and phone, one a crew badge and one a ticket:
    # perhaps one person, perhaps two. Said, never combined.
    if len(mine_n.split()) >= 2 and _active(a):
        for o in ix["by_name"].get(mine_n, []):
            if o.id == a.id or o.id in same or not _active(o):
                continue
            kinds = {_kind(a, ix), _kind(o, ix)}
            if "staff" in kinds and kinds & {"paid", "guest", "complimentary"}:
                statuses.append("VERIFY")
                notes.append("Possible volunteer and paid attendee match (#%d). Verify identity before combining records." % o.id)

    if cd.get("transfers"):
        t = cd["transfers"][-1] or {}
        frm = (t.get("purchaser") or t.get("from") or {}).get("name") or "another buyer"
        statuses.append("VERIFY")
        notes.append("Originally purchased by %s. Transferred to %s." % (frm, (t.get("to") or {}).get("name") or _name(a)))

    if a.registration_source in SEAT_SOURCES or cd.get("needs_name_check"):
        statuses.append("VERIFY")
        notes.append("Paid guest seat. Confirm the guest's identity before issuing the badge.")

    # Email: a problem with the message, never with the ticket.
    buyer_id = int(cd.get("bought_by_attendee") or 0) if a.registration_source in SEAT_SOURCES else a.id
    if _active(a) and _kind(a, ix) in ("paid", "guest", "transferred", "complimentary"):
        if a.id in ix["failed"] and a.id not in ix["delivered"]:
            statuses.append("VERIFY")
            notes.append("Ticket valid. Email could not be delivered. Verify identity and issue badge at desk.")
        elif a.id not in ix["delivered"] and (a.id in ix["holds"] or ("B%d" % buyer_id) in ix["held_keys"]):
            statuses.append("VERIFY")
            notes.append("Ticket valid. Asked not to be emailed, so they have no QR code with them. Verify identity and issue badge at desk.")

    if _active(a) and email_state(a, ix) == "not_sent":
        notes.append("Ticket valid, but its email was never sent. Nothing to fix: check them in and print the badge here.")

    ent = entitlement(a, ix)
    if ent == "Requires administrator review" and _active(a):
        statuses.append("VERIFY")
        notes.append("No payment on record for this ticket. Ask an organiser before admitting.")

    # Seats this booking paid for that nobody holds yet.
    tickets = [_ticket_row(a, ix, "this ticket", own=True)]
    if party:
        if int(party.get("unnamed") or 0) > 0:
            tt = ix["types"].get(party.get("next_seat_ticket_type_id")) if party.get("next_seat_ticket_type_id") else None
            notes.append("%d paid guest seat%s%s not yet named. When the guest arrives, use “Name seat” — no charge."
                         % (party["unnamed"], "" if party["unnamed"] == 1 else "s",
                            (" (%s)" % tt.name) if tt else ""))
        for m in party.get("members") or []:
            if m["attendee_id"] != a.id and m["attendee_id"] not in same:
                o = ix["by_id"].get(m["attendee_id"])
                if o is not None:
                    tickets.append(_ticket_row(o, ix, "booking buyer" if m.get("is_buyer") else "guest seat on this booking"))
    for o in sorted(same.values(), key=lambda x: x.id):
        tickets.append(_ticket_row(o, ix, "same person, separate ticket"))

    # The booking at a glance (20 Nov 2026): how many tickets were bought, how
    # many badges exist, how many were emailed -- so the desk sees a gap and
    # closes it there (Name seat / Print badge) instead of sending people away.
    if party:
        _members = [ix["by_id"].get(m["attendee_id"]) for m in (party.get("members") or [])]
        _members = [m for m in _members if m is not None]
        bought = int(party.get("paid_for") or len(_members) or 1)
        buyer_id = int(party.get("buyer_attendee_id") or a.id)
    else:
        _members, bought, buyer_id = [a], 1, a.id
    # The same person's separate tickets count too: "how many did they buy".
    _seen_ids = {m.id for m in _members}
    for o in valid_same:
        if o.id not in _seen_ids:
            _members.append(o); _seen_ids.add(o.id); bought += 1
    _valid = [m for m in _members if _active(m)]
    double_charge = buyer_id in ix.get("double_charge", set()) and bought > len(_valid)
    if double_charge:
        bought = len(_valid)
        notes[:] = [n for n in notes if "not yet named" not in n]
        notes.append("The extra payments on this booking were a double charge (refund due), not extra seats. Do not name a seat.")
    _states = [email_state(m, ix) for m in _valid]
    booking = {"buyer_attendee_id": buyer_id, "bought": bought, "issued": len(_valid),
               "missing": max(0, bought - len(_valid)) if party else 0,
               "emailed": sum(1 for x in _states if x == "sent"),
               "not_emailed": sum(1 for x in _states if x in ("failed", "held", "not_sent")),
               "emailable": sum(1 for x in _states if x is not None), "double_charge": double_charge}

    order = ["BLOCKED", "VERIFY", "MULTIPLE"]
    statuses = [s for s in order if s in statuses] or ["READY"]
    seen, uniq = set(), []
    for n in notes:
        if n not in seen:
            seen.add(n); uniq.append(n)
    return {"status": statuses[0], "statuses": statuses, "entitlement": ent,
            "checked_in": bool(a.is_checked_in), "valid_days": _days(ix, a), "notes": uniq, "tickets": tickets,
            "booking": booking}
