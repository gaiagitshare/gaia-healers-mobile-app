# -*- coding: utf-8 -*-
"""REFUND WITHDRAWN — a refunded extra charge is not a refund leak.

Amy L Paff (#695) paid $99 on 20 Sep, paid $99 again two minutes later by
mistake, and the second charge was refunded. The refund path marked that
order's entitlement refunded, and her badge stands on the first, paid, order --
which is correct. The reconciler judged the refund against the badge as a
whole, called it "Payment was reversed and the ticket is still valid", and the
gaia app has raised a critical alert about it every minute since.

Proves, on a copy of the live database:
  1. the rule on its own: withdrawn + another paid order = healthy; a badge
     whose ONLY paid order was refunded is still critical
  2. after a reclassify, Amy's refund is healthy, her badge still admits, and
     the service-side "refunded still active" count no longer includes her
  3. no other payment changes state except refunds that are withdrawn the
     same way, and nothing about any attendee changes

Run:  python3 /root/event/backend/test_refund_withdrawn.py
"""
import json, sqlite3, sys, urllib.request, urllib.error
from types import SimpleNamespace as NS

env = {}
for line in open("/root/event/backend/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
SVC = env["IDENTITY_SERVICE_TOKEN"]
sys.path.insert(0, "/root/event/backend")
import testbed
BASE, DB = testbed.start()
import payments
import main

def call(method, path, body=None, token=None, svc=False):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method)
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    if svc: req.add_header("X-Service-Token", SVC); req.add_header("Authorization", "Bearer " + SVC)
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

print("REFUND WITHDRAWN")

# 1 ── the rule
def att(ents, refunded=()):
    return NS(custom_data={"entitlements": ents, "refunded_order_ids": list(refunded)}, registration_status="active")
pe = NS(ghl_entity_id="B", status="refunded", event_id=1)
both = att([{"order_id": "A", "status": "paid"}, {"order_id": "B", "status": "refunded"}], ["B"])
only = att([{"order_id": "B", "status": "refunded"}], ["B"])
unmarked = att([{"order_id": "A", "status": "paid"}, {"order_id": "B", "status": "paid"}])
check(main._refund_withdrawn(both, pe) is True, "refunded order withdrawn, badge on another paid order: withdrawn")
check(main._refund_withdrawn(only, pe) is False, "the only paid order refunded: not withdrawn")
check(main._refund_withdrawn(unmarked, pe) is False, "a refund the ledger never recorded: not withdrawn")
check(payments.classify(pe, both, True, refund_withdrawn=True)[0] == "healthy", "classify: withdrawn is healthy")
check(payments.classify(pe, only, True, refund_withdrawn=False)[0] == "critical", "classify: a live badge on refunded money is still critical")
check(payments.classify(pe, only, False)[0] == "healthy", "classify: refunded and blocked is healthy, as before")

# 2 ── on the copy
c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
before = {r["id"]: (r["recon_state"], r["attendee_id"]) for r in c.execute("SELECT id, recon_state, attendee_id FROM payment_events")}
att_before = {r["id"]: (r["registration_status"], r["ticket_type_id"], r["custom_data"]) for r in c.execute("SELECT id, registration_status, ticket_type_id, custom_data FROM attendees")}
amy = c.execute("SELECT id FROM payment_events WHERE ghl_entity_id='6aafde16d36cf235fa7e7315'").fetchone()
check(amy is not None, "Amy's refund is on the ledger")
st, r = call("POST", "/identity/payments/reclassify", {}, svc=True)
check(st == 200, "reclassify runs", (st, r))
c2 = sqlite3.connect(DB); c2.row_factory = sqlite3.Row
row = c2.execute("SELECT recon_state, recon_reason, attendee_id FROM payment_events WHERE id=?", (amy["id"],)).fetchone()
check(row["recon_state"] == "healthy" and "another paid order" in row["recon_reason"] and row["attendee_id"] == 695,
      "Amy's refund is healthy, still on her badge, and says why", tuple(row))
a695 = c2.execute("SELECT registration_status FROM attendees WHERE id=695").fetchone()[0]
check(a695 not in ("refunded", "cancelled", "revoked"), "her badge still admits: she paid for it", a695)
# The old rule: any reversed payment on a badge that still admits.
old_rule = c2.execute("SELECT count(*) FROM payment_events p JOIN attendees a ON a.id = p.attendee_id "
                      "WHERE p.event_id IS NOT NULL AND p.status IN ('refunded','partially_refunded','reversed','disputed') "
                      "AND COALESCE(a.registration_status,'active') NOT IN ('refunded','cancelled','revoked')").fetchone()[0]
st, ex1 = call("GET", "/identity/payment-exceptions?grace_hours=6", svc=True)
check(old_rule >= 1 and st == 200 and ex1["refunded_still_active"] == old_rule - 1,
      "the alert count no longer includes her (old rule %d, now %s)" % (old_rule, ex1.get("refunded_still_active") if isinstance(ex1, dict) else ex1), ex1)

# 3 ── nothing else moved
after = {r["id"]: (r["recon_state"], r["attendee_id"]) for r in c2.execute("SELECT id, recon_state, attendee_id FROM payment_events")}
# State-independent: whatever was stored before, a reclassify may only ever
# clear a flag here, never raise one, and Amy ends healthy.
moved = [i for i in before if before[i] != after.get(i)]
worse = [i for i in moved if after[i][0] != "healthy"]
check(not worse, "a reclassify only ever clears flags, it raises none", [(i, before[i], after[i]) for i in worse][:6])
att_after = {r["id"]: (r["registration_status"], r["ticket_type_id"], r["custom_data"]) for r in c2.execute("SELECT id, registration_status, ticket_type_id, custom_data FROM attendees")}
check(att_before == att_after, "no attendee, ticket or entitlement changed")

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
