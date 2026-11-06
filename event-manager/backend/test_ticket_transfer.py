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

print("\n== the payment stays with the ticket ==")
def pay(ref):
    return db().execute("select attendee_id,status,recon_state from payment_events where ghl_entity_id=?", (ref,)).fetchone()
def sync(ref, email, cid_):
    tx = {"_id": "tx-" + ref, "status": "succeeded", "amount": 99, "amountRefunded": 0, "currency": "USD", "liveMode": True, "entityType": "order",
          "entityId": ref, "contactId": cid_, "contactEmail": email, "contactName": "ZZ", "createdAt": "2026-11-06T10:00:00.000Z", "updatedAt": "2026-11-06T10:00:00.000Z"}
    return http("POST", "/identity/payments/sync", {"source": "mirror", "transactions": [{"transaction": tx, "order": {"status": "completed", "items": [{"productId": GA_PRODUCT, "name": "x"}], "amount": 99}}]}, SVC)
st, _ = http("POST", "/identity/payments/reclassify", {"event_id": 1}, SVC)
check(st == 200 and pay(oid) == (t0["id"], "paid", "healthy"), "a reclassify keeps it linked and healthy (the 6 Nov bug)", (st, pay(oid)))
sync(oid, A, cid); http("POST", "/identity/payments/reclassify", {"event_id": 1}, SVC)
check(pay(oid)[0] == t0["id"], "so does the mirror reading the same payment again", pay(oid))

print("\n== it stays transferred ==")
st, _ = http("POST", "/identity/reconcile-attendee", body, SVC)
check(st == 200 and not row(A) and len(row(B)) == 1 and row(B)[0]["email"] == B, "replaying the same order makes no new ticket", (st, row(A)))
b2 = buy("second", A, cid)
check(len(row(A)) == 1 and row(A)[0]["id"] != t0["id"], "a NEW order from the original buyer gets its own ticket", row(A)[:1])
st, out = http("POST", "/identity/refund-ticket", {"event_id": 1, "email": A, "order_id": oid, "transaction_id": "tx-" + oid, "amount": 99, "status": "refunded"}, SVC)
s = row(B)[0]["registration_status"]
check(st == 200 and s in ("refunded", "revoked", "cancelled"), "a refund of the order still reaches the transferred ticket", (st, out, s))
st, msg = http("POST", "/attendees/%d/transfer" % t0["id"], dict(X, email="zz.again.%s@example.invalid" % T))
check(st == 409, "a refunded ticket cannot be transferred", msg)

print("\n== several tickets on one email ==")
S_, D_ = "zz.xfer.sandra.%s@example.invalid" % T, "zz.xfer.terry.%s@example.invalid" % T
own_o, own_c, own_b = buy("sandra", S_)
give_o, give_c, give_b = buy("terry", D_)
own, give = row(S_)[0], row(D_)[0]
before_n = db().execute("select count(*) from attendees").fetchone()[0]
before_m = db().execute("select count(*),sum(amount) from payment_events").fetchone()
st, out = http("POST", "/attendees/%d/transfer" % give["id"], {"first_name": "ZZ", "last_name": "sandra", "email": S_, "reason": "Terry gave it to Sandra"})
check(st == 200, "a transfer to someone who already holds a ticket goes through", out)
both = {r["id"]: r for r in row(S_)}
check(set(both) == {own["id"], give["id"]} and not row(D_), "both tickets now sit on one email, nothing merged", list(both))
check(both[own["id"]]["qr_code"] == own["qr_code"] and both[give["id"]]["qr_code"] == give["qr_code"] and own["qr_code"] != give["qr_code"], "each keeps its own id and QR code")
check(json.loads(both[own["id"]]["custom_data"]).get("transfers") is None, "their own ticket is untouched")
tr2 = json.loads(both[give["id"]]["custom_data"])["transfers"][-1]
check(tr2["purchaser"]["email"] == D_ and tr2["payment_ids"] and tr2["holder_other_tickets"] == [own["id"]], "purchaser, payment and the holder's other ticket are recorded", tr2)
http("POST", "/identity/payments/reclassify", {"event_id": 1}, SVC)
check(pay(own_o)[:2] == (own["id"], "paid") and pay(give_o)[:2] == (give["id"], "paid"), "each payment stays on the ticket it bought", (pay(own_o), pay(give_o)))
check(pay(own_o)[2] == "healthy" and pay(give_o)[2] == "healthy", "and neither reads as a problem", (pay(own_o), pay(give_o)))
http("POST", "/identity/reconcile-attendee", own_b, SVC); http("POST", "/identity/reconcile-attendee", give_b, SVC)
check(db().execute("select count(*) from attendees").fetchone()[0] == before_n, "replaying either order makes no new ticket")
check(db().execute("select count(*),sum(amount) from payment_events").fetchone() == before_m, "a transfer adds no sale and no revenue")
r1 = http("POST", "/events/1/authorize", {"qr_code": own["qr_code"], "access_type": "EVENT_ENTRY"})[1]
r2 = http("POST", "/events/1/authorize", {"qr_code": give["qr_code"], "access_type": "EVENT_ENTRY"})[1]
card = r2.get("door") or {}
check([x["id"] for x in card.get("same_email_tickets", [])] == [own["id"]] and "Transferred" in card.get("transfer_note", ""), "the door card shows the other ticket and the transfer", card.get("same_email_tickets"))
r3 = http("POST", "/events/1/authorize", {"qr_code": give["qr_code"], "access_type": "EVENT_ENTRY"})[1]
check(r1.get("checked_in_now") and r2.get("checked_in_now"), "each QR admits its own person", (r1, r2))
check(not r3.get("checked_in_now"), "and each admits only once", r3)
st, ident = http("POST", "/identity/ticket", {"email": S_, "email_verified": True, "event_id": 1}, SVC)
check(st == 200 and "duplicate_email_in_event" not in json.dumps(ident) and (ident or {}).get("ok") is not False, "the app still finds their ticket", ident)
st, csvb = 0, ""
req = urllib.request.Request(BASE + "/events/1/attendees/export", headers={"Authorization": "Bearer " + ADMIN})
with urllib.request.urlopen(req, timeout=60) as r: csvb = r.read().decode()
line = next((l for l in csvb.splitlines() if give["qr_code"] in l), "")
check("purchased_by" in csvb.splitlines()[0] and D_ in line and ",yes," in line, "the export names the purchaser beside the holder", line[-200:])
new_o, _, _ = buy("sandra2", S_, own_c)
n = {r["id"] for r in row(S_)}
check(give["id"] in n and own["id"] in n, "a later purchase never lands on the transferred ticket's payment", n)

print("\n%s" % ("ALL PASSED" if not fails else "%d FAILED" % fails))
sys.exit(1 if fails else 0)
