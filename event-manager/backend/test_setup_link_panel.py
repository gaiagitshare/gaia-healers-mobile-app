# -*- coding: utf-8 -*-
"""The Exhibitors page's "Setup link" button no longer breaks the link a stand
was emailed (11 Nov 2026). It shows the current link; replacing it is an
explicit rotate, recorded in the Email Center so reminders use the new link.
Runs on a testbed copy of both databases; nothing is sent."""
import json, os, sqlite3, sys, urllib.error, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
env = {}
for line in open(os.path.join(HERE, ".env")):
    t = line.strip()
    if "=" in t and not t.startswith("#"):
        k, v = t.split("=", 1); env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
import testbed
BASE, DB = testbed.start()
TD = os.environ["TICKET_DELIVERY_DB"]
fails = []
def check(ok, label, detail=""):
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", label, "" if ok else "   %s" % (detail,)))
    if not ok: fails.append(label)
def call(m, p, tok=None):
    r = urllib.request.Request(BASE + p, method=m); r.add_header("Content-Type", "application/json")
    if tok: r.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(r, data=b"{}" if m == "POST" else None) as x: return x.status, json.loads(x.read() or "null")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or "null")
        except Exception: return e.code, None
def opens(url):
    return call("GET", "/vendor-setup/" + url.rstrip("/").rsplit("/", 1)[-1])[0]
def stored(eid):
    c = sqlite3.connect(TD)
    try: return (c.execute("SELECT link_url FROM ec_exhibitor_emails WHERE exhibitor_id=? AND kind='setup'", (eid,)).fetchone() or [None])[0]
    finally: c.close()

print("SETUP LINK BUTTON")
c = sqlite3.connect(TD)
row = c.execute("SELECT exhibitor_id, link_url FROM ec_exhibitor_emails WHERE kind='setup' AND link_url IS NOT NULL AND link_expires_at > datetime('now') LIMIT 1").fetchone()
c.close()
check(row is not None, "the copy has an invited stand with an emailed link")
EID, EMAILED = row
st0 = opens(EMAILED)
check(st0 == 200, "the emailed link opens", st0)
s, l = call("POST", "/exhibitors/%d/activation-link" % EID, ADMIN)
check(s == 200 and l.get("url") == EMAILED and not l.get("new_link"), "the button shows the link the stand already has", (s, l and l.get("new_link")))
check(opens(EMAILED) == 200, "and the emailed link still opens")
s, r = call("POST", "/exhibitors/%d/activation-link?rotate=1" % EID, ADMIN)
check(s == 200 and r.get("new_link") and r.get("url") != EMAILED, "replacing it is a separate step that makes a new link")
check(opens(EMAILED) != 200, "after which the old link stops working")
check(opens(r["url"]) == 200, "and the new one opens")
check(stored(EID) == r["url"], "the Email Center now holds the new link, so a reminder sends it", stored(EID))
# a link replaced behind the Email Center's back is no longer offered as valid
c = sqlite3.connect(DB); c.execute("UPDATE exhibitors SET setup_token_hash='x' WHERE id=?", (EID,)); c.commit(); c.close()
s, rows = call("GET", "/events/1/email-center/exhibitors", ADMIN)
items = rows.get("items", rows) if isinstance(rows, dict) else rows
mine = [x for x in (items or []) if x.get("id") == EID]
lk = (mine[0].get("setup_link") if mine else None)
check(mine and (lk in (None, "", "none", "missing", "expired") or (isinstance(lk, dict) and not lk.get("url"))) or (mine and str(mine[0].get("setup_link_state", "")).lower() != "valid"),
      "a link that no longer matches the stand is not shown as valid", lk if mine else s)
print("\n%d failed" % len(fails)); sys.exit(1 if fails else 0)
