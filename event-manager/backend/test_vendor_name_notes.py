# -*- coding: utf-8 -*-
"""Staff notes written into the sheet's company cell ("…/BOOK") are not part of
a stand's name (11 Nov 2026). They were reaching the directory, the map and the
stands' own emails. The parser takes them off; the sync renames stands that
already carry one, without creating a second stand or touching other renames."""
import os, sys, shutil, sqlite3, subprocess, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "tools"))
import vendor_sheet as vs

fails = []
def check(cond, label, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else "   " + repr(detail)))
    if not cond: fails.append(label)

print("STAFF NOTES IN COMPANY NAMES")
check(vs.split_staff_note("Transform and RISE /BOOK") == ("Transform and RISE", "BOOK"), "a spaced note comes off")
check(vs.split_staff_note("Biohacking Cancer/BOOK") == ("Biohacking Cancer", "BOOK"), "an unspaced note comes off")
for real in ("AC/DC", "HEALEEX/USA", "Mind / Body", "Bio-Well", "Root Causes /book", "A /B"):
    check(vs.split_staff_note(real) == (real, ""), "a real name is left alone: %s" % real, vs.split_staff_note(real))

work = tempfile.mkdtemp(prefix="vendor-notes-")
db = os.path.join(work, "event.db")
src = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "event.db"), uri=True); dst = sqlite3.connect(db); src.backup(dst); dst.close(); src.close()
c = sqlite3.connect(db)
c.execute("INSERT INTO exhibitors (event_id, company_name, stage, is_published, can_scan_leads, created_at, access_token, sort_order) "
          "VALUES (1, 'Zz Notetest Stand/BOOK', 'confirmed', 0, 0, datetime('now'), 'EXH-ZZTEST0000000001', 0)")
c.execute("INSERT INTO exhibitors (event_id, company_name, stage, is_published, can_scan_leads, created_at, access_token, sort_order) "
          "VALUES (1, 'Zz Organiser Renamed', 'confirmed', 0, 0, datetime('now'), 'EXH-ZZTEST0000000002', 0)")
c.commit(); before = c.execute("SELECT count(*) FROM exhibitors WHERE event_id=1").fetchone()[0]; c.close()
csv_path = os.path.join(work, "sheet.csv")
open(csv_path, "w").write("Status,Booth #,Company Name,Name,Email\n2026 CONFIRMED EXHIBITORS,,,,\n"
                          ",90,Zz Notetest Stand /BOOK,,\n,91,Zz Organiser Renamed,,\n"
                          + "".join(",9%d,Zz Filler %d,,\n" % (i, i) for i in range(2, 6)))   # the sync refuses fewer than 5
env = dict(os.environ, DATABASE_URL="sqlite:///" + db, VENDOR_SYNC_DATA=work)
subprocess.run([sys.executable, os.path.join(HERE, "tools", "vendor_sync.py"), csv_path, "--apply"], env=env,
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
c = sqlite3.connect(db)
names = [r[0] for r in c.execute("SELECT company_name FROM exhibitors WHERE event_id=1 AND company_name LIKE 'Zz %'")]
check("Zz Notetest Stand" in names, "a stored name loses its note", names)
check(not any("/BOOK" in n for n in names), "and no stand keeps '/BOOK'", names)
check(c.execute("SELECT count(*) FROM exhibitors WHERE event_id=1 AND company_name LIKE 'Zz Notetest%'").fetchone()[0] == 1, "no second stand is created")
check("Zz Organiser Renamed" in names, "a name without a note is not touched", names)
shutil.rmtree(work, ignore_errors=True)
print("\n%d failed" % len(fails))
sys.exit(1 if fails else 0)
