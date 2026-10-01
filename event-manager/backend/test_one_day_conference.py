# -*- coding: utf-8 -*-
"""ONE DAY OF YOUR CHOOSING

GoHighLevel's own description of the $97 product is "access to ONE DAY OF YOUR
CHOOSING to attend the speaker's presentation". It was mapped to the full
General Admission + Conference tier, which is three days, so twenty-seven
people held two days they never paid for and nobody could see it: the badge,
the door and the panel all agreed, and all three were wrong together.

The machinery for doing it properly already existed and nothing used it -- the
ONE_DAY_CONFERENCE add-on, a door that grants it on the chosen day and refuses
it on any other, a day picker on the Manage dialog. What was missing was the
mapping saying the product IS that add-on, and the grant path reading the
mapping when it said so. Every caller passed the tier and the upgrade flag and
stopped there, so the mapping's answer never arrived.

What is pinned here:

  * the product is mapped as the add-on, and the grant path reads that from the
    mapping rather than needing every caller to repeat it;
  * an add-on never lifts the base tier -- that is the difference between this
    and the $297, and it is the whole bug;
  * before a day is chosen the conference room refuses, and says why rather
    than just saying no;
  * once chosen it admits on that day and refuses on the others;
  * the exhibit hall is unaffected on every day, because that is what the $99
    underneath it bought;
  * the desk may pick a day this event runs and no other.

Runs against its own copy of the database.
Run:  python3 /root/event/backend/test_one_day_conference.py
"""
import json
import sys

sys.path.insert(0, "/root/event/backend")
import os                                                   # noqa: E402
# The conference is weeks away, so proving "admits on Saturday, refuses on
# Sunday" means telling the door which day it is. That override is admin-only
# and off in production by design; the testbed is exactly what it is for.
os.environ["ALLOW_SCAN_TIME_OVERRIDE"] = "1"
import testbed                                              # noqa: E402
BASE, DB = testbed.start()

import sqlite3, urllib.error, urllib.request                # noqa: E402
import main, models                                         # noqa: E402
from sqlalchemy import func                                 # noqa: E402
HERE_ENV = "/root/event/backend/.env"
from database import SessionLocal                           # noqa: E402

EVENT = 1
ADDON = "ONE_DAY_CONFERENCE"
ONE_DAY_PRODUCT = "6890d769862c0cf72f94de51"
ADMIN = {"Authorization": "Bearer " + main.create_access_token({"sub": "1"})}

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

s = SessionLocal()
event = s.query(models.Event).filter(models.Event.id == EVENT).first()
event.door_test_mode = True          # the conference is in November; practise mode
s.commit()
DAYS = main._event_days(event)

print("\nTHE PRODUCT IS MAPPED AS AN ADD-ON")
m = s.query(models.TicketMapping).filter(
    models.TicketMapping.event_id == EVENT,
    models.TicketMapping.external_product_id == ONE_DAY_PRODUCT).first()
check(m is not None and m.addon_code == ADDON,
      "the one-day product grants the add-on, not a tier", m and m.addon_code)

print("\nSOMEBODY WHO BOUGHT IT")
holder = None
for a in s.query(models.Attendee).filter(models.Attendee.event_id == EVENT).all():
    ents = (a.custom_data or {}).get("entitlements") or []
    if any(e.get("addon_code") == ADDON for e in ents):
        holder = a
        break
check(holder is not None, "the roll carries one-day add-on holders")
if holder is None:
    sys.exit(1)
name = ("%s %s" % (holder.first_name or "", holder.last_name or "")).strip()
print("     %s" % name)

# Everybody who bought one day has since been given all three, complimentary.
# That is a decision about this event, not about how a one-day add-on behaves,
# so the rule is tested on a copy with the comp lifted -- otherwise the next
# event to sell one inherits a rule nothing checks any more.
ga = s.query(models.TicketType).filter(
    models.TicketType.event_id == EVENT, models.TicketType.name == "General Admission").first()
comped = (holder.custom_data or {}).get("admin_tier") is not None
if comped:
    _cd = dict(holder.custom_data or {})
    _cd.pop("admin_tier", None)
    holder.custom_data = _cd
    holder.ticket_type_id = ga.id
    s.commit()
    print("     (comp lifted on this copy, to test the add-on rule itself)")

