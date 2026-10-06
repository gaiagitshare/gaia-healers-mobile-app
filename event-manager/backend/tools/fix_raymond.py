# -*- coding: utf-8 -*-
"""Finish the Kay Raymond merge: her $99 base ticket onto the row her badge is.

On 28 Sep attendee 275 was ruled a duplicate of 274 (one person, one GHL
contact hWZxRkRG4kTEvDnlyuLj, one badge token) and revoked, and 274's log says
it "absorbed" 275. The entitlement was never moved: her Exhibit Pass order
69ffc0f196309439f99c0a46 still sits on the revoked 275, so her payment reads
"money received but the ticket is not valid for entry" and her live badge's
ledger is missing the ticket underneath her upgrade.

This does what fix_moreau did for Marie Moreau on 1 Oct, nothing more:
  * the entitlement is copied onto 274 (one attendee, one QR, combined ledger)
  * 275 gets duplicate_of = 274 and an empty ledger, and stays revoked
  * both rows get a lifecycle entry saying why
No QR, token, email, status or ticket type changes. 274 already admits all
three days (admin tier GA + Conference, the one-day comp), and still does.

  python3 tools/fix_raymond.py           # dry run: print what would change
  python3 tools/fix_raymond.py --apply   # write it (honours DATABASE_URL)
"""
import json, os, sqlite3, sys
from datetime import datetime

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DBURL = os.environ.get("DATABASE_URL", "")
DB = _DBURL.split("sqlite:///", 1)[1] if _DBURL.startswith("sqlite:///") else os.path.join(HERE, "event.db")
APPLY = "--apply" in sys.argv
KEEP, DUP, ORDER = 274, 275, "69ffc0f196309439f99c0a46"

db = sqlite3.connect(DB, timeout=30); db.row_factory = sqlite3.Row
rows = {r["id"]: r for r in db.execute("SELECT * FROM attendees WHERE id IN (?, ?)", (KEEP, DUP))}
keep, dup = rows[KEEP], rows[DUP]
kd, dd = json.loads(keep["custom_data"] or "{}"), json.loads(dup["custom_data"] or "{}")

# Refuse unless the world is exactly as investigated on 6 Oct.
assert keep["event_id"] == dup["event_id"] == 1
assert dup["registration_status"] == "revoked", "275 is no longer revoked; stop"
assert keep["public_token"] == dup["public_token"], "the two rows no longer share a badge token; stop"
assert kd.get("contact_id") == dd.get("contact_id"), "not the same GHL contact; stop"
moving = [e for e in dd.get("entitlements") or [] if e.get("order_id") == ORDER]
already = any(e.get("order_id") == ORDER for e in kd.get("entitlements") or [])
if already and not moving and dd.get("duplicate_of") == KEEP:
    print("Already done: 274 holds the order and 275 points at it."); sys.exit(0)
assert len(moving) == 1 and not already, ("unexpected ledger", moving, already)

now = datetime.utcnow().isoformat()
ent = dict(moving[0])
kd.setdefault("entitlements", []).append(ent)
kd.setdefault("lifecycle", []).append({"ts": now, "action": "entitlement_moved_from_duplicate", "actor": "fix_raymond",
    "reason": "Her Exhibit Pass ($99, order %s) was left on duplicate row 275 when the two were merged on 28 Sep. It now sits on this row, the one her badge resolves to, under her one-day upgrade and the organiser's three-day comp." % ORDER,
    "order_id": ORDER, "from_attendee": DUP})
dd["entitlements"] = [e for e in dd.get("entitlements") or [] if e.get("order_id") != ORDER]
dd["duplicate_of"] = KEEP
dd.setdefault("lifecycle", []).append({"ts": now, "action": "duplicate_of", "actor": "fix_raymond",
    "reason": "Duplicate row of the same person (merged 28 Sep). Pointer added so payments and orders under rtdtravels@gmail.com land on 274.", "duplicate_of": KEEP})
dd["lifecycle"].append({"ts": now, "action": "entitlement_moved_out", "actor": "fix_raymond",
    "reason": "Her Exhibit Pass now sits on attendee 274. This row is a duplicate of the same person and holds nothing.", "moved_to": KEEP})

print("274 entitlements:", [(e.get("order_id")[-6:], e.get("status"), e.get("ticket_type_id"), e.get("is_upgrade")) for e in kd["entitlements"]])
print("275 entitlements:", dd["entitlements"], " duplicate_of:", dd["duplicate_of"], " status stays:", dup["registration_status"])
if not APPLY:
    print("\nDry run. Add --apply to write."); sys.exit(0)
db.execute("UPDATE attendees SET custom_data=? WHERE id=?", (json.dumps(kd), KEEP))
db.execute("UPDATE attendees SET custom_data=? WHERE id=?", (json.dumps(dd), DUP))
db.commit()
print("\nApplied.")
