# -*- coding: utf-8 -*-
"""Mirror the event website's own content (tickets, exhibitor packages, FAQ, hotel)
into the Event Manager.

    python3 tools/event_site_sync.py                      # dry run, live pages
    python3 tools/event_site_sync.py --apply              # write it
    python3 tools/event_site_sync.py --apply main.html packages.html   # saved copies

GHL and the Gaia event pages are the source of truth (Babak, 28 Oct 2026).
Speakers, the schedule and the exhibitor line-up already have their own
mirrors; this one carries the rest of what an attendee or exhibitor reads on
the website, so gaiahealers.app can show it:

  main page  (elevate.gaiahealers.com/gaia-healers-elevate-conference-page)
    * ticket options: name, price, badge, description, what's included, and
      the official purchase link
    * the FAQ
    * the official hotel: venue, description, group booking link
  exhibitors-and-speakers page (elevate.gaiahealers.com/exhibitors-and-speakers-page)
    * exhibitor packages: name, type, regular and early-bird price, benefits,
      availability ("4 Spots Remaining", "This Package Has Been Filled") and
      the official claim link -- the app links there; it never sells
    * the package terms line

This is pure website content -- nobody edits it in the app -- so the page wins:
changed items are updated, new ones added, and one that leaves the page is
switched off (is_active=0, kept, never deleted). A page that no longer parses
(too few items) applies nothing for that page and the run exits 1.

OFF unless EVENT_SITE_SYNC=1 (it then runs with the other mirrors every 30
minutes from sheet_sync_all.py); when off it still watches the pages.
"""
import hashlib, html as _html, json, os, re, sqlite3, sys, urllib.request
from datetime import datetime, timezone

MAIN_URL = "https://elevate.gaiahealers.com/gaia-healers-elevate-conference-page"
PACKAGES_URL = "https://elevate.gaiahealers.com/exhibitors-and-speakers-page"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DBURL = os.environ.get("DATABASE_URL", "")
DB = (_DBURL.split("sqlite:///", 1)[1] if _DBURL.startswith("sqlite:///") else os.path.join(HERE, "event.db"))
DATA = os.environ.get("VENDOR_SYNC_DATA") or os.path.join(HERE, "data")
LOG = os.path.join(DATA, "event-site-sync.log")
LATEST = os.path.join(DATA, "event-site-sync-latest.md")
WATCH = os.path.join(DATA, "event-site-watch.json")
EVENT = int(os.environ.get("VENDOR_SHEET_EVENT", "1"))
APPLY = "--apply" in sys.argv
SRCS = [a for a in sys.argv[1:] if a.endswith(".html")]
ENABLED = os.environ.get("EVENT_SITE_SYNC") == "1" or bool(SRCS)
FIELDS = ("title", "subtitle", "badge", "price", "regular_price", "body", "perks", "availability",
          "status", "url", "button", "image_url", "sort_order")
# Fewer than this many items means the page changed shape, not its content.
MINIMUM = {"ticket": 2, "faq": 3, "package": 2}

DDL = """CREATE TABLE IF NOT EXISTS site_items (
    id INTEGER PRIMARY KEY, event_id INTEGER, kind VARCHAR, key VARCHAR,
    title VARCHAR, subtitle VARCHAR, badge VARCHAR, price VARCHAR, regular_price VARCHAR,
    body TEXT, perks TEXT, availability VARCHAR, status VARCHAR, url VARCHAR, button VARCHAR,
    image_url VARCHAR, sort_order INTEGER DEFAULT 0, source_url VARCHAR,
    is_active BOOLEAN DEFAULT 1, synced_at DATETIME, created_at DATETIME,
    UNIQUE (event_id, kind, key))"""


def text(s):
    """Visible text of an HTML fragment, one space between words."""
    s = re.sub(r"<(script|style)\b.*?</\1>", " ", s or "", flags=re.S | re.I)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</p>\s*<p[^>]*>", "\n\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = _html.unescape(s)
    return "\n".join(re.sub(r"[ \t\r\f\v]+", " ", l).strip() for l in s.split("\n")).strip()


