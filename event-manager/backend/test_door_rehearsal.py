# -*- coding: utf-8 -*-
"""DOOR REHEARSAL — practise before opening day, without weakening the door.

A ticket is not valid outside its event's calendar window. That gate is what
stops last year's badge opening this year's door, so it is never removed. But
staff have to practise the flow and test the printer BEFORE the event rather
than in front of a queue, and until now there was no way to do that at all.

Rehearsal waives the calendar window, for one event, deliberately, with a banner
on screen the whole time. Everything else still applies. These tests pin exactly
that boundary: what rehearsal lets through, and what it still refuses.

They also cover the bug rehearsal uncovered. event.custom_fields is a LIST of
registration-form fields on every real event, and the anti-passback check called
.get() on it. Nothing had ever reached that line, because the calendar gate
returns first on every day that is not an event day -- so the first scan to get
that far would have been the first scan of the real event.

Throwaway events and example.invalid people only.
Run:  python3 /root/event/backend/test_door_rehearsal.py
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

def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        p = e.read()
        try:
            return e.code, json.loads(p or b"null")
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

print("DOOR REHEARSAL")

for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ reh%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)

def make(tag, days_ahead):
    start = datetime.utcnow() + timedelta(days=days_ahead)
    st, ev = call("POST", "/events", {"name": "ZZ reh %s" % tag,
                                      "start_date": start.isoformat(),
                                      "end_date": (start + timedelta(days=2)).isoformat(),
                                      "location": "Test", "timezone": "UTC"}, ADMIN)
    assert st in (200, 201), (st, ev)
    return ev["id"]

FUTURE = make("future", 60)          # not started
OTHER = make("other", 60)            # a different event entirely

def ticket(ev, name, code, day=None):
    st, tt = call("POST", "/events/%d/ticket-types" % ev, {"name": name, "code": code,
                                                           "valid_day": day}, ADMIN)
    assert st in (200, 201), (st, tt)
    return tt["id"]

TT = ticket(FUTURE, "ZZ GA", "zz-reh-ga")
TT_DAY = ticket(FUTURE, "ZZ Friday only", "zz-reh-fri", "2020-01-03")
TT_OTHER = ticket(OTHER, "ZZ GA", "zz-reh-other")

def attendee(ev, tt, email, ref):
    st, r = call("POST", "/identity/reconcile-attendee", {
        "event_id": ev, "email": email, "ticket_type_id": tt, "order_id": ref,
        "first_name": "Reh", "last_name": "Tester"}, SVC)
    assert st == 200 and r.get("ok"), (st, r)
    return r

A = attendee(FUTURE, TT, "zz-reh-a@example.invalid", "zz-reh-o1")
B = attendee(FUTURE, TT, "zz-reh-b@example.invalid", "zz-reh-o2")
D = attendee(FUTURE, TT_DAY, "zz-reh-day@example.invalid", "zz-reh-o3")
O = attendee(OTHER, TT_OTHER, "zz-reh-other@example.invalid", "zz-reh-o4")

def scan(ev, qr, zone="EVENT_ENTRY"):
    st, d = call("POST", "/events/%d/authorize" % ev, {"qr_code": qr, "access_type": zone}, ADMIN)
    return d if isinstance(d, dict) else {"result": "ERROR", "raw": d}

def rehearsal(ev, on):
    return call("POST", "/events/%d/door-test-mode" % ev, {"enabled": on}, ADMIN)

# ── 1. with rehearsal off, a future event refuses everything ──────────────
d = scan(FUTURE, A["qr_code"])
check(d.get("result") == "DENIED" and "not open yet" in (d.get("reason") or ""),
      "before the event, the door refuses the badge", d)

# ── 2. rehearsal on: the same badge is admitted ───────────────────────────
st, r = rehearsal(FUTURE, True)
check(st == 200 and r.get("door_test_mode") is True, "rehearsal can be switched on", (st, r))
d = scan(FUTURE, A["qr_code"])
check(d.get("result") == "GRANTED" and d.get("granted") is True,
      "with rehearsal on, a valid badge is admitted", d)
check(d.get("rehearsal") is True,
      "and the decision says plainly that it was a rehearsal", d)
check(sql("SELECT is_checked_in FROM attendees WHERE id=?", (A["attendee_id"],))[0][0] == 1,
      "the check-in really happens, so the flow is genuinely tested")

row = sql("SELECT result, reason FROM scan_logs WHERE event_id=? ORDER BY id DESC LIMIT 1", (FUTURE,))
check(row and "REHEARSAL" in (row[0][1] or ""),
      "and the history marks it REHEARSAL, so it cannot read as real attendance", row)

# ── 3. rehearsal waives the CALENDAR and nothing else ─────────────────────
d = scan(FUTURE, O["qr_code"])
check(d.get("result") == "DENIED",
      "another event's badge is still refused during a rehearsal", d)

d = scan(FUTURE, D["qr_code"])
check(d.get("granted") is not True,
      "a single-day pass is still refused on the wrong day", d)

call("POST", "/identity/refund-ticket", {"event_id": FUTURE, "order_id": "zz-reh-o2",
                                         "amount": 99.0, "amount_refunded": 99.0}, SVC)
d = scan(FUTURE, B["qr_code"])
check(d.get("result") == "DENIED" and "REFUND" in (d.get("reason") or "").upper(),
      "a refunded ticket is still refused during a rehearsal", d)

# ── 4. anti-passback still applies (the line that used to crash) ──────────
d = scan(FUTURE, A["qr_code"])
check(d.get("result") == "LIMITED" and "already checked in" in (d.get("reason") or "").lower(),
      "a second scan of the same badge is still stopped, not a 500", d)

# ── 5. switching rehearsal off closes the door again ──────────────────────
rehearsal(FUTURE, False)
d = scan(FUTURE, D["qr_code"])
check(d.get("result") == "DENIED" and "not open yet" in (d.get("reason") or ""),
      "turning rehearsal off restores the calendar gate", d)

# ── 6. an event that is running is unaffected either way ──────────────────
NOW = make("running", 0)
TT_NOW = ticket(NOW, "ZZ GA", "zz-reh-now")
N = attendee(NOW, TT_NOW, "zz-reh-now@example.invalid", "zz-reh-o5")
d = scan(NOW, N["qr_code"])
check(d.get("result") == "GRANTED" and not d.get("rehearsal"),
      "a live event admits normally, with no rehearsal flag", d)

# ── 7. clearing the history ───────────────────────────────────────────────
before = sql("SELECT COUNT(*) FROM scan_logs WHERE event_id=?", (FUTURE,))[0][0]
check(before > 0, "the rehearsal left scans behind", before)
st, r = call("DELETE", "/events/%d/scan-logs" % FUTURE, token=ADMIN)
check(st == 200 and r.get("cleared") == before, "they can be cleared in one action", (st, r))
check(sql("SELECT COUNT(*) FROM scan_logs WHERE event_id=?", (FUTURE,))[0][0] == 0,
      "and the history is empty afterwards")
check(sql("SELECT COUNT(*) FROM scan_logs WHERE event_id=?", (NOW,))[0][0] > 0,
      "while another event's history is untouched")
check(sql("SELECT is_checked_in FROM attendees WHERE id=?", (A["attendee_id"],))[0][0] == 1,
      "clearing the log does not un-check anyone in")

# ── cleanup ───────────────────────────────────────────────────────────────
for ev in (FUTURE, OTHER, NOW):
    write("DELETE FROM ticket_mappings WHERE event_id=?", (ev,))
    call("DELETE", "/events/%d" % ev, token=ADMIN)
write("DELETE FROM member_cards WHERE email LIKE 'zz-reh-%'")
left = sql("SELECT COUNT(*) FROM attendees WHERE email LIKE 'zz-reh-%'")
check(left[0][0] == 0, "the throwaway events and their people are gone afterwards", left)

print("\n%d checks, %d failed" % (18, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
