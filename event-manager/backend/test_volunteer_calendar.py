"""VOLUNTEER SCHEDULE REMINDER + CALENDAR FEED (17 Nov 2026), with a FAKE mailer.

  * a volunteer's feed holds exactly their CONFIRMED shifts, at the right
    instant (Orlando wall clock -> UTC), with a reminder an hour before;
  * a bad link is a 404; the feed is valid iCalendar (lines folded <= 75 bytes);
  * the volunteer page carries the subscribe links;
  * the reminder lists their shifts and the webcal / Google / page links;
  * preview + send: only approved volunteers with confirmed shifts and an
    email; the count must match; each is sent ONCE (a second send skips them
    unless Resend is asked for); nothing real is sent (fake mailer).
Run:  python3 /root/event/backend/test_volunteer_calendar.py
"""
import json, os, re, sqlite3, sys, urllib.error, urllib.request
os.environ["VOLUNTEER_INVITES_FAKE"] = "1"
os.environ["VOLUNTEER_INVITES_ENABLED"] = "1"
sys.path.insert(0, "/root/event/backend")
import testbed
BASE, DB = testbed.start()
import main                                                    # noqa: E402
ADMIN = {"Authorization": "Bearer " + main.create_access_token({"sub": "1", "adm": True})}

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok: fails.append(label)

def call(m, p, b=None, h=ADMIN, raw=False):
    req = urllib.request.Request(BASE + p, data=json.dumps(b).encode() if b is not None else None, method=m,
                                 headers=dict({"Content-Type": "application/json"}, **(h or {})))
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read()
            return r.status, (body.decode() if raw else json.loads(body or b"null")), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), e.headers

db = sqlite3.connect(DB, timeout=30)
v = db.execute("""SELECT v.id, v.token FROM volunteers v WHERE v.event_id=1 AND v.status='approved' AND v.email LIKE '%@%'
                  AND v.token IS NOT NULL AND (SELECT count(*) FROM volunteer_bookings b WHERE b.volunteer_id=v.id AND b.status='confirmed')>=2
                  ORDER BY v.id LIMIT 1""").fetchone()
check(v is not None, "a volunteer with confirmed shifts exists on the copy")
VID, TOK = v
mine = db.execute("""SELECT s.day, s.start_time, s.end_time, s.role FROM volunteer_bookings b JOIN volunteer_shifts s ON s.id=b.shift_id
                     WHERE b.volunteer_id=? AND b.status='confirmed' AND s.active=1 ORDER BY s.day, s.start_time""", (VID,)).fetchall()
other = db.execute("SELECT count(*) FROM volunteer_bookings WHERE volunteer_id=? AND status!='confirmed'", (VID,)).fetchone()[0]

print("1. the calendar feed")
st, ics, hd = call("GET", "/volunteer/%s/calendar.ics" % TOK, h={}, raw=True)
check(st == 200 and "text/calendar" in hd.get("Content-Type", ""), "served as text/calendar", (st, hd.get("Content-Type")))
check(ics.startswith("BEGIN:VCALENDAR") and ics.rstrip().endswith("END:VCALENDAR"), "a whole calendar")
check(ics.count("BEGIN:VEVENT") == len(mine), "exactly the confirmed shifts (%d; %d other bookings left out)" % (len(mine), other),
      ics.count("BEGIN:VEVENT"))
d, t = mine[0][0], mine[0][1]
want = "DTSTART:%s%s%02d%s00Z" % (d.replace("-", ""), "T", int(t[:2]) + 5, t[3:5])     # Orlando is UTC-5 in November
check(want in ics, "first shift at the right instant (%s %s Orlando -> %s)" % (d, t, want[8:]), re.findall(r"DTSTART:\S+", ics)[:2])
check("TRIGGER:-PT1H" in ics and "REFRESH-INTERVAL" in ics, "a reminder an hour before; the feed refreshes itself")
check(all(len(l.encode()) <= 75 for l in ics.split("\r\n")), "every line folded to 75 bytes")
st, _, _ = call("GET", "/volunteer/nope-not-a-token/calendar.ics", h={}, raw=True)
check(st == 404, "a bad link is a 404", st)

print("2. the volunteer page")
st, page, _ = call("GET", "/volunteer/%s" % TOK, h={})
cal = (page or {}).get("calendar") or {}
check(st == 200 and cal.get("webcal", "").startswith("webcal://") and cal["webcal"].endswith("/volunteer/%s/calendar.ics" % TOK)
      and "calendar.google.com" in cal.get("google", ""), "carries the subscribe links", cal)

print("3. preview and send")
st, pv, _ = call("POST", "/events/1/volunteers/schedule-reminder-preview", {})
rows = {r["id"]: r for r in pv.get("recipients", [])} if st == 200 else {}
check(st == 200 and rows.get(VID, {}).get("can_send") and rows[VID]["shifts"] == len(mine), "the volunteer is ready to send", rows.get(VID))
check(all(not r["can_send"] for r in rows.values() if not r["email"] or r["shifts"] == 0),
      "nobody without an email or a confirmed shift is sendable")
