"""BIO-WELL STATION — 10 Nov 2026.

On a throwaway copy of the live database with SYNTHETIC people, a simulated
CRM and mailbox (BIOWELL_FAKE) and a temporary consent-link store. No real
person, contact, email or reading is touched.

A existing correct email · B email correction · C guest ticket · D several
tickets, one email · E two people behind one purchaser contact · F no email ·
G link status (several readings live with the partner) · H wrong/expired/
reused codes · I duplicate station submit · J link store unavailable ·
K unauthorised staff · L no results ever exposed · M email changed after a
link · N several sessions for one person. Plus: ticket, buyer and payments
never change; check-in and the existing activation keep working.
Run:  /root/event-biowell-wt/stage-run.sh python3 test_biowell_station.py
"""
import json, os, secrets, shutil, sqlite3, sys, tempfile, threading, urllib.error, urllib.request
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
WORK = tempfile.mkdtemp(prefix="biowell-")
LINKS = os.path.join(WORK, "member-links.json")
json.dump({"codes": {}, "links": {}, "audit": []}, open(LINKS, "w"))
FAKE = WORK
json.dump({"existing": {}, "dnd": ["zz-dnd@example.invalid"], "several": ["zz-several@example.invalid"]}, open(os.path.join(WORK, "fake.json"), "w"))
os.environ.update(BIOWELL_FAKE=FAKE, BIOWELL_LINK_FILE=LINKS, BIOWELL_CREATE_CONTACTS="1", TESTBED_RAW_APPROVALS="1")

import testbed                                                # noqa: E402
BASE, DB = testbed.start()
import main                                                   # noqa: E402

env = {}
for line in open(os.path.join(HERE, ".env")):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
SVC = {"Authorization": "Bearer " + env["IDENTITY_SERVICE_TOKEN"]}

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try:
            return e.code, json.loads(b or "null")
        except Exception:
            return e.code, b

def outbox():
    try:
        return [json.loads(x) for x in open(os.path.join(WORK, "outbox.jsonl"))]
    except OSError:
        return []

def last_code(to):
    c = [x for x in outbox() if x.get("kind") == "code_email" and x.get("to") == to]
    return c[-1]["code"] if c else None

def fake(**kw):
    cfg = json.load(open(os.path.join(WORK, "fake.json")))
    cfg.update(kw)
    json.dump(cfg, open(os.path.join(WORK, "fake.json"), "w"))

db = sqlite3.connect(DB, timeout=60)
now = datetime.utcnow().isoformat(" ")
EV, TAG = 1, secrets.token_hex(3)
B = "/events/%d/biowell" % EV
GA = db.execute("select id from ticket_types where event_id=? order by id limit 1", (EV,)).fetchone()[0]

def user(label, role=None, admin=0):
    cur = db.execute("insert into users(email,hashed_password,full_name,is_admin,created_at) values(?,?,?,?,?)",
                     ("zz-%s-%s@example.invalid" % (label, TAG), "x", "ZZ " + label, admin, now))
    if role:
        db.execute("insert into event_roles(user_id,event_id,role,created_at) values(?,?,?,?)", (cur.lastrowid, EV, role, now))
    db.commit()
    return {"Authorization": "Bearer " + main.create_access_token({"sub": str(cur.lastrowid)})}

STA = user("station", "biowell_station")
ORG = user("org", "organizer")
DOOR = user("door", "checkin_staff")
TEM = user("tem", "ticket_email_manager")

def ticket(first, last, email, contact=None, cd=None, source="ghl_order"):
    qr = "ATT-" + secrets.token_hex(6).upper()
    badge = "".join(secrets.choice("ABCDEFGHJKMNPQRSTUVWXYZ23456789") for _ in range(8))
    c = dict(cd or {})
    if contact:
        c["contact_id"] = contact
    r = db.execute("insert into attendees(event_id,email,first_name,last_name,qr_code,public_token,is_checked_in,registration_status,registration_source,"
                   "attendance_type,ticket_type_id,custom_data,acq_contact_id,created_at) values(?,?,?,?,?,?,0,'registered',?,'paid',?,?,?,?)",
                   (EV, email, first, last + TAG, qr, badge, source, GA, json.dumps(c), contact, now))
    db.commit()
    return {"id": r.lastrowid, "qr": qr, "badge": badge, "email": email}

