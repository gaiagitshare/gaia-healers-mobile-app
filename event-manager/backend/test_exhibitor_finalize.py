"""EXHIBITOR FINALIZE -- 10 Nov 2026.

Before the first exhibitor invitations go out:
  * two independent sending switches: attendee ticket emails and exhibitor
    emails. Exhibitor ON never lets a ticket email through (single send, retry,
    resend, batch start, batch resume); both OFF refuses everything; the
    automatic ticket sender stays in shadow whatever the switches say;
  * only a platform admin flips a switch, with a reason, and it is audited;
  * stand readiness: missing contact email, GHL contact checked read-only
    (found / none / several / do-not-email), ready to send;
  * a stand's GHL contact is created only by a platform admin who confirms the
    representative -- an existing contact is used as it is, the new one has the
    source "Gaia Healers event - Exhibitor" and no email is sent;
  * flags for admin review: paid/comp with scanning off, partially paid, no
    scanner link -- and no scanner permission or payment record changes;
  * the per-stand activity trail;
  * the setup page (mobile logo size, Gaia Healers title).
Everything runs on a throwaway copy with a SIMULATED GHL. No email to anyone.
Run:  /root/event-exh-wt/stage-run.sh python3 test_exhibitor_finalize.py
"""
import json, os, secrets, sqlite3, sys, tempfile, urllib.error, urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

WORK = tempfile.mkdtemp(prefix="exfin-test-")
TD = os.path.join(WORK, "ticket-delivery.db")
src = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "data", "ticket-delivery.db"), uri=True)
dst = sqlite3.connect(TD); src.backup(dst); dst.close(); src.close()
FAKE = os.path.join(WORK, "fake-ghl.json")
OUTBOX = os.path.join(WORK, "outbox.jsonl")
BW = os.path.join(WORK, "bw"); os.makedirs(BW)
json.dump({}, open(FAKE, "w"))
json.dump({}, open(os.path.join(BW, "fake.json"), "w"))
os.environ.update(TICKET_DELIVERY_DB=TD, EMAIL_CENTER_FAKE=FAKE, EMAIL_CENTER_FAKE_OUTBOX=OUTBOX, BIOWELL_FAKE=BW,
                  EMAIL_CENTER_SEND_PAUSE="0.05", EMAIL_CENTER_CACHE_SECONDS="0")
os.environ.pop("EMAIL_CENTER_DISABLED", None)
os.environ.pop("BIOWELL_CREATE_CONTACTS", None)        # the stand route must not depend on the station's switch

os.environ["TESTBED_RAW_APPROVALS"] = "1"
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
            return r.status, (b.decode() if raw else json.loads(b.decode() or "null"))
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try:
            return e.code, json.loads(b or "null")
        except Exception:
            return e.code, b

def outbox():
    try:
        return [json.loads(x) for x in open(OUTBOX)]
    except OSError:
        return []

def bw_log():
    try:
        return [json.loads(x) for x in open(os.path.join(BW, "outbox.jsonl"))]
    except OSError:
        return []

def bw_fake(**cfg):
    json.dump(cfg, open(os.path.join(BW, "fake.json"), "w"))

db = sqlite3.connect(DB, timeout=30)
td = sqlite3.connect(TD, timeout=30)
now = datetime.utcnow().isoformat(" ")
EV, TAG = 1, secrets.token_hex(3)
E = "/events/%d/email-center" % EV

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
EXM = user("exm", "exhibitor_manager")

GA = db.execute("select id from ticket_types where event_id=? order by id limit 1", (EV,)).fetchone()[0]

