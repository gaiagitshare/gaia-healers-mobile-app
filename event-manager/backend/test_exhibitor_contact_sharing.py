"""EXHIBITOR CONTACT SHARING — Babak, 9 Nov 2026.

Buyers accept the terms at purchase, which permit sharing their details with
the exhibitors whose stand they hand their badge to. So a stand that scans a
badge gets, without any further question:
  full name, email, phone (if any), company (if any), job title (if any).
Rules checked here, on a throwaway copy with synthetic stands and visitors:
  * only the stand that scanned a person sees them (not other stands, not the roster);
  * an explicit opt-out (door / admin) still wins, also for leads already captured;
  * guest tickets show the GUEST's own details, never the purchaser's
    ("+seatN" mailbox, a seat linked to the buyer, a shared mailbox, a transfer);
  * no ticket tier, ticket QR, badge code, payment or profile data reaches a stand;
  * notes, ratings, duplicate prevention and the CSV keep working.
Run:  python3 /root/event/backend/test_exhibitor_contact_sharing.py
"""
import csv, io, json, secrets, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime

HERE = "/root/event/backend"
sys.path.insert(0, HERE)
import testbed
BASE, DB = testbed.start()
import main                                                    # noqa: E402

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
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read()
            return r.status, (b if raw else json.loads(b.decode() or "null"))
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b

db = sqlite3.connect(DB, timeout=30)
now = datetime.utcnow().isoformat(" ")
EV, TAG = 1, secrets.token_hex(3)
cur = db.execute("insert into users(email,hashed_password,full_name,is_admin,created_at) values(?,?,?,?,?)",
                 ("zz-org-%s@example.invalid" % TAG, "x", "ZZ fixture", 0, now))
db.execute("insert into event_roles(user_id,event_id,role,created_at) values(?,?,?,?)", (cur.lastrowid, EV, "organizer", now))
db.commit()
ORG = {"Authorization": "Bearer " + main.create_access_token({"sub": str(cur.lastrowid)})}

def stand(name):
    tok = "EXH-" + secrets.token_hex(8).upper()
    c = db.execute("insert into exhibitors(event_id,company_name,booth_number,contact_email,access_token,created_at,"
                   "is_published,can_scan_leads,stage,payment_status) values(?,?,?,?,?,?,1,1,'confirmed','paid')",
                   (EV, name, "99", "stand@example.invalid", tok, now))
    db.commit()
    return c.lastrowid, tok

def person(last, email, phone=None, company=None, job=None, cd=None, share_email=1, share_phone=1, asked=None):
    qr = "ATT-" + secrets.token_hex(6).upper()
    badge = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
    c = db.execute("insert into attendees(event_id,email,first_name,last_name,phone,company,job_title,qr_code,public_token,"
                   "is_checked_in,registration_status,share_email_with_exhibitors,share_phone_with_exhibitors,"
                   "consent_updated_at,custom_data,created_at) values(?,?,?,?,?,?,?,?,?,0,'registered',?,?,?,?,?)",
                   (EV, email, "Zz", last + TAG, phone, company, job, qr, badge, share_email, share_phone, asked,
                    json.dumps(cd or {}), now))
    db.commit()
    return {"id": c.lastrowid, "qr": qr, "badge": badge, "email": email, "phone": phone}

def scan(tok, code):
    st, out = call("POST", "/scan", {"access_token": tok, "qr_code": code})
    return (out or {}).get("attendee") or {}, out or {}

FORBIDDEN = ("pass_display", "pass_includes", "pass", "ticket_type", "ticket_type_id", "qr_code", "public_token",
             "badge", "payment_status", "amount_paid", "custom_data", "member_card", "readings", "contact_id")

S1, T1 = stand("ZZ Stand One %s" % TAG)
S2, T2 = stand("ZZ Stand Two %s" % TAG)

