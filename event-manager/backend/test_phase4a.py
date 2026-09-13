# -*- coding: utf-8 -*-
"""PHASE 4a — the scanner authorization matrix, one QR through every zone.

Originally run against event 2 while that was a live demo. Event 2 is now the
archived Elevate 2025 and reconciliation into it is correctly refused, so the
script died on a 409 before it reached a single assertion. It also leaned on the
`at` scan-time override, which is deliberately switched OFF in production --
nobody may fake the clock at a real door -- so even past the 409 its day-specific
cases were being judged against today rather than the day they named.

Both are fixed the same way: the test builds its own live event, and the day
matrix asks the authorization function directly, which takes an explicit date,
writes nothing, and is the exact code the endpoint calls. The cases that are
genuinely about the endpoint -- check-in side effects, revoke, wrong-event
lookup -- still go over HTTP, on the event's real middle day.

Throwaway event, example.invalid people, GHL is never written to.
Run:  python3 /root/event/backend/test_phase4a.py
"""
import json, sqlite3, sys, urllib.error, urllib.request
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

fails = []
def check(n, desc, ok, detail=""):
    print("  %-3s %-46s %s%s" % (n, desc, "ok" if ok else "FAIL", "" if ok else "   -- %s" % (detail,)))
    if not ok:
        fails.append("%s %s" % (n, desc))

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

def sv(p, b): return call("POST", p, b, SVC)
def ad(p, b): return call("POST", p, b, ADMIN)

# The pure decision path: takes a date, writes nothing, same code the endpoint runs.
sys.path.insert(0, "/root/event/backend")
import main as emmain, models as emmodels

def decide(attendee_id, zone, at, event_id=None):
    db = emmain.SessionLocal()
    try:
        att = db.get(emmodels.Attendee, attendee_id)
        ev = db.get(emmodels.Event, event_id or EV)
        return emmain._authorize_decision(db, att, ev, zone, at=at)
    finally:
        db.rollback(); db.close()

def expect(n, desc, aid, zone, at, result, granted=None):
    d = decide(aid, zone, at)
    ok = d.get("result") == result and (granted is None or d.get("granted") == granted)
    check(n, desc, ok, "got %s/%s: %s" % (d.get("result"), d.get("granted"), (d.get("reason") or "")[:44]))

# ── a live event whose middle day is today ─────────────────────────────────
_t = date.today()
FRI, SAT, SUN = (_t - timedelta(days=1)).isoformat(), _t.isoformat(), (_t + timedelta(days=1)).isoformat()
s, ev = call("POST", "/events", {
    "name": "PHASE4A TEST EVENT (throwaway)",
    "start_date": FRI + "T09:00:00", "end_date": SUN + "T18:00:00",
    "location": "test", "timezone": "UTC"}, ADMIN)
assert s in (200, 201), (s, ev)
EV = ev["id"]
_, ga = call("POST", "/events/%d/ticket-types" % EV, {"code": "P4-GA", "name": "P4 General Admission"}, ADMIN)
_, vip = call("POST", "/events/%d/ticket-types" % EV,
              {"code": "P4-VIP", "name": "P4 VIP", "is_vip": True, "grants_workshops": True}, ADMIN)
TT_GA, TT_VIP = ga["id"], vip["id"]
c = sqlite3.connect(DB)
c.execute("update ticket_types set upgrade_rank=1 where id=?", (TT_GA,))
c.execute("update ticket_types set upgrade_rank=5 where id=?", (TT_VIP,))
c.commit(); c.close()

MAIN, NODAY, ONLY = "p4-main@example.invalid", "p4-noday@example.invalid", "p4-addononly@example.invalid"

_, b = sv("/identity/reconcile-attendee", {"event_id": EV, "email": MAIN, "ticket_type_id": TT_GA,
                                           "first_name": "Pat", "last_name": "Four", "order_id": "P4-GA"})
AID, QR = b["attendee_id"], b["qr_code"]
sv("/identity/reconcile-attendee", {"event_id": EV, "email": MAIN, "addon_code": "ONE_DAY_CONFERENCE",
                                    "day": "Saturday", "order_id": "P4-1DAY"})
ad("/attendees/%d/addon-day" % AID, {"addon_code": "ONE_DAY_CONFERENCE", "day_label": "Saturday", "day_date": SAT})
_, bn = sv("/identity/reconcile-attendee", {"event_id": EV, "email": NODAY, "ticket_type_id": TT_GA,
                                            "first_name": "No", "last_name": "Day", "order_id": "P4-GA2"})
NAID, NQR = bn["attendee_id"], bn["qr_code"]
sv("/identity/reconcile-attendee", {"event_id": EV, "email": NODAY, "addon_code": "ONE_DAY_CONFERENCE",
                                    "day": None, "order_id": "P4-1DAY2"})
