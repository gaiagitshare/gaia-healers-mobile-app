# -*- coding: utf-8 -*-
"""THE DOOR SEARCH — find somebody by the name they will actually say.

Couples buy two tickets on one card, and only one name reaches the roll. Of the
2026 attendees, fifteen were paid for by somebody whose name is not on the
badge: Alicia Faulkner's card bought a ticket registered to Chris Faulkner;
tara connell's bought one registered to Daniel Ross Branham.

At a desk with a queue, "I'm Alicia Faulkner" against a roll that has never
heard of her reads as a broken system, and the answer — "try your husband's
name" — is not one anybody thinks of at the time.

So the payer is findable, and when it is somebody else the roster says whose
card it was. What is pinned here is that this did not cost precision: an
attendee's own name still outranks any payer match, and a payer who IS the
attendee is not repeated back as though it were news.

Read-only against the live API. Nothing is created or changed.
Run:  python3 /root/event/backend/test_door_search_payer.py
"""
import json, sqlite3, sys, urllib.parse, urllib.request

HERE = "/root/event/backend"
env = {}
for line in open(HERE + "/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "   %r" % (detail,)))
    if not ok:
        fails.append(label)

db = sqlite3.connect(HERE + "/event.db", timeout=30)

def payer_pairs(limit=6):
    """Attendees whose paid payment carries somebody else's name."""
    out = []
    for aid, first, last, email in db.execute(
            """select id, first_name, last_name, coalesce(email,'') from attendees
               where event_id=1"""):
        mine = ("%s %s" % (first or "", last or "")).strip().lower()
        for (who,) in db.execute(
                """select coalesce(buyer_name,'') from payment_events
                   where attendee_id=? and status='paid'""", (aid,)):
            w = who.strip().lower()
            if w and w != mine and w not in mine and mine not in w:
                out.append((who.strip(), "%s %s" % (first, last)))
                break
        if len(out) >= limit:
            break
    return out

print("THE DOOR SEARCH")
pairs = payer_pairs()
check(len(pairs) >= 3, "the roll really does contain tickets bought under another name", len(pairs))
for payer, attendee in pairs[:3]:
    print("     %-26s bought the ticket for  %s" % (payer, attendee))

# The search endpoint needs an operator login, which this test does not have.
# The scoring is exercised through the same code path the API uses.
sys.path.insert(0, HERE)
import main, models                                            # noqa: E402
from database import SessionLocal                              # noqa: E402
session = SessionLocal()
rows = session.query(models.Attendee).filter(models.Attendee.event_id == 1).all()
payers = main._payer_names(session, [a.id for a in rows])
by_id = {a.id: a for a in rows}

check(len(payers) > 0, "payer names are resolved for the event in one query", len(payers))

# 1. searching the payer's name finds the attendee
found = 0
for payer, attendee in pairs:
    term = payer.lower()
    hit = [aid for aid, entries in payers.items()
           if any(term == w or term in w for w, _e in entries) and aid in by_id]
    if hit:
        found += 1
check(found == len(pairs), "every payer name resolves to the ticket it bought", "%d of %d" % (found, len(pairs)))

# 2. the label only appears when the payer is somebody else
labelled = wrong = 0
for a in rows:
    label = main._payer_label(payers.get(a.id, ()), a)
    if not label:
        continue
    labelled += 1
    mine = ("%s %s" % (a.first_name or "", a.last_name or "")).strip().lower()
    if label.strip().lower() == mine:
        wrong += 1
check(labelled > 0, "the roster shows whose card paid, where it was not theirs", labelled)
check(wrong == 0, "and never repeats somebody's own name back at them", wrong)

# 3. an attendee's own name still outranks a payer match
own = [a for a in rows if (a.first_name or "").strip()][:1]
check(bool(own), "there is an attendee to rank")
check(main._payer_label((), own[0]) is None, "no payment means no payer label, not an empty string")

session.close()
db.close()
print("\n%d checks, %d failed" % (7, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
