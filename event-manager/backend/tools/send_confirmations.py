# -*- coding: utf-8 -*-
"""Tell the people who paid that they hold a ticket.

GoHighLevel sends the registration confirmation from a workflow, and a
workflow has to be attached to each product by hand. New exhibit-hall and
day-pass products were added without that, so 88 of 339 paid attendees for
Elevate 2026 were never told the dates or the venue -- and 20 have had no
e-mail of any kind. The people who bought most recently fared worst.

This does not fix the workflow; nobody can, from here, because GHL's API has
no way to edit one. It removes the DEPENDENCE on it. The system that knows who
holds a ticket now says so itself, and records that it did, so the same person
is never told twice and the next new product cannot repeat this.

The e-mail is docs/ticket-email.html with the merge fields filled in from the
attendee's own row -- the same block that goes in GHL, so the two cannot drift.

  python3 tools/send_confirmations.py                 # who would be written to
  python3 tools/send_confirmations.py --limit 10      # the first ten only
  python3 tools/send_confirmations.py --apply         # actually send
  python3 tools/send_confirmations.py --apply --to a@b.com   # one person, to test

Sending is off by default and --apply is required, because this writes to real
people on somebody else's behalf.
"""
import argparse, html, json, os, re, sqlite3, sys, time, urllib.error, urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HERE, "event.db")
TEMPLATE = os.path.join(os.path.dirname(HERE), "docs", "ticket-email.html")
SUBJECT = "Your ticket for Elevate 2026 — November 20–22, Orlando"

env = {}
for line in open(os.path.join(HERE, ".env")):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
PROXY = (env.get("GAIA_PROXY_BASE_URL") or "https://api.gaiahealers.app").rstrip("/")
SVC = env.get("IDENTITY_SERVICE_TOKEN", "")


def render(template, fields):
    out = re.sub(r"<!--[\s\S]*?-->", "", template, count=1)
    for key, value in fields.items():
        out = out.replace("{{contact.%s}}" % key, html.escape(str(value or "")))
    left = re.findall(r"\{\{[^}]+\}\}", out)
    if left:
        raise RuntimeError("unfilled merge fields: %s" % sorted(set(left)))
    return out


def notify(contact_id, subject, body):
    request = urllib.request.Request(
        PROXY + "/api/event/notify",
        data=json.dumps({"contactId": contact_id, "subject": subject, "html": body}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + SVC})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        return {"ok": False, "reason": "http_%d" % exc.code, "detail": exc.read().decode()[:160]}
    except Exception as exc:                                  # noqa: BLE001
        return {"ok": False, "reason": "unreachable", "detail": str(exc)[:160]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually send; otherwise print who would be written to")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many")
    ap.add_argument("--to", help="only this e-mail address, for a test send")
    ap.add_argument("--event", type=int, default=1)
    ap.add_argument("--resend", action="store_true", help="include people already confirmed")
    args = ap.parse_args()

    template = open(TEMPLATE).read()
    db = sqlite3.connect(DB, timeout=30)
    db.isolation_level = None
    rows = db.execute("""
        select id, first_name, last_name, lower(trim(coalesce(email,''))),
               coalesce(acq_contact_id,''), coalesce(public_token,''),
               coalesce(confirmation_sent_at,'')
        from attendees
        where event_id = ? and coalesce(registration_status,'') not in ('cancelled','refunded','revoked')
        order by coalesce(acq_purchased_at, created_at)""", (args.event,)).fetchall()

    queue, blocked = [], []
    for aid, first, last, email, contact, token, sent_at in rows:
        if args.to and email != args.to.lower().strip():
            continue
        if sent_at and not args.resend:
            continue
        why = []
        if not contact: why.append("no GHL contact id")
        if not token: why.append("no badge token")
        if not email: why.append("no e-mail address")
        (blocked if why else queue).append((aid, first, last, email, contact, token, "; ".join(why)))

    print("EVENT %d — %d people on file" % (args.event, len(rows)))
    print("  ready to be told ........ %d" % len(queue))
    print("  cannot be told yet ...... %d" % len(blocked))
    if blocked:
        for aid, first, last, email, _c, _t, why in blocked[:10]:
            print("      id=%-4d %-26s %-34s %s" % (aid, ((first or "") + " " + (last or ""))[:26], email[:34], why))
        if len(blocked) > 10:
            print("      … and %d more" % (len(blocked) - 10))

    if args.limit:
        queue = queue[:args.limit]
    if not args.apply:
        print("\nDRY RUN — nothing sent. %d would receive \"%s\"" % (len(queue), SUBJECT))
        for aid, first, last, email, _c, token, _w in queue[:15]:
            print("   id=%-4d %-26s %-34s token=%s" % (aid, ((first or "") + " " + (last or ""))[:26], email[:34], token))
        if len(queue) > 15:
            print("   … and %d more" % (len(queue) - 15))
        print("\nAdd --apply to send.")
        db.close()
        return 0

    load_passes(args.event)
    print("\nSENDING to %d people" % len(queue))
    ok = failed = 0
    for aid, first, last, email, contact, token, _w in queue:
        body = render(template, {
            "first_name": (first or "there").strip(),
            "gaia_badge_token": token,
            "gaia_pass": PASS_CACHE.get(aid, ""),
            "gaia_pass_includes": INCLUDES_CACHE.get(aid, ""),
        })
        result = notify(contact, SUBJECT, body)
        stamp = datetime.utcnow().isoformat()
        db.execute("update attendees set confirmation_sent_at=?, confirmation_result=? where id=?",
                   (stamp if result.get("ok") else None,
                    "ok" if result.get("ok") else (result.get("reason") or "failed")[:60], aid))
        if result.get("ok"):
            ok += 1
        else:
            failed += 1
            print("   FAILED %-34s %s" % (email[:34], result.get("reason")))
        time.sleep(0.4)                       # GHL rate limits; this is not a race
    print("\nsent %d, failed %d" % (ok, failed))
    db.close()
    return 1 if failed else 0


PASS_CACHE, INCLUDES_CACHE = {}, {}


def load_passes(event_id):
    """The pass name and what it includes, straight from the API that Admin,
    the ticket page and the badge all read, so the e-mail cannot disagree."""
    db = sqlite3.connect(DB, timeout=30)
    tokens = [r[0] for r in db.execute(
        "select coalesce(public_token,'') from attendees where event_id=? and coalesce(public_token,'')<>''",
        (event_id,))]
    ids = {r[0]: r[1] for r in db.execute(
        "select coalesce(public_token,''), id from attendees where event_id=?", (event_id,))}
    db.close()
    for token in tokens:
        try:
            request = urllib.request.Request(
                "http://127.0.0.1:8002/identity/ticket/by-token/" + token,
                headers={"Authorization": "Bearer " + SVC})
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode())
            if payload.get("ok"):
                PASS_CACHE[ids[token]] = payload.get("pass_label", "")
                INCLUDES_CACHE[ids[token]] = payload.get("pass_includes", "")
        except Exception:                                      # noqa: BLE001
            continue


if __name__ == "__main__":
    sys.exit(main())
