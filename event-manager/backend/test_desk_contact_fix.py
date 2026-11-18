"""Fixing contact details at the desk (Babak, 18 Nov 2026), on a copy.
  * desk staff fix name, phone, company, job title at once;
  * with the person there and identity checked, the desk corrects the EMAIL at
    once; the old address stays in the ticket's history;
  * without that tick the desk cannot, and an organiser's change still waits
    for a second admin;
  * an address already on another ticket, or not an address, is refused;
  * the order mirror replaying the purchase finds the same ticket: no duplicate.
Run: python3 test_desk_contact_fix.py"""
import json, os, sys, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["TESTBED_RAW_APPROVALS"] = "1"
import testbed
BASE, DB = testbed.start()
import main, models                                   # noqa: E402
from database import SessionLocal                     # noqa: E402
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok: fails.append(label)
env = {}
for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")):
    l = l.strip()
    if "=" in l and not l.startswith("#"): k, v = l.split("=", 1); env[k] = v.strip().strip('"').strip("'")
s = SessionLocal()
desk = s.query(models.User).filter(models.User.email == "desk1@gaiahealers.app").first()
DESK = main.create_access_token({"sub": str(desk.id)})
ADMIN = main.create_access_token({"sub": "1", "adm": True})
def call(p, b, tok):
    r = urllib.request.Request(BASE + p, data=json.dumps(b).encode(), method="POST",
                               headers={"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    try:
        with urllib.request.urlopen(r, timeout=60) as x: return x.status, json.loads(x.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")
def att(i):
    s.expire_all(); return s.get(models.Attendee, i)
st, r = call("/events/1/attendees/901/door-identity", {"phone": "+1 407 555 0101", "company": "Trentham Co", "job_title": "Owner"}, DESK)
a = att(901)
check(st == 200 and a.phone == "+1 407 555 0101" and a.company == "Trentham Co" and a.job_title == "Owner", "desk fixes phone, company, job title", (st, r))
old = a.email
st, r = call("/events/1/attendees/901/door-identity", {"email": "cameron.fixed@example.com"}, DESK)
check(st == 403 and att(901).email == old, "desk without the identity tick cannot change the email", st)
st, r = call("/events/1/attendees/901/door-identity", {"email": "Cameron.Fixed@Example.com", "identity_checked": True}, DESK)
a = att(901)
check(st == 200 and a.email == "cameron.fixed@example.com", "desk with the tick corrects the email at once", (st, r))
hist = [l for l in (a.custom_data or {}).get("lifecycle", []) if l.get("action") == "door_identity_fix" and "email" in (l.get("changed") or {})]
check(hist and hist[-1]["changed"]["email"]["from"] == old and hist[-1]["changed"]["email"].get("identity_checked_at_desk"),
      "the old address and the desk check are in the history", hist[-1:] if hist else None)
other = att(1).email
st, r = call("/events/1/attendees/901/door-identity", {"email": other, "identity_checked": True}, DESK)
check(st == 409 and att(901).email == "cameron.fixed@example.com", "an address already on another ticket is refused", st)
st, r = call("/events/1/attendees/901/door-identity", {"email": "not-an-email", "identity_checked": True}, DESK)
check(st == 400, "not an address: refused", st)
st, r = call("/events/1/attendees/13/door-identity", {"email": "victoria.test@example.com"}, ADMIN)
check(st == 409 and "second admin" in json.dumps(r) and att(13).email != "victoria.test@example.com",
      "an organiser's change from the back office still waits for a second admin", (st, r))
n0 = s.query(models.Attendee).filter(models.Attendee.event_id == 1).count()
st, r = call("/identity/reconcile-attendee", {"event_id": 1, "email": old, "ticket_type_id": 8, "is_upgrade": False,
             "contact_id": "bHcPmrV0TUbA4zjQqgOt", "order_id": "6afcd129fa8d1f4492701c39", "product_id": "69b463a14181e967e2fc2cfe",
             "quantity": 1, "amount": 104.94, "purchased_at": "2026-11-17T22:11:53"}, env["IDENTITY_SERVICE_TOKEN"])
s.expire_all()
check(st == 200 and r.get("attendee_id") == 901 and not r.get("created") and s.query(models.Attendee).filter(models.Attendee.event_id == 1).count() == n0
      and att(901).email == "cameron.fixed@example.com", "the mirror replaying the order finds the same ticket; no duplicate, email kept", r)
print("\n%d failed" % len(fails) if fails else "\nALL PASS"); sys.exit(1 if fails else 0)
