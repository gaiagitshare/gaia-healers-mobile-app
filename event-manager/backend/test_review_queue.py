# -*- coding: utf-8 -*-
"""THE LIST OF THINGS WAITING ON A PERSON

Every rule that declines to guess writes down why and moves on. A duplicate
charge held back from becoming a badge, a seat carrying the buyer's name until
somebody asks, a sale whose product nobody mapped, a payment that never settled.
All of it was readable and none of it was anywhere a person would look -- the
held charges sat in an attendee's lifecycle log, which is an audit trail, not a
worklist.

Two properties matter and neither is obvious from reading the endpoint:

  * Items leave when the FACT changes, not when somebody ticks them off. There is
    no queue table to drift out of step with the records.
  * The ones that cannot leave on their own are closed with a reason, and a
    closed item stays closed across reloads without being deleted.

Runs against a COPY. Nothing here touches production.
Run:  python3 /root/event/backend/test_review_queue.py
"""
import os, shutil, sys, tempfile, uuid
from datetime import datetime, timedelta

HERE = "/root/event/backend"
COPY = os.path.join(tempfile.mkdtemp(prefix="review-q-"), "event.db")
shutil.copy(HERE + "/event.db", COPY)
os.environ["DATABASE_URL"] = "sqlite:///" + COPY
sys.path.insert(0, HERE)

import importlib, database                                   # noqa: E402
importlib.reload(database)
import main, models, schemas                                 # noqa: E402
from database import SessionLocal                            # noqa: E402

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

db = SessionLocal()
EVENT = 1
ev = db.query(models.Event).filter(models.Event.id == EVENT).first()
admin = db.query(models.User).filter(models.User.is_admin == True).first()   # noqa: E712

def queue(money=True):
    return main._review_queue(db, EVENT, with_money=money)

def rows(kind, money=True):
    return [r for r in queue(money)["items"] if r["kind"] == kind]

base = queue()
print("\n== 0) it reads the event as it stands ==")
check(base["count"] > 0, "there is work waiting on this event", base["count"])
check(base["money_visible"] is True, "and the organiser's copy includes money")
check(set(base["summary"].keys()) <= {
          "payment_unplaced", "confirm_purchase", "sale_unmapped", "identity_review",
          "name_to_confirm", "seat_unnamed", "payment_unsettled"},
      "every section is one the UI knows how to render", sorted(base["summary"].keys()))
for k, cell in base["summary"].items():
    check(cell["count"] > 0, "the %s summary counts what it lists" % k, cell)
    listed = len(rows(k))
    check(listed == cell["count"], "and %s agrees with its own rows" % k, (cell["count"], listed))

print("\n== 1) a settled repeat is a seat, flagged -- not a held charge ==")
# Organiser's rule (25 Oct 2026): every separate settled ticket transaction is a
# ticket, named at the door. The stuck-PayPal shape (an unsettled charge of the
# same amount on the account) used to hold the second charge back; now it makes
# the seat and flags it as a possible double charge.
mp = db.query(models.TicketMapping).filter(
    models.TicketMapping.event_id == EVENT,
    models.TicketMapping.is_upgrade == False,                            # noqa: E712
    models.TicketMapping.external_product_id != None).first()            # noqa: E711
em = "zz-rq-%s@example.invalid" % uuid.uuid4().hex[:6]
T0 = datetime(2026, 7, 1, 10, 0, 0)


def buy(order, when):
    main.reconcile_attendee(schemas.ReconcileAttendee(
        event_id=EVENT, email=em, ticket_type_id=mp.ticket_type_id,
        product_id=mp.external_product_id, order_id=order, amount=99.0,
        quantity=1, purchased_at=when.isoformat(), is_upgrade=False,
        first_name="Zz", last_name="Queue"), db=db, _=True)
    db.commit()


buy("zz-rq-ord-1", T0)
who = db.query(models.Attendee).filter(models.Attendee.event_id == EVENT,
                                       models.Attendee.email == em).first()
check(who is not None, "the throwaway buyer exists")
db.add(models.PaymentEvent(event_id=EVENT, attendee_id=who.id, amount=99.0,
                           status="pending", occurred_at=T0, provider="paypal",
                           ghl_transaction_id="zz-rq-pending"))
db.commit()
buy("zz-rq-ord-2", T0 + timedelta(days=7))
seat = [a for a in db.query(models.Attendee).filter(models.Attendee.event_id == EVENT).all()
        if int((a.custom_data or {}).get("bought_by_attendee") or 0) == who.id]
check(len(seat) == 1, "the second settled ticket became a seat", [(a.id, a.email) for a in seat])
check(bool(seat and (seat[0].custom_data or {}).get("possible_double_charge")),
      "and the seat carries the possible-double-charge flag", seat and seat[0].custom_data)
check(not rows("charge_held") and not rows("payment_repeat"),
      "nothing is held back or asked as 'paid twice'",
      [r["kind"] for r in rows("charge_held") + rows("payment_repeat")])

print("\n== 2) a close repeat counts as a seat to name, flagged in the queue ==")
em2 = "zz-rq-%s@example.invalid" % uuid.uuid4().hex[:6]
for i, mins in enumerate((0, 6)):
    main.reconcile_attendee(schemas.ReconcileAttendee(
        event_id=EVENT, email=em2, ticket_type_id=mp.ticket_type_id,
        product_id=mp.external_product_id, order_id="zz-rq-close-%d" % i, amount=99.0,
        quantity=1, purchased_at=(T0 + timedelta(minutes=mins)).isoformat(), is_upgrade=False,
        first_name="Zz", last_name="Close"), db=db, _=True)
    db.add(models.PaymentEvent(event_id=EVENT, amount=99.0, status="paid", provider="stripe",
                               occurred_at=T0 + timedelta(minutes=mins), ghl_transaction_id="zz-rq-close-tx-%d" % i,
                               product_ids=[mp.external_product_id], product_names=["Zz ticket"],
                               buyer_email=em2, recon_state="healthy"))
    db.commit()
