"""STAND ACCESS TO THE ATTENDEE LIST -- Babak, 13 Nov 2026.

Stands whose package includes it (an organiser's grant, `full_list_access`)
see every ticket holder without scanning, and can still scan. Every other
stand scans for free, but every lead it scans stays fully blurred (no name,
company, role or contact is sent) until it buys its leads (`leads_unlocked`);
it is offered its scanned leads and the full list, each at its own price
(set later; empty = "to be announced"). Unlocking opens earlier scans too. Checked here, on a throwaway copy:
  * full-list stand: every ticket holder, nobody else (crew, speakers, stand
    staff, cancelled/refunded/revoked tickets are not on it);
  * the same person-level rules as a scan: opt-outs win, never the buyer's
    contact on a guest ticket, no ticket QR / badge code / tier / payment;
  * full-list stand can still scan; the CSV has everyone and is logged;
  * any other stand: no list, no CSV (404), a count and the buy offer;
  * the grant follows the stand's stage and needs the scanning permission;
  * the stand's own page (printed card) links its scanner and says which.
Run:  python3 /root/event/backend/test_stand_full_list.py
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
        with urllib.request.urlopen(req, timeout=120) as r:
            b = r.read()
            return r.status, (b if raw else json.loads(b.decode() or "null"))
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b

db = sqlite3.connect(DB, timeout=30)
now = datetime.utcnow().isoformat(" ")
EV, TAG = 1, secrets.token_hex(3)

def user(role=None, admin=0):
    cur = db.execute("insert into users(email,hashed_password,full_name,is_admin,created_at) values(?,?,?,?,?)",
                     ("zz-%s-%s-%s@example.invalid" % (role or "admin", TAG, secrets.token_hex(2)), "x", "ZZ fixture", admin, now))
    if role:
        db.execute("insert into event_roles(user_id,event_id,role,created_at) values(?,?,?,?)", (cur.lastrowid, EV, role, now))
    db.commit()
    return {"Authorization": "Bearer " + main.create_access_token({"sub": str(cur.lastrowid)})}

ADMIN = user(admin=1)

def stand(name, full=0, scan=1, stage="confirmed", token=True, unlocked=0):
    tok = ("EXH-" + secrets.token_hex(8).upper()) if token else None
    c = db.execute("insert into exhibitors(event_id,company_name,booth_number,contact_email,access_token,created_at,"
                   "is_published,can_scan_leads,full_list_access,leads_unlocked,stage,payment_status) "
                   "values(?,?,?,?,?,?,1,?,?,?,?,'paid')",
                   (EV, name, "99", "stand@example.invalid", tok, now, scan, full, unlocked, stage))
    db.commit()
    return c.lastrowid, tok

def person(last, email, kind="paid", status="registered", phone=None, cd=None, share_email=1):
    qr = "ATT-" + secrets.token_hex(6).upper()
    badge = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
    c = db.execute("insert into attendees(event_id,email,first_name,last_name,phone,qr_code,public_token,is_checked_in,"
                   "registration_status,attendance_type,share_email_with_exhibitors,share_phone_with_exhibitors,"
                   "custom_data,created_at) values(?,?,?,?,?,?,?,0,?,?,?,1,?,?)",
                   (EV, email, "Zz", last + TAG, phone, qr, badge, status, kind, share_email, json.dumps(cd or {}), now))
    db.commit()
    return {"id": c.lastrowid, "qr": qr, "badge": badge, "email": email}

FORBIDDEN = ("pass_display", "pass", "ticket_type", "ticket_type_id", "qr_code", "public_token", "badge",
             "payment_status", "amount_paid", "custom_data", "registration_status", "attendance_type", "acq_price")

FULL, TF = stand("ZZ Title Sponsor %s" % TAG, full=1)
REG, TR = stand("ZZ Regular %s" % TAG)
p_paid = person("Paid", "zz-paid-%s@example.invalid" % TAG, phone="+15550002222")
p_comp = person("Comp", "zz-comp-%s@example.invalid" % TAG, kind="complimentary")
p_out = person("OptOut", "zz-out-%s@example.invalid" % TAG, share_email=0)
p_buyer = person("Buyer", "zz-buyer-%s@example.invalid" % TAG)
p_guest = person("Guest", "zz-buyer-%s+seat2@example.invalid" % TAG)
p_crew = person("Crew", "zz-crew-%s@example.invalid" % TAG, kind="staff")
p_spk = person("Speaker", "zz-spk-%s@example.invalid" % TAG, kind="speaker")
p_exs = person("StandStaff", "zz-exs-%s@example.invalid" % TAG, kind="exhibitor")
p_can = person("Cancelled", "zz-can-%s@example.invalid" % TAG, status="cancelled")
p_ref = person("Refunded", "zz-ref-%s@example.invalid" % TAG, status="refunded")

holders = db.execute("select count(*) from attendees where event_id=? and attendance_type in ('paid','complimentary') "
                     "and lower(coalesce(registration_status,'')) not in "
                     "('cancelled','canceled','refunded','revoked','transferred','void')", (EV,)).fetchone()[0]

print("\n== a full-list stand sees every ticket holder, nobody else ==")
st, r = call("GET", "/scan/roster/%s" % TF)
check(st == 200 and r.get("full_list") is True, "roster says full list", (st, r if st != 200 else r.get("full_list")))
people = {a["attendee_id"]: a for a in (r.get("attendees") or [])}
check(len(people) == holders == r.get("attendees_total"), "everyone with a ticket, and the count matches",
      (len(people), holders, r.get("attendees_total")))
check(p_paid["id"] in people and p_comp["id"] in people, "paid and complimentary tickets are on it")
for p, what in ((p_crew, "crew"), (p_spk, "speaker"), (p_exs, "stand staff"), (p_can, "cancelled"), (p_ref, "refunded")):
    check(p["id"] not in people, "%s badge is not on the list" % what)
check(people.get(p_paid["id"], {}).get("email") == p_paid["email"]
      and people.get(p_paid["id"], {}).get("phone") == "+15550002222", "name, email and phone of a buyer")
check(people.get(p_out["id"], {}).get("email") is None, "an opt-out still wins", people.get(p_out["id"]))
check(people.get(p_guest["id"], {}).get("email") is None, "a guest seat never shows the buyer's mailbox",
      people.get(p_guest["id"]))
leaked = sorted({k for a in people.values() for k in a if k in FORBIDDEN})
check(not leaked, "no ticket QR, badge code, tier or payment on the list", leaked)
check("offers" not in r and r.get("leads_unlocked") is True, "no offers; its scans are open too")

print("\n== the full-list stand can still scan ==")
st, out = call("POST", "/scan", {"access_token": TF, "qr_code": p_paid["qr"]})
check(st == 200 and (out or {}).get("success") and out["attendee"].get("email") == p_paid["email"],
      "scan works and shows the person", (st, out))

print("\n== the full list as CSV, logged ==")
st, raw = call("GET", "/scan/roster/%s/attendees.csv" % TF, raw=True)
rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))) if st == 200 else []
check(st == 200 and len(rows) == holders, "CSV has every ticket holder", (st, len(rows), holders))
mine = [x for x in rows if x["last_name"] == "Paid" + TAG]
check(mine and mine[0]["email"] == p_paid["email"] and mine[0]["scanned_at_your_stand"] == "yes",
      "CSV row has contact and marks who they met", mine)
check(not any(x["last_name"] == "OptOut" + TAG and x["email"] for x in rows), "CSV respects the opt-out")
check(db.execute("select count(*) from export_audit where kind=?", ("stand_full_list:%d" % FULL,)).fetchone()[0] == 1,
      "the download is recorded")

print("\n== any other stand: a count and the offers, never the list ==")
st, r = call("GET", "/scan/roster/%s" % TR)
check(st == 200 and r.get("full_list") is False and "attendees" not in r, "no list for a regular stand",
      sorted(r) if isinstance(r, dict) else r)
check(r.get("attendees_total") == holders, "the blurred count is ticket holders only", (r.get("attendees_total"), holders))
TBA = {"price": None, "currency": "USD", "status": "coming_soon"}
check(r.get("offers") == {"lists": [], "scanned_leads": TBA},
      "scanned leads: price to be announced; other options not decided yet", r.get("offers"))
st, _ = call("GET", "/scan/roster/%s/attendees.csv" % TR, raw=True)
check(st == 404, "no CSV for a regular stand (same 404 as a bad link)", st)
st, _ = call("GET", "/scan/roster/EXH-NOPE%s/attendees.csv" % TAG, raw=True)
check(st == 404, "bad link: 404", st)
print("\n== scanning is free, the scanned leads stay fully blurred until bought ==")
LOCKED = {"locked": True, "first_name": "", "last_name": "", "company": "", "job_title": "", "email": None, "phone": None}
st, out = call("POST", "/scan", {"access_token": TR, "qr_code": p_paid["qr"]})
check(st == 200 and (out or {}).get("success"), "a regular stand scans", (st, out))
check(out.get("attendee") == LOCKED, "the scan shows nothing about the person", out.get("attendee"))
check("Zz" not in (out.get("message") or "") and TAG not in json.dumps(out), "not even in the message", out.get("message"))
st, r = call("GET", "/scan/roster/%s" % TR)
check(len(r.get("leads", [])) == 1 and r["leads"][0]["attendee"] == LOCKED and r.get("leads_unlocked") is False,
      "the lead is on its list, fully locked", r.get("leads"))
lid = r["leads"][0]["id"]
st, ld = call("GET", "/scan/leads/%s" % TR)
check(st == 200 and ld[0]["attendee"] == LOCKED, "the leads endpoint is locked too", ld)
st, upd = call("PUT", "/scan/leads/%d" % lid, {"access_token": TR, "notes": "liked the mats", "rating": 4})
check(st == 200 and upd.get("rating") == 4 and upd.get("attendee") == LOCKED, "it can still note and rate a locked lead",
      (st, upd))
st, _ = call("GET", "/scan/leads/%s/export.csv" % TR, raw=True)
check(st == 402, "no download while locked", st)
st, rows = call("GET", "/exhibitors/%d/leads" % REG, None, ADMIN)
check(st == 200 and rows and rows[0]["attendee"].get("email") == p_paid["email"],
      "the organiser still sees the lead in full", (st, rows))
OFFERS = [{"title": "Whole attendee list", "note": "Everyone at the event", "price": 499},
          {"title": "VIP attendees", "price": None}, {"title": "", "price": 5}, "junk"]
st, _ = call("PUT", "/events/%d" % EV, {"scanned_leads_price": 149, "lead_offers": OFFERS}, ADMIN)
st, r = call("GET", "/scan/roster/%s" % TR)
o = r.get("offers") or {}
check(o.get("scanned_leads", {}).get("price") == 149 and o["scanned_leads"]["status"] == "price_set",
      "once set, the scanned-leads price shows", o)
check([(x["title"], x["price"], x["status"]) for x in o.get("lists", [])]
      == [("Whole attendee list", 499.0, "price_set"), ("VIP attendees", None, "coming_soon")],
      "the organiser's other options show as entered, blank ones dropped", o.get("lists"))
st, html = None, None
call("PUT", "/events/%d" % EV, {"scanned_leads_price": None, "lead_offers": None}, ADMIN)

print("\n== once bought, every scan opens, earlier ones too ==")
st, _ = call("PUT", "/exhibitors/%d" % REG, {"leads_unlocked": True}, user("checkin_staff"))
check(st in (401, 403), "door staff cannot unlock leads", st)
st, _ = call("PUT", "/exhibitors/%d" % REG, {"leads_unlocked": True}, ADMIN)
st, r = call("GET", "/scan/roster/%s" % TR)
a = (r.get("leads") or [{}])[0].get("attendee") or {}
check(r.get("leads_unlocked") is True and a.get("locked") is False and a.get("email") == p_paid["email"]
      and a.get("last_name") == "Paid" + TAG, "the earlier scan now shows name and contact", a)
check(set(r.get("offers") or {}) == {"lists"}, "scanned leads no longer offered; other options still are", r.get("offers"))
st, raw = call("GET", "/scan/leads/%s/export.csv" % TR, raw=True)
check(st == 200 and p_paid["email"].encode() in raw and b"liked the mats" in raw, "download works, notes kept", st)
st, _ = call("GET", "/scan/roster/%s/attendees.csv" % TR, raw=True)
check(st == 404, "unlocked leads are not the full list", st)
st, out = call("POST", "/scan", {"access_token": TR, "qr_code": p_out["qr"]})
check(out.get("attendee", {}).get("email") is None and out["attendee"].get("last_name") == "OptOut" + TAG,
      "an opt-out still wins after unlocking", out.get("attendee"))

print("\n== the grant follows the stand ==")
LATE, TL = stand("ZZ Not attending %s" % TAG, full=1, stage="not_attending")
st, _ = call("GET", "/scan/roster/%s/attendees.csv" % TL, raw=True)
check(st == 404, "a stand that is no longer attending loses the list", st)
NEW, _ = stand("ZZ New sponsor %s" % TAG, scan=0, token=False)
DOOR = user("checkin_staff")
st, _ = call("PUT", "/exhibitors/%d" % NEW, {"full_list_access": True}, DOOR)
check(st in (401, 403), "door staff cannot grant the full list", st)
st, row = call("PUT", "/exhibitors/%d" % NEW, {"full_list_access": True}, ADMIN)
check(st == 200 and row.get("full_list_access") and row.get("can_scan_leads") and row.get("access_token"),
      "granting the list also switches on the scanner link", row if st != 200 else
      {k: row.get(k) for k in ("full_list_access", "can_scan_leads", "access_token")})

print("\n== the stand's own page (the printed card) ==")
def setup_page(ex_id):
    tok = secrets.token_urlsafe(18)
    import hashlib
    db.execute("update exhibitors set setup_token_hash=?, setup_expires_at=? where id=?",
               (hashlib.sha256(("vendor:%s" % tok).encode()).hexdigest(), "2027-01-01 00:00:00", ex_id))
    db.commit()
    st, raw = call("GET", "/vendor/%s" % tok, raw=True)
    return st, (raw.decode() if isinstance(raw, bytes) else str(raw))
st, html = setup_page(FULL)
check(st == 200 and "includes the full attendee list" in html and ("/event/scan/" + TF) in html,
      "full-list stand: says it is included, links the list", st)
st, html = setup_page(REG)
LOCKD, TLK = stand("ZZ Locked %s" % TAG)
st, html = setup_page(LOCKD)
check(st == 200 and "Open my badge scanner" in html and ("/event/scan/" + TLK) in html
      and "stays blurred until you buy your leads" in html and "Your scanned leads: price to be announced" in html
      and "More attendee-list options are coming" in html,
      "regular stand: scanner link, blurred until bought, more options coming", st)
st, html = setup_page(REG)
check(st == 200 and "stays blurred" not in html and "Want more of the attendees?" in html,
      "stand that bought its leads: no lock note, other options only", st)
OFF, TO = stand("ZZ Scanner off %s" % TAG, scan=0)
st, html = setup_page(OFF)
check(st == 200 and "not switched on yet" in html and ("/event/scan/" + TO) not in html,
      "scanner off: says so, no dead link", st)

print("\n%d failure(s)" % len(fails))
for f in fails:
    print("   - " + f)
sys.exit(1 if fails else 0)
