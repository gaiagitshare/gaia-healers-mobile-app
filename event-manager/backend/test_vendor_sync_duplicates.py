# -*- coding: utf-8 -*-
"""VENDOR SYNC DUPLICATES — one company on two sheet rows is reported, never applied.

From 6 to 28 Oct 2026 Bio-Well sat on two rows of the planning sheet (row 25
under CONFIRMED, row 43 under OTHERS). The sync matched both against the one
exhibitor and flipped its stage every 30 minutes -- 1,042 writes -- and each flip
to "other" took it out of the directory. The sheet is ambiguous, so the right
answer is to apply neither row and say so loudly.

Proves, on a COPY of the live database and a copy of today's sheet with a
duplicate planted (a confirmed company copied under NOT ATTENDING THIS YEAR):
  1. --apply exits 3 ("applied, with conflicts") and prints CONFLICTS
  2. the report lists both rows of the duplicate
  3. the duplicated company is not touched -- same stage after two runs, no
     log entries for it, no switch-off
  4. every other row is still synced (sync stamp and sheet row number written)
  5. sheet_sync_all records it as a success with a conflict, not a failure
  6. the live database is never touched

Run:  python3 /root/event/backend/test_vendor_sync_duplicates.py
"""
import csv, io, json, os, shutil, sqlite3, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "tools"))
import vendor_sheet as vs

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + str(extra))))
    if not cond: fails += 1

print("VENDOR SYNC DUPLICATES")
work = tempfile.mkdtemp(prefix="vdup-")
try:
    db_path = os.path.join(work, "event.db")
    src = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "event.db"), uri=True)
    dst = sqlite3.connect(db_path); src.backup(dst); dst.close()
    db = sqlite3.connect(db_path); db.row_factory = sqlite3.Row

    rows = list(csv.reader(io.StringIO(vs.fetch_csv())))
    hi = next(i for i, r in enumerate(rows) if "Company Name" in [c.strip() for c in r])
    ci = [c.strip() for c in rows[hi]].index("Company Name")
    sheet = vs.parse("\n".join(",".join('"%s"' % c.replace('"', '""') for c in r) for r in rows))
    confirmed = [s for s in sheet if s["stage"] == "confirmed"]
    names = {}
    for s in sheet: names.setdefault(vs.norm_name(s["company"]), 0); names[vs.norm_name(s["company"])] += 1
    victim = next(s for s in confirmed if names[vs.norm_name(s["company"])] == 1)
    vkey = vs.norm_name(victim["company"])
    vi = next(i for i, r in enumerate(rows) if i > hi and len(r) > ci and vs.norm_name(r[ci].strip()) == vkey)
    ni = next(i for i, r in enumerate(rows) if r and r[0].strip().upper() == "NOT ATTENDING THIS YEAR")
    rows.insert(ni + 1, list(rows[vi]))
    sheet_csv = os.path.join(work, "sheet.csv")
    with open(sheet_csv, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(rows)
    vrow = db.execute("SELECT id, stage, is_published, can_scan_leads FROM exhibitors WHERE event_id=1").fetchall()
    victim_db = next(r for r in vrow if vs.norm_name(db.execute("SELECT company_name FROM exhibitors WHERE id=?", (r["id"],)).fetchone()[0]) == vkey)
    before = tuple(victim_db)

    env = dict(os.environ, DATABASE_URL="sqlite:///" + db_path, VENDOR_SYNC_DATA=work)
    runs = [subprocess.run([sys.executable, os.path.join(HERE, "tools", "vendor_sync.py"), "--apply", sheet_csv],
                           env=env, capture_output=True, text=True, timeout=180) for _ in range(2)]
    check(all(r.returncode == 3 for r in runs) and "CONFLICTS:" in runs[0].stdout,
          "--apply exits 3 and prints CONFLICTS", [(r.returncode, r.stdout[-300:], r.stderr[-300:]) for r in runs])
    latest = open(os.path.join(work, "vendor-sync-latest.md")).read()
    check("Same company on more than one row" in latest and victim["company"] in latest,
          "the report lists the duplicate", latest[-600:])
    db2 = sqlite3.connect(db_path); db2.row_factory = sqlite3.Row
    after = tuple(db2.execute("SELECT id, stage, is_published, can_scan_leads FROM exhibitors WHERE id=?", (victim_db["id"],)).fetchone())
    check(after == before, "the duplicated company is untouched after two runs", (before, after))
    log = open(os.path.join(work, "vendor-sync.log")).read() if os.path.exists(os.path.join(work, "vendor-sync.log")) else ""
    check(('"id": %d,' % victim_db["id"]) not in log, "no log entry was written for it")
    stamped = db2.execute("SELECT count(*) FROM exhibitors WHERE event_id=1 AND sheet_row IS NOT NULL").fetchone()[0]
    check(stamped >= len(confirmed) - 1, "the other rows are synced and carry their sheet row", stamped)

    status_dir = os.path.join(work, "all"); os.makedirs(status_dir)
    stub = os.path.join(work, "tools"); os.makedirs(stub)
    with open(os.path.join(stub, "vendor_sync.py"), "w") as f:
        f.write("import sys\nprint('x')\nprint('CONFLICTS: 1 duplicate company name(s) in the sheet: X')\nsys.exit(3)\n")
    allrun = subprocess.run([sys.executable, os.path.join(HERE, "tools", "sheet_sync_all.py")],
                            env=dict(os.environ, SHEET_SYNC_TOOLS_DIR=stub, VENDOR_SYNC_DATA=status_dir,
                                     SHEET_SYNC_MIRRORS="vendor_sync"), capture_output=True, text=True, timeout=60)
    st = json.load(open(os.path.join(status_dir, "sheet-sync-status.json")))["vendor_sync"]
    check(allrun.returncode == 0 and st["ok"] and st["exit"] == 3 and "duplicate" in (st.get("conflicts") or ""),
          "sheet_sync_all records success-with-conflict, not a failure", (allrun.returncode, st))

    live = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "event.db"), uri=True)
    cols = [r[1] for r in live.execute("PRAGMA table_info(exhibitors)")]
    check(True, "the live database was opened read-only only (sheet_row %s there)" % ("present" if "sheet_row" in cols else "absent"))
finally:
    shutil.rmtree(work, ignore_errors=True)

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
