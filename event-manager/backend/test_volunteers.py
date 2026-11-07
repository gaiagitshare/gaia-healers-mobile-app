# -*- coding: utf-8 -*-
"""VOLUNTEER SCHEDULING (7 Nov 2026).

On a testbed copy: the SignUpGenius schedule loads once and only once, a
volunteer's private link shows the schedule without anybody's contact details,
nobody can take a place that is not there (not even two people at the same
instant), nobody holds two overlapping shifts, requests hold a place until an
admin decides, volunteers change only their own shifts, links can be switched
off, and volunteers can reach nothing else in the Event Manager.
Run:  python3 /root/event/backend/test_volunteers.py
"""
import json, os, secrets, sqlite3, subprocess, sys, threading, urllib.error, urllib.request

HERE = "/root/event/backend"
sys.path.insert(0, HERE)
import testbed
BASE, DB = testbed.start()
import main                                                    # noqa: E402

ADMIN = {"Authorization": "Bearer " + main.create_access_token({"sub": "1", "adm": True})}
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
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode()
            try: return r.status, json.loads(raw or "null")
            except Exception: return r.status, raw
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b

db = sqlite3.connect(DB, timeout=30)
EV = 1
TAG = secrets.token_hex(3)
before = (db.execute("select count(*), group_concat(id||coalesce(email,'')||coalesce(qr_code,'')) from attendees").fetchone(),
          db.execute("select count(*), coalesce(sum(amount),0) from payment_events").fetchone(),
          db.execute("select count(*) from exhibitors").fetchone())

print("\n== the SignUpGenius schedule ==")
call("GET", "/events/%d/volunteers/overview" % EV)          # tables exist
env = dict(os.environ, DATABASE_URL="sqlite:///" + DB, EVENT_AUTO_SYNC_URLS="", GAIA_PROXY_BASE_URL="http://127.0.0.1:9")
fixture = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools", "volunteers_signup_fixture.txt")
args = [sys.executable, HERE + "/tools/volunteers_elevate_2026.py", "--apply"] + (["--signups", fixture] if os.path.exists(fixture) else [])
r1 = subprocess.run(args, env=env, capture_output=True, text=True, timeout=300).stdout
r2 = subprocess.run(args, env=env, capture_output=True, text=True, timeout=300).stdout
st, ov = call("GET", "/events/%d/volunteers/overview" % EV)
check(st == 200 and ov["stats"]["shifts"] == 61 and ov["stats"]["positions"] == 144,
      "61 shifts and 144 places over four days, as on SignUpGenius", (st, ov.get("stats") if isinstance(ov, dict) else ov))
check("shifts_added': 0" in r2 and "bookings_added': 0" in r2, "loading it again adds nothing twice", r2[-300:])
days = sorted({s["day"] for s in ov["shifts"]})
check(days == ["2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"], "Thursday setup through Sunday", days)
if os.path.exists(fixture):
    imp = [p for s in ov["shifts"] for p in s["people"] if p["status"] == "confirmed"]
    check(len(imp) == 2, "the existing SignUpGenius sign-ups come in as confirmed", imp)
    check(any(v["needs_review"] for v in ov["volunteers"]), "imported people without contact details are flagged for review", None)
reg = next(s for s in ov["shifts"] if s["day"] == "2026-11-20" and s["role"] == "Registration" and s["start_time"] == "08:00")
check(reg["start_time"] == "08:00" and reg["end_time"] == "11:00" and reg["capacity"] == 4,
      "times are the event's own wall-clock (8:00-11:00 Orlando), stored as written", reg)

print("\n== volunteers and their links ==")
def add(name):
    st, r = call("POST", "/events/%d/volunteers" % EV, {"first_name": name, "last_name": "Tester%s" % TAG,
                                                        "email": "zz-%s-%s@example.invalid" % (name.lower(), TAG), "phone": "+10000000000"})
    assert st == 200, (st, r)
    return r["id"], r["token"]
A, ta = add("Ann"); B, tb = add("Ben"); C, tc = add("Cleo")
st, me = call("GET", "/volunteer/%s" % ta, headers={})
check(st == 200 and me["me"]["first_name"] == "Ann" and len(me["shifts"]) == 61, "a private link opens that volunteer's schedule", st)
check("example.invalid" not in json.dumps(me) and "+1000" not in json.dumps(me), "no email or phone of anybody appears on it", None)
st, _ = call("GET", "/volunteer/%s" % ("x" * 32), headers={})
check(st == 404, "a made-up link opens nothing", st)

