# -*- coding: utf-8 -*-
"""Payment monitoring: normalise what GHL says, then say whether Gaia agrees.

Two rules run this file, and they are worth stating before the code.

**GHL's word is kept.** `status_raw` is stored exactly as it arrived and shown
in the detail view. The normalised `status` beside it is for filtering and
colour, and it is a mapping, not a correction — if GHL says `pending`, this says
pending. It does not decide that a PayPal payment sitting in pending for three
weeks is "really" failed, because that would be inventing evidence.

**Payment and reconciliation are separate dimensions.** Money arriving and a
person having a ticket are different facts. The whole value of this screen is
the cases where they disagree, and collapsing them into one status is exactly
what hides those.
"""
from datetime import datetime, timedelta

# GHL's transaction vocabulary, observed live: succeeded, pending, failed,
# refunded, partially_refunded. Orders add: completed, cancelled.
# Anything unrecognised keeps its raw value and lands in "unknown" rather than
# being forced into the nearest bucket.
_STATUS = {
    "succeeded": "paid",
    "success": "paid",
    "completed": "paid",
    "paid": "paid",
    "pending": "pending",
    "processing": "pending",
    "requires_action": "pending",
    "failed": "failed",
    "declined": "declined",
    "canceled": "cancelled",
    "cancelled": "cancelled",
    "refunded": "refunded",
    "partially_refunded": "partially_refunded",
    "reversed": "reversed",
    "disputed": "disputed",
    "chargeback": "disputed",
}

PAID = ("paid",)
REVERSED = ("refunded", "partially_refunded", "reversed", "disputed")
INCOMPLETE = ("pending", "failed", "declined", "cancelled")

# How long a pending payment is unremarkable before it wants a human. PayPal
# redirects legitimately sit pending for a while; three days is well past that
# without flagging every checkout that took a coffee break.
PENDING_STALE_DAYS = 3


def normalise_status(raw):
    """GHL's word -> one of ours. Unrecognised stays unknown, never guessed."""
    return _STATUS.get(str(raw or "").strip().lower(), "unknown")


def display_provider(raw):
    """Providers are discovered, not enumerated: whatever GHL reports is shown.

    Hard-coding stripe/paypal would mean a third provider silently rendering as
    blank on the day somebody switches one on.
    """
    v = str(raw or "").strip().lower()
    return {"stripe": "Stripe", "paypal": "PayPal", "manual": "Manual"}.get(v, (raw or "Unknown"))


def classify(pe, attendee, ticket_active, now=None, person_paid=False):
    """Is this payment and its ticket in a state a human needs to look at?

    `person_paid` is whether this buyer has a successful payment for this event
    by any means. It matters because a declined card followed by a successful
    one is the single most common shape in the data, and judging each row on its
    own turns every one of those into an alert about a customer who is already
    paid up and holding a valid ticket. The failed row is history, not a fault.

    Returns (state, severity, reason). Severity 2 shouts, 1 asks, 0 is silent.
    """
    now = now or datetime.utcnow()
    st = pe.status
    is_event = pe.event_id is not None

    if not is_event:
        # A payment that is not for a mapped event product is not this event's
        # business. It is kept for the record and for the unmapped-sale review,
        # but it is not a reconciliation failure.
        return "not_event", 0, "Not an event product"

    if st in PAID:
        if attendee is None:
            return ("critical", 2,
                    "Money received and no attendee exists — this person cannot get in")
        if not ticket_active:
            return ("critical", 2,
                    "Money received but the ticket is not valid for entry")
        return "healthy", 0, "Paid, ticket issued"

    if st in REVERSED:
        if attendee is not None and ticket_active:
            return ("critical", 2,
                    "Payment was reversed and the ticket is still valid")
        return "healthy", 0, "Reversed, access withdrawn"

    if st == "pending":
        if person_paid:
            return "healthy", 0, "Superseded by a payment that went through"
        if attendee is not None:
            # A ticket standing on money that never arrived.
            return ("warning", 1,
                    "Ticket exists while the payment is still pending")
        age = (now - pe.occurred_at).days if pe.occurred_at else 0
        if age >= PENDING_STALE_DAYS:
            return ("warning", 1,
                    "Pending for %d days — the buyer may think they have paid" % age)
        return "info", 0, "Pending"

    if st in ("failed", "declined", "cancelled"):
        if person_paid:
            return "healthy", 0, "Retried and paid — this attempt is history"
        if attendee is not None:
            return ("warning", 1,
                    "A ticket exists but this payment did not succeed")
        return "healthy", 0, "Did not complete, no ticket — as expected"

    return "warning", 1, "Unrecognised payment status: %s" % (pe.status_raw or "?")