def one(pat, s, group=1):
    m = re.search(pat, s or "", re.S | re.I)
    return text(m.group(group)) if m else None


def key(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:80]


def section(page, cls):
    """The custom-code section carrying `cls` (GHL renders each block verbatim)."""
    i = page.find('class="%s"' % cls)
    if i < 0:
        i = page.find('class="%s ' % cls)
    if i < 0:
        return None
    start = page.rfind("<section", 0, i)
    end = page.find("</section>", i)
    return page[start if start >= 0 else i:end if end > 0 else len(page)]


def cards(chunk, cls):
    """Each <div class="cls ..."> up to the next one of the same class."""
    if not chunk:
        return []                    # the section is gone: the caller reports it
    starts = [m.start() for m in re.finditer(r'<div class="%s(?:"|\s)' % re.escape(cls), chunk)]
    return [chunk[a:b] for a, b in zip(starts, starts[1:] + [len(chunk)])]


def parse_main(page):
    items, problems = [], []
    tix = section(page, "tix-section")
    for n, c in enumerate(cards(tix, "tix-card")):
        name = one(r'class="tix-name">(.*?)</div>', c)
        if not name:
            continue
        a = re.search(r'<a href="([^"]+)"[^>]*class="tix-btn[^"]*"[^>]*>(.*?)</a>', c, re.S)
        items.append({"kind": "ticket", "key": key(name), "title": name, "badge": one(r'class="tix-badge">(.*?)</div>', c),
                      "price": one(r'class="tix-price">(.*?)</div>', c), "body": one(r'class="tix-desc">(.*?)</p>', c),
                      "perks": [text(li) for li in re.findall(r"<li>(.*?)</li>", c, re.S)],
                      "url": a.group(1) if a else None, "button": text(a.group(2)) if a else None,
                      "sort_order": n, "source_url": MAIN_URL})
    faq = section(page, "faq-section")
    for n, c in enumerate(cards(faq, "faq-item")):
        q = one(r'class="faq-q"[^>]*>\s*<span>(.*?)</span>', c)
        a = one(r'class="faq-a">(.*?)</div>', c)
        if q and a:
            items.append({"kind": "faq", "key": key(q), "title": q, "body": a, "sort_order": n, "source_url": MAIN_URL})
    hotel = section(page, "hotel-section")
    if hotel:
        book = re.search(r'<a href="([^"]+)"[^>]*>(.*?)</a>', hotel, re.S)
        paras = [text(p) for p in re.findall(r"<p[^>]*>(.*?)</p>", hotel, re.S)]
        # "Rosen<br>Shingle Creek<br><em>Orlando, FL</em>": the last line is the place.
        hm = re.search(r'class="hotel-headline"[^>]*>(.*?)</h[1-4]>', hotel, re.S)
        head = [l for l in text(hm.group(1) if hm else "").split("\n") if l.strip()]
        place = head.pop() if len(head) > 1 else None
        items.append({"kind": "hotel", "key": "official-hotel", "title": " ".join(head) or "Official hotel",
                      "subtitle": place, "badge": one(r'class="hotel-eyebrow">(.*?)</', hotel),
                      "body": "\n\n".join(p for p in paras if p), "url": book.group(1) if book else None,
                      "button": text(book.group(2)) if book else None, "sort_order": 0, "source_url": MAIN_URL})
    for kind in ("ticket", "faq"):
        got = sum(1 for i in items if i["kind"] == kind)
        if got < MINIMUM[kind]:
            problems.append("main page: only %d %s item(s) found; the page layout may have changed" % (got, kind))
    return items, problems