main.payments_reclassify(db=db, _=True)
who2 = db.query(models.Attendee).filter(models.Attendee.event_id == EVENT, models.Attendee.email == em2).first()
party = main._party_members(db, who2)
check(party and party["paid_for"] == 2 and party["unnamed"] == 1,
      "two close purchases are a booking of two, one waiting for a name", party and {k: party[k] for k in ("paid_for", "size", "unnamed")})
check(party and party.get("possible_double_charges") == 1 and party["purchases"][1]["minutes_after_same_ticket"] == 6.0,
      "with the evidence: 6 minutes after the same ticket, flagged", party and party.get("purchases"))
it = [r for r in rows("seat_unnamed") if r.get("attendee_id") == who2.id]
check(it and "possible double charge" in it[0]["detail"], "the queue row names the flag", it and it[0]["detail"])
check(any(l.get("action") == "possible_double_charge" for l in ((who2.custom_data or {}).get("lifecycle") or [])),
      "and the buyer's record says why")

print("\n== 3) closing an item needs a reason, and closed means closed ==")
item = it[0]
try:
    main.review_queue_resolve(EVENT, schemas.ReviewResolve(
        attendee_id=item["attendee_id"], ref=str(item["ref"]), kind=item["kind"], note="x"),
        db=db, current_user=admin)
    check(False, "a one-character reason is refused", "it was accepted")
except Exception as exc:                                     # noqa: BLE001
    check(getattr(exc, "status_code", None) == 400, "a one-character reason is refused", repr(exc))
main.review_queue_resolve(EVENT, schemas.ReviewResolve(
    attendee_id=item["attendee_id"], ref=str(item["ref"]), kind=item["kind"],
    note="refunded the duplicate in PayPal"), db=db, current_user=admin)
db.commit()
check(not [r for r in rows("seat_unnamed") if r.get("attendee_id") == who2.id],
      "once closed it stops being asked about")
db.refresh(who2)
lc = [l for l in ((who2.custom_data or {}).get("lifecycle") or [])
      if l.get("action") == main.REVIEW_RESOLVED_ACTION]
check(len(lc) == 1 and lc[0].get("reason") == "refunded the duplicate in PayPal",
      "the closure is on the record, with the reason", lc)

print("\n== 4) an item leaves when the FACT changes, with nobody ticking it off ==")
flagged = rows("name_to_confirm")
check(flagged, "there are seats waiting for a name", len(flagged))
target = db.query(models.Attendee).filter(
    models.Attendee.id == flagged[0]["attendee_id"]).first()
cd = dict(target.custom_data or {})
cd.pop("needs_name_check", None)
target.custom_data = cd
db.commit()
check(not [r for r in rows("name_to_confirm") if r["attendee_id"] == target.id],
      "confirming the name removes the row by itself", target.id)
check(len(rows("name_to_confirm")) == len(flagged) - 1,
      "and removes exactly that one", (len(flagged), len(rows("name_to_confirm"))))

print("\n== 4b) every kind that offers Close actually closes ==")
# The Close button appears on three kinds, and each writes a ref that the next
# read has to recognise. Two of them did not match, so closing succeeded and the
# item came straight back -- which is worse than having no button at all.
for _kind in ("seat_unnamed", "identity_review", "name_to_confirm"):
    _rows = [r for r in rows(_kind) if r.get("resolvable")]
    if not _rows:
        print("  SKIP  no %s item on this event to close" % _kind)
        continue
    _r = _rows[0]
    main.review_queue_resolve(EVENT, schemas.ReviewResolve(
        attendee_id=_r["attendee_id"], ref=str(_r["ref"]), kind=_kind,
        note="dealt with during the queue test"), db=db, current_user=admin)
    db.commit()
    _still = [x for x in rows(_kind) if str(x.get("ref")) == str(_r["ref"])]
    check(not _still, "closing a %s item removes it" % _kind,
          [(x["ref"], x["title"]) for x in _still])

print("\n== 5) the desk sees its own work and no money ==")
desk = queue(money=False)
check(desk["money_visible"] is False, "the desk copy says so")
check(not any("amount" in r for r in desk["items"]), "no amount appears in it",
      [r for r in desk["items"] if "amount" in r][:2])
check({r["kind"] for r in desk["items"]} <= {"name_to_confirm", "seat_unnamed", "identity_review"},
      "only the sections a desk can act on", sorted({r["kind"] for r in desk["items"]}))
check(desk["count"] < queue()["count"], "and it is a shorter list than the organiser's",
      (desk["count"], queue()["count"]))

print("\n== 6) cleanup ==")
for a in db.query(models.Attendee).filter(models.Attendee.event_id == EVENT,
                                          models.Attendee.email.like("zz-rq-%")).all():
    for pe in db.query(models.PaymentEvent).filter(models.PaymentEvent.attendee_id == a.id).all():
        db.delete(pe)
    db.delete(a)
db.commit()
check(db.query(models.Attendee).filter(
          models.Attendee.event_id == EVENT,
          models.Attendee.email.like("zz-rq-%")).count() == 0,
      "the throwaway buyer is gone")

print("\n%d failed" % len(fails))
if fails:
    print("FAILED: " + "; ".join(fails))
    sys.exit(1)
print("the review queue reads the records and closes with a reason")
