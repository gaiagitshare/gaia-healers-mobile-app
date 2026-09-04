# -*- coding: utf-8 -*-
"""THE DOOR, END TO END.

Registration and payment are different questions, and this proves Gaia keeps
them apart:

  * four kinds of person arrive at the desk and each is recorded for what they
    actually are — being a walk-in never implies anyone paid
  * money taken at our own till is Gaia's record, reported on its own, and
    never added to GHL revenue or written into the entitlement ledger
  * a genuine GHL order arriving afterwards reconciles onto the same person
    without touching their permanent identity, and WITHOUT rewriting how they
    originally arrived
  * cash taken at the door is never quietly written off because an order turned
    up later — it is flagged for a human

Throwaway events, .invalid addresses. Nothing real is touched.
Run:  python3 /root/event/backend/test_door_lifecycle.py
"""
import json, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime, timedelta

env = {}
for line in open("/root/event/backend/.env"):
    t = line.strip()
    if "=" in t and not t.startswith("#"):
        k, v = t.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
SVC = env["IDENTITY_SERVICE_TOKEN"]
BASE, DB = "http://127.0.0.1:8002", "/root/event/backend/event.db"

fails = []
def check(ok, label, detail=""):
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", label, "" if ok else "   %s" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, token=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            p = r.read()
            return r.status, (p if raw else json.loads(p or "null"))
    except urllib.error.HTTPError as e:
        p = e.read()
        try:
            return e.code, (p if raw else json.loads(p or "null"))
        except Exception:
            return e.code, p

def sql(q, a=()):
    c = sqlite3.connect(DB)
    try:
        return c.execute(q, a).fetchall()
    finally:
        c.close()

print("THE DOOR, END TO END")
for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ door-life%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)

def make_event(label, days):
    st = datetime.utcnow() + timedelta(days=days)
    _s, ev = call("POST", "/events", {"name": "ZZ door-life %s" % label, "start_date": st.isoformat(),
                                      "end_date": (st + timedelta(days=1)).isoformat(),
                                      "location": "T", "timezone": "UTC"}, ADMIN)
    return ev["id"]

EV1, EV2 = make_event("one", 12), make_event("two", 40)
_s, tt = call("POST", "/events/%d/ticket-types" % EV1, {"code": "ZZ-GA", "name": "ZZ GA"}, ADMIN)
TT = tt["id"]

E = {k: "door-%s-test@example.invalid" % k for k in ("payer", "unfound", "comp", "crew")}

def walk_in(ev, email, first, extra):
    st, d = call("POST", "/events/%d/walk-in" % ev,
                 dict({"first_name": first, "last_name": "Doortest", "email": email,
                       "phone": "+1407555%04d" % (abs(hash(email)) % 10000)}, **extra), ADMIN)
    return st, d

# ── 1. four kinds of person, four records ─────────────────────────────────
st, payer = walk_in(EV1, E["payer"], "Pia", {"attendance_type": "paid", "door_payment_status": "collected",
                                             "door_payment_method": "cash", "door_payment_amount": 99,
                                             "door_payment_reference": "TILL-0042", "ticket_type_id": TT})
A_PAY = (payer.get("attendee") or {})
check(st == 200 and A_PAY.get("registration_source") == "walk_in"
      and A_PAY.get("attendance_type") == "paid"
      and A_PAY.get("door_payment_status") == "collected"
      and A_PAY.get("door_payment_amount") == 99,
      "paying at the door is recorded as a Gaia door payment", (st, A_PAY.get("door_payment_status")))

st, unf = walk_in(EV1, E["unfound"], "Ugo", {"attendance_type": "paid", "door_payment_status": "none"})
A_UNF = (unf.get("attendee") or {})
check(A_UNF.get("attendance_type") == "paid" and A_UNF.get("door_payment_status") == "none",
      "'already paid, can't find them' takes no money and waits for reconciliation")

st, comp = walk_in(EV1, E["comp"], "Cleo", {"attendance_type": "complimentary",
                                            "door_payment_status": "waived", "note": "Guest of the organiser"})
