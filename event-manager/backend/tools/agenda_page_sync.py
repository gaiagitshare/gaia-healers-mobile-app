# -*- coding: utf-8 -*-
"""Mirror the public agenda page (elevate.gaiahealers.com/agenda) into the Event Manager.

    python3 tools/agenda_page_sync.py [page.html]            # dry run
    python3 tools/agenda_page_sync.py --apply [page.html]    # write it

OFF unless AGENDA_PAGE_SYNC=1 (it then runs with the other mirrors every 30
minutes from sheet_sync_all.py). Until the organiser picks where the schedule
lives, this keeps the app's agenda in step with the only live schedule there is.
If the planning sheet gets a Schedule tab instead, leave this off: session_sync.py
owns that source, and only one of the two should be switched on.

Same rules as the sheet mirror: rows are keyed (page:<day>:<kind>:<name>), so a
moved or retitled talk is updated, not duplicated; a row that leaves the page is
reported and UNPUBLISHED, never deleted (attendance and saved sessions hang off
it). Sessions arrive as drafts unless AGENDA_PAGE_PUBLISH=1. If the page no
longer parses the way it should, nothing is applied and the run exits 1.
"""
import json, os, sqlite3, sys, urllib.request
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agenda_page as ap
import speaker_sheet as ss

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DBURL = os.environ.get("DATABASE_URL", "")
DB = (_DBURL.split("sqlite:///", 1)[1] if _DBURL.startswith("sqlite:///") else os.path.join(HERE, "event.db"))
DATA = os.environ.get("VENDOR_SYNC_DATA") or os.path.join(HERE, "data")
LOG = os.path.join(DATA, "agenda-page-sync.log")
LATEST = os.path.join(DATA, "agenda-page-sync-latest.md")
EVENT = int(os.environ.get("SESSION_SHEET_EVENT", os.environ.get("VENDOR_SHEET_EVENT", "1")))
APPLY = "--apply" in sys.argv
SRC = next((a for a in sys.argv[1:] if a.endswith(".html")), None)
ENABLED = os.environ.get("AGENDA_PAGE_SYNC") == "1" or bool(SRC)
PUBLISH = os.environ.get("AGENDA_PAGE_PUBLISH") == "1"
FIELDS = ("title", "description", "session_type", "room", "start_time", "end_time", "is_published")


def fetch(url=ap.PAGE_URL, tries=3):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (GaiaAgendaSync)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:                                   # noqa: BLE001
            last = e
    raise SystemExit("could not read the agenda page: %s" % last)


WATCH = os.path.join(DATA, "agenda-page-watch.json")


def watch(text):
    """Record a fingerprint of the page's schedule and when it last changed."""
    import hashlib
    rows, problems = ap.parse(text)
    fp = hashlib.sha256(json.dumps([(r["key"], r["title"], str(r["start"]), str(r["end"]), r["room"]) for r in rows],
                                   sort_keys=True).encode()).hexdigest()[:16]
    try:
        prev = json.load(open(WATCH))
    except Exception:                                            # noqa: BLE001
        prev = {}
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")
    cur = {"checked_at": now, "fingerprint": fp, "rows": len(rows), "problems": problems,
           "changed_at": prev.get("changed_at") if prev.get("fingerprint") == fp else now,
           "first_seen_at": prev.get("first_seen_at") or now, "synced": False}
    tmp = WATCH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cur, f, indent=1)
    os.replace(tmp, WATCH)
    return cur


def want_of(row):
    title = row["title"]
    desc = row["description"]
    if row["kind"] == "talk" and row["speaker"]:
        desc = "with %s" % row["speaker"]
    s, e = ap.at(row["day"], row["start"]), ap.at(row["day"], row["end"])
    return {"title": title, "description": desc, "session_type": row["kind"], "room": row["room"],
            "start_time": s.isoformat(sep=" ") if s else None, "end_time": e.isoformat(sep=" ") if e else None,
            "is_published": 1 if (PUBLISH and s) else 0}


def same(field, stored, want):
    a = "" if stored is None else str(stored).strip()
    b = "" if want is None else str(want).strip()
    if field in ("start_time", "end_time"):
        return a[:16] == b[:16]
    if field == "is_published":
        return int(stored or 0) == int(want or 0)
    return a == b


