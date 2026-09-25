# -*- coding: utf-8 -*-
"""Apple Wallet and Google Wallet passes for an event ticket.

A badge QR on a phone screen depends on the app opening, the session holding
and the signal reaching -- at a door, with three hundred people behind you.
A wallet pass depends on none of those: it is on the lock screen, it works in
aeroplane mode, and it survives a flat battery better than a web page does.

Both stores demand credentials that only the organiser can obtain, so this
module is written to be INERT until they exist:

  Apple   APPLE_PASS_TYPE_ID, APPLE_TEAM_ID and a Pass Type ID certificate
          (APPLE_PASS_CERT_PEM + APPLE_PASS_KEY_PEM, plus Apple's WWDR
          intermediate in APPLE_WWDR_CERT_PEM). Apple Wallet refuses an
          unsigned pass, so there is no useful "try it without" path.
  Google  GOOGLE_WALLET_ISSUER_ID and a service-account key
          (GOOGLE_WALLET_SA_JSON). The "save" link is a JWT signed with it.

`status()` says what is configured; every caller asks first, and the buttons
in the app appear only for a store that can actually issue.

Deliberately NOT here: pass updates over the air. That needs a web service
plus APNs for Apple and a separate write scope for Google, and a ticket whose
QR never changes does not need them -- a re-issued pass replaces the old one
by serial number.
"""
import hashlib
import io
import json
import os
import subprocess
import tempfile
import time
import zipfile
from datetime import datetime, timedelta, timezone

ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wallet_assets")
APPLE_FILES = ("icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png")

# Gaia green on near-black, the app's own colours.
BG_COLOR = "rgb(10, 22, 14)"
FG_COLOR = "rgb(236, 243, 233)"
LABEL_COLOR = "rgb(166, 237, 104)"


def _env(name, default=""):
    return (os.environ.get(name) or default).strip()


def _pem(name):
    """A PEM either inline in the environment or in a file it points at."""
    raw = os.environ.get(name) or ""
    if raw.strip().startswith("-----BEGIN"):
        return raw
    path = raw.strip()
    if path and os.path.isfile(path):
        with open(path) as fh:
            return fh.read()
    return ""


def apple_ready():
    return bool(_env("APPLE_PASS_TYPE_ID") and _env("APPLE_TEAM_ID")
                and _pem("APPLE_PASS_CERT_PEM") and _pem("APPLE_PASS_KEY_PEM")
                and _pem("APPLE_WWDR_CERT_PEM")
                and all(os.path.isfile(os.path.join(ASSETS, f)) for f in APPLE_FILES))


def _google_sa():
    raw = os.environ.get("GOOGLE_WALLET_SA_JSON") or ""
    if raw.strip().startswith("{"):
        try:
            return json.loads(raw)
        except ValueError:
            return None
    path = raw.strip()
    if path and os.path.isfile(path):
        try:
            with open(path) as fh:
                return json.load(fh)
        except ValueError:
            return None
    return None


def google_ready():
    sa = _google_sa()
    return bool(_env("GOOGLE_WALLET_ISSUER_ID") and sa and sa.get("private_key") and sa.get("client_email"))


def status():
    """What the app may offer. Asked before every button is drawn."""
    return {"apple": apple_ready(), "google": google_ready()}


# ── the ticket, as both stores want to read it ─────────────────────────────
def _fields(attendee, event, pass_name, venue):
    start = getattr(event, "start_date", None)
    end = getattr(event, "end_date", None)
    name = ("%s %s" % (getattr(attendee, "first_name", "") or "",
                       getattr(attendee, "last_name", "") or "")).strip() or (attendee.email or "Guest")
    return {
        "name": name,
        "pass_name": pass_name or "Ticket",
        "event_name": getattr(event, "name", "") or "Gaia Healers event",
        "venue": venue or "",
        "start": start,
        "end": end,
        "qr": getattr(attendee, "qr_code", "") or "",
        "serial": "gaia-%s-%s" % (getattr(event, "id", 0), getattr(attendee, "id", 0)),
    }


def _iso(value):
    if not value:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()
    return str(value)


