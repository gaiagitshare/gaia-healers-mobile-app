# -*- coding: utf-8 -*-
"""DUPLICATE PAYMENT FOLLOW — money paid under a duplicate's email lands on the real badge.

Two people were merged after checking out twice under two email addresses:
Kay Raymond (275 -> 274, 28 Sep) and Marie Moreau (742 -> 741, 1 Oct). Both
duplicate rows are revoked on purpose and must stay so. But a payment is matched
to an attendee by the buyer's email, so each still had a payment landing on the
revoked row, reported as "Money received but the ticket is not valid for entry"
-- the only two critical payments on the event, about two people whose real
badges work.

Proves, on a copy of the live database:
  1. tools/fix_raymond.py (dry run writes nothing) moves Kay's $99 Exhibit Pass
     onto 274's ledger and points 275 at 274; a second run is a no-op
  2. after a reclassify both payments are on the live badge and healthy, and
     the two revoked rows are still revoked and still refused at the door
  3. Kay's door access is what it was: same pass, same days, same zones
  4. nothing else moved: no other payment, no other attendee

Run:  python3 /root/event/backend/test_duplicate_payment_follow.py
"""
import json, os, sqlite3, subprocess, sys, urllib.request, urllib.error

env = {}
for line in open("/root/event/backend/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
SVC = env["IDENTITY_SERVICE_TOKEN"]
HERE = "/root/event/backend"
sys.path.insert(0, HERE)
import testbed
BASE, DB = testbed.start()

def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method)
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or "null")
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + str(extra))))
    if not cond: fails += 1

def snapshot():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
    pe = {r["id"]: (r["recon_state"], r["attendee_id"]) for r in c.execute("SELECT id, recon_state, attendee_id FROM payment_events")}
    at = {r["id"]: (r["registration_status"], r["ticket_type_id"], r["qr_code"], r["public_token"], r["email"], r["custom_data"])
          for r in c.execute("SELECT * FROM attendees")}
    return pe, at

def access(aid):
    st, a = call("GET", "/attendees/%d" % aid, None, ADMIN)
    ea = (a or {}).get("effective_access") if isinstance(a, dict) else None
    if not ea:
        return st, None
    keep = {k: ea.get(k) for k in ("base_ticket", "tier", "zones", "days", "valid_days", "conference_days", "addons", "access") if k in ea}
    return st, json.dumps(keep, sort_keys=True, default=str)

print("DUPLICATE PAYMENT FOLLOW")
pe0, at0 = snapshot()
# Informational only: on a fresh copy before the repair both sit on the revoked
# rows; once the repair is live they already sit on the live badges. The end
# state is what is asserted below.
print("  info  start: Kay %s, Marie %s" % (pe0.get(593), pe0.get(1404)))
_, kay_before = access(274)

env2 = dict(os.environ, DATABASE_URL="sqlite:///" + DB)
dry = subprocess.run([sys.executable, os.path.join(HERE, "tools", "fix_raymond.py")], env=env2, capture_output=True, text=True)
check(dry.returncode == 0 and ("Dry run" in dry.stdout or "Already done" in dry.stdout) and snapshot()[1] == at0,
      "the dry run writes nothing", dry.stdout[-400:] + dry.stderr[-400:])
app = subprocess.run([sys.executable, os.path.join(HERE, "tools", "fix_raymond.py"), "--apply"], env=env2, capture_output=True, text=True)
check(app.returncode == 0 and ("Applied" in app.stdout or "Already done" in app.stdout), "the repair applies (or is already in place)", app.stdout[-400:] + app.stderr[-400:])
again = subprocess.run([sys.executable, os.path.join(HERE, "tools", "fix_raymond.py"), "--apply"], env=env2, capture_output=True, text=True)
check(again.returncode == 0 and "Already done" in again.stdout, "a second run is a no-op", again.stdout[-300:] + again.stderr[-300:])

c = sqlite3.connect(DB)
k274 = json.loads(c.execute("SELECT custom_data FROM attendees WHERE id=274").fetchone()[0])
k275 = json.loads(c.execute("SELECT custom_data FROM attendees WHERE id=275").fetchone()[0])
check(any(e.get("order_id") == "69ffc0f196309439f99c0a46" and e.get("status") == "paid" for e in k274["entitlements"])
      and k275["entitlements"] == [] and k275["duplicate_of"] == 274, "Kay's Exhibit Pass is on 274; 275 points at 274 and holds nothing")

st, r = call("POST", "/identity/payments/reclassify", {}, SVC)
check(st == 200, "reclassify runs", (st, r))
pe1, at1 = snapshot()
check(pe1[593] == ("healthy", 274), "Kay's $99 is on her live badge, healthy", pe1[593])
check(pe1[1404] == ("healthy", 741), "Marie's $97 upgrade is on her live badge, healthy", pe1[1404])
check(at1[275][0] == "revoked" and at1[742][0] == "revoked", "both duplicate rows stay revoked")
for aid in (274, 275, 741, 742):
    check(at1[aid][2:5] == at0[aid][2:5], "#%d keeps its QR, token and email" % aid)

_, kay_after = access(274)
check(kay_before is not None and kay_before == kay_after, "Kay's door access is exactly what it was", (kay_before, kay_after))
for qr, want, who in (("ATT-66A55FD2F221", True, "Kay's live badge"), ("ATT-77FED6C1D6AE", False, "Kay's revoked row"),
                      ("ATT-00E6EB360515", True, "Marie's live badge"), ("ATT-8ADDA9014A9C", False, "Marie's revoked row")):
    st, d = call("POST", "/events/1/authorize", {"qr_code": qr, "access_type": "EVENT_ENTRY"}, ADMIN)
    check(st == 200 and bool(d.get("granted")) is want, "%s %s at the door" % (who, "admits" if want else "is refused"), (st, d.get("result") if isinstance(d, dict) else d, d.get("reason") if isinstance(d, dict) else ""))

moved_pe = [i for i in pe0 if pe0[i] != pe1.get(i) and i not in (593, 1404) and pe1[i][0] != "healthy"]
check(not moved_pe, "no other payment was made worse", [(i, pe0[i], pe1[i]) for i in moved_pe][:5])
moved_at = [i for i in at0 if i not in (274, 275, 741, 742) and at0[i][:5] != at1[i][:5]]
check(not moved_at, "no other attendee changed", moved_at[:5])

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
