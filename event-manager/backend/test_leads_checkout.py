"""STANDS BUY THEIR SCANNED LEADS ONLINE -- Babak, 14 Nov 2026.

One offer: the leads a stand scanned, $199, paid on the GHL checkout. When the
payment reaches Gaia (webhook / mirror -> /identity/payments/sync) the stand
whose contact email is the buyer's opens by itself. Checked here, on a
throwaway copy:
  * the stand's screen and page show the price and a checkout link with the
    stand's email pre-filled, only once a price AND https link are set;
  * setting price / link / product ids needs the scanning permission;
  * a paid live payment for the leads product opens the matching stand, its
    earlier scans open too, and running it again changes nothing;
  * failed, test-mode, other-product, unmatched and two-stand payments open
    nothing; unmatched ones wait on the admin list and an organiser assigns;
  * a payment that arrived before the product id was set counts once it is;
  * a refund never re-locks by itself; it is flagged.
Run:  python3 /root/event/backend/test_leads_checkout.py
"""
import json, secrets, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime
from urllib.parse import urlsplit, parse_qs

HERE = "/root/event/backend"
sys.path.insert(0, HERE)
import os, tempfile
# The unlock log goes to a temporary folder, never the live data/ folder
# (18 Nov 2026: test unlocks of stands 66-68 had landed in the live log).
os.environ["VENDOR_SYNC_DATA"] = tempfile.mkdtemp(prefix="leads-test-")
import testbed
BASE, DB = testbed.start()
import main                                                    # noqa: E402

SVC = {"Authorization": "Bearer " + main.IDENTITY_SERVICE_TOKEN}
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            b = r.read()
            try: return r.status, json.loads(b.decode() or "null")
            except ValueError: return r.status, b.decode()
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b

db = sqlite3.connect(DB, timeout=30)
now = datetime.utcnow().isoformat(" ")
EV, TAG = 1, secrets.token_hex(3)
PROD = "zz-leads-" + TAG

def user(role=None, admin=0):
    cur = db.execute("insert into users(email,hashed_password,full_name,is_admin,created_at) values(?,?,?,?,?)",
                     ("zz-%s-%s-%s@example.invalid" % (role or "admin", TAG, secrets.token_hex(2)), "x", "ZZ fixture", admin, now))
    if role:
        db.execute("insert into event_roles(user_id,event_id,role,created_at) values(?,?,?,?)", (cur.lastrowid, EV, role, now))
    db.commit()
    return {"Authorization": "Bearer " + main.create_access_token({"sub": str(cur.lastrowid)})}

ADMIN = user(admin=1)

def stand(name, email, unlocked=0, full=0):
    tok = "EXH-" + secrets.token_hex(8).upper()
    setup_tok = secrets.token_urlsafe(16)
    c = db.execute("insert into exhibitors(event_id,company_name,booth_number,contact_email,access_token,created_at,"
                   "is_published,can_scan_leads,full_list_access,leads_unlocked,stage,payment_status,"
                   "setup_token_hash,setup_expires_at) values(?,?,?,?,?,?,1,1,?,?,'confirmed','paid',?,?)",
                   (EV, name, "98", email, tok, now, full, unlocked,
                    main._hash_setup_token(setup_tok) if hasattr(main, "_hash_setup_token") else None,
                    "2099-01-01 00:00:00"))
    db.commit()
    return c.lastrowid, tok, setup_tok

def person(last):
    qr = "ATT-" + secrets.token_hex(6).upper()
    c = db.execute("insert into attendees(event_id,email,first_name,last_name,qr_code,public_token,is_checked_in,"
                   "registration_status,attendance_type,share_email_with_exhibitors,share_phone_with_exhibitors,"
                   "custom_data,created_at) values(?,?,?,?,?,?,0,'registered','paid',1,1,'{}',?)",
                   (EV, "zz-%s-%s@example.invalid" % (last, TAG), "Zz", last + TAG, qr,
                    secrets.token_hex(4).upper(), now))
    db.commit()
    return qr

