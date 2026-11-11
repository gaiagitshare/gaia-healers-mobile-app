# -*- coding: utf-8 -*-
"""Event-day fixes from the 11 Nov 2026 audit, on a testbed copy:
* a desk walk-in must carry one of THIS event's passes, and the desk cannot
  give a VIP/conference/workshop pass without taking payment;
* door staff see their own recent scans (without codes);
* the event and scheduled announcements follow the venue's clock, not UTC."""
import json, sys, os, urllib.error, urllib.request, uuid
from datetime import datetime, timedelta
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import testbed
BASE, DB = testbed.start()
import main, models
from database import SessionLocal

fails = []
def check(ok, label, detail=""):
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", label, "" if ok else "   %s" % (detail,)))
    if not ok: fails.append(label)
def call(m, p, tok=None, body=None):
    d = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + p, data=d, method=m); r.add_header("Content-Type", "application/json")
    if tok: r.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(r) as x: return x.status, json.loads(x.read() or "null")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or "null")
        except Exception: return e.code, None

s = SessionLocal()
admin = s.query(models.User).filter(models.User.is_admin == True).first()
ADMIN = main.create_access_token({"sub": str(admin.id)})
desk = models.User(email="zz-desk-%s@example.invalid" % uuid.uuid4().hex[:6], full_name="Zz Desk", hashed_password="x")
s.add(desk); s.commit(); s.refresh(desk)
s.add(models.EventRole(event_id=1, user_id=desk.id, role="checkin_staff")); s.commit()
DESK = main.create_access_token({"sub": str(desk.id)})
tts = {t.name: t.id for t in s.query(models.TicketType).filter(models.TicketType.event_id == 1).all()}
other = s.query(models.TicketType).filter(models.TicketType.event_id != 1).first()

print("EVENT-DAY FIXES")
def walk(tok, tt, pay="none", **kw):
    b = {"first_name": "Zz", "last_name": "Walk", "email": "zz-w-%s@example.invalid" % uuid.uuid4().hex[:8], "phone": "",
         "ticket_type_id": tt, "attendance_type": "paid", "door_payment_status": pay, "confirm_new": True}
    b.update(kw); return call("POST", "/events/1/walk-in", tok, b)
if other:
    check(walk(ADMIN, other.id)[0] == 400, "a walk-in cannot carry another event's pass")
_st, _w = walk(ADMIN, None)
check(_st == 200 and ((_w or {}).get("attendee") or {}).get("ticket_type_id") == main._exhibit_only_pass(s, 1).id,
      "a walk-in without a chosen pass gets the exhibit-hall pass", (_st, (_w or {}).get("attendee", {}).get("ticket_type_id") if isinstance(_w, dict) else _w))
check(walk(DESK, tts["VIP Pass"])[0] == 403, "the desk cannot give a VIP pass without taking payment")
check(walk(DESK, tts["General Admission"])[0] == 200, "but can register the exhibit-hall pass for someone who already paid")
check(walk(DESK, tts["VIP Pass"], "collected", door_payment_method="cash", door_payment_amount=500)[0] == 200,
      "and can sell a VIP pass at the door")
check(walk(ADMIN, tts["VIP Pass"], attendance_type="complimentary")[0] == 200, "an organiser can still comp a VIP")

sl = models.ScanLog(event_id=1, attendee_id=None, qr_code="ATT-ZZSECRET", access_type="EVENT_ENTRY", result="DENIED",
                    reason="test", staff_user_id=desk.id)
s.add(sl); s.add(models.ScanLog(event_id=1, qr_code="ATT-ZZOTHER", access_type="EVENT_ENTRY", result="GRANTED", reason="t",
                               staff_user_id=admin.id)); s.commit()
st, logs = call("GET", "/events/1/scan-logs", DESK)
items = (logs or {}).get("items", [])
check(st == 200 and any(i["reason"] == "test" for i in items), "door staff see their own recent scans", st)
check(all(i.get("staff_user_id") == desk.id for i in items), "and only their own")
check(all(i.get("qr_code") is None for i in items), "without the codes")
st, alllogs = call("GET", "/events/1/scan-logs", ADMIN)
check(any(i.get("qr_code") == "ATT-ZZOTHER" for i in (alllogs or {}).get("items", [])), "organisers still see everything")

# venue clock: an Orlando event ending 3 h from now (venue time) is still on
ev = s.query(models.Event).filter(models.Event.id == 1).first()
vnow = main.venue_now(ev)
ev.end_date = vnow + timedelta(hours=3); s.commit()
st, nxt = call("GET", "/public/events/next")
check(st == 200 and nxt.get("id") == 1, "the event is still current 3 hours before its venue-time end", (st, nxt and nxt.get("id")))
st, lst = call("GET", "/public/events")
check(any(e["id"] == 1 for e in (lst or [])), "and still listed")
a = models.Announcement(event_id=1, title="Zz later", body="x", is_published=True, scheduled_for=vnow + timedelta(hours=2))
s.add(a); s.commit()
st, ann = call("GET", "/public/events/1/announcements")
check(not any(x.get("title") == "Zz later" for x in (ann or [])), "an announcement scheduled 2 hours ahead (venue time) is not out yet")
a.scheduled_for = vnow - timedelta(minutes=5); s.commit()
st, ann = call("GET", "/public/events/1/announcements")
check(any(x.get("title") == "Zz later" for x in (ann or [])), "and appears once its venue time has passed")
st, caps = call("GET", "/events/1/my-capabilities", DESK)
check((caps or {}).get("may", {}).get("door_settings") is False, "the desk is told it cannot change door settings")
print("\n%d failed" % len(fails)); sys.exit(1 if fails else 0)