def main():
    os.makedirs(DATA, exist_ok=True)
    if not ENABLED:
        # Even off, watch the page: if the public schedule changes while nothing
        # carries it into the app, the health checks should say so.
        if os.environ.get("AGENDA_PAGE_WATCH", "1") == "1" and not SRC:
            watch(fetch())
        print("agenda page mirror is off (set AGENDA_PAGE_SYNC=1 to run it)")
        return 0
    text = open(SRC, encoding="utf-8").read() if SRC else fetch()
    page, problems = ap.parse(text)
    started = datetime.now(timezone.utc)
    L = ["# Agenda page sync — %s (%s)" % (started.strftime("%Y-%m-%d %H:%M UTC"), "APPLIED" if APPLY else "dry run"), ""]
    if problems:
        L += ["## The page did not parse cleanly — nothing applied", ""] + ["- %s" % p for p in problems]
        out = "\n".join(L); open(LATEST, "w").write(out + "\n"); print(out)
        return 1
    db = sqlite3.connect(DB, timeout=30); db.row_factory = sqlite3.Row
    rows = db.execute("SELECT * FROM sessions WHERE event_id=?", (EVENT,)).fetchall()
    byext = {r["external_id"]: r for r in rows if r["external_id"]}
    speakers = {ss.norm_name(r["name"]): r["id"] for r in db.execute("SELECT id, name FROM speakers WHERE event_id=?", (EVENT,))}
    creates, changes, links, seen = [], [], [], set()
    for i, row in enumerate(page):
        want = want_of(row)
        seen.add(row["key"])
        r = byext.get(row["key"])
        if r is None:
            creates.append((i, row, want))
        else:
            diff = {f: v for f, v in want.items() if not same(f, r[f], v)}
            if diff:
                changes.append((i, r, row, diff))
        if row["speaker"]:
            # "Dr. Nima Farshid, PhD, DNM" on the page is "Dr. Nima Farshid" here:
            # credentials after the first comma are not part of the name.
            key = ss.match(ss.norm_name(row["speaker"].split(",")[0]), speakers)
            links.append((row["key"], row["speaker"], speakers.get(key) if key else None))
    dropped = [r for r in rows if (r["external_id"] or "").startswith("page:") and r["external_id"] not in seen]

    L.append("Agenda page · %d rows · in the app from this page: %d · to add: %d · to update: %d · gone from the page: %d · %s"
             % (len(page), sum(1 for r in rows if (r["external_id"] or "").startswith("page:")), len(creates), len(changes),
                len(dropped), "publishing" if PUBLISH else "drafts only"))
    L.append("")
    if creates:
        L.append("## Added from the page")
        for _, row, want in creates:
            L.append("- %s %s · %s%s" % (row["day"].title(), (want["start_time"] or "")[11:16], want["title"],
                                          (" · " + row["speaker"]) if row["speaker"] else ""))
        L.append("")
    if changes:
        L.append("## Updated from the page")
        for _, r, row, diff in changes:
            L.append("- **%s** (id %d)" % (r["title"], r["id"]))
            for f, v in diff.items():
                L.append("  - %s: `%s` → `%s`" % (f, r[f] if r[f] not in (None, "") else "—", v if v not in (None, "") else "—"))
        L.append("")
    if dropped:
        L.append("## No longer on the page (unpublished here, not deleted)")
        for r in dropped:
            L.append("- %s" % r["title"])
        L.append("")
    unknown = sorted({n for _, n, sid in links if sid is None})
    if unknown:
        L.append("## Speakers on the agenda who are not in the Event Manager")
        for n in unknown:
            L.append("- %s" % n)
        L.append("")

    if APPLY:
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        with open(LOG, "a") as log:
            for i, row, want in creates:
                fields = dict(want)
                fields.update({"event_id": EVENT, "external_id": row["key"], "sort_order": 1000 + i,
                               "created_at": now, "updated_at": now,
                               # Explicit, never NULL: the public agenda's schema
                               # rejects a NULL flag, and one such row took the
                               # whole agenda (app + website) down with a 500.
                               "is_featured": 0, "requires_registration": 0, "needs_workshop_pass": 0})
                db.execute("INSERT INTO sessions (%s) VALUES (%s)" % (", ".join(fields), ", ".join("?" * len(fields))),
                           list(fields.values()))
                log.write(json.dumps({"at": now, "op": "create", "key": row["key"], "fields": fields}, default=str) + "\n")
            for i, r, row, diff in changes:
                sets = dict(diff); sets["updated_at"] = now; sets["sort_order"] = 1000 + i
                db.execute("UPDATE sessions SET %s WHERE id=?" % ", ".join("%s=?" % k for k in sets),
                           list(sets.values()) + [r["id"]])
                log.write(json.dumps({"at": now, "op": "update", "id": r["id"], "key": row["key"],
                                      "before": {f: r[f] for f in diff}, "after": diff}, default=str) + "\n")
            for r in dropped:
                if int(r["is_published"] or 0):
                    db.execute("UPDATE sessions SET is_published=0, updated_at=? WHERE id=?", (now, r["id"]))
                    log.write(json.dumps({"at": now, "op": "unpublish", "id": r["id"], "title": r["title"]}) + "\n")
            db.commit()
            ids = {r["external_id"]: r["id"] for r in db.execute("SELECT id, external_id FROM sessions WHERE event_id=?", (EVENT,))
                   if r["external_id"]}
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
    if APPLY:
        w = watch(text)
        w["synced"] = True
        w["synced_at"] = w["checked_at"]
        with open(WATCH + ".tmp", "w") as f:
            json.dump(w, f, indent=1)
        os.replace(WATCH + ".tmp", WATCH)
    return 0


if __name__ == "__main__":
    sys.exit(main())
