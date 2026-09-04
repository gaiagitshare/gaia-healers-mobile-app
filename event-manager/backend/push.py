"""Web Push (VAPID) sending for event notifications.

Multi-event by construction: every subscription is tied to an attendee (hence a
single event), and every send is scoped to one event_id — so this serves the
current event and every future event created with the Event Builder.

Config is read lazily (per call), not at import time, because this module is
imported before main.py calls load_dotenv().
"""
import os
import json
from pywebpush import webpush, WebPushException


def _private_key_file():
    return os.getenv("VAPID_PRIVATE_KEY_FILE", "").strip()


def _subject():
    return os.getenv("VAPID_SUBJECT", "mailto:support@gaiahealers.com").strip()


def application_server_key():
    return os.getenv("VAPID_APPLICATION_SERVER_KEY", "").strip()


def push_configured():
    f = _private_key_file()
    return bool(f and os.path.exists(f) and application_server_key())


def send_one(endpoint, p256dh, auth, payload):
    """Send one web push. Returns (ok, gone). gone=True means the subscription
    is expired/invalid (404/410) and the caller should delete it."""
    try:
        webpush(
            subscription_info={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
            data=json.dumps(payload),
            vapid_private_key=_private_key_file(),
            vapid_claims={"sub": _subject()},
            ttl=3600,
        )
        return (True, False)
    except WebPushException as exc:
        code = getattr(getattr(exc, "response", None), "status_code", None)
        return (False, code in (404, 410))
    except Exception:
        return (False, False)
