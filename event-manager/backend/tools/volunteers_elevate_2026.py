# -*- coding: utf-8 -*-
"""Load the ELEVATE 2026 volunteer schedule (from the SignUpGenius sheet) and
import the people who already signed up there. Safe to run again.

    python3 tools/volunteers_elevate_2026.py [--signups <rendered sheet .txt>] [--apply]

Without --apply it only reports what it would do. Shifts are matched by a
stable key (day|start|role), so a second run adds nothing twice. Imported
volunteers are matched by full name (SignUpGenius shows no contact details);
anything that cannot be placed reliably -- an unknown slot, a full shift, an
overlap -- is NOT guessed: the volunteer is flagged "needs review" for an admin.
Nothing is emailed or texted.
"""
import argparse
import os
import re
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

EVENT_ID = 1
TITLE = "Volunteer Team: Gaia Healers ELEVATE 2026"
INTRO = """Welcome, Gaia Healers Elevate Volunteers!

November 20–22, 2026 | Rosen Shingle Creek | Orlando, FL

Thank you for sharing your time, energy, and talents with the Gaia Healers Elevate Conference! Our volunteers are essential in bringing this event to life, and we couldn't do it without YOU.

There are also opportunities on Thursday afternoon (November 19) to help the leadership team get every area ready for Friday morning.

Choose your role and shift: pick the roles, days and times you can confidently commit to. Two 3-hour shifts a day are expected; you are welcome to sign up for more.

Arrive 20–30 minutes early: check in at the registration table before your shift so you can connect with the volunteer finishing theirs.

Honor your commitment: your presence and punctuality make the day smooth for attendees, speakers, exhibitors and fellow volunteers.

Communicate changes: if your availability changes, update your shifts here and let Bita know.

Conference attire: a black or white shirt with coordinating bottoms during your shift.

If you are not needed at your assigned location, please return to the registration desk for a different assignment.

Together, we are creating an experience rooted in connection, community, and transformation. Let's Elevate Together!"""

REG = "Execute registration functions: collect payment, issue tickets, distribute badges and field questions."
D = {
    "reg_prep": "Set up the registration area; organize all resources and make sure the supplies are ready (markers, paper, payment tools, badges, goody bags).",
    "hall_setup": "Make sure all setup is completed in the exhibit hall; support exhibit hall vendors as needed.",
    "manager": "Oversee registration operations, volunteer assignments and support, and the overall registration flow. Resolve attendee concerns while delivering exceptional customer service.",
    "nima": "Provide support to Nima during presentations.",
    "speaker_room": "Check tickets for attendees entering the speaker room; make sure they have the right badge, and send anyone without one to registration.",
    "vip": "Provide assistance to VIPs.",
    "hall": "Support exhibit hall vendors as needed and check entry tickets.",
    "floater": "Help with conference logistics and volunteer check-ins, fill in where needed, and support whatever keeps the event running smoothly.",
    "workshop": "Support workshop hosts during workshop times; if no workshop is running, report back to registration for other needs.",
}
THREE = [("09:00", "12:00"), ("12:00", "15:00"), ("15:00", "18:00")]


def template():
    """(day, start, end, role, location, capacity, description, lead_role)"""
    out = [("2026-11-19", "16:00", "19:00", "Registration Prep", "Registration area", 4, D["reg_prep"], False),
           ("2026-11-19", "16:00", "19:00", "Exhibit Hall Setup", "Exhibit hall", 2, D["hall_setup"], False),
           ("2026-11-19", "16:00", "19:00", "Registration Manager", "Registration area", 2, D["manager"], True)]
    for day in ("2026-11-20", "2026-11-21", "2026-11-22"):
        last = REG + (" End of the day: review how the day went for tomorrow." if day != "2026-11-22" else
                      " Break down all supplies at the end of the event; organize and label them for next year, and make sure Bita receives all assets.")
        for (a, b), desc in zip([("08:00", "11:00"), ("10:00", "14:00"), ("13:00", "16:00"), ("15:00", "18:00")],
                                [REG, REG, REG, last]):
            out.append((day, a, b, "Registration", "Registration area", 4, desc, False))
        if day != "2026-11-22":
            for a, b in THREE:
                out.append((day, a, b, "Nima Speaker Support", "Main stage", 1, D["nima"], False))
            for a, b in THREE:
                out.append((day, a, b, "Speaker Room Host (Exterior)", "Speaker room entrance", 1, D["speaker_room"], False))
        for a, b in THREE:
            out.append((day, a, b, "VIP Room Support", "VIP room", 1, D["vip"], False))
        if day == "2026-11-21":
            out.append((day, "16:50", "18:00", "Workshop Support Assistant", "Workshop room", 1, D["workshop"], False))
        if day == "2026-11-22":
            for a, b in THREE:
                out.append((day, a, b, "Workshop Support Assistant", "Workshop room", 2, D["workshop"], False))
        for a, b in THREE:
            out.append((day, a, b, "Exhibit Hall Support", "Exhibit hall", 4, D["hall"], False))
        for a, b in THREE:
            out.append((day, a, b, "Floater / General Support", "Wherever needed", 2, D["floater"], False))
        out.append((day, "08:00", "18:00", "Registration Manager", "Registration area", 2, D["manager"], True))
    return out