def parse_packages(page):
    items, problems = [], []
    sec = section(page, "ph-packages")
    for n, c in enumerate(cards(sec, "ph-pkg")):
        name = one(r'class="ph-pkg-name">(.*?)</div>', c)
        if not name:
            continue
        filled = re.search(r"has been filled|sold out", c, re.I)
        avail = one(r'class="ph-pkg-availability[^"]*">(.*?)</div>', c)
        note = one(r'class="ph-pkg-no-spots">(.*?)</div>', c)
        a = re.search(r'<a href="([^"]+)"[^>]*class="ph-pkg-btn[^"]*"[^>]*>(.*?)</a>', c, re.S)
        img = re.search(r'<img[^>]*src="([^"]+)"', c)
        items.append({"kind": "package", "key": key(name), "title": name, "subtitle": one(r'class="ph-pkg-tag">(.*?)</span>', c),
                      "badge": one(r'class="ph-pkg-badge">(.*?)</span>', c), "price": one(r'class="ph-pkg-price">(.*?)</span>', c),
                      "regular_price": one(r'class="ph-pkg-regular-price">(.*?)</span>', c),
                      "perks": [text(li) for li in re.findall(r"<li>(.*?)</li>", c, re.S)],
                      # "filled" is carried by status, so it is not repeated here.
                      "availability": "; ".join(x for x in (avail, note) if x) or None,
                      "status": "filled" if filled else "available",
                      "url": None if filled else (a.group(1) if a else None),
                      "button": None if filled else (text(a.group(2)) if a else None),
                      "image_url": img.group(1) if img else None, "sort_order": n, "source_url": PACKAGES_URL})
    terms = one(r'class="ph-disclaimer">\s*<p>(.*?)<br', page)
    if terms:
        items.append({"kind": "note", "key": "package-terms", "title": "Package terms", "body": terms.lstrip("*").strip(),
                      "sort_order": 0, "source_url": PACKAGES_URL})
    got = sum(1 for i in items if i["kind"] == "package")
    if got < MINIMUM["package"]:
        problems.append("packages page: only %d package(s) found; the page layout may have changed" % got)
    return items, problems


def fetch(url, tries=3):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (GaiaEventSiteSync)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:                                   # noqa: BLE001
            last = e
    raise SystemExit("could not read %s: %s" % (url, last))


def watch(pages, synced=False):
    """pages: {name: (items, problems)} -> one fingerprint per page."""
    try:
        prev = json.load(open(WATCH))
    except Exception:                                            # noqa: BLE001
        prev = {}
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")
    cur = {"checked_at": now, "pages": {}, "problems": [], "synced": synced,
           "first_seen_at": prev.get("first_seen_at") or now}
    changed = prev.get("changed_at")
    for name, (items, problems) in pages.items():
        fp = hashlib.sha256(json.dumps(items, sort_keys=True).encode()).hexdigest()[:16]
        before = (prev.get("pages") or {}).get(name) or {}
        if before.get("fingerprint") != fp:
            changed = now
        cur["pages"][name] = {"fingerprint": fp, "items": len(items)}
        cur["problems"] += problems
    cur["changed_at"] = changed or now
    cur["rows"] = sum(p["items"] for p in cur["pages"].values())
    cur["synced_at"] = now if synced else prev.get("synced_at")
    with open(WATCH + ".tmp", "w") as f:
        json.dump(cur, f, indent=1)
    os.replace(WATCH + ".tmp", WATCH)


