# -*- coding: utf-8 -*-
"""WILL THE NEXT PURCHASE, AND THE NEXT UPGRADE, LAND?

Sixteen people on the 2026 roll carry an admin-set tier: fifteen were moved onto
"General Admission + Conference" after the storefront sold them a pass the
mapping did not grant, and one was comped. That tier exists so the payment
ledger cannot quietly undo a correction.

Read as an OVERRIDE, it did something much worse than that. Any of those
sixteen could buy a VIP upgrade, be charged $297, and still be refused at the
VIP door -- because the correction that was supposed to protect them was also
capping them. The same applied to anybody ever comped or changed at the door,
since that path sets the tier too.

An admin tier is a FLOOR. It holds the line underneath somebody and never over
them. This pins both halves: an upgrade lifts a corrected attendee, and a
refund drops them back to the floor rather than through it.

It also answers the plain question -- does the headcount move correctly when
the next ticket sells -- because a ticket is a person and an upgrade is not.

Runs against a COPY. Nothing here touches production.
Run:  python3 /root/event/backend/test_upgrade_after_correction.py
"""
import os, shutil, sys, tempfile

HERE = "/root/event/backend"
COPY = os.path.join(tempfile.mkdtemp(prefix="upgrade-floor-"), "event.db")
shutil.copy(HERE + "/event.db", COPY)
os.environ["DATABASE_URL"] = "sqlite:///" + COPY
sys.path.insert(0, HERE)

import importlib, database                                   # noqa: E402
importlib.reload(database)
import main, models                                          # noqa: E402
from database import SessionLocal                            # noqa: E402

EVENT = 1
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

db = SessionLocal()
event = db.query(models.Event).filter(models.Event.id == EVENT).first()
types = {t.name: t for t in db.query(models.TicketType).filter(models.TicketType.event_id == EVENT)}
label = lambda a: main._effective_access(db, a).get("effective_label")
door = lambda a, z: main._authorize_decision(db, a, event, z)["result"]

corrected = [a for a in db.query(models.Attendee).filter(models.Attendee.event_id == EVENT).all()
             if (a.custom_data or {}).get("admin_tier") is not None]
check(len(corrected) >= 15, "the roll really does carry admin-set tiers", len(corrected))
print("     %d people carry one" % len(corrected))

print("\nA CORRECTED ATTENDEE BUYS AN UPGRADE")
a = next(x for x in corrected if x.last_name == "Bailey")
print("     %s %s starts on %r" % (a.first_name, a.last_name, label(a)))
check(door(a, "CONFERENCE") == "GRANTED", "their correction works", door(a, "CONFERENCE"))
check(door(a, "VIP") != "GRANTED", "and does not give them VIP they never bought")

cd = dict(a.custom_data or {})
main._ent_record(cd, "test-order", "test-tx", types["VIP Pass"].id, True)
a.custom_data = cd
db.flush()
check(label(a) == "VIP Pass", "a paid VIP upgrade lifts them", label(a))
check(door(a, "VIP") == "GRANTED", "and the VIP door lets them in", door(a, "VIP"))
check(door(a, "CONFERENCE") == "GRANTED", "without losing what they already had")

print("\nAND IF THEY REFUND IT, THEY LAND ON THE FLOOR, NOT THROUGH IT")
cd = dict(a.custom_data or {})
for e in cd["entitlements"]:
    e["status"] = "refunded"
a.custom_data = cd
db.flush()
check(label(a) == "General Admission + Conference",
      "the correction still protects them after the refund", label(a))
check(door(a, "VIP") != "GRANTED", "but the VIP access goes with the money")
db.rollback()

print("\nA FLOOR NEVER DRAGS ANYBODY DOWN")
# Somebody whose PAID tier is already above an admin floor keeps the paid one.
b = next(x for x in corrected if x.last_name == "Bailey")
cd = dict(b.custom_data or {})
main._ent_record(cd, "o2", "t2", types["VIP Pass"].id, False)   # a paid BASE at VIP
cd["admin_tier"] = types["General Admission"].id                 # a lower floor
b.custom_data = cd
db.flush()
check(label(b) == "VIP Pass",
      "a low floor under a high paid tier changes nothing", label(b))
db.rollback()

print("\nA TICKET IS A PERSON; AN UPGRADE IS NOT")
before = main._roll_counts(db, EVENT)
ga = types["General Admission"]
newbie = models.Attendee(
    event_id=EVENT, email="counts-test@example.invalid", first_name="Count", last_name="Test",
    ticket_type_id=ga.id, registration_status="registered", attendance_type="paid",
    registration_source="test", qr_code="ATT-COUNTTEST0001")
db.add(newbie); db.flush()
after_ticket = main._roll_counts(db, EVENT)
check(after_ticket["admitting"] == before["admitting"] + 1,
      "a new ticket raises the headcount by exactly one",
      (before["admitting"], after_ticket["admitting"]))

cd = dict(newbie.custom_data or {})
main._ent_record(cd, "o3", "t3", types["VIP Pass"].id, True)
newbie.custom_data = cd
db.flush()
after_upgrade = main._roll_counts(db, EVENT)
check(after_upgrade["admitting"] == after_ticket["admitting"],
      "their upgrade raises it by none",
      (after_ticket["admitting"], after_upgrade["admitting"]))
check(label(newbie) == "VIP Pass", "while still changing what they hold", label(newbie))

newbie.registration_status = "refunded"
db.flush()
after_refund = main._roll_counts(db, EVENT)
check(after_refund["admitting"] == before["admitting"],
      "and a refund puts the headcount back", (before["admitting"], after_refund["admitting"]))
check(after_refund["rows"] == before["rows"] + 1,
      "with the row and its history still on file")
db.rollback()

print("\n" + ("ALL GOOD" if not fails else "FAILED: " + "; ".join(fails)))
shutil.rmtree(os.path.dirname(COPY), ignore_errors=True)
sys.exit(1 if fails else 0)
