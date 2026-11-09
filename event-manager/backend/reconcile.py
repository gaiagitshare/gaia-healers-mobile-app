# -*- coding: utf-8 -*-
"""Ticket Reconciliation & Issue Resolution: finding the problems (7 Nov 2026).

Every check here READS. It turns what is wrong with an event's tickets into
issue records an administrator can open and act on; it never issues a ticket,
moves money, changes a pass or sends an email. Corrections live in main.py and
go through the same audited endpoints the desk uses.

An issue has a stable key ("booking:204"), so a re-run updates the same record
instead of adding another, and a problem that disappears is closed with a line
in its history saying the check no longer finds it.
"""
import json
import re
from datetime import datetime

import models

PRIORITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}
# Facts an administrator records on an issue. A re-run of the checks refreshes
# everything else and never these.
ADMIN_FACT_KEYS = ("decision", "marked_duplicate_for_review")
OPEN_STATES = ("open", "in_review")
SEAT_TAG = re.compile(r"\+seat\d+@")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
QR_RE = re.compile(r"^ATT-[0-9A-F]{6,}$")
TOKEN_RE = re.compile(r"^[A-Z0-9]{8}$")

# Plain-English names, for people who never see the database.
KINDS = {
    "incomplete_booking": "Booking is missing tickets",
    "possible_duplicate_payment": "Possible duplicate payment",
    "paid_without_ticket": "Paid, but no ticket",
    "category_check": "Ticket category to check",
    "holder_details": "Ticket-holder details to confirm",
    "qr_invalid": "Missing or invalid QR code",
    "duplicate_badge": "Two tickets share one badge",
    "missing_from_email_list": "Ticket missing from the email list",
    "incomplete_delivery": "Booking only partly emailed",
    "contact_unverified": "Buyer contact not verified",
    "email_suppressed": "Contact asked not to be emailed",
    "delivery_failed": "Ticket email failed",
    "manual_review": "Needs a person to look",
}

# What the 3 Nov review's hold reasons mean, in words, and what kind of issue
# each one is. The holds themselves stay holds until an administrator acts.
HOLD_REASON_KIND = [
    ("source_buyer_email_differs_from_current_contact", "contact_unverified", "medium",
     "The buyer's email in GHL changed after they bought. Confirm it is the same person "
     "(phone on file, or a reply from the original address) before emailing the ticket."),
    ("verified_recipient_missing", "contact_unverified", "medium",
     "There is no verified email address to send this ticket to."),
    ("email_suppression_or_dnd", "email_suppressed", "low",
     "This contact asked not to receive email. The ticket is not emailed; the desk finds them by name."),
    ("source_category_vs_stored_entitlement", "category_check", "high",
     "The pass on the ticket differs from the product bought. Check the payment before changing anything; "
     "a recorded upgrade or complimentary pass is kept."),
    ("credential_conflict", "manual_review", "high",
     "The ticket's codes conflict with another record. A person needs to look before it is emailed."),
]


def _now():
    return datetime.utcnow()


def _name(a):
    return ("%s %s" % (a.first_name or "", a.last_name or "")).strip() or (a.email or "Ticket %d" % a.id)


PLAIN_REASONS = [
    ("source_buyer_email_differs_from_current_contact", "buyer's email changed after purchase; identity to confirm"),
    ("verified_recipient_missing", "no verified email address"),
    ("email_suppression_or_dnd", "contact asked not to be emailed"),
    ("source_category_vs_stored_entitlement", "pass differs from the product bought"),
    ("credential_conflict", "ticket codes conflict with another record"),
    ("multiple_base_lines_share_ticket", "booking has more purchases than tickets"),
    ("paid_quantity_not_equal_distinct_ticket_ids", "paid quantity differs from tickets issued"),
]


def plain_reason(reason):
    """A hold reason in words. The admin's own note is shown as written."""
    r = str(reason or "")
    words = [w for code, w in PLAIN_REASONS if code in r]
    return "; ".join(words) if words else r


