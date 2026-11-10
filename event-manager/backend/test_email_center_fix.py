"""EMAIL CENTER — FIX WORKFLOW, 10 Nov 2026.

Investigate, correct, approve and re-check flagged orders from the Email
Center, on a throwaway copy of the live database (the real #204 booking is
corrected ON THE COPY ONLY). Simulated GHL; nothing is emailed.

Checked:
  * corrections run through the ONE reconciliation executor (same records,
    same history) and every one is followed by the reconciliation re-run;
  * a reviewer applies low-risk fixes herself; sensitive ones are proposed and
    approved by a DIFFERENT platform admin; she cannot apply them directly;
  * booking #204: 4 paid, 3 issued -> propose the missing ticket -> approve ->
    exactly 4 tickets, existing 3 untouched, new QR valid, flag gone, order
    approvable; and it stays fixed after reruns; a second approval or a
    concurrent one creates nothing more;
  * the same correction cannot be pending twice; rejected/withdrawn work;
  * Needs Attention: one item per problem, filters, assignment;
  * Entitlement Review is admin-only; payments are never changed.
Run:  /root/event-email-wt/stage-run.sh python3 test_email_center_fix.py
"""
import json, os, secrets, shutil, sqlite3, sys, tempfile, threading, urllib.error, urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
WORK = tempfile.mkdtemp(prefix="ecfix-test-")
TD = os.path.join(WORK, "ticket-delivery.db")
src = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "data", "ticket-delivery.db"), uri=True)
dst = sqlite3.connect(TD); src.backup(dst); dst.close(); src.close()
FAKE = os.path.join(WORK, "fake.json"); json.dump({}, open(FAKE, "w"))
os.environ.update(TICKET_DELIVERY_DB=TD, EMAIL_CENTER_FAKE=FAKE, EMAIL_CENTER_FAKE_OUTBOX=os.path.join(WORK, "outbox.jsonl"),
                  EMAIL_CENTER_SEND_PAUSE="0.05", EMAIL_CENTER_CACHE_SECONDS="0")

os.environ["TESTBED_RAW_APPROVALS"] = "1"
import testbed                                                # noqa: E402
BASE, DB = testbed.start()
import main                                                   # noqa: E402

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try:
            return e.code, json.loads(b or "null")
        except Exception:
            return e.code, b

db = sqlite3.connect(DB, timeout=60)
now = datetime.utcnow().isoformat(" ")
EV, TAG = 1, secrets.token_hex(3)
E = "/events/%d/email-center" % EV

def user(label, role=None, admin=0):
    cur = db.execute("insert into users(email,hashed_password,full_name,is_admin,created_at) values(?,?,?,?,?)",
                     ("zz-%s-%s@example.invalid" % (label, TAG), "x", "ZZ " + label, admin, now))
    if role:
        db.execute("insert into event_roles(user_id,event_id,role,created_at) values(?,?,?,?)", (cur.lastrowid, EV, role, now))
    db.commit()
    return cur.lastrowid, {"Authorization": "Bearer " + main.create_access_token({"sub": str(cur.lastrowid)})}

A1_ID, A1 = user("admin1", admin=1)
A2_ID, A2 = user("admin2", admin=1)
TEM_ID, TEM = user("tem", "ticket_email_manager")
DOOR_ID, DOOR = user("door", "checkin_staff")
PAY0 = db.execute("select count(*), sum(amount), sum(coalesce(amount_refunded,0)), group_concat(status) from payment_events").fetchone()
LINKS0 = dict(db.execute("select id, attendee_id from payment_events"))

# ---------------------------------------------------------------------------
print("\n== Entitlement Review is admin-only")
check(call("GET", "/entitlement-review", headers=TEM)[0] == 403, "Ticket Email Manager: 403")
check(call("GET", "/entitlement-review", headers=DOOR)[0] == 403, "Door staff: 403")
check(call("GET", "/entitlement-review", headers=A1)[0] == 200, "Platform admin: 200")

# ---------------------------------------------------------------------------
print("\n== Booking #204: what she sees")
st, pr = call("GET", E + "/bookings/B204/problems", headers=TEM)
check(st == 200, "Problems page opens for the reviewer", pr)
probs = {p["kind"]: p for p in pr["problems"]}
inc = probs.get("incomplete_booking")
check(inc and inc["evidence"]["paid_for"] == 4 and inc["evidence"]["issued"] == 3 and inc["evidence"]["missing"] == 1,
      "#204: 4 purchased, 3 generated, 1 missing", inc and inc["evidence"])
