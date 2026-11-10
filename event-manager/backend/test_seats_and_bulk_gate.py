# -*- coding: utf-8 -*-
"""A BOOKING NEVER GETS MORE BADGES THAN IT PAID FOR, AND NO BULK EMAIL GOES OUT
WITH A TICKET WRONG OR MISSING (7 Nov 2026).

  1. Party seats: two desks naming the last free seat of one booking at the
     same instant both created a badge (Codex seat-race). Seat naming now takes
     the database write lock and recounts before it creates anything.
  2. Pre-send gate: POST /internal/ticket-delivery/preflight checks a bulk list
     against live data and reports CRITICAL findings that block the send:
     duplicate badges / QR codes, wrong holder, a booking that would get fewer
     tickets than it paid for (Babak: "how many tickets they bought, that many
     they will get in the email"), a paid ticket nobody accounts for, and a
     pass type or text that is not true any more.

Synthetic attendees on a testbed copy only (example.invalid).
Run:  python3 /root/event/backend/test_seats_and_bulk_gate.py
"""
import json, secrets, sqlite3, sys, threading, urllib.error, urllib.request
from datetime import datetime

HERE = "/root/event/backend"
sys.path.insert(0, HERE)
import testbed
BASE, DB = testbed.start()
import main                                                    # noqa: E402

