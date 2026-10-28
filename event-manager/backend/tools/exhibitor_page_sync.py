# -*- coding: utf-8 -*-
"""Mirror the exhibitors and sponsors on the public Elevate page into the Event Manager.

    python3 tools/exhibitor_page_sync.py [page.html]            # dry run
    python3 tools/exhibitor_page_sync.py --apply [page.html]    # write it

The team keeps the public exhibitor line-up in the GHL page's "Meet Our
Exhibitors" block (elevate.gaiahealers.com/gaia-healers-elevate-conference-page):
Title Sponsors, Premium Sponsors, the "Exhibiting Partners" strip and "Gifted to
You By" (28 Oct 2026). GHL and that page are the source of truth (Babak,
28 Oct 2026); the planning sheet keeps booths, packages and contacts. This
carries the page into the Event Manager so gaiahealers.app follows it.

OFF unless EXHIBITOR_PAGE_SYNC=1 (it then runs with the other mirrors every 30
minutes from sheet_sync_all.py). Rules:
  * an exhibitor on the page is matched to the Event Manager by its logo file,
    then by name (case, spacing and punctuation ignored; "Rapid Release" is
    "Rapids Release Therapy"); the page's name becomes the PUBLIC name
    (site_name) and the sheet's name stays the company's internal name, so the
    sheet keeps matching;
  * only EMPTY fields are filled (logo); a logo set in the app is never replaced;
  * one on the page that the Event Manager does not have is created, and with
    EXHIBITOR_PAGE_PUBLISH=1 published (it is on the public page already);
  * EXHIBITOR_PAGE_PUBLISH=1 also publishes a matched exhibitor the page shows,
    unless the sheet has it as not confirmed -- that disagreement is reported,
    never decided here;
  * sponsors follow the page: Title -> headline, Premium -> gold, Gifted to You
    By -> partner. Missing ones are created, empty logos filled, a tier that
    differs from the page is set to the page's;
  * anything that leaves the page is reported, never unpublished or deleted;
  * if the block no longer parses (fewer than 5 exhibitors), nothing is applied.
"""
import difflib, hashlib, html as _html, json, os, re, sqlite3, sys, urllib.request
from datetime import datetime, timezone

PAGE_URL = "https://elevate.gaiahealers.com/gaia-healers-elevate-conference-page"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DBURL = os.environ.get("DATABASE_URL", "")
DB = (_DBURL.split("sqlite:///", 1)[1] if _DBURL.startswith("sqlite:///") else os.path.join(HERE, "event.db"))
DATA = os.environ.get("VENDOR_SYNC_DATA") or os.path.join(HERE, "data")
LOG = os.path.join(DATA, "exhibitor-page-sync.log")
LATEST = os.path.join(DATA, "exhibitor-page-sync-latest.md")
WATCH = os.path.join(DATA, "exhibitor-page-watch.json")
EVENT = int(os.environ.get("VENDOR_SHEET_EVENT", "1"))
APPLY = "--apply" in sys.argv
SRC = next((a for a in sys.argv[1:] if a.endswith(".html")), None)
ENABLED = os.environ.get("EXHIBITOR_PAGE_SYNC") == "1" or bool(SRC)
PUBLISH = os.environ.get("EXHIBITOR_PAGE_PUBLISH") == "1"
TIERS = (("title sponsors", "headline"), ("premium sponsors", "gold"), ("gifted to you by", "partner"))
GIFT_BLURB = "Gifted to you by: in the VIP & Speaker welcome bags."


def _clean(s):
    return re.sub(r"\s+", " ", _html.unescape(s or "")).strip()


def _imgs(chunk):
    out = []
    for tag in re.findall(r"<img\b[^>]*>", chunk, re.I):
        src = re.search(r'\bsrc="([^"]+)"', tag)
        alt = re.search(r'\balt="([^"]*)"', tag)
        if src and alt and _clean(alt.group(1)):
            out.append({"name": _clean(alt.group(1)), "logo": src.group(1).strip()})
    return out


