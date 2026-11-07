# -*- coding: utf-8 -*-
"""Add the volunteers listed on the Elevate planning sheet's "Volunteers" tab.

    python3 tools/volunteers_from_planning_sheet.py [--csv file] [--apply]

READ-ONLY on the sheet (CSV export; the sheet is never edited). Matched by
email, then by full name, so running it again adds nobody twice and a person
already imported from SignUpGenius gets their email and phone filled in.
Rows marked "Cancelled" are skipped. Nobody is put on a shift: the sheet says
when people are available, not which shift they chose. Anything an admin should
look at (no email, no phone, not confirmed on the sheet) is flagged for review.
Nothing is emailed or texted.
"""
import argparse
import csv
import io
import os
import re
import sys
import urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
SHEET = "1x_fzjIT1TI6UzZTIU0ZgAoGTE0eM17IUbw41kCDXVFU"
GID = "72483911"
EVENT_ID = 1
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")


def rows_from(text):
    rows = list(csv.reader(io.StringIO(text)))
    head = [h.strip().upper() for h in rows[0]]
    col = lambda r, name: (r[head.index(name)] if name in head and head.index(name) < len(r) else "").strip()
    out = []
    for r in rows[1:]:
        name, area = col(r, "NAME"), col(r, "AREA OF EXPERTISE")
        if not name or not area:
            continue                      # notes and blank rows below the list
        out.append({"name": " ".join(name.split()), "area": area, "dates": col(r, "DATES"),
                    "email": (EMAIL_RE.search(col(r, "E-MAIL")) or [None])[0], "phone": " ".join(col(r, "PHONE").split()),
                    "confirmed": col(r, "CONFIRMED"), "forms": col(r, "FORMS COMPLETED"), "extra": col(r, "WORKSHOPS")})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    text = open(a.csv, encoding="utf-8").read() if a.csv else urllib.request.urlopen(
        "https://docs.google.com/spreadsheets/d/%s/export?format=csv&gid=%s" % (SHEET, GID), timeout=60).read().decode("utf-8")
    import models
    import volunteers as V
    from database import SessionLocal
    db = SessionLocal()
    rep = {"added": [], "completed": [], "already": [], "cancelled_skipped": [], "flagged": 0}
    existing = db.query(models.Volunteer).filter(models.Volunteer.event_id == EVENT_ID).all()
    for r in rows_from(text):
        if "cancel" in (r["dates"] or "").lower():
            rep["cancelled_skipped"].append(r["name"])
            continue
        parts = r["name"].split()
        first, last = parts[0], " ".join(parts[1:])
        v = next((x for x in existing if r["email"] and (x.email or "").lower() == r["email"].lower()), None) or \
            next((x for x in existing if V.full_name(x).lower() == r["name"].lower()), None)
        sheet_note = "From the planning sheet: %s · available %s · confirmed: %s · forms: %s%s" % (
            r["area"], r["dates"] or "not given", r["confirmed"] or "-", r["forms"] or "-",
            (" · " + r["extra"]) if r["extra"] else "")
        review = []
        if not r["email"]:
            review.append("no email on the sheet")
        if not r["phone"]:
            review.append("no phone on the sheet")
        if (r["confirmed"] or "").upper() != "YES":
            review.append("not marked confirmed on the sheet")
        if not last:
            review.append("only a first name on the sheet")
        if v is None:
            v = models.Volunteer(event_id=EVENT_ID, first_name=first, last_name=last, email=(r["email"] or None) and r["email"].lower(),
                                 phone=r["phone"] or None, notes=sheet_note, status="approved", token=V.new_token(),
                                 token_created_at=datetime.utcnow(), source="planning_sheet",
                                 needs_review=("Check: " + "; ".join(review) + ".") if review else None,
                                 created_at=datetime.utcnow(), updated_at=datetime.utcnow())
            db.add(v); db.flush(); existing.append(v)
            V.log(db, EVENT_ID, "planning sheet import", "volunteer_imported", volunteer_id=v.id, after={"name": r["name"]})
            rep["added"].append(r["name"])
        else:
            before = {"email": v.email, "phone": v.phone}
            changed = False
            if not v.email and r["email"]:
                v.email, changed = r["email"].lower(), True
            if not v.phone and r["phone"]:
                v.phone, changed = r["phone"], True
            if sheet_note not in (v.notes or ""):
                v.notes = ((v.notes + "\n") if v.notes else "") + sheet_note
                changed = True
            if changed:
                if v.source == "signupgenius" and v.email and v.phone:
                    v.needs_review = ("Check: " + "; ".join(review) + ".") if review else None
                v.updated_at = datetime.utcnow()
                V.log(db, EVENT_ID, "planning sheet import", "volunteer_completed", volunteer_id=v.id, before=before,
                      after={"email": bool(v.email), "phone": bool(v.phone)})
                rep["completed"].append(r["name"])
            else:
                rep["already"].append(r["name"])
        if v.needs_review:
            rep["flagged"] += 1
    (db.commit if a.apply else db.rollback)()
    print(("APPLIED " if a.apply else "DRY RUN ") + " | ".join("%s: %s" % (k, len(x) if isinstance(x, list) else x) for k, x in rep.items()))
    for k in ("added", "completed", "already", "cancelled_skipped"):
        print("  %s: %s" % (k, ", ".join(rep[k]) or "-"))


if __name__ == "__main__":
    main()
