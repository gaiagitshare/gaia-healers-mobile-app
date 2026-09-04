# -*- coding: utf-8 -*-
"""DYNAMIC LIFECYCLE — the people who were not on the list.

Tickets keep selling after the import, and some people simply turn up. This
proves the whole system handles both without anyone rerunning a migration:

  * an online sale landing AFTER the migration gets its permanent identity
    immediately, with no restart and no backfill
  * a walk-in registered at the door gets exactly the same thing
  * the same person at a second event keeps ONE token and ONE card, and gains
    a second line of participation history
  * staff cannot quietly mint a second card for somebody who already has one

Throwaway events and example people only — nothing real is touched.
Run:  python3 /root/event/backend/test_walkin_lifecycle.py
"""
import io, json, sqlite3, sys, urllib.error, urllib.request

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
from datetime import datetime, timedelta

WALKIN = "walkin-lifecycle-test@example.invalid"
ONLINE = "online-after-import-test@example.invalid"

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

print("DYNAMIC LIFECYCLE")

for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ walkin%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)

def make_event(label, days):
    start = datetime.utcnow() + timedelta(days=days)
    st, ev = call("POST", "/events", {"name": "ZZ walkin %s" % label,
                                      "start_date": start.isoformat(),
                                      "end_date": (start + timedelta(days=1)).isoformat(),
                                      "location": "Test", "timezone": "UTC"}, ADMIN)
    assert st in (200, 201), (st, ev)
    return ev["id"]

EV1 = make_event("event one", 20)
EV2 = make_event("event two", 50)

# ── 1. an ONLINE sale arriving after the migration ────────────────────────
st, rec = call("POST", "/identity/reconcile-attendee", {
    "event_id": EV1, "email": ONLINE, "first_name": "Nadia", "last_name": "Online",
    "contact_id": "ghl-test-online-1", "order_id": "ord-test-online-1"}, SVC)
check(st == 200 and rec.get("created") is True, "an online sale after the import creates an attendee", (st, rec))
check(bool(rec.get("public_token")), "and it gets its permanent badge token immediately, with no restart or backfill", rec)
ONLINE_TOKEN = rec.get("public_token")
st, body = call("GET", "/c/" + (ONLINE_TOKEN or "XXXXXXXX"), raw=True)
check(st == 200 and b"Nadia" in body, "their card is live the moment the order lands", st)

# ── 2. a WALK-IN, nobody has heard of them ────────────────────────────────
st, chk = call("POST", "/events/%d/walk-in/check" % EV1,
               {"first_name": "Ola", "last_name": "Doorstep", "email": WALKIN}, ADMIN)
check(st == 200 and chk.get("matches") == [], "a genuinely new person shows no duplicate matches", chk)

st, w = call("POST", "/events/%d/walk-in" % EV1,
             {"first_name": "Ola", "last_name": "Doorstep", "email": WALKIN,
              "phone": "+14075550123"}, ADMIN)
check(st == 200 and w.get("created") is True, "the walk-in is registered", (st, w))
att = w.get("attendee") or {}
TOKEN = att.get("public_token") or ""
check(bool(TOKEN) and bool(att.get("qr_code")), "they get a ticket QR and a permanent badge token", att)
check((att.get("card_state") or "") == "unclaimed" and (att.get("card_url") or "").endswith(TOKEN),
      "and a badge card link, in the same shape as everyone else's", (att.get("card_state"), att.get("card_url")))
check((att.get("custom_data") or {}).get("source") == "walk_in",
      "the row is stamped as a door registration, never mistaken for a GHL order")

# GHL must not have been touched
check(not (att.get("custom_data") or {}).get("order_id"),
      "no GHL order id is invented for a door sale")

# ── 3. found by search, checked in, printed ───────────────────────────────
st, found = call("GET", "/events/%d/attendees/search?q=%s" % (EV1, "doorstep"), token=ADMIN)
check(st == 200 and any(a["email"] == WALKIN for a in found), "staff can find them by name straight away", st)
st, dec = call("POST", "/events/%d/authorize" % EV1, {"qr_code": TOKEN, "access_type": "EVENT_ENTRY"}, ADMIN)
check(st == 200 and dec.get("result") in ("GRANTED", "LIMITED", "DENIED"), "their badge scans at the door", dec.get("reason"))
st, png = call("GET", "/events/%d/attendees/%d/badge-label.png" % (EV1, att["id"]), token=ADMIN, raw=True)
check(st == 200 and isinstance(png, bytes) and png[:4] == bytes([0x89, 0x50, 0x4E, 0x47]), "their sticker prints", st)