A_CMP = (comp.get("attendee") or {})
check(A_CMP.get("attendance_type") == "complimentary" and A_CMP.get("door_payment_status") == "waived",
      "a complimentary guest is never marked paid")

st, crew = walk_in(EV1, E["crew"], "Sami", {"attendance_type": "speaker", "door_payment_status": "none"})
A_CRW = (crew.get("attendee") or {})
check(A_CRW.get("attendance_type") == "speaker", "a speaker gets a badge with no payment at all")

st, bad = walk_in(EV1, "refused-%s" % E["comp"], "Nope", {"attendance_type": "complimentary",
                                                          "door_payment_status": "collected",
                                                          "door_payment_amount": 50})
check(st == 400, "a complimentary badge cannot also be a door sale", st)
st, bad2 = walk_in(EV1, "refused2-%s" % E["comp"], "Nope", {"attendance_type": "paid",
                                                            "door_payment_status": "collected"})
check(st == 400, "a door sale without an amount is refused", st)

# ── 2. the full badge lifecycle for the payer ─────────────────────────────
TOKEN, QR, AID = A_PAY["public_token"], A_PAY["qr_code"], A_PAY["id"]
st, dec = call("POST", "/events/%d/authorize" % EV1, {"qr_code": TOKEN, "access_type": "EVENT_ENTRY"}, ADMIN)
check(st == 200 and dec.get("attendee_id") == AID, "their badge checks them in")
st, png = call("GET", "/events/%d/attendees/%d/badge-label.png" % (EV1, AID), token=ADMIN, raw=True)
check(st == 200 and png[:4] == bytes([0x89, 0x50, 0x4E, 0x47]), "their sticker prints")
ident = {"email": E["payer"], "email_verified": True, "event_id": 0}
# Publishing needs all three identity fields; this test is about the door, so
# the phone is filled in directly rather than through the verification flow.
_c = sqlite3.connect(DB)
_c.execute("UPDATE member_cards SET phone=? WHERE public_token=?", ("+1 555 700 2000", TOKEN))
_c.commit(); _c.close()
st, card = call("POST", "/identity/card/update", dict(ident, public=True, company="Doortest Studio"), SVC)
check(st == 200 and card.get("token") == TOKEN and card.get("public") is True, "they claim and publish their card")
st, body = call("GET", "/c/" + TOKEN, raw=True)
check(st == 200 and b"Doortest Studio" in body, "the printed QR opens their card")

# ── 3. reporting keeps the two kinds of money apart ───────────────────────
st, rep = call("GET", "/events/%d/door-report" % EV1, token=ADMIN)
w = rep["walk_ins"]
check(st == 200 and w["total"] == 4, "all four walk-ins are counted", w["total"])
check(w["by_attendance_type"] == {"paid": 2, "complimentary": 1, "speaker": 1},
      "and broken down by why they are here", w["by_attendance_type"])
check(rep["door_payments"]["collected_total"] == 99 and rep["door_payments"]["by_method"]["cash"]["count"] == 1,
      "door takings are reported on their own", rep["door_payments"])
check(rep["verified_ghl_revenue"]["amount"] == 0,
      "and NOT counted as GHL revenue — no order exists yet", rep["verified_ghl_revenue"])
check(w["awaiting_ghl_reconciliation"] == 1, "the 'already paid' person is flagged as awaiting reconciliation", w)

# ── 4. the real order lands for the person who said they had paid ─────────
st, rec = call("POST", "/identity/reconcile-attendee", {
    "event_id": EV1, "email": E["unfound"], "first_name": "Ugo", "last_name": "Doortest",
    "contact_id": "ghl-door-life-1", "order_id": "ord-door-life-1", "ticket_type_id": TT}, SVC)
check(rec.get("created") is False and rec.get("attendee_id") == A_UNF["id"],
      "the order reconciles onto the walk-in, not a new attendee")
row = sql("SELECT registration_source, attendance_type, ghl_linked_at, public_token, qr_code FROM attendees WHERE id=?",
          (A_UNF["id"],))[0]
