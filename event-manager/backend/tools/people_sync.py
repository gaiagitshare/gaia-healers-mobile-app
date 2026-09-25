# -*- coding: utf-8 -*-
"""Mirror the volunteers and guests from the planning sheet into the event,
so the people working the door are not the ones turned away at it.

    python3 tools/people_sync.py            # dry run
    python3 tools/people_sync.py --apply    # write it

Fifteen of the sixteen volunteers and the one house guest had no badge at
all: on the day they would have been refused by the same scanner they are
staffing. Each becomes an attendee through the walk-in endpoint the desk
itself uses -- same badge, same QR, same card -- stamped `staff` or
`complimentary` so the money reports never count them as ticket sales.

The sheet decides who is on the list and what they do. It never decides
anyone's TICKET: a volunteer who also bought a ticket keeps the one they
bought, and this only fills in the job title and phone the sheet knows.
Nobody is removed here — a name dropped from the sheet is reported, because
a badge already printed is already in someone's hand.

A row without an e-mail cannot become a badge (a card with no address can
never be claimed), so it is reported by name rather than half-created.
"""
import json, os, re, sys, time, urllib.request
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import people_sheet as ps

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
LOG = os.path.join(DATA, "people-sync.log")
LATEST = os.path.join(DATA, "people-sync-latest.md")
BASE = os.environ.get("EVENT_API", "http://127.0.0.1:8002")
EVENT = int(os.environ.get("PEOPLE_SHEET_EVENT", os.environ.get("VENDOR_SHEET_EVENT", "1")))
APPLY = "--apply" in sys.argv

# The two passes these people hold. Created once, then left alone: they are
# ordinary ticket types, visible and editable in Admin like any other.
TYPES = {
    "volunteer": {"code": "VOL", "name": "Volunteer / Staff", "grants_conference": 1,
                  "grants_workshops": 1, "is_vip": 0, "upgrade_rank": 5,
                  "description": "Working the event. Moves freely; never counted as a sale."},
    "guest": {"code": "GUEST", "name": "Gaia Guest", "grants_conference": 1,
              "grants_workshops": 0, "is_vip": 0, "upgrade_rank": 4,
              "description": "Invited by Gaia Healers. Same access as the three-day pass."},
}
ATTENDANCE = {"volunteer": "staff", "guest": "complimentary"}


def token():
    env = {}
    for line in open(os.path.join(HERE, ".env")):
        s = line.strip()
        if "=" in s and not s.startswith("#"):
            k, v = s.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")
    from jose import jwt
    return jwt.encode({"sub": "1", "exp": int(time.time()) + 900}, env["SECRET_KEY"], algorithm="HS256")


