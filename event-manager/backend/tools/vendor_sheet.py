# -*- coding: utf-8 -*-
"""The exhibitor planning sheet ("Elevate 2026" / Vendors tab), read and
normalised. Used by the audit and by the daily sync.

The sheet is the team's working list: one row per company, section headings
("2026 CONFIRMED EXHIBITORS", "WAITING TO CONFIRM", ...) that say where a
company stands, and a free-text status column. Nothing here writes anywhere.
"""
import csv, io, re, sys, urllib.request

SHEET_ID = "1x_fzjIT1TI6UzZTIU0ZgAoGTE0eM17IUbw41kCDXVFU"
CSV_URL = "https://docs.google.com/spreadsheets/d/%s/export?format=csv" % SHEET_ID   # first tab = Vendors

# Section heading (upper-cased, as typed) -> stage in the Event Manager.
SECTIONS = {
    "2026 CONFIRMED EXHIBITORS": "confirmed",
    "WAITING TO CONFIRM": "waiting",
    "NOT SURE YET": "unsure",
    "OTHERS": "other",
    "INTERESTED FOR NEXT YEAR": "next_year",
    "NOT ATTENDING THIS YEAR": "not_attending",
    "NOT ALIGNED WITH OUR EVENT": "not_aligned",
    "PRODUCT-ONLY SPONSORS": "product_sponsor",
}
HEADERS = {"booth": "Booth #", "company": "Company Name", "video": "Intro Video Sent", "contact": "Name",
           "website": "Website", "email": "Email", "phone": "Phone", "package": "Package", "tables": "Tables",
           "speaking": "Speaking?", "booth_old": "Booth Number", "notes": "Notes"}

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
URL_RE = re.compile(r"^(https?://)?([a-z0-9-]+\.)+[a-z]{2,}(/.*)?$", re.I)


def fetch_csv(url=CSV_URL, timeout=30, attempts=3):
    """Google occasionally takes longer than the timeout on the redirect to the
    export host; one run in nine died that way and simply skipped a sync. Retry
    a couple of times before giving up -- a sheet that answers slowly is not a
    sheet that has changed."""
    import time
    last = None
    for i in range(max(1, attempts)):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "gaia-event-manager/vendor-sync"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8-sig")
        except Exception as e:                      # timeout, transient 5xx, redirect stall
            last = e
            if i + 1 < attempts:
                time.sleep(5 * (i + 1))
    raise last


def _clean(v):
    v = (v or "").strip()
    return re.sub(r"\s+", " ", v)


def _num(v):
    """A sheet number cell comes through as '1.0' / '9545511920.0'. Return the
    integer text when it is a whole number, else the text as typed."""
    t = _clean(v).lstrip("=").strip()    # a formula cell exported as text
    if re.fullmatch(r"-?\d+\.0+", t):
        return t.split(".")[0]
    return t


def _payment_status(status_text, package):
    s = (status_text or "").lower()
    if "fully paid" in s or s.strip() == "paid":
        return "paid"
    if re.search(r"paid|deposit|installment", s):
        return "partial"
    if (package or "").lower().startswith("gaia healers") or (package or "").lower() == "partners":
        return "comp"
    return "unpaid"


