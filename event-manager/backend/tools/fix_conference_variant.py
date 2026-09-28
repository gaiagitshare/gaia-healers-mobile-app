# -*- coding: utf-8 -*-
"""Split one GHL product into the two things it is actually sold as.

Product 69b463a14181e967e2fc2cfe is sold under five names at four prices. Two of
them are exhibit hall only; three of them include the conference. One mapping
cannot be right for both, and the price cannot separate them -- $104.94 is sold
under both names -- so the mapping that exists resolves every one of them to
plain General Admission, and the people who paid for the conference hold a pass
that does not open it.

This adds a SECOND mapping for the same product that claims the conference
variants by name, and moves the people who already bought one onto the pass they
paid for. The original mapping is left exactly as it is: it is correct for the
exhibit-hall-only buyers, and repointing it would simply move the error onto
them instead.

Dry run by default. Nothing is written without --apply.
Run:  python3 /root/event/backend/tools/fix_conference_variant.py [--apply]
"""
import json, sys, os
sys.path.insert(0, "/root/event/backend")
os.chdir("/root/event/backend")

import main, models                                       # noqa: E402
from database import SessionLocal                         # noqa: E402

EVENT = 1
PRODUCT = "69b463a14181e967e2fc2cfe"
PATTERN = "+ CONFERENCE"          # the wording every conference variant carries
APPLY = "--apply" in sys.argv

s = SessionLocal()
conf_tt = s.query(models.TicketType).filter(
    models.TicketType.event_id == EVENT,
    models.TicketType.name == "General Admission + Conference").first()
assert conf_tt, "no General Admission + Conference pass on this event"

base = s.query(models.TicketMapping).filter(
    models.TicketMapping.event_id == EVENT,
    models.TicketMapping.external_product_id == PRODUCT,
    models.TicketMapping.product_name_match.is_(None)).first()
assert base, "the original mapping for this product is missing"

print("PRODUCT %s" % PRODUCT)
print("  existing mapping m%d  %-44s -> %s" % (
    base.id, (base.label or "")[:44],
    (s.get(models.TicketType, base.ticket_type_id).name if base.ticket_type_id else "?")))

# What this product has actually been sold as, and to whom.
variants = {}
for pe in s.query(models.PaymentEvent).filter(
        models.PaymentEvent.event_id == EVENT,
        models.PaymentEvent.status == "paid").all():
    pids = pe.product_ids if isinstance(pe.product_ids, (list, tuple)) else json.loads(pe.product_ids or "[]")
    if PRODUCT not in (pids or []):
        continue
    names = pe.product_names if isinstance(pe.product_names, (list, tuple)) else json.loads(pe.product_names or "[]")
    name = (names[0] if names else "").strip()
    v = variants.setdefault(name, {"payments": [], "amounts": set()})
    v["payments"].append(pe)
    v["amounts"].add(float(pe.amount or 0))

print("\n  SOLD AS:")
movers, keepers = [], []
for name, v in sorted(variants.items(), key=lambda kv: -len(kv[1]["payments"])):
    hits = PATTERN.upper() in name.upper()
    print("    %-58s %-22s %2d  -> %s" % (
        name[:58], ",".join("$%s" % a for a in sorted(v["amounts"])),
        len(v["payments"]), "GA + CONFERENCE" if hits else "General Admission (unchanged)"))
    for pe in v["payments"]:
        (movers if hits else keepers).append(pe)

print("\n  the pattern %r separates them: %d conference, %d exhibit-hall-only"
      % (PATTERN, len(movers), len(keepers)))

# Who needs their pass changed, and who already has it by another route.
change, already = [], []
for pe in movers:
    a = s.query(models.Attendee).filter(models.Attendee.id == pe.attendee_id).first() if pe.attendee_id else None
    if not a:
        continue
    tt = s.get(models.TicketType, a.ticket_type_id) if a.ticket_type_id else None
    (already if (tt and tt.grants_conference) else change).append((a, pe, tt))

print("\n  PEOPLE WHO PAID FOR THE CONFERENCE")
print("    already have it (from a separate upgrade): %d" % len(already))
for a, _pe, tt in already:
    print("       %-30s %s" % (("%s %s" % (a.first_name, a.last_name)).strip()[:30], tt.name))
print("    holding a pass that does not open it     : %d" % len(change))
for a, pe, tt in sorted(change, key=lambda r: (r[0].last_name or "")):
    print("       %-30s $%-9s %-11s %s" % (
        ("%s %s" % (a.first_name, a.last_name)).strip()[:30], pe.amount, (pe.occurred_at or "")[:10] if isinstance(pe.occurred_at, str) else str(pe.occurred_at)[:10],
        (tt.name if tt else "(no pass)")))

# Nothing must move that did not buy a conference variant.
bad = [pe for pe in keepers if pe.attendee_id and any(pe.attendee_id == a.id for a, _, _ in change)]
print("\n  exhibit-hall-only buyers caught up in this: %d %s"
      % (len(bad), "(must be 0)" if not bad else "<-- REFUSING"))
if bad:
    sys.exit("refusing: an exhibit-hall-only buyer would be given conference access")

if not APPLY:
    print("\nDRY RUN. Nothing written. Re-run with --apply to:")
    print("  1. add a mapping for product %s matching %r -> %s" % (PRODUCT, PATTERN, conf_tt.name))
    print("  2. move %d people onto %s (audited)" % (len(change), conf_tt.name))
    sys.exit(0)

existing = s.query(models.TicketMapping).filter(
    models.TicketMapping.event_id == EVENT,
    models.TicketMapping.external_product_id == PRODUCT,
    models.TicketMapping.product_name_match == PATTERN).first()
if existing:
    print("\n  mapping already present (m%d)" % existing.id)
else:
    m = models.TicketMapping(
        event_id=EVENT, provider=base.provider, external_product_id=PRODUCT,
        external_price_id=None, ticket_type_id=conf_tt.id, is_upgrade=False,
        label="GENERAL ADMISSION + CONFERENCE (name variant)",
        is_active=True, entitlement_type="EVENT_TICKET",
        product_name_match=PATTERN,
        valid_from=base.valid_from, valid_until=base.valid_until)
    s.add(m); s.flush()
    print("\n  added mapping m%d for the conference variant" % m.id)

moved = 0
for a, pe, tt in change:
    old = a.ticket_type_id
    a.ticket_type_id = conf_tt.id
    cd = dict(a.custom_data or {})
    cd["admin_tier"] = conf_tt.id
    a.custom_data = cd
    main._lifecycle_append(
        a, "pass_corrected", actor="fix_conference_variant",
        reason=("Paid for \\u201c%s\\u201d, which includes the conference, but the product was "
                "mapped to a pass that does not. Moved onto the pass that was bought."
                % (next(iter([n for n in variants if PATTERN.upper() in n.upper()
                              and pe in variants[n]['payments']]), 'GENERAL ADMISSION + CONFERENCE'))),
        from_tt=old, to_tt=conf_tt.id, from_payment=pe.id)
    moved += 1
s.commit()
print("  moved %d people onto %s" % (moved, conf_tt.name))
main._ensure_public_tokens()
print("done")
