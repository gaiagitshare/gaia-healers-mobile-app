# -*- coding: utf-8 -*-
"""Email Center (10 Nov 2026): review, approve and send the ticket emails, and
the exhibitor emails, from the admin panel.

What it is built on, unchanged:
  * the send list and holds the Ticket Reconciliation Center keeps
    (email_plan, email_holds, recon_issues) -- the authoritative place for
    fixing ticket problems; nothing here edits a ticket, a payment or a hold;
  * the bulk-email rules (_bulk_check): duplicate QR/badge, wrong holder, a
    booking getting fewer tickets than it paid for;
  * the shared delivery history and its claim (ticket_delivery.state): one
    email per order, ever, unless a person resends with a reason; an email
    whose outcome is uncertain is never sent again automatically;
  * the reviewed ticket template (ticket_delivery.ticket_email) and the GHL
    send route the bulk and automatic senders use.

What it adds:
  * BOOKINGS as the review unit -- a buyer and every seat they paid for, with
    the emails (send units) that carry those tickets;
  * a review state per booking, tied to a fingerprint of exactly what was
    reviewed: change a ticket, a pass, a recipient, a payment or the template
    and the approval no longer counts;
  * an Email Center sending switch, OFF until a platform admin turns it on.
    The automatic sender's shadow lock and the global pause are untouched and
    still respected (paused = nothing sends from here either);
  * batches that survive a refresh, a double click and a restart.
"""
import csv
import hashlib
import io
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, Response
from sqlalchemy.orm import Session

import authz
import main as M
import models
from ticket_delivery import ec_store, exhibitor_email
from ticket_delivery import state as st
from ticket_delivery import ticket_email

router = APIRouter()

PUBLIC = "https://api.gaiahealers.app"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
QR_RE = re.compile(r"^ATT-[0-9A-F]{6,}$")
SEAT_TAG = re.compile(r"\+seat\d+@", re.I)
AUTO_CUTOFF = "2026-11-03T15:46:00"
PAID_SOURCES = ("ghl_order", "ghl_invoice", "ghl_webhook")
BATCH_LIMIT = 500
STALE_SECONDS = 90          # a running batch whose heartbeat is older than this was interrupted
SEND_PAUSE_SECONDS = float(os.environ.get("EMAIL_CENTER_SEND_PAUSE", "0.6"))

CAP_READ, CAP_REVIEW, CAP_SEND, CAP_EXPORT = ("ticket_email.read", "ticket_email.review",
                                              "ticket_email.send", "ticket_email.export")


# ---------------------------------------------------------------------------
# Plumbing
# ---------------------------------------------------------------------------
def _store():
    s = st.DeliveryState()
    ec_store.ensure(s.db)
    return s


def _who(user):
    return "admin:%s" % (getattr(user, "email", None) or getattr(user, "id", "?"))


def _need(db, user, event_id, cap):
    M._get_event_or_404(event_id, db)
    authz.require_cap(db, user, event_id, cap)


def _template_sha():
    return hashlib.sha256(open(ticket_email.__file__, "rb").read()).hexdigest()


