# -*- coding: utf-8 -*-
"""PAYMENT MONITORING -- every attempt recorded, and read-only about it.

What this proves, in the order it matters.

**Nothing is written back to GHL.** The sync endpoint takes what the proxy read
and stores it. The tests below feed it transactions naming a real-looking
product and check that no attendee, ticket, order or mapping moved as a result.
Monitoring that can change the thing it monitors is not monitoring.

**GHL's word survives normalisation.** `status_raw` is kept verbatim; the
normalised status beside it drives colour and filters. A status nobody has seen
before becomes "unknown" and asks for a human -- it is never rounded to the
nearest familiar bucket, because guessing that an unrecognised word means
"failed" is how a paid customer gets locked out.

**Payment state and ticket state are separate.** The rows worth surfacing are
the disagreements: money in with no attendee, a refund with a live ticket, a
ticket standing on a payment that never arrived. Each is asserted directly.

**A retried card is one buyer, not three lost sales.** Recovery resolves per
person across providers, so somebody whose Stripe charge failed and who then
paid by PayPal is not chased.

Throwaway events and example.invalid people only.
Run:  python3 /root/event/backend/test_payments.py
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

sys.path.insert(0, "/root/event/backend")
import payments as P

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

print("PAYMENT MONITORING")

# ---------------------------------------------------------------- pure rules
print("\nStatus normalisation -- GHL's vocabulary, mapped not corrected")
for raw, want in [("succeeded", "paid"), ("completed", "paid"), ("pending", "pending"),
                  ("failed", "failed"), ("declined", "declined"), ("refunded", "refunded"),
                  ("partially_refunded", "partially_refunded"), ("cancelled", "cancelled"),
                  ("SUCCEEDED", "paid"), (" pending ", "pending")]:
    check(P.normalise_status(raw) == want, "%r -> %s" % (raw, want), P.normalise_status(raw))
check(P.normalise_status("held_for_review") == "unknown",
      "an unseen status becomes unknown, not the nearest guess")
check(P.normalise_status(None) == "unknown", "a missing status is unknown")

print("\nProviders are discovered, not enumerated")
check(P.display_provider("stripe") == "Stripe", "stripe")
check(P.display_provider("paypal") == "PayPal", "paypal -- counted, not missed")
check(P.display_provider("manual") == "Manual", "manual")
check(P.display_provider("square") == "square",
      "a provider nobody has configured yet still shows its own name")

class Fake(object):
    def __init__(self, **kw):
        self.status = "paid"; self.status_raw = "succeeded"; self.event_id = 1
        self.occurred_at = datetime.utcnow(); self.amount = 99.0
        self.buyer_email = "a@example.invalid"; self.buyer_name = "A"; self.buyer_phone = None
        self.provider = "stripe"; self.product_names = []; self.contact_id = None
        self.severity = 0
        self.__dict__.update(kw)

print("\nPayment state and ticket state are separate facts")
s, sev, why = P.classify(Fake(status="paid"), None, False)
check(sev == 2 and "cannot get in" in why, "paid + no attendee is the loudest row there is", why)
s, sev, why = P.classify(Fake(status="paid"), object(), False)
check(sev == 2, "paid + attendee whose ticket is not valid for entry is critical", why)
s, sev, why = P.classify(Fake(status="paid"), object(), True)
check(sev == 0 and s == "healthy", "paid + valid ticket is silent", why)
s, sev, why = P.classify(Fake(status="refunded"), object(), True)
check(sev == 2 and "still valid" in why, "refunded + live ticket is critical", why)
s, sev, why = P.classify(Fake(status="refunded"), object(), False)
check(sev == 0, "refunded + withdrawn access is correct, not a problem", why)
s, sev, why = P.classify(Fake(status="failed"), None, False)
check(sev == 0, "a failed payment with no ticket is the expected outcome, not an alert", why)
s, sev, why = P.classify(Fake(status="failed"), object(), True)
check(sev == 1, "a ticket standing on a payment that failed wants a human", why)
s, sev, why = P.classify(Fake(status="failed"), object(), True, person_paid=True)
check(sev == 0, "unless the same buyer retried and paid -- that row is history, not a fault", why)
s, sev, why = P.classify(Fake(status="pending"), object(), True, person_paid=True)
check(sev == 0, "a pending attempt superseded by a payment that went through is quiet", why)
s, sev, why = P.classify(Fake(status="pending"), object(), True)
check(sev == 1, "a ticket standing on money that has not arrived wants a human", why)
s, sev, why = P.classify(Fake(status="pending"), None, False)
check(sev == 0, "a payment pending for an hour is normal", why)
old = Fake(status="pending", occurred_at=datetime.utcnow() - timedelta(days=9))
s, sev, why = P.classify(old, None, False)
check(sev == 1 and "9 days" in why, "a payment pending for nine days is not", why)
s, sev, why = P.classify(Fake(status="unknown", status_raw="held_for_review"), None, False)
check(sev == 1 and "held_for_review" in why,
      "an unrecognised status is surfaced with GHL's own word, never auto-resolved", why)
s, sev, why = P.classify(Fake(event_id=None, status="paid"), None, False)
check(sev == 0 and s == "not_event",
      "a payment for something that is not an event product is not this event's failure", why)

print("\nRecovery -- a retried card is one buyer, not three lost sales")
rows = P.recovery_rows([
    Fake(status="failed", provider="stripe", buyer_email="switch@example.invalid", amount=222.0),
    Fake(status="failed", provider="stripe", buyer_email="switch@example.invalid", amount=222.0),
    Fake(status="paid", provider="paypal", buyer_email="switch@example.invalid", amount=222.0),
    Fake(status="failed", provider="stripe", buyer_email="lost@example.invalid", amount=555.0),
])
by = {r["email"]: r for r in rows}
check(by["switch@example.invalid"]["recovered"] is True,
      "failed on Stripe then paid on PayPal is recovered, not chased")
check(by["switch@example.invalid"]["attempts"] == 2, "both attempts are still counted")
check(by["lost@example.invalid"]["recovered"] is False, "genuinely never paid stays unrecovered")
check(rows[0]["email"] == "lost@example.invalid",
      "unrecovered sorts first, and by money at stake")
check(by["switch@example.invalid"]["amount"] == 222.0,
      "one person's repeated attempts count the amount once, not twice")

print("\nSummary counts attempts, payments and buyers separately")
s = P.summarise([
    Fake(status="paid", buyer_email="x@example.invalid", amount=100.0, provider="stripe"),
    Fake(status="paid", buyer_email="x@example.invalid", amount=50.0, provider="paypal"),
    Fake(status="failed", buyer_email="y@example.invalid", amount=100.0),
    Fake(status="pending", buyer_email="z@example.invalid", amount=100.0),
])
check(s["attempts"] == 4, "four attempts", s)
check(s["paid"] == 2, "two successful payments", s)
check(s["unique_buyers"] == 1, "one unique buyer -- a person who paid twice is still one person", s)
check(s["paid_amount"] == 150.0, "money is summed over payments, not over buyers", s)
check(s["by_provider"] == {"Stripe": 1, "PayPal": 1}, "split by provider", s)
check(s["pending"] == 1 and s["declined_or_failed"] == 1, "incomplete split out", s)

# ------------------------------------------------------------- live endpoint
print("\nEnd to end, against a throwaway event")
for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ pay%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)
write("DELETE FROM payment_events WHERE ghl_transaction_id LIKE 'zz-pay-%'")

start = datetime.utcnow() + timedelta(days=50)
st, ev = call("POST", "/events", {"name": "ZZ pay", "start_date": start.isoformat(),
                                  "end_date": (start + timedelta(days=1)).isoformat(),
                                  "location": "Test", "timezone": "UTC"}, ADMIN)
assert st in (200, 201), (st, ev)
EV = ev["id"]
st, tt = call("POST", "/events/%d/ticket-types" % EV, {"name": "ZZ Pay GA", "code": "zz-pay-ga"}, ADMIN)
TT = tt["id"]
PROD = "zz-pay-product"
write("INSERT INTO ticket_mappings (event_id, provider, external_product_id, ticket_type_id,"
      " is_upgrade, label, is_active, entitlement_type) VALUES (?,?,?,?,0,?,1,?)",
      (EV, "ghl", PROD, TT, "ZZ pay map", "EVENT_TICKET"))

def tx(txid, status, email, provider="stripe", amount=99.0, when=None, product=PROD, live=True):
    return {"transaction": {"_id": txid, "status": status, "paymentProviderType": provider,
                            "amount": amount, "currency": "USD", "liveMode": live,
                            "entityType": "order", "entityId": "ord-" + txid,
                            "contactEmail": email, "contactName": "Zed Payer",
                            "entitySourceName": "ZZ Funnel", "entitySourceType": "funnel",
                            "entitySourceMeta": {"domain": "zz.example.invalid",
                                                 "pageUrl": "/zz"},
                            "createdAt": (when or datetime.utcnow()).isoformat() + "Z"},
            "order": {"status": "completed",
                      "items": [{"product": {"_id": product, "name": "ZZ Pay Product"}}]}}

BEFORE = sql("SELECT count(*) FROM attendees")[0][0]
MAPS_BEFORE = sql("SELECT count(*) FROM ticket_mappings")[0][0]

st, r = call("POST", "/identity/payments/sync", {"source": "mirror", "transactions": [
    tx("zz-pay-1", "succeeded", "paid-nobody@example.invalid"),
    tx("zz-pay-2", "failed", "declined@example.invalid"),
    tx("zz-pay-3", "pending", "waiting@example.invalid", provider="paypal"),
    tx("zz-pay-4", "succeeded", "other@example.invalid", product="zz-not-ours"),
]}, SVC)
check(st == 200 and r.get("recorded") == 4, "four attempts recorded", (st, r))

check(sql("SELECT count(*) FROM attendees")[0][0] == BEFORE,
      "recording payments created no attendee -- monitoring never issues a ticket")
check(sql("SELECT count(*) FROM ticket_mappings")[0][0] == MAPS_BEFORE,
      "recording payments created no mapping")

st, feed = call("GET", "/events/%d/payments" % EV, token=ADMIN)
check(st == 200 and feed["total"] == 3,
      "the feed shows this event's three attempts and not the unrelated sale", feed.get("total"))
row = [x for x in feed["items"] if x["transaction_id"] == "zz-pay-1"][0]
check(row["status"] == "paid" and row["status_raw"] == "succeeded",
      "normalised status and GHL's own word are both carried")
check(row["severity"] == 2 and row["ticket"] is None,
      "money in with nobody to admit is critical", row["reason"])
check(row["provider"] == "PayPal" or row["provider"] == "Stripe", "provider is displayed")
check(row["funnel"] == "ZZ Funnel" and row["page"] == "zz.example.invalid",
      "funnel and landing page are carried for attribution")
# GHL hands us the buyer's IP on every transaction. It is not needed to tell
# whether a payment reconciled, so it is never stored and never served.
keys = set()
for x in feed["items"]:
    keys |= set(x.keys())
check(not any("ip" in k.lower() or "address" in k.lower() for k in keys),
      "the buyer's IP address is never stored or served", sorted(keys))
check(not [r for r in sql("PRAGMA table_info(payment_events)")
           if "ip" in r[1].lower() or "address" in r[1].lower()],
      "and there is no column for it to leak into later")

st, again = call("POST", "/identity/payments/sync", {"source": "webhook", "transactions": [
    tx("zz-pay-1", "succeeded", "paid-nobody@example.invalid")]}, SVC)
st, feed2 = call("GET", "/events/%d/payments" % EV, token=ADMIN)
check(feed2["total"] == 3, "re-syncing the same transaction updates it, never duplicates it",
      feed2["total"])

print("\nThe two dimensions disagreeing is what gets surfaced")
st, att = call("GET", "/events/%d/payments/attention" % EV, token=ADMIN)
check(att["critical"] == 1, "one critical", att)
check(att["items"][0]["transaction_id"] == "zz-pay-1", "worst first")
st, sm = call("GET", "/events/%d/payments/summary" % EV, token=ADMIN)
check(sm["all_time"]["paid"] == 1 and sm["all_time"]["attempts"] == 3, "summary is event-scoped", sm)
check("PayPal" in sm["providers"], "PayPal appears in the provider list", sm["providers"])

# Give the payer a ticket the way the real path would, and the row should go quiet.
st, rec = call("POST", "/identity/reconcile-attendee", {
    "event_id": EV, "email": "paid-nobody@example.invalid", "ticket_type_id": TT,
    "product_id": PROD, "order_id": "ord-zz-pay-1", "first_name": "Zed", "last_name": "Payer"}, SVC)
check(st == 200, "reconcile issued the ticket", (st, rec))
call("POST", "/identity/payments/sync", {"source": "mirror", "transactions": [
    tx("zz-pay-1", "succeeded", "paid-nobody@example.invalid")]}, SVC)
st, att2 = call("GET", "/events/%d/payments/attention" % EV, token=ADMIN)
check(att2["critical"] == 0, "once the ticket exists the alarm clears itself", att2)
res = sql("SELECT resolved_at, resolution FROM payment_events WHERE ghl_transaction_id='zz-pay-1'")
check(res and res[0][0] is not None,
      "and how it ended is recorded -- a fixed problem, not one that quietly moved")

print("\nRecovery view, live")
st, rv = call("GET", "/events/%d/payments/recovery" % EV, token=ADMIN)
emails = {r["email"] for r in rv["items"]}
check("declined@example.invalid" in emails, "the declined payer is listed for follow-up")
check(rv["unrecovered"] >= 1 and rv["unrecovered_value"] >= 99.0,
      "with the money at stake attached", rv)

print("\nEvent isolation")
# The same product id sold for two conferences: the purchase date, not the
# product, decides whose payment this is.
st, prev = call("POST", "/events", {"name": "ZZ pay 2025", "start_date": "2025-11-07T09:00:00",
                                    "end_date": "2025-11-09T18:00:00",
                                    "location": "Test", "timezone": "UTC"}, ADMIN)
PREV = prev["id"]
st, ptt = call("POST", "/events/%d/ticket-types" % PREV, {"name": "ZZ Pay Old", "code": "zz-pay-old"}, ADMIN)
write("UPDATE ticket_mappings SET valid_from='2026-01-01' WHERE external_product_id=?", (PROD,))
write("INSERT INTO ticket_mappings (event_id, provider, external_product_id, ticket_type_id,"
      " is_upgrade, label, is_active, entitlement_type, valid_from, valid_until)"
      " VALUES (?,?,?,?,0,?,1,?,?,?)",
      (PREV, "ghl", PROD, ptt["id"], "ZZ pay old map", "EVENT_TICKET", "2025-01-01", "2025-12-31"))
call("POST", "/identity/payments/sync", {"source": "mirror", "transactions": [
    tx("zz-pay-9", "succeeded", "lastyear@example.invalid",
       when=datetime(2025, 9, 14, 10, 0))]}, SVC)
st, f26 = call("GET", "/events/%d/payments?q=lastyear" % EV, token=ADMIN)
check(f26["total"] == 0,
      "a 2025 payment is not counted against the 2026 conference, however familiar the product")
st, f25 = call("GET", "/events/%d/payments?q=lastyear" % PREV, token=ADMIN)
check(f25["total"] == 1, "it belongs to the year it was bought in", f25["total"])
call("DELETE", "/events/%d" % PREV, token=ADMIN)
write("DELETE FROM payment_events WHERE ghl_transaction_id='zz-pay-9'")
write("DELETE FROM ticket_mappings WHERE external_product_id=?", (PROD,))
write("INSERT INTO ticket_mappings (event_id, provider, external_product_id, ticket_type_id,"
      " is_upgrade, label, is_active, entitlement_type) VALUES (?,?,?,?,0,?,1,?)",
      (EV, "ghl", PROD, TT, "ZZ pay map", "EVENT_TICKET"))

st, other = call("POST", "/events", {"name": "ZZ pay other", "start_date": start.isoformat(),
                                     "end_date": (start + timedelta(days=1)).isoformat(),
                                     "location": "Test", "timezone": "UTC"}, ADMIN)
st, f2 = call("GET", "/events/%d/payments" % other["id"], token=ADMIN)
check(f2["total"] == 0, "another event sees none of these payments", f2)

print("\nFilters")
st, f = call("GET", "/events/%d/payments?status=paid" % EV, token=ADMIN)
check(f["total"] == 1, "status filter", f["total"])
st, f = call("GET", "/events/%d/payments?provider=paypal" % EV, token=ADMIN)
check(f["total"] == 1, "provider filter", f["total"])
st, f = call("GET", "/events/%d/payments?q=waiting" % EV, token=ADMIN)
check(f["total"] == 1, "search by email", f["total"])
st, f = call("GET", "/events/%d/payments?q=ord-zz-pay-2" % EV, token=ADMIN)
check(f["total"] == 1, "search by order id", f["total"])
st, f = call("GET", "/events/%d/payments?needs_attention=true" % EV, token=ADMIN)
check(all(x["severity"] > 0 for x in f["items"]), "needs-attention filter")

print("\nAuthorisation")
st, _ = call("GET", "/events/%d/payments" % EV)
check(st in (401, 403), "the feed is not readable without a token", st)
st, _ = call("POST", "/identity/payments/sync", {"transactions": []}, ADMIN)
check(st in (401, 403), "an admin JWT cannot post payment data -- only the service token can", st)

# tidy
call("DELETE", "/events/%d" % EV, token=ADMIN)
call("DELETE", "/events/%d" % other["id"], token=ADMIN)
write("DELETE FROM payment_events WHERE ghl_transaction_id LIKE 'zz-pay-%'")

print("\n%d checks failed" % len(fails))
for f in fails:
    print("  - %s" % f)
sys.exit(1 if fails else 0)
