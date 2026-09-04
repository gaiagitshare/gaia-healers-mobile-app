# -*- coding: utf-8 -*-
"""INVOICE RECONCILIATION — the channel that hid five paying customers.

Tickets are not only sold as GHL orders. Some are invoiced, and until today the
reconciler read orders only, so an invoiced ticket produced no attendee, no
badge and no QR. These checks prove the invoice path now behaves exactly like
the order path, and — just as importantly — that it refuses everything it
should refuse.

Throwaway event, .invalid addresses. Nothing real is touched.
"""
import json, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime, timedelta
env = {}
for line in open("/root/event/backend/.env"):
    t = line.strip()
    if "=" in t and not t.startswith("#"):
        k, v = t.split("=", 1); env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
SVC = env["IDENTITY_SERVICE_TOKEN"]
BASE, DB = "http://127.0.0.1:8002", "/root/event/backend/event.db"
fails = []
def check(ok, label, detail=""):
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", label, "" if ok else "   %s" % (detail,)))
    if not ok: fails.append(label)
def call(m, p, b=None, tok=None):
    d = json.dumps(b).encode() if b is not None else None
    r = urllib.request.Request(BASE + p, data=d, method=m)
    r.add_header("Content-Type", "application/json")
    if tok: r.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(r) as x: return x.status, json.loads(x.read() or "null")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or "null")
        except Exception: return e.code, None
def sql(q, a=()):
    c = sqlite3.connect(DB)
    try: return c.execute(q, a).fetchall()
    finally: c.close()

print("INVOICE RECONCILIATION")
for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ inv%'"):
    call("DELETE", "/events/%d" % eid, tok=ADMIN)
st = datetime.utcnow() + timedelta(days=25)
_s, ev = call("POST", "/events", {"name": "ZZ inv test", "start_date": st.isoformat(),
    "end_date": (st + timedelta(days=2)).isoformat(), "location": "T", "timezone": "UTC"}, ADMIN)
EV = ev["id"]
_s, base = call("POST", "/events/%d/ticket-types" % EV, {"code": "ZZ-GA", "name": "ZZ GA", "sort_order": 2}, ADMIN)
_s, up = call("POST", "/events/%d/ticket-types" % EV, {"code": "ZZ-VIP", "name": "ZZ VIP", "is_vip": True, "sort_order": 1}, ADMIN)
BASE_TT, UP_TT = base["id"], up["id"]
PID, UPID, OTHER = "zz-prod-ticket", "zz-prod-upgrade", "zz-prod-sponsorship"
call("POST", "/events/%d/ticket-mappings" % EV, {"external_product_id": PID, "ticket_type_id": BASE_TT,
     "entitlement_type": "EVENT_TICKET", "is_active": True, "label": "ZZ ticket"}, ADMIN)
call("POST", "/events/%d/ticket-mappings" % EV, {"external_product_id": UPID, "ticket_type_id": UP_TT,
     "is_upgrade": True, "entitlement_type": "EVENT_UPGRADE", "is_active": True, "label": "ZZ upgrade"}, ADMIN)

E = lambda n: "inv-%s-test@example.invalid" % n
def inv(email, invoice_id, product, amount, status="paid", tx="tx-"+"x", qty=1, first="Ivy", last="Invoice"):
    return call("POST", "/identity/reconcile-invoice", {"event_id": EV, "email": email,
        "invoice_id": invoice_id, "transaction_id": tx, "contact_id": "c-" + email,
        "product_id": product, "amount": amount, "quantity": qty, "status": status,
        "first_name": first, "last_name": last}, SVC)

# 1 paid mapped invoice -> attendee, full lifecycle
st1, d1 = inv(E("a"), "inv-a-1", PID, 99)
check(st1 == 200 and d1.get("created") is True and d1.get("qr_code") and d1.get("public_token"),
      "a paid, mapped invoice creates an attendee with a QR and a permanent card", (st1, d1))
A = d1["attendee_id"]; QR = d1["qr_code"]; TOK = d1["public_token"]
row = sql("SELECT registration_source FROM attendees WHERE id=?", (A,))[0][0]
check(row == "ghl_invoice", "and it is recorded as arriving by invoice, not by order", row)
cd = json.loads(sql("SELECT custom_data FROM attendees WHERE id=?", (A,))[0][0])
ent = (cd.get("entitlements") or [])[0]
check(ent.get("invoice_id") == "inv-a-1" and not ent.get("order_id"),
      "the ledger records an invoice id and invents no order id", ent)

# 2 idempotent replay — the invoice and its transaction are one payment
st2, d2 = inv(E("a"), "inv-a-1", PID, 99)
check(d2.get("created") is False and d2.get("already") is True and d2.get("attendee_id") == A,
      "replaying the same invoice does not double-count or duplicate", d2)
check(len(json.loads(sql("SELECT custom_data FROM attendees WHERE id=?", (A,))[0][0]).get("entitlements") or []) == 1,
      "still exactly one ledger entry")

# 3 upgrade on the same person
st3, d3 = inv(E("a"), "inv-a-2", UPID, 200)
check(d3.get("created") is False and d3.get("attendee_id") == A and d3.get("upgraded") is True,
      "a mapped upgrade invoice lifts the same attendee", d3)