print("\n== a scan gives the person's details, no question asked ==")
p = person("Full", "zz-full-%s@example.invalid" % TAG, "+15550001111", "Zz Co", "Healer")
who, out = scan(T1, p["qr"])
check(out.get("success") and who.get("first_name") == "Zz" and who.get("last_name") == "Full" + TAG, "full name", who)
check(who.get("email") == p["email"], "email", who.get("email"))
check(who.get("phone") == p["phone"], "phone", who.get("phone"))
check(who.get("company") == "Zz Co" and who.get("job_title") == "Healer", "company and job title", who)
who_b, _ = scan(T1, p["badge"])
check(who_b.get("email") == p["email"], "the printed badge code works the same as the ticket QR", who_b.get("email"))
q = person("NoPhone", "zz-nophone-%s@example.invalid" % TAG)
who, _ = scan(T1, q["qr"])
check(who.get("email") == q["email"] and not who.get("phone") and who.get("company") == "", "missing phone/company simply blank", who)
for k in FORBIDDEN:
    check(k not in who and k not in json.dumps(out), "no %s in the scan response" % k)

print("\n== only the stand that scanned them ==")
st, l2 = call("GET", "/scan/leads/%s?limit=500" % T2)
check(st == 200 and not any(p["email"] in json.dumps(x) for x in l2), "another stand's lead list does not contain them", len(l2 or []))
st, ro2 = call("GET", "/scan/roster/%s" % T2)
check(p["email"] not in json.dumps(ro2) and ("Full" + TAG) not in json.dumps(ro2), "another stand's roster carries no name or email", list((ro2 or {}).keys()))
st, csv2 = call("GET", "/scan/leads/%s/export.csv" % T2, raw=True)
check(p["email"].encode() not in csv2, "nor its CSV")
st, ro1 = call("GET", "/scan/roster/%s" % T1)
check(p["email"] in json.dumps(ro1), "the scanning stand's own roster lists them")

print("\n== duplicates, notes, rating, CSV ==")
scan(T1, p["qr"]); scan(T1, p["badge"])
n = db.execute("select count(*) from leads where exhibitor_id=? and attendee_id=?", (S1, p["id"])).fetchone()[0]
check(n == 1, "several scans of one person: one lead", n)
st, l1 = call("GET", "/scan/leads/%s?limit=500" % T1)
lid = next(x["id"] for x in l1 if (x.get("attendee") or {}).get("attendee_id") == p["id"])
st, upd = call("PUT", "/scan/leads/%d" % lid, {"access_token": T1, "notes": "Wants a demo", "rating": 5})
check(st == 200, "note and rating saved", (st, upd))
st, raw = call("GET", "/scan/leads/%s/export.csv" % T1, raw=True)
rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
mine = [r for r in rows if r["last_name"] == "Full" + TAG]
# A phone starting with "+" carries the spreadsheet formula guard (a leading '), as before.
check(mine and mine[0]["email"] == p["email"] and mine[0]["phone"].lstrip("'") == p["phone"] and mine[0]["notes"] == "Wants a demo" and mine[0]["rating"] == "5",
      "CSV row has email, phone, note and rating", mine[:1])
check(rows and "pass" not in rows[0], "CSV has no ticket-tier column", list(rows[0].keys()) if rows else [])
st, adm = call("GET", "/exhibitors/%d/leads" % S1, headers=ORG)
check(st == 200 and all(k not in json.dumps(adm) for k in ("pass_display", "pass_includes", "qr_code", "public_token")),
      "the organiser's lead view carries no ticket tier or codes either", st)

print("\n== explicit opt-out still wins ==")
o1 = person("OptEmail", "zz-optemail-%s@example.invalid" % TAG, "+15550002222", share_email=0, asked=now)
who, _ = scan(T1, o1["qr"])
check(who.get("email") is None and who.get("phone") == o1["phone"], "opted out of email: phone only", who)
o2 = person("OptPhone", "zz-optphone-%s@example.invalid" % TAG, "+15550003333", share_phone=0, asked=now)
who, _ = scan(T1, o2["qr"])
check(who.get("phone") is None and who.get("email") == o2["email"], "opted out of phone: email only", who)
st, r = call("POST", "/events/%d/attendees/%d/sharing" % (EV, p["id"]), {"share_email": False, "share_phone": False, "reason": "zz withdraws"}, ORG)
check(st == 200, "a later withdrawal is recorded (door/admin)", (st, r))
st, l1 = call("GET", "/scan/leads/%s?limit=500" % T1)
check(not any(p["email"] in json.dumps(x) or p["phone"] in json.dumps(x) for x in l1), "withdrawal hides email and phone from a lead already captured", "")
st, raw = call("GET", "/scan/leads/%s/export.csv" % T1, raw=True)
check(p["email"].encode() not in raw, "and from the CSV")