def _ticket_brief(M, db, a, delivered, plan_ids, holds):
    """One ticket as an administrator sees it."""
    h = holds.get(a.id)
    return {"ticket_id": a.id, "name": _name(a), "email": a.email, "status": M._ticket_status(a),
            "active": bool(M._ticket_active(a)), "pass": M._pass_display(db, a),
            "ticket_type_id": a.ticket_type_id, "qr_code": a.qr_code, "badge": a.public_token,
            "checked_in": bool(a.is_checked_in), "source": a.registration_source,
            "attendance_type": a.attendance_type,
            "email_status": ("delivered" if a.id in delivered else "in email list" if a.id in plan_ids
                             else "held: %s" % plain_reason(h.reason) if h is not None and h.state == "held" else "not in email list")}


def delivery_index(event_id):
    """ticket id -> what the delivery history says about it."""
    out = {}
    try:
        from ticket_delivery import state as _st
        s = _st.DeliveryState()
        try:
            for oid, state, prov, ids, at in s.db.execute(
                    "select order_id,state,provider_status,ticket_ids,updated_at from order_ticket_delivery where event_id=?",
                    (event_id,)):
                for x in str(ids or "").replace(",", ";").split(";"):
                    if x.strip().isdigit():
                        out[int(x)] = {"order_id": oid, "state": state, "provider_status": prov, "at": at}
        finally:
            s.close()
    except Exception:
        pass
    return out


def delivered_ids(index):
    return {tid for tid, d in index.items() if d["state"] != "rejected"}


def import_bulk_list(db, event_id, orders, held_orders=None, actor="bulk check"):
    """Record the approved bulk list and its order-level holds, once.

    An administrator's later rebuild of a booking replaces that booking's rows;
    importing the list again never overwrites an administrator's decision."""
    import main as M
    rebuilt = set()
    for p in db.query(models.EmailPlan).filter(models.EmailPlan.event_id == event_id,
                                               models.EmailPlan.source == "admin_rebuild",
                                               models.EmailPlan.active == True).all():   # noqa: E712
        rebuilt |= set(int(x) for x in (p.ticket_ids or []))
    for o in orders or []:
        ids = [int(t["ticket_id"]) for t in (o.get("tickets") or [])]
        row = db.query(models.EmailPlan).filter(models.EmailPlan.event_id == event_id,
                                                models.EmailPlan.plan_key == o["order_id"]).first()
        if row is None:
            row = models.EmailPlan(event_id=event_id, plan_key=o["order_id"], source="approved_list")
            db.add(row)
        if row.source == "approved_list":
            row.recipient = (o.get("recipient") or "").strip().lower()
            row.ticket_ids = [i for i in ids if i not in rebuilt]
            row.order_ids = [o["order_id"]]
            row.active = bool(row.ticket_ids)
            row.updated_by = actor
            row.updated_at = _now()
    have = {h.attendee_id for h in db.query(models.EmailHold).filter(models.EmailHold.event_id == event_id).all()}
    # A ticket the approved list sends is not held, whatever its order's row said.
    have |= {int(t["ticket_id"]) for o in (orders or []) for t in (o.get("tickets") or [])}
    for oid, why in (held_orders or {}).items():
        for (aid,) in db.query(models.PaymentEvent.attendee_id).filter(
                models.PaymentEvent.event_id == event_id, models.PaymentEvent.ghl_entity_id == oid,
                models.PaymentEvent.attendee_id.isnot(None)).distinct():
            if int(aid) not in have:
                have.add(int(aid))
                db.add(models.EmailHold(event_id=event_id, attendee_id=int(aid), state="held",
                                        reason=str(why), source="review_2026_11_03", by=actor))
    db.flush()


def plan_state(db, event_id):
    """(ticket id -> plan row, holds by ticket id)."""
    plan = {}
    for p in db.query(models.EmailPlan).filter(models.EmailPlan.event_id == event_id,
                                               models.EmailPlan.active == True).all():   # noqa: E712
        for x in (p.ticket_ids or []):
            plan[int(x)] = p
    holds = {h.attendee_id: h for h in db.query(models.EmailHold).filter(models.EmailHold.event_id == event_id).all()}
    return plan, holds


