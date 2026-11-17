# -*- coding: utf-8 -*-
"""EXHIBITOR STAFF FROM THE SHEET, AND RENAMED STANDS -- 17 Nov 2026.

The Vendors tab gained a "Staff Members at the Event" column that nothing read
(36 of 45 people unbadged), and two stands the sheet retyped ("First
Alternative Care" -> "First Alternative") became second stands. Checked here,
on a throwaway copy of the live database and today's sheet:
  1. the staff cell is split into people the way the team types it (names and
     addresses on separate lines, phones, roles, address-only lines);
  2. a stand renamed in the sheet is matched by its contact email and renamed,
     keeping its id, scanner and listing -- no second stand is created;
  3. the staff sync: new people get an exhibitor badge on the GA pass with the
     stand as company; people with any badge are left alone; no email / no
     name / unconfirmed stand are reported, never half-created; a second run
     adds nobody; nothing is sent.
Run:  python3 /root/event/backend/test_exhibitor_staff_sync.py
"""
import csv, io, os, secrets, shutil, sqlite3, subprocess, sys, tempfile

HERE = "/root/event/backend"
sys.path.insert(0, os.path.join(HERE, "tools"))
import vendor_sheet as vs

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + repr(extra)[:600])))
    if not cond: fails += 1

print("1. parsing the staff cell")
P = vs.parse_staff
r = P("Michael Porter - mporter@braintap.com\nShawn Bean - sbean@braintap.com\nDr. Patrick Porter, PhD - Speaker - pporter@braintap.com")
check([(p["name"], p["email"]) for p in r] == [("Michael Porter", "mporter@braintap.com"), ("Shawn Bean", "sbean@braintap.com"),
                                               ("Patrick Porter", "pporter@braintap.com")], "name - email on one line; titles dropped", r)
r = P("Erin Currin \nerinina2020@gmail.com\nShannon Procise\nShannon@shannonprocise.com")
check([(p["name"], p["email"]) for p in r] == [("Erin Currin", "erinina2020@gmail.com"), ("Shannon Procise", "shannon@shannonprocise.com")],
      "name and address on alternate lines pair up", r)
r = P("Ariel Molina\nPaola Palacio\nDarya Smith\nJacob Wilson \narielthemermaidllc@gmail.com")
check([p["email"] for p in r] == ["arielthemermaidllc@gmail.com", None, None, None],
      "a trailing address goes to the name it belongs to, not just the last name", r)
r = P("Jason Cestaro - ‪+1 (321) 987‑4949‬\nSean Speer - ‪+1 (910) 599‑8971‬")
check([(p["name"], p["email"], bool(p["phone"])) for p in r] == [("Jason Cestaro", None, True), ("Sean Speer", None, True)],
      "phone-only lines: names kept, phones read, no email", r)
r = P("Ray@myivspaorlando.com\nPatricia@myivspaorlando.com ")
check(all(p["name_from_email"] for p in r) and [p["email"] for p in r] == ["ray@myivspaorlando.com", "patricia@myivspaorlando.com"],
      "address-only lines are marked as having no name", r)
r = P("David Federman (Sales Consultant) dfederman@pulsepemf.com\nScott Baider (CEO) sbaider@pulsepemf.com")
check([p["name"] for p in r] == ["David Federman", "Scott Baider"], "roles in brackets are not part of the name", r)
check(P("") == [] and P("   ") == [], "an empty cell is nobody")

