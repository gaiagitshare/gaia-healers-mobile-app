# -*- coding: utf-8 -*-
"""Fill vendor listings from each company's OWN public website.

Everything written here is already published by the company: the description on
its homepage, the address and switchboard on its contact page, and the logo it
gave us for the event site.

What is NOT written here is the sheet's email and phone. Those belong to the
person who booked the booth and are frequently a personal mobile; publishing
them in an attendee directory would be handing out somebody's private number.
They stay in contact_email/contact_phone, which the organiser sees and the
directory does not.

Never overwrites something a human already wrote. Re-runnable.
"""
import json, sys
sys.path.insert(0, "/root/event/backend")
from database import SessionLocal
import models

EVENT_ID = 1
data = json.load(open("/root/enrich.json"))
db = SessionLocal()
touched = skipped = 0
for company, r in data.items():
    ex = db.query(models.Exhibitor).filter(
        models.Exhibitor.event_id == EVENT_ID,
        models.Exhibitor.company_name == company).first()
    if ex is None:
        print("  no such vendor: %s" % company); continue
    before = (ex.description, ex.logo_url, ex.public_email, ex.public_phone, ex.tagline, ex.address)
    if r.get("description") and not (ex.description or "").strip():
        ex.description = r["description"][:1200]
    if r.get("tagline") and not (ex.tagline or "").strip():
        ex.tagline = r["tagline"][:160]
    if r.get("logo_url") and not (ex.logo_url or "").strip():
        ex.logo_url = r["logo_url"]
    if r.get("public_email") and not (ex.public_email or "").strip():
        ex.public_email = r["public_email"][:160]
    if r.get("public_phone") and not (ex.public_phone or "").strip():
        ex.public_phone = r["public_phone"][:40]
    if r.get("address") and not (ex.address or "").strip():
        ex.address = r["address"][:200]
    # The website column held an email address for a few of these. A directory
    # link that opens a mail client is a broken link.
    w = (ex.website or "").strip()
    if "@" in w and "/" not in w:
        ex.website = None
    elif w and not w.startswith(("http://", "https://")):
        ex.website = "https://" + w
    after = (ex.description, ex.logo_url, ex.public_email, ex.public_phone, ex.tagline, ex.address)
    if before != after:
        touched += 1
    else:
        skipped += 1
db.commit()

rows = db.query(models.Exhibitor).filter(
    models.Exhibitor.event_id == EVENT_ID,
    models.Exhibitor.stage.in_(("confirmed", "other", "product_sponsor"))).order_by(
    models.Exhibitor.company_name).all()
print("updated %d, already had content %d\n" % (touched, skipped))
print("%-28s %-5s %-5s %-5s %-6s %-6s %s" % ("company", "logo", "tag", "desc", "email", "phone", "site"))
print("-" * 74)
full = 0
for r in rows:
    bits = [bool(r.logo_url), bool(r.tagline), bool(r.description), bool(r.public_email),
            bool(r.public_phone), bool(r.website)]
    if bits[0] and bits[2]:
        full += 1
    print("%-28s %-5s %-5s %-5s %-6s %-6s %s" % (
        (r.company_name or "")[:28], *["yes" if b else "-" for b in bits]))
print("-" * 74)
print("%d of %d have both a logo and a description" % (full, len(rows)))
db.close()
