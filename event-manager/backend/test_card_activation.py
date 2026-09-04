# -*- coding: utf-8 -*-
"""ONE QR, TWO JOBS — the card wakes up when its owner walks in.

Every attendee has a permanent token and a card from the moment their ticket
lands, months before the event. That card is real the whole time -- its QR
already resolves -- but until they check in there is nothing to show, and an
empty profile reads as broken rather than as "not yet".

So checking in activates it. The same scan opens the door and switches the card
on, because it is the same QR either way: no second step at a busy desk, no
second code to print, and nothing to reissue.

The one rule that needs care: activation publishes ONCE. Somebody who later
switches their card off has decided something, and walking past a scanner again
must not quietly undo it.

Throwaway events and example.invalid people only.
Run:  python3 /root/event/backend/test_card_activation.py
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

def call(method, path, body=None, token=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            p = r.read()
            return r.status, (p if raw else json.loads(p or b"null"))
    except urllib.error.HTTPError as e:
        p = e.read()
        try:
            return e.code, (p if raw else json.loads(p or b"null"))
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

print("CARD ACTIVATION")

for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ act%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)
write("DELETE FROM member_cards WHERE email LIKE 'zz-act-%'")

start = datetime.utcnow()
st, ev = call("POST", "/events", {"name": "ZZ act", "start_date": start.isoformat(),
                                  "end_date": (start + timedelta(days=1)).isoformat(),
                                  "location": "Test", "timezone": "UTC"}, ADMIN)
EV = ev["id"]
st, tt = call("POST", "/events/%d/ticket-types" % EV, {"name": "ZZ GA", "code": "zz-act-ga"}, ADMIN)
TT = tt["id"]

E = "zz-act-one@example.invalid"
st, a = call("POST", "/identity/reconcile-attendee", {
    "event_id": EV, "email": E, "ticket_type_id": TT, "order_id": "zz-act-o1",
    "first_name": "Ada", "last_name": "Arrival", "phone": "+14075550909"}, SVC)
TOKEN = a["public_token"]

def card_row():
    return sql("SELECT activated_at, card_public FROM member_cards WHERE public_token=?", (TOKEN,))[0]

# ── 1. the card exists long before the event, and says so ─────────────────
check(bool(TOKEN), "a ticket gives them a permanent token immediately", TOKEN)
check(card_row()[0] is None, "the card starts dormant", card_row())
st, page = call("GET", "/c/" + TOKEN, raw=True)
check(st == 200 and b"Ada Arrival" in page, "the QR already resolves, months early", st)
check(b"Card not active yet" in page,
      "and the page says it is not switched on yet, rather than showing a blank profile")
check(b"Ada Arrival" in page and E.encode() not in page,
      "the name is there; the email is not")

# ── 2. the SAME token opens the door ──────────────────────────────────────
st, dec = call("POST", "/events/%d/authorize" % EV, {"qr_code": TOKEN, "access_type": "EVENT_ENTRY"}, ADMIN)
check(st == 200 and dec.get("granted") is True,
      "the card's own QR checks them in — one code, both jobs", dec.get("reason"))
check(sql("SELECT is_checked_in FROM attendees WHERE public_token=?", (TOKEN,))[0][0] == 1,
      "they are checked in")

# ── 3. ...and the same scan switches the card on ──────────────────────────
row = card_row()
check(row[0] is not None, "checking in activated the card", row)
check(bool(row[1]) is True, "and published it, with no second step at the desk", row)
st, page = call("GET", "/c/" + TOKEN, raw=True)
check(b"Card not active yet" not in page, "the page no longer says dormant")
check(b"Ada Arrival" in page, "and shows them")
check(E.encode() not in page and b"14075550909" not in page,
      "contact details are STILL not on the public page")
check(b"locked__blur" in page, "they are shown as a locked row instead")

# ── 4. a later decision by the owner is respected ─────────────────────────
first_activated = card_row()[0]
call("POST", "/identity/card/update", {"email": E, "email_verified": True,
                                       "event_id": 0, "public": False}, SVC)
check(bool(card_row()[1]) is False, "the owner can switch their card back off")

st, dec = call("POST", "/events/%d/authorize" % EV, {"qr_code": TOKEN, "access_type": "EXHIBIT"}, ADMIN)
check(bool(card_row()[1]) is False,
      "scanning them again does NOT quietly switch it back on", card_row())
check(card_row()[0] == first_activated,
      "and the activation time is the first one, not the latest scan", card_row()[0])

st, page = call("GET", "/c/" + TOKEN, raw=True)
check(b"Card is private" in page,
      "the page now says private, not dormant — they are two different things")

# ── 5. someone who never turns up keeps a dormant card ────────────────────
E2 = "zz-act-two@example.invalid"
st, b = call("POST", "/identity/reconcile-attendee", {
    "event_id": EV, "email": E2, "ticket_type_id": TT, "order_id": "zz-act-o2",
    "first_name": "Noah", "last_name": "Noshow", "phone": "+14075550910"}, SVC)
T2 = b["public_token"]
st, page = call("GET", "/c/" + T2, raw=True)
check(b"Card not active yet" in page, "a no-show's card stays dormant, and still resolves", st)
check(sql("SELECT activated_at FROM member_cards WHERE public_token=?", (T2,))[0][0] is None,
      "with no activation stamp")

# ── cleanup ───────────────────────────────────────────────────────────────
write("DELETE FROM member_card_events WHERE card_id IN (SELECT id FROM member_cards WHERE email LIKE 'zz-act-%')")
write("DELETE FROM member_cards WHERE email LIKE 'zz-act-%'")
write("DELETE FROM ticket_mappings WHERE event_id=?", (EV,))
call("DELETE", "/events/%d" % EV, token=ADMIN)
check(sql("SELECT COUNT(*) FROM attendees WHERE email LIKE 'zz-act-%'")[0][0] == 0,
      "the throwaway event and its people are gone afterwards")

print("\n%d checks, %d failed" % (18, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
