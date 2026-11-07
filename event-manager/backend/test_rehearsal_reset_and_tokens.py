# -*- coding: utf-8 -*-
"""REHEARSAL LEAVES NOBODY CHECKED IN, AND EVERY TICKET HAS ITS OWN BADGE.

Two findings of the 7 Nov 2026 audits:
  * rehearsal scans really check people in, and ending rehearsal left them
    checked in -- on opening day they would hear "already checked in";
  * two live tickets under one email shared one badge token, so the second
    ticket's printed badge opened the first ticket at the door.
Synthetic attendees on a testbed copy only.
Run:  python3 /root/event/backend/test_rehearsal_reset_and_tokens.py
"""
import json, secrets, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime

HERE = "/root/event/backend"
sys.path.insert(0, HERE)
import testbed
BASE, DB = testbed.start()
import main, models, badge_card                                # noqa: E402
from database import SessionLocal                              # noqa: E402

ADMIN = {"Authorization": "Bearer " + main.create_access_token({"sub": "1"})}
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, headers=ADMIN):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b

db = sqlite3.connect(DB, timeout=30)
EV = 1
now = datetime.utcnow().isoformat(" ")
ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
def ticket(email, status="registered", token=True):
    qr = "ATT-" + secrets.token_hex(6).upper()
    cur = db.execute("insert into attendees(event_id,email,first_name,last_name,qr_code,is_checked_in,registration_status,"
                     "created_at,ticket_type_id,public_token,custom_data,badge_print_count) values(?,?,?,?,?,0,?,?,7,?,'{}',0)",
                     (EV, email, "Zz", "Rehearsal", qr, status, now,
                      "".join(secrets.choice(ALPHA) for _ in range(8)) if token else None))
    db.commit()
    return cur.lastrowid, qr

print("\n== a rehearsal check-in is reset when rehearsal ends ==")
event_day = db.execute("select date(start_date) from events where id=?", (EV,)).fetchone()[0]
if datetime.utcnow().date().isoformat() >= event_day:
    print("  SKIP  only meaningful before the event's first day")
else:
    st, _ = call("POST", "/events/%d/door-test-mode" % EV, {"enabled": True})
    check(st == 200, "rehearsal switched on", st)
    pid, pqr = ticket("zz-practice-%s@example.invalid" % secrets.token_hex(3))
    st, d = call("POST", "/events/%d/authorize" % EV, {"qr_code": pqr, "access_type": "EVENT_ENTRY"})
    check(d.get("result") == "GRANTED" and d.get("rehearsal"), "a practice scan admits, marked as rehearsal", d.get("reason"))
    real_id, _ = ticket("zz-realday-%s@example.invalid" % secrets.token_hex(3))
    db.execute("update attendees set is_checked_in=1, checked_in_at=? where id=?", (event_day + " 15:00:00", real_id))
    db.commit()
    st, p = call("GET", "/events/%d/rehearsal-checkins" % EV)
    check(st == 200 and p.get("count", 0) >= 1, "the preview counts the practice check-in", p)
    st, out = call("POST", "/events/%d/rehearsal-reset" % EV)
    check(st == 200 and out.get("reset", 0) >= 1, "reset reports what it undid", out)
    row = db.execute("select is_checked_in, checked_in_at, badge_print_count from attendees where id=?", (pid,)).fetchone()
    check(row[0] == 0 and row[1] is None, "the practice visitor is no longer checked in", row)
    log = db.execute("select result, reason from scan_logs where attendee_id=? order by id desc limit 1", (pid,)).fetchone()
    check(log and log[0] == "UNDO" and "Rehearsal reset" in (log[1] or ""), "the reset is logged as an UNDO", log)
    check(db.execute("select is_checked_in from attendees where id=?", (real_id,)).fetchone()[0] == 1,
          "a check-in dated on an event day is never touched", real_id)
    st, _ = call("POST", "/events/%d/door-test-mode" % EV, {"enabled": False})
    d = call("POST", "/events/%d/authorize" % EV, {"qr_code": pqr, "access_type": "EVENT_ENTRY", "at": event_day})[1]
    # The date override only works where ALLOW_SCAN_TIME_OVERRIDE is set; the
    # point is the same either way: nothing says "already checked in" any more.
    check("already checked in" not in (d.get("reason") or "").lower(),
          "after the reset the practised visitor is not 'already checked in'", d.get("reason"))
    st, _ = call("POST", "/events/%d/rehearsal-reset" % EV, None, headers={})
    check(st == 401, "nobody resets without logging in", st)

print("\n== every live ticket in an event gets its own badge token ==")
email = "zz-two-tickets-%s@example.invalid" % secrets.token_hex(3)
t1, _ = ticket(email, token=False)
t2, _ = ticket(email, token=False)
s = SessionLocal()
a1 = s.get(models.Attendee, t1); a2 = s.get(models.Attendee, t2)
k1 = badge_card.ensure_public_token(s, models, a1)
k2 = badge_card.ensure_public_token(s, models, a2)
check(k1 and k2 and k1 != k2, "two live tickets under one email: two different badge tokens", (k1, k2))
email2 = "zz-reissue-%s@example.invalid" % secrets.token_hex(3)
r1, _ = ticket(email2, status="revoked")
r2, _ = ticket(email2, token=False)
old = db.execute("select public_token from attendees where id=?", (r1,)).fetchone()[0]
s.expire_all()
k3 = badge_card.ensure_public_token(s, models, s.get(models.Attendee, r2))
check(k3 == old, "a ticket re-issued after a revocation keeps the person's badge token", (k3, old))
s.close()

print("\n== per-day admission for a three-day event ==")
# Scan rows as the door writes them, on two event days (event timezone is
# America/New_York; 15:00 UTC is 10:00 at the venue). One person comes Friday,
# steps out and back (2 entries), and returns Saturday; a rehearsal row is not
# attendance.
pa, _ = ticket("zz-days-a-%s@example.invalid" % secrets.token_hex(3))
pb, _ = ticket("zz-days-b-%s@example.invalid" % secrets.token_hex(3))
rows = [(pa, "2026-11-20 15:00:00", "GRANTED", "admitted"), (pa, "2026-11-20 18:00:00", "GRANTED", "admitted"),
        (pa, "2026-11-21 15:00:00", "GRANTED", "admitted"), (pb, "2026-11-20 16:00:00", "OVERRIDE", "override"),
        (pb, "2026-11-20 16:30:00", "GRANTED", "REHEARSAL \u2014 practice"), (pb, "2026-11-21 16:00:00", "DENIED", "x")]
for aid, at, res, why in rows:
    db.execute("insert into scan_logs(event_id,attendee_id,qr_code,access_type,result,reason,created_at) values(?,?,?,?,?,?,?)",
               (EV, aid, "x", "EVENT_ENTRY", res, why, at))
db.commit()
st, d = call("GET", "/events/%d/daily-admissions" % EV)
days = {x["day"]: x for x in (d or {}).get("days", [])}
fri, sat = days.get("2026-11-20", {}), days.get("2026-11-21", {})
check(st == 200 and fri.get("people", 0) >= 2 and fri.get("re_entries", 0) >= 1,
      "Friday: both people counted once, the step-out counted as a re-entry", fri)
check(sat.get("people", 0) >= 1, "Saturday: the returning visitor counts again on day two", sat)
check(st == 200 and d.get("allow_reentry") is False, "the report says re-entry is still off (not activated)", d.get("allow_reentry"))

print("\n%d check(s) failed" % len(fails) if fails else "\nALL CHECKS PASSED")
sys.exit(1 if fails else 0)
