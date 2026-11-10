"""SECOND-ADMIN APPROVAL EVERYWHERE — Babak, 10 Nov 2026.

Sensitive corrections (create a paid ticket, change a pass or access day,
change a ticket's email/owner, void/reinstate/delete, link a payment, release a
protective hold, decide a payment) need a second platform admin, whichever page
or endpoint they come from. One mechanism: the change is filed as a proposal
in the Email Center's Approvals queue and applied only when another admin
approves. Door-desk operations by door-only staff stay direct (bounded).

Throwaway copy of the live database; booking #204 is corrected ON THE COPY.
Run:  /root/event-email-wt/stage-run.sh python3 test_four_eyes.py
"""
import json, os, secrets, shutil, sqlite3, sys, tempfile, threading, urllib.error, urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
WORK = tempfile.mkdtemp(prefix="foureyes-")
TD = os.path.join(WORK, "ticket-delivery.db")
src = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "data", "ticket-delivery.db"), uri=True)
dst = sqlite3.connect(TD); src.backup(dst); dst.close(); src.close()
FAKE = os.path.join(WORK, "fake.json"); json.dump({}, open(FAKE, "w"))
OUTBOX = os.path.join(WORK, "outbox.jsonl")
os.environ.update(TICKET_DELIVERY_DB=TD, EMAIL_CENTER_FAKE=FAKE, EMAIL_CENTER_FAKE_OUTBOX=OUTBOX, EMAIL_CENTER_CACHE_SECONDS="0")

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
ORG_ID, ORG = user("org", "organizer")
TEM_ID, TEM = user("tem", "ticket_email_manager")
DOOR_ID, DOOR = user("door", "checkin_staff")

def money():
    return db.execute("select count(*), round(sum(amount),2), round(sum(coalesce(amount_refunded,0)),2) from payment_events").fetchone()
def links():
    return dict(db.execute("select id, attendee_id from payment_events"))
def qrs():
    return dict(db.execute("select id, qr_code||'|'||coalesce(public_token,'') from attendees where event_id=1"))
MONEY0, LINKS0, QR0 = money(), links(), qrs()
SEATS = "select count(*) from attendees where json_extract(custom_data,'$.bought_by_attendee')=204"

def pid_of(detail):
    import re
    m = re.search(r"proposal #(\d+)", str(detail))
    return int(m.group(1)) if m else None

def decide(pid, who, decision="approve", note="checked the evidence"):
    return call("POST", E + "/proposals/%d/decide" % pid, {"decision": decision, "note": note}, who)

ISS = {r[1]: r[0] for r in db.execute("select id, issue_key from recon_issues where issue_key in ('booking:204','duplicate-payment:204')")}
INC = ISS["booking:204"]

# ---------------------------------------------------------------------------
print("\n== Admins cannot bypass approval through Ticket Reconciliation")
st, r = call("POST", "/events/%d/reconcile/issues/%d/action" % (EV, INC),
             {"action": "issue_seat", "first_name": "Guest of", "last_name": "Jessica", "note": "4 paid, 3 exist", "confirm": True,
              "confirm_real_seat": True}, A1)
check(st == 409 and "second admin" in str(r), "Admin 1: 'Issue missing seat' in Ticket Reconciliation is held for approval", (st, r))
P1 = pid_of(r)
check(P1 and db.execute(SEATS).fetchone()[0] == 2, "...nothing created yet (still 3 tickets)")
st, r2 = call("POST", "/events/%d/reconcile/issues/%d/action" % (EV, INC),
              {"action": "issue_seat", "first_name": "Guest of", "last_name": "Jessica", "note": "4 paid, 3 exist", "confirm": True,
               "confirm_real_seat": True}, A1)
check(st == 409 and pid_of(r2) == P1 and "already waiting" in str(r2), "Clicking again does not file a second proposal", r2)
st, r = call("POST", "/events/%d/attendees/204/add-seat" % EV, {"first_name": "Back", "last_name": "Door", "reason": "x"}, A1)
check(st == 409 and pid_of(r), "Admin 1: the door 'add seat' endpoint is held for approval too", (st, r))
P_ADD = pid_of(r)
check(db.execute(SEATS).fetchone()[0] == 2, "...still 3 tickets")
check(decide(P1, A1)[0] == 403, "Admin 1 cannot approve own proposal")
check(decide(P1, TEM)[0] == 403, "Ticket Email Manager cannot approve")
check(decide(P1, ORG)[0] == 403, "An organiser who is not a platform admin cannot approve")
st, r = call("POST", "/events/%d/reconcile/issues/%d/status" % (EV, ISS["duplicate-payment:204"]),
             {"status": "reviewed", "note": "real seat", "real_seat": True}, A1)
check(st == 409 and pid_of(r), "Admin 1: payment decision (real seat) is held for approval", (st, r))
P_DUP = pid_of(r)
check(json.loads(db.execute("select facts from recon_issues where id=?", (ISS["duplicate-payment:204"],)).fetchone()[0] or "{}").get("decision") is None,
      "...the decision was not recorded yet")

