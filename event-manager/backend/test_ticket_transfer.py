# -*- coding: utf-8 -*-
"""Transferring a paid ticket to somebody else (6 Nov 2026), on a testbed copy.

The ticket moves; the purchase does not. The payment stays linked and names the
buyer, the same order replayed never makes a second ticket, a new order from the
original buyer does, a refund still finds the ticket, and everyone comparing a
purchase with an attendee sees why they differ.
"""
import json, os, sqlite3, sys, time, urllib.error, urllib.request
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
SVC = env["IDENTITY_SERVICE_TOKEN"]
fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else "   " + str(extra)[:400]))
    if not cond: fails += 1
def http(method, path, body=None, token=ADMIN):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

GA_PRODUCT, GA = "69ffab66233a0d773296e989", 8
T = str(int(time.time()))
def buy(key, email, cid=None):
    oid, cid = "zz-xfer-%s-%s" % (key, T), cid or "c-zz-%s-%s" % (key, T)
    when = (datetime.now(timezone.utc) - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    body = {"event_id": 1, "email": email, "ticket_type_id": GA, "first_name": "ZZ", "last_name": key, "contact_id": cid, "order_id": oid,
            "is_upgrade": False, "product_id": GA_PRODUCT, "quantity": 1, "amount": 99, "purchased_at": when[:19]}
    st, out = http("POST", "/identity/reconcile-attendee", body, SVC); assert st == 200, (st, out)
    tx = {"_id": "tx-" + oid, "status": "succeeded", "amount": 99, "amountRefunded": 0, "currency": "USD", "liveMode": True, "entityType": "order",
          "entityId": oid, "contactId": cid, "contactEmail": email, "contactName": "ZZ " + key, "createdAt": when, "updatedAt": when}
    st, out = http("POST", "/identity/payments/sync", {"source": "webhook", "transactions": [{"transaction": tx,
                   "order": {"status": "completed", "items": [{"productId": GA_PRODUCT, "name": "x"}], "amount": 99}}]}, SVC); assert st == 200, (st, out)
    return oid, cid, body
db = lambda: sqlite3.connect(DB)
def row(email):
    c = db(); c.row_factory = sqlite3.Row
    return [dict(r) for r in c.execute("select * from attendees where event_id=1 and lower(email)=?", (email,))]

A, B = "zz.xfer.buyer.%s@example.invalid" % T, "zz.xfer.new.%s@example.invalid" % T
oid, cid, body = buy("buyer", A)
t0 = row(A)[0]
X = {"first_name": "ZZ New", "last_name": "Holder", "email": B, "reason": "Asked by the buyer"}

print("\n== refused ==")
st, _ = http("POST", "/attendees/%d/transfer" % t0["id"], dict(X, reason=""))
check(st == 422, "a reason is required")
st, _ = http("POST", "/attendees/%d/transfer" % t0["id"], dict(X, email="not-an-email"))
check(st == 422, "a valid email is required")
other, _, _ = buy("other", "zz.xfer.other.%s@example.invalid" % T)
st, msg = http("POST", "/attendees/%d/transfer" % t0["id"], dict(X, email="zz.xfer.other.%s@example.invalid" % T))
check(st == 409 and "already holds ticket" in str(msg), "someone who already holds a ticket is refused, and named", msg)

print("\n== the transfer ==")
st, out = http("POST", "/attendees/%d/transfer" % t0["id"], X)
check(st == 200, "it goes through", out)
t1 = row(B)[0] if row(B) else {}
check(t1.get("id") == t0["id"] and t1["qr_code"] == t0["qr_code"] and t1["public_token"] == t0["public_token"] and t1["ticket_type_id"] == GA,
      "same ticket, QR, link and pass", t1)
check(t1["first_name"] == "ZZ New" and not row(A), "the new holder has it; the old email holds nothing")
check(t1["acq_order_id"] == t0["acq_order_id"] and t1["acq_contact_id"] == t0["acq_contact_id"], "the purchase facts are untouched")
p = db().execute("select attendee_id,buyer_email,status from payment_events where ghl_entity_id=?", (oid,)).fetchone()
check(p == (t0["id"], A, "paid"), "the payment stays linked and still names the buyer", p)
cd = json.loads(t1["custom_data"])
tr = cd["transfers"][-1]
check(cd.get("transferred") is True and tr["from"]["email"] == A and tr["to"]["email"] == B and oid in tr["order_ids"], "flagged, with who, when, why and which orders", tr)
check(any(e["action"] == "ticket_transferred" for e in cd["lifecycle"]), "and it is in the ticket's history")
check("contact_id" not in cd, "the buyer's GHL contact no longer identifies the holder")
st, pay = http("GET", "/events/1/payments?q=" + A)
note = [x["transfer_note"] for x in pay["items"] if x["order_id"] == oid]
check(note and "Transferred" in note[0] and A in note[0] and B in note[0], "the Payments screen explains the mismatch", note)

print("\n== it stays transferred ==")
st, _ = http("POST", "/identity/reconcile-attendee", body, SVC)
check(st == 200 and not row(A) and len(row(B)) == 1 and row(B)[0]["email"] == B, "replaying the same order makes no new ticket", (st, row(A)))
b2 = buy("second", A, cid)
check(len(row(A)) == 1 and row(A)[0]["id"] != t0["id"], "a NEW order from the original buyer gets its own ticket", row(A)[:1])
st, _ = http("POST", "/attendees/%d/transfer" % t0["id"], dict(X, email=A))
check(st == 409, "and the ticket cannot move back onto a held address")
st, out = http("POST", "/identity/refund-ticket", {"event_id": 1, "email": A, "order_id": oid, "transaction_id": "tx-" + oid, "amount": 99, "status": "refunded"}, SVC)
s = row(B)[0]["registration_status"]
check(st == 200 and s in ("refunded", "revoked", "cancelled"), "a refund of the order still reaches the transferred ticket", (st, out, s))
st, msg = http("POST", "/attendees/%d/transfer" % t0["id"], dict(X, email="zz.again.%s@example.invalid" % T))
check(st == 409, "a refunded ticket cannot be transferred", msg)

print("\n%s" % ("ALL PASSED" if not fails else "%d FAILED" % fails))
sys.exit(1 if fails else 0)
