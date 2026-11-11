# -*- coding: utf-8 -*-
"""Guests on the planning sheet's guests tab are VIP host guests (11 Nov 2026).

Runs the real people_sync against a throwaway copy of the database, with the
sheet replaced by a small fixture: a new guest gets a complimentary VIP pass,
a guest with no e-mail is reported and not half-created, and a guest who
already has a badge keeps exactly the pass they have.
"""
import os, sys, json, sqlite3, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "tools"))
import testbed
BASE, DB = testbed.start()
os.environ["EVENT_API"] = BASE
os.environ["VENDOR_SYNC_DATA"] = tempfile.mkdtemp(prefix="people-sync-test-")
sys.argv = ["people_sync.py", "--apply"]   # read at import time
import people_sheet as ps
import people_sync

fails = []
def check(cond, label, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else "   " + str(detail)))
    if not cond: fails.append(label)

db = sqlite3.connect(DB)
existing = db.execute("SELECT a.id, a.email, a.ticket_type_id FROM attendees a JOIN ticket_types t ON t.id=a.ticket_type_id "
                      "WHERE a.event_id=1 AND t.is_vip=0 AND a.email IS NOT NULL AND a.email!='' LIMIT 1").fetchone()
NEW = "zz-vip-host-guest@example.invalid"
GUESTS = ("NAME,EMAIL,PHONE,MEDIA?\n"
          "Zz Hostguest,%s,,YES\n"
          "Zz Noemail,,,\n"
          "Zz Already,%s,,NO\n") % (NEW, existing[1])
ps.fetch = lambda gid: GUESTS if gid == ps.GUESTS_GID else ""

print("PEOPLE SYNC: VIP HOST GUESTS")
people_sync.main()
db = sqlite3.connect(DB)
row = db.execute("SELECT a.attendance_type, t.is_vip, t.grants_conference, t.grants_workshops, t.valid_day, a.custom_data, a.job_title "
                 "FROM attendees a JOIN ticket_types t ON t.id=a.ticket_type_id WHERE a.event_id=1 AND lower(a.email)=?", (NEW,)).fetchone()
check(row is not None, "a new guest on the guests tab gets a badge")
if row:
    check(row[1] == 1 and row[2] == 1 and row[3] == 1 and not (row[4] or "").strip(), "on the event's VIP pass (all days, conference, workshops)", row[1:5])
    check(row[0] == "complimentary", "as a complimentary badge, never a sale", row[0])
    check("VIP host guest" in (row[6] or ""), "labelled a VIP host guest", row[6])
    check("media" in (row[6] or "").lower() and "YES" in json.dumps(json.loads(row[5] or "{}")), "the Media column is kept", row[6])
check(db.execute("SELECT count(*) FROM attendees WHERE event_id=1 AND lower(first_name)='zz' AND lower(last_name)='noemail'").fetchone()[0] == 0,
      "a guest with no e-mail is not half-created")
after = db.execute("SELECT ticket_type_id FROM attendees WHERE id=?", (existing[0],)).fetchone()[0]
check(after == existing[2], "a guest who already has a badge keeps exactly that pass", (existing[2], after))
report = open(os.path.join(os.environ["VENDOR_SYNC_DATA"], "people-sync-latest.md")).read()
check("VIP pass (host guest)" in report, "the report says what they were given")
check("Zz Noemail" in report, "and names the guest it could not add")
people_sync.main()
db = sqlite3.connect(DB)
check(db.execute("SELECT count(*) FROM attendees WHERE event_id=1 AND lower(email)=?", (NEW,)).fetchone()[0] == 1,
      "running it again creates nothing new")
print("\n%d checks, %d failed" % (10, len(fails)))
sys.exit(1 if fails else 0)
