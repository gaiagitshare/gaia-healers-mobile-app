# -*- coding: utf-8 -*-
"""EVENT SAFETY RELEASE A (9 Nov 2026), on a testbed copy with synthetic people.

  A1  Badge/card codes keep working at the door (re-entry convenience), and
      cannot double-admit or get round day or zone rules.
  A2  The PUBLIC badge/card code no longer opens a ticket page, QR image or
      wallet pass; the private ticket link (derived from the ticket's own entry
      code) does. No entry QR changes.
  A3  A transfer gives the ticket the new holder's own badge code; the previous
      holder keeps their card; the entry QR is unchanged.
  A4  Two people on one GHL contact each resolve to their own ticket.
Run:  python3 /root/event/backend/test_event_safety_a.py
"""
import json, os, secrets, sqlite3, sys, threading, urllib.error, urllib.request
from datetime import datetime

HERE = "/root/event/backend"
sys.path.insert(0, HERE)
os.environ["ALLOW_SCAN_TIME_OVERRIDE"] = "1"     # date override for the day-pass check (copy only)
import testbed
BASE, DB = testbed.start()
import main, models, identity, ticket_links    # noqa: E402
from database import SessionLocal                # noqa: E402

env = {}
for line in open(HERE + "/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
SVC = {"Authorization": "Bearer " + env["IDENTITY_SERVICE_TOKEN"]}
ADMIN = {"Authorization": "Bearer " + main.create_access_token({"sub": "1", "adm": True})}
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, headers=ADMIN):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            try: return r.status, json.loads(raw.decode() or "null")
            except Exception: return r.status, raw
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b

db = sqlite3.connect(DB, timeout=30)
EV, TAG = 1, secrets.token_hex(3)
event_day = db.execute("select date(start_date) from events where id=?", (EV,)).fetchone()[0]
call("POST", "/events/%d/door-test-mode" % EV, {"enabled": False})   # judge real days on the copy
SECRET = env.get("SECRET_KEY")

def ticket(who, **extra):
    body = dict({"event_id": EV, "email": "zz-%s-%s@example.invalid" % (who, TAG), "first_name": "Zz",
                 "last_name": who, "ticket_type_id": 7}, **extra)
    st, a = call("POST", "/attendees", body)
    assert st == 200, (st, a)
    return a

def scan(code, zone="EVENT_ENTRY", at=event_day):
    return call("POST", "/events/%d/authorize" % EV, {"qr_code": code, "access_type": zone, "at": at,
                                                       "scan_id": secrets.token_hex(12)})[1]

print("\n== A1: badge codes at the door stay safe ==")
a = ticket("door")
results = []
def go(code):
    results.append(scan(code))
ts = [threading.Thread(target=go, args=(c,)) for c in (a["qr_code"], a["public_token"], a["qr_code"], a["public_token"])]
[t.start() for t in ts]; [t.join() for t in ts]
fresh = sum(1 for r in results if r.get("checked_in_now"))
check(fresh == 1, "ticket QR and badge code scanned at the same moment: exactly one admission", [r.get("result") for r in results])
r = scan(a["public_token"])
check(r.get("result") == "LIMITED", "re-entry off: the badge code cannot admit a second time", r.get("reason"))
st, _ = call("POST", "/events/%d/re-entry" % EV, {"enabled": True})
r = scan("HTTPS://CARD.GAIAHEALERS.APP/" + a["public_token"])
check(r.get("result") == "GRANTED" and not r.get("checked_in_now"), "re-entry on: the badge (card URL form) re-admits, no new check-in", r.get("reason"))
r = scan(a["public_token"], zone="VIP")
check(r.get("result") != "GRANTED", "a badge cannot open a zone the ticket does not include (VIP)", r.get("result"))
one_day = db.execute("select id, valid_day from ticket_types where event_id=? and valid_day is not null and valid_day!='' limit 1", (EV,)).fetchone()
if one_day:
    b = ticket("oneday", ticket_type_id=one_day[0])
    wrong = "2026-11-22" if one_day[1] != "2026-11-22" else "2026-11-20"
    r = scan(b["public_token"], at=wrong)
    check(r.get("result") == "DENIED", "a hand-added one-day ticket's badge is refused on another day", (one_day[1], wrong, r.get("reason")))
    r = scan(b["qr_code"], zone="EXHIBIT", at=wrong)
    check(r.get("result") == "DENIED", "and its ticket QR cannot open the exhibit hall on another day", r.get("reason"))
    r = scan(b["qr_code"], zone="EXHIBIT", at=str(one_day[1])[:10])
    check(r.get("result") == "GRANTED", "but works on its own day", r.get("reason"))
else:
    print("  SKIP  no one-day ticket type in this copy")
call("POST", "/events/%d/re-entry" % EV, {"enabled": False})

