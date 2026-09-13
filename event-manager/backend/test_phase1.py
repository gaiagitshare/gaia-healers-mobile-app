# -*- coding: utf-8 -*-
"""PHASE 1 — base ticket + add-on day, and the resolver that reads them.

Originally written against event 2 while that was a live demo. Event 2 is now
the archived Elevate 2025, and the application correctly refuses to reconcile
anything into an archived event, so the script died on a 409 it never expected.
The behaviour was right and the test was stale.

It now builds its own disposable event, which is what it should always have
done: a test that depends on a particular production event is a test that
breaks the day somebody archives it. The archive guard is not worked around --
it is asserted, so this file now protects both halves: an archived event refuses
the write, and a live one accepts it.

The original also only printed. Every claim it made is now an assertion.

Throwaway event, example.invalid people, GHL is never written to.
Run:  python3 /root/event/backend/test_phase1.py
"""
import json, sqlite3, sys, urllib.error, urllib.request

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
TEST = "phase1-test@example.invalid"

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
            return e.code, p.decode()[:200]

# ── the archive guard, asserted rather than tripped over ────────────────────
print("== 0) an archived event refuses reconciliation ==")
arch = sqlite3.connect("file:%s?mode=ro" % DB, uri=True).execute(
    "select id, name from events where is_archived=1 limit 1").fetchone()
if arch:
    s, b = call("POST", "/identity/reconcile-attendee",
                {"event_id": arch[0], "email": TEST, "ticket_type_id": 1,
                 "first_name": "Arch", "last_name": "Guard", "order_id": "P1-ARCHIVED"}, SVC)
    check(s == 409, "archived event '%s' rejects a reconcile with 409" % arch[1][:34], "got %s" % s)
    check("archived" in str(b).lower(), "and says why", str(b)[:70])
    left = sqlite3.connect("file:%s?mode=ro" % DB, uri=True).execute(
        "select count(*) from attendees where email=?", (TEST,)).fetchone()[0]
    check(left == 0, "and wrote nothing", "found %d rows" % left)
else:
    check(False, "an archived event exists to test the guard against")

# ── a live, disposable event for everything else ────────────────────────────
s, ev = call("POST", "/events", {
    "name": "PHASE1 TEST EVENT (throwaway)",
    "start_date": "2027-04-02T09:00:00", "end_date": "2027-04-04T18:00:00",
    "location": "test", "timezone": "UTC"}, ADMIN)
assert s in (200, 201), (s, ev)
EV = ev["id"]
s, tt = call("POST", "/events/%d/ticket-types" % EV,
             {"code": "P1-GA", "name": "Phase1 General Admission"}, ADMIN)
assert s == 200, (s, tt)
TT = tt["id"]

print()
print("== 1) a live event accepts the same reconcile ==")
s, b = call("POST", "/identity/reconcile-attendee",
            {"event_id": EV, "email": TEST, "ticket_type_id": TT,
             "first_name": "Phase1", "last_name": "Test", "order_id": "P1-BASE-001"}, SVC)
check(s == 200 and isinstance(b, dict) and b.get("attendee_id"),
      "base ticket reconciles into a live event", "%s %s" % (s, str(b)[:70]))
AID = b.get("attendee_id") if isinstance(b, dict) else None
check(bool(b.get("qr_code")) if isinstance(b, dict) else False, "and a QR is issued")

print()
print("== 2) an add-on day attaches to the same person ==")
s, b = call("POST", "/identity/reconcile-attendee",
            {"event_id": EV, "email": TEST, "addon_code": "ONE_DAY_CONFERENCE",
             "day": "Saturday, Apr 3", "order_id": "P1-ADDON-001"}, SVC)
check(s == 200, "add-on reconciles", "%s %s" % (s, str(b)[:70]))
check(b.get("attendee_id") == AID if isinstance(b, dict) else False,
      "onto the SAME attendee, not a second one")

print()
print("== 3) the resolver reports base and add-on separately ==")
s, det = call("GET", "/attendees/%d" % AID, None, ADMIN)
ea = (det or {}).get("effective_access") or {}
check(ea.get("base_ticket", {}).get("id") == TT, "base ticket is the GA tier", str(ea.get("base_ticket")))
check(len(ea.get("addons") or []) == 1, "exactly one add-on", str(ea.get("addons"))[:70])
check("Phase1 General Admission" in (ea.get("effective_label") or ""),
      "effective label names the base tier", ea.get("effective_label"))
hist = ea.get("entitlement_history") or []
check(len(hist) == 2, "history keeps both purchases", "got %d" % len(hist))
check({h.get("order_id") for h in hist} == {"P1-BASE-001", "P1-ADDON-001"},
      "and both order references", str([h.get("order_id") for h in hist]))

print()
print("== 4) re-sending the same add-on order changes nothing ==")
call("POST", "/identity/reconcile-attendee",
     {"event_id": EV, "email": TEST, "addon_code": "ONE_DAY_CONFERENCE",
      "day": "Saturday, Apr 3", "order_id": "P1-ADDON-001"}, SVC)
s, det2 = call("GET", "/attendees/%d" % AID, None, ADMIN)
ea2 = (det2 or {}).get("effective_access") or {}
check(len(ea2.get("addons") or []) == 1, "still exactly one add-on after a replay",
      str(len(ea2.get("addons") or [])))
rows = sqlite3.connect("file:%s?mode=ro" % DB, uri=True).execute(
    "select count(*) from attendees where event_id=? and lower(email)=?", (EV, TEST)).fetchone()[0]
check(rows == 1, "and still exactly one attendee", "got %d" % rows)

print()
print("== 5) counts keep base tickets and add-ons apart ==")
s, tc = call("GET", "/events/%d/ticket-counts" % EV, None, ADMIN)
check(s == 200 and isinstance(tc, dict), "ticket-counts responds", str(tc)[:60])
check((tc.get("by_base_ticket") or {}).get("P1-GA") == 1, "one base ticket counted",
      str(tc.get("by_base_ticket")))
check(sum((tc.get("by_addon") or {}).values()) == 1, "one add-on counted, separately",
      str(tc.get("by_addon")))
check(tc.get("total") == 1, "and one person, not two", str(tc.get("total")))

print()
print("== 6) cleanup ==")
s, _ = call("DELETE", "/events/%d" % EV, None, ADMIN)
left = sqlite3.connect("file:%s?mode=ro" % DB, uri=True).execute(
    "select count(*) from attendees where lower(email)=?", (TEST,)).fetchone()[0]
check(s in (200, 204) and left == 0, "throwaway event and its attendee removed",
      "status=%s left=%s" % (s, left))

print()
if fails:
    print("FAILED (%d):" % len(fails))
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("phase 1 passed")