def ticket(last, email):
    qr = "ATT-" + secrets.token_hex(6).upper()
    badge = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
    c = db.execute("insert into attendees(event_id,email,first_name,last_name,qr_code,public_token,is_checked_in,registration_status,"
                   "registration_source,attendance_type,ticket_type_id,custom_data,created_at) values(?,?,?,?,?,?,0,'registered',"
                   "'ghl_order','paid',?,'{}',?)", (EV, email, "Zz", last + TAG, qr, badge, GA, now))
    db.execute("insert into payment_events(ghl_transaction_id,ghl_entity_type,ghl_entity_id,provider,status_raw,amount,amount_refunded,currency,"
               "live_mode,occurred_at,buyer_name,buyer_email,buyer_phone,contact_id,product_names,event_id,status,attendee_id,first_seen_at,ingest_source) "
               "values(?,?,?,?,?,99,0,'USD',1,?,?,?,?,?,?,?,?,?,?,?)",
               ("ZZTX" + secrets.token_hex(6), "order", "ZZORD-%s-%s" % (last, TAG), "stripe", "succeeded", now, "Zz Buyer", email, None,
                "zzcontact", json.dumps(["ZZ General Admission"]), EV, "paid", c.lastrowid, now, "zz-test"))
    db.commit()
    return "B%d" % c.lastrowid

def fp(key):
    return call("GET", E + "/bookings/" + key, headers=ORG)[1]["fingerprint"]

def approve(key):
    call("POST", E + "/bookings/%s/review" % key, {"action": "verify", "note": "", "fingerprint": fp(key)}, ORG)
    return call("POST", E + "/bookings/%s/review" % key, {"action": "approve", "note": "", "fingerprint": fp(key)}, TEM)

def send_ticket(key, **kw):
    return call("POST", E + "/bookings/%s/send" % key, dict(kw, fingerprint=fp(key)), TEM)

def switch(channel, state, who=ADMIN, reason=None):
    return call("POST", E + "/controls", {"channel": channel, "sending": state,
                                          "reason": ("test %s" % TAG) if reason is None else reason}, who)

def stand(name, email, scan=1, pay_status="paid", due=None, paid=None, token=True):
    tok = ("EXH-" + secrets.token_hex(8).upper()) if token else None
    c = db.execute("insert into exhibitors(event_id,company_name,booth_number,contact_email,contact_name,access_token,created_at,"
                   "is_published,can_scan_leads,stage,payment_status,amount_due,amount_paid) values(?,?,?,?,?,?,?,1,?,'confirmed',?,?,?)",
                   (EV, name, "98", email, "Zz Rep", tok, now, scan, pay_status, due, paid))
    db.commit()
    return c.lastrowid

def ex_send(ex_id, kind="setup", who=ORG, **kw):
    return call("POST", E + "/exhibitors/%d/send" % ex_id, dict(kw, kind=kind), who)

def rows():
    return {r["id"]: r for r in call("GET", E + "/exhibitors", headers=ORG)[1]["items"]}

def mode():
    r = td.execute("select value from delivery_control where key='mode'").fetchone()
    return r[0] if r else "shadow"

SCAN_BEFORE = dict(db.execute("select id, can_scan_leads from exhibitors where event_id=?", (EV,)).fetchall())
PAY_BEFORE = db.execute("select group_concat(id||':'||coalesce(payment_status,'')||':'||coalesce(amount_paid,'')||':'||coalesce(amount_due,''))"
                        " from exhibitors where event_id=?", (EV,)).fetchone()[0]
MODE_BEFORE = mode()

# Synthetic stands
SA = stand("ZZ Fin A %s" % TAG, "zz-fina-%s@example.invalid" % TAG)
SB = stand("ZZ Fin B %s" % TAG, None, scan=0, pay_status="comp")                       # missing email, comp, scanner off
SC = stand("ZZ Fin C %s" % TAG, "zz-finc-%s@example.invalid" % TAG, pay_status="partial", due=3500, paid=1000)
SD = stand("ZZ Fin D %s" % TAG, "zz-find-%s@example.invalid" % TAG, scan=0, token=False)  # no scanner link
SE = stand("ZZ Fin E %s" % TAG, "zz-fine-%s@example.invalid" % TAG)                      # several contacts
SF = stand("ZZ Fin F %s" % TAG, "zz-finf-%s@example.invalid" % TAG)                      # do-not-email
SG = stand("ZZ Fin G %s" % TAG, "zz-fing-%s@example.invalid" % TAG)                      # no GHL contact
for x in (SA, SB, SC, SD, SE, SF, SG):
    SCAN_BEFORE[x] = db.execute("select can_scan_leads from exhibitors where id=?", (x,)).fetchone()[0]

