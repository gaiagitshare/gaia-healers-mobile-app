# -*- coding: utf-8 -*-
"""TICKET RECONCILIATION & ISSUE RESOLUTION (7 Nov 2026).

On a testbed copy of the live database: the checks find the known problems
(booking #204 and the seven other incomplete bookings), administrators resolve
them through the same API the screen uses, and nothing they do can issue a
duplicate ticket, exceed what was paid for, touch a payment, or send an email.
Run:  python3 /root/event/backend/test_reconciliation.py
"""
import csv, hashlib, json, os, secrets, sqlite3, sys, urllib.error, urllib.request

HERE = "/root/event/backend"
sys.path.insert(0, HERE)
import testbed
BASE, DB = testbed.start()
import main                                                    # noqa: E402

env = {}
for line in open(HERE + "/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
SVC = {"Authorization": "Bearer " + env["IDENTITY_SERVICE_TOKEN"]}
ADMIN = {"Authorization": "Bearer " + main.create_access_token({"sub": "3", "adm": True})}
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
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b

db = sqlite3.connect(DB, timeout=30)
EV = 1
DELIVERY = os.environ.get("TICKET_DELIVERY_DB") or os.path.join(HERE, "data", "ticket-delivery.db")
def delivery_records():
    """What was sent and every attempt -- not the whole file: on the live server
    the automatic sender's shadow check updates its own bookkeeping every two
    minutes, which is not a send."""
    if not os.path.exists(DELIVERY):
        return None
    d = sqlite3.connect("file:%s?mode=ro" % DELIVERY, uri=True)
    try:
        return [d.execute("select * from order_ticket_delivery order by event_id, order_id").fetchall(),
                d.execute("select * from delivery_attempts order by id").fetchall(),
                d.execute("select * from resend_requests order by id").fetchall()]
    finally:
        d.close()
dsha = delivery_records()
pay_before = db.execute("select count(*), coalesce(sum(amount),0), group_concat(id||status||coalesce(attendee_id,'')) from payment_events").fetchone()
tickets_before = db.execute("select count(*) from attendees").fetchone()[0]
door = db.execute("select u.id from users u join event_roles r on r.user_id=u.id where r.role='checkin_staff' limit 1").fetchone()
DOOR = {"Authorization": "Bearer " + main.create_access_token({"sub": str(door[0])})} if door else None

W = "/root/Documents/Codex/2026-11-03/files-pasted-by-the-user-gaia/work/tonight"
if not os.path.exists(W + "/private/send-manifest-remaining.json"):
    print("  SKIP  the bulk list is not on this machine"); sys.exit(0)
M = json.load(open(W + "/private/send-manifest-remaining.json"))
held = {r["ORDER ID"]: r["SEND ELIGIBILITY"] + ": " + r["HOLD REASONS"]
        for r in csv.DictReader(open(W + "/private/FINAL_SEND_MANIFEST_2026-11-03.csv")) if r["SEND ELIGIBILITY"] != "GREEN"}

print("\n== the checks find the known problems ==")
st, g = call("POST", "/internal/ticket-delivery/preflight", {"event_id": EV, "orders": M["orders"], "held_orders": held,
             "delivered_ticket_ids": [], "auto_sender_cutoff": "2026-11-03 15:46:00", "record": True}, headers=SVC)
check(st == 200 and g.get("ok") is False, "the bulk check records the list and still blocks it", (st, g.get("ok") if isinstance(g, dict) else g))
st, s = call("GET", "/events/%d/reconcile/summary" % EV)
check(st == 200 and s["unresolved"] > 0 and s["bulk_check"]["imported"] and not s["bulk_check"]["ok"]
      and s["bulk_check"]["sending"] == "locked", "dashboard: unresolved issues, bulk email blocked and locked", s.get("bulk_check"))

def issue(key):
    st, l = call("GET", "/events/%d/reconcile/issues?status=all&q=%s" % (EV, key.split(":")[-1]))
    for r in l.get("rows", []):
        if r["key"] == key:
            return call("GET", "/events/%d/reconcile/issues/%d" % (EV, r["id"]))[1]
    return None

b204 = issue("booking:204")
check(b204 and b204["priority"] == "critical" and "4" in b204["title"] and "missing" in b204["explanation"]
      and "email" in b204["explanation"], "booking #204 is a CRITICAL issue explaining the missing seat and the email gap",
      b204 and (b204["priority"], b204["title"]))
check(b204 and b204["booking"]["paid_for"] == 4 and b204["booking"]["missing_seats"] == 1 and len(b204["payments"]) >= 4,
      "#204 detail: bought 4, 1 missing, its payments listed", b204 and b204["booking"])
seven = [57, 58, 122, 252, 614, 752, 753]
found = {b: issue("booking:%d" % b) for b in seven}
check(all(found.values()), "the seven other incomplete bookings are all there", [b for b, v in found.items() if not v])
st, l = call("GET", "/events/%d/reconcile/issues?q=%s" % (EV, "204"))
check(st == 200 and any(r["key"] == "booking:204" for r in l["rows"]), "search by ticket number finds the booking", l.get("total"))

print("\n== permissions ==")
if DOOR:
    st, _ = call("GET", "/events/%d/reconcile/summary" % EV, headers=DOOR)
    check(st == 403, "door staff cannot open the Reconciliation Center", st)
    st, _ = call("POST", "/events/%d/reconcile/issues/%d/action" % (EV, b204["id"]), {"action": "hold", "note": "x x x", "ticket_ids": [204]}, headers=DOOR)
    check(st == 403, "door staff cannot correct anything", st)

print("\n== issuing a missing seat ==")
b57 = found[57]
act = lambda i, body: call("POST", "/events/%d/reconcile/issues/%d/action" % (EV, i["id"]), body)
st, _ = act(b57, {"action": "issue_seat", "first_name": "Guest of", "last_name": "buyer", "note": "buyer confirmed by phone"})
check(st == 428, "issuing a seat needs explicit confirmation", st)
st, _ = act(b57, {"action": "issue_seat", "first_name": "Guest", "confirm": True, "note": ""})
check(st == 400, "and a note", st)
st, r = act(b57, {"action": "issue_seat", "first_name": "Guest of", "last_name": "buyer", "confirm": True, "note": "buyer confirmed by phone"})
new57 = (r.get("result") or {}).get("issued_ticket_id") if isinstance(r, dict) else None
check(st == 200 and new57, "with both, one ticket is issued against the paid booking", (st, r))
st, r = act(b57, {"action": "issue_seat", "first_name": "Guest", "last_name": "Again", "confirm": True, "note": "second try"})
check(st == 409, "a second seat is refused: the booking has every ticket it paid for", (st, r))
seats57 = db.execute("select count(*) from attendees where id=57 or json_extract(custom_data,'$.bought_by_attendee')=57").fetchone()[0]
check(seats57 == 2, "booking #57 now holds exactly the 2 tickets it paid for", seats57)

print("\n== suspected duplicate charges are never issued by default ==")
b58 = found[58]
st, r = act(b58, {"action": "issue_seat", "first_name": "Guest", "confirm": True, "note": "trying a seat"})
check(st == 409 and "duplicate" in str(r).lower(), "a seat on a booking with a suspected duplicate payment is refused", (st, r))
dup58 = issue("duplicate-payment:58")
st, r = act(dup58, {"action": "mark_duplicate", "note": "looks like a double click"})
check(st == 200, "a duplicate can be marked for review (no money moves)", (st, r))
st, r = call("POST", "/events/%d/reconcile/issues/%d/status" % (EV, dup58["id"]), {"status": "reviewed", "real_seat": True, "note": "buyer says 3 people are coming"})
check(st == 200, "an administrator records that it was a real seat", (st, r))
st, r = act(b58, {"action": "issue_seat", "first_name": "Guest", "last_name": "One", "confirm": True, "note": "real seat per buyer"})
check(st == 200, "then the seat can be issued", (st, r))

print("\n== booking #204 resolved end to end ==")
st, r = act(b204, {"action": "issue_seat", "first_name": "Guest of", "last_name": "buyer", "confirm": True,
                   "confirm_real_seat": True, "note": "buyer confirmed four people"})
check(st == 200, "#204: the 4th seat issued (duplicate question answered in the dialog)", (st, r))
st, r = act(b204, {"action": "rebuild_email", "note": "all four tickets to the buyer"})
check(st == 200 and "4 ticket" in (r.get("result") or {}).get("note", ""), "#204: email record rebuilt with all 4 tickets", r)
st, r = act(b204, {"action": "release", "ticket_ids": [x["ticket_id"] for x in issue("booking:204")["tickets"]],
                   "confirm": True, "note": "booking complete, may be emailed"})
check(st == 200, "#204: released to the email list", (st, r))
d = issue("booking:204")
check(d and not d["detected"] and d["status"] == "resolved", "#204: the checks no longer find a problem; resolved by itself", d and (d["detected"], d["status"]))
st, s = call("GET", "/events/%d/reconcile/summary" % EV)
check(not any("4, its email" in (p.get("detail") or "") for p in s["bulk_check"]["problems"]),
      "the bulk check no longer reports #204", s["bulk_check"]["problems"])
check(s["bulk_check"]["sending"] == "locked" and s["bulk_check"]["changed_since_list"] >= 1,
      "sending stays locked, and the list is marked for rebuild + new approval", s["bulk_check"])

print("\n== corrections are audited, and reverts reopen ==")
st, r = act(b57, {"action": "fix_identity", "ticket_id": new57, "first_name": "Zz Corrected", "note": "name from buyer"})
check(st == 200, "a name can be corrected without confirmation", (st, r))
st, r = act(b57, {"action": "fix_identity", "ticket_id": new57, "email": "zz-new-%s@example.invalid" % secrets.token_hex(3), "note": "holder's own email"})
check(st == 428, "changing the holder's email needs confirmation", st)
st, r = act(b57, {"action": "fix_identity", "ticket_id": 999999, "first_name": "X", "note": "wrong ticket"})
check(st == 400, "a ticket outside the issue cannot be touched", st)
h = issue("booking:57")["history"]
fx = [x for x in h if x["kind"] == "action" and x["text"].startswith("fix identity")]
check(fx and fx[-1]["before"]["first_name"] != fx[-1]["after"]["first_name"] and fx[-1]["actor"],
      "the history records who, the before and the after", fx[-1:] if fx else h[-2:])
st, _ = call("POST", "/events/%d/reconcile/issues/%d/comment" % (EV, b57["id"]), {"text": "Called the buyer at 10:00"})
check(st == 200, "an internal note is added", st)
st, _ = call("POST", "/events/%d/reconcile/issues/%d/assign" % (EV, b57["id"]), {"user_id": 3})
check(st == 200, "an issue is assigned to an administrator", st)
if door:
    st, _ = call("POST", "/events/%d/reconcile/issues/%d/assign" % (EV, b57["id"]), {"user_id": door[0]})
    check(st == 400, "but not to door staff", st)
b122 = found[122]
st, r = call("POST", "/events/%d/reconcile/issues/%d/status" % (EV, b122["id"]), {"status": "resolved", "note": "said fixed"})
check(st == 200 and r["status"] == "open", "'resolved' while the problem is still there reopens it", r)
st, r = call("POST", "/events/%d/reconcile/issues/%d/status" % (EV, b122["id"]), {"status": "reviewed", "note": "keep held: buyer to name the guest at the door"})
check(st == 200 and r["status"] == "reviewed", "kept as it is: reviewed with a note (stays held)", r)
held122 = db.execute("select state from email_holds where attendee_id=122").fetchone()
check(held122 and held122[0] == "held", "a previously held booking stays held until someone releases it", held122)

print("\n== category corrections ==")
ci = issue("booking:57")
t = [x for x in ci["tickets"] if x["ticket_id"] == 57][0]
st, _ = act(ci, {"action": "change_category", "ticket_id": 57, "ticket_type_id": t["ticket_type_id"], "note": "short"})
check(st == 428, "a category change needs confirmation", st)
st, _ = act(ci, {"action": "change_category", "ticket_id": 57, "ticket_type_id": t["ticket_type_id"], "confirm": True, "note": "short"})
check(st == 400, "and a note naming the payment that supports it", st)
st, _ = act(ci, {"action": "change_category", "ticket_id": 57, "ticket_type_id": 999999, "confirm": True, "note": "order 1234 shows this pass"})
check(st == 400, "only a pass of this event", st)

print("\n== integrity ==")
check(db.execute("select count(*), coalesce(sum(amount),0), group_concat(id||status||coalesce(attendee_id,'')) from payment_events").fetchone()[:2] == pay_before[:2],
      "payments: same rows, same money", None)
check(db.execute("select count(*) from attendees").fetchone()[0] == tickets_before + 3,
      "exactly the 3 seats issued above were added, nothing else", db.execute("select count(*) from attendees").fetchone()[0] - tickets_before)
dups = db.execute("select count(*) from (select public_token from attendees where event_id=1 and public_token is not null and "
                  "lower(coalesce(registration_status,'registered')) not in ('refunded','cancelled','canceled','revoked','void','withdrawn') "
                  "group by public_token having count(*)>1)").fetchone()[0]
check(dups == 0, "no duplicate badge identities", dups)
if dsha is not None:
    check(delivery_records() == dsha, "the delivery history is untouched: nothing was sent", None)

print("\n%d check(s) failed" % len(fails) if fails else "\nALL CHECKS PASSED")
sys.exit(1 if fails else 0)
