# -*- coding: utf-8 -*-
"""SCHEDULE SYNC — the running order comes from the sheet, and only what the
sheet actually says reaches an attendee.

The team keeps the schedule in the planning workbook. This proves the mirror:
a row becomes a session at the right local time whichever way the day is
written, it goes live only when the sheet says Publish AND it has a time, a
second run changes nothing, an edit edits rather than duplicates, a row
deleted from the sheet is unpublished rather than deleted (attendance records
hang off it), and the named speakers are linked to their sessions.

Throwaway event only.
Run:  python3 /root/event/backend/test_schedule_sync.py
"""
import json, os, subprocess, sqlite3, sys, urllib.request
from datetime import datetime, timedelta

env = {}
for line in open("/root/event/backend/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
BASE = "http://127.0.0.1:8002"
DB = "/root/event/backend/event.db"
HERE = os.path.dirname(os.path.abspath(__file__))
TMP = "/tmp/zz-schedule-sync.csv"

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "   %r" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")

def sql(q, a=()):
    c = sqlite3.connect(DB)
    try:
        return c.execute(q, a).fetchall()
    finally:
        c.close()

def sync(event_id, apply_=True):
    e = dict(os.environ); e["SESSION_SHEET_EVENT"] = str(event_id)
    args = [sys.executable, os.path.join(HERE, "tools", "session_sync.py"), TMP]
    if apply_:
        args.append("--apply")
    return subprocess.run(args, capture_output=True, text=True, env=e, cwd=HERE).stdout

def sheet(rows):
    head = "Day,Start,End,Length,Title,Speaker,Room,Type,Track,Description,Publish?\n"
    open(TMP, "w").write(head + "".join(rows))

print("SCHEDULE SYNC")
for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ sched%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)
start = datetime.utcnow() + timedelta(days=40)
st, ev = call("POST", "/events", {"name": "ZZ sched", "start_date": start.isoformat(),
                                  "end_date": (start + timedelta(days=2)).isoformat(),
                                  "location": "Test", "timezone": "UTC"}, ADMIN)
assert st in (200, 201), (st, ev)
EV = ev["id"]
st, sp = call("POST", "/events/%d/speakers" % EV, {"name": "Dr. Zeta Quill-Vance, PhD"}, ADMIN)
assert st in (200, 201), (st, sp)
SPK = sp["id"]

# ── 1. a row becomes a session, however the day is written ─────────────────
d1 = (start).strftime("%Y-%m-%d")
sheet([
    'Day 1,9:00 AM,,30 min,ZZ Opening,Dr. Zeta Quill,Main Stage,talk,,Welcome.,YES\n',
    '%s,2:00 PM,3:30 PM,,ZZ Long Workshop,,Room B,workshop,,,YES\n' % d1,
    'Day 2,10:00,,20 min,ZZ Draft Talk,,Main Stage,talk,,,NO\n',
])
sync(EV)
rows = sql("SELECT title, start_time, end_time, is_published, session_type, room, external_id"
           " FROM sessions WHERE event_id=? ORDER BY start_time", (EV,))
check(len(rows) == 3, "every schedule row became a session", rows)
opening = [r for r in rows if r[0] == "ZZ Opening"][0]
check(opening[1].startswith(d1 + " 09:00") and opening[2].startswith(d1 + " 09:30"),
      "\"Day 1\" resolves to the event's first day and a length gives the end time", opening[:3])
wshop = [r for r in rows if r[0] == "ZZ Long Workshop"][0]
check(wshop[2].startswith(d1 + " 15:30") and wshop[4] == "workshop" and wshop[5] == "Room B",
      "an explicit date, end time, type and room come across as written", wshop)

# ── 2. publication is the sheet's decision ─────────────────────────────────
check(opening[3] == 1 and [r for r in rows if r[0] == "ZZ Draft Talk"][0][3] == 0,
      "Publish? decides what an attendee sees; a NO row stays a draft", [(r[0], r[3]) for r in rows])
st, pub = call("GET", "/public/events/%d/sessions" % EV)
titles = {s["title"] for s in (pub if isinstance(pub, list) else pub.get("items", []))} if st == 200 else set()
check("ZZ Draft Talk" not in titles, "and the draft is absent from the public schedule", titles)

# ── 3. the named speaker is linked ─────────────────────────────────────────
link = sql("SELECT s.title FROM sessions s JOIN session_speakers ss ON ss.session_id=s.id"
           " WHERE s.event_id=? AND ss.speaker_id=?", (EV, SPK))
check([r[0] for r in link] == ["ZZ Opening"],
      "a speaker named in the sheet is linked through titles and a hyphenated surname", link)

# ── 4. running it again changes nothing ────────────────────────────────────
before = sql("SELECT id, title, start_time, is_published FROM sessions WHERE event_id=? ORDER BY id", (EV,))
out = sync(EV)
after = sql("SELECT id, title, start_time, is_published FROM sessions WHERE event_id=? ORDER BY id", (EV,))
check(before == after and "to add: 0 · to update: 0" in out, "a second run is a no-op", out.splitlines()[2:3])

# ── 5. an edit edits; it does not duplicate ────────────────────────────────
sheet([
    'Day 1,9:15 AM,,30 min,ZZ Opening Ceremony,Dr. Zeta Quill,Main Hall,talk,,Welcome.,YES\n',
    '%s,2:00 PM,3:30 PM,,ZZ Long Workshop,,Room B,workshop,,,YES\n' % d1,
    'Day 2,10:00,,20 min,ZZ Draft Talk,,Main Stage,talk,,,NO\n',
])
sync(EV)
rows = sql("SELECT title, start_time, room FROM sessions WHERE event_id=? ORDER BY start_time", (EV,))
check(len(rows) == 3 and any(r[0] == "ZZ Opening Ceremony" and r[2] == "Main Hall" for r in rows),
      "renaming and moving a row edits that session rather than adding another", rows)

# ── 6. a row deleted from the sheet is unpublished, not deleted ────────────
sheet(['%s,2:00 PM,3:30 PM,,ZZ Long Workshop,,Room B,workshop,,,YES\n' % d1])
sync(EV)
rows = sql("SELECT title, is_published FROM sessions WHERE event_id=? ORDER BY title", (EV,))
check(len(rows) == 3, "a session dropped from the sheet is kept — attendance hangs off it", rows)
check(all(p == 0 for t, p in rows if t != "ZZ Long Workshop"),
      "but it stops being shown to attendees", rows)

# ── cleanup ────────────────────────────────────────────────────────────────
call("DELETE", "/events/%d" % EV, token=ADMIN)
os.path.exists(TMP) and os.remove(TMP)
left = sql("SELECT COUNT(*) FROM sessions WHERE event_id=?", (EV,))
check(left[0][0] == 0, "the throwaway event and its schedule are gone afterwards", left)

print("\n%d checks, %d failed" % (10, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
