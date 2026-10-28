# -*- coding: utf-8 -*-
"""Mirror the speaker cards on the public Elevate page into the Event Manager.

    python3 tools/speaker_page_sync.py [page.html]            # dry run
    python3 tools/speaker_page_sync.py --apply [page.html]    # write it

The team keeps the speaker line-up on the public event page
(elevate.gaiahealers.com/gaia-healers-elevate-conference-page): 16 cards with
name, topic, bio and photo (28 Oct 2026). The planning sheet only says who
speaks and for which company; it has no bio, photo or title. This carries the
page into the Event Manager so the app and the website embeds follow it.

OFF unless SPEAKER_PAGE_SYNC=1 (it then runs with the other mirrors every 30
minutes from sheet_sync_all.py). Rules:
  * a speaker on the page who is not in the Event Manager is created;
  * for one who is, only EMPTY fields are filled (role, bio, photo): anything
    already set in the app is the app's and is never overwritten;
  * SPEAKER_PAGE_PUBLISH=1 publishes the speakers the page shows publicly;
  * a speaker who leaves the page is reported, never unpublished or deleted
    (the sheet and the app own that);
  * if the page no longer parses (fewer than 5 cards), nothing is applied.
"""
import hashlib, html as _html, json, os, re, sqlite3, sys, urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import speaker_sheet as ss

PAGE_URL = "https://elevate.gaiahealers.com/gaia-healers-elevate-conference-page"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DBURL = os.environ.get("DATABASE_URL", "")
DB = (_DBURL.split("sqlite:///", 1)[1] if _DBURL.startswith("sqlite:///") else os.path.join(HERE, "event.db"))
DATA = os.environ.get("VENDOR_SYNC_DATA") or os.path.join(HERE, "data")
LOG = os.path.join(DATA, "speaker-page-sync.log")
LATEST = os.path.join(DATA, "speaker-page-sync-latest.md")
WATCH = os.path.join(DATA, "speaker-page-watch.json")
EVENT = int(os.environ.get("VENDOR_SHEET_EVENT", "1"))
APPLY = "--apply" in sys.argv
SRC = next((a for a in sys.argv[1:] if a.endswith(".html")), None)
ENABLED = os.environ.get("SPEAKER_PAGE_SYNC") == "1" or bool(SRC)
PUBLISH = os.environ.get("SPEAKER_PAGE_PUBLISH") == "1"
VOID = ("img", "br", "hr", "input", "meta", "link", "source", "path", "rect", "polyline", "polygon", "circle", "line", "use", "stop")
FIELDS = ("spk-name", "spk-topic", "spk-bio")