# ---------------------------------------------------------------------------
print("\n== Ticket Email Manager cannot bypass")
for path, body in (("/events/%d/attendees/204/add-seat" % EV, {"first_name": "x"}),
                   ("/attendees/204/change-pass", {"ticket_type_id": 1, "reason": "x"}),
                   ("/attendees/204/transfer", {"email": "x@example.invalid", "first_name": "x", "reason": "x"}),
                   ("/attendees/204/revoke", {"reason": "x"}),
                   ("/events/%d/reconcile/issues/%d/action" % (EV, INC), {"action": "issue_seat", "first_name": "x", "note": "xxx", "confirm": True})):
    st, r = call("POST", path, body, TEM)
    check(st == 403, "TEM refused: %s" % path, (st, r))
st, r = call("PUT", "/attendees/204", {"email": "x@example.invalid"}, TEM)
check(st == 403, "TEM refused: edit a ticket's email", st)
st, r = call("POST", E + "/issues/%d/fix" % INC, {"action": "issue_seat", "body": {"first_name": "x"}, "note": "trying", "confirm": True}, TEM)
check(st == 403, "TEM refused: create ticket as a direct fix", st)

# ---------------------------------------------------------------------------
print("\n== Other back-office pages: held for approval, nothing changed")
T = db.execute("select id, ticket_type_id, email, registration_status from attendees where event_id=1 and registration_source='ghl_order' "
               "and registration_status in ('registered','active') and id not in (204,724,725) order by id limit 1").fetchone()
TT_OTHER = db.execute("select id from ticket_types where event_id=1 and id!=? order by id limit 1", (T[1],)).fetchone()[0]
for label, method, path, body in (
        ("change pass", "POST", "/attendees/%d/change-pass" % T[0], {"ticket_type_id": TT_OTHER, "reason": "comp upgrade", "complimentary": True}),
        ("transfer", "POST", "/attendees/%d/transfer" % T[0], {"email": "zz-new-%s@example.invalid" % TAG, "first_name": "Zz", "last_name": "New", "reason": "gift"}),
        ("void", "POST", "/attendees/%d/revoke" % T[0], {"reason": "duplicate"}),
        ("edit email", "PUT", "/attendees/%d" % T[0], {"email": "zz-other-%s@example.invalid" % TAG}),
        ("edit pass", "PUT", "/attendees/%d" % T[0], {"ticket_type_id": TT_OTHER}),
        ("ticket email at desk", "POST", "/events/%d/attendees/%d/door-identity" % (EV, T[0]), {"email": "zz-desk-%s@example.invalid" % TAG, "reason": "typo"})):
    st, r = call(method, path, body, A1)
    check(st == 409 and pid_of(r), "Admin: %s is held for approval" % label, (st, r))
row = db.execute("select ticket_type_id, email, registration_status from attendees where id=?", (T[0],)).fetchone()
check(row == T[1:], "The ticket is unchanged", (row, T[1:]))
st, r = call("PUT", "/attendees/%d" % T[0], {"company": "Zz Co"}, A1)
check(st == 200, "A harmless edit (company) still saves directly", st)
st, r = call("POST", "/attendees/%d/change-pass" % T[0], {"ticket_type_id": TT_OTHER, "reason": "x"}, ORG)
check(st == 409, "Organiser (not admin): also held", st)

# ---------------------------------------------------------------------------
print("\n== Door-desk operations by door staff stay direct (bounded)")
B = db.execute("insert into attendees(event_id,email,first_name,last_name,qr_code,public_token,is_checked_in,registration_status,registration_source,"
               "attendance_type,ticket_type_id,custom_data,created_at) values(?,?,?,?,?,?,0,'registered','ghl_order','paid',?,?,?)",
               (EV, "zz-party-%s@example.invalid" % TAG, "Zz", "Party", "ATT-" + secrets.token_hex(6).upper(), secrets.token_hex(4).upper(),
                T[1], json.dumps({"entitlements": [{"status": "paid", "quantity": 2, "ticket_type_id": T[1], "order_id": "ZZQ" + TAG}]}), now)).lastrowid
db.commit()
st, r = call("POST", "/events/%d/attendees/%d/add-seat" % (EV, B), {"first_name": "Zz", "last_name": "Guest", "reason": "at the desk"}, DOOR)
check(st == 200, "Door staff names a paid seat at the desk", (st, r))
st, r = call("POST", "/events/%d/attendees/%d/add-seat" % (EV, B), {"first_name": "Zz", "last_name": "Extra", "reason": "at the desk"}, DOOR)
check(st == 409 and "already has all" in str(r), "...but never more than were paid for", (st, r))

