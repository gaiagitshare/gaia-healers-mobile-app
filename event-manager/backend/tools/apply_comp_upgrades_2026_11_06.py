# -*- coding: utf-8 -*-
"""Record tickets 789, 790, 791 as approved complimentary upgrades (6 Nov 2026).

    python3 tools/apply_comp_upgrades_2026_11_06.py            # dry run
    python3 tools/apply_comp_upgrades_2026_11_06.py --apply    # write

They bought the plain exhibit-hall pass on 3 Nov and hold General Admission +
Conference because of the mapping bug, as #771, #772 and #786 did. Management
decision: keep it, on the house. admin_tier pins the access, so no later
reconcile can take it away. Payments and the ticket's pass are not written;
nobody is charged. Idempotent: a recorded ticket is skipped.
"""
import os, sys
HERE = "/root/event/backend"
sys.path.insert(0, HERE)
os.chdir(HERE)
import main, models                                       # noqa: E402
from database import SessionLocal                         # noqa: E402

APPLY = "--apply" in sys.argv
TICKETS = (789, 790, 791)
ACTOR = "management_decision_2026_11_06 (approved by Babak)"
REASON = ("Management decision, 6 Nov 2026: approved complimentary upgrade. Bought the $99 General Admission "
          "(Exhibit Hall Only) pass through the Elevate checkout and received GA + Conference through the "
          "ticket-mapping bug; access kept, consistent with tickets 771, 772 and 786. Customer not charged.")
s = SessionLocal()
conf = s.query(models.TicketType).filter(models.TicketType.event_id == 1,
                                         models.TicketType.name == "General Admission + Conference").first()
ga = s.query(models.TicketType).filter(models.TicketType.event_id == 1, models.TicketType.name == "General Admission").first()
for tid in TICKETS:
    a = s.get(models.Attendee, tid)
    why = None
    if a is None or a.event_id != 1:
        why = "not found"
    elif not main._ticket_active(a):
        why = "ticket is %s" % main._ticket_status(a)
    elif a.ticket_type_id != conf.id:
        why = "no longer General Admission + Conference"
    elif any(e.get("action") == "comp_upgrade" and e.get("actor") == ACTOR for e in (a.custom_data or {}).get("lifecycle", [])):
        why = "already recorded"
    if why:
        print("SKIPPED ticket %s: %s" % (tid, why))
        continue
    print("%s ticket %s %s %s" % ("RECORD" if APPLY else "WOULD RECORD", tid, a.first_name, a.last_name))
    if APPLY:
        cd = dict(a.custom_data or {})
        cd["admin_tier"] = conf.id
        cd.pop(main.ADMIN_CAP_KEY, None)
        a.custom_data = cd
        main._lifecycle_append(a, "comp_upgrade", actor=ACTOR, from_tt=ga.id, to_tt=conf.id, complimentary=True, reason=REASON)
if APPLY:
    s.commit()
