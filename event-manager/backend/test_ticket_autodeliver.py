# -*- coding: utf-8 -*-
"""Automatic ticket email, end to end, on a throwaway copy (3 Nov 2026).

Simulated purchases go into a testbed copy of the Event Manager through the
same two calls the proxy makes for a real GHL payment (reconcile-attendee, then
payments/sync). GHL and the mail route are fakes in this process; the QR image
and ticket page are read from the testbed. Nothing real is called, nobody is
emailed, and the delivery history is a temporary file.

Proves: one purchase -> exactly one valid ticket; shadow mode sends nothing;
live mode sends once to the buyer with the right pass and QR; repeated runs
never send twice; refunds, revocations, do-not-disturb, changed emails,
several seats, upgrades and unmapped products are held; an already-delivered
order (Bita's) is never sent again; the bulk sender and the automatic sender
racing on one order send it once; pause stops everything, the bulk sender
included; a resend needs a reason and is recorded; the dashboard API shows it.
"""
import json, multiprocessing, os, sqlite3, sys, tempfile, time, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="autodeliver-")
os.environ["TICKET_DELIVERY_DB"] = os.path.join(TMP, "ticket-delivery.db")
sys.path.insert(0, HERE)
env = {}
for line in open(os.path.join(HERE, ".env")):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1); env[k] = v.strip().strip('"').strip("'")
from jose import jwt  # noqa: E402
import testbed  # noqa: E402
BASE, DB = testbed.start()
ADMIN = jwt.encode({"sub": "1", "exp": datetime.utcnow() + timedelta(hours=2)}, env["SECRET_KEY"], algorithm="HS256")
SVC = env["IDENTITY_SERVICE_TOKEN"]
from ticket_delivery import engine, state as st  # noqa: E402

QRDEPS = os.environ.get("GAIA_QRDEPS", "/opt/gaia-qrdeps")
if not os.path.isdir(QRDEPS):
    QRDEPS = "/root/Documents/Codex/2026-11-03/files-pasted-by-the-user-gaia/work/tickets/qrdeps"
sys.path.insert(0, QRDEPS)

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else "   " + str(extra)[:500]))
    if not cond:
        fails += 1

def http(method, path, body=None, token=ADMIN):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

GA_PRODUCT, GA_TYPE = "69ffab66233a0d773296e989", 8          # Elevate Conference 2026 (Exhibit Hall Only)
UPGRADE_PRODUCT = "6a8f241addec25df2d4e292e"                 # GA-CONF to VIP upgrade
NOW = datetime.now(timezone.utc)
STAMP = NOW.strftime("%H%M%S")


class FakeWorld:
    """GHL, the mail route and the alert contact. Ticket QR and page come from the testbed."""
    def __init__(self):
        self.orders, self.tx, self.contacts, self.sent, self.status = {}, {}, {}, [], {}
        self.location = "LOC-TEST"
    def ghl(self, path):
        if path.startswith("/payments/orders/"):
            return {"order": self.orders[path.split("/")[3].split("?")[0]]}
        if path.startswith("/payments/transactions"):
            oid = path.split("entityId=")[1].split("&")[0]
            return {"data": self.tx.get(oid, [])}
        if path.startswith("/contacts/?"):
            q = path.split("query=")[1].split("&")[0].replace("%40", "@")
            return {"contacts": [c for c in self.contacts.values() if c["email"] == q]}
        if path.startswith("/contacts/"):
            return {"contact": self.contacts[path.split("/")[2]]}
        if path.startswith("/conversations/messages/email/"):
            return {"emailMessage": {"status": self.status.get(path.rsplit("/", 1)[1], "sent")}}
        raise KeyError(path)
    def send(self, contact_id, payload):
        self.sent.append((contact_id, payload))
        return {"ok": True, "messageId": "msg-%d" % len(self.sent)}
    def alert_contact(self):
        return "ALERT-CONTACT"
    def fetch(self, url):
        # The proxy serves /t/<token>.png and /ticket/<token> from these two
        # Event Manager calls; the testbed has no proxy in front of it.
        path = url.replace(engine.PUBLIC, "")
        if path.startswith("/t/"):
            path = "/identity/badge-qr/" + path[3:-4]
        elif path.startswith("/ticket/"):
            path = "/identity/ticket/by-token/" + path[8:]
        req = urllib.request.Request(BASE + path, headers={"Authorization": "Bearer " + SVC})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, b""
    def decode_qr(self, png):
        return engine.Live.decode_qr(self, png)
    def pass_texts(self, ids):
        req = urllib.request.Request(BASE + "/internal/ticket-delivery/tickets?ids=" + ",".join(map(str, ids)), headers={"Authorization": "Bearer " + SVC})
        with urllib.request.urlopen(req, timeout=20) as r:
            return {int(k): v for k, v in json.load(r).items()}
    def customer_sends(self):
        return [s for s in self.sent if s[0] != "ALERT-CONTACT"]


