# -*- coding: utf-8 -*-
"""A stand buys its own scanned leads through the GHL checkout (Babak, 14 Nov 2026).

One offer: the leads a stand scanned, one price per event ($199 for ELEVATE
2026). The other list offers are not sold.

How a payment becomes an unlock, with no person in the loop when it is clear:

  * The stand's scanner screen links to the event's GHL checkout
    (`Event.scanned_leads_checkout_url`), with the stand's contact email
    pre-filled, so the buyer is normally the email we already hold.
  * The payment reaches Gaia like every other GHL sale (webhook at once, the
    mirror every 15 minutes) as a PaymentEvent. A paid, live payment for one of
    the event's leads products (`Event.scanned_leads_product_ids`) whose buyer
    email is the contact email of exactly ONE scanning stand unlocks that stand,
    and records which payment did it.
  * Anything less certain is never guessed: no stand, two stands, a test-mode
    payment. It waits on the Exhibitors page, where an organiser assigns it.
  * A refund never re-locks a stand by itself (somebody may already be using
    the leads); it is flagged on the same page for an organiser to decide.

Idempotent: running it again over the same payments changes nothing.
"""
import json
import os
from datetime import datetime
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qsl

from sqlalchemy import func

import models
import payments

LOG = os.path.join(os.environ.get("VENDOR_SYNC_DATA") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"),
                   "leads-unlock.log")


def product_ids(event):
    raw = getattr(event, "scanned_leads_product_ids", None) or []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = [raw]
    return [str(p).strip() for p in raw if str(p or "").strip()]


def _pids(pe):
    raw = pe.product_ids or []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = []
    return [str(p) for p in raw if p]


def checkout_url(event, ex):
    """The event's checkout with this stand's contact pre-filled, or None when
    the event has no checkout or no price yet (the screen then says so)."""
    base = (getattr(event, "scanned_leads_checkout_url", None) or "").strip() if event else ""
    if not base or not getattr(event, "scanned_leads_price", None) or not base.startswith("https://"):
        return None
    parts = urlsplit(base)
    q = dict(parse_qsl(parts.query))
    if ex.contact_email:
        q.setdefault("email", ex.contact_email.strip())
    if ex.company_name:
        q.setdefault("company_name", ex.company_name.strip())
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q), parts.fragment))


def _log(entry):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a") as f:
            f.write(json.dumps(dict(entry, at=datetime.utcnow().isoformat() + "Z")) + "\n")
    except OSError:
        pass


def _leads_events(db):
    return [e for e in db.query(models.Event).all() if product_ids(e)]


def candidates(db, event_id, email):
    if not email:
        return []
    return db.query(models.Exhibitor).filter(
        models.Exhibitor.event_id == event_id,
        func.lower(func.trim(models.Exhibitor.contact_email)) == email.strip().lower(),
        models.Exhibitor.can_scan_leads == True,                     # noqa: E712
    ).all()


def _digits10(p):
    d = "".join(ch for ch in str(p or "") if ch.isdigit())
    return d[-10:] if len(d) >= 10 else ""


def candidates_by_phone(db, event_id, phone):
    """The stand whose contact phone is the buyer's (last ten digits). Used only
    when the buyer's email matches no stand: 18 Nov 2026, Transform and RISE's
    speaker paid $199 from her personal email, but with the stand's own phone."""
    want = _digits10(phone)
    if not want:
        return []
    return [x for x in db.query(models.Exhibitor).filter(
        models.Exhibitor.event_id == event_id,
        models.Exhibitor.can_scan_leads == True).all()               # noqa: E712
        if _digits10(x.contact_phone) == want]


def unlock(db, ex, pe=None, source="payment", actor=None):
    """Open a stand's leads, saying why. Never touches a stand already open."""
    if ex.leads_unlocked:
        return False
    ex.leads_unlocked = True
    ex.leads_unlocked_at = datetime.utcnow()
    ex.leads_unlock_source = source
    ex.leads_unlock_payment_id = pe.id if pe is not None else None
    _log({"op": "unlock", "exhibitor": ex.id, "source": source, "payment": pe.id if pe is not None else None,
          "actor": actor})
    return True


