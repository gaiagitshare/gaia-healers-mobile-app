# -*- coding: utf-8 -*-
"""EXHIBITOR PACKAGES — a package bought through GHL reaches the exhibitor list.

"The Ambassador" / "The Connector" / "The Community Builder" / "The Legacy
Partner" are sold through the GHL checkout on the exhibitors-and-speakers page.
Those payments already reach the Event Manager, but were filed as "unrelated"
sales and never became exhibitors (28 Oct 2026).

Proves, on a COPY of the live database (served by the real API) with
controlled test sales:
  1. off by default: nothing changes without EXHIBITOR_PACKAGE_SYNC=1
  2. a dry run reports and writes nothing
  3. a buyer who is already an exhibitor (same email) is linked, not duplicated;
     their package is filled only if empty
  4. a new buyer becomes ONE exhibitor in stage "purchased" -- unpublished, no
     scanner, paid -- even with two package payments
  5. a package from last year's selling window is left alone
  6. the sales leave the unmapped review queue (status "exhibitor")
  7. no ticket or attendee is ever created from a package
  8. the public directory does not show a "purchased" stand
  9. a second run changes nothing
 10. the planning sheet adopts the purchased stand by email (company name and
     stage from the sheet, no second exhibitor)
 11. the live database is never touched

Run:  python3 /root/event/backend/test_exhibitor_package_sync.py
"""
import csv, io, json, os, sqlite3, subprocess, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "tools", "exhibitor_package_sync.py")
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "tools"))
import testbed
import vendor_sheet as vs

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + str(extra)[:500])))
    if not cond: fails += 1

print("EXHIBITOR PACKAGES")
live = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "event.db"), uri=True)
LQ = ("SELECT (SELECT count(*) FROM exhibitors), (SELECT count(*) FROM attendees), "
      "(SELECT group_concat(status||coalesce(relevance,''), '|') FROM unmapped_sales)")
live_before = live.execute(LQ).fetchone()
BASE, DB = testbed.start()
work = os.path.dirname(DB)
base = dict(os.environ, DATABASE_URL="sqlite:///" + DB, VENDOR_SYNC_DATA=work)
base.pop("EXHIBITOR_PACKAGE_SYNC", None)

def run(*args, **env):
    return subprocess.run([sys.executable, TOOL] + list(args), env=dict(base, **env), capture_output=True, text=True, timeout=120)
def db():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row; return c
def snap():
    c = db()
    return ([tuple(r) for r in c.execute("SELECT * FROM exhibitors ORDER BY id")],
            [tuple(r) for r in c.execute("SELECT id, status, relevance FROM unmapped_sales ORDER BY id")])

# Controlled test sales only. The real package sales already in the copy are set
# aside so the counts below are about these rows alone.
c = db()
c.execute("UPDATE unmapped_sales SET status='dismissed' WHERE status='pending'")
known = c.execute("SELECT id, company_name, contact_email FROM exhibitors WHERE event_id=1 AND stage='confirmed' "
                  "AND contact_email LIKE '%@%' AND coalesce(package,'')='' LIMIT 1").fetchone()
if known is None:
    known = c.execute("SELECT id, company_name, contact_email FROM exhibitors WHERE event_id=1 AND contact_email LIKE '%@%' LIMIT 1").fetchone()
    c.execute("UPDATE exhibitors SET package=NULL WHERE id=?", (known["id"],))
def sale(ref, product, email, name, amount, paid):
    c.execute("INSERT INTO unmapped_sales (event_id, reference, source, product_id, product_name, buyer_name, buyer_email, "
              "amount, currency, quantity, paid_at, status, relevance, relevance_reason, first_seen) "
              "VALUES (NULL,?,?,?,?,?,?,?,'USD',1,?,'pending','unrelated','matches the non-event catalogue',datetime('now'))",
              (ref, "ghl_order", "test-pkg", product, name, email, amount, paid))
sale("zz-pkg-1", "The Ambassador", known["contact_email"].lower(), "Known Buyer", 3500, "2026-08-01T10:00:00Z")
sale("zz-pkg-2", "The Connector", "zz.newstand@example.invalid", "Zz New Stand", 5000, "2026-09-01T10:00:00Z")
sale("zz-pkg-3", "The Ambassador", "zz.newstand@example.invalid", "Zz New Stand", 3500, "2026-09-02T10:00:00Z")
sale("zz-pkg-old", "The Ambassador", "zz.lastyear@example.invalid", "Zz Last Year", 3500, "2025-08-01T10:00:00Z")
sale("zz-not-pkg", "Bio-Well 3.0", "zz.device@example.invalid", "Zz Device", 4200, "2026-09-03T10:00:00Z")
c.commit()
n_att = c.execute("SELECT count(*) FROM attendees").fetchone()[0]
n_ex = c.execute("SELECT count(*) FROM exhibitors").fetchone()[0]

print("\n== 1) off by default ==")
s0 = snap(); r = run()
check(r.returncode == 0 and snap() == s0, "without EXHIBITOR_PACKAGE_SYNC=1 nothing changes")