eff = main._effective_access(s, holder)
base = (eff.get("base_ticket") or {}).get("name")
check(base == "General Admission",
      "the add-on did NOT lift their base pass", base)
check(any(x["code"] == ADDON for x in (eff.get("addons") or [])),
      "and it is carried as an add-on", eff.get("addons"))

def door(zone, at=None):
    body = {"qr_code": holder.qr_code, "access_type": zone}
    if at:
        body["at"] = at
    return call("POST", "/events/%d/authorize" % EVENT, body, ADMIN)[1]

print("\nBEFORE A DAY IS CHOSEN")
d = door("CONFERENCE")
check(d.get("granted") is False, "the conference room refuses them", d.get("reason"))
check("day not selected" in (d.get("reason") or "").lower(),
      "  and says why, rather than just no", d.get("reason"))
d = door("EXHIBIT")
check(d.get("granted") is True, "the exhibit hall still admits them — that is the $99 underneath")

print("\nTHE DESK PICKS A DAY")
st, out = call("POST", "/attendees/%d/addon-day" % holder.id,
               {"addon_code": ADDON, "day_label": "Saturday 21 November",
                "day_date": DAYS[1], "reason": "asked at the desk"}, ADMIN)
check(st == 200, "a day this event runs is accepted", (st, out))
st, out = call("POST", "/attendees/%d/addon-day" % holder.id,
               {"addon_code": ADDON, "day_label": "some Tuesday", "day_date": "2027-03-02"}, ADMIN)
check(st == 200, "an organiser may set any date at all", st)
# put it back on the real day
call("POST", "/attendees/%d/addon-day" % holder.id,
     {"addon_code": ADDON, "day_label": "Saturday 21 November", "day_date": DAYS[1]}, ADMIN)

print("\nAFTER IT IS CHOSEN")
for i, day in enumerate(DAYS):
    d = door("CONFERENCE", at=day)
    want = (day == DAYS[1])
    check(d.get("granted") is want,
          "%s: conference %s" % (day, "admits" if want else "refuses"), d.get("reason"))
    e = door("EXHIBIT", at=day)
    check(e.get("granted") is True, "  and the hall admits on %s regardless" % day, e.get("reason"))

print("\nWHAT THE SCREENS SAY")
s.expire_all()
holder = s.query(models.Attendee).filter(models.Attendee.id == holder.id).first()
disp = main._pass_display(s, holder)
inc = main._pass_includes(s, holder, event)
print("     %s" % disp)
print("     %s" % inc)
check("One-Day" in disp, "the pass names the add-on", disp)
# Once a day is chosen the sentence names it, which is more use to the person
# reading it than the words "one day" would be.
check("Saturday 21 November" in inc and "all three days" in inc,
      "and what it includes names the hall days AND their one conference day", inc)

print("\nTHE DESK'S BOUND")
# A door-capability user may pick a day this event runs, and nothing else.
staff = s.query(models.User).filter(models.User.email == "oneday-test@gaiahealers.test").first()
if staff is None:
    staff = models.User(email="oneday-test@gaiahealers.test", hashed_password="x",
                        full_name="Door Staff", is_admin=False)
    s.add(staff); s.flush()
    s.add(models.EventRole(event_id=EVENT, user_id=staff.id, role="checkin_staff"))
    s.commit()
STAFF = {"Authorization": "Bearer " + main.create_access_token({"sub": str(staff.id)})}
st, out = call("POST", "/attendees/%d/addon-day" % holder.id,
               {"addon_code": ADDON, "day_label": "Friday", "day_date": DAYS[0]}, STAFF)
check(st == 200, "the desk can pick a day of this event", (st, out))
st, out = call("POST", "/attendees/%d/addon-day" % holder.id,
               {"addon_code": ADDON, "day_label": "some Tuesday", "day_date": "2027-03-02"}, STAFF)
check(st == 400 and "day this event runs" in str(out),
      "but not a day it does not run", (st, out))

print("\nA COMP TO THE FULL CONFERENCE COVERS THE ADD-ON")
# What the organiser actually decided: give them all three days. The one-day
# purchase stays on the ledger, and stops being displayed, because listing
# "one day, still to be chosen" beside a pass that opens every day reads as a
# restriction that no longer exists.
conf = s.query(models.TicketType).filter(
    models.TicketType.event_id == EVENT,
    models.TicketType.name == "General Admission + Conference").first()