def shift(day, a, b, role, cap, lead=False):
    st, r = call("POST", "/events/%d/volunteer-shifts" % EV, {"day": day, "start_time": a, "end_time": b, "role": role + TAG,
                                                              "capacity": cap, "lead_role": lead})
    assert st == 200, (st, r)
    return r["id"]
req = lambda tok, sid: call("POST", "/volunteer/%s/request" % tok, {"shift_id": sid}, headers={})

print("\n== nobody takes a place that is not there ==")
last = shift("2026-11-20", "06:00", "07:00", "Last place", 1)
res = []
def grab(tok):
    res.append(req(tok, last)[0])
ts = [threading.Thread(target=grab, args=(t,)) for t in (ta, tb, tc, ta, tb, tc)]
[t.start() for t in ts]; [t.join() for t in ts]
held = db.execute("select count(*) from volunteer_bookings where shift_id=? and status in ('requested','confirmed')", (last,)).fetchone()[0]
check(res.count(200) == 1 and held == 1, "six requests for the last place at the same instant: exactly one gets it", (sorted(res), held))

two = shift("2026-11-21", "06:00", "07:00", "Two places", 2)
check(req(ta, two)[0] == 200 and req(tb, two)[0] == 200, "requests hold places straight away", None)
st, r = req(tc, two)
check(st == 409 and "full" in str(r).lower(), "a shift whose places are all requested is full for the next person", (st, r))
ann_b = db.execute("select id from volunteer_bookings where shift_id=? and volunteer_id=?", (two, A)).fetchone()[0]
st, _ = call("PATCH", "/events/%d/volunteer-bookings/%d" % (EV, ann_b), {"status": "declined"})
check(st == 200 and req(tc, two)[0] == 200, "an admin declines a request and the place is free again", st)

print("\n== no overlapping shifts ==")
m = shift("2026-11-22", "09:00", "12:00", "Morning", 3)
o = shift("2026-11-22", "10:00", "14:00", "Overlap", 3)
n = shift("2026-11-22", "12:00", "15:00", "Next", 3)
lead = shift("2026-11-22", "08:00", "18:00", "Lead", 2, lead=True)
check(req(ta, m)[0] == 200, "Ann takes 9-12", None)
st, r = req(ta, o)
check(st == 409 and "overlap" in str(r).lower(), "Ann cannot also take 10-14", (st, r))
check(req(ta, n)[0] == 200, "but can take 12-3 straight after", None)
check(req(ta, lead)[0] == 200, "an all-day lead role does not block other shifts", None)
st, r = req(ta, m)
check(st == 409, "nor take the same shift twice", st)

print("\n== volunteers change only their own shifts ==")
mine = db.execute("select id from volunteer_bookings where shift_id=? and volunteer_id=?", (n, A)).fetchone()[0]
st, _ = call("POST", "/volunteer/%s/cancel" % tb, {"booking_id": mine}, headers={})
check(st == 404, "Ben cannot cancel Ann's shift", st)
st, _ = call("POST", "/volunteer/%s/cancel" % ta, {"booking_id": mine}, headers={})
check(st == 200 and db.execute("select status from volunteer_bookings where id=?", (mine,)).fetchone()[0] == "cancelled",
      "Ann cancels her own shift; the place is free again", st)
st, me = call("GET", "/volunteer/%s" % ta, headers={})
statuses = {b["shift"]["id"]: b["status"] for b in me["my_bookings"]}
check(statuses.get(two) == "declined" and statuses.get(m) == "requested", "Ann sees the status of each of her requests", statuses)
other = next(s for s in me["shifts"] if s["id"] == two)
check(any(p["name"] == "Ben T." for p in other["people"]), "others appear by first name and last initial", other["people"])

print("\n== admins: approve, move, assign, capacity ==")
ann_m = db.execute("select id from volunteer_bookings where shift_id=? and volunteer_id=? and status='requested'", (m, A)).fetchone()[0]
st, r = call("PATCH", "/events/%d/volunteer-bookings/%d" % (EV, ann_m), {"status": "confirmed"})
check(st == 200 and r["status"] == "confirmed", "an admin approves a request", (st, r))
st, r = call("PATCH", "/events/%d/volunteer-bookings/%d" % (EV, ann_m), {"move_to_shift_id": o})
check(st == 200 and r["shift_id"] == o, "an admin moves Ann to another shift (nothing else of hers overlaps it)", (st, r))
full1 = shift("2026-11-19", "10:00", "11:00", "Tiny", 1)
call("POST", "/events/%d/volunteer-bookings" % EV, {"shift_id": full1, "volunteer_id": B})
st, r = call("POST", "/events/%d/volunteer-bookings" % EV, {"shift_id": full1, "volunteer_id": C})
check(st == 409, "even an admin cannot overbook a full shift", (st, r))
st, r = call("PATCH", "/events/%d/volunteer-shifts/%d" % (EV, full1), {"capacity": 2})
check(st == 200 and call("POST", "/events/%d/volunteer-bookings" % EV, {"shift_id": full1, "volunteer_id": C})[0] == 200,
      "raise the places, then assign", (st, r))
