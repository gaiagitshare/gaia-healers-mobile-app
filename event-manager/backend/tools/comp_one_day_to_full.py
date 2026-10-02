# -*- coding: utf-8 -*-
"""Give everybody who bought one conference day all three, on the house.

They paid $97 for "one day of your choosing". The organiser's decision is to
hand them the full three days rather than hold them to it, so this records a
COMPLIMENTARY upgrade to General Admission + Conference.

What it does not do is rewrite history. The one-day purchase stays on their
entitlement ledger, because that is what they actually bought and it is what a
refund or a question in six months would need to read. The upgrade sits on top
as an admin tier, which is a FLOOR: if one of them later buys VIP, that lifts
them further rather than being capped by this.

The add-on simply stops being displayed once the pass already covers it --
listing "one day, still to be chosen" beside a pass that opens all three reads
as a restriction that no longer exists.

Dry run by default. Nothing is written without --apply.
Run:  python3 /root/event/backend/tools/comp_one_day_to_full.py [--apply]
"""
import os
import sys

sys.path.insert(0, "/root/event/backend")
os.chdir("/root/event/backend")

import main, models                                       # noqa: E402
from database import SessionLocal                         # noqa: E402

EVENT = 1
ADDON = "ONE_DAY_CONFERENCE"
APPLY = "--apply" in sys.argv

s = SessionLocal()
conf = s.query(models.TicketType).filter(
    models.TicketType.event_id == EVENT,
    models.TicketType.name == "General Admission + Conference").first()
assert conf is not None, "this event has no General Admission + Conference pass"

holders = []
for a in s.query(models.Attendee).filter(models.Attendee.event_id == EVENT).all():
    ents = (a.custom_data or {}).get("entitlements") or []
    if any(e.get("addon_code") == ADDON and e.get("status") == "paid" for e in ents):
        holders.append(a)

nm = lambda x: ("%s %s" % (x.first_name or "", x.last_name or "")).strip()
todo, already = [], []
for a in holders:
    tt = s.query(models.TicketType).filter(models.TicketType.id == a.ticket_type_id).first()
    (already if (tt is not None and tt.grants_conference) else todo).append((a, tt))

print("ONE-DAY CONFERENCE HOLDERS: %d" % len(holders))
print("\nALREADY HAVE ALL THREE DAYS (nothing to do): %d" % len(already))
for a, tt in already:
    print("   %-28s %s" % (nm(a)[:28], tt.name if tt else "(no pass)"))

print("\nCOMPLIMENTARY UPGRADE TO %s: %d" % (conf.name, len(todo)))
for a, tt in sorted(todo, key=lambda r: (r[0].last_name or "")):
    print("   %-28s %-22s -> %s" % (nm(a)[:28], (tt.name if tt else "(no pass)"), conf.name))

if not APPLY:
    print("\nDRY RUN. Nothing written. Re-run with --apply.")
    sys.exit(0)

done = 0
for a, tt in todo:
    old = a.ticket_type_id
    a.ticket_type_id = conf.id
    cd = dict(a.custom_data or {})
    # A floor, not a ceiling: a later paid upgrade still lifts them past this.
    cd["admin_tier"] = conf.id
    a.custom_data = cd
    main._lifecycle_append(
        a, "comp_upgrade", actor="comp_one_day_to_full",
        reason=("Bought the one-day conference upgrade. Given all three days as a "
                "complimentary upgrade by the organiser. The one-day purchase stays on "
                "the ledger; this sits on top of it."),
        complimentary=True, from_tt=old, to_tt=conf.id)
    done += 1
s.commit()
print("\nupgraded %d people to %s, complimentary" % (done, conf.name))
print("their one-day purchase is still on the ledger, and the add-on stops showing")
print("because the pass now covers it")
