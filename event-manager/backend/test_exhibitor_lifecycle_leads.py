# -*- coding: utf-8 -*-
"""EXHIBITOR LIFECYCLE, SCANNER PERMISSION AND LEADS — the 7 Nov 2026 audit fixes.

Both audits that week found the same holes at the stands:
  * a cancelled stand's setup link kept working and could re-publish it, and
    its scanner kept capturing leads until somebody flipped a second switch;
  * an exhibitor manager could switch scanning on and read every scanner token;
  * 50 representatives scanning one badge at once stored two leads;
  * lists stopped at 200 (roster) and 50 (lead list), and said 200 "captured";
  * the scan response and the saved list disagreed about consent;
  * the organiser's lead list returned whole attendee records, badge
    credentials and payment fields included;
  * there was no export.
Every check below runs on a throwaway copy (testbed) with synthetic stands and
synthetic visitors only.
Run:  python3 /root/event/backend/test_exhibitor_lifecycle_leads.py
"""
import concurrent.futures, csv, io, json, secrets, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime, timedelta

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
            return r.status, (b if raw else json.loads(b.decode() or "null")), {k.lower(): v for k, v in r.headers.items()}
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        h = {k.lower(): v for k, v in e.headers.items()}
        try: return e.code, json.loads(b or "null"), h
        except Exception: return e.code, b, h

db = sqlite3.connect(DB, timeout=30)
db.row_factory = sqlite3.Row
now = datetime.utcnow().isoformat(" ")
EV = 1

def user(email, admin=False, role=None):
    cur = db.execute("insert into users(email,hashed_password,full_name,is_admin,created_at) values(?,?,?,?,?)",
                     (email, "x", "ZZ fixture", 1 if admin else 0, now))
    if role:
        db.execute("insert into event_roles(user_id,event_id,role,created_at) values(?,?,?,?)", (cur.lastrowid, EV, role, now))
    db.commit()
    return {"Authorization": "Bearer " + main.create_access_token({"sub": str(cur.lastrowid)})}

ORGANISER = user("zz-org-%s@example.invalid" % secrets.token_hex(3), role="organizer")
MANAGER = user("zz-exman-%s@example.invalid" % secrets.token_hex(3), role="exhibitor_manager")

def stand(name, stage="confirmed", scan=True):
    tok = "EXH-" + secrets.token_hex(8).upper()
    # No sort_order, as the sheet and package syncs create them.
    cur = db.execute("insert into exhibitors(event_id,company_name,booth_number,contact_email,access_token,created_at,"
                     "is_published,can_scan_leads,leads_unlocked,stage,payment_status) values(?,?,?,?,?,?,1,?,1,?,'paid')",  # leads bought (13 Nov 2026)
                     (EV, name, "99", "stand@example.invalid", tok, now, 1 if scan else 0, stage))
    db.commit()
    return cur.lastrowid, tok

ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
def visitor(i, share=True):
    qr = "ATT-" + secrets.token_hex(6).upper()
    db.execute("insert into attendees(event_id,email,first_name,last_name,company,qr_code,is_checked_in,registration_status,"
               "created_at,ticket_type_id,public_token,custom_data,badge_print_count,share_email_with_exhibitors,"
               "share_phone_with_exhibitors,phone) values(?,?,?,?,?,?,0,'registered',?,7,?,'{}',0,?,?,?)",
               (EV, "zz-visitor-%d-%s@example.invalid" % (i, secrets.token_hex(2)), "Zz", "Visitor%d" % i,
                "=HYPERLINK(\"x\")" if i == 0 else "Acme", qr, now,
                "".join(secrets.choice(ALPHA) for _ in range(8)), 1 if share else 0, 1 if share else 0, "+10000000%03d" % i))
    db.commit()
    return qr

print("\n== a stand's stage decides, at request time ==")
sid, stok = stand("ZZ Lifecycle Stand")
setup = secrets.token_urlsafe(24)
db.execute("update exhibitors set setup_token_hash=?, setup_expires_at=? where id=?",
           (main._vendor_token_hash(setup), (datetime.utcnow() + timedelta(days=30)).isoformat(" "), sid))
db.commit()
v0 = visitor(0)
st, out, _ = call("GET", "/vendor-setup/" + setup)
check(st == 200, "a confirmed stand's setup link opens", (st, out))
st, out, _ = call("POST", "/scan", {"access_token": stok, "qr_code": v0})
check(st == 200 and out.get("success"), "a confirmed stand with scanning captures a lead", out)
db.execute("update exhibitors set stage='not_attending' where id=?", (sid,)); db.commit()
st, out, _ = call("GET", "/vendor-setup/" + setup)
check(st == 404, "cancelled: the setup link stops working at once", (st, out))
st, out, _ = call("POST", "/vendor-setup/" + setup, {"publish": True, "description": "back again"})
check(st == 404, "cancelled: the setup link cannot re-publish the stand", (st, out))
st, out, _ = call("POST", "/scan", {"access_token": stok, "qr_code": v0})
check(not out.get("success"), "cancelled: the scanner stops capturing although can_scan_leads is still on", out)
st, out, _ = call("GET", "/scan/roster/" + stok)
check(st == 404, "cancelled: the roster is closed too", st)
db.execute("update exhibitors set stage='purchased', is_published=0 where id=?", (sid,)); db.commit()
st, out, _ = call("POST", "/vendor-setup/" + setup, {"publish": True, "description": "ready"})
check(st == 200 and out.get("is_published") is False,
      "purchased (not yet confirmed): profile saves but is not listed", out)
