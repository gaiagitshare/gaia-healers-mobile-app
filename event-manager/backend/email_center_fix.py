# -*- coding: utf-8 -*-
"""Email Center: investigate and fix flagged orders (10 Nov 2026).

There is ONE way to correct a ticket problem in this system: the Ticket
Reconciliation actions (main._rc_execute), which change the authoritative
records through the existing functions (seat issue, identity fix, pass change,
holds, email record) and re-run the reconciliation checks afterwards. This
module does not add a second one. It adds what was missing around it:

  * plain-language guidance per problem: what is wrong, why it was flagged,
    what the right result is, the evidence, and the actions that fit;
  * a split by risk: a reviewer (Ticket Email Manager) applies low-risk fixes
    herself; sensitive ones (creating a paid ticket, changing access, changing
    who holds a ticket, payment decisions, releasing a protective hold) become
    PROPOSALS that a platform admin -- a different person -- approves;
  * proposals (models.ReconProposal), applied exactly once, with the re-check
    result stored; a fix that does not clear the problem leaves it open;
  * one work queue (Needs Attention) built on the reconciliation issues, so a
    problem appears once, not once per screen.

A problem is never closed by hand here: the reconciliation re-run decides.
"""
import hashlib
import json
from datetime import datetime

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

import authz
import main as M
import models
import reconcile as RC
import email_center as EC
from ticket_delivery import ec_store

router = EC.router
P = EC.P

# What may be fixed directly, by whom. Everything else is proposed.
LOW_RISK = {"correct_holder", "set_delivery_email", "rebuild_email", "hold", "flag_duplicate", "acknowledge", "release_contact"}
SENSITIVE = {"issue_seat", "decide_duplicate", "change_category", "correct_ticket_email", "release", "request_admin"}
CONTACT_HOLD_WORDS = ("buyer's email in GHL changed", "no verified email address", "source_buyer_email_differs_from_current_contact",
                      "verified_recipient_missing")
QUANTITY_HOLD_WORDS = ("multiple_base_lines_share_ticket", "paid_quantity_not_equal_distinct_ticket_ids",
                       "more purchases than tickets")
ACK_KINDS = {"manual_review": ("low", "medium"), "holder_details": ("medium",), "contact_unverified": ("medium", "low"),
             "email_suppressed": ("low",)}
ROOT_CAUSES = ("one_off", "mapping", "ticket_generation", "guest_assignment", "payment_sync", "unknown")

# Plain words per kind of problem: the right result, and what usually fixes it.
GUIDE = {
    "incomplete_booking": ("Every ticket the customer paid for exists, each with its own QR code, and all of them are in the customer's email.",
                           "Check the payments below. If each one is a real seat, propose the missing ticket. If one may be a double charge, "
                           "that decision comes first."),
    "incomplete_delivery": ("All of the booking's tickets go to the buyer by email.",
                            "Rebuild the email record so it carries every ticket of the booking."),
    "possible_duplicate_payment": ("Each payment is either a real extra seat (it gets a ticket) or a mistake (refunded in GHL, no ticket).",
                                   "Ask the customer or check the payments. Propose 'real seat' or 'duplicate' for an admin to decide."),
    "paid_without_ticket": ("The payment belongs to a ticket: linked to the person's existing ticket, or a new one if they have none.",
                            "Investigate who paid. Request an admin to place the payment (Review Queue) — no ticket is created from here."),
    "category_check": ("The ticket's pass matches what was bought (or a recorded complimentary upgrade).",
                       "Compare the product bought with the pass. Propose the correct pass for an admin to approve."),
    "holder_details": ("The ticket shows the holder's real name and a working email.",
                       "Correct the holder's name or phone yourself; a ticket email change goes to an admin."),
    "contact_unverified": ("The ticket is emailed to an address confirmed to belong to the customer.",
                           "Confirm the address (phone on file, or a reply from the original address), then set the delivery email "
                           "and release the hold."),
    "email_suppressed": ("The customer asked not to be emailed: no ticket email is sent; the desk finds them by name.",
                         "Nothing to fix. Acknowledge it so it leaves the queue."),
    "manual_review": ("A person has looked at it and recorded the decision.",
                      "Read the explanation, then acknowledge it with a note, or propose a correction."),
    "missing_from_email_list": ("Every paid ticket is in exactly one planned email (or held for a reason).",
                                "Rebuild the email record to add it, or hold it with a reason."),
    "delivery_failed": ("The ticket email reaches the customer.",
                        "Check the address, correct the delivery email if needed, then retry the email."),
    "qr_invalid": ("Every ticket has its own valid QR code and badge.",
                   "Request an admin to repair the code. No email can be sent with a broken or shared code."),
    "duplicate_badge": ("Every ticket has its own badge code.",
                        "Request an admin to repair it. No email can be sent with a shared badge."),
}


def _now():
    return datetime.utcnow()


def _who(u):
    return M._rc_actor(u)


def _issue(db, event_id, issue_id):
    i = db.query(models.ReconIssue).filter(models.ReconIssue.id == issue_id, models.ReconIssue.event_id == event_id).first()
    if not i:
        raise HTTPException(status_code=404, detail="Issue not found")
    return i


def _booking_of_issue(db, event_id, i):
    """The Email Center booking key ('B<buyer ticket>') this issue belongs to."""
    ids = [int(x) for x in (i.attendee_ids or []) if str(x).isdigit()]
    anchor_id = i.buyer_attendee_id or (ids[0] if ids else None)
    if not anchor_id:
        return None, None
    a = db.query(models.Attendee).filter(models.Attendee.id == anchor_id).first()
    if a is None:
        return None, None
    p = M._party_members(db, a)
    buyer = (p["buyer_attendee_id"] if p else None) or (int((a.custom_data or {}).get("bought_by_attendee") or 0) or a.id)
    return "B%d" % buyer, p


def _holds_for(db, event_id, ids):
    return {h.attendee_id: h for h in db.query(models.EmailHold).filter(models.EmailHold.event_id == event_id,
                                                                       models.EmailHold.attendee_id.in_(list(ids) or [0]),
                                                                       models.EmailHold.state == "held").all()}


def _contact_hold(h):
    return h is not None and any(w in (h.reason or "") for w in CONTACT_HOLD_WORDS)


