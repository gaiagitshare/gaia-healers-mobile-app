# -*- coding: utf-8 -*-
"""QR PERMANENCE — the badge guarantee.

One attendee owns ONE qr_code for the life of the event. It is printed on a
physical badge, shown in the Gaia app, and scanned at the door, so it must
survive every later write: an upgrade, a second purchase, a re-reconcile, a
backfill. This test proves the code never changes once issued.

Run:  python3 /root/event/backend/test_qr_permanence.py
"""
import json, urllib.request, urllib.error, sqlite3, sys

env = {}
for line in open("/root/event/backend/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
SECRET = env.get("SECRET_KEY"); SVC = env.get("IDENTITY_SERVICE_TOKEN")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, SECRET, algorithm="HS256")
BASE = "http://127.0.0.1:8002"
DB = "/root/event/backend/event.db"
TEST_EMAIL = "qr-permanence-test@example.invalid"
EVENT = 1

def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or "null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or "null")

def db_qr():
    c = sqlite3.connect(DB)
    r = c.execute("SELECT qr_code, ticket_type_id FROM attendees WHERE event_id=? AND lower(email)=?",
                  (EVENT, TEST_EMAIL)).fetchone()
    c.close()
    return r

def cleanup():
    c = sqlite3.connect(DB); c.isolation_level = None
    c.execute("DELETE FROM attendees WHERE lower(email)=?", (TEST_EMAIL,))
    # The permanent card this run created belongs to nobody real, so it goes too.
    c.execute("DELETE FROM member_card_events WHERE card_id IN "
              "(SELECT id FROM member_cards WHERE lower(email)=? OR person_key=?)",
              (TEST_EMAIL, "email:" + TEST_EMAIL))
    c.execute("DELETE FROM member_cards WHERE lower(email)=? OR person_key=?",
              (TEST_EMAIL, "email:" + TEST_EMAIL))
    c.close()

def ticket_types():
    c = sqlite3.connect(DB)
    rows = dict(c.execute("SELECT code,id FROM ticket_types WHERE event_id=?", (EVENT,)).fetchall())
    c.close()
    return rows

fails = []
def check(name, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + name + (("  -- " + detail) if detail and not ok else ""))
    if not ok: fails.append(name)

print("QR PERMANENCE TEST")
cleanup()
tt = ticket_types()
GA = tt.get("GA"); CONF = tt.get("GA-CONF") or tt.get("GA_CONF")

# 1. base purchase issues a QR
s, r = call("POST", "/identity/reconcile-attendee", {
    "event_id": EVENT, "email": TEST_EMAIL, "ticket_type_id": GA,
    "first_name": "QR", "last_name": "Permanence", "order_id": "test-order-base"}, SVC)
check("base purchase creates an attendee", s == 200 and r and r.get("ok"), str(r)[:120])
row = db_qr()
check("a qr_code was issued", bool(row and row[0]), str(row))
original = row[0] if row else None
print("        issued: %s" % original)

# 2. an UPGRADE must not mint a new code
s, r = call("POST", "/identity/reconcile-attendee", {
    "event_id": EVENT, "email": TEST_EMAIL, "ticket_type_id": CONF,
    "is_upgrade": True, "order_id": "test-order-upgrade"}, SVC)
after = db_qr()
check("upgrade keeps the SAME qr_code", after and after[0] == original,
      "was %s now %s" % (original, after[0] if after else None))

# 3. a second base purchase must not mint a new code
call("POST", "/identity/reconcile-attendee", {
    "event_id": EVENT, "email": TEST_EMAIL, "ticket_type_id": GA,
    "order_id": "test-order-second"}, SVC)
after2 = db_qr()
check("second purchase keeps the SAME qr_code", after2 and after2[0] == original,
      "now %s" % (after2[0] if after2 else None))

# 4. re-running the identical reconcile (the every-minute job) is idempotent
call("POST", "/identity/reconcile-attendee", {
    "event_id": EVENT, "email": TEST_EMAIL, "ticket_type_id": GA,
    "order_id": "test-order-base"}, SVC)
after3 = db_qr()
check("repeat reconciliation keeps the SAME qr_code", after3 and after3[0] == original)

# 5. exactly one attendee row for this person on this event
c = sqlite3.connect(DB)
n = c.execute("SELECT COUNT(*) FROM attendees WHERE event_id=? AND lower(email)=?", (EVENT, TEST_EMAIL)).fetchone()[0]
c.close()
check("still exactly ONE attendee row", n == 1, "found %d" % n)

# 6. the app-facing lookup returns that same code
s, r = call("POST", "/identity/ticket", {"email": TEST_EMAIL, "email_verified": True, "event_id": EVENT}, SVC)
app_qr = ((r or {}).get("attendee") or {}).get("qr_code")
check("Gaia app ticket returns the SAME qr_code", app_qr == original,
      "app=%s admin=%s" % (app_qr, original))

# 7. no other attendee anywhere shares this code
c = sqlite3.connect(DB)
dupes = c.execute("SELECT COUNT(*) FROM attendees WHERE qr_code=?", (original,)).fetchone()[0]
c.close()
check("qr_code is globally unique", dupes == 1, "%d rows carry it" % dupes)

cleanup()
print()
print(("FAILED: " + ", ".join(fails)) if fails else "ALL CHECKS PASSED - the badge QR is safe to print")
sys.exit(1 if fails else 0)