db.execute("update exhibitors set stage='confirmed' where id=?", (sid,)); db.commit()

print("\n== the company name stays the organiser's ==")
st, out, _ = call("POST", "/vendor-setup/" + setup, {"company_name": "ZZ Renamed", "contact_email": "new@example.invalid"})
name, vf = db.execute("select company_name, vendor_fields from exhibitors where id=?", (sid,)).fetchone()
check(name == "ZZ Lifecycle Stand", "a setup save does not rename the stand (the sheet matches on it)", name)
check("contact_email" in json.loads(vf or "[]"), "a field the stand set itself is remembered as theirs", vf)
sys.path.insert(0, HERE + "/tools")
import vendor_sync
check(vendor_sync.vendor_owned({"vendor_fields": vf}) == ("contact_email",),
      "the sheet sync treats that field as the stand's", vendor_sync.vendor_owned({"vendor_fields": vf}))

print("\n== scanning is a separate permission from editing ==")
sid2, stok2 = stand("ZZ Grant Stand", scan=False)
st, out, _ = call("PUT", "/exhibitors/%d" % sid2, {"can_scan_leads": True}, MANAGER)
check(st == 403, "an exhibitor manager cannot switch scanning on", (st, out))
st, out, _ = call("PUT", "/exhibitors/%d" % sid2, {"description": "edited"}, MANAGER)
check(st == 200 and out.get("access_token") is None, "they can still edit the stand, and get no scanner token back", (st, out))
st, rows, _ = call("GET", "/events/%d/exhibitors" % EV, None, MANAGER)
check(st == 200 and rows and all(r.get("access_token") is None for r in rows),
      "the stand list shows the manager no scanner tokens", st)
st, rows, _ = call("GET", "/events/%d/exhibitors" % EV, None, ORGANISER)
check(st == 200 and any(r.get("access_token") == stok2 for r in rows), "an organiser still sees them", st)
st, out, _ = call("PUT", "/exhibitors/%d" % sid2, {"can_scan_leads": True}, ORGANISER)
check(st == 200 and out.get("can_scan_leads") is True, "an organiser can grant scanning", (st, out))
st, out, _ = call("POST", "/exhibitors/%d/rotate-scanner-token" % sid2, None, MANAGER)
check(st == 403, "a manager cannot issue scanner links", st)
st, out, _ = call("POST", "/exhibitors/%d/rotate-scanner-token" % sid2, None, ORGANISER)
newtok = (out or {}).get("access_token")
check(st == 200 and newtok and newtok != stok2, "an organiser can issue a new scanner link", (st, out))
st, out, _ = call("POST", "/scan", {"access_token": stok2, "qr_code": v0})
check(not out.get("success"), "the old link stops working at once", out)
st, out, _ = call("POST", "/scan", {"access_token": newtok, "qr_code": v0})
check(out.get("success"), "the new link works", out)

print("\n== one lead per stand per visitor, even 50 at once ==")
sid3, stok3 = stand("ZZ Busy Stand")
v1 = visitor(1)
with concurrent.futures.ThreadPoolExecutor(max_workers=50) as pool:
    res = list(pool.map(lambda _: call("POST", "/scan", {"access_token": stok3, "qr_code": v1}), range(50)))
ok = sum(1 for st, out, _ in res if st == 200 and out.get("success"))
n = db.execute("select count(*) from leads where exhibitor_id=?", (sid3,)).fetchone()[0]
check(ok == 50 and n == 1, "50 simultaneous scans of one badge: all answered, exactly one lead stored", (ok, n))
idx = db.execute("select count(*) from sqlite_master where name='uq_leads_exhibitor_attendee'").fetchone()[0]
check(idx == 1, "the database itself holds the one-lead rule (unique index)", idx)

