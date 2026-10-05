# -*- coding: utf-8 -*-
"""PRINTER LOG — what a door device's Bluetooth printer did, readable from here.

Proves, against a served copy of the live database:
  1. a desk (checkin_staff) can report a connect failure with its driver trace
  2. the same attempt id re-sent is stored once
  3. bad stage/result values are refused
  4. the trace is bounded (newest 150 lines, 300 characters each)
  5. organizers read it back with the trace and the device; a desk cannot
  6. a desk connecting to a printer another desk used today is told which desk
  7. the dashboard's printer-status: a row per desk, failures first, clashes named

Run:  python3 /root/event/backend/test_printer_log.py
"""
import json, urllib.request, urllib.error, sqlite3, sys, uuid

env = {}
for line in open("/root/event/backend/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
import sys as _sys; _sys.path.insert(0, "/root/event/backend")
import testbed
BASE, DB = testbed.start()
EVENT = 1

def call(method, path, body=None, token=None, ua=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if ua: req.add_header("User-Agent", ua)
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or "null")
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + str(extra))))
    if not cond: fails += 1

print("PRINTER LOG")
c = sqlite3.connect(DB)
row = c.execute("SELECT r.user_id FROM event_roles r JOIN users u ON u.id = r.user_id "
                "WHERE r.event_id=? AND r.role='checkin_staff' AND u.is_admin=0 LIMIT 1", (EVENT,)).fetchone()
DESK = jwt.encode({"sub": str(row[0])}, env["SECRET_KEY"], algorithm="HS256") if row else None
check(DESK is not None, "a non-admin door desk exists to report as")

# 1 ── a desk reports a connect that never answered
aid = "test-" + uuid.uuid4().hex
UA = "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) Bluefy/3.9.3 test"
body = {"stage": "connect", "result": "failed", "station": "test-desk",
        "error": "ConnectTimeout: The printer did not answer.",
        "trace": ["20:06:16 Niimbot 2.6.0 — connecting (task=b1)", 'picked "B1 Pro-H123"'],
        "client_attempt_id": aid}
st, b = call("POST", "/events/%d/printer-log" % EVENT, body, DESK, UA)
check(st == 200 and b.get("already") is False, "desk reports a connect failure", (st, b))
# 2 ── once per attempt
st, b = call("POST", "/events/%d/printer-log" % EVENT, body, DESK, UA)
check(st == 200 and b.get("already") is True, "the same attempt id is stored once", (st, b))
n = c.execute("SELECT count(*) FROM printer_logs WHERE client_attempt_id=?", (aid,)).fetchone()[0]
check(n == 1, "one row for the attempt", n)
# 3 ── refused values
st, _ = call("POST", "/events/%d/printer-log" % EVENT, {"stage": "dance", "result": "ok"}, DESK)
check(st == 400, "an unknown stage is refused", st)
st, _ = call("POST", "/events/%d/printer-log" % EVENT, {"stage": "print", "result": "printed"}, DESK)
check(st == 400, "an unknown result is refused", st)
st, _ = call("POST", "/events/%d/printer-log" % EVENT, {"stage": "print", "result": "ok"})
check(st == 401, "no token, no report", st)
# 4 ── bounded
aid2 = "test-" + uuid.uuid4().hex
st, _ = call("POST", "/events/%d/printer-log" % EVENT,
             {"stage": "print", "result": "ok", "station": "test-desk", "client_attempt_id": aid2,
              "trace": ["line %d %s" % (i, "x" * 400) for i in range(400)]}, ADMIN)
t = c.execute("SELECT trace FROM printer_logs WHERE client_attempt_id=?", (aid2,)).fetchone()[0].split("\n")
check(st == 200 and len(t) == 150 and t[-1].startswith("line 399") and max(map(len, t)) <= 300,
      "the trace keeps the newest 150 lines of at most 300 characters", (st, len(t)))