check(row[0] == "walk_in", "their registration source is STILL walk_in — history is not rewritten", row[0])
check(row[2] is not None, "but the GHL linkage is recorded")
check(row[3] == A_UNF["public_token"] and row[4] == A_UNF["qr_code"], "permanent token and ticket QR unchanged")
cd = json.loads(sql("SELECT custom_data FROM attendees WHERE id=?", (A_UNF["id"],))[0][0] or "{}")
check(any(e.get("action") == "reconciled_with_ghl_order" for e in (cd.get("lifecycle") or [])),
      "and the reconciliation is written into their history", [e.get("action") for e in (cd.get("lifecycle") or [])])

# ── 5. an order arriving AFTER cash was taken is never auto-written-off ───
st, rec2 = call("POST", "/identity/reconcile-attendee", {
    "event_id": EV1, "email": E["payer"], "first_name": "Pia", "last_name": "Doortest",
    "contact_id": "ghl-door-life-2", "order_id": "ord-door-life-2", "ticket_type_id": TT}, SVC)
pay = sql("SELECT door_payment_status, door_payment_amount, registration_source FROM attendees WHERE id=?", (AID,))[0]
check(pay[0] == "needs_review",
      "cash taken at the door is FLAGGED for staff, never silently superseded", pay[0])
check(pay[1] == 99, "the amount taken is still on the record", pay[1])
check(pay[2] == "walk_in", "and they are still recorded as a walk-in")

st, rep2 = call("GET", "/events/%d/door-report" % EV1, token=ADMIN)
check(rep2["walk_ins"]["needs_review"] == 1, "the report surfaces it for reconciliation")
check(rep2["walk_ins"]["reconciled_with_ghl"] == 2, "two walk-ins now have genuine orders")
check(rep2["verified_ghl_revenue"]["orders"] == 2, "GHL revenue counts the two real orders", rep2["verified_ghl_revenue"])
check(rep2["door_payments"]["collected_total"] == 0,
      "the flagged door payment leaves the collected total until a human decides", rep2["door_payments"])
check(rep2["verified_ghl_revenue"]["amount"] + rep2["door_payments"]["collected_total"] ==
      rep2["verified_ghl_revenue"]["amount"], "no money is counted twice")

# ── 6. the same person at a second event ──────────────────────────────────
st, second = call("POST", "/events/%d/walk-in" % EV2,
                  {"first_name": "Pia", "last_name": "Doortest", "email": E["payer"],
                   "phone": "+14075550777",
                   "attendance_type": "paid", "door_payment_status": "none", "link_token": TOKEN}, ADMIN)
A2 = (second.get("attendee") or {})
check(A2.get("public_token") == TOKEN, "SAME permanent card token at the second event")
check(A2.get("qr_code") != QR, "but a distinct ticket QR for that event")
check(sql("SELECT COUNT(*) FROM member_cards WHERE public_token=?", (TOKEN,))[0][0] == 1,
      "still exactly ONE permanent business card")
st, prof = call("POST", "/identity/card", {"email": E["payer"], "email_verified": True, "event_id": 0}, SVC)
check(len(prof.get("events") or []) == 2, "two events in their participation history",
      [e.get("label") for e in (prof.get("events") or [])])

# ── clean up ──────────────────────────────────────────────────────────────
toks = [r[0] for r in sql("SELECT DISTINCT public_token FROM attendees WHERE email LIKE ?", ("%door-%-test@example.invalid",)) if r[0]]
for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ door-life%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)
c = sqlite3.connect(DB)
for t in toks:
    c.execute("DELETE FROM member_card_events WHERE card_id IN (SELECT id FROM member_cards WHERE public_token=?)", (t,))
    c.execute("DELETE FROM member_cards WHERE public_token=?", (t,))
c.execute("DELETE FROM member_cards WHERE email LIKE ?", ("%door-%-test@example.invalid",))
c.commit(); c.close()

print()
if fails:
    print("%d CHECK(S) FAILED" % len(fails)); sys.exit(1)
print("ALL CHECKS PASSED - registration, attendance and door money stay separate")