_cd = dict(holder.custom_data or {})
_cd["admin_tier"] = conf.id
holder.custom_data = _cd
holder.ticket_type_id = conf.id
s.commit()
s.expire_all()
holder = s.query(models.Attendee).filter(models.Attendee.id == holder.id).first()
eff = main._effective_access(s, holder)
check((eff.get("base_ticket") or {}).get("name") == "General Admission + Conference",
      "the comp gives them the full conference", eff.get("effective_label"))
check(not eff.get("addons"),
      "and the one-day add-on stops being listed, because the pass covers it", eff.get("addons"))
check(any(e.get("addon_code") == ADDON for e in (holder.custom_data or {}).get("entitlements") or []),
      "but the purchase is still on the ledger \u2014 it is what they paid for")
for day in DAYS:
    d = door("CONFERENCE", at=day)
    check(d.get("granted") is True, "the conference room admits them on %s" % day, d.get("reason"))

print("\nONE ORDER, ARRIVING TWICE")
# The mirror and a replay call the same endpoint, and the later call often
# carries only the ticket type. It cannot re-derive the add-on from a product
# id it was not given, so it used to record the order a SECOND time as a full
# tier -- which is how a $97 purchase became three days, twenty-eight seconds
# after being granted correctly.
env = {}
for line in open(HERE_ENV):
    t = line.strip()
    if "=" in t and not t.startswith("#"):
        k, v = t.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
SVC = {"Authorization": "Bearer " + env["IDENTITY_SERVICE_TOKEN"]}
EM, ORDER = "zz-twice@example.invalid", "zz-order-twice"
st1, _ = call("POST", "/identity/reconcile-attendee",
              {"event_id": EVENT, "email": EM, "first_name": "Twice", "last_name": "Over",
               "order_id": ORDER, "product_id": ONE_DAY_PRODUCT, "ticket_type_id": 7,
               "amount": 97, "purchased_at": "2026-10-01"}, SVC)
st2, _ = call("POST", "/identity/reconcile-attendee",
              {"event_id": EVENT, "email": EM, "first_name": "Twice", "last_name": "Over",
               "order_id": ORDER, "ticket_type_id": 7, "quantity": 1}, SVC)
check(st1 == 200 and st2 == 200, "both calls succeed", (st1, st2))
s.expire_all()
twice = s.query(models.Attendee).filter(
    models.Attendee.event_id == EVENT, func.lower(models.Attendee.email) == EM).first()
ents = (twice.custom_data or {}).get("entitlements") or []
check(len(ents) == 1, "one order leaves one entitlement, not two", [e.get("addon_code") for e in ents])
check(ents and ents[0].get("addon_code") == ADDON,
      "and it is still the add-on after the second call", ents and ents[0].get("addon_code"))
check(twice.ticket_type_id != 7, "the second call did not lift them to the full conference",
      twice.ticket_type_id)

print("\nTHE TRANSACTION DECIDES, NOT THE NAME ON IT")
# What a confirmed transaction BOUGHT is what says whether it is another person.
# An upgrade is an upgrade OF something, so it belongs to whoever holds the
# ticket it upgrades, whatever address the buyer typed that time. A second
# TICKET has no such reading -- it might genuinely be a seat for a friend --
# so the same contact id must NOT merge those.
C = "zz-rule-contact"
_t = call("POST", "/identity/reconcile-attendee",
          {"event_id": EVENT, "email": "zz-rule-a@example.invalid", "first_name": "Rule",
           "last_name": "Ticket", "contact_id": C, "order_id": "zz-rule-ticket",
           "product_id": "69ffab66233a0d773296e989", "ticket_type_id": 8,
           "amount": 104.94, "purchased_at": "2026-10-01"}, SVC)[1]
_u = call("POST", "/identity/reconcile-attendee",
          {"event_id": EVENT, "email": "zz-rule-b@example.invalid", "first_name": "Rule",
           "last_name": "Ticket", "contact_id": C, "order_id": "zz-rule-upgrade",
           "product_id": ONE_DAY_PRODUCT, "ticket_type_id": 7,
           "amount": 97, "purchased_at": "2026-10-01"}, SVC)[1]
