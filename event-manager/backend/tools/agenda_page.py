# -*- coding: utf-8 -*-
"""Read the public Elevate agenda page (elevate.gaiahealers.com/agenda) into rows.

The team edits that page by hand in GoHighLevel; it is the only live schedule
(28 Oct 2026). It has no feed, so this parses its markup -- the classes it uses
for every row (ag-row / ag-workshop-row / ag-add-card with ag-time,
ag-speaker-name, ag-talk-title, ...). If the page stops looking like that, parse
returns problems instead of guessing, and the sync refuses to apply.

Each row gets a stable key that survives the edits the page actually receives:
day + speaker for a talk (so swapping two talks' times, or retitling one,
updates it), day + workshop name for a workshop, day + label + order for
breaks and notices.
"""
import html as _html
import re
from datetime import date, datetime, time, timedelta
from html.parser import HTMLParser

PAGE_URL = "https://elevate.gaiahealers.com/agenda"
DAYS = {"fri": date(2026, 11, 20), "sat": date(2026, 11, 21), "sun": date(2026, 11, 22)}
FIELDS = ("ag-time", "ag-speaker-name", "ag-talk-title", "ag-break-label", "ag-exhibit-label",
          "ag-workshop-name", "ag-workshop-detail", "ag-add-name", "ag-add-detail", "ag-add-time",
          "ag-panel-heading")
ROWS = ("ag-row", "ag-workshop-row", "ag-add-card")
VOID = ("img", "br", "hr", "input", "meta", "link", "source", "path", "rect", "polyline", "polygon",
        "circle", "line", "ellipse", "use", "stop")


