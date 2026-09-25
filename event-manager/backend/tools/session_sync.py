# -*- coding: utf-8 -*-
"""Mirror the schedule tab of the planning sheet into the Event Manager.

    python3 tools/session_sync.py            # dry run
    python3 tools/session_sync.py --apply    # write it

The sheet decides the running order: day, start, end (or length), title,
speaker, room, type, track, description, and whether a row is published to
attendees ("Publish?"). Nothing else here is invented: a session appears in
the app only when the sheet gives it a day and a start time, and only goes
live when the sheet says so, because a half-written schedule shown to 339
attendees is worse than an empty one.

Rows are keyed by their position in the sheet (external_id "sheet:<gid>:<row>"),
so renaming a talk edits it instead of creating a second one. A row deleted
from the sheet is reported and UNPUBLISHED, never deleted here — attendance
and saved-session records hang off these rows.
"""
import json, os, sqlite3, sys
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import session_sheet as sh
import speaker_sheet as ss

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HERE, "event.db")
DATA = os.path.join(HERE, "data")
LOG = os.path.join(DATA, "session-sync.log")
LATEST = os.path.join(DATA, "session-sync-latest.md")
EVENT = int(os.environ.get("SESSION_SHEET_EVENT", os.environ.get("VENDOR_SHEET_EVENT", "1")))
APPLY = "--apply" in sys.argv

FIELDS = ("title", "description", "session_type", "track", "room", "start_time", "end_time", "is_published")


def same(field, stored, want):
    """Compare a stored column with what the sheet asks for.

    `0` is a value, not an absence: an unpublished session compared with
    `stored or ""` reads as empty and every run reported it as changed again.
    """
    if field == "is_published":
        return bool(stored) == bool(want)
    a = "" if stored is None else str(stored).strip()
    b = "" if want is None else str(want).strip()
    if field in ("start_time", "end_time"):
        a, b = a[:19], b[:19]                      # sqlite may keep microseconds
    return a == b


def want_of(rec):
    return {"title": rec["title"], "description": rec["description"],
            "session_type": rec["type"] or "talk", "track": rec["track"], "room": rec["room"],
            "start_time": rec["start_time"].isoformat(sep=" ") if rec["start_time"] else None,
            "end_time": rec["end_time"].isoformat(sep=" ") if rec["end_time"] else None,
            "is_published": 1 if (rec["publish"] and rec["start_time"]) else 0}


