# -*- coding: utf-8 -*-
"""Badge card: ONE printed QR, two uses.

The physical sticker carries a short public URL. Scanned by the Admin scanner
it checks the person in; scanned by any phone camera it opens their digital
badge card. Both resolve to the same attendee row.

Identity rules, fixed:

- ``attendee.qr_code`` (``ATT-...``) stays the canonical ticket identity. It is
  never printed as a URL and never leaves the authenticated surfaces it lives
  on today.
- ``attendee.public_token`` is a random alias for the PERSON. It carries no
  information (not an id, not an email, not a tier), it is reused across events
  for the same person so their card and connections persist, and it can be
  rotated only by choice (a rotation means a reprint).
- Nothing on the public card comes from checkout data by default. The card is
  empty until the person claims it, and every field is opt-in.

The two representations meet in ``parse_scan`` and nowhere else: every scanner
path asks it what it was handed, and the backend resolves from there.
"""
import html
import json
import io
import os
import re
import secrets
from datetime import datetime
from urllib.parse import urlsplit, unquote, quote

import qrcode
from PIL import Image, ImageDraw, ImageFont

# This module is imported before main.py calls load_dotenv(), so it reads the
# backend .env itself: the printed host must never depend on import order.
try:
    from dotenv import load_dotenv as _load_dotenv
    _load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except Exception:
    pass

# ---------------------------------------------------------------------------
# Token
# ---------------------------------------------------------------------------
# 32 symbols, none of which can be misread for another on a thermal print:
# no 0/O, no 1/I. 8 symbols = 40 bits, and unknown tokens answer a plain 404.
TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
TOKEN_LEN = 8
TOKEN_RE = re.compile(r"^[A-Z2-9]{8}$")
QR_RE = re.compile(r"^ATT-[0-9A-F]{12}$")

# Where the printed URL points. Change this ONLY before printing; every label
# ever printed keeps pointing at whatever this was on the day it was printed.
CARD_PUBLIC_BASE = os.getenv("CARD_PUBLIC_BASE", "https://api.gaiahealers.app/c").rstrip("/")
APP_BASE = os.getenv("GAIA_APP_BASE", "https://gaiahealers.app").rstrip("/")
API_BASE = os.getenv("GAIA_API_BASE", "https://api.gaiahealers.app").rstrip("/")


def new_token() -> str:
    return "".join(secrets.choice(TOKEN_ALPHABET) for _ in range(TOKEN_LEN))


def card_url(token: str, base: str = None) -> str:
    return "%s/%s" % ((base or CARD_PUBLIC_BASE).rstrip("/"), token)


def printed_payload(token: str, base: str = None) -> str:
    """What the QR on the sticker encodes. UPPERCASE on purpose: the QR
    encoder then uses alphanumeric mode, one full version smaller than the
    same URL in mixed case (measured: v2 vs v3 at 24 mm)."""
    return card_url(token, base).upper()


def parse_scan(text):
    """Classify whatever a scanner or a typing hand produced.

    Returns ("qr", "ATT-...") | ("token", "XXXXXXXX") | None. Accepts the raw
    ticket code, a bare token, or any URL whose last path segment is one of
    those (with or without a scheme, any case, optional .vcf/.json suffix).
    """
    s = (text or "").strip()
    if not s:
        return None
    u = s.upper()
    if QR_RE.match(u):
        return ("qr", u)
    if TOKEN_RE.match(u):
        return ("token", u)
    cand = s if "://" in s else ("https://" + s if "/" in s else None)
    if not cand:
        return None
    try:
        parts = urlsplit(cand)
    except ValueError:
        return None
    seg = unquote(parts.path or "").rstrip("/").split("/")[-1].upper()
    seg = re.sub(r"\.(VCF|JSON|PNG)$", "", seg)
    if TOKEN_RE.match(seg):
        return ("token", seg)
    if QR_RE.match(seg):
        return ("qr", seg)
    return None


# ---------------------------------------------------------------------------
# Person-level token assignment
# ---------------------------------------------------------------------------
def normalized_name(attendee) -> str:
    """First + last, flattened for comparison. Used to tell two humans apart
    when they share one CRM contact record."""
    raw = "%s %s" % ((attendee.first_name or ""), (attendee.last_name or ""))
    return re.sub(r"[^a-z ]+", "", raw.lower()).strip()


def _person_keys(attendee):
    """What makes two attendee rows the SAME human.

    An email is proof on its own. A CRM contact id is not: households, couples
    and colleagues routinely share one contact record, and two different people
    behind one contact must never end up sharing a badge card. So a contact id
    only counts together with the name on the ticket.
    """
    cd = attendee.custom_data or {}
    keys = set()
    name = normalized_name(attendee)
    for v in (cd.get("contact_id"), getattr(attendee, "acq_contact_id", None)):
        if v and name:
            keys.add(("contact", "%s|%s" % (str(v).strip(), name)))
    if attendee.email:
        keys.add(("email", attendee.email.strip().lower()))
    return keys


def ensure_public_token(db, models, attendee, commit=True) -> str:
    """Give this attendee row a token, REUSING the person's existing one.

    The same human at two events must print the same URL, so a sibling row
    (same GHL contact id or the same verified email) that already carries a
    token is the source of truth. Only a person with no token anywhere gets a
    fresh one, and a fresh one is retried until no other row holds it.
    """
    if attendee.public_token:
        return attendee.public_token
    # Rows assigned earlier in the same session must be visible to the
    # sibling lookup below, whatever the session's autoflush setting.
    try:
        db.flush()
    except Exception:
        pass
    keys = _person_keys(attendee)
    sibling_token = None
    if keys:
        q = db.query(models.Attendee).filter(models.Attendee.public_token.isnot(None),
                                             models.Attendee.id != attendee.id)
        for row in q.all():
            if keys & _person_keys(row):
                sibling_token = row.public_token
                break
    token = sibling_token
    while not token:
        cand = new_token()
        taken = db.query(models.Attendee).filter(models.Attendee.public_token == cand).first()
        if not taken:
            token = cand
    attendee.public_token = token
    if commit:
        db.commit()
    return token


