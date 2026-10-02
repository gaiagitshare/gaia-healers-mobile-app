# -*- coding: utf-8 -*-
"""ONE CHARGE TOO MANY, OR ONE TICKET MORE?

Two settled charges on the same account for the same product look identical in
the ledger whether they are two people or one payment taken twice. This event
has both, and they must not be treated the same way:

  * PayPal attempts that appeared to fail and were paid again. Seating these
    hands out a badge for money taken once and inflates the roll.
  * Somebody coming back a week later to buy a ticket for a friend. NOT seating
    these leaves a paid person with no badge to scan.

The rule that separates them is time and amount, and it lives in exactly one
place -- _repeat_kind -- so the money report and the door can never disagree
about the same two payments. Only "a day or more later" becomes a seat. A buyer
who wants several seats at once says so with a quantity on one order, which
needs no guessing at all, and those seats are named at the desk by the person
actually standing there.

Upgrades are never seats, and never were. A day pass bought separately adds a
day to one person rather than inventing a second.

Runs against a COPY. Nothing here touches production.
Run:  python3 /root/event/backend/test_duplicate_vs_second_seat.py
"""
import os, shutil, sys, tempfile, uuid
from datetime import datetime, timedelta

HERE = "/root/event/backend"
COPY = os.path.join(tempfile.mkdtemp(prefix="dupe-seat-"), "event.db")
shutil.copy(HERE + "/event.db", COPY)
os.environ["DATABASE_URL"] = "sqlite:///" + COPY
sys.path.insert(0, HERE)

import importlib, database                                   # noqa: E402
importlib.reload(database)
import main, models, schemas                                 # noqa: E402
from database import SessionLocal                            # noqa: E402

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

db = SessionLocal()

# ── a throwaway event, so none of this is visible to the real roll ─────────
ev = models.Event(name="zz-dupe-seat-%s" % uuid.uuid4().hex[:6],
                  start_date=datetime(2026, 11, 20), end_date=datetime(2026, 11, 22))
db.add(ev); db.flush()
tt = models.TicketType(event_id=ev.id, code="ZZBASE", name="zz Base")
up = models.TicketType(event_id=ev.id, code="ZZVIP", name="zz VIP", is_vip=True)
db.add_all([tt, up]); db.flush()
P_BASE, P_UP = "zz-dsp-base", "zz-dsp-up"
db.add_all([
    models.TicketMapping(event_id=ev.id, external_product_id=P_BASE, ticket_type_id=tt.id,
                         is_upgrade=False, entitlement_type="EVENT_TICKET", is_active=True),
    models.TicketMapping(event_id=ev.id, external_product_id=P_UP, ticket_type_id=up.id,
                         is_upgrade=True, entitlement_type="EVENT_UPGRADE", is_active=True)])
db.commit()

T0 = datetime(2026, 6, 1, 10, 0, 0)
def at(mins):
    return (T0 + timedelta(minutes=mins)).isoformat()

def buy(email, order, when, amount=99.0, qty=1, upgrade=False, first="Zz", last="Tester", day=None):
    return main.reconcile_attendee(schemas.ReconcileAttendee(
        event_id=ev.id, email=email, ticket_type_id=(up.id if upgrade else tt.id),
        product_id=(P_UP if upgrade else P_BASE), order_id=order, amount=amount,
        quantity=qty, purchased_at=when, is_upgrade=upgrade,
        first_name=first, last_name=last, day=day), db=db, _=True)

def roll(email_like):
    return db.query(models.Attendee).filter(
        models.Attendee.event_id == ev.id,
        models.Attendee.email.like(email_like)).all()

def seats_of(email_like):
    return [a for a in roll(email_like)
            if (a.custom_data or {}).get("registration_source") == "reconciled_seat"
            or a.registration_source == "reconciled_seat"]

print("\n== 1) PayPal: the attempt that looked like it failed ==")
# The retry is three minutes later for the same amount. This is the shape of a
# duplicate, not of a friend's ticket.
E1 = "zz-dsp-paypal@example.invalid"
buy(E1, "zz-pp-1", T0.isoformat())
r = buy(E1, "zz-pp-2", at(3))
check(len(roll("zz-dsp-paypal%")) == 1,
      "a charge repeated three minutes later does NOT become a second badge",
      [(a.id, a.email, a.registration_source) for a in roll("zz-dsp-paypal%")])