check(inc and len([p for p in inc["evidence"]["payments"] if p["status"] == "paid"]) == 4, "Purchase evidence: 4 paid payments listed")
check(inc and inc["what_is_wrong"] and inc["why_flagged"] and inc["correct_result"] and inc["recommended"], "Plain explanation: wrong / why / correct / recommended")
acts = {a["key"]: a for a in inc["actions"]}
check(acts.get("issue_seat", {}).get("mode") == "propose" and acts["issue_seat"].get("max_count") == 1, "Missing ticket is offered as a PROPOSAL, at most 1")
check("decide_duplicate" in {a["key"] for a in probs["possible_duplicate_payment"]["actions"]}, "Duplicate-payment case offers a decision proposal")
INC, DUP = inc["id"], probs["possible_duplicate_payment"]["id"]
before = {r[0]: (r[1], r[2]) for r in db.execute("select id,qr_code,public_token from attendees where id in (204,724,725)")}

# She cannot create a ticket herself.
st, r = call("POST", E + "/issues/%d/fix" % INC, {"action": "issue_seat", "body": {"first_name": "Guest"}, "note": "trying directly", "confirm": True}, TEM)
check(st == 403, "Reviewer cannot create a paid ticket directly", (st, r))
st, r = call("POST", "/events/%d/reconcile/issues/%d/action" % (EV, INC), {"action": "issue_seat", "first_name": "x", "note": "x", "confirm": True}, TEM)
check(st == 403, "...nor through Ticket Reconciliation", st)
st, r = call("POST", E + "/issues/%d/propose" % INC, {"action": "issue_seat", "body": {"first_name": "Guest", "count": 2},
                                                     "reason": "paid four times, see payments", "root_cause": "ticket_generation"}, TEM)
check(st == 409, "Cannot propose more tickets than are missing", r)
st, r = call("POST", E + "/issues/%d/propose" % INC, {"action": "issue_seat", "body": {"first_name": "Guest of", "last_name": "Jessica Ison"},
                                                     "reason": "Four separate paid orders of $99 each; three tickets exist. The fourth seat was never issued.",
                                                     "root_cause": "ticket_generation"}, TEM)
check(st == 200 and r["proposal"]["state"] == "proposed", "Reviewer proposes the missing ticket", r)
PID = r["proposal"]["id"]
check([s["action"] for s in r["proposal"]["steps"]] == ["decide_duplicate", "issue_seat", "release"],
      "One proposal: record 'real seat', create the ticket, release the hold that waited for it", r["proposal"]["steps"])
check(r["proposal"]["current_value"] and r["proposal"]["proposed_value"] and r["proposal"]["evidence"]["payments"], "Proposal carries current/proposed values and evidence")
st, r2 = call("POST", E + "/issues/%d/propose" % INC, {"action": "issue_seat", "body": {"first_name": "Guest of", "last_name": "Jessica Ison"},
                                                      "reason": "Four separate paid orders of $99 each; three tickets exist. The fourth seat was never issued.",
                                                      "root_cause": "ticket_generation"}, TEM)
check(st == 409, "The same correction cannot be pending twice", r2)
st, q = call("GET", E + "/queue?filter=awaiting_approval", headers=TEM)
check(any(x.get("issue_id") == INC for x in q["items"]), "Needs Attention: #204 is 'awaiting approval'")
check(call("POST", E + "/proposals/%d/decide" % PID, {"decision": "approve", "note": "ok"}, TEM)[0] == 403, "Reviewer cannot approve")
check(db.execute("select count(*) from attendees where json_extract(custom_data,'$.bought_by_attendee')=204").fetchone()[0] == 2,
      "Nothing changed before approval")

# Approve with two admins clicking at the same moment: applied once.
res = []
def approve(h):
    res.append(call("POST", E + "/proposals/%d/decide" % PID, {"decision": "approve", "note": "checked the four GHL orders"}, h))