def plan_as_orders(db, event_id):
    """The current planned emails, in the shape the bulk check reads."""
    out = []
    for p in db.query(models.EmailPlan).filter(models.EmailPlan.event_id == event_id,
                                               models.EmailPlan.active == True).all():   # noqa: E712
        tickets = []
        for x in (p.ticket_ids or []):
            a = db.query(models.Attendee).filter(models.Attendee.id == int(x)).first()
            tickets.append({"ticket_id": int(x), "qr": a.qr_code if a else None, "token": a.public_token if a else None})
        out.append({"order_id": p.plan_key, "recipient": p.recipient, "tickets": tickets})
    return out


def bulk_status(db, event_id):
    """The bulk-email rules applied to the planned emails as they stand now."""
    import main as M
    if not db.query(models.EmailPlan).filter(models.EmailPlan.event_id == event_id).first():
        return {"ok": False, "imported": False, "critical": [], "warnings": [], "summary": {}}
    idx = delivery_index(event_id)
    _, holds = plan_state(db, event_id)
    held = {h.attendee_id: (h.reason or "held") for h in holds.values() if h.state == "held"}
    released = {h.attendee_id for h in holds.values() if h.state == "released"}
    out = M._bulk_check(db, event_id, plan_as_orders(db, event_id), delivered_ids(idx), held, {},
                        "2026-11-03 15:46:00", released)
    out["imported"] = True
    out["changed_since_list"] = db.query(models.EmailPlan).filter(
        models.EmailPlan.event_id == event_id, models.EmailPlan.changed_since_list == True).count()   # noqa: E712
    return out