def _sha(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()


def _iso(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return (v if v.tzinfo else v.replace(tzinfo=timezone.utc)).isoformat()
    return str(v)


def _name(a):
    return " ".join(x for x in [a.first_name or "", a.last_name or ""] if x).strip()


def _cd(a):
    cd = a.custom_data or {}
    if isinstance(cd, str):
        try:
            cd = json.loads(cd or "{}")
        except ValueError:
            cd = {}
    return cd


def _names(v):
    if isinstance(v, (list, tuple)):
        return list(v)
    try:
        x = json.loads(v or "[]")
        return x if isinstance(x, list) else [str(x)]
    except (ValueError, TypeError):
        return [str(v)] if v else []


# ---------------------------------------------------------------------------
# GHL: the real gateway, and the stand-in used on staging and in tests
# ---------------------------------------------------------------------------
class Gateway:
    """GHL reads for the send-time recheck, the send itself, and status."""
    fake = False

    def __init__(self):
        from ticket_delivery import engine
        self._engine = engine
        self.live = engine.Live()
        self.loc = self.live.location

    def ghl(self, path):
        return self.live.ghl(path)

    def contact(self, contact_id):
        return self.ghl("/contacts/%s" % contact_id).get("contact", {})

    def find_contacts(self, email):
        import urllib.parse
        found = self.ghl("/contacts/?locationId=%s&query=%s&limit=10" % (self.loc, urllib.parse.quote(email))).get("contacts", [])
        return [c for c in found if (c.get("email") or "").strip().lower() == email]

    def order(self, order_id, source):
        if source == "ghl_invoice":
            j = self.ghl("/invoices/%s?altId=%s&altType=location" % (order_id, self.loc))
            return j.get("invoice", j)
        j = self.ghl("/payments/orders/%s?altId=%s&altType=location" % (order_id, self.loc))
        return j.get("order", j)

    def transactions(self, order_id):
        return self.ghl("/payments/transactions?altId=%s&altType=location&entityId=%s&limit=50" % (self.loc, order_id)).get("data", [])

    def send(self, contact_id, payload):
        return self.live.send(contact_id, payload)

    def status(self, message_id):
        return self._engine.provider_status(self.live, message_id)


class FakeGateway:
    """Staging and tests: no network, ever. Behaviour comes from a JSON file
    (EMAIL_CENTER_FAKE); every 'sent' email is appended to an outbox file
    (EMAIL_CENTER_FAKE_OUTBOX) so a test can read exactly what went out.

      {"no_contact": [emails], "dnd": [emails], "refunded_orders": [ids],
       "unpaid_orders": [ids], "reject": [emails], "ambiguous": [emails],
       "status": {"default": "delivered", "<email>": "bounced"}}
    """
    fake = True

    def __init__(self, path):
        self.path = path
        try:
            self.cfg = json.load(open(path))
        except (OSError, ValueError):
            self.cfg = {}
        self.outbox = os.environ.get("EMAIL_CENTER_FAKE_OUTBOX") or (path + ".outbox.jsonl")

    def _l(self, k):
        return {x.lower() for x in self.cfg.get(k, [])}

    def contact(self, contact_id):
        return {"id": contact_id, "email": None}

    def find_contacts(self, email):
        if email in self._l("no_contact"):
            return []
        c = {"id": "fake-" + hashlib.sha256(email.encode()).hexdigest()[:12], "email": email}
        if email in self._l("dnd"):
            c["dnd"] = True
        return [c]

    def order(self, order_id, source):
        if order_id in set(self.cfg.get("unpaid_orders", [])):
            return {"status": "pending", "paymentStatus": "unpaid", "liveMode": True}
        return {"status": "completed" if source != "ghl_invoice" else "paid", "paymentStatus": "paid", "liveMode": True}

    def transactions(self, order_id):
        if order_id in set(self.cfg.get("refunded_orders", [])):
            return [{"status": "refunded", "amountRefunded": 1, "liveMode": True}]
        return [{"status": "succeeded", "liveMode": True}]

    def send(self, contact_id, payload):
        email = payload.get("_to", "")
        rec = {"at": ec_store.now(), "contact_id": contact_id, "to": email, "subject": payload.get("subject"),
               "html_sha": hashlib.sha256((payload.get("html") or "").encode()).hexdigest()}
        if email in self._l("ambiguous"):
            rec["result"] = "ambiguous"
            self._append(rec)
            raise TimeoutError("fake: no answer from the provider")
        if email in self._l("reject"):
            rec["result"] = "rejected"
            self._append(rec)
            return {"ok": False, "reason": "ghl_error", "definitely_rejected": True}
        mid = "fake-msg-" + uuid.uuid4().hex[:12]
        rec.update(result="accepted", message_id=mid)
        self._append(rec)
        return {"ok": True, "messageId": mid}

    def status(self, message_id):
        s = self.cfg.get("status") or {}
        try:
            for line in open(self.outbox):
                r = json.loads(line)
                if r.get("message_id") == message_id:
                    return str(s.get(r.get("to"), s.get("default", "delivered")))
        except OSError:
            pass
        return "unknown"

    def _append(self, rec):
        with open(self.outbox, "a") as f:
            f.write(json.dumps(rec) + "\n")


def gateway():
    fake = os.environ.get("EMAIL_CENTER_FAKE")
    return FakeGateway(fake) if fake else Gateway()


# ---------------------------------------------------------------------------
# Bookings: what was bought, what exists, what would be emailed
# ---------------------------------------------------------------------------
_CACHE = {}
_CACHE_LOCK = threading.Lock()
CACHE_SECONDS = float(os.environ.get("EMAIL_CENTER_CACHE_SECONDS", "20"))


def invalidate():
    with _CACHE_LOCK:
        _CACHE.clear()


def booking(db, event_id, key):
    """One booking, built fresh (fast: only its own party is checked), and
    swapped into the cached list so the next list load shows it."""
    if not re.match(r"^B\d+$", key or ""):
        return None, None
    s = _store()
    try:
        one = _build(db, event_id, s, only_buyer=int(key[1:]))
    finally:
        s.close()
    b = one["by_key"].get(key)
    with _CACHE_LOCK:
        hit = _CACHE.get(event_id)
        if hit:
            lst = hit[1]
            if b is not None and key in lst["by_key"]:
                lst["bookings"] = [b if x["key"] == key else x for x in lst["bookings"]]
                lst["by_key"][key] = b
    return b, one


def bookings(db, event_id, fresh=False):
    with _CACHE_LOCK:
        hit = _CACHE.get(event_id)
        if hit and not fresh and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    s = _store()
    try:
        out = _build(db, event_id, s)
    finally:
        s.close()
    with _CACHE_LOCK:
        _CACHE[event_id] = (time.time(), out)
    return out


def _holder_email(a, by_id):
    """Where this ticket's email goes: the holder; a party seat's to its buyer
    (the same rule the bulk check uses)."""
    holder = SEAT_TAG.sub("@", (a.email or "").strip().lower())
    buyer_id = int(_cd(a).get("bought_by_attendee") or 0)
    if buyer_id and a.registration_source in M.PARTY_SEAT_SOURCES and by_id.get(buyer_id) is not None:
        holder = (by_id[buyer_id].email or "").strip().lower()
    return holder


def _delivery_rows(s, event_id):
    rows = {}
    for r in s.db.execute("select order_id,recipient,state,attempt_count,message_id,result,updated_at,provider_status,"
                          "provider_checked_at,ticket_ids from order_ticket_delivery where event_id=?", (event_id,)):
        rows[r[0]] = {"unit_key": r[0], "recipient": r[1], "state": r[2], "attempts": r[3] or 0, "message_id": r[4],
                      "result": r[5], "updated_at": r[6], "provider_status": r[7], "provider_checked_at": r[8],
                      "ticket_ids": [int(x) for x in str(r[9] or "").replace(",", ";").split(";") if x.strip().isdigit()]}
    return rows


def unit_status(d):
    """One email's delivery status, from evidence only."""
    if not d:
        return "not_sent"
    state = d.get("state")
    p = (d.get("provider_status") or "").lower()
    if state == "sending":
        return "unknown"            # claimed, never finished: the outcome must be looked at
    if state == "unknown":
        return "unknown"
    if state == "rejected":
        return "failed"
    if state in ("accepted", "delivered"):
        if p in ("bounced", "complained"):
            return "bounced"
        if p in st.BAD_PROVIDER:
            return "failed"
        if p == "clicked":
            return "clicked"
        if p in ("opened", "read"):
            return "opened"
        if p == "delivered":
            return "delivered"
        return "accepted"           # GHL took it; no delivery evidence yet
    return "unknown"


_DELIVERY_ORDER = ["failed", "bounced", "unknown", "sending", "accepted", "delivered", "opened", "clicked"]


def booking_delivery(units):
    statuses = [u["delivery"] for u in units]
    if not statuses:
        return "not_sent"
    sent = [x for x in statuses if x != "not_sent"]
    if not sent:
        return "not_sent"
    if len(sent) < len(statuses):
        return "partially_sent"
    return min(sent, key=lambda x: _DELIVERY_ORDER.index(x) if x in _DELIVERY_ORDER else 0)


def _build(db, event_id, s, only_buyer=None):
    event = db.query(models.Event).filter(models.Event.id == event_id).first()
    rows = db.query(models.Attendee).filter(models.Attendee.event_id == event_id).all()
    by_id = {a.id: a for a in rows}
    types = {t.id: t for t in db.query(models.TicketType).filter(models.TicketType.event_id == event_id).all()}
    pays = db.query(models.PaymentEvent).filter(models.PaymentEvent.event_id == event_id).all()
    pays_by_att, pays_by_order = {}, {}
    for p in pays:
        if p.attendee_id:
            pays_by_att.setdefault(p.attendee_id, []).append(p)
        if p.ghl_entity_id:
            pays_by_order.setdefault(p.ghl_entity_id, []).append(p)

    def in_scope(a):
        return M._ticket_active(a) and ((a.registration_source or "") in PAID_SOURCES + tuple(M.PARTY_SEAT_SOURCES)
                                        or (a.attendance_type or "") == "paid")
    live = [a for a in rows if in_scope(a)]
    out_of_scope = [a for a in rows if M._ticket_active(a) and not in_scope(a)]

    plan = {}
    for p in db.query(models.EmailPlan).filter(models.EmailPlan.event_id == event_id,
                                               models.EmailPlan.active == True).all():   # noqa: E712
        plan[p.plan_key] = p
    holds = {h.attendee_id: (h.reason or "held") for h in db.query(models.EmailHold).filter(
        models.EmailHold.event_id == event_id, models.EmailHold.state == "held").all()}
    issues = [i for i in db.query(models.ReconIssue).filter(models.ReconIssue.event_id == event_id,
                                                           models.ReconIssue.status.in_(("open", "in_review"))).all()]
    deliv = _delivery_rows(s, event_id)
    delivered_tix = {t for d in deliv.values() if d["state"] != "rejected" for t in d["ticket_ids"]}
    reviews = ec_store.reviews(s.db, event_id)
    tsha = _template_sha()

    # Group tickets into bookings: a party seat belongs to its buyer.
    group = {}
    for a in live:
        buyer = int(_cd(a).get("bought_by_attendee") or 0) if a.registration_source in M.PARTY_SEAT_SOURCES else 0
        if not buyer or buyer not in by_id:
            buyer = a.id
        group.setdefault(buyer, []).append(a)

    if only_buyer is not None:
        group = {only_buyer: group[only_buyer]} if only_buyer in group else {}
        scope = {t.id for t in group.get(only_buyer, [])}
    else:
        scope = None

    # Send units: the Reconciliation Center's planned emails first, then what
    # the delivery history says went out, then one per remaining ticket.
    unit_of_ticket, units = {}, {}
    for key, p in plan.items():
        ids = [int(x) for x in (p.ticket_ids or []) if int(x) in by_id]
        units[key] = {"unit_key": key, "source": "send_list", "recipient": (p.recipient or "").strip().lower(),
                      "ticket_ids": ids, "order_ids": list(p.order_ids or [])}
        for i in ids:
            unit_of_ticket.setdefault(i, key)
    for key, d in deliv.items():
        if key not in units:
            units[key] = {"unit_key": key, "source": "delivery_history", "recipient": (d["recipient"] or "").lower(),
                          "ticket_ids": [i for i in d["ticket_ids"] if i in by_id], "order_ids": [key]}
        for i in d["ticket_ids"]:
            if d["state"] != "rejected" or i not in unit_of_ticket:
                unit_of_ticket[i] = key
    used_orders = set(units)
    for a in sorted(live, key=lambda x: x.id):
        if a.id in unit_of_ticket:
            continue
        own = sorted({p.ghl_entity_id for p in pays_by_att.get(a.id, []) if p.status == "paid" and p.ghl_entity_id},
                     key=lambda oid: min(str(p.occurred_at or "") for p in pays_by_order.get(oid, [])) or oid)
        free = [o for o in own if o not in used_orders]
        key = free[0] if free else "ticket:%d" % a.id
        used_orders.add(key)
        units[key] = {"unit_key": key, "source": "not_in_send_list", "recipient": _holder_email(a, by_id),
                      "ticket_ids": [a.id], "order_ids": [key] if free else []}
        unit_of_ticket[a.id] = key

    # The bulk-email rules over everything not yet sent, in one pass.
    to_check = []
    for key, u in units.items():
        d = deliv.get(key)
        if d and d["state"] != "rejected":
            continue
        tix = [by_id[i] for i in u["ticket_ids"] if i in by_id and i not in holds]
        if not tix or (scope is not None and not (set(u["ticket_ids"]) & scope)):
            continue
        to_check.append({"order_id": key, "recipient": u["recipient"],
                         "tickets": [{"ticket_id": t.id, "qr": t.qr_code, "token": t.public_token,
                                      "ticket_type_id": t.ticket_type_id} for t in tix]})
    gate = M._bulk_check(db, event_id, to_check, delivered_tix, {}, {}, None, (), account_all=False, party_scope=scope)

    def findings_for(ids, unit_keys):
        found = []
        for f in gate.get("critical") or []:
            if set(f.get("ticket_ids") or []) & ids or set(f.get("order_ids") or []) & unit_keys:
                found.append({"code": f.get("code"), "detail": f.get("detail") or f.get("code"),
                              "paid_for": f.get("paid_for"), "emailed": f.get("emailed")})
        return found

    out, now_cut = [], AUTO_CUTOFF
    for buyer_id, tix in group.items():
        buyer = by_id[buyer_id]
        ids = {t.id for t in tix}
        party = M._party_members(db, buyer)
        paid_for = int(party.get("paid_for") or len(ids)) if party else 1
        ukeys = sorted({unit_of_ticket[t.id] for t in tix if t.id in unit_of_ticket})
        bunits = []
        for k in ukeys:
            u = dict(units[k])
            d = deliv.get(k)
            u["delivery"] = unit_status(d)
            u["delivery_record"] = d
            u["held_ticket_ids"] = [i for i in u["ticket_ids"] if i in holds]
            bunits.append(u)
        order_ids = sorted({o for u in bunits for o in u["order_ids"]} |
                           {p.ghl_entity_id for t in tix for p in pays_by_att.get(t.id, []) if p.ghl_entity_id})
        payments = []
        for oid in order_ids:
            for p in pays_by_order.get(oid, []):
                if p.attendee_id and p.attendee_id not in ids:
                    continue
                payments.append({"order_id": oid, "type": p.ghl_entity_type, "status": p.status, "amount": p.amount,
                                 "refunded": p.amount_refunded or 0, "currency": p.currency, "products": _names(p.product_names),
                                 "paid_at": _iso(p.occurred_at), "first_seen_at": _iso(p.first_seen_at),
                                 "buyer_name": p.buyer_name, "buyer_email": (p.buyer_email or "").lower(),
                                 "contact_id": p.contact_id, "ticket_id": p.attendee_id})
        bp = [p for p in payments if p["ticket_id"] == buyer_id] or payments
        purchaser_name = (bp[0]["buyer_name"] if bp and bp[0]["buyer_name"] else _name(buyer))
        purchaser_email = (bp[0]["buyer_email"] if bp and bp[0]["buyer_email"] else (buyer.email or "").lower())

        critical = findings_for(ids, set(ukeys))
        warnings = []
        held = {t.id: holds[t.id] for t in tix if t.id in holds}
        if held:
            critical.append({"code": "HELD", "detail": "%d ticket(s) held in Ticket Reconciliation: %s"
                             % (len(held), "; ".join(sorted(set(held.values()))))})
        if len(ids) < paid_for and not any(c["code"] == "MISSING_TICKETS" for c in critical):
            critical.append({"code": "MISSING_TICKETS", "detail": "paid for %d ticket(s), %d exist" % (paid_for, len(ids)),
                             "paid_for": paid_for, "emailed": len(ids)})
        for t in tix:
            if not t.qr_code or not QR_RE.match(t.qr_code or "") or not t.public_token:
                critical.append({"code": "QR_INVALID", "detail": "ticket %d has a missing or invalid QR code or badge" % t.id})
            if _cd(t).get("needs_name_check"):
                warnings.append({"code": "NAME_TO_CONFIRM", "detail": "ticket %d: holder name to confirm at the desk" % t.id})
        for u in bunits:
            if u["delivery"] == "not_sent" and not EMAIL_RE.match(u["recipient"] or ""):
                critical.append({"code": "NO_VALID_EMAIL", "detail": "email %s has no valid recipient address" % u["unit_key"]})
        rel = []
        for i in issues:
            a_ids = set(int(x) for x in (i.attendee_ids or []) if str(x).isdigit())
            if a_ids & ids or set(i.order_ids or []) & set(order_ids) or (i.buyer_attendee_id and i.buyer_attendee_id in ids):
                rel.append({"id": i.id, "kind": i.kind, "priority": i.priority, "status": i.status, "title": i.title,
                            "explanation": i.explanation, "recommendation": i.recommendation})
                if i.priority in ("critical", "high"):
                    critical.append({"code": "RECONCILIATION", "detail": "open %s reconciliation case: %s" % (i.priority, i.title),
                                     "issue_id": i.id})
                else:
                    warnings.append({"code": "RECONCILIATION", "detail": "open %s case: %s" % (i.priority, i.title), "issue_id": i.id})
        late = all(u["source"] == "not_in_send_list" for u in bunits) and any(
            (p["first_seen_at"] or "") > now_cut for p in payments)
        if late:
            warnings.append({"code": "LATE_ORDER", "detail": "paid after the 3 Nov list; not in the approved send list"})

        tickets = []
        for t in sorted(tix, key=lambda x: (x.id != buyer_id, x.id)):
            tt = types.get(t.ticket_type_id)
            tickets.append({"id": t.id, "name": _name(t), "email": (t.email or "").lower(),
                            "ticket_type": tt.name if tt else None, "ticket_type_id": t.ticket_type_id,
                            "pass": M._pass_display(db, t), "includes": M._pass_includes(db, t, event),
                            "status": M._ticket_status(t), "source": t.registration_source,
                            "qr_present": bool(t.qr_code), "qr_valid": bool(t.qr_code and QR_RE.match(t.qr_code) and t.public_token),
                            "is_buyer": t.id == buyer_id, "seat": (_cd(t).get("seat_of_party") or None),
                            "needs_name_check": bool(_cd(t).get("needs_name_check")),
                            "held": holds.get(t.id), "unit_key": unit_of_ticket.get(t.id),
                            "checked_in": bool(t.is_checked_in), "checked_in_at": _iso(t.checked_in_at),
                            "_qr": t.qr_code, "_token": t.public_token})
        fp = _sha({"tickets": [{k: v for k, v in x.items() if k not in ("checked_in", "checked_in_at", "held")} for x in tickets],
                   "units": [{"k": u["unit_key"], "r": u["recipient"], "t": u["ticket_ids"]} for u in bunits],
                   "paid_for": paid_for, "payments": [(p["order_id"], p["status"], p["amount"], p["refunded"]) for p in payments],
                   "template": tsha})
        key = "B%d" % buyer_id
        rv = reviews.get(key) or {}
        state = rv.get("state") or "pending_review"
        changed = state in ("verified", "approved") and rv.get("fingerprint") != fp
        effective = "pending_review" if changed else state
        delivery = booking_delivery(bunits)
        unsent = [u for u in bunits if u["delivery"] == "not_sent"]
        retryable = [u for u in bunits if u["delivery"] == "failed" and (u["delivery_record"] or {}).get("state") == "rejected"]
        blockers = list(critical)
        out.append({
            "key": key, "buyer_ticket_id": buyer_id, "order_ids": order_ids,
            "order_number": order_ids[0] if order_ids else ("ticket %d" % buyer_id),
            "purchaser_name": purchaser_name, "purchaser_email": purchaser_email,
            "ticket_types": sorted({x["ticket_type"] or "?" for x in tickets}),
            "paid_for": paid_for, "tickets_generated": len(tickets),
            "payment_status": ("refunded" if any(p["refunded"] for p in payments) else
                               "paid" if payments and all(p["status"] == "paid" for p in payments) else
                               ("no_payment_record" if not payments else "check")),
            "amount_paid": round(sum((p["amount"] or 0) - (p["refunded"] or 0) for p in payments if p["status"] == "paid"), 2),
            "qr_status": "ok" if all(x["qr_valid"] for x in tickets) else "problem",
            "reconciliation": ("held" if held else "open_case" if any(c["code"] == "RECONCILIATION" for c in critical)
                               else "warning" if rel else "clear"),
            "review_state": effective, "review": rv, "changed_since_review": changed,
            "delivery": delivery, "units": bunits, "tickets": tickets, "payments": payments,
            "issues": rel, "critical": blockers, "warnings": warnings, "fingerprint": fp,
            "late_order": late, "held": bool(held),
            "can_approve": not blockers and bool(unsent),
            "sendable": (effective == "approved" and not blockers and bool(unsent)),
            "retryable": (effective == "approved" and not blockers and bool(retryable)),
            "last_sent": max([(u["delivery_record"] or {}).get("updated_at") or "" for u in bunits] or [""]) or None,
            "attempts": sum((u["delivery_record"] or {}).get("attempts") or 0 for u in bunits),
            "last_error": next(((u["delivery_record"] or {}).get("result") for u in bunits
                                if u["delivery"] in ("failed", "bounced", "unknown")), None),
            "provider_checked_at": max([(u["delivery_record"] or {}).get("provider_checked_at") or "" for u in bunits] or [""]) or None,
        })
    out.sort(key=lambda b: b["buyer_ticket_id"])
    return {"event": {"id": event.id, "name": event.name, "start_date": _iso(event.start_date), "end_date": _iso(event.end_date),
                      "timezone": event.timezone, "location": event.location},
            "bookings": out, "by_key": {b["key"]: b for b in out},
            "out_of_scope": [{"id": a.id, "name": _name(a), "attendance_type": a.attendance_type,
                              "source": a.registration_source} for a in out_of_scope],
            "template_sha": tsha, "built_at": ec_store.now()}


def _public(b, detail=False):
    """What the browser gets. No QR codes or badge tokens in the list."""
    keep = dict(b)
    keep["units"] = [{k: v for k, v in u.items() if k != "delivery_record"} | {
        "attempts": (u.get("delivery_record") or {}).get("attempts", 0),
        "last_update": (u.get("delivery_record") or {}).get("updated_at"),
        "provider_status": (u.get("delivery_record") or {}).get("provider_status"),
        "provider_checked_at": (u.get("delivery_record") or {}).get("provider_checked_at"),
        "result": (u.get("delivery_record") or {}).get("result"),
        "message_id": (u.get("delivery_record") or {}).get("message_id") if detail else None,
    } for u in b["units"]]
    tix = []
    for t in b["tickets"]:
        x = {k: v for k, v in t.items() if not k.startswith("_")}
        if detail and t.get("_qr"):
            code = M._ticket_links.link_code(t["_qr"], M.SECRET_KEY)
            x["qr_code"] = t["_qr"]
            x["ticket_url"] = PUBLIC + "/ticket/" + code
            x["qr_image_url"] = PUBLIC + "/t/" + code + ".png"
        tix.append(x)
    keep["tickets"] = tix
    if detail:
        keep["payments"] = [{k: v for k, v in p.items() if k != "contact_id"} for p in b["payments"]]
    if not detail:
        for k in ("payments", "issues", "review"):
            keep.pop(k, None)
    return keep


# ---------------------------------------------------------------------------
# The email itself
# ---------------------------------------------------------------------------
def _unit_order(db, built, b, u):
    """The order dict the reviewed template and the delivery history read."""
    ev = built["event"]
    by = {t["id"]: t for t in b["tickets"]}
    tickets = []
    for i in u["ticket_ids"]:
        t = by[i]
        code = M._ticket_links.link_code(t["_qr"], M.SECRET_KEY)
        tickets.append({"ticket_id": i, "name": "" if t["needs_name_check"] else t["name"], "qr": t["_qr"],
                        "token": t["_token"], "link": PUBLIC + "/ticket/" + code, "qr_url": PUBLIC + "/t/" + code + ".png",
                        "purchased_category": t["ticket_type"] or "", "ticket_type_id": t["ticket_type_id"],
                        "current_pass": t["pass"] or t["ticket_type"] or "", "pass_includes": t["includes"] or ""})
    shown = (u["order_ids"][0] if u["order_ids"] else b["order_number"])
    return {"order_id": u["unit_key"], "display_order_id": shown, "source": "ghl_invoice" if any(
                p["type"] == "invoice" and p["order_id"] in u["order_ids"] for p in b["payments"]) else "ghl_order",
            # The greeting names the ticket's holder when the email carries one
            # ticket, as the approved 3 Nov list did (338 of 341 identical; the
            # other 3 are holder names corrected since), else the purchaser.
            "recipient": u["recipient"], "buyer_name": ((by[u["ticket_ids"][0]]["name"] if len(tickets) == 1 else "")
                                                        or b["purchaser_name"]), "quantity": len(tickets),
            "event": {"id": ev["id"], "name": ev["name"], "start_date": ev["start_date"], "end_date": ev["end_date"],
                      "timezone": ev["timezone"], "location": ev["location"]},
            "tickets": tickets}


def _render(order):
    view = dict(order, order_id=order["display_order_id"])
    return ticket_email.render(view)


# ---------------------------------------------------------------------------
# Safety switch
# ---------------------------------------------------------------------------
def sending_state(s):
    env_off = os.environ.get("EMAIL_CENTER_DISABLED") == "1"
    on = s.get("email_center_sending", "off") == "on"
    paused = s.mode() == "paused"
    reason = None
    if env_off:
        reason = "Email Center sending is disabled on this server."
    elif not on:
        reason = "Sending is switched off. A platform admin must switch it on in Email Center > Overview."
    elif paused:
        reason = "Ticket email is paused (Ticket Emails > Pause). Nothing is sent while paused."
    return {"enabled": not reason, "switch": "on" if on else "off", "global_mode": s.mode(),
            "reason": reason, "fake_gateway": bool(os.environ.get("EMAIL_CENTER_FAKE")),
            "changed_by": (s.db.execute("select updated_by,updated_at from delivery_control where key='email_center_sending'").fetchone() or (None, None))}


def _require_sending(s):
    ss = sending_state(s)
    if not ss["enabled"]:
        raise HTTPException(status_code=409, detail=ss["reason"])


# ---------------------------------------------------------------------------
# Sending one booking
# ---------------------------------------------------------------------------
def _validate_live(gw, order, contact_hint):
    """Re-check at the moment of sending: the GHL contact is the recipient and
    is not do-not-disturb; the order is paid, live and not refunded.
    -> (ok, reason, contact_id)."""
    email = order["recipient"]
    contact_id = None
    if contact_hint:
        c = gw.contact(contact_hint)
        if (c.get("email") or "").strip().lower() == email:
            contact_id = c.get("id") or contact_hint
            if c.get("dnd") or ((c.get("dndSettings") or {}).get("Email") or {}).get("status") == "active":
                return False, "recipient_do_not_disturb", None
    if not contact_id:
        found = gw.find_contacts(email)
        if len(found) != 1:
            return False, ("no_ghl_contact_for_recipient" if not found else "several_ghl_contacts_for_recipient"), None
        c = found[0]
        if c.get("dnd") or ((c.get("dndSettings") or {}).get("Email") or {}).get("status") == "active":
            return False, "recipient_do_not_disturb", None
        contact_id = c["id"]
    for oid in order.get("_order_ids") or []:
        o = gw.order(oid, order["source"])
        if order["source"] == "ghl_invoice":
            if (o.get("status") or "").lower() != "paid":
                return False, "invoice_not_paid_live", None
        elif o.get("status") != "completed" or o.get("paymentStatus") != "paid" or o.get("liveMode") is not True:
            return False, "order_not_paid_live", None
        tx = gw.transactions(oid)
        if any(t.get("status") in ("refunded", "partially_refunded") or t.get("amountRefunded") for t in tx):
            return False, "order_refunded", None
    return True, "", contact_id


def send_booking(db, event_id, key, actor, resend_reason=None, retry=False, gw=None, expect_fingerprint=None):
    """Send every not-yet-sent email of an approved booking (or, with a reason,
    resend; or retry definite failures). Re-validates everything first."""
    s = _store()
    s.actor = actor
    try:
        _require_sending(s)
        b, built = booking(db, event_id, key)
        if not b:
            return {"key": key, "state": "refused", "reason": "booking_not_found"}
        if b["review_state"] != "approved":
            return {"key": key, "state": "refused", "reason": "changed_since_approval" if b["changed_since_review"] else "not_approved"}
        if expect_fingerprint and expect_fingerprint != b["fingerprint"]:
            return {"key": key, "state": "refused", "reason": "changed_since_confirmation"}
        if b["critical"]:
            return {"key": key, "state": "refused", "reason": "blocked: " + "; ".join(c["detail"] for c in b["critical"])}
        if resend_reason:
            todo = [u for u in b["units"] if u["delivery"] in ("accepted", "delivered", "opened", "clicked", "bounced")
                    and (u["delivery_record"] or {}).get("state") in ("accepted", "delivered")]
        elif retry:
            todo = [u for u in b["units"] if (u["delivery_record"] or {}).get("state") == "rejected"]
        else:
            todo = [u for u in b["units"] if u["delivery"] == "not_sent"]
        if not todo:
            return {"key": key, "state": "skipped", "reason": "nothing_to_send"}
        gw = gw or gateway()
        hint = {p["order_id"]: p["contact_id"] for p in b["payments"] if p.get("contact_id")}
        prepared = []
        for u in todo:
            order = _unit_order(db, built, b, u)
            order["_order_ids"] = [o for o in u["order_ids"] if not o.startswith(("ticket:", "booking:"))]
            ok, why, contact_id = _validate_live(gw, order, next((hint[o] for o in u["order_ids"] if o in hint), None))
            if not ok:
                ec_store.log(s.db, event_id, key, actor, "send_refused", note="%s: %s" % (u["unit_key"], why))
                return {"key": key, "state": "held", "reason": why, "unit": u["unit_key"]}
            order["contact_id"] = contact_id
            prepared.append(order)
        results = []
        sha = "ec:" + b["fingerprint"][:20]
        for order in prepared:
            payload = _render(order)

            def transport(o, p, _to=order["recipient"]):
                return gw.send(o["contact_id"], {"subject": p["subject"], "html": p["html"], "_to": _to}
                               if gw.fake else {"subject": p["subject"], "html": p["html"]})
            r = st.deliver(order, s, sha, lambda o: (True, ""), transport, lambda o, _p=payload: _p,
                           retry_rejected=retry, resend_reason=resend_reason, allow_changed=retry)
            results.append(r)
        states = [r["state"] for r in results]
        overall = ("sent" if all(x == "accepted" for x in states) else
                   "unknown" if "unknown" in states else
                   "failed" if "rejected" in states else
                   "skipped" if all(x == "skipped_existing_delivery" for x in states) else "partial")
        ec_store.log(s.db, event_id, key, actor, "resend" if resend_reason else "retry" if retry else "send",
                     note="%s; %s" % (overall, ", ".join("%s=%s" % (r["order_id"], r["state"]) for r in results)) +
                     (("; reason: " + resend_reason) if resend_reason else ""))
        s.audit(actor, "email_center_send", event_id, key, resend_reason or "", {"results": results})
        booking(db, event_id, key)
        return {"key": key, "state": overall, "units": results}
    finally:
        s.close()


# ---------------------------------------------------------------------------
# Exhibitors
# ---------------------------------------------------------------------------
def _app_base():
    base = (os.environ.get("CARD_PUBLIC_BASE") or "").rstrip("/")
    return base.replace("//card.", "//api.") if base else ""


def _setup_link(db, s, ex, mint_if_missing=True):
    url, exp = ec_store.exhibitor_link(s.db, ex.event_id, ex.id)
    if url:
        return url, exp, False
    if not mint_if_missing:
        return None, None, False
    import secrets as _secrets
    token = _secrets.token_urlsafe(24)
    ex.setup_token_hash = M._vendor_token_hash(token)
    ex.setup_sent_at = datetime.utcnow()
    ex.setup_expires_at = datetime.utcnow() + timedelta(days=M.VENDOR_SETUP_TTL_DAYS)
    db.commit()
    url = "%s/vendor/%s" % (_app_base(), token)
    exp = ex.setup_expires_at.replace(tzinfo=timezone.utc).isoformat()
    ec_store.store_link(s.db, ex.event_id, ex.id, url, exp)
    return url, exp, True


def _scanner_url(ex):
    return "%s/event/scan/%s" % (PUBLIC, ex.access_token) if ex.access_token else None


def _ex_view(ex):
    return {"company_name": ex.company_name, "booth_number": ex.booth_number, "contact_name": ex.contact_name}


def exhibitor_rows(db, event_id, s):
    recs = ec_store.exhibitor_rows(s.db, event_id)
    out = []
    first_scan = dict(db.query(models.Lead.exhibitor_id, M.func.min(models.Lead.scanned_at)).group_by(models.Lead.exhibitor_id).all())
    leads = dict(db.query(models.Lead.exhibitor_id, M.func.count(models.Lead.id)).group_by(models.Lead.exhibitor_id).all())
    for ex in db.query(models.Exhibitor).filter(models.Exhibitor.event_id == event_id,
                                                models.Exhibitor.stage == "confirmed").all():
        email = (ex.contact_email or "").strip().lower()
        own_link, own_exp = ec_store.exhibitor_link(s.db, event_id, ex.id)
        expires = _iso(ex.setup_expires_at)
        row = {"id": ex.id, "company_name": ex.company_name, "booth_number": ex.booth_number,
               "contact_name": ex.contact_name, "contact_email": email or None,
               "email_valid": bool(EMAIL_RE.match(email)), "payment_status": ex.payment_status,
               "package": ex.package, "amount_due": ex.amount_due, "amount_paid": ex.amount_paid,
               "profile_activated_at": _iso(ex.activated_at),
               "setup_link": ("activated" if ex.activated_at else
                              "valid" if own_link else
                              "created_not_tracked" if ex.setup_token_hash and expires and expires > ec_store.now()[:19] else
                              "expired" if ex.setup_token_hash else "none"),
               "setup_link_created_at": _iso(ex.setup_sent_at), "setup_link_expires_at": own_exp or expires,
               "scanning_enabled": bool(ex.can_scan_leads), "scanner_link_available": bool(ex.access_token),
               "first_scan_at": _iso(first_scan.get(ex.id)), "leads": int(leads.get(ex.id) or 0),
               "eligible_for_scanning": (ex.payment_status or "").lower() in ("paid", "comp"),
               "amount_mismatch": bool(ex.amount_due and (ex.amount_paid or 0) < ex.amount_due and (ex.payment_status or "").lower() == "paid")}
        for kind in ("setup", "scanner"):
            r = recs.get((ex.id, kind)) or {}
            row[kind] = {"status": _ex_status(r), "attempts": r.get("attempts") or 0, "last_sent": r.get("sent_at"),
                         "sent_by": r.get("sent_by"), "last_error": r.get("result") if _ex_status(r) in ("failed", "unknown") else None,
                         "provider_status": r.get("provider_status"), "provider_checked_at": r.get("provider_checked_at")}
        row["scanner"]["eligible"] = bool(ex.can_scan_leads and ex.access_token and row["email_valid"])
        row["setup"]["eligible"] = row["email_valid"] and not ex.activated_at
        out.append(row)
    out.sort(key=lambda r: (_booth_sort(r["booth_number"]), r["company_name"] or ""))
    return out


def _booth_sort(b):
    m = re.match(r"\d+", str(b or ""))
    return int(m.group()) if m else 9999


def _ex_status(r):
    if not r or r.get("state") in (None, "", "prepared"):
        return "not_sent"
    if r["state"] == "manual":
        return "sent_manually"
    return unit_status({"state": r["state"], "provider_status": r.get("provider_status")})


def send_exhibitor(db, event_id, ex_id, kind, actor, resend_reason=None, gw=None):
    s = _store()
    try:
        _require_sending(s)
        ex = db.query(models.Exhibitor).filter(models.Exhibitor.id == ex_id, models.Exhibitor.event_id == event_id).first()
        if not ex or ex.stage != "confirmed":
            return {"id": ex_id, "kind": kind, "state": "refused", "reason": "not_a_confirmed_stand"}
        email = (ex.contact_email or "").strip().lower()
        if not EMAIL_RE.match(email):
            return {"id": ex_id, "kind": kind, "state": "refused", "reason": "missing_contact_email"}
        if kind == "scanner" and not (ex.can_scan_leads and ex.access_token):
            return {"id": ex_id, "kind": kind, "state": "refused", "reason": "scanning_not_enabled"}
        if kind == "setup" and ex.activated_at and not resend_reason:
            return {"id": ex_id, "kind": kind, "state": "refused", "reason": "profile_already_set_up"}
        gw = gw or gateway()
        found = gw.find_contacts(email)
        if len(found) != 1:
            return {"id": ex_id, "kind": kind, "state": "refused",
                    "reason": "no_ghl_contact" if not found else "several_ghl_contacts"}
        c = found[0]
        if c.get("dnd") or ((c.get("dndSettings") or {}).get("Email") or {}).get("status") == "active":
            return {"id": ex_id, "kind": kind, "state": "refused", "reason": "contact_do_not_disturb"}
        prior = ec_store.exhibitor_rows(s.db, event_id).get((ex_id, kind)) or {}
        claim = ec_store.exhibitor_claim(s.db, event_id, ex_id, kind, email, actor, resend_reason,
                                         retry_failed=prior.get("state") == "rejected")
        if not claim:
            return {"id": ex_id, "kind": kind, "state": "skipped", "reason": "already_sent_or_outcome_unknown"}
        try:
            if kind == "setup":
                url, exp, _ = _setup_link(db, s, ex)
                exp_text = exp[:10] if exp else ""
                payload = exhibitor_email.render_setup(_ex_view(ex), url, exp_text)
            else:
                payload = exhibitor_email.render_scanner(_ex_view(ex), _scanner_url(ex))
            body = {"subject": payload["subject"], "html": payload["html"]}
            if gw.fake:
                body["_to"] = email
            res = gw.send(c["id"], body)
        except Exception as e:
            ec_store.exhibitor_finish(s.db, event_id, ex_id, kind, "unknown", actor, result="Ambiguous outcome (%s); check GHL before resending" % type(e).__name__,
                                      contact_id=c["id"], reason=resend_reason or "")
            return {"id": ex_id, "kind": kind, "state": "unknown"}
        if res.get("ok") and res.get("messageId"):
            ec_store.exhibitor_finish(s.db, event_id, ex_id, kind, "accepted", actor, res["messageId"],
                                      "Provider accepted; delivery not yet confirmed", c["id"], resend_reason or "")
            state = "accepted"
        else:
            state = "rejected" if res.get("definitely_rejected") else "unknown"
            ec_store.exhibitor_finish(s.db, event_id, ex_id, kind, state, actor, result=str(res.get("reason") or "no acknowledgement")[:200],
                                      contact_id=c["id"], reason=resend_reason or "")
        s.audit(actor, "email_center_exhibitor_" + kind, event_id, "exhibitor:%d" % ex_id, resend_reason or "", {"state": state})
        return {"id": ex_id, "kind": kind, "state": state}
    finally:
        s.close()


# ---------------------------------------------------------------------------
# Batches
# ---------------------------------------------------------------------------
def _batch_plan(db, event_id, keys=None, all_approved=False, mode="send"):
    built = bookings(db, event_id, fresh=True)
    pool = built["bookings"] if all_approved or not keys else [built["by_key"][k] for k in keys if k in built["by_key"]]
    include, exclude = [], []
    for b in pool:
        why = None
        if b["review_state"] != "approved":
            why = "changed since approval" if b["changed_since_review"] else "not approved (%s)" % b["review_state"].replace("_", " ")
        elif b["critical"]:
            why = "blocked: " + "; ".join(c["detail"] for c in b["critical"])
        elif mode == "retry" and not b["retryable"]:
            why = "no failed email to retry"
        elif mode == "send" and not b["sendable"]:
            why = "already sent (%s)" % b["delivery"].replace("_", " ")
        if why:
            if keys or b["review_state"] == "approved":
                exclude.append({"key": b["key"], "order_number": b["order_number"], "purchaser": b["purchaser_name"], "reason": why})
            continue
        include.append(b)
    for k in (keys or []):
        if k not in built["by_key"]:
            exclude.append({"key": k, "reason": "not found"})
    units = [u for b in include for u in b["units"]
             if (u["delivery"] == "not_sent" if mode == "send" else (u.get("delivery_record") or {}).get("state") == "rejected")]
    warnings = [{"key": b["key"], "detail": w["detail"]} for b in include for w in b["warnings"]]
    token = _sha({"mode": mode, "items": sorted((b["key"], b["fingerprint"]) for b in include), "t": built["template_sha"]})
    return {"mode": mode, "orders": len(include), "emails": len(units), "tickets": sum(len(u["ticket_ids"]) for u in units),
            "recipients": len({u["recipient"] for u in units}), "excluded": exclude, "warnings": warnings,
            "template": {"name": "Official ticket email (reviewed 3 Nov 2026)", "sha": built["template_sha"][:12]},
            "items": [{"key": b["key"], "fingerprint": b["fingerprint"], "order_number": b["order_number"],
                       "purchaser": b["purchaser_name"], "emails": sum(1 for u in b["units"] if u in units)} for b in include],
            "confirm_token": token}


def _ex_batch_plan(db, event_id, ids, kind):
    s = _store()
    try:
        rows = {r["id"]: r for r in exhibitor_rows(db, event_id, s)}
    finally:
        s.close()
    include, exclude = [], []
    for i in ids:
        r = rows.get(i)
        if not r:
            exclude.append({"id": i, "reason": "not a confirmed stand"}); continue
        k = r[kind]
        if not k["eligible"]:
            exclude.append({"id": i, "company": r["company_name"], "reason": "missing contact email" if not r["email_valid"] else
                            ("scanning not enabled" if kind == "scanner" else "profile already set up")}); continue
        if k["status"] not in ("not_sent", "failed", "sent_manually"):
            exclude.append({"id": i, "company": r["company_name"], "reason": "already %s" % k["status"].replace("_", " ")}); continue
        include.append(r)
    token = _sha({"kind": kind, "ids": sorted(r["id"] for r in include)})
    return {"kind": kind, "emails": len(include), "excluded": exclude,
            "items": [{"id": r["id"], "company": r["company_name"], "booth": r["booth_number"]} for r in include],
            "template": exhibitor_email.SUBJECTS[kind], "confirm_token": token}


_RUNNER_ID = uuid.uuid4().hex


def _lease(s, batch_id):
    """Take the batch for this process if nobody is running it. Atomic."""
    stale = (datetime.now(timezone.utc) - timedelta(seconds=STALE_SECONDS)).isoformat()
    cur = s.db.execute("update ec_batches set runner=?,heartbeat_at=?,state='running' where id=? and state in ('running','queued') "
                       "and (runner is null or runner=? or heartbeat_at is null or heartbeat_at < ?)",
                       (_RUNNER_ID, ec_store.now(), batch_id, _RUNNER_ID, stale))
    return cur.rowcount == 1


def _run_batch(batch_id, event_id):
    from database import SessionLocal
    s = _store()
    try:
        if not _lease(s, batch_id):
            return
        b = s.db.execute("select kind,created_by from ec_batches where id=?", (batch_id,)).fetchone()
        kind, actor = b[0], b[1]
        while True:
            row = s.db.execute("select state from ec_batches where id=?", (batch_id,)).fetchone()
            if not row or row[0] != "running":
                return
            s.db.execute("update ec_batches set heartbeat_at=? where id=? and runner=?", (ec_store.now(), batch_id, _RUNNER_ID))
            item = s.db.execute("select id,item_key from ec_batch_items where batch_id=? and state='queued' order by id limit 1", (batch_id,)).fetchone()
            if not item:
                s.db.execute("update ec_batches set state='done',finished_at=? where id=?", (ec_store.now(), batch_id))
                return
            iid, ikey = item
            s.db.execute("update ec_batch_items set state='working',updated_at=? where id=?", (ec_store.now(), iid))
            db = SessionLocal()
            try:
                if kind in ("send", "retry"):
                    key, fp = ikey.split("|", 1)
                    r = send_booking(db, event_id, key, actor, retry=(kind == "retry"), expect_fingerprint=fp)
                    res_state = {"sent": "sent", "skipped": "skipped", "held": "held", "refused": "skipped",
                                 "unknown": "unknown", "failed": "failed"}.get(r["state"], r["state"])
                else:
                    ex_id = int(ikey)
                    r = send_exhibitor(db, event_id, ex_id, kind.split(":")[1], actor)
                    res_state = {"accepted": "sent", "rejected": "failed"}.get(r["state"], r["state"])
                s.db.execute("update ec_batch_items set state=?,result=?,updated_at=? where id=?",
                             (res_state, json.dumps(r, default=str)[:2000], ec_store.now(), iid))
            except HTTPException as e:
                # The switch went off or a pause began mid-run: stop, leave the rest queued.
                s.db.execute("update ec_batch_items set state='queued',updated_at=? where id=?", (ec_store.now(), iid))
                s.db.execute("update ec_batches set state='paused',paused_by='system',note=? where id=?", (str(e.detail), batch_id))
                return
            except Exception as e:      # never retry blindly: mark and move on
                s.db.execute("update ec_batch_items set state='error',result=?,updated_at=? where id=?",
                             (type(e).__name__, ec_store.now(), iid))
            finally:
                db.close()
            time.sleep(SEND_PAUSE_SECONDS)
    finally:
        s.close()


def start_batch_thread(batch_id, event_id):
    t = threading.Thread(target=_run_batch, args=(batch_id, event_id), daemon=True, name="email-center-batch-%d" % batch_id)
    t.start()
    return t


def batch_view(s, batch_id):
    r = s.db.execute("select id,event_id,kind,created_by,created_at,state,template_sha,counts,runner,heartbeat_at,finished_at,paused_by,note "
                     "from ec_batches where id=?", (batch_id,)).fetchone()
    if not r:
        return None
    items = s.db.execute("select item_key,state,result,updated_at from ec_batch_items where batch_id=? order by id", (batch_id,)).fetchall()
    tally = {}
    for it in items:
        tally[it[1]] = tally.get(it[1], 0) + 1
    state = r[5]
    hb = ec_store._ts(r[9])
    if state == "running" and (not hb or datetime.now(timezone.utc) - hb > timedelta(seconds=STALE_SECONDS)):
        state = "interrupted"
    return {"id": r[0], "event_id": r[1], "kind": r[2], "created_by": r[3], "created_at": r[4], "state": state,
            "template_sha": (r[6] or "")[:12], "counts": json.loads(r[7] or "{}"), "heartbeat_at": r[9], "finished_at": r[10],
            "paused_by": r[11], "note": r[12], "total": len(items), "tally": tally,
            "items": [{"key": i[0].split("|")[0], "state": i[1], "result": _short(i[2]), "updated_at": i[3]} for i in items]}


def _short(res):
    try:
        r = json.loads(res or "{}")
    except ValueError:
        return res
    return r.get("reason") or r.get("state")


def create_batch(s, event_id, kind, actor, plan, item_keys):
    s.db.execute("begin immediate")
    try:
        busy = {r[0].split("|")[0] for r in s.db.execute(
            "select i.item_key from ec_batch_items i join ec_batches b on b.id=i.batch_id where b.event_id=? and b.state in ('running','queued','paused') "
            "and i.state in ('queued','working')", (event_id,))}
        clash = [k for k in item_keys if k.split("|")[0] in busy]
        if clash:
            s.db.execute("rollback")
            raise HTTPException(status_code=409, detail="%d of these are already in another sending run. Wait for it, or pause it first." % len(clash))
        cur = s.db.execute("insert into ec_batches(event_id,kind,created_by,created_at,state,template_sha,confirm_token,counts) values(?,?,?,?,?,?,?,?)",
                           (event_id, kind, actor, ec_store.now(), "queued", plan.get("template", {}).get("sha") if isinstance(plan.get("template"), dict) else "",
                            plan["confirm_token"], json.dumps({k: plan.get(k) for k in ("orders", "emails", "tickets", "recipients")})))
        bid = cur.lastrowid
        for k in item_keys:
            s.db.execute("insert into ec_batch_items(batch_id,item_key,state,updated_at) values(?,?, 'queued', ?)", (bid, k, ec_store.now()))
        s.db.execute("commit")
        return bid
    except HTTPException:
        raise
    except Exception:
        s.db.execute("rollback")
        raise


# ---------------------------------------------------------------------------
# Needs Attention
# ---------------------------------------------------------------------------
def attention(db, event_id):
    built = bookings(db, event_id)
    s = _store()
    try:
        ex_rows = exhibitor_rows(db, event_id, s)
        marks = {r[0]: {"status": r[1], "assigned_to": r[2], "note": r[3], "updated_by": r[4], "updated_at": r[5]}
                 for r in s.db.execute("select item_key,status,assigned_to,note,updated_by,updated_at from ec_attention where event_id=?", (event_id,))}
    finally:
        s.close()
    items = []

    def add(key, problem, severity, related, action, link, kind):
        m = marks.get(key) or {}
        items.append({"key": key, "problem": problem, "severity": severity, "related": related, "recommended_action": action,
                      "link": link, "kind": kind, "status": m.get("status") or "open", "assigned_to": m.get("assigned_to"),
                      "note": m.get("note"), "updated_by": m.get("updated_by"), "updated_at": m.get("updated_at")})
    for b in built["bookings"]:
        rel = "Order %s · %s" % (b["order_number"], b["purchaser_name"] or "")
        link = {"booking": b["key"], "reconcile_issue": next((c.get("issue_id") for c in b["critical"] if c.get("issue_id")), None)}
        for c in b["critical"]:
            code = c["code"]
            if code == "MISSING_TICKETS":
                add("%s:missing" % b["key"], "Paid for %s ticket(s), only %s exist" % (c.get("paid_for") or b["paid_for"], b["tickets_generated"]),
                    "critical", rel, "Complete the booking in Ticket Reconciliation (add the missing seat), then review again.", link, "missing_tickets")
            elif code == "HELD":
                add("%s:held" % b["key"], c["detail"], "high", rel, "Resolve or release the hold in Ticket Reconciliation.", link, "held")
            elif code == "RECONCILIATION":
                add("%s:recon:%s" % (b["key"], c.get("issue_id")), c["detail"], "high", rel, "Resolve the case in Ticket Reconciliation.",
                    dict(link, reconcile_issue=c.get("issue_id")), "reconciliation")
            elif code in ("QR_INVALID", "DUPLICATE_QR", "DUPLICATE_BADGE", "WRONG_HOLDER", "CATEGORY_MISMATCH"):
                add("%s:%s" % (b["key"], code.lower()), c["detail"], "critical", rel, "Correct the ticket in Ticket Reconciliation or Attendees.", link, code.lower())
            elif code == "NO_VALID_EMAIL":
                add("%s:email" % b["key"], "No valid email address for this ticket email", "high", rel,
                    "Correct the holder's email in Ticket Reconciliation, then review again.", link, "missing_email")
        if b["changed_since_review"]:
            add("%s:changed" % b["key"], "Changed after it was %s; the approval no longer counts" % b["review"].get("state"), "medium", rel,
                "Review the booking again.", link, "approval_invalidated")
        if b["review_state"] in ("needs_correction",):
            add("%s:flagged" % b["key"], "Flagged for correction" + ((": " + b["review"].get("note")) if b["review"].get("note") else ""),
                "medium", rel, "Correct it, then review again.", link, "flagged")
        if b["delivery"] in ("failed", "bounced", "unknown", "partially_sent"):
            add("%s:delivery" % b["key"], {"failed": "Ticket email failed", "bounced": "Ticket email bounced",
                                           "unknown": "Delivery uncertain: the send did not get a clear answer",
                                           "partially_sent": "Only some of this booking's emails were sent"}[b["delivery"]],
                "high", rel, ("Check the message in GHL before resending; never resend blind." if b["delivery"] == "unknown"
                              else "Check the address, then retry or resend from the review panel."), link, "delivery_" + b["delivery"])
    for r in ex_rows:
        rel = "%s (booth %s)" % (r["company_name"], r["booth_number"] or "?")
        link = {"exhibitor": r["id"]}
        if not r["email_valid"]:
            add("ex%d:email" % r["id"], "No contact email for this stand", "high", rel, "Add the contact email in Exhibitor Emails.", link, "exhibitor_no_email")
        if r["setup_link"] in ("none", "expired") and not r["profile_activated_at"]:
            add("ex%d:setup" % r["id"], "No valid setup link", "medium", rel, "Send the setup invitation (a new link is created).", link, "exhibitor_no_setup_link")
        if r["eligible_for_scanning"] and not r["scanning_enabled"]:
            add("ex%d:scan" % r["id"], "Paid/complimentary stand with scanning switched off", "medium", rel,
                "An organiser decides whether to switch scanning on (Exhibitors).", link, "exhibitor_scanner_off")
        if r["amount_mismatch"]:
            add("ex%d:pay" % r["id"], "Marked paid, but the amounts show %s of %s" % (r["amount_paid"], r["amount_due"]), "medium", rel,
                "Check the payment in the planning sheet.", link, "exhibitor_payment")
        for kind in ("setup", "scanner"):
            if r[kind]["status"] in ("failed", "bounced", "unknown"):
                add("ex%d:%s:delivery" % (r["id"], kind), "%s email %s" % (kind.capitalize(), r[kind]["status"]), "high", rel,
                    "Check in GHL, then resend.", link, "exhibitor_delivery")
    sev = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    items.sort(key=lambda i: (i["status"] == "resolved", sev.get(i["severity"], 9), i["key"]))
    return items


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
P = "/events/{event_id}/email-center"


@router.get(P + "/me")
def ec_me(event_id: int, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    M._get_event_or_404(event_id, db)
    caps = authz.capabilities_for(db, current_user, event_id)
    if CAP_READ not in caps and "exhibitor.write" not in caps:
        raise HTTPException(status_code=403, detail="Not permitted for this event")
    s = _store()
    try:
        ss = sending_state(s)
    finally:
        s.close()
    return {"read": CAP_READ in caps, "review": CAP_REVIEW in caps, "send": CAP_SEND in caps, "export": CAP_EXPORT in caps,
            "exhibitors": "exhibitor.write" in caps, "scanner_links": "exhibitor.grant_scanning" in caps,
            "reconcile": "reconcile.read" in caps, "platform_admin": bool(current_user.is_admin),
            "user": current_user.email, "sending": {k: v for k, v in ss.items() if k != "changed_by"},
            "sending_changed_by": ss["changed_by"][0], "sending_changed_at": ss["changed_by"][1]}


@router.get(P + "/overview")
def ec_overview(event_id: int, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_READ)
    built = bookings(db, event_id)
    bs = built["bookings"]
    units = [u for b in bs for u in b["units"]]
    count = lambda pred: sum(1 for b in bs if pred(b))  # noqa: E731
    du = {}
    for u in units:
        du[u["delivery"]] = du.get(u["delivery"], 0) + 1
    out = {
        "attendee": {
            "orders": len(bs), "tickets": sum(b["tickets_generated"] for b in bs),
            "tickets_paid_for": sum(b["paid_for"] for b in bs), "emails": len(units),
            "pending_review": count(lambda b: b["review_state"] == "pending_review"),
            "verified": count(lambda b: b["review_state"] == "verified"),
            "approved": count(lambda b: b["review_state"] == "approved"),
            "ready_to_send": count(lambda b: b["sendable"]),
            "held": count(lambda b: b["held"] or b["review_state"] == "held"),
            "needs_correction": count(lambda b: b["review_state"] == "needs_correction"),
            "blocked": count(lambda b: bool(b["critical"])),
            "changed_since_review": count(lambda b: b["changed_since_review"]),
            "late_orders": count(lambda b: b["late_order"]),
            "missing_email": count(lambda b: any(c["code"] == "NO_VALID_EMAIL" for c in b["critical"])),
            "emails_by_status": du,
            "sent": sum(v for k, v in du.items() if k != "not_sent"),
            "delivered": sum(du.get(k, 0) for k in ("delivered", "opened", "clicked")),
            "opened": sum(du.get(k, 0) for k in ("opened", "clicked")), "clicked": du.get("clicked", 0),
            "failed": du.get("failed", 0), "bounced": du.get("bounced", 0), "unknown": du.get("unknown", 0),
            "accepted_no_evidence": du.get("accepted", 0),
            "not_in_ticket_emails": len(built["out_of_scope"]),
        },
        "built_at": built["built_at"],
    }
    s = _store()
    try:
        ex = exhibitor_rows(db, event_id, s)
        out["sending"] = {k: v for k, v in sending_state(s).items() if k != "changed_by"}
        running = [batch_view(s, r[0]) for r in s.db.execute("select id from ec_batches where event_id=? and state in ('running','queued','paused') order by id desc limit 3", (event_id,))]
    finally:
        s.close()
    exs = lambda kind, st_: sum(1 for r in ex if r[kind]["status"] in st_)  # noqa: E731
    out["exhibitor"] = {"stands": len(ex), "missing_contact": sum(1 for r in ex if not r["email_valid"]),
                        "profiles_activated": sum(1 for r in ex if r["profile_activated_at"]),
                        "scanning_enabled": sum(1 for r in ex if r["scanning_enabled"]),
                        "setup_sent": exs("setup", ("accepted", "delivered", "opened", "clicked", "sent_manually")),
                        "setup_delivered": exs("setup", ("delivered", "opened", "clicked")),
                        "scanner_sent": exs("scanner", ("accepted", "delivered", "opened", "clicked", "sent_manually")),
                        "scanner_delivered": exs("scanner", ("delivered", "opened", "clicked")),
                        "failed": exs("setup", ("failed", "bounced", "unknown")) + exs("scanner", ("failed", "bounced", "unknown")),
                        "first_scans": sum(1 for r in ex if r["first_scan_at"]), "leads": sum(r["leads"] for r in ex)}
    out["needs_attention"] = sum(1 for i in attention(db, event_id) if i["status"] != "resolved")
    out["batches"] = running
    return out


FILTERS = {
    "pending_review": lambda b: b["review_state"] == "pending_review",
    "verified": lambda b: b["review_state"] == "verified",
    "approved": lambda b: b["review_state"] == "approved",
    "ready": lambda b: b["sendable"],
    "can_approve": lambda b: b["can_approve"] and b["review_state"] in ("pending_review", "verified"),
    "blocked": lambda b: bool(b["critical"]),
    "held": lambda b: b["held"] or b["review_state"] == "held",
    "needs_correction": lambda b: b["review_state"] == "needs_correction",
    "changed": lambda b: b["changed_since_review"],
    "not_sent": lambda b: b["delivery"] == "not_sent",
    "sent": lambda b: b["delivery"] not in ("not_sent",),
    "delivered": lambda b: b["delivery"] in ("delivered", "opened", "clicked"),
    "failed": lambda b: b["delivery"] in ("failed", "bounced", "unknown", "partially_sent"),
    "multi": lambda b: b["paid_for"] > 1 or b["tickets_generated"] > 1,
    "late": lambda b: b["late_order"],
    "missing_email": lambda b: any(c["code"] == "NO_VALID_EMAIL" for c in b["critical"]),
}


@router.get(P + "/bookings")
def ec_bookings(event_id: int, filter: Optional[str] = None, q: Optional[str] = None,
                db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_READ)
    bs = bookings(db, event_id)["bookings"]
    if filter and filter in FILTERS:
        bs = [b for b in bs if FILTERS[filter](b)]
    if q:
        ql = q.strip().lower()
        bs = [b for b in bs if ql in " ".join([b["purchaser_name"] or "", b["purchaser_email"] or "", " ".join(b["order_ids"]), b["key"],
                                               " ".join(str(t["id"]) + " " + (t["name"] or "") + " " + (t["email"] or "") for t in b["tickets"])]).lower()]
    return {"items": [_public(b) for b in bs], "count": len(bs), "filters": list(FILTERS)}


@router.get(P + "/bookings/{key}")
def ec_booking(event_id: int, key: str, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_READ)
    b, _ = booking(db, event_id, key)
    if not b:
        raise HTTPException(status_code=404, detail="Booking not found")
    s = _store()
    try:
        out = _public(b, detail=True)
        out["review_log"] = ec_store.review_log(s.db, event_id, key)
        hist = []
        for u in b["units"]:
            for r in s.db.execute("select kind,recipient,state,message_id,result,reason,at,actor,manifest_sha from delivery_attempts "
                                  "where event_id=? and order_id=? order by id", (event_id, u["unit_key"])):
                hist.append({"unit_key": u["unit_key"], "kind": r[0], "recipient": r[1], "state": r[2], "message_id": r[3],
                             "result": r[4], "reason": r[5], "at": r[6], "actor": r[7] or "bulk sender",
                             "template": "Email Center" if (r[8] or "").startswith("ec:") else "bulk/automatic sender"})
        out["history"] = hist
    finally:
        s.close()
    return out


@router.get(P + "/bookings/{key}/preview")
def ec_preview(event_id: int, key: str, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_READ)
    b, built = booking(db, event_id, key)
    if not b:
        raise HTTPException(status_code=404, detail="Booking not found")
    out = []
    for u in b["units"]:
        if not all(i in {t["id"] for t in b["tickets"]} for i in u["ticket_ids"]) or not u["ticket_ids"]:
            continue
        try:
            p = _render(_unit_order(db, built, b, u))
            out.append({"unit_key": u["unit_key"], "recipient": u["recipient"], "subject": p["subject"], "html": p["html"],
                        "from": p.get("from"), "tickets": len(u["ticket_ids"]), "delivery": u["delivery"]})
        except Exception as e:
            out.append({"unit_key": u["unit_key"], "recipient": u["recipient"], "error": "Cannot render: %s" % e})
    return {"key": key, "emails": out}


@router.post(P + "/bookings/{key}/review")
def ec_review(event_id: int, key: str, body: dict, db: Session = Depends(M.get_db),
              current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_REVIEW)
    action = (body.get("action") or "").strip()
    note = (body.get("note") or "").strip()[:1000]
    to = {"verify": "verified", "approve": "approved", "flag": "needs_correction", "hold": "held", "reset": "pending_review"}.get(action)
    if not to:
        raise HTTPException(status_code=400, detail="Unknown action")
    if action in ("flag", "hold") and not note:
        raise HTTPException(status_code=400, detail="Say why (a note is required)")
    b, _ = booking(db, event_id, key)
    if not b:
        raise HTTPException(status_code=404, detail="Booking not found")
    if body.get("fingerprint") and body["fingerprint"] != b["fingerprint"]:
        raise HTTPException(status_code=409, detail="This booking changed while you were reviewing it. Reload and review again.")
    if to in ("verified", "approved") and b["critical"]:
        raise HTTPException(status_code=409, detail="Cannot %s: %s" % (action, "; ".join(c["detail"] for c in b["critical"])))
    if to == "approved" and not any(u["delivery"] == "not_sent" for u in b["units"]):
        # Approving an already-sent booking would only matter for a resend.
        pass
    s = _store()
    try:
        ec_store.set_review(s.db, event_id, key, to, _who(current_user), b["fingerprint"], note)
        s.audit(_who(current_user), "email_center_review_" + action, event_id, key, note, {"fingerprint": b["fingerprint"][:16]})
    finally:
        s.close()
    booking(db, event_id, key)
    return {"ok": True, "key": key, "state": to}


@router.post(P + "/bookings/{key}/send")
def ec_send(event_id: int, key: str, body: dict, db: Session = Depends(M.get_db),
            current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_SEND)
    reason = (body.get("resend_reason") or "").strip() or None
    retry = bool(body.get("retry"))
    if body.get("resend") and not reason:
        raise HTTPException(status_code=400, detail="A resend needs a reason")
    return send_booking(db, event_id, key, _who(current_user), resend_reason=reason, retry=retry,
                        expect_fingerprint=body.get("fingerprint"))


@router.post(P + "/bookings/{key}/outcome")
def ec_outcome(event_id: int, key: str, body: dict, db: Session = Depends(M.get_db),
               current_user: models.User = Depends(M.get_current_user)):
    """After looking the message up in GHL: record what really happened to an
    email whose outcome was uncertain. 'not_sent' makes it retryable; 'sent'
    records it as accepted. Never sends anything itself."""
    _need(db, current_user, event_id, CAP_SEND)
    unit = body.get("unit_key")
    outcome = body.get("outcome")
    note = (body.get("note") or "").strip()
    if outcome not in ("not_sent", "sent") or not note:
        raise HTTPException(status_code=400, detail="Choose what GHL shows and say how you checked")
    b, _ = booking(db, event_id, key)
    if not b or unit not in {u["unit_key"] for u in b["units"]}:
        raise HTTPException(status_code=404, detail="Email not found")
    s = _store()
    try:
        r = s.db.execute("select state from order_ticket_delivery where event_id=? and order_id=?", (event_id, unit)).fetchone()
        if not r or r[0] not in ("unknown", "sending"):
            raise HTTPException(status_code=409, detail="Only an email with an uncertain outcome can be settled this way")
        new = "rejected" if outcome == "not_sent" else "accepted"
        s.db.execute("update order_ticket_delivery set state=?,result=?,updated_at=? where event_id=? and order_id=?",
                     (new, "Settled by %s after checking GHL: %s" % (_who(current_user), note[:150]), ec_store.now(), event_id, unit))
        s.db.execute("insert into delivery_attempts(event_id,order_id,kind,recipient,manifest_sha,ticket_ids,state,message_id,result,reason,at,actor) "
                     "select event_id,order_id,'settled',recipient,manifest_sha,ticket_ids,?,message_id,?,?,?,? from order_ticket_delivery where event_id=? and order_id=?",
                     (new, "outcome settled after checking GHL", note[:300], ec_store.now(), _who(current_user), event_id, unit))
        ec_store.log(s.db, event_id, key, _who(current_user), "outcome_settled", note="%s -> %s: %s" % (unit, new, note))
        s.audit(_who(current_user), "email_center_outcome", event_id, unit, note, {"outcome": outcome})
    finally:
        s.close()
    booking(db, event_id, key)
    return {"ok": True, "unit_key": unit, "state": new}


@router.post(P + "/batches/preview")
def ec_batch_preview(event_id: int, body: dict, db: Session = Depends(M.get_db),
                     current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_SEND)
    if body.get("exhibitor_kind"):
        authz.require_cap(db, current_user, event_id, "exhibitor.write")
        kind = body["exhibitor_kind"]
        if kind not in ("setup", "scanner"):
            raise HTTPException(status_code=400, detail="Unknown email type")
        if kind == "scanner":
            authz.require_cap(db, current_user, event_id, "exhibitor.grant_scanning")
        plan = _ex_batch_plan(db, event_id, [int(x) for x in body.get("ids") or []], kind)
    else:
        mode = "retry" if body.get("retry") else "send"
        plan = _batch_plan(db, event_id, body.get("keys"), bool(body.get("all_approved")), mode)
    s = _store()
    try:
        plan["sending"] = {k: v for k, v in sending_state(s).items() if k != "changed_by"}
    finally:
        s.close()
    plan["sender"] = current_user.email
    return plan


@router.post(P + "/batches")
def ec_batch_start(event_id: int, body: dict, db: Session = Depends(M.get_db),
                   current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_SEND)
    if not body.get("confirm_token"):
        raise HTTPException(status_code=400, detail="Preview the batch and confirm it first")
    if body.get("exhibitor_kind"):
        authz.require_cap(db, current_user, event_id, "exhibitor.write")
        kind = body["exhibitor_kind"]
        if kind == "scanner":
            authz.require_cap(db, current_user, event_id, "exhibitor.grant_scanning")
        plan = _ex_batch_plan(db, event_id, [int(x) for x in body.get("ids") or []], kind)
        keys, bkind = [str(i["id"]) for i in plan["items"]], "exhibitor:" + kind
    else:
        mode = "retry" if body.get("retry") else "send"
        plan = _batch_plan(db, event_id, body.get("keys"), bool(body.get("all_approved")), mode)
        keys, bkind = ["%s|%s" % (i["key"], i["fingerprint"]) for i in plan["items"]], mode
    if plan["confirm_token"] != body["confirm_token"]:
        raise HTTPException(status_code=409, detail="The list changed since you previewed it. Preview again and confirm the new numbers.")
    if not keys:
        raise HTTPException(status_code=400, detail="Nothing eligible to send")
    if len(keys) > BATCH_LIMIT:
        raise HTTPException(status_code=400, detail="At most %d per run" % BATCH_LIMIT)
    s = _store()
    try:
        _require_sending(s)
        bid = create_batch(s, event_id, bkind, _who(current_user), plan, keys)
        s.audit(_who(current_user), "email_center_batch_start", event_id, "batch:%d" % bid, "",
                {"kind": bkind, "items": len(keys), "emails": plan.get("emails"), "confirm": plan["confirm_token"][:16]})
    finally:
        s.close()
    start_batch_thread(bid, event_id)
    return {"ok": True, "batch_id": bid}


@router.get(P + "/batches")
def ec_batches(event_id: int, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_READ)
    s = _store()
    try:
        return [batch_view(s, r[0]) for r in s.db.execute("select id from ec_batches where event_id=? order by id desc limit 30", (event_id,))]
    finally:
        s.close()


@router.get(P + "/batches/{batch_id}")
def ec_batch(event_id: int, batch_id: int, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_READ)
    s = _store()
    try:
        v = batch_view(s, batch_id)
    finally:
        s.close()
    if not v or v["event_id"] != event_id:
        raise HTTPException(status_code=404, detail="Not found")
    return v


@router.post(P + "/batches/{batch_id}/{action}")
def ec_batch_action(event_id: int, batch_id: int, action: str, db: Session = Depends(M.get_db),
                    current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_SEND)
    s = _store()
    try:
        v = batch_view(s, batch_id)
        if not v or v["event_id"] != event_id:
            raise HTTPException(status_code=404, detail="Not found")
        if v["kind"].startswith("exhibitor:"):
            # An exhibitor run is controlled by those who may send exhibitor email.
            authz.require_cap(db, current_user, event_id, "exhibitor.write")
            if v["kind"] == "exhibitor:scanner":
                authz.require_cap(db, current_user, event_id, "exhibitor.grant_scanning")
        if action == "pause":
            s.db.execute("update ec_batches set state='paused',paused_by=? where id=? and state in ('running','queued')", (_who(current_user), batch_id))
        elif action == "cancel":
            s.db.execute("update ec_batches set state='cancelled',paused_by=?,finished_at=? where id=? and state in ('running','queued','paused')",
                         (_who(current_user), ec_store.now(), batch_id))
            s.db.execute("update ec_batch_items set state='cancelled',updated_at=? where batch_id=? and state='queued'", (ec_store.now(), batch_id))
        elif action == "resume":
            _require_sending(s)
            if v["state"] not in ("paused", "interrupted"):
                raise HTTPException(status_code=409, detail="Only a paused or interrupted run can be resumed")
            # A 'working' item of an interrupted run never finished here: its
            # send outcome is in the delivery history (unknown if mid-send), so
            # it is NOT re-queued -- the claim would refuse it anyway.
            s.db.execute("update ec_batch_items set state='interrupted',updated_at=? where batch_id=? and state='working'", (ec_store.now(), batch_id))
            s.db.execute("update ec_batches set state='running',runner=null,heartbeat_at=null,note=null where id=?", (batch_id,))
        else:
            raise HTTPException(status_code=400, detail="Unknown action")
        s.audit(_who(current_user), "email_center_batch_" + action, event_id, "batch:%d" % batch_id)
    finally:
        s.close()
    if action == "resume":
        start_batch_thread(batch_id, event_id)
    return {"ok": True}


@router.get(P + "/history")
def ec_history(event_id: int, q: Optional[str] = None, kind: Optional[str] = None, limit: int = 500,
               db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_READ)
    s = _store()
    try:
        rows = []
        if kind in (None, "", "tickets"):
            for r in s.db.execute("select id,order_id,kind,recipient,state,message_id,result,reason,at,actor,manifest_sha,ticket_ids "
                                  "from delivery_attempts where event_id=? order by id desc limit ?", (event_id, min(limit, 5000))):
                rows.append({"type": "ticket", "id": "t%d" % r[0], "related": r[1], "attempt": r[2], "recipient": r[3], "state": r[4],
                             "message_id": r[5], "result": r[6], "reason": r[7], "at": r[8], "actor": r[9] or "bulk sender",
                             "template": "Ticket email" + (" (Email Center)" if (r[10] or "").startswith("ec:") else ""),
                             "tickets": r[11]})
            cur = {r[0]: r for r in s.db.execute("select order_id,provider_status,provider_checked_at from order_ticket_delivery where event_id=?", (event_id,))}
            for x in rows:
                p = cur.get(x["related"])
                x["provider_status"], x["provider_checked_at"] = (p[1], p[2]) if p else (None, None)
        if kind in (None, "", "exhibitors"):
            names = {e.id: e.company_name for e in db.query(models.Exhibitor).filter(models.Exhibitor.event_id == event_id).all()}
            cur = {(k[0], k[1]): v for k, v in ec_store.exhibitor_rows(s.db, event_id).items()}
            for h in ec_store.exhibitor_history(s.db, event_id):
                c = cur.get((h["exhibitor_id"], h["kind"])) or {}
                rows.append({"type": "exhibitor", "id": "e%d" % h["id"], "related": names.get(h["exhibitor_id"], h["exhibitor_id"]),
                             "exhibitor_id": h["exhibitor_id"], "attempt": h["kind"], "recipient": h["recipient"], "state": h["state"],
                             "message_id": h["message_id"], "result": h["result"], "reason": h["reason"], "at": h["at"], "actor": h["actor"],
                             "template": exhibitor_email.SUBJECTS.get(h["kind"]), "provider_status": c.get("provider_status"),
                             "provider_checked_at": c.get("provider_checked_at")})
    finally:
        s.close()
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in json.dumps(r, default=str).lower()]
    rows.sort(key=lambda r: r["at"] or "", reverse=True)
    return {"items": rows[:limit], "count": len(rows)}


@router.get(P + "/attention")
def ec_attention(event_id: int, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_READ)
    return {"items": attention(db, event_id)}


@router.post(P + "/attention/{item_key}")
def ec_attention_mark(event_id: int, item_key: str, body: dict, db: Session = Depends(M.get_db),
                      current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_REVIEW)
    status = body.get("status") or "open"
    if status not in ("open", "in_progress", "resolved"):
        raise HTTPException(status_code=400, detail="Unknown status")
    s = _store()
    try:
        s.db.execute("insert into ec_attention(event_id,item_key,status,assigned_to,note,updated_by,updated_at) values(?,?,?,?,?,?,?) "
                     "on conflict(event_id,item_key) do update set status=excluded.status,assigned_to=excluded.assigned_to,"
                     "note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
                     (event_id, item_key[:120], status, (body.get("assigned_to") or "")[:80] or None, (body.get("note") or "")[:500],
                      _who(current_user), ec_store.now()))
        s.audit(_who(current_user), "email_center_attention", event_id, item_key, body.get("note") or "", {"status": status})
    finally:
        s.close()
    return {"ok": True}


@router.get(P + "/exhibitors")
def ec_exhibitors(event_id: int, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, "exhibitor.write")
    s = _store()
    try:
        return {"items": exhibitor_rows(db, event_id, s)}
    finally:
        s.close()


@router.get(P + "/exhibitors/{ex_id}/preview")
def ec_ex_preview(event_id: int, ex_id: int, kind: str, db: Session = Depends(M.get_db),
                  current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, "exhibitor.write")
    ex = db.query(models.Exhibitor).filter(models.Exhibitor.id == ex_id, models.Exhibitor.event_id == event_id).first()
    if not ex:
        raise HTTPException(status_code=404, detail="Not found")
    s = _store()
    try:
        if kind == "setup":
            url, exp, _ = _setup_link(db, s, ex, mint_if_missing=False)
            p = exhibitor_email.render_setup(_ex_view(ex), url or "https://api.gaiahealers.app/vendor/(a new link is created when you send)",
                                             (exp or "")[:10])
        elif kind == "scanner":
            if not authz.can(db, current_user, event_id, "exhibitor.grant_scanning"):
                raise HTTPException(status_code=403, detail="Not permitted for this event")
            p = exhibitor_email.render_scanner(_ex_view(ex), _scanner_url(ex) or "(scanning is not enabled for this stand)")
        else:
            raise HTTPException(status_code=400, detail="Unknown email type")
    finally:
        s.close()
    return {"subject": p["subject"], "html": p["html"], "recipient": (ex.contact_email or "").lower() or None}


@router.post(P + "/exhibitors/{ex_id}/send")
def ec_ex_send(event_id: int, ex_id: int, body: dict, db: Session = Depends(M.get_db),
               current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, "exhibitor.write")
    kind = body.get("kind")
    if kind not in ("setup", "scanner"):
        raise HTTPException(status_code=400, detail="Unknown email type")
    if kind == "scanner":
        authz.require_cap(db, current_user, event_id, "exhibitor.grant_scanning")
    return send_exhibitor(db, event_id, ex_id, kind, _who(current_user), (body.get("resend_reason") or "").strip() or None)


@router.post(P + "/exhibitors/{ex_id}/link")
def ec_ex_link(event_id: int, ex_id: int, body: dict, db: Session = Depends(M.get_db),
               current_user: models.User = Depends(M.get_current_user)):
    """A link to copy for sending by hand. The scanner link is never rotated
    here; the setup link is reused while valid and created only if none is."""
    _need(db, current_user, event_id, "exhibitor.write")
    ex = db.query(models.Exhibitor).filter(models.Exhibitor.id == ex_id, models.Exhibitor.event_id == event_id).first()
    if not ex:
        raise HTTPException(status_code=404, detail="Not found")
    kind = body.get("kind")
    s = _store()
    try:
        if kind == "scanner":
            authz.require_cap(db, current_user, event_id, "exhibitor.grant_scanning")
            if not (ex.can_scan_leads and ex.access_token):
                raise HTTPException(status_code=409, detail="Scanning is not enabled for this stand")
            url, created = _scanner_url(ex), False
        elif kind == "setup":
            url, _, created = _setup_link(db, s, ex)
        else:
            raise HTTPException(status_code=400, detail="Unknown link type")
        s.audit(_who(current_user), "email_center_copy_link_" + kind, event_id, "exhibitor:%d" % ex_id, "", {"created": created})
    finally:
        s.close()
    return {"url": url, "created": created}


@router.post(P + "/exhibitors/{ex_id}/manual")
def ec_ex_manual(event_id: int, ex_id: int, body: dict, db: Session = Depends(M.get_db),
                 current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, "exhibitor.write")
    kind = body.get("kind")
    if kind not in ("setup", "scanner"):
        raise HTTPException(status_code=400, detail="Unknown email type")
    ex = db.query(models.Exhibitor).filter(models.Exhibitor.id == ex_id, models.Exhibitor.event_id == event_id).first()
    if not ex:
        raise HTTPException(status_code=404, detail="Not found")
    s = _store()
    try:
        ec_store.exhibitor_manual(s.db, event_id, ex_id, kind, (ex.contact_email or "").lower(), _who(current_user),
                                  (body.get("note") or "").strip()[:300])
        s.audit(_who(current_user), "email_center_manual_" + kind, event_id, "exhibitor:%d" % ex_id, body.get("note") or "")
    finally:
        s.close()
    return {"ok": True}


@router.post(P + "/exhibitors/{ex_id}/outcome")
def ec_ex_outcome(event_id: int, ex_id: int, body: dict, db: Session = Depends(M.get_db),
                  current_user: models.User = Depends(M.get_current_user)):
    """Settle an exhibitor email whose outcome was uncertain, after checking GHL."""
    _need(db, current_user, event_id, "exhibitor.write")
    kind, outcome, note = body.get("kind"), body.get("outcome"), (body.get("note") or "").strip()
    if kind not in ("setup", "scanner") or outcome not in ("not_sent", "sent") or not note:
        raise HTTPException(status_code=400, detail="Choose the email, what GHL shows, and say how you checked")
    s = _store()
    try:
        r = s.db.execute("select state from ec_exhibitor_emails where event_id=? and exhibitor_id=? and kind=?", (event_id, ex_id, kind)).fetchone()
        if not r or r[0] not in ("unknown", "sending"):
            raise HTTPException(status_code=409, detail="Only an email with an uncertain outcome can be settled this way")
        new = "rejected" if outcome == "not_sent" else "accepted"
        ec_store.exhibitor_finish(s.db, event_id, ex_id, kind, new, _who(current_user),
                                  result="Settled after checking GHL: %s" % note[:150], reason="settled")
        s.audit(_who(current_user), "email_center_exhibitor_outcome", event_id, "exhibitor:%d" % ex_id, note, {"kind": kind, "outcome": outcome})
    finally:
        s.close()
    return {"ok": True, "state": new}


@router.patch(P + "/exhibitors/{ex_id}/contact")
def ec_ex_contact(event_id: int, ex_id: int, body: dict, db: Session = Depends(M.get_db),
                  current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, "exhibitor.write")
    ex = db.query(models.Exhibitor).filter(models.Exhibitor.id == ex_id, models.Exhibitor.event_id == event_id).first()
    if not ex:
        raise HTTPException(status_code=404, detail="Not found")
    email = (body.get("contact_email") or "").strip().lower()
    if email and not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="That email address does not look valid")
    before = {"contact_name": ex.contact_name, "contact_email": bool(ex.contact_email)}
    if "contact_name" in body:
        ex.contact_name = (body.get("contact_name") or "").strip()[:200] or None
    if "contact_email" in body:
        ex.contact_email = email or None
    db.commit()
    s = _store()
    try:
        s.audit(_who(current_user), "email_center_exhibitor_contact", event_id, "exhibitor:%d" % ex_id, "",
                {"before": before, "after": {"contact_name": ex.contact_name, "contact_email": bool(ex.contact_email)}})
    finally:
        s.close()
    return {"ok": True}


@router.get(P + "/controls")
def ec_controls(event_id: int, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_READ)
    s = _store()
    try:
        ss = sending_state(s)
    finally:
        s.close()
    return {k: v for k, v in ss.items() if k != "changed_by"} | {"changed_by": ss["changed_by"][0], "changed_at": ss["changed_by"][1]}


@router.post(P + "/controls")
def ec_controls_set(event_id: int, body: dict, db: Session = Depends(M.get_db),
                    current_user: models.User = Depends(M.get_current_user)):
    """The Email Center's own sending switch. Platform admins only. It never
    touches the automatic sender's shadow lock or the global pause."""
    M._get_event_or_404(event_id, db)
    authz.require_admin(current_user)
    want = body.get("sending")
    reason = (body.get("reason") or "").strip()
    if want not in ("on", "off") or not reason:
        raise HTTPException(status_code=400, detail="Choose on or off and give a reason")
    s = _store()
    try:
        s.put("email_center_sending", want, by=_who(current_user))
        s.audit(_who(current_user), "email_center_sending_" + want, event_id, None, reason)
        ss = sending_state(s)
    finally:
        s.close()
    return {k: v for k, v in ss.items() if k != "changed_by"}


@router.post(P + "/refresh-status")
def ec_refresh(event_id: int, db: Session = Depends(M.get_db), current_user: models.User = Depends(M.get_current_user)):
    """Ask GHL now about recently sent emails (bounded)."""
    _need(db, current_user, event_id, CAP_SEND)
    gw = gateway()
    s = _store()
    try:
        n = ec_store.poll_tickets(s.db, gw.status, limit=60) + ec_store.poll_exhibitors(s.db, gw.status, limit=30)
    except RuntimeError as e:
        n = 0
        raise HTTPException(status_code=429, detail=str(e))
    finally:
        s.close()
    invalidate()
    return {"checked": n}


@router.get(P + "/export.csv")
def ec_export(event_id: int, what: str = "orders", db: Session = Depends(M.get_db),
              current_user: models.User = Depends(M.get_current_user)):
    _need(db, current_user, event_id, CAP_EXPORT)
    buf = io.StringIO()
    w = csv.writer(buf)
    cell = M._csv_cell
    if what == "history":
        rows = ec_history(event_id, None, None, 5000, db, current_user)["items"]
        w.writerow(["at_utc", "type", "related", "attempt", "recipient", "state", "provider_status", "message_id", "result", "reason", "by"])
        for r in rows:
            w.writerow([cell(r.get(k)) for k in ("at", "type", "related", "attempt", "recipient", "state", "provider_status",
                                                 "message_id", "result", "reason", "actor")])
    else:
        w.writerow(["order_number", "booking", "purchaser", "purchaser_email", "ticket_types", "paid_for", "tickets_generated",
                    "payment_status", "amount_paid", "qr_status", "reconciliation", "review", "reviewed_by", "approved_by",
                    "email_status", "last_sent_utc", "attempts", "blockers"])
        for b in bookings(db, event_id)["bookings"]:
            rv = b.get("review") or {}
            w.writerow([cell(x) for x in (b["order_number"], b["key"], b["purchaser_name"], b["purchaser_email"], "; ".join(b["ticket_types"]),
                                          b["paid_for"], b["tickets_generated"], b["payment_status"], b["amount_paid"], b["qr_status"],
                                          b["reconciliation"], b["review_state"], rv.get("reviewed_by"), rv.get("approved_by"),
                                          b["delivery"], b["last_sent"], b["attempts"], "; ".join(c["detail"] for c in b["critical"]))])
    db.add(models.ExportAudit(event_id=event_id, user_id=current_user.id, kind="email_center_" + what, count=buf.getvalue().count("\n") - 1))
    db.commit()
    return Response(content=buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="email-center-%s.csv"' % what})


def resume_interrupted():
    """At start-up: nothing resumes by itself. An interrupted run waits for a
    person to press Resume (its unfinished send is in the delivery history)."""
    return None
