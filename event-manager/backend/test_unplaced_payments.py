# -*- coding: utf-8 -*-
"""UNPLACED MONEY — a paid order the matcher cannot place is suggested, linked in one tap, and stays linked.

On 22 Oct 2026 Erika Cunningham paid $1,058.94 for VIP under a second GHL
contact that had a phone and no email. Reconcile demanded an email and payments
matched on email only, so the money read "paid, no ticket" for three days. Four
minutes later Sarah Brooker, also a GA holder, paid full price for VIP on her
own contact and was folded onto her badge with nobody asked anything.

The fix is the operation, not the two people: the review queue shows every
paid payment that sits on nobody's badge with the ticket holders who share its
name, phone or email; one tap links it through the normal reconcile path; and
anybody who pays full price for a higher ticket than they hold is flagged for a
confirm call automatically.

Proves, on a copy of the live database:
  1. the queue lists the unplaced $1,058.94 with badge 225 suggested by name
  2. Link places it on 225 -- no new attendee, no second badge -- through
     reconcile: VIP at the door, stored pass VIP, payment no longer critical
  3. the contact is now Erika's: a contact-only replay of the order (what the
     mirror sends) lands on 225 and changes nothing
  4. the confirm-call item appears for her without anyone writing it, and for
     Sarah once her order is re-seen (as the mirror does every 15 minutes)
  5. "their own badge" turns an unplaced payment into a new attendee
  6. a contact-only order for a contact nobody holds is still refused (400)
  7. nothing else moved

Run:  python3 /root/event/backend/test_contact_only_orders.py
"""
import json, sqlite3, sys, urllib.request, urllib.error

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

def queue(kind):
    st, q = call("GET", "/events/1/review-queue", None, ADMIN)
    return [i for i in (q or {}).get("items", []) if i.get("kind") == kind]

ERIKA, SARAH, PAY = 225, 202, 1482
ORDER, NEW_CONTACT = "6ad95876fac91c38b383f9c5", "tipIMGG9QiM0rnmAePoG"
SARAH_ORDER = "6ad95963e63c996682ac84c1"

print("UNPLACED MONEY")
pe0, at0 = snapshot()
n0 = len(at0)
if pe0[PAY][1] is not None:
    print("  info  payment %d is already placed on this copy (%s); the placement steps are skipped" % (PAY, pe0[PAY]))
else:
    items = [i for i in queue("payment_unplaced") if i.get("payment_id") == PAY]
    check(items and any(c["attendee_id"] == ERIKA and "name" in c["match"] for c in items[0].get("candidates", [])),
          "the queue lists the unplaced VIP with badge 225 suggested by name", items)

    st, r = call("POST", "/events/1/payments/%d/place" % PAY, {"attendee_id": ERIKA, "reason": "test"}, ADMIN)
    check(st == 200 and r.get("attendee_id") == ERIKA, "Link places it on badge 225", (st, r))
    pe1, at1 = snapshot()
    check(pe1[PAY][1] == ERIKA and pe1[PAY][0] != "critical", "the payment is on 225 and no longer critical", pe1[PAY])
    check(len(at1) == n0, "no attendee was created", (n0, len(at1)))

st, a = call("GET", "/attendees/%d" % ERIKA, None, ADMIN)
ea = (a or {}).get("effective_access") or {}
check((ea.get("base_ticket") or {}).get("id") == 4, "Erika's effective ticket is VIP", ea.get("effective_label"))
check(a.get("ticket_type_id") == 4, "and her stored pass says VIP too, not the June GA", a.get("ticket_type_id"))
qr = at0[ERIKA][2]
st, d = call("POST", "/events/1/authorize", {"qr_code": qr, "access_type": "VIP"}, ADMIN)
check(st == 200 and d.get("granted") is True, "her badge admits her to the VIP zone", (st, d.get("reason")))

replay = {"event_id": 1, "email": "", "contact_id": NEW_CONTACT, "order_id": ORDER, "ticket_type_id": 4,
          "is_upgrade": False, "product_id": "69b461f512895312b36276de", "quantity": 1, "amount": 1058.94,
          "purchased_at": "2026-10-22T00:27:35", "first_name": "Erika", "last_name": "D Cunningham"}