print("\n== A2: the public badge/card code opens no ticket ==")
c = ticket("link")
code = ticket_links.link_code(c["qr_code"], SECRET)
check(code and len(code) == 20 and code != c["public_token"], "each ticket has a private link code, different from its badge code", code)
st, t = call("GET", "/identity/ticket/by-token/%s" % code, headers=SVC)
check(st == 200 and t.get("ok") and t.get("qr_code") == c["qr_code"], "the private link opens the ticket and its entry QR", (st, t.get("reason") if isinstance(t, dict) else t))
st, t = call("GET", "/identity/ticket/by-token/%s" % c["public_token"], headers=SVC)
check(st == 200 and not t.get("ok") and "qr_code" not in t, "the public badge/card code does NOT open the ticket", t)
st, _ = call("GET", "/identity/badge-qr/%s" % code, headers=SVC)
check(st == 200, "the private link serves the QR image (for the e-mail)", st)
st, _ = call("GET", "/identity/badge-qr/%s" % c["public_token"], headers=SVC)
check(st == 404, "the badge code serves no QR image", st)
st, w = call("POST", "/identity/wallet/by-token", {"store": "google", "token": c["public_token"]}, headers=SVC)
check(not (isinstance(w, dict) and w.get("ok")), "the badge code gets no wallet pass", w)
check(db.execute("select qr_code from attendees where id=?", (c["id"],)).fetchone()[0] == c["qr_code"], "the entry QR itself is unchanged", None)
for (q,) in db.execute("select qr_code from attendees where event_id=? and qr_code is not null limit 50", (EV,)):
    if ticket_links.link_code(q, SECRET) == ticket_links.link_code(q + "x", SECRET):
        check(False, "link codes collide", q)
check(ticket_links.find(SessionLocal(), models, "A" * 20, SECRET) is None, "a made-up link code opens nothing", None)

print("\n== A3: a transfer moves the badge to the new holder ==")
g = ticket("giver", phone="+10000000001")
s = SessionLocal()
main.attach_member_identity(s, s.get(models.Attendee, g["id"]), commit=True)
giver_card = s.query(models.MemberCard).filter(models.MemberCard.public_token == g["public_token"]).first()
check(giver_card is not None, "the giver has a card on their badge code", None)
new_email = "zz-receiver-%s@example.invalid" % TAG
pay_before = db.execute("select count(*), coalesce(sum(amount),0) from payment_events where attendee_id=?", (g["id"],)).fetchone()
st, tr = call("POST", "/attendees/%d/transfer" % g["id"], {"email": new_email, "first_name": "Zz", "last_name": "Receiver", "reason": "synthetic transfer"})
check(st == 200, "transfer accepted", (st, tr))
row = db.execute("select qr_code, public_token, ticket_type_id from attendees where id=?", (g["id"],)).fetchone()
check(row[0] == g["qr_code"], "the entry QR is unchanged", None)
check(row[1] and row[1] != g["public_token"], "the ticket now has the new holder's own badge code", (g["public_token"], row[1]))
s.expire_all()
gc = s.get(models.MemberCard, giver_card.id)
check(gc.public_token == g["public_token"] and "giver" in (gc.name or "").lower(), "the previous holder keeps their own card and name", (gc.public_token, gc.name))
st, ctx = call("GET", "/c/%s.json" % row[1], headers={})
check(st == 200 and "receiver" in json.dumps(ctx).lower() and "giver" not in json.dumps(ctx).lower().replace("receiver", ""), "the new badge code opens the new holder's card", st)
st, own = call("POST", "/identity/card/owner", {"token": g["public_token"], "email": new_email, "email_verified": True}, headers=SVC)
check(not (isinstance(own, dict) and own.get("owner")), "the new holder does not own the previous holder's card", own)
check(db.execute("select count(*), coalesce(sum(amount),0) from payment_events where attendee_id=?", (g["id"],)).fetchone() == pay_before,
      "payments untouched", None)
hist = json.loads(db.execute("select custom_data from attendees where id=?", (g["id"],)).fetchone()[0] or "{}")
check((hist.get("transfers") or [{}])[-1].get("badge_code_replaced") is True, "the transfer record notes the badge change", None)
s.close()

print("\n== A4: one GHL contact shared by two people ==")
cid = "zzcontact" + TAG
p1 = ticket("partner-one"); p2 = ticket("partner-two")
for pid in (p1["id"], p2["id"]):
    cd = json.loads(db.execute("select custom_data from attendees where id=?", (pid,)).fetchone()[0] or "{}")
    cd["contact_id"] = cid
    db.execute("update attendees set custom_data=? where id=?", (json.dumps(cd), pid))
db.commit()
s = SessionLocal()
rows, ev, rep = identity.resolve_attendees(s, contact_id=cid, email=p1["email"], email_verified=True)
ids = {a.id for a in rows}
check(p1["id"] in ids and p2["id"] not in ids, "partner one, signed in with their email, sees only their own ticket", sorted(ids))
rows, ev, rep = identity.resolve_attendees(s, contact_id=cid, email=p2["email"], email_verified=True)
ids = {a.id for a in rows}
check(p2["id"] in ids and p1["id"] not in ids, "partner two likewise", sorted(ids))
rows, ev, rep = identity.resolve_attendees(s, contact_id=cid, email="zz-changed-%s@example.invalid" % TAG, email_verified=True)
check({p1["id"], p2["id"]} <= {a.id for a in rows}, "a member whose email changed still matches by contact (unchanged)", None)
buyer = ticket("buyer")
seat_email = buyer["email"].replace("@", "+seat2@")
seat = ticket("seat", email=seat_email)
for pid in (buyer["id"], seat["id"]):
    cd = json.loads(db.execute("select custom_data from attendees where id=?", (pid,)).fetchone()[0] or "{}")
    cd["contact_id"] = cid + "b"
    db.execute("update attendees set custom_data=? where id=?", (json.dumps(cd), pid))
db.commit()
s.expire_all()
rows, ev, rep = identity.resolve_attendees(s, contact_id=cid + "b", email=buyer["email"], email_verified=True)
check({buyer["id"], seat["id"]} <= {a.id for a in rows}, "a buyer still sees the party seat they paid for", None)
s.close()

print("\n%d check(s) failed" % len(fails) if fails else "\nALL CHECKS PASSED")
sys.exit(1 if fails else 0)