# ── Apple ──────────────────────────────────────────────────────────────────
def apple_pass_json(f):
    """An eventTicket, per Apple's PassKit shape."""
    body = {
        "formatVersion": 1,
        "passTypeIdentifier": _env("APPLE_PASS_TYPE_ID"),
        "teamIdentifier": _env("APPLE_TEAM_ID"),
        "organizationName": "Gaia Healers",
        "serialNumber": f["serial"],
        "description": "%s — entry pass" % f["event_name"],
        "backgroundColor": BG_COLOR,
        "foregroundColor": FG_COLOR,
        "labelColor": LABEL_COLOR,
        "logoText": "Gaia Healers",
        # The code IS the ticket: the same value the door scanner reads from a
        # printed badge, so a phone and a sticker are interchangeable.
        "barcodes": [{
            "format": "PKBarcodeFormatQR",
            "message": f["qr"],
            "messageEncoding": "iso-8859-1",
            "altText": f["qr"],
        }],
        "eventTicket": {
            "headerFields": [{"key": "pass", "label": "PASS", "value": f["pass_name"]}],
            "primaryFields": [{"key": "event", "label": "EVENT", "value": f["event_name"]}],
            "secondaryFields": [{"key": "name", "label": "ATTENDEE", "value": f["name"]}],
            "auxiliaryFields": [],
            "backFields": [
                {"key": "code", "label": "Badge code", "value": f["qr"]},
                {"key": "help", "label": "At the door",
                 "value": "Show this pass at check-in. If the scanner cannot read it, staff can type the badge code."},
            ],
        },
    }
    if f["venue"]:
        body["eventTicket"]["auxiliaryFields"].append({"key": "venue", "label": "VENUE", "value": f["venue"]})
    start = _iso(f["start"])
    if start:
        body["eventTicket"]["auxiliaryFields"].append(
            {"key": "start", "label": "STARTS", "value": start,
             "dateStyle": "PKDateStyleMedium", "timeStyle": "PKDateStyleShort"})
        # Apple shows the pass on the lock screen around this time.
        body["relevantDate"] = start
    end = _iso(f["end"])
    if end:
        body["expirationDate"] = end
    return body


def _sign_manifest(manifest_bytes):
    """PKCS#7 detached signature over manifest.json, as PassKit requires."""
    with tempfile.TemporaryDirectory() as tmp:
        p = lambda n: os.path.join(tmp, n)
        with open(p("manifest.json"), "wb") as fh:
            fh.write(manifest_bytes)
        for name, pem in (("cert.pem", _pem("APPLE_PASS_CERT_PEM")),
                          ("key.pem", _pem("APPLE_PASS_KEY_PEM")),
                          ("wwdr.pem", _pem("APPLE_WWDR_CERT_PEM"))):
            with open(p(name), "w") as fh:
                fh.write(pem)
        cmd = ["openssl", "smime", "-binary", "-sign",
               "-certfile", p("wwdr.pem"), "-signer", p("cert.pem"), "-inkey", p("key.pem"),
               "-in", p("manifest.json"), "-out", p("signature"), "-outform", "DER"]
        password = _env("APPLE_PASS_KEY_PASSWORD")
        if password:
            cmd += ["-passin", "pass:" + password]
        run = subprocess.run(cmd, capture_output=True)
        if run.returncode != 0:
            raise RuntimeError("pass signing failed: %s" % (run.stderr.decode("utf-8", "ignore")[:300]))
        with open(p("signature"), "rb") as fh:
            return fh.read()


def apple_pkpass(attendee, event, pass_name, venue):
    """-> bytes of a signed .pkpass. Raises if the certificate is not set up."""
    if not apple_ready():
        raise RuntimeError("Apple Wallet is not configured")
    f = _fields(attendee, event, pass_name, venue)
    files = {"pass.json": json.dumps(apple_pass_json(f), separators=(",", ":")).encode("utf-8")}
    for name in APPLE_FILES:
        with open(os.path.join(ASSETS, name), "rb") as fh:
            files[name] = fh.read()
    manifest = json.dumps({n: hashlib.sha1(b).hexdigest() for n, b in files.items()},
                          separators=(",", ":")).encode("utf-8")
    files["manifest.json"] = manifest
    files["signature"] = _sign_manifest(manifest)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, blob in files.items():
            zf.writestr(name, blob)
    return buf.getvalue()


