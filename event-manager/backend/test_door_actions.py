# -*- coding: utf-8 -*-
"""THE DOOR ON THE DAY — what the desk can see, and what it can fix.

Three things went wrong on this year's roll before anyone scanned anything: a
seat existed only inside somebody else's order, the name on it was the buyer's
guess, and a couple of badges belonged to people the rules would refuse. All
three arrive at one place — a person standing at a desk with a queue behind
them — and all three have to be answerable there, in one tap, without walking
over to the attendee list.

What this pins down:

  * the scan decision carries the whole picture, not just the verdict: the pass,
    what was paid and by whom, whether the name still needs checking, and the
    rest of the booking with who of them is already inside;
  * a refusal can be overridden by a named person with a reason, and the
    override never alters the ticket — the refusal stays true and stays visible;
  * the correction the weekend will actually need most, typing somebody's real
    name onto a rebuilt seat, is inside the DOOR capability, because organisers
    are not standing at the desk;
  * the email address is not, because it is how the permanent card is claimed;
  * revoke and reinstate work from the same screen and the door believes them.

Runs against a COPY of the live database. Nothing here touches production.
Run:  python3 /root/event/backend/test_door_actions.py
"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request

HERE = "/root/event/backend"
PORT = 8911
COPY = os.path.join(tempfile.mkdtemp(prefix="door-actions-"), "event.db")
shutil.copy(HERE + "/event.db", COPY)
sys.path.insert(0, HERE)

# The API under test runs against a COPY, in its own process on its own port.
# Nothing here can reach the live database or the live door.
env = dict(os.environ, DATABASE_URL="sqlite:///" + COPY)
server = subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(PORT),
     "--log-level", "warning"],
    cwd=HERE, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
BASE = "http://127.0.0.1:%d" % PORT

def stop():
    server.terminate()
    try: server.wait(timeout=10)
    except Exception: server.kill()
    shutil.rmtree(os.path.dirname(COPY), ignore_errors=True)

for _ in range(80):
    try:
        urllib.request.urlopen(BASE + "/events", timeout=2)
        break
    except urllib.error.HTTPError:
        break                                   # 401 == it is listening
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

import main, models                                  # noqa: E402
os.environ["DATABASE_URL"] = "sqlite:///" + COPY     # this process talks to the copy too
import importlib, database                           # noqa: E402
importlib.reload(database)
from database import SessionLocal                    # noqa: E402

EVENT = 1

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def bearer(user_id):
    return {"Authorization": "Bearer " + main.create_access_token({"sub": str(user_id)})}

db = SessionLocal()

# An organiser (the platform owner) and a door staffer who is nothing else.
admin = db.query(models.User).filter(models.User.is_admin == True).first()
staff = models.User(email="door-test@gaiahealers.test", hashed_password="x",
                    full_name="Door Staff", is_admin=False)
db.add(staff); db.flush()
db.add(models.EventRole(event_id=EVENT, user_id=staff.id, role="checkin_staff"))
db.commit()
ADMIN, STAFF = bearer(admin.id), bearer(staff.id)

# The conference is in November. The door is put in rehearsal so the calendar
# gate does not hide everything else -- the same switch staff use to practise,
# and it is stamped on every decision it touches.
event = db.query(models.Event).filter(models.Event.id == EVENT).first()
event.door_test_mode = True
db.commit()

seat = db.query(models.Attendee).filter(
    models.Attendee.event_id == EVENT,
    models.Attendee.registration_source == "rebuilt_seat").order_by(models.Attendee.id).first()
assert seat is not None, "no rebuilt seat to test against"
SEAT_ID, SEAT_QR, SEAT_FIRST = seat.id, seat.qr_code, seat.first_name
buyer_id = int((seat.custom_data or {}).get("bought_by_attendee"))
buyer = db.query(models.Attendee).filter(models.Attendee.id == buyer_id).first()
BUYER_QR, BUYER_EMAIL = buyer.qr_code, buyer.email

def scan(qr, who=None, zone="EVENT_ENTRY"):
    _, out = call("POST", "/events/%d/authorize" % EVENT,
                  {"qr_code": qr, "access_type": zone}, who or ADMIN)
    return out

def identity(body, who):
    return call("POST", "/events/%d/attendees/%d/door-identity" % (EVENT, SEAT_ID), body, who)

def override(body, who, event_id=EVENT, attendee_id=None):
    return call("POST", "/events/%d/attendees/%d/override-admit" % (event_id, attendee_id or SEAT_ID), body, who)

print("\nWHAT THE DESK SEES")
d = scan(SEAT_QR)
card = d.get("door") or {}
check(bool(card), "the decision carries a door card at all", d)
check(bool(card.get("pass_display")), "it names the pass in words a person can read", card.get("pass_display"))
check(card.get("needs_name_check") is True, "it says this seat's name still needs checking")
check(isinstance(card.get("money"), dict) and "total" in card["money"],
      "it answers the money question", card.get("money"))
print("     pass: %s" % card.get("pass_display"))
print("     money: $%s %s from %d payment(s)" % (card["money"]["total"], card["money"]["currency"], card["money"]["count"]))

party = card.get("party") or {}
names = [m["name"] for m in party.get("members", [])]
check(party.get("buyer_attendee_id") == buyer_id, "the booking is keyed on the buyer, not a name", party.get("buyer"))
check(party.get("size") == len(names) and len(names) >= 2, "every seat on the booking is listed", names)
check(party["members"][0]["is_buyer"] is True, "the person who paid is first", names[:1])
check(sum(1 for m in party["members"] if m["is_this_one"]) == 1, "exactly one of them is the badge in hand")
check(all(m.get("qr_code") for m in party["members"]),
      "each of them can be pulled up without their badge")
print("     %s \u2014 seat %s of %s's booking: %s" % (
    d.get("name"), party.get("seat"), party.get("buyer"), ", ".join(names)))

dbuyer = scan(BUYER_QR)
bparty = (dbuyer.get("door") or {}).get("party") or {}
check(bparty.get("size") == party.get("size"), "the buyer sees the same booking their seats do",
      (bparty.get("size"), party.get("size")))

print("\nTYPING THE RIGHT NAME ONTO A REBUILT SEAT")
st, out = identity({"first_name": "Realfirst", "last_name": "Realsurname",
                    "reason": "asked them at the desk"}, STAFF)
check(st == 200, "door staff may correct a name without an organiser", (st, out))
changed = (out or {}).get("changed") or {}
check(changed.get("first_name", {}).get("from") == SEAT_FIRST,
      "the old name is kept in the audit trail", changed.get("first_name"))
check((out.get("door") or {}).get("needs_name_check") is False,
      "and the seat stops asking to be checked")
db.expire_all()
after = db.query(models.Attendee).filter(models.Attendee.id == SEAT_ID).first()
life = [e for e in (after.custom_data or {}).get("lifecycle", []) if e.get("action") == "door_identity_fix"]
check(len(life) == 1 and life[0].get("actor") == staff.email, "signed by whoever typed it", life[:1])

print("\nTHE EMAIL IS NOT THE DOOR'S TO CHANGE")
st, _ = identity({"email": "someone-else@example.com"}, STAFF)
check(st == 403, "door staff cannot move the address that claims the card", st)
st, out = identity({"email": "someone-else@example.com"}, ADMIN)
check(st == 200, "an organiser can", (st, out))
st, out = identity({"email": BUYER_EMAIL}, ADMIN)
check(st == 409, "and nobody can give two people one address", (st, out))

print("\nLETTING SOMEBODY IN THAT THE RULES REFUSED")
call("POST", "/attendees/%d/revoke" % SEAT_ID, {"reason": "test"}, ADMIN)
d = scan(SEAT_QR)
check(d.get("result") == "DENIED", "a revoked badge is refused", d.get("reason"))
refusal = d.get("reason")

st, out = override({"reason": "no"}, STAFF)
check(st == 400, "an override with no real reason is refused", (st, out))

st, o = override({"reason": "showed a receipt, organiser approved"}, STAFF)
check(st == 200 and o.get("granted") is True, "with a reason, the door opens", (st, o))
check(o.get("result") == "OVERRIDE", "and says outright that it was overridden", o.get("result"))
check(o.get("refused_reason") == refusal, "the refusal is kept, not overwritten", o.get("refused_reason"))
check(o.get("checked_in") is True, "the person is checked in")

db.expire_all()
after = db.query(models.Attendee).filter(models.Attendee.id == SEAT_ID).first()
check(main._ticket_status(after) == "revoked",
      "the TICKET is untouched \u2014 still revoked tomorrow", main._ticket_status(after))

_, logs = call("GET", "/events/%d/scan-logs?limit=10" % EVENT, None, ADMIN)
ov = [l for l in (logs or {}).get("items", []) if l.get("result") == "OVERRIDE"]
check(len(ov) == 1, "the override has its own row in the scan history", len(ov))
_reason = (ov[0].get("reason") or "") if ov else ""
check("was:" in _reason and "receipt" in _reason,
      "carrying both what the door said and what the human said", _reason[:140])
check(ov and (ov[0].get("staff_user_id") == staff.id or ov[0].get("staff_email") == staff.email),
      "against the person who made the call", ov[0] if ov else None)

print("\nPUTTING IT BACK")
st, _ = call("POST", "/attendees/%d/reinstate" % SEAT_ID, {"reason": "resolved"}, ADMIN)
check(st == 200, "reinstate works from the same screen", st)
d = scan(SEAT_QR)
check((d.get("door") or {}).get("status") == "active", "and the door believes it", (d.get("door") or {}).get("status"))

print("\nCHANGING THE PASS WHERE THEY ARE STANDING")
_, tts = call("GET", "/events/%d/ticket-types" % EVENT, None, ADMIN)
other = next((t for t in (tts or []) if t["id"] != after.ticket_type_id), None)
if other:
    st, out = call("POST", "/attendees/%d/change-pass" % SEAT_ID,
                   {"ticket_type_id": other["id"], "reason": "upgraded at the door",
                    "complimentary": True, "allow_downgrade": True}, ADMIN)
    check(st == 200, "the pass changes", (st, out))
    d = scan(SEAT_QR)
    check((d.get("door") or {}).get("ticket_type_id") == other["id"],
          "and the very next scan shows the new one", (d.get("door") or {}).get("ticket_type_id"))
    check(d.get("qr_code") == SEAT_QR, "on the same badge \u2014 never a second one")

print("\nFINISHING A BOOKING THAT PAID FOR MORE SEATS THAN IT NAMED")
# Jessica Star Ison bought four and only three could be rebuilt: the fourth
# name never reached any system. That seat is paid for, and the entrance is
# where the name finally gets collected.
short = None
for a in db.query(models.Attendee).filter(models.Attendee.event_id == EVENT,
                                          models.Attendee.registration_source == "rebuilt_seat").all():
    p = main._party_members(db, a)
    if p and p["unnamed"] > 0:
        short = (a, p); break
check(short is not None, "the roll really does contain a booking with an unnamed seat")
if short:
    a, p = short
    print("     %s paid for %d, has %d badges \u2014 %d unnamed" % (p["buyer"], p["paid_for"], p["size"], p["unnamed"]))
    before = p["size"]
    st, out = call("POST", "/events/%d/attendees/%d/add-seat" % (EVENT, a.id),
                   {"first_name": "Fourth", "last_name": "Guest"}, STAFF)
    check(st == 200, "door staff can name it without an organiser", (st, out))
    check(bool(out.get("qr_code")) and out["qr_code"].startswith("ATT-"),
          "the new seat gets its own badge code", out.get("qr_code"))
    d2 = scan(out["qr_code"])
    p2 = (d2.get("door") or {}).get("party") or {}
    check(d2.get("granted") is True, "and it scans", d2.get("reason"))
    check(p2.get("size") == before + 1 and p2.get("unnamed") == 0,
          "the booking is now complete", (p2.get("size"), p2.get("unnamed")))
    check(p2.get("buyer_attendee_id") == p["buyer_attendee_id"],
          "on the same booking, under the buyer's name", p2.get("buyer"))
    check((d2.get("door") or {}).get("ticket_type_id") == a.ticket_type_id,
          "holding the pass the buyer paid for")

    # The bound. This is the whole reason it is safe to give the door.
    st, out = call("POST", "/events/%d/attendees/%d/add-seat" % (EVENT, a.id),
                   {"first_name": "Fifth", "last_name": "Gatecrasher"}, STAFF)
    check(st == 409, "a fifth person cannot be added to a booking of four", (st, out))
    check("walk-in" in str(out).lower(), "and the door is told where they DO belong", out)

# A party of one is not a booking, and must not become a way to mint badges.
solo = db.query(models.Attendee).filter(
    models.Attendee.event_id == EVENT,
    models.Attendee.registration_source == "ghl_order").order_by(models.Attendee.id.desc()).first()
solo_party = main._party_members(db, solo)
if solo_party is None:
    st, out = call("POST", "/events/%d/attendees/%d/add-seat" % (EVENT, solo.id),
                   {"first_name": "Nobody"}, STAFF)
    check(st == 409, "a single ticket cannot sprout a second seat", (st, out))

print("\nNOBODY ELSE'S DOOR")
st, _ = override({"reason": "wrong event on purpose"}, STAFF, event_id=2)
check(st in (403, 404), "a badge cannot be overridden at an event it does not belong to", st)

print("\n" + ("ALL GOOD" if not fails else "FAILED: " + "; ".join(fails)))
stop()
sys.exit(1 if fails else 0)