# ---------------------------------------------------------------------------
# Card content
# ---------------------------------------------------------------------------
CARD_FIELDS = ("display_name", "headline", "company", "title", "city", "website", "booking_url",
               "instagram", "linkedin", "facebook", "tiktok", "youtube", "whatsapp",
               "photo_url", "tags", "services", "theme")
# show_email / show_phone are RETIRED. They used to decide whether contact
# details appeared on the public card; contact details are no longer public at
# all, so the switches decided nothing and offering them implied a control the
# owner did not have. Sharing with an exhibitor is governed separately, by the
# consent recorded on the attendee and snapshotted onto each lead.
# The identity fields. NOT in CARD_FIELDS on purpose: an ordinary card update
# must not be able to write them, because changing them needs a verified
# identity. clean_card still has to carry them through, or a headline edit
# would quietly wipe the card's own name, email and phone.
IDENTITY_FIELDS = ("full_name", "email", "phone")
MAX = {"full_name": 120, "email": 160, "phone": 32,
       "display_name": 60, "headline": 90, "company": 80, "title": 80, "city": 60, "website": 200,
       "booking_url": 300, "instagram": 60, "linkedin": 120, "facebook": 120, "tiktok": 60,
       "youtube": 160, "whatsapp": 24, "photo_url": 400}
# Accent presets the owner may pick. Names, not hex, cross the API.
THEMES = {
    "gaia":    ("#B6F25C", "#5CE1E6", "#A78BFA"),
    "sunrise": ("#F5C451", "#F08A5D", "#E5715A"),
    "ocean":   ("#5CE1E6", "#4F9DF2", "#A78BFA"),
    "rose":    ("#F7A1C4", "#E06C9F", "#A78BFA"),
    "forest":  ("#6FCE3A", "#3F8C1F", "#5CE1E6"),
    "gold":    ("#F5C451", "#E8B04B", "#FFFFFF"),
}


def _handle(v, prefix_hosts):
    """'@name', a bare name or a profile URL -> the bare handle."""
    v = (v or "").strip()
    if not v:
        return ""
    for h in prefix_hosts:
        m = re.search(r"%s/([A-Za-z0-9_.\-]+)" % re.escape(h), v, re.I)
        if m:
            return m.group(1)
    return v.lstrip("@").split("/")[0][:60]


def _url(v, limit):
    w = str(v or "").strip()[:limit]
    if w and not re.match(r"^https?://", w, re.I):
        w = "https://" + w
    return w if re.match(r"^https?://[^\s]+\.[^\s]+$", w or "x") else ""


def clean_card(data: dict) -> dict:
    """Sanitise what the owner typed. Never trusts, never invents."""
    src = data or {}
    out = {}
    for k in ("display_name", "headline", "company", "title", "city"):
        out[k] = str(src.get(k) or "").strip()[:MAX[k]]
    # Preserved, never re-derived: these arrive only through the verified paths.
    for k in IDENTITY_FIELDS:
        v = str(src.get(k) or "").strip()[:MAX[k]]
        if v:
            out[k] = v.lower() if k == "email" else v
    out["website"] = _url(src.get("website"), MAX["website"])
    out["booking_url"] = _url(src.get("booking_url"), MAX["booking_url"])
    out["instagram"] = _handle(src.get("instagram"), ["instagram.com"])
    out["linkedin"] = _handle(src.get("linkedin"), ["linkedin.com/in", "linkedin.com/company"])
    out["facebook"] = _handle(src.get("facebook"), ["facebook.com"])
    out["tiktok"] = _handle(src.get("tiktok"), ["tiktok.com/@", "tiktok.com"])
    yt = str(src.get("youtube") or "").strip()[:MAX["youtube"]]
    out["youtube"] = _url(yt, MAX["youtube"]) if "/" in yt or "." in yt else (("https://youtube.com/@" + yt.lstrip("@")) if yt else "")
    svc = src.get("services") or []
    if isinstance(svc, str):
        svc = re.split(r"[,\n]", svc)
    out["services"] = [str(t).strip()[:40] for t in svc if str(t).strip()][:6]
    out["theme"] = str(src.get("theme") or "gaia") if str(src.get("theme") or "gaia") in THEMES else "gaia"
    out["whatsapp"] = re.sub(r"\D", "", str(src.get("whatsapp") or ""))[:MAX["whatsapp"]]
    p = str(src.get("photo_url") or "").strip()[:MAX["photo_url"]]
    out["photo_url"] = p if re.match(r"^https://", p) else ""
    tags = src.get("tags") or []
    if isinstance(tags, str):
        tags = [t for t in re.split(r"[,\n]", tags)]
    out["tags"] = [str(t).strip()[:24] for t in tags if str(t).strip()][:4]
    return out


def event_label(name: str, year: str = "") -> str:
    """How an event reads on someone's card: short, and still theirs.
    "Gaia Healers Elevate Conference 2026" -> "Elevate 2026"."""
    n = re.sub(r"^\s*gaia\s+healers\s+", "", str(name or "").strip(), flags=re.I)
    if re.search(r"\b(19|20)\d{2}\b", n):
        n = re.sub(r"\s*\bconference\b\s*", " ", n, flags=re.I).strip()
    elif year:
        n = "%s %s" % (n, year)
    return re.sub(r"\s{2,}", " ", n).strip() or (str(name or "").strip())