def key(day, start, role):
    return "%s|%s|%s" % (day, start, re.sub(r"[^a-z]", "", role.lower()))


# SignUpGenius slot label -> our role name. Labels look like "9am-12pm Floater/General Support".
ROLE_MAP = [("registration prep", "Registration Prep"), ("registration manager", "Registration Manager"),
            ("exhibit hall support", "Exhibit Hall Support"), ("exhibit hall", None),
            ("registration", "Registration"), ("nima", "Nima Speaker Support"),
            ("speaker room", "Speaker Room Host (Exterior)"), ("vip", "VIP Room Support"),
            ("workshop", "Workshop Support Assistant"), ("floater", "Floater / General Support")]
DATE_RE = re.compile(r"^(\d{2})/(\d{2})/(\d{4})$")
LABEL_TIME = re.compile(r"^(\d{1,2})(?::(\d{2}))?(am|pm)-(\d{1,2})(?::(\d{2}))?(am|pm)\s+(.*)$", re.I)
FILLED = re.compile(r"^(\d+) of (\d+) slots? filled$")
INITIALS = re.compile(r"^[A-Z]{1,3}$")


def _hm(h, m, ap):
    h = int(h) % 12 + (12 if ap.lower() == "pm" else 0)
    return "%02d:%02d" % (h, int(m or 0))


