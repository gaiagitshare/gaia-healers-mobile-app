# -*- coding: utf-8 -*-
"""Badges for the people working each stand, from the planning sheet.

    python3 tools/exhibitor_staff_sync.py            # dry run
    python3 tools/exhibitor_staff_sync.py --apply    # write it

The Vendors tab gained a "Staff Members at the Event" column (16 Nov 2026):
the team types each stand's people into one cell, names and addresses on
separate lines. Nothing read it, so 36 of 45 people had no badge three days
before the doors opened. This runs with the other sheet mirrors.

Rules:
  * only a CONFIRMED stand's people, and only once the stand is in the Event
    Manager (by name, or by the stand's contact email);
  * someone who already has any badge here -- a ticket, a speaker or crew
    badge -- keeps it exactly as it is (matched by email, then by name);
  * a new person becomes an attendee through the walk-in endpoint the desk
    uses, stamped `exhibitor` (never a sale) on the event's General Admission
    pass, which is how the first stand's staff were badged on 13 Nov, with the
    stand as their company and "Exhibitor staff" as their role;
  * a line with no email cannot become a badge (it could never be claimed),
    and an address with no name gets one only when it is the stand's own
    contact address (that contact's name is used); otherwise the report
    asks the team to add the missing name or email;
  * nothing is ever removed, and nothing is ever SENT -- badge emails go out
    only through Email Center, on an organiser's approval.
"""
import json, os, re, sqlite3, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vendor_sheet as vs

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("VENDOR_SYNC_DATA") or os.path.join(HERE, "data")
LOG = os.path.join(DATA, "exhibitor-staff-sync.log")
LATEST = os.path.join(DATA, "exhibitor-staff-sync-latest.md")
BASE = os.environ.get("EVENT_API", "http://127.0.0.1:8002")
EVENT = int(os.environ.get("VENDOR_SHEET_EVENT", "1"))
_DBURL = os.environ.get("DATABASE_URL", "")
DB = (_DBURL.split("sqlite:///", 1)[1] if _DBURL.startswith("sqlite:///") else os.path.join(HERE, "event.db"))
APPLY = "--apply" in sys.argv
SRC = next((a for a in sys.argv[1:] if a.endswith(".csv")), None)
STAFF_PASS_CODE = os.environ.get("EXHIBITOR_STAFF_PASS", "GA")
ROLE = "Exhibitor staff"


def token():
    env = {}
    for line in open(os.path.join(HERE, ".env")):
        s = line.strip()
        if "=" in s and not s.startswith("#"):
            k, v = s.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")
    from jose import jwt
    return jwt.encode({"sub": "1", "exp": int(time.time()) + 900}, env["SECRET_KEY"], algorithm="HS256")


def _key(first, last):
    return (re.sub(r"[^a-z]", "", (first or "").lower()), re.sub(r"[^a-z]", "", (last or "").lower()))