check(not seats_of("zz-dsp-paypal%"), "and no seat row is invented for it", r)

m = main._tm_metrics(db, ev.id) if hasattr(main, "_tm_metrics") else None

print("\n== 2) but the money is still put in front of a human ==")
# Not seating it must not mean not noticing it. A charge taken twice is a refund
# somebody has to make, so it has to appear in the review list.
kind, gap = main._repeat_kind({"amount": 99.0, "purchased_at": T0.isoformat()},
                              {"amount": 99.0, "purchased_at": at(3)})
check(kind == "duplicate_suspected", "the pair reads as a suspected duplicate", (kind, gap))
check(round(gap, 1) == 3.0, "and the gap between the two charges is recorded", gap)

print("\n== 3) a ticket for a friend, bought a week later ==")
E2 = "zz-dsp-friend@example.invalid"
buy(E2, "zz-fr-1", T0.isoformat())
r2 = buy(E2, "zz-fr-2", at(60 * 24 * 7))
rows = roll("zz-dsp-friend%")
check(len(rows) == 2, "a second ticket a week later DOES become its own badge",
      [(a.id, a.email, a.registration_source) for a in rows])
seat = next((a for a in rows if a.registration_source == "reconciled_seat"), None)
check(seat is not None and seat.qr_code and seat.qr_code.startswith("ATT-"),
      "the new badge has its own QR, so it can be scanned on its own",
      seat and seat.qr_code)
check(seat is not None and (seat.custom_data or {}).get("needs_name_check") is True,
      "and it says the name on it still has to be confirmed",
      seat and (seat.custom_data or {}))
check(seat is not None and (seat.custom_data or {}).get("from_order") == "zz-fr-2",
      "and it records which transaction paid for it", seat and (seat.custom_data or {}))

print("\n== 4) replaying that week-later order changes nothing ==")
r3 = buy(E2, "zz-fr-2", at(60 * 24 * 7))
check(len(roll("zz-dsp-friend%")) == 2, "a replay does not add a third badge",
      [(a.id, a.email) for a in roll("zz-dsp-friend%")])
check(isinstance(r3, dict) and r3.get("created") is False,
      "and it reports that it created nothing", r3)

print("\n== 4b) the PayPal charge that sat pending for a week ==")
# The hard one. The customer paid, it did not go through, they paid again and got
# in. A week later the first charge settles. The gap rule alone reads that as a
# separate decision to buy, which would hand one person a second badge for a
# ticket they bought once -- so an unsettled charge for the same amount on the
# same account is read as the thing now settling.
E2b = "zz-dsp-stuck@example.invalid"
buy(E2b, "zz-st-1", T0.isoformat())
_b = roll("zz-dsp-stuck%")[0]
db.add(models.PaymentEvent(event_id=ev.id, attendee_id=_b.id, amount=99.0,
                           status="pending", occurred_at=T0,
                           provider="paypal", ghl_transaction_id="zz-st-pending"))
db.commit()
buy(E2b, "zz-st-2", at(60 * 24 * 7))
check(len(roll("zz-dsp-stuck%")) == 1,
      "a stuck charge settling a week later does NOT become a second badge",
      [(a.id, a.email, a.registration_source) for a in roll("zz-dsp-stuck%")])
_lc = [l for l in ((_b.custom_data or {}).get("lifecycle") or [])
       if l.get("action") == "second_ticket_held_for_review"]
check(len(_lc) == 1, "and the reason it was held is written on the record", _lc)

print("\n== 4c) but a clean account still gets its second seat ==")
# Same timing, no unsettled charge anywhere. This must still seat, or the guard
# above would have quietly switched the rule off for everybody.
E2c = "zz-dsp-clean@example.invalid"
buy(E2c, "zz-cl-1", T0.isoformat())
buy(E2c, "zz-cl-2", at(60 * 24 * 7))
check(len(roll("zz-dsp-clean%")) == 2,
      "a second ticket on an account with no stuck charge still becomes a badge",
      [(a.id, a.email, a.registration_source) for a in roll("zz-dsp-clean%")])

