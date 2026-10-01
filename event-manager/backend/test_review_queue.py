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
          "payment_repeat", "charge_held", "sale_unmapped", "identity_review",
          "name_to_confirm", "seat_unnamed", "payment_unsettled"},
      "every section is one the UI knows how to render", sorted(base["summary"].keys()))
for k, cell in base["summary"].items():
    check(cell["count"] > 0, "the %s summary counts what it lists" % k, cell)
    listed = len(rows(k))
    check(listed == cell["count"], "and %s agrees with its own rows" % k, (cell["count"], listed))

print("\n== 1) a charge held back from becoming a badge shows up ==")
# The one section with no production data, so it is made here rather than assumed.
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
# An unsettled charge of the same amount: the stuck-PayPal shape.
db.add(models.PaymentEvent(event_id=EVENT, attendee_id=who.id, amount=99.0,
                           status="pending", occurred_at=T0, provider="paypal",
                           ghl_transaction_id="zz-rq-pending"))
db.commit()
held_before = len(rows("charge_held"))
buy("zz-rq-ord-2", T0 + timedelta(days=7))
held = [r for r in rows("charge_held") if r.get("attendee_id") == who.id]
check(len(held) == 1, "the held charge appears in the queue, once",
      [(r["ref"], r["title"]) for r in held])
check(len(rows("charge_held")) == held_before + 1,
      "and it did not disturb the other sections", len(rows("charge_held")))
item = held[0]
check(item["severity"] == "error", "it is the most serious kind of row", item["severity"])
check(item["resolvable"] is True, "and it can be closed by hand", item)
check("pending" in (item["detail"] or ""), "the row says why it was held", item["detail"][:90])

print("\n== 2) closing it needs a reason, and then it is gone ==")
try:
    main.review_queue_resolve(EVENT, schemas.ReviewResolve(
        attendee_id=who.id, ref=str(item["ref"]), kind=item["kind"], note="x"),
        db=db, current_user=admin)
    check(False, "a one-character reason is refused", "it was accepted")
except Exception as exc:                                     # noqa: BLE001
    check(getattr(exc, "status_code", None) == 400, "a one-character reason is refused", repr(exc))

main.review_queue_resolve(EVENT, schemas.ReviewResolve(
    attendee_id=who.id, ref=str(item["ref"]), kind=item["kind"],
    note="refunded the duplicate in PayPal"), db=db, current_user=admin)
db.commit()
check(not [r for r in rows("charge_held") if r.get("attendee_id") == who.id],
      "once closed it stops being asked about",
      [r["ref"] for r in rows("charge_held") if r.get("attendee_id") == who.id])

print("\n== 3) closed means closed, not deleted ==")
db.refresh(who)
lc = [l for l in ((who.custom_data or {}).get("lifecycle") or [])
      if l.get("action") == main.REVIEW_RESOLVED_ACTION]
check(len(lc) == 1, "the closure is on the record", lc)
check(lc[0].get("reason") == "refunded the duplicate in PayPal",
      "with the reason that was given", lc[0])
check(lc[0].get("actor") == (admin.email or "staff"), "and who gave it", lc[0].get("actor"))
held_still = [l for l in ((who.custom_data or {}).get("lifecycle") or [])
              if l.get("action") == main.REVIEW_HELD_ACTION]
check(len(held_still) == 1, "the original decision is still in the trail", held_still)

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