ts = [threading.Thread(target=approve, args=(h,)) for h in (A1, A2, A1)]
[t.start() for t in ts]; [t.join() for t in ts]
oks = [r for r in res if r[0] == 200]
check(len(oks) == 1, "Three simultaneous approvals: exactly one applies", [r[0] for r in res])
st, out = oks[0] if oks else (None, {})
check(out.get("state") == "applied", "Applied, and the re-check no longer finds the problem", out)
seats = db.execute("select id,qr_code,public_token,registration_status from attendees where json_extract(custom_data,'$.bought_by_attendee')=204").fetchall()
check(len(seats) == 3, "Booking now has 4 tickets (buyer + 3 seats)", len(seats))
new = [s for s in seats if s[0] not in (724, 725)]
check(len(new) == 1 and new[0][1] and new[0][1].startswith("ATT-") and new[0][2], "The new ticket has its own QR code and badge", new)
after = {r[0]: (r[1], r[2]) for r in db.execute("select id,qr_code,public_token from attendees where id in (204,724,725)")}
check(after == before, "The 3 existing tickets are untouched (same QR codes and badges)")
qrs = [r[0] for r in db.execute("select qr_code from attendees where event_id=1 and qr_code is not null")]
check(len(qrs) == len(set(qrs)), "No QR code is shared anywhere in the event")
st, b = call("GET", E + "/bookings/B204", headers=TEM)
check(b["paid_for"] == 4 and b["tickets_generated"] == 4, "Email Center: paid 4 · generated 4", (b["paid_for"], b["tickets_generated"]))
check(not any(c["code"] in ("MISSING_TICKETS", "RECONCILIATION") for c in b["critical"]), "Missing-ticket and case blockers gone", b["critical"])
check(not b["critical"], "No blockers left: hold released with the fix, email record rebuilt", b["critical"])
st, pv = call("GET", E + "/proposals?state=all", headers=TEM)
p = [x for x in pv["items"] if x["id"] == PID][0]
check(p["proposed_by"] == "ZZ tem" and p["decided_by"] in ("ZZ admin1", "ZZ admin2") and p["applied_at"] and p["validation"]["booking"]["generated"] == 4,
      "Audit: who proposed, who approved, when applied, validation result", p)
check(call("POST", E + "/proposals/%d/decide" % PID, {"decision": "approve", "note": "again"}, A2)[0] == 409, "Approving again does nothing (409)")
st, r = call("POST", E + "/issues/%d/propose" % INC, {"action": "issue_seat", "body": {"first_name": "Again"}, "reason": "trying a fifth ticket here",
                                                     "root_cause": "one_off"}, TEM)
check(st in (400, 404, 409), "A fifth ticket cannot even be proposed", (st, r))

st, b = call("GET", E + "/bookings/B204", headers=TEM)
check(not b["critical"] and b["can_approve"], "#204 has no blockers and can be approved", b["critical"])
st, r = call("POST", E + "/bookings/B204/review", {"action": "approve", "fingerprint": b["fingerprint"]}, TEM)
check(st == 200, "Reviewer approves #204")
check(len(b["units"]) >= 1 and sum(len(u["ticket_ids"]) for u in b["units"]) == 4, "All 4 tickets are in the booking's emails",
      [(u["unit_key"], u["ticket_ids"]) for u in b["units"]])
outbox = os.path.join(WORK, "outbox.jsonl")
check(not os.path.exists(outbox), "Fixing and approving sent nothing")

# Persistence: reruns, restarts of the check, a list rebuild.
for _ in range(2):
    call("POST", E + "/bookings/B204/revalidate", {}, TEM)
st, b2 = call("GET", E + "/bookings/B204", headers=TEM)
check(not b2["critical"] and b2["review_state"] == "approved" and b2["tickets_generated"] == 4, "Still fixed and approved after two re-runs", b2["critical"])
st_i = db.execute("select status,detected from recon_issues where id=?", (INC,)).fetchone()
check(st_i == ("resolved", 0), "Reconciliation case is resolved by the check itself (not by a button)", st_i)
st, rr = call("POST", "/events/%d/reconcile/run" % EV, {}, A1)
st_i = db.execute("select status,detected from recon_issues where id=?", (INC,)).fetchone()
check(st_i == ("resolved", 0), "Stays resolved after a full reconciliation run", st_i)
check(db.execute("select count(*) from attendees where json_extract(custom_data,'$.bought_by_attendee')=204").fetchone()[0] == 3, "Still exactly 4 tickets")
# Approval invalidation after a later change.
db.execute("update attendees set last_name=last_name||'x' where id=?", (new[0][0],)); db.commit()
st, b3 = call("GET", E + "/bookings/B204", headers=TEM)
check(b3["changed_since_review"] and b3["review_state"] == "pending_review", "A later change to a ticket cancels the approval")

