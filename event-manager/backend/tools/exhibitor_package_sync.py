# -*- coding: utf-8 -*-
"""Exhibitor packages bought through GHL become pending exhibitors.

    python3 tools/exhibitor_package_sync.py            # dry run
    python3 tools/exhibitor_package_sync.py --apply    # write it

The exhibitor packages ("The Ambassador", "The Connector", "The Community
Builder", "The Legacy Partner") are sold through the GHL checkout on
elevate.gaiahealers.com/exhibitors-and-speakers-page. Those payments already
reach the Event Manager (webhook + 15-minute mirror) but, not being tickets,
they were filed as "unrelated" sales and never reached the exhibitor list.

Rules (runs every 30 minutes from sheet_sync_all.py when
EXHIBITOR_PACKAGE_SYNC=1):
  * only a package paid in this event's selling window counts: from 365 days
    before the event starts to the day it ends (a 2025 Ambassador is last
    year's stand);
  * a buyer who is already an exhibitor here (same contact email) is linked,
    and their package is filled in only if empty;
  * anyone else becomes ONE exhibitor in stage "purchased" -- never published,
    never given a lead scanner -- named after the buyer until the team confirms
    the company and booth (the planning sheet adopts it by email);
  * the sale leaves the "unmapped" review queue with status "exhibitor";
  * a ticket is never created from a package; nothing is ever deleted.
"""
import json, os, sqlite3, sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DBURL = os.environ.get("DATABASE_URL", "")
DB = (_DBURL.split("sqlite:///", 1)[1] if _DBURL.startswith("sqlite:///") else os.path.join(HERE, "event.db"))
DATA = os.environ.get("VENDOR_SYNC_DATA") or os.path.join(HERE, "data")
LOG = os.path.join(DATA, "exhibitor-package-sync.log")
LATEST = os.path.join(DATA, "exhibitor-package-sync-latest.md")
EVENT = int(os.environ.get("VENDOR_SHEET_EVENT", "1"))
APPLY = "--apply" in sys.argv
ENABLED = os.environ.get("EXHIBITOR_PACKAGE_SYNC") == "1" or "--force" in sys.argv
PACKAGES = ("the ambassador", "the connector", "the community builder", "the legacy partner", "exhibitor package")


def is_package(name):
    n = (name or "").strip().lower()
    return any(n == p or n.startswith(p + " ") or n.startswith(p + " (") for p in PACKAGES)


def day(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")[:19]).replace(tzinfo=None)
    except Exception:                                            # noqa: BLE001
        return None


def money(v):
    try:
        return "$%s" % format(int(round(float(v))), ",")
    except (TypeError, ValueError):
        return ""


def main():
    if not ENABLED:
        print("exhibitor package flow is off (set EXHIBITOR_PACKAGE_SYNC=1 to run it)")
        return 0
    os.makedirs(DATA, exist_ok=True)
    db = sqlite3.connect(DB, timeout=30); db.row_factory = sqlite3.Row
    ev = db.execute("SELECT start_date, end_date FROM events WHERE id=?", (EVENT,)).fetchone()
    start, end = day(ev["start_date"]), day(ev["end_date"])
    opens = start - timedelta(days=365)
    sales = [r for r in db.execute(
        "SELECT * FROM unmapped_sales WHERE (event_id=? OR event_id IS NULL) AND status='pending' ORDER BY paid_at", (EVENT,))
        if is_package(r["product_name"])]
    in_window = [r for r in sales if day(r["paid_at"]) and opens <= day(r["paid_at"]) <= end]
    out_window = [r for r in sales if r not in in_window]
    exhibitors = db.execute("SELECT * FROM exhibitors WHERE event_id=?", (EVENT,)).fetchall()
    by_email = {}
    for x in exhibitors:
        if (x["contact_email"] or "").strip():
            by_email.setdefault(x["contact_email"].strip().lower(), x)

    links, creates = [], {}
    for s in in_window:
        email = (s["buyer_email"] or "").strip().lower()
        if email and email in by_email:
            links.append((s, by_email[email]))
        else:
            creates.setdefault(email or ("ref:" + s["reference"]), []).append(s)

    started = datetime.now(timezone.utc)
    L = ["# Exhibitor packages — %s (%s)" % (started.strftime("%Y-%m-%d %H:%M UTC"), "APPLIED" if APPLY else "dry run"), "",
         "Package sales waiting: %d · this event (%s to %s): %d · linked to an exhibitor: %d · new pending exhibitors: %d · other years, left alone: %d"
         % (len(sales), opens.date(), end.date(), len(in_window), len(links), len(creates), len(out_window)), ""]
    if links:
        L += ["## Linked to an existing exhibitor"] + ["- %s %s → %s" % (s["product_name"], s["paid_at"][:10], x["company_name"]) for s, x in links] + [""]
    if creates:
        L += ["## New pending exhibitors (stage \"purchased\": confirm company and booth)"] + [
            "- %s · %s" % (ss[0]["buyer_name"] or ss[0]["buyer_email"] or ss[0]["reference"],
                           ", ".join("%s %s" % (s["product_name"], s["paid_at"][:10]) for s in ss)) for ss in creates.values()] + [""]

    if APPLY and (links or creates):
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        with open(LOG, "a") as log:
            for s, x in links:
                if not (x["package"] or "").strip():
                    db.execute("UPDATE exhibitors SET package=? WHERE id=?", ("%s %s" % (s["product_name"], money(s["amount"])), x["id"]))
                db.execute("UPDATE unmapped_sales SET status='exhibitor', relevance='exhibitor_package', relevance_reason=?, "
                           "note=?, resolved_at=? WHERE id=?",
                           ("exhibitor package for this event", "linked to exhibitor #%d" % x["id"], now, s["id"]))
                log.write(json.dumps({"at": now, "op": "link", "sale": s["reference"], "exhibitor": x["id"]}) + "\n")
            for key, ss in creates.items():
                first = ss[0]
                total = sum(float(s["amount"] or 0) for s in ss)
                f = {"event_id": EVENT, "company_name": (first["buyer_name"] or first["buyer_email"] or first["reference"]).strip(),
                     "contact_name": first["buyer_name"], "contact_email": (first["buyer_email"] or "").lower() or None,
                     "stage": "purchased", "is_published": 0, "can_scan_leads": 0,
                     "package": " + ".join("%s %s" % (s["product_name"], money(s["amount"])) for s in ss),
                     "payment_status": "paid", "amount_paid": total, "sort_order": 0,
                     "payment_note": "Bought online through GHL (%s). Confirm the company name and booth."
                                     % ", ".join("%s %s" % (s["reference"], s["paid_at"][:10]) for s in ss)}
                cur = db.execute("INSERT INTO exhibitors (%s) VALUES (%s)" % (", ".join(f), ", ".join("?" * len(f))), list(f.values()))
                for s in ss:
                    db.execute("UPDATE unmapped_sales SET status='exhibitor', relevance='exhibitor_package', relevance_reason=?, "
                               "note=?, resolved_at=? WHERE id=?",
                               ("exhibitor package for this event", "pending exhibitor #%d" % cur.lastrowid, now, s["id"]))
                log.write(json.dumps({"at": now, "op": "create", "exhibitor": cur.lastrowid,
                                      "sales": [s["reference"] for s in ss]}) + "\n")
        db.commit()
    out = "\n".join(L)
    open(LATEST, "w").write(out + "\n")
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