# ---------------------------------------------------------------------------
print("\n== 1. Both switches OFF by default: nothing can be sent")
st_, ctl = call("GET", E + "/controls", headers=ORG)
check(st_ == 200 and ctl["tickets"]["switch"] == "off" and ctl["exhibitors"]["switch"] == "off"
      and not ctl["tickets"]["enabled"] and not ctl["exhibitors"]["enabled"], "Tickets OFF and exhibitors OFF", ctl)
check(ctl["switch"] == "off" and ctl["enabled"] is False, "Top-level fields still describe the ticket switch (old screens keep working)")
st_, me = call("GET", E + "/me", headers=ORG)
check(not me["sending"]["enabled"] and not me["sending_exhibitors"]["enabled"], "/me shows both OFF", (me.get("sending"), me.get("sending_exhibitors")))
K1 = ticket("FinOne", "zz-finone-%s@example.invalid" % TAG)
check(approve(K1)[0] == 200, "A synthetic booking is approved (two people)")
st_, r = send_ticket(K1)
check(st_ == 409 and "Ticket email sending is switched off" in str(r), "Ticket send refused", r)
st_, r = ex_send(SA)
check(st_ == 409 and "Exhibitor email sending is switched off" in str(r), "Exhibitor send refused", r)
pv = call("POST", E + "/batches/preview", {"exhibitor_kind": "setup", "ids": [SA]}, ORG)[1]
check(call("POST", E + "/batches", {"exhibitor_kind": "setup", "ids": [SA], "confirm_token": pv.get("confirm_token")}, ORG)[0] == 409,
      "Exhibitor batch cannot start")
pv = call("POST", E + "/batches/preview", {"keys": [K1]}, ORG)[1]
check(call("POST", E + "/batches", {"keys": [K1], "confirm_token": pv.get("confirm_token")}, ORG)[0] == 409, "Ticket batch cannot start")
check(len(outbox()) == 0, "Nothing reached the simulated mailbox")

# ---------------------------------------------------------------------------
print("\n== 2. Switch controls: platform admin only, with a reason, audited")
check(switch("exhibitors", "on", ORG)[0] == 403, "An organiser cannot switch exhibitor sending on")
check(switch("exhibitors", "on", EXM)[0] == 403, "An exhibitor manager cannot switch it on")
check(switch("exhibitors", "on", TEM)[0] == 403, "A Ticket Email Manager cannot switch it on")
check(switch("exhibitors", "on", reason="")[0] in (400, 422), "No reason, no switch")
check(switch("everything", "on")[0] in (400, 422), "An unknown channel is refused")
check(call("POST", E + "/controls", {"sending": "maybe", "channel": "exhibitors", "reason": "x"}, ADMIN)[0] in (400, 422), "Only on/off")
st_, r = switch("exhibitors", "on")
check(st_ == 200, "Platform admin switches EXHIBITOR sending on", r)
ctl = call("GET", E + "/controls", headers=ORG)[1]
check(ctl["exhibitors"]["switch"] == "on" and ctl["tickets"]["switch"] == "off", "Exhibitors ON, tickets still OFF", ctl)
a = td.execute("select actor, reason from delivery_admin_audit where action='email_center_exhibitors_sending_on' order by id desc limit 1").fetchone()
check(a and a[0].startswith("admin:zz-admin") and a[1] == "test %s" % TAG, "Audited with who and why", a)
check(mode() == MODE_BEFORE, "The automatic ticket sender's mode is unchanged (%s)" % MODE_BEFORE, mode())

