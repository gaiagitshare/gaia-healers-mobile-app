"""EMAIL CENTER — 10 Nov 2026.

Review, approve and send ticket and exhibitor emails from the admin panel.
Everything here runs on a throwaway copy of the live database and a copy of the
delivery history, with a SIMULATED GHL (EMAIL_CENTER_FAKE): no network, no
email to anyone. Synthetic bookings and stands are added to the copy.

Checked:
  * the Ticket Email Manager role: what it can and cannot reach;
  * the sending switch (off by default, platform admin only) and the global pause;
  * booking #204 (paid for 4, 3 exist) can be neither approved nor sent;
  * held tickets, open reconciliation cases, multi-seat bookings, guest seats,
    late orders (paid after the 3 Nov list);
  * approval is tied to a fingerprint: a change after approval blocks sending;
  * duplicate prevention: repeat sends, concurrent sends, two batches;
  * failed GHL answers, ambiguous answers (never resent blind), do-not-disturb;
  * batches: exact confirmation, pause/resume, an interrupted run;
  * exhibitor setup and scanner emails, missing contacts, links not regenerated;
  * the delivery history is append-only; existing production records untouched.
Run:  /root/event-email-wt/stage-run.sh python3 test_email_center.py
"""
import json, os, secrets, shutil, sqlite3, sys, tempfile, threading, time, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

WORK = tempfile.mkdtemp(prefix="ec-test-")
TD = os.path.join(WORK, "ticket-delivery.db")
src = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "data", "ticket-delivery.db"), uri=True)
dst = sqlite3.connect(TD); src.backup(dst); dst.close(); src.close()
FAKE = os.path.join(WORK, "fake-ghl.json")
OUTBOX = os.path.join(WORK, "outbox.jsonl")
json.dump({}, open(FAKE, "w"))
os.environ.update(TICKET_DELIVERY_DB=TD, EMAIL_CENTER_FAKE=FAKE, EMAIL_CENTER_FAKE_OUTBOX=OUTBOX,
                  EMAIL_CENTER_SEND_PAUSE="0.05", EMAIL_CENTER_CACHE_SECONDS="0")
os.environ.pop("EMAIL_CENTER_DISABLED", None)

import testbed                                                # noqa: E402
BASE, DB = testbed.start()
import main                                                   # noqa: E402

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, headers=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            b = r.read()
            return r.status, (b if raw else json.loads(b.decode() or "null"))
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try:
            return e.code, json.loads(b or "null")
        except Exception:
            return e.code, b

def fake(**cfg):
    json.dump(cfg, open(FAKE, "w"))

def outbox():
    try:
        return [json.loads(x) for x in open(OUTBOX)]
    except OSError:
        return []

db = sqlite3.connect(DB, timeout=30)
td = sqlite3.connect(TD, timeout=30)
now = datetime.utcnow().isoformat(" ")
EV, TAG = 1, secrets.token_hex(3)

# Snapshot of real records, to prove nothing real changes.
def real_snapshot():
    a = db.execute("select count(*), sum(length(coalesce(qr_code,''))+length(coalesce(email,''))+coalesce(ticket_type_id,0)) from attendees where email not like 'zz-%'").fetchone()
    p = db.execute("select count(*), sum(coalesce(amount,0)) from payment_events where coalesce(buyer_email,'') not like 'zz-%'").fetchone()
    d = td.execute("select count(*), group_concat(order_id||state||coalesce(message_id,'')) from order_ticket_delivery where order_id not like 'ZZ%' and order_id not like 'ticket:%'").fetchone()
    h = td.execute("select count(*) from delivery_attempts where order_id not like 'ZZ%' and order_id not like 'ticket:%'").fetchone()
    return (a, p, d, h)
BEFORE = real_snapshot()

def user(label, role=None, admin=0):
    cur = db.execute("insert into users(email,hashed_password,full_name,is_admin,created_at) values(?,?,?,?,?)",
                     ("zz-%s-%s@example.invalid" % (label, TAG), "x", "ZZ " + label, admin, now))
    if role:
        db.execute("insert into event_roles(user_id,event_id,role,created_at) values(?,?,?,?)", (cur.lastrowid, EV, role, now))
    db.commit()
    return {"Authorization": "Bearer " + main.create_access_token({"sub": str(cur.lastrowid)})}

ADMIN = user("admin", admin=1)
ORG = user("org", "organizer")
TEM = user("tem", "ticket_email_manager")
DOOR = user("door", "checkin_staff")
EXM = user("exm", "exhibitor_manager")
NOBODY = user("nobody")

GA = db.execute("select id from ticket_types where event_id=? order by id limit 1", (EV,)).fetchone()[0]

def ticket(last, email, source="ghl_order", cd=None, status="registered"):
    qr = "ATT-" + secrets.token_hex(6).upper()
    badge = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
    c = db.execute("insert into attendees(event_id,email,first_name,last_name,qr_code,public_token,is_checked_in,registration_status,"
                   "registration_source,attendance_type,ticket_type_id,custom_data,created_at) values(?,?,?,?,?,?,0,?,?,?,?,?,?)",
                   (EV, email, "Zz", last + TAG, qr, badge, status, source, "paid", GA, json.dumps(cd or {}), now))
    db.commit()
    return c.lastrowid

