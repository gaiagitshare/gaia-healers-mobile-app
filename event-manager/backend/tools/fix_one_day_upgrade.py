# -*- coding: utf-8 -*-
"""Give the one-day conference upgrade back its one day.

GoHighLevel's own description of the $97 product is "access to ONE DAY OF YOUR
CHOOSING to attend the speaker's presentation". It was mapped to the full
General Admission + Conference tier, which is three days, so everybody who
bought it has been holding two days they never paid for.

The machinery for doing this properly already existed and nothing used it: the
ONE_DAY_CONFERENCE add-on code, a door that grants it on the chosen day and
refuses it on any other, and a day picker on the attendee's Manage dialog. What
was missing was the mapping saying the product IS that add-on, and the grant
path reading the mapping when it said so.

This script does the data half:

  * points the mapping at the add-on, so the next sale is right;
  * turns each existing holder's tier entitlement into the add-on, and drops
    their base pass back to what they actually bought.

It does NOT pick anybody's day. The product says "of your choosing", so the
choice is theirs -- at the desk, or in advance. Until one is chosen the door
says "One-Day Speaker Access purchased, day not selected" rather than letting
them in or turning them away silently.

Anybody who ALSO holds conference access by another route keeps three days and
is skipped by name in the output, not quietly.

Dry run by default. Nothing is written without --apply.
Run:  python3 /root/event/backend/tools/fix_one_day_upgrade.py [--apply]
"""
import json
import os
import sys

sys.path.insert(0, "/root/event/backend")
os.chdir("/root/event/backend")

import main, models                                       # noqa: E402
from database import SessionLocal                         # noqa: E402

EVENT = 1
ONE_DAY_PRODUCT = "6890d769862c0cf72f94de51"
ADDON = "ONE_DAY_CONFERENCE"
APPLY = "--apply" in sys.argv

s = SessionLocal()

mapping = s.query(models.TicketMapping).filter(
    models.TicketMapping.event_id == EVENT,
    models.TicketMapping.external_product_id == ONE_DAY_PRODUCT).first()
assert mapping is not None, "the one-day product is not mapped on this event"

ga = s.query(models.TicketType).filter(
    models.TicketType.event_id == EVENT, models.TicketType.name == "General Admission").first()
conf = s.query(models.TicketType).filter(
    models.TicketType.event_id == EVENT,
    models.TicketType.name == "General Admission + Conference").first()
assert ga and conf

print("MAPPING m%d  %s" % (mapping.id, mapping.label))
print("   addon_code now : %r  ->  %r" % (mapping.addon_code, ADDON))

# Who bought it, and who has conference access some other way.
maps = {m.external_product_id: m for m in s.query(models.TicketMapping).filter(
    models.TicketMapping.event_id == EVENT).all() if m.external_product_id}


def products(pe):
    v = pe.product_ids
    if isinstance(v, (list, tuple)):
        return list(v)
    try:
        return json.loads(v or "[]")
    except Exception:
        return []


def name_of(pe):
    v = pe.product_names
    if isinstance(v, (list, tuple)):
        return (v[0] if v else "")
    try:
        n = json.loads(v or "[]")
        return n[0] if n else ""
    except Exception:
        return ""


def grants_conference_otherwise(att_id):
    """Another paid product that opens the conference on its own."""
    out = []
    for pe in s.query(models.PaymentEvent).filter(
            models.PaymentEvent.event_id == EVENT,
            models.PaymentEvent.attendee_id == att_id,
            models.PaymentEvent.status == "paid").all():
        pids = products(pe)
        if ONE_DAY_PRODUCT in pids:
            continue
        m = main._pick_mapping([maps[p] for p in pids if p in maps], name_of(pe), pe.occurred_at)
        tt = s.query(models.TicketType).filter(
            models.TicketType.id == m.ticket_type_id).first() if m else None
        if tt is not None and tt.grants_conference:
            out.append("$%s %s" % (pe.amount, name_of(pe)[:44]))
    return out


holders = {}
for pe in s.query(models.PaymentEvent).filter(
        models.PaymentEvent.event_id == EVENT,
        models.PaymentEvent.status == "paid").all():
    if ONE_DAY_PRODUCT in products(pe) and pe.attendee_id:
        holders.setdefault(pe.attendee_id, []).append(pe)

convert, keep = [], []
for aid, pays in holders.items():
    att = s.query(models.Attendee).filter(models.Attendee.id == aid).first()
    if att is None:
        continue
    other = grants_conference_otherwise(aid)
    (keep if other else convert).append((att, pays, other))

nm = lambda a: ("%s %s" % (a.first_name or "", a.last_name or "")).strip()

print("\nKEEPING THREE DAYS (paid for the conference another way): %d" % len(keep))
for att, _p, other in keep:
    print("   %-28s <- %s" % (nm(att)[:28], "; ".join(other)))

print("\nMOVING TO THE ONE-DAY ADD-ON: %d" % len(convert))
for att, pays, _o in sorted(convert, key=lambda r: (r[0].last_name or "")):
    print("   %-28s  %-32s -> General Admission + One-Day Speaker Access (day to choose)"
          % (nm(att)[:28], (s.query(models.TicketType).filter(
              models.TicketType.id == att.ticket_type_id).first().name
              if att.ticket_type_id else "(no pass)")))

if not APPLY:
    print("\nDRY RUN. Nothing written. Re-run with --apply.")
    sys.exit(0)

mapping.addon_code = ADDON
moved = 0
for att, pays, _o in convert:
    cd = dict(att.custom_data or {})
    ents = list(cd.get("entitlements") or [])
    touched = False
    for e in ents:
        if e.get("addon_code"):
            continue
        # The entitlement this product created: a tier upgrade to GA + Conference.
        if e.get("product_id") == ONE_DAY_PRODUCT or (
                e.get("is_upgrade") and e.get("ticket_type_id") == conf.id):
            e["addon_code"] = ADDON
            e["ticket_type_id"] = None      # an add-on never names a tier
            e.pop("day", None)
            e.pop("day_date", None)
            touched = True
    cd["entitlements"] = ents
    # The base pass goes back to what they bought. An admin-set floor would
    # outrank this, and none of these people carry one -- but read it rather
    # than assume it.
    if not cd.get("admin_tier") and att.ticket_type_id == conf.id:
        att.ticket_type_id = ga.id
    att.custom_data = cd
    main._lifecycle_append(
        att, "one_day_upgrade_corrected", actor="fix_one_day_upgrade",
        reason=("Bought the One Day Speaker Upgrade, which GHL describes as one day of "
                "their choosing. It had been mapped to the full three-day conference "
                "tier. Moved to the ONE_DAY_CONFERENCE add-on; the day is still to be "
                "chosen."),
        from_tt=conf.id, to_tt=ga.id)
    moved += 1 if touched else 0

s.commit()
print("\nmapping m%d now grants the add-on" % mapping.id)
print("moved %d people onto the one-day add-on" % moved)
print("nobody has a day chosen yet - the door will say so until one is picked")
