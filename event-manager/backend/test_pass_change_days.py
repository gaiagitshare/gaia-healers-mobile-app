# -*- coding: utf-8 -*-
"""A pass set by hand decides the days as well as the tier (11 Nov 2026).

A Friday-only buyer upgraded at the desk to the Three Day pass was refused on
Saturday and Sunday ("valid on Friday only"); a Friday pass corrected to
Saturday admitted on Friday and refused on Saturday. Runs on a testbed copy."""
import os, sys, uuid
from datetime import datetime
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import testbed
BASE, DB = testbed.start()
import main, models
from database import SessionLocal

fails = []
def check(cond, label, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else "   " + repr(detail)))
    if not cond: fails.append(label)

db = SessionLocal()
ev = db.query(models.Event).filter(models.Event.id == 1).first()
tt = {t.name: t for t in db.query(models.TicketType).filter(models.TicketType.event_id == 1).all()}
FRI, SAT, THREE = tt["Friday Exhibit Hall"], tt["Saturday Exhibit Hall"], tt["Three Day Event Pass"]

def person(paid_tt, admin_tt=None):
    cd = {"entitlements": [{"ticket_type_id": paid_tt.id, "status": "paid", "order_id": "zz-" + uuid.uuid4().hex[:8],
                            "ts": "2026-11-01T10:00:00"}]}
    if admin_tt: cd["admin_tier"] = admin_tt.id
    a = models.Attendee(event_id=1, email="zz-%s@example.invalid" % uuid.uuid4().hex[:8], first_name="Zz", last_name="Pass",
                        ticket_type_id=(admin_tt or paid_tt).id, custom_data=cd, registration_status="registered",
                        qr_code="ATT-%s" % uuid.uuid4().hex[:12].upper())
    db.add(a); db.commit(); db.refresh(a); return a

def at(day):   # 10:00 in Orlando on that day, as UTC
    return datetime(2026, 11, day, 15, 0, 0)

def ok(a, day):
    d = main._authorize_decision(db, a, ev, "EVENT_ENTRY", at=at(day))
    r = d.get("result") if isinstance(d, dict) else getattr(d, "result", d)
    return str(r).upper().startswith("GRANT"), d

print("PASS CHANGES DECIDE THE DAYS")
up = person(FRI, THREE)
e = main._effective_access(db, up)
check(e["unrestricted_days"] and not e["valid_days"], "Friday upgraded to Three Day is good on every day", (e["valid_days"], e["unrestricted_days"]))
for d in (20, 21, 22):
    g, why = ok(up, d)
    check(g, "and admitted on %d Nov" % d, why)
fix = person(FRI, SAT)
e = main._effective_access(db, fix)
check(e["valid_days"] == [str(SAT.valid_day)[:10]], "Friday corrected to Saturday is good on Saturday only", e["valid_days"])
check(not ok(fix, 20)[0], "and no longer on Friday")
check(ok(fix, 21)[0], "but on Saturday", ok(fix, 21)[1])
plain = person(FRI)
e = main._effective_access(db, plain)
check(e["valid_days"] == [str(FRI.valid_day)[:10]] and not e["unrestricted_days"], "an untouched Friday pass is still Friday only", e["valid_days"])
check(ok(plain, 20)[0] and not ok(plain, 21)[0], "admitted Friday, not Saturday")
print("\n%d failed" % len(fails)); sys.exit(1 if fails else 0)