def snapshot(ids):
    """Everything about the ticket except its history (where the visit is logged)."""
    out = []
    for r in db.execute("select id,email,first_name,last_name,qr_code,public_token,ticket_type_id,registration_status,custom_data "
                        "from attendees where id in (%s) order by id" % ",".join(map(str, ids))):
        cd = json.loads(r[8] or "{}")
        cd.pop("lifecycle", None)
        out.append(tuple(r[:8]) + (json.dumps(cd, sort_keys=True),))
    return out
PAY0 = db.execute("select count(*), sum(amount) from payment_events").fetchone()

def start(t, who=STA, key=None):
    return call("POST", B + "/sessions", {"ticket_id": t["id"], "station": "Booth 21", "client_key": key or secrets.token_hex(8)}, who)

def card_of(t):
    return db.execute("select id,email,contact_id from member_cards where public_token=?", (t["badge"],)).fetchone()

# ---------------------------------------------------------------------------
print("\n== A. existing, correct email")
A = ticket("Zz", "Alpha", "zz-alpha-%s@example.invalid" % TAG, contact="zz-c-alpha-" + TAG)
st, p = call("POST", B + "/lookup", {"code": A["qr"]}, STA)
check(st == 200 and p["profile_email_usable"] and not p["is_guest"] and p["profile_email"] == A["email"], "Ticket QR finds the person; their email is usable", p)
st, p2 = call("POST", B + "/lookup", {"code": "https://card.gaiahealers.app/" + A["badge"]}, STA)
check(st == 200 and p2["ticket_id"] == A["id"], "The badge QR finds the same person")
st, s = start(A)
check(st == 200 and s["email_status"] == "ok" and s["next_step"].startswith("Let them scan"), "Session: email ok, next step = activate on their phone", s.get("next_step"))
check(call("POST", B + "/lookup", {"code": "ATT-ABCDEF123456"}, STA)[0] == 404, "Unknown code: 404")
check(call("POST", B + "/lookup", {"code": "hello"}, STA)[0] == 400, "Not a code: 400")

# ---------------------------------------------------------------------------
print("\n== B. email correction (verified by a code)")
Bt = ticket("Zz", "Bravo", "zz-typo-%s@exmaple.invalid" % TAG, contact="zz-c-bravo-" + TAG)
snapB = snapshot([Bt["id"]])
st, s = start(Bt)
SB = s["session_id"]
check(call("POST", B + "/sessions/%s/email" % SB, {"email": "not an email"}, STA)[0] == 400, "Invalid email refused")
newB = "zz-bravo-%s@example.invalid" % TAG
fake(existing={newB: "zz-c-bravo-real-" + TAG})
st, s = call("POST", B + "/sessions/%s/email" % SB, {"email": "  " + newB.upper() + " "}, STA)
check(st == 200 and s["email_status"] == "pending" and s["person"]["pending_email"]["email"] == newB, "Normalised, saved as PENDING, code emailed", s)
check(card_of(Bt)[1] == Bt["email"], "Nothing changed yet: the profile still has the old email")
check(call("POST", B + "/sessions/%s/verify" % SB, {"code": "000000"}, STA)[0] == 400, "Wrong code refused")
code = last_code(newB)
st, s = call("POST", B + "/sessions/%s/verify" % SB, {"code": code}, STA)
check(st == 200 and s["email_status"] == "verified", "Right code: confirmed", s)
cB = card_of(Bt)
check(cB[1] == newB and cB[2] == "zz-c-bravo-real-" + TAG, "Profile now uses the new email and its own CRM contact", cB)
check(snapshot([Bt["id"]]) == snapB, "The ticket itself is unchanged (email, holder, pass, QR, buyer)")
check(call("POST", B + "/sessions/%s/verify" % SB, {"code": code}, STA)[0] == 409, "H: the same code cannot be used twice")
lc = json.loads(db.execute("select custom_data from attendees where id=?", (Bt["id"],)).fetchone()[0]).get("lifecycle", [])
check(any(e.get("action") == "profile_email_verified" for e in lc) and any(e.get("action") == "profile_email_requested" for e in lc),
      "Audit: request and confirmation recorded on the ticket history")

