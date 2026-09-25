# -*- coding: utf-8 -*-
"""The speaker tab of the "Elevate 2026" planning sheet, read and normalised.

One row per speaker: who, their company, how long they have, and the three
"have we received it yet" columns the team works from. Nothing here writes.
"""
import csv, io, re, sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from vendor_sheet import SHEET_ID, fetch_csv          # same workbook, same retrying fetch

SPEAKERS_GID = "1414762250"
CSV_URL = "https://docs.google.com/spreadsheets/d/%s/export?format=csv&gid=%s" % (SHEET_ID, SPEAKERS_GID)
HEADERS = {"name": "Speakers", "email": "Email", "length": "Session Length", "company": "Company",
           "topic": "Topic", "headshot": "Headshot - Received?", "bio": "Bio- Received?",
           "deck": "Presentation Received?"}
# Titles and post-nominals are how the SAME person is written differently in
# two places ("Dr. Patrick Porter" in the sheet, "Dr. Patrick K. Porter, PhD"
# in the app). Matching strips them and compares what is left.
_TITLES = r"^(dr|prof|professor|mr|mrs|ms|miss)\.?\s+"
_POST = r"\b(ph\.?\s*d|dnp|nhd|aprn|ddm|dds|md|do|rn|lac|dc|msc|ma|bsc)\b\.?"


def fetch(url=CSV_URL):
    return fetch_csv(url)


def norm_name(s):
    t = (s or "").lower().strip()
    t = re.sub(r"[.,]", " ", t)
    # A hyphenated surname is ONE name: "Rivera-Dugenio" must stay attached, or
    # first+last reads as "jere dugenio" and no longer matches the sheet's
    # "Jere Rivera".
    t = t.replace("-", "")
    t = re.sub(_POST, " ", t)
    t = re.sub(_TITLES, " ", t.strip())
    t = re.sub(_TITLES, " ", t.strip())          # "Dr. Prof. X"
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    parts = [p for p in t.split() if p]
    if len(parts) >= 2:
        return parts[0] + " " + parts[-1]        # first + last, the stable pair
    return " ".join(parts)


def match(key, candidates):
    """Find `key` among candidate keys, allowing one side to carry more of a
    compound surname than the other: the sheet says "Dr. Jere Rivera", the app
    says "Dr. Jere Rivera-Dugenio, Ph.D.", and creating a second speaker for
    the same man is the one thing this must not do."""
    if not key:
        return None
    if key in candidates:
        return key
    a = key.split()
    for cand in candidates:
        b = cand.split()
        if len(a) >= 2 and len(b) >= 2 and a[0] == b[0]:
            if b[-1].startswith(a[-1]) or a[-1].startswith(b[-1]):
                return cand
    return None


def parse(csv_text):
    rows = list(csv.reader(io.StringIO(csv_text)))
    hi = next((i for i, r in enumerate(rows) if "Speakers" in [c.strip() for c in r]), None)
    if hi is None:
        raise ValueError("header row with 'Speakers' not found")
    header = [c.strip() for c in rows[hi]]
    col = {k: header.index(v) for k, v in HEADERS.items() if v in header}
    out = []
    for n, r in enumerate(rows[hi + 1:], start=hi + 2):
        cells = [re.sub(r"\s+", " ", (c or "").strip()) for c in r] + [""] * len(header)
        name = cells[col["name"]] if "name" in col else ""
        if not name or name.lower() in ("speakers", "name"):
            continue
        rec = {"row": n, "name": name, "key": norm_name(name)}
        for k in ("email", "length", "company", "topic", "headshot", "bio", "deck"):
            rec[k] = cells[col[k]] if k in col else ""
        rec["issues"] = []
        if rec["email"] and "@" not in rec["email"]:
            rec["issues"].append("email column does not hold an email: %r" % rec["email"])
        if not rec["key"]:
            rec["issues"].append("name is not a person's name")
        out.append(rec)
    return out


def yes(v):
    return (v or "").strip().lower().startswith("y")


def notes(rec):
    """The team's checklist for this speaker, as one line."""
    bits = []
    if rec["length"]:
        bits.append("Session " + rec["length"])
    if rec["topic"]:
        bits.append("Topic: " + rec["topic"])
    for label, key in (("headshot", "headshot"), ("bio", "bio"), ("deck", "deck")):
        if rec[key]:
            bits.append("%s: %s" % (label.capitalize(), rec[key]))
    return "; ".join(bits)


if __name__ == "__main__":
    for r in parse(fetch() if len(sys.argv) < 2 else open(sys.argv[1], encoding="utf-8-sig").read()):
        print("%-34s %-22s %-10s %s" % (r["name"][:34], (r["company"] or "")[:22], r["length"], notes(r)))
