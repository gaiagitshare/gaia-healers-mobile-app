# -*- coding: utf-8 -*-
"""Upgrades with nobody to upgrade, and invoiced add-ons (11 Nov 2026 audit).

* An upgrade bought under another address used to become a brand-new attendee
  holding the upgraded tier: a full VIP with no base ticket. It now goes to the
  ticket holder by GHL contact, or is parked for review with no access.
* An invoiced add-on used to be granted as a full tier upgrade.
* A refunded guest who pays again by invoice is reactivated.
* A refunded upgrade invoice replayed never lifts the tier again.
Throwaway event on a testbed copy, .invalid addresses."""
import json, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime, timedelta
sys.path.insert(0, "/root/event/backend")
env = {}
for line in open("/root/event/backend/.env"):
    t = line.strip()
    if "=" in t and not t.startswith("#"):
        k, v = t.split("=", 1); env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
SVC = env["IDENTITY_SERVICE_TOKEN"]
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import testbed
BASE, DB = testbed.start()
fails = []
def check(ok, label, detail=""):
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", label, "" if ok else "   %s" % (detail,)))
    if not ok: fails.append(label)
def call(m, p, b=None, tok=None):
    d = json.dumps(b).encode() if b is not None else None
    r = urllib.request.Request(BASE + p, data=d, method=m); r.add_header("Content-Type", "application/json")
    if tok: r.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(r) as x: return x.status, json.loads(x.read() or "null")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or "null")
        except Exception: return e.code, None
def row(aid):
    c = sqlite3.connect(DB)
    try:
        r = c.execute("SELECT ticket_type_id, registration_status, custom_data FROM attendees WHERE id=?", (aid,)).fetchone()
        return r[0], r[1], json.loads(r[2] or "{}")
    finally: c.close()

print("ORPHAN UPGRADES AND INVOICED ADD-ONS")
st = datetime.utcnow() + timedelta(days=25)
_s, ev = call("POST", "/events", {"name": "ZZ orphan test", "start_date": st.isoformat(),
    "end_date": (st + timedelta(days=2)).isoformat(), "location": "T", "timezone": "UTC"}, ADMIN)
EV = ev["id"]
_s, ga = call("POST", "/events/%d/ticket-types" % EV, {"code": "ZZ-GA", "name": "ZZ GA", "sort_order": 3, "upgrade_rank": 1}, ADMIN)
_s, vip = call("POST", "/events/%d/ticket-types" % EV, {"code": "ZZ-VIP", "name": "ZZ VIP", "is_vip": True, "grants_conference": True,
               "grants_workshops": True, "sort_order": 1, "upgrade_rank": 9}, ADMIN)
GA, VIP = ga["id"], vip["id"]
for pid, tt, up, addon in (("zz-ga", GA, False, None), ("zz-vip-up", VIP, True, None), ("zz-oneday", VIP, True, "ONE_DAY_CONFERENCE")):
    b = {"external_product_id": pid, "ticket_type_id": tt, "is_upgrade": up, "is_active": True, "label": pid,
         "entitlement_type": "EVENT_UPGRADE" if up else "EVENT_TICKET"}
    if addon: b["addon_code"] = addon
    s, m = call("POST", "/events/%d/ticket-mappings" % EV, b, ADMIN)
    if addon and isinstance(m, dict) and m.get("addon_code") != addon:
        c = sqlite3.connect(DB); c.execute("UPDATE ticket_mappings SET addon_code=? WHERE external_product_id=?", (addon, pid)); c.commit(); c.close()

E = lambda n: "orph-%s-test@example.invalid" % n
def order(email, oid, pid, tt, up, contact=None):
    return call("POST", "/identity/reconcile-attendee", {"event_id": EV, "email": email, "first_name": "Zz", "last_name": "Test",
        "order_id": oid, "product_id": pid, "ticket_type_id": tt, "is_upgrade": up, "contact_id": contact, "amount": 10}, SVC)
def invoice(email, iid, pid, contact=None, amount=10):
    return call("POST", "/identity/reconcile-invoice", {"event_id": EV, "email": email, "invoice_id": iid, "product_id": pid,
        "contact_id": contact, "status": "paid", "amount": amount, "first_name": "Zz", "last_name": "Test"}, SVC)

# 1. upgrade under another email, same GHL contact -> lands on the holder
s, h = order(E("holder"), "zz-o1", "zz-ga", GA, False, contact="zzc-1")
s, u = order(E("other-address"), "zz-o2", "zz-vip-up", VIP, True, contact="zzc-1")
check(u.get("attendee_id") == h.get("attendee_id"), "an upgrade under another address reaches the holder by contact", (h, u))
check(row(h["attendee_id"])[0] == VIP, "and lifts their tier")
# 2. upgrade nobody holds -> parked, no access
s, o = order(E("nobody"), "zz-o3", "zz-vip-up", VIP, True, contact="zzc-unknown")
tt, stt, cd = row(o["attendee_id"])
check(tt is None and cd.get("needs_identity_review"), "an upgrade nobody holds is parked for review", (tt, cd.get("needs_identity_review")))
_s, det = call("GET", "/attendees/%d" % o["attendee_id"], tok=ADMIN)
eff = (det or {}).get("effective_access") or {}
check(not eff.get("base_ticket"), "and gives no access on its own", eff.get("base_ticket"))
_s, rq = call("GET", "/events/%d/review-queue" % EV, tok=ADMIN)
check(any(i.get("kind") == "identity_review" for i in (rq or {}).get("items", [])), "and shows in the Review queue")
# 3. invoiced add-on on a GA holder -> add-on, not a VIP upgrade
s, g = order(E("ga2"), "zz-o4", "zz-ga", GA, False)
s, a = invoice(E("ga2"), "zz-i1", "zz-oneday")
tt, stt, cd = row(g["attendee_id"])
check(tt == GA, "an invoiced add-on does not lift the tier", tt)
check(any(e.get("addon_code") == "ONE_DAY_CONFERENCE" for e in cd.get("entitlements", [])), "it is recorded as the add-on")
# 4. refunded, then pays again by invoice -> reactivated
s, r = order(E("refund"), "zz-o5", "zz-ga", GA, False)
call("POST", "/identity/refund-ticket", {"event_id": EV, "email": E("refund"), "order_id": "zz-o5", "full": True}, SVC)
check(row(r["attendee_id"])[1] == "refunded", "a refund blocks the ticket")
invoice(E("refund"), "zz-i2", "zz-ga")
check(row(r["attendee_id"])[1] == "active", "a new paid invoice reactivates them", row(r["attendee_id"])[1])
# 5. refunded upgrade invoice replayed -> tier not lifted again
s, b = order(E("upref"), "zz-o6", "zz-ga", GA, False)
invoice(E("upref"), "zz-i3", "zz-vip-up")
check(row(b["attendee_id"])[0] == VIP, "an upgrade invoice lifts the tier")
call("POST", "/identity/refund-ticket", {"event_id": EV, "email": E("upref"), "invoice_id": "zz-i3", "full": True}, SVC)
c = sqlite3.connect(DB); c.execute("UPDATE attendees SET ticket_type_id=? WHERE id=?", (GA, b["attendee_id"])); c.commit(); c.close()
invoice(E("upref"), "zz-i3", "zz-vip-up")
check(row(b["attendee_id"])[0] == GA, "replaying the refunded upgrade invoice does not lift it again", row(b["attendee_id"])[0])
call("DELETE", "/events/%d" % EV, tok=ADMIN)
print("\n%d failed" % len(fails)); sys.exit(1 if fails else 0)