# ---------------------------------------------------------------------------
print("\n== Low-risk fixes she applies herself")
st, q = call("GET", E + "/queue?filter=open", headers=TEM)
cu = [x for x in q["items"] if x["kind"] == "contact_unverified" and x.get("booking")]
check(len(cu) >= 5, "Queue lists 'buyer contact not verified' items", len(cu))
if cu:
    it = cu[0]
    st, pr = call("GET", E + "/bookings/%s/problems" % it["booking"], headers=TEM)
    issue = next(p for p in pr["problems"] if p["id"] == it["issue_id"])
    a = {x["key"]: x for x in issue["actions"]}
    check(a.get("set_delivery_email", {}).get("mode") == "direct" and a.get("release_contact", {}).get("mode") == "direct",
          "Contact-only hold: correct delivery email and release are direct actions", list(a))
    check(call("POST", E + "/issues/%d/fix" % issue["id"], {"action": "release_contact", "note": "x", "confirm": True}, TEM)[0] == 400, "A note is required")
    check(call("POST", E + "/issues/%d/fix" % issue["id"], {"action": "release_contact", "note": "phoned the buyer"}, TEM)[0] == 428, "Confirmation is required")
    target = issue["evidence"]["tickets"][0]
    new_addr = "zz-verified-%s@example.invalid" % TAG
    st, r = call("POST", E + "/issues/%d/fix" % issue["id"], {"action": "set_delivery_email", "body": {"email": new_addr},
                                                               "note": "buyer confirmed by phone", "confirm": True}, TEM)
    check(st == 200, "Reviewer corrects the delivery email", r)
    st, r = call("POST", E + "/issues/%d/fix" % issue["id"], {"action": "release_contact", "note": "address confirmed by phone", "confirm": True}, TEM)
    check(st == 200 and r["validation"]["issues"][str(issue["id"])]["still_found"] is False, "Release; the re-check clears the case", r.get("validation"))
    st, b = call("GET", E + "/bookings/%s" % it["booking"], headers=TEM)
    check(any(u["recipient"] == new_addr for u in b["units"]), "The order's email now goes to the confirmed address")
    tk = db.execute("select email from attendees where id=?", (target["id"],)).fetchone()[0]
    check(tk == target["email"], "The ticket itself (holder email) is unchanged — only the delivery address")
    hist = [h for h in db.execute("select kind,actor from recon_history where issue_id=?", (issue["id"],))]
    check(any(k == "action" for k, _ in hist), "Recorded in the reconciliation history (same records as Ticket Reconciliation)")

# Holder name fix (door-level metadata) yes; ticket email change no.
hd = [x for x in q["items"] if x["kind"] == "holder_details" and x.get("booking") and x["booking"] != "B204"]
if hd:
    it = hd[0]
    st, pr = call("GET", E + "/bookings/%s/problems" % it["booking"], headers=TEM)
    issue = next(p for p in pr["problems"] if p["id"] == it["issue_id"])
    tid = issue["evidence"]["tickets"][-1]["id"]
    email0 = db.execute("select email from attendees where id=?", (tid,)).fetchone()[0]
    st, r = call("POST", E + "/issues/%d/fix" % issue["id"], {"action": "correct_holder", "body": {"ticket_id": tid, "first_name": "Zzfixed",
                 "last_name": "Holder", "email": "sneaky@example.invalid"}, "note": "name confirmed with the buyer", "confirm": True}, TEM)
    check(st == 200, "Reviewer corrects a holder's name", r)
    row = db.execute("select first_name,email from attendees where id=?", (tid,)).fetchone()
    check(row[0] == "Zzfixed" and row[1] == email0, "Name changed; an email slipped into the same request was ignored", row)
    st, r = call("POST", E + "/issues/%d/fix" % issue["id"], {"action": "correct_ticket_email", "body": {"ticket_id": tid, "email": "x@example.invalid"},
                 "note": "trying the sensitive one", "confirm": True}, TEM)
    check(st == 403, "Changing the ticket's email is a proposal, not a direct fix", st)

# Pass change: proposal only.
st, r = call("POST", E + "/issues/%d/fix" % INC, {"action": "change_category", "body": {"ticket_id": 204, "ticket_type_id": 1},
             "note": "trying the pass", "confirm": True}, TEM)
check(st in (400, 403), "Reviewer cannot change a pass directly", st)

# Acknowledge a do-not-email case.
st, q = call("GET", E + "/queue?filter=open", headers=TEM)
dnd = [x for x in q["items"] if x["kind"] == "email_suppressed"]
if dnd:
    st, r = call("POST", E + "/issues/%d/fix" % dnd[0]["issue_id"], {"action": "acknowledge", "note": "customer asked for no email; desk finds them",
                 "confirm": True}, TEM)
    check(st == 200, "Reviewer acknowledges a do-not-email case", r)
    st, q2 = call("GET", E + "/queue?filter=open", headers=TEM)
    check(not any(x.get("issue_id") == dnd[0]["issue_id"] for x in q2["items"]), "...it leaves the open queue")
    call("POST", "/events/%d/reconcile/run" % EV, {}, A1)
    check(db.execute("select status from recon_issues where id=?", (dnd[0]["issue_id"],)).fetchone()[0] == "reviewed",
          "...and stays decided after a reconciliation run")

