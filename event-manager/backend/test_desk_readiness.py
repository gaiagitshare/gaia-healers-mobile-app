"""Registration-desk readiness, 12 door scenarios (18 Nov 2026), on a throwaway
copy of the live database with the real API in front of it. Nothing is sent and
GHL is never called.

Desk staff = a door-only account (checkin_staff); dates are simulated with the
scan-time override (admin) so "Friday" and "Saturday" can be tested on Wednesday.

 1 one attendee, one ticket            7 an attendee with no phone number
 2 one person, several tickets         8 volunteer who also bought a ticket
 3 a purchaser with guest seats        9 a paid guest seat with no name yet
 4 GA and VIP for the same person     10 a checked-in attendee returning
 5 a transferred ticket               11 a three-day pass on another day
 6 an attendee whose email bounced    12 two devices scanning one ticket at once
 + ticket-number / order-number search, payment hidden from the desk.
Run:  python3 test_desk_readiness.py
"""
import json, os, sys, threading, urllib.error, urllib.request
os.environ["ALLOW_SCAN_TIME_OVERRIDE"] = "1"
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import testbed
BASE, DB = testbed.start()
import main, models                                     # noqa: E402
from database import SessionLocal                       # noqa: E402

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok: fails.append(label)

s = SessionLocal()
# The testbed turns re-entry off on its copy; the live event has it ON (checked
# 18 Nov), and a three-day conference needs it, so test the live setting.
_ev = s.query(models.Event).filter(models.Event.id == 1).first(); _ev.allow_reentry = True
# Simulate Friday: rehearsal switched off (on this COPY only; live stays on until Friday).
_ev.door_test_mode = False; s.commit()
admin = s.query(models.User).filter(models.User.is_admin == True).first()   # noqa: E712
ADMIN = main.create_access_token({"sub": str(admin.id), "adm": True})
desk = models.User(email="readiness-desk@gaiahealers.test", full_name="Readiness Desk",
                   hashed_password=main.get_password_hash("x-desk-0009"), is_admin=False)
s.add(desk); s.flush(); s.add(models.EventRole(event_id=1, user_id=desk.id, role="checkin_staff")); s.commit()
DESK = main.create_access_token({"sub": str(desk.id)})

def call(m, p, b=None, tok=None):
    r = urllib.request.Request(BASE + p, data=json.dumps(b).encode() if b is not None else None, method=m,
                               headers={"Content-Type": "application/json", "Authorization": "Bearer " + (tok or DESK)})
    try:
        with urllib.request.urlopen(r, timeout=120) as x: return x.status, json.loads(x.read() or b"null")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b"null")
        except Exception: return e.code, None

def find(q):
    st, r = call("GET", "/events/1/attendees/search?q=" + urllib.request.quote(q))
    return r if st == 200 else []

def att(aid):
    return s.query(models.Attendee).filter(models.Attendee.id == aid).first()

def scan(aid, day="2026-11-20", tok=None):
    s.expire_all()
    return call("POST", "/events/1/authorize", {"qr_code": att(aid).qr_code, "access_type": "EVENT_ENTRY", "at": day},
                tok=tok or ADMIN)[1] or {}

def card(aid):
    st, r = call("GET", "/events/1/attendees/%d/door" % aid)
    if st != 200:   # fall back to the scan answer's card
        r = (scan_preview(aid) or {}).get("door")
    return r or {}

def scan_preview(aid):
    return None

def desk_of(results, aid):
    return next((r.get("desk") for r in results if r["id"] == aid), None) or {}

print("\n1. one attendee, one ticket (Jane Oelke)")
r = find("Jane Oelke"); d = desk_of(r, 1)
check(d.get("status") == "READY" and len(d.get("tickets", [])) == 1, "READY, one ticket", d)
v = scan(1)
check(v.get("result") == "GRANTED", "admitted on Friday", v.get("reason"))
check(not any(k in json.dumps([x.get("desk") for x in r]) for k in ('"amount"', '"money"', 'transaction', '$')), "the desk summary carries no money")

print("\n2. one person, several tickets (Sandra Hartung)")
r = find("Sandra Hartung")
ids = sorted(x["id"] for x in r if x["last_name"] == "Hartung")
d = desk_of(r, 196)
check(ids == [195, 196] and "MULTIPLE" in d.get("statuses", []), "both tickets found, MULTIPLE", (ids, d.get("statuses")))
check(any("Do not cancel" in n for n in d.get("notes", [])), "says: do not cancel either", d.get("notes"))
check(scan(195).get("result") == "GRANTED" and scan(196).get("result") == "GRANTED", "each ticket admits one person")

print("\n3. a purchaser with several guest seats (Jessica Star Ison)")
r = find("Jessica Star Ison")
d = desk_of(r, 204)
seats = [t for t in d.get("tickets", []) if t["relation"] == "guest seat on this booking"]
check(len(seats) >= 3, "the buyer's card lists every guest seat", [t["id"] for t in d.get("tickets", [])])
gs = desk_of(r, seats[0]["id"]) if seats else {}
check(gs.get("status") == "VERIFY" and any("guest" in n for n in gs.get("notes", [])), "a guest seat says: confirm the guest", gs)
check(scan(seats[0]["id"]).get("result") == "GRANTED" if seats else False, "a guest seat admits")

