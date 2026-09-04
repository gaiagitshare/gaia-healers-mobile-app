# -*- coding: utf-8 -*-
"""WALK-IN MEETS A REAL ORDER — and everything appearing at once.

Two things this proves, both about the ten minutes after somebody walks up to
the desk:

  1. A registration made at the door shows up EVERYWHERE in Event Admin
     immediately — list, search, counts, check-in, sticker, badge-card state,
     reporting — with no refresh, restart or re-import.

  2. When the real GHL order for that same person lands afterwards, it
     RECONCILES onto the walk-in. No second attendee, no second card, and the
     permanent token printed on their badge does not move.

Throwaway event, example addresses. Nothing real is touched.
Run:  python3 /root/event/backend/test_walkin_reconcile.py
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
EMAIL = "walkin-then-order-test@example.invalid"

fails = []
notes = []
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

print("WALK-IN MEETS A REAL ORDER")
for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ door%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)

start = datetime.utcnow() + timedelta(days=15)
st, ev = call("POST", "/events", {"name": "ZZ door test", "start_date": start.isoformat(),
                                  "end_date": (start + timedelta(days=1)).isoformat(),
                                  "location": "Test", "timezone": "UTC"}, ADMIN)
EV = ev["id"]

# ── the walk-in ───────────────────────────────────────────────────────────
st, tt = call("POST", "/events/%d/ticket-types" % EV,
              {"code": "ZZTEST-GA", "name": "ZZ Test General Admission"}, ADMIN)
TT = (tt or {}).get("id")

st, w = call("POST", "/events/%d/walk-in" % EV,
             {"first_name": "Maya", "last_name": "Doorstep", "email": EMAIL,
              "phone": "+14075550199"}, ADMIN)
att = (w or {}).get("attendee") or {}
AID, TOKEN, QR = att.get("id"), att.get("public_token"), att.get("qr_code")
check(st == 200 and AID and TOKEN and QR, "registered at the door", (st, w))

# ── 1. it is everywhere, straight away ───────────────────────────────────
st, lst = call("GET", "/events/%d/attendees" % EV, token=ADMIN)
row = next((a for a in lst if a["id"] == AID), None)
check(st == 200 and row is not None, "appears in the attendee list with no refresh")
check(bool(row and row.get("card_url")) and (row or {}).get("card_state") == "unclaimed",
      "with its badge-card link and state already resolved", (row or {}).get("card_state"))
st, found = call("GET", "/events/%d/attendees/search?q=doorstep" % EV, token=ADMIN)
check(any(a["id"] == AID for a in found), "findable by name in search")
st, found2 = call("GET", "/events/%d/attendees/search?q=%s" % (EV, "5550199"), token=ADMIN)
check(any(a["id"] == AID for a in found2), "findable by the last digits of their phone")
st, counts = call("GET", "/events/%d/ticket-counts" % EV, token=ADMIN)
check(st == 200 and (counts or {}).get("total", 0) >= 1, "counted in the event totals", counts)
st, png = call("GET", "/events/%d/attendees/%d/badge-label.png" % (EV, AID), token=ADMIN, raw=True)
check(st == 200 and png[:4] == bytes([0x89, 0x50, 0x4E, 0x47]), "their sticker prints immediately")
st, dec = call("POST", "/events/%d/authorize" % EV, {"qr_code": TOKEN, "access_type": "EVENT_ENTRY"}, ADMIN)
check(st == 200 and dec.get("attendee_id") == AID, "their badge resolves at the door", dec.get("reason"))
st, body = call("GET", "/c/" + TOKEN, raw=True)
check(st == 200 and b"Maya" in body, "their public card is live")
st, rep = call("GET", "/events/%d/acquisition-report" % EV, token=ADMIN)
check(st == 200 and (rep or {}).get("attendees", 0) >= 1, "included in reporting", (rep or {}).get("attendees"))

card_before = sql("SELECT id, public_token, contact_id FROM member_cards WHERE public_token=?", (TOKEN,))
check(len(card_before) == 1, "exactly one permanent card exists for them")
src_before = json.loads(sql("SELECT custom_data FROM attendees WHERE id=?", (AID,))[0][0] or "{}").get("source")
check(src_before == "walk_in", "the row is marked as a door registration", src_before)

# ── 2. the real order lands ten minutes later ────────────────────────────
st, rec = call("POST", "/identity/reconcile-attendee", {
    "event_id": EV, "email": EMAIL, "first_name": "Maya", "last_name": "Doorstep",
    "contact_id": "ghl-door-test-1", "order_id": "ord-door-test-1",
    "ticket_type_id": TT}, SVC)
check(st == 200 and rec.get("created") is False,
      "the GHL order RECONCILES onto the walk-in instead of creating a new attendee", (st, rec))
check(rec.get("attendee_id") == AID, "it is the same attendee row", rec.get("attendee_id"))
check(rec.get("qr_code") == QR, "their ticket QR is unchanged")

rows = sql("SELECT id, public_token FROM attendees WHERE event_id=? AND lower(email)=?", (EV, EMAIL))
check(len(rows) == 1, "still ONE attendee row for this person at this event", len(rows))
check(rows[0][1] == TOKEN, "their permanent badge token did not move", rows[0][1])
cards = sql("SELECT id, contact_id FROM member_cards WHERE public_token=?", (TOKEN,))
check(len(cards) == 1 and cards[0][0] == card_before[0][0], "still exactly ONE permanent card, the same one")
check(cards[0][1] == "ghl-door-test-1", "the card picked up their GHL contact id", cards[0][1])
lines = sql("SELECT COUNT(*) FROM member_card_events WHERE card_id=?", (cards[0][0],))[0][0]
check(lines == 1, "one line of participation, not two", lines)
st, body = call("GET", "/c/" + TOKEN, raw=True)
check(st == 200, "the printed QR still opens the card after the order lands")

cd = json.loads(sql("SELECT custom_data FROM attendees WHERE id=?", (AID,))[0][0] or "{}")
check(cd.get("order_id") == "ord-door-test-1", "the order is now recorded against them")
check(bool(cd.get("entitlements")), "and ledgered for revenue")
# Documented, not asserted: this is the behaviour to decide on.
notes.append("source after reconcile = %r (was 'walk_in')" % cd.get("source"))
notes.append("lifecycle entries      = %s" % [e.get("action") for e in (cd.get("lifecycle") or [])])

for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ door%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)
c = sqlite3.connect(DB)
c.execute("DELETE FROM member_card_events WHERE card_id IN (SELECT id FROM member_cards WHERE public_token=?)", (TOKEN,))
c.execute("DELETE FROM member_cards WHERE public_token=?", (TOKEN,))
c.commit(); c.close()

print()
for n in notes:
    print("  NOTE  " + n)
print()
if fails:
    print("%d CHECK(S) FAILED" % len(fails)); sys.exit(1)
print("ALL CHECKS PASSED - a later order reconciles onto the walk-in")