print("\n== 2) dry run ==")
r = run(EXHIBITOR_PACKAGE_SYNC="1")
check(r.returncode == 0 and "this event (2025-11-20 to 2026-11-22): 3" in r.stdout and snap() == s0,
      "3 package sales for this event reported, nothing written", r.stdout[:400])

print("\n== 3) a buyer who is already an exhibitor is linked ==")
r = run("--apply", EXHIBITOR_PACKAGE_SYNC="1")
k = db().execute("SELECT * FROM exhibitors WHERE id=?", (known["id"],)).fetchone()
check(k["package"] == "The Ambassador $3,500", "the empty package is filled in", k["package"])
check(k["company_name"] == known["company_name"], "nothing else about them changes")

print("\n== 4) a new buyer becomes one pending exhibitor ==")
new = db().execute("SELECT * FROM exhibitors WHERE contact_email='zz.newstand@example.invalid'").fetchall()
check(len(new) == 1, "two payments, one exhibitor", len(new))
n = new[0]
check(n["stage"] == "purchased" and n["is_published"] == 0 and n["can_scan_leads"] == 0 and n["payment_status"] == "paid",
      "stage purchased, unpublished, no scanner, paid", dict(n))
check(n["package"] == "The Connector $5,000 + The Ambassador $3,500" and abs((n["amount_paid"] or 0) - 8500) < 0.01
      and "zz-pkg-2" in (n["payment_note"] or ""), "package, amount and the GHL references are carried", (n["package"], n["amount_paid"]))

print("\n== 5) last year's package is left alone ==")
old = db().execute("SELECT status, relevance FROM unmapped_sales WHERE reference='zz-pkg-old'").fetchone()
check(tuple(old) == ("pending", "unrelated") and not db().execute(
      "SELECT 1 FROM exhibitors WHERE contact_email='zz.lastyear@example.invalid'").fetchone(), "untouched, no exhibitor")

print("\n== 6) the sales leave the review queue ==")
st = {r["reference"]: (r["status"], r["relevance"]) for r in db().execute("SELECT * FROM unmapped_sales WHERE reference LIKE 'zz-%'")}
check(all(st[x] == ("exhibitor", "exhibitor_package") for x in ("zz-pkg-1", "zz-pkg-2", "zz-pkg-3")), "status exhibitor", st)
check(st["zz-not-pkg"] == ("pending", "unrelated"), "a device sale is not touched")

print("\n== 7) no ticket from a package ==")
check(db().execute("SELECT count(*) FROM attendees").fetchone()[0] == n_att, "no attendee was created")
check(db().execute("SELECT count(*) FROM exhibitors").fetchone()[0] == n_ex + 1, "exactly one exhibitor was created")

print("\n== 8) the public directory ==")
pub = json.load(urllib.request.urlopen(BASE + "/public/events/1/exhibitors", timeout=20))
check(not any(x["company_name"] == "Zz New Stand" for x in pub), "a purchased stand is not listed publicly")

print("\n== 9) a second run changes nothing ==")
s1 = snap(); r = run("--apply", EXHIBITOR_PACKAGE_SYNC="1")
check(snap() == s1 and "this event (2025-11-20 to 2026-11-22): 0" in r.stdout, "idempotent", r.stdout[:300])

print("\n== 10) the planning sheet adopts it by email ==")
rows = list(csv.reader(io.StringIO(vs.fetch_csv())))
hi = next(i for i, r in enumerate(rows) if "Company Name" in [x.strip() for x in r])
hdr = [x.strip() for x in rows[hi]]
ci, ei = hdr.index("Company Name"), hdr.index(vs.HEADERS["email"])
sheet = vs.parse("\n".join(",".join('"%s"' % x.replace('"', '""') for x in r) for r in rows))
first_conf = next(s for s in sheet if s["stage"] == "confirmed")
fi = next(i for i, r in enumerate(rows) if i > hi and len(r) > ci and r[ci].strip() == first_conf["company"])
newrow = list(rows[fi]) + [""] * (len(hdr) - len(rows[fi]))
newrow[ci], newrow[ei] = "Zz Sheet Company", "zz.newstand@example.invalid"
rows.insert(fi + 1, newrow)
sheet_csv = os.path.join(work, "sheet.csv")
with open(sheet_csv, "w", newline="", encoding="utf-8") as f:
    csv.writer(f).writerows(rows)
vr = subprocess.run([sys.executable, os.path.join(HERE, "tools", "vendor_sync.py"), "--apply", sheet_csv],
                    env=base, capture_output=True, text=True, timeout=180)
adopted = db().execute("SELECT * FROM exhibitors WHERE id=?", (n["id"],)).fetchone()
check(vr.returncode in (0, 3) and adopted["company_name"] == "Zz Sheet Company" and adopted["stage"] == "confirmed",
      "the purchased stand takes the sheet's company name and stage", (vr.returncode, dict(adopted), vr.stderr[-300:]))
check(db().execute("SELECT count(*) FROM exhibitors WHERE company_name='Zz Sheet Company'").fetchone()[0] == 1,
      "no second exhibitor was created for the sheet row")

print("\n== 11) the live database ==")
check(live.execute(LQ).fetchone() == live_before, "the live database was never touched")

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