_, bo = sv("/identity/reconcile-attendee", {"event_id": EV, "email": ONLY, "addon_code": "ONE_DAY_CONFERENCE",
                                            "day": "Saturday", "order_id": "P4-1DAY3"})
OAID, OQR = bo["attendee_id"], bo["qr_code"]

print("== the 16-case matrix ==")
expect("1", "EVENT_ENTRY (GA entry)", AID, "EVENT_ENTRY", SAT, "GRANTED", True)
expect("2", "EXHIBIT Friday (GA has no day limit)", AID, "EXHIBIT", FRI, "GRANTED", True)
expect("3", "CONFERENCE Friday (wrong day)", AID, "CONFERENCE", FRI, "LIMITED", False)
expect("4", "CONFERENCE Saturday", AID, "CONFERENCE", SAT, "GRANTED", True)
expect("5", "CONFERENCE Sunday (wrong day)", AID, "CONFERENCE", SUN, "LIMITED", False)
expect("6", "WORKSHOP (GA, not entitled)", AID, "WORKSHOP", SAT, "LIMITED", False)
expect("7", "VIP (GA, not entitled)", AID, "VIP", SAT, "LIMITED", False)

sv("/identity/reconcile-attendee", {"event_id": EV, "email": MAIN, "ticket_type_id": TT_VIP,
                                    "is_upgrade": True, "order_id": "P4-VIP"})
expect("8", "VIP after upgrade", AID, "VIP", SAT, "GRANTED", True)

sv("/identity/refund-ticket", {"event_id": EV, "email": MAIN, "order_id": "P4-VIP", "full": True})
expect("9a", "VIP after refunding the upgrade", AID, "VIP", SAT, "LIMITED", False)
expect("9b", "CONFERENCE Saturday still granted", AID, "CONFERENCE", SAT, "GRANTED", True)
expect("9c", "CONFERENCE Friday still limited", AID, "CONFERENCE", FRI, "LIMITED", False)
expect("10", "conference with no day selected", NAID, "CONFERENCE", SAT, "LIMITED", False)
expect("11", "add-on only, no base -> no entry", OAID, "EVENT_ENTRY", SAT, "DENIED", False)

ad("/attendees/%d/revoke" % AID, {"reason": "test"})
expect("12", "revoked base is refused everywhere", AID, "EVENT_ENTRY", SAT, "DENIED", False)
ad("/attendees/%d/reinstate" % AID, {"reason": "test"})
expect("13", "reinstated base is admitted again", AID, "EVENT_ENTRY", SAT, "GRANTED", True)

# 14-16 are about the endpoint, not the decision: they run over HTTP on the
# event's real middle day, which is today.
other = sqlite3.connect("file:%s?mode=ro" % DB, uri=True).execute(
    "select id from events where id<>? order by id limit 1", (EV,)).fetchone()
_, d14 = ad("/events/%d/authorize" % other[0], {"qr_code": QR, "access_type": "EVENT_ENTRY"})
check("14", "this QR is refused at another event's door",
      isinstance(d14, dict) and not d14.get("granted"), str(d14)[:60])

_, d15a = ad("/events/%d/authorize" % EV, {"qr_code": QR, "access_type": "EVENT_ENTRY"})
_, d15b = ad("/events/%d/authorize" % EV, {"qr_code": QR, "access_type": "EVENT_ENTRY"})
check("15", "a second entry scan is not a second person",
      isinstance(d15a, dict) and d15a.get("granted") and isinstance(d15b, dict)
      and d15b.get("result") in ("GRANTED", "LIMITED"),
      "%s then %s" % (d15a.get("result"), d15b.get("result")))

ad("/events/%d/authorize" % EV, {"qr_code": OQR, "access_type": "CONFERENCE"})
ci = sqlite3.connect("file:%s?mode=ro" % DB, uri=True).execute(
    "select is_checked_in from attendees where id=?", (OAID,)).fetchone()
check("16", "a denied zone scan never checks anybody in", bool(ci) and not ci[0],
      "is_checked_in=%s" % (ci[0] if ci else "?"))

print()
print("== cleanup ==")
s, _ = call("DELETE", "/events/%d" % EV, None, ADMIN)
c = sqlite3.connect(DB)
c.execute("delete from scan_logs where qr_code in (?,?,?)", (QR, NQR, OQR)); c.commit(); c.close()
left = sqlite3.connect("file:%s?mode=ro" % DB, uri=True).execute(
    "select count(*) from attendees where email like 'p4-%@example.invalid'").fetchone()[0]
check("--", "throwaway event and attendees removed", s in (200, 204) and left == 0,
      "status=%s left=%s" % (s, left))

print()
if fails:
    print("FAILED (%d):" % len(fails))
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("phase 4a passed — 16/16")
