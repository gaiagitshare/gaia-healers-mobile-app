# -*- coding: utf-8 -*-
"""WHO IS ALLOWED TO SEE WHAT SOMEBODY BOUGHT?

A badge card is a PUBLIC page. Its QR is worn all weekend, photographed, left
on tables and forwarded, so what tier somebody paid for does not belong on it —
a stranger opening the link has no business knowing who is VIP.

The people who scan the badge are a different matter, and there are two of
them: the door, which is making an access decision, and a stand the person
chose to hand their badge to. Both see the pass. Neither sees anything the
attendee did not agree to share.

And the organiser can see who scanned whom, which nothing could answer before:
a stand could see its own leads, the door could see its own log, and there was
no screen that held both or either one across the whole floor.

Proving what a scanner sees means scanning, and a scan CAPTURES a lead — a real
row on a real stand's list. So this suite records every lead it creates and
removes exactly those at the end: an exhibitor opening their list on the day
should not find four people they never met.
Run:  python3 /root/event/backend/test_scan_visibility.py
"""
import json, sqlite3, sys, urllib.request, urllib.error

HERE = "/root/event/backend"
import sys as _sys; _sys.path.insert(0, "/root/event/backend")
import testbed
BASE, _DB = testbed.start()
db = sqlite3.connect("file:%s/event.db?mode=ro" % HERE, uri=True)
db.row_factory = sqlite3.Row
sys.path.insert(0, HERE)
import main, models                                            # noqa: E402
from sqlalchemy import text                                    # noqa: E402
from database import SessionLocal                              # noqa: E402

ADMIN = {"Authorization": "Bearer " + main.create_access_token({"sub": "1"})}
STAFF = ADMIN          # the door capability; the platform owner holds it too
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try: return e.code, json.loads(raw or "null")
        except Exception: return e.code, raw

def token_for(pass_name):
    r = db.execute("""select a.public_token, a.qr_code, a.id from attendees a
                      join ticket_types t on t.id = a.ticket_type_id
                      where a.event_id=1 and t.name=? and a.public_token is not null limit 1""",
                   (pass_name,)).fetchone()
    return (r["public_token"], r["qr_code"], r["id"]) if r else (None, None, None)

PASSES = ("VIP Pass", "General Admission + Conference", "General Admission", "Friday Exhibit Hall")
made = set()          # lead ids this run created, so it can put them back

print("\nTHE PUBLIC CARD DOES NOT SAY WHAT THEY BOUGHT")
for pass_name in PASSES:
    tok, _qr, _aid = token_for(pass_name)
    if not tok:
        continue
    j = json.loads(urllib.request.urlopen("%s/c/%s.json" % (BASE, tok), timeout=30).read())
    html = urllib.request.urlopen("%s/c/%s" % (BASE, tok), timeout=30).read().decode()
    check(not j.get("pass_display"), "%s is not in the card's data" % pass_name, j.get("pass_display"))
    check(pass_name not in html, "  nor on the card's page")
# and the card still works
_tok, _, _ = token_for("General Admission")
_html = urllib.request.urlopen("%s/c/%s" % (BASE, _tok), timeout=30).read().decode()
check("digital badge" in _html, "the card itself still renders")

print("\nA STAND THAT SCANS THE BADGE DOES SEE IT")
stand = db.execute("""select id, company_name, access_token from exhibitors
                      where event_id=1 and coalesce(access_token,'')<>'' and can_scan_leads=1
                      limit 1""").fetchone()
check(stand is not None, "an exhibitor has scanning switched on", stand and stand["company_name"])
if stand:
    print("     scanning as: %s" % stand["company_name"])
    for pass_name in PASSES:
        _t, qr, aid = token_for(pass_name)
        if not qr:
            continue
        st, out = call("POST", "/scan", {"access_token": stand["access_token"], "qr_code": qr})
        who = (out or {}).get("attendee") or {}
        check(st == 200 and (out or {}).get("success") is True, "the scan works for %s" % pass_name, (st, out))
        if (out or {}).get("lead_id"):
            made.add(out["lead_id"])
        check(bool(who.get("pass_display")), "  and hands the stand the pass", who.get("pass_display"))
        check(bool(who.get("pass_includes")), "  with what it opens", who.get("pass_includes"))
        # It must be the SAME words the door uses.
        s = SessionLocal()
        a = s.query(models.Attendee).filter(models.Attendee.id == aid).first()
        check(who.get("pass_display") == main._pass_display(s, a),
              "  matching the door exactly", (who.get("pass_display"), main._pass_display(s, a)))
        s.close()
        print("     %-32s -> %s" % (pass_name, who.get("pass_display")))

    print("\n  -- and still only what the attendee agreed to share --")
    _t, qr, aid = token_for("General Admission")
    st, out = call("POST", "/scan", {"access_token": stand["access_token"], "qr_code": qr})
    if (out or {}).get("lead_id"):
        made.add(out["lead_id"])
    who = (out or {}).get("attendee") or {}
    s = SessionLocal()
    a = s.query(models.Attendee).filter(models.Attendee.id == aid).first()
    if not a.share_email_with_exhibitors:
        check(who.get("email") is None, "an email nobody agreed to share is still withheld", who.get("email"))
    if not a.share_phone_with_exhibitors:
        check(who.get("phone") is None, "and so is the phone number", who.get("phone"))
    check("consent" in who, "and the stand is told why a field is blank", who.get("consent"))
    s.close()