def tx(txid, email, status="succeeded", live=True, product=None):
    return {"transaction": {"_id": txid + TAG, "status": status, "paymentProviderType": "stripe",
                            "amount": 199.0, "currency": "USD", "liveMode": live,
                            "entityType": "order", "entityId": "ord-" + txid + TAG,
                            "contactEmail": email, "contactName": "Zz Buyer",
                            "createdAt": datetime.utcnow().isoformat() + "Z"},
            "order": {"status": "completed",
                      "items": [{"product": {"_id": product or PROD, "name": "ZZ Scanned leads"}}]}}

def sync(*rows):
    return call("POST", "/identity/payments/sync", {"source": "webhook", "transactions": list(rows)}, SVC)

def roster(tok):
    return call("GET", "/scan/roster/" + tok)[1]

def opened(ex_id):
    return db.execute("select leads_unlocked, leads_unlock_source, leads_unlock_payment_id from exhibitors where id=?",
                      (ex_id,)).fetchone()

# Clean slate on this copy: no price, no link, no product.
call("PUT", "/events/%d" % EV, {"scanned_leads_price": None, "scanned_leads_checkout_url": None,
                                "scanned_leads_product_ids": []}, ADMIN)

A, A_TOK, A_SETUP = stand("ZZ Alpha " + TAG, "Alpha-%s@Example.invalid" % TAG)
B, B_TOK, _ = stand("ZZ Beta " + TAG, "beta-%s@example.invalid" % TAG)
C1, C1_TOK, _ = stand("ZZ Twin One " + TAG, "twin-%s@example.invalid" % TAG)
C2, C2_TOK, _ = stand("ZZ Twin Two " + TAG, "twin-%s@example.invalid" % TAG)

print("Configuration")
r = roster(A_TOK)
check(r["offers"]["scanned_leads"].get("checkout_url") is None, "no link while nothing is set", r["offers"])
mgr = user("exhibitor_manager")
st, _ = call("PUT", "/events/%d" % EV, {"scanned_leads_price": 199}, mgr)
check(st == 403, "an exhibitor manager without the scanning permission cannot set the price", st)
st, _ = call("PUT", "/events/%d" % EV, {"scanned_leads_checkout_url": "http://pay.example.invalid/x"}, ADMIN)
check(st == 422, "a non-https checkout link is refused", st)
st, _ = call("PUT", "/events/%d" % EV, {"scanned_leads_price": 199,
                                        "scanned_leads_checkout_url": "https://pay.example.invalid/leads?src=card"}, ADMIN)
check(st == 200, "admin sets price and checkout link", st)
off = roster(A_TOK)["offers"]["scanned_leads"]
u = urlsplit(off.get("checkout_url") or "")
q = parse_qs(u.query)
check(off["price"] == 199 and u.netloc == "pay.example.invalid" and q.get("email") == ["Alpha-%s@Example.invalid" % TAG]
      and q.get("src") == ["card"], "stand screen: $199 and the checkout with the stand's email pre-filled", off)
check("lists" in roster(A_TOK)["offers"], "roster shape unchanged")

# A scan before paying stays blurred.
qr = person("Before")
db.execute("insert into leads(exhibitor_id,attendee_id,scanned_at) select ?, id, ? from attendees where qr_code=?",
           (A, now, qr))
db.commit()
lead = roster(A_TOK)["leads"][0]["attendee"]
check(lead.get("locked") is True and not lead.get("last_name"), "earlier scan is blurred before payment", lead)

print("Payment before the product id is known")
st, r = sync(tx("early", "alpha-%s@example.invalid" % TAG))
check(st == 200 and r.get("leads_unlocked") == 0 and not opened(A)[0], "not yet a leads product: nothing opens", (st, r))
st, _ = call("PUT", "/events/%d" % EV, {"scanned_leads_product_ids": [PROD]}, ADMIN)
row = opened(A)
check(st == 200 and row[0] == 1 and row[1] == "payment" and row[2], "naming the product opens the stand that paid earlier", row)
lead = roster(A_TOK)["leads"][0]["attendee"]
check(not lead.get("locked") and lead.get("last_name") == "Before" + TAG, "its earlier scan is open now", lead)
check(roster(A_TOK)["leads_unlocked"] is True and "scanned_leads" not in roster(A_TOK)["offers"],
      "the buy offer is gone once open")