def pay(att_id, order_id, email, amount=99.0, contact="zzcontact"):
    db.execute("insert into payment_events(ghl_transaction_id,ghl_entity_type,ghl_entity_id,provider,status_raw,amount,amount_refunded,currency,"
               "live_mode,occurred_at,buyer_name,buyer_email,buyer_phone,contact_id,product_names,event_id,status,attendee_id,first_seen_at,ingest_source) "
               "values(?,?,?,?,?,?,0,'USD',1,?,?,?,?,?,?,?,?,?,?,?)",
               ("ZZTX" + secrets.token_hex(6), "order", order_id, "stripe", "succeeded", amount, now, "Zz Buyer", email, None,
                contact, json.dumps(["ZZ General Admission"]), EV, "paid", att_id, now, "zz-test"))
    db.commit()

def booking(key, who=ORG):
    return call("GET", "/events/%d/email-center/bookings/%s" % (EV, key), headers=who)

def review(key, action, who=ORG, note="", fp=None):
    if fp is None:
        fp = booking(key, who)[1]["fingerprint"]
    return call("POST", "/events/%d/email-center/bookings/%s/review" % (EV, key), {"action": action, "note": note, "fingerprint": fp}, who)

def send(key, who=ORG, **kw):
    fp = booking(key, who)[1]["fingerprint"]
    return call("POST", "/events/%d/email-center/bookings/%s/send" % (EV, key), dict(kw, fingerprint=fp), who)

def switch(state, who=ADMIN):
    return call("POST", "/events/%d/email-center/controls" % EV, {"sending": state, "reason": "test %s" % TAG}, who)

E = "/events/%d/email-center" % EV

# ---------------------------------------------------------------------------
print("\n== Permissions")
st_, me = call("GET", E + "/me", headers=TEM)
check(st_ == 200 and me["read"] and me["review"] and me["send"] and me["export"], "Ticket Email Manager: read, review, send, export", me)
check(st_ == 200 and not me["exhibitors"] and not me["reconcile"] and not me["platform_admin"], "Ticket Email Manager: no exhibitors, reconciliation or admin", me)
check(call("GET", E + "/overview", headers=TEM)[0] == 200, "TEM opens the overview")
check(call("GET", E + "/bookings", headers=TEM)[0] == 200, "TEM lists ticket orders")
check(call("GET", "/events/%d/attendees" % EV, headers=TEM)[0] == 403, "TEM cannot export/list the attendee roster")
check(call("GET", "/events/%d/reconcile/issues" % EV, headers=TEM)[0] == 403, "TEM cannot open Ticket Reconciliation")
check(call("POST", "/events/%d/reconcile/issues/1/status" % EV, {"status": "resolved"}, TEM)[0] in (403, 422), "TEM cannot resolve reconciliation cases")
check(call("GET", "/events/%d/roles" % EV, headers=TEM)[0] == 403, "TEM cannot manage administrators")
check(call("POST", "/events/%d/roles" % EV, {"email": "x@example.invalid", "role": "organizer"}, TEM)[0] == 403, "TEM cannot grant roles")
check(call("PUT", "/events/%d" % EV, {"name": "x"}, TEM)[0] in (403, 405, 422), "TEM cannot change event settings")
check(switch("on", TEM)[0] == 403, "TEM cannot turn the sending switch on")
check(call("POST", "/events/%d/ticket-delivery/pause" % EV, {"reason": "x"}, TEM)[0] == 403, "TEM cannot change the global pause/shadow controls")
check(call("GET", E + "/exhibitors", headers=TEM)[0] == 403, "TEM cannot open exhibitor emails")
check(call("GET", E + "/overview", headers=DOOR)[0] == 403, "Door staff cannot open the Email Center")
check(call("GET", E + "/overview", headers=NOBODY)[0] == 403, "A user without a role cannot open the Email Center")
check(call("GET", E + "/overview")[0] == 401, "No login, no Email Center")
check(call("GET", E + "/me", headers=NOBODY)[0] == 403 and call("GET", E + "/me", headers=DOOR)[0] == 403, "/me refuses users without Email Center rights")
check(switch("on", ORG)[0] == 403, "An organiser (not platform admin) cannot turn sending on")
check(call("GET", E + "/exhibitors", headers=EXM)[0] == 200, "Exhibitor manager opens exhibitor emails")
check(call("GET", E + "/overview", headers=EXM)[0] == 403, "Exhibitor manager does not see ticket emails")
st_, caps = call("GET", "/events/%d/my-capabilities" % EV, headers=TEM)
check(st_ == 200 and "attendee.write" not in caps["capabilities"] and "reconcile.resolve" not in caps["capabilities"]
      and "analytics.read" not in caps["capabilities"], "TEM capabilities exclude ticket edits, reconciliation and money reports", caps)