# ---------------------------------------------------------------------------
print("\n== 3. Exhibitors ON, tickets OFF: no ticket email gets through")
st_, r = send_ticket(K1)
check(st_ == 409 and "Ticket email" in str(r), "Ticket send still refused", r)
st_, r = send_ticket(K1, retry=True)
check(st_ == 409, "Ticket retry refused", r)
st_, r = send_ticket(K1, resend_reason="lost it")
check(st_ == 409, "Ticket resend refused", r)
pv = call("POST", E + "/batches/preview", {"keys": [K1]}, ORG)[1]
check(pv.get("sending", {}).get("channel") == "tickets" and not pv["sending"]["enabled"], "Ticket batch preview shows the ticket switch OFF", pv.get("sending"))
check(call("POST", E + "/batches", {"keys": [K1], "confirm_token": pv.get("confirm_token")}, ORG)[0] == 409, "Ticket batch cannot start")
st_, ov = call("GET", E + "/overview", headers=ORG)
check(not ov["sending"]["enabled"] and ov["sending_exhibitors"]["enabled"], "Overview: tickets OFF, exhibitors ON")
st_, r = ex_send(SA)
check(st_ == 200 and r.get("state") == "accepted", "Exhibitor setup email sends (simulated)", r)
check(not any("zz-finone" in (x.get("to") or "") for x in outbox()), "No ticket email in the mailbox")
expv = call("POST", E + "/batches/preview", {"exhibitor_kind": "setup", "ids": [SC]}, ORG)[1]
check(expv.get("sending", {}).get("channel") == "exhibitors" and expv["sending"]["enabled"], "Exhibitor batch preview follows the exhibitor switch", expv.get("sending"))
# Ticket-delivery pause blocks tickets only, not stands.
td.execute("insert into delivery_control(key,value,updated_at,updated_by) values('mode','paused','x','test') "
           "on conflict(key) do update set value='paused'"); td.commit()
check(call("GET", E + "/controls", headers=ORG)[1]["exhibitors"]["enabled"], "Ticket pause does not block exhibitor emails")
td.execute("update delivery_control set value=? where key='mode'", (MODE_BEFORE,)); td.commit()

# Resume: a ticket run paused while tickets were on cannot resume once they are off.
switch("tickets", "on")
K2 = ticket("FinTwo", "zz-fintwo-%s@example.invalid" % TAG)
approve(K2)
os.environ["EMAIL_CENTER_SEND_PAUSE"] = "2"
pv = call("POST", E + "/batches/preview", {"keys": [K2]}, ORG)[1]
st_, b = call("POST", E + "/batches", {"keys": [K2], "confirm_token": pv.get("confirm_token")}, ORG)
bid = b.get("batch_id")
call("POST", E + "/batches/%s/pause" % bid, {}, ORG)
switch("tickets", "off")
st_, r = call("POST", E + "/batches/%s/resume" % bid, {}, ORG)
check(bid and st_ == 409, "A paused ticket run cannot resume while the ticket switch is off", (bid, st_, r))
call("POST", E + "/batches/%s/cancel" % bid, {}, ORG)
os.environ["EMAIL_CENTER_SEND_PAUSE"] = "0.05"

# ---------------------------------------------------------------------------
print("\n== 4. Tickets ON, exhibitors OFF")
switch("exhibitors", "off"); switch("tickets", "on")
st_, r = ex_send(SA, "scanner")
check(st_ == 409 and "Exhibitor email" in str(r), "Exhibitor send refused while its switch is off", r)
st_, r = send_ticket(K1)
check(st_ == 200 and r.get("state") == "sent", "Ticket send works (simulated) -- the ticket path is unchanged", r)
switch("tickets", "off")
check(mode() == MODE_BEFORE, "Automatic ticket sender still %s" % MODE_BEFORE)

# ---------------------------------------------------------------------------
print("\n== 5. Readiness and GHL contact check (read-only)")
R = rows()
check(R[SB]["readiness"] == "missing_email", "Stand without email: Missing contact email", R[SB].get("readiness"))
check(R[SA]["readiness"] == "not_checked", "Before the check: GHL not checked", R[SA].get("readiness"))
bw_fake(existing={"zz-fina-%s@example.invalid" % TAG: "fake-a", "zz-finc-%s@example.invalid" % TAG: "fake-c",
                  "zz-find-%s@example.invalid" % TAG: "fake-d"},
        several=["zz-fine-%s@example.invalid" % TAG], dnd=["zz-finf-%s@example.invalid" % TAG])