# ---------------------------------------------------------------------------
print("\n== C. guest ticket bought by someone else (verified through activation)")
BUY = ticket("Zz", "Buyer", "zz-buyer-%s@example.invalid" % TAG, contact="zz-c-buyer-" + TAG)
G = ticket("Zz", "Guest", "zz-buyer-%s+seat2@example.invalid" % TAG, cd={"bought_by_attendee": BUY["id"], "seat_of_party": "2 of 2"},
           source="rebuilt_seat")
snapG = snapshot([G["id"], BUY["id"]])
st, p = call("POST", B + "/lookup", {"code": G["qr"]}, STA)
check(p["is_guest"] and p["guest_of"].startswith("Zz Buyer") and not p["profile_email_usable"] and "Guest" in (p["email_problem"] or ""),
      "Guest: shown as guest of the buyer; the buyer's address is not usable", p)
st, s = start(G)
SG = s["session_id"]
check(call("POST", B + "/sessions/%s/email" % SG, {"email": "zz-buyer-%s+seat9@example.invalid" % TAG}, STA)[0] == 400, "A +seat alias is refused")
check(call("POST", B + "/sessions/%s/email" % SG, {"email": BUY["email"]}, STA)[0] in (200, 409), "(buyer's address checked)")
cbuy = card_of(BUY)
newG = "zz-guest-own-%s@example.invalid" % TAG
st, s = call("POST", B + "/sessions/%s/email" % SG, {"email": newG}, STA)
check(st == 200 and s["email_status"] == "pending", "Guest's own email: pending; a CRM contact is created for it (allowed on this server)", s)
check(any(x.get("kind") == "contact_created" and x.get("email") == newG for x in outbox()), "Contact created for the guest's own address")
# The guest confirms on their own phone, through the EXISTING activation.
st, a = call("POST", "/identity/activate/start", {"token": G["badge"], "send_code": True}, SVC)
check(a.get("ok") and a.get("deliver_to", {}).get("email") == newG and a.get("code") and not a.get("desk_only"),
      "Activation sends the code to the guest's pending own email (never to the buyer)", {k: a.get(k) for k in ("ok", "desk_only", "deliver_to")})
st, v = call("POST", "/identity/activate/verify", {"token": G["badge"], "code": a.get("code")}, SVC)
check(v.get("ok") and v.get("permit"), "Entering it on the phone verifies the email", v)
st, c = call("POST", "/identity/activate/complete", {"token": G["badge"], "permit": v.get("permit"), "password": "guest pass 1"}, SVC)
ident = c.get("identity", {})
check(c.get("ok") and ident.get("email") == newG and ident.get("contact_id", "").startswith("fake-new-"),
      "Guest's profile is now their own: own email, own contact (results can be linked to THEM)", ident)
check(snapshot([G["id"], BUY["id"]]) == snapG, "Guest and buyer tickets unchanged; purchase untouched")
check(card_of(BUY) == cbuy, "The buyer's profile is unchanged")

# ---------------------------------------------------------------------------
print("\n== D. several tickets, one email")
D1 = ticket("Zz", "Delta", "zz-delta-%s@example.invalid" % TAG, contact="zz-c-delta-" + TAG)
D2 = ticket("Zz", "Delta", "zz-delta-%s@example.invalid" % TAG, contact="zz-c-delta-" + TAG)
st, p1 = call("POST", B + "/lookup", {"code": D1["qr"]}, STA)
st, p2 = call("POST", B + "/lookup", {"code": D2["qr"]}, STA)
check(p1["profile_url"] == p2["profile_url"] or (p1["profile_email"] == p2["profile_email"] and p1["profile_email_usable"]),
      "One person with two tickets is one profile with one email", (p1["profile_url"], p2["profile_url"]))

