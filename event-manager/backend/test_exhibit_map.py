# -*- coding: utf-8 -*-
"""Exhibit-hall map: a booth pin follows the planning sheet's booth number (3 Nov 2026).

On a testbed copy. A pin named "Booth N" links to the one published exhibitor
whose booth number holds table N -- "12", "#12", "2 & 3" -- so moving a company
in the sheet moves it on the map with nobody editing pins. A tentative "maybe"
table is not a claim; two claims on one table are left unassigned, never
guessed; an unpublished stand never appears; an explicit exhibitor_id wins.
"""
import json, os, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
env = {}
for line in open(os.path.join(HERE, ".env")):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1); env[k] = v.strip().strip('"').strip("'")
from jose import jwt  # noqa: E402
import testbed  # noqa: E402
BASE, DB = testbed.start()
ADMIN = jwt.encode({"sub": "1", "exp": datetime.now(timezone.utc) + timedelta(hours=1)}, env["SECRET_KEY"], algorithm="HS256")

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else "   " + str(extra)[:400]))
    if not cond: fails += 1

def http(method, path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Authorization": "Bearer " + ADMIN, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e: return e.code, e.read().decode()[:300]

c = sqlite3.connect(DB)
# Free table numbers far above the real hall, so real stands never interfere.
def stand(name, booth, published=1):
    cur = c.execute("insert into exhibitors(event_id,company_name,booth_number,is_published,stage,access_token,created_at,sort_order,can_scan_leads,logo_on_dark,show_contact_publicly,contact_email) values(1,?,?,?,'confirmed',?,datetime('now'),0,0,0,0,'')",
                    (name, booth, published, os.urandom(8).hex()))
    c.commit(); return cur.lastrowid
a = stand("ZZ Map A", "901")
b = stand("ZZ Map B", "#902 & #903")
m = stand("ZZ Map Maybe", "904 (maybe #905 also)")
x1 = stand("ZZ Map Clash 1", "906"); x2 = stand("ZZ Map Clash 2", "906")
h = stand("ZZ Map Hidden", "907", published=0)
e = stand("ZZ Map Explicit", "908")
pins = {}
for n in range(901, 909):
    st, p = http("POST", "/events/1/places", {"kind": "booth", "name": "Booth %d" % n, "x": 10, "y": 10})
    assert st in (200, 201), (st, p); pins[n] = p["id"]
st, p = http("POST", "/events/1/places", {"kind": "booth", "name": "Booth 909", "x": 10, "y": 10, "exhibitor_id": a})
pins[909] = p["id"]

def linked():
    st, mp = http("GET", "/public/events/1/map")
    assert st == 200, (st, mp)
    return {pl["name"]: pl["exhibitor_id"] for pl in mp["places"] if pl["name"].startswith("Booth 9")}

L = linked()
check(L["Booth 901"] == a, "a plain booth number links its stand")
check(L["Booth 902"] == b and L["Booth 903"] == b, "'#902 & #903' links both tables")
check(L["Booth 904"] == m and L["Booth 905"] is None, "a 'maybe' second table is not a claim")
check(L["Booth 906"] is None, "two stands on one table: left unassigned, never guessed", L["Booth 906"])
check(L["Booth 907"] is None, "an unpublished stand is never on the public map")
check(L["Booth 909"] == a, "an explicit exhibitor_id on the pin wins")
c.execute("update exhibitors set booth_number='908' where id=?", (a,)); c.execute("update exhibitors set booth_number='' where id=?", (e,)); c.commit()
L = linked()
check(L["Booth 908"] == a and L["Booth 901"] is None, "moving a stand in the sheet moves it on the map")
c.execute("update exhibitors set is_published=1 where id=?", (h,)); c.commit()
check(linked()["Booth 907"] == h, "publishing a stand puts it on its table")

# Optional profile fields (3 Nov 2026): social links and Featured.
def public(eid):
    st, rows = http("GET", "/public/events/1/exhibitors")
    return next(r for r in rows if r["id"] == eid)
check(public(a)["social_links"] == [] and public(a)["is_featured"] is False, "new fields default to empty / not featured")
st, _ = http("PUT", "/exhibitors/%d" % a, {"social_links": ["https://instagram.com/zzmap", "javascript:alert(1)", "http://plain.example", "https://x.com/zz"], "is_featured": True})
check(st == 200, "an organiser can set them", (st, _))
pa = public(a)
check(pa["social_links"] == ["https://instagram.com/zzmap", "https://x.com/zz"], "only https links reach attendees", pa["social_links"])
check(pa["is_featured"] is True, "Featured is the organiser's explicit choice")
st, _ = http("PUT", "/exhibitors/%d" % a, {"social_links": []})
check(public(a)["social_links"] == [], "and can be cleared")

print("\n%s" % ("ALL PASSED" if not fails else "%d FAILED" % fails))
sys.exit(1 if fails else 0)
