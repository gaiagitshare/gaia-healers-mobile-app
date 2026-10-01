# -*- coding: utf-8 -*-
"""BUYING MORE MUST NEVER GIVE YOU LESS

Every pass is ranked, and the door resolved an attendee to the single
highest-ranked tier they had paid for. That works while the ranks describe a
ladder. These do not:

    Workshop Access     workshops, no conference   rank 3
    GA + Conference     conference, no workshops   rank 2

Two of the upgrades on sale cross between them. "GA-CONF to Workshop" raised the
rank and dropped the conference; "Workshop to Three-Day" raised it again and
dropped the workshops. Each one charged somebody to lose a door they already
paid to walk through. Neither had sold yet, which is the only reason this was
not a live incident.

So access is the UNION of every tier a person paid for. The ranks still name the
tier -- that is all they were ever fit for.

Runs against a COPY. Nothing here touches production.
Run:  python3 /root/event/backend/test_upgrade_never_removes_access.py
"""
import os, shutil, sys, tempfile
from datetime import datetime

HERE = "/root/event/backend"
COPY = os.path.join(tempfile.mkdtemp(prefix="up-access-"), "event.db")
shutil.copy(HERE + "/event.db", COPY)
os.environ["DATABASE_URL"] = "sqlite:///" + COPY
sys.path.insert(0, HERE)

import importlib, database                                   # noqa: E402
importlib.reload(database)
import main, models, schemas                                 # noqa: E402
from database import SessionLocal                            # noqa: E402

EVENT = 1
DAY = "2026-11-21"
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

db = SessionLocal()
ev = db.query(models.Event).filter(models.Event.id == EVENT).first()
maps = [m for m in db.query(models.TicketMapping).filter(
    models.TicketMapping.event_id == EVENT,
    models.TicketMapping.is_active == True).all()]                      # noqa: E712
bases = [m for m in maps if not m.is_upgrade]
made = []


def zones_of(a):
    dec = main._authorize_decision(db, a, ev, "EVENT_ENTRY",
                                   at=datetime.fromisoformat(DAY + "T10:00:00"))
    z = dec.get("zones") or {}
    def f(k):
        v = z.get(k)
        return bool(v.get("allowed") if isinstance(v, dict) else v)
    return {"entry": bool(dec.get("granted")), "conference": f("conference"),
            "workshop": f("workshop"), "vip": f("vip")}


def buy(email, mapping, order, when, upgrade):
    main.reconcile_attendee(schemas.ReconcileAttendee(
        event_id=EVENT, email=email, ticket_type_id=mapping.ticket_type_id,
        product_id=mapping.external_product_id, order_id=order, amount=150.0,
        quantity=1, purchased_at=when, is_upgrade=upgrade,
        addon_code=mapping.addon_code,
        first_name="Zz", last_name="Union"), db=db, _=True)
    db.commit()


print("\n== every upgrade on sale, applied to the pass it is sold from ==")
tested = 0
for m in sorted([x for x in maps if x.is_upgrade and not x.addon_code],
                key=lambda x: x.id):
    src = next((b for b in bases if b.ticket_type_id == m.from_ticket_type_id), None)
    if not src:
        continue                      # no product sells the pass it upgrades from
    em = "zz-union-%d@example.invalid" % m.id
    made.append(em)
    buy(em, src, "zz-union-base-%d" % m.id, "2026-09-01", False)
    a = db.query(models.Attendee).filter(models.Attendee.event_id == EVENT,
                                         models.Attendee.email == em).first()
    before = zones_of(a)
    buy(em, m, "zz-union-up-%d" % m.id, "2026-09-20", True)
    db.refresh(a)
    after = zones_of(a)
    tested += 1
    kept = [k for k in ("entry", "conference", "workshop", "vip")
            if before[k] and not after[k]]
    check(not kept, "%s keeps everything it started with" % (m.label or m.id)[:52],
          {"before": before, "after": after, "lost": kept})

check(tested >= 4, "enough upgrade paths were exercised to mean anything", tested)

print("\n== and an upgrade still ADDS what it sells ==")
# GA + Conference, then the Workshop upgrade: both zones, not one.
gac = next((b for b in bases if b.ticket_type_id == 7), None)
wk = next((m for m in maps if m.is_upgrade and m.ticket_type_id == 6
           and m.from_ticket_type_id == 7), None)
if gac and wk:
    em = "zz-union-add@example.invalid"
    made.append(em)
    buy(em, gac, "zz-union-add-1", "2026-09-01", False)
    buy(em, wk, "zz-union-add-2", "2026-09-20", True)
    a = db.query(models.Attendee).filter(models.Attendee.event_id == EVENT,
                                         models.Attendee.email == em).first()
    z = zones_of(a)
    check(z["conference"] and z["workshop"],
          "GA + Conference plus the workshop upgrade opens BOTH", z)
else:
    check(False, "the GA-CONF to Workshop upgrade is still on sale to test")

print("\n== a refund is still a refund ==")
# The union reads PAID tiers only. Refunding the upgrade must close its zone.
if gac and wk:
    a = db.query(models.Attendee).filter(models.Attendee.event_id == EVENT,
                                         models.Attendee.email == "zz-union-add@example.invalid").first()
    cd = dict(a.custom_data or {})
    ents = [dict(e) for e in (cd.get("entitlements") or [])]
    for e in ents:
        if e.get("order_id") == "zz-union-add-2":
            e["status"] = "refunded"
    cd["entitlements"] = ents
    a.custom_data = cd
    db.commit(); db.refresh(a)
    z = zones_of(a)
    check(not z["workshop"], "refunding the workshop upgrade closes the workshops", z)
    check(z["conference"], "and leaves the conference they still paid for", z)

print("\n== cleanup ==")
for em in made:
    for a in db.query(models.Attendee).filter(models.Attendee.event_id == EVENT,
                                              models.Attendee.email == em).all():
        db.delete(a)
db.commit()
left = db.query(models.Attendee).filter(
    models.Attendee.event_id == EVENT,
    models.Attendee.email.like("zz-union-%")).count()
check(left == 0, "every throwaway attendee is gone", left)

print("\n%d failed" % len(fails))
if fails:
    print("FAILED: " + "; ".join(fails))
    sys.exit(1)
print("no upgrade on sale removes access")