st, r = call("POST", "/identity/reconcile-attendee", replay, SVC)
check(st == 200 and r.get("attendee_id") == ERIKA and not r.get("created") and not r.get("seat_of"),
      "a contact-only replay of the order lands on 225 and changes nothing", (st, r))

st, r = call("POST", "/identity/reconcile-attendee", {
    "event_id": 1, "email": at0[SARAH][4], "order_id": SARAH_ORDER, "ticket_type_id": 4, "is_upgrade": False,
    "product_id": "69b461f512895312b36276de", "quantity": 1, "amount": 1058.94,
    "purchased_at": "2026-10-22T00:31:32"}, SVC)
check(st == 200 and r.get("attendee_id") == SARAH and not r.get("seat_of"), "Sarah's order re-seen stays on her badge", (st, r))
conf = queue("confirm_purchase")
check({i.get("attendee_id") for i in conf} >= {ERIKA, SARAH},
      "a confirm call is asked for both, written by the rule", [(i.get("attendee_id"), i.get("detail", "")[:60]) for i in conf])
st, r = call("POST", "/identity/reconcile-attendee", dict(replay), SVC)
check(sum(1 for i in queue("confirm_purchase") if i.get("attendee_id") == ERIKA) == 1, "and only once per order")

c = sqlite3.connect(DB)
c.execute("INSERT INTO payment_events (ghl_transaction_id, ghl_entity_type, ghl_entity_id, provider, status_raw, "
          "order_status_raw, amount, currency, live_mode, occurred_at, buyer_name, buyer_phone, contact_id, product_ids, "
          "product_names, event_id, status, recon_state, severity, ingest_source, first_seen_at, last_checked_at) VALUES "
          "('test-tx-place', 'order', 'test-order-place', 'paypal', 'succeeded', 'completed', 99, 'USD', 1, "
          "'2026-10-20 12:00:00', 'Placement Testperson', '+15550000123', 'testContactPlace01', "
          "'[\"68755fe707a26368c72395d6\"]', '[\"Gaia Healers Holistic Wellness Conference Exhibit Pass\"]', 1, 'paid', "
          "'critical', 2, 'mirror', '2026-10-20 12:05:00', '2026-10-20 12:05:00')")
c.commit()
tid = c.execute("SELECT id FROM payment_events WHERE ghl_transaction_id='test-tx-place'").fetchone()[0]
c.close()
item = [i for i in queue("payment_unplaced") if i.get("payment_id") == tid]
check(item and not item[0].get("candidates"), "a stranger's payment is listed with no suggestion", item)
st, r = call("POST", "/events/1/payments/%d/place" % tid, {"new_badge": True}, ADMIN)
new_id = (r or {}).get("attendee_id") if isinstance(r, dict) else None
check(st == 200 and new_id and new_id not in at0, "'their own badge' makes a new attendee and places the payment on it", (st, r))
st, r = call("POST", "/events/1/payments/%d/place" % tid, {"new_badge": True}, ADMIN)
check(st == 409, "placing it twice is refused", (st, r))

bad = dict(replay, contact_id="nobodyHasThisContact0", order_id="test-contact-only-unknown")
st, r = call("POST", "/identity/reconcile-attendee", bad, SVC)
check(st == 400, "an order for a contact nobody holds is still refused", (st, r))

pe2, at2 = snapshot()
check(at2[ERIKA][2:5] == at0[ERIKA][2:5] and at2[SARAH][2:5] == at0[SARAH][2:5], "both keep their QR, token and email")
moved_at = [i for i in at0 if i not in (ERIKA, SARAH) and at0[i][:5] != at2[i][:5]]
check(not moved_at, "no other attendee changed", moved_at[:5])
worse = [i for i in pe0 if i != PAY and pe0[i] != pe2.get(i) and pe2[i][0] == "critical"]
check(not worse, "no other payment was made critical", [(i, pe0[i], pe2[i]) for i in worse][:5])

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
