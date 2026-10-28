# -*- coding: utf-8 -*-
"""EXHIBITOR PAGE SYNC — the public exhibitor and sponsor line-up reaches the app.

The "Meet Our Exhibitors" block on the public Elevate page (Title / Premium
sponsors, the Exhibiting Partners strip, Gifted to You By) is edited in GHL and
is the source of truth for what attendees see (Babak, 28 Oct 2026).

Proves, on a COPY of the live database (served by the real API) and a saved
copy of that page:
  1. off by default: it only watches the page (fingerprint written), changes nothing
  2. a dry run reports 21 exhibitors and 8 sponsors and writes nothing
  3. --apply: every page exhibitor is matched (logo file first, then name) --
     no duplicate is created; the page's name becomes the PUBLIC name and the
     sheet's company_name is untouched (the sheet sync still matches on it)
  4. the public API and the website embed show the page's names (the app
     reads this same endpoint through the proxy)
  5. sponsors follow the page: LifeWave (gold) and the three gift partners
     are added, the existing four keep their tiers
  6. a logo set in the app is never replaced
  7. publishing: an exhibitor the page shows but the sheet has as "not aligned"
     is reported, not published; a confirmed one is published
  8. a new exhibitor on the page is created (published with PUBLISH=1)
  9. one leaving the page is reported, not unpublished
 10. a page that no longer parses applies nothing and exits 1
 11. a second run changes nothing
 12. the live database is never touched

Run:  python3 /root/event/backend/test_exhibitor_page_sync.py
"""
import json, os, sqlite3, subprocess, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "tools", "exhibitor_page_sync.py")
PAGE = os.path.join(HERE, "fixtures", "event-page-2026-10-28.html")
sys.path.insert(0, HERE)
import testbed

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + str(extra)[:500])))
    if not cond: fails += 1

print("EXHIBITOR PAGE SYNC")
live = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "event.db"), uri=True)
q = "SELECT count(*), group_concat(coalesce(company_name,'')||coalesce(logo_url,'')||is_published, '|') FROM exhibitors"
live_before = live.execute(q).fetchone(), live.execute("SELECT count(*), group_concat(name||tier, '|') FROM sponsors").fetchone()
BASE, DB = testbed.start()
work = os.path.dirname(DB)
base = dict(os.environ, DATABASE_URL="sqlite:///" + DB, VENDOR_SYNC_DATA=work)
for k in ("EXHIBITOR_PAGE_SYNC", "EXHIBITOR_PAGE_PUBLISH"): base.pop(k, None)

def run(*args, page=PAGE, **env):
    return subprocess.run([sys.executable, TOOL] + list(args) + ([page] if page else []),
                          env=dict(base, **env), capture_output=True, text=True, timeout=120)
def db():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row; return c
def exhibitors():
    return {r["id"]: dict(r) for r in db().execute("SELECT * FROM exhibitors WHERE event_id=1")}
def sponsors():
    return {r["name"]: dict(r) for r in db().execute("SELECT * FROM sponsors WHERE event_id=1")}
def get(path):
    return json.load(urllib.request.urlopen(BASE + path, timeout=20))

e0, s0 = exhibitors(), sponsors()
print("\n== 1) off by default ==")
r = subprocess.run([sys.executable, TOOL], env=dict(base, EXHIBITOR_PAGE_WATCH="0"), capture_output=True, text=True)
check(r.returncode == 0 and exhibitors() == e0 and sponsors() == s0, "without EXHIBITOR_PAGE_SYNC=1 nothing changes")

print("\n== 2) dry run ==")
r = run()
check(r.returncode == 0 and "exhibitors: 21" in r.stdout and "sponsors: 8" in r.stdout and exhibitors() == e0,
      "21 exhibitors and 8 sponsors reported, nothing written", r.stdout[:400])

print("\n== 3) apply: matched, not duplicated; public name set, sheet name kept ==")
c = db(); c.execute("UPDATE exhibitors SET logo_url='https://example.invalid/app-logo.png' WHERE company_name='Zinzino'"); c.commit()
r = run("--apply")
e1 = exhibitors()
check(r.returncode == 0 and len(e1) == len(e0), "no exhibitor was created for the 21 on the page", (r.returncode, len(e0), len(e1), r.stdout[-400:]))
by_co = {v["company_name"]: v for v in e1.values()}
check(by_co["Rapids Release Therapy"]["site_name"] == "Rapid Release", "\"Rapids Release Therapy\" shows as the page's \"Rapid Release\"")
check(by_co["ELUMIIS"]["site_name"] == "Eluumis" and by_co["Biohacking Cancer/BOOK"]["site_name"] == "Root Causes",
      "matched by logo file: ELUMIIS → Eluumis, Biohacking Cancer/BOOK → Root Causes")
check(by_co["HEALEEX"]["site_name"] == "Healeex" and by_co["encompass Life"]["site_name"] == "Encompass Life",
      "matched by name where the logo differs: HEALEEX, encompass Life")
check(all(v["company_name"] == e0[k]["company_name"] for k, v in e1.items()), "every sheet company_name is unchanged")

print("\n== 4) the public API, the embed and the app feed show the page's names ==")
pub = {x["company_name"] for x in get("/public/events/1/exhibitors")}
check({"Rapid Release", "Eluumis", "Relax Saunas", "PulsePEMF"} <= pub and "Rapids Release Therapy" not in pub,
      "public exhibitors use the page's names", sorted(pub)[:8])
