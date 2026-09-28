# -*- coding: utf-8 -*-
"""Give the second seat its own badge.

Twenty households bought more seats for Elevate 2026 than they have badges.
The reconciler attached every payment on a household to ONE attendee, so a
couple who bought two tickets has one row: the partner paid, and has nothing
to scan at the door.

The missing names are not lost. Each payment carries its own buyer_name and
buyer_email -- Chris Faulkner's order has a second payment in Alicia
Faulkner's name -- so a seat can be rebuilt as the person who actually bought
it, rather than as "guest of".

Refuses to guess. A payment whose buyer is the SAME person as the existing
attendee (a spelling apart) is an upgrade or a retry, not a second seat, and
is left alone.

  python3 tools/rebuild_missing_seats.py            # what would be created
  python3 tools/rebuild_missing_seats.py --apply    # create it
"""
import argparse, json, re, sqlite3, sys, uuid
from collections import defaultdict
from datetime import datetime

HERE = "/root/event/backend"
sys.path.insert(0, HERE)
import main, models                                                # noqa: E402
from database import SessionLocal                                  # noqa: E402

EVENT = 1


def seat_products(db):
    return {r[0] for r in db.execute(
        """select external_product_id from ticket_mappings
           where event_id=? and is_active=1 and coalesce(is_upgrade,0)=0
             and coalesce(addon_code,'')=''""", (EVENT,))}


def ticket_type_for(db, product_ids, seats_map):
    for pid in product_ids:
        if pid in seats_map:
            return seats_map[pid]
    return None


def plan():
    raw = sqlite3.connect(HERE + "/event.db", timeout=30)
    c = raw.cursor()
    seats = seat_products(c)
    tt = {r[0]: r[1] for r in c.execute(
        """select external_product_id, ticket_type_id from ticket_mappings
           where event_id=? and is_active=1""", (EVENT,))}
    groups = defaultdict(list)
    for pe, pid, amt, contact, email, name, aid, when in c.execute("""
            select id, coalesce(product_ids,''), amount, coalesce(contact_id,''),
                   lower(coalesce(buyer_email,'')), coalesce(buyer_name,''), attendee_id,
                   substr(coalesce(occurred_at,''),1,10)
            from payment_events
            where status='paid' and coalesce(event_id,-1)=? order by occurred_at""", (EVENT,)):
        try:
            ids = json.loads(pid) if isinstance(pid, str) else (pid or [])
        except Exception:
            ids = []
        if not any(i in seats for i in ids):
            continue
        groups[contact or email or name].append(
            {"pe": pe, "ids": ids, "amount": amt, "email": email, "name": name,
             "attendee_id": aid, "date": when})

    out = []
    for key, pays in groups.items():
        attendee_ids = {p["attendee_id"] for p in pays if p["attendee_id"]}
        if len(pays) <= len(attendee_ids):
            continue                                   # every seat already has a badge
        held = [c.execute("""select id, first_name, last_name, coalesce(email,''), ticket_type_id
                             from attendees where id=? and event_id=?""", (a, EVENT)).fetchone()
                for a in attendee_ids]
        held = [h for h in held if h]
        if not held:
            continue                                   # not a 2026 badge; leave it alone
        taken = [("%s %s" % (h[1] or "", h[2] or "")).strip() for h in held]
        for p in pays:
            if not p["name"]:
                continue
            # Already represented? A name a spelling apart is the same human.
            if any(main._same_person(p["name"], t) for t in taken):
                continue
            taken.append(p["name"])                    # so two payments by one name make one row
            parts = p["name"].strip().split()
            out.append({
                "party_size": len(pays),
                "seat_no": len(taken),
                "seat_of_party": "%d of %d" % (len(taken), len(pays)),
                "buyer_key": key,
                "alongside": held[0][0],
                "alongside_name": ("%s %s" % (held[0][1] or "", held[0][2] or "")).strip(),
                "first_name": parts[0] if parts else p["name"],
                "last_name": " ".join(parts[1:]) if len(parts) > 1 else "",
                "email": p["email"] or held[0][3],
                "shared_email": not p["email"] or p["email"] == (held[0][3] or "").lower(),
                "ticket_type_id": ticket_type_for(c, p["ids"], tt) or held[0][4],
                "payment": p["pe"], "amount": p["amount"], "date": p["date"],
            })
    raw.close()
    return out


def main_cli():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    rows = plan()

    print("SEATS PAID FOR THAT HAVE NO BADGE — %d to rebuild\n" % len(rows))
    parties = {}
    for r in rows:
        parties.setdefault(r["alongside_name"], []).append(r)
    for buyer, seats in sorted(parties.items()):
        print("  %s — %d seats bought, %d badge%s to add"
              % (buyer, seats[0]["party_size"], len(seats), "" if len(seats) == 1 else "s"))
        print("      seat 1 of %d   %-26s (already has a badge)" % (seats[0]["party_size"], buyer[:26]))
        for r in seats:
            print("      seat %-8s %-26s %-34s $%s"
                  % (r["seat_of_party"], (r["first_name"] + " " + r["last_name"])[:26],
                     (r["email"] or "")[:34], r["amount"] or 0))
        print()
    shared = [r for r in rows if r["shared_email"]]
    if shared:
        print("\n%d share the buyer's e-mail; they get a +seat2 address so both can claim a card:"
              % len(shared))
        for r in shared[:6]:
            print("   %s" % (r["first_name"] + " " + r["last_name"]))

    if not args.apply:
        print("\nDRY RUN — nothing created. Add --apply.")
        return 0

    s = SessionLocal()
    made = 0
    for r in rows:
        email = (r["email"] or "").lower()
        if r["shared_email"] and "@" in email:
            local, _, domain = email.partition("@")
            email = "%s+seat%d@%s" % (local, r["payment"], domain)
        now = datetime.utcnow().isoformat()
        a = models.Attendee(
            event_id=EVENT, email=email,
            first_name=r["first_name"], last_name=r["last_name"],
            ticket_type_id=r["ticket_type_id"],
            registration_status="registered", attendance_type="paid",
            registration_source="rebuilt_seat",
            qr_code="ATT-%s" % uuid.uuid4().hex[:12].upper(),
            custom_data={
                "source": "rebuilt_seat",
                # The whole party is findable under the name that BOUGHT it:
                # at a door somebody says "I'm with the Ison booking", not
                # "I am seat three".
                "bought_by": r["alongside_name"],
                "bought_by_attendee": r["alongside"],
                "seat_of_party": r["seat_of_party"],
                "needs_name_check": True,
                "lifecycle": [{"ts": now, "action": "seat_rebuilt", "actor": "rebuild_missing_seats",
                               "reason": ("Paid seat with no badge. Payment %d ($%s, %s) was attached to "
                                          "attendee %d alongside their own, so this person had no row. "
                                          "Rebuilt from the name on their own payment."
                                          % (r["payment"], r["amount"], r["date"], r["alongside"])),
                               "from_payment": r["payment"], "alongside": r["alongside"]}],
            })
        s.add(a); s.flush()
        pe = s.get(models.PaymentEvent, r["payment"])
        if pe:
            pe.attendee_id = a.id                       # the seat now points at its own badge
        made += 1
        print("  created id=%-4d %-26s <%s>" % (a.id, (a.first_name + " " + a.last_name)[:26], a.email))
    s.commit()
    main._ensure_public_tokens()
    s.close()
    print("\n%d rows created." % made)
    return 0


if __name__ == "__main__":
    sys.exit(main_cli())