env = {}
for line in open(HERE + "/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
SVC = {"Authorization": "Bearer " + env["IDENTITY_SERVICE_TOKEN"]}
ADMIN = {"Authorization": "Bearer " + main.create_access_token({"sub": "1", "adm": True})}
# The desks are door staff (10 Nov 2026: an admin's seat goes to a second
# admin for approval; naming a paid seat at the desk stays a door action).
import sqlite3 as _sq
_c = _sq.connect(DB, timeout=60)
DESK_ID = _c.execute("insert into users(email,hashed_password,full_name,is_admin,created_at) values('zz-desk-seats@example.invalid','x','ZZ Desk',0,datetime('now'))").lastrowid
_c.execute("insert into event_roles(user_id,event_id,role,created_at) values(?,1,'checkin_staff',datetime('now'))", (DESK_ID,))
_c.commit(); _c.close()
DESK = {"Authorization": "Bearer " + main.create_access_token({"sub": str(DESK_ID)})}
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, headers=ADMIN, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b

db = sqlite3.connect(DB, timeout=30)
EV, TAG = 1, secrets.token_hex(3)
now = datetime.utcnow().isoformat(" ")
ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
existing = dict(db.execute("select id, coalesce(qr_code,'')||'|'||coalesce(public_token,'')||'|'||coalesce(email,'') from attendees").fetchall())
pay_before = db.execute("select count(*), coalesce(sum(amount),0), group_concat(status) from payment_events").fetchone()

def buyer(who, quantity=1, ticket_type=7):
    email = "zz-%s-%s@example.invalid" % (who, TAG)
    cd = {"entitlements": [{"status": "paid", "quantity": quantity, "ticket_type_id": ticket_type, "is_upgrade": False}]}
    cur = db.execute("insert into attendees(event_id,email,first_name,last_name,qr_code,is_checked_in,registration_status,created_at,"
                     "ticket_type_id,public_token,custom_data,badge_print_count,registration_source,attendance_type) "
                     "values(?,?,?,?,?,0,'registered',?,?,?,?,0,'ghl_order','paid')",
                     (EV, email, "Zz", who, "ATT-" + secrets.token_hex(6).upper(), now, ticket_type,
                      "".join(secrets.choice(ALPHA) for _ in range(8)), json.dumps(cd)))
    db.commit()
    return cur.lastrowid, email

def row(aid):
    r = db.execute("select id,email,qr_code,public_token,ticket_type_id from attendees where id=?", (aid,)).fetchone()
    return {"id": r[0], "email": r[1], "qr": r[2], "token": r[3], "tt": r[4]}

print("\n== 1. naming the last free seat is atomic ==")
b1, _ = buyer("seat-race", quantity=2)
res = []
def name_seat(i):
    res.append(call("POST", "/events/%d/attendees/%d/add-seat" % (EV, b1), {"first_name": "Zz", "last_name": "Desk%d" % i, "reason": "synthetic race"}, DESK)[0])
ts = [threading.Thread(target=name_seat, args=(i,)) for i in range(8)]
[t.start() for t in ts]; [t.join() for t in ts]
seats = db.execute("select count(*) from attendees where json_extract(custom_data,'$.bought_by_attendee')=?", (b1,)).fetchone()[0]
check(sorted(res).count(200) == 1 and sorted(res).count(409) == 7,
      "8 desks naming the last seat of a 2-ticket booking at once: one succeeds, seven are refused", sorted(res))
check(seats == 1, "the booking has exactly the badges it paid for (buyer + 1 seat)", seats)
st, _ = call("POST", "/events/%d/attendees/%d/add-seat" % (EV, b1), {"first_name": "Zz", "last_name": "Late"}, DESK)
check(st == 409, "a full booking refuses another seat", st)

b3, _ = buyer("seat-three", quantity=3)
res = []
def name3(i):
    res.append(call("POST", "/events/%d/attendees/%d/add-seat" % (EV, b3), {"first_name": "Zz", "last_name": "Three%d" % i}, DESK)[0])
ts = [threading.Thread(target=name3, args=(i,)) for i in range(6)]
[t.start() for t in ts]; [t.join() for t in ts]
n3 = db.execute("select count(*) from attendees where json_extract(custom_data,'$.bought_by_attendee')=?", (b3,)).fetchone()[0]
check(res.count(200) == 2 and n3 == 2, "a 3-ticket booking with 2 free seats: exactly two of six desks succeed", (sorted(res), n3))

# The same overlap forced deterministically, Codex style: every request has
# already read "1 free seat" before any of them writes.
import models                                                  # noqa: E402
from database import SessionLocal                              # noqa: E402
b5, _ = buyer("seat-barrier", quantity=2)
original = main._party_members
barrier = threading.Barrier(5)
local = threading.local()
def controlled(dbs, att):
    p = original(dbs, att)
    if not getattr(local, "seen", False):
        local.seen = True
        try: barrier.wait(timeout=10)
        except threading.BrokenBarrierError: pass
    return p
main._party_members = controlled
outcomes = []
def direct(i):
    s = SessionLocal()
    try:
        main.add_party_seat(EV, b5, main.schemas.AddPartySeat(first_name="Zz", last_name="Barrier%d" % i), s, s.get(models.User, DESK_ID))
        outcomes.append("ok")
    except Exception as ex:
        s.rollback(); outcomes.append(type(ex).__name__)
    finally:
        s.close()
ts = [threading.Thread(target=direct, args=(i,)) for i in range(5)]
[t.start() for t in ts]; [t.join() for t in ts]
main._party_members = original
n5 = db.execute("select count(*) from attendees where json_extract(custom_data,'$.bought_by_attendee')=?", (b5,)).fetchone()[0]
check(outcomes.count("ok") == 1 and n5 == 1, "all five desks past the count before any writes: still exactly one seat", (outcomes, n5))

print("\n== 2. the bulk pre-send gate ==")
live_ids = [r[0] for r in db.execute("select id from attendees where event_id=? and lower(coalesce(registration_status,'registered')) "
                                     "not in ('refunded','cancelled','canceled','revoked','void','withdrawn')", (EV,))]
def order(oid, recipient, *aids, over=None):
    over = over or {}
    tickets = []
    for a in aids:
        r = row(a)
        t = {"ticket_id": a, "qr": r["qr"], "token": r["token"], "ticket_type_id": r["tt"]}
        t.update(over.get(a, {}))
        tickets.append(t)
    return {"order_id": oid, "recipient": recipient, "tickets": tickets, "event": {"id": EV}}

def gate(orders, delivered=(), extra_holds=None, holds_all_but=()):
    holds = {str(i): "synthetic: other ticket" for i in live_ids if i not in holds_all_but}
    holds.update(extra_holds or {})
    return call("POST", "/internal/ticket-delivery/preflight",
                {"event_id": EV, "orders": orders, "delivered_ticket_ids": list(delivered), "holds": holds}, headers=SVC)

def codes(g):
    return sorted({x["code"] for x in (g or {}).get("critical", [])})

st, _ = call("POST", "/internal/ticket-delivery/preflight", {"event_id": EV, "orders": []}, headers={})
check(st in (401, 403), "the gate needs the service token", st)

solo, solo_email = buyer("gate-solo")
st, g = gate([order("ZZ-1", solo_email, solo)], holds_all_but=[solo])
check(st == 200 and g.get("ok") is True and not g["critical"], "a correct one-ticket email passes", (st, g.get("critical")))

pb, pb_email = buyer("gate-party", quantity=3)
s1 = call("POST", "/events/%d/attendees/%d/add-seat" % (EV, pb), {"first_name": "Zz", "last_name": "Guest1"}, DESK)[1]["attendee_id"]
s2 = call("POST", "/events/%d/attendees/%d/add-seat" % (EV, pb), {"first_name": "Zz", "last_name": "Guest2"}, DESK)[1]["attendee_id"]
live_ids = live_ids + [solo, pb, s1, s2, b1, b3, b5]
st, g = gate([order("ZZ-P", pb_email, pb, s1, s2)], holds_all_but=[pb, s1, s2])
check(g.get("ok") is True, "a 3-ticket booking with all 3 tickets in the buyer's email passes", g.get("critical"))
st, g = gate([order("ZZ-P", pb_email, pb, s1)], holds_all_but=[pb, s1, s2])
short = [x for x in g.get("critical", []) if x["code"] == "MISSING_TICKETS" and x.get("paid_for") == 3]
check(not g.get("ok") and short and short[0]["emailed"] == 2,
      "BLOCK: a 3-ticket booking whose email would carry 2", g.get("critical"))
st, g = gate([order("ZZ-P1", pb_email, pb), order("ZZ-P2", pb_email, s1, s2)], holds_all_but=[pb, s1, s2])
check(g.get("ok") is True, "the same booking split over two emails, all 3 tickets: passes", g.get("critical"))
st, g = gate([order("ZZ-P2", pb_email, s1, s2)], delivered=[pb], holds_all_but=[pb, s1, s2])
check(g.get("ok") is True, "buyer's ticket already delivered + the 2 seats now: passes", g.get("critical"))

nb, nb_email = buyer("gate-unissued", quantity=2)
live_ids.append(nb)
st, g = gate([order("ZZ-N", nb_email, nb)], holds_all_but=[nb])
miss = [x for x in g.get("critical", []) if x["code"] == "MISSING_TICKETS"]
check(miss and miss[0].get("not_issued") == 1, "BLOCK: a 2-ticket booking whose second seat was never issued", g.get("critical"))

st, g = gate([order("ZZ-1", "someone-else-%s@example.invalid" % TAG, solo)], holds_all_but=[solo])
check("WRONG_HOLDER" in codes(g), "BLOCK: email to someone who does not hold the ticket", codes(g))
st, g = gate([order("ZZ-P", pb_email, pb, s1, s2)], holds_all_but=[pb, s1, s2])
check(g.get("ok") is True, "a guest seat goes to its paying buyer (stored under +seat): passes", g.get("critical"))
st, g = gate([order("ZZ-1", solo_email, solo, over={solo: {"qr": "ATT-NOTTHEONE"}})], holds_all_but=[solo])
check("WRONG_HOLDER" in codes(g), "BLOCK: the QR code in the list is not the ticket's own", codes(g))
st, g = gate([order("ZZ-1", solo_email, solo, over={solo: {"ticket_type_id": 9999}})], holds_all_but=[solo])
check("CATEGORY_MISMATCH" in codes(g), "BLOCK: pass type in the email differs from the ticket", codes(g))
st, g = gate([order("ZZ-1", solo_email, solo, over={solo: {"current_pass": "VIP Everything"}})], holds_all_but=[solo])
check("CATEGORY_MISMATCH" in codes(g), "BLOCK: pass text in the email is not what the ticket grants", codes(g))
st, g = gate([order("ZZ-1", solo_email, solo), order("ZZ-1b", solo_email, solo)], holds_all_but=[solo])
check("DUPLICATE_QR" in codes(g), "BLOCK: one ticket in two emails", codes(g))
st, g = gate([order("ZZ-1", solo_email, solo)], delivered=[solo], holds_all_but=[solo])
check("DUPLICATE_QR" in codes(g), "BLOCK: a ticket that was already delivered", codes(g))

rv, rv_email = buyer("gate-revoked")
db.execute("update attendees set registration_status='revoked' where id=?", (rv,)); db.commit()
st, g = gate([order("ZZ-R", rv_email, rv)], holds_all_but=[])
check("WRONG_HOLDER" in codes(g), "BLOCK: a revoked ticket", codes(g))

d1, d1_email = buyer("gate-dup-a"); d2, _ = buyer("gate-dup-b")
db.execute("update attendees set public_token=(select public_token from attendees where id=?) where id=?", (d1, d2)); db.commit()
live_ids += [d1, d2]
st, g = gate([order("ZZ-D", d1_email, d1)], holds_all_but=[d1])
check("DUPLICATE_BADGE" in codes(g), "BLOCK: two live tickets share one badge identity", codes(g))
db.execute("update attendees set public_token=? where id=?", ("".join(secrets.choice(ALPHA) for _ in range(8)), d2)); db.commit()

orphan, _ = buyer("gate-orphan")
live_ids.append(orphan)
st, g = gate([order("ZZ-1", solo_email, solo)], holds_all_but=[solo, orphan])
check(any(x["code"] == "MISSING_TICKETS" and orphan in x["ticket_ids"] for x in g.get("critical", [])),
      "BLOCK: a paid ticket in no email, not delivered and not on the hold list", g.get("critical"))
st, g = gate([order("ZZ-1", solo_email, solo)], holds_all_but=[solo], extra_holds={str(orphan): "synthetic: buyer email changed"})
check(g.get("ok") is True and any(x["code"] == "HELD" and orphan in x["ticket_ids"] for x in g["warnings"]),
      "the same ticket on the recorded hold list: passes, reported as HELD", (g.get("critical"), [w["code"] for w in g.get("warnings", [])]))

print("\n== nothing that existed before the suite changed ==")
after = dict(db.execute("select id, coalesce(qr_code,'')||'|'||coalesce(public_token,'')||'|'||coalesce(email,'') from attendees").fetchall())
check(not [i for i, v in existing.items() if after.get(i) != v], "every pre-existing ticket keeps its QR, badge and holder", None)
check(db.execute("select count(*), coalesce(sum(amount),0), group_concat(status) from payment_events").fetchone() == pay_before,
      "payment records untouched", None)

print("\n%d check(s) failed" % len(fails) if fails else "\nALL CHECKS PASSED")
sys.exit(1 if fails else 0)
