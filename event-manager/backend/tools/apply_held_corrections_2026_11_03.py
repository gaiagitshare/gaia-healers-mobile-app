# -*- coding: utf-8 -*-
"""Apply the held-ticket corrections Babak approved on 3 Nov 2026. Dry run by default.

    python3 tools/apply_held_corrections_2026_11_03.py MANIFEST.json            # dry run
    python3 tools/apply_held_corrections_2026_11_03.py MANIFEST.json --apply    # write

Two kinds of correction, nothing else:

  pass_corrected   The GHL order LINE is the "GENERAL ADMISSION + CONFERENCE" variant
                   of product 69b463a1..., sold under the exhibit-hall-only product.
                   tools/fix_conference_variant.py (Oct) applies the approved rule --
                   the "+ CONFERENCE" wording decides -- but reads the PRODUCT name, so
                   these line-level variants were missed. Same move, same audit shape:
                   pass -> General Admission + Conference, admin_tier pinned,
                   lifecycle "pass_corrected" naming the paid payment and the order line.
  comp_recorded    Bought General Admission, already holding GA + Conference with no
                   upgrade on record. Kept, and recorded as a complimentary upgrade
                   (lifecycle "comp_upgrade", complimentary=True), admin_tier pinned so
                   a later reconcile cannot take it away. Nobody is charged.

Every row is re-checked before it is touched (still the expected pass, still active,
the paid payment still linked); anything that no longer matches is skipped and
reported, never forced. Payments are never written. Each applied row is appended
to data/held-corrections-2026-11-03.log.
"""
import json, os, sys
from datetime import datetime

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
os.chdir(HERE)
import main, models                                       # noqa: E402
from database import SessionLocal                         # noqa: E402

APPLY = "--apply" in sys.argv
SRC = next(a for a in sys.argv[1:] if a.endswith(".json"))
LOG = os.path.join(HERE, "data", "held-corrections-2026-11-03.log")
ACTOR = "held_corrections_2026_11_03 (approved by Babak, 3 Nov 2026)"

plan = json.load(open(SRC))
s = SessionLocal()
conf = s.query(models.TicketType).filter(models.TicketType.event_id == 1,
                                         models.TicketType.name == "General Admission + Conference").first()
ga = s.query(models.TicketType).filter(models.TicketType.event_id == 1,
                                       models.TicketType.name == "General Admission").first()
assert conf and ga and conf.grants_conference and not ga.grants_conference

done, skipped = [], []
for row in plan["corrections"]:
    a = s.get(models.Attendee, row["ticket_id"])
    why = None
    if a is None or a.event_id != 1:
        why = "ticket not found"
    elif not main._ticket_active(a):
        why = "ticket is %s" % main._ticket_status(a)
    elif row["kind"] == "pass_corrected":
        pe = s.get(models.PaymentEvent, row["payment_event_id"])
        if a.ticket_type_id != ga.id:
            why = "no longer General Admission (now %s)" % a.ticket_type_id
        elif not pe or pe.attendee_id != a.id or pe.status != "paid" or pe.ghl_entity_id != row["order_id"]:
            why = "paid payment for order %s is not linked to this ticket" % row["order_id"]
        elif "+ CONFERENCE" not in (row.get("order_line_name") or "").upper():
            why = "order line is not a + CONFERENCE variant"
    elif row["kind"] == "comp_recorded":
        if a.ticket_type_id != conf.id:
            why = "no longer General Admission + Conference (now %s)" % a.ticket_type_id
        elif any(e.get("action") == "comp_upgrade" and e.get("actor") == ACTOR
                 for e in (a.custom_data or {}).get("lifecycle", [])):
            why = "already recorded"
    else:
        why = "unknown kind"
    if why:
        skipped.append((row["ticket_id"], row["kind"], why)); continue
    done.append(row)
    if not APPLY:
        continue
    cd = dict(a.custom_data or {})
    cd["admin_tier"] = conf.id
    cd.pop(main.ADMIN_CAP_KEY, None)
    a.custom_data = cd
    if row["kind"] == "pass_corrected":
        old = a.ticket_type_id
        a.ticket_type_id = conf.id
        main._lifecycle_append(a, "pass_corrected", actor=ACTOR, from_tt=old, to_tt=conf.id,
                               from_payment=row["payment_event_id"], order_id=row["order_id"],
                               reason=("GHL order line “%s” (%s) includes the conference; the product "
                                       "was mapped to exhibit hall only. Moved onto the pass that was bought, "
                                       "per the October “+ CONFERENCE” rule." % (row["order_line_name"], row["price_name"])))
    else:
        main._lifecycle_append(a, "comp_upgrade", actor=ACTOR, from_tt=ga.id, to_tt=conf.id, complimentary=True,
                               order_id=row.get("order_id"),
                               reason="Bought General Admission; already holding GA + Conference with no upgrade on "
                                      "record. Kept as a complimentary upgrade. Customer not charged.")
    with open(LOG, "a") as f:
        f.write(json.dumps({"at": datetime.utcnow().isoformat(), "ticket_id": a.id, "kind": row["kind"],
                            "to_tt": conf.id}) + "\n")

if APPLY:
    s.commit()
print("%s: %d to apply, %d skipped" % ("APPLIED" if APPLY else "DRY RUN", len(done), len(skipped)))
for r in done:
    print("  %-15s ticket %s (order %s)" % (r["kind"], r["ticket_id"], r.get("order_id")))
for t, k, w in skipped:
    print("  SKIPPED %-15s ticket %s: %s" % (k, t, w))