print("2. a stand renamed in the sheet")
import testbed
BASE, DB = testbed.start()
work = tempfile.mkdtemp(prefix="staffsync-")
try:
    db = sqlite3.connect(DB, timeout=30); db.row_factory = sqlite3.Row
    TAG = secrets.token_hex(3)
    text = vs.fetch_csv()
    rows = list(csv.reader(io.StringIO(text)))
    hi = next(i for i, r in enumerate(rows) if "Company Name" in [c.strip() for c in r])
    hdr = [c.strip() for c in rows[hi]]
    ci, ei = hdr.index("Company Name"), hdr.index("Email")
    si = next(i for i, h in enumerate(hdr) if h.lower().startswith("staff"))
    sheet = vs.parse(text)
    stands = {vs.norm_name(s["company_name"]): s for s in db.execute(
        "SELECT * FROM exhibitors WHERE event_id=1 AND stage='confirmed' AND can_scan_leads=1 AND contact_email LIKE '%@%'")}
    # one confirmed scanning stand whose email no other stand shares
    rec = next(r for r in sheet if r["stage"] == "confirmed" and vs.norm_name(r["company"]) in stands
               and (r["email"] or "").strip().lower() == stands[vs.norm_name(r["company"])]["contact_email"].strip().lower()
               and db.execute("SELECT count(*) FROM exhibitors WHERE event_id=1 AND lower(contact_email)=?",
                              (stands[vs.norm_name(r["company"])]["contact_email"].lower(),)).fetchone()[0] == 1)
    victim = stands[vs.norm_name(rec["company"])]
    newname = "ZZ Renamed %s %s" % (rec["company"], TAG)
    rows[rec["row"] - 1][ci] = newname
    # 3's fixture: staff on that same stand
    known = db.execute("SELECT email, first_name, last_name FROM attendees WHERE event_id=1 AND attendance_type='paid' "
                       "AND email LIKE '%@%' LIMIT 1").fetchone()
    cell = ("zz-orphan-%s@example.invalid\nZz Newperson - zz-new-%s@example.invalid\nZz Second\nzz-second-%s@example.invalid\n"
            "%s %s - %s\nZz Nomail - +1 (555) 010 0199"
            % (TAG, TAG, TAG, known["first_name"], known["last_name"], known["email"]))
    while len(rows[rec["row"] - 1]) <= si:
        rows[rec["row"] - 1].append("")
    rows[rec["row"] - 1][si] = cell
    sheet_csv = os.path.join(work, "sheet.csv")
    with open(sheet_csv, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(rows)
    env = dict(os.environ, DATABASE_URL="sqlite:///" + DB, VENDOR_SYNC_DATA=work, EVENT_API=BASE)
    n_before = db.execute("SELECT count(*) FROM exhibitors WHERE event_id=1").fetchone()[0]
    out = subprocess.run([sys.executable, os.path.join(HERE, "tools", "vendor_sync.py"), "--apply", sheet_csv],
                         env=env, capture_output=True, text=True, timeout=180)
    db = sqlite3.connect(DB, timeout=30); db.row_factory = sqlite3.Row
    after = db.execute("SELECT * FROM exhibitors WHERE id=?", (victim["id"],)).fetchone()
    check(out.returncode in (0, 3) and db.execute("SELECT count(*) FROM exhibitors WHERE event_id=1").fetchone()[0] == n_before,
          "no second stand is created", out.stdout[-600:] + out.stderr[-400:])
    check(after["company_name"] == newname, "the stand takes the sheet's new name", after["company_name"])
    check(after["can_scan_leads"] == victim["can_scan_leads"] and after["is_published"] == victim["is_published"]
          and after["access_token"] == victim["access_token"], "and keeps its id, scanner, link and listing")
    out = subprocess.run([sys.executable, os.path.join(HERE, "tools", "vendor_sync.py"), sheet_csv],
                         env=env, capture_output=True, text=True, timeout=180)
    check("to create: 0" in out.stdout and "to update: 0" in out.stdout, "a second run changes nothing", out.stdout[:400])

    print("3. the staff sync")
    tool = os.path.join(HERE, "tools", "exhibitor_staff_sync.py")
    att0 = db.execute("SELECT count(*) FROM attendees WHERE event_id=1").fetchone()[0]
    dry = subprocess.run([sys.executable, tool, sheet_csv], env=env, capture_output=True, text=True, timeout=180)
    check(dry.returncode == 0 and "zz-new-%s@example.invalid" % TAG in dry.stdout
          and db.execute("SELECT count(*) FROM attendees WHERE event_id=1").fetchone()[0] == att0,
          "a dry run lists the new people and writes nothing", dry.stdout[-500:] + dry.stderr[-500:])
    app = subprocess.run([sys.executable, tool, "--apply", sheet_csv], env=env, capture_output=True, text=True, timeout=300)
    db = sqlite3.connect(DB, timeout=30); db.row_factory = sqlite3.Row
    def person(email):
        return db.execute("SELECT a.*, t.code FROM attendees a LEFT JOIN ticket_types t ON t.id=a.ticket_type_id "
                          "WHERE a.event_id=1 AND lower(a.email)=?", (email,)).fetchall()
    new = person("zz-new-%s@example.invalid" % TAG)
    check(len(new) == 1 and new[0]["attendance_type"] == "exhibitor" and new[0]["code"] == "GA"
          and new[0]["company"] == newname and new[0]["job_title"] == "Exhibitor staff"
          and new[0]["first_name"] == "Zz" and new[0]["last_name"] == "Newperson",
          "a new person: exhibitor badge, GA pass, the stand as company", [dict(x) for x in new] or app.stdout[-600:] + app.stderr[-600:])
    check(len(person("zz-second-%s@example.invalid" % TAG)) == 1, "a name with its address on the next line gets a badge")
    check(not db.execute("SELECT 1 FROM attendees WHERE event_id=1 AND last_name='Nomail'").fetchone()
          and "Zz Nomail" in app.stdout, "no email: reported, no badge", app.stdout[-600:])
    check(not person("zz-orphan-%s@example.invalid" % TAG) and "zz-orphan-%s@example.invalid" % TAG in app.stdout,
          "an address with no name: reported, no badge")
    check(len(person(known["email"].lower())) == 1 and person(known["email"].lower())[0]["attendance_type"] == "paid",
          "someone who already has a ticket keeps it, untouched")
    again = subprocess.run([sys.executable, tool, "--apply", sheet_csv], env=env, capture_output=True, text=True, timeout=180)
    check("to add: 0" in again.stdout or "given a badge: 0" in again.stdout, "a second run adds nobody", again.stdout[:300])
    live = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "event.db"), uri=True)
    check(not live.execute("SELECT 1 FROM attendees WHERE email LIKE ?", ("%" + TAG + "@example.invalid",)).fetchone(),
          "the live database was never touched")
    dd = sqlite3.connect("file:%s?mode=ro" % os.environ.get("TICKET_DELIVERY_DB", os.path.join(HERE, "data", "ticket-delivery.db")), uri=True)
    check(not dd.execute("SELECT 1 FROM order_ticket_delivery WHERE recipient LIKE ?", ("%" + TAG + "@example.invalid",)).fetchone(),
          "nothing was sent")
finally:
    shutil.rmtree(work, ignore_errors=True)

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
