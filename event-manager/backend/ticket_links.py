# -*- coding: utf-8 -*-
"""Private ticket links (9 Nov 2026).

The ticket page (/ticket/<code>), its QR image (/t/<code>.png) and the wallet
link used to be keyed by the person's PUBLIC badge/card code -- the code on the
printed badge and in the app's Share button -- so a shared profile link also
opened the ticket and its entry QR.

Ticket links are now keyed by a code derived from the ticket's own entry code
with the server secret: nothing new is stored, no entry QR changes, and the
public badge/card code no longer opens a ticket. Rotating SECRET_KEY changes
every ticket link (the entry codes stay valid).
"""
import base64
import hashlib
import hmac
import re

LINK_RE = re.compile(r"^[A-Za-z0-9_-]{20}$")


def link_code(qr_code, secret):
    """20 URL-safe characters; one per ticket; not derivable without the secret."""
    if not qr_code or not secret:
        return None
    digest = hmac.new(secret.encode(), ("ticket-link:" + qr_code).encode(), hashlib.sha256).digest()[:15]
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def find(db, models, code, secret):
    """The ticket (attendee row) a private link code belongs to, or None."""
    code = (code or "").strip()
    if not LINK_RE.match(code):
        return None
    for a in db.query(models.Attendee).filter(models.Attendee.qr_code.isnot(None)).all():
        c = link_code(a.qr_code, secret)
        if c and hmac.compare_digest(c, code):
            return a
    return None
