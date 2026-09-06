# -*- coding: utf-8 -*-
"""The public page for one stand, and the roster a stand is allowed to see.

Two pages, one rule between them: a vendor's own listing is theirs to show off,
and the attendee list is not theirs at all until somebody hands them a badge.
"""
import html

BRAND = "#2e7d32"


def _h(v):
    return html.escape(str(v or ""), quote=True)


_CSS = """
:root{color-scheme:light dark;
  --ink:#12200f; --muted:#5f7263; --line:#e3eae4; --bg:#f5f7f4; --card:#ffffff;
  --brand:#2e7d32; --brand-soft:#eaf3ea}
@media (prefers-color-scheme:dark){:root{
  --ink:#e9f0ea; --muted:#9db0a3; --line:#25322a; --bg:#0d1410; --card:#141d17;
  --brand:#7dd956; --brand-soft:#18261a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:400 16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:640px;margin:0 auto;padding:26px 18px 72px}
.crumb{display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--muted);margin-bottom:18px}
.crumb b{color:var(--ink)}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden}
.hero{padding:30px 26px 24px;text-align:center;
  background:linear-gradient(180deg,var(--brand-soft),transparent)}
.logo{width:104px;height:104px;margin:0 auto 16px;border-radius:22px;background:#fff;
  border:1px solid var(--line);display:flex;align-items:center;justify-content:center;overflow:hidden}
/* Eight of these logos are white artwork lifted from the event site, which is
   dark. On a white tile they simply are not there. */
.logo--dark{background:#12200f;border-color:#2b3a2d}
.logo img{max-width:82%;max-height:82%;object-fit:contain}
.logo span{font:700 34px/1 inherit;color:var(--brand);letter-spacing:-.02em}
h1{margin:0 0 6px;font-size:29px;line-height:1.15;letter-spacing:-.022em;text-wrap:balance}
.tag{margin:0;color:var(--muted);font-size:16px;line-height:1.5;text-wrap:balance}
.booth{display:inline-flex;align-items:center;gap:7px;margin-top:16px;padding:7px 15px;
  border-radius:999px;background:var(--brand);color:#fff;font-size:13.5px;font-weight:650;
  letter-spacing:.01em}
.booth em{font-style:normal;opacity:.8;font-weight:500}
.body{padding:4px 26px 26px}
.about{margin:0;padding:20px 0 4px;font-size:16px;line-height:1.65;border-top:1px solid var(--line)}
.rows{margin:20px 0 0;display:grid;gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:14px;overflow:hidden}
.row{display:flex;gap:13px;align-items:center;padding:14px 16px;background:var(--card);
  color:inherit;text-decoration:none}
.row:hover{background:var(--brand-soft)}
.row svg{flex:0 0 auto;opacity:.55}
.row div{min-width:0}
.row .k{display:block;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.row .v{display:block;font-size:15.5px;overflow-wrap:anywhere}
.cta{display:block;margin:22px 0 0;padding:15px;text-align:center;border-radius:999px;
  background:var(--brand);color:#fff;text-decoration:none;font-weight:650;font-size:16px}
.cta.ghost{background:transparent;color:var(--brand);border:1.5px solid var(--brand);margin-top:10px}
.foot{margin:22px 0 0;text-align:center;font-size:12.5px;color:var(--muted);line-height:1.6}
.foot a{color:var(--brand)}
.empty{margin:20px 0 0;padding:18px;border:1px dashed var(--line);border-radius:14px;
  text-align:center;color:var(--muted);font-size:14.5px;line-height:1.6}
/* Photos scroll sideways rather than stacking: a stand with eight pictures
   should not push its catalogue and its address off the bottom of the phone. */
.shots{margin:22px -26px 0;padding:0 26px;display:flex;gap:10px;overflow-x:auto;
  scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.shots::-webkit-scrollbar{display:none}
.shot{flex:0 0 auto;width:75%;max-width:280px;scroll-snap-align:start}
.shot img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:14px;
  border:1px solid var(--line);background:var(--brand-soft)}
.shot figcaption{margin:7px 2px 0;font-size:12.5px;color:var(--muted);line-height:1.45}
.sect{margin:26px 0 0;padding-top:22px;border-top:1px solid var(--line)}
.sect h2{margin:0 0 3px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;
  color:var(--muted);font-weight:650}
.sect .note{margin:0 0 14px;font-size:13px;color:var(--muted)}
.cat{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
@media (max-width:420px){.cat{grid-template-columns:1fr}}
.item{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--card)}
.item img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;background:var(--brand-soft)}
.item .txt{padding:11px 13px 13px}
.item h3{margin:0;font-size:15px;line-height:1.35;letter-spacing:-.01em}
.item p{margin:4px 0 0;font-size:13.5px;line-height:1.5;color:var(--muted)}
"""

_ICON = {
 "web": '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/></svg>',
 "mail": '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/></svg>',
 "phone": '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6.5 3h3l1.5 4-2 1.5a12 12 0 0 0 6.5 6.5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.2 2 2 0 0 1 6.5 3Z"/></svg>',
 "pin": '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/></svg>',
}

_MARK = ('<svg width="17" height="17" viewBox="0 0 100 100" aria-hidden="true">'
         '<circle cx="50" cy="50" r="50" fill="%s"/>'
         '<path d="M42 21A30 30 0 1 0 66 25" stroke="#fff" stroke-width="14" fill="none" stroke-linecap="round"/>'
         '<path d="M64 27 48 49" stroke="#fff" stroke-width="14" stroke-linecap="round"/></svg>' % BRAND)