after = sql("SELECT qr_code, public_token, ticket_type_id FROM attendees WHERE id=?", (A,))[0]
check(after[0] == QR and after[1] == TOK, "their ticket QR and permanent card are untouched by the upgrade")
check(after[2] == UP_TT, "and the tier moved up")

# 4 refusals
st4, d4 = inv(E("b"), "inv-b-1", PID, 99, status="draft")
check(d4.get("ok") is False and d4.get("reason") == "invoice_not_paid", "an unpaid invoice creates nothing", d4)
st5, d5 = inv(E("c"), "inv-c-1", OTHER, 5000)
check(d5.get("ok") is False and d5.get("reason") == "product_not_mapped_to_this_event",
      "an unmapped product creates nothing, however it is described", d5)
st6, d6 = inv(E("d"), "inv-d-1", None, 2500)
check(d6.get("ok") is False, "an invoice with no product creates nothing", d6)
check(sql("SELECT COUNT(*) FROM attendees WHERE event_id=? AND email LIKE 'inv-%'", (EV,))[0][0] == 1,
      "after every refusal, still exactly one attendee exists")

# 5 an event-sounding sponsorship must never become a ticket
st7, d7 = inv(E("e"), "inv-e-1", "zz-prod-elevate-sponsorship", 6250)
check(d7.get("ok") is False, "a sponsorship with 'Elevate' in its name is still refused", d7)

# 6 unmapped sale is surfaced for review, not converted
st8, d8 = call("POST", "/identity/report-unmapped-sale", {"event_id": EV, "reference": "ord-zz-1",
    "source": "ghl_order", "product_id": "zz-prod-daypass", "product_name": "ZZ Friday Pass",
    "buyer_email": E("f"), "buyer_name": "Fay Friday", "amount": 97, "paid_at": "2026-09-04"}, SVC)
check(st8 == 200 and d8.get("recorded") is True, "an unmapped paid product is recorded for review", d8)
st9, d9 = call("GET", "/events/%d/unmapped-sales" % EV, tok=ADMIN)
# Assert THIS row is present, not that it is the only one: the reconciler now
# files genuine unmapped sales of its own, so the panel is shared.
_mine = [i for i in (d9.get("items") or []) if i.get("reference") == "ord-zz-1"]
check(st9 == 200 and len(_mine) == 1 and _mine[0]["product_name"] == "ZZ Friday Pass"
      and _mine[0]["amount"] == 97,
      "and it appears in the review list with enough detail to act on", d9.get("pending"))
check(sql("SELECT COUNT(*) FROM attendees WHERE event_id=? AND lower(email)=?", (EV, E("f")))[0][0] == 0,
      "and NO attendee was created from it")
_s, dd = call("POST", "/identity/report-unmapped-sale", {"event_id": EV, "reference": "ord-zz-1",
    "product_id": "zz-prod-daypass"}, SVC)
check(dd.get("already") is True, "reporting it twice does not pile up duplicates")

# 7 a returning person keeps one permanent card across events
st10, ev2 = call("POST", "/events", {"name": "ZZ inv test two",
    "start_date": (st + timedelta(days=60)).isoformat(), "end_date": (st + timedelta(days=61)).isoformat(),
    "location": "T", "timezone": "UTC"}, ADMIN)
EV2 = ev2["id"]
_s, b2 = call("POST", "/events/%d/ticket-types" % EV2, {"code": "ZZ-GA2", "name": "ZZ GA2"}, ADMIN)
call("POST", "/events/%d/ticket-mappings" % EV2, {"external_product_id": PID, "ticket_type_id": b2["id"],
     "entitlement_type": "EVENT_TICKET", "is_active": True, "label": "ZZ ticket 2"}, ADMIN)
st11, d11 = call("POST", "/identity/reconcile-invoice", {"event_id": EV2, "email": E("a"),
    "invoice_id": "inv-a-3", "product_id": PID, "amount": 99, "status": "paid",
    "first_name": "Ivy", "last_name": "Invoice"}, SVC)
check(d11.get("created") is True and d11.get("public_token") == TOK,
      "at a second event they keep the SAME permanent card token", d11.get("public_token"))
check(d11.get("qr_code") != QR, "but get a distinct ticket QR")
check(sql("SELECT COUNT(*) FROM member_cards WHERE public_token=?", (TOK,))[0][0] == 1,
      "exactly one permanent card exists for them")

# clean up
toks = [r[0] for r in sql("SELECT DISTINCT public_token FROM attendees WHERE email LIKE 'inv-%-test@example.invalid'") if r[0]]
for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ inv%'"):
    call("DELETE", "/events/%d" % eid, tok=ADMIN)
c = sqlite3.connect(DB)
for t in toks:
    c.execute("DELETE FROM member_card_events WHERE card_id IN (SELECT id FROM member_cards WHERE public_token=?)", (t,))
    c.execute("DELETE FROM member_cards WHERE public_token=?", (t,))
c.execute("DELETE FROM unmapped_sales WHERE reference='ord-zz-1'")
c.commit(); c.close()
print()
if fails:
    print("%d CHECK(S) FAILED" % len(fails)); sys.exit(1)
print("ALL CHECKS PASSED - invoiced tickets behave like ordered tickets, and refusals hold")
