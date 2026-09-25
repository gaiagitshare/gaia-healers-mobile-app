# -*- coding: utf-8 -*-
"""Mirror the speaker tab of the planning sheet into the Event Manager.

    python3 tools/speaker_sync.py            # dry run: print what WOULD change
    python3 tools/speaker_sync.py --apply    # write it

What the sheet decides: who is speaking, their company, and the team's
checklist for them (session length, topic, headshot/bio/deck received).
What the sheet never touches: the bio and headshot shown in the app, the
links, the running order, and whether a speaker is published -- those are
written by the team here, and the sheet has no column for any of them.

A speaker the sheet adds is created UNPUBLISHED on purpose: without a bio
and a photo their card in the app is an empty rectangle. The report says who
is waiting on what, which is the same list the team keeps in the sheet.
Nobody is ever deleted: a speaker the sheet drops is reported, not removed.
"""
import json, os, sqlite3, sys
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import speaker_sheet as ss

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HERE, "event.db")
DATA = os.path.join(HERE, "data")
LOG = os.path.join(DATA, "speaker-sync.log")
LATEST = os.path.join(DATA, "speaker-sync-latest.md")
EVENT = int(os.environ.get("SPEAKER_SHEET_EVENT", os.environ.get("VENDOR_SHEET_EVENT", "1")))
APPLY = "--apply" in sys.argv
SRC = next((a for a in sys.argv[1:] if a.endswith(".csv")), None)


def main():
    os.makedirs(DATA, exist_ok=True)
    started = datetime.now(timezone.utc)
    sheet = ss.parse(open(SRC, encoding="utf-8-sig").read() if SRC else ss.fetch())
    if len(sheet) < 3:
        raise SystemExit("refusing: the speaker tab parsed with fewer than 3 speakers — layout changed?")
        # Wait for the door, rather than skipping a sync: the service writes to
    # the same file, and a busy moment is exactly when the sheet matters.
    db = sqlite3.connect(DB, timeout=30); db.row_factory = sqlite3.Row
    cols = {r[1] for r in db.execute("PRAGMA table_info(speakers)")}
    for col, ddl in (("sheet_notes", "TEXT"), ("sheet_synced_at", "DATETIME")):
        if col not in cols:
            db.execute("ALTER TABLE speakers ADD COLUMN %s %s" % (col, ddl))
    rows = db.execute("SELECT * FROM speakers WHERE event_id=?", (EVENT,)).fetchall()
    bykey = {ss.norm_name(r["name"]): r for r in rows}

    # The Company column sometimes holds a talk title ("The Future of Medicine
    # is Illuminated"). The app prints company under the speaker's name, so a
    # sentence there reads as a mistake to every attendee; it is reported
    # instead of written, and the sheet is where it gets fixed.
    def looks_like_company(v):
        v = (v or "").strip()
        return bool(v) and len(v.split()) <= 4 and " is " not in (" " + v.lower() + " ")

    creates, changes, seen, odd_company = [], [], set(), []
    for rec in sheet:
        key = ss.match(rec["key"], bykey)
        if rec["company"] and not looks_like_company(rec["company"]):
            odd_company.append((rec["row"], rec["name"], rec["company"]))
        want = {"company": rec["company"] if looks_like_company(rec["company"]) else None,
                "sheet_notes": ss.notes(rec) or None}
        if key is None:
            creates.append((rec, want)); continue
        seen.add(key)
        r = bykey[key]
        diff = {f: v for f, v in want.items() if v and (r[f] or "").strip() != v}
        if diff:
            changes.append((r, rec, diff))
    gone = [r for r in rows if ss.norm_name(r["name"]) not in seen]
    waiting = [r for r in sheet if not r["bio"] or not r["headshot"]]

    L = ["# Speaker sheet sync — %s (%s)" % (started.strftime("%Y-%m-%d %H:%M UTC"), "APPLIED" if APPLY else "dry run"), ""]
    L.append("Sheet: %d speakers · in the app: %d · to add: %d · to update: %d · in the app but not in the sheet: %d"
             % (len(sheet), len(rows), len(creates), len(changes), len(gone)))
    L.append("")
    if creates:
        L.append("## Added from the sheet (unpublished until they have a bio and a headshot)")
        for rec, want in creates:
            L.append("- **%s**%s — %s" % (rec["name"], (" · " + rec["company"]) if rec["company"] else "", ss.notes(rec) or "nothing else on file"))
        L.append("")
    if changes:
        L.append("## Updated from the sheet")
        for r, rec, diff in changes:
            L.append("- **%s** (id %d)" % (r["name"], r["id"]))
            for f, v in diff.items():
                L.append("  - %s: `%s` → `%s`" % (f, r[f] if r[f] not in (None, "") else "—", v))
        L.append("")
    if gone:
        L.append("## In the app but not in the sheet (left untouched)")
        for r in gone:
            L.append("- %s" % r["name"])
        L.append("")
    if waiting:
        L.append("## Still waiting on material (the sheet's own columns)")
        for r in waiting:
            need = ", ".join(n for n, v in (("headshot", r["headshot"]), ("bio", r["bio"])) if not v)
            L.append("- %s — no %s recorded" % (r["name"], need))
        L.append("")
    issues = [(r["row"], r["name"], i) for r in sheet for i in r["issues"]]
    issues += [(row, name, "the Company column holds %r, which reads as a talk title — not written" % v)
               for row, name, v in odd_company]
    if issues:
        L.append("## Rows worth a look")
        for row, name, i in issues:
            L.append("- row %d %s: %s" % (row, name, i))
        L.append("")

    if APPLY:
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        nxt = (max([r["sort_order"] or 0 for r in rows]) + 1) if rows else 0
        with open(LOG, "a") as log:
            for i, (rec, want) in enumerate(creates):
                fields = {"event_id": EVENT, "name": rec["name"], "company": want["company"],
                          "sheet_notes": want["sheet_notes"], "is_published": 0, "is_featured": 0,
                          "sort_order": nxt + i, "links": "{}", "created_at": now, "sheet_synced_at": now}
                db.execute("INSERT INTO speakers (%s) VALUES (%s)" % (", ".join(fields), ", ".join("?" * len(fields))),
                           list(fields.values()))
                log.write(json.dumps({"at": now, "op": "create", "name": rec["name"], "fields": fields}, default=str) + "\n")
            for r, rec, diff in changes:
                sets = dict(diff); sets["sheet_synced_at"] = now
                db.execute("UPDATE speakers SET %s WHERE id=?" % ", ".join("%s=?" % k for k in sets),
                           list(sets.values()) + [r["id"]])
                log.write(json.dumps({"at": now, "op": "update", "id": r["id"], "name": r["name"],
                                      "before": {f: r[f] for f in diff}, "after": diff}, default=str) + "\n")
            for rec in sheet:
                key = ss.match(rec["key"], bykey)
                if key is not None:
                    db.execute("UPDATE speakers SET sheet_synced_at=? WHERE id=?", (now, bykey[key]["id"]))
        db.commit()
    out = "\n".join(L)
    with open(LATEST, "w") as f:
        f.write(out + "\n")
    print(out)


if __name__ == "__main__":
    main()
