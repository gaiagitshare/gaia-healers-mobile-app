# -*- coding: utf-8 -*-
"""Production smoke test for the door release (3 Nov 2026). One clearly labelled
test guest ("ZZ SMOKE TEST", @example.invalid) is created through the new
Add Collaborating Guest endpoint, exercised, then REVOKED (never deleted) with a
reason. The door is in rehearsal mode, so its scans are stamped as rehearsal.
No email is sent, nothing touches GHL or payments.

Run (as root on the server):  python3 tools/smoke_door_2026-11-03.py
"""
import concurrent.futures, json, os, re, sys, time, urllib.error, urllib.request

API = "http://127.0.0.1:8002"
PROXY = "https://api.gaiahealers.app"
EVENT = 1


def service_env():
    pid = os.popen("systemctl show gaia-event-manager -p MainPID --value").read().strip()
    raw = open("/proc/%s/environ" % pid, "rb").read().split(b"\0")
    return dict(x.decode("utf-8", "replace").split("=", 1) for x in raw if b"=" in x)


# Mint an admin token with the running service's own secret (never printed).
from dotenv import dotenv_values  # noqa: E402
# The service reads its secret from backend/.env (load_dotenv); never printed.
os.environ["SECRET_KEY"] = dotenv_values(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")).get("SECRET_KEY") or service_env().get("SECRET_KEY") or ""
assert os.environ["SECRET_KEY"], "no SECRET_KEY found"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sqlite3  # noqa: E402
db = sqlite3.connect("file:%s?mode=ro" % os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "event.db"), uri=True)
admin_id = db.execute("SELECT id FROM users WHERE is_admin=1 ORDER BY id LIMIT 1").fetchone()[0]
from datetime import datetime, timedelta  # noqa: E402
from jose import jwt  # noqa: E402
# Signed exactly as main.create_access_token does, without importing the app
# (which would run its start-up database steps against production).
_tok = jwt.encode({"sub": str(admin_id), "exp": datetime.utcnow() + timedelta(minutes=20)},
                  os.environ["SECRET_KEY"], algorithm="HS256")
H = {"Authorization": "Bearer " + _tok, "Content-Type": "application/json"}
results = []


def call(method, path, body=None, base=API, headers=H, raw=False):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                 method=method, headers=headers if base == API else {"User-Agent": "Mozilla/5.0 smoke"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
            return r.status, (data if raw else json.loads(data.decode() or "null"))
    except urllib.error.HTTPError as e:
        data = e.read()
        try: return e.code, (data if raw else json.loads(data.decode() or "null"))
        except Exception: return e.code, data


def check(ok, label, detail=""):
    results.append((bool(ok), label))
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "   " + str(detail)[:300]))


ts = time.strftime("%Y%m%d%H%M%S")
guest = {"first_name": "ZZ SMOKE TEST", "last_name": "Not A Real Attendee", "email": "zz.smoke.%s@example.invalid" % ts,
         "partner_event": "Health & Healing Expo", "partner_confirmation": "SMOKE-%s" % ts}
print("PRODUCTION SMOKE TEST — door release")
st, ev = call("GET", "/events/%d" % EVENT)
check(st == 200 and ev.get("door_test_mode") in (True, 1), "service up; door in rehearsal mode", (st, ev.get("door_test_mode") if isinstance(ev, dict) else ev))

st, out = call("POST", "/events/%d/partner-guest" % EVENT, guest)
a = (out or {}).get("attendee") or {}
AID, QR, TOK = a.get("id"), a.get("qr_code"), a.get("public_token")
check(st == 200 and out.get("created") and QR and TOK, "Add Collaborating Guest creates a guest with a unique QR (id %s)" % AID, (st, out))
check((out or {}).get("pass") and "General Admission" in out.get("pass", ""), "exhibition-only pass assigned (%s)" % out.get("pass"), out.get("pass"))
st, dup = call("POST", "/events/%d/partner-guest" % EVENT, guest)
check(st == 200 and dup.get("created") is False and dup["attendee"]["id"] == AID, "duplicate prevented (same email)", dup)

def scan(zone="EVENT_ENTRY"):
    return call("POST", "/events/%d/authorize" % EVENT, {"qr_code": QR, "access_type": zone})[1]
with concurrent.futures.ThreadPoolExecutor(2) as p:
    two = list(p.map(lambda _: scan(), range(2)))
firsts = sum(1 for d in two if d.get("checked_in_now"))
check(firsts == 1 and sum(1 for d in two if d.get("result") == "GRANTED") == 1,
      "two simultaneous scans: exactly one admission recorded (the other: already checked in)", [(d.get("result"), d.get("checked_in_now")) for d in two])
conf = scan("CONFERENCE")
check(conf.get("result") != "GRANTED", "conference not included (%s)" % conf.get("result"), conf.get("reason"))
check(scan("EXHIBIT").get("granted") is True, "exhibition hall granted")

st, png = call("GET", "/events/%d/attendees/%d/badge-label.png" % (EVENT, AID), raw=True)
check(st == 200 and png[:8] == b"\x89PNG\r\n\x1a\n", "printable badge renders", st)
for i in range(2):
    st, pr = call("POST", "/events/%d/attendees/%d/badge-print" % (EVENT, AID),
                  {"result": "printed", "station": "SMOKE TEST", "client_attempt_id": "smoke-%s-%d" % (ts, i)})
check(st == 200, "badge print and reprint recorded", (st, pr))
again = scan()
check(not again.get("checked_in_now"), "reprint did not create another admission")

st, u = call("POST", "/events/%d/attendees/%d/undo-checkin" % (EVENT, AID), {"reason": "smoke test: undo"})
check(st == 200 and u.get("already") is False, "undo check-in (single, with reason)", (st, u))
st, u2 = call("POST", "/events/%d/attendees/%d/undo-checkin" % (EVENT, AID), {"reason": "smoke test: undo twice"})
check(st == 200 and u2.get("already") is True, "second undo is a no-op", (st, u2))
st, ov = call("POST", "/events/%d/attendees/%d/override-admit" % (EVENT, AID), {"reason": "smoke test: override", "access_type": "EVENT_ENTRY"})
check(st == 200 and ov.get("result") == "OVERRIDE" and ov.get("checked_in_now"), "admin override admits once, logged", (st, ov.get("result") if isinstance(ov, dict) else ov))

st, page = call("GET", "/ticket/%s" % TOK, base=PROXY, raw=True)
st2, _ = call("GET", "/t/%s.png" % TOK, base=PROXY, raw=True)
check(st == 200 and b"/t/" in page and st2 == 200, "ticket link opens without login, with QR", (st, st2))

st, rv = call("POST", "/attendees/%d/revoke" % AID, {"reason": "Production smoke test record, not a real attendee (3 Nov 2026)"})
check(st == 200, "test guest revoked (kept for the audit trail)", (st, rv))
st, page = call("GET", "/ticket/%s" % TOK, base=PROXY, raw=True)
check(st == 404, "revoked ticket link stops working", st)
check(scan().get("granted") is not True, "revoked ticket refused at the door")

print("\n%d of %d passed. Test guest id %s (revoked)." % (sum(r[0] for r in results), len(results), AID))
sys.exit(0 if all(r[0] for r in results) else 1)
