# -*- coding: utf-8 -*-
"""A replayed sale must bring the buyer's phone with it.

James Mosqueda bought a Sunday pass, and the product had no mapping yet. The
checkout webhook only fires for a mapped product, so nothing created him at the
time; he was created weeks later when the product was finally mapped and its
history replayed. That replay passed the name and the email and dropped the
phone on the floor -- map-reconcile simply never put it in the payload -- so the
one attendee in the event who could only have arrived by replay was also the one
nobody could look up by phone at the door.

Two things had to change. The proxy's sales feed now carries the phone GHL keeps
on the order (contactSnapshot.phone, and phoneNo on an invoice), and
map-reconcile passes it through. The merge rule is the one reconcile already
used for names: fill a blank field, never overwrite one that is already set, so
a replay cannot undo a phone somebody corrected by hand.

This exercises the real reconcile path with the exact payload map-reconcile
builds, and asserts the plumbing that carries the phone into it.

Throwaway event, example.invalid people, GHL is never written to.
Run:  python3 /root/event/backend/test_reconcile_phone.py
"""
import json, re, sqlite3, sys, urllib.error, urllib.request
from datetime import date, timedelta

env = {}
for l in open("/root/event/backend/.env"):
    m = l.strip()
    if "=" in m and not m.startswith("#"):
        k, v = m.split("=", 1); env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
SVC = env["IDENTITY_SERVICE_TOKEN"]
BASE = "http://127.0.0.1:8002"
DB = "/root/event/backend/event.db"
PHONE = "+13143033510"
OTHER = "+15550001111"

fails = []
def check(ok, label, detail=""):
    print("  %-4s %s%s" % ("ok" if ok else "FAIL", label, "" if ok else "   -- %s" % (detail,)))
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
            return e.code, p.decode()[:160]

def row(email):
    return sqlite3.connect("file:%s?mode=ro" % DB, uri=True).execute(
        "select id, phone, qr_code, ticket_type_id from attendees where event_id=? and lower(email)=?",
        (EV, email.lower())).fetchall()

def replay(email, tt, order_id, phone, first="Repl", last="Ay", product_id="prod-phone-test"):
    """Exactly the payload map_reconcile_apply builds for one replayed order."""
    return call("POST", "/identity/reconcile-attendee", {
        "event_id": EV, "email": email, "ticket_type_id": tt,
        "is_upgrade": False, "addon_code": None,
        "contact_id": "ctc-test", "order_id": order_id,
        "product_id": product_id, "quantity": 1, "amount": 97.0,
        "purchased_at": "2026-09-05", "phone": phone,
        "first_name": first, "last_name": last}, SVC)

# ── the plumbing that carries the phone, asserted at the source ─────────────
print("== 0) map-reconcile actually puts the phone in the payload ==")
src = open("/root/event/backend/main.py", encoding="utf-8").read()
apply_fn = src[src.index("def map_reconcile_apply"):]
apply_fn = apply_fn[:apply_fn.index("\n@app.")] if "\n@app." in apply_fn else apply_fn
check("phone=row.get(\"phone\")" in apply_fn,
      "the replayed ORDER payload carries phone=row.get('phone')")
check(apply_fn.count("phone=row.get(\"phone\")") >= 2,
      "and so does the replayed INVOICE payload",
      "found %d" % apply_fn.count("phone=row.get(\"phone\")"))

# ── a live event with three day passes ─────────────────────────────────────
_t = date.today()
D1, D2 = (_t + timedelta(days=30)).isoformat(), (_t + timedelta(days=31)).isoformat()
s, ev = call("POST", "/events", {
    "name": "PHONE TEST EVENT (throwaway)",
    "start_date": D1 + "T09:00:00", "end_date": D2 + "T18:00:00",
    "location": "test", "timezone": "UTC"}, ADMIN)
assert s in (200, 201), (s, ev)
EV = ev["id"]
_, t1 = call("POST", "/events/%d/ticket-types" % EV, {"code": "PH-D1", "name": "Phone Day One", "valid_day": D1}, ADMIN)
_, t2 = call("POST", "/events/%d/ticket-types" % EV, {"code": "PH-D2", "name": "Phone Day Two", "valid_day": D2}, ADMIN)
TT1, TT2 = t1["id"], t2["id"]

