"""WRISTBAND AT CHECK-IN (17 Nov 2026), on a copy of the live database.
GREEN = VIP pass; PURPLE = a pass with workshops; YELLOW = a pass with the
conference, or the One-Day Speaker add-on; RED = bought a RED product (extra
band); none = exhibit hall only, exhibitor staff, speakers, volunteers.
Run:  python3 /root/event/backend/test_wristbands.py
"""
import json, sqlite3, sys, urllib.request
sys.path.insert(0, "/root/event/backend")
import testbed
BASE, DB = testbed.start()
import main, database, models, wristbands as W                   # noqa: E402
fails = []
def check(ok, label, d=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (d,)))
    if not ok: fails.append(label)
db = database.SessionLocal()
ev = db.query(models.Event).get(1)
def first(where, args=()):
    c = sqlite3.connect(DB); r = c.execute("SELECT a.id FROM attendees a JOIN ticket_types t ON t.id=a.ticket_type_id WHERE a.event_id=1 AND " + where + " LIMIT 1", args).fetchone()
    return db.query(models.Attendee).get(r[0]) if r else None
def colors(a): return [w["color"] for w in W.for_attendee(db, a, ev)]
for where, want, label in (
        ("t.is_vip=1 AND a.attendance_type='paid'", ["green"], "a VIP ticket holder: GREEN"),
        ("t.code='GA-CONF' AND a.attendance_type='paid'", ["yellow"], "General Admission + Conference: YELLOW"),
        ("t.code='3DAY'", ["yellow"], "Three Day pass: YELLOW"),
        ("t.code='GA' AND a.attendance_type='paid' AND a.custom_data NOT LIKE '%ONE_DAY_CONFERENCE%'", [], "General Admission only: no wristband"),
        ("t.valid_day IS NOT NULL", [], "a day exhibit pass: no wristband"),
        ("a.attendance_type='speaker'", [], "a speaker: no wristband"),
        ("a.attendance_type='staff'", [], "a volunteer: no wristband"),
        ("a.attendance_type='exhibitor'", [], "exhibitor staff: no wristband"),
        ("a.custom_data LIKE '%ONE_DAY_CONFERENCE%' AND a.attendance_type='paid'", ["yellow"], "One-Day Speaker add-on: YELLOW")):
    a = first(where)
    check(a is not None and colors(a) == want, label, (a and a.id, a and colors(a)))
c = sqlite3.connect(DB)
pe = c.execute("SELECT product_ids, attendee_id FROM payment_events WHERE event_id=1 AND status='paid' AND attendee_id IS NOT NULL AND product_ids LIKE '[\"%' LIMIT 1").fetchone()
a = db.query(models.Attendee).get(pe[1]); before = colors(a)
ev.wristband_red_product_ids = [json.loads(pe[0])[0]]
check(colors(a) == before + ["red"], "a buyer of a RED product gets RED as well", (before, colors(a)))
ev.wristband_red_product_ids = None
check(colors(a) == before, "with no RED product set, nobody is red")
tok = main.create_access_token({"sub": "1"})
req = urllib.request.Request(BASE + "/events/1/attendees/%d/door-identity" % a.id, data=b"{}", method="POST",
                             headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
card = json.load(urllib.request.urlopen(req, timeout=60))["door"]
check(isinstance(card.get("wristbands"), list) and [w["color"] for w in card["wristbands"]] == before
      and all(w["label"] for w in card["wristbands"]), "the door card carries the wristband with its label", card.get("wristbands"))
print("\n%d failed" % len(fails) if fails else "\nALL PASS"); sys.exit(1 if fails else 0)
