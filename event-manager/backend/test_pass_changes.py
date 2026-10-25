# -*- coding: utf-8 -*-
"""PASS CHANGES AT THE DESK — up, down and back up again, and the door believes each one.

On 25 Oct 2026 an organiser's downgrade was found to do nothing: change-pass
answered 200 and the list said GA, but the badge kept opening the VIP door,
because the paid VIP was still on the ledger and access reads the ledger. For
Sarah Brooker it was worse -- her stored pass column still said GA after she
paid full price for VIP, so "change to GA" was a silent no-op.

Proves, on a copy of the live database, with Sarah Brooker (202: GA in June,
full-price VIP on 22 Oct):
  1. she starts as VIP and the VIP zone admits her
  2. an organiser downgrade to GA takes effect: VIP zone LIMITED, front door
     still admits, effective pass GA, and the cap is recorded
  3. a comp back up to VIP clears the cap and the VIP zone admits again
  4. her QR never changes and no attendee is created

Run:  python3 /root/event/backend/test_pass_changes.py
"""
import json, sqlite3, sys, urllib.request, urllib.error

env = {}
for line in open("/root/event/backend/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
sys.path.insert(0, "/root/event/backend")
import testbed
BASE, DB = testbed.start()

def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method)
    req.add_header("Content-Type", "application/json"); req.add_header("Authorization", "Bearer " + ADMIN)
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return r.status, json.loads(r.read() or "null")
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + str(extra))))
    if not cond: fails += 1

SARAH, GA, VIP = 202, 8, 4
def state():
    st, a = call("GET", "/attendees/%d" % SARAH)
    vip = call("POST", "/events/1/authorize", {"qr_code": a["qr_code"], "access_type": "VIP"})[1]
    return a, (a["effective_access"].get("base_ticket") or {}).get("id"), vip.get("result"), None

print("PASS CHANGES AT THE DESK")
n0 = sqlite3.connect(DB).execute("SELECT count(*) FROM attendees").fetchone()[0]
a0, eff, vip, door = state()
check(eff == VIP and vip == "GRANTED", "Sarah starts as VIP and the VIP zone admits her", (eff, vip))

st, _ = call("POST", "/attendees/%d/change-pass" % SARAH, {"ticket_type_id": GA, "reason": "test downgrade",
                                                          "complimentary": True, "allow_downgrade": True})
a1, eff, vip, door = state()
check(st == 200 and eff == GA, "an organiser downgrade to GA is what she now holds", (st, eff))
check(vip == "LIMITED", "the VIP zone no longer admits her", vip)
door = call("POST", "/events/1/authorize", {"qr_code": a1["qr_code"], "access_type": "EVENT_ENTRY"})[1]
check(door.get("result") == "GRANTED", "the front door still does (first scan of the day)", door.get("reason"))
cap = json.loads(sqlite3.connect(DB).execute("SELECT custom_data FROM attendees WHERE id=?", (SARAH,)).fetchone()[0]).get("admin_cap") or {}
check(cap.get("tt") == GA and cap.get("at"), "the downgrade is recorded as a dated cap", cap)

st, _ = call("POST", "/attendees/%d/change-pass" % SARAH, {"ticket_type_id": VIP, "reason": "test back up",
                                                          "complimentary": True})
a2, eff, vip, door = state()
check(st == 200 and eff == VIP and vip == "GRANTED", "a comp back up to VIP clears the cap", (st, eff, vip))
cd = json.loads(sqlite3.connect(DB).execute("SELECT custom_data FROM attendees WHERE id=?", (SARAH,)).fetchone()[0])
check("admin_cap" not in cd, "no cap left behind", cd.get("admin_cap"))

check(a0["qr_code"] == a1["qr_code"] == a2["qr_code"], "her QR never changes")
n1 = sqlite3.connect(DB).execute("SELECT count(*) FROM attendees").fetchone()[0]
check(n0 == n1, "no attendee was created", (n0, n1))

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
