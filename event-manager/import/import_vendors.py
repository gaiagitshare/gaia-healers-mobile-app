# -*- coding: utf-8 -*-
"""Import the 2026 confirmed exhibitors from the planning sheet.

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
rows = json.load(open("/root/vendors.json"))
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
    ex.booth_number = v["booth"] or None
    ex.package = v["package"] or None
    ex.payment_status = v["payment_status"]
    ex.amount_due = v["amount_due"]
    ex.amount_paid = v["amount_paid"]
    ex.payment_note = v["payment_note"] or None
    ex.category = "Gaia Healers" if (v["package"] or "").startswith("Gaia") else (
        "Partner" if (v["package"] or "") == "Partners" else "Exhibitor")
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
print("%-28s %-9s %8s %8s %-10s %s" % ("company", "status", "due", "paid", "published", "scan"))
print("-" * 80)
for r in rows:
    print("%-28s %-9s %8s %8s %-10s %s" % (
        (r.company_name or "")[:28], r.payment_status,
        int(r.amount_due) if r.amount_due else "-",
        int(r.amount_paid) if r.amount_paid else "-",
        "yes" if r.is_published else "no", "yes" if r.can_scan_leads else "no"))
print("-" * 80)
print("%d exhibitors on event %d" % (len(rows), EVENT_ID))
db.close()
