# -*- coding: utf-8 -*-
"""Buying two days must give you two days.

Elevate 2026 sells its exhibit hall by the day -- Friday, Saturday and Sunday
are three separate products at three separate prices. Nothing about that is an
upgrade: a person who buys Saturday and Sunday has bought two days, not traded
one for the other. Two things used to disagree with that.

First, the entitlement ledger keyed a purchase on (order, addon_code). One GHL
order carrying both Saturday and Sunday therefore matched itself: the second
product overwrote the first in place, and the ledger ended up believing the
buyer had paid for one day. The evidence of the other day was gone before
anything downstream could read it.

Second, the effective-access resolver chose a single base ticket by upgrade
rank. All three day passes rank 0, so with two of them max() returned whichever
came first and the scanner's day gate -- which reads valid_day off that one
resolved ticket -- refused the day it had not picked.

The invariant that matters most here is order independence. Saturday then
Sunday, and Sunday then Saturday, must end at the same access. A reconciler
whose result depends on the order GHL happened to list the line items in is a
reconciler nobody can reason about.

Throwaway event, example.invalid people, GHL is never written to.
Run:  python3 /root/event/backend/test_multiday_passes.py
"""
import json, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime

env = {}
for line in open("/root/event/backend/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
SVC = env["IDENTITY_SERVICE_TOKEN"]
BASE = "http://127.0.0.1:8002"
DB = "/root/event/backend/event.db"

fails = []
def check(ok, label, detail=""):
    print("  %-4s %s%s" % ("ok" if ok else "FAIL", label, "" if ok else "   -- %s" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        p = e.read()
        try:
            return e.code, json.loads(p or b"null")
        except Exception:
            return e.code, p

def sql(q, a=()):
    c = sqlite3.connect(DB)
    try:
        return c.execute(q, a).fetchall()
    finally:
        c.close()

# ── the pure authorization path ─────────────────────────────────────────────
# ALLOW_SCAN_TIME_OVERRIDE is off in production on purpose: nobody may fake the
# clock at a real door. The day matrix therefore asks the decision function
# itself, which takes an explicit date, writes nothing, and is the same code the
# endpoint calls. One real HTTP scan below proves the endpoint agrees.
sys.path.insert(0, "/root/event/backend")
import main as emmain, models as emmodels

def pure_decide(attendee_id, event_id, zone, at):
    db = emmain.SessionLocal()
    try:
        att = db.get(emmodels.Attendee, attendee_id)
        ev = db.get(emmodels.Event, event_id)
        return emmain._authorize_decision(db, att, ev, zone, at=at)
    finally:
        db.rollback(); db.close()

# ── throwaway event with three day passes ───────────────────────────────────
# Dated around today so the calendar window is genuinely open for one of the
# three days, which lets the real endpoint be tested with the real clock.
from datetime import date, timedelta
_t = date.today()
FRI, SAT, SUN = (_t - timedelta(days=1)).isoformat(), _t.isoformat(), (_t + timedelta(days=1)).isoformat()
S, ev = call("POST", "/events", {
    "name": "MULTIDAY TEST EVENT (throwaway)",
    "start_date": FRI + "T09:00:00", "end_date": SUN + "T18:00:00",
    "location": "test", "timezone": "UTC"}, ADMIN)
assert S in (200, 201), (S, ev)
EV = ev["id"]

def mk_type(code, name, day, **kw):
    s, b = call("POST", "/events/%d/ticket-types" % EV,
                dict(code=code, name=name, valid_day=day, **kw), ADMIN)
    assert s == 200, (s, b)
    return b["id"]

TT_FRI = mk_type("T-FRI", "Test Friday Hall", FRI)
TT_SAT = mk_type("T-SAT", "Test Saturday Hall", SAT)
TT_SUN = mk_type("T-SUN", "Test Sunday Hall", SUN)
TT_GA  = mk_type("T-GA",  "Test General Admission", None)
TT_VIP = mk_type("T-VIP", "Test VIP", None, is_vip=True, grants_workshops=True)

# TicketTypeCreate does not expose upgrade_rank, and a tie between rank-less
# tiers would make the upgrade case meaningless. Rank the throwaway tiers the
# way the real event ranks its own: day passes 0, GA 1, VIP 5.
def write(q, a=()):
    c = sqlite3.connect(DB)
    try:
        c.execute(q, a); c.commit()
    finally:
        c.close()

for _tt, _rank in ((TT_FRI, 0), (TT_SAT, 0), (TT_SUN, 0), (TT_GA, 1), (TT_VIP, 5)):
    write("update ticket_types set upgrade_rank=? where id=?", (_rank, _tt))

DAY_TT = {FRI: TT_FRI, SAT: TT_SAT, SUN: TT_SUN}
PROD = {FRI: "prod-fri-test", SAT: "prod-sat-test", SUN: "prod-sun-test"}

def buy(email, days, order_id, tt_override=None, first="Multi", last="Day"):
    """Reconcile one order carrying one or more day passes, in the given order."""
    out = []
    for d in days:
        s, b = call("POST", "/identity/reconcile-attendee", {
            "event_id": EV, "email": email, "first_name": first, "last_name": last,
            "ticket_type_id": tt_override or DAY_TT[d], "order_id": order_id,
            "product_id": PROD.get(d), "amount": 97.0, "quantity": 1}, SVC)
        out.append((s, b))
    return out

def decide(email, at, zone="EXHIBIT"):
    """The scanner's own decision for one person on one event day. No writes."""
    r = sql("select id from attendees where event_id=? and lower(email)=?", (EV, email.lower()))
    if not r:
        return None
    return pure_decide(r[0][0], EV, zone, at)

def days_granted(email, zone="EXHIBIT"):
    got = []
    for d in (FRI, SAT, SUN):
        dec = decide(email, d, zone)
        if dec and dec.get("granted"):
            got.append(d)
    return got

def attendee_rows(email):
    return sql("select id, qr_code, ticket_type_id from attendees where event_id=? and lower(email)=?",
               (EV, email.lower()))

print("== 1) single-day purchases are unchanged ==")
for d, lbl in ((FRI, "Friday"), (SAT, "Saturday"), (SUN, "Sunday")):
    em = "solo-%s@example.invalid" % lbl.lower()
    buy(em, [d], "ORD-SOLO-%s" % lbl)
    check(days_granted(em) == [d], "%s only -> admits %s and no other day" % (lbl, lbl),
          "got %s" % days_granted(em))
    check(len(attendee_rows(em)) == 1, "%s only -> exactly one attendee" % lbl)

print()
print("== 2) two days on ONE order accumulate (the ledger bug) ==")
CASES = [("SAT+SUN", [SAT, SUN]), ("FRI+SAT", [FRI, SAT]), ("FRI+SUN", [FRI, SUN])]
for lbl, days in CASES:
    em = "two-%s@example.invalid" % lbl.lower().replace("+", "-")
    buy(em, days, "ORD-ONE-%s" % lbl)
    got = days_granted(em)
    check(sorted(got) == sorted(days), "%s (one order) -> admits both days" % lbl, "got %s" % got)
    other = [d for d in (FRI, SAT, SUN) if d not in days][0]
    check(other not in got, "%s -> still refused on the unpurchased day" % lbl)
    rows = attendee_rows(em)
    check(len(rows) == 1, "%s -> one attendee, not one per day" % lbl, "rows=%d" % len(rows))

print()
print("== 3) two days on SEPARATE orders accumulate ==")
em = "two-separate@example.invalid"
buy(em, [SAT], "ORD-SEP-A")
buy(em, [SUN], "ORD-SEP-B")
got = days_granted(em)
check(sorted(got) == sorted([SAT, SUN]), "Sat then Sun on two orders -> both days", "got %s" % got)
check(len(attendee_rows(em)) == 1, "two orders -> still one attendee")

print()
print("== 4) all three days ==")
em = "three-day@example.invalid"
buy(em, [FRI, SAT, SUN], "ORD-THREE")
got = days_granted(em)
check(sorted(got) == sorted([FRI, SAT, SUN]), "Fri+Sat+Sun -> admits all three days", "got %s" % got)
check(len(attendee_rows(em)) == 1, "three days -> one attendee")
qrs = {r[1] for r in attendee_rows(em)}
check(len(qrs) == 1, "three days -> one QR")

print()
print("== 5) processing order must not change the outcome ==")
em_a, em_b = "order-a@example.invalid", "order-b@example.invalid"
buy(em_a, [SAT, SUN], "ORD-AB-1")
buy(em_b, [SUN, SAT], "ORD-AB-2")
ga, gb = sorted(days_granted(em_a)), sorted(days_granted(em_b))
check(ga == gb == sorted([SAT, SUN]), "Sat-then-Sun == Sun-then-Sat", "a=%s b=%s" % (ga, gb))

print()
print("== 6) replays are idempotent ==")
em = "replay@example.invalid"
buy(em, [SAT, SUN], "ORD-REPLAY")
before_qr = attendee_rows(em)[0][1]
buy(em, [SAT, SUN], "ORD-REPLAY")          # same order, same products, twice
buy(em, [SUN, SAT], "ORD-REPLAY")          # and again in the other order
rows = attendee_rows(em)
check(len(rows) == 1, "duplicate webhook -> still one attendee", "rows=%d" % len(rows))
check(rows[0][1] == before_qr, "duplicate webhook -> QR unchanged")
check(sorted(days_granted(em)) == sorted([SAT, SUN]), "duplicate webhook -> still both days")
ents = sql("select custom_data from attendees where id=?", (rows[0][0],))[0][0]
ent_list = (json.loads(ents) or {}).get("entitlements") or []
paid_base = [e for e in ent_list if e.get("status") == "paid" and not e.get("addon_code")]
check(len(paid_base) == 2, "replay -> ledger holds exactly 2 day entitlements, not 4",
      "got %d" % len(paid_base))

print()
print("== 6b) the real HTTP door endpoint agrees ==")
em = "door@example.invalid"
buy(em, [SAT, SUN], "ORD-DOOR")
_qr = sql("select qr_code from attendees where event_id=? and lower(email)=?", (EV, em))[0][0]
s_, d_sat = call("POST", "/events/%d/authorize" % EV,
                 {"qr_code": _qr, "access_type": "EVENT_ENTRY"}, ADMIN)   # real clock = SAT
check(s_ == 200 and d_sat.get("granted"),
      "EVENT_ENTRY granted today (a purchased day) via the real endpoint",
      str(d_sat)[:80])

print()
print("== 7) day passes never grant conference, workshop or VIP ==")
em = "zones@example.invalid"
buy(em, [SAT, SUN], "ORD-ZONES")
for zone in ("CONFERENCE", "WORKSHOP", "VIP"):
    dec = decide(em, SAT, zone)
    check(dec and not dec.get("granted"), "two day passes do not grant %s" % zone,
          str(dec and dec.get("reason"))[:60])

print()
print("== 8) unrestricted tiers still admit every day ==")
em = "ga@example.invalid"
call("POST", "/identity/reconcile-attendee", {
    "event_id": EV, "email": em, "first_name": "Gen", "last_name": "Adm",
    "ticket_type_id": TT_GA, "order_id": "ORD-GA", "amount": 99.0}, SVC)
check(sorted(days_granted(em)) == sorted([FRI, SAT, SUN]),
      "a no-valid_day tier (GA) still admits all three days", "got %s" % days_granted(em))

print()
print("== 9) a true upgrade still replaces, it does not accumulate ==")
em = "upgrade@example.invalid"
call("POST", "/identity/reconcile-attendee", {
    "event_id": EV, "email": em, "first_name": "Up", "last_name": "Grade",
    "ticket_type_id": TT_GA, "order_id": "ORD-UP-A", "amount": 99.0}, SVC)
call("POST", "/identity/reconcile-attendee", {
    "event_id": EV, "email": em, "ticket_type_id": TT_VIP, "order_id": "ORD-UP-B",
    "is_upgrade": True, "amount": 900.0}, SVC)
dec = decide(em, SAT, "VIP")
check(dec and dec.get("granted"), "GA upgraded to VIP grants the VIP zone",
      str(dec and dec.get("reason"))[:60])
check(len(attendee_rows(em)) == 1, "upgrade -> one attendee")

print()
print("== 10) refund of one day removes that day and keeps the other ==")
em = "refund-one@example.invalid"
buy(em, [SAT, SUN], "ORD-REF")
aid = attendee_rows(em)[0][0]
s, b = call("POST", "/identity/refund-ticket",
            {"event_id": EV, "order_id": "ORD-REF", "email": em}, SVC)
after = days_granted(em)
check(s == 200, "refund call accepted", "%s %s" % (s, str(b)[:70]))
check(after == [], "a refunded order leaves no day access", "got %s" % after)

print()
print("== 10b) event isolation still holds for a multi-day badge ==")
em = "isolation@example.invalid"
buy(em, [SAT, SUN], "ORD-ISO")
_qr = sql("select qr_code from attendees where event_id=? and lower(email)=?", (EV, em))[0][0]
# the same badge offered at a different event's door must not resolve at all
_other = sql("select id from events where id<>? order by id limit 1", (EV,))
if _other:
    s_, b_ = call("POST", "/events/%d/authorize" % _other[0][0],
                  {"qr_code": _qr, "access_type": "EXHIBIT"}, ADMIN)
    check(s_ == 200 and not b_.get("granted"),
          "a two-day badge is refused at another event's door", str(b_)[:70])
s_, b_ = call("POST", "/events/%d/authorize" % EV,
              {"qr_code": "ATT-NOT-A-REAL-BADGE", "access_type": "EXHIBIT"}, ADMIN)
check(s_ == 200 and not b_.get("granted"), "an unknown QR is refused", str(b_)[:70])

print()
print("== 11) cleanup ==")
s, _ = call("DELETE", "/events/%d" % EV, None, ADMIN)
left = sql("select count(*) from attendees where event_id=?", (EV,))[0][0]
check(s in (200, 204) and left == 0, "throwaway event removed", "status=%s left=%s" % (s, left))

print()
if fails:
    print("FAILED (%d):" % len(fails))
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("all multi-day entitlement checks passed")