def main():
    os.makedirs(DATA, exist_ok=True)
    started = datetime.now(timezone.utc)
    text = open(SRC, encoding="utf-8-sig").read() if SRC else vs.fetch_csv()
    sheet = vs.parse(text)
    if len([s for s in sheet if s["stage"] == "confirmed"]) < 5:
        raise SystemExit("refusing: the sheet parsed with fewer than 5 confirmed exhibitors — layout changed?")

    db = sqlite3.connect("file:%s?mode=ro" % DB, uri=True, timeout=30); db.row_factory = sqlite3.Row
    stands = db.execute("SELECT id, company_name, booth_number, contact_email, contact_name, stage FROM exhibitors "
                        "WHERE event_id=?", (EVENT,)).fetchall()
    by_name = {vs.norm_name(vs.split_staff_note(s["company_name"] or "")[0]): s for s in stands}
    by_email = {}
    for s in stands:
        e = (s["contact_email"] or "").strip().lower()
        if e:
            by_email.setdefault(e, []).append(s)
    people_rows = db.execute("SELECT id, email, first_name, last_name, attendance_type FROM attendees WHERE event_id=?",
                             (EVENT,)).fetchall()
    have_email = {(a["email"] or "").strip().lower(): a for a in people_rows if a["email"]}
    by_last = {}
    for a in people_rows:
        k = _key(a["first_name"], a["last_name"])
        if k[1]:
            by_last.setdefault(k[1], []).append((k[0], a))

    def known(p):
        if p["email"] and p["email"] in have_email:
            return have_email[p["email"]], "email"
        f, l = _key(p["first_name"], p["last_name"])
        if not l or p.get("name_from_email"):
            return None, ""
        c = [a for fn, a in by_last.get(l, []) if fn and (fn.startswith(f) or f.startswith(fn))]
        if not c:
            # "Jere Rivera Dugenio" is on the list as "Rivera-Dugenio": the
            # surname may have swallowed a middle name.
            for ln, lst in by_last.items():
                if ln != l and ln.endswith(l) and len(l) >= 4:
                    c += [a for fn, a in lst if fn and (fn.startswith(f) or f.startswith(fn))]
        return (c[0], "name") if len(c) == 1 else (None, "")

    creates, already, no_email, need_name, no_stand = [], [], [], [], []
    planned = set()
    for rec in sheet:
        if rec["stage"] != "confirmed" or not (rec.get("staff") or "").strip():
            continue
        stand = by_name.get(vs.norm_name(rec["company"]))
        if stand is None and rec["email"]:
            c = by_email.get(rec["email"].strip().lower(), [])
            c = [s for s in c if (s["stage"] or "") == "confirmed"]
            stand = c[0] if len(c) == 1 else None
        people = vs.parse_staff(rec["staff"])
        if stand is None or (stand["stage"] or "") != "confirmed":
            no_stand.append((rec, people)); continue
        for p in people:
            if p["name_from_email"] and p["email"] == (stand["contact_email"] or "").strip().lower() and stand["contact_name"]:
                bits = stand["contact_name"].split()
                p.update(name=stand["contact_name"], first_name=bits[0], last_name=" ".join(bits[1:]), name_from_email=False)
            hit, how = known(p)
            if hit is not None:
                already.append((stand, p, hit, how)); continue
            if not p["email"]:
                no_email.append((stand, p)); continue
            if p["name_from_email"]:
                need_name.append((stand, p)); continue
            if p["email"] in planned:
                continue
            planned.add(p["email"])
            creates.append((stand, p))

    L = ["# Exhibitor staff sync — %s (%s)" % (started.strftime("%Y-%m-%d %H:%M UTC"), "APPLIED" if APPLY else "dry run"), ""]
    total = len(creates) + len(already) + len(no_email) + len(need_name) + sum(len(p) for _, p in no_stand)
    L.append("Sheet: %d stand staff · already have a badge: %d · %s: %d · need an email: %d · need a name: %d · stand not ready: %d"
             % (total, len(already), "given a badge" if APPLY else "to add", len(creates), len(no_email), len(need_name),
                sum(len(p) for _, p in no_stand)))
    L.append("")
    if creates:
        L.append("## %s" % ("Given a badge" if APPLY else "Will get a badge"))
        for s, p in creates:
            L.append("- **%s** (%s) — %s, booth %s" % (p["name"], p["email"], s["company_name"], s["booth_number"] or "—"))
        L.append("")
    if no_email:
        L.append("## No badge yet: the sheet has no email for them")
        for s, p in no_email:
            L.append("- %s — %s · add their email in the sheet and the next run makes the badge" % (p["name"], s["company_name"]))
        L.append("")
    if need_name:
        L.append("## No badge yet: only an email, no name")
        for s, p in need_name:
            L.append("- %s — %s · add the person's name next to it in the sheet" % (p["email"], s["company_name"]))
        L.append("")
    if no_stand:
        L.append("## Stand not confirmed in the Event Manager yet (left until it is)")
        for rec, people in no_stand:
            L.append("- %s: %s" % (rec["company"], ", ".join(p["name"] or p["email"] or "?" for p in people)))
        L.append("")
    if already:
        L.append("## Already have a badge (left exactly as it is)")
        for s, p, a, how in already:
            who = ("%s %s" % (a["first_name"] or "", a["last_name"] or "")).strip()
            L.append("- %s — %s · matched by %s, %s badge%s" % (p["name"], s["company_name"], how, a["attendance_type"],
                     "" if who.lower() == p["name"].lower() else " as **%s**" % who))
        L.append("")

    if APPLY and creates:
        tok = token()

        def call(method, path, body=None):
            req = urllib.request.Request(BASE + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    return r.status, json.loads(r.read() or b"null")
            except urllib.error.HTTPError as e:
                try:
                    return e.code, json.loads(e.read() or b"null")
                except ValueError:
                    return e.code, None

        st, tts = call("GET", "/events/%d/ticket-types" % EVENT)
        tt = next((t for t in (tts or []) if (t.get("code") or "").upper() == STAFF_PASS_CODE.upper()), None)
        if tt is None:
            raise SystemExit("refusing: no %s pass on this event for stand staff" % STAFF_PASS_CODE)
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        with open(LOG, "a") as log:
            for s, p in creates:
                note = "Exhibitor staff - %s (booth %s), from the planning sheet" % (s["company_name"], s["booth_number"] or "—")
                st, out = call("POST", "/events/%d/walk-in" % EVENT, {
                    "first_name": p["first_name"], "last_name": p["last_name"], "email": p["email"],
                    "phone": p["phone"] or "", "ticket_type_id": tt["id"], "attendance_type": "exhibitor",
                    "confirm_new": True, "note": note[:300]})
                ok = st in (200, 201) and (out or {}).get("attendee")
                if ok:
                    aid = out["attendee"]["id"]
                    call("PUT", "/attendees/%d" % aid, {"job_title": ROLE, "company": s["company_name"]})
                log.write(json.dumps({"at": now, "op": "create" if ok else "failed", "name": p["name"], "email": p["email"],
                                      "exhibitor": s["id"], "status": st, "attendee": (out or {}).get("attendee", {}).get("id") if ok else None,
                                      "detail": None if ok else out}, default=str) + "\n")
                if not ok:
                    L.append("- ⚠ %s could not be added: %s" % (p["name"], (out or {}).get("detail", st) if isinstance(out, dict) else st))
    out = "\n".join(L)
    open(LATEST, "w").write(out + "\n")
    print(out)


if __name__ == "__main__":
    main()
