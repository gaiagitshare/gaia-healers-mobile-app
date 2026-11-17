"""Email Center pre-send check on a booking that mixes GHL orders and invoices
(17 Nov 2026: Lana Warren's and Lita Aris's sends crashed with a 500).
Run:  python3 /root/event/backend/test_ec_mixed_sources.py
"""
import sys, urllib.error
sys.path.insert(0, "/root/event/backend")
import main  # noqa: F401
import email_center as EC
fails = []
def check(ok, label, d=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "   %r" % (d,)))
    if not ok: fails.append(label)
class GW:
    def __init__(self, orders, invoices, refunded=()):
        self.orders, self.invoices, self.refunded = orders, invoices, set(refunded)
    def contact(self, cid): return {"id": cid, "email": "a@example.invalid"}
    def find_contacts(self, email): return [{"id": "c1", "email": email}]
    def order(self, oid, source):
        table = self.invoices if source == "ghl_invoice" else self.orders
        if oid not in table:
            raise urllib.error.HTTPError("u", 400 if source == "ghl_invoice" else 404, "no", {}, None)
        return table[oid]
    def transactions(self, oid): return [{"status": "refunded"}] if oid in self.refunded else [{"status": "succeeded"}]
PAID_O = {"status": "completed", "paymentStatus": "paid", "liveMode": True}
PAID_I = {"status": "paid"}
gw = GW({"o1": PAID_O, "o2": PAID_O}, {"i1": PAID_I})
ok, why, cid = EC._validate_live(gw, {"recipient": "a@example.invalid", "source": "ghl_order", "_order_ids": ["o1", "o2", "i1"]}, "c1")
check(ok and cid == "c1", "orders + an invoice under an 'order' booking pass", (ok, why))
ok, why, _ = EC._validate_live(gw, {"recipient": "a@example.invalid", "source": "ghl_invoice", "_order_ids": ["i1", "o1"]}, "c1")
check(ok, "an order under an 'invoice' booking passes", (ok, why))
gw2 = GW({"o1": dict(PAID_O, paymentStatus="pending")}, {"i1": PAID_I})
ok, why, _ = EC._validate_live(gw2, {"recipient": "a@example.invalid", "source": "ghl_invoice", "_order_ids": ["i1", "o1"]}, "c1")
check(not ok and why == "order_not_paid_live", "an unpaid order is still refused, wherever it sits", (ok, why))
gw3 = GW({"o1": PAID_O}, {"i1": PAID_I}, refunded=["i1"])
ok, why, _ = EC._validate_live(gw3, {"recipient": "a@example.invalid", "source": "ghl_order", "_order_ids": ["o1", "i1"]}, "c1")
check(not ok and why == "order_refunded", "a refunded invoice is still refused", (ok, why))
gw4 = GW({}, {})
try:
    EC._validate_live(gw4, {"recipient": "a@example.invalid", "source": "ghl_order", "_order_ids": ["x"]}, "c1"); raised = False
except urllib.error.HTTPError:
    raised = True
check(raised, "an id GHL knows under neither type is not waved through")
print("\n%d failed" % len(fails) if fails else "\nALL PASS"); sys.exit(1 if fails else 0)