check(call("POST", E + "/exhibitors/check-contacts", {}, TEM)[0] == 403, "A Ticket Email Manager cannot run the check")
n_log = len(bw_log())
st_, r = call("POST", E + "/exhibitors/check-contacts", {}, EXM)
check(st_ == 200 and r["checked"] >= 6, "Exhibitor manager runs the GHL check", r)
check(len(bw_log()) == n_log, "The check creates nothing in GHL")
R = rows()
want = {SA: "ready", SB: "missing_email", SC: "ready", SD: "ready", SE: "several_contacts", SF: "do_not_email", SG: "missing_ghl_contact"}
check(all(R[k]["readiness"] == v for k, v in want.items()), "Each stand gets the right status",
      {k: R[k]["readiness"] for k in want})
check(R[SA]["ghl_contact"]["checked_at"], "When it was checked is shown")
check(all("fake-" not in json.dumps(r) for r in R.values()), "The list never shows GHL contact ids")
# The stored answer only counts while the email is the same.
check(call("PATCH", E + "/exhibitors/%d/contact" % SG, {"contact_email": "zz-fing2-%s@example.invalid" % TAG}, ORG)[0] == 200,
      "Admin updates a stand's contact email")
check(rows()[SG]["readiness"] == "not_checked", "A changed email needs a new check")
check(call("PATCH", E + "/exhibitors/%d/contact" % SB, {"contact_email": "zz-finb-%s@example.invalid" % TAG}, ORG)[0] == 200,
      "Admin adds the missing email")
check(rows()[SB]["readiness"] == "not_checked", "...and the stand leaves 'Missing contact email'")

# ---------------------------------------------------------------------------
print("\n== 6. Creating a stand's GHL contact: platform admin, confirmed, never automatic")
check(len([x for x in bw_log() if x.get("kind") == "contact_created"]) == 0, "No contact was created by anything above")
body = {"confirm_representative": True, "note": "Confirmed by phone with the stand"}
check(call("POST", E + "/exhibitors/%d/create-contact" % SG, body, ORG)[0] == 403, "An organiser cannot create contacts")
check(call("POST", E + "/exhibitors/%d/create-contact" % SG, body, EXM)[0] == 403, "An exhibitor manager cannot create contacts")
check(call("POST", E + "/exhibitors/%d/create-contact" % SG, {"note": "Confirmed by phone"}, ADMIN)[0] == 428, "Without confirming the representative: refused")
check(call("POST", E + "/exhibitors/%d/create-contact" % SG, {"confirm_representative": True, "note": ""}, ADMIN)[0] == 428, "Without saying how: refused")
check(call("POST", E + "/exhibitors/%d/create-contact" % SE, body, ADMIN)[0] == 409, "Several contacts already: refused")
n0 = len(outbox())
st_, r = call("POST", E + "/exhibitors/%d/create-contact" % SG, body, ADMIN)
made = [x for x in bw_log() if x.get("kind") == "contact_created"]
check(st_ == 200 and r["created"] and len(made) == 1, "Admin creates the contact (simulated GHL)", r)
check(made and made[0].get("source") == "Gaia Healers event - Exhibitor" and made[0]["email"] == "zz-fing2-%s@example.invalid" % TAG,
      "Source 'Gaia Healers event - Exhibitor', the stand's own email", made)
check(len(outbox()) == n0, "No email was sent")
check(rows()[SG]["readiness"] == "ready", "The stand is now ready")
st_, r = call("POST", E + "/exhibitors/%d/create-contact" % SA, body, ADMIN)
check(st_ == 200 and not r["created"] and len([x for x in bw_log() if x.get("kind") == "contact_created"]) == 1,
      "An existing contact is used as it is (nothing created)", r)
check(call("POST", E + "/exhibitors/%d/create-contact" % stand("ZZ Fin H %s" % TAG, None), body, ADMIN)[0] == 409,
      "No email: refused")

# ---------------------------------------------------------------------------
print("\n== 7. Flags for admin review; scanner permissions and payments untouched")
R = rows()
check("paid_or_comp_scanning_off" in R[SB]["flags"], "Comp stand with scanning off is flagged", R[SB]["flags"])
check("paid_or_comp_scanning_off" not in R[SA]["flags"], "A paid stand with scanning on is not flagged")
check("partially_paid" in R[SC]["flags"], "Partially paid stand is flagged", R[SC]["flags"])
check("no_scanner_link" in R[SD]["flags"], "A stand with no scanner link is flagged", R[SD]["flags"])
check(not R[SD]["scanner"]["eligible"], "...and gets no scanner email")
st_, r = ex_send(SD, "scanner")
check(st_ == 409 or r.get("reason"), "Scanner email refused for a stand without a link/scanning", (st_, r))
after = dict(db.execute("select id, can_scan_leads from exhibitors where event_id=?", (EV,)).fetchall())
check(all(after.get(k) == v for k, v in SCAN_BEFORE.items()), "No scanner permission changed")
check(db.execute("select access_token from exhibitors where id=?", (SD,)).fetchone()[0] is None, "No scanner link was minted automatically")