def public_view(mcard, event=None, participation=None) -> dict:
    """The card as a stranger sees it. Built ONLY from opted-in fields.

    Takes the PERSON's card. An event is passed only to label the card and may
    be None — a card whose events have all been archived or deleted still
    renders, because the person and their details did not go anywhere.
    """
    card = (mcard.card if mcard and mcard.card else {}) or {}
    bio = (mcard.bio if mcard else "") or ""
    full = (mcard.name or "").strip()
    first = full.split(" ")[0] if full else ""
    shown = (card.get("display_name") or "").strip() if (mcard and mcard.card_public) else ""
    view = {
        "name": shown or full,
        "first_name": first,
        "ticket_name": full,
        "events": list(participation or []),
        "event_name": event.name if event else "",
        "event_id": event.id if event else None,
        "public": bool(mcard and mcard.card_public),
    }
    if not view["public"]:
        return view
    view.update({
        "headline": card.get("headline") or "",
        "booking_url": card.get("booking_url") or "",
        "facebook": card.get("facebook") or "",
        "tiktok": card.get("tiktok") or "",
        "youtube": card.get("youtube") or "",
        "services": list(card.get("services") or []),
        "theme": card.get("theme") or "gaia",
        "company": card.get("company") or "",
        "title": card.get("title") or "",
        "city": card.get("city") or "",
        "bio": (bio or "")[:400],
        "website": card.get("website") or "",
        "instagram": card.get("instagram") or "",
        "linkedin": card.get("linkedin") or "",
        "whatsapp": card.get("whatsapp") or "",
        "photo_url": card.get("photo_url") or "",
        "tags": list(card.get("tags") or []),
        # Email and phone are NEVER public, and are not sent to this page at
        # all -- a blur drawn in CSS is not privacy, because the value is still
        # in the HTML for anyone who opens the page source.
        #
        # A badge is visible on someone's chest all day and its URL can be
        # photographed from across a room by people the attendee never spoke
        # to. Contact details reach an EXHIBITOR who scans the badge, because
        # the attendee handed it over -- that is the moment consent is given,
        # and it is recorded on the lead. It does not reach a stranger with a
        # camera.
        "email": "",
        "phone": "",
        # So the page can show a locked row rather than pretend nothing exists.
        "contact_on_file": bool((mcard.email or "").strip() or (getattr(mcard, "phone", "") or "").strip()),
    })
    return view


