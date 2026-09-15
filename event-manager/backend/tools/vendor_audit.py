# -*- coding: utf-8 -*-
"""Audit: the exhibitor sheet against the Event Manager's exhibitors. Reads
both, writes nothing. Prints a Markdown report.

Run:  python3 /root/event/backend/tools/vendor_audit.py [event_id] [saved.csv]
"""
import os, re, sqlite3, sys
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vendor_sheet as vs

DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "event.db")
EVENT = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 1
SRC = sys.argv[2] if len(sys.argv) > 2 else None

FIELDS = [("stage", "stage"), ("booth", "booth_number"), ("tables", "tables"), ("email", "contact_email"),
          ("phone", "contact_phone"), ("website", "website"), ("package", "package"),
          ("payment_status", "payment_status"), ("status_text", "payment_note")]


def norm_val(field, v):
    v = "" if v is None else str(v).strip()
    if field == "tables":
        return re.sub(r"\.0+$", "", v)
    if field == "phone":
        return re.sub(r"\D", "", v)
    if field == "website":
        return re.sub(r"^https?://(www\.)?", "", v.lower()).rstrip("/")
    if field == "email":
        return v.lower()
    if field == "booth":
        return re.sub(r"\s+", "", re.sub(r"#", "", v.lower()))
    return v


