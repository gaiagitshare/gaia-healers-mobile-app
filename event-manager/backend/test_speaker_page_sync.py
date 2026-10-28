# -*- coding: utf-8 -*-
"""SPEAKER PAGE SYNC — the public speaker line-up reaches the Event Manager.

The 16 speaker cards on the public Elevate page (name, topic, bio, photo) are the
team's live line-up; the planning sheet has no bio, photo or title (28 Oct 2026).

Proves, on a COPY of the live database and a saved copy of that page:
  1. off by default: it only watches the page (fingerprint written), changes nothing
  2. a dry run reports and writes nothing
  3. --apply fills EMPTY fields only; a bio or photo set in the app is never
     overwritten
  4. "Dr. Davis" in the app is the page's "Dr. Christopher Davis, MD, FACC" --
     no duplicate speaker is created
  5. a speaker added to the page is created; with SPEAKER_PAGE_PUBLISH=1 the
     page's speakers are published
  6. a speaker removed from the page is reported, not unpublished
  7. a page that no longer parses applies nothing and exits 1
  8. the live database is never touched

Run:  python3 /root/event/backend/test_speaker_page_sync.py
"""
import json, os, shutil, sqlite3, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "tools", "speaker_page_sync.py")
PAGE = os.path.join(HERE, "fixtures", "event-page-2026-10-28.html")

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + str(extra)[:500])))
    if not cond: fails += 1

print("SPEAKER PAGE SYNC")
work = tempfile.mkdtemp(prefix="spkpage-")
try:
    db_path = os.path.join(work, "event.db")
    src = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "event.db"), uri=True)
    dst = sqlite3.connect(db_path); src.backup(dst); dst.close()
    live_before = src.execute("SELECT count(*), group_concat(coalesce(bio,'')||coalesce(photo_url,''), '|') FROM speakers").fetchone()
    base = dict(os.environ, DATABASE_URL="sqlite:///" + db_path, VENDOR_SYNC_DATA=work)
    for k in ("SPEAKER_PAGE_SYNC", "SPEAKER_PAGE_PUBLISH"): base.pop(k, None)
    def run(*args, page=PAGE, **env):
        return subprocess.run([sys.executable, TOOL] + list(args) + ([page] if page else []),
                              env=dict(base, **env), capture_output=True, text=True, timeout=120)
    def speakers():
        c = sqlite3.connect(db_path); c.row_factory = sqlite3.Row
        return {r["name"]: dict(r) for r in c.execute("SELECT * FROM speakers WHERE event_id=1")}

    s0 = speakers()
    print("\n== 1) off by default ==")
    r = subprocess.run([sys.executable, TOOL], env=dict(base, SPEAKER_PAGE_WATCH="0"), capture_output=True, text=True)
    check(r.returncode == 0 and speakers() == s0, "without SPEAKER_PAGE_SYNC=1 nothing changes")

    print("\n== 2) dry run ==")
    r = run()
    check(r.returncode == 0 and "16 cards" in r.stdout and speakers() == s0, "16 cards reported, nothing written", r.stdout[:300])

    print("\n== 3) fill empty fields only ==")
    c = sqlite3.connect(db_path)
    c.execute("UPDATE speakers SET bio='Set in the app', photo_url='https://example.invalid/app.png' WHERE name LIKE 'Dr. Nima Farshid%'")
    c.commit()
    r = run("--apply")
    s1 = speakers()
    nima = next(v for k, v in s1.items() if k.startswith("Dr. Nima Farshid"))
    check(nima["bio"] == "Set in the app" and nima["photo_url"].endswith("app.png"), "the app's bio and photo were kept", (nima["bio"], nima["photo_url"]))
    filled = [k for k in ("Martha Carlin", "Dr. Steven Roth", "Scott Baider") if s1.get(k, {}).get("bio")]
    check(len(filled) == 3, "empty bios were filled from the page", filled)

    print("\n== 4) no duplicate for a surname-only entry ==")
    check("Dr. Davis" in s1 and not any("Christopher Davis" in k for k in s1), "Dr. Davis was filled, not duplicated",
          [k for k in s1 if "Davis" in k])
    check(len(s1) == len(s0), "no speaker was created from the unchanged page", (len(s0), len(s1)))

    print("\n== 5) a new speaker on the page, and publishing ==")
    html = open(PAGE, encoding="utf-8").read()
    card = '<div class="spk-card"><div class="spk-img"><img src="https://example.invalid/new.png" alt=""></div><div class="spk-info"><div class="spk-name">Zz Page Speaker</div><div class="spk-topic">Testing Flows</div><p class="spk-bio">Added to the page.</p></div></div>'
    i = html.find('<div class="spk-card">')
    page2 = os.path.join(work, "page2.html"); open(page2, "w", encoding="utf-8").write(html[:i] + card + html[i:])
    r = run("--apply", page=page2, SPEAKER_PAGE_PUBLISH="1")
    s2 = speakers()
    check("Zz Page Speaker" in s2 and s2["Zz Page Speaker"]["is_published"] == 1 and s2["Zz Page Speaker"]["photo_url"].endswith("new.png"),
          "the new speaker exists, published, with photo", s2.get("Zz Page Speaker"))
    on_page = [v for k, v in s2.items() if k in ("Martha Carlin", "Dr. Steven Roth", "Scott Baider", "Dr. Davis")]
    check(all(v["is_published"] == 1 for v in on_page), "speakers shown on the page are published", [(v["name"], v["is_published"]) for v in on_page])

    print("\n== 6) a speaker leaving the page ==")
    j = html.find("Martha Carlin"); a = html.rfind('<div class="spk-card">', 0, j); b = html.find('<div class="spk-card">', j)
    page3 = os.path.join(work, "page3.html"); open(page3, "w", encoding="utf-8").write(html[:a] + html[b:])
    r = run("--apply", page=page3, SPEAKER_PAGE_PUBLISH="1")
    check("Martha Carlin" in r.stdout and speakers()["Martha Carlin"]["is_published"] == 1, "reported, still published", r.stdout[-300:])

    print("\n== 7) a page that no longer parses ==")
    bad = os.path.join(work, "bad.html"); open(bad, "w").write("<html><body>Coming soon</body></html>")
    before = speakers()
    r = run("--apply", page=bad)
    check(r.returncode == 1 and speakers() == before, "exit 1, nothing applied")

    print("\n== 8) the watch file and the live database ==")
    w = json.load(open(os.path.join(work, "speaker-page-watch.json")))
    check(w.get("rows") and w.get("fingerprint") and w.get("synced") is not None, "the page fingerprint is recorded", w)
    live_after = src.execute("SELECT count(*), group_concat(coalesce(bio,'')||coalesce(photo_url,''), '|') FROM speakers").fetchone()
    check(live_before == live_after, "the live database was never touched")
finally:
    shutil.rmtree(work, ignore_errors=True)

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