def detect(db, event_id):
    """Everything wrong, as {issue_key: issue dict}. Read-only."""
    import main as M
    found = {}
    rows = db.query(models.Attendee).filter(models.Attendee.event_id == event_id).all()
    by_id = {a.id: a for a in rows}
    live = [a for a in rows if M._ticket_active(a)]
    idx = delivery_index(event_id)
    delivered = delivered_ids(idx)
    plan, holds = plan_state(db, event_id)
    have_list = bool(plan) or db.query(models.EmailPlan).filter(models.EmailPlan.event_id == event_id).first() is not None

    def add(key, kind, priority, title, explanation, recommendation, attendees=(), orders=(), buyer=None, facts=None):
        ids = sorted({a.id for a in attendees})
        words = " ".join([title] + [(_name(a) + " " + (a.email or "") + " " + str(a.id)) for a in attendees] + list(orders))
        found[key] = {"issue_key": key, "kind": kind, "priority": priority, "title": title,
                      "explanation": explanation, "recommendation": recommendation,
                      "attendee_ids": ids, "order_ids": sorted(set(o for o in orders if o)),
                      "buyer_attendee_id": buyer, "facts": facts or {}, "search_text": words.lower()}

    # 1+2+9. Bookings: paid for more than they hold, possible double charges,
    # and bookings only partly in the email list.
    seen = set()
    for a in live:
        p = M._party_members(db, a)
        if not p or p["buyer_attendee_id"] in seen:
            continue
        seen.add(p["buyer_attendee_id"])
        buyer = by_id.get(p["buyer_attendee_id"])
        members = [by_id[m["attendee_id"]] for m in p["members"] if m["attendee_id"] in by_id]
        paid, issued, unnamed = int(p.get("paid_for") or 0), len(members), int(p.get("unnamed") or 0)
        dup = int(p.get("possible_double_charges") or 0)
        emailed = [m for m in members if m.id in delivered or m.id in plan]
        held_m = [m for m in members if m.id in holds and holds[m.id].state == "held"]
        orders = sorted({pe.ghl_entity_id for pe in db.query(models.PaymentEvent).filter(
            models.PaymentEvent.attendee_id.in_([m.id for m in members]),
            models.PaymentEvent.status == "paid").all() if pe.ghl_entity_id})
        facts = {"paid_for": paid, "issued": issued, "missing_seats": unnamed, "possible_double_charges": dup,
                 "tickets_in_email": len(emailed), "tickets_held": len(held_m), "buyer": p.get("buyer")}
        problems = []
        if unnamed:
            problems.append("paid for %d ticket%s but only %d %s been issued (%d missing)"
                            % (paid, "" if paid == 1 else "s", issued, "has" if issued == 1 else "have", unnamed))
        if have_list and emailed and len(emailed) < paid:
            problems.append("only %d of the %d paid tickets would reach the buyer by email" % (len(emailed), paid))
        if problems:
            critical = bool(emailed) and len(emailed) < paid
            explain = "This booking %s." % "; and ".join(problems)
            if held_m:
                explain += " %d of its tickets %s held from the email by the 3 Nov review." % (
                    len(held_m), "is" if len(held_m) == 1 else "are")
            if dup:
                explain += (" %d of the payments came minutes after another at the same price, so they may be "
                            "a duplicate charge rather than an extra seat." % dup)
            rec = ("Check the duplicate-payment issue for this booking first. " if dup else "") + (
                "Use 'Issue missing seat' for each seat the buyer really paid for (the system will not go above "
                "the paid quantity), then 'Rebuild email record' so every ticket goes in the buyer's email, "
                "then release the booking from hold." if unnamed else
                "Use 'Rebuild email record' so the email carries all of the booking's tickets, then release the booking.")
            add("booking:%d" % p["buyer_attendee_id"], "incomplete_delivery" if (critical and not unnamed) else "incomplete_booking",
                "critical" if critical else "high",
                "%s: paid for %d, %d issued, %d in the email" % (p.get("buyer") or "Booking", paid, issued, len(emailed)),
                explain, rec, attendees=members, orders=orders, buyer=p["buyer_attendee_id"], facts=facts)
        if dup:
            add("duplicate-payment:%d" % p["buyer_attendee_id"], "possible_duplicate_payment", "high" if unnamed else "medium",
                "%s: %d possible duplicate payment%s" % (p.get("buyer") or "Booking", dup, "" if dup == 1 else "s"),
                "Several payments for the same pass arrived minutes apart. It may be a real extra seat or the "
                "buyer paying twice by mistake. Nothing is refunded or issued automatically.",
                "Contact the buyer. If it was a real extra seat, mark this reviewed as 'real seat' and issue it from "
                "the booking issue. If it was a mistake, the refund is made in GHL (outside this system) and the "
                "seat closes itself.", attendees=members, orders=orders, buyer=p["buyer_attendee_id"], facts=facts)

    # 3-8. What the existing review queue already finds, with money.
    try:
        rq = M._review_queue(db, event_id, with_money=True)
    except Exception:
        rq = {"items": []}
    rq_map = {"payment_unplaced": ("paid_without_ticket", "critical"),
              "sale_unmapped": ("paid_without_ticket", "high"),
              "charge_held": ("possible_duplicate_payment", "high"),
              "name_to_confirm": ("holder_details", "medium"),
              "identity_review": ("manual_review", "high"),
              "confirm_purchase": ("manual_review", "medium"),
              "payment_unsettled": ("manual_review", "low")}
    for it in rq.get("items") or []:
        if it["kind"] not in rq_map:
            continue   # unnamed seats are the booking issue above
        kind, prio = rq_map[it["kind"]]
        att = by_id.get(it.get("attendee_id"))
        add("review:%s:%s" % (it["kind"], it.get("ref") or it.get("attendee_id") or it.get("title")), kind, prio,
            it["title"] + (" — %s" % it["name"] if it.get("name") else ""), it.get("detail") or "",
            {"payment_unplaced": "Look at 'This person's tickets' below. If they already have a ticket, open "
                                 "Review Queue and use Place to link this payment to it. Only give a new badge "
                                 "if they have no ticket at all.",
             "sale_unmapped": "Check the product sold. If the person already has a ticket (see below) or it is "
                              "not an event ticket, Dismiss with a note. If it is an event ticket nobody has "
                              "received, add the product in Setup > Ticket Mappings: the ticket is then created "
                              "from the purchase by itself.",
             "charge_held": "Confirm with the buyer whether this was a second seat or a duplicate charge.",
             "name_to_confirm": "Ask the buyer who this ticket is for, then use 'Correct name & contact'.",
             "identity_review": "Decide which person this record belongs to.",
             "confirm_purchase": "Call the buyer to confirm the purchase.",
             "payment_unsettled": "A card payment that failed or has not settled yet: no money arrived, so no ticket "
                                  "is owed for it. If the person already has a ticket (see below), Dismiss. If not, "
                                  "Dismiss too, unless they say they paid another way; then check GHL."}.get(it["kind"], ""),
            attendees=[att] if att else [], orders=[str(it.get("ref") or "")] if it["kind"] in ("sale_unmapped", "payment_unplaced", "charge_held") else [],
            facts={"source": "review queue", "kind": it["kind"], "amount": it.get("amount"), "when": it.get("when"),
                   "name": it.get("name"), "email": it.get("email")})

    # 6+7. QR codes and badge identity.
    tok, qr = {}, {}
    for a in live:
        if a.public_token:
            tok.setdefault(a.public_token, []).append(a)
    for a in rows:
        if a.qr_code:
            qr.setdefault(a.qr_code, []).append(a)
    for t, group in tok.items():
        if len(group) > 1:
            add("badge:%s" % t, "duplicate_badge", "critical", "%d tickets share one badge" % len(group),
                "These live tickets carry the same badge identity, so either printed badge would open the other "
                "ticket at the door.", "Escalate to the system administrator: a badge identity change replaces a "
                "printed badge and needs approval.", attendees=group)
    for q, group in qr.items():
        if len(group) > 1:
            add("qr-dup:%s" % q, "qr_invalid", "critical", "%d tickets share one QR code" % len(group),
                "Two tickets carry the same QR code.", "Escalate to the system administrator.", attendees=group)
    for a in live:
        bad = []
        if not a.qr_code or not QR_RE.match(a.qr_code):
            bad.append("QR code missing or malformed")
        if not a.public_token or not TOKEN_RE.match(a.public_token):
            bad.append("badge identity missing or malformed")
        if bad:
            add("qr:%d" % a.id, "qr_invalid", "critical", "%s: %s" % (_name(a), ", ".join(bad)),
                "This ticket cannot be scanned reliably: %s." % ", ".join(bad),
                "Escalate to the system administrator; a ticket's codes are never changed from this screen.",
                attendees=[a])

    # 5. Holder details that cannot be right.
    for a in live:
        em = (a.email or "").strip()
        if not em or not EMAIL_RE.match(em):
            add("holder:%d" % a.id, "holder_details", "high", "%s: no valid email address" % _name(a),
                "The ticket has no usable email address, so it cannot be emailed.",
                "Use 'Correct name & contact' with the holder's real address (needs confirmation).", attendees=[a])
        elif not (a.first_name or "").strip():
            add("holder:%d" % a.id, "holder_details", "medium", "%s: no first name" % _name(a),
                "The ticket has no first name, so the badge prints without one.",
                "Use 'Correct name & contact'.", attendees=[a])

    # 8+10+12. The email list: tickets in no email, held tickets needing a decision.
    if have_list:
        paid_sources = ("ghl_order", "ghl_invoice", "ghl_webhook") + tuple(M.PARTY_SEAT_SOURCES)
        booked = set()
        for k, v in found.items():
            if v["kind"] in ("incomplete_booking", "incomplete_delivery"):
                booked |= set(v["attendee_ids"])
        for a in live:
            if a.id in delivered or a.id in plan or a.id in booked:
                continue
            if (a.registration_source or "") not in paid_sources and (a.attendance_type or "paid") != "paid":
                continue
            h = holds.get(a.id)
            if h is not None and h.state == "held":
                kind, prio, text = "manual_review", "medium", "Held from the ticket email by the 3 Nov review."
                for needle, k, pr, words in HOLD_REASON_KIND:
                    if needle in (h.reason or ""):
                        kind, prio, text = k, pr, words
                        break
                if "multiple_base_lines_share_ticket" in (h.reason or "") and kind == "manual_review":
                    text = ("This ticket's booking has more purchases than tickets. Check the booking before "
                            "releasing it to the email.")
                add("hold:%d" % a.id, kind, prio, "%s: held from the email" % _name(a), text,
                    "Review, then 'Release to email list' (and 'Rebuild email record') or keep it held and mark "
                    "the issue reviewed with a note.", attendees=[a],
                    facts={"hold_reason": plain_reason(h.reason), "hold_source": h.source})
                continue
            first = db.query(models.PaymentEvent).filter(models.PaymentEvent.attendee_id == a.id,
                                                         models.PaymentEvent.status == "paid").order_by(
                models.PaymentEvent.first_seen_at).first()
            if first is not None and first.first_seen_at and str(first.first_seen_at) > "2026-11-03 15:46:00":
                continue   # the automatic sender's
            add("unlisted:%d" % a.id, "missing_from_email_list", "high", "%s: not in the email list" % _name(a),
                "This paid ticket is in no planned email, has not been delivered and is not on hold.",
                "Use 'Rebuild email record' to add it to an email, or 'Hold from email' with a reason.",
                attendees=[a])

    # 11. Ticket emails that failed.
    for tid, d in idx.items():
        a = by_id.get(tid)
        if a is None:
            continue
        if d["state"] == "rejected" or (d.get("provider_status") or "") in ("failed", "bounced", "rejected", "complained",
                                                                             "undelivered", "permanent_fail"):
            add("delivery:%d" % tid, "delivery_failed", "high", "%s: ticket email %s" % (_name(a), d.get("provider_status") or d["state"]),
                "The ticket email did not arrive.", "Check the address with 'Correct delivery email', then resend "
                "from Ticket Emails (resends need a reason and never happen automatically).",
                attendees=[a], orders=[d["order_id"]], facts={"delivery": d})
    return found


