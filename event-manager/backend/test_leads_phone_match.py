"""Scanned-leads payments that do not carry the stand's email (18 Nov 2026), on a copy.
  * buyer email matches no stand but the buyer's phone is exactly one scanning
    stand's contact phone: that stand opens (source payment_phone);
  * a phone shared by two stands opens nothing (ambiguous);
  * a payment matching nothing opens nothing and appears in Needs Attention;
  * once assigned it leaves Needs Attention.
Run: python3 test_leads_phone_match.py"""
import json, os, sys, tempfile, time, urllib.request, urllib.error
from datetime import datetime
os.environ["VENDOR_SYNC_DATA"] = tempfile.mkdtemp(prefix="leads-phone-")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import testbed
BASE, DB = testbed.start()
import main, models, leads_checkout                                  # noqa: E402
from database import SessionLocal                                    # noqa: E402
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok: fails.append(label)
ADMIN = main.create_access_token({"sub": "1", "adm": True})
def call(m, p, b=None):
    r = urllib.request.Request(BASE + p, data=json.dumps(b).encode() if b is not None else None, method=m,
                               headers={"Content-Type": "application/json", "Authorization": "Bearer " + ADMIN})
    try:
        with urllib.request.urlopen(r, timeout=120) as x: return x.status, json.loads(x.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")
db = SessionLocal()
ev = db.get(models.Event, 1)
PID = leads_checkout.product_ids(ev)[0]
def pay(email, phone, n):
    pe = models.PaymentEvent(ghl_transaction_id="t-%s" % n, ghl_entity_type="order", ghl_entity_id="o-%s" % n,
                             status="paid", status_raw="succeeded", amount=199.0, amount_refunded=0, currency="USD", live_mode=True,
                             occurred_at=datetime.utcnow(), buyer_name="Test Buyer %s" % n, buyer_email=email, buyer_phone=phone,
                             product_ids=json.dumps([PID]), product_names=json.dumps(["Exhibitor Lead Scan"]))
    db.add(pe); db.commit(); return pe
ex = db.get(models.Exhibitor, 8); ex.leads_unlocked = False; ex.leads_unlock_payment_id = None; db.commit()
pe = pay("someone.else@example.com", "+1 (949) 870-2692", 1)
r = leads_checkout.apply_payment(db, pe); db.commit(); db.refresh(ex)
check(r == "unlocked" and ex.leads_unlocked and ex.leads_unlock_source == "payment_phone" and ex.leads_unlock_payment_id == pe.id,
      "paid from another email, stand's own phone: that stand opens", (r, ex.leads_unlocked, ex.leads_unlock_source))
a, b = db.get(models.Exhibitor, 1), db.get(models.Exhibitor, 2)
for x in (a, b):
    x.contact_phone = "555-010-9999"; x.leads_unlocked = False; x.leads_unlock_payment_id = None
db.commit()
pe2 = pay("nobody@example.com", "5550109999", 2)
r = leads_checkout.apply_payment(db, pe2); db.commit(); db.refresh(a); db.refresh(b)
check(r == "ambiguous" and not a.leads_unlocked and not b.leads_unlocked, "a phone shared by two stands opens neither", r)
pe3 = pay("stranger@example.com", "+1 212 555 0000", 3)
r = leads_checkout.apply_payment(db, pe3); db.commit()
check(r == "unmatched", "no email or phone match: nothing opens", r)
main_ec = __import__("email_center"); main_ec.invalidate() if hasattr(main_ec, "invalidate") else None
st, att = call("GET", "/events/1/email-center/attention")
keys = {i["key"]: i for i in (att or {}).get("items", [])}
check(st == 200 and "leadspay:%d" % pe3.id in keys and keys["leadspay:%d" % pe3.id]["severity"] == "high",
      "the unmatched payment is in Needs Attention", [k for k in keys if k.startswith("leadspay")])
check("leadspay:%d" % pe2.id in keys, "so is the ambiguous one")
st, out = call("POST", "/events/1/leads-payments/%d/assign" % pe3.id, {"exhibitor_id": 3})
st, att = call("GET", "/events/1/email-center/attention")
check(st == 200 and "leadspay:%d" % pe3.id not in {i["key"] for i in att.get("items", [])}, "assigned: it leaves Needs Attention")
print("\n%d failed" % len(fails) if fails else "\nALL PASS"); sys.exit(1 if fails else 0)