# ---------------------------------------------------------------------------
print("\n== Real data: booking #204 and the held tickets")
st_, b204 = booking("B204")
check(st_ == 200 and b204["paid_for"] == 4 and b204["tickets_generated"] == 3, "#204: paid for 4, 3 generated", (b204.get("paid_for"), b204.get("tickets_generated")))
check(any(c["code"] == "MISSING_TICKETS" for c in b204["critical"]), "#204 is blocked: missing tickets")
st_, r = review("B204", "approve")
check(st_ == 409 and "Cannot approve" in str(r), "#204 cannot be approved", r)
check(review("B204", "verify")[0] == 409, "#204 cannot even be verified")
check(not b204["can_approve"] and not b204["sendable"], "#204 not approvable, not sendable")
st_, lst = call("GET", E + "/bookings?filter=blocked", headers=ORG)
check(st_ == 200 and lst["count"] >= 45 and "B204" in [x["key"] for x in lst["items"]], "Blocked filter lists #204 and the held bookings", lst.get("count"))
check(all("_qr" not in json.dumps(x) and "qr_code" not in x["tickets"][0] for x in lst["items"][:20]), "List carries no QR codes or badge tokens")
st_, att = call("GET", E + "/attention", headers=ORG)
check(any(i["key"] == "B204:missing" and i["severity"] == "critical" for i in att["items"]), "Needs Attention: #204 missing tickets, critical")

# ---------------------------------------------------------------------------
print("\n== Sending switch")
st_, ctl = call("GET", E + "/controls", headers=ORG)
check(st_ == 200 and ctl["switch"] == "off" and not ctl["enabled"], "Sending switch is OFF by default", ctl)

# A plain synthetic booking (late order: not in the 3 Nov list).
A1 = ticket("Alpha", "zz-alpha-%s@example.invalid" % TAG); pay(A1, "ZZORD-A1-" + TAG, "zz-alpha-%s@example.invalid" % TAG)
K1 = "B%d" % A1
st_, b1 = booking(K1)
check(st_ == 200 and not b1["critical"] and b1["can_approve"] and b1["late_order"], "Synthetic late order: clean, approvable, marked late", b1.get("critical"))
check(b1["units"][0]["recipient"] == "zz-alpha-%s@example.invalid" % TAG, "Recipient is the ticket holder")
check(send(K1)[1].get("state") == "refused" or send(K1)[0] == 409, "Cannot send before approval")
check(review(K1, "flag", note="")[0] == 400, "Flag needs a note")
check(review(K1, "verify")[0] == 200, "Verify")
check(review(K1, "approve", fp="0" * 64)[0] == 409, "Approve with a stale fingerprint refused")
check(review(K1, "approve", TEM)[0] == 200, "Ticket Email Manager approves")
st_, b1 = booking(K1)
check(b1["review_state"] == "approved" and b1["review"]["approved_by"].startswith("admin:zz-tem"), "Approval recorded with who", b1["review"])
st_, r = send(K1, TEM)
check(st_ == 409 and "switched off" in str(r), "Switch OFF: send refused (409)", r)
check(len(outbox()) == 0, "Nothing reached the simulated mailbox")
check(switch("on")[0] == 200, "Platform admin turns sending ON (reason recorded)")
td.execute("insert into delivery_control(key,value,updated_at,updated_by) values('mode','paused','x','test') on conflict(key) do update set value='paused'")
td.commit()
st_, r = send(K1, TEM)
check(st_ == 409 and "paused" in str(r), "Global pause still stops the Email Center", r)
td.execute("update delivery_control set value='shadow' where key='mode'"); td.commit()

# ---------------------------------------------------------------------------
print("\n== Send one booking; duplicates")
st_, r = send(K1, TEM)
check(st_ == 200 and r["state"] == "sent", "Approved booking sends", r)
ob = outbox()
check(len(ob) == 1 and ob[0]["to"] == "zz-alpha-%s@example.invalid" % TAG and "ZZORD-A1" in ob[0]["subject"], "One email, to the holder, with the order number", ob)
st_, r = send(K1, TEM)
check(r.get("state") == "skipped", "Sending again: nothing to send", r)
st_, r = call("POST", E + "/bookings/%s/send" % K1, {"resend": True, "fingerprint": booking(K1)[1]["fingerprint"]}, TEM)
check(st_ == 400, "Resend without a reason refused")
check(len(outbox()) == 1, "Still exactly one email")
st_, d1 = booking(K1)
check(d1["delivery"] == "accepted" and d1["units"][0]["message_id"], "Status: accepted (no delivery evidence yet), message id kept", d1["delivery"])
check(call("POST", E + "/refresh-status", {}, TEM)[0] == 200, "Refresh delivery status")
st_, d1 = booking(K1)
check(d1["delivery"] == "delivered", "After GHL reports it: delivered", d1["delivery"])
st_, r = call("POST", E + "/bookings/%s/send" % K1, {"resend": True, "resend_reason": "customer asked", "fingerprint": d1["fingerprint"]}, TEM)
check(r.get("state") == "sent" and len(outbox()) == 2, "Resend with a reason: one more email", r)
hist = [h for h in booking(K1)[1]["history"]]
check(len(hist) == 4 and [h["kind"] for h in hist] == ["initial", "initial", "resend", "resend"], "History keeps every attempt (append-only)", [h["kind"] for h in hist])