# ---------------------------------------------------------------------------
print("\n== 8. Copy links, manual sends and the activity trail")
switch("exhibitors", "on")
u = call("POST", E + "/exhibitors/%d/link" % SA, {"kind": "setup"}, ORG)[1]
check(u.get("url") and not u.get("created"), "Copy setup link: the link already emailed", u)
tok_a = db.execute("select access_token from exhibitors where id=?", (SA,)).fetchone()[0]
check(call("POST", E + "/exhibitors/%d/link" % SA, {"kind": "scanner"}, ORG)[1]["url"].endswith(tok_a), "Copy scanner link: the stand's own link")
check(call("POST", E + "/exhibitors/%d/manual" % SC, {"kind": "setup", "note": "sent from my mailbox"}, ORG)[0] == 200, "Mark sent manually")
st_, act = call("GET", E + "/exhibitors/%d/activity" % SC, headers=ORG)
whats = [x["what"] for x in act.get("items", [])]
check(st_ == 200 and "Setup email marked sent by hand" in whats and any(w.startswith("GHL contact check") for w in whats),
      "Activity shows the manual send and the GHL check", whats)
st_, act = call("GET", E + "/exhibitors/%d/activity" % SG, headers=ORG)
whats = [x["what"] for x in act.get("items", [])]
check("Contact changed" in whats and "GHL contact created" in whats, "Activity shows the contact change and the creation", whats)
check(call("GET", E + "/exhibitors/%d/activity" % SG, headers=TEM)[0] == 403, "A Ticket Email Manager cannot open stand activity")
R = rows()
check(R[SC]["setup"]["status"] == "sent_manually", "Manual send shows as 'Manually sent'")
switch("exhibitors", "off")

# ---------------------------------------------------------------------------
print("\n== 9. Setup page: new link opens, Gaia Healers branding, mobile logo")
url = u["url"]
token = url.rsplit("/", 1)[-1]
st_, html = call("GET", "/vendor/" + token, raw=True)
check(st_ == 200 and "Gaia Healers" in html and "<title>" in html and "Gaia Healers</title>" in html, "Setup page opens, title says Gaia Healers", st_)
check(".top svg{width:28px;height:28px" in html, "The Gaia mark is held at 28px (no oversized logo on phones)")
check('name="viewport"' in html, "Mobile viewport set")
st_, html = call("GET", "/vendor/not-a-real-token", raw=True)
check(st_ in (200, 404, 410) and "expired" in html.lower(), "An invalid link says the link has expired", st_)

# ---------------------------------------------------------------------------
print("\n== 10. Nothing real")
check(mode() == MODE_BEFORE, "Automatic ticket sender mode unchanged")
PAY_AFTER = db.execute("select group_concat(id||':'||coalesce(payment_status,'')||':'||coalesce(amount_paid,'')||':'||coalesce(amount_due,''))"
                       " from exhibitors where event_id=? and company_name not like 'ZZ Fin %'", (EV,)).fetchone()[0]
check(PAY_AFTER == PAY_BEFORE, "No real stand's payment status or amounts changed", (len(PAY_BEFORE or ""), len(PAY_AFTER or "")))
check(all("example.invalid" in (x.get("to") or x.get("email") or "example.invalid") for x in outbox() + bw_log()), "No real address anywhere")
ctl = call("GET", E + "/controls", headers=ORG)[1]
check(ctl["tickets"]["switch"] == "off" and ctl["exhibitors"]["switch"] == "off", "Both switches left OFF")

print("\n%d failure(s)" % len(fails))
sys.exit(1 if fails else 0)