print("\n== 5) an upgrade is never a seat, however it is paid ==")
E3 = "zz-dsp-upgrade@example.invalid"
buy(E3, "zz-up-1", T0.isoformat())
buy(E3, "zz-up-2", at(60 * 24 * 9), amount=200.0, upgrade=True)
check(len(roll("zz-dsp-upgrade%")) == 1,
      "an upgrade nine days later adds no badge",
      [(a.id, a.email, a.registration_source) for a in roll("zz-dsp-upgrade%")])

print("\n== 6) a second day is a day, not a person ==")
# Saturday, then Sunday, on two transactions. One person collecting days.
E4 = "zz-dsp-days@example.invalid"
buy(E4, "zz-dy-1", T0.isoformat(), day="2026-11-20")
buy(E4, "zz-dy-2", at(60 * 24 * 2), day="2026-11-21")
check(len(roll("zz-dsp-days%")) == 1,
      "buying a second day does not invent a second attendee",
      [(a.id, a.email, a.registration_source) for a in roll("zz-dsp-days%")])

print("\n== 7) choosing three seats on one order ==")
# The unambiguous way to buy for other people. The buyer gets their own badge;
# the rest are counted as paid-for and named by whoever turns up.
E5 = "zz-dsp-three@example.invalid"
buy(E5, "zz-th-1", T0.isoformat(), amount=297.0, qty=3, first="Trio", last="Buyer")
buyer = roll("zz-dsp-three%")[0]
party = main._party_members(db, buyer)
check(len(roll("zz-dsp-three%")) == 1,
      "one order for three does not silently invent two people",
      [(a.id, a.email) for a in roll("zz-dsp-three%")])
check(party.get("paid_for") == 3,
      "the door is told three seats were paid for", party)
check(party.get("unnamed") == 2,
      "and that two of them still have nobody's name on them", party)

print("\n== 8) naming those seats at the desk, one at a time ==")
staff = db.query(models.User).filter(models.User.email != None).first()   # noqa: E711
named = []
for who in (("Friend", "One"), ("Friend", "Two")):
    out = main.add_party_seat(ev.id, buyer.id,
                              schemas.AddPartySeat(first_name=who[0], last_name=who[1]),
                              db=db, current_user=staff)
    named.append(out)
rows = roll("zz-dsp-three%")
check(len(rows) == 3, "naming two seats makes exactly two more badges",
      [(a.id, a.email, a.first_name, a.last_name) for a in rows])
qrs = {a.qr_code for a in rows}
check(len(qrs) == 3, "each of the three has its own QR", qrs)
check({(a.first_name, a.last_name) for a in rows} ==
      {("Trio", "Buyer"), ("Friend", "One"), ("Friend", "Two")},
      "and each carries the name of the person actually standing there",
      [(a.first_name, a.last_name) for a in rows])
party = main._party_members(db, buyer)
check(party.get("unnamed") == 0, "nothing is left unnamed afterwards", party)
check(party.get("size") == 3 and party.get("paid_for") == 3,
      "and the booking is three seats for three paid tickets", party)

print("\n== 9) and the desk cannot invent a fourth ==")
try:
    main.add_party_seat(ev.id, buyer.id,
                        schemas.AddPartySeat(first_name="Gate", last_name="Crasher"),
                        db=db, current_user=staff)
    check(False, "a seat beyond what was paid for is refused", "it was allowed")
except Exception as exc:                                    # noqa: BLE001
    check(getattr(exc, "status_code", None) in (400, 409),
          "a seat beyond what was paid for is refused", repr(exc))

print("\n== 10) cleanup ==")
for a in roll("zz-dsp-%"):
    db.delete(a)
for m in db.query(models.TicketMapping).filter(models.TicketMapping.event_id == ev.id).all():
    db.delete(m)
for t in (tt, up):
    db.delete(t)
db.delete(ev)
db.commit()
check(not db.query(models.Event).filter(models.Event.id == ev.id).first(),
      "the throwaway event is gone")

print("\n%d checks, %d failed" % (12, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
    sys.exit(1)
print("duplicate-versus-second-seat rules hold")
