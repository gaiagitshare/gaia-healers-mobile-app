"""EXHIBITOR VISIBILITY -- 10 Nov 2026.

What admins need to see and do before the remaining exhibitor emails:
  * "On hold": an admin keeps a stand out of every exhibitor email (setup,
    reminder, scanner; single or batch), with a reason, until released --
    payment, scanning and the listing are untouched;
  * a stand that changes its own contact email on the setup page is flagged,
    with the old address in its activity, and needs a new GHL check;
  * the setup reminder: only after the setup email, only before setup is
    completed, the SAME link (never a new one), its own count;
  * one "next action" per stand, in priority order;
  * a pending online purchase that looks like a confirmed stand is flagged as
    a possible duplicate (a hint; nothing is merged).
Throwaway copies, SIMULATED GHL, no email to anyone.
Run:  /root/event-exh-wt/stage-run.sh python3 test_exhibitor_visibility.py
"""
import json, os, secrets, sqlite3, sys, tempfile, urllib.error, urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

WORK = tempfile.mkdtemp(prefix="exfin-test-")
TD = os.path.join(WORK, "ticket-delivery.db")
src = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "data", "ticket-delivery.db"), uri=True)
dst = sqlite3.connect(TD); src.backup(dst)
# Sending starts OFF in every copy, whatever the live switches say (Babak
# switched both on for the real event, 13 Nov 2026): these suites test the
# switch itself and must not pass or fail on how the live event is set up.
dst.execute("update delivery_control set value='off' where key in ('email_center_ticket_sending','email_center_exhibitor_sending')")
dst.commit(); dst.close(); src.close()
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

def contact_ok(*emails):
    bw_fake(existing={e: "fake-" + e.split("@")[0] for e in emails})
    check(call("POST", E + "/exhibitors/check-contacts", {}, ORG)[0] == 200, "(GHL check)")

def hold(ex_id, on, who=ORG, reason="waiting for payment"):
    return call("POST", E + "/exhibitors/%d/hold" % ex_id, {"hold": on, "reason": reason}, who)

def nxt(ex_id):
    return rows()[ex_id]["next_action"]["key"]

EA, EB = "zz-visa-%s@example.invalid" % TAG, "zz-visb-%s@example.invalid" % TAG
VA = stand("ZZ Vis A %s" % TAG, EA)
VB = stand("ZZ Vis B %s" % TAG, EB, scan=0)
VC = stand("ZZ Vis C %s" % TAG, None, scan=0)
db.execute("update exhibitors set contact_name=? where id=?", ("Zzquirin Kaanovic", VC)); db.commit()
VP = db.execute("insert into exhibitors(event_id,company_name,contact_name,contact_email,stage,is_published,can_scan_leads,payment_status,package,created_at) "
                "values(?,?,?,?,'purchased',0,0,'paid','The Ambassador $2,000',?)",
                (EV, "Zzq Purchase", "Zzq", "zzquirin.kaanovic@example.invalid", now)).lastrowid
db.commit()
contact_ok(EA, EB)
switch("exhibitors", "on")

# ---------------------------------------------------------------------------
print("\n== 1. Next action and possible duplicates")
check(nxt(VA) == "send_setup", "Fresh ready stand: Send setup email", rows()[VA]["next_action"])
R = rows()
check(R[VC]["possible_duplicate"] and R[VC]["possible_duplicate"]["id"] == VP and "possible_duplicate" in R[VC]["flags"],
      "Stand without email whose contact matches a pending purchase: possible duplicate", R[VC].get("possible_duplicate"))
check(nxt(VC) == "check_duplicate", "...next action: check the possible duplicate")
check("zzquirin" not in json.dumps(R[VC]["possible_duplicate"]), "The duplicate hint carries no email address")
check(db.execute("select stage from exhibitors where id=?", (VP,)).fetchone()[0] == "purchased", "Nothing merged or changed")
check(not R[VA]["possible_duplicate"], "No false duplicate for an unrelated stand")