def parse(csv_text):
    """-> list of dicts, one per company row, in sheet order. Section headings
    set `stage`; blank rows are skipped; the header row locates the columns."""
    rows = list(csv.reader(io.StringIO(csv_text)))
    # header row: the one carrying "Company Name"
    hi = next((i for i, r in enumerate(rows) if "Company Name" in [c.strip() for c in r]), None)
    if hi is None:
        raise ValueError("header row with 'Company Name' not found")
    header = [c.strip() for c in rows[hi]]
    col = {key: header.index(label) for key, label in HEADERS.items() if label in header}
    # "Staff Members at the Event" (added to the sheet 16 Nov 2026): matched by
    # its start, since the wording of a header drifts.
    staff_col = next((i for i, h in enumerate(header) if h.lower().startswith("staff")), None)
    status_col = 0
    out, stage, section = [], None, None
    for n, r in enumerate(rows[hi + 1:], start=hi + 2):
        cells = [_clean(c) for c in r] + [""] * (len(header) - len(r))
        first = cells[status_col].upper()
        if first in SECTIONS and not cells[col["company"]]:
            section, stage = cells[status_col], SECTIONS[first]
            continue
        company, name_note = split_staff_note(cells[col["company"]])
        if not company:
            continue
        rec = {"row": n, "section": section, "stage": stage, "company": company,
               "name_note": name_note,
               "status_text": cells[status_col],
               "booth": cells[col["booth"]] if "booth" in col else "",
               "booth_old": _num(cells[col["booth_old"]]) if "booth_old" in col else "",
               "contact": cells[col["contact"]] if "contact" in col else "",
               "website": cells[col["website"]] if "website" in col else "",
               "email": cells[col["email"]] if "email" in col else "",
               "phone": _num(cells[col["phone"]]) if "phone" in col else "",
               "package": _num(cells[col["package"]]) if "package" in col else "",
               "tables": _num(cells[col["tables"]]) if "tables" in col else "",
               "speaking": cells[col["speaking"]] if "speaking" in col else "",
               "video": cells[col["video"]] if "video" in col else "",
               "notes": cells[col["notes"]] if "notes" in col else "",
               # Raw, not _clean()ed: people are separated by line breaks.
               "staff": (r[staff_col] if staff_col is not None and staff_col < len(r) else "") or "",
               "issues": []}
        # Email and website typed in each other's column happens; repair, and say so.
        if rec["email"] and not EMAIL_RE.match(rec["email"]) and rec["website"] and EMAIL_RE.match(rec["website"]):
            rec["email"], rec["website"] = rec["website"], rec["email"]
            rec["issues"].append("email and website were in each other's columns (swapped on read)")
        elif rec["email"] and not EMAIL_RE.match(rec["email"]):
            rec["issues"].append("email column does not hold an email: %r" % rec["email"])
        if rec["website"] and EMAIL_RE.match(rec["website"]):
            rec["issues"].append("website column holds an email: %r" % rec["website"])
        if rec["booth"] and not re.fullmatch(r"#?\d+(\s*&\s*#?\d+)*", rec["booth"]):
            rec["issues"].append("booth is not a plain number: %r" % rec["booth"])
        if rec["contact"] and rec["company"] and EMAIL_RE.match(rec["company"]):
            rec["issues"].append("company column holds an email")
        if name_note:
            rec["issues"].append("company cell carries a staff note %r (kept off the stand's name)" % ("/" + name_note))
        rec["payment_status"] = _payment_status(rec["status_text"], rec["package"])
        out.append(rec)
    return out


def booth_label(rec, prefer="booth"):
    """The booth as an ATTENDEE should read it.

    The cell is a planning note as often as a number: '#7 & #8', '#14 (maybe
    #15 also)', '?', 'Foyar 6&7'. Attendees saw "Booth 14 (maybe 15 also)" in
    the directory, which is a note to the team, not a place to stand. So: the
    hashes go, an aside in brackets goes, a placeholder with no number at all
    ('?', 'TBD', '-') is no booth rather than a printed question mark, and a
    named location that carries numbers ('Foyar 6&7') is kept as typed. The
    aside is not lost -- clean_booth_note() reports it.
    """
    v = (rec.get(prefer) or rec.get("booth_old") or "").strip()
    v = re.sub(r"\([^)]*\)", " ", v)            # "(maybe #15 also)" is a note, not a booth
    v = re.sub(r"#", "", v)
    v = re.sub(r"\s*,\s*", ", ", v)
    v = re.sub(r"\s+", " ", v).strip(" ,;/-")
    if not re.search(r"\d", v):                  # "?", "TBD", "-", "" -> no booth yet
        return ""
    return v


def booth_note(rec, prefer="booth"):
    """What was dropped from the booth cell, so nobody has to diff the sheet."""
    raw = (rec.get(prefer) or rec.get("booth_old") or "").strip()
    shown = booth_label(rec, prefer)
    if not raw or re.sub(r"[#\s]", "", raw) == re.sub(r"\s", "", shown):
        return ""
    return "booth cell reads %r; attendees are shown %s" % (raw, ("%r" % shown) if shown else "no booth")


# The team writes short notes for each other into the company cell itself:
# "Transform and RISE /BOOK" means "Bita: book this one" (11 Nov 2026). The
# note is not part of the name -- it was reaching the public directory, the
# map and the stand's own emails. A trailing "/WORD" in capitals is read as
# such a note when the name before it is not itself all capitals, so a real
# name like "AC/DC" or "HEALEEX/USA" is left alone.
_STAFF_NOTE = re.compile(r"^(.*?[^\s/])\s*/\s*([A-Z]{2,12})\s*$")


def split_staff_note(company):
    """-> (name, note) with a trailing staff note like "/BOOK" taken off the name."""
    s = (company or "").strip()
    m = _STAFF_NOTE.match(s)
    if not m:
        return s, ""
    name, note = m.group(1).strip(), m.group(2)
    if not re.search(r"[a-z]", name):
        return s, ""
    return name, note