# ---------------------------------------------------------------------------
print("\n== E. two people behind one purchaser contact")
shared = "zz-c-house-" + TAG
E1 = ticket("Zz", "Echo", "zz-echo1-%s@example.invalid" % TAG, contact=shared)
E2 = ticket("Zz", "Echotwo", "zz-echo2-%s@example.invalid" % TAG, contact=shared)
st, p = call("POST", B + "/lookup", {"code": E2["qr"]}, STA)
check(p["shared_contact"] and not p["profile_email_usable"], "Shared contact detected: not usable for results as is", p)
st, s = start(E2)
st, r = call("POST", B + "/sessions/%s/email" % s["session_id"], {"email": E1["email"]}, STA)
check(st == 409 and "another person" in str(r), "Entering the other person's email is refused (no merging)", (st, r))
newE = "zz-echo2-own-%s@example.invalid" % TAG
st, s = call("POST", B + "/sessions/%s/email" % s["session_id"], {"email": newE}, STA)
st, s = call("POST", B + "/sessions/%s/verify" % s["session_id"], {"code": last_code(newE)}, STA)
call("POST", B + "/lookup", {"code": E1["qr"]}, STA)
check(st == 200 and card_of(E2)[2] != shared and card_of(E1)[2] == shared, "Second person gets their own contact; the first keeps theirs")

# ---------------------------------------------------------------------------
print("\n== F. no email")
F = ticket("Zz", "Foxtrot", "", contact=None)
st, p = call("POST", B + "/lookup", {"code": F["qr"]}, STA)
check(st == 200 and not p["profile_email_usable"] and "No email" in (p["email_problem"] or ""), "No email: asked for one", p)
st, s = start(F)
newF = "zz-fox-%s@example.invalid" % TAG
st, s = call("POST", B + "/sessions/%s/email" % s["session_id"], {"email": newF}, STA)
st, s = call("POST", B + "/sessions/%s/verify" % s["session_id"], {"code": last_code(newF)}, STA)
check(st == 200 and card_of(F)[1] == newF, "Email added and confirmed")
check(db.execute("select email from attendees where id=?", (F["id"],)).fetchone()[0] == "", "...on the profile only, the ticket is unchanged")

# ---------------------------------------------------------------------------
print("\n== G/M. link status, and an email changed after a link")
cA = card_of(A)
links = json.load(open(LINKS))
links["links"][cA[2]] = {"status": "confirmed", "customer_id": "cust-zz", "practitioner_id": "p-zz", "linked_at": now}
json.dump(links, open(LINKS, "w"))
st, p = call("POST", B + "/lookup", {"code": A["qr"]}, STA)
check(p["results_link"] == "linked", "A linked person shows 'linked' (readings and history stay with the partner)")
check(not any(k in json.dumps(p) for k in ("cust-zz", "p-zz", "practitioner", "customer")), "L: no customer, practitioner or reading data in the station view")
st, s = start(A)
newA = "zz-alpha-new-%s@example.invalid" % TAG
st, s = call("POST", B + "/sessions/%s/email" % s["session_id"], {"email": newA}, STA)
st, s = call("POST", B + "/sessions/%s/verify" % s["session_id"], {"code": last_code(newA)}, STA)
check(s["person"]["results_link"] == "not_linked", "M: after the email change the old link does NOT follow (they link again with a new code)", s["person"]["results_link"])

# ---------------------------------------------------------------------------
print("\n== H. codes: expired, too many, reused")
Ht = ticket("Zz", "Hotel", "zz-hotel-%s@example.invalid" % TAG, contact="zz-c-hotel-" + TAG)
st, s = start(Ht)
newH = "zz-hotel-new-%s@example.invalid" % TAG
call("POST", B + "/sessions/%s/email" % s["session_id"], {"email": newH}, STA)
cid = card_of(Ht)[0]
db.execute("update card_verifications set expires_at=? where card_id=? and purpose='station_email' and consumed_at is null",
           ((datetime.utcnow() - timedelta(minutes=1)).isoformat(" "), cid)); db.commit()
st, r = call("POST", B + "/sessions/%s/verify" % s["session_id"], {"code": last_code(newH)}, STA)
check(st == 400 and "expired" in str(r), "Expired code refused", r)
st, r = call("POST", B + "/sessions/%s/resend" % s["session_id"], {}, STA)
check(st == 200, "Send the code again")
for _ in range(5):
    call("POST", B + "/sessions/%s/verify" % s["session_id"], {"code": "111111"}, STA)
st, r = call("POST", B + "/sessions/%s/verify" % s["session_id"], {"code": last_code(newH)}, STA)
check(st == 400 and "Too many" in str(r), "After 5 wrong tries even the right code is refused", r)