emb = urllib.request.urlopen(BASE + "/public/events/1/embed/exhibitors?nocache=1", timeout=20).read().decode()
check("Rapid Release" in emb, "the website embed follows")

print("\n== 5) sponsors follow the page ==")
s1 = sponsors()
check(s1.get("LifeWave", {}).get("tier") == "gold", "LifeWave added as a Premium (gold) sponsor", s1.get("LifeWave"))
check(all(s1.get(n, {}).get("tier") == "partner" and "welcome bags" in (s1[n]["blurb"] or "")
          for n in ("Manta Sleep", "David Protein", "Baja Gold Salt Co.")), "the three gift partners added", [s1.get(n) for n in ("Manta Sleep",)])
check(s1["The Rasha"]["tier"] == "headline" and s1["BrainTap"]["tier"] == "headline" and s1["Eluumis"]["tier"] == "gold",
      "the existing four keep their page tiers")
check(len(get("/public/events/1/sponsors")) == len(s1), "the public sponsor list carries them")

print("\n== 6) a logo set in the app is kept ==")
check(by_co["Zinzino"]["logo_url"] == "https://example.invalid/app-logo.png", "Zinzino's app logo was not replaced")

print("\n== 7) publishing respects the sheet's stage ==")
c = db(); c.execute("UPDATE exhibitors SET is_published=0 WHERE company_name='Zero Gravity'"); c.commit()
r = run("--apply", EXHIBITOR_PAGE_PUBLISH="1")
e2 = {v["company_name"]: v for v in exhibitors().values()}
check(e2["Zero Gravity"]["is_published"] == 1, "a confirmed exhibitor on the page is published")
check(e2["Avini Health"]["is_published"] == 0 and "Avini Health (not_aligned)" in r.stdout,
      "Avini Health (sheet: not aligned) is reported, not published", r.stdout[-500:])

print("\n== 8) a new exhibitor on the page ==")
html = open(PAGE, encoding="utf-8").read()
card = ('<div class="exh-card"><div class="exh-logo-wrap"><img src="https://example.invalid/zz.png" alt="Zz"></div>'
        '<div class="exh-name">Zz Page Exhibitor</div></div>')
i = html.find('<div class="exh-card">')
page2 = os.path.join(work, "page2.html"); open(page2, "w", encoding="utf-8").write(html[:i] + card + html[i:])
r = run("--apply", page=page2, EXHIBITOR_PAGE_PUBLISH="1")
zz = [v for v in exhibitors().values() if v["company_name"] == "Zz Page Exhibitor"]
check(len(zz) == 1 and zz[0]["is_published"] == 1 and zz[0]["logo_url"].endswith("zz.png") and zz[0]["can_scan_leads"] == 0,
      "created once, published, with logo, no scanner", zz)

print("\n== 9) an exhibitor leaving the page ==")
j = html.find('class="exh-name">Zinzino'); a = html.rfind('<div class="exh-card">', 0, j); b = html.find('<div class="exh-card">', j)
html3 = html[:a] + html[b:]
while 'class="exh-name">Zinzino' in html3:            # the strip repeats its set
    j = html3.find('class="exh-name">Zinzino'); a = html3.rfind('<div class="exh-card">', 0, j); b = html3.find('<div class="exh-card">', j)
    html3 = html3[:a] + html3[b:]
page3 = os.path.join(work, "page3.html"); open(page3, "w", encoding="utf-8").write(html3)
r = run("--apply", page=page3, EXHIBITOR_PAGE_PUBLISH="1")
zin = [v for v in exhibitors().values() if v["company_name"] == "Zinzino"][0]
check("Zinzino" in r.stdout.split("not on the page")[-1] and zin["is_published"] == 1, "reported, still published", r.stdout[-300:])

print("\n== 10) a page that no longer parses ==")
bad = os.path.join(work, "bad.html"); open(bad, "w").write("<html><body>Coming soon</body></html>")
before = exhibitors(), sponsors()
r = run("--apply", page=bad)
check(r.returncode == 1 and (exhibitors(), sponsors()) == before, "exit 1, nothing applied")

print("\n== 11) a second run changes nothing ==")
run("--apply", page=page2, EXHIBITOR_PAGE_PUBLISH="1")
before = exhibitors(), sponsors()
r = run("--apply", page=page2, EXHIBITOR_PAGE_PUBLISH="1")
strip = lambda e: {k: {f: x for f, x in v.items() if f != "site_synced_at"} for k, v in e.items()}
check(strip(exhibitors()) == strip(before[0]) and sponsors() == before[1] and "new 0, updated 0, to publish 0" in r.stdout,
      "idempotent", r.stdout[:300])

print("\n== 12) the watch file and the live database ==")
w = json.load(open(os.path.join(work, "exhibitor-page-watch.json")))
check(w.get("rows") and w.get("sponsors") and w.get("fingerprint") and w.get("synced") is not None, "the page fingerprint is recorded", w)
live_after = live.execute(q).fetchone(), live.execute("SELECT count(*), group_concat(name||tier, '|') FROM sponsors").fetchone()
check(live_before == live_after, "the live database was never touched")

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