# 5 ── read back
st, rows = call("GET", "/events/%d/printer-log?limit=10" % EVENT, None, ADMIN)
mine = [r for r in (rows or []) if r.get("station") == "test-desk" and r.get("stage") == "connect"]
check(st == 200 and mine and mine[0]["error"].startswith("ConnectTimeout") and "Bluefy" in (mine[0]["user_agent"] or "")
      and mine[0]["trace"][-1].startswith("picked") and mine[0]["by"], "an organizer reads it back with trace, device and person", (st, rows))
st, rows = call("GET", "/events/%d/printer-log?failed_only=true" % EVENT, None, ADMIN)
check(st == 200 and all(r["result"] == "failed" for r in rows), "failed_only shows failures only", rows)
st, _ = call("GET", "/events/%d/printer-log" % EVENT, None, DESK)
check(st == 403, "a door desk cannot read everyone's traces", st)

# 6 ── one printer, two desks: the second desk is told who else has it
dev = "B1 Pro-TEST" + uuid.uuid4().hex[:6]
ids = ["test-" + uuid.uuid4().hex for _ in range(4)]
st, b = call("POST", "/events/%d/printer-log" % EVENT, {"stage": "connect", "result": "ok", "station": "test-desk-1",
             "device": dev, "client_attempt_id": ids[0]}, DESK, UA)
check(st == 200 and b.get("shared_with") == [], "the first desk on a printer hears nothing", (st, b))
st, b = call("POST", "/events/%d/printer-log" % EVENT, {"stage": "connect", "result": "ok", "station": "test-desk-1",
             "device": dev, "client_attempt_id": ids[1]}, DESK, UA)
check(st == 200 and b.get("shared_with") == [], "reconnecting the same desk is not a clash", (st, b))
st, b = call("POST", "/events/%d/printer-log" % EVENT, {"stage": "connect", "result": "ok", "station": "test-desk-2",
             "device": dev, "client_attempt_id": ids[2]}, ADMIN)
check(st == 200 and [r["station"] for r in b.get("shared_with", [])] == ["test-desk-1"],
      "a second desk is told the first desk has this printer", (st, b))
st, b = call("POST", "/events/%d/printer-log" % EVENT, {"stage": "connect", "result": "failed", "station": "test-desk-3",
             "device": "B1 Pro-OTHER", "client_attempt_id": ids[3]}, ADMIN)
check(st == 200 and b.get("shared_with") == [], "a different printer is nobody else's", (st, b))
st, rows = call("GET", "/events/%d/printer-log?limit=5" % EVENT, None, ADMIN)
check(st == 200 and any(r.get("device") == dev for r in rows), "the printer's name is read back", rows)

# 7 ── the dashboard's view: one row per desk, the clash called out by name
st, ps = call("GET", "/events/%d/printer-status?hours=1" % EVENT, None, ADMIN)
rows = {d["station"]: d for d in (ps or {}).get("desks", [])}
d1, d2, d3 = rows.get("test-desk-1"), rows.get("test-desk-2"), rows.get("test-desk-3")
check(st == 200 and d1 and d2 and d3, "each desk is a row", (st, ps))
check(d1 and d1["device"] == dev and d1["status"] == "ok" and d1["browser"] == "iPad/Bluefy",
      "a desk shows its printer, its browser and that it is fine", d1)
check(d3 and d3["status"] == "failed" and d3["connect_failed"] == 1 and d3["last_failure"]["stage"] == "connect",
      "a failing desk shows as failed, with the failure", d3)
check(d1 and d1["shares_printer_with"] == ["test-desk-2"] and d2["shares_printer_with"] == ["test-desk-1"],
      "two desks on one printer are told about each other", (d1, d2))
check(any(s_["device"] == dev and s_["desks"] == ["test-desk-1", "test-desk-2"] for s_ in ps.get("shared_printers", [])),
      "the shared printer is listed once, with both desks", ps.get("shared_printers"))
check(ps["desks"][0]["status"] == "failed", "failing desks come first", [d["station"] for d in ps["desks"]])
st, _ = call("GET", "/events/%d/printer-status" % EVENT, None, DESK)
check(st == 403, "a door desk cannot read the dashboard view", st)

c.execute("DELETE FROM printer_logs WHERE client_attempt_id IN (%s)" % ",".join("?" * 6), [aid, aid2] + ids); c.commit()
print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