# ---------------------------------------------------------------------------
print("\n== H2. code security: limits, other people's codes, other purposes")
X = ticket("Zz", "Xray", "zz-xray-%s@example.invalid" % TAG, contact="zz-c-xray-" + TAG)
Y = ticket("Zz", "Yankee", "zz-yankee-%s@example.invalid" % TAG, contact="zz-c-yankee-" + TAG)
st, sx = start(X); st, sy = start(Y)
newX, newY = "zz-xray-new-%s@example.invalid" % TAG, "zz-yankee-new-%s@example.invalid" % TAG
call("POST", B + "/sessions/%s/email" % sx["session_id"], {"email": newX}, STA)
call("POST", B + "/sessions/%s/email" % sy["session_id"], {"email": newY}, STA)
codeX = last_code(newX)
st, r = call("POST", B + "/sessions/%s/verify" % sy["session_id"], {"code": codeX}, STA)
check(st == 400 and card_of(Y)[1] == Y["email"], "X's code cannot confirm Y's email", (st, r))
st, a = call("POST", "/identity/activate/verify", {"token": Y["badge"], "code": codeX}, SVC)
check(not a.get("ok"), "X's station code cannot open Y's account", a)
st, a = call("POST", "/identity/activate/verify", {"token": X["badge"], "code": codeX}, SVC)
check(not a.get("ok"), "A station code is not an activation code (cannot sign anyone in)", a)
st, r = call("POST", B + "/sessions/%s/verify" % sx["session_id"], {"code": codeX}, STA)
check(st == 200 and card_of(X)[1] == newX, "...and it still confirms X's own email at the station")
for i in range(6):
    st, r = call("POST", B + "/sessions/%s/resend" % sy["session_id"], {}, STA)
check(st == 429, "At most 5 codes per hour per person", (st, r))
st, p = call("POST", B + "/lookup", {"code": X["qr"]}, STA)
check(p["results_available"] is False, "Results sharing reported as NOT open (partner not in production)")
st, s = call("GET", B + "/sessions/%s" % sx["session_id"], headers=STA)
check("Get my code" not in s["next_step"] and "practitioner" not in s["next_step"].lower().replace("practitioner connection", ""),
      "Station never asks for a results code while sharing is not open", s["next_step"])

# ---------------------------------------------------------------------------
print("\n== GHL contacts: several guests, existing contacts, retries, failures")
BUY2 = ticket("Zz", "Buyertwo", "zz-buyer2-%s@example.invalid" % TAG, contact="zz-c-buyer2-" + TAG)
G1 = ticket("Zz", "Guestone", "zz-buyer2-%s+seat2@example.invalid" % TAG, cd={"bought_by_attendee": BUY2["id"], "seat_of_party": "2 of 3"}, source="rebuilt_seat")
G2 = ticket("Zz", "Guesttwo", "zz-buyer2-%s+seat3@example.invalid" % TAG, cd={"bought_by_attendee": BUY2["id"], "seat_of_party": "3 of 3"}, source="rebuilt_seat")
call("POST", B + "/lookup", {"code": BUY2["qr"]}, STA)
cb2 = card_of(BUY2)
created0 = len([x for x in outbox() if x.get("kind") == "contact_created"])
for g, em in ((G1, "zz-g1-own-%s@example.invalid" % TAG), (G2, "zz-g2-own-%s@example.invalid" % TAG)):
    st, sg = start(g)
    st, r = call("POST", B + "/sessions/%s/email" % sg["session_id"], {"email": em}, STA)
    st, r = call("POST", B + "/sessions/%s/verify" % sg["session_id"], {"code": last_code(em)}, STA)
