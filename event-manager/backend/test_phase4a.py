# -*- coding: utf-8 -*-
# PHASE 4a — 16-case scanner authorization matrix on DEMO (event 2). Same QR throughout.
import json, urllib.request, urllib.error, os, sqlite3
from jose import jwt
env = {}
for l in open("/root/event/backend/.env"):
    m = l.strip()
    if "=" in m and not m.startswith("#"):
        k, v = m.split("=", 1); env[k] = v.strip().strip('"').strip("'")
SVC = env["IDENTITY_SERVICE_TOKEN"]; ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
BASE = "http://127.0.0.1:8002"
def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or "null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:120]
def sv(p, b): return call("POST", p, b, SVC)
def ad(p, b): return call("POST", p, b, ADMIN)

FRI, SAT, SUN = "2026-09-12", "2026-09-13", "2026-09-14"
MAIN = "p4-main@example.invalid"; NODAY = "p4-noday@example.invalid"; ONLY = "p4-addononly@example.invalid"
# clean slate
c = sqlite3.connect("/root/event/backend/event.db")
c.execute("delete from attendees where email like 'p4-%@example.invalid'"); c.commit(); c.close()

# --- setup MAIN: GA + one-day(Saturday) ---
_, b = sv("/identity/reconcile-attendee", {"event_id": 2, "email": MAIN, "ticket_type_id": 1, "first_name": "Pat", "last_name": "Four", "order_id": "P4-GA"})
AID = b["attendee_id"]; QR = b["qr_code"]
sv("/identity/reconcile-attendee", {"event_id": 2, "email": MAIN, "addon_code": "ONE_DAY_CONFERENCE", "day": "Saturday, Sep 13", "order_id": "P4-1DAY"})
ad("/attendees/%d/addon-day" % AID, {"addon_code": "ONE_DAY_CONFERENCE", "day_label": "Saturday, Sep 13", "day_date": SAT})
# NODAY: GA + one-day (no day selected)
_, bn = sv("/identity/reconcile-attendee", {"event_id": 2, "email": NODAY, "ticket_type_id": 1, "first_name": "No", "last_name": "Day", "order_id": "P4-GA2"})
NQR = bn["qr_code"]
sv("/identity/reconcile-attendee", {"event_id": 2, "email": NODAY, "addon_code": "ONE_DAY_CONFERENCE", "day": None, "order_id": "P4-1DAY2"})
# ONLY: add-on, no base
_, bo = sv("/identity/reconcile-attendee", {"event_id": 2, "email": ONLY, "addon_code": "ONE_DAY_CONFERENCE", "day": "Saturday, Sep 13", "order_id": "P4-1DAY3"})
OQR = bo["qr_code"]

def scan(qr, atype, at=None, ev=2):
    _, d = ad("/events/%d/authorize" % ev, {"qr_code": qr, "access_type": atype, "at": at})
    return d if isinstance(d, dict) else {"result": "ERR", "reason": str(d)}

def check(n, desc, d, expect_result, expect_granted=None):
    r = d.get("result"); g = d.get("granted")
    ok = (r == expect_result) and (expect_granted is None or g == expect_granted)
    print("  %-2s %-46s -> %-8s %s | %s" % (n, desc, r, ("OK" if ok else "**FAIL**"), (d.get("reason") or "")[:60]))
    return ok

P = []
P.append(check("1", "EVENT_ENTRY (main GA entry)", scan(QR, "EVENT_ENTRY", SAT), "GRANTED", True))
P.append(check("2", "EXHIBIT Friday", scan(QR, "EXHIBIT", FRI), "GRANTED", True))
P.append(check("3", "CONFERENCE Friday (wrong day)", scan(QR, "CONFERENCE", FRI), "LIMITED", False))
P.append(check("4", "CONFERENCE Saturday", scan(QR, "CONFERENCE", SAT), "GRANTED", True))
P.append(check("5", "CONFERENCE Sunday (wrong day)", scan(QR, "CONFERENCE", SUN), "LIMITED", False))
P.append(check("6", "WORKSHOP (GA, not entitled)", scan(QR, "WORKSHOP", SAT), "LIMITED", False))
P.append(check("7", "VIP (GA, not entitled)", scan(QR, "VIP", SAT), "LIMITED", False))
# 8: add VIP upgrade
sv("/identity/reconcile-attendee", {"event_id": 2, "email": MAIN, "ticket_type_id": 2, "is_upgrade": True, "order_id": "P4-VIP"})
P.append(check("8", "VIP after upgrade", scan(QR, "VIP", SAT), "GRANTED", True))
# 9: refund VIP upgrade -> back to GA + Saturday
sv("/identity/refund-ticket", {"event_id": 2, "email": MAIN, "order_id": "P4-VIP", "full": True})
d9a = scan(QR, "VIP", SAT); d9b = scan(QR, "CONFERENCE", SAT); d9c = scan(QR, "CONFERENCE", FRI)
P.append(check("9a", "VIP after refund -> LIMITED", d9a, "LIMITED", False))
P.append(check("9b", "CONFERENCE Saturday still granted", d9b, "GRANTED", True))
P.append(check("9c", "CONFERENCE Friday still limited", d9c, "LIMITED", False))
P.append(check("10", "day-not-selected conference", scan(NQR, "CONFERENCE", SAT), "LIMITED", False))
P.append(check("11", "add-on only, EVENT_ENTRY", scan(OQR, "EVENT_ENTRY", SAT), "DENIED", False))
# 12: revoke base
ad("/attendees/%d/revoke" % AID, {"reason": "test"})
P.append(check("12", "revoked base EVENT_ENTRY", scan(QR, "EVENT_ENTRY", SAT), "DENIED", False))
# 13: reinstate
ad("/attendees/%d/reinstate" % AID, {"reason": "test"})
P.append(check("13", "reinstated base EVENT_ENTRY", scan(QR, "EVENT_ENTRY", SAT), "GRANTED", True))
# 14: wrong event (DEMO qr scanned at ELEVATE event 1)
P.append(check("14", "wrong-event QR (at event 1)", scan(QR, "EVENT_ENTRY", SAT, ev=1), "DENIED", False))
# 15: duplicate entry idempotent
d15 = scan(QR, "EVENT_ENTRY", SAT)
P.append(check("15", "duplicate entry idempotent", d15, "GRANTED", True))
# 16: denied conference scan must not have set check-in on the add-on-only person
onlyci = sqlite3.connect("/root/event/backend/event.db").execute("select is_checked_in from attendees where email=?", (ONLY,)).fetchone()
P.append(check("16", "denied scan didn't check in add-on-only", {"result": "GRANTED" if (onlyci and onlyci[0] == 0) else "FAIL", "granted": True, "reason": "add-on-only is_checked_in=%s" % (onlyci[0] if onlyci else "?")}, "GRANTED", True))

print("\\n== %d/%d PASS ==" % (sum(P), len(P)))
# cleanup
c = sqlite3.connect("/root/event/backend/event.db")
c.execute("delete from attendees where email like 'p4-%@example.invalid'")
c.execute("delete from scan_logs where qr_code in (?,?,?)", (QR, NQR, OQR)); c.commit(); c.close()
print("cleanup done")