def actions_for(db, event_id, i, party, me_caps, is_admin):
    """The actions that make sense for this problem, each with its risk.
    'mode': 'direct' = she may apply it now; 'propose' = goes to an admin."""
    ids = set(int(x) for x in (i.attendee_ids or []) if str(x).isdigit())
    if party:
        ids |= {m["attendee_id"] for m in party["members"]}
    holds = _holds_for(db, event_id, ids)
    out = []

    def add(key, label, mode, explain, **extra):
        out.append(dict(key=key, label=label, mode=mode, explain=explain, **extra))
    k = i.kind
    missing = int((party or {}).get("unnamed") or 0)
    if missing > 0 and k in ("incomplete_booking",):
        add("issue_seat", "Propose missing ticket", "propose",
            "Creates only the missing paid ticket(s) with a new QR code. The existing tickets are kept. An admin approves.",
            max_count=missing)
    if k == "possible_duplicate_payment":
        add("decide_duplicate", "Propose: real seat or double charge", "propose",
            "Records the decision on these payments. Nothing is refunded or issued by this decision. An admin approves.")
        add("flag_duplicate", "Flag for an admin to look at", "direct", "Marks the payments for review. Changes nothing else.")
    if k in ("category_check", "manual_review", "incomplete_booking"):
        add("change_category", "Propose a pass correction", "propose",
            "Changes the ticket's pass (its access) to match the purchase. The QR code stays the same. An admin approves.")
    if k in ("holder_details", "contact_unverified", "manual_review", "incomplete_booking", "delivery_failed") or any(
            (db.query(models.Attendee).filter(models.Attendee.id == t).first().custom_data or {}).get("needs_name_check") for t in ids
            if db.query(models.Attendee).filter(models.Attendee.id == t).first()):
        add("correct_holder", "Correct holder name / phone", "direct", "Fixes the name or phone on a ticket. Access and QR code do not change.")
        add("correct_ticket_email", "Propose a ticket email change", "propose",
            "Changes the email on the ticket itself (who it belongs to). An admin approves.")
    if k in ("contact_unverified", "holder_details", "delivery_failed", "incomplete_delivery", "missing_from_email_list", "incomplete_booking"):
        add("set_delivery_email", "Correct delivery email", "direct",
            "Changes only where the ticket email is sent. The ticket and its holder stay the same.")
    if k in ("missing_from_email_list", "incomplete_delivery", "incomplete_booking"):
        add("rebuild_email", "Rebuild the email record", "direct", "Puts every ticket of the booking into the buyer's email. Nothing is sent.")
    if holds:
        if all(_contact_hold(h) for h in holds.values()):
            add("release_contact", "Release hold (address confirmed)", "direct",
                "For a hold that only waited for the address to be confirmed. Confirm how you checked it.",
                ticket_ids=sorted(holds))
        else:
            add("release", "Propose releasing the hold", "propose",
                "This hold protects against a problem that is not just the address. An admin approves the release.",
                ticket_ids=sorted(holds))
    add("hold", "Hold from email", "direct", "Keeps these tickets out of every email until released.")
    if k in ACK_KINDS and (i.priority in ACK_KINDS[k]):
        add("acknowledge", "Mark reviewed (keep as is)", "direct",
            "Records your decision with a note. The checks keep running; if the problem is real it stays visible on the order.")
    if k in ("paid_without_ticket", "qr_invalid", "duplicate_badge", "manual_review", "category_check"):
        add("request_admin", "Request admin action", "propose", "Sends this to Babak, Nima or Bita with your notes. Nothing changes until they act.")
    if not authz.can(db, me_caps["user"], event_id, "ticket.correct_details") and not is_admin:
        out = [a for a in out if a["key"] != "correct_holder"]
    return out


def _evidence(db, event_id, i, party):
    ids = set(int(x) for x in (i.attendee_ids or []) if str(x).isdigit())
    if party:
        ids |= {m["attendee_id"] for m in party["members"]}
    pays = []
    q = db.query(models.PaymentEvent).filter(models.PaymentEvent.event_id == event_id)
    from sqlalchemy import or_
    conds = [models.PaymentEvent.attendee_id.in_(list(ids) or [0])]
    if i.order_ids:
        conds.append(models.PaymentEvent.ghl_entity_id.in_(list(i.order_ids)))
    for pe in q.filter(or_(*conds)).order_by(models.PaymentEvent.occurred_at).all():
        pays.append({"order_id": pe.ghl_entity_id, "transaction": pe.ghl_transaction_id, "status": pe.status,
                     "amount": pe.amount, "refunded": pe.amount_refunded or 0, "products": EC._names(pe.product_names),
                     "paid_at": EC._iso(pe.occurred_at), "ticket_id": pe.attendee_id})
    tickets = []
    for t in sorted(ids):
        a = db.query(models.Attendee).filter(models.Attendee.id == t).first()
        if a is not None:
            tickets.append({"id": a.id, "name": EC._name(a), "email": (a.email or "").lower(), "pass": M._pass_display(db, a),
                            "status": M._ticket_status(a), "seat": (a.custom_data or {}).get("seat_of_party"),
                            "needs_name_check": bool((a.custom_data or {}).get("needs_name_check"))})
    return {"payments": pays, "tickets": tickets,
            "paid_for": (party or {}).get("paid_for"), "issued": len((party or {}).get("members") or []) or None,
            "missing": (party or {}).get("unnamed"), "possible_double_charges": (party or {}).get("possible_double_charges"),
            "facts": i.facts or {}}


def _stage(i, props):
    live = [p for p in props if p.state in ("proposed", "applying")]
    if not i.detected or i.status in ("resolved",):
        return "revalidated"
    if any(p.state == "applying" for p in live):
        return "confirmed"
    if live:
        return "correction_proposed"
    if any(p.state in ("applied", "applied_still_flagged") for p in props):
        return "corrected_still_flagged"
    if i.status == "reviewed":
        return "reviewed"
    if i.status == "in_review" or i.assigned_to:
        return "investigating"
    return "flagged"


def _users(db):
    return {u.id: (u.full_name or u.email) for u in db.query(models.User).all()}


