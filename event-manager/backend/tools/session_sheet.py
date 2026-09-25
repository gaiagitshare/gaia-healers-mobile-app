# -*- coding: utf-8 -*-
"""The schedule tab of the "Elevate 2026" planning sheet, if the team has made
one yet. Reads nothing else and writes nothing.

There is no schedule tab today — the event site still says "you'll receive a
detailed schedule closer to November" — so this looks for one by its columns
rather than by a fixed gid, and says so plainly when it is not there. Add a
tab with these headers and the running order starts flowing on the next sync:

    Day | Start | End | Length | Title | Speaker | Room | Type | Track | Description | Publish?

Day accepts "Day 1", "Fri", "20 Nov", "2026-11-20"; Start/End accept "9:00 AM",
"09:00", "9am". End may be left out when Length ("30 min") is given.
"""
import csv, io, re, sys, urllib.request
from datetime import datetime, timedelta
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from vendor_sheet import SHEET_ID, fetch_csv

TAB_URL = "https://docs.google.com/spreadsheets/d/%s/export?format=csv&gid=%s"
VIEW_URL = "https://docs.google.com/spreadsheets/d/%s/htmlview" % SHEET_ID
# Header synonyms -> our field. The team writes the sheet, not us.
FIELDS = {
    "day": ("day", "date", "when"),
    "start": ("start", "start time", "time", "from"),
    "end": ("end", "end time", "until", "to"),
    "length": ("length", "session length", "duration", "mins", "minutes"),
    "title": ("title", "session", "session title", "talk", "topic"),
    "speaker": ("speaker", "speakers", "presenter", "who"),
    "room": ("room", "location", "where", "stage"),
    "type": ("type", "session type", "format"),
    "track": ("track",),
    "description": ("description", "summary", "notes", "about"),
    "publish": ("publish?", "publish", "live?", "show in app", "published"),
}
DAY_WORDS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


def _gids(timeout=30):
    req = urllib.request.Request(VIEW_URL, headers={"User-Agent": "gaia-event-manager/schedule-sync"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return sorted(set(re.findall(r"gid=(\d+)", r.read().decode("utf-8", "ignore"))))


def _map_header(header):
    got = {}
    for i, cell in enumerate(header):
        c = re.sub(r"\s+", " ", (cell or "").strip().lower())
        for field, names in FIELDS.items():
            if c in names and field not in got:
                got[field] = i
    return got


def find_tab(gids=None):
    """-> (gid, csv_text, column map) for the schedule tab, or None."""
    for gid in (gids or _gids()):
        try:
            text = fetch_csv(TAB_URL % (SHEET_ID, gid))
        except Exception:
            continue
        rows = list(csv.reader(io.StringIO(text)))[:8]
        for r in rows:
            col = _map_header([c.strip() for c in r])
            if "title" in col and "start" in col and ("day" in col or "date" in col):
                return gid, text, col
    return None


def _parse_day(v, event_start):
    v = (v or "").strip()
    if not v:
        return None
    m = re.fullmatch(r"day\s*(\d+)", v, re.I)
    if m:
        return (event_start + timedelta(days=int(m.group(1)) - 1)).date()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d %b %Y", "%b %d %Y", "%d %B %Y", "%B %d %Y"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            pass
    for fmt in ("%d %b", "%b %d", "%d %B", "%B %d"):           # no year: the event's
        try:
            d = datetime.strptime(v, fmt)
            return d.replace(year=event_start.year).date()
        except ValueError:
            pass
    w = DAY_WORDS.get(v[:3].lower())                            # "Fri", "Friday"
    if w is not None:
        for i in range(0, 14):
            d = (event_start + timedelta(days=i)).date()
            if d.weekday() == w:
                return d
    return None


def _parse_time(v):
    v = re.sub(r"\s+", "", (v or "")).lower().replace(".", ":")
    if not v:
        return None
    m = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?(am|pm)?", v)
    if not m:
        return None
    h, mi, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3)
    if ap == "pm" and h < 12:
        h += 12
    if ap == "am" and h == 12:
        h = 0
    return (h, mi) if 0 <= h < 24 and 0 <= mi < 60 else None


def _minutes(v):
    m = re.search(r"(\d+)", v or "")
    return int(m.group(1)) if m else None


def parse(csv_text, col, event_start, gid="0"):
    """-> list of session dicts in sheet order. `event_start` is a datetime."""
    rows = list(csv.reader(io.StringIO(csv_text)))
    hi = next(i for i, r in enumerate(rows) if _map_header([c.strip() for c in r]) == col
              or ("title" in _map_header([c.strip() for c in r])))
    out = []
    for n, r in enumerate(rows[hi + 1:], start=hi + 2):
        cells = [re.sub(r"\s+", " ", (c or "").strip()) for c in r] + [""] * 40
        get = lambda f: cells[col[f]] if f in col else ""
        title = get("title")
        if not title or title.lower() in ("title", "session"):
            continue
        rec = {"row": n, "gid": gid, "external_id": "sheet:%s:%d" % (gid, n),
               "title": title, "room": get("room") or None, "track": get("track") or None,
               "description": get("description") or None,
               "type": (get("type") or "talk").lower(),
               "speakers": [s.strip() for s in re.split(r"[,;&/]| and ", get("speaker")) if s.strip()],
               "publish": (get("publish") or "").strip().lower().startswith(("y", "true", "1")),
               "issues": []}
        day = _parse_day(get("day") or get("date"), event_start)
        start = _parse_time(get("start"))
        end = _parse_time(get("end"))
        mins = _minutes(get("length"))
        if day is None:
            rec["issues"].append("day %r not understood" % (get("day") or get("date")))
        if start is None:
            rec["issues"].append("start time %r not understood" % get("start"))
        if day and start:
            rec["start_time"] = datetime.combine(day, datetime.min.time()).replace(hour=start[0], minute=start[1])
            if end:
                e = datetime.combine(day, datetime.min.time()).replace(hour=end[0], minute=end[1])
                if e <= rec["start_time"]:
                    e += timedelta(days=1)
                rec["end_time"] = e
            elif mins:
                rec["end_time"] = rec["start_time"] + timedelta(minutes=mins)
            else:
                rec["end_time"] = None
                rec["issues"].append("no end time and no length")
        else:
            rec["start_time"] = rec["end_time"] = None
        out.append(rec)
    return out


if __name__ == "__main__":
    found = find_tab()
    if not found:
        print("No schedule tab in the workbook yet. Add a tab with these headers and it will sync:")
        print("  Day | Start | End | Length | Title | Speaker | Room | Type | Track | Description | Publish?")
        raise SystemExit(0)
    gid, text, col = found
    print("schedule tab gid=%s, columns: %s" % (gid, ", ".join(sorted(col))))
    for r in parse(text, col, datetime(2026, 11, 20, 9, 0), gid):
        print("  %-16s %-34s %-22s %s" % (
            r["start_time"].strftime("%a %d %H:%M") if r["start_time"] else "(no time)",
            r["title"][:34], ", ".join(r["speakers"])[:22], "; ".join(r["issues"])))
