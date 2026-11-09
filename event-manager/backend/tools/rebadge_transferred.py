# -*- coding: utf-8 -*-
"""Give tickets transferred BEFORE the 9 Nov fix the new holder's own badge code.

    python3 tools/rebadge_transferred.py            # dry run: lists what would change
    python3 tools/rebadge_transferred.py --apply    # applies, with history on each ticket

Same steps the transfer action now takes (main.transfer_ticket): the ticket's
badge/card code is released and re-issued for the CURRENT holder (their own
code from another ticket, or a fresh one), and their card is attached; the
previous holder keeps their card. Entry QR codes, passes and payments are not
touched. Only tickets whose transfer record lacks "badge_code_replaced" and
which are not checked in and never had a badge printed are considered.
"""
import argparse
import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    import main as M
    import models
    import badge_card
    from database import SessionLocal
    db = SessionLocal()
    todo = []
    for a in db.query(models.Attendee).all():
        cd = a.custom_data or {}
        tr = cd.get("transfers") or []
        if not tr or tr[-1].get("badge_code_replaced") is not None:
            continue
        if not M._ticket_active(a) or a.is_checked_in or int(a.badge_print_count or 0) > 0:
            print("skip ticket %d: checked in, printed or not active" % a.id)
            continue
        todo.append(a)
    for a in todo:
        old = a.public_token
        a.public_token = None
        db.flush()
        badge_card.ensure_public_token(db, models, a, commit=False)
        M.attach_member_identity(db, a)
        cd = dict(a.custom_data or {})
        trs = list(cd.get("transfers") or [])
        trs[-1] = dict(trs[-1], badge_code_replaced=bool(old and old != a.public_token))
        cd["transfers"] = trs
        a.custom_data = cd
        M._lifecycle_append(a, "badge_code_reissued_for_holder", actor="tools/rebadge_transferred.py",
                            reason="Transferred before 9 Nov 2026: the badge code still belonged to the previous holder",
                            badge_code_changed=bool(old and old != a.public_token))
        print("ticket %d: badge code %s" % (a.id, "re-issued for the current holder" if old != a.public_token else "unchanged"))
    if args.apply:
        db.commit()
        print("APPLIED to %d ticket(s)" % len(todo))
    else:
        db.rollback()
        print("DRY RUN: %d ticket(s) would change; nothing written" % len(todo))


if __name__ == "__main__":
    main()