# ---------------------------------------------------------------------------
# vCard
# ---------------------------------------------------------------------------
def _vesc(s: str) -> str:
    return (s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def vcard(view: dict, token: str) -> str:
    lines = ["BEGIN:VCARD", "VERSION:3.0"]
    lines.append("N:%s;%s;;;" % (_vesc(view["name"].split(" ")[-1] if " " in view["name"] else view["name"]),
                                _vesc(view.get("first_name", ""))))
    lines.append("FN:%s" % _vesc(view["name"]))
    if view.get("company"):
        lines.append("ORG:%s" % _vesc(view["company"]))
    if view.get("title"):
        lines.append("TITLE:%s" % _vesc(view["title"]))
    if view.get("email"):
        lines.append("EMAIL;TYPE=INTERNET:%s" % _vesc(view["email"]))
    if view.get("phone"):
        lines.append("TEL;TYPE=CELL:%s" % _vesc(view["phone"]))
    if view.get("whatsapp"):
        lines.append("TEL;TYPE=CELL,WHATSAPP:+%s" % _vesc(view["whatsapp"]))
        lines.append("X-SOCIALPROFILE;TYPE=whatsapp:https://wa.me/%s" % _vesc(view["whatsapp"]))
    if view.get("website"):
        lines.append("URL:%s" % _vesc(view["website"]))
    if view.get("booking_url"):
        lines.append("URL;TYPE=booking:%s" % _vesc(view["booking_url"]))
    if view.get("instagram"):
        lines.append("X-SOCIALPROFILE;TYPE=instagram:https://instagram.com/%s" % _vesc(view["instagram"]))
    if view.get("linkedin"):
        lines.append("X-SOCIALPROFILE;TYPE=linkedin:https://linkedin.com/in/%s" % _vesc(view["linkedin"]))
    if view.get("photo_url"):
        lines.append("PHOTO;VALUE=URI:%s" % _vesc(view["photo_url"]))
    note = []
    if view.get("city"):
        note.append(view["city"])
    if view.get("bio"):
        note.append(view["bio"])
    note.append("Met at %s (Gaia Healers)" % (view.get("event_name") or "a Gaia Healers event"))
    lines.append("NOTE:%s" % _vesc(" \u00b7 ".join(note)))
    lines.append("URL;TYPE=gaia:%s" % _vesc(card_url(token)))
    lines.append("REV:%sZ" % datetime.utcnow().strftime("%Y%m%dT%H%M%S"))
    lines.append("END:VCARD")
    return "\r\n".join(lines) + "\r\n"


# ---------------------------------------------------------------------------
# Card page (server-rendered, no framework, no external script)
# ---------------------------------------------------------------------------
_MARK = ('<svg viewBox="0 0 100 100" fill="none" aria-hidden="true"><defs><linearGradient id="gm" x1="18" y1="6" x2="82" y2="94" gradientUnits="userSpaceOnUse">'
         '<stop offset="0" stop-color="#6fce3a"/><stop offset="1" stop-color="#3f8c1f"/></linearGradient></defs>'
         '<circle cx="50" cy="50" r="50" fill="url(#gm)"/><path d="M42 21 A30 30 0 1 0 66 25" stroke="#fff" stroke-width="14" stroke-linecap="round"/>'
         '<path d="M64 27 L48 49" stroke="#fff" stroke-width="14" stroke-linecap="round"/></svg>')

_ICON = {
    "web": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    "instagram": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>',
    "linkedin": '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.5 8.5h-3V20h3V8.5zM5 4a1.75 1.75 0 1 0 0 3.5A1.75 1.75 0 0 0 5 4zm15 16h-3v-5.6c0-1.5-.5-2.4-1.8-2.4-1.1 0-1.7.8-2 1.5-.1.3-.1.6-.1 1V20h-3V8.5h3v1.6c.4-.6 1.2-1.8 3-1.8 2.2 0 3.9 1.4 3.9 4.6V20z"/></svg>',
    "whatsapp": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1.3-3.8A8 8 0 1 1 8 19.2L4 20z"/><path d="M9.5 9.5c0 3 2 5 5 5l1-1.5-2-1-1 1a4 4 0 0 1-2-2l1-1-1-2-1 1.5z"/></svg>',
    "mail": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
    "phone": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
    "calendar": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    "facebook": '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 8h3V4h-3c-2.8 0-4 1.8-4 4v2H7v4h3v6h4v-6h3l1-4h-4V8.5c0-.3.2-.5.5-.5z"/></svg>',
    "tiktok": '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 3h3c.3 2.2 1.6 3.6 4 3.9v3c-1.5 0-2.9-.5-4-1.3V15a6 6 0 1 1-6-6h1v3h-1a3 3 0 1 0 3 3V3z"/></svg>',
    "youtube": '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 8.2a3 3 0 0 0-2.1-2.1C18 5.6 12 5.6 12 5.6s-6 0-7.9.5A3 3 0 0 0 2 8.2 31 31 0 0 0 1.6 12 31 31 0 0 0 2 15.8a3 3 0 0 0 2.1 2.1c1.9.5 7.9.5 7.9.5s6 0 7.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .4-3.8 31 31 0 0 0-.4-3.8zM10 15V9l5.2 3L10 15z"/></svg>',
    "pin": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
}

_CSS = """
:root{--bg:#04070A;--surface:#0C1117;--hi:#131A22;--line:rgba(255,255,255,.09);--text:#fff;--muted:rgba(255,255,255,.62);--faint:rgba(255,255,255,.4);
--accent:#B6F25C;--on-accent:#0B1408;--purple:#A78BFA;--teal:#5CE1E6;--gold:#F5C451;--r:22px;--font:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box}html{color-scheme:dark}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);-webkit-font-smoothing:antialiased;min-height:100dvh}
.sky{position:fixed;inset:0;pointer-events:none;background:
 radial-gradient(60% 40% at 50% -10%,rgba(182,242,92,.16),transparent 70%),
 radial-gradient(45% 35% at 90% 100%,rgba(167,139,250,.14),transparent 70%),
 radial-gradient(35% 30% at 0% 80%,rgba(92,225,230,.08),transparent 70%)}
.wrap{position:relative;max-width:440px;margin:0 auto;padding:22px 18px 40px}
.top{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13px;letter-spacing:.02em}
.top svg{width:26px;height:26px;flex:none}.top b{color:var(--text);font-weight:600}
.card{margin-top:18px;background:linear-gradient(180deg,var(--hi),var(--surface));border:1px solid var(--line);border-radius:var(--r);padding:28px 22px 22px;box-shadow:0 24px 60px -24px rgba(0,0,0,.7);position:relative;overflow:hidden}
.card:before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,var(--accent),var(--teal),var(--purple))}
.event{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);background:rgba(182,242,92,.1);border:1px solid rgba(182,242,92,.25);border-radius:999px;padding:6px 12px}
.avatar{width:104px;height:104px;border-radius:50%;margin:22px auto 0;display:grid;place-items:center;font-size:38px;font-weight:700;letter-spacing:.02em;color:#0B1408;
 background:conic-gradient(from 210deg,var(--accent),var(--teal),var(--purple),var(--accent));box-shadow:0 0 0 6px rgba(255,255,255,.04),0 18px 40px -18px rgba(182,242,92,.5);overflow:hidden}
.avatar img{width:100%;height:100%;object-fit:cover;display:block}
h1{margin:18px 0 0;font-size:28px;line-height:1.1;text-align:center;font-weight:700;letter-spacing:-.01em;text-wrap:balance}
.role{margin:8px 0 0;text-align:center;color:var(--muted);font-size:15px;line-height:1.4}.role b{color:var(--text);font-weight:600}
.city{display:flex;justify-content:center;align-items:center;gap:6px;margin:10px 0 0;color:var(--faint);font-size:13px}.city svg{width:15px;height:15px}
.tags{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:14px 0 0}.tags span{font-size:12px;color:var(--teal);border:1px solid rgba(92,225,230,.3);border-radius:999px;padding:4px 10px}
.headline{margin:10px 0 0;text-align:center;font-size:16px;line-height:1.4;color:var(--text);font-weight:600;text-wrap:balance}
.services{margin:18px 0 0;padding:14px 16px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid var(--line)}
.services__k{margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
.services ul{margin:0;padding:0;list-style:none;display:grid;gap:6px}.services li{font-size:14.5px;color:var(--text);padding-left:16px;position:relative}
.services li:before{content:"";position:absolute;left:0;top:.55em;width:7px;height:7px;border-radius:50%;background:var(--accent)}
.events{margin:18px 0 0;padding:14px 16px;border-radius:14px;background:rgba(255,255,255,.03);border:1px solid var(--line)}
.events__k{margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
.events ul{margin:0;padding:0;list-style:none;display:grid;gap:9px}
.events li{display:flex;align-items:center;gap:10px;font-size:14.5px}
.events li b{font-weight:700}
.events__dot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none}
.events__role{margin-left:auto;font-size:12.5px;color:var(--faint)}
.bio{margin:18px 0 0;font-size:15px;line-height:1.55;color:var(--muted);text-align:center;text-wrap:pretty}
.actions{display:grid;gap:10px;margin:22px 0 0}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;min-height:50px;border-radius:14px;font:inherit;font-size:15px;font-weight:600;text-decoration:none;border:1px solid transparent;cursor:pointer;transition:transform .14s ease,filter .14s ease}
.btn:active{transform:scale(.985)}.btn--primary{background:var(--accent);color:var(--on-accent);box-shadow:0 10px 30px -14px rgba(182,242,92,.7)}.btn--primary:hover{filter:brightness(1.05)}
.btn--secondary{background:rgba(167,139,250,.14);color:#EDE8FF;border-color:rgba(167,139,250,.4)}.btn--ghost{background:transparent;color:var(--muted);border-color:var(--line)}
.btn svg{width:18px;height:18px}
.links{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:14px 0 0}
/* Contact details that exist but are not on this page. The blur is decoration
   over block characters -- the real values were never sent, so there is nothing
   to find in the page source. */
.locked{margin:14px 0 0;padding:12px 14px;border:1px dashed rgba(0,0,0,.18);border-radius:12px}
.locked__row{display:flex;align-items:center;gap:10px;padding:4px 0}
.locked__row svg{flex:0 0 auto;opacity:.45}
.locked__blur{filter:blur(4px);letter-spacing:.06em;opacity:.5;user-select:none}
.locked__note{margin:8px 0 0;font-size:.78rem;line-height:1.5;opacity:.62}
.links a{display:flex;align-items:center;gap:8px;padding:12px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid var(--line);color:var(--text);text-decoration:none;font-size:14px;min-height:46px}
.links a svg{width:18px;height:18px;color:var(--teal);flex:none}.links a span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.claim{margin:22px 0 0;padding:16px;border-radius:14px;background:rgba(255,255,255,.03);border:1px dashed var(--line);text-align:center;color:var(--muted);font-size:14px;line-height:1.5}
.claim a{color:var(--accent);font-weight:600;text-decoration:none}
.foot{margin:26px 0 0;text-align:center;color:var(--faint);font-size:12px;line-height:1.6}.foot a{color:var(--muted);text-decoration:none}
.na{margin-top:18px;text-align:center}.na h1{font-size:22px}.na p{color:var(--muted)}
@media (prefers-reduced-motion:no-preference){.card{animation:rise .5s cubic-bezier(.22,1,.36,1) both}@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}}
"""


def _h(s):
    return html.escape(str(s or ""), quote=True)


def _initials(view):
    parts = [p for p in (view.get("name") or "").split() if p]
    return "".join(p[0] for p in parts[:2]).upper() or "G"


def render_card_html(view: dict, token: str, app_base: str = None) -> str:
    app_base = (app_base or APP_BASE).rstrip("/")
    claim_url = "%s/home.html?view=events&card=%s&claim=1" % (app_base, quote(token))
    connect_url = "%s/home.html?view=events&card=%s" % (app_base, quote(token))
    name = _h(view.get("name") or "Gaia Healers attendee")
    # With every event of theirs archived or removed, the card is still theirs;
    # it just stops claiming to be a badge for something currently running.
    _ev = view.get("event_name") or ""
    if not _ev and view.get("events"):
        _ev = view["events"][0].get("label") or ""
    event = _h(_ev or "Gaia Healers")
    og_title = "%s \u00b7 %s" % (view.get("name") or "Digital badge", view.get("event_name") or "Gaia Healers")
    og_desc = "Digital badge card from Gaia Healers."
    og_img = view.get("photo_url") or "%s/assets/gaia-icon.png" % app_base
    theme = THEMES.get(view.get("theme") or "gaia", THEMES["gaia"])
    theme_css = "<style>:root{--accent:%s;--teal:%s;--purple:%s}</style>" % theme
    head = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
            "<title>%s</title><meta name=\"robots\" content=\"noindex\">"
            "<meta property=\"og:title\" content=\"%s\"><meta property=\"og:description\" content=\"%s\"><meta property=\"og:image\" content=\"%s\">"
            "<meta name=\"theme-color\" content=\"#04070A\">"
            "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"><link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>"
            "<link href=\"https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700&display=swap\" rel=\"stylesheet\">"
            "<style>%s</style>%s</head><body><div class=\"sky\"></div><div class=\"wrap\">"
            "<div class=\"top\">%s<span><b>Gaia Healers</b> \u00b7 digital badge</span></div>"
            % (_h(og_title), _h(og_title), _h(og_desc), _h(og_img), _CSS, theme_css, _MARK))

    if not view.get("public"):
        first = _h(view.get("first_name") or "the owner")
        body = ("<div class=\"card\"><span class=\"event\">%s</span>"
                "<div class=\"avatar\">%s</div><h1>%s</h1>"
                "<p class=\"role\">Attending <b>%s</b></p>"
                "<div class=\"actions\"><a class=\"btn btn--secondary\" href=\"%s\">Connect in the Gaia app</a></div>"
                "<div class=\"claim\" data-claim>Is this you, %s? <a href=\"%s\" data-claim-link>Sign in to set up your card</a> \u2014 "
                "add your photo, company and links. The QR on your badge already points here; nothing gets reprinted.</div>"
                "</div>" % (event, _h(_initials(view)), name, event, _h(connect_url), first, _h(claim_url)))
    else:
        avatar = ("<img src=\"%s\" alt=\"\">" % _h(view["photo_url"])) if view.get("photo_url") else _h(_initials(view))
        role = ""
        if view.get("title") or view.get("company"):
            role = "<p class=\"role\">%s%s%s</p>" % (
                ("<b>%s</b>" % _h(view["title"])) if view.get("title") else "",
                " \u00b7 " if view.get("title") and view.get("company") else "",
                _h(view.get("company")) if view.get("company") else "")
        headline = ("<p class=\"headline\">%s</p>" % _h(view["headline"])) if view.get("headline") else ""
        city = ("<p class=\"city\">%s<span>%s</span></p>" % (_ICON["pin"], _h(view["city"]))) if view.get("city") else ""
        services = ""
        if view.get("services"):
            services = ("<div class=\"services\"><p class=\"services__k\">Offerings</p><ul>%s</ul></div>"
                        % "".join("<li>%s</li>" % _h(x) for x in view["services"]))
        booking = ("<a class=\"btn btn--primary\" href=\"%s\" rel=\"noopener\" target=\"_blank\">%s Book with %s</a>"
                   % (_h(view["booking_url"]), _ICON["calendar"], _h(view.get("first_name") or "me"))) if view.get("booking_url") else ""
        tags = ("<div class=\"tags\">%s</div>" % "".join("<span>%s</span>" % _h(t) for t in view.get("tags") or [])) if view.get("tags") else ""
        bio = ("<p class=\"bio\">%s</p>" % _h(view["bio"])) if view.get("bio") else ""
        links = []
        if view.get("website"):
            host = re.sub(r"^https?://(www\.)?", "", view["website"]).rstrip("/")
            links.append("<a href=\"%s\" rel=\"noopener\" target=\"_blank\">%s<span>%s</span></a>" % (_h(view["website"]), _ICON["web"], _h(host)))
        if view.get("instagram"):
            links.append("<a href=\"https://instagram.com/%s\" rel=\"noopener\" target=\"_blank\">%s<span>@%s</span></a>" % (_h(view["instagram"]), _ICON["instagram"], _h(view["instagram"])))
        if view.get("linkedin"):
            links.append("<a href=\"https://linkedin.com/in/%s\" rel=\"noopener\" target=\"_blank\">%s<span>LinkedIn</span></a>" % (_h(view["linkedin"]), _ICON["linkedin"]))
        if view.get("facebook"):
            links.append("<a href=\"https://facebook.com/%s\" rel=\"noopener\" target=\"_blank\">%s<span>Facebook</span></a>" % (_h(view["facebook"]), _ICON["facebook"]))
        if view.get("tiktok"):
            links.append("<a href=\"https://tiktok.com/@%s\" rel=\"noopener\" target=\"_blank\">%s<span>@%s</span></a>" % (_h(view["tiktok"]), _ICON["tiktok"], _h(view["tiktok"])))
        if view.get("youtube"):
            links.append("<a href=\"%s\" rel=\"noopener\" target=\"_blank\">%s<span>YouTube</span></a>" % (_h(view["youtube"]), _ICON["youtube"]))
        if view.get("whatsapp"):
            links.append("<a href=\"https://wa.me/%s\" rel=\"noopener\" target=\"_blank\">%s<span>WhatsApp</span></a>" % (_h(view["whatsapp"]), _ICON["whatsapp"]))
        if view.get("email"):
            links.append("<a href=\"mailto:%s\">%s<span>%s</span></a>" % (_h(view["email"]), _ICON["mail"], _h(view["email"])))
        if view.get("phone"):
            links.append("<a href=\"tel:%s\">%s<span>%s</span></a>" % (_h(view["phone"]), _ICON["phone"], _h(view["phone"])))
        links_html = ("<div class=\"links\">%s</div>" % "".join(links)) if links else ""
        # Contact details exist but are not on this page. Shown as a locked row
        # rather than omitted, so it is honest about what is being withheld and
        # from whom -- and the blur is nothing but decoration over text that was
        # never sent, so viewing the source reveals nothing.
        locked_html = ""
        if view.get("contact_on_file"):
            locked_html = (
                "<div class=\"locked\">"
                "<div class=\"locked__row\">%s<span class=\"locked__blur\">&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#64;&#9608;&#9608;&#9608;&#9608;&#9608;</span></div>"
                "<div class=\"locked__row\">%s<span class=\"locked__blur\">&#9608;&#9608;&#9608; &#9608;&#9608;&#9608; &#9608;&#9608;&#9608;&#9608;</span></div>"
                "<p class=\"locked__note\">Email and phone are shared with an exhibitor when this badge is scanned at their stand \u2014 not on this page.</p>"
                "</div>" % (_ICON["mail"], _ICON["phone"]))
        # Where they have been with us. Built from attendance records only —
        # no ticket, order or payment ever appears here.
        events_html = ""
        if view.get("events"):
            events_html = ("<div class=\"events\"><p class=\"events__k\">Gaia Healers events</p><ul>%s</ul></div>"
                           % "".join("<li><span class=\"events__dot\"></span><b>%s</b><span class=\"events__role\">%s</span></li>"
                                     % (_h(e.get("label")), _h(e.get("role") or "Participant"))
                                     for e in view["events"]))
        body = ("<div class=\"card\"><span class=\"event\">%s</span>"
                "<div class=\"avatar\">%s</div><h1>%s</h1>%s%s%s%s%s%s"
                "<div class=\"actions\">%s<a class=\"btn %s\" href=\"%s.vcf\" download>%s Save contact</a>"
                "<a class=\"btn btn--secondary\" href=\"%s\">Connect in the Gaia app</a>"
                "<a class=\"btn btn--ghost\" href=\"%s\" data-owner-edit hidden>Edit my card</a></div>%s%s%s</div>"
                % (event, avatar, name, headline, role, city, tags, bio, services, booking,
                   "btn--secondary" if booking else "btn--primary", _h(token),
                   _ICON["mail"].replace("currentColor", "#0B1408" if not booking else "currentColor"),
                   _h(connect_url), _h(claim_url), links_html, locked_html, events_html))

    foot = ("<p class=\"foot\">This card is shared by its owner and shows only what they chose to share.<br>"
            "<a href=\"%s\">gaiahealers.app</a></p></div>" % _h(app_base))
    # Ownership is asked of the Gaia proxy with the viewer's own session cookie.
    # The answer is one boolean; the page never sees who the viewer is. Owner ->
    # the edit/set-up control; a signed-in stranger -> the claim box goes away;
    # signed out or blocked -> the default "sign in to set up" stays.
    owner_js = ("<script>(function(){try{fetch(%s+'/api/card/owner?token='+encodeURIComponent(%s),{credentials:'include',headers:{Accept:'application/json'}})"
                ".then(function(r){return r.json()}).then(function(d){if(!d||!d.ok)return;"
                "var box=document.querySelector('[data-claim]'),link=document.querySelector('[data-claim-link]'),edit=document.querySelector('[data-owner-edit]');"
                "if(d.owner){if(link){link.textContent='Set up your card';box.firstChild.textContent='This is your badge. ';}if(edit){edit.hidden=false;}}"
                "else if(d.authenticated&&box){box.remove();}}).catch(function(){});}catch(e){}})();</script>"
                % (json.dumps(API_BASE), json.dumps(token)))
    return head + body + foot + owner_js + "</body></html>"


