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


def fetch_csv(url=CSV_URL, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "gaia-event-manager/vendor-sync"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8-sig")


def _clean(v):
    v = (v or "").strip()
    return re.sub(r"\s+", " ", v)


def _num(v):
    """A sheet number cell comes through as '1.0' / '9545511920.0'. Return the
    integer text when it is a whole number, else the text as typed."""
    t = _clean(v)
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
    status_col = 0
    out, stage, section = [], None, None
    for n, r in enumerate(rows[hi + 1:], start=hi + 2):
        cells = [_clean(c) for c in r] + [""] * (len(header) - len(r))
        first = cells[status_col].upper()
        if first in SECTIONS and not cells[col["company"]]:
            section, stage = cells[status_col], SECTIONS[first]
            continue
        company = cells[col["company"]]
        if not company:
            continue
        rec = {"row": n, "section": section, "stage": stage, "company": company,
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
        rec["payment_status"] = _payment_status(rec["status_text"], rec["package"])
        out.append(rec)
    return out


def booth_label(rec, prefer="booth"):
    """The booth as the Event Manager should show it: '#7 & #8' -> '7 & 8'."""
    v = rec.get(prefer) or rec.get("booth_old") or ""
    return re.sub(r"#", "", v).strip()


def norm_name(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


if __name__ == "__main__":
    text = fetch_csv() if len(sys.argv) < 2 else open(sys.argv[1], encoding="utf-8-sig").read()
    for rec in parse(text):
        print("%-16s %-6s %-32s booth=%-8s old=%-4s tables=%-2s pay=%-8s %s" % (
            rec["stage"], "#%s" % rec["row"], rec["company"][:32], booth_label(rec), rec["booth_old"],
            rec["tables"], rec["payment_status"], "; ".join(rec["issues"])))
