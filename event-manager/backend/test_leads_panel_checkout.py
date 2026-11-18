"""'Unlock my leads' from the stand's own panel opens THAT stand, whoever pays
(Babak, 18 Nov 2026), on a copy, nothing real is charged or called.
  * the panel's button goes through Gaia (302 to the GHL checkout) and notes the stand;
  * a leads payment whose email and phone match no stand opens the stand that
    started the checkout shortly before;
  * two stands starting at once: neither opens (Needs Attention instead);
  * a checkout started hours before does not count; an open stand records nothing;
  * the scanner page offers the panel link, not the bare GHL link.
Run: python3 test_leads_panel_checkout.py"""
import json, os, sys, tempfile, urllib.request, urllib.error
from datetime import datetime, timedelta
os.environ["VENDOR_SYNC_DATA"] = tempfile.mkdtemp(prefix="leads-panel-")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import testbed
BASE, DB = testbed.start()
import main, models, leads_checkout                                  # noqa: E402
from database import SessionLocal                                    # noqa: E402
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok: fails.append(label)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(NoRedirect)
def click(token):
    try:
        opener.open(BASE + "/scan/leads/%s/checkout" % token, timeout=60); return 200, None
    except urllib.error.HTTPError as e: return e.code, e.headers.get("Location")
db = SessionLocal(); ev = db.get(models.Event, 1); PID = leads_checkout.product_ids(ev)[0]
def stand(i):
    x = db.get(models.Exhibitor, i); x.leads_unlocked = False; x.leads_unlock_payment_id = None; x.leads_checkout_started_at = None
    x.full_list_access = False; db.commit(); return x
n = [0]
def pay(when=None):
    n[0] += 1
    pe = models.PaymentEvent(ghl_transaction_id="tp-%d" % n[0], ghl_entity_type="order", ghl_entity_id="op-%d" % n[0], status="paid",
                             status_raw="succeeded", amount=199.0, amount_refunded=0, currency="USD", live_mode=True,
                             occurred_at=when or datetime.utcnow(), buyer_name="Someone Else", buyer_email="paid.by.someone%d@example.com" % n[0],
                             buyer_phone="+1 212 555 01%02d" % n[0], product_ids=json.dumps([PID]), product_names=json.dumps(["Exhibitor Lead Scan"]))
    db.add(pe); db.commit(); return pe
a = stand(1)
st, loc = click(a.access_token)
db.expire_all(); a = db.get(models.Exhibitor, 1)
check(st == 302 and (loc or "").startswith(ev.scanned_leads_checkout_url) and "email=" in loc, "the panel button forwards to the GHL checkout", (st, loc))
check(a.leads_checkout_started_at is not None, "and notes that this stand started a checkout")
pe = pay()
r = leads_checkout.apply_payment(db, pe); db.commit(); db.refresh(a)
check(r == "unlocked" and a.leads_unlocked and a.leads_unlock_source == "payment_panel" and a.leads_unlock_payment_id == pe.id,
      "paid by someone else, other email and phone: the stand that started it opens", (r, a.leads_unlock_source))
b, c = stand(2), stand(3)
click(b.access_token); click(c.access_token)
pe = pay(); r = leads_checkout.apply_payment(db, pe); db.commit(); db.refresh(b); db.refresh(c)
check(r == "ambiguous" and not b.leads_unlocked and not c.leads_unlocked, "two stands started at once: neither opens", r)
d = stand(4); d.leads_checkout_started_at = datetime.utcnow() - timedelta(hours=4); db.commit()
b.leads_checkout_started_at = None; c.leads_checkout_started_at = None; db.commit()
pe = pay(); r = leads_checkout.apply_payment(db, pe); db.commit(); db.refresh(d)
check(r == "unmatched" and not d.leads_unlocked, "a checkout started 4 hours before does not count", r)
db.expire_all(); a = db.get(models.Exhibitor, 1); before = a.leads_checkout_started_at
click(a.access_token); db.expire_all(); a = db.get(models.Exhibitor, 1)
check(a.leads_checkout_started_at == before, "an already-open stand records nothing")
st, _ = click("not-a-real-token")
check(st == 404, "a bad link is refused", st)
e = stand(5)
with urllib.request.urlopen(BASE + "/scan/roster/%s" % e.access_token, timeout=60) as x: ro = json.loads(x.read())
url = (((ro.get("offers") or {}).get("scanned_leads") or {}).get("checkout_url") or "")
check(url.endswith("/scan/leads/%s/checkout" % e.access_token), "the scanner page offers the panel link", url)
print("\n%d failed" % len(fails) if fails else "\nALL PASS"); sys.exit(1 if fails else 0)
