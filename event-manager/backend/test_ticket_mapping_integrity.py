# -*- coding: utf-8 -*-
"""WHAT WE SOLD vs WHAT THE BADGE OPENS.

A reconciliation of the 2026 ledger turned up fifteen people who bought
"GENERAL ADMISSION + CONFERENCE" and hold a General Admission pass, which does
not include the conference. Nobody did anything wrong: a ticket mapping is
written by hand, once, and then believed forever, and nothing ever read it back
against the product it maps. The first person to find out would have been
somebody at the conference room door holding a receipt for it.

Two separate rules are pinned here, because the same reconciliation showed both
being got wrong by eye:

  1. A mapping must GRANT everything its product NAME sells. This is the read-
     back, and it is the thing that makes the class of bug self-reporting
     instead of waiting for a door.

  2. A payment is not a person. Only a base-ticket product seats somebody; an
     upgrade is the same human paying again. And the price cannot be used to
     tell them apart -- $99 is 314 tickets AND 4 one-day upgrades in this very
     ledger, so any rule that reads the amount is wrong in both directions.

The logic checks below run against fixtures and always apply. The last section
is a GATE on live data: while it fails, real people are holding passes that do
not open what they paid for.

Run:  python3 /root/event/backend/test_ticket_mapping_integrity.py
"""
import os, shutil, sys, tempfile

HERE = "/root/event/backend"
COPY = os.path.join(tempfile.mkdtemp(prefix="mapping-audit-"), "event.db")
shutil.copy(HERE + "/event.db", COPY)
os.environ["DATABASE_URL"] = "sqlite:///" + COPY
sys.path.insert(0, HERE)

import importlib, database                                   # noqa: E402
importlib.reload(database)
import main, models                                          # noqa: E402
from database import SessionLocal                            # noqa: E402

EVENT = 1
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

db = SessionLocal()

print("\nREADING A PRODUCT NAME FOR WHAT IT SELLS")
promises = main._product_promises
check(promises("GENERAL ADMISSION + CONFERENCE") == {"conference"},
      "a bundled name sells the conference", promises("GENERAL ADMISSION + CONFERENCE"))
check(promises("GENERAL ADMISSION (EXHIBIT HALL ONLY + CONFERENCE 3 DAYS)") == {"conference"},
      "so does the three-day wording", promises("GENERAL ADMISSION (EXHIBIT HALL ONLY + CONFERENCE 3 DAYS)"))
check(promises("Gaia Healers Conference One Day Speaker Upgrade") == {"conference"},
      "and a speaker upgrade")
check(promises("Gaia Healers Holistic Wellness Conference Exhibit Pass") == set(),
      "but the word Conference in an EVENT's name sells nothing",
      promises("Gaia Healers Holistic Wellness Conference Exhibit Pass"))
check(promises("Elevate Conference 2026 (Exhibit Hall Only)") == set(),
      "nor does it in an exhibit-hall-only product")
check(promises("VIP PASS") == {"vip"} and promises("WORKSHOP ACCESS") == {"workshop"},
      "VIP and workshop read straight")
# The half of an upgrade's label that names where it CAME from is not a promise.
check(promises("ELEVATE Upgrade - Workshop to Three-Day (01)", is_upgrade=True) == set(),
      "an upgrade FROM workshop does not sell a workshop",
      promises("ELEVATE Upgrade - Workshop to Three-Day (01)", is_upgrade=True))
check(promises("ELEVATE Upgrade - GA-CONF to VIP (00)", is_upgrade=True) == {"vip"},
      "but it does sell what it upgrades TO")

print("\nREADING A PASS FOR WHAT IT OPENS")
types = {t.name: t for t in db.query(models.TicketType).filter(models.TicketType.event_id == EVENT)}
check(main._pass_grants(types["General Admission"]) == set(),
      "General Admission opens the hall and nothing else")
check("conference" in main._pass_grants(types["General Admission + Conference"]),
      "GA + Conference opens the conference")
check(main._pass_grants(types["VIP Pass"]) == {"conference", "workshop", "vip"},
      "VIP opens everything", main._pass_grants(types["VIP Pass"]))

print("\nTHE AUDIT CATCHES A MIS-MAPPED PRODUCT, AND ONLY A MIS-MAPPED ONE")
# Deliberately break a good mapping on the COPY and watch it get reported.
good = db.query(models.TicketMapping).filter(
    models.TicketMapping.event_id == EVENT,
    models.TicketMapping.label.like("%Full Speaker Access%")).first()
before = main._mapping_audit(db, EVENT)
before_ids = {(f["mapping_id"], f.get("product_name")) for f in before if f["severity"] == "error"}
good.ticket_type_id = types["General Admission"].id          # conference sold, hall delivered
db.flush()
after = main._mapping_audit(db, EVENT)
new = [f for f in after if f["severity"] == "error"
       and (f["mapping_id"], f.get("product_name")) not in before_ids]
check(any(f["mapping_id"] == good.id for f in new),
      "breaking a mapping is reported as an error", [f["detail"][:70] for f in new][:2])
broke = next((f for f in new if f["mapping_id"] == good.id), None)
check(broke and broke["missing"] == ["conference"], "naming exactly what is missing", broke and broke.get("missing"))
check(broke and broke["payments"] >= 38,
      "and counting the people it already sold to", broke and broke.get("payments"))
