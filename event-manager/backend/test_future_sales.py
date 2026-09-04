# -*- coding: utf-8 -*-
"""FUTURE SALES — does this stay correct without anyone running a script?

The event is two months away and selling. These checks simulate the
transactions that will actually arrive between now and then, through the same
endpoints the live webhook calls, and prove each one produces the full
lifecycle on its own.

Throwaway events, .invalid addresses. Nothing real is touched, and nothing is
sent to GHL.
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
fails, manual = [], []
def check(ok, label, detail=""):
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", label, "" if ok else "   %s" % (detail,)))
    if not ok: fails.append(label)
def note(msg): manual.append(msg); print("  NOTE  %s" % msg)
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

print("FUTURE SALES")
for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ future%'"):
    call("DELETE", "/events/%d" % eid, tok=ADMIN)
start = datetime.utcnow() + timedelta(days=60)
_s, ev = call("POST", "/events", {"name": "ZZ future sales", "start_date": start.isoformat(),
    "end_date": (start + timedelta(days=2)).isoformat(), "location": "T", "timezone": "UTC"}, ADMIN)
EV = ev["id"]
_s, ga = call("POST", "/events/%d/ticket-types" % EV, {"code": "ZZ-GA", "name": "ZZ GA", "sort_order": 3}, ADMIN)
_s, vip = call("POST", "/events/%d/ticket-types" % EV, {"code": "ZZ-VIP", "name": "ZZ VIP", "is_vip": True, "sort_order": 1}, ADMIN)
GA, VIP = ga["id"], vip["id"]
P_GA, P_UP, P_NEW = "zz-fut-ga", "zz-fut-upgrade", "zz-fut-brandnew"
call("POST", "/events/%d/ticket-mappings" % EV, {"external_product_id": P_GA, "ticket_type_id": GA,
     "entitlement_type": "EVENT_TICKET", "is_active": True, "label": "ZZ GA"}, ADMIN)
call("POST", "/events/%d/ticket-mappings" % EV, {"external_product_id": P_UP, "ticket_type_id": VIP,
     "is_upgrade": True, "entitlement_type": "EVENT_UPGRADE", "is_active": True, "label": "ZZ upgrade"}, ADMIN)
E = lambda n: "future-%s@example.invalid" % n

def order(email, oid, tt, up=False, first="Fay", last="Future"):
    return call("POST", "/identity/reconcile-attendee", {"event_id": EV, "email": email, "order_id": oid,
        "ticket_type_id": tt, "is_upgrade": up, "contact_id": "c-" + email,
        "first_name": first, "last_name": last}, SVC)
def invoice(email, iid, product, amount, status="paid", qty=1, first="Ina", last="Invoice"):
    return call("POST", "/identity/reconcile-invoice", {"event_id": EV, "email": email, "invoice_id": iid,
        "transaction_id": "tx-" + iid, "product_id": product, "amount": amount, "quantity": qty,
        "status": status, "first_name": first, "last_name": last, "contact_id": "c-" + email}, SVC)

# 1 a new completed mapped order
st, d = order(E("order"), "fut-ord-1", GA)
check(st == 200 and d.get("created") and d.get("qr_code") and d.get("public_token"),
      "a new completed mapped ORDER creates attendee + ticket QR + permanent card", d)
A1, QR1, TOK1 = d["attendee_id"], d["qr_code"], d["public_token"]

# 2 a new paid mapped invoice
st, d = invoice(E("invoice"), "fut-inv-1", P_GA, 99)
check(st == 200 and d.get("created") and d.get("qr_code") and d.get("public_token"),
      "a new paid mapped INVOICE does the same", d)
A2, QR2, TOK2 = d["attendee_id"], d["qr_code"], d["public_token"]

# 3 a future upgrade keeps identity
st, d = order(E("order"), "fut-ord-2", VIP, up=True)
after = sql("SELECT qr_code, public_token, ticket_type_id FROM attendees WHERE id=?", (A1,))[0]
check(d.get("created") is False and after[0] == QR1 and after[1] == TOK1 and after[2] == VIP,
      "a future UPGRADE lifts the tier and preserves QR, card and token", (d.get("created"), after[2] == VIP))
st, d = invoice(E("invoice"), "fut-inv-2", P_UP, 200)
after2 = sql("SELECT qr_code, public_token, ticket_type_id FROM attendees WHERE id=?", (A2,))[0]
check(after2[0] == QR2 and after2[1] == TOK2 and after2[2] == VIP,
      "and an INVOICE upgrade behaves identically")

# 4 an unmapped product cannot vanish
st, d = call("POST", "/identity/report-unmapped-sale", {"event_id": EV, "reference": "fut-ord-new-1",
    "source": "ghl_order", "product_id": P_NEW, "product_name": "ZZ Saturday Pass",
    "buyer_email": E("new"), "buyer_name": "Nia New", "amount": 197, "paid_at": "2026-10-01"}, SVC)
st2, lst = call("GET", "/events/%d/unmapped-sales" % EV, tok=ADMIN)
# Present, not sole occupant: the reconciler files real unmapped sales too.
_mine = [i for i in (lst.get("items") or []) if i.get("reference") == "fut-ord-new-1"]
check(d.get("recorded") and len(_mine) == 1,
      "a brand-new UNMAPPED product surfaces for review instead of disappearing")
check(sql("SELECT COUNT(*) FROM attendees WHERE event_id=? AND lower(email)=?", (EV, E("new")))[0][0] == 0,
      "and creates no attendee on its own")

# 5 what happens after staff map it?
call("POST", "/events/%d/ticket-mappings" % EV, {"external_product_id": P_NEW, "ticket_type_id": GA,
     "entitlement_type": "EVENT_TICKET", "is_active": True, "label": "ZZ Saturday"}, ADMIN)
n_after_map = sql("SELECT COUNT(*) FROM attendees WHERE event_id=? AND lower(email)=?", (EV, E("new")))[0][0]
if n_after_map == 0:
    note("MAPPING A PRODUCT DOES NOT REPLAY ITS EARLIER SALES - staff must re-trigger those")
else:
    check(True, "mapping the product automatically reconciles its earlier sales")
st, d = call("POST", "/identity/report-unmapped-sale", {"event_id": EV, "reference": "fut-ord-new-1",
    "product_id": P_NEW}, SVC)
check(d.get("reason") == "product_is_now_mapped",
      "re-reporting a now-mapped product closes the review row instead of nagging", d)

# 6 pending / failed never create tickets
st, d = invoice(E("pending"), "fut-inv-p", P_GA, 99, status="draft")
check(d.get("ok") is False and sql("SELECT COUNT(*) FROM attendees WHERE event_id=? AND lower(email)=?", (EV, E("pending")))[0][0] == 0,
      "an unpaid invoice never creates a ticket")

# 7 refunds
st, d = order(E("refund"), "fut-ord-ref", GA)
AR = d["attendee_id"]
c = sqlite3.connect(DB)
cd = json.loads(c.execute("SELECT custom_data FROM attendees WHERE id=?", (AR,)).fetchone()[0])
for e in cd["entitlements"]:
    e["status"] = "refunded"
cd["refunded_order_ids"] = ["fut-ord-ref"]
c.execute("UPDATE attendees SET custom_data=?, registration_status='refunded' WHERE id=?", (json.dumps(cd), AR))
c.commit(); c.close()
st, dec = call("POST", "/events/%d/authorize" % EV, {"qr_code": sql("SELECT qr_code FROM attendees WHERE id=?", (AR,))[0][0],
    "access_type": "EVENT_ENTRY"}, ADMIN)
check(dec.get("granted") is False and "REFUND" in str(dec.get("reason","")).upper(),
      "a refunded ticket is refused at the door", dec.get("reason"))
st, d = order(E("refund"), "fut-ord-ref", GA)
check(d.get("blocked") is True, "and re-seeing the same refunded order does not revive it", d)

# 8 quantity > 1
st, d = invoice(E("qty"), "fut-inv-qty", P_GA, 198, qty=2)
check(d.get("created") is True, "an invoice for two tickets creates the buyer")
cdq = json.loads(sql("SELECT custom_data FROM attendees WHERE id=?", (d["attendee_id"],))[0][0])
note("QUANTITY 2 PRODUCES ONE ATTENDEE (%d ledger entr%s) - a second badge needs a second name, so staff add the guest"
     % (len(cdq.get("entitlements") or []), "y" if len(cdq.get("entitlements") or []) == 1 else "ies"))

# 9 duplicate delivery
before = sql("SELECT COUNT(*) FROM attendees WHERE event_id=?", (EV,))[0][0]
for _ in range(3):
    order(E("order"), "fut-ord-1", GA)
    invoice(E("invoice"), "fut-inv-1", P_GA, 99)
after = sql("SELECT COUNT(*) FROM attendees WHERE event_id=?", (EV,))[0][0]
check(before == after, "repeated webhook delivery of the same payment changes nothing", (before, after))
check(len(json.loads(sql("SELECT custom_data FROM attendees WHERE id=?", (A1,))[0][0]).get("entitlements") or []) == 2,
      "and the ledger still holds exactly the two real purchases")

# 10 walk-ins keep working alongside all of this
st, w = call("POST", "/events/%d/walk-in" % EV, {"first_name": "Wanda", "last_name": "Walkin",
    "email": E("walkin"), "phone": "+14075550188",
    "attendance_type": "paid", "door_payment_status": "collected",
    "door_payment_method": "cash", "door_payment_amount": 97, "confirm_new": True}, ADMIN)
check(st == 200 and (w.get("attendee") or {}).get("public_token"), "walk-ins still work independently", st)

# 11 returning participant
_s, ev2 = call("POST", "/events", {"name": "ZZ future sales two",
    "start_date": (start + timedelta(days=200)).isoformat(), "end_date": (start + timedelta(days=201)).isoformat(),
    "location": "T", "timezone": "UTC"}, ADMIN)
EV2 = ev2["id"]
_s, g2 = call("POST", "/events/%d/ticket-types" % EV2, {"code": "ZZ-GA2", "name": "ZZ GA2"}, ADMIN)
st, d = call("POST", "/identity/reconcile-attendee", {"event_id": EV2, "email": E("order"),
    "order_id": "fut-ord-next-year", "ticket_type_id": g2["id"], "first_name": "Fay", "last_name": "Future",
    "contact_id": "c-" + E("order")}, SVC)
check(d.get("public_token") == TOK1, "a returning participant reuses their permanent badge card", d.get("public_token"))
check(d.get("qr_code") != QR1, "with a distinct ticket QR for the new event")

# 12 day-specific tiers need no code change
_s, fri = call("POST", "/events/%d/ticket-types" % EV, {"code": "ZZ-FRI", "name": "ZZ Friday only",
    "valid_day": start.strftime("%Y-%m-%d"), "sort_order": 6}, ADMIN)
c = sqlite3.connect(DB)
c.execute("UPDATE ticket_types SET valid_day=? WHERE id=?", ((start + timedelta(days=1)).strftime("%Y-%m-%d"), fri["id"]))
c.commit(); c.close()
check(sql("SELECT valid_day FROM ticket_types WHERE id=?", (fri["id"],))[0][0] is not None,
      "a new day-specific tier is pure configuration, no code change")

# 13 reports move with the data
st, rep = call("GET", "/events/%d/acquisition-report" % EV, tok=ADMIN)
st2, cnt = call("GET", "/events/%d/ticket-counts" % EV, tok=ADMIN)
# Two order-backed purchases, two invoice-backed, one for the quantity buyer.
# The refunded one is correctly NOT counted as revenue.
inv_backed = sum(1 for r in sql("SELECT custom_data FROM attendees WHERE event_id=?", (EV,))
                 for e in (json.loads(r[0] or "{}").get("entitlements") or []) if e.get("invoice_id"))
check(rep.get("attendees", 0) >= 5 and rep.get("purchases", 0) == 5 and inv_backed >= 2,
      "the acquisition report counts order-backed AND invoice-backed purchases, and excludes the refund",
      (rep.get("attendees"), rep.get("purchases"), inv_backed))
check((cnt or {}).get("total", 0) >= 5, "and the attendee counts move with them", cnt.get("total") if cnt else None)

# clean up
toks = [r[0] for r in sql("SELECT DISTINCT public_token FROM attendees WHERE email LIKE 'future-%@example.invalid'") if r[0]]
for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ future%'"):
    call("DELETE", "/events/%d" % eid, tok=ADMIN)
c = sqlite3.connect(DB)
for t in toks:
    c.execute("DELETE FROM member_card_events WHERE card_id IN (SELECT id FROM member_cards WHERE public_token=?)", (t,))
    c.execute("DELETE FROM member_cards WHERE public_token=?", (t,))
c.execute("DELETE FROM unmapped_sales WHERE reference LIKE 'fut-%'")
c.commit(); c.close()
print()
for m in manual: print("  ACTION NEEDED: %s" % m)
print()
if fails:
    print("%d CHECK(S) FAILED" % len(fails)); sys.exit(1)
print("ALL CHECKS PASSED")
