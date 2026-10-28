# -*- coding: utf-8 -*-
"""EVENT WEBSITE CONTENT — tickets, exhibitor packages, FAQ and hotel reach the app.

The Elevate pages in GHL are the source of truth (Babak, 28 Oct 2026). This
proves, on a COPY of the live database (served by the real API) and saved
copies of the two pages:
  1. off by default: it only watches the pages (fingerprints written), writes nothing
  2. a dry run reports 4 tickets, 4 packages, 12 FAQ, 1 hotel and writes nothing
  3. --apply stores them, and /public/events/1/site returns them with the
     official purchase links (GHL checkout; the app never sells)
  4. packages carry name, type, regular and early-bird price, benefits,
     availability and the claim link; a filled package has no buy link
  5. a price changed on the website updates the app on the next run
  6. a package marked filled on the website loses its buy link
  7. an item removed from the website is hidden (kept, not deleted); it comes
     back if the website shows it again
  8. a page that no longer parses changes nothing for that page and exits 1,
     while the other page still applies
  9. a second run changes nothing
 10. sponsors carry the website's categories (Title / Premium / Gifted to You By)
 11. the live database is never touched

Run:  python3 /root/event/backend/test_event_site_sync.py
"""
import json, os, re, sqlite3, subprocess, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "tools", "event_site_sync.py")
MAIN = os.path.join(HERE, "fixtures", "event-page-2026-10-28.html")
PKG = os.path.join(HERE, "fixtures", "exhibitors-and-speakers-page-2026-10-28.html")
sys.path.insert(0, HERE)
import testbed

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + str(extra)[:500])))
    if not cond: fails += 1