def main():
    os.makedirs(DATA, exist_ok=True)
    if not ENABLED and os.environ.get("EVENT_SITE_WATCH", "1") != "1":
        return 0
    main_html = open(SRCS[0], encoding="utf-8").read() if len(SRCS) > 0 else fetch(MAIN_URL)
    pkg_html = open(SRCS[1], encoding="utf-8").read() if len(SRCS) > 1 else fetch(PACKAGES_URL)
    pages = {"main": parse_main(main_html), "packages": parse_packages(pkg_html)}
    if not ENABLED:
        watch(pages)
        print("event site mirror is off (set EVENT_SITE_SYNC=1 to run it); watched %s"
              % ", ".join("%s: %d items" % (k, len(v[0])) for k, v in pages.items()))
        return 0
    started = datetime.now(timezone.utc)
    L = ["# Event website content — %s (%s)" % (started.strftime("%Y-%m-%d %H:%M UTC"), "APPLIED" if APPLY else "dry run"), ""]
    db = sqlite3.connect(DB, timeout=30); db.row_factory = sqlite3.Row
    db.execute(DDL)
    have = {(r["kind"], r["key"]): r for r in db.execute("SELECT * FROM site_items WHERE event_id=?", (EVENT,))}
    adds, updates, offs, skipped = [], [], [], []
    for name, (items, problems) in pages.items():
        if problems:
            skipped.append((name, problems)); continue
        kinds = {i["kind"] for i in items} | ({"ticket", "faq", "hotel"} if name == "main" else {"package", "note"})
        seen = set()
        for it in items:
            k = (it["kind"], it["key"]); seen.add(k)
            row = dict(it, perks=json.dumps(it.get("perks") or []) if it.get("perks") is not None else None)
            r = have.get(k)
            if r is None:
                adds.append(row); continue
            diff = {f: row.get(f) for f in FIELDS if (row.get(f) if f != "perks" else (row.get(f) or "[]")) != (r[f] if f != "perks" else (r[f] or "[]"))}
            if not int(r["is_active"] or 0):
                diff["is_active"] = 1
            if diff:
                updates.append((r, diff))
        offs += [r for (kd, ky), r in have.items() if kd in kinds and (kd, ky) not in seen and int(r["is_active"] or 0)]

    counts = {}
    for name, (items, _) in pages.items():
        for i in items:
            counts[i["kind"]] = counts.get(i["kind"], 0) + 1
    L.append("Website · %s · new: %d · changed: %d · removed from the page: %d"
             % (" · ".join("%s %d" % (k, v) for k, v in sorted(counts.items())), len(adds), len(updates), len(offs)))
    L.append("")
    for name, problems in skipped:
        L += ["## %s did not parse cleanly — nothing applied for it" % name] + ["- %s" % p for p in problems] + [""]
    if adds:
        L += ["## New from the website"] + ["- %s: %s%s" % (a["kind"], a["title"], (" — " + a["price"]) if a.get("price") else "") for a in adds] + [""]
    if updates:
        L += ["## Changed on the website"] + ["- %s: %s (%s)" % (r["kind"], r["title"], ", ".join(sorted(d))) for r, d in updates] + [""]
    if offs:
        L += ["## No longer on the website (hidden in the app, kept)"] + ["- %s: %s" % (r["kind"], r["title"]) for r in offs] + [""]

    if APPLY:
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        with open(LOG, "a") as log:
            for a in adds:
                f = {k: a.get(k) for k in FIELDS}
                f.update(event_id=EVENT, kind=a["kind"], key=a["key"], source_url=a.get("source_url"),
                         is_active=1, synced_at=now, created_at=now)
                db.execute("INSERT INTO site_items (%s) VALUES (%s)" % (", ".join(f), ", ".join("?" * len(f))), list(f.values()))
                log.write(json.dumps({"at": now, "op": "add", "kind": a["kind"], "key": a["key"]}) + "\n")
            for r, d in updates:
                d = dict(d, synced_at=now)
                db.execute("UPDATE site_items SET %s WHERE id=?" % ", ".join("%s=?" % k for k in d), list(d.values()) + [r["id"]])
                log.write(json.dumps({"at": now, "op": "update", "id": r["id"], "fields": sorted(d)}) + "\n")
            for r in offs:
                db.execute("UPDATE site_items SET is_active=0, synced_at=? WHERE id=?", (now, r["id"]))
                log.write(json.dumps({"at": now, "op": "hide", "id": r["id"], "kind": r["kind"], "key": r["key"]}) + "\n")
            db.execute("UPDATE site_items SET synced_at=? WHERE event_id=? AND is_active=1", (now, EVENT))
        db.commit()
        watch(pages, synced=not skipped)
    out = "\n".join(L)
    open(LATEST, "w").write(out + "\n")
    print(out)
    return 1 if skipped else 0


if __name__ == "__main__":
    sys.exit(main())
