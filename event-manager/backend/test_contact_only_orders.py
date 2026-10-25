# -*- coding: utf-8 -*-
"""CONTACT-ONLY ORDERS — a paid order with no email still reaches its ticket holder.

On 22 Oct 2026 Erika Cunningham paid $1,058.94 for VIP under a second GHL
contact that had a phone and no email. The mirror skipped the order, the
reconciler demanded an email, and the payment matcher matched on email only, so
the money read "paid, no ticket" for three days. Four minutes later Sarah
Brooker made the same purchase on her own contact and became VIP on her badge.

Proves, on a copy of the live database:
  1. tools/fix_cunningham.py: the dry run writes nothing; --apply links the
     second contact to badge 225 and flags 225 and 202; a second run is a no-op
  2. a contact-only reconcile of the VIP order lands on 225 -- no new attendee,
     no second badge -- and a repeat of it changes nothing
  3. Erika's door access is VIP (the VIP zone admits her) and her QR is unchanged
  4. after a reclassify the $1,058.94 payment is on 225 and no longer critical
  5. the review queue holds a "confirm this purchase" item for both women
  6. a contact-only order for a contact nobody holds is still refused (400)
  7. nothing else moved: no other attendee, no other payment made worse

Run:  python3 /root/event/backend/test_contact_only_orders.py
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

def snapshot():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
    pe = {r["id"]: (r["recon_state"], r["attendee_id"]) for r in c.execute("SELECT id, recon_state, attendee_id FROM payment_events")}
    at = {r["id"]: (r["registration_status"], r["ticket_type_id"], r["qr_code"], r["public_token"], r["email"], r["custom_data"])
          for r in c.execute("SELECT * FROM attendees")}
    return pe, at

ERIKA, SARAH, PAY = 225, 202, 1482
ORDER, NEW_CONTACT = "6ad95876fac91c38b383f9c5", "tipIMGG9QiM0rnmAePoG"

print("CONTACT-ONLY ORDERS")
pe0, at0 = snapshot()
n0 = len(at0)

env2 = dict(os.environ, DATABASE_URL="sqlite:///" + DB)
tool = [sys.executable, os.path.join(HERE, "tools", "fix_cunningham.py")]
dry = subprocess.run(tool, env=env2, capture_output=True, text=True)
check(dry.returncode == 0 and ("Dry run" in dry.stdout or "Already done" in dry.stdout) and snapshot()[1] == at0,
      "the dry run writes nothing", dry.stdout[-400:] + dry.stderr[-400:])
app = subprocess.run(tool + ["--apply"], env=env2, capture_output=True, text=True)
check(app.returncode == 0 and ("Applied" in app.stdout or "Already done" in app.stdout), "the tool applies (or is already in place)", app.stdout[-400:] + app.stderr[-400:])
again = subprocess.run(tool + ["--apply"], env=env2, capture_output=True, text=True)
check(again.returncode == 0 and "Already done" in again.stdout, "a second run is a no-op", again.stdout[-300:] + again.stderr[-300:])

order = {"event_id": 1, "email": "", "contact_id": NEW_CONTACT, "order_id": ORDER, "ticket_type_id": 4,
         "is_upgrade": False, "product_id": "69b461f512895312b36276de", "quantity": 1, "amount": 1058.94,
         "purchased_at": "2026-10-22T00:27:35", "first_name": "Erika", "last_name": "D Cunningham"}
st, r = call("POST", "/identity/reconcile-attendee", order, SVC)
check(st == 200 and r.get("attendee_id") == ERIKA and not r.get("seat_of"), "the contact-only VIP order lands on badge 225, no new seat", (st, r))
st2, r2 = call("POST", "/identity/reconcile-attendee", order, SVC)
check(st2 == 200 and r2.get("attendee_id") == ERIKA and not r2.get("created"), "the same order again changes nothing", (st2, r2))

st, a = call("GET", "/attendees/%d" % ERIKA, None, ADMIN)
ea = (a or {}).get("effective_access") or {}
check((ea.get("base_ticket") or {}).get("id") == 4, "Erika's effective ticket is VIP", ea.get("effective_label"))
check(a.get("ticket_type_id") == 4, "and her stored pass says VIP too, not the June GA", a.get("ticket_type_id"))
qr = at0[ERIKA][2]
st, d = call("POST", "/events/1/authorize", {"qr_code": qr, "access_type": "VIP"}, ADMIN)
check(st == 200 and d.get("granted") is True, "her badge admits her to the VIP zone", (st, d))
st, d = call("POST", "/events/1/authorize", {"qr_code": qr, "access_type": "EVENT_ENTRY"}, ADMIN)
check(st == 200 and d.get("granted") is True, "and through the front door", (st, d))

st, r = call("POST", "/identity/payments/reclassify", {}, SVC)
check(st == 200, "reclassify runs", (st, r))
pe1, at1 = snapshot()
check(pe1[PAY][1] == ERIKA and pe1[PAY][0] != "critical", "the $1,058.94 payment is on 225 and not critical", pe1[PAY])

st, q = call("GET", "/events/1/review-queue", None, ADMIN)
conf = [i for i in (q or {}).get("items", []) if i.get("kind") == "confirm_purchase"]
check({i.get("attendee_id") for i in conf} >= {ERIKA, SARAH}, "the review queue asks for a call to both women", conf)

bad = dict(order, contact_id="nobodyHasThisContact0", order_id="test-contact-only-unknown")
st, r = call("POST", "/identity/reconcile-attendee", bad, SVC)
check(st == 400, "an order for a contact nobody holds is still refused", (st, r))

check(len(at1) == n0, "no attendee was created", (n0, len(at1)))
check(at1[ERIKA][2:5] == at0[ERIKA][2:5] and at1[SARAH][2:5] == at0[SARAH][2:5], "both keep their QR, token and email")
moved_at = [i for i in at0 if i not in (ERIKA, SARAH) and at0[i][:5] != at1[i][:5]]
check(not moved_at, "no other attendee changed", moved_at[:5])
worse = [i for i in pe0 if i != PAY and pe0[i] != pe1.get(i) and pe1[i][0] == "critical"]
check(not worse, "no other payment was made critical", [(i, pe0[i], pe1[i]) for i in worse][:5])

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