def norm_name(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


if __name__ == "__main__":
    text = fetch_csv() if len(sys.argv) < 2 else open(sys.argv[1], encoding="utf-8-sig").read()
    for rec in parse(text):
        print("%-16s %-6s %-32s booth=%-8s old=%-4s tables=%-2s pay=%-8s %s" % (
            rec["stage"], "#%s" % rec["row"], rec["company"][:32], booth_label(rec), rec["booth_old"],
            rec["tables"], rec["payment_status"], "; ".join(rec["issues"])))


# ---------------------------------------------------------------------------
# The stand's staff, as the team types them into one cell (16 Nov 2026):
#   "Michael Porter - mporter@braintap.com | Shawn Bean - sbean@braintap.com"
#   "Erin Currin\nerinina2020@gmail.com\nShannon Procise\nShannon@..."
#   "Ariel Molina\nPaola Palacio\nDarya Smith\nJacob Wilson\narielthemermaidllc@gmail.com"
#   "Jason Cestaro - +1 (321) 987-4949"         (phone only)
#   "Ray@myivspaorlando.com\nPatricia@..."      (address only)
# ---------------------------------------------------------------------------
_EMAIL_IN = re.compile(r"[\w.+'-]+@[\w-]+(?:\.[\w-]+)+")
_PHONE_IN = re.compile(r"\+?\d[\d\s().\-‐-―‑]{6,}\d")
_ROLE = re.compile(r"\([^)]*\)")
_TITLES = re.compile(r"\b(dr|mr|mrs|ms|phd|md|ceo|cfo|coo|speaker)\b\.?", re.I)
_INVISIBLE = re.compile("[‎‏‪-‮⁦-⁩]")
# Labels the team types in front of a value ("Badge 1: Matt Ma", "email: x@y"),
# which are never part of a name (18 Nov 2026: two badges came out named "email").
_LABEL = re.compile(r"\b(?:badges?|staff|e-?mail|phone|tel|cell|mobile|name|contact)\b\s*#?\s*\d*\s*:?", re.I)


_STATUS_MARK = re.compile(r"^(done|no|yes|printed|ok|tbd|n/?a|pending)$", re.I)


def _name_of(seg):
    t = _INVISIBLE.sub("", seg)
    t = _EMAIL_IN.sub(" ", t)
    t = _LABEL.sub(" ", t)
    t = _PHONE_IN.sub(" ", t)
    t = _ROLE.sub(" ", t)
    t = _TITLES.sub(" ", t)
    t = re.sub(r"[<>|;:,\-‐-―]+", " ", t)
    t = " ".join(w for w in t.split() if re.search(r"[A-Za-z]", w) and not re.search(r"\d", w))
    # The team marks each person's badge in the same cell ("Jeff Maier DONE",
    # "Jacob Wilson no", a bare "NO"). A mark is not part of the name: kept, it
    # printed "Maier DONE" on a badge and hid a speaker's own badge from the
    # name match, so a second badge was made (19 Nov 2026).
    words = t.split()
    while words and _STATUS_MARK.match(words[-1].strip(" .")):
        words.pop()
    return " ".join(words).strip(" .")


def _alpha(s):
    return re.sub(r"[^a-z]", "", (s or "").lower())


def _owns(person, email):
    """Does this address plausibly belong to this name? (its local part carries
    the first name, the surname, or initial+surname)."""
    local = _alpha(email.split("@")[0])
    parts = [_alpha(w) for w in person["name"].split()]
    parts = [w for w in parts if len(w) >= 3]
    if not local or not parts:
        return False
    first, last = parts[0], parts[-1]
    return (any(w in local or (len(local) >= 3 and w.startswith(local)) for w in parts)
            or (len(parts) > 1 and local.startswith(first[0] + last[:4])))


def parse_staff(cell):
    """-> [{"name", "first_name", "last_name", "email", "phone", "name_from_email"}].
    An address on its own line goes to the name it belongs to (by its local
    part), else to the name right before it; never guessed further."""
    segs = [s.strip() for s in re.split(r"[\n|;]+", _INVISIBLE.sub("", cell or "")) if s.strip()]
    people = []
    prev_named_without_email = None
    for seg in segs:
        emails = [e.lower() for e in _EMAIL_IN.findall(seg)]
        phones = [re.sub(r"[^\d+]", "", p) for p in _PHONE_IN.findall(seg)]
        name = _name_of(seg)
        if name and len(_alpha(name)) >= 2:
            p = {"name": name, "email": emails[0] if emails else None, "phone": phones[0] if phones else None,
                 "name_from_email": False}
            people.append(p)
            prev_named_without_email = p if not p["email"] else None
            continue
        if emails:
            e = emails[0]
            owner = next((p for p in people if not p["email"] and p["name"] and _owns(p, e)), None)
            if owner is None and prev_named_without_email is not None:
                owner = prev_named_without_email
            if owner is not None:
                owner["email"] = e
            else:
                local = re.sub(r"[\d_]+", " ", e.split("@")[0]).replace(".", " ").strip()
                people.append({"name": " ".join(w.capitalize() for w in local.split()) or e, "email": e,
                               "phone": phones[0] if phones else None, "name_from_email": True})
            prev_named_without_email = None
        elif phones and people and not people[-1]["phone"]:
            people[-1]["phone"] = phones[0]
    for p in people:
        bits = p["name"].split()
        p["first_name"], p["last_name"] = (bits[0], " ".join(bits[1:])) if bits else ("", "")
    return people