def render_not_found_html(app_base: str = None) -> str:
    app_base = (app_base or APP_BASE).rstrip("/")
    return ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            "<title>Card not found</title><meta name=\"robots\" content=\"noindex\"><style>%s</style></head><body><div class=\"sky\"></div><div class=\"wrap\">"
            "<div class=\"top\">%s<span><b>Gaia Healers</b> \u00b7 digital badge</span></div>"
            "<div class=\"card na\"><h1>This card isn\u2019t active</h1><p>The link may be mistyped, or its owner hasn\u2019t activated it yet.</p>"
            "<div class=\"actions\"><a class=\"btn btn--ghost\" href=\"%s\">Open Gaia Healers</a></div></div></div></body></html>"
            % (_CSS, _MARK, _h(app_base)))


# ---------------------------------------------------------------------------
# Thermal label
# ---------------------------------------------------------------------------
DPI = 203
_FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
_FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def _mm(v):
    return int(round(v * DPI / 25.4))


def _font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def _fit(draw, text, path, max_w, start, floor):
    size = start
    while size > floor:
        f = _font(path, size)
        if draw.textlength(text, font=f) <= max_w:
            return f, text
        size -= 1
    f = _font(path, floor)
    # Still too wide at the floor: keep the END of the word (the surname is the
    # part that matters at a desk) and mark the cut.
    while len(text) > 3 and draw.textlength("\u2026" + text, font=f) > max_w:
        text = text[1:]
    return f, ("\u2026" + text) if text else ""


