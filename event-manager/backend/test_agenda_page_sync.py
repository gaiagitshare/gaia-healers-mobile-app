# -*- coding: utf-8 -*-
"""AGENDA PAGE SYNC — the live agenda page reaches the app, and edits follow it.

On 28 Oct 2026 the app showed no schedule at all: the sessions table was empty,
the planning sheet has no Schedule tab, and the only real schedule was the
hand-edited page elevate.gaiahealers.com/agenda -- which had already changed
since the 6 Oct export (two talks swapped, times shifted, one retitled, one
added, one removed).

Proves, on a COPY of the live database and a saved copy of that page:
  1. off by default: without AGENDA_PAGE_SYNC=1 it does nothing
  2. a dry run reports 46 rows and writes nothing
  3. --apply creates every row as a draft, linked to known speakers
  4. a second run changes nothing
  5. the edits the page really gets propagate without duplicates: two talks
     swap times, one is retitled, one leaves the page, one is added
  6. AGENDA_PAGE_PUBLISH=1 publishes them; a row that then leaves the page is
     unpublished, not deleted
  7. a page that no longer parses applies nothing and exits 1
  8. the live database is never touched

Run:  python3 /root/event/backend/test_agenda_page_sync.py
"""
import os, re, shutil, sqlite3, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "tools", "agenda_page_sync.py")
PAGE = os.path.join(HERE, "fixtures", "agenda-page-2026-10-28.html")

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + str(extra))))
    if not cond: fails += 1

print("AGENDA PAGE SYNC")
work = tempfile.mkdtemp(prefix="agenda-")
try:
    db_path = os.path.join(work, "event.db")
    src = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "event.db"), uri=True)
    dst = sqlite3.connect(db_path); src.backup(dst); dst.close()
    live_before = src.execute("SELECT count(*), max(updated_at) FROM sessions").fetchone()
    base_env = dict(os.environ, DATABASE_URL="sqlite:///" + db_path, VENDOR_SYNC_DATA=work)
    base_env.pop("AGENDA_PAGE_SYNC", None); base_env.pop("AGENDA_PAGE_PUBLISH", None)

    def run(*args, page=None, **env):
        e = dict(base_env, **env)
        cmd = [sys.executable, TOOL] + list(args) + ([page] if page else [])
        return subprocess.run(cmd, env=e, capture_output=True, text=True, timeout=120)

    def sessions():
        c = sqlite3.connect(db_path); c.row_factory = sqlite3.Row
        return {r["external_id"]: dict(r) for r in c.execute("SELECT * FROM sessions WHERE external_id LIKE 'page:%'")}

    print("\n== 1) off by default ==")
    r = run("--apply")
    check(r.returncode == 0 and "off" in r.stdout and not sessions(), "nothing happens without AGENDA_PAGE_SYNC=1", r.stdout[-200:])

    print("\n== 2) dry run ==")
    r = run(page=PAGE)
    check(r.returncode == 0 and "46 rows" in r.stdout and not sessions(), "46 rows reported, nothing written", r.stdout[:300] + r.stderr[-300:])

    print("\n== 3) apply ==")
    r = run("--apply", page=PAGE)
    s = sessions()
    check(r.returncode == 0 and len(s) == 46, "46 sessions created", (r.returncode, len(s), r.stderr[-300:]))
    check(all(v["is_published"] == 0 for v in s.values()), "all as drafts")
    c = sqlite3.connect(db_path)
    linked = c.execute("SELECT count(DISTINCT session_id) FROM session_speakers WHERE session_id IN "
                       "(SELECT id FROM sessions WHERE external_id LIKE 'page:%')").fetchone()[0]
    check(linked >= 15, "talks are linked to the speakers the Event Manager knows", linked)
    roth = s.get("page:sat:talk:dr-steven-roth")
    check(roth and roth["start_time"].startswith("2026-11-21 15:40"), "Dr. Steven Roth is Sat 3:40 PM", roth and roth["start_time"])

    print("\n== 4) a second run changes nothing ==")
    before = sessions()
    r = run("--apply", page=PAGE)
    check(r.returncode == 0 and sessions() == before, "identical after a re-run")

    print("\n== 5) the page's real kinds of edit ==")
    html = open(PAGE, encoding="utf-8").read()
    edited = html.replace("15:40", "15:40")
    # swap Roth and Prebeg's times on Saturday
    edited = edited.replace('<div class="ag-time">3:00 – 3:40 PM</div>', '<div class="ag-time">__A__</div>')
    edited = edited.replace('<div class="ag-time">3:40 – 4:30 PM</div>', '<div class="ag-time">3:00 – 3:40 PM</div>')
    edited = edited.replace('<div class="ag-time">__A__</div>', '<div class="ag-time">3:40 – 4:30 PM</div>')
    edited = edited.replace("Sonic Frequency Therapy", "Sonic Frequency Therapy: Live")
    gi = edited.find("Gong Meditation")
    ga = edited.rfind('<div class="ag-add-card"', 0, gi)
    gb = edited.find('<div class="ag-add-card"', gi)
    edited = edited[:ga] + edited[gb:]
    edited = edited.replace('<div class="ag-workshop-name">BioTekna Workshop</div>', '<div class="ag-workshop-name">BioTekna Workshop</div>', 1)
    page2 = os.path.join(work, "page2.html")
    open(page2, "w", encoding="utf-8").write(edited)
    r = run("--apply", page=page2)
    s2 = sessions()
    check(r.returncode == 0, "the edited page applies", r.stdout[-400:] + r.stderr[-300:])
    check(len(s2) == 46, "no duplicates: still 46 keyed rows", len(s2))
    check(s2["page:sat:talk:dr-steven-roth"]["start_time"].startswith("2026-11-21 15:00"), "the swap moved Roth to 3:00", s2["page:sat:talk:dr-steven-roth"]["start_time"])
    check(s2["page:fri:talk:jeff-maier"]["title"] == "Sonic Frequency Therapy: Live", "the retitle updated the same session")
    check("Gong Meditation" in r.stdout and "No longer on the page" in r.stdout, "the removed session is reported", r.stdout[-500:])

    print("\n== 6) publishing, and a row leaving after it was live ==")
    r = run("--apply", page=PAGE, AGENDA_PAGE_PUBLISH="1")
    s3 = sessions()
    check(r.returncode == 0 and all(v["is_published"] == 1 for v in s3.values()), "every row with a time is published")
    r = run("--apply", page=page2, AGENDA_PAGE_PUBLISH="1")
    gong = s3.get("page:sat:workshop:gong-meditation")
    s4 = sessions()
    check(gong and gong["external_id"] in s4 and s4[gong["external_id"]]["is_published"] == 0,
          "the removed session is unpublished, not deleted", gong and s4.get(gong["external_id"]))

    print("\n== 7) a page that no longer parses ==")
    broken = os.path.join(work, "broken.html")
    open(broken, "w").write("<html><body>We are updating the agenda</body></html>")
    before = sessions()
    r = run("--apply", page=broken)
    check(r.returncode == 1 and sessions() == before, "exit 1 and nothing applied", r.stdout[-300:])

    print("\n== 8) the live database ==")
    live_after = src.execute("SELECT count(*), max(updated_at) FROM sessions").fetchone()
    check(live_before == live_after, "never touched", (live_before, live_after))
finally:
    shutil.rmtree(work, ignore_errors=True)

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