print("\n== one consent rule for the scan, the list and the export ==")
v2 = visitor(2, share=False)
st, out, _ = call("POST", "/scan", {"access_token": stok3, "qr_code": v2})
check(out.get("attendee", {}).get("email") is None, "no consent: the scan shows no email", out.get("attendee"))
# An explicit yes (as the door's sharing control records it: flags + timestamp).
db.execute("update attendees set share_email_with_exhibitors=1, share_phone_with_exhibitors=1, consent_updated_at=? where qr_code=?", (now, v2)); db.commit()
st, out, _ = call("POST", "/scan", {"access_token": stok3, "qr_code": v2})
scan_email = (out.get("attendee") or {}).get("email")
st, lst, _ = call("GET", "/scan/leads/" + stok3)
list_email = next((l["attendee"]["email"] for l in lst if l["attendee"]["last_name"] == "Visitor2"), "missing")
check(scan_email and scan_email == list_email, "after a yes and a new scan, scan and list agree", (scan_email, list_email))
db.execute("update attendees set share_email_with_exhibitors=0 where qr_code=?", (v2,)); db.commit()
st, lst, _ = call("GET", "/scan/leads/" + stok3)
list_email = next((l["attendee"]["email"] for l in lst if l["attendee"]["last_name"] == "Visitor2"), "missing")
check(list_email is None, "a later withdrawal hides the email again everywhere", list_email)

v3 = visitor(3, share=True)     # flags on by default, never asked
st, out, _ = call("POST", "/scan", {"access_token": stok3, "qr_code": v3})
a3 = out.get("attendee") or {}
check(bool(a3.get("email")) and a3.get("first_name") == "Zz" and a3.get("consent") == {"email": True, "phone": True},
      "never asked: purchase terms share their own email and phone (Babak, 9 Nov 2026)", a3)

print("\n== complete lists and a real total ==")
sid4, stok4 = stand("ZZ Big Stand")
vids = [r[0] for r in db.execute("select id from attendees where event_id=? and registration_status in ('registered','active') limit 230", (EV,))]
db.executemany("insert into leads(exhibitor_id,attendee_id,scanned_at,consent_snapshot) values(?,?,?,?)",
               [(sid4, a, now, json.dumps({"email": False, "phone": False})) for a in vids])
db.commit()
st, ro, _ = call("GET", "/scan/roster/" + stok4)
check(st == 200 and ro.get("captured") == len(vids) and ro.get("shown") == 200,
      "roster: captured is the true total (%d), 200 shown" % len(vids), (ro.get("captured"), ro.get("shown")))
st, page, hdr = call("GET", "/scan/leads/%s?limit=100&offset=200" % stok4)
check(st == 200 and hdr.get("x-total-count") == str(len(vids)) and len(page) == len(vids) - 200,
      "lead list pages past the old 50 cap, with X-Total-Count", (hdr.get("x-total-count"), len(page)))

print("\n== export: own leads only, consent-filtered, formula-safe ==")
st, raw, hdr = call("GET", "/scan/leads/%s/export.csv" % stok3, raw=True)
rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
check(st == 200 and len(rows) == 3, "the stand downloads exactly its own 3 leads", (st, len(rows)))
check(all(r["last_name"] in ("Visitor1", "Visitor2", "Visitor3") for r in rows), "no other stand's visitors in it", [r["last_name"] for r in rows])
check("@" in next(r for r in rows if r["last_name"] == "Visitor3")["email"], "never-asked email is in the CSV (purchase terms)", rows)
check("pass" not in (rows[0].keys() if rows else []), "the CSV has no pass/ticket-tier column", list(rows[0].keys()) if rows else [])
check(next(r for r in rows if r["last_name"] == "Visitor2")["email"] == "", "withdrawn email is blank in the CSV", rows)
st, raw, _ = call("GET", "/scan/leads/%s/export.csv" % stok, raw=True)
v0row = [r for r in csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))) if r["last_name"] == "Visitor0"]
check(v0row and v0row[0]["company"].startswith("'="), "a value starting with = is neutralised for spreadsheets", v0row)
st, raw, _ = call("GET", "/exhibitors/%d/leads/export.csv" % sid4, None, ORGANISER, raw=True)
check(st == 200 and len(list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))) == len(vids),
      "the organiser export has every lead (%d)" % len(vids), st)
st, out, _ = call("GET", "/scan/leads/EXH-NOPE/export.csv")
check(st == 404, "an unknown scanner token exports nothing", st)

print("\n== the organiser's lead list carries no badge credentials ==")
st, lst, _ = call("GET", "/exhibitors/%d/leads" % sid3, None, ORGANISER)
keys = set((lst[0].get("attendee") or {}).keys()) if st == 200 and lst else set()
check(st == 200 and keys and not keys & {"qr_code", "public_token", "door_payment_amount", "acq_price", "custom_data"},
      "no QR code, badge token, payment or purchase fields", sorted(keys))

print("\n== the admin list no longer fails on rows without a created_at or token ==")
db.execute("insert into exhibitors(event_id,company_name,stage) values(?,?,?)", (EV, "ZZ Bare Row", "purchased")); db.commit()
st, rows, _ = call("GET", "/events/%d/exhibitors" % EV, None, ORGANISER)
check(st == 200, "a stand with no created_at, token or email does not break the list", st)

print("\n%d check(s) failed" % len(fails) if fails else "\nALL CHECKS PASSED")
sys.exit(1 if fails else 0)
