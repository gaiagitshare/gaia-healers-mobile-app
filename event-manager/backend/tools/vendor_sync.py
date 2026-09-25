# -*- coding: utf-8 -*-
"""Mirror the exhibitor planning sheet into the Event Manager. Daily, and on demand.

    python3 tools/vendor_sync.py            # dry run: print what WOULD change
    python3 tools/vendor_sync.py --apply    # write it

What the sheet decides (per company, matched by name):
  stage (from the section heading), booth (the "Booth #" column), tables,
  contact name/email/phone, website, package, payment status + the status
  text, and the sheet's notes/speaking/video columns.
What the sheet never touches:
  whether a stand is in the attendee directory, whether it may scan leads,
  its description, logo, photos, products, public contact details, tokens,
  and anything the exhibitor set up themselves. A sheet cell left blank never
  blanks a value here. A company in the Event Manager that the sheet no
  longer lists is reported, not deleted.
Every applied change is appended to data/vendor-sync.log (JSON lines) and
the last report is written to data/vendor-sync-latest.md.
"""
import json, os, re, sqlite3, sys
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vendor_sheet as vs

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HERE, "event.db")
DATA = os.path.join(HERE, "data")
LOG = os.path.join(DATA, "vendor-sync.log")
LATEST = os.path.join(DATA, "vendor-sync-latest.md")
EVENT = int(os.environ.get("VENDOR_SHEET_EVENT", "1"))
APPLY = "--apply" in sys.argv
SRC = next((a for a in sys.argv[1:] if a.endswith(".csv")), None)


def money(v):
    """'3500.0' / '3500' / '$3,500' -> '$3,500'; anything else as typed."""
    t = (v or "").strip()
    m = re.fullmatch(r"\$?\s*([\d,]+)(\.\d+)?", t)
    if m:
        try: return "$%s" % format(int(m.group(1).replace(",", "")), ",")
        except ValueError: return t
    return t


def website(v):
    t = (v or "").strip()
    if t and not re.match(r"^https?://", t, re.I): t = "https://" + t
    return t


def to_int(v):
    try: return int(float(v))
    except (TypeError, ValueError): return None


def desired(rec):
    """The Event Manager values this sheet row calls for. None = the sheet says nothing."""
    notes = "; ".join(x for x in [rec["notes"], ("Speaking: " + rec["speaking"]) if rec["speaking"] else "",
                                  ("Intro video sent: " + rec["video"]) if rec["video"] else ""] if x)
    d = {
        "stage": rec["stage"],
        # Only the live "Booth #" column, cleaned for an attendee to read. A
        # cell that carries no number at all ('?') clears the stored booth
        # rather than printing a question mark in the directory.
        "booth_number": (vs.booth_label(rec, prefer="booth") or "") if rec["booth"] else None,
        "tables": to_int(rec["tables"]),
        "contact_name": rec["contact"] or None,
        "contact_email": rec["email"].lower() if rec["email"] and vs.EMAIL_RE.match(rec["email"]) else None,
        "contact_phone": rec["phone"] or None,
        "website": website(rec["website"]) if rec["website"] and vs.URL_RE.match(rec["website"]) else None,
        "package": money(rec["package"]) if rec["package"] else None,
        "payment_note": rec["status_text"] or None,
        "sheet_notes": notes or None,
    }
    if rec["status_text"] or rec["package"]:
        d["payment_status"] = rec["payment_status"]
    return d


def same(field, a, b):
    a = "" if a is None else str(a).strip(); b = "" if b is None else str(b).strip()
    if field == "contact_phone": return re.sub(r"\D", "", a) == re.sub(r"\D", "", b)
    if field == "website": return re.sub(r"^https?://(www\.)?", "", a.lower()).rstrip("/") == re.sub(r"^https?://(www\.)?", "", b.lower()).rstrip("/")
    if field in ("contact_email",): return a.lower() == b.lower()
    if field == "booth_number": return re.sub(r"\s+", "", a.lower()) == re.sub(r"\s+", "", b.lower())
    return a == b


