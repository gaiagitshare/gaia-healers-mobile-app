# -*- coding: utf-8 -*-
"""Import the vendor board from the planning sheet -- every section, not just
the confirmed ones.

Prospects, maybes and refusals share the list with the confirmed stands,
separated only by a heading. That is the right shape: a maybe becomes confirmed
the day they pay. Carrying it across means the whole board is in one place and
nobody re-types a vendor on conversion.

Idempotent on (event, company name): re-running updates rather than duplicating.
Everything arrives UNPUBLISHED with scanning OFF -- the sheet is a planning
document, and what goes into the attendee directory or gets a working scanner
is a decision somebody makes on this screen, not a side effect of an import.

The free-text payment column is preserved verbatim in payment_note. The parsed
status beside it is an interpretation, and the original is kept so nobody has to
trust the parser.
"""
import json, sys
sys.path.insert(0, "/root/event/backend")
from database import SessionLocal
import models, secrets

EVENT_ID = 1
rows = json.load(open("/root/vendors_all.json"))
db = SessionLocal()
created = updated = 0
for v in rows:
    ex = db.query(models.Exhibitor).filter(
        models.Exhibitor.event_id == EVENT_ID,
        models.Exhibitor.company_name == v["company"]).first()
    if ex is None:
        ex = models.Exhibitor(event_id=EVENT_ID, company_name=v["company"],
                              access_token=secrets.token_urlsafe(18))
        db.add(ex); created += 1
    else:
        updated += 1
    ex.contact_email = v["email"] or ""
    ex.contact_phone = v["phone"] or None
    ex.website = v["website"] or None
    b = (v["booth"] or "").strip()
    # A booth is a label, not a quantity — the sheet stores some numerically.
    ex.booth_number = (b[:-2] if b.endswith(".0") else b) or None
    ex.stage = v["stage"]
    if v.get("tables") is not None:
        ex.tables = int(v["tables"])
    ex.package = v["package"] or None
    ex.payment_status = v["payment_status"]
    ex.amount_due = v["amount_due"]
    ex.amount_paid = v["amount_paid"]
    ex.payment_note = v["payment_note"] or None
    ex.category = "Gaia Healers" if (v["package"] or "").startswith("Gaia") else (
        "Partner" if (v["package"] or "") == "Partners" else "Exhibitor")
    if not (v.get("contact") or "").strip():
        pass
    if ex.description is None:
        ex.description = ""
    # Deliberately NOT set here: is_published, can_scan_leads, show_contact_publicly.
    # A new row gets the column default (off); an existing row keeps whatever a
    # human already chose, so re-running the import cannot unpublish a stand.
db.commit()

print("created %d, updated %d" % (created, updated))
print()
rows = db.query(models.Exhibitor).filter(models.Exhibitor.event_id == EVENT_ID).order_by(
    models.Exhibitor.company_name).all()
from collections import Counter
by = Counter(r.stage or "confirmed" for r in rows)
print("%-18s %6s %10s %10s" % ("stage", "count", "booked", "collected"))
print("-" * 48)
for st in ("confirmed", "waiting", "unsure", "other", "product_sponsor",
           "next_year", "not_attending", "not_aligned"):
    grp = [r for r in rows if (r.stage or "confirmed") == st]
    if not grp:
        continue
    print("%-18s %6d %10s %10s" % (st, len(grp),
          int(sum(r.amount_due or 0 for r in grp)) or "-",
          int(sum(r.amount_paid or 0 for r in grp)) or "-"))
print("-" * 48)
print("%-18s %6d %10d %10d" % ("TOTAL", len(rows),
      sum(r.amount_due or 0 for r in rows), sum(r.amount_paid or 0 for r in rows)))
live = [r for r in rows if r.is_published or r.can_scan_leads]
print("\npublished or scanning: %d" % len(live))
db.close()