def issue_view(db, event_id, i, user, users=None, with_detail=True):
    key, party = _booking_of_issue(db, event_id, i)
    props = db.query(models.ReconProposal).filter(models.ReconProposal.event_id == event_id,
                                                  models.ReconProposal.issue_id == i.id).order_by(models.ReconProposal.id).all()
    users = users or _users(db)
    correct, advice = GUIDE.get(i.kind, ("The records agree with what was bought.", "Read the explanation and decide."))
    v = {"id": i.id, "kind": i.kind, "kind_label": RC.KINDS.get(i.kind, i.kind), "priority": i.priority, "status": i.status,
         "detected": bool(i.detected), "booking": key, "title": i.title,
         "what_is_wrong": i.title, "why_flagged": i.explanation, "correct_result": correct,
         "recommended": i.recommendation or advice, "advice": advice,
         "assigned_to": i.assigned_to, "assigned_name": users.get(i.assigned_to),
         "stage": _stage(i, props), "updated_at": EC._iso(i.updated_at),
         "proposals": [proposal_view(p) for p in props]}
    if with_detail:
        caps = {"user": user}
        v["actions"] = actions_for(db, event_id, i, party, caps, bool(user.is_admin))
        v["evidence"] = _evidence(db, event_id, i, party)
        v["history"] = [{"at": EC._iso(h.at), "actor": h.actor, "kind": h.kind, "text": h.text, "before": h.before, "after": h.after}
                        for h in db.query(models.ReconHistory).filter(models.ReconHistory.issue_id == i.id).order_by(models.ReconHistory.id).all()]
    return v


def proposal_view(p):
    return {"id": p.id, "issue_id": p.issue_id, "booking": p.booking_key, "kind": p.kind, "steps": p.steps, "summary": p.summary,
            "current_value": p.current_value, "proposed_value": p.proposed_value, "evidence": p.evidence, "reason": p.reason,
            "root_cause": p.root_cause, "state": p.state, "proposed_by": p.proposed_by_name, "proposed_by_id": p.proposed_by,
            "proposed_at": EC._iso(p.proposed_at), "decided_by": p.decided_by_name, "decided_at": EC._iso(p.decided_at),
            "decision_note": p.decision_note, "applied_at": EC._iso(p.applied_at), "results": p.results, "validation": p.validation}


# ---------------------------------------------------------------------------
# Revalidation: the checks decide, never a button
# ---------------------------------------------------------------------------
def revalidate(db, event_id, issue_ids=(), booking_key=None, actor="Email Center re-check"):
    rerun = RC.run(db, event_id, actor=actor)
    db.commit()
    out = {"reconciliation": rerun, "issues": {}}
    for iid in issue_ids:
        i = db.query(models.ReconIssue).filter(models.ReconIssue.id == iid).first()
        if i is not None:
            db.refresh(i)
            out["issues"][str(iid)] = {"still_found": bool(i.detected), "status": i.status, "title": i.title}
    if booking_key:
        b, _ = EC.booking(db, event_id, booking_key)
        if b:
            out["booking"] = {"key": booking_key, "paid_for": b["paid_for"], "generated": b["tickets_generated"],
                              "qr_ok": b["qr_status"] == "ok", "blockers": [c["detail"] for c in b["critical"]],
                              "recipients": sorted({u["recipient"] for u in b["units"]}),
                              "can_approve": b["can_approve"], "review_state": b["review_state"]}
    return out


# ---------------------------------------------------------------------------
# Steps: each maps to ONE existing reconciliation action
# ---------------------------------------------------------------------------
def _step_body(step, note):
    a = step["action"]
    b = dict(step.get("body") or {})
    m = {"correct_holder": "fix_identity", "correct_ticket_email": "fix_identity", "set_delivery_email": "set_delivery_email",
         "rebuild_email": "rebuild_email", "hold": "hold", "release": "release", "release_contact": "release",
         "issue_seat": "issue_seat", "change_category": "change_category", "flag_duplicate": "mark_duplicate"}
    if a not in m:
        return None
    b["action"] = m[a]
    b["note"] = note
    b["confirm"] = True
    if a == "correct_holder":
        b.pop("email", None)            # a ticket email change is a separate, approved step
    return b


def run_step(db, event_id, step, note, user):
    """Carry out one step. Idempotent where the underlying action is: a seat
    is never issued above the paid quantity, a hold or release twice is the
    same state, a rebuild gives the same record."""
    a = step["action"]
    i = _issue(db, event_id, int(step["issue_id"]))
    if a == "issue_seat":
        key, party = _booking_of_issue(db, event_id, i)
        if not party or int(party.get("unnamed") or 0) < 1:
            return {"action": a, "state": "already_fulfilled", "note": "The booking already has every paid ticket; nothing created."}
    if a == "decide_duplicate":
        r = M._rc_set_status(db, event_id, i, {"status": "reviewed", "note": note,
                                               "real_seat": bool((step.get("body") or {}).get("real_seat"))}, user)
        return {"action": a, "state": "done", "status": r.get("status")}
    if a == "acknowledge":
        r = M._rc_set_status(db, event_id, i, {"status": "reviewed", "note": note}, user)
        return {"action": a, "state": "done", "status": r.get("status")}
    if a == "request_admin":
        RC._hist(db, i, "comment", "Admin action requested: %s" % note, actor=_who(user), user_id=user.id)
        db.commit()
        return {"action": a, "state": "done"}
    body = _step_body(step, note)
    if body is None:
        raise HTTPException(status_code=400, detail="Unknown correction")
    r = M._rc_execute(db, event_id, i, body, user)
    return {"action": a, "state": "done", "result": r.get("result"), "issue_status": r.get("status")}


def _signature(issue_id, steps):
    return hashlib.sha256(json.dumps({"i": issue_id, "s": steps}, sort_keys=True).encode()).hexdigest()


def _need_read(db, user, event_id):
    M._get_event_or_404(event_id, db)
    if not (authz.can(db, user, event_id, EC.CAP_READ) or user.is_admin):
        raise HTTPException(status_code=403, detail="Not permitted for this event")


def _need_review(db, user, event_id):
    M._get_event_or_404(event_id, db)
    if not (authz.can(db, user, event_id, EC.CAP_REVIEW) or user.is_admin):
        raise HTTPException(status_code=403, detail="Not permitted for this event")


