# -*- coding: utf-8 -*-
"""CARD PERMANENCE — the promise printed on a badge.

A badge card belongs to the PERSON. The event it was first issued at can end,
be archived, or be deleted outright, and the QR already printed on someone's
badge has to keep resolving to the same card, still editable by its owner.

This test proves exactly that, against the running service, with throwaway
events of its own. It creates what it needs and removes it again.

Run:  python3 /root/event/backend/test_card_permanence.py
"""
import json, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime, timedelta

env = {}
for line in open("/root/event/backend/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
SVC = env["IDENTITY_SERVICE_TOKEN"]
BASE = "http://127.0.0.1:8002"
DB = "/root/event/backend/event.db"
EMAIL = "card-permanence-test@example.invalid"

fails = []
def check(ok, label, detail=""):
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", label, "" if ok else "   %s" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, token=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            payload = r.read()
            return r.status, (payload if raw else json.loads(payload or "null"))
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, (payload if raw else json.loads(payload or "null"))
        except Exception:
            return e.code, payload

def sql(q, args=()):
    c = sqlite3.connect(DB)
    try:
        return c.execute(q, args).fetchall()
    finally:
        c.close()

print("CARD PERMANENCE")

# ── clean any wreckage from an interrupted run ─────────────────────────────
for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ card-permanence%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)

def make_event(label, days_ahead):
    start = datetime.utcnow() + timedelta(days=days_ahead)
    st, ev = call("POST", "/events", {
        "name": "ZZ card-permanence %s" % label,
        "start_date": start.isoformat(), "end_date": (start + timedelta(days=1)).isoformat(),
        "location": "Test", "timezone": "UTC"}, ADMIN)
    assert st in (200, 201) and ev.get("id"), (st, ev)
    return ev["id"]

def add_person(event_id):
    st, a = call("POST", "/attendees", {
        "event_id": event_id, "email": EMAIL,
        "first_name": "Pat", "last_name": "Permanence"}, ADMIN)
    assert st in (200, 201), (st, a)
    return a

ev_archive = make_event("archive", 30)
ev_delete = make_event("delete", 60)
a1 = add_person(ev_archive)
a2 = add_person(ev_delete)

ident = {"email": EMAIL, "email_verified": True, "event_id": ev_archive}

# ── the card, as its owner would set it up ────────────────────────────────
st, card = call("POST", "/identity/card", ident, SVC)
check(st == 200 and card.get("ok") and card.get("token"), "the ticket holder gets a card and a token", (st, card))
TOKEN = card["token"]

st, card = call("POST", "/identity/card/update", dict(
    ident, public=True, company="Permanence Test Co", title="Practitioner",
    bio="Set up before anything was archived or deleted."), SVC)
check(st == 200 and card.get("public") is True, "owner publishes the card", (st, card))

# one token for the person, on BOTH tickets
toks = sorted({r[0] for r in sql("SELECT public_token FROM attendees WHERE lower(email)=?", (EMAIL,))})
check(toks == [TOKEN], "one token across both of this person's events", toks)

def card_ok(stage):
    st, body = call("GET", "/c/" + TOKEN, raw=True)
    live = st == 200 and b"Permanence Test Co" in body and b"Pat Permanence" in body
    check(live, "%s: the printed QR still opens the card, with its content" % stage,
          (st, body[:120] if isinstance(body, bytes) else body))
    st2, own = call("POST", "/identity/card", {"email": EMAIL, "email_verified": True, "event_id": 0}, SVC)
    check(st2 == 200 and own.get("ok") and own.get("token") == TOKEN,
          "%s: the owner still reaches the same card, and the token is unchanged" % stage, (st2, own))
    st3, upd = call("POST", "/identity/card/update", {
        "email": EMAIL, "email_verified": True, "event_id": 0,
        "city": "Edited after " + stage}, SVC)
    check(st3 == 200 and (upd.get("fields") or {}).get("city") == "Edited after " + stage,
          "%s: the card is still editable" % stage, (st3, upd))
    return own

before = card_ok("before")
events_before = [e.get("label") for e in (before.get("events") or [])]
check(len(events_before) == 2, "both events show in the participation history", events_before)

# ── ARCHIVE ───────────────────────────────────────────────────────────────
st, _ = call("PUT", "/events/%d" % ev_archive, {"is_archived": True}, ADMIN)
check(st == 200, "event archived", st)
card_ok("after archive")

# ── DELETE ────────────────────────────────────────────────────────────────
prof_before = sql("SELECT COUNT(*) FROM networking_profiles p JOIN attendees a ON a.id=p.attendee_id WHERE a.event_id=?", (ev_delete,))[0][0]
st, _ = call("DELETE", "/events/%d" % ev_delete, token=ADMIN)
check(st == 200, "event deleted", st)
check(sql("SELECT COUNT(*) FROM attendees WHERE event_id=?", (ev_delete,))[0][0] == 0,
      "the deleted event's attendee rows are gone")
after = card_ok("after delete")
labels = [e.get("label") for e in (after.get("events") or [])]
check(len(labels) == 2, "the deleted event stays in the history — attending it still happened", labels)

# ── DELETE THE LAST ONE TOO: a card with no tickets at all ────────────────
st, _ = call("DELETE", "/events/%d" % ev_archive, token=ADMIN)
check(st == 200, "the last remaining event deleted too", st)
check(sql("SELECT COUNT(*) FROM attendees WHERE lower(email)=?", (EMAIL,))[0][0] == 0,
      "this person now has NO attendee row anywhere")
card_ok("with no tickets left")

# ── nothing personal left dangling ────────────────────────────────────────
orphans = sql("SELECT COUNT(*) FROM networking_profiles p WHERE NOT EXISTS (SELECT 1 FROM attendees a WHERE a.id = p.attendee_id)")[0][0]
check(orphans == 0, "no orphaned networking profiles left behind by the deletes", orphans)
for tbl, col in (("saved_sessions", "attendee_id"), ("connections", "requester_id"), ("feedback", "attendee_id")):
    try:
        n = sql("SELECT COUNT(*) FROM %s t WHERE NOT EXISTS (SELECT 1 FROM attendees a WHERE a.id = t.%s)" % (tbl, col))[0][0]
    except Exception:
        n = 0
    check(n == 0, "no orphaned rows in %s" % tbl, n)

# ── the card never leaked anything internal ───────────────────────────────
st, body = call("GET", "/c/" + TOKEN, raw=True)
text = body.decode("utf-8", "replace") if isinstance(body, bytes) else str(body)
leaks = [w for w in ("ATT-", "attendee_id", "ticket_type", "order_id", "contact_id", EMAIL) if w in text]
check(not leaks, "the public card exposes no ticket, order, contact or attendee identifier", leaks)

# ── clean up ──────────────────────────────────────────────────────────────
c = sqlite3.connect(DB)
c.execute("DELETE FROM member_card_events WHERE card_id IN (SELECT id FROM member_cards WHERE public_token=?)", (TOKEN,))
c.execute("DELETE FROM member_cards WHERE public_token=?", (TOKEN,))
c.commit(); c.close()
for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ card-permanence%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)

print()
if fails:
    print("%d CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL CHECKS PASSED - a claimed card outlives its events")
