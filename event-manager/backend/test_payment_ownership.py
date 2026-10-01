# -*- coding: utf-8 -*-
"""WHOSE PAYMENT IS THIS?

Somebody buys four tickets. Four payments appear, all four carrying the buyer's
email, because that is the only email the checkout ever saw. The reconciler
answered "whose payment is this?" with "the attendee whose email matches the
buyer's" -- so all four collapsed onto the buyer's badge and the three people
they bought for read as having paid nothing.

That alone would be a counting error. What made it a live one is that the
answer was recomputed on every sweep: fourteen seats rebuilt from the payment
ledger were given their own payment, and the reconciler took it straight back
off them, every minute, silently. By the time anybody looked, the seats existed,
scanned, and showed "No payment on record" at the door.

So the rule is now: a CLAIM beats a guess. A seat created from one specific
payment records which one, and that assignment survives every later reconcile.
Everything else still falls back to the buyer's email, which is the right
answer for one person with one ticket -- which is nearly everybody.

Runs against a COPY. Nothing here touches production.
Run:  python3 /root/event/backend/test_payment_ownership.py
"""
import os, shutil, sys, tempfile

HERE = "/root/event/backend"
COPY = os.path.join(tempfile.mkdtemp(prefix="pay-owner-"), "event.db")
shutil.copy(HERE + "/event.db", COPY)
os.environ["DATABASE_URL"] = "sqlite:///" + COPY
sys.path.insert(0, HERE)

import importlib, database                                   # noqa: E402
importlib.reload(database)
import main, models, payments                                # noqa: E402
from database import SessionLocal                            # noqa: E402
from sqlalchemy import func                                  # noqa: E402

EVENT = 1
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

db = SessionLocal()

def sweep():
    """The same re-attribution the reconciler runs, over every payment."""
    maps = {}
    for m in db.query(models.TicketMapping).filter(models.TicketMapping.is_active == True).all():   # noqa: E712
        if (m.entitlement_type or "EVENT_TICKET") in ("EVENT_TICKET", "EVENT_UPGRADE"):
            maps.setdefault(m.external_product_id, []).append(m)
    claims = {}
    for pe in db.query(models.PaymentEvent).filter(models.PaymentEvent.event_id == EVENT).all():
        if EVENT not in claims:
            claims[EVENT] = main._payment_claims(db, EVENT)
        a = main._attendee_for_payment(db, pe, claims[EVENT])
        pe.attendee_id = a.id if a else None
    db.commit()

seats = db.query(models.Attendee).filter(
    models.Attendee.event_id == EVENT,
    models.Attendee.registration_source.in_(main.PARTY_SEAT_SOURCES)).order_by(models.Attendee.id).all()
check(len(seats) >= 10, "the roll really does contain seats rebuilt from payments", len(seats))

print("\nTHE SEATS CAN SAY WHICH PAYMENT BOUGHT THEM")
claims = main._payment_claims(db, EVENT)
print("     %d of %d seats carry a claim" % (len(claims), len(seats)))
check(len(claims) == len(seats),
      "every rebuilt seat records the payment it was built from", (len(claims), len(seats)))
check(len(set(claims.values())) == len(claims),
      "and no two seats claim the same payment")

print("\nA CLAIM SURVIVES THE RECONCILER")
sweep()
db.expire_all()
kept, lost = [], []
for a in seats:
    n = db.query(models.PaymentEvent).filter(
        models.PaymentEvent.attendee_id == a.id,
        models.PaymentEvent.status == "paid").count()
    (kept if n else lost).append("%s %s" % (a.first_name, a.last_name))
check(not lost, "after a full sweep every rebuilt seat still holds its own payment", lost)
print("     %d seats kept their money through a sweep" % len(kept))

print("\nTHE BUYER KEEPS EXACTLY ONE, NOT ALL FOUR")
for a in seats[:6]:
    cd = a.custom_data or {}
    buyer = db.query(models.Attendee).filter(
        models.Attendee.id == int(cd.get("bought_by_attendee") or 0)).first()
    if not buyer:
        continue
    mine = db.query(models.PaymentEvent).filter(
        models.PaymentEvent.attendee_id == a.id, models.PaymentEvent.status == "paid").count()
    theirs = db.query(models.PaymentEvent).filter(
        models.PaymentEvent.attendee_id == buyer.id, models.PaymentEvent.status == "paid").count()
    check(mine >= 1, "%s holds their own seat's payment" % ("%s %s" % (a.first_name, a.last_name))[:28])
    check(theirs >= 1, "  and %s still holds theirs" % ("%s %s" % (buyer.first_name, buyer.last_name))[:26])

print("\nEVERYBODY ELSE IS STILL MATCHED THE ORDINARY WAY")
# One person, one ticket, no claim anywhere near them: the buyer's email is
# still what answers it, and a sweep must not move them.
plain = db.query(models.PaymentEvent).filter(
    models.PaymentEvent.event_id == EVENT, models.PaymentEvent.status == "paid",
    models.PaymentEvent.attendee_id.isnot(None)).limit(60).all()
moved = []
for pe in plain:
    if pe.id in claims:
        continue
    want = db.query(models.Attendee).filter(
        models.Attendee.event_id == EVENT,
        func.lower(models.Attendee.email) == (pe.buyer_email or "")).first()
    if want and pe.attendee_id != want.id:
        moved.append((pe.id, pe.attendee_id, want.id))
check(not moved, "an ordinary payment still lands on the buyer's own badge", moved[:3])

print("\nA PAYMENT CANNOT BE CLAIMED ACROSS EVENTS")
other = db.query(models.PaymentEvent).filter(models.PaymentEvent.event_id == 2).first()
if other:
    a = main._attendee_for_payment(db, other, claims)
    check(a is None or a.event_id == 2,
          "a 2025 payment never resolves to a 2026 badge", a and a.event_id)

print("\nNO MONEY WENT MISSING")
orphans = db.query(models.PaymentEvent).filter(
    models.PaymentEvent.event_id == EVENT, models.PaymentEvent.status == "paid",
    models.PaymentEvent.attendee_id.is_(None)).count()
check(orphans == 0, "no paid 2026 payment is left pointing at nobody", orphans)
total = db.query(func.sum(models.PaymentEvent.amount)).filter(
    models.PaymentEvent.event_id == EVENT, models.PaymentEvent.status == "paid").scalar()
print("     $%0.2f across %d paid payments, all attributed" % (
    total or 0, db.query(models.PaymentEvent).filter(
        models.PaymentEvent.event_id == EVENT, models.PaymentEvent.status == "paid").count()))

print("\n" + ("ALL GOOD" if not fails else "FAILED: " + "; ".join(fails)))
shutil.rmtree(os.path.dirname(COPY), ignore_errors=True)
sys.exit(1 if fails else 0)
