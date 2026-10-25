# -*- coding: utf-8 -*-
"""Erika Cunningham's VIP: link her second GHL contact, and flag two VIP buyers for a call.

On 22 Oct 2026 at 00:27 UTC Erika D Cunningham paid $1,058.94 (PayPal) for the
VIP PASS, order 6ad95876fac91c38b383f9c5. She already held a $99 General
Admission ticket (attendee 225, GHL contact Oj76CoyFtTlCnjjWM2va,
erikad_513@yahoo.com) but checked out under a second GHL contact,
tipIMGG9QiM0rnmAePoG, created 20 Oct with a phone and no email. The mirror
skipped the order for having no email, so no ticket moved and the money read
"paid, no ticket".

Four minutes later Sarah Brooker (attendee 202) did the same thing -- GA in
June, full-price VIP on 22 Oct -- on her own contact, and the reconciler gave
her VIP on her one badge.

Organiser's decision (Babak, 25 Oct): treat Erika's like Sarah's -- her
upgrade, on badge 225 -- and flag both for a confirm call.

This tool does the identity part only:
  * 225 gets linked_contact_ids = [tipIMGG9QiM0rnmAePoG], with a lifecycle note
  * 225 and 202 each get a `confirm_with_buyer` entry (review queue item)
The order itself is then reconciled by the normal path (the mirror, or one
contact-only POST to /identity/reconcile-attendee), which now resolves a
contact-only order to the one ticket holder that contact belongs to. No QR,
token, email, status or ticket type is touched here.

  python3 tools/fix_cunningham.py           # dry run
  python3 tools/fix_cunningham.py --apply   # write it (honours DATABASE_URL)
"""
import json, os, sqlite3, sys
from datetime import datetime

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DBURL = os.environ.get("DATABASE_URL", "")
DB = _DBURL.split("sqlite:///", 1)[1] if _DBURL.startswith("sqlite:///") else os.path.join(HERE, "event.db")
APPLY = "--apply" in sys.argv

ERIKA, SARAH = 225, 202
ERIKA_OLD_CONTACT, ERIKA_NEW_CONTACT = "Oj76CoyFtTlCnjjWM2va", "tipIMGG9QiM0rnmAePoG"
ERIKA_ORDER, SARAH_ORDER = "6ad95876fac91c38b383f9c5", "6ad95963e63c996682ac84c1"
VIP_AMOUNT = 1058.94

db = sqlite3.connect(DB, timeout=30); db.row_factory = sqlite3.Row
rows = {r["id"]: r for r in db.execute("SELECT * FROM attendees WHERE id IN (?, ?)", (ERIKA, SARAH))}
erika, sarah = rows[ERIKA], rows[SARAH]
ed, sd = json.loads(erika["custom_data"] or "{}"), json.loads(sarah["custom_data"] or "{}")

# Refuse unless the world is as investigated on 25 Oct.
assert erika["event_id"] == sarah["event_id"] == 1
assert (erika["last_name"] or "").endswith("Cunningham") and (sarah["last_name"] or "") == "Brooker"
assert ed.get("contact_id") == ERIKA_OLD_CONTACT, "225 is no longer on Erika's June contact; stop"
assert any(e.get("order_id") == SARAH_ORDER and e.get("ticket_type_id") == 4 for e in sd.get("entitlements") or []), \
    "Sarah's VIP order is not on 202; stop"
others = [r["id"] for r in db.execute("SELECT id, custom_data FROM attendees WHERE event_id=1")
          if r["id"] != ERIKA and ERIKA_NEW_CONTACT in (r["custom_data"] or "")]
assert not others, ("the new contact already sits on another attendee; stop", others)

now = datetime.utcnow().isoformat()
changed = []

linked = list(ed.get("linked_contact_ids") or [])
if ERIKA_NEW_CONTACT not in linked:
    linked.append(ERIKA_NEW_CONTACT)
    ed["linked_contact_ids"] = linked
    ed.setdefault("lifecycle", []).append({"ts": now, "action": "contact_linked", "actor": "fix_cunningham",
        "reason": ("GHL contact %s (created 20 Oct, phone only, no email) is Erika too: she paid $1,058.94 "
                   "for VIP under it on 22 Oct. Linked by the organiser's decision of 25 Oct, so orders "
                   "and payments under that contact land on this badge." % ERIKA_NEW_CONTACT),
        "contact_id": ERIKA_NEW_CONTACT})
    changed.append("225 linked to %s" % ERIKA_NEW_CONTACT)


def flag(cd, order_id, reason):
    if any(l.get("action") == "confirm_with_buyer" and l.get("order_id") == order_id
           for l in cd.get("lifecycle") or []):
        return False
    cd.setdefault("lifecycle", []).append({"ts": now, "action": "confirm_with_buyer", "actor": "fix_cunningham",
                                            "order_id": order_id, "amount": VIP_AMOUNT, "reason": reason})
    return True


if flag(ed, ERIKA_ORDER, "Held GA ($99, June) and paid the full VIP price ($1,058.94, 22 Oct, PayPal) under a "
        "second GHL contact with no email. Applied as her own VIP upgrade, like Sarah Brooker's four minutes "
        "later. Ask: was the VIP for her, or for somebody else? If someone else, add a seat for them. "
        "Also ask whether she expects the $99 back. Her June phone is +1 321-765-7183, the VIP order's is "
        "+1 407-668-8597."):
    changed.append("225 flagged confirm_with_buyer")
if flag(sd, SARAH_ORDER, "Held GA ($99, June) and paid the full VIP price ($1,058.94, 22 Oct) on the same account. "
        "Applied as her own VIP upgrade. Ask: was the VIP for her, or for somebody else? If someone else, add "
        "a seat for them. Also ask whether she expects the $99 back."):
    changed.append("202 flagged confirm_with_buyer")

if not changed:
    print("Already done."); sys.exit(0)
print("\n".join(changed))
if not APPLY:
    print("\nDry run. Add --apply to write."); sys.exit(0)
db.execute("UPDATE attendees SET custom_data=? WHERE id=?", (json.dumps(ed), ERIKA))
db.execute("UPDATE attendees SET custom_data=? WHERE id=?", (json.dumps(sd), SARAH))
db.commit()
print("\nApplied.")