def main():
    os.makedirs(DATA, exist_ok=True)
    started = datetime.now(timezone.utc)
    tok = token()

    def call(method, path, body=None):
        req = urllib.request.Request(BASE + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    people = ps.parse_volunteers(ps.fetch(ps.VOLUNTEERS_GID)) + ps.parse_guests(ps.fetch(ps.GUESTS_GID))
    if len(people) < 3:
        raise SystemExit("refusing: the people tabs parsed with fewer than 3 rows — layout changed?")
    st, attendees = call("GET", "/events/%d/attendees?limit=2000" % EVENT)
    rows = attendees.get("items", attendees) if isinstance(attendees, dict) else attendees
    by_email = {(a.get("email") or "").lower(): a for a in rows if a.get("email")}
    # Also by name: the sheet has no e-mail for seven of these people, and one
    # of them (Vlad Spivak, on the list as Vladimir) already had a badge. A
    # volunteer who is already an attendee must be recognised, not reported as
    # missing for ever. First name and surname must both match, allowing the
    # short form of a first name ("Vlad" for "Vladimir"), and only when that
    # lands on exactly ONE person.
    def key(first, last):
        return (re.sub(r"[^a-z]", "", (first or "").lower()), re.sub(r"[^a-z]", "", (last or "").lower()))
    by_last = {}
    for a in rows:
        k = key(a.get("first_name"), a.get("last_name"))
        if k[1]:
            by_last.setdefault(k[1], []).append((k[0], a))

    def by_name(p):
        f, l = key(p["first_name"], p["last_name"])
        if not l:
            return None
        cands = [a for fn, a in by_last.get(l, []) if fn and (fn.startswith(f) or f.startswith(fn))]
        return cands[0] if len(cands) == 1 else None

    creates, known, no_email = [], [], []
    for p in people:
        hit = by_email.get(p["email"]) if p["email"] else None
        how = "e-mail" if hit else ""
        if hit is None:
            hit = by_name(p)
            how = "name" if hit else ""
        if hit is not None:
            known.append((p, hit, how))
        elif p["email"]:
            creates.append(p)
        else:
            no_email.append(p)

    L = ["# Volunteers & guests sync — %s (%s)" % (started.strftime("%Y-%m-%d %H:%M UTC"), "APPLIED" if APPLY else "dry run"), ""]
    L.append("Sheet: %d people (%d volunteers, %d guests) · already have a badge: %d · to add: %d · cannot be added yet: %d"
             % (len(people), sum(1 for p in people if p["kind"] == "volunteer"),
                sum(1 for p in people if p["kind"] == "guest"), len(known), len(creates), len(no_email)))
    L.append("")
    if creates:
        L.append("## Given a badge")
        for p in creates:
            L.append("- **%s** — %s · %s" % (p["name"], ps.job_title(p), TYPES[p["kind"]]["name"]))
        L.append("")
    if known:
        L.append("## Already on the list (ticket left exactly as it is)")
        for p, a, how in known:
            who = ("%s %s" % (a.get("first_name") or "", a.get("last_name") or "")).strip()
            L.append("- %s — matched by %s%s" % (p["name"], how, ("" if who.lower() == p["name"].lower() else ", on the list as **%s**" % who)))
        L.append("")
    if no_email:
        L.append("## No badge yet: the sheet has no e-mail for them")
        for p in no_email:
            L.append("- %s (%s) — add an address in the sheet and the next run makes their badge" % (p["name"], p["role"] or p["kind"]))
        L.append("")

    if APPLY and creates:
        # the two passes, made once
        st, tts = call("GET", "/events/%d/ticket-types" % EVENT)
        have = {(t.get("code") or "").upper(): t for t in (tts or [])}
        ids = {}
        for kind, spec in TYPES.items():
            t = have.get(spec["code"])
            if not t:
                st, t = call("POST", "/events/%d/ticket-types" % EVENT, dict(spec))
                if st not in (200, 201):
                    raise SystemExit("could not create the %s pass: %s" % (spec["name"], t))
            ids[kind] = t["id"]
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        with open(LOG, "a") as log:
            for p in creates:
                st, out = call("POST", "/events/%d/walk-in" % EVENT, {
                    "first_name": p["first_name"], "last_name": p["last_name"], "email": p["email"],
                    "phone": p["phone"] or "", "ticket_type_id": ids[p["kind"]],
                    "attendance_type": ATTENDANCE[p["kind"]], "confirm_new": True,
                    "note": ("From the planning sheet: " + (ps.job_title(p) or p["kind"]))[:300]})
                ok = st in (200, 201) and (out or {}).get("attendee")
                if ok:
                    aid = out["attendee"]["id"]
                    call("PUT", "/attendees/%d" % aid, {"job_title": ps.job_title(p)})
                log.write(json.dumps({"at": now, "op": "create" if ok else "failed", "name": p["name"],
                                      "kind": p["kind"], "status": st, "detail": None if ok else out}, default=str) + "\n")
                if not ok:
                    L.append("- ⚠ %s could not be added: %s" % (p["name"], (out or {}).get("detail", st)))
    out = "\n".join(L)
    open(LATEST, "w").write(out + "\n")
    print(out)


if __name__ == "__main__":
    main()