check(_u.get("attendee_id") == _t.get("attendee_id"),
      "an upgrade under a different email joins the ticket it upgrades",
      (_t.get("attendee_id"), _u.get("attendee_id")))
check(_u.get("created") is False, "and does not mint a second person")

_f = call("POST", "/identity/reconcile-attendee",
          {"event_id": EVENT, "email": "zz-rule-friend@example.invalid", "first_name": "Rule",
           "last_name": "Friend", "contact_id": C, "order_id": "zz-rule-ticket-2",
           "product_id": "69ffab66233a0d773296e989", "ticket_type_id": 8,
           "amount": 99, "purchased_at": "2026-10-01"}, SVC)[1]
check(_f.get("attendee_id") != _t.get("attendee_id"),
      "but a second TICKET on the same contact stays a separate person \u2014 it may be a friend",
      (_t.get("attendee_id"), _f.get("attendee_id")))

_o = call("POST", "/identity/reconcile-attendee",
          {"event_id": EVENT, "email": "zz-rule-orphan@example.invalid", "first_name": "Rule",
           "last_name": "Orphan", "contact_id": "zz-rule-nobody", "order_id": "zz-rule-orphan",
           "product_id": ONE_DAY_PRODUCT, "ticket_type_id": 7,
           "amount": 97, "purchased_at": "2026-10-01"}, SVC)[1]
s.expire_all()
_orow = s.query(models.Attendee).filter(models.Attendee.id == _o.get("attendee_id")).first()
check((_orow.custom_data or {}).get("needs_identity_review") is True,
      "an upgrade with no ticket under it is flagged, not silently an attendee",
      (_orow.custom_data or {}).get("needs_identity_review"))
check(any(e.get("addon_code") == ADDON for e in ((_orow.custom_data or {}).get("entitlements") or [])),
      "  and the money it represents is still recorded")
check(_orow.ticket_type_id is None, "  with no pass invented for it")

print("\nA DUPLICATE ROW HANDS ITS ORDERS ON")
# Somebody who checks out twice under two email addresses becomes two rows.
# Once one is ruled a duplicate it keeps its email, so orders keep arriving at
# it -- and every sync re-grants the purchase to somebody revoked whose badge
# nobody holds. The duplicate points at the person it IS, and the order follows.
dup = models.Attendee(event_id=EVENT, email="zz-dup@example.invalid",
                      first_name="Dup", last_name="Row", registration_status="revoked",
                      qr_code="ATT-ZZDUPROW01",
                      custom_data={"duplicate_of": twice.id})
s.add(dup); s.commit()
st, _ = call("POST", "/identity/reconcile-attendee",
             {"event_id": EVENT, "email": "zz-dup@example.invalid", "order_id": "zz-order-dup",
              "product_id": ONE_DAY_PRODUCT, "ticket_type_id": 7, "amount": 97,
              "purchased_at": "2026-10-01"}, SVC)
s.expire_all()
dup = s.query(models.Attendee).filter(models.Attendee.id == dup.id).first()
canon = s.query(models.Attendee).filter(models.Attendee.id == twice.id).first()
check(st == 200, "the order is accepted", st)
check(not ((dup.custom_data or {}).get("entitlements") or []),
      "the revoked duplicate is left with nothing",
      (dup.custom_data or {}).get("entitlements"))
check(any(e.get("order_id") == "zz-order-dup"
          for e in ((canon.custom_data or {}).get("entitlements") or [])),
      "and the person it points at got the purchase instead",
      [e.get("order_id") for e in ((canon.custom_data or {}).get("entitlements") or [])])

print("\nNOBODY ELSE MOVED")
lana = s.query(models.Attendee).filter(
    models.Attendee.event_id == EVENT, models.Attendee.first_name == "Lana",
    models.Attendee.last_name == "Warren").first()
if lana is not None:
    d = call("POST", "/events/%d/authorize" % EVENT,
             {"qr_code": lana.qr_code, "access_type": "CONFERENCE"}, ADMIN)[1]
    check(d.get("granted") is True,
          "somebody who also bought a three-day bundle keeps all three days", d.get("reason"))
s.close()

print("\n" + ("ALL GOOD" if not fails else "FAILED: " + "; ".join(fails)))
sys.exit(1 if fails else 0)
