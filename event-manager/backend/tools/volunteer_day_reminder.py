# -*- coding: utf-8 -*-
"""The day-before reminder for volunteers (17 Nov 2026: "I want a reminder a
day before the shift").

    python3 tools/volunteer_day_reminder.py              # dry run: who would get tomorrow's reminder
    python3 tools/volunteer_day_reminder.py --apply      # send it (what the daily timer runs)
    python3 tools/volunteer_day_reminder.py --day 2026-11-20   # a given shift day instead of tomorrow

Each morning (gaia-volunteer-reminder.timer, 9:00 Orlando) every approved
volunteer with a CONFIRMED shift TOMORROW gets one email listing tomorrow's
shifts, with the add-to-calendar button and their own page link.

  * once per volunteer per shift day: the send is logged in volunteer_log
    (schedule_day_reminder_sent, with the day) and a second run skips them;
  * only between 8:00 and 21:00 Orlando time for an automatic run, so a
    server back up late at night does not email anyone at midnight;
  * hard cap of 80 emails per run (29 volunteers today);
  * sends through the same path as the invitations (GHL, existing contact
    only, email do-not-disturb respected, refused while volunteer emails are
    switched off);
  * a volunteer with no email or no GHL contact is reported, never guessed.
"""
import json, os, sqlite3, sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
import volunteer_invites as INV
import volunteer_calendar as VCAL

_DBURL = os.environ.get("DATABASE_URL", "")
DB = (_DBURL.split("sqlite:///", 1)[1] if _DBURL.startswith("sqlite:///") else os.path.join(HERE, "event.db"))
DATA = os.environ.get("VENDOR_SYNC_DATA") or os.path.join(HERE, "data")
LATEST = os.path.join(DATA, "volunteer-day-reminder-latest.md")
EVENT = int(os.environ.get("VOLUNTEER_EVENT", "1"))
APPLY = "--apply" in sys.argv
CAP = 80
ACTION = "schedule_day_reminder_sent"
ACTOR = "system: day-before reminder"


class Shift:
    def __init__(self, row):
        for k in row.keys():
            setattr(self, k, row[k])


def main():
    db = sqlite3.connect(DB, timeout=30); db.row_factory = sqlite3.Row
    ev = db.execute("SELECT name, timezone FROM events WHERE id=?", (EVENT,)).fetchone()
    tz = (ev["timezone"] if ev else None) or "America/New_York"
    now = datetime.now(ZoneInfo(tz))
    arg = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--day" and i + 1 < len(sys.argv)), None)
    day = arg or (now.date() + timedelta(days=1)).isoformat()
    L = ["# Volunteer day-before reminder — %s (%s)" % (now.strftime("%Y-%m-%d %H:%M %Z"), "APPLIED" if APPLY else "dry run"), ""]
    if APPLY and not arg and not (8 <= now.hour < 21):
        L.append("Outside 8:00–21:00 event time: nothing sent. The next run will send.")
        return finish(L)
    vols = db.execute("SELECT * FROM volunteers WHERE event_id=? AND status='approved' AND token IS NOT NULL ORDER BY first_name",
                      (EVENT,)).fetchall()
    plan, skipped = [], []
    for v in vols:
        shifts = [Shift(r) for r in db.execute(
            "SELECT s.* FROM volunteer_bookings b JOIN volunteer_shifts s ON s.id=b.shift_id WHERE b.volunteer_id=? "
            "AND b.status='confirmed' AND s.active=1 AND s.day=? ORDER BY s.start_time", (v["id"], day)).fetchall()]
        if not shifts:
            continue
        name = ("%s %s" % (v["first_name"] or "", v["last_name"] or "")).strip()
        done = db.execute("SELECT 1 FROM volunteer_log WHERE volunteer_id=? AND action=? AND after LIKE ?",
                          (v["id"], ACTION, '%"day": "' + day + '"%')).fetchone()
        if done:
            skipped.append((name, "already sent for this day")); continue
        if not v["email"]:
            skipped.append((name, "no email address — tell them directly (%d shift%s)" % (len(shifts), "s" if len(shifts) > 1 else "")))
            continue
        plan.append((v, name, shifts))
    L.append("Shift day: %s · to remind: %d · skipped: %d" % (day, len(plan), len(skipped)))
    L.append("")
    if len(plan) > CAP:
        L.append("REFUSED: %d emails is above the cap of %d. Nothing sent." % (len(plan), CAP))
        return finish(L, code=2)
    sent = 0
    for v, name, shifts in plan:
        what = ", ".join("%s %s" % (VCAL._t(s.start_time), s.role) for s in shifts)
        if not APPLY:
            L.append("- would remind **%s** (%s): %s" % (name, v["email"], what)); continue
        cid = v["ghl_contact_id"]
        why = None
        if not cid:
            cid, why = INV.find_contact(v["email"])
            if cid:
                db.execute("UPDATE volunteers SET ghl_contact_id=? WHERE id=?", (cid, v["id"])); db.commit()
        if not cid:
            L.append("- ⚠ %s: not sent — %s" % (name, why)); continue
        subject, html = VCAL.render_day_reminder(v["first_name"], day, shifts, VCAL.feed_urls(v["token"]), ev["name"] if ev else "")
        r = INV.send(cid, subject, html)
        stamp = datetime.utcnow().isoformat(" ")
        db.execute("INSERT INTO volunteer_log(event_id, at, actor, action, volunteer_id, after) VALUES (?,?,?,?,?,?)",
                   (EVENT, stamp, ACTOR, ACTION if r["ok"] else "schedule_day_reminder_failed", v["id"],
                    json.dumps({"day": day, "ok": r["ok"], "message_id": r["message_id"], "reason": r["reason"], "shifts": len(shifts)})))
        db.commit()
        if r["ok"]:
            sent += 1
            L.append("- reminded **%s**: %s" % (name, what))
        else:
            L.append("- ⚠ %s: not sent — %s" % (name, r["reason"]))
    if skipped:
        L += ["", "## Skipped"] + ["- %s: %s" % s for s in skipped]
    if APPLY:
        L.insert(2, "Sent: %d" % sent)
    return finish(L)


def finish(L, code=0):
    out = "\n".join(L)
    try:
        os.makedirs(DATA, exist_ok=True)
        open(LATEST, "w").write(out + "\n")
    except OSError:
        pass
    print(out)
    return code


if __name__ == "__main__":
    sys.exit(main() or 0)