def _wrap_two(draw, words, path, max_w, size):
    """Best split of the words into two lines at this size, or None."""
    f = _font(path, size)
    best = None
    for k in range(1, len(words)):
        a, b = " ".join(words[:k]), " ".join(words[k:])
        if draw.textlength(a, font=f) <= max_w and draw.textlength(b, font=f) <= max_w:
            # Prefer the split that keeps the surname whole and lines balanced.
            score = abs(draw.textlength(a, font=f) - draw.textlength(b, font=f))
            if best is None or score < best[0]:
                best = (score, a, b)
    return (f, best[1], best[2]) if best else None


def _render_portrait(first_name, last_name, token, W, H, base=None):
    """The approved sticker: FULL NAME on top, one large QR beneath, nothing
    else. The QR is sized FIRST and is the same on every sticker; the name gets
    the band above it, wrapping to two lines and shrinking as needed. The
    surname is never cut before the given names are."""
    img = Image.new("L", (W, H), 255)
    draw = ImageDraw.Draw(img)
    side = _mm(2.5)
    top = _mm(3.0)
    bottom = _mm(2.5)
    gap = _mm(1.5)
    max_w = W - 2 * side

    # 1. QR first, as large as the label allows while leaving a name band that
    #    fits two lines at the smallest size we would ever print (3.0 mm).
    q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2, box_size=1)
    q.add_data(printed_payload(token, base))
    q.make(fit=True)
    n = q.modules_count + 4
    min_line = _font(_FONT_BOLD, _mm(3.0)).getbbox("HXg")[3]
    min_band = 2 * min_line + _mm(0.9)
    qr_px = min(max_w, H - top - bottom - gap - min_band)
    box = max(1, int(qr_px // n))
    qimg = q.make_image(fill_color="black", back_color="white").convert("L").resize((n * box, n * box), Image.NEAREST)
    band_h = H - top - bottom - gap - qimg.height   # what the name may use

    # 2. the name, inside the band
    name = " ".join(p for p in ((first_name or "").strip(), (last_name or "").strip()) if p).upper()
    words = name.split()
    lines = None
    for size in range(_mm(5.6), _mm(3.8) - 1, -1):          # one line
        f = _font(_FONT_BOLD, size)
        if draw.textlength(name, font=f) <= max_w and f.getbbox("HXg")[3] <= band_h:
            lines = (f, [name]); break
    if lines is None and len(words) > 1:                     # two lines
        for size in range(_mm(5.2), _mm(3.0) - 1, -1):
            f = _font(_FONT_BOLD, size)
            if 2 * f.getbbox("HXg")[3] + _mm(0.9) > band_h:
                continue
            got = _wrap_two(draw, words, _FONT_BOLD, max_w, size)
            if got:
                lines = (got[0], [got[1], got[2]]); break
    if lines is None:                                        # last resort
        given = " ".join(words[:-1]) if len(words) > 1 else name
        sur = words[-1] if len(words) > 1 else ""
        f2, t2 = _fit(draw, sur or given, _FONT_BOLD, max_w, _mm(3.4), _mm(2.6))
        if sur:
            f1, t1 = _fit(draw, given, _FONT_BOLD, max_w, f2.size, _mm(2.4))
            lines = (f2, [t1, t2])
        else:
            lines = (f2, [t2])

    # 3. Compose name and QR as ONE block and centre that on the label.
    #
    # Previously the name was centred inside its own reserved band and the QR
    # pinned below it. On a 40x60 roll the QR is limited by the label's WIDTH,
    # so the leftover height all collected in the name band: the name floated
    # in mid-air, the gap under it was wide, and the whole composition sat high
    # with a thin margin at the foot. Measuring the real content and centring it
    # gives even air top and bottom and keeps the name sitting on its QR.
    f, texts = lines
    bb = f.getbbox("HXg")
    ink_top = bb[1]          # the blank the font leaves above a capital
    line_h = bb[3]
    lead = _mm(0.9)
    block_h = line_h * len(texts) + lead * (len(texts) - 1)
    # Centre the INK, not the text box. A capital sits below its box top by the
    # font's ascender bearing, so centring the box leaves the label looking
    # top-heavy by exactly that much.
    # The QR image carries its own 2-module white quiet zone. Scanners need it,
    # so it stays in the file -- but it is white, and counting it as content
    # pushes everything visibly high on the sticker. Balance the INK.
    quiet = 2 * box
    content_h = (block_h - ink_top) + gap + (qimg.height - quiet)
    y = (H - content_h) // 2 - ink_top
    y = max(top - ink_top, min(y, H - bottom - block_h - gap - qimg.height + quiet))
    if y + content_h > H - bottom:                            # never crowd the foot
        y = max(top, H - bottom - content_h)
    for t in texts:
        w = draw.textlength(t, font=f)
        draw.text(((W - w) / 2, y), t, font=f, fill=0)
        y += line_h + lead
    y -= lead

    img.paste(qimg, ((W - qimg.width) // 2, int(y + gap)))
    meta = {"layout": "portrait", "name_lines": len(texts), "name_pt_mm": round(f.size * 25.4 / DPI, 1),
            "content_mm": round(content_h * 25.4 / DPI, 1),
            "qr_mm": round(qimg.width * 25.4 / DPI, 1), "qr_modules": q.modules_count, "qr_box_px": box}
    return img, meta


def _render_landscape(first_name, last_name, token, W, H, qr_mm, base=None):
    img = Image.new("L", (W, H), 255)
    draw = ImageDraw.Draw(img)
    margin = _mm(2)
    q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2, box_size=1)
    q.add_data(printed_payload(token, base))
    q.make(fit=True)
    n = q.modules_count + 4
    box = max(1, _mm(qr_mm) // n)
    qimg = q.make_image(fill_color="black", back_color="white").convert("L").resize((n * box, n * box), Image.NEAREST)
    img.paste(qimg, (margin, (H - qimg.height) // 2))
    x0 = margin + qimg.width + _mm(2)
    max_w = W - x0 - margin
    first = (first_name or "").strip()
    last = (last_name or "").strip().upper()
    f1, t1 = _fit(draw, first, _FONT_REG, max_w, _mm(4.2), _mm(2.2))
    if t1.startswith("\u2026") and " " in first:
        f1, t1 = _fit(draw, first.split(" ")[0], _FONT_REG, max_w, _mm(4.2), _mm(2.2))
    f2, t2 = _fit(draw, last, _FONT_BOLD, max_w, _mm(5.0), _mm(2.4))
    h1 = f1.getbbox(t1 or "X")[3] if t1 else 0
    h2 = f2.getbbox(t2 or "X")[3] if t2 else 0
    gap = _mm(1.2)
    y = (H - (h1 + (gap if t1 and t2 else 0) + h2)) // 2
    if t1:
        draw.text((x0, y), t1, font=f1, fill=0)
        y += h1 + gap
    if t2:
        draw.text((x0, y), t2, font=f2, fill=0)
    return img, {"layout": "landscape", "qr_modules": q.modules_count, "qr_box_px": box}


# The approved format. Others exist only for a roll that turns out to be what
# is in the printer on the day; the design does not change with them.
# Roll sizes the renderer supports, and whether NIIMBOT actually sells that
# roll. The printer needs its own RFID-tagged stock — an unbranded roll prints
# at near-zero density — so a size nobody sells cannot be ordered, however good
# it looks. The 40x50 design target is kept selectable in case a genuine roll is
# sourced; the DEFAULT is a size that can be bought today, with the identical
# layout (full name over the same 32.7 mm QR) and 10 mm more air around it.
LABEL_SIZES = {"40x60": (40, 60), "40x50": (40, 50), "40x40": (40, 40),
               "50x30": (50, 30), "40x30": (40, 30), "50x40": (50, 40)}
LABEL_STOCKED = {"40x60": True, "40x40": True, "50x30": True, "40x30": True,
                 "40x50": False, "50x40": False}
DEFAULT_LABEL = "40x60"


def render_label(first_name, last_name, token, width_mm=40, height_mm=50, qr_mm=26, base=None):
    """A 1-bit PNG at 203 dpi, sized for the roll. Portrait rolls (the approved
    40 x 50) get NAME over QR; a landscape roll falls back to QR beside name."""
    W, H = _mm(width_mm), _mm(height_mm)
    if H >= W:
        img, meta = _render_portrait(first_name, last_name, token, W, H, base)
    else:
        img, meta = _render_landscape(first_name, last_name, token, W, H, qr_mm, base)
    out = io.BytesIO()
    img.convert("1").save(out, format="PNG")
    meta.update({"width_px": W, "height_px": H, "dpi": DPI, "payload": printed_payload(token, base)})
    return out.getvalue(), meta