# ---------------------------------------------------------------------------
print("\n== 2. On hold")
check(hold(VB, True, TEM)[0] == 403, "A Ticket Email Manager cannot hold a stand")
check(hold(VB, True, reason="")[0] == 400, "A hold needs a reason")
check(hold(VB, True)[0] == 200, "Organiser puts a stand on hold")
R = rows()
check(R[VB]["hold"] and R[VB]["hold"]["reason"] == "waiting for payment" and nxt(VB) == "on_hold", "Shown as On hold, with the reason")
check(not R[VB]["setup"]["eligible"] and not R[VB]["reminder"]["eligible"], "Not eligible for any email")
st_, r = ex_send(VB)
check(r.get("reason") == "on_hold" and r.get("state") == "refused", "Single setup send refused: on hold", r)
pv = call("POST", E + "/batches/preview", {"exhibitor_kind": "setup", "ids": [VA, VB]}, ORG)[1]
check(pv["emails"] == 1 and any(x["id"] == VB and x["reason"] == "on hold" for x in pv["excluded"]), "Batch leaves the held stand out", pv.get("excluded"))
check(db.execute("select can_scan_leads, payment_status from exhibitors where id=?", (VB,)).fetchone() == (0, "paid"),
      "Holding changes neither scanning nor payment")
check(hold(VB, False, reason="paid now")[0] == 200 and not rows()[VB]["hold"], "Hold released (with a reason)")
st_, act = call("GET", E + "/exhibitors/%d/activity" % VB, headers=ORG)
whats = [x["what"] for x in act["items"]]
check("Put on hold" in whats and "Hold released" in whats, "Hold and release are in the activity", whats)
hold(VB, True)

# ---------------------------------------------------------------------------
print("\n== 3. Setup reminder: after the setup email, same link, before completion")
st_, r = ex_send(VA, "reminder")
check(r.get("reason") == "setup_not_sent_yet", "No reminder before the setup email", r)
n0 = len(outbox())
check(ex_send(VA)[1].get("state") == "accepted", "Setup email sent")
check(nxt(VA) == "wait_setup", "Right after: Wait for setup")
link = call("POST", E + "/exhibitors/%d/link" % VA, {"kind": "setup"}, ORG)[1]["url"]
hash_before = db.execute("select setup_token_hash from exhibitors where id=?", (VA,)).fetchone()[0]
td.execute("update ec_exhibitor_emails set sent_at=? where exhibitor_id=? and kind='setup'", ("2026-01-01T00:00:00+00:00", VA)); td.commit()
check(nxt(VA) == "remind", "48 h later, not completed: Send setup reminder", rows()[VA]["next_action"])
pv = call("GET", E + "/exhibitors/%d/preview?kind=reminder" % VA, headers=ORG)[1]
check(pv["subject"].startswith("Reminder:") and link in pv["html"], "Reminder preview: own subject, the same link")
st_, r = ex_send(VA, "reminder")
check(r.get("state") == "accepted", "Reminder sent", r)
last = outbox()[-1]
import hashlib
check(last.get("subject", "").startswith("Reminder:") and last.get("html_sha") == hashlib.sha256(pv["html"].encode()).hexdigest(),
      "The reminder sent is exactly the previewed one, carrying the SAME setup link", (last.get("subject"),))
check(db.execute("select setup_token_hash from exhibitors where id=?", (VA,)).fetchone()[0] == hash_before, "No new link was created")
R = rows()
check(R[VA]["reminder"]["status"] in ("accepted", "delivered") and R[VA]["setup"]["attempts"] == 1, "Reminder has its own status; setup count unchanged",
      (R[VA]["reminder"]["status"], R[VA]["setup"]["attempts"]))
check(nxt(VA) == "wait_setup", "After the reminder: wait again (no second automatic nudge)")
check(ex_send(VA, "reminder")[1].get("state") == "skipped", "A second reminder needs a reason")
st_, act = call("GET", E + "/exhibitors/%d/activity" % VA, headers=ORG)
check("Setup reminder sent" in [x["what"] for x in act["items"]], "Reminder in the activity")
st_, r = ex_send(VB, "reminder")
check(r.get("reason") == "on_hold", "A held stand gets no reminder either", r)

