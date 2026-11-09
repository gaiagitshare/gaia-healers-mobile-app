# -*- coding: utf-8 -*-
"""Share links and QR codes for an event's public pages (9 Nov 2026).

Admins pick a public page of the event (the exhibitor directory, the hall map,
the agenda, one exhibitor's stand on the map...) and get its link, a QR code,
and a printable sign. Only PUBLIC pages are offered: everything here opens
without signing in, so a QR code gives away nothing that is not already on the
public event page. A stand is offered only once it is published in the
directory. Nothing is stored and nothing is sent.
"""
import io
from urllib.parse import urlencode

from fastapi import Depends, HTTPException, Response

import qrcode
from qrcode.constants import ERROR_CORRECT_Q
from PIL import Image, ImageDraw, ImageFont

# key -> (label, tab in the app, what it is for)
PAGES = [
    ("event", "Event page", None, "The event's home page in the app."),
    ("exhibitors", "Exhibitor directory", "exhibitors", "Every published stand, searchable by name or booth."),
    ("map", "Exhibit hall map", "map", "The floor plan with every booth."),
    ("agenda", "Agenda", "agenda", "The schedule, day by day."),
    ("speakers", "Speakers", "speakers", "Everyone speaking, in schedule order."),
    ("sponsors", "Sponsors", "sponsors", "The event's sponsors."),
    ("info", "Info", "info", "Venue, parking, FAQ."),
    ("tickets", "Tickets", "tickets", "Buy tickets (hidden in the app once the event starts)."),
]
GREEN = "#16301d"


def _font(size, bold=False):
    for f in (["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"] if bold else []) + \
             ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        try:
            return ImageFont.truetype(f, size)
        except Exception:
            pass
    return ImageFont.load_default()


def qr_png(url, title=None, subtitle=None):
    """A QR code for url; with a title, a printable sign around it."""
    q = qrcode.QRCode(error_correction=ERROR_CORRECT_Q, box_size=20, border=4)
    q.add_data(url)
    q.make(fit=True)
    img = q.make_image(fill_color=GREEN, back_color="white").convert("RGB")
    if title:
        w = img.width
        card = Image.new("RGB", (w, img.height + 280), "white")
        card.paste(img, (0, 140))
        d = ImageDraw.Draw(card)
        lines = [(title, 30, _font(max(26, w // 26), True))]
        if subtitle:
            lines.append((subtitle, 90, _font(max(22, w // 30))))
        lines.append(("Scan with your phone camera", img.height + 170, _font(max(20, w // 34))))
        for text, y, f in lines:
            while d.textlength(text, font=f) > w - 40 and len(text) > 8:
                text = text[:-2]
            d.text(((w - d.textlength(text, font=f)) / 2, y), text, fill=GREEN, font=f)
        img = card
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


def register(app, get_db, get_current_user, models, authz, app_base):
    from sqlalchemy.orm import Session

    def url_for(event_id, tab=None, stand=None):
        q = {"view": "events", "event": event_id}
        if tab:
            q["tab"] = tab
        if stand:
            q["stand"] = stand
        # home.html, not the root: the root shows a first-time visitor an intro
        # screen first, one more tap for somebody who just scanned a sign.
        return "%s/home.html?%s" % (app_base, urlencode(q))

    def event_or_404(db, event_id):
        ev = db.query(models.Event).filter(models.Event.id == event_id).first()
        if ev is None:
            raise HTTPException(status_code=404, detail="Event not found")
        return ev

    def stand_or_404(db, event_id, stand_id):
        ex = db.query(models.Exhibitor).filter(models.Exhibitor.id == stand_id, models.Exhibitor.event_id == event_id,
                                               models.Exhibitor.is_published == True).first()   # noqa: E712
        if ex is None:
            raise HTTPException(status_code=404, detail="That stand is not published in the directory")
        return ex

    def target(db, event_id, page, stand):
        if stand:
            ex = stand_or_404(db, event_id, int(stand))
            booth = ("Booth %s" % ex.booth_number) if ex.booth_number else None
            return url_for(event_id, stand=ex.id), ex.company_name, booth
        row = next((p for p in PAGES if p[0] == page), None)
        if row is None:
            raise HTTPException(status_code=404, detail="Unknown page")
        return url_for(event_id, tab=row[2]), row[1], None

    @app.get("/events/{event_id}/share-links")
    def share_links(event_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
        authz.require_cap(db, current_user, event_id, "event.write")
        ev = event_or_404(db, event_id)
        stands = db.query(models.Exhibitor).filter(models.Exhibitor.event_id == event_id,
                                                   models.Exhibitor.is_published == True).all()   # noqa: E712
        return {"event": ev.name,
                "pages": [{"key": k, "label": l, "help": h, "url": url_for(event_id, tab=t)} for k, l, t, h in PAGES],
                "stands": sorted([{"id": s.id, "name": s.company_name, "booth": s.booth_number,
                                   "url": url_for(event_id, stand=s.id)} for s in stands], key=lambda s: (s["name"] or "").lower())}

    @app.get("/events/{event_id}/share-qr.png")
    def share_qr(event_id: int, page: str = "event", stand: int = 0, sign: int = 0, db: Session = Depends(get_db)):
        """Public on purpose: the code only ever points at a public page of the
        event, so an <img> tag and a plain download link both work."""
        ev = event_or_404(db, event_id)
        url, title, extra = target(db, event_id, page, stand)
        png = qr_png(url, title=(ev.name if sign else None),
                     subtitle=(" · ".join(x for x in (title, extra) if x) if sign else None))
        name = ("stand-%d" % stand if stand else page) + ("-sign" if sign else "-qr") + ".png"
        return Response(content=png, media_type="image/png",
                        headers={"Cache-Control": "public, max-age=300",
                                 "Content-Disposition": 'inline; filename="%s"' % name})
