"""18 Nov 2026 audit regressions (worktree DB copy, no network, nothing sent).

  1. a GHL "failed" (a recipient's temporary 4.x deferral that GHL keeps
     retrying) is asked about again for three days, every half hour; a bounce,
     a click and anything older than three days stay final;
  2. a refused email whose ticket has since been delivered in another email
     (Vladimir Spivak, booking B700: refused at the old yahoo address,
     delivered at the corrected one) no longer makes the booking critical
     ("duplicate QR" / "wrong holder");
  3. ...but a refused email whose ticket has NOT gone out elsewhere is still
     checked (Ashlyn Marshall, B791, keeps her real problem).
Run:  python3 test_audit_20261118.py
"""
import os, sys, tempfile, shutil, sqlite3
from datetime import datetime, timedelta, timezone
HERE = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp(prefix="audit1118-")
for src, dst in ((os.path.join(HERE, "event.db"), os.path.join(tmp, "event.db")),
                 (os.path.join(HERE, "data", "ticket-delivery.db"), os.path.join(tmp, "ticket-delivery.db"))):
    a = sqlite3.connect(src); b = sqlite3.connect(dst); a.backup(b); b.close(); a.close()
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tmp, "event.db")
os.environ["TICKET_DELIVERY_DB"] = os.path.join(tmp, "ticket-delivery.db")
sys.path.insert(0, HERE)
import atexit; atexit.register(shutil.rmtree, tmp, True)
from ticket_delivery import ec_store
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok: fails.append(label)

print("1. a failed status is re-checked for three days")
t0 = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)
iso = lambda d: d.isoformat()
d = ec_store.due_for_status
check(d("accepted", "failed", iso(t0 - timedelta(hours=1)), iso(t0 - timedelta(days=1)), t0), "failed, sent yesterday, checked an hour ago: ask again")
check(not d("accepted", "failed", iso(t0 - timedelta(minutes=5)), iso(t0 - timedelta(days=1)), t0), "...but not every few minutes")
check(not d("accepted", "failed", iso(t0 - timedelta(hours=1)), iso(t0 - timedelta(days=4)), t0), "failed and older than three days: final")
check(not d("accepted", "bounced", None, iso(t0 - timedelta(hours=1)), t0), "a bounce stays final")
check(not d("accepted", "clicked", None, iso(t0 - timedelta(hours=1)), t0), "a click stays final")
check(not d("rejected", "failed", None, iso(t0 - timedelta(hours=1)), t0), "a refused send is never polled")

print("2./3. stale refusals")
import main, database, email_center as EC
db = database.SessionLocal()
built = EC.bookings(db, 1, fresh=True)
b700 = built["by_key"].get("B700")
check(b700 is not None and not [c for c in b700["critical"] if c["code"] in ("DUPLICATE_QR", "WRONG_HOLDER")],
      "B700: delivered at the corrected address, no duplicate-QR / wrong-holder", b700 and b700["critical"])
b791 = built["by_key"].get("B791")
check(b791 is not None and b791["delivery"] in ("failed", "bounced"), "B791: the refused, never-delivered email still shows as failed",
      b791 and b791["delivery"])
dup = [b["key"] for b in built["bookings"] if any(c["code"] == "DUPLICATE_QR" for c in b["critical"])]
check(not dup, "no booking reports a duplicate QR", dup)
print("\n%d failed" % len(fails) if fails else "\nALL PASS")
sys.exit(1 if fails else 0)