# ---------------------------------------------------------------------------
print("\n== 4. The stand changes its own contact email on the setup page")
token = link.rsplit("/", 1)[-1]
NEW = "zz-visa-new-%s@example.invalid" % TAG
st_, r = call("POST", "/vendor-setup/" + token, {"contact_email": NEW, "description": "Our stand", "publish": True})
check(st_ == 200, "Stand saves and publishes with a new contact email", r)
R = rows()
check(R[VA]["stand_email_change"] and R[VA]["stand_email_change"]["old"] == EA and "email_changed_by_stand" in R[VA]["flags"],
      "Flagged: Email changed by stand, old address kept", R[VA].get("stand_email_change"))
check(R[VA]["readiness"] == "not_checked" and nxt(VA) == "check_ghl", "Needs a new GHL check before anything else",
      (R[VA]["readiness"], R[VA]["next_action"]))
check(R[VA]["setup_completed"] and not R[VA]["reminder"]["eligible"], "Setup completed; no more reminders")
st_, act = call("GET", E + "/exhibitors/%d/activity" % VA, headers=ORG)
check("Contact email changed by the stand" in [x["what"] for x in act["items"]], "The change is in the stand's activity")
st_, r = call("POST", "/vendor-setup/" + token, {"contact_email": NEW, "description": "Our stand v2"})
n_changes = td.execute("select count(*) from delivery_admin_audit where action='email_center_exhibitor_contact_by_stand' and order_id=?",
                       ("exhibitor:%d" % VA,)).fetchone()[0]
check(n_changes == 1, "Saving the same email again records nothing new", n_changes)
contact_ok(NEW, EB)
check(nxt(VA) == "send_scanner", "After the check, a completed stand with scanning on: Send scanner email", rows()[VA]["next_action"])
check(call("PATCH", E + "/exhibitors/%d/contact" % VA, {"contact_email": "zz-visa-admin-%s@example.invalid" % TAG}, ORG)[0] == 200, "Admin sets another email")
check(not rows()[VA]["stand_email_change"], "The 'changed by stand' flag clears once an admin changes it")

# ---------------------------------------------------------------------------
print("\n== 5. Decide scanning; batch reminder; nothing real")
hold(VB, False, reason="paid now")
check(ex_send(VB)[1].get("state") == "accepted", "Stand B setup sent")
db.execute("update exhibitors set activated_at=? where id=?", (now, VB)); db.commit()
check(nxt(VB) == "decide_scanning", "Completed, paid, scanning off: Decide scanning", rows()[VB]["next_action"])
pv = call("POST", E + "/batches/preview", {"exhibitor_kind": "reminder", "ids": [VA, VB]}, ORG)[1]
check(pv["emails"] == 0 and len(pv["excluded"]) == 2, "Reminder batch skips completed stands", pv.get("excluded"))
check(call("POST", E + "/batches/preview", {"exhibitor_kind": "bogus", "ids": [VA]}, ORG)[0] == 400, "Unknown email type refused")
switch("exhibitors", "off")
st_, r = ex_send(VA, "reminder")
check(st_ == 409, "Switch OFF: reminders refused too", r)
after = dict(db.execute("select id, can_scan_leads from exhibitors where event_id=?", (EV,)).fetchall())
check(all(after.get(k) == v for k, v in SCAN_BEFORE.items()), "No existing scanner permission changed")
PAY_AFTER = db.execute("select group_concat(id||':'||coalesce(payment_status,'')||':'||coalesce(amount_paid,'')||':'||coalesce(amount_due,''))"
                       " from exhibitors where event_id=? and company_name not like 'ZZ Vis %' and company_name <> 'Zzq Purchase'", (EV,)).fetchone()[0]
check(PAY_AFTER == PAY_BEFORE, "No real stand's payment changed")
check(mode() == MODE_BEFORE, "Automatic ticket sender mode unchanged")
check(all("example.invalid" in (x.get("to") or x.get("email") or "example.invalid") for x in outbox() + bw_log()), "No real address anywhere")
ctl = call("GET", E + "/controls", headers=ORG)[1]
check(ctl["tickets"]["switch"] == "off" and ctl["exhibitors"]["switch"] == "off", "Both switches left OFF")

print("\n%d failure(s)" % len(fails))
sys.exit(1 if fails else 0)