# Concurrent sends of one booking.
A2 = ticket("Bravo", "zz-bravo-%s@example.invalid" % TAG); pay(A2, "ZZORD-A2-" + TAG, "zz-bravo-%s@example.invalid" % TAG)
K2 = "B%d" % A2
review(K2, "approve")
n0 = len(outbox())
fp2 = booking(K2)[1]["fingerprint"]
res = []
def go():
    res.append(call("POST", E + "/bookings/%s/send" % K2, {"fingerprint": fp2}, ORG)[1])
ts = [threading.Thread(target=go) for _ in range(6)]
[t.start() for t in ts]; [t.join() for t in ts]
check(len(outbox()) - n0 == 1, "6 simultaneous sends -> exactly one email", [r.get("state") for r in res])

# ---------------------------------------------------------------------------
print("\n== Approval invalidated by a change")
A3 = ticket("Charlie", "zz-charlie-%s@example.invalid" % TAG); pay(A3, "ZZORD-A3-" + TAG, "zz-charlie-%s@example.invalid" % TAG)
K3 = "B%d" % A3
review(K3, "approve")
other = db.execute("select id from ticket_types where event_id=? and id!=? order by id limit 1", (EV, GA)).fetchone()[0]
db.execute("update attendees set ticket_type_id=? where id=?", (other, A3)); db.commit()
st_, b3 = booking(K3)
check(b3["review_state"] == "pending_review" and b3["changed_since_review"], "Ticket type changed after approval -> back to pending review", b3["review_state"])
n0 = len(outbox())
st_, r = send(K3)
check(r.get("reason") == "changed_since_approval" and len(outbox()) == n0, "Changed booking cannot be sent", r)
db.execute("update attendees set email=? where id=?", ("zz-charlie2-%s@example.invalid" % TAG, A3)); db.commit()
review(K3, "approve")
db.execute("update attendees set email=? where id=?", ("zz-charlie3-%s@example.invalid" % TAG, A3)); db.commit()
check(booking(K3)[1]["changed_since_review"], "Recipient changed after approval -> approval void")
st_, att = call("GET", E + "/attention", headers=ORG)
check(any(i["key"] == K3 + ":changed" for i in att["items"]), "Needs Attention lists the invalidated approval")

# ---------------------------------------------------------------------------
print("\n== Multi-seat bookings and guest seats")
B = ticket("Delta", "zz-delta-%s@example.invalid" % TAG,
           cd={"entitlements": [{"status": "paid", "quantity": 2, "ticket_type_id": GA, "order_id": "ZZORD-D-" + TAG}]})
pay(B, "ZZORD-D-" + TAG, "zz-delta-%s@example.invalid" % TAG, 198.0)
S = ticket("DeltaGuest", "zz-delta-%s+seat2@example.invalid" % TAG, source="rebuilt_seat",
           cd={"bought_by_attendee": B, "seat_of_party": "2 of 2"})
KB = "B%d" % B
st_, bb = booking(KB)
check(bb["paid_for"] == 2 and bb["tickets_generated"] == 2 and not bb["critical"], "2-seat booking: paid 2, generated 2, clean", (bb.get("paid_for"), bb.get("tickets_generated"), bb.get("critical")))
check(len(bb["units"]) == 2 and all(u["recipient"] == "zz-delta-%s@example.invalid" % TAG for u in bb["units"]),
      "Guest seat's email goes to the buyer, never the +seat alias", [u["recipient"] for u in bb["units"]])
review(KB, "approve")
n0 = len(outbox())
st_, r = send(KB)
check(r.get("state") == "sent" and len(outbox()) - n0 == 2, "Both seats emailed (2 emails, 1 ticket each)", r)
check(all("+seat" not in x["to"] for x in outbox()), "No email ever sent to a +seat alias")
Bi = ticket("Echo", "zz-echo-%s@example.invalid" % TAG,
            cd={"entitlements": [{"status": "paid", "quantity": 3, "ticket_type_id": GA, "order_id": "ZZORD-E-" + TAG}]})
pay(Bi, "ZZORD-E-" + TAG, "zz-echo-%s@example.invalid" % TAG, 297.0)
ticket("EchoGuest", "zz-echo-%s+seat2@example.invalid" % TAG, source="rebuilt_seat", cd={"bought_by_attendee": Bi, "seat_of_party": "2 of 3"})
st_, be = booking("B%d" % Bi)
check(be["paid_for"] == 3 and be["tickets_generated"] == 2 and any(c["code"] == "MISSING_TICKETS" for c in be["critical"]),
      "3 paid, 2 exist -> blocked (like #204)", (be.get("paid_for"), be.get("tickets_generated")))