# ---------------------------------------------------------------------------
print("\n== Queue: one item per problem, filters, assignment")
st, q = call("GET", E + "/queue?filter=open", headers=TEM)
keys = [x["key"] for x in q["items"]]
check(len(keys) == len(set(keys)), "No duplicate items")
iss = [x["issue_id"] for x in q["items"] if x.get("issue_id")]
check(len(iss) == len(set(iss)), "Each reconciliation case appears once")
check(q["by_category"] and q["open"] == q["count"], "Items are grouped into categories", q["by_category"])
blocked = call("GET", E + "/bookings?filter=blocked", headers=TEM)[1]["items"]
withitem = {x["booking"] for x in q["items"] if x.get("booking")}
nocover = [b["key"] for b in blocked if b["key"] not in withitem]
decided = [k for k in nocover if all(p["status"] == "reviewed" or not p["detected"]
                                     for p in call("GET", E + "/bookings/%s/problems" % k, headers=TEM)[1]["problems"])]
check(nocover == decided, "Every blocked order has a queue item, unless its case was decided (e.g. do-not-email)", (nocover, decided))
first = next(x for x in q["items"] if x.get("issue_id"))
check(call("POST", E + "/issues/%d/assign" % first["issue_id"], {"me": True}, TEM)[0] == 200, "Assign to myself")
st, mine = call("GET", E + "/queue?filter=mine", headers=TEM)
check(any(x["issue_id"] == first["issue_id"] for x in mine["items"]), "'Assigned to me' filter")
check(call("POST", E + "/issues/%d/assign" % first["issue_id"], {"user_id": DOOR_ID}, TEM)[0] == 400, "Cannot assign to someone without review rights")
check(call("POST", E + "/issues/%d/comment" % first["issue_id"], {"text": "looking into it"}, TEM)[0] == 200, "Add a note")
check(call("GET", E + "/queue", headers=DOOR)[0] == 403, "Door staff cannot open the queue")
st, rq = call("GET", E + "/queue?filter=resolved", headers=TEM)
check(any(x.get("issue_id") == INC for x in rq["items"]), "'Resolved' shows #204's case, cleared by the check")

# Reject and withdraw.
some = next((x for x in q["items"] if x.get("issue_id") and x["kind"] == "manual_review"), None) or first
st, pr = call("GET", E + "/bookings/%s/problems" % some["booking"], headers=TEM)
iss_ = next(p for p in pr["problems"] if p["id"] == some["issue_id"])
if any(a["key"] == "request_admin" for a in iss_["actions"]):
    st, r = call("POST", E + "/issues/%d/propose" % some["issue_id"], {"action": "request_admin", "reason": "Please check this payment in GHL first.",
                 "root_cause": "unknown"}, TEM)
    check(st == 200, "Request admin action", r)
    pid2 = r["proposal"]["id"]
    check(call("POST", E + "/proposals/%d/decide" % pid2, {"decision": "reject", "note": "not needed"}, A1)[0] == 200, "Admin rejects")
    check(call("POST", E + "/proposals/%d/withdraw" % pid2, {}, TEM)[0] == 409, "A decided proposal cannot be withdrawn")

# ---------------------------------------------------------------------------
print("\n== Nothing financial changed")
PAY1 = db.execute("select count(*), sum(amount), sum(coalesce(amount_refunded,0)), group_concat(status) from payment_events").fetchone()
check(PAY0 == PAY1, "No payment amount, refund or status changed; none added or removed")
moved = {k: (v, a) for k, a in db.execute("select id, attendee_id from payment_events") for v in [LINKS0.get(k)] if v != a}
check(len(moved) == 1 and list(moved.values())[0] == (204, new[0][0]),
      "Only one payment link moved: the 4th seat's payment, from the buyer's ticket to the new ticket it paid for", moved)
check(not os.path.exists(outbox), "No email was sent by any of this")

print("\n%d failure(s)" % len(fails))
for f in fails:
    print("   - " + f)
shutil.rmtree(WORK, ignore_errors=True)
sys.exit(1 if fails else 0)
