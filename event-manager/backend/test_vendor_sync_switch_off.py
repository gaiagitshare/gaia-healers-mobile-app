# -*- coding: utf-8 -*-
"""VENDOR SYNC SWITCH-OFF — a stand that drops out loses its scanner and its listing.

The sheet never turns scanning or the directory listing ON; that is the
organiser's grant. It does turn them OFF: on 5 October Prestige Wellness moved
to "not attending" in the sheet and kept its badge scanner, which the deploy
gate (test_vendors.py) then refused to ship past.

Proves, on a COPY of the live database and a copy of today's sheet:
  1. the rule: scanner off unless confirmed AND paid/comp; listing off unless
     confirmed; nothing is ever switched on
  2. a scanning, listed stand moved to NOT ATTENDING in the sheet loses both
     on --apply, and the log says why
  3. a dry run reports it and writes nothing
  4. every other stand's scanner and listing are untouched

Run:  python3 /root/event/backend/test_vendor_sync_switch_off.py
"""
import csv, io, json, os, shutil, sqlite3, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "tools"))
import vendor_sheet as vs
import vendor_sync

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + str(extra))))
    if not cond: fails += 1

print("VENDOR SYNC SWITCH-OFF")

# 1 ── the rule, on its own
def row(stage, pay, scan, pub):
    return {"stage": stage, "payment_status": pay, "can_scan_leads": scan, "is_published": pub}
so = vendor_sync.switch_offs
check(so(row("confirmed", "paid", 1, 1), {}) == {}, "confirmed and paid keeps both")
check(so(row("confirmed", "comp", 1, 1), {}) == {}, "confirmed and comp keeps both")
check(so(row("confirmed", "paid", 1, 1), {"payment_status": "unpaid"}) == {"can_scan_leads": 0},
      "confirmed but now unpaid: scanner off, still listed")
check(so(row("confirmed", "paid", 1, 1), {"stage": "not_attending"}) == {"can_scan_leads": 0, "is_published": 0},
      "dropped out: scanner off and unlisted")
check(so(row("waiting", "paid", 1, 0), {}) == {"can_scan_leads": 0}, "a stand that is not confirmed cannot keep a scanner")
check(so(row("not_attending", "unpaid", 0, 0), {}) == {}, "already off stays as it is")
check(so(row("confirmed", "paid", 0, 0), {}) == {}, "nothing is ever switched on")

# 2 ── end to end on copies
work = tempfile.mkdtemp(prefix="vsync-")
try:
    db_path = os.path.join(work, "event.db")
    shutil.copy(os.path.join(HERE, "event.db"), db_path)
    db = sqlite3.connect(db_path); db.row_factory = sqlite3.Row
    victim = db.execute("SELECT id, company_name FROM exhibitors WHERE event_id=1 AND stage='confirmed' "
                        "AND payment_status IN ('paid','comp') AND can_scan_leads=1 AND is_published=1 "
                        "ORDER BY id LIMIT 1").fetchone()
    check(victim is not None, "a confirmed, paid, scanning, listed stand exists to drop")
    before = {r["id"]: (r["can_scan_leads"], r["is_published"]) for r in db.execute(
        "SELECT id, can_scan_leads, is_published FROM exhibitors WHERE event_id=1")}

    # Today's sheet, with that stand's row moved under NOT ATTENDING THIS YEAR.
    rows = list(csv.reader(io.StringIO(vs.fetch_csv())))
    key = vs.norm_name(victim["company_name"])
    hi = next(i for i, r in enumerate(rows) if "Company Name" in [c.strip() for c in r])
    ci = [c.strip() for c in rows[hi]].index("Company Name")
    vi = next(i for i, r in enumerate(rows) if i > hi and len(r) > ci and vs.norm_name(r[ci].strip()) == key)
    moved = rows.pop(vi)
    ni = next(i for i, r in enumerate(rows) if r and r[0].strip().upper() == "NOT ATTENDING THIS YEAR")
    rows.insert(ni + 1, moved)
    sheet_csv = os.path.join(work, "sheet.csv")
    with open(sheet_csv, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(rows)

    # Log and report go to the scratch folder, never the real ones.
    env = dict(os.environ, DATABASE_URL="sqlite:///" + db_path, VENDOR_SYNC_DATA=work)
    log_path = os.path.join(work, "vendor-sync.log")
    if True:
        dry = subprocess.run([sys.executable, os.path.join(HERE, "tools", "vendor_sync.py"), sheet_csv],
                             env=env, capture_output=True, text=True, timeout=120)
        r = db.execute("SELECT can_scan_leads, is_published FROM exhibitors WHERE id=?", (victim["id"],)).fetchone()
        check(dry.returncode == 0 and "Switched OFF" in dry.stdout and victim["company_name"] in dry.stdout,
              "a dry run reports the switch-off", dry.stdout[-800:] + dry.stderr[-400:])
        check((r["can_scan_leads"], r["is_published"]) == (1, 1), "and writes nothing", tuple(r))

        app = subprocess.run([sys.executable, os.path.join(HERE, "tools", "vendor_sync.py"), "--apply", sheet_csv],
                             env=env, capture_output=True, text=True, timeout=120)
        log_lines = open(log_path).read().splitlines() if os.path.exists(log_path) else []

    db2 = sqlite3.connect(db_path); db2.row_factory = sqlite3.Row
    r = db2.execute("SELECT stage, can_scan_leads, is_published FROM exhibitors WHERE id=?", (victim["id"],)).fetchone()
    check(app.returncode == 0 and r["stage"] == "not_attending" and r["can_scan_leads"] == 0 and r["is_published"] == 0,
          "--apply: the dropped stand is not attending, its scanner off, out of the directory",
          (app.returncode, tuple(r) if r else None, app.stderr[-400:]))
    entry = [json.loads(l) for l in log_lines if '"switch_off"' in l]
    check(entry and entry[-1]["id"] == victim["id"] and entry[-1]["because"]["stage"] == "not_attending"
          and entry[-1]["after"] == {"can_scan_leads": 0, "is_published": 0},
          "the log records what was switched off and why", entry[-1:] if entry else log_lines[-2:])
    after = {x["id"]: (x["can_scan_leads"], x["is_published"]) for x in db2.execute(
        "SELECT id, can_scan_leads, is_published FROM exhibitors WHERE event_id=1")}
    others = [i for i in before if i != victim["id"] and before[i] != after.get(i)]
    check(not others, "no other stand's scanner or listing changed", others)
    live = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "event.db"), uri=True)
    lv = live.execute("SELECT can_scan_leads, is_published FROM exhibitors WHERE id=?", (victim["id"],)).fetchone()
    check(lv == (1, 1), "the live database was never touched", lv)
finally:
    shutil.rmtree(work, ignore_errors=True)

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