# ── Google ─────────────────────────────────────────────────────────────────
def google_class_id():
    return "%s.gaia_event_ticket" % _env("GOOGLE_WALLET_ISSUER_ID")


def _localized(value):
    return {"defaultValue": {"language": "en-US", "value": value}}


def _image(url, description=""):
    return {"sourceUri": {"uri": url}, "contentDescription": _localized(description or "Gaia Healers")}


def google_object(attendee, event, pass_name, venue):
    f = _fields(attendee, event, pass_name, venue)
    obj = {
        "id": "%s.%s" % (_env("GOOGLE_WALLET_ISSUER_ID"), f["serial"].replace("-", "_")),
        "classId": google_class_id(),
        "state": "ACTIVE",
        "hexBackgroundColor": "#0a160e",
        "ticketHolderName": f["name"],
        "ticketNumber": f["qr"],
        "barcode": {"type": "QR_CODE", "value": f["qr"], "alternateText": f["qr"]},
        "textModulesData": [{"header": "Pass", "body": f["pass_name"], "id": "pass"}],
    }
    if venue:
        obj["textModulesData"].append({"header": "Venue", "body": venue, "id": "venue"})
    return obj


def google_class(event, venue):
    """The event itself, shared by every ticket for it.

    Google draws what the class gives it, so the logo and the event's own
    artwork go here: a pass with neither is a grey rectangle in a wallet full
    of branded ones, which is not what a $999 ticket should look like.
    """
    start, end = _iso(getattr(event, "start_date", None)), _iso(getattr(event, "end_date", None))
    app_base = _env("APP_PUBLIC_BASE", "https://gaiahealers.app").rstrip("/")
    cls = {
        "id": google_class_id(),
        "issuerName": "Gaia Healers",
        "reviewStatus": "UNDER_REVIEW",
        "eventName": _localized(getattr(event, "name", "") or "Gaia Healers event"),
        "hexBackgroundColor": "#0a160e",
        "logo": _image(_env("WALLET_LOGO_URL", app_base + "/assets/icon-512.png"), "Gaia Healers"),
    }
    hero = (getattr(event, "hero_image_url", "") or "").strip()
    if hero.startswith("https://"):
        cls["heroImage"] = _image(hero, getattr(event, "name", "") or "Event")
    if venue:
        cls["venue"] = {"name": _localized(venue), "address": _localized(venue)}
    if start or end:
        cls["dateTime"] = {k: v for k, v in (("start", start), ("end", end)) if v}
    # Somewhere to go from the pass itself, rather than back through the app.
    links = [u for u in (app_base + "/home.html?view=events&event=%s" % getattr(event, "id", ""),) if u]
    cls["linksModuleData"] = {"uris": [{"uri": links[0], "description": "Event programme", "id": "programme"}]}
    return cls


def google_save_url(attendee, event, pass_name, venue):
    """A 'Save to Google Wallet' link: a JWT carrying the class and the object,
    signed by the issuer's service account. Nothing is pre-registered with
    Google -- the first save creates both."""
    if not google_ready():
        raise RuntimeError("Google Wallet is not configured")
    from jose import jwt as jose_jwt
    sa = _google_sa()
    obj = google_object(attendee, event, pass_name, venue)
    obj.pop("eventTicketClass", None)
    payload = {
        "iss": sa["client_email"],
        "aud": "google",
        "typ": "savetowallet",
        "iat": int(time.time()),
        "exp": int(time.time() + timedelta(hours=1).total_seconds()),
        # Every origin the save link may be opened from. A missing one is the
        # usual cause of a link that opens and then refuses to save.
        "origins": sorted({o for o in (
            _env("APP_PUBLIC_BASE", "https://gaiahealers.app").rstrip("/"),
            "https://gaiahealers.app",
            "https://www.gaiahealers.app",
            "https://api.gaiahealers.app",
        ) if o}),
        "payload": {"eventTicketClasses": [google_class(event, venue)], "eventTicketObjects": [obj]},
    }
    token = jose_jwt.encode(payload, sa["private_key"], algorithm="RS256")
    return "https://pay.google.com/gp/v/save/%s" % token