def main():
    os.makedirs(DATA, exist_ok=True)
    started = datetime.now(timezone.utc)
    text = open(SRC, encoding="utf-8-sig").read() if SRC else vs.fetch_csv()
    sheet = vs.parse(text)
    if len([s for s in sheet if s["stage"] == "confirmed"]) < 5:
        raise SystemExit("refusing: the sheet parsed with fewer than 5 confirmed exhibitors — layout changed?")
    db = sqlite3.connect(DB); db.row_factory = sqlite3.Row
    cols = {r[1] for r in db.execute("PRAGMA table_info(exhibitors)")}
    for col, ddl in (("contact_name", "VARCHAR"), ("sheet_notes", "TEXT"), ("sheet_synced_at", "DATETIME")):
        if col not in cols: db.execute("ALTER TABLE exhibitors ADD COLUMN %s %s" % (col, ddl))
    rows = db.execute("SELECT * FROM exhibitors WHERE event_id=?", (EVENT,)).fetchall()
    by_name = {vs.norm_name(r["company_name"]): r for r in rows}
    seen, changes, creates, report = set(), [], [], []

    for rec in sheet:
        key = vs.norm_name(rec["company"]); seen.add(key)
        want = desired(rec)
        r = by_name.get(key)
        if r is None:
            creates.append((rec, want)); continue
        diff = {f: v for f, v in want.items() if v not in (None, "") and not same(f, r[f], v)}
        # One deliberate exception to "a blank cell never blanks a value": a
        # booth cell the sheet has emptied or filled with a placeholder means
        # this stand has no booth yet, and a stale number on the floor plan is
        # worse than none.
        if want["booth_number"] == "" and (r["booth_number"] or "").strip():
            diff["booth_number"] = ""
        # A company that moved section carries its old status text with it
        # ("Not aligned with our event" on a row now confirmed) unless the
        # sheet gives a new one -- the one case a blank cell does clear a value.
        if "stage" in diff and want["payment_note"] is None and (r["payment_note"] or "").strip():
            diff["payment_note"] = ""
        if diff:
            changes.append((r, rec, diff))

    gone = [r for r in rows if vs.norm_name(r["company_name"]) not in seen]

    lines = ["# Exhibitor sheet sync — %s (%s)" % (started.strftime("%Y-%m-%d %H:%M UTC"), "APPLIED" if APPLY else "dry run"), ""]
    lines.append("Sheet rows: %d · matched: %d · to create: %d · to update: %d · in Event Manager but not in sheet: %d" % (
        len(sheet), len(sheet) - len(creates), len(creates), len(changes), len(gone)))
    lines.append("")
    if creates:
        lines.append("## New in the sheet → created (unpublished, no lead scanning)")
        for rec, want in creates:
            lines.append("- **%s** — %s" % (rec["company"], ", ".join("%s=%s" % (k, v) for k, v in want.items() if v not in (None, ""))))
        lines.append("")
    if changes:
        lines.append("## Updated from the sheet")
        for r, rec, diff in changes:
            lines.append("- **%s** (id %d)" % (r["company_name"], r["id"]))
            for f, v in diff.items():
                lines.append("  - %s: `%s` → `%s`" % (f, r[f] if r[f] not in (None, "") else "—", v))
        lines.append("")
    if gone:
        lines.append("## In the Event Manager but not in the sheet (left untouched)")
        for r in gone: lines.append("- %s (id %d, %s)" % (r["company_name"], r["id"], r["stage"]))
        lines.append("")
    issues = [(rec["row"], rec["company"], i) for rec in sheet for i in rec["issues"]]
    issues += [(rec["row"], rec["company"], n) for rec in sheet for n in [vs.booth_note(rec)] if n]
    if issues:
        lines.append("## Sheet rows worth a look")
        for row, name, i in issues: lines.append("- row %d %s: %s" % (row, name, i))
        lines.append("")

    if APPLY:
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        with open(LOG, "a") as log:
            for rec, want in creates:
                fields = {k: v for k, v in want.items() if v not in (None, "")}
                fields.update({"event_id": EVENT, "company_name": rec["company"], "contact_email": fields.get("contact_email", ""),
                               "access_token": os.urandom(16).hex(), "is_published": 0, "can_scan_leads": 0,
                               "category": "Exhibitor", "sort_order": 0, "created_at": now, "sheet_synced_at": now,
                               "payment_status": fields.get("payment_status", "unpaid")})
                db.execute("INSERT INTO exhibitors (%s) VALUES (%s)" % (", ".join(fields), ", ".join("?" * len(fields))), list(fields.values()))
                log.write(json.dumps({"at": now, "op": "create", "company": rec["company"], "fields": fields}, default=str) + "\n")
            for r, rec, diff in changes:
                sets = dict(diff); sets["sheet_synced_at"] = now
                db.execute("UPDATE exhibitors SET %s WHERE id=?" % ", ".join("%s=?" % k for k in sets), list(sets.values()) + [r["id"]])
                log.write(json.dumps({"at": now, "op": "update", "id": r["id"], "company": r["company_name"],
                                      "before": {f: r[f] for f in diff}, "after": diff}, default=str) + "\n")
            for rec in sheet:   # a clean row still gets its sync stamp
                r = by_name.get(vs.norm_name(rec["company"]))
                if r is not None: db.execute("UPDATE exhibitors SET sheet_synced_at=? WHERE id=?", (now, r["id"]))
        db.commit()
    out = "\n".join(lines)
    with open(LATEST, "w") as f: f.write(out + "\n")
    print(out)


if __name__ == "__main__":
    main()