def parse_signups(text):
    """[(day, start|None, role|None, label, [names])] for every slot with names."""
    lines = [l.strip() for l in text.splitlines()]
    out, day, i = [], None, 0
    while i < len(lines):
        m = DATE_RE.match(lines[i])
        if m:
            day = "%s-%s-%s" % (m.group(3), m.group(1), m.group(2))
        if lines[i] == "Sign Up" and i + 2 < len(lines) and FILLED.match(lines[i + 2] or ""):
            label, filled = lines[i + 1], int(FILLED.match(lines[i + 2]).group(1))
            j, names = i + 4, []
            while j < len(lines) and lines[j] != "Sign Up" and not DATE_RE.match(lines[j]) and not lines[j].startswith("©"):
                if lines[j] and not INITIALS.match(lines[j]) and lines[j] not in names:
                    names.append(lines[j])
                j += 1
            if filled:
                tm = LABEL_TIME.match(label)
                start = _hm(tm.group(1), tm.group(2), tm.group(3)) if tm else None
                rest = (tm.group(7) if tm else label).lower()
                role = next((r for k, r in ROLE_MAP if k in rest), None)
                out.append((day, start, role, label, names[:filled], filled))
            i = j
            continue
        i += 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--signups", help="rendered text of the SignUpGenius sheet")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    import models
    import volunteers as V
    from database import SessionLocal, engine
    models.Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    actor = "SignUpGenius import"
    report = {"shifts_added": 0, "shifts_kept": 0, "volunteers_added": 0, "volunteers_matched": 0,
              "bookings_added": 0, "bookings_kept": 0, "flagged": []}
    p = db.query(models.VolunteerProgram).filter(models.VolunteerProgram.event_id == EVENT_ID).first()
    if p is None:
        p = models.VolunteerProgram(event_id=EVENT_ID, join_open=False, expected_per_day=2)
        db.add(p)
    if not p.intro:
        p.title, p.intro = TITLE, INTRO
    p.expected_per_day = p.expected_per_day or 2
    p.updated_at = datetime.utcnow()
    for n, (day, a, b, role, loc, cap, desc, lead) in enumerate(template()):
        k = key(day, a, role)
        s = db.query(models.VolunteerShift).filter(models.VolunteerShift.event_id == EVENT_ID,
                                                   models.VolunteerShift.template_key == k).first()
        if s is not None:
            report["shifts_kept"] += 1
            continue
        db.add(models.VolunteerShift(event_id=EVENT_ID, day=day, start_time=a, end_time=b, role=role, location=loc,
                                     capacity=cap, description=desc, lead_role=lead, sort=n, template_key=k,
                                     active=True, created_at=datetime.utcnow()))
        report["shifts_added"] += 1
    db.flush()

    if args.signups:
        for day, start, role, label, names, filled in parse_signups(open(args.signups, encoding="utf-8").read()):
            shift = None
            if day and role:
                q = db.query(models.VolunteerShift).filter(models.VolunteerShift.event_id == EVENT_ID,
                                                           models.VolunteerShift.day == day,
                                                           models.VolunteerShift.role == role)
                shift = q.filter(models.VolunteerShift.start_time == start).first() if start else q.filter(
                    models.VolunteerShift.lead_role == True).first()   # noqa: E712
            if len(names) < filled:
                report["flagged"].append("%s %s: %d signed up but only %d name(s) readable" % (day, label, filled, len(names)))
            for name in names:
                parts = name.split()
                first, last = parts[0], " ".join(parts[1:])
                vol = next((v for v in db.query(models.Volunteer).filter(models.Volunteer.event_id == EVENT_ID).all()
                            if V.full_name(v).lower() == name.lower()), None)
                if vol is None:
                    vol = models.Volunteer(event_id=EVENT_ID, first_name=first, last_name=last, status="approved",
                                           token=V.new_token(), token_created_at=datetime.utcnow(), source="signupgenius",
                                           needs_review="Imported from SignUpGenius: add their email and phone, then send "
                                                        "them their personal link.",
                                           created_at=datetime.utcnow(), updated_at=datetime.utcnow())
                    db.add(vol); db.flush()
                    V.log(db, EVENT_ID, actor, "volunteer_imported", volunteer_id=vol.id, after={"name": name})
                    report["volunteers_added"] += 1
                else:
                    report["volunteers_matched"] += 1
                if shift is None:
                    why = "SignUpGenius slot '%s' on %s could not be matched to a shift; please place them by hand." % (label, day)
                    vol.needs_review = ((vol.needs_review + " ") if vol.needs_review else "") + why
                    report["flagged"].append("%s: %s" % (name, why))
                    continue
                if db.query(models.VolunteerBooking).filter(models.VolunteerBooking.volunteer_id == vol.id,
                                                            models.VolunteerBooking.shift_id == shift.id,
                                                            models.VolunteerBooking.status.in_(V.ACTIVE)).first():
                    report["bookings_kept"] += 1
                    continue
                try:
                    V.check_can_hold(db, shift, vol, allow_overlap=True)
                except Exception as e:
                    why = "SignUpGenius shift '%s' on %s not placed: %s" % (label, day, getattr(e, "detail", e))
                    vol.needs_review = ((vol.needs_review + " ") if vol.needs_review else "") + why
                    report["flagged"].append("%s: %s" % (name, why))
                    continue
                bk = models.VolunteerBooking(event_id=EVENT_ID, shift_id=shift.id, volunteer_id=vol.id, status="confirmed",
                                             note="Signed up on SignUpGenius", created_by=actor, decided_by=actor,
                                             created_at=datetime.utcnow(), updated_at=datetime.utcnow())
                db.add(bk); db.flush()
                V.log(db, EVENT_ID, actor, "imported_booking", volunteer_id=vol.id, shift_id=shift.id, booking_id=bk.id,
                      after={"status": "confirmed", "shift": "%s %s %s" % (day, shift.start_time, role)})
                report["bookings_added"] += 1
    if args.apply:
        db.commit()
    else:
        db.rollback()
    print(("APPLIED " if args.apply else "DRY RUN ") + str({k: (v if k != "flagged" else len(v)) for k, v in report.items()}))
    for f in report["flagged"]:
        print("  needs review:", f)
    db.close()


if __name__ == "__main__":
    main()
