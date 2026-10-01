# -*- coding: utf-8 -*-
"""HOW MANY PEOPLE IS THIS EVENT EXPECTING?

Every screen in the panel read the same number, and it was a row count: SELECT
COUNT(*) FROM attendees WHERE event_id = ?. A refunded, cancelled or revoked
ticket keeps its row -- deliberately, because the history of a ticket is worth
more than the space it saves -- and the door refuses it. So the panel counted
people the door will turn away, and it did so silently: the number drifts
further from the truth with every refund, and nothing on the screen says why.

The headline is now who will be ADMITTED, and the blocked rows are reported
beside it rather than folded away. Both read TICKET_BLOCKED_STATUSES, which is
the same list the scanner enforces, so the panel and the door cannot disagree.

Runs against a COPY. Nothing here touches production.
Run:  python3 /root/event/backend/test_attendance_counts.py
"""
import os, shutil, sys, tempfile

HERE = "/root/event/backend"
COPY = os.path.join(tempfile.mkdtemp(prefix="attendance-"), "event.db")
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

print("\nTHE ROLL IS NOT THE HEADCOUNT")
roll = main._roll_counts(db, EVENT)
print("     %d rows  =  %d admitting  +  %d refused at the door"
      % (roll["rows"], roll["admitting"], roll["blocked"]))
check(roll["rows"] == roll["admitting"] + roll["blocked"],
      "the three numbers add up", roll)
check(roll["blocked"] >= 1,
      "this event really does carry a blocked ticket", roll["blocked"])
check(roll["admitting"] < roll["rows"],
      "so the headline is smaller than the table")

print("\nBLOCKED MEANS WHAT THE SCANNER MEANS BY IT")
rows = db.query(models.Attendee).filter(models.Attendee.event_id == EVENT).all()
blocked = [a for a in rows if main._ticket_status(a) in main.TICKET_BLOCKED_STATUSES]
check(len(blocked) == roll["blocked"],
      "the count uses the scanner's own status list", (len(blocked), roll["blocked"]))
event = db.query(models.Event).filter(models.Event.id == EVENT).first()
for a in blocked:
    d = main._authorize_decision(db, a, event, "EVENT_ENTRY")
    check(d.get("granted") is False,
          "%s is refused at the door, as counted" % ("%s %s" % (a.first_name, a.last_name)).strip()[:26],
          d.get("reason"))

print("\nA REFUND DROPS THE HEADLINE, AND SAYS SO")
victim = next(a for a in rows if main._ticket_status(a) not in main.TICKET_BLOCKED_STATUSES)
before = main._roll_counts(db, EVENT)
victim.registration_status = "refunded"
db.flush()
after = main._roll_counts(db, EVENT)
check(after["admitting"] == before["admitting"] - 1,
      "refunding somebody lowers the number the panel shows",
      (before["admitting"], after["admitting"]))
check(after["blocked"] == before["blocked"] + 1,
      "and raises the blocked count by exactly one")
check(after["rows"] == before["rows"],
      "while nothing is deleted — the row and its history stay")
db.rollback()

print("\nEVERY SCREEN READS THE SAME NUMBER")
ev = db.query(models.Event).filter(models.Event.id == EVENT).first()
main._apply_roll_counts(ev, db)
truth = main._roll_counts(db, EVENT)
check(ev.attendee_count == truth["admitting"], "the event card", (ev.attendee_count, truth["admitting"]))
check(ev.blocked_count == truth["blocked"], "carries the blocked count too")
check(ev.roll_rows == truth["rows"], "and still knows how many rows there are")
check(ev.checked_in_count == truth["checked_in"],
      "check-ins are counted among the admitted, never the refused")

print("\nAN ARCHIVED EVENT IS COUNTED THE SAME WAY, SEPARATELY")
r25 = main._roll_counts(db, 2)
print("     2025: %d rows = %d admitting + %d blocked" % (r25["rows"], r25["admitting"], r25["blocked"]))
check(r25["rows"] == r25["admitting"] + r25["blocked"], "2025 adds up too", r25)
check(r25["rows"] != roll["rows"], "and is a different roll, not a copy of this one")

print("\nTHE CHECK-IN RATE IS OUT OF WHO CAN COME")
# Dividing by the row count would permanently understate the rate, by exactly
# the people who were never going to walk in.
rate_rows = round(roll["checked_in"] / roll["rows"] * 100, 2) if roll["rows"] else 0
rate_real = round(roll["checked_in"] / roll["admitting"] * 100, 2) if roll["admitting"] else 0
check(rate_real >= rate_rows, "the rate cannot be dragged down by refunded tickets",
      (rate_real, rate_rows))

print("\n" + ("ALL GOOD" if not fails else "FAILED: " + "; ".join(fails)))
shutil.rmtree(os.path.dirname(COPY), ignore_errors=True)
sys.exit(1 if fails else 0)