st, r = call("PATCH", "/events/%d/volunteer-shifts/%d" % (EV, full1), {"capacity": 1})
check(st == 409, "places cannot drop below the people already on it", (st, r))

print("\n== links and the team ==")
st, r = call("PATCH", "/events/%d/volunteers/%d" % (EV, B), {"new_link": True})
check(st == 200 and call("GET", "/volunteer/%s" % tb, headers={})[0] == 404 and call("GET", "/volunteer/%s" % r["token"], headers={})[0] == 200,
      "a new link replaces the old one", st)
st, r = call("PATCH", "/events/%d/volunteers/%d" % (EV, C), {"status": "rejected"})
check(st == 200 and r["released"] >= 1 and call("GET", "/volunteer/%s" % tc, headers={})[0] == 404,
      "removing a volunteer releases their places and switches off their link", r)

print("\n== joining through the general link ==")
st, r = call("PUT", "/events/%d/volunteers/program" % EV, {"join_open": False, "new_join_link": True})
jt = r["join_token"]
st, r = call("POST", "/volunteer-join/%s" % jt, {"first_name": "Dee", "last_name": "New", "email": "zz-dee-%s@example.invalid" % TAG, "phone": "1"}, headers={})
check(st == 409, "a closed sign-up link takes nobody", st)
call("PUT", "/events/%d/volunteers/program" % EV, {"join_open": True})
st, r = call("POST", "/volunteer-join/%s" % jt, {"first_name": "Dee", "last_name": "New", "email": "zz-dee-%s@example.invalid" % TAG, "phone": "1"}, headers={})
check(st == 200 and r.get("token"), "an open link: the new volunteer gets their own page straight away", (st, r))
dee = db.execute("select status from volunteers where email=?", ("zz-dee-%s@example.invalid" % TAG,)).fetchone()
check(dee and dee[0] == "pending", "and waits for approval", dee)
st, r = call("POST", "/volunteer-join/%s" % jt, {"first_name": "Mallory", "last_name": "X", "email": "zz-ann-%s@example.invalid" % TAG.lower(), "phone": "1"}, headers={})
check(st == 200 and not r.get("token") and r.get("duplicate"), "signing up with somebody else's email never hands out their link", r)

print("\n== volunteers reach nothing else ==")
VTOK = {"Authorization": "Bearer " + ta}
for path in ("/events/%d/attendees" % EV, "/events/%d/volunteers/overview" % EV, "/events/%d/exhibitors" % EV,
             "/events/%d/review-queue" % EV, "/events/%d/payments" % EV):
    st, _ = call("GET", path, headers=VTOK)
    check(st in (401, 403), "a volunteer link is not a login: %s refused" % path, st)
door = db.execute("select u.id from users u join event_roles r on r.user_id=u.id where r.role='checkin_staff' limit 1").fetchone()
if door:
    st, _ = call("GET", "/events/%d/volunteers/overview" % EV, headers={"Authorization": "Bearer " + main.create_access_token({"sub": str(door[0])})})
    check(st == 403, "door staff cannot manage volunteers", st)
st, _ = call("GET", "/events/%d/volunteers/overview" % EV, headers={})
check(st == 401, "nobody without a login", st)
st, csv_ = call("GET", "/events/%d/volunteers/export.csv" % EV)
check(st == 200 and "Day,Start,End,Role" in str(csv_), "admins export the schedule", st)
logs = db.execute("select actor, action from volunteer_log where action in ('requested','booking_updated','assigned') limit 50").fetchall()
check(any(a.startswith("volunteer:") for a, _ in logs) and any(not a.startswith("volunteer:") for a, _ in logs),
      "every change records who made it", logs[:4])

print("\n== nothing else changed ==")
after = (db.execute("select count(*), group_concat(id||coalesce(email,'')||coalesce(qr_code,'')) from attendees").fetchone(),
         db.execute("select count(*), coalesce(sum(amount),0) from payment_events").fetchone(),
         db.execute("select count(*) from exhibitors").fetchone())
check(after == before, "tickets, payments and stands untouched", None)

print("\n%d check(s) failed" % len(fails) if fails else "\nALL CHECKS PASSED")
sys.exit(1 if fails else 0)