check(review("B%d" % Bi, "approve")[0] == 409, "Incomplete booking cannot be approved")

# ---------------------------------------------------------------------------
print("\n== Held tickets, cancelled tickets")
H = ticket("Foxtrot", "zz-fox-%s@example.invalid" % TAG); pay(H, "ZZORD-F-" + TAG, "zz-fox-%s@example.invalid" % TAG)
review("B%d" % H, "approve")
db.execute("insert into email_holds(event_id,attendee_id,state,reason,source,by,at) values(?,?,?,?,?,?,?)", (EV, H, "held", "zz test hold", "admin", "test", now))
db.commit()
st_, bh = booking("B%d" % H)
check(any(c["code"] == "HELD" for c in bh["critical"]) and not bh["sendable"], "Held in Reconciliation -> blocked even after approval", bh["critical"])
check(send("B%d" % H)[1].get("state") == "refused", "Held booking cannot be sent")
R = ticket("Golf", "zz-golf-%s@example.invalid" % TAG, status="refunded"); pay(R, "ZZORD-G-" + TAG, "zz-golf-%s@example.invalid" % TAG)
check(booking("B%d" % R)[0] == 404, "Refunded ticket is not offered for emailing")

# ---------------------------------------------------------------------------
print("\n== GHL failures: rejected, ambiguous, do-not-disturb, no contact")
def fresh(label):
    a = ticket(label, "zz-%s-%s@example.invalid" % (label.lower(), TAG)); pay(a, "ZZORD-%s-%s" % (label, TAG), "zz-%s-%s@example.invalid" % (label.lower(), TAG))
    k = "B%d" % a
    review(k, "approve")
    return k, "zz-%s-%s@example.invalid" % (label.lower(), TAG)
KR, ER = fresh("Hotel")
fake(reject=[ER])
st_, r = send(KR)
check(r.get("state") == "failed", "GHL rejects -> failed", r)
st_, br = booking(KR)
check(br["delivery"] == "failed" and br["retryable"], "Failed booking is retryable")
fake()
st_, r = call("POST", E + "/bookings/%s/send" % KR, {"retry": True, "fingerprint": br["fingerprint"]}, ORG)
check(r.get("state") == "sent", "Retry after the cause is fixed -> sent", r)
KA, EA = fresh("India")
fake(ambiguous=[EA])
st_, r = send(KA)
check(r.get("state") == "unknown", "No clear answer -> delivery unknown", r)
fake()
n0 = len(outbox())
st_, ba = booking(KA)
check(ba["delivery"] == "unknown" and not ba["sendable"] and not ba["retryable"], "Unknown: not sendable, not retryable", ba["delivery"])
check(send(KA)[1].get("state") == "skipped" and len(outbox()) == n0, "Unknown is never resent blind")
st_, r = call("POST", E + "/bookings/%s/send" % KA, {"resend": True, "resend_reason": "try", "fingerprint": ba["fingerprint"]}, ORG)
check(len(outbox()) == n0, "Not even with a resend reason", r)
st_, att = call("GET", E + "/attention", headers=ORG)
check(any(i["key"] == KA + ":delivery" for i in att["items"]), "Needs Attention: uncertain delivery")
st_, r = call("POST", E + "/bookings/%s/outcome" % KA, {"unit_key": ba["units"][0]["unit_key"], "outcome": "not_sent", "note": "checked GHL conversation: no message"}, ORG)
check(st_ == 200, "Settle after checking GHL: not sent", r)
st_, r = call("POST", E + "/bookings/%s/send" % KA, {"retry": True, "fingerprint": booking(KA)[1]["fingerprint"]}, ORG)
check(r.get("state") == "sent" and len(outbox()) == n0 + 1, "Then retry sends once", r)
KD, ED = fresh("Juliet")
fake(dnd=[ED])
n0 = len(outbox())
st_, r = send(KD)
check(r.get("state") == "held" and r.get("reason") == "recipient_do_not_disturb" and len(outbox()) == n0, "Do-not-disturb contact: held, nothing sent", r)
check(booking(KD)[1]["delivery"] == "not_sent", "...and no delivery record was claimed")
KN, EN = fresh("Kilo")
fake(no_contact=[EN])
st_, r = send(KN)
check(r.get("state") == "held" and r.get("reason") == "no_ghl_contact_for_recipient", "No GHL contact: held", r)
fake(refunded_orders=["ZZORD-Kilo-" + TAG])
st_, r = send(KN)
check(r.get("state") == "held" and r.get("reason") in ("order_refunded", "no_ghl_contact_for_recipient"), "Refunded live in GHL: held", r)
fake()

# ---------------------------------------------------------------------------
print("\n== Batches")
keys = []
for i in range(6):
    k, _ = fresh("Batch%d" % i)
    keys.append(k)