print("EVENT WEBSITE CONTENT")
live = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "event.db"), uri=True)
def live_state():
    t = [r[0] for r in live.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='site_items'")]
    return live.execute("SELECT count(*), group_concat(title||coalesce(price,''), '|') FROM site_items").fetchone() if t else None
live_before = live_state()
BASE, DB = testbed.start()
work = os.path.dirname(DB)
base = dict(os.environ, DATABASE_URL="sqlite:///" + DB, VENDOR_SYNC_DATA=work)
base.pop("EVENT_SITE_SYNC", None)

def run(*args, main=MAIN, pkg=PKG, **env):
    return subprocess.run([sys.executable, TOOL] + list(args) + [main, pkg], env=dict(base, **env),
                          capture_output=True, text=True, timeout=120)
def rows():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
    have = c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='site_items'").fetchone()
    return [tuple(r) for r in c.execute("SELECT kind, key, title, price, status, url, is_active FROM site_items ORDER BY id")] if have else []
def site():
    return json.load(urllib.request.urlopen(BASE + "/public/events/1/site", timeout=20))
def write(name, html):
    p = os.path.join(work, name); open(p, "w", encoding="utf-8").write(html); return p

print("\n== 1) off by default ==")
r = subprocess.run([sys.executable, TOOL], env=dict(base, EVENT_SITE_WATCH="0"), capture_output=True, text=True)
check(r.returncode == 0 and rows() == [], "without EVENT_SITE_SYNC=1 and no pages given, nothing is written")

print("\n== 2) dry run ==")
r = run()
check(r.returncode == 0 and "faq 12 · hotel 1 · note 1 · package 4 · ticket 4" in r.stdout and rows() == [],
      "4 tickets, 4 packages, 12 FAQ, 1 hotel reported; nothing written", r.stdout[:300])

print("\n== 3) apply; the public endpoint ==")
r = run("--apply")
s = site()
check(r.returncode == 0 and len(s["tickets"]) == 4 and len(s["packages"]) == 4 and len(s["faq"]) == 12 and len(s["hotel"]) == 1,
      "stored and served", {k: len(v) for k, v in s.items() if isinstance(v, list)})
vip = s["tickets"][0]
check(vip["title"] == "VIP Pass" and vip["price"] == "$999" and vip["badge"] == "Most Inclusive" and len(vip["perks"]) == 3
      and vip["url"].startswith("https://crm.gaiahealers.com/"), "VIP Pass: price, badge, perks, official link", vip)
hotel = s["hotel"][0]
check(hotel["title"] == "Rosen Shingle Creek" and hotel["subtitle"] == "Orlando, FL" and "GRP_GAIA26" in hotel["url"],
      "hotel: venue, place and the group booking link", hotel)

print("\n== 4) packages ==")
p = {x["title"]: x for x in s["packages"]}
amb = p["The Ambassador"]
check(amb["subtitle"] == "Exhibitor Package" and amb["price"] == "$3,500" and amb["regular_price"] == "$5,000"
      and amb["badge"] == "Early Bird" and len(amb["perks"]) == 5 and "4 Spots Remaining" in (amb["availability"] or "")
      and amb["url"] == "https://exhibitors.gaiahealers.com/check-out-page", "The Ambassador, complete", amb)
leg = p["The Legacy Partner"]
check(leg["status"] == "filled" and leg["url"] is None and "Filled" not in (leg["availability"] or ""),
      "The Legacy Partner is filled: no buy link", leg)
check(any(n["key"] == "package-terms" and "final" in n["body"] for n in s["notes"]), "the package terms are carried")

print("\n== 5) a price change on the website ==")
pkg = open(PKG, encoding="utf-8").read()
pkg2 = pkg.replace('<span class="ph-pkg-price">$3,500</span>', '<span class="ph-pkg-price">$3,900</span>', 1)
r = run("--apply", pkg=write("pkg2.html", pkg2))
check({x["title"]: x for x in site()["packages"]}["The Ambassador"]["price"] == "$3,900" and "Changed on the website" in r.stdout,
      "the app follows the new price", r.stdout[-300:])

print("\n== 6) a package marked filled on the website ==")
i = pkg2.find('<a href="https://exhibitors.gaiahealers.com/check-out-page" class="ph-pkg-btn">Claim Ambassador Package</a>')
pkg3 = pkg2[:i] + '<div>This Package Has Been Filled</div>' + pkg2[i + len('<a href="https://exhibitors.gaiahealers.com/check-out-page" class="ph-pkg-btn">Claim Ambassador Package</a>'):]
r = run("--apply", pkg=write("pkg3.html", pkg3))
amb3 = {x["title"]: x for x in site()["packages"]}["The Ambassador"]
check(amb3["status"] == "filled" and amb3["url"] is None, "no buy link once filled", amb3)

print("\n== 7) an item removed from the website, then back ==")
main = open(MAIN, encoding="utf-8").read()
a = main.find("<!-- General Admission -->"); b = main.find("</a>\n    </div>", a) + len("</a>\n    </div>")
main2 = main[:a] + main[b:]
check(main2.count('class="tix-card') == 3, "test page has 3 tickets", main2.count('class="tix-card'))
r = run("--apply", main=write("main2.html", main2), pkg=write("pkg3b.html", pkg3))
titles = [t["title"] for t in site()["tickets"]]
hidden = [x for x in rows() if x[0] == "ticket" and x[2] == "General Admission"]
check("General Admission" not in titles and hidden and hidden[0][6] == 0, "hidden in the app, kept in the table", (titles, hidden))
r = run("--apply", pkg=write("pkg3c.html", pkg3))
check("General Admission" in [t["title"] for t in site()["tickets"]], "back when the website shows it again")

print("\n== 8) a page that no longer parses ==")
before = rows()
bad = write("bad.html", "<html><body>Coming soon</body></html>")
r = run("--apply", main=bad, pkg=write("pkg2b.html", pkg2))
after = rows()
main_rows = lambda rs: [x for x in rs if x[0] in ("ticket", "faq", "hotel")]
check(r.returncode == 1 and main_rows(after) == main_rows(before), "exit 1, the broken page's items untouched", r.stdout[:300])
check({x["title"]: x for x in site()["packages"]}["The Ambassador"]["status"] == "available",
      "the other page still applied (the Ambassador is available again)")

print("\n== 9) a second run changes nothing ==")
run("--apply")
before = rows(); r = run("--apply")
check(rows() == before and "new: 0 · changed: 0 · removed from the page: 0" in r.stdout, "idempotent", r.stdout[:300])

print("\n== 10) sponsor categories ==")
cats = {x["tier"]: x.get("category") for x in json.load(urllib.request.urlopen(BASE + "/public/events/1/sponsors", timeout=20))}
check(cats.get("headline") == "Title Sponsor" and cats.get("gold") == "Premium Sponsor", "headline → Title Sponsor, gold → Premium Sponsor", cats)

print("\n== 11) watch file and the live database ==")
w = json.load(open(os.path.join(work, "event-site-watch.json")))
check(set(w.get("pages", {})) == {"main", "packages"} and w.get("rows") and w.get("synced") is True, "per-page fingerprints recorded", w)
check(live_state() == live_before, "the live database was never touched")

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