class _Cards(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth, self.cur, self.card_depth, self.field, self.field_depth, self.cards = 0, None, None, None, None, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = (a.get("class") or "").split()
        if tag in VOID:
            if tag == "img" and self.cur is not None and "photo" not in self.cur:
                self.cur["photo"] = a.get("src") or ""
            return
        self.depth += 1
        if self.cur is None and "spk-card" in cls:
            self.cur, self.card_depth = {}, self.depth
        elif self.cur is not None and self.field is None:
            hit = next((c for c in cls if c in FIELDS), None)
            if hit:
                self.field, self.field_depth = hit, self.depth
                self.cur.setdefault(hit, "")

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if self.field is not None and self.depth == self.field_depth:
            self.field = None
        if self.cur is not None and self.depth == self.card_depth:
            self.cards.append(self.cur)
            self.cur = None
        self.depth -= 1

    def handle_data(self, data):
        if self.field and self.cur is not None:
            self.cur[self.field] = (self.cur[self.field] + " " + data).strip()


def _clean(s):
    return re.sub(r"\s+", " ", _html.unescape(s or "")).strip()


def parse(page_html):
    p = _Cards()
    p.feed(page_html)
    rows = []
    for c in p.cards:
        name = _clean(c.get("spk-name"))
        if not name:
            continue
        rows.append({"name": name, "role": _clean(c.get("spk-topic")) or None,
                     "bio": _clean(c.get("spk-bio")) or None, "photo": (c.get("photo") or "").strip() or None})
    problems = [] if len(rows) >= 5 else ["only %d speaker cards found; the page layout may have changed" % len(rows)]
    return rows, problems


def fetch(url=PAGE_URL, tries=3):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (GaiaSpeakerSync)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:                                   # noqa: BLE001
            last = e
    raise SystemExit("could not read the speaker page: %s" % last)


def watch(rows, problems, synced=False):
    fp = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()[:16]
    try:
        prev = json.load(open(WATCH))
    except Exception:                                            # noqa: BLE001
        prev = {}
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")
    cur = {"checked_at": now, "fingerprint": fp, "rows": len(rows), "problems": problems,
           "changed_at": prev.get("changed_at") if prev.get("fingerprint") == fp else now,
           "first_seen_at": prev.get("first_seen_at") or now, "synced": synced,
           "synced_at": now if synced else prev.get("synced_at")}
    with open(WATCH + ".tmp", "w") as f:
        json.dump(cur, f, indent=1)
    os.replace(WATCH + ".tmp", WATCH)


def main():
    os.makedirs(DATA, exist_ok=True)
    text = open(SRC, encoding="utf-8").read() if SRC else (fetch() if (ENABLED or os.environ.get("SPEAKER_PAGE_WATCH", "1") == "1") else None)
    if text is None:
        return 0
    rows, problems = parse(text)
    if not ENABLED:
        watch(rows, problems)
        print("speaker page mirror is off (set SPEAKER_PAGE_SYNC=1 to run it); watched %d cards" % len(rows))
        return 0
    started = datetime.now(timezone.utc)
    L = ["# Speaker page sync — %s (%s)" % (started.strftime("%Y-%m-%d %H:%M UTC"), "APPLIED" if APPLY else "dry run"), ""]
    if problems:
        L += ["## The page did not parse cleanly — nothing applied", ""] + ["- %s" % p for p in problems]
        out = "\n".join(L); open(LATEST, "w").write(out + "\n"); print(out)
        return 1
    db = sqlite3.connect(DB, timeout=30); db.row_factory = sqlite3.Row
    have = {ss.norm_name(r["name"]): r for r in db.execute("SELECT * FROM speakers WHERE event_id=?", (EVENT,))}
    creates, fills, publishes, seen = [], [], [], set()
    for row in rows:
        key = ss.match(ss.norm_name(row["name"].split(",")[0]), have) or ss.match(ss.norm_name(row["name"]), have)
        if key is None:
            # The app may hold a surname-only entry ("Dr. Davis") for a speaker the
            # page names in full ("Dr. Christopher Davis, MD, FACC"). One such entry
            # with that surname is the same person; two or more is ambiguous.
            last = (ss.norm_name(row["name"].split(",")[0]).split() or [""])[-1]
            solo = [k for k in have if " " not in k and k == last]
            key = solo[0] if len(solo) == 1 else None
        if key is None:
            creates.append(row)
            continue
        seen.add(key)
        r = have[key]
        want = {f: v for f, v in (("role", row["role"]), ("bio", row["bio"]), ("photo_url", row["photo"]))
                if v and not (r[f] or "").strip()}
        if want:
            fills.append((r, want))
        if PUBLISH and not int(r["is_published"] or 0):
            publishes.append(r)
    def _from_agenda(r):
        try:
            return (json.loads(r["links"] or "{}") or {}).get("source") == "elevate-agenda"
        except Exception:                                        # noqa: BLE001
            return False
    # Session leaders the agenda mirror created are not expected on this page.
    gone = [r for k, r in have.items() if k not in seen and int(r["is_published"] or 0) and not _from_agenda(r)]

    L.append("Speaker page · %d cards · new: %d · empty fields filled: %d · to publish: %d · published here but not on the page: %d · %s"
             % (len(rows), len(creates), len(fills), len(publishes), len(gone), "publishing" if PUBLISH else "drafts only"))
    L.append("")
    if creates:
        L += ["## New from the page"] + ["- %s — %s" % (r["name"], r["role"] or "") for r in creates] + [""]
    if fills:
        L += ["## Empty fields filled from the page"] + ["- %s: %s" % (r["name"], ", ".join(w)) for r, w in fills] + [""]
    if publishes:
        L += ["## Published (on the public page)"] + ["- %s" % r["name"] for r in publishes] + [""]
    if gone:
        L += ["## Published here but not on the page (left as they are)"] + ["- %s" % r["name"] for r in gone] + [""]

    if APPLY:
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        with open(LOG, "a") as log:
            for row in creates:
                fields = {"event_id": EVENT, "name": row["name"], "role": row["role"], "bio": row["bio"],
                          "photo_url": row["photo"], "links": json.dumps({"source": "elevate-page"}),
                          "sort_order": 0, "is_published": 1 if PUBLISH else 0, "is_featured": 0, "created_at": now}
                db.execute("INSERT INTO speakers (%s) VALUES (%s)" % (", ".join(fields), ", ".join("?" * len(fields))), list(fields.values()))
                log.write(json.dumps({"at": now, "op": "create", "name": row["name"]}) + "\n")
            for r, want in fills:
                db.execute("UPDATE speakers SET %s WHERE id=?" % ", ".join("%s=?" % k for k in want), list(want.values()) + [r["id"]])
                log.write(json.dumps({"at": now, "op": "fill", "id": r["id"], "fields": sorted(want)}) + "\n")
            for r in publishes:
                db.execute("UPDATE speakers SET is_published=1 WHERE id=?", (r["id"],))
                log.write(json.dumps({"at": now, "op": "publish", "id": r["id"]}) + "\n")
        db.commit()
        watch(rows, problems, synced=True)
    out = "\n".join(L)
    open(LATEST, "w").write(out + "\n")
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