def parse(page_html):
    """-> (exhibitors, sponsors, problems). Reads the 'exh-section' block only."""
    i = page_html.find('class="exh-section"')
    if i < 0:
        return [], [], ["the exhibitor block (exh-section) is not on the page"]
    end = page_html.find("</section>", i)
    sec = page_html[i:end if end > 0 else len(page_html)]
    low = sec.lower()
    # Section boundaries by their visible labels, in page order.
    marks = sorted((low.find(">" + label), tier) for label, tier in TIERS if low.find(">" + label) >= 0)
    ex_at = low.find('class="exh-marquee-wrap')
    bounds = sorted([p for p, _ in marks] + ([ex_at] if ex_at >= 0 else []) + [len(sec)])
    sponsors, seen_sp = [], set()
    for pos, tier in marks:
        nxt = min(b for b in bounds if b > pos)
        for im in _imgs(sec[pos:nxt]):
            key = norm(im["name"])
            if key not in seen_sp:
                seen_sp.add(key)
                sponsors.append(dict(im, tier=tier))
    exhibitors, seen_ex = [], set()
    if ex_at >= 0:
        nxt = min(b for b in bounds if b > ex_at)
        for card in re.findall(r'<div class="exh-card">(.*?)class="exh-name">([^<]+)<', sec[ex_at:nxt], re.S):
            src = re.search(r'\bsrc="([^"]+)"', card[0])
            name = _clean(card[1])
            # The strip repeats its set so it can scroll forever; one entry each.
            if name and norm(name) not in seen_ex:
                seen_ex.add(norm(name))
                exhibitors.append({"name": name, "logo": src.group(1).strip() if src else None})
    problems = [] if len(exhibitors) >= 5 else ["only %d exhibitors found in the strip; the block may have changed" % len(exhibitors)]
    return exhibitors, sponsors, problems


def norm(s):
    t = _html.unescape(s or "").lower().replace("’", "'")
    t = re.sub(r"/\s*book\b", " ", t)            # "Transform and RISE /BOOK"
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    words = [w for w in t.split() if w not in ("the", "co", "inc", "llc")]
    return " ".join(words)


def media_id(url):
    """The CDN file name without its extension: the same logo file under .png/.webp."""
    return (url or "").rsplit("/", 1)[-1].split("?")[0].rsplit(".", 1)[0] or None


def find(item, rows, name_of):
    """Logo file first (exact), then name: equal, every word a prefix of the
    other side's word in order ("rapid release" ~ "rapids release therapy"),
    run-together ("pulsepemf" ~ "pulse pemf"), or one close spelling."""
    mid = media_id(item.get("logo"))
    if mid:
        hit = [r for r in rows if media_id(r["logo_url"]) == mid]
        if len(hit) == 1:
            return hit[0], "logo"
    a = norm(item["name"])
    by = {}
    for r in rows:
        by.setdefault(norm(name_of(r)), []).append(r)
    if len(by.get(a, [])) == 1:
        return by[a][0], "name"
    def words_match(x, y):
        xs, ys = x.split(), y.split()
        return len(xs) <= len(ys) and all(ys[i].startswith(xs[i]) or xs[i].startswith(ys[i]) for i in range(len(xs)))
    cand = [rs[0] for k, rs in by.items() if len(rs) == 1 and k and (words_match(a, k) or words_match(k, a)
            or a.replace(" ", "") == k.replace(" ", "")
            or (len(a) >= 5 and difflib.SequenceMatcher(None, a.replace(" ", ""), k.replace(" ", "")).ratio() >= 0.85))]
    if len(cand) == 1:
        return cand[0], "name"
    return None, ("ambiguous" if cand else None)


def fetch(url=PAGE_URL, tries=3):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (GaiaExhibitorSync)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:                                   # noqa: BLE001
            last = e
    raise SystemExit("could not read the event page: %s" % last)


def watch(exhibitors, sponsors, problems, synced=False):
    fp = hashlib.sha256(json.dumps([exhibitors, sponsors], sort_keys=True).encode()).hexdigest()[:16]
    try:
        prev = json.load(open(WATCH))
    except Exception:                                            # noqa: BLE001
        prev = {}
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")
    cur = {"checked_at": now, "fingerprint": fp, "rows": len(exhibitors), "sponsors": len(sponsors),
           "problems": problems, "changed_at": prev.get("changed_at") if prev.get("fingerprint") == fp else now,
           "first_seen_at": prev.get("first_seen_at") or now, "synced": synced,
           "synced_at": now if synced else prev.get("synced_at")}
    with open(WATCH + ".tmp", "w") as f:
        json.dump(cur, f, indent=1)
    os.replace(WATCH + ".tmp", WATCH)


