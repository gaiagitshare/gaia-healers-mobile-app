"""Photo-upload update email to exhibitors (18 Nov 2026), FAKE GHL, a copy of
the delivery history: nothing reaches anyone.
  * sent with the stand's EXISTING setup link; no link is minted or rotated;
  * a stand with no valid setup link is refused, and still has none afterwards;
  * once per stand (a second send is skipped); do-not-disturb respected;
  * only confirmed stands.
Run: python3 test_photos_update_email.py"""
import json, os, secrets, sqlite3, sys, tempfile, urllib.error, urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

WORK = tempfile.mkdtemp(prefix="exphoto-test-")
TD = os.path.join(WORK, "ticket-delivery.db")
src = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "data", "ticket-delivery.db"), uri=True)
dst = sqlite3.connect(TD); src.backup(dst)
# Sending starts OFF in every copy, whatever the live switches say (Babak
# switched both on for the real event, 13 Nov 2026): these suites test the
# switch itself and must not pass or fail on how the live event is set up.
dst.execute("update delivery_control set value='off' where key in ('email_center_ticket_sending','email_center_exhibitor_sending')")
dst.commit(); dst.close(); src.close()
FAKE = os.path.join(WORK, "fake-ghl.json")
OUTBOX = os.path.join(WORK, "outbox.jsonl")
BW = os.path.join(WORK, "bw"); os.makedirs(BW)
json.dump({"dnd": ["ray@myivspaorlando.com"]}, open(FAKE, "w"))
json.dump({}, open(os.path.join(BW, "fake.json"), "w"))
os.environ.update(TICKET_DELIVERY_DB=TD, EMAIL_CENTER_FAKE=FAKE, EMAIL_CENTER_FAKE_OUTBOX=OUTBOX, BIOWELL_FAKE=BW,
                  EMAIL_CENTER_SEND_PAUSE="0.05", EMAIL_CENTER_CACHE_SECONDS="0")
os.environ.pop("EMAIL_CENTER_DISABLED", None)
os.environ.pop("BIOWELL_CREATE_CONTACTS", None)        # the stand route must not depend on the station's switch

os.environ["TESTBED_RAW_APPROVALS"] = "1"
import testbed                                                # noqa: E402
BASE, DB = testbed.start()
import main                                                   # noqa: E402

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok: fails.append(label)
def call(m, p, b=None):
    r = urllib.request.Request(BASE + p, data=json.dumps(b).encode() if b is not None else None, method=m,
                               headers={"Content-Type": "application/json", "Authorization": "Bearer " + ADMIN})
    try:
        with urllib.request.urlopen(r, timeout=120) as x: return x.status, json.loads(x.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")
def outbox():
    try: return [json.loads(x) for x in open(OUTBOX)]
    except OSError: return []
ADMIN = main.create_access_token({"sub": "1", "adm": True})
st, _ = call("POST", "/events/1/email-center/controls", {"key": "exhibitors", "value": "on", "reason": "test", "confirm": True})
s2 = sqlite3.connect(TD); s2.execute("update delivery_control set value='on' where key='email_center_exhibitor_sending'"); s2.commit()
db = sqlite3.connect(DB)
tok6 = db.execute("select setup_token_hash from exhibitors where id=6").fetchone()[0]
st, pv = call("GET", "/events/1/email-center/exhibitors/6/preview?kind=photos_update")
check(st == 200 and "Photo uploads now work" in pv.get("subject", "") and "/vendor/" in pv.get("html", ""), "preview: subject and the stand's own link", (st, str(pv)[:200]))
st, r = call("POST", "/events/1/email-center/exhibitors/6/send", {"kind": "photos_update"})
check(st == 200 and r.get("state") == "accepted", "sent to Gordon's stand", r)
ob = [o for o in outbox() if o["to"] == "gordon@biblehealingoil.com"]
check(len(ob) == 1 and "Photo uploads" in ob[0]["subject"], "exactly one email to the stand's contact", ob)
check(sqlite3.connect(DB).execute("select setup_token_hash from exhibitors where id=6").fetchone()[0] == tok6, "the setup link was NOT rotated")
st, r = call("POST", "/events/1/email-center/exhibitors/6/send", {"kind": "photos_update"})
check(r.get("state") == "skipped" and len([o for o in outbox() if o["to"] == "gordon@biblehealingoil.com"]) == 1, "a second send is skipped", r)
tok61 = sqlite3.connect(DB).execute("select setup_token_hash from exhibitors where id=61").fetchone()[0]
st, r = call("POST", "/events/1/email-center/exhibitors/61/send", {"kind": "photos_update"})
check(r.get("state") == "refused" and r.get("reason") == "no_valid_setup_link", "a stand with no setup link is refused", r)
check(sqlite3.connect(DB).execute("select setup_token_hash from exhibitors where id=61").fetchone()[0] == tok61, "and no link was minted for it")
st, r = call("POST", "/events/1/email-center/exhibitors/62/send", {"kind": "photos_update"})
check(r.get("state") == "refused", "do-not-disturb / no link: refused", r)
st, r = call("POST", "/events/1/email-center/exhibitors/14/send", {"kind": "photos_update"})
check(r.get("state") == "refused" and r.get("reason") == "not_a_confirmed_stand", "a stand not attending is refused", r)
print("\n%d failed" % len(fails) if fails else "\nALL PASS"); sys.exit(1 if fails else 0)
