# -*- coding: utf-8 -*-
"""LEDGER INTEGRITY — entitlements must belong to exactly one Gaia event.

Separating the attendee rows by year was not enough: the transaction history
travelled with the rows, so 2025 purchases sat inside the 2026 event and
inflated its numbers. Ownership is now stamped on each entitlement, and this
test refuses to let it drift again.

Run:  python3 /root/event/backend/test_ledger_integrity.py
"""
import json, sqlite3, sys
from collections import defaultdict

DB = "/root/event/backend/event.db"
fails = []
def check(name, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + name + (("  -- " + detail) if detail and not ok else ""))
    if not ok: fails.append(name)

c = sqlite3.connect(DB)
events = dict(c.execute("SELECT id,name FROM events").fetchall())
order_owner = defaultdict(set)
per_event = defaultdict(lambda: {"attendees": 0, "entries": 0, "mismatch": 0, "unstamped": 0})

for aid, ev, cd in c.execute("SELECT id,event_id,custom_data FROM attendees"):
    per_event[ev]["attendees"] += 1
    try: d = json.loads(cd or "{}")
    except Exception: d = {}
    for e in (d.get("entitlements") or []):
        per_event[ev]["entries"] += 1
        owner = e.get("event_id")
        if owner is None:
            per_event[ev]["unstamped"] += 1
        elif owner != ev:
            per_event[ev]["mismatch"] += 1
        if e.get("order_id"):
            order_owner[e["order_id"]].add(ev)

print("LEDGER INTEGRITY")
for ev in sorted(per_event):
    s = per_event[ev]
    print("  event %-3s %-46s attendees=%-5s entries=%s" % (ev, (events.get(ev) or "?")[:46], s["attendees"], s["entries"]))

# 1. every entitlement names the event that owns it
tot_unstamped = sum(s["unstamped"] for s in per_event.values())
check("every entitlement carries an event_id", tot_unstamped == 0, "%d unstamped" % tot_unstamped)

# 2. and it matches the attendee row holding it
tot_mismatch = sum(s["mismatch"] for s in per_event.values())
check("entitlement.event_id == attendee.event_id", tot_mismatch == 0, "%d mismatched" % tot_mismatch)

# 3. one GHL order must not grant access to two different events
shared = {o: evs for o, evs in order_owner.items() if len(evs) > 1}
check("no GHL order_id spans multiple events", not shared,
      "%d shared: %s" % (len(shared), list(shared.items())[:3]))

# 4. an order may appear only once inside a given event
dupes = 0
for ev in per_event:
    seen = set()
    for aid, cd in c.execute("SELECT id,custom_data FROM attendees WHERE event_id=?", (ev,)):
        try: d = json.loads(cd or "{}")
        except Exception: d = {}
        for e in (d.get("entitlements") or []):
            k = (ev, e.get("order_id"))
            if e.get("order_id"):
                if k in seen: dupes += 1
                seen.add(k)
check("no duplicate order_id within one event", dupes == 0, "%d duplicates" % dupes)

# 5. every entitlement points at a ticket type belonging to that same event
bad_tt = 0
tt_event = dict(c.execute("SELECT id,event_id FROM ticket_types").fetchall())
for aid, ev, cd in c.execute("SELECT id,event_id,custom_data FROM attendees"):
    try: d = json.loads(cd or "{}")
    except Exception: d = {}
    for e in (d.get("entitlements") or []):
        t = e.get("ticket_type_id")
        if t and tt_event.get(t) not in (None, ev): bad_tt += 1
check("entitlement ticket types belong to that event", bad_tt == 0, "%d cross-event ticket types" % bad_tt)

c.close()
print()
print(("FAILED: " + ", ".join(fails)) if fails else "ALL CHECKS PASSED - no cross-event contamination")
sys.exit(1 if fails else 0)
