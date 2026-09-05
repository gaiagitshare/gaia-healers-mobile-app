# -*- coding: utf-8 -*-
"""EVENT-YEAR ISOLATION -- a sale belongs to the conference it was bought for.

GHL reuses product and funnel ids from one year to the next, so a product id on
its own cannot say which conference a ticket is for. Only the product AND when
it was bought can. The mappings have carried `valid_from` since the 2025/2026
mixup was untangled, and the webhook has always honoured it -- but the
reconciler did not, and the reconciler is what the hourly mirror and Map &
Reconcile call.

That gap was invisible for as long as the mirror only ever looked back a few
hours. It stopped being invisible the moment somebody ran a backfill reaching
past 1 January 2026: 311 people who bought a 2025 ticket were admitted to the
2026 conference, complete with QR codes. Nothing was checked in and nothing was
printed, and the rows were removed -- but the hole is the point, not the
incident. A recovery run after an outage would have done the same thing.

So the window is now enforced at the one door every caller comes through. These
tests hold it shut from each side.

Throwaway events and example.invalid people only. GHL is never written to.
Run:  python3 /root/event/backend/test_event_year_isolation.py
"""
import json, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime, timedelta

env = {}
for line in open("/root/event/backend/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
SVC = env["IDENTITY_SERVICE_TOKEN"]
BASE = "http://127.0.0.1:8002"
DB = "/root/event/backend/event.db"

fails = []
def check(ok, label, detail=""):
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", label, "" if ok else "   %s" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        p = e.read()
        try:
            return e.code, json.loads(p or b"null")
        except Exception:
            return e.code, p

def sql(q, a=()):
    c = sqlite3.connect(DB)
    try:
        return c.execute(q, a).fetchall()
    finally:
        c.close()

def write(q, a=()):
    c = sqlite3.connect(DB)
    try:
        c.execute(q, a); c.commit()
    finally:
        c.close()

print("EVENT-YEAR ISOLATION")

for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ yr %'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)

# Two conferences a year apart, and ONE product id sold for both -- exactly the
# shape GHL gives us.
def make(name, start):
    st, ev = call("POST", "/events", {"name": name, "start_date": start.isoformat(),
                                      "end_date": (start + timedelta(days=1)).isoformat(),
                                      "location": "Test", "timezone": "UTC"}, ADMIN)
    assert st in (200, 201), (st, ev)
    st, tt = call("POST", "/events/%d/ticket-types" % ev["id"],
                  {"name": "ZZ GA", "code": "zz-yr-ga-%d" % ev["id"]}, ADMIN)
    return ev["id"], tt["id"]

OLD_EV, OLD_TT = make("ZZ yr 2025", datetime(2025, 11, 7))
NEW_EV, NEW_TT = make("ZZ yr 2026", datetime(2026, 11, 20))
PROD = "zz-yr-shared-product"

def mapping(ev, tt, vf, vu):
    write("INSERT INTO ticket_mappings (event_id, provider, external_product_id, ticket_type_id,"
          " is_upgrade, label, is_active, entitlement_type, valid_from, valid_until)"
          " VALUES (?,?,?,?,0,?,1,?,?,?)",
          (ev, "ghl", PROD, tt, "ZZ yr map", "EVENT_TICKET", vf, vu))

mapping(OLD_EV, OLD_TT, "2025-01-01", "2025-12-31")
mapping(NEW_EV, NEW_TT, "2026-01-01", None)

def reconcile(ev, tt, email, when, ref):
    return call("POST", "/identity/reconcile-attendee", {
        "event_id": ev, "email": email, "ticket_type_id": tt, "product_id": PROD,
        "order_id": ref, "purchased_at": when, "amount": 99.0,
        "first_name": "Zed", "last_name": "Yearly"}, SVC)

print("\nThe same product id, bought in two different years")
st, r = reconcile(NEW_EV, NEW_TT, "y2026@example.invalid", "2026-04-02T10:00:00", "zz-yr-a")
check(st == 200 and r.get("created"), "a 2026 sale joins the 2026 conference", (st, r))

st, r = reconcile(NEW_EV, NEW_TT, "y2025@example.invalid", "2025-09-14T10:00:00", "zz-yr-b")
check(st == 409, "a 2025 sale is REFUSED entry to the 2026 conference", (st, r))
check("outside the sales window" in json.dumps(r), "and says why", r)
check("event %d" % OLD_EV in json.dumps(r), "and says where it does belong", r)
check(not sql("SELECT 1 FROM attendees WHERE event_id=? AND email=?", (NEW_EV, "y2025@example.invalid")),
      "no attendee row was created for the refused sale")

st, r = reconcile(OLD_EV, OLD_TT, "y2025@example.invalid", "2025-09-14T10:00:00", "zz-yr-b")
check(st in (200, 409), "and routed to its own year it is accepted or blocked by archival, never lost", (st, r))

print("\nThe boundary itself")
st, r = reconcile(NEW_EV, NEW_TT, "eve@example.invalid", "2025-12-31T23:59:00", "zz-yr-c")
check(st == 409, "31 December 2025 is outside the 2026 window", st)
st, r = reconcile(NEW_EV, NEW_TT, "day1@example.invalid", "2026-01-01T00:01:00", "zz-yr-d")
check(st == 200, "1 January 2026 is inside it", st)

print("\nWhat the guard must NOT do")
st, r = reconcile(NEW_EV, NEW_TT, "nodate@example.invalid", None, "zz-yr-e")
check(st == 200, "a sale with no date is still admitted -- absent evidence is not evidence of a 2025 sale", (st, r))
st, r = call("POST", "/identity/reconcile-attendee", {
    "event_id": NEW_EV, "email": "walkin@example.invalid", "ticket_type_id": NEW_TT,
    "order_id": "zz-yr-f", "purchased_at": "2025-05-01T10:00:00",
    "first_name": "Zed", "last_name": "Walkin"}, SVC)
check(st == 200, "a sale with no product id is not blocked -- the window is a property of the mapping", (st, r))

write("UPDATE ticket_mappings SET valid_from=NULL WHERE external_product_id=? AND event_id=?", (PROD, NEW_EV))
st, r = reconcile(NEW_EV, NEW_TT, "nowindow@example.invalid", "2019-01-01T10:00:00", "zz-yr-g")
check(st == 200, "a mapping with no window declared claims everything, as it always did", (st, r))
write("UPDATE ticket_mappings SET valid_from='2026-01-01' WHERE external_product_id=? AND event_id=?", (PROD, NEW_EV))

print("\nThe invoice channel is guarded too")
st, r = call("POST", "/identity/reconcile-invoice", {
    "event_id": NEW_EV, "email": "inv2025@example.invalid", "invoice_id": "zz-yr-inv-1",
    "product_id": PROD, "amount": 99.0, "status": "paid", "issued_at": "2025-11-14T10:00:00",
    "first_name": "Zed", "last_name": "Invoiced"}, SVC)
check(st == 409, "a November 2025 invoice cannot become a 2026 attendee", (st, r))
st, r = call("POST", "/identity/reconcile-invoice", {
    "event_id": NEW_EV, "email": "inv2026@example.invalid", "invoice_id": "zz-yr-inv-2",
    "product_id": PROD, "amount": 99.0, "status": "paid", "issued_at": "2026-02-14T10:00:00",
    "first_name": "Zed", "last_name": "Invoiced"}, SVC)
check(st == 200, "a 2026 invoice can", (st, r))

print("\nCounts")
n = sql("SELECT count(*) FROM attendees WHERE event_id=?", (NEW_EV,))[0][0]
check(n == 6, "six admitted through both channels, four refused", n)

# tidy
call("DELETE", "/events/%d" % OLD_EV, token=ADMIN)
call("DELETE", "/events/%d" % NEW_EV, token=ADMIN)
write("DELETE FROM ticket_mappings WHERE external_product_id=?", (PROD,))
write("DELETE FROM member_cards WHERE email LIKE '%@example.invalid'")

print("\n%d checks failed" % len(fails))
for f in fails:
    print("  - %s" % f)
sys.exit(1 if fails else 0)