def main():
    text = open(SRC, encoding="utf-8-sig").read() if SRC else vs.fetch_csv()
    sheet = vs.parse(text)
    db = sqlite3.connect(DB); db.row_factory = sqlite3.Row
    rows = db.execute("SELECT * FROM exhibitors WHERE event_id=? ORDER BY id", (EVENT,)).fetchall()
    by_name = {vs.norm_name(r["company_name"]): r for r in rows}
    sheet_names = {vs.norm_name(s["company"]) for s in sheet}

    print("# Exhibitor sheet vs Event Manager — audit\n")
    print("Sheet: %d company rows in %d sections. Event Manager (event %d): %d exhibitors.\n" % (
        len(sheet), len({s['section'] for s in sheet}), EVENT, len(rows)))
    print("Stages in the sheet: " + ", ".join("%s %d" % kv for kv in sorted(Counter(s["stage"] for s in sheet).items())))
    print("Stages in the DB:    " + ", ".join("%s %d" % kv for kv in sorted(Counter(r["stage"] for r in rows).items())) + "\n")

    # A. in the sheet, not in the DB
    print("## A. In the sheet but not in the Event Manager")
    missing = [s for s in sheet if vs.norm_name(s["company"]) not in by_name]
    for s in missing:
        print("- **%s** (row %d, %s) — booth %s, %s, %s" % (s["company"], s["row"], s["section"], vs.booth_label(s) or "—", s["email"] or "no email", s["status_text"] or "no status"))
    if not missing: print("- none")
    print()

    # B. in the DB, not in the sheet
    print("## B. In the Event Manager but no longer in the sheet")
    gone = [r for r in rows if vs.norm_name(r["company_name"]) not in sheet_names]
    for r in gone:
        print("- **%s** (id %d, stage %s, booth %s)" % (r["company_name"], r["id"], r["stage"], r["booth_number"] or "—"))
    if not gone: print("- none")
    print()

    # C. differences per company
    print("## C. Same company, different data (sheet → Event Manager)")
    ndiff = 0
    for s in sheet:
        r = by_name.get(vs.norm_name(s["company"]))
        if not r: continue
        diffs = []
        for sf, dbf in FIELDS:
            sv = s[sf] if sf != "booth" else vs.booth_label(s)
            dv = r[dbf]
            if sf == "payment_status" and not s["status_text"] and not s["package"]:
                continue            # the sheet says nothing about money for this row
            if norm_val(sf, sv) != norm_val(sf, dv):
                diffs.append("%s: sheet `%s` vs EM `%s`" % (dbf, sv or "—", dv if dv not in (None, "") else "—"))
        if s["contact"]:
            diffs.append("contact name `%s` — the Event Manager has no field for it" % s["contact"])
        if diffs:
            ndiff += 1
            print("- **%s** (id %d)\n  - " % (s["company"], r["id"]) + "\n  - ".join(diffs))
    if not ndiff: print("- none")
    print()

    # D. sheet data quality
    print("## D. Sheet rows that need a human's eye")
    nq = 0
    for s in sheet:
        if s["issues"]:
            nq += 1
            print("- row %d **%s**: %s" % (s["row"], s["company"], "; ".join(s["issues"])))
    # name/company swap heuristic: a personal name in the company column and a company-looking name in the contact column
    for s in sheet:
        if s["contact"] and re.search(r"\b(medical|health|labs?|inc|llc|group|therapy)\b", s["contact"], re.I) and not re.search(r"\b(medical|health|labs?|inc|llc|group|therapy)\b", s["company"], re.I):
            nq += 1
            print("- row %d **%s**: company and contact name look swapped (contact reads `%s`)" % (s["row"], s["company"], s["contact"]))
    if not nq: print("- none")
    print()

    # E. the booth plan
    print("## E. Booth plan")
    confirmed = [s for s in sheet if s["stage"] == "confirmed"]
    taken = defaultdict(list)
    for s in confirmed:
        for b in re.findall(r"\d+", s["booth"] or ""):
            taken[b].append(s["company"])
    dups = {b: c for b, c in taken.items() if len(c) > 1}
    print("- Confirmed exhibitors with a booth in the **Booth #** column: %d of %d" % (sum(1 for s in confirmed if s["booth"]), len(confirmed)))
    print("- Booths used by confirmed exhibitors: " + ", ".join(sorted(taken, key=int)))
    if dups:
        for b, c in sorted(dups.items(), key=lambda kv: int(kv[0])):
            print("- ⚠ booth %s is given to more than one confirmed exhibitor: %s" % (b, ", ".join(c)))
    else:
        print("- No booth is assigned twice among confirmed exhibitors.")
    stale = []
    for s in sheet:
        if s["stage"] != "confirmed" and (s["booth"] or s["booth_old"]):
            for b in re.findall(r"\d+", s["booth"] or s["booth_old"]):
                if b in taken:
                    stale.append("%s (%s) still holds booth %s, now %s's" % (s["company"], s["section"], b, taken[b][0]))
    if stale:
        print("- Numbers on non-confirmed rows that now belong to a confirmed exhibitor (old plan?):")
        for t in stale: print("  - " + t)
    old_vs_new = [(s["company"], s["booth_old"], vs.booth_label(s)) for s in confirmed if s["booth_old"] and vs.norm_name(s["booth_old"]) != vs.norm_name(vs.booth_label(s))]
    if old_vs_new:
        print("- Confirmed rows where **Booth Number** (old column) differs from **Booth #**: " + "; ".join("%s %s→%s" % t for t in old_vs_new))
    print()

    # F. what the Event Manager adds that the sheet never carries
    print("## F. Event Manager state the sheet does not carry (kept as is by any sync)")
    pub = sum(1 for r in rows if r["is_published"]); scan = sum(1 for r in rows if r["can_scan_leads"]); act = sum(1 for r in rows if r["activated_at"])
    desc = sum(1 for r in rows if (r["description"] or "").strip()); logo = sum(1 for r in rows if (r["logo_url"] or "").strip())
    print("- Published in the attendee directory: %d · lead scanning granted: %d · stand activated by the exhibitor: %d" % (pub, scan, act))
    print("- With a description: %d · with a logo: %d" % (desc, logo))
    conf_unpub = [r["company_name"] for r in rows if r["stage"] == "confirmed" and not r["is_published"]]
    if conf_unpub: print("- Confirmed but NOT published in the directory: " + ", ".join(conf_unpub))
    nonconf_pub = [r["company_name"] for r in rows if r["stage"] != "confirmed" and r["is_published"]]
    if nonconf_pub: print("- Published but not confirmed: " + ", ".join(nonconf_pub))
    print("- No confirmed stand has lead scanning granted yet." if scan == 0 else "")


if __name__ == "__main__":
    main()