def apply_payment(db, pe, events=None):
    """Judge one payment. Returns what happened, for tests and the log."""
    if pe is None:
        return None
    events = _leads_events(db) if events is None else events
    pids = set(_pids(pe))
    event = next((e for e in events if pids & set(product_ids(e))), None)
    if event is None:
        return None
    if pe.status not in payments.PAID or pe.live_mode is False:
        return "not_paid"
    db.flush()
    # Already counted: this payment opened a stand before.
    if db.query(models.Exhibitor.id).filter(models.Exhibitor.leads_unlock_payment_id == pe.id).first():
        return "already"
    hits = candidates(db, event.id, pe.buyer_email)
    source = "payment"
    if not hits:
        hits = candidates_by_phone(db, event.id, pe.buyer_phone)
        source = "payment_phone"
    if len(hits) != 1:
        return "unmatched" if not hits else "ambiguous"
    ex = hits[0]
    if ex.leads_unlocked:
        # Opened by hand before the money arrived: note the payment that
        # settles it, so it is not left looking unmatched.
        if ex.leads_unlock_payment_id is None and not ex.full_list_access:
            ex.leads_unlock_payment_id = pe.id
            _log({"op": "link", "exhibitor": ex.id, "payment": pe.id, "actor": None})
            return "linked"
        return "stand_already_open"
    unlock(db, ex, pe, source)
    return "unlocked"


def sweep(db):
    """Every leads payment on file, judged again (after a product id is set, or
    by the mirror). Cheap: a handful of rows."""
    events = _leads_events(db)
    if not events:
        return {}
    all_pids = {p for e in events for p in product_ids(e)}
    out = {}
    for pe in db.query(models.PaymentEvent).filter(models.PaymentEvent.status.in_(list(payments.PAID))).all():
        if set(_pids(pe)) & all_pids:
            out[pe.id] = apply_payment(db, pe, events)
    return out


def payments_for_event(db, event):
    """Every payment for this event's leads products, with the stand it opened
    (or why it opened none), newest first. Admin only."""
    pids = set(product_ids(event))
    if not pids:
        return []
    by_payment = {x.leads_unlock_payment_id: x for x in db.query(models.Exhibitor).filter(
        models.Exhibitor.event_id == event.id, models.Exhibitor.leads_unlock_payment_id.isnot(None)).all()}
    rows = []
    for pe in db.query(models.PaymentEvent).order_by(models.PaymentEvent.occurred_at.desc()).all():
        if not (set(_pids(pe)) & pids):
            continue
        ex = by_payment.get(pe.id)
        if ex is not None:
            state = "refunded_still_open" if pe.status in payments.REVERSED else "unlocked"
        elif pe.status in payments.REVERSED:
            state = "refunded"
        elif pe.status not in payments.PAID:
            state = "not_paid"
        elif pe.live_mode is False:
            state = "test_mode"
        else:
            n = len(candidates(db, event.id, pe.buyer_email) or candidates_by_phone(db, event.id, pe.buyer_phone))
            state = "unmatched" if n == 0 else "ambiguous" if n > 1 else "stand_already_open"
        rows.append({"id": pe.id, "occurred_at": pe.occurred_at, "buyer_name": pe.buyer_name,
                     "buyer_email": pe.buyer_email, "amount": pe.amount, "currency": pe.currency,
                     "status": pe.status, "state": state,
                     "exhibitor": ({"id": ex.id, "company_name": ex.company_name, "booth_number": ex.booth_number}
                                   if ex is not None else None),
                     "needs_attention": state in ("unmatched", "ambiguous", "refunded_still_open")})
    return rows


def assign(db, event, pe, ex, actor):
    """An organiser says which stand a payment was for."""
    if ex.event_id != event.id:
        raise ValueError("wrong_event")
    if not (set(_pids(pe)) & set(product_ids(event))):
        raise ValueError("not_a_leads_payment")
    if pe.status not in payments.PAID:
        raise ValueError("not_paid")
    if db.query(models.Exhibitor.id).filter(models.Exhibitor.leads_unlock_payment_id == pe.id).first():
        raise ValueError("payment_already_used")
    if ex.leads_unlocked:
        # Record the payment against it all the same, so the list is settled.
        ex.leads_unlock_payment_id = pe.id
        _log({"op": "link", "exhibitor": ex.id, "payment": pe.id, "actor": actor})
        return "linked"
    unlock(db, ex, pe, "payment_assigned", actor)
    return "unlocked"