print("\n4. GA and VIP for the same person (Eileen Lubinski)")
r = find("Eileen Lubinski"); d = desk_of(r, 908)
check("MULTIPLE" in d.get("statuses", []) and {t["id"] for t in d.get("tickets", [])} == {684, 908}, "both tickets shown together", d.get("tickets"))
check(all(t.get("order_ref") for t in d.get("tickets", [])), "each with its own order reference")
check(att(684).registration_status != "revoked" and att(908).registration_status != "revoked", "neither is cancelled or merged")
v = scan(908); check(v.get("result") == "GRANTED" and any(w["color"] == "green" for w in (v.get("door") or {}).get("wristbands", [])), "VIP ticket: GREEN band", v.get("door", {}).get("wristbands"))

print("\n5. a transferred ticket (#195, Terry Woods -> Sandra Hartung)")
d = desk_of(find("Sandra Hartung"), 195)
check(any("Originally purchased by Terry Woods" in n for n in d.get("notes", [])), "says who bought it", d.get("notes"))

print("\n6. an attendee whose email bounced (Victoria Philips)")
d = desk_of(find("Victoria Philips"), 13)
check(d.get("status") == "VERIFY" and "BLOCKED" not in d.get("statuses", []), "VERIFY, never BLOCKED", d)
check(any("Email could not be delivered" in n for n in d.get("notes", [])), "explains the email problem")
check(scan(13).get("result") == "GRANTED", "and the ticket admits")

print("\n7. an attendee with no phone (Matt Ma, exhibitor staff)")
r = find("Matt Ma"); d = desk_of(r, 902)
check(any(x["id"] == 902 for x in r) and not att(902).phone and d.get("status") == "READY", "found by name, READY", d)

print("\n8. volunteer who also bought a ticket (Kay Raymond)")
r = find("Kay Raymond")
d1, d2 = desk_of(r, 274), desk_of(r, 810)
check(d1.get("status") == "VERIFY" and d2.get("status") == "VERIFY", "both VERIFY", (d1.get("statuses"), d2.get("statuses")))
check(any("Possible volunteer and paid attendee match" in n for n in d1.get("notes", [])), "flagged as a POSSIBLE match")
check(att(274).registration_status != "revoked" and att(810).registration_status != "revoked", "records kept separate, both valid")

print("\n9. a paid guest seat with no name (Marian Balta)")
d = desk_of(find("Marian Balta"), 774)
check(any("not yet named" in n and "Three Day" in n for n in d.get("notes", [])), "the buyer's card says a Three Day seat is waiting", d.get("notes"))
st, out = call("POST", "/events/1/attendees/774/add-seat", {"first_name": "Robin", "last_name": "Guest", "reason": "test"})
seat = att(out.get("attendee_id")) if st == 200 else None
check(st == 200 and seat is not None, "the desk names the seat (no charge)", (st, out))
check(seat is not None and seat.ticket_type_id == 5, "on the Three Day pass the order bought, not the buyer's VIP",
      seat and seat.ticket_type_id)
st2, _ = call("POST", "/events/1/attendees/774/add-seat", {"first_name": "Extra", "last_name": "Person", "reason": "test"})
check(st2 == 409, "a second seat is refused: the order paid for two", st2)
s.expire_all()
check(scan(seat.id).get("result") == "GRANTED" if seat else False, "the new guest badge admits")

print("\n10. a checked-in attendee returning")
v2 = scan(1)
# (entries_today counts the scan log by REAL date, so a simulated Friday cannot
#  show it; on the day it reads "back again today".)
check(v2.get("result") == "GRANTED" and v2.get("checked_in_now") is False and v2.get("checked_in"),
      "re-entry admitted, as a return (not a second first entry); check-in history kept", (v2.get("result"), v2.get("checked_in_now")))

print("\n11. a three-day pass on another day")
v = scan(1, day="2026-11-21")
check(v.get("result") == "GRANTED", "Saturday: admitted", v.get("reason"))
fri = next(a for a in s.query(models.Attendee).filter(models.Attendee.event_id == 1, models.Attendee.ticket_type_id == 14).all()
           if (a.registration_status or "") not in ("revoked", "cancelled", "refunded"))
v = scan(fri.id, day="2026-11-21")
check(v.get("result") != "GRANTED", "a Friday-only pass is refused on Saturday", v.get("result"))

print("\n12. two devices scanning the same ticket at once")
target = 57
res = []
def go():
    res.append(scan(target, tok=ADMIN))
th = [threading.Thread(target=go) for _ in range(2)]
[t.start() for t in th]; [t.join() for t in th]
s.expire_all()
first = [x for x in res if x.get("checked_in_now")]
check(len(res) == 2 and all(x.get("result") == "GRANTED" for x in res), "both answers are GRANTED (re-entry is on)", [x.get("result") for x in res])
check(len(first) == 1, "exactly one of them is the first entry", [x.get("checked_in_now") for x in res])
check(att(target).is_checked_in, "the ticket is checked in once")

print("\n+ search by ticket number, order number, phone; money only for organisers")
check(any(x["id"] == 909 for x in find("#909")), "ticket number #909")
check(any(x["id"] == 908 for x in find("d9120d")), "order number (last characters)")
check(any(x["id"] == 76 for x in find("4075695486")), "phone number")
_, sc = call("POST", "/events/1/authorize", {"qr_code": att(684).qr_code, "access_type": "EVENT_ENTRY", "at": "2026-11-20"}, tok=DESK)
cd = (sc or {}).get("door") or {}
check(cd.get("desk", {}).get("status") == "MULTIPLE" and cd.get("may", {}).get("comp") is False,
      "a desk scan shows the desk summary and is not an organiser view (money hidden on screen)", (cd.get("desk", {}).get("status"), cd.get("may")))

print("\n%d failed" % len(fails) if fails else "\nALL PASS")
sys.exit(1 if fails else 0)
