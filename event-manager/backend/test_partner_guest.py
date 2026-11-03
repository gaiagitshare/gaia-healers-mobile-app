"""ADD COLLABORATING GUEST — a Health & Healing Expo visitor at our door.

Staff check the partner ticket by eye and issue our own complimentary badge.
What this pins down:
  * desk staff (check-in role) can register one; it needs no organiser;
  * the pass is chosen by the server and is exhibition-only: entry and exhibit
    are granted, conference / workshop / VIP are not;
  * a unique Gaia QR and card; source event, confirmation number and the staff
    member are recorded; no payment, never in the reconciliation queue;
  * the same email, or the same partner confirmation number, never creates a
    second guest; a similar person needs an explicit "different person";
  * the normal atomic check-in admits them once; a second scan does not
    re-admit; reprinting the badge creates no admission;
  * desk staff can correct the name, with history; they cannot pick another pass.

Runs against a COPY of the live database. Nothing here touches production.
Run:  python3 /root/event/backend/test_partner_guest.py
"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request

HERE = "/root/event/backend"
PORT = 8913
COPY = os.path.join(tempfile.mkdtemp(prefix="partner-guest-"), "event.db")
shutil.copy(HERE + "/event.db", COPY)
sys.path.insert(0, HERE)
env = dict(os.environ, DATABASE_URL="sqlite:///" + COPY)
server = subprocess.Popen([sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(PORT),
                           "--log-level", "warning"], cwd=HERE, env=env,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
BASE = "http://127.0.0.1:%d" % PORT


def stop():
    server.terminate()
    try: server.wait(timeout=10)
    except Exception: server.kill()
    shutil.rmtree(os.path.dirname(COPY), ignore_errors=True)


for _ in range(80):
    try:
        urllib.request.urlopen(BASE + "/events", timeout=2); break
    except urllib.error.HTTPError:
        break
    except Exception:
        time.sleep(0.25)
else:
    stop(); sys.exit("the test server never came up")


def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try: return e.code, json.loads(raw or "null")
        except Exception: return e.code, raw


os.environ["DATABASE_URL"] = "sqlite:///" + COPY
import main, models                                  # noqa: E402
import importlib, database                           # noqa: E402
importlib.reload(database)
from database import SessionLocal                    # noqa: E402

EVENT = 1
fails = []


def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok: fails.append(label)


def bearer(uid):
    return {"Authorization": "Bearer " + main.create_access_token({"sub": str(uid)})}


try:
    db = SessionLocal()
    admin = db.query(models.User).filter(models.User.is_admin == True).first()  # noqa: E712
    staff = models.User(email="partner-desk@gaiahealers.test", hashed_password="x", full_name="Desk", is_admin=False)
    nobody = models.User(email="no-role@gaiahealers.test", hashed_password="x", full_name="Nobody", is_admin=False)
    db.add_all([staff, nobody]); db.flush()
    db.add(models.EventRole(event_id=EVENT, user_id=staff.id, role="checkin_staff"))
    ev = db.query(models.Event).filter(models.Event.id == EVENT).first(); ev.door_test_mode = True
    db.commit()
    STAFF, ADMIN, NOBODY = bearer(staff.id), bearer(admin.id), bearer(nobody.id)
    G = {"first_name": "Zz Partner", "last_name": "Visitor", "email": "zz.partner.visitor@example.invalid",
         "phone": "+1 555 0100", "partner_event": "Health & Healing Expo", "partner_confirmation": "HHE-778899"}

    def awaiting():
        return ((call("GET", "/events/%d/door-report" % EVENT, None, ADMIN)[1] or {}).get("walk_ins") or {}).get("awaiting_ghl_reconciliation")
    AWAIT_BEFORE = awaiting()

    print("\nWHO MAY ADD ONE")
    st, out = call("POST", "/events/%d/partner-guest" % EVENT, G, NOBODY)
    check(st == 403, "someone without a door role cannot", (st, out))

    print("\nDESK STAFF ADD A GUEST")
    st, out = call("POST", "/events/%d/partner-guest" % EVENT, G, STAFF)
    a = (out or {}).get("attendee") or {}
    check(st == 200 and out.get("created") is True, "created by desk staff, no organiser needed", (st, out))
    check(a.get("qr_code", "").startswith("ATT-") and a.get("public_token"), "unique Gaia QR and card token", a)
    db.expire_all()
    row = db.query(models.Attendee).filter(models.Attendee.id == a.get("id")).first()
    tt = db.query(models.TicketType).filter(models.TicketType.id == row.ticket_type_id).first()
    check(not tt.grants_conference and not tt.grants_workshops and not tt.is_vip and not (tt.valid_day or ""),
          "pass is all-days exhibition-only (%s)" % tt.name, (tt.name, tt.grants_conference, tt.grants_workshops))
    cd = row.custom_data or {}
    check(cd.get("partner_event") == "Health & Healing Expo" and cd.get("partner_confirmation") == "HHE-778899"
          and cd.get("registered_by") == staff.id, "source event, confirmation number and staff member recorded", cd)
    check(row.registration_source == "partner_guest" and row.attendance_type == "complimentary"
          and row.door_payment_status == "waived", "complimentary, no payment", (row.registration_source, row.attendance_type, row.door_payment_status))
    life = [e for e in cd.get("lifecycle", []) if e.get("action") == "partner_guest_registered"]
    check(len(life) == 1 and life[0].get("actor") == staff.email, "audit entry names the staff member", life)
    check(AWAIT_BEFORE is not None and awaiting() == AWAIT_BEFORE, "never in the payment reconciliation queue", (AWAIT_BEFORE, awaiting()))

    print("\nNO DUPLICATES")
    st, again = call("POST", "/events/%d/partner-guest" % EVENT, G, STAFF)
    check(st == 200 and again.get("created") is False and again["attendee"]["id"] == row.id, "same email: the existing guest", again)
    G2 = dict(G, email="other.address@example.invalid", first_name="Zz Partner")
    st, again = call("POST", "/events/%d/partner-guest" % EVENT, G2, STAFF)
    check(st == 200 and again.get("created") is False and again["attendee"]["id"] == row.id,
          "same partner confirmation number: the existing guest", again)
    G3 = dict(G, email="zz.partner.twin@example.invalid", partner_confirmation=None)
    st, again = call("POST", "/events/%d/partner-guest" % EVENT, G3, STAFF)
    check(st == 200 and again.get("reason") == "possible_duplicate", "same name and phone: asks first", again)
    st, again = call("POST", "/events/%d/partner-guest" % EVENT, dict(G3, confirm_new=True), STAFF)
    check(st == 200 and again.get("created") is True and again["attendee"]["id"] != row.id, "explicit different person: created", again)

    print("\nAT THE DOOR")
    def scan(zone):
        return call("POST", "/events/%d/authorize" % EVENT, {"qr_code": row.qr_code, "access_type": zone}, STAFF)[1]
    first = scan("EVENT_ENTRY")
    check(first.get("granted") and first.get("checked_in_now"), "admitted once through the normal check-in", first.get("reason"))
    second = scan("EVENT_ENTRY")
    check(not second.get("checked_in_now"), "a second scan does not record another entry", second.get("reason"))
    ex = scan("EXHIBIT")
    check(ex.get("granted") is True, "exhibition hall: yes", ex.get("reason"))
    for z in ("CONFERENCE", "WORKSHOP", "VIP"):
        d = scan(z)
        check(d.get("result") != "GRANTED", "%s: not included" % z.lower(), (d.get("result"), d.get("reason")))

    print("\nREPRINT AND CORRECT")
    for i in range(2):
        st, pr = call("POST", "/events/%d/attendees/%d/badge-print" % (EVENT, row.id),
                      {"station": "Desk 1", "result": "printed", "client_attempt_id": "zz-%d" % i}, STAFF)
    db.expire_all(); row2 = db.query(models.Attendee).filter(models.Attendee.id == row.id).first()
    entries = db.query(models.ScanLog).filter(models.ScanLog.attendee_id == row.id, models.ScanLog.result == "GRANTED",
                                              models.ScanLog.access_type == "EVENT_ENTRY").count()
    check(st == 200 and int(row2.badge_print_count or 0) >= 2 and entries == 1, "reprints logged; still one admission",
          (st, row2.badge_print_count, entries))
    st, fix = call("POST", "/events/%d/attendees/%d/door-identity" % (EVENT, row.id),
                   {"first_name": "Zz Corrected", "last_name": "Visitor", "reason": "spelling"}, STAFF)
    db.expire_all(); row3 = db.query(models.Attendee).filter(models.Attendee.id == row.id).first()
    hist = [e for e in (row3.custom_data or {}).get("lifecycle", []) if e.get("action") == "door_identity_fix"]
    check(st == 200 and row3.first_name == "Zz Corrected" and hist, "desk can correct the name, with history", (st, fix))
    check(row3.ticket_type_id == row.ticket_type_id, "the pass did not change")
finally:
    stop()

print("\n" + ("ALL GOOD" if not fails else "FAILED: " + "; ".join(fails)))
sys.exit(1 if fails else 0)