def _initials(name):
    parts = [p for p in str(name or "").split() if p]
    return ("".join(p[0] for p in parts[:2]) or "G").upper()


def public_vendor_html(ex, event_name, directory_url=""):
    """One stand, as an attendee meets it."""
    tile = " logo--dark" if getattr(ex, "logo_on_dark", False) else ""
    logo_inner = ('<img src="%s" alt="">' % _h(ex.logo_url)) if ex.logo_url else \
                 ('<span>%s</span>' % _h(_initials(ex.company_name)))
    tag = ('<p class="tag">%s</p>' % _h(ex.tagline)) if ex.tagline else ""
    booth = ""
    if ex.booth_number:
        # The sheet stored some of these in a numeric cell, so they arrive as
        # "27.0". A booth is a label, not a quantity.
        b = str(ex.booth_number).strip()
        if b.endswith(".0"):
            b = b[:-2]
        booth = '<div class="booth"><em>Booth</em> %s</div>' % _h(b)
    about = ('<p class="about">%s</p>' % _h(ex.description)) if (ex.description or "").strip() else ""

    rows = []
    def row(kind, key, value, href=None):
        inner = ('<div><span class="k">%s</span><span class="v">%s</span></div>'
                 % (_h(key), _h(value)))
        if href:
            rows.append('<a class="row" href="%s" rel="noopener" target="_blank">%s%s</a>'
                        % (_h(href), _ICON[kind], inner))
        else:
            rows.append('<div class="row">%s%s</div>' % (_ICON[kind], inner))

    if ex.website:
        shown = ex.website.replace("https://", "").replace("http://", "").rstrip("/")
        row("web", "Website", shown, ex.website)
    pub_mail = getattr(ex, "public_email", None)
    pub_tel = getattr(ex, "public_phone", None)
    if pub_mail:
        row("mail", "Email", pub_mail, "mailto:%s" % pub_mail)
    if pub_tel:
        row("phone", "Phone", pub_tel, "tel:%s" % "".join(c for c in pub_tel if c.isdigit() or c == "+"))
    addr = getattr(ex, "address", None)
    if addr:
        row("pin", "Address", addr)
    rows_html = ('<div class="rows">%s</div>' % "".join(rows)) if rows else ""

    # Pictures of the stand, then what will be on the table. Both are the
    # company's own material, so both are simply absent when they have not
    # given us any -- never a grey box promising something that isn't coming.
    photos = [p for p in (getattr(ex, "photos", None) or []) if p.url]
    shots = ""
    if photos:
        shots = ('<div class="shots">%s</div>' % "".join(
            '<figure class="shot"><img src="%s" alt="%s" loading="lazy">%s</figure>'
            % (_h(p.url), _h(p.caption or ex.company_name),
               ('<figcaption>%s</figcaption>' % _h(p.caption)) if p.caption else "")
            for p in photos))

    products = [p for p in (getattr(ex, "products", None) or []) if (p.name or "").strip()]
    catalogue = ""
    if products:
        catalogue = (
            '<div class="sect"><h2>What they bring</h2>'
            '<p class="note">A catalogue, not a shop &mdash; see it on the stand.</p>'
            '<div class="cat">%s</div></div>' % "".join(
                '<article class="item">%s<div class="txt"><h3>%s</h3>%s</div></article>'
                % (('<img src="%s" alt="%s" loading="lazy">' % (_h(p.image_url), _h(p.name)))
                   if p.image_url else "",
                   _h(p.name),
                   ('<p>%s</p>' % _h(p.description)) if (p.description or "").strip() else "")
                for p in products))

    if not about and not rows_html and not shots and not catalogue:
        rows_html = ('<div class="empty">%s is exhibiting at %s.<br>'
                     'Come and find them at the event.</div>'
                     % (_h(ex.company_name), _h(event_name)))

    # Straight to the exhibitor directory in the Gaia app, not to the API root
    # this used to point at. Somebody who scanned one stand's QR is asking who
    # else is here, and that is a directory, not a JSON document.
    cta = ""
    if directory_url:
        cta = ('<a class="cta ghost" href="%s">See everyone exhibiting</a>' % _h(directory_url))

    body = ('<div class="card">'
            '<div class="hero"><div class="logo%s">%s</div><h1>%s</h1>%s%s</div>'
            '<div class="body">%s%s%s%s%s</div></div>'
            % (tile, logo_inner, _h(ex.company_name), tag, booth,
               about, shots, catalogue, rows_html, cta))

    return ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            "<title>%s · %s</title>"
            "<meta property=\"og:title\" content=\"%s\">"
            "<meta property=\"og:description\" content=\"%s\">"
            "%s<style>%s</style></head><body><div class=\"wrap\">"
            "<div class=\"crumb\">%s<span><b>Gaia Healers</b> · %s</span></div>%s"
            "<p class=\"foot\">Exhibiting at %s.<br>"
            "Details are published by the company itself.</p>"
            "</div></body></html>"
            % (_h(ex.company_name), _h(event_name), _h(ex.company_name),
               _h((ex.tagline or ex.description or "")[:180]),
               ('<meta property="og:image" content="%s">' % _h(ex.logo_url)) if ex.logo_url else "",
               _CSS, _MARK, _h(event_name), body, _h(event_name)))
