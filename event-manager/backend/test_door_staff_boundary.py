# -*- coding: utf-8 -*-
"""WHAT A DOOR ACCOUNT CAN REACH

Five desk logins exist so the people working the entrance do not have to be
handed the platform owner's password. The whole point is the boundary, and the
boundary was wrong the moment the first one was created: the attendee CSV was
gated on attendee.READ rather than attendee.EXPORT, so a desk account could
walk out with every name, email, phone number and amount paid in one file.

The capability already existed and was organiser-only. The endpoint simply
asked the wrong question — which nobody could notice while every account was an
administrator.

Looking ONE person up is the job all weekend. Taking the whole roster in a
single call is a different act with a different risk, and the format it arrives
in does not change what the data is — so the bulk list is guarded alongside the
CSV. Money is analytics.read and is nobody's door job.

This walks both sides: everything a desk must be able to do, and everything it
must not, with an organiser checked against the same list so a tightened
permission can never quietly break the panel.

Runs against its own copy of the database.
Run:  python3 /root/event/backend/test_door_staff_boundary.py
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, "/root/event/backend")
import testbed                                              # noqa: E402
BASE, DB = testbed.start()

import main, models                                         # noqa: E402
from database import SessionLocal                           # noqa: E402

EVENT = 1
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code

def fetch(path, token):
    """Status and parsed body, for asserting what a response contains."""
    req = urllib.request.Request(BASE + path, method="GET",
                                 headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}


s = SessionLocal()
admin = s.query(models.User).filter(models.User.is_admin == True).first()   # noqa: E712
ADMIN = main.create_access_token({"sub": str(admin.id)})

PW = "testbed-desk-0007"
desk = s.query(models.User).filter(models.User.email == "boundary-desk@gaiahealers.test").first()
if desk is None:
    desk = models.User(email="boundary-desk@gaiahealers.test", full_name="Boundary Desk",
                       hashed_password=main.get_password_hash(PW), is_admin=False)
    s.add(desk); s.flush()
    s.add(models.EventRole(event_id=EVENT, user_id=desk.id, role="checkin_staff"))
    s.commit()

print("\nA DESK SIGNS IN THE WAY A PHONE DOES")
body = urllib.parse.urlencode({"username": desk.email, "password": PW}).encode()
req = urllib.request.Request(BASE + "/auth/login", data=body, method="POST",
                             headers={"Content-Type": "application/x-www-form-urlencoded"})
out = json.loads(urllib.request.urlopen(req, timeout=30).read())
DESK = out["access_token"]
check(bool(DESK), "a desk login returns a token")
check(out["user"]["is_admin"] is False, "and it is NOT an administrator", out["user"]["is_admin"])

# The same login on a second phone: JWTs carry no server session, so signing in
# again does not end the first one. That is what lets one desk run two devices.
out2 = json.loads(urllib.request.urlopen(urllib.request.Request(
    BASE + "/auth/login", data=body, method="POST",
    headers={"Content-Type": "application/x-www-form-urlencoded"}), timeout=30).read())
check(call("GET", "/events/%d/ticket-counts" % EVENT, DESK) == 200,
      "signing in on a second device does not log the first one out")
check(bool(out2["access_token"]), "and the second device gets a working token of its own")

CAN = [
    ("scan a badge",            "POST", "/events/%d/authorize" % EVENT,
     {"qr_code": "ATT-NOTREAL", "access_type": "EVENT_ENTRY"}),
    ("search for one person",   "GET",  "/events/%d/attendees/search?q=a" % EVENT, None),
    ("check for a duplicate",   "POST", "/events/%d/walk-in/check" % EVENT, {"email": "x@y.invalid"}),
    ("see the door counts",     "GET",  "/events/%d/ticket-counts" % EVENT, None),
    ("read the print log",      "GET",  "/events/%d/print-report" % EVENT, None),
    # The desk's half of the review queue: which seats still need a name. The
    # money half of the same list is withheld, which is asserted below.
    ("read the review queue",   "GET",  "/events/%d/review-queue" % EVENT, None),
    ("ask what it may do",      "GET",  "/events/%d/my-capabilities" % EVENT, None),
    ("read this event",         "GET",  "/events/%d" % EVENT, None),
]
CANNOT = [
    ("export the roster CSV",   "GET",  "/events/%d/attendees/export" % EVENT, None),
    ("pull the whole roster",   "GET",  "/events/%d/attendees" % EVENT, None),
    ("read the payments feed",  "GET",  "/events/%d/payments" % EVENT, None),
    ("read revenue summary",    "GET",  "/events/%d/payments/summary" % EVENT, None),
    ("read payments attention", "GET",  "/events/%d/payments/attention" % EVENT, None),
    ("read the acquisition report", "GET", "/events/%d/acquisition-report" % EVENT, None),
    ("read unmapped sales",     "GET",  "/events/%d/unmapped-sales" % EVENT, None),
    # Money wearing a different hat. ticket-metrics returns gross and net
    # revenue, and it was guarded by attendee.read -- which every door account
    # has, because looking one person up is the job all weekend.
    ("read the revenue metrics", "GET", "/events/%d/ticket-metrics" % EVENT, None),
    ("read the mapping audit",  "GET",  "/events/%d/ticket-mapping-audit" % EVENT, None),
    ("see who scanned who",     "GET",  "/events/%d/scan-history" % EVENT, None),
    ("read the door report",    "GET",  "/events/%d/door-report" % EVENT, None),
    ("clear the scan history",  "DELETE", "/events/%d/scan-logs" % EVENT, None),
    ("change door settings",    "POST", "/events/%d/re-entry" % EVENT, {"enabled": True}),
    ("turn rehearsal off",      "POST", "/events/%d/door-test-mode" % EVENT, {"enabled": False}),
    ("touch another event",     "GET",  "/events/2", None),
]

print("\nWHAT THE DESK MUST BE ABLE TO DO")
for label, method, path, body in CAN:
    st = call(method, path, DESK, body)
    check(st < 400, "%s" % label, st)

print("\nWHAT THE DESK MUST NOT BE ABLE TO DO")
for label, method, path, body in CANNOT:
    st = call(method, path, DESK, body)
    check(st == 403, "%s is refused" % label, st)

print("\nAND NONE OF THAT BROKE THE ORGANISER")
for label, method, path, body in CAN + CANNOT:
    if path == "/events/2":
        continue                      # archived; a 403 there is about the event, not the role
    st = call(method, path, ADMIN, body)
    check(st < 400, "an organiser can still %s" % label.replace(" is refused", ""), st)

print("\nTHE SAME LIST, TWO ROLES")
# The queue is readable at the door because "which seats still need a name" is
# the desk's own work. The money half of the same list is not: a double charge
# and what anybody paid are an organiser's business.
_st, desk_q = fetch("/events/%d/review-queue" % EVENT, DESK)
_st2, org_q = fetch("/events/%d/review-queue" % EVENT, ADMIN)
check(desk_q.get("money_visible") is False, "the desk's copy says money is withheld", desk_q.get("money_visible"))
check(org_q.get("money_visible") is True, "the organiser's copy includes it", org_q.get("money_visible"))
check(not any("amount" in r for r in (desk_q.get("items") or [])),
      "no amount appears anywhere in the desk's copy",
      [r for r in (desk_q.get("items") or []) if "amount" in r][:2])
_desk_kinds = {r["kind"] for r in (desk_q.get("items") or [])}
_money_kinds = {"payment_repeat", "charge_held", "sale_unmapped", "payment_unsettled"}
check(not (_desk_kinds & _money_kinds),
      "and none of the money sections are in it", sorted(_desk_kinds & _money_kinds))
check(_desk_kinds <= {"name_to_confirm", "seat_unnamed", "identity_review"},
      "only the work that belongs at a desk", sorted(_desk_kinds))
check(len(org_q.get("items") or []) >= len(desk_q.get("items") or []),
      "the organiser sees at least everything the desk sees",
      (len(org_q.get("items") or []), len(desk_q.get("items") or [])))

print("\nCLOSING AN ITEM")
# Closing is an organiser act, and it refuses to happen without a reason -- an
# item closed silently is indistinguishable from one nobody looked at.
_named = next((r for r in (org_q.get("items") or []) if r.get("resolvable")), None)
if _named:
    check(call("POST", "/events/%d/review-queue/resolve" % EVENT, DESK,
               {"attendee_id": _named["attendee_id"], "ref": str(_named["ref"]), "note": "desk tried"}) == 403,
          "a desk account cannot close a review item")
    check(call("POST", "/events/%d/review-queue/resolve" % EVENT, ADMIN,
               {"attendee_id": _named["attendee_id"], "ref": str(_named["ref"]), "note": "x"}) == 400,
          "and an organiser cannot close one without saying what was done")
else:
    check(False, "there was a resolvable item to test closing with")

print("\nTHE ROLE ITSELF")
caps = main.__dict__["authz"].capabilities_for(s, desk, EVENT)
check("attendee.export" not in caps, "a desk does not hold attendee.export", sorted(caps))
check("analytics.read" not in caps, "nor analytics.read")
check("attendee.write" not in caps, "nor attendee.write")
check("checkin.perform" in caps and "attendee.read" in caps,
      "but it does hold what the door needs", sorted(caps))
s.close()

print("\n" + ("ALL GOOD" if not fails else "FAILED: " + "; ".join(fails)))
sys.exit(1 if fails else 0)