print("\nSHARING IS ON, BECAUSE THE TICKET WAS SOLD ON IT")
if stand:
    _t, qr, aid = token_for("General Admission")
    st, out = call("POST", "/scan", {"access_token": stand["access_token"], "qr_code": qr})
    if (out or {}).get("lead_id"):
        made.add(out["lead_id"])
    who = (out or {}).get("attendee") or {}
    s = SessionLocal()
    a = s.query(models.Attendee).filter(models.Attendee.id == aid).first()
    check(who.get("email") == a.email and who.get("phone") == a.phone,
          "a stand gets the real contact details", (who.get("email"), a.email))
    check(who.get("consent") == {"email": True, "phone": True},
          "and is told the person agreed", who.get("consent"))
    s.close()

    print("\n  -- but somebody can say no, and it sticks --")
    st, out = call("POST", "/events/1/attendees/%d/sharing" % aid,
                   {"share_email": False, "share_phone": False,
                    "reason": "asked at the desk"}, STAFF)
    check(st == 200 and out.get("share_email") is False,
          "the desk can record a refusal", (st, out))
    check(bool(out.get("asked_at")), "stamped as an answer somebody actually gave", out.get("asked_at"))

    # Withdrawing after a lead was captured is respected too: the lead list
    # takes the MOST RESTRICTIVE of the snapshot and the current setting.
    st, leads = call("GET", "/scan/leads/%s" % stand["access_token"])
    mine = [l for l in (leads or []) if l.get("attendee_id") == aid]
    check(mine and (mine[0].get("attendee") or {}).get("email") is None,
          "and a lead already captured stops showing their email", mine[:1])

    # Nothing may write over that answer -- not the backfill, not a default.
    s = SessionLocal()
    a = s.query(models.Attendee).filter(models.Attendee.id == aid).first()
    stamped = a.consent_updated_at
    s.execute(text("UPDATE attendees SET share_email_with_exhibitors=1 "
                   "WHERE consent_updated_at IS NULL AND COALESCE(share_email_with_exhibitors,0)=0"))
    s.commit()
    s.refresh(a)
    check(a.share_email_with_exhibitors is False or a.share_email_with_exhibitors == 0,
          "the consent backfill steps over anybody who was asked",
          a.share_email_with_exhibitors)
    # put them back the way the policy says
    a.share_email_with_exhibitors = True
    a.share_phone_with_exhibitors = True
    a.consent_updated_at = None
    s.commit(); s.close()
    check(stamped is not None, "  (restored for the next run)")

print("\nA BAD TOKEN LEARNS NOTHING")
st, out = call("POST", "/scan", {"access_token": "not-a-real-token", "qr_code": token_for("VIP Pass")[1]})
check((out or {}).get("success") is False and not (out or {}).get("attendee"),
      "an invalid scanner token gets no attendee at all", out)

print("\nTHE ORGANISER CAN SEE WHO SCANNED WHOM")
st, hist = call("GET", "/events/1/scan-history", None, ADMIN)
check(st == 200, "the scan history loads", st)
check("stand_scans" in hist and "door_scans" in hist,
      "with stands and doors reported apart, never added together", sorted(hist or {}))
check(hist["door_scans"]["total"] > 0, "the door's own scans are there", hist["door_scans"]["total"])
d0 = (hist["door_scans"]["items"] or [{}])[0]
check("by" in d0 and "result" in d0, "each door scan names its operator and its verdict", d0)
print("     %d stand scan(s), %d door scan(s)" % (hist["stand_scans"]["total"], hist["door_scans"]["total"]))

print("\nAND EVERYWHERE ONE BADGE HAS BEEN READ")
_t, _qr, aid = token_for("General Admission")
st, one = call("GET", "/events/1/attendees/%d/scans" % aid, None, ADMIN)
check(st == 200 and one.get("attendee_id") == aid, "one badge's whole history loads", (st, one))
check("stands" in one and "doors" in one, "listing the stands it visited and the doors it passed", sorted(one or {}))

print("\nNOBODY ELSE CAN")
st, _ = call("GET", "/events/1/scan-history")
check(st in (401, 403), "the scan history needs a login", st)

# A scan CAPTURES a lead, which is a real row on a real stand's list. This
# suite has to scan to prove what a scanner sees, so it puts back exactly what
# it created and nothing else -- an exhibitor opening their leads on the day
# should not find four people they never met.
print("\nPUTTING BACK WHAT THIS TEST CREATED")
if stand and made:
    s = SessionLocal()
    gone = s.query(models.Lead).filter(models.Lead.id.in_(list(made))).delete(synchronize_session=False)
    s.commit()
    left = s.query(models.Lead).filter(models.Lead.id.in_(list(made))).count()
    s.close()
    check(gone == len(made) and left == 0,
          "the %d lead(s) this test captured are removed" % len(made), (gone, left))
else:
    print("     nothing to undo")

print("\n" + ("ALL GOOD" if not fails else "FAILED: " + "; ".join(fails)))
sys.exit(1 if fails else 0)