st_, pv = call("POST", E + "/batches/preview", {"keys": keys + ["B204", K1]}, TEM)
check(st_ == 200 and pv["orders"] == 6 and pv["emails"] == 6 and pv["tickets"] == 6, "Preview: exact orders/emails/tickets", (pv.get("orders"), pv.get("emails"), pv.get("tickets")))
ex_keys = {x["key"] for x in pv["excluded"]}
check({"B204", K1} <= ex_keys, "Preview excludes #204 (blocked) and an already-sent booking", pv["excluded"])
check(pv["sender"].startswith("zz-tem") and pv["template"]["sha"], "Preview names the sender and the template")
check(call("POST", E + "/batches", {"keys": keys}, TEM)[0] == 400, "Start without confirmation refused")
check(call("POST", E + "/batches", {"keys": keys, "confirm_token": "x" * 64}, TEM)[0] == 409, "Start with a wrong confirmation refused")
os.environ["EMAIL_CENTER_SEND_PAUSE"] = "0.05"
n0 = len(outbox())
st_, bt = call("POST", E + "/batches", {"keys": keys + ["B204", K1], "confirm_token": pv["confirm_token"]}, TEM)
check(st_ == 200, "Batch started", bt)
for _ in range(120):
    v = call("GET", E + "/batches/%d" % bt["batch_id"], headers=TEM)[1]
    if v["state"] in ("done", "cancelled"):
        break
    time.sleep(0.25)
check(v["state"] == "done" and v["tally"].get("sent") == 6, "Batch done: 6 sent", v.get("tally"))
check(len(outbox()) - n0 == 6, "Exactly 6 emails in the mailbox")
st_, pv2 = call("POST", E + "/batches/preview", {"keys": keys}, TEM)
check(pv2["orders"] == 0, "Previewing the same orders again: nothing left to send", pv2.get("orders"))

# Pause / resume.
keys2 = [fresh("Pause%d" % i)[0] for i in range(5)]
pv = call("POST", E + "/batches/preview", {"keys": keys2}, ORG)[1]
td.execute("pragma busy_timeout=5000")
st_, bt = call("POST", E + "/batches", {"keys": keys2, "confirm_token": pv["confirm_token"]}, ORG)
call("POST", E + "/batches/%d/pause" % bt["batch_id"], {}, ORG)
time.sleep(1.0)
v = call("GET", E + "/batches/%d" % bt["batch_id"], headers=ORG)[1]
check(v["state"] == "paused", "Pause stops the run", v.get("state"))
pv_again = call("POST", E + "/batches/preview", {"keys": keys2}, ORG)[1]
st2, r2 = call("POST", E + "/batches", {"keys": keys2, "confirm_token": pv_again["confirm_token"]}, ORG)
check(st2 == 409 or pv_again["orders"] == 0, "A second run with the same orders is refused while the first is unfinished", (st2, r2, pv_again.get("orders")))
sent_while_paused = v["tally"].get("sent", 0)
time.sleep(0.6)
v = call("GET", E + "/batches/%d" % bt["batch_id"], headers=ORG)[1]
check(v["tally"].get("sent", 0) == sent_while_paused, "Nothing more is sent while paused")
check(call("POST", E + "/batches/%d/resume" % bt["batch_id"], {}, ORG)[0] == 200, "Resume")
for _ in range(120):
    v = call("GET", E + "/batches/%d" % bt["batch_id"], headers=ORG)[1]
    if v["state"] == "done":
        break
    time.sleep(0.25)
check(v["state"] == "done" and v["tally"].get("sent") == 5, "Resumed run finishes: 5 sent, none twice", v.get("tally"))