c1, c2 = card_of(G1), card_of(G2)
check(c1[2] and c2[2] and c1[2] != c2[2] and cb2[2] not in (c1[2], c2[2]), "D: two guests of one buyer get two separate own contacts", (c1, c2))
check(card_of(BUY2) == cb2, "D: the buyer's profile and contact are unchanged")
check(len([x for x in outbox() if x.get("kind") == "contact_created"]) - created0 == 2, "D: exactly one contact created per guest")
# E: the new address already has a GHL contact.
E3 = ticket("Zz", "Existing", "zz-e3-%s@example.invalid" % TAG, contact="zz-c-e3-" + TAG)
mine = "zz-e3-other-%s@example.invalid" % TAG
fake(existing={mine: "zz-c-e3-other-" + TAG})
st, s3 = start(E3)
n0 = len([x for x in outbox() if x.get("kind") == "contact_created"])
st, r = call("POST", B + "/sessions/%s/email" % s3["session_id"], {"email": mine}, STA)
st, r = call("POST", B + "/sessions/%s/verify" % s3["session_id"], {"code": last_code(mine)}, STA)
check(card_of(E3)[2] == "zz-c-e3-other-" + TAG and len([x for x in outbox() if x.get("kind") == "contact_created"]) == n0,
      "E: an existing contact for the person's own email is linked as is; nothing created", card_of(E3))
taken = ticket("Zz", "Taken", "zz-taken-%s@example.invalid" % TAG, contact="zz-c-taken-" + TAG)
call("POST", B + "/lookup", {"code": taken["qr"]}, STA)
other_addr = "zz-taken-alt-%s@example.invalid" % TAG
fake(existing={other_addr: "zz-c-taken-" + TAG})
E4 = ticket("Zz", "Fourth", "zz-e4-%s@example.invalid" % TAG, contact="zz-c-e4-" + TAG)
st, s4 = start(E4)
st, r = call("POST", B + "/sessions/%s/email" % s4["session_id"], {"email": other_addr}, STA)
check(st == 409 and "belongs to another person" in str(r), "E: an email whose contact belongs to another profile is refused (no merge)", (st, r))
# F: retries never create a second contact.
F2 = ticket("Zz", "Retry", "zz-f2-%s@example.invalid" % TAG, contact="zz-c-f2-" + TAG)
st, sf = start(F2)
newF2 = "zz-f2-new-%s@example.invalid" % TAG
n0 = len([x for x in outbox() if x.get("kind") == "contact_created"])
call("POST", B + "/sessions/%s/email" % sf["session_id"], {"email": newF2}, STA)
call("POST", B + "/sessions/%s/resend" % sf["session_id"], {}, STA)
call("POST", B + "/sessions/%s/resend" % sf["session_id"], {}, STA)
check(len([x for x in outbox() if x.get("kind") == "contact_created"]) - n0 == 1, "F: send + 2 resends = one contact created")
# G: GHL failures save nothing.
G3 = ticket("Zz", "Gfail", "zz-g3-%s@example.invalid" % TAG, contact="zz-c-g3-" + TAG)
st, sg3 = start(G3)
fake(existing={}, lookup_error=["zz-g3-new-%s@example.invalid" % TAG], create_fail=["zz-g3-new2-%s@example.invalid" % TAG])
st, r = call("POST", B + "/sessions/%s/email" % sg3["session_id"], {"email": "zz-g3-new-%s@example.invalid" % TAG}, STA)
check(st == 503, "G: GHL unreachable -> 'try again', nothing saved", (st, r))
st, r = call("POST", B + "/sessions/%s/email" % sg3["session_id"], {"email": "zz-g3-new2-%s@example.invalid" % TAG}, STA)
check(st == 409 and db.execute("select count(*) from card_email_requests where attendee_id=?", (G3["id"],)).fetchone()[0] == 0,
      "G: contact creation failure -> refused, nothing saved", (st, r))
fake(lookup_error=[], create_fail=[])

# ---------------------------------------------------------------------------
print("\n== I/N. duplicate submits; several sessions")
key = secrets.token_hex(8)
res = []
def go():
    res.append(start(A, key=key))
ts = [threading.Thread(target=go) for _ in range(5)]
[t.start() for t in ts]; [t.join() for t in ts]
ids = {r[1]["session_id"] for r in res if r[0] == 200}
check(len(ids) == 1, "5 simultaneous submits of one tap: one session", ids)
st, s2 = start(A)
st, p = call("POST", B + "/lookup", {"code": A["qr"]}, STA)
check(len(p["recent_sessions"]) >= 3, "N: several sessions for one person are kept", p["recent_sessions"])

