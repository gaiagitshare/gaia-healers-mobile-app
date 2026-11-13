"""Speaker badges: every published programme speaker holds a SPEAKER badge.

13 Nov 2026 (Babak): the 23 programme speakers had no ticket, so at the door
they could not be found and their badge could not say SPEAKER. A speaker is
either somebody who already has a ticket (they keep it; the row is LINKED to
the speaker, custom_data.speaker_id, and their badge then says SPEAKER), or
gets a speaker badge of their own:

  * pass "Speaker" (conference + workshops, not VIP), created if missing;
  * attendance_type speaker, registration_source admin;
  * no email unless one is given -- the door finds them by name, and a guessed
    address would hand their card to whoever owns it.

A link is never guessed from a name match: the organiser names it (--link).
Running it again changes nothing (one badge per speaker, ever).

  python3 tools/speaker_badges.py --dry-run
  python3 tools/speaker_badges.py --link 6:811 --link 10:250 --link 23:717
"""
import argparse
import os
import re
import sys
import uuid
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sqlalchemy.orm.attributes import flag_modified          # noqa: E402

import main as M                                              # noqa: E402
import database                                               # noqa: E402
import models                                                 # noqa: E402

HONORIFICS = {"dr", "dr.", "master", "prof", "prof."}


def split_name(full):
    """'Dr. Nima Farshid' -> ('Nima', 'Farshid'); 'Dr. Davis' -> ('Dr.', 'Davis');
    credentials after a comma ('..., PhD DDM') are dropped."""
    base = re.sub(r",.*$", "", full or "").replace("Ph.D.", "").strip()
    words = base.split()
    if len(words) > 2 and words[0].lower() in HONORIFICS:
        words = words[1:]
    if len(words) == 1:
        return "", words[0]
    if not words:
        return "", ""
    return " ".join(words[:-1]), words[-1]


def speaker_pass(db, event_id, dry):
    tt = db.query(models.TicketType).filter(models.TicketType.event_id == event_id,
                                            models.TicketType.code == "SPEAKER").first()
    if tt or dry:
        return tt
    tt = models.TicketType(event_id=event_id, code="SPEAKER", name="Speaker",
                           description="Programme speaker: exhibit halls, conference and workshops.",
                           is_vip=False, grants_conference=True, grants_workshops=True)
    db.add(tt)
    db.flush()
    return tt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", type=int, default=1)
    ap.add_argument("--link", action="append", default=[], help="SPEAKER_ID:ATTENDEE_ID")
    ap.add_argument("--include-unpublished", action="store_true")
    ap.add_argument("--actor", default="admin:claude (approved by Babak in chat, 13 Nov 2026)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    links = {}
    for x in a.link:
        sid, aid = x.split(":")
        links[int(sid)] = int(aid)

    db = database.SessionLocal()
    rows = db.query(models.Attendee).filter(models.Attendee.event_id == a.event).all()
    linked = {int((r.custom_data or {}).get("speaker_id")): r for r in rows if (r.custom_data or {}).get("speaker_id")}
    q = db.query(models.Speaker).filter(models.Speaker.event_id == a.event)
    if not a.include_unpublished:
        q = q.filter(models.Speaker.is_published == True)      # noqa: E712
    tt = speaker_pass(db, a.event, a.dry_run)
    now = datetime.utcnow().isoformat()
    for sp in q.order_by(models.Speaker.name).all():
        if sp.id in linked:
            print("  has badge  #%d %s -> attendee %d" % (sp.id, sp.name, linked[sp.id].id))
            continue
        if sp.id in links:
            att = db.query(models.Attendee).filter(models.Attendee.id == links[sp.id],
                                                   models.Attendee.event_id == a.event).first()
            if not att:
                print("  REFUSED    #%d %s: attendee %d not in this event" % (sp.id, sp.name, links[sp.id]))
                continue
            print("  link       #%d %s -> attendee %d %s %s (keeps %s)" % (sp.id, sp.name, att.id, att.first_name,
                                                                             att.last_name, M._pass_display(db, att)))
            if not a.dry_run:
                cd = dict(att.custom_data or {})
                cd["speaker_id"] = sp.id
                cd.setdefault("lifecycle", []).append({"ts": now, "action": "linked_to_speaker",
                                                       "actor": a.actor, "speaker_id": sp.id})
                att.custom_data = cd
                flag_modified(att, "custom_data")
            continue
        first, last = split_name(sp.name)
        print("  new badge  #%d %s -> %s / %s, pass Speaker" % (sp.id, sp.name, first, last))
        if a.dry_run:
            continue
        att = models.Attendee(event_id=a.event, email=None, first_name=first, last_name=last,
                              company=(sp.company or None), ticket_type_id=tt.id, registration_status="registered",
                              qr_code="ATT-%s" % uuid.uuid4().hex[:12].upper(),
                              custom_data={"source": "speaker_badge", "speaker_id": sp.id, "speaker_name": sp.name,
                                           "registered_by": a.actor, "registered_at": now,
                                           "lifecycle": [{"ts": now, "action": "speaker_badge_created", "actor": a.actor}]})
        db.add(att)
        db.flush()
        M.stamp_registration(att, "admin", "speaker")
        att.door_payment_status = "none"
        M.attach_member_identity(db, att)
    if a.dry_run:
        db.rollback()
        print("dry run: nothing written")
    else:
        db.commit()
        print("done")


if __name__ == "__main__":
    main()