db.rollback()

restored = main._mapping_audit(db, EVENT)
check(not any(f["mapping_id"] == good.id and f["severity"] == "error" for f in restored),
      "and a correct mapping is not reported")

print("\nA PAYMENT IS NOT A PERSON")
paid = db.query(models.PaymentEvent).filter(
    models.PaymentEvent.event_id == EVENT, models.PaymentEvent.status == "paid").all()
maps = {m.external_product_id: m for m in db.query(models.TicketMapping).filter(
    models.TicketMapping.event_id == EVENT) if m.external_product_id}

def kind(pay):
    import json as _j
    v = pay.product_ids
    pids = v if isinstance(v, (list, tuple)) else (_j.loads(v or "[]") if v else [])
    m = next((maps[x] for x in pids if x in maps), None)
    if m is None:
        return "unmapped"
    return "upgrade" if m.is_upgrade else "ticket"

kinds = [kind(p) for p in paid]
tickets = kinds.count("ticket"); upgrades = kinds.count("upgrade")
print("     %d paid payments = %d tickets + %d upgrades + %d unmapped"
      % (len(paid), tickets, upgrades, kinds.count("unmapped")))
check(kinds.count("unmapped") == 0, "every paid payment resolves to a product we know",
      kinds.count("unmapped"))
check(tickets + upgrades == len(paid), "and is one thing or the other, never both")

# The trap the price heuristic falls into, in this very ledger.
at99 = [kind(p) for p in paid if abs(float(p.amount or 0) - 99.0) < 0.005]
check(at99.count("ticket") > 0 and at99.count("upgrade") > 0,
      "$99 is BOTH a ticket and an upgrade — so the price can never decide",
      {"tickets": at99.count("ticket"), "upgrades": at99.count("upgrade")})
at97 = [kind(p) for p in paid if abs(float(p.amount or 0) - 97.0) < 0.005]
check(at97 and set(at97) == {"upgrade"},
      "every $97 is an upgrade, not a workshop add-on", set(at97))
names97 = {(_n[0] if isinstance(_n, (list, tuple)) else str(_n))
           for _n in (p.product_names for p in paid if abs(float(p.amount or 0) - 97.0) < 0.005)}
print("     what $97 actually is: %s" % list(names97)[:1])

print("\nONE PRODUCT SOLD UNDER TWO NAMES")
# GoHighLevel sells several storefront variants through ONE product id. Product
# 69b463a1... arrives as "GENERAL ADMISSION (EXHIBIT HALL ONLY)" and as
# "GENERAL ADMISSION + CONFERENCE", and at $104.94 under BOTH names -- so
# neither the id nor the price can separate them. Only the name can.
PRODUCT = "69b463a14181e967e2fc2cfe"
cands = db.query(models.TicketMapping).filter(
    models.TicketMapping.event_id == EVENT,
    models.TicketMapping.external_product_id == PRODUCT).all()
check(len(cands) >= 2, "the product has a mapping for each variant", len(cands))
pick = main._pick_mapping
hall = pick(cands, "GENERAL ADMISSION (EXHIBIT HALL ONLY)")
conf = pick(cands, "GENERAL ADMISSION + CONFERENCE")
three = pick(cands, "GENERAL ADMISSION (EXHIBIT HALL ONLY + CONFERENCE 3 DAYS)")
both = pick(cands, "GENERAL ADMISSION (EXHIBIT HALL + CONFERENCE)")
name_of = lambda m: (db.query(models.TicketType).filter(
    models.TicketType.id == m.ticket_type_id).first().name if m else None)
check(name_of(hall) == "General Admission",
      "exhibit hall only resolves to the hall pass", name_of(hall))
check(name_of(conf) == "General Admission + Conference",
      "the conference variant resolves to the conference pass", name_of(conf))
check(name_of(three) == "General Admission + Conference",
      "so does the three-day wording", name_of(three))
check(name_of(both) == "General Admission + Conference",
      "and the hall+conference wording", name_of(both))
check(name_of(pick(cands, "")) == "General Admission",
      "a sale with no name at all falls back, it does not guess upward",
      name_of(pick(cands, "")))
# The price is not consulted, and must not be: $104.94 is sold under both names.
check(name_of(pick(cands, "GENERAL ADMISSION (EXHIBIT HALL ONLY)")) !=
      name_of(pick(cands, "GENERAL ADMISSION + CONFERENCE")),
      "two sales at the SAME price resolve differently, by name alone")

print("\nGATE ON LIVE DATA")
live = main._mapping_audit(db, EVENT)
errors = [f for f in live if f["severity"] == "error"]
hurt = sorted({p for f in errors for p in (f.get("people") or [])})
for f in errors:
    print("     %-52s -> %-24s  %d paid" % (
        (f.get("product_name") or f["label"])[:52], f["ticket_type"], f.get("payments") or 0))
check(not errors,
      "no live mapping sells access the badge does not open",
      "%d product(s), %d people: %s" % (len(errors), len(hurt), hurt))

print("\n" + ("ALL GOOD" if not fails else "FAILED: " + "; ".join(fails)))
shutil.rmtree(os.path.dirname(COPY), ignore_errors=True)
sys.exit(1 if fails else 0)
