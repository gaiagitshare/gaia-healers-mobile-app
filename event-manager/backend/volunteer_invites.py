# -*- coding: utf-8 -*-
"""Volunteer invitation email (7 Nov 2026).

Reuses the route every Gaia email already takes: the proxy's /api/event/notify,
which sends through GHL Conversations to an existing GHL contact. A volunteer
is matched to a contact by EXACT email (read-only lookup); no contact is ever
created or changed, because creating one can start GHL workflows. A contact
with email Do-Not-Disturb is never emailed.

SENDING IS OFF unless the server sets VOLUNTEER_INVITES_ENABLED=1. Until the
owner approves, every send is refused and only the preview works.
VOLUNTEER_INVITES_FAKE=1 (tests) records sends without any network call.
"""
import html as _html
import json
import os
import urllib.error
import urllib.parse
import urllib.request

PROXY_ENV = "/root/gaia-staging-proxy/.env"
NOTIFY_URL = os.environ.get("GAIA_NOTIFY_URL", "http://127.0.0.1:8787/api/event/notify")
FAKE_SENT = []          # tests only


def enabled():
    return os.environ.get("VOLUNTEER_INVITES_ENABLED") == "1"


def fake():
    return os.environ.get("VOLUNTEER_INVITES_FAKE") == "1"


def _cfg():
    try:
        from dotenv import dotenv_values
        return dict(dotenv_values(PROXY_ENV))
    except Exception:
        return {}


def _ghl(path):
    cfg = _cfg()
    base = (cfg.get("GHL_API_BASE_URL") or "https://services.leadconnectorhq.com").rstrip("/")
    req = urllib.request.Request(base + path, headers={"Authorization": "Bearer " + cfg.get("GHL_API_TOKEN", ""),
                                                       "Version": "2021-07-28", "Accept": "application/json",
                                                       "User-Agent": "Gaia-volunteer-invite"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)


def find_contact(email):
    """(contact_id, None) or (None, reason in plain words)."""
    if not email:
        return None, "no email address"
    if fake():
        if email.endswith("@not-in-ghl.invalid"):
            return None, "not found in GHL"
        if email.endswith("@dnd.invalid"):
            return None, "has email turned off in GHL (do not disturb)"
        return "fake-" + email, None
    cfg = _cfg()
    try:
        data = _ghl("/contacts/?locationId=%s&query=%s&limit=10" % (cfg.get("GHL_LOCATION_ID", ""), urllib.parse.quote(email)))
    except Exception:
        return None, "GHL could not be reached; try again"
    exact = [c for c in data.get("contacts", []) if (c.get("email") or "").strip().lower() == email.lower()]
    if not exact:
        return None, "not found in GHL"
    if len(exact) > 1:
        return None, "several GHL contacts share this email"
    c = exact[0]
    dnd_email = ((c.get("dndSettings") or {}).get("Email") or {}).get("status") == "active"
    if c.get("dnd") or dnd_email:
        return None, "has email turned off in GHL (do not disturb)"
    return c.get("id"), None


def render(first_name, link, event_name, title):
    f = _html.escape(first_name or "there")
    link_e = _html.escape(link, quote=True)
    subject = "Your volunteer page: %s" % (event_name or "Gaia Healers ELEVATE")
    body = """<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1d2a1f">
<h2 style="color:#2f5d3a">Hi %s, welcome to the volunteer team!</h2>
<p>Thank you for volunteering at <b>%s</b>, November 20–22, 2026 at Rosen Shingle Creek, Orlando.</p>
<p>Your personal volunteer page is ready. There you can see the full schedule, request the shifts you would like,
and see who else is on each shift. The team confirms each request.</p>
<p style="text-align:center;margin:28px 0"><a href="%s" style="background:#2f5d3a;color:#fff;padding:14px 26px;border-radius:8px;text-decoration:none;font-weight:bold">Open my volunteer page</a></p>
<p style="font-size:13px;color:#555">This link is personal to you; please do not forward it. If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">%s</span></p>
<p>With gratitude,<br>The Gaia Healers volunteer team</p></div>""" % (f, _html.escape(event_name or title or "Gaia Healers ELEVATE"), link_e, link_e)
    return subject, body


def send(contact_id, subject, html):
    """{'ok': bool, 'message_id': str|None, 'reason': str|None}. Refuses when sending is off."""
    if not enabled():
        return {"ok": False, "message_id": None, "reason": "sending is switched off"}
    if fake():
        FAKE_SENT.append({"contact_id": contact_id, "subject": subject})
        return {"ok": True, "message_id": "fake-%d" % len(FAKE_SENT), "reason": None}
    svc = os.environ.get("IDENTITY_SERVICE_TOKEN") or _cfg().get("IDENTITY_SERVICE_TOKEN", "")
    req = urllib.request.Request(NOTIFY_URL, data=json.dumps({"contactId": contact_id, "subject": subject, "html": html}).encode(),
                                 headers={"Authorization": "Bearer " + svc, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=35) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            d = json.load(e)
        except Exception:
            d = {}
        return {"ok": False, "message_id": None, "reason": d.get("reason") or d.get("error") or "the email service refused it"}
    except Exception:
        return {"ok": False, "message_id": None, "reason": "the email service could not be reached"}
    mid = d.get("messageId") or d.get("emailMessageId") or d.get("id")
    return {"ok": bool(d.get("ok", True)), "message_id": mid, "reason": d.get("reason")}


def provider_status(message_id):
    """What GHL now says about a sent message: delivered | opened | failed | None."""
    if not message_id:
        return None
    if fake():
        return "delivered"
    try:
        e = _ghl("/conversations/messages/email/" + urllib.parse.quote(message_id)).get("emailMessage", {})
        st = (e.get("status") or "").lower()
    except Exception:
        return None
    if st in ("opened", "clicked"):
        return "opened"
    if st in ("failed", "bounced", "rejected", "complained", "undelivered", "permanent_fail"):
        return "failed"
    if st in ("delivered", "sent"):
        return "delivered"
    return None