# ── 4. they claim the card and it is theirs ───────────────────────────────
ident = {"email": WALKIN, "email_verified": True, "event_id": 0}
st, card = call("POST", "/identity/card", ident, SVC)
check(st == 200 and card.get("ok") and card.get("token") == TOKEN,
      "signing in with the email on their walk-in reaches the same card", (st, card.get("token")))
st, card = call("POST", "/identity/card/update", dict(ident, public=True, company="Doorstep Studio"), SVC)
check(st == 200 and card.get("public") is True, "they publish it")
st, body = call("GET", "/c/" + TOKEN, raw=True)
check(st == 200 and b"Doorstep Studio" in body, "the public card shows what they typed")
st, prof = call("POST", "/identity/card", {"email": WALKIN, "email_verified": True, "event_id": 0}, SVC)
check(st == 200 and prof.get("card_url", "").endswith(TOKEN) and prof.get("qr_image"),
      "it appears in their profile with the very QR on their badge")

# ── 5. the SAME person at a second event ──────────────────────────────────
st, dup = call("POST", "/events/%d/walk-in" % EV2,
               {"first_name": "Ola", "last_name": "Doorstep", "email": WALKIN}, ADMIN)
check(st == 200 and dup.get("ok") is False and dup.get("reason") == "possible_duplicate",
      "registering them again stops and offers the match instead of minting a second card", dup.get("reason"))
match = (dup.get("matches") or [{}])[0]
check(match.get("token") == TOKEN and match.get("why") == "same email address",
      "the match staff are shown is the right person", match)
check("@" in match.get("email_masked", "") and WALKIN not in json.dumps(dup),
      "their address is masked on a screen a queue can see", match.get("email_masked"))

st, linked = call("POST", "/events/%d/walk-in" % EV2,
                  {"first_name": "Ola", "last_name": "Doorstep", "email": WALKIN,
                   "link_token": TOKEN}, ADMIN)
check(st == 200 and linked.get("created") is True and linked.get("reused_existing_card") is True,
      "staff link them to the card they already have", (st, linked.get("reused_existing_card")))
att2 = linked.get("attendee") or {}
check(att2.get("public_token") == TOKEN, "SAME permanent token at the second event", att2.get("public_token"))
check(att2.get("qr_code") != att.get("qr_code"), "but a distinct ticket QR for the new event")

cards = sql("SELECT COUNT(*) FROM member_cards WHERE public_token=?", (TOKEN,))[0][0]
check(cards == 1, "exactly ONE permanent card exists for them", cards)
st, prof2 = call("POST", "/identity/card", {"email": WALKIN, "email_verified": True, "event_id": 0}, SVC)
labels = [e.get("label") for e in (prof2.get("events") or [])]
check(len(labels) == 2, "and TWO events in their participation history", labels)
check(prof2.get("token") == TOKEN, "their card and token are unchanged by the second event")

# ── 6. an existing member met by email only, no token given ───────────────
st, chk2 = call("POST", "/events/%d/walk-in/check" % EV2,
                {"first_name": "Different", "last_name": "Name", "email": WALKIN}, ADMIN)
check(st == 200 and any(m["token"] == TOKEN for m in chk2.get("matches", [])),
      "a mistyped name still finds them by email before anything is created")

# ── clean up ──────────────────────────────────────────────────────────────
for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ walkin%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)
c = sqlite3.connect(DB)
for tok in (TOKEN, ONLINE_TOKEN):
    if tok:
        c.execute("DELETE FROM member_card_events WHERE card_id IN (SELECT id FROM member_cards WHERE public_token=?)", (tok,))
        c.execute("DELETE FROM member_cards WHERE public_token=?", (tok,))
c.commit(); c.close()

print()
if fails:
    print("%d CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL CHECKS PASSED - walk-ins and late online sales are first-class")