# ---------------------------------------------------------------------------
print("\n== #204 through approval: verified, applied once, payment linked once")
# Admin 2 approves the payment decision, then the seat (proposed by admin 1).
st, r = decide(P_DUP, A2)
check(st == 200 and r["state"] in ("applied", "applied_still_flagged"), "Admin 2 approves the payment decision", r)
res = []
def go(h):
    res.append(decide(P1, h))
ts = [threading.Thread(target=go, args=(h,)) for h in (A2, A2, A2)]
[t.start() for t in ts]; [t.join() for t in ts]
oks = [x for x in res if x[0] == 200]
check(len(oks) == 1, "Three simultaneous approvals: applied exactly once", [x[0] for x in res])
check(db.execute(SEATS).fetchone()[0] == 3, "Exactly 4 tickets now (buyer + 3 seats)")
st, r = decide(P_ADD, A2)
check(st == 200 and r["state"] == "failed" and db.execute(SEATS).fetchone()[0] == 3,
      "The second (door) proposal for the same seat creates nothing: booking already complete", r.get("results"))
new = db.execute("select id, qr_code, public_token from attendees where json_extract(custom_data,'$.bought_by_attendee')=204 and id not in (724,725)").fetchone()
check(new and new[1].startswith("ATT-") and new[2], "New ticket has its own QR code and badge", new)
allq = [r[0] for r in db.execute("select qr_code from attendees where event_id=1")]
check(len(allq) == len(set(allq)), "No QR code shared in the event")
q1 = qrs()
check(all(q1.get(k) == v for k, v in QR0.items()), "Every existing ticket keeps its QR code and badge")
check(money() == MONEY0, "Payment totals unchanged: no payment created, no amount or refund changed", (MONEY0, money()))
moved = {k: (LINKS0.get(k), v) for k, v in links().items() if LINKS0.get(k) != v}
check(len(moved) == 1 and list(moved.values())[0] == (204, new[0]),
      "One payment association moved, once: the 4th seat's own payment, from the buyer's ticket to the new ticket", moved)

# Release the hold that waited for the seat: held for approval from Reconciliation too.
st, r = call("POST", "/events/%d/reconcile/issues/%d/action" % (EV, INC), {"action": "release", "ticket_ids": [204], "note": "booking complete",
                                                                         "confirm": True}, A1)
check(st == 409 and pid_of(r), "Releasing the protective hold from Reconciliation is held for approval", (st, r))
st, r = decide(pid_of(r), A2)
check(st == 200 and r["state"] == "applied", "Admin 2 approves; the re-check clears the booking problem", r.get("validation", {}).get("issues"))
st, b = call("GET", E + "/bookings/B204", headers=TEM)
check(b["paid_for"] == 4 and b["tickets_generated"] == 4 and not b["critical"] and b["can_approve"],
      "Email Center: 4 of 4, no blockers, ready for review", b["critical"])

# Persistence: rebuild of the sending list, reconciliation reruns, a fresh server.
call("POST", "/events/%d/reconcile/run" % EV, {}, A1)
st, b2 = call("GET", E + "/bookings/B204", headers=TEM)
check(not b2["critical"] and b2["tickets_generated"] == 4, "Still fixed after a reconciliation run")
st, pv = call("POST", E + "/batches/preview", {"keys": ["B204"]}, A1)
check(st == 200 and not any(x["key"] == "B204" and "blocked" in x["reason"] for x in pv["excluded"]),
      "The sending list rebuild sees #204 as clean (only 'not approved' keeps it out)", pv.get("excluded"))
st, b3 = call("GET", E + "/bookings/B204/problems", headers=TEM)
check(all(not p["detected"] for p in b3["problems"] if p["kind"] in ("incomplete_booking",)), "The case is closed by the check, not hidden")

# ---------------------------------------------------------------------------
print("\n== Audit history")
props = call("GET", E + "/proposals?state=all", headers=A1)[1]["items"]
mine = [p for p in props if p["id"] in (P1, P_DUP, P_ADD)]
check(all(p["proposed_by"] and p["proposed_at"] for p in mine), "Every proposal records who proposed it and when")
ap = [p for p in mine if p["state"] in ("applied", "applied_still_flagged")]
check(ap and all(p["decided_by"] and p["decided_at"] and p["applied_at"] and p["validation"] for p in ap),
      "Applied ones record who approved, when applied, and the re-check result")
hist = [r[0] for r in db.execute("select text from recon_history where issue_id=? order by id", (INC,))]
check(any("Held for a second admin" in h for h in hist) and any("issue seat" in h for h in hist) and any("Correction #" in h for h in hist),
      "The case history shows: held, the seat action, and the approved correction", hist[-6:])
check(db.execute("select count(*) from recon_history where issue_id=?", (INC,)).fetchone()[0] >= 5, "History is kept, not overwritten")

print("\n== Nothing emailed")
check(not os.path.exists(OUTBOX), "No email was sent by any correction")

print("\n%d failure(s)" % len(fails))
for f in fails:
    print("   - " + f)
shutil.rmtree(WORK, ignore_errors=True)
sys.exit(1 if fails else 0)