def main():
    os.makedirs(DATA, exist_ok=True)
    text = open(SRC, encoding="utf-8").read() if SRC else (fetch() if (ENABLED or os.environ.get("EXHIBITOR_PAGE_WATCH", "1") == "1") else None)
    if text is None:
        return 0
    exhibitors, sponsors, problems = parse(text)
    if not ENABLED:
        watch(exhibitors, sponsors, problems)
        print("exhibitor page mirror is off (set EXHIBITOR_PAGE_SYNC=1 to run it); watched %d exhibitors, %d sponsors"
              % (len(exhibitors), len(sponsors)))
        return 0
    started = datetime.now(timezone.utc)
    L = ["# Exhibitor page sync — %s (%s)" % (started.strftime("%Y-%m-%d %H:%M UTC"), "APPLIED" if APPLY else "dry run"), ""]
    if problems:
        L += ["## The page did not parse cleanly — nothing applied", ""] + ["- %s" % p for p in problems]
        out = "\n".join(L); open(LATEST, "w").write(out + "\n"); print(out)
        return 1
    db = sqlite3.connect(DB, timeout=30); db.row_factory = sqlite3.Row
    cols = {r[1] for r in db.execute("PRAGMA table_info(exhibitors)")}
    for col, ddl in (("site_name", "VARCHAR"), ("site_synced_at", "DATETIME")):
        if col not in cols:
            db.execute("ALTER TABLE exhibitors ADD COLUMN %s %s" % (col, ddl))
    ex_rows = db.execute("SELECT * FROM exhibitors WHERE event_id=?", (EVENT,)).fetchall()
    sp_rows = db.execute("SELECT * FROM sponsors WHERE event_id=?", (EVENT,)).fetchall()

    ex_new, ex_set, ex_pub, ex_disagree, ex_ambig, matched = [], [], [], [], [], set()
    for it in exhibitors:
        r, how = find(it, [x for x in ex_rows if x["id"] not in matched],
                      lambda x: x["site_name"] or x["company_name"])
        if r is None and how == "ambiguous":
            ex_ambig.append(it); continue
        if r is None:
            ex_new.append(it); continue
        matched.add(r["id"])
        want = {}
        if (r["site_name"] or "") != it["name"]:
            want["site_name"] = it["name"]
        if it["logo"] and not (r["logo_url"] or "").strip():
            want["logo_url"] = it["logo"]
        if want:
            ex_set.append((r, want, how))
        if PUBLISH and not int(r["is_published"] or 0):
            if (r["stage"] or "confirmed") == "confirmed":
                ex_pub.append(r)
            else:
                ex_disagree.append(r)
    ex_gone = [r for r in ex_rows if r["id"] not in matched and int(r["is_published"] or 0)]

    sp_new, sp_set, sp_matched = [], [], set()
    for it in sponsors:
        r, how = find(it, [x for x in sp_rows if x["id"] not in sp_matched], lambda x: x["name"])
        if r is None:
            sp_new.append(it); continue
        sp_matched.add(r["id"])
        want = {}
        if (r["tier"] or "") != it["tier"]:
            want["tier"] = it["tier"]
        if it["logo"] and not (r["logo_url"] or "").strip():
            want["logo_url"] = it["logo"]
        if it["tier"] == "partner" and not (r["blurb"] or "").strip():
            want["blurb"] = GIFT_BLURB
        if want:
            sp_set.append((r, want))
    sp_gone = [r for r in sp_rows if r["id"] not in sp_matched and int(r["is_published"] or 0)]

    L.append("Exhibitor block · exhibitors: %d (new %d, updated %d, to publish %d) · sponsors: %d (new %d, updated %d) · %s"
             % (len(exhibitors), len(ex_new), len(ex_set), len(ex_pub), len(sponsors), len(sp_new), len(sp_set),
                "publishing" if PUBLISH else "drafts only"))
    L.append("")
    if ex_new:
        L += ["## New exhibitors from the page"] + ["- %s" % i["name"] for i in ex_new] + [""]
    if ex_set:
        L += ["## Exhibitors updated from the page"] + [
            "- %s → %s (matched by %s)" % (r["company_name"], ", ".join("%s=%s" % (k, v if k == "site_name" else "set") for k, v in w.items()), how)
            for r, w, how in ex_set] + [""]
    if ex_pub:
        L += ["## Published (on the public page)"] + ["- %s" % (r["site_name"] or r["company_name"]) for r in ex_pub] + [""]
    if ex_disagree:
        L += ["## On the page, but the sheet says not confirmed (left as they are)"] + [
            "- %s (%s)" % (r["company_name"], r["stage"]) for r in ex_disagree] + [""]
    if ex_ambig:
        L += ["## Could not tell which exhibitor this is (nothing applied)"] + ["- %s" % i["name"] for i in ex_ambig] + [""]
    if ex_gone:
        L += ["## Published here but not on the page (left as they are)"] + [
            "- %s" % (r["site_name"] or r["company_name"]) for r in ex_gone] + [""]
    if sp_new:
        L += ["## New sponsors from the page"] + ["- %s (%s)" % (i["name"], i["tier"]) for i in sp_new] + [""]
    if sp_set:
        L += ["## Sponsors updated from the page"] + ["- %s: %s" % (r["name"], ", ".join(sorted(w))) for r, w in sp_set] + [""]
    if sp_gone:
        L += ["## Sponsors here but not on the page (left as they are)"] + ["- %s" % r["name"] for r in sp_gone] + [""]

    if APPLY:
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        with open(LOG, "a") as log:
            for it in ex_new:
                f = {"event_id": EVENT, "company_name": it["name"], "site_name": it["name"], "logo_url": it["logo"],
                     "stage": "confirmed", "is_published": 1 if PUBLISH else 0, "can_scan_leads": 0,
                     "payment_status": "unpaid", "sort_order": 0, "site_synced_at": now,
                     "sheet_notes": "Added from the public event page; not in the planning sheet yet."}
                db.execute("INSERT INTO exhibitors (%s) VALUES (%s)" % (", ".join(f), ", ".join("?" * len(f))), list(f.values()))
                log.write(json.dumps({"at": now, "op": "create_exhibitor", "name": it["name"]}) + "\n")
            for r, want, how in ex_set:
                db.execute("UPDATE exhibitors SET %s WHERE id=?" % ", ".join("%s=?" % k for k in want), list(want.values()) + [r["id"]])
                log.write(json.dumps({"at": now, "op": "update_exhibitor", "id": r["id"], "before": {k: r[k] for k in want},
                                      "after": want, "matched_by": how}) + "\n")
            for r in ex_pub:
                db.execute("UPDATE exhibitors SET is_published=1 WHERE id=?", (r["id"],))
                log.write(json.dumps({"at": now, "op": "publish_exhibitor", "id": r["id"]}) + "\n")
            db.execute("UPDATE exhibitors SET site_synced_at=? WHERE id IN (%s)" % ",".join("?" * len(matched)),
                       [now] + list(matched)) if matched else None
            for it in sp_new:
                f = {"event_id": EVENT, "name": it["name"], "tier": it["tier"], "logo_url": it["logo"],
                     "blurb": GIFT_BLURB if it["tier"] == "partner" else None, "sort_order": 0,
                     "is_published": 1, "created_at": now}
                db.execute("INSERT INTO sponsors (%s) VALUES (%s)" % (", ".join(f), ", ".join("?" * len(f))), list(f.values()))
                log.write(json.dumps({"at": now, "op": "create_sponsor", "name": it["name"], "tier": it["tier"]}) + "\n")
            for r, want in sp_set:
                db.execute("UPDATE sponsors SET %s WHERE id=?" % ", ".join("%s=?" % k for k in want), list(want.values()) + [r["id"]])
                log.write(json.dumps({"at": now, "op": "update_sponsor", "id": r["id"], "before": {k: r[k] for k in want},
                                      "after": want}) + "\n")
        db.commit()
        watch(exhibitors, sponsors, problems, synced=True)
    out = "\n".join(L)
    open(LATEST, "w").write(out + "\n")
    print(out)
    if ex_ambig:
        print("CONFLICTS: %d page exhibitor(s) match more than one record: %s" % (len(ex_ambig), ", ".join(i["name"] for i in ex_ambig)))
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