def _validate_steps(db, event_id, i, steps, user, direct):
    key, party = _booking_of_issue(db, event_id, i)
    allowed = {a["key"]: a for a in actions_for(db, event_id, i, party, {"user": user}, bool(user.is_admin))}
    clean = []
    for s in steps:
        a = (s.get("action") or "").strip()
        if a not in allowed:
            raise HTTPException(status_code=400, detail="That correction does not apply to this problem")
        if direct and allowed[a]["mode"] != "direct":
            raise HTTPException(status_code=403, detail="This correction needs an admin's approval. Propose it instead.")
        body = dict(s.get("body") or {})
        if a == "issue_seat":
            n = int(body.get("count") or 1)
            if n < 1 or n > int((party or {}).get("unnamed") or 0):
                raise HTTPException(status_code=409, detail="The booking is missing %d ticket(s); that many can be proposed at most."
                                    % int((party or {}).get("unnamed") or 0))
            if not (body.get("first_name") or "").strip():
                raise HTTPException(status_code=400, detail="Enter the guest's first name (or 'Guest of' the buyer)")
            body["confirm_real_seat"] = True
            for _ in range(n):
                clean.append({"action": a, "issue_id": i.id, "body": {k: body.get(k) for k in ("first_name", "last_name", "email", "phone", "confirm_real_seat")}})
            continue
        if a in ("correct_holder", "correct_ticket_email", "change_category", "hold", "release", "release_contact"):
            tid = body.get("ticket_id")
            ids = set(int(x) for x in (i.attendee_ids or []) if str(x).isdigit()) | ({m["attendee_id"] for m in party["members"]} if party else set())
            if a in ("hold", "release", "release_contact"):
                body["ticket_ids"] = [int(x) for x in (body.get("ticket_ids") or allowed[a].get("ticket_ids") or ([tid] if tid else []))]
                if not body["ticket_ids"] or not set(body["ticket_ids"]) <= ids:
                    raise HTTPException(status_code=400, detail="Choose tickets of this order")
            elif tid is None or int(tid) not in ids:
                raise HTTPException(status_code=400, detail="Choose the ticket to correct")
        if a == "correct_ticket_email" and not EC.EMAIL_RE.match((body.get("email") or "").strip().lower()):
            raise HTTPException(status_code=400, detail="Enter a valid email address")
        if a == "set_delivery_email" and not EC.EMAIL_RE.match((body.get("email") or "").strip().lower()):
            raise HTTPException(status_code=400, detail="Enter a valid email address")
        if a == "decide_duplicate" and body.get("real_seat") is None:
            raise HTTPException(status_code=400, detail="Choose: real extra seat, or double charge")
        if a == "change_category" and not body.get("ticket_type_id"):
            raise HTTPException(status_code=400, detail="Choose the correct pass")
        clean.append({"action": a, "issue_id": i.id, "body": body})
    return clean, key, party