print()
print("== 1) a replayed sale WITH a phone (the James case) ==")
em = "phone-yes@example.invalid"
s, b = replay(em, TT1, "PH-ORD-1", PHONE)
r = row(em)
check(s == 200 and len(r) == 1, "attendee created exactly once", "%s rows=%d" % (s, len(r)))
check(r and r[0][1] == PHONE, "phone stored verbatim as GHL gave it", r and r[0][1])
check(r and bool(r[0][2]), "QR issued", r and r[0][2])
check(r and r[0][3] == TT1, "correct ticket type", r and r[0][3])

print()
print("== 2) a replayed sale with NO phone invents nothing ==")
em2 = "phone-no@example.invalid"
s, _ = replay(em2, TT1, "PH-ORD-2", None)
r2 = row(em2)
check(s == 200 and len(r2) == 1, "attendee still created", "rows=%d" % len(r2))
check(r2 and not r2[0][1], "phone left empty, not fabricated", repr(r2 and r2[0][1]))
check(r2 and bool(r2[0][2]), "and still gets a QR")

print()
print("== 3) an existing phone is never overwritten ==")
call("PUT", "/attendees/%d" % r2[0][0], {"phone": OTHER}, ADMIN)          # corrected by hand
replay(em2, TT1, "PH-ORD-3", None)                                        # later replay, blank phone
r3 = row(em2)
check(r3 and r3[0][1] == OTHER, "a blank incoming phone does not erase it", r3 and r3[0][1])
replay(em2, TT1, "PH-ORD-4", PHONE)                                       # later replay, different phone
r4 = row(em2)
check(r4 and r4[0][1] == OTHER, "and a different incoming phone does not replace it", r4 and r4[0][1])

print()
print("== 4) a blank phone is filled when one finally arrives ==")
em5 = "phone-late@example.invalid"
replay(em5, TT1, "PH-ORD-5", None)
check(not row(em5)[0][1], "starts blank")
replay(em5, TT1, "PH-ORD-6", PHONE)
check(row(em5)[0][1] == PHONE, "and is filled by a later sale that has one", row(em5)[0][1])

print()
print("== 5) replaying the same order changes nothing ==")
em6 = "phone-replay@example.invalid"
replay(em6, TT1, "PH-ORD-7", PHONE)
before = row(em6)[0]
replay(em6, TT1, "PH-ORD-7", PHONE)
replay(em6, TT1, "PH-ORD-7", PHONE)
after = row(em6)
check(len(after) == 1, "still one attendee", "rows=%d" % len(after))
check(after[0][2] == before[2], "QR unchanged", after[0][2])
check(after[0][1] == PHONE, "phone unchanged", after[0][1])

print()
print("== 6) a two-day order keeps one person, one QR, both days and the phone ==")
em7 = "phone-multiday@example.invalid"
replay(em7, TT1, "PH-ORD-8", PHONE, product_id="prod-day-1")
replay(em7, TT2, "PH-ORD-8", PHONE, product_id="prod-day-2")   # same order, second day
r7 = row(em7)
check(len(r7) == 1, "one attendee", "rows=%d" % len(r7))
check(r7[0][1] == PHONE, "phone preserved across the multi-day replay", r7[0][1])
sys.path.insert(0, "/root/event/backend")
import main as emmain, models as emmodels
db = emmain.SessionLocal()
try:
    att = db.get(emmodels.Attendee, r7[0][0]); evo = db.get(emmodels.Event, EV)
    days = emmain._effective_access(db, att).get("valid_days") or []
    check(sorted(days) == sorted([D1, D2]), "both days still entitled", str(days))
    g1 = emmain._authorize_decision(db, att, evo, "EXHIBIT", at=D1).get("granted")
    g2 = emmain._authorize_decision(db, att, evo, "EXHIBIT", at=D2).get("granted")
    check(bool(g1) and bool(g2), "and the scanner admits on both", "%s/%s" % (g1, g2))
finally:
    db.rollback(); db.close()

print()
print("== 7) cleanup ==")
s, _ = call("DELETE", "/events/%d" % EV, None, ADMIN)
left = sqlite3.connect("file:%s?mode=ro" % DB, uri=True).execute(
    "select count(*) from attendees where email like 'phone-%@example.invalid'").fetchone()[0]
check(s in (200, 204) and left == 0, "throwaway event removed", "status=%s left=%s" % (s, left))

print()
if fails:
    print("FAILED (%d):" % len(fails))
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("reconcile phone checks passed")