sm = pv.get("sample") or {}
check("calendar" in sm.get("subject", "").lower() or "schedule" in sm.get("subject", "").lower(), "a schedule subject", sm.get("subject"))
check("webcal://" in sm.get("html", "") and "calendar.google.com" in sm.get("html", "") and "/event/volunteer/" in sm.get("html", ""),
      "the email carries the calendar, Google and page links")
st, out, _ = call("POST", "/events/1/volunteers/schedule-reminder", {"volunteer_ids": [VID], "confirm_count": 5})
check(st == 409, "a count that does not match the preview is refused", st)
st, out, _ = call("POST", "/events/1/volunteers/schedule-reminder", {"volunteer_ids": [VID], "confirm_count": 1})
check(st == 200 and out["sent"] == 1, "sent once", out)
st, pv2, _ = call("POST", "/events/1/volunteers/schedule-reminder-preview", {"volunteer_ids": [VID]})
r2 = (pv2.get("recipients") or [{}])[0]
check(not r2.get("can_send") and "already" in (r2.get("reason") or ""), "a second send skips them", r2)
st, pv3, _ = call("POST", "/events/1/volunteers/schedule-reminder-preview", {"volunteer_ids": [VID], "resend": True})
check((pv3.get("recipients") or [{}])[0].get("can_send"), "Resend is possible when asked for")
db = sqlite3.connect(DB, timeout=30)
check(db.execute("SELECT count(*) FROM volunteer_log WHERE volunteer_id=? AND action='schedule_reminder_sent'", (VID,)).fetchone()[0] == 1,
      "the send is logged once")

print("4. the day-before reminder job")
import subprocess
day = mine[0][0]
env = dict(os.environ, DATABASE_URL="sqlite:///" + DB, VENDOR_SYNC_DATA=os.path.dirname(DB),
           VOLUNTEER_INVITES_FAKE="1", VOLUNTEER_INVITES_ENABLED="1")
tool = os.path.join("/root/event/backend", "tools", "volunteer_day_reminder.py")
dry = subprocess.run([sys.executable, tool, "--day", day], env=env, capture_output=True, text=True, timeout=120)
db = sqlite3.connect(DB, timeout=30)
n = db.execute("SELECT count(DISTINCT v.id) FROM volunteers v JOIN volunteer_bookings b ON b.volunteer_id=v.id JOIN volunteer_shifts s ON s.id=b.shift_id "
               "WHERE v.event_id=1 AND v.status='approved' AND v.token IS NOT NULL AND v.email LIKE '%@%' AND b.status='confirmed' AND s.active=1 AND s.day=?", (day,)).fetchone()[0]
check(dry.returncode == 0 and ("to remind: %d" % n) in dry.stdout, "dry run: everyone with a confirmed shift that day and an email (%d)" % n, dry.stdout[:300] + dry.stderr[-300:])
check(db.execute("SELECT count(*) FROM volunteer_log WHERE action='schedule_day_reminder_sent'").fetchone()[0] == 0, "a dry run sends nothing")
app = subprocess.run([sys.executable, tool, "--apply", "--day", day], env=env, capture_output=True, text=True, timeout=120)
sent = db.execute("SELECT count(*) FROM volunteer_log WHERE action='schedule_day_reminder_sent' AND after LIKE ?", ('%"day": "' + day + '"%',)).fetchone()[0]
check(app.returncode == 0 and sent == n, "--apply reminds each of them once (%d logged)" % sent, app.stdout[-400:] + app.stderr[-400:])
again = subprocess.run([sys.executable, tool, "--apply", "--day", day], env=env, capture_output=True, text=True, timeout=120)
check("to remind: 0" in again.stdout and db.execute("SELECT count(*) FROM volunteer_log WHERE action='schedule_day_reminder_sent'").fetchone()[0] == sent,
      "a second run the same day sends nothing", again.stdout[:300])
import volunteer_calendar as VCAL
class _S: pass
sh = _S(); sh.start_time, sh.end_time, sh.role, sh.lead_role, sh.location = "08:00", "11:00", "Registration", 0, "Registration area"
subj, h = VCAL.render_day_reminder("Amy", "2026-11-20", [sh], VCAL.feed_urls("TOKEN"), "Gaia Healers Elevate Conference 2026")
check(subj.startswith("Tomorrow:") and "Friday 20 November" in subj and "8:00 am – 11:00 am" in h and "webcal://" in h,
      "the email says tomorrow, the day, the times and has the calendar button", subj)

print("\n%d failed" % len(fails) if fails else "\nALL PASS")
sys.exit(1 if fails else 0)