st, r = sync(tx("early", "alpha-%s@example.invalid" % TAG))
check(st == 200 and r.get("leads_unlocked") == 0 and opened(A)[2] == row[2], "the same payment again changes nothing", r)

print("Payments that must open nothing")
st, r = sync(tx("fail", "beta-%s@example.invalid" % TAG, status="failed"),
             tx("test", "beta-%s@example.invalid" % TAG, live=False),
             tx("other", "beta-%s@example.invalid" % TAG, product="zz-not-leads"),
             tx("twin", "twin-%s@example.invalid" % TAG),
             tx("stranger", "stranger-%s@example.invalid" % TAG))
check(st == 200 and r.get("leads_unlocked") == 0, "failed / test / other product / two stands / stranger", r)
check(not opened(B)[0] and not opened(C1)[0] and not opened(C2)[0], "none of those stands opened")

print("Live webhook payment")
st, r = sync(tx("beta", "BETA-%s@example.invalid" % TAG))
check(st == 200 and r.get("leads_unlocked") == 1 and opened(B)[0] == 1, "paid: the stand opens at once (email case ignored)", r)

print("Admin list and assigning")
st, lp = call("GET", "/events/%d/leads-payments" % EV, headers=ADMIN)
states = {p["buyer_email"]: p["state"] for p in lp.get("payments", [])} if st == 200 else {}
check(st == 200 and lp["configured"] and states.get("stranger-%s@example.invalid" % TAG) == "unmatched"
      and states.get("twin-%s@example.invalid" % TAG) == "ambiguous", "unmatched and two-stand payments wait", states)
check(lp.get("attention", 0) >= 2, "they count as needing attention", lp.get("attention"))
st, _ = call("GET", "/events/%d/leads-payments" % EV, headers=mgr)
check(st == 403, "the list needs the scanning permission", st)
stranger = [p for p in lp["payments"] if p["buyer_email"] == "stranger-%s@example.invalid" % TAG][0]
st, r = call("POST", "/events/%d/leads-payments/%d/assign" % (EV, stranger["id"]), {"exhibitor_id": C1}, ADMIN)
check(st == 200 and r["result"] == "unlocked" and opened(C1)[0] == 1 and opened(C1)[1] == "payment_assigned",
      "an organiser assigns it and that stand opens", (st, r))
st, r = call("POST", "/events/%d/leads-payments/%d/assign" % (EV, stranger["id"]), {"exhibitor_id": C2}, ADMIN)
check(st == 409, "one payment cannot open two stands", (st, r))

print("Refund")
st, r = sync(tx("beta", "beta-%s@example.invalid" % TAG, status="refunded"))
check(opened(B)[0] == 1, "a refund does not re-lock by itself")
st, lp = call("GET", "/events/%d/leads-payments" % EV, headers=ADMIN)
b = [p for p in lp["payments"] if p["exhibitor"] and p["exhibitor"]["id"] == B]
check(b and b[0]["state"] == "refunded_still_open" and b[0]["needs_attention"], "it is flagged for an organiser", b)

print("Organiser locks by hand")
st, _ = call("PUT", "/exhibitors/%d" % B, {"leads_unlocked": False}, ADMIN)
check(st == 200 and opened(B) == (0, None, None), "locking by hand clears the payment link", opened(B))
st, _ = call("PUT", "/exhibitors/%d" % B, {"leads_unlocked": True}, ADMIN)
check(opened(B)[1] == "admin", "unlocking by hand says so", opened(B))

print("Stand page")
html = call("GET", "/vendor/" + A_SETUP)[1]
if isinstance(html, str) and "Collect leads" in html:
    check("More attendee-list options" not in html, "the setup page no longer promises other list options")
st, r = call("PUT", "/events/%d" % EV, {"scanned_leads_price": None, "scanned_leads_checkout_url": None,
                                        "scanned_leads_product_ids": []}, ADMIN)

print("\n%d failed" % len(fails) if fails else "\nALL PASS")
sys.exit(1 if fails else 0)