W = FakeWorld()

def purchase(key, product=GA_PRODUCT, ttype=GA_TYPE, qty=1, refunded=False, dnd=False, email_now=None, name="ZZ Autotest", minutes_ago=10, upgrade=False):
    """A paid GHL order, delivered to the testbed the way the proxy does it."""
    oid, cid, txid = "zz-auto-%s-%s" % (key, STAMP), "c-zz-%s-%s" % (key, STAMP), "tx-zz-%s-%s" % (key, STAMP)
    email = "zz.auto.%s.%s@example.invalid" % (key, STAMP)
    when = (NOW - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    item = {"_id": "it-" + oid, "name": "Elevate Conference 2026 (Exhibit Hall Only)" if product == GA_PRODUCT else "Upgrade", "qty": qty,
            "product": {"_id": product, "name": "x"}, "price": {"_id": "p", "amount": 99}}
    tx = {"_id": txid, "status": "succeeded", "amount": 99 * qty, "amountRefunded": 99 if refunded else 0, "currency": "USD", "liveMode": True,
          "entityType": "order", "entityId": oid, "contactId": cid, "contactEmail": email, "contactName": name, "createdAt": when, "updatedAt": when}
    if not upgrade:
        st_, out = http("POST", "/identity/reconcile-attendee", {"event_id": 1, "email": email, "ticket_type_id": ttype, "first_name": name, "last_name": key,
                        "contact_id": cid, "order_id": oid, "is_upgrade": False, "product_id": product, "quantity": qty, "amount": 99 * qty,
                        "purchased_at": when[:19]}, token=SVC)
        assert st_ == 200, (st_, out)
    st_, out = http("POST", "/identity/payments/sync", {"source": "webhook", "transactions": [{"transaction": dict(tx, amountRefunded=0),
                    "order": {"status": "completed", "items": [{"productId": product, "name": item["name"]}], "amount": 99 * qty}}]}, token=SVC)
    assert st_ == 200, (st_, out)
    W.orders[oid] = {"_id": oid, "status": "completed", "paymentStatus": "refunded" if refunded else "paid", "liveMode": True, "amount": 99 * qty,
                     "createdAt": when, "contactId": cid, "contactSnapshot": {"email": email}, "items": [item]}
    W.tx[oid] = [tx]
    W.contacts[cid] = {"id": cid, "email": email_now or email, "firstName": name, "lastName": key, "dnd": dnd}
    return oid, email

def em():
    return engine.em_connect(DB)

def tickets_of(oid):
    c = sqlite3.connect(DB)
    return c.execute("select id,ticket_type_id,registration_status,qr_code,public_token from attendees where acq_order_id=? or json_extract(custom_data,'$.order_id')=?",
                     (oid, oid)).fetchall()

S = st.DeliveryState()
# Only purchases made by this test are in scope: real orders in the copy are never classified.
CUTOFF = (NOW - timedelta(seconds=5)).strftime("%Y-%m-%d %H:%M:%S")
S.put("auto_cutoff", CUTOFF, "test")
quiet = lambda *_: None

print("\n== A purchase becomes exactly one valid ticket ==")
good, good_email = purchase("good")
again = http("POST", "/identity/reconcile-attendee", {"event_id": 1, "email": good_email, "ticket_type_id": GA_TYPE, "first_name": "ZZ Autotest", "last_name": "good",
             "contact_id": W.orders[good]["contactId"], "order_id": good, "is_upgrade": False, "product_id": GA_PRODUCT, "quantity": 1, "amount": 99,
             "purchased_at": W.orders[good]["createdAt"][:19]}, token=SVC)
t = tickets_of(good)
check(len(t) == 1 and t[0][1] == GA_TYPE and t[0][3] and t[0][4], "one ticket, General Admission, with its own QR and link, even after the webhook repeats", t)

print("\n== Shadow mode: classified, nothing sent ==")
check(S.mode() == "shadow", "a fresh install starts in shadow mode")
fresh, _ = purchase("fresh", minutes_ago=1)
refund, _ = purchase("refund", refunded=True)
dndo, _ = purchase("dnd", dnd=True)
moved, _ = purchase("moved", email_now="zz.someone.else.%s@example.invalid" % STAMP)
seats, _ = purchase("seats", qty=2)
upg, _ = purchase("upgrade", product=UPGRADE_PRODUCT, upgrade=True)
revoked, _ = purchase("revoked")
c = sqlite3.connect(DB); c.execute("update attendees set registration_status='revoked' where id=?", (tickets_of(revoked)[0][0],)); c.commit()
r1 = engine.run_cycle(W, S, em(), log=quiet)
cls = dict(S.db.execute("select order_id,classification from delivery_candidates").fetchall())
why = dict(S.db.execute("select order_id,reasons from delivery_candidates").fetchall())
check(not W.customer_sends(), "no customer email in shadow mode", W.customer_sends())
# fresh would settle while this test runs; revoke it so it can never be sent later.
c.execute("update attendees set registration_status='revoked' where id=?", (tickets_of(fresh)[0][0],)); c.commit()
check(cls.get(good) == "GREEN" and S.db.execute("select shadow_would_send_at from delivery_candidates where order_id=?", (good,)).fetchone()[0],
      "the clean purchase is GREEN and recorded as 'would send'", (cls.get(good), why.get(good)))
check(fresh not in cls, "a purchase under 3 minutes old is left to settle")
check(cls.get(refund) == "RED" and "ghl_order_not_paid_live" in why[refund] and "ghl_transactions_not_clean" in why[refund], "refunded -> RED", why.get(refund))
check(cls.get(dndo) == "RED" and "email_do_not_disturb" in why[dndo], "do-not-disturb -> RED", why.get(dndo))
check(cls.get(moved) == "YELLOW" and "buyer_email_changed_since_purchase" in why[moved], "email changed since purchase -> YELLOW", why.get(moved))
check(cls.get(seats) == "YELLOW" and "several_seats_in_one_order" in why[seats], "two seats in one order -> YELLOW", why.get(seats))
check(cls.get(upg) in ("YELLOW", "RED") and "upgrade_order" in why[upg], "upgrade order -> held", why.get(upg))
check(cls.get(revoked) == "RED" and "ticket_not_active" in why[revoked], "revoked ticket -> RED", why.get(revoked))
check(r1["alerts"] >= 6 and W.sent and W.sent[-1][0] == "ALERT-CONTACT" and "[Gaia Tickets]" in W.sent[-1][1]["subject"],
      "one internal alert lists the held orders (to the alert contact only)", r1)
n_alerts = len(W.sent)
engine.run_cycle(W, S, em(), log=quiet)
check(len(W.sent) == n_alerts, "the same held orders are not alerted twice")

print("\n== Bita's order (already delivered) is never sent again ==")
BITA = "69fb51c9f7e6ada8854b325e"
S.db.execute("insert into order_ticket_delivery(event_id,order_id,manifest_sha,recipient,state,attempt_count,message_id,result,updated_at,ticket_ids) values(1,?,?,?,?,1,'vN8f0uOnOtRdZKkxGGvG','',?,'18')",
             (BITA, "bd1b2c1c", "bitajalali89@gmail.com", "accepted", st.now()))
S.put("auto_cutoff", "2026-01-01", "test")       # even with every 2026 order in scope
W.orders[BITA] = {"_id": BITA, "status": "completed", "paymentStatus": "paid", "liveMode": True, "createdAt": "2026-05-06T14:35:53Z", "contactId": "x", "items": []}
in_scope = [o["order_id"] for o in engine.new_paid_orders(em(), "2026-01-01", NOW)]
S.put("auto_cutoff", CUTOFF, "test")
check(BITA in in_scope, "(her order is a paid 2026 order in the copy)")
check(S.delivered(1, BITA)[0] == "accepted", "her order has a delivery record, so every sender's claim refuses it")
probe = {"order_id": BITA, "recipient": "bitajalali89@gmail.com", "event": {"id": 1}, "tickets": [{"ticket_id": 18}]}
check(st.deliver(probe, S, engine.template_sha(), lambda o: (True, ""), lambda o, p: W.send("BITA", p), lambda o: {})["state"] == "skipped_existing_delivery"
      and not [x for x in W.sent if x[0] == "BITA"], "the automatic sender's claim skips her order without sending")

print("\n== Live mode: sends once, to the buyer, with the right ticket ==")
S.put("mode", "live", "test"); S.put("approved_template_sha", engine.template_sha(), "test")
r2 = engine.run_cycle(W, S, em(), log=quiet)
sends = W.customer_sends()
check(len(sends) == 1 and sends[0][0] == W.orders[good]["contactId"], "exactly one email, to the buyer's own contact", (r2, S.db.execute("select classification,reasons from delivery_candidates where order_id=?", (good,)).fetchone()))
html_ = sends[0][1]["html"] if sends else ""
tk = tickets_of(good)[0]
check(tk[3] in html_ and "/ticket/" + tk[4] in html_ and "/t/" + tk[4] + ".png" in html_, "the email carries this ticket's QR code and link")
check("General Admission" in html_ and "[TEST]" not in sends[0][1]["subject"], "the right pass is named; a real subject", sends[0][1]["subject"] if sends else "")
check(sends and "ELEVATE 2026" in sends[0][1]["subject"], "the official subject")
st_, png = W.fetch(engine.PUBLIC + "/t/" + tk[4] + ".png")
check(tk[3] in W.decode_qr(png), "the QR in the email opens/decodes to this ticket")
for _ in range(3):
    engine.run_cycle(W, S, em(), log=quiet)
check(len(W.customer_sends()) == 1, "three more runs: still one email")
hist = S.db.execute("select kind,state,actor from delivery_attempts where order_id=? order by id", (good,)).fetchall()
check(hist == [("initial", "sending", "auto"), ("initial", "accepted", "auto")], "history: one initial attempt by the automatic sender", hist)
check(not [s for s in W.customer_sends() if s[1]["subject"].endswith(BITA)], "Bita's order was not sent")

print("\n== GHL acceptance and delivery are recorded separately ==")
row = S.db.execute("select state,provider_status from order_ticket_delivery where order_id=?", (good,)).fetchone()
check(row[0] == "accepted", "accepted by GHL", row)
W.status["msg-%d" % next(i + 1 for i, s in enumerate(W.sent) if s[0] == W.orders[good]["contactId"])] = "delivered"
S.db.execute("update order_ticket_delivery set provider_checked_at=null where order_id=?", (good,))
engine.run_cycle(W, S, em(), log=quiet)
check(S.db.execute("select provider_status from order_ticket_delivery where order_id=?", (good,)).fetchone()[0] == "delivered", "then delivered, as the provider reports")
bounce, _ = purchase("bounce")
engine.run_cycle(W, S, em(), log=quiet)
mid = S.db.execute("select message_id from order_ticket_delivery where order_id=?", (bounce,)).fetchone()[0]
W.status[mid] = "bounced"
S.db.execute("update order_ticket_delivery set provider_checked_at=null where order_id=?", (bounce,))
k = len(W.sent)
engine.run_cycle(W, S, em(), log=quiet)
check(S.db.execute("select provider_status from order_ticket_delivery where order_id=?", (bounce,)).fetchone()[0] == "bounced"
      and any("BOUNCED" in s[1]["html"] for s in W.sent[k:] if s[0] == "ALERT-CONTACT"), "a bounce is recorded and alerted")

print("\n== A transferred ticket goes to its current holder ==")
moved_o, moved_e = purchase("moved2")
holder_e, holder_c = "zz.auto.holder.%s@example.invalid" % STAMP, "c-zz-holder-%s" % STAMP
tid = tickets_of(moved_o)[0][0]
st_, out = http("POST", "/attendees/%d/transfer" % tid, {"first_name": "ZZ", "last_name": "Holder", "email": holder_e, "reason": "Test transfer"})
assert st_ == 200, out
cls_, why_, _o, _i = engine.classify(moved_o, em(), W, S)
check(cls_ == "YELLOW" and "transferred_holder_has_no_single_ghl_contact" in why_, "no GHL contact for the holder: held, not sent to the buyer", (cls_, why_))
W.contacts[holder_c] = {"id": holder_c, "email": holder_e, "firstName": "ZZ", "lastName": "Holder", "dnd": False}
k = len(W.sent)
engine.run_cycle(W, S, em(), log=quiet)
got = [x for x in W.sent[k:] if x[1].get("subject", "").endswith(moved_o)]
check(len(got) == 1 and got[0][0] == holder_c, "sent once, to the holder's contact, never the buyer's", [x[0] for x in got])
check(S.db.execute("select recipient from order_ticket_delivery where order_id=?", (moved_o,)).fetchone()[0] == holder_e, "and the history names the holder")

print("\n== Bulk sender vs automatic sender on the same order ==")
race, _ = purchase("race")
sys.path.insert(0, "/root/Documents/Codex/2026-11-03/files-pasted-by-the-user-gaia/work/tonight")
def racer(which, oid, path, q):
    import importlib
    os.environ["TICKET_DELIVERY_DB"] = path
    order = {"order_id": oid, "recipient": "x@example.invalid", "event": {"id": 1}, "tickets": [{"ticket_id": 1}]}
    calls = []
    def transport(o, p):
        time.sleep(0.3); calls.append(1); return {"ok": True, "messageId": which}
    if which == "bulk":
        od = importlib.import_module("order_delivery")
        s = od.DeliveryState(path)
        r = od.deliver(order, s, "sha", lambda o: (True, ""), transport)
    else:
        s = st.DeliveryState(path)
        r = st.deliver(order, s, "sha", lambda o: (True, ""), transport, lambda o: {})
    q.put((which, r["state"], len(calls)))
results = []
for trial in range(5):
    oid = "%s-trial%d" % (race, trial)
    q = multiprocessing.Queue()
    ps = [multiprocessing.Process(target=racer, args=(w, oid, os.environ["TICKET_DELIVERY_DB"], q)) for w in ("bulk", "auto")]
    import order_delivery as _od
    _od.render_order_email = lambda o: {}
    [p.start() for p in ps]; [p.join(30) for p in ps]
    out = [q.get(timeout=5) for _ in ps]
    results.append(sum(x[2] for x in out))
check(results == [1] * 5, "5 simultaneous races: the order is sent exactly once every time", results)

print("\n== Pause stops everything, the bulk sender too ==")
S.put("mode_before_pause", "live", "test"); S.put("mode", "paused", "test")
paused_order, _ = purchase("paused")
k = len(W.customer_sends())
engine.run_cycle(W, S, em(), log=quiet)
import order_delivery as od2
check(len(W.customer_sends()) == k and od2.paused(S), "paused: nothing sent, and the bulk sender sees the pause")

print("\n== Dashboard API ==")
st_, summ = http("GET", "/events/1/ticket-delivery/summary")
check(st_ == 200 and summ["mode"] == "paused" and summ["counts"].get("review", 0) >= 6, "summary: mode and counts", (st_, summ))
st_, found = http("GET", "/events/1/ticket-delivery/orders?q=" + good_email)
check(st_ == 200 and found["total"] == 1 and found["rows"][0]["order_id"] == good and found["rows"][0]["bucket"] == "delivered", "search by email finds the order, delivered", found)
st_, found = http("GET", "/events/1/ticket-delivery/orders?q=%23" + str(tk[0]))
check(st_ == 200 and any(r["order_id"] == good for r in found["rows"]), "search by ticket number", found)
st_, found = http("GET", "/events/1/ticket-delivery/orders?bucket=review")
check(st_ == 200 and {refund, dndo, moved, seats, revoked} <= {r["order_id"] for r in found["rows"]}, "the review list shows the held orders with reasons")
st_, det = http("GET", "/events/1/ticket-delivery/orders/" + good)
check(st_ == 200 and len(det["attempts"]) == 2, "order history", det)
st_, _ = http("POST", "/events/1/ticket-delivery/orders/%s/resend" % good, {"reason": ""})
check(st_ == 422, "a resend without a reason is refused")
st_, _ = http("POST", "/events/1/ticket-delivery/orders/%s/resend" % refund, {"reason": "customer asked again"})
check(st_ == 409, "an order that was never sent cannot be 'resent'")
st_, rs = http("POST", "/events/1/ticket-delivery/orders/%s/resend" % good, {"reason": "customer cannot find it"})
check(st_ == 200 and rs["queued"], "a resend with a reason is queued", rs)
k = len(W.customer_sends())
engine.run_cycle(W, S, em(), log=quiet)
check(len(W.customer_sends()) == k, "while paused, the queued resend waits")
st_, _ = http("POST", "/events/1/ticket-delivery/resume", {"reason": "x"})
check(st_ == 422, "resume needs a reason")
st_, rm = http("POST", "/events/1/ticket-delivery/resume", {"reason": "test over, back on"})
check(st_ == 200 and rm["mode"] == "live", "resume returns to the mode before the pause", rm)
engine.run_cycle(W, S, em(), log=quiet)
check([x for x in W.customer_sends()[k:] if x[1]["subject"].endswith(good)], "the resend went out once resumed")
hist = S.db.execute("select kind,state,reason,actor from delivery_attempts where order_id=? order by id", (good,)).fetchall()
check(hist[-1][0] == "resend" and "customer cannot find it" in hist[-1][2] and hist[-1][3].startswith("admin:"), "the resend is in the history with its reason and who asked", hist[-1])
st_, aud = http("GET", "/events/1/ticket-delivery/audit")
check(st_ == 200 and {"resume", "resend_requested"} <= {a["action"] for a in aud}, "admin actions are in the audit", [a["action"] for a in aud][:5])
st_, _ = http("POST", "/events/1/ticket-delivery/pause", {"reason": "end of test"})
st_, summ = http("GET", "/events/1/ticket-delivery/summary")
check(summ["mode"] == "paused", "pause from the dashboard takes effect", summ["mode"])

print("\n== Live needs the approved template ==")
S.put("mode", "live", "test"); S.put("approved_template_sha", "not-this-template", "test")
late, _ = purchase("late")
k = len(W.customer_sends())
r = engine.run_cycle(W, S, em(), log=quiet)
check(len(W.customer_sends()) == k and r["shadow_would_send"] >= 1, "a changed template is never sent automatically", r)

print("\n== The shadow-only lock beats the database mode ==")
engine.HARD_SHADOW = True
S.put("mode", "live", "test"); S.put("approved_template_sha", engine.template_sha(), "test")
locked, _ = purchase("locked")
S.db.execute("insert into resend_requests(event_id,order_id,reason,requested_by,requested_at) values(1,?,?,?,?)", (good, "lock test", "admin:test", st.now()))
k = len(W.customer_sends())
r = engine.run_cycle(W, S, em(), log=quiet)
check(len(W.customer_sends()) == k and r["shadow_would_send"] >= 1 and r["resends"] == 0, "mode=live in the database, lock on: no customer email, resend waits", r)
blocked = False
try:
    engine.Live.send(type("L", (), {"alert_contact": lambda self: "ALERT", "cfg": {}})(), "CUSTOMER", {})
except RuntimeError:
    blocked = True
check(blocked, "and the real send route itself refuses any contact but the alert contact")
engine.HARD_SHADOW = False

print("\n%s" % ("ALL PASSED" if not fails else "%d FAILED" % fails))
S.close()
sys.exit(1 if fails else 0)
