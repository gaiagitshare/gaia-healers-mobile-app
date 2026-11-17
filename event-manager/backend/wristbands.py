# -*- coding: utf-8 -*-
"""Which wristband the desk hands over at check-in (17 Nov 2026).

    GREEN   super VIP: VIP room and lunch          -> a VIP pass
    PURPLE  workshop                               -> a pass that includes workshops
    YELLOW  speaker room and exhibit hall          -> a pass that includes the conference,
                                                      or the One-Day Speaker add-on (upgraded to 3 days)
    RED     Susanne's workshop (an extra band)     -> bought one of the event's RED products
    none    exhibit hall only (General Admission, day exhibit passes), exhibitor staff,
            speakers and volunteers (their badge is enough)

Read from what each pass GRANTS (is_vip / grants_workshops / grants_conference),
never from its name, so a pass renamed or added later lands in the right colour.
"""
import json

import models

BANDS = {
    "green": "GREEN — Super VIP (VIP room + lunch)",
    "purple": "PURPLE — Workshop",
    "yellow": "YELLOW — Speaker room + exhibit hall",
    "red": "RED — Susanne's workshop",
}
NO_BAND_TYPES = ("speaker", "staff", "exhibitor")


def _red_products(event):
    raw = getattr(event, "wristband_red_product_ids", None) or []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = [raw]
    return {str(x).strip() for x in raw if str(x or "").strip()}


def for_attendee(db, attendee, event):
    """-> [{"color", "label"}]; empty = no wristband."""
    out = []
    if (attendee.attendance_type or "") not in NO_BAND_TYPES:
        tt = db.query(models.TicketType).filter(models.TicketType.id == attendee.ticket_type_id).first() \
            if attendee.ticket_type_id else None
        one_day = any(e.get("addon_code") == "ONE_DAY_CONFERENCE" and e.get("status", "paid") == "paid"
                      for e in ((attendee.custom_data or {}).get("entitlements") or []))
        if tt is not None and tt.is_vip:
            out.append("green")
        elif tt is not None and tt.grants_workshops:
            out.append("purple")
        elif (tt is not None and tt.grants_conference) or one_day:
            out.append("yellow")
    red = _red_products(event)
    if red:
        q = db.query(models.PaymentEvent).filter(models.PaymentEvent.status == "paid")
        mine = q.filter(models.PaymentEvent.attendee_id == attendee.id).all()
        if attendee.email:
            mine += q.filter(models.PaymentEvent.buyer_email == attendee.email.lower()).all()
        for pe in mine:
            ids = pe.product_ids if isinstance(pe.product_ids, list) else json.loads(pe.product_ids or "[]")
            if red & {str(i) for i in ids}:
                out.append("red")
                break
    return [{"color": c, "label": BANDS[c]} for c in out]