def main():
    os.makedirs(DATA, exist_ok=True)
    started = datetime.now(timezone.utc)
        # Wait for the door, rather than skipping a sync: the service writes to
    # the same file, and a busy moment is exactly when the sheet matters.
    db = sqlite3.connect(DB, timeout=30); db.row_factory = sqlite3.Row
    ev = db.execute("SELECT id, name, start_date FROM events WHERE id=?", (EVENT,)).fetchone()
    if not ev:
        raise SystemExit("no event %d" % EVENT)
    event_start = datetime.fromisoformat(str(ev["start_date"]))

    # A local CSV stands in for the tab, so the mirror can be exercised
    # end to end before the team has made one (see test_schedule_sync.py).
    src = next((a for a in sys.argv[1:] if a.endswith(".csv")), None)
    if src:
        text = open(src, encoding="utf-8-sig").read()
        col = sh._map_header([c.strip() for c in next(__import__("csv").reader(__import__("io").StringIO(text)))])
        found = ("local", text, col) if ("title" in col and "start" in col and ("day" in col or "date" in col)) else None
    else:
        found = sh.find_tab()
    L = ["# Schedule sheet sync — %s (%s)" % (started.strftime("%Y-%m-%d %H:%M UTC"), "APPLIED" if APPLY else "dry run"), ""]
    if not found:
        L += ["**No schedule tab in the workbook yet**, so nothing was changed.",
              "",
              "Add a tab to the Elevate 2026 workbook with these headers and the running order",
              "starts flowing at the next sync (six times a day):", "",
              "    Day | Start | End | Length | Title | Speaker | Room | Type | Track | Description | Publish?",
              "",
              "Day takes `Day 1`, `Fri`, `20 Nov` or `2026-11-20`; Start/End take `9:00 AM`, `09:00` or `9am`;",
              "End can be left out when Length (`30 min`) is given. A row reaches attendees only when it has a",
              "day and a start time **and** Publish? says yes.", ""]
        out = "\n".join(L)
        open(LATEST, "w").write(out + "\n"); print(out); return

    gid, text, col = found
    sheet = sh.parse(text, col, event_start, gid)
    rows = db.execute("SELECT * FROM sessions WHERE event_id=?", (EVENT,)).fetchall()
    byext = {r["external_id"]: r for r in rows if r["external_id"]}
    speakers = {ss.norm_name(r["name"]): r["id"] for r in db.execute("SELECT id, name FROM speakers WHERE event_id=?", (EVENT,))}

    creates, changes, links, seen = [], [], [], set()
    for rec in sheet:
        want = want_of(rec)
        r = byext.get(rec["external_id"])
        seen.add(rec["external_id"])
        if r is None:
            creates.append((rec, want))
        else:
            diff = {f: v for f, v in want.items() if not same(f, r[f], v)}
            if diff:
                changes.append((r, rec, diff))
        for name in rec["speakers"]:
            key = ss.match(ss.norm_name(name), speakers)
            links.append((rec["external_id"], name, speakers.get(key) if key else None))
    gone = [r for r in rows if r["external_id"] and r["external_id"].startswith("sheet:") and r["external_id"] not in seen]

    L.append("Schedule tab gid %s · %d rows · in the app: %d · to add: %d · to update: %d · dropped from the sheet: %d"
             % (gid, len(sheet), len(rows), len(creates), len(changes), len(gone)))
    L.append("")
    if creates:
        L.append("## Added from the sheet")
        for rec, want in creates:
            L.append("- **%s** — %s%s%s" % (rec["title"],
                     rec["start_time"].strftime("%a %d %b %H:%M") if rec["start_time"] else "no time yet",
                     (" · " + rec["room"]) if rec["room"] else "",
                     " · live" if want["is_published"] else " · draft"))
        L.append("")
    if changes:
        L.append("## Updated from the sheet")
        for r, rec, diff in changes:
            L.append("- **%s** (id %d)" % (r["title"], r["id"]))
            for f, v in diff.items():
                L.append("  - %s: `%s` → `%s`" % (f, r[f] if r[f] not in (None, "") else "—", v if v not in (None, "") else "—"))
        L.append("")
    if gone:
        L.append("## Dropped from the sheet (unpublished here, not deleted)")
        for r in gone:
            L.append("- %s" % r["title"])
        L.append("")
    unknown = sorted({n for _, n, sid in links if sid is None})
    if unknown:
        L.append("## Speakers named in the schedule that are not on the Speakers tab")
        for n in unknown:
            L.append("- %s" % n)
        L.append("")
    issues = [(r["row"], r["title"], i) for r in sheet for i in r["issues"]]
    if issues:
        L.append("## Rows worth a look")
        for row, title, i in issues:
            L.append("- row %d %s: %s" % (row, title, i))
        L.append("")

    if APPLY:
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        with open(LOG, "a") as log:
            for i, (rec, want) in enumerate(creates):
                fields = dict(want)
                fields.update({"event_id": EVENT, "external_id": rec["external_id"],
                               "sort_order": rec["row"], "created_at": now, "updated_at": now})
                db.execute("INSERT INTO sessions (%s) VALUES (%s)" % (", ".join(fields), ", ".join("?" * len(fields))),
                           list(fields.values()))
                log.write(json.dumps({"at": now, "op": "create", "title": rec["title"], "fields": fields}, default=str) + "\n")
            for r, rec, diff in changes:
                sets = dict(diff); sets["updated_at"] = now; sets["sort_order"] = rec["row"]
                db.execute("UPDATE sessions SET %s WHERE id=?" % ", ".join("%s=?" % k for k in sets),
                           list(sets.values()) + [r["id"]])
                log.write(json.dumps({"at": now, "op": "update", "id": r["id"], "title": r["title"],
                                      "before": {f: r[f] for f in diff}, "after": diff}, default=str) + "\n")
            for r in gone:
                db.execute("UPDATE sessions SET is_published=0, updated_at=? WHERE id=?", (now, r["id"]))
                log.write(json.dumps({"at": now, "op": "unpublish", "id": r["id"], "title": r["title"]}) + "\n")
            # speaker links, rebuilt for the rows this sheet owns
            db.commit()
            ids = {r["external_id"]: r["id"] for r in db.execute("SELECT id, external_id FROM sessions WHERE event_id=?", (EVENT,)) if r["external_id"]}
            for ext in seen:
                sid = ids.get(ext)
                if not sid:
                    continue
                db.execute("DELETE FROM session_speakers WHERE session_id=?", (sid,))
                for e, _n, spid in links:
                    if e == ext and spid:
                        db.execute("INSERT OR IGNORE INTO session_speakers (session_id, speaker_id) VALUES (?, ?)", (sid, spid))
        db.commit()
    out = "\n".join(L)
    open(LATEST, "w").write(out + "\n")
    print(out)


if __name__ == "__main__":
    main()