class _Walker(HTMLParser):
    """Collects text per field inside each row, with the panel it sits in."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []          # (tag, classes, id)
        self.panel = None        # ag-fri / ag-sat / ag-workshops
        self.rows = []
        self.cur = None
        self.field = None
        self.depth_row = None
        self.depth_field = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = (a.get("class") or "").split()
        if tag in VOID:
            if tag == "img" and self.cur is not None and "photo" not in self.cur:
                self.cur["photo"] = a.get("src") or ""
            return
        self.stack.append(tag)
        pid = a.get("id") or ""
        if pid in ("ag-fri", "ag-sat", "ag-workshops"):
            self.panel = pid
        if self.cur is None and any(c in ROWS for c in cls):
            self.cur = {"panel": self.panel, "kind": next(c for c in cls if c in ROWS), "classes": cls}
            self.depth_row = len(self.stack)
        elif self.cur is not None and self.field is None:
            hit = next((c for c in cls if c in FIELDS), None)
            if hit:
                self.field = hit
                self.depth_field = len(self.stack)
                self.cur.setdefault(hit, "")
        elif self.cur is None:
            hit = next((c for c in cls if c == "ag-panel-heading"), None)
            if hit:
                self.field = hit
                self.depth_field = len(self.stack)

    def handle_endtag(self, tag):
        # Self-closing SVG shapes (<rect .../>) arrive here too, but were never
        # pushed: popping for them would unbalance every row after an icon.
        if not self.stack or tag in VOID:
            return
        depth = len(self.stack)
        self.stack.pop()
        if self.field is not None and depth == self.depth_field:
            self.field = None
        if self.cur is not None and depth == self.depth_row:
            self.rows.append(self.cur)
            self.cur = None

    def handle_data(self, data):
        if self.field and self.cur is not None:
            self.cur[self.field] = (self.cur[self.field] + " " + data).strip()


def _clean(s):
    return re.sub(r"\s+", " ", _html.unescape(s or "")).replace("\u00a0", " ").strip(" \u00b7\u2726")


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:60]


def _clock(tok, pm_hint=None):
    tok = tok.strip().upper().replace(".", "")
    m = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?", tok)
    if not m:
        return None, None
    h, mi, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3) or pm_hint
    if ap == "PM" and h != 12:
        h += 12
    if ap == "AM" and h == 12:
        h = 0
    return time(h, mi), m.group(3)


def parse_range(text):
    """'10:20 – 10:50 AM' / '11:15 AM – 12:15 PM' / '9:00 AM' -> (start, end) times."""
    t = _clean(text).replace("–", "-").replace("—", "-")
    parts = [p.strip() for p in t.split("-")]
    if len(parts) == 1:
        s, _ = _clock(parts[0])
        return s, None
    end, end_ap = _clock(parts[1])
    start, start_ap = _clock(parts[0], pm_hint=end_ap)
    if start and end and start > end and end_ap == "PM" and not start_ap:
        start, _ = _clock(parts[0], pm_hint="AM")          # "11:15 - 12:15 PM"
    return start, end


def _days_in(text):
    t = (text or "").lower()
    found = [d for d in ("fri", "sat", "sun") if re.search(r"\b%s" % d, t)]
    return found


def parse(page_html):
    """Return (rows, problems). Each row: key, day, title, speaker, kind, start, end, room, description."""
    w = _Walker()
    w.feed(page_html)
    out, problems, counters = [], [], {}
    for r in w.rows:
        panel = r.get("panel")
        kind = r.get("kind")
        if kind == "ag-add-card":
            name = _clean(r.get("ag-add-name"))
            detail = _clean(r.get("ag-add-detail"))
            when = _clean(r.get("ag-add-time"))
            if "private event" in detail.lower():
                continue                                      # not on the public schedule
            day_part, _, clock = when.rpartition("·") if "·" in when else ("", "", when)
            days = _days_in(day_part) or _days_in(detail)
            if not days:
                problems.append("additional workshop %r has no day" % name)
                continue
            start, end = parse_range(clock)
            m = re.search(r"with ([^·]+)", detail)
            if m:
                speaker = _clean(m.group(1))
            elif re.search(r"\b(Dr\.|PhD|MD|DNM)\b", name):
                # A card headed by the person ("Dr. Jahani, PhD") with the
                # session in its detail line.
                speaker, name = name, _clean(re.split(r"·|John", detail)[0]) or name
            else:
                speaker = _clean(detail.split("·")[0]) if "·" in detail else None
            rm = re.search(r"(John['’]s\s*\d+\s*[–-]\s*\d+|Room\s+[\w-]+)", detail, re.I)
            room = _clean(rm.group(1)) if rm else None
            for d in days:
                out.append({"key": "page:%s:workshop:%s" % (d, _slug(name)), "day": d, "kind": "workshop",
                            "title": name, "speaker": speaker, "start": start, "end": end,
                            "room": room or "Workshops", "description": detail})
            continue
        day = {"ag-fri": "fri", "ag-sat": "sat", "ag-workshops": "sun"}.get(panel)
        if not day:
            continue
        start, end = parse_range(r.get("ag-time") or "")
        if r.get("ag-speaker-name") or r.get("ag-talk-title"):
            speaker = _clean(r.get("ag-speaker-name"))
            title = _clean(r.get("ag-talk-title")) or speaker
            base = "page:%s:talk:%s" % (day, _slug(speaker or title))
            n = counters[base] = counters.get(base, 0) + 1
            out.append({"key": base + ("" if n == 1 else ":%d" % n), "day": day, "kind": "talk", "title": title,
                        "speaker": speaker, "start": start, "end": end, "room": "Main Stage", "description": None})
        elif r.get("ag-workshop-name"):
            name = _clean(r.get("ag-workshop-name"))
            detail = _clean(r.get("ag-workshop-detail"))
            m = re.match(r"with ([^—-]+)", detail)
            out.append({"key": "page:%s:workshop:%s" % (day, _slug(name)), "day": day, "kind": "workshop",
                        "title": name, "speaker": _clean(m.group(1)) if m else None, "start": start, "end": end,
                        "room": "Workshops", "description": detail or None})
        elif r.get("ag-break-label") or r.get("ag-exhibit-label"):
            label = _clean(r.get("ag-break-label") or r.get("ag-exhibit-label"))
            base = "page:%s:%s:%s" % (day, "break" if r.get("ag-break-label") else "info", _slug(label))
            n = counters[base] = counters.get(base, 0) + 1
            out.append({"key": base + ":%d" % n, "day": day, "kind": "break" if r.get("ag-break-label") else "info",
                        "title": label, "speaker": None, "start": start, "end": end,
                        "room": "Main Stage" if day != "sun" else "Workshops", "description": None})
    for row in out:
        if row["start"] is None:
            problems.append("%s %r has no readable time" % (row["day"], row["title"]))
    talks = [r for r in out if r["kind"] == "talk"]
    if len(talks) < 10:
        problems.append("only %d talks found; the page layout may have changed" % len(talks))
    return out, problems


def at(day, t):
    return datetime.combine(DAYS[day], t) if (day in DAYS and t) else None