print("\n== guest tickets: the guest's own details, never the purchaser's ==")
buyer = person("Buyer", "zz-buyer-%s@example.invalid" % TAG, "+15550004444")
seat_alias = person("SeatAlias", "zz-buyer-%s+seat2@example.invalid" % TAG, "+15550004444",
                    cd={"seat_of_party": "2 of 2", "bought_by_attendee": buyer["id"]})
who, _ = scan(T1, seat_alias["qr"])
check(who.get("email") is None, "seat on the buyer's mailbox (+seatN): no email", who.get("email"))
check(who.get("phone") is None, "seat carrying the buyer's phone: no phone", who.get("phone"))
check(who.get("last_name") == "SeatAlias" + TAG, "the guest's own name is shown", who.get("last_name"))
seat_own = person("SeatOwn", "zz-guest-own-%s@example.invalid" % TAG, "+15550005555",
                  cd={"seat_of_party": "3 of 3", "bought_by_attendee": buyer["id"]})
who, _ = scan(T1, seat_own["qr"])
check(who.get("email") == seat_own["email"] and who.get("phone") == seat_own["phone"], "seat named with the guest's own email and phone: shown", who)
seat_linked = person("SeatLinked", "zz-buyer-%s@example.invalid" % TAG, None,
                     cd={"seat_of_party": "4 of 4", "bought_by_attendee": buyer["id"]})
who, _ = scan(T1, seat_linked["qr"])
check(who.get("email") is None, "seat linked to the buyer but on the buyer's own address: no email", who.get("email"))
mbox = "zz-family-%s@example.invalid" % TAG
db.execute("insert into payment_events(provider, buyer_name, buyer_email, buyer_phone, event_id, first_seen_at) values('zz-test',?,?,?,?,?)",
           ("Zz Purchaser" + TAG, mbox, "+15550006666", EV, now))
db.commit()
fam_buyer = person("Purchaser", mbox, "+15550006666")
fam_guest = person("Partner", mbox, "+15550006666")
who_b, _ = scan(T1, fam_buyer["qr"]); who_g, _ = scan(T1, fam_guest["qr"])
check(who_b.get("email") == mbox, "shared mailbox: the purchaser's own ticket shows it", who_b.get("email"))
check(who_g.get("email") is None and who_g.get("phone") is None, "shared mailbox: the other holder gets neither the purchaser's email nor phone", who_g)
tr = person("TransferOld", "zz-old-holder-%s@example.invalid" % TAG, "+15550007777")
new_email = "zz-new-holder-%s@example.invalid" % TAG
st, out = call("POST", "/attendees/%d/transfer" % tr["id"], {"email": new_email, "first_name": "Zz", "last_name": "TransferNew" + TAG,
                                                           "phone": "+15550008888", "reason": "zz synthetic transfer"}, ORG)
check(st == 200, "transfer accepted", (st, out))
who, _ = scan(T1, tr["qr"])
check(who.get("email") == new_email and who.get("phone") == "+15550008888", "transferred ticket: the new holder's own details", who)
check("zz-old-holder" not in json.dumps(who), "never the previous holder's")

print("\n== nothing private ==")
st, l1 = call("GET", "/scan/leads/%s?limit=500" % T1)
blob = json.dumps(l1)
for k in ("pass_display", "pass_includes", "qr_code", "public_token", "payment", "amount_paid", "custom_data"):
    check(k not in blob, "lead list has no %s" % k)
check(all(x["qr"] not in blob and x["badge"] not in blob for x in (p, q, buyer, seat_alias)), "no ticket QR or badge code values in the lead list")

print("\nALL PASS" if not fails else "\nFAILED: %d" % len(fails))
sys.exit(1 if fails else 0)