def recovery_rows(events):
    """People who tried to pay and, as far as GHL knows, never did.

    Somebody whose card failed and who then paid by PayPal is NOT a lost sale,
    and calling them one would send an apology to a paying customer. Resolution
    is checked per person across every provider and every attempt.
    """
    paid_emails = {
        (e.buyer_email or "").lower()
        for e in events if e.status in PAID and e.buyer_email
    }
    by_person = {}
    for e in events:
        if e.status not in INCOMPLETE:
            continue
        key = (e.buyer_email or "").lower() or ("contact:" + str(e.contact_id))
        if key in ("", "contact:None"):
            continue
        g = by_person.setdefault(key, {
            "email": e.buyer_email, "name": e.buyer_name, "phone": e.buyer_phone,
            "attempts": 0, "providers": set(), "amount": 0.0, "products": set(),
            "first_at": e.occurred_at, "last_at": e.occurred_at,
            "statuses": set(), "event_id": e.event_id,
        })
        g["attempts"] += 1
        g["providers"].add(display_provider(e.provider))
        g["amount"] = max(g["amount"], e.amount or 0)
        for n in (e.product_names or []):
            g["products"].add(n)
        g["statuses"].add(e.status_raw)
        if e.occurred_at:
            if not g["first_at"] or e.occurred_at < g["first_at"]:
                g["first_at"] = e.occurred_at
            if not g["last_at"] or e.occurred_at > g["last_at"]:
                g["last_at"] = e.occurred_at
        if e.event_id:
            g["event_id"] = e.event_id

    out = []
    now = datetime.utcnow()
    for key, g in by_person.items():
        recovered = (g["email"] or "").lower() in paid_emails
        out.append({
            "email": g["email"], "name": g["name"], "phone": g["phone"],
            "attempts": g["attempts"],
            "providers": sorted(g["providers"]),
            "tried_more_than_one_provider": len(g["providers"]) > 1,
            "amount": round(g["amount"], 2),
            "products": sorted(g["products"]),
            "first_attempt": g["first_at"].isoformat() if g["first_at"] else None,
            "last_attempt": g["last_at"].isoformat() if g["last_at"] else None,
            "age_days": (now - g["first_at"]).days if g["first_at"] else None,
            "ghl_statuses": sorted(s for s in g["statuses"] if s),
            "recovered": recovered,
        })
    # Unrecovered first, then by money at stake: a $3,500 stand that never paid
    # matters more than a $99 ticket, and both matter more than a resolved one.
    out.sort(key=lambda r: (r["recovered"], -(r["amount"] or 0)))
    return out


def summarise(events, since=None):
    """The figures at the top. Attempts, successful payments and unique buyers
    are counted separately, because a retried card is one buyer and three rows."""
    rows = [e for e in events if (since is None or (e.occurred_at and e.occurred_at >= since))]
    paid = [e for e in rows if e.status in PAID]
    by_provider = {}
    for e in paid:
        p = display_provider(e.provider)
        by_provider[p] = by_provider.get(p, 0) + 1
    return {
        "attempts": len(rows),
        "paid": len(paid),
        "paid_amount": round(sum(e.amount or 0 for e in paid), 2),
        "unique_buyers": len({(e.buyer_email or "").lower() for e in paid if e.buyer_email}),
        "by_provider": by_provider,
        "pending": sum(1 for e in rows if e.status == "pending"),
        "declined_or_failed": sum(1 for e in rows if e.status in ("failed", "declined")),
        "refunded": sum(1 for e in rows if e.status in REVERSED),
        "paid_missing_ticket": sum(1 for e in rows if e.severity == 2 and e.status in PAID),
        "critical": sum(1 for e in rows if e.severity == 2),
        "warning": sum(1 for e in rows if e.severity == 1),
    }