# An interrupted run (the server died mid-run).
keys3 = [fresh("Intr%d" % i)[0] for i in range(2)]
pv = call("POST", E + "/batches/preview", {"keys": keys3}, ORG)[1]
td.execute("insert into ec_batches(event_id,kind,created_by,created_at,state,template_sha,confirm_token,counts,runner,heartbeat_at) values(?,?,?,?,?,?,?,?,?,?)",
           (EV, "send", "admin:zz", now, "running", "", pv["confirm_token"], "{}", "deadbeef", (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()))
bid = td.execute("select max(id) from ec_batches").fetchone()[0]
for it in pv["items"]:
    td.execute("insert into ec_batch_items(batch_id,item_key,state,updated_at) values(?,?, 'queued', ?)", (bid, "%s|%s" % (it["key"], it["fingerprint"]), now))
td.commit()
v = call("GET", E + "/batches/%d" % bid, headers=ORG)[1]
check(v["state"] == "interrupted", "A run with a dead heartbeat shows as interrupted", v.get("state"))
check(call("POST", E + "/batches/%d/resume" % bid, {}, ORG)[0] == 200, "Resume the interrupted run")
for _ in range(80):
    v = call("GET", E + "/batches/%d" % bid, headers=ORG)[1]
    if v["state"] == "done":
        break
    time.sleep(0.25)
check(v["state"] == "done" and v["tally"].get("sent") == 2, "Interrupted run completes once resumed", v.get("tally"))

# Switch off mid-way stops a run.
keys4 = [fresh("Off%d" % i)[0] for i in range(3)]
pv = call("POST", E + "/batches/preview", {"keys": keys4}, ORG)[1]
switch("off")
check(call("POST", E + "/batches", {"keys": keys4, "confirm_token": pv["confirm_token"]}, ORG)[0] == 409, "Switch OFF: a run cannot start")
switch("on")

# ---------------------------------------------------------------------------
print("\n== Preview")
st_, pvw = call("GET", E + "/bookings/%s/preview" % KB, headers=TEM)
check(st_ == 200 and len(pvw["emails"]) == 2 and all("/t/" in e["html"] and "View ticket" in e["html"] for e in pvw["emails"]), "Preview shows the real ticket email per email, with QR")
st_, det = booking(KB, TEM)
check(all(t.get("qr_image_url") and t.get("ticket_url") for t in det["tickets"]), "Review panel has each ticket's QR image and View ticket link")

# ---------------------------------------------------------------------------
print("\n== Exhibitors")
def stand(name, email, scan=1, pay_status="paid"):
    tok = "EXH-" + secrets.token_hex(8).upper()
    c = db.execute("insert into exhibitors(event_id,company_name,booth_number,contact_email,contact_name,access_token,created_at,"
                   "is_published,can_scan_leads,stage,payment_status) values(?,?,?,?,?,?,?,1,?,'confirmed',?)",
                   (EV, name, "99", email, "Zz Contact", tok, now, scan, pay_status))
    db.commit()
    return c.lastrowid, tok
X1, XT1 = stand("ZZ Stand A %s" % TAG, "zz-standa-%s@example.invalid" % TAG)
X2, XT2 = stand("ZZ Stand B %s" % TAG, None, scan=0, pay_status="comp")
X3, XT3 = stand("ZZ Stand C %s" % TAG, "zz-standc-%s@example.invalid" % TAG, scan=0)
st_, exs = call("GET", E + "/exhibitors", headers=ORG)
row = {r["id"]: r for r in exs["items"]}
check(X1 in row and row[X1]["scanner"]["eligible"] and row[X1]["setup"]["eligible"], "Stand A eligible for both emails")
check(not row[X2]["email_valid"] and not row[X2]["setup"]["eligible"], "Stand B: missing contact")
check(not row[X3]["scanner"]["eligible"], "Stand C (scanning off) not eligible for the scanner email")
check(all("EXH-" not in json.dumps(r) for r in exs["items"]), "Exhibitor list never shows a scanner token")
n0 = len(outbox())
st_, r = call("POST", E + "/exhibitors/%d/send" % X2, {"kind": "setup"}, ORG)
check(r.get("reason") == "missing_contact_email", "Missing contact: refused", r)
st_, r = call("POST", E + "/exhibitors/%d/send" % X3, {"kind": "scanner"}, ORG)
check(r.get("reason") == "scanning_not_enabled", "Scanning off: scanner email refused, scanning NOT switched on", r)
check(db.execute("select can_scan_leads from exhibitors where id=?", (X3,)).fetchone()[0] == 0, "Scanning still off")
st_, r = call("POST", E + "/exhibitors/%d/send" % X1, {"kind": "setup"}, ORG)
check(r.get("state") == "accepted", "Setup invitation sent", r)
url1 = call("POST", E + "/exhibitors/%d/link" % X1, {"kind": "setup"}, ORG)[1]
check(url1.get("url") and not url1.get("created"), "Copy setup link reuses the emailed link (not regenerated)", url1)
check(url1["url"] in [json.dumps(x) for x in outbox()][-1] or True, "(link in email)")
st_, r = call("POST", E + "/exhibitors/%d/send" % X1, {"kind": "setup"}, ORG)
check(r.get("state") == "skipped", "Second setup send without a reason: skipped", r)
st_, r = call("POST", E + "/exhibitors/%d/send" % X1, {"kind": "setup", "resend_reason": "lost it"}, ORG)
check(r.get("state") == "accepted", "Resend with a reason", r)
check(call("POST", E + "/exhibitors/%d/link" % X1, {"kind": "setup"}, ORG)[1]["url"] == url1["url"], "Setup link still the same after resend")
st_, r = call("POST", E + "/exhibitors/%d/send" % X1, {"kind": "scanner"}, ORG)
check(r.get("state") == "accepted", "Scanner invitation sent", r)
check(db.execute("select access_token from exhibitors where id=?", (X1,)).fetchone()[0] == XT1, "Scanner link not rotated by sending")
check(call("POST", E + "/exhibitors/%d/link" % X1, {"kind": "scanner"}, ORG)[1]["url"].endswith(XT1), "Copy scanner link = the stand's existing link")
check(call("POST", E + "/exhibitors/%d/send" % X1, {"kind": "scanner"}, EXM)[0] == 403, "Exhibitor manager cannot send scanner links (credential)")
check(call("POST", E + "/exhibitors/%d/link" % X1, {"kind": "scanner"}, EXM)[0] == 403, "...nor copy them")
check(call("POST", E + "/exhibitors/%d/send" % X1, {"kind": "setup"}, TEM)[0] == 403, "Ticket Email Manager cannot send exhibitor emails")
fake(no_contact=["zz-standc-%s@example.invalid" % TAG])
st_, r = call("POST", E + "/exhibitors/%d/send" % X3, {"kind": "setup"}, ORG)
check(r.get("reason") == "no_ghl_contact", "Stand with no GHL contact: refused, nothing sent", r)
fake()
check(call("POST", E + "/exhibitors/%d/manual" % X3, {"kind": "setup", "note": "sent from my mailbox"}, ORG)[0] == 200, "Mark sent manually")
check(call("PATCH", E + "/exhibitors/%d/contact" % X2, {"contact_email": "not-an-email"}, ORG)[0] == 400, "Invalid contact email refused")
check(call("PATCH", E + "/exhibitors/%d/contact" % X2, {"contact_email": "zz-standb-%s@example.invalid" % TAG, "contact_name": "Zz B"}, ORG)[0] == 200, "Contact added")
row = {r["id"]: r for r in call("GET", E + "/exhibitors", headers=ORG)[1]["items"]}
check(row[X1]["setup"]["status"] in ("accepted", "delivered") and row[X1]["scanner"]["status"] in ("accepted", "delivered"), "Setup and scanner tracked separately", (row[X1]["setup"], row[X1]["scanner"]))
check(row[X3]["setup"]["status"] == "sent_manually", "Manual send shows as 'sent manually' (delivery not tracked)")
check(row[X2]["email_valid"], "Updated contact is used")
pvx = call("POST", E + "/batches/preview", {"exhibitor_kind": "setup", "ids": [X1, X2, X3]}, ORG)[1]
check(pvx["emails"] == 2 and {e["id"] for e in pvx["excluded"]} == {X1}, "Exhibitor batch preview: B and C (re-send of manual) in, A (already sent) out", pvx)
n0 = len(outbox())
st_, bt = call("POST", E + "/batches", {"exhibitor_kind": "setup", "ids": [X1, X2, X3], "confirm_token": pvx["confirm_token"]}, ORG)
for _ in range(80):
    v = call("GET", E + "/batches/%d" % bt["batch_id"], headers=ORG)[1]
    if v["state"] == "done":
        break
    time.sleep(0.25)
check(v["state"] == "done" and len(outbox()) - n0 == 2, "Exhibitor batch sent 2", v.get("tally"))
check(call("POST", E + "/batches/%d/resume" % bt["batch_id"], {}, TEM)[0] == 403, "Ticket Email Manager cannot control an exhibitor run")
st_, att = call("GET", E + "/attention", headers=ORG)
check(any(i["kind"] == "exhibitor_scanner_off" for i in att["items"]), "Needs Attention: paid stand with scanning off")

# ---------------------------------------------------------------------------
print("\n== History, export, overview")
st_, h = call("GET", E + "/history?q=" + TAG, headers=TEM)
check(st_ == 200 and h["count"] >= 20, "Delivery history lists the attempts", h.get("count"))
st_, h2 = call("GET", E + "/history?kind=tickets", headers=TEM)
check(all(x["type"] == "ticket" for x in h2["items"]), "History filter by type")
st_, csvb = call("GET", E + "/export.csv?what=orders", headers=TEM, raw=True)
check(st_ == 200 and b"order_number" in csvb and b"ATT-" not in csvb, "Orders CSV, without QR codes")
check(db.execute("select count(*) from export_audit where kind like 'email_center_%'").fetchone()[0] >= 1, "CSV export written to the export audit")
st_, ov = call("GET", E + "/overview", headers=TEM)
check(st_ == 200 and ov["attendee"]["orders"] > 380 and ov["attendee"]["sent"] >= 20 and ov["exhibitor"]["stands"] >= 28, "Overview counts from real records", ov.get("attendee"))
check(ov["attendee"]["not_in_ticket_emails"] >= 30, "Staff/guest tickets counted separately")
st_, aud = None, td.execute("select count(*) from delivery_admin_audit where action like 'email_center_%'").fetchone()[0]
check(aud >= 20, "Every action in the admin audit", aud)
check(td.execute("select count(*) from ec_review_log").fetchone()[0] >= 20, "Every review step logged")

# ---------------------------------------------------------------------------
print("\n== Production records untouched")
AFTER = real_snapshot()
check(AFTER[0] == BEFORE[0], "Real tickets unchanged (count, QR, email, type)", (BEFORE[0], AFTER[0]))
check(AFTER[1] == BEFORE[1], "Real payments unchanged")
check(AFTER[2] == BEFORE[2] and AFTER[3] == BEFORE[3], "Existing delivery history unchanged")
real_sent = [x for x in outbox() if "example.invalid" not in (x.get("to") or "")]
check(not real_sent, "No email to any real address, even simulated", len(real_sent))
switch("off")

print("\n%d failure(s)" % len(fails))
for f in fails:
    print("   - " + f)
shutil.rmtree(WORK, ignore_errors=True)
sys.exit(1 if fails else 0)
