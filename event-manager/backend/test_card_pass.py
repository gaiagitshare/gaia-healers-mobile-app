# -*- coding: utf-8 -*-
"""WHAT DID I ACTUALLY BUY?

The badge card answered everything except the one thing its owner opens it to
find out. It said "Attending Gaia Healers Elevate Conference 2026" and stopped
there, so a VIP card and a Friday-only card were word for word identical — and
the person holding one had no way to check what they had paid for short of
finding the receipt.

The pass now sits on the card, in the same words the door uses, read from the
same resolver — so a card can never describe access the scanner would refuse.
That is the whole point of it coming from there: two sources would eventually
disagree, and the one somebody reads on their phone is not the one that opens
the door.

Two silences are deliberate and are pinned here. A card whose event has been
archived says nothing about a pass, because last year's ticket is not a thing
anybody holds now. And a card whose attendee rows are gone entirely still
renders — the badge in somebody's drawer keeps working after its event is
deleted, and it simply has no pass to describe.

Read-only against the live API. Nothing is created or changed.
Run:  python3 /root/event/backend/test_card_pass.py
"""
import json, sqlite3, sys, urllib.request

HERE = "/root/event/backend"
BASE = "http://127.0.0.1:8002"
db = sqlite3.connect("file:%s/event.db?mode=ro" % HERE, uri=True)
db.row_factory = sqlite3.Row

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def card(token, fmt=""):
    return urllib.request.urlopen("%s/c/%s%s" % (BASE, token, fmt), timeout=30).read().decode()

def card_json(token):
    return json.loads(card(token, ".json"))

def token_for(pass_name):
    r = db.execute("""select a.public_token from attendees a
                      join ticket_types t on t.id = a.ticket_type_id
                      where a.event_id=1 and t.name=? and a.public_token is not null limit 1""",
                   (pass_name,)).fetchone()
    return r[0] if r else None

print("\nTHE CARD SAYS WHAT THEY HOLD")
seen = {}
for pass_name in ("VIP Pass", "General Admission + Conference", "General Admission",
                  "Friday Exhibit Hall", "Workshop Access"):
    tok = token_for(pass_name)
    if not tok:
        print("     (nobody holds %s)" % pass_name)
        continue
    j = card_json(tok)
    seen[pass_name] = j.get("pass_display")
    check(bool(j.get("pass_display")), "%s is named on the card" % pass_name, j.get("pass_display"))
    check(bool(j.get("pass_includes")), "  and says what it includes", j.get("pass_includes"))
    check((j.get("pass_display") or "no-such-text") in card(tok),
          "  and it is on the page, not only in the data")
    print("     %-32s %s" % (j.get("pass_display"), j.get("pass_includes")))

print("\nTWO PASSES NEVER READ THE SAME")
vals = [v for v in seen.values() if v]
check(len(set(vals)) == len(vals), "every pass on the roll renders differently", seen)
if seen.get("Friday Exhibit Hall"):
    check("Friday" in seen["Friday Exhibit Hall"],
          "a day pass says which day on the card itself", seen["Friday Exhibit Hall"])

print("\nIT AGREES WITH THE DOOR")
sys.path.insert(0, HERE)
import main, models                                            # noqa: E402
from database import SessionLocal                              # noqa: E402
s = SessionLocal()
mismatch = []
for pass_name, shown in seen.items():
    tok = token_for(pass_name)
    a = s.query(models.Attendee).filter(models.Attendee.public_token == tok,
                                        models.Attendee.event_id == 1).first()
    if a is not None and main._pass_display(s, a) != shown:
        mismatch.append((pass_name, shown, main._pass_display(s, a)))
check(not mismatch, "the card and the door read the same resolver", mismatch)

print("\nWHAT THE CARD DELIBERATELY DOES NOT SAY")
r = db.execute("""select a.public_token from attendees a where a.event_id=2 and a.public_token is not null
                  and not exists(select 1 from attendees b
                                 where b.public_token=a.public_token and b.event_id=1) limit 1""").fetchone()
if r:
    j = card_json(r[0])
    check("2025" in (j.get("event_name") or ""), "an archived event still labels its card", j.get("event_name"))
    check(not j.get("pass_display"),
          "but says nothing about a pass — last year's ticket is not a thing anybody holds",
          j.get("pass_display"))

r2 = db.execute("""select public_token from member_cards
                   where public_token not in (select coalesce(public_token,'') from attendees) limit 1""").fetchone()
if r2:
    check("digital badge" in card(r2[0]), "a card whose attendee rows are gone still renders")
    check(not card_json(r2[0]).get("pass_display"), "  with no pass to describe")

print("\nAND IT IS NOT LEAKING ANYTHING ELSE")
tok = token_for("VIP Pass")
if tok:
    j = card_json(tok)
    a = s.query(models.Attendee).filter(models.Attendee.public_token == tok,
                                        models.Attendee.event_id == 1).first()
    html = card(tok)
    check(a.email not in html, "the card still does not show the email address")
    check(not a.phone or a.phone not in html, "nor the phone number")
    check("$" not in (j.get("pass_includes") or ""), "nor what anybody paid")
s.close()

print("\n" + ("ALL GOOD" if not fails else "FAILED: " + "; ".join(fails)))
sys.exit(1 if fails else 0)