# ---------------------------------------------------------------------------
print("\n== other refusals")
Rt = ticket("Zz", "Romeo", "zz-romeo-%s@example.invalid" % TAG, contact="zz-c-romeo-" + TAG)
st, s = start(Rt)
check(call("POST", B + "/sessions/%s/email" % s["session_id"], {"email": "zz-dnd@example.invalid"}, STA)[0] == 409, "Do-not-email address refused")
check(call("POST", B + "/sessions/%s/email" % s["session_id"], {"email": "zz-several@example.invalid"}, STA)[0] == 409, "Address with several CRM contacts refused")
os.environ["BIOWELL_CREATE_CONTACTS"] = "0"   # (server keeps its own env; checked via a fresh call below)
db.execute("update attendees set registration_status='refunded' where id=?", (Rt["id"],)); db.commit()
check(start(Rt)[0] == 409, "A refunded ticket cannot start a session")

# ---------------------------------------------------------------------------
print("\n== J. link store unavailable")
os.rename(LINKS, LINKS + ".away")
st, p = call("POST", B + "/lookup", {"code": A["qr"]}, STA)
check(st == 200 and p["link_store_unavailable"], "The station still works and says link status is unavailable")
os.rename(LINKS + ".away", LINKS)

# ---------------------------------------------------------------------------
print("\n== K. permissions")
check(call("POST", B + "/lookup", {"code": A["qr"]}, DOOR)[0] == 403, "Door staff cannot use the station")
check(call("POST", B + "/lookup", {"code": A["qr"]}, TEM)[0] == 403, "Ticket Email Manager cannot use the station")
check(call("POST", B + "/lookup", {"code": A["qr"]})[0] == 401, "Not signed in: 401")
check(call("GET", B + "/overview", headers=STA)[0] == 403, "Station staff cannot open the dashboard")
for m, path, body in (("GET", "/events/%d/attendees" % EV, None), ("GET", "/events/%d/attendees/search?q=zz" % EV, None),
                      ("PUT", "/attendees/%d" % A["id"], {"email": "x@example.invalid"}), ("GET", "/events/%d/payments" % EV, None),
                      ("GET", "/events/%d/reconcile/issues" % EV, None), ("GET", "/events/%d/email-center/overview" % EV, None),
                      ("POST", "/events/%d/attendees/%d/add-seat" % (EV, A["id"]), {"first_name": "x"}),
                      ("POST", "/attendees/%d/change-pass" % A["id"], {"ticket_type_id": GA, "reason": "x"})):
    st, _ = call(m, path, body, STA)
    check(st == 403, "Station staff refused: %s %s" % (m, path.split("?")[0]), st)
st, caps = call("GET", "/events/%d/my-capabilities" % EV, headers=STA)
check(sorted(caps["capabilities"]) == ["biowell.station", "event.read"], "Station role = event.read + biowell.station only", caps.get("capabilities"))
check(call("GET", "/api/practitioners/my-readings", headers=STA)[0] in (401, 404), "No readings route in the Event Manager at all")

# ---------------------------------------------------------------------------
print("\n== dashboard")
st, ov = call("GET", B + "/overview", headers=ORG)
check(st == 200 and ov["station"]["sessions"] >= 10 and ov["email"]["verified"] >= 4 and ov["people_processed"]["results_linked"] == 0,
      "Overview counts from real records (A's old link no longer counts after M)", ov.get("email"))
check(ov["partner"]["environment"] in ("staging", "production", "unknown") and "note" in ov, "Partner environment shown; no scan count claimed")
st, ls = call("GET", B + "/sessions?filter=problems", headers=ORG)
check(st == 200 and ls["count"] >= 1, "Sessions needing attention listed")

# ---------------------------------------------------------------------------
print("\n== nothing else changed")
check(db.execute("select count(*), sum(amount) from payment_events").fetchone() == PAY0, "Payments unchanged")
real = [x for x in outbox() if x.get("to") and not x["to"].endswith("example.invalid")]
check(not real, "Codes only to synthetic addresses (simulated mailbox)", real)
check(db.execute("select count(*) from attendees where email like 'zz-%' and is_checked_in=1").fetchone()[0] == 0, "Check-in untouched")

print("\n%d failure(s)" % len(fails))
for f in fails:
    print("   - " + f)
shutil.rmtree(WORK, ignore_errors=True)
sys.exit(1 if fails else 0)