def _hist(db, issue, kind, text, actor="system", user_id=None, before=None, after=None):
    db.add(models.ReconHistory(issue_id=issue.id, event_id=issue.event_id, at=_now(), user_id=user_id,
                               actor=actor, kind=kind, text=text, before=before, after=after))


def run(db, event_id, actor="system"):
    """Detect, then bring the issue records in line. Returns the counts."""
    found = detect(db, event_id)
    now = _now()
    existing = {i.issue_key: i for i in db.query(models.ReconIssue).filter(models.ReconIssue.event_id == event_id).all()}
    created = updated = cleared = reopened = 0
    for key, d in found.items():
        i = existing.get(key)
        if i is None:
            i = models.ReconIssue(event_id=event_id, issue_key=key, status="open", source="detector",
                                  first_seen_at=now, last_seen_at=now, detected=True, updated_at=now)
            for f in ("kind", "priority", "title", "explanation", "recommendation", "attendee_ids", "order_ids",
                      "buyer_attendee_id", "facts", "search_text"):
                setattr(i, f, d[f])
            db.add(i); db.flush()
            _hist(db, i, "detected", d["explanation"], actor=actor)
            created += 1
            continue
        kept = {k: v for k, v in (i.facts or {}).items() if k in ADMIN_FACT_KEYS}
        d = dict(d, facts=dict(d["facts"], **kept))
        changed = any(json.dumps(getattr(i, f), sort_keys=True, default=str) != json.dumps(d[f], sort_keys=True, default=str)
                      for f in ("title", "facts", "attendee_ids", "priority"))
        before = {"title": i.title, "facts": i.facts, "priority": i.priority} if changed else None
        for f in ("kind", "priority", "title", "explanation", "recommendation", "attendee_ids", "order_ids",
                  "buyer_attendee_id", "facts", "search_text"):
            setattr(i, f, d[f])
        i.last_seen_at = now
        if not i.detected:
            i.detected, i.cleared_at = True, None
        if i.status == "resolved":
            # Marked resolved, but the check still finds the problem.
            i.status = "open"
            _hist(db, i, "reopened", "The check still finds this problem, so it was reopened.", actor=actor)
            reopened += 1
        elif changed:
            _hist(db, i, "updated", "The facts changed: %s" % d["title"], actor=actor, before=before,
                  after={"title": d["title"], "facts": d["facts"], "priority": d["priority"]})
            updated += 1
        i.updated_at = now
    for key, i in existing.items():
        if key in found or not i.detected:
            continue
        i.detected, i.cleared_at, i.updated_at = False, now, now
        if i.status in OPEN_STATES or i.status == "reviewed":
            i.status, i.resolved_at = "resolved", now
            i.resolution = (i.resolution or "") + ("\n" if i.resolution else "") + "Cleared: the check no longer finds this problem."
        _hist(db, i, "cleared", "The check no longer finds this problem.", actor=actor)
        cleared += 1
    db.flush()
    return {"detected": len(found), "created": created, "updated": updated, "cleared": cleared, "reopened": reopened}