def _describe(db, event_id, steps, party):
    cur, new, words = [], [], []
    for s in steps:
        a, b = s["action"], s["body"]
        t = db.query(models.Attendee).filter(models.Attendee.id == int(b["ticket_id"])).first() if b.get("ticket_id") else None
        if a == "issue_seat":
            words.append("Create one missing ticket for %s %s (new QR code)." % (b.get("first_name") or "", b.get("last_name") or ""))
            cur.append({"tickets": len((party or {}).get("members") or []), "paid_for": (party or {}).get("paid_for")})
            new.append({"tickets": len((party or {}).get("members") or []) + 1})
        elif a == "change_category":
            tt = db.query(models.TicketType).filter(models.TicketType.id == int(b["ticket_type_id"])).first()
            words.append("Change ticket %s's pass from %s to %s." % (b["ticket_id"], M._pass_display(db, t) if t else "?", tt.name if tt else "?"))
            cur.append({"ticket": b["ticket_id"], "pass": M._pass_display(db, t) if t else None}); new.append({"ticket": b["ticket_id"], "pass": tt.name if tt else None})
        elif a == "correct_ticket_email":
            words.append("Change ticket %s's email." % b["ticket_id"])
            cur.append({"ticket": b["ticket_id"], "email": (t.email if t else None)}); new.append({"ticket": b["ticket_id"], "email": b.get("email")})
        elif a in ("release", "release_contact"):
            words.append("Release ticket(s) %s from the email hold." % ", ".join(map(str, b["ticket_ids"])))
            cur.append({"held": b["ticket_ids"]}); new.append({"held": []})
        elif a == "decide_duplicate":
            words.append("Record the payments as %s." % ("a real extra seat" if b.get("real_seat") else "a double charge (refund in GHL)"))
        elif a == "request_admin":
            words.append("Ask an admin to act.")
        else:
            words.append(a.replace("_", " ").capitalize() + ".")
    return " ".join(words), cur, new


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.get(P + "/bookings/{key}/problems")
def ec_booking_problems(event_id: int, key: str, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    """Every reconciliation problem on this order, explained, with what can be done."""
    _need_read(db, current_user, event_id)
    b, _ = EC.booking(db, event_id, key)
    if not b:
        raise HTTPException(status_code=404, detail="Booking not found")
    ids = {t["id"] for t in b["tickets"]}
    users = _users(db)
    out = []
    for i in db.query(models.ReconIssue).filter(models.ReconIssue.event_id == event_id).all():
        a_ids = set(int(x) for x in (i.attendee_ids or []) if str(x).isdigit())
        if (a_ids & ids or (i.buyer_attendee_id in ids)) and (i.detected or i.status not in ("dismissed",)):
            if not i.detected and i.status == "resolved" and not db.query(models.ReconProposal).filter(models.ReconProposal.issue_id == i.id).count():
                continue    # long-cleared and never touched here: noise
            out.append(issue_view(db, event_id, i, current_user, users))
    stage = ("send" if b["sendable"] or b["delivery"] not in ("not_sent",) else "approve" if not b["critical"] and b["review_state"] != "approved"
             else "fix" if b["critical"] else "approve")
    return {"key": key, "problems": out, "workflow_stage": stage,
            "summary": [c["detail"] for c in b["critical"]], "warnings": [w["detail"] for w in b["warnings"]]}


@router.post(P + "/issues/{issue_id}/fix")
def ec_fix(event_id: int, issue_id: int, body: dict, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    """Apply a LOW-RISK correction now (reviewer). It goes through the same
    reconciliation action, then everything is re-checked."""
    _need_review(db, current_user, event_id)
    i = _issue(db, event_id, issue_id)
    note = (body.get("note") or "").strip()
    if len(note) < 5:
        raise HTTPException(status_code=400, detail="Say what you checked and why (a short note)")
    if body.get("confirm") is not True:
        raise HTTPException(status_code=428, detail="Confirm the correction first")
    steps, key, _ = _validate_steps(db, event_id, i, [{"action": body.get("action"), "body": body.get("body") or {}}], current_user, direct=True)
    results = [run_step(db, event_id, s, "Email Center: " + note, current_user) for s in steps]
    v = revalidate(db, event_id, [i.id], key, actor="re-check after %s" % _who(current_user))
    s = EC._store()
    try:
        s.audit(EC._who(current_user), "email_center_fix_" + steps[0]["action"], event_id, key, note, {"issue": i.id, "results": results})
    finally:
        s.close()
    return {"ok": True, "results": results, "validation": v}


@router.post(P + "/issues/{issue_id}/propose")
def ec_propose(event_id: int, issue_id: int, body: dict, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    """Propose a correction for an admin to approve. The same correction cannot
    be pending twice."""
    _need_review(db, current_user, event_id)
    i = _issue(db, event_id, issue_id)
    reason = (body.get("reason") or "").strip()
    if len(reason) < 10 and not body.get("dry_run"):
        raise HTTPException(status_code=400, detail="Explain what is wrong and what supports the correction (at least a sentence)")
    root = body.get("root_cause") or "unknown"
    if root not in ROOT_CAUSES:
        raise HTTPException(status_code=400, detail="Unknown root cause")
    raw = body.get("steps") or [{"action": body.get("action"), "body": body.get("body") or {}}]
    steps, key, party = _validate_steps(db, event_id, i, raw, current_user, direct=False)
    if any(st_["action"] == "issue_seat" for st_ in steps) and party:
        # Creating a seat means the payments were real seats: the open
        # duplicate-payment case of the same booking is decided in the same
        # approval, first -- otherwise the order would stay blocked by it.
        dup = db.query(models.ReconIssue).filter(models.ReconIssue.event_id == event_id,
                                                 models.ReconIssue.issue_key == "duplicate-payment:%d" % party["buyer_attendee_id"],
                                                 models.ReconIssue.detected == True,   # noqa: E712
                                                 models.ReconIssue.status.in_(("open", "in_review"))).first()
        if dup is not None and not any(st_["action"] == "decide_duplicate" for st_ in steps):
            steps = [{"action": "decide_duplicate", "issue_id": dup.id, "body": {"real_seat": True}}] + steps
        # Holds that exist only BECAUSE seats were missing (more paid lines
        # than tickets) are released once the seat exists; the release also
        # rebuilds the email record so every ticket is in the buyer's email.
        # Any other hold (address, do-not-email, ...) stays for its own decision.
        ids = {m["attendee_id"] for m in party["members"]}
        qty_holds = sorted(t for t, h in _holds_for(db, event_id, ids).items()
                           if any(w in (h.reason or "") for w in QUANTITY_HOLD_WORDS))
        if qty_holds and not any(st_["action"] == "release" for st_ in steps):
            steps = steps + [{"action": "release", "issue_id": i.id, "body": {"ticket_ids": qty_holds}}]
    sig = _signature(i.id, steps)
    if body.get("dry_run"):
        # Preview: exactly what would be proposed (including steps the server
        # adds), without saving anything.
        summary, cur, new = _describe(db, event_id, steps, party)
        return {"ok": True, "dry_run": True, "proposal": {"summary": summary, "steps": steps, "current_value": cur,
                                                          "proposed_value": new, "state": "preview"}}
    pending = db.query(models.ReconProposal).filter(models.ReconProposal.event_id == event_id, models.ReconProposal.signature == sig,
                                                    models.ReconProposal.state.in_(("proposed", "applying"))).first()
    if pending:
        raise HTTPException(status_code=409, detail="This exact correction is already waiting for approval (proposal %d)." % pending.id)
    summary, cur, new = _describe(db, event_id, steps, party)
    p = models.ReconProposal(event_id=event_id, issue_id=i.id, booking_key=key, kind=i.kind, steps=steps, signature=sig,
                             summary=summary, current_value=cur, proposed_value=new, evidence=_evidence(db, event_id, i, party),
                             reason=reason, root_cause=root, state="proposed", proposed_by=current_user.id,
                             proposed_by_name=_who(current_user), proposed_at=_now())
    db.add(p)
    if i.status == "open":
        i.status = "in_review"
    RC._hist(db, i, "comment", "Correction proposed: %s Reason: %s" % (summary, reason), actor=_who(current_user), user_id=current_user.id)
    db.commit()
    return {"ok": True, "proposal": proposal_view(p)}


@router.get(P + "/proposals")
def ec_proposals(event_id: int, state: str = "proposed", db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need_read(db, current_user, event_id)
    q = db.query(models.ReconProposal).filter(models.ReconProposal.event_id == event_id)
    if state != "all":
        q = q.filter(models.ReconProposal.state.in_(state.split(",")))
    return {"items": [proposal_view(p) for p in q.order_by(models.ReconProposal.id.desc()).limit(300).all()],
            "can_decide": bool(current_user.is_admin)}


@router.post(P + "/proposals/{pid}/decide")
def ec_decide(event_id: int, pid: int, body: dict, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    """Approve (and apply) or reject a proposal. Platform admins only, and
    never the person who proposed it. Applied exactly once."""
    M._get_event_or_404(event_id, db)
    authz.require_admin(current_user)
    decision = body.get("decision")
    note = (body.get("note") or "").strip()
    if decision not in ("approve", "reject", "retry") or len(note) < 3:
        raise HTTPException(status_code=400, detail="Approve or reject, with a short note")
    p = db.query(models.ReconProposal).filter(models.ReconProposal.id == pid, models.ReconProposal.event_id == event_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Proposal not found")
    if p.proposed_by == current_user.id:
        raise HTTPException(status_code=403, detail="The person who proposed a correction cannot approve it. Ask another admin.")
    i = _issue(db, event_id, p.issue_id)
    if decision == "reject":
        n = db.query(models.ReconProposal).filter(models.ReconProposal.id == pid, models.ReconProposal.state == "proposed").update(
            {"state": "rejected", "decided_by": current_user.id, "decided_by_name": _who(current_user), "decided_at": _now(),
             "decision_note": note}, synchronize_session=False)
        if n != 1:
            raise HTTPException(status_code=409, detail="This proposal was already decided")
        RC._hist(db, i, "comment", "Correction rejected: %s" % note, actor=_who(current_user), user_id=current_user.id)
        db.commit()
        return {"ok": True, "state": "rejected"}
    # Claim it: only one approver, one application, even with two clicks at once.
    from_states = ("proposed",) if decision == "approve" else ("failed",)
    n = db.query(models.ReconProposal).filter(models.ReconProposal.id == pid, models.ReconProposal.state.in_(from_states)).update(
        {"state": "applying", "decided_by": current_user.id, "decided_by_name": _who(current_user), "decided_at": _now(),
         "decision_note": note}, synchronize_session=False)
    db.commit()
    if n != 1:
        raise HTTPException(status_code=409, detail="This proposal was already decided or is being applied")
    db.refresh(p)
    results, failed = list(p.results or []) if decision == "retry" else [], False
    done_idx = {r.get("index") for r in results if r.get("state") in ("done", "already_fulfilled")}
    for idx, step in enumerate(p.steps or []):
        if idx in done_idx:
            continue
        try:
            r = run_step(db, event_id, step, "Approved correction #%d (%s): %s" % (p.id, p.proposed_by_name, p.reason), current_user)
        except HTTPException as e:
            db.rollback()
            r, failed = {"action": step["action"], "state": "failed", "error": e.detail}, True
        except Exception as e:
            db.rollback()
            r, failed = {"action": step["action"], "state": "failed", "error": type(e).__name__}, True
        r["index"] = idx
        results = [x for x in results if x.get("index") != idx] + [r]
        if failed:
            break
    v = revalidate(db, event_id, [i.id], p.booking_key, actor="re-check after approved correction #%d" % p.id)
    still = v["issues"].get(str(i.id), {}).get("still_found")
    state = "failed" if failed else ("applied_still_flagged" if still else "applied")
    db.query(models.ReconProposal).filter(models.ReconProposal.id == pid).update(
        {"state": state, "results": results, "validation": v, "applied_at": _now()}, synchronize_session=False)
    RC._hist(db, i, "comment", "Correction #%d %s by %s. Re-check: %s." % (
        p.id, "applied" if not failed else "FAILED", _who(current_user),
        "the problem is still found" if still else "the problem no longer appears"), actor=_who(current_user), user_id=current_user.id)
    db.commit()
    s = EC._store()
    try:
        s.audit(EC._who(current_user), "email_center_correction_" + state, event_id, p.booking_key, note, {"proposal": p.id})
    finally:
        s.close()
    return {"ok": not failed, "state": state, "results": results, "validation": v}


@router.post(P + "/proposals/{pid}/withdraw")
def ec_withdraw(event_id: int, pid: int, body: dict, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need_review(db, current_user, event_id)
    p = db.query(models.ReconProposal).filter(models.ReconProposal.id == pid, models.ReconProposal.event_id == event_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Proposal not found")
    if p.proposed_by != current_user.id and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Only the person who proposed it can withdraw it")
    n = db.query(models.ReconProposal).filter(models.ReconProposal.id == pid, models.ReconProposal.state == "proposed").update(
        {"state": "withdrawn", "decision_note": (body.get("note") or "withdrawn")[:300], "decided_at": _now()}, synchronize_session=False)
    db.commit()
    if n != 1:
        raise HTTPException(status_code=409, detail="Only a waiting proposal can be withdrawn")
    return {"ok": True}


@router.post(P + "/issues/{issue_id}/assign")
def ec_issue_assign(event_id: int, issue_id: int, body: dict, db: Session = Depends(M.get_db),
                    current_user: models.User = Depends(M.get_current_user)):
    """Assign (to me, or to another reviewer/admin) and start the review. Same
    field and history as Ticket Reconciliation."""
    _need_review(db, current_user, event_id)
    i = _issue(db, event_id, issue_id)
    uid = current_user.id if body.get("me") else body.get("user_id")
    if uid is not None:
        u = db.query(models.User).filter(models.User.id == int(uid)).first()
        if not u or not (u.is_admin or authz.can(db, u, event_id, EC.CAP_REVIEW) or authz.can(db, u, event_id, "reconcile.resolve")):
            raise HTTPException(status_code=400, detail="That person cannot work on ticket problems for this event")
    users = _users(db)
    before = users.get(i.assigned_to)
    i.assigned_to = int(uid) if uid is not None else None
    if i.status == "open" and uid is not None:
        i.status = "in_review"
    RC._hist(db, i, "assign", "Assigned to %s" % (users.get(i.assigned_to) or "nobody"), actor=_who(current_user),
             user_id=current_user.id, before={"assigned": before}, after={"assigned": users.get(i.assigned_to)})
    i.updated_at = _now()
    db.commit()
    return {"ok": True}


@router.post(P + "/issues/{issue_id}/comment")
def ec_issue_comment(event_id: int, issue_id: int, body: dict, db: Session = Depends(M.get_db),
                     current_user: models.User = Depends(M.get_current_user)):
    _need_review(db, current_user, event_id)
    i = _issue(db, event_id, issue_id)
    t = (body.get("text") or "").strip()
    if len(t) < 2:
        raise HTTPException(status_code=400, detail="Write the note first")
    RC._hist(db, i, "comment", t[:4000], actor=_who(current_user), user_id=current_user.id)
    i.updated_at = _now()
    db.commit()
    return {"ok": True}


@router.post(P + "/bookings/{key}/revalidate")
def ec_revalidate(event_id: int, key: str, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    """Re-run every check now: reconciliation, then this order's ticket checks."""
    _need_review(db, current_user, event_id)
    b, _ = EC.booking(db, event_id, key)
    if not b:
        raise HTTPException(status_code=404, detail="Booking not found")
    return revalidate(db, event_id, [], key, actor="re-check by %s" % _who(current_user))


@router.get(P + "/reviewers")
def ec_reviewers(event_id: int, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need_read(db, current_user, event_id)
    out = []
    for u in db.query(models.User).all():
        if u.is_admin or authz.can(db, u, event_id, EC.CAP_REVIEW):
            out.append({"id": u.id, "name": u.full_name or u.email, "admin": bool(u.is_admin)})
    return {"items": out, "me": current_user.id}


@router.get(P + "/pass-options")
def ec_pass_options(event_id: int, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need_read(db, current_user, event_id)
    return {"items": [{"id": t.id, "name": t.name} for t in db.query(models.TicketType).filter(models.TicketType.event_id == event_id).all()]}


# ---------------------------------------------------------------------------
# Needs Attention: one item per real problem
# ---------------------------------------------------------------------------
CODE_KINDS = {"MISSING_TICKETS": ("incomplete_booking", "paid_without_ticket", "incomplete_delivery"),
              "HELD": None, "RECONCILIATION": None, "QR_INVALID": ("qr_invalid",), "DUPLICATE_BADGE": ("duplicate_badge",),
              "DUPLICATE_QR": ("qr_invalid",), "NO_VALID_EMAIL": ("holder_details", "contact_unverified")}


# Problems that are about the ticket email itself are always shown; other
# low/medium cases only when their order is blocked (otherwise they are
# warnings on the order and live in Ticket Reconciliation).
EMAIL_KINDS = {"contact_unverified", "holder_details", "email_suppressed", "delivery_failed", "missing_from_email_list",
               "incomplete_delivery", "incomplete_booking", "qr_invalid", "duplicate_badge"}


def work_queue(db, event_id, user):
    built = EC.bookings(db, event_id)
    by_ticket = {t["id"]: b for b in built["bookings"] for t in b["tickets"]}
    users = _users(db)
    issues = db.query(models.ReconIssue).filter(models.ReconIssue.event_id == event_id).all()
    props = {}
    for p in db.query(models.ReconProposal).filter(models.ReconProposal.event_id == event_id).all():
        props.setdefault(p.issue_id, []).append(p)
    items, covered = [], {}

    def item(**kw):
        kw.setdefault("history", 0)
        items.append(kw)
    for i in issues:
        ids = set(int(x) for x in (i.attendee_ids or []) if str(x).isdigit())
        if i.buyer_attendee_id:
            ids.add(i.buyer_attendee_id)
        bks = {by_ticket[t]["key"]: by_ticket[t] for t in ids if t in by_ticket}
        b = next(iter(bks.values()), None)
        active = i.detected and i.status in ("open", "in_review")
        resolved = (not i.detected and i.status == "resolved" and props.get(i.id)) or (i.status == "reviewed" and props.get(i.id))
        if not active and not resolved:
            continue
        # Only what touches the ticket emails (the rest lives in Ticket Reconciliation).
        affects = b is not None and (i.priority in ("critical", "high") or i.kind in EMAIL_KINDS
                                     or (b["delivery"] == "not_sent" and bool(b["critical"])))
        if not affects and not resolved:
            continue
        for k in bks:
            covered.setdefault(k, set()).add(i.kind)
        pl = props.get(i.id, [])
        item(key="issue:%d" % i.id, issue_id=i.id, booking=b["key"] if b else None,
             order_number=b["order_number"] if b else None, customer=b["purchaser_name"] if b else None,
             problem=i.title, kind=i.kind, kind_label=RC.KINDS.get(i.kind, i.kind), severity=i.priority,
             recommended_action=GUIDE.get(i.kind, (None, i.recommendation))[1],
             stage=_stage(i, pl), status="resolved" if not active else ("awaiting_approval" if any(p.state == "proposed" for p in pl) else i.status),
             assigned_to=i.assigned_to, assigned_name=users.get(i.assigned_to), last_update=EC._iso(i.updated_at),
             awaiting_approval=any(p.state == "proposed" for p in pl), proposals=len(pl),
             ready_to_fix=active and not any(p.state == "proposed" for p in pl),
             blocks_email=i.priority in ("critical", "high"))
    # Order problems the reconciliation checks do not already describe.
    for b in built["bookings"]:
        have = covered.get(b["key"], set())
        for c in b["critical"]:
            kinds = CODE_KINDS.get(c["code"], ())
            if kinds is None or (kinds and have & set(kinds)) or c["code"] == "RECONCILIATION":
                continue
            item(key="%s:%s" % (b["key"], c["code"].lower()), issue_id=None, booking=b["key"], order_number=b["order_number"],
                 customer=b["purchaser_name"], problem=c["detail"], kind=c["code"].lower(), kind_label=c["code"].replace("_", " ").title(),
                 severity="critical", recommended_action="Open the order and follow the recommendation.", stage="flagged", status="open",
                 assigned_to=None, assigned_name=None, last_update=None, awaiting_approval=False, proposals=0,
                 ready_to_fix=True, blocks_email=True)
        if b["changed_since_review"]:
            item(key="%s:changed" % b["key"], issue_id=None, booking=b["key"], order_number=b["order_number"], customer=b["purchaser_name"],
                 problem="Changed after it was %s; review it again" % (b["review"].get("state") or "approved"), kind="approval_invalidated",
                 kind_label="Review again", severity="medium", recommended_action="Open the order, check it, approve again.",
                 stage="flagged", status="open", assigned_to=None, assigned_name=None, last_update=b["review"].get("updated_at"),
                 awaiting_approval=False, proposals=0, ready_to_fix=True, blocks_email=True)
        if b["review_state"] == "needs_correction":
            item(key="%s:flagged" % b["key"], issue_id=None, booking=b["key"], order_number=b["order_number"], customer=b["purchaser_name"],
                 problem="Flagged by a reviewer: %s" % (b["review"].get("note") or ""), kind="flagged", kind_label="Flagged by reviewer",
                 severity="medium", recommended_action="Correct it, then review again.", stage="investigating", status="in_review",
                 assigned_to=None, assigned_name=b["review"].get("reviewed_by"), last_update=b["review"].get("updated_at"),
                 awaiting_approval=False, proposals=0, ready_to_fix=True, blocks_email=True)
        if b["delivery"] in ("failed", "bounced", "unknown", "partially_sent") and "delivery_failed" not in have:
            item(key="%s:delivery" % b["key"], issue_id=None, booking=b["key"], order_number=b["order_number"], customer=b["purchaser_name"],
                 problem={"failed": "Ticket email failed", "bounced": "Ticket email bounced", "unknown": "Delivery uncertain",
                          "partially_sent": "Only some of this order's emails were sent"}[b["delivery"]],
                 kind="delivery_" + b["delivery"], kind_label="Email delivery", severity="high",
                 recommended_action=("Check the message in GHL, then settle it; never resend blind." if b["delivery"] == "unknown"
                                     else "Check the address, correct it if needed, then retry."),
                 stage="flagged", status="open", assigned_to=None, assigned_name=None, last_update=b["last_sent"],
                 awaiting_approval=False, proposals=0, ready_to_fix=True, blocks_email=False)
    # Exhibitors (unchanged rules).
    s = EC._store()
    try:
        exr = EC.exhibitor_rows(db, event_id, s)
    finally:
        s.close()
    for r in exr:
        rel = "%s (booth %s)" % (r["company_name"], r["booth_number"] or "?")
        base = dict(issue_id=None, booking=None, order_number=None, customer=rel, exhibitor=r["id"], assigned_to=None, assigned_name=None,
                    last_update=None, awaiting_approval=False, proposals=0, ready_to_fix=True, blocks_email=False, stage="flagged", status="open")
        if not r["email_valid"]:
            item(key="ex%d:email" % r["id"], problem="No contact email for this stand", kind="exhibitor_no_email", kind_label="Exhibitor contact",
                 severity="high", recommended_action="Update Contact in Exhibitor Emails.", **base)
        if r["setup_link"] in ("none", "expired") and not r["profile_activated_at"]:
            item(key="ex%d:setup" % r["id"], problem="No valid setup link", kind="exhibitor_no_setup_link", kind_label="Exhibitor link",
                 severity="medium", recommended_action="Generate the link: send the setup invitation or Copy link.", **base)
        if r["eligible_for_scanning"] and not r["scanning_enabled"]:
            item(key="ex%d:scan" % r["id"], problem="Paid/complimentary stand with scanning switched off", kind="exhibitor_scanner_off",
                 kind_label="Exhibitor scanner", severity="medium", recommended_action="An organiser decides in Exhibitors whether to switch scanning on.", **base)
        if r["amount_mismatch"]:
            item(key="ex%d:pay" % r["id"], problem="Marked paid, but %s of %s received" % (r["amount_paid"], r["amount_due"]),
                 kind="exhibitor_payment", kind_label="Exhibitor payment", severity="medium", recommended_action="Check the payment in the planning sheet.", **base)
        for kind in ("setup", "scanner"):
            if r[kind]["status"] in ("failed", "bounced", "unknown"):
                item(key="ex%d:%s:delivery" % (r["id"], kind), problem="%s email %s" % (kind.capitalize(), r[kind]["status"]),
                     kind="exhibitor_delivery", kind_label="Exhibitor email", severity="high", recommended_action="Check in GHL, then resend.", **base)
    # Systemic causes: the same root cause corrected again and again is a bug.
    causes = {}
    for pl in props.values():
        for p in pl:
            if p.root_cause in ("mapping", "ticket_generation", "guest_assignment", "payment_sync") and p.state not in ("rejected", "withdrawn"):
                causes.setdefault(p.root_cause, []).append(p.id)
    for cause, ids in causes.items():
        if len(ids) >= 2:
            item(key="systemic:%s" % cause, issue_id=None, booking=None, order_number=None, customer=None,
                 problem="%d corrections blamed on %s: probably a system bug, not individual mistakes" % (len(ids), cause.replace("_", " ")),
                 kind="systemic", kind_label="Possible system bug", severity="high",
                 recommended_action="Tell the developer: fix the cause so new orders stop needing this correction.",
                 stage="flagged", status="open", assigned_to=None, assigned_name=None, last_update=None,
                 awaiting_approval=False, proposals=len(ids), ready_to_fix=False, blocks_email=False)
    # Work-queue marks for items that are not reconciliation issues.
    s = EC._store()
    try:
        marks = {r[0]: r for r in s.db.execute("select item_key,status,assigned_to,note,updated_by,updated_at from ec_attention where event_id=?", (event_id,))}
    finally:
        s.close()
    for it in items:
        m = marks.get(it["key"])
        if m and not it.get("issue_id"):
            it["assigned_name"] = it.get("assigned_name") or m[2]
            it["note"] = m[3]
            it["last_update"] = it.get("last_update") or m[5]
            if m[1] == "in_progress":
                it["stage"] = "investigating"
    sev = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    items.sort(key=lambda x: (x["status"] == "resolved", sev.get(x["severity"], 9), x["key"]))
    for it in items:
        it["assigned_to_me"] = it.get("assigned_to") == user.id
    return items


@router.get(P + "/queue")
def ec_queue(event_id: int, filter: str = "", db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need_read(db, current_user, event_id)
    items = work_queue(db, event_id, current_user)
    f = {"critical": lambda x: x["severity"] == "critical" and x["status"] != "resolved",
         "high": lambda x: x["severity"] == "high" and x["status"] != "resolved",
         "medium": lambda x: x["severity"] == "medium" and x["status"] != "resolved",
         "low": lambda x: x["severity"] == "low" and x["status"] != "resolved",
         "mine": lambda x: x["assigned_to_me"] and x["status"] != "resolved",
         "awaiting_approval": lambda x: x["awaiting_approval"],
         "ready_to_fix": lambda x: x["ready_to_fix"] and x["status"] != "resolved",
         "resolved": lambda x: x["status"] == "resolved",
         "open": lambda x: x["status"] != "resolved"}.get(filter or "open")
    counts = {}
    for it in items:
        if it["status"] != "resolved":
            counts[it["kind_label"]] = counts.get(it["kind_label"], 0) + 1
    shown = [x for x in items if f(x)] if f else items
    return {"items": shown, "count": len(shown), "open": sum(1 for x in items if x["status"] != "resolved"),
            "by_category": counts, "awaiting_approval": sum(1 for x in items if x["awaiting_approval"])}
