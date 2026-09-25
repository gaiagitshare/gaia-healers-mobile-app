# -*- coding: utf-8 -*-
"""The two people tabs of the planning sheet: the volunteers who work the
event, and the guests of the house. Read-only.

    Volunteers:  NAME | Area of expertise | Dates | E-MAIL | PHONE | WORKSHOPS | FORMS COMPLETED
    Guests:      NAME | EMAIL | PHONE
"""
import csv, io, re, sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from vendor_sheet import SHEET_ID, fetch_csv

TAB = "https://docs.google.com/spreadsheets/d/%s/export?format=csv&gid=%s"
VOLUNTEERS_GID = "72483911"
GUESTS_GID = "931914391"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _clean(v):
    return re.sub(r"\s+", " ", (v or "").strip())


def _split_name(full):
    """Single names are real names ("Elnaz", "Jahangir"), not incomplete ones."""
    parts = [p for p in _clean(full).split(" ") if p]
    if not parts:
        return "", ""
    return parts[0], " ".join(parts[1:])


def fetch(gid):
    return fetch_csv(TAB % (SHEET_ID, gid))


def parse_volunteers(text):
    out = []
    for n, row in enumerate(csv.DictReader(io.StringIO(text)), start=2):
        name = _clean(row.get("NAME"))
        if not name or name.upper() == "NAME":
            continue
        first, last = _split_name(name)
        email = _clean(row.get("E-MAIL")).lower()
        rec = {"row": n, "kind": "volunteer", "name": name, "first_name": first, "last_name": last,
               "email": email if EMAIL_RE.match(email) else "",
               "phone": _clean(row.get("PHONE")), "role": _clean(row.get("Area of expertise")),
               "workshops": _clean(row.get("WORKSHOPS")), "dates": _clean(row.get("Dates")),
               "forms": _clean(row.get("FORMS COMPLETED")), "issues": []}
        if email and not rec["email"]:
            rec["issues"].append("e-mail column does not hold an email: %r" % email)
        if not rec["email"]:
            rec["issues"].append("no e-mail — a badge cannot be made without one")
        out.append(rec)
    return out


def parse_guests(text):
    out = []
    for n, row in enumerate(csv.DictReader(io.StringIO(text)), start=2):
        name = _clean(row.get("NAME"))
        if not name or name.upper() == "NAME":
            continue
        first, last = _split_name(name)
        email = _clean(row.get("EMAIL")).lower()
        rec = {"row": n, "kind": "guest", "name": name, "first_name": first, "last_name": last,
               "email": email if EMAIL_RE.match(email) else "", "phone": _clean(row.get("PHONE")),
               "role": "", "workshops": "", "dates": "", "forms": "", "issues": []}
        if not rec["email"]:
            rec["issues"].append("no e-mail — a badge cannot be made without one")
        out.append(rec)
    return out


def job_title(rec):
    if rec["kind"] == "guest":
        return "Gaia Healers guest"
    bits = ["Volunteer" if not rec["role"] else "Volunteer — " + rec["role"]]
    if rec["workshops"]:
        bits.append("runs " + rec["workshops"])
    return " · ".join(bits)[:120]


if __name__ == "__main__":
    for rec in parse_volunteers(fetch(VOLUNTEERS_GID)) + parse_guests(fetch(GUESTS_GID)):
        print("%-10s %-20s %-30s %-28s %s" % (rec["kind"], rec["name"][:20], job_title(rec)[:30],
                                              rec["email"][:28], "; ".join(rec["issues"])))
