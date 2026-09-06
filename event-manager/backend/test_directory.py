# -*- coding: utf-8 -*-
"""THE DIRECTORY — who is visible, and what of them.

The exhibitor directory is the one place a stand's details are handed to
strangers, so the interesting question is never "does it list them" but "what
does it refuse to list". Two rules do all the work:

  published only  -- a stand an operator has not put in the directory is not in
                     the payload, is not findable by name, and its own page is
                     a 404. There is no draft state that leaks.
  public fields   -- no setup token, no scanner token, no package, no money, no
                     internal note. The booking contact appears only where the
                     stand asked for it; the details the company already
                     publishes appear without asking.

Search runs in the app over the payload, so a row that is not in the payload
cannot be searched into view. That is the property tested here, rather than the
filtering itself.

Throwaway event only. Never touches a real stand.
Run:  python3 /root/event/backend/test_directory.py
"""
import json, sqlite3, sys, urllib.error, urllib.request

env = {}
for line in open("/root/event/backend/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
BASE = "http://127.0.0.1:8002"
DB = "/root/event/backend/event.db"

fails = []
checks = 0


def check(ok, label, detail=""):
    global checks
    checks += 1
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", label, "" if ok else "   %s" % (detail,)))
    if not ok:
        fails.append(label)


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            p = r.read()
            try:
                return r.status, json.loads(p or b"null")
            except Exception:
                return r.status, p.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        p = e.read()
        try:
            return e.code, json.loads(p or b"null")
        except Exception:
            return e.code, p.decode("utf-8", "replace")


def sql(q, a=()):
    c = sqlite3.connect(DB)
    try:
        return c.execute(q, a).fetchall()
    finally:
        c.close()


print("DIRECTORY")

# ── a throwaway event with one listed stand and one withheld ────────────────
for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ dir%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)

st, ev = call("POST", "/events", {
    "name": "ZZ dir test", "start_date": "2030-01-01T09:00:00",
    "end_date": "2030-01-02T17:00:00", "location": "Nowhere",
    "is_published": True,
}, token=ADMIN)
check(st == 200, "throwaway event created", (st, ev))
EV = ev["id"]

st, listed = call("POST", "/exhibitors", {
    "event_id": EV, "company_name": "ZZ Listed Stand", "contact_email": "listed@example.invalid",
    "contact_phone": "+15550001111", "booth_number": "9", "description": "In the directory.",
    "package": "The Connector $5000", "payment_status": "paid", "amount_paid": 5000,
    "amount_due": 5000, "payment_note": "internal only", "is_published": True,
}, token=ADMIN)
LISTED = listed["id"]
st, hidden = call("POST", "/exhibitors", {
    "event_id": EV, "company_name": "ZZ Withheld Stand", "contact_email": "hidden@example.invalid",
    "booth_number": "10", "description": "Not in the directory.", "is_published": False,
}, token=ADMIN)
HIDDEN = hidden["id"]

# ── who appears ─────────────────────────────────────────────────────────────
st, rows = call("GET", "/public/events/%d/exhibitors" % EV)
names = [r["company_name"] for r in rows]
check(st == 200, "the directory endpoint answers", st)
check("ZZ Listed Stand" in names, "a listed stand is in the directory")
check("ZZ Withheld Stand" not in names, "an unlisted stand is NOT in the directory", names)
check(all(r["id"] != HIDDEN for r in rows), "the unlisted stand's id is not in the payload either")

# Search is client-side over exactly this payload, so a row that is absent here
# cannot be searched into view. Proving absence proves search cannot reach it.
blob = json.dumps(rows).lower()
check("withheld" not in blob, "no trace of the unlisted stand anywhere in the payload")
check("hidden@example.invalid" not in blob, "nor its contact address")

# ── what a listed stand does and does not carry ─────────────────────────────
row = [r for r in rows if r["id"] == LISTED][0]
for private in ("access_token", "setup_token_hash", "package", "payment_status",
                "amount_due", "amount_paid", "payment_note", "can_scan_leads",
                "show_contact_publicly", "stage", "sort_order"):
    check(private not in row, "the directory does not carry %s" % private, sorted(row.keys()))
check("5000" not in json.dumps(row), "what they paid does not appear in any field")
check("internal only" not in json.dumps(row), "the internal payment note does not appear")
check(row.get("contact_phone") is None,
      "the booking phone is withheld while show_contact_publicly is off", row.get("contact_phone"))
check("photos" in row and "products" in row,
      "the stand's own pictures and catalogue are carried, because those are public")

# The company's own published details need no permission; the booking contact does.
call("PUT", "/exhibitors/%d" % LISTED, {"public_email": "hello@example.invalid"}, token=ADMIN)
st, rows2 = call("GET", "/public/events/%d/exhibitors" % EV)
row2 = [r for r in rows2 if r["id"] == LISTED][0]
check(row2.get("contact_email") == "hello@example.invalid",
      "a public address the company already publishes is shown")
call("PUT", "/exhibitors/%d" % LISTED, {"show_contact_publicly": True}, token=ADMIN)
st, rows3 = call("GET", "/public/events/%d/exhibitors" % EV)
row3 = [r for r in rows3 if r["id"] == LISTED][0]
check(row3.get("contact_phone") == "+15550001111",
      "the booking phone appears only once the stand has asked for it", row3.get("contact_phone"))

# ── the stand page follows the same rule ────────────────────────────────────
st, body = call("GET", "/v/%d" % LISTED)
check(st == 200, "a listed stand has a public page", st)
check("ZZ Listed Stand" in str(body), "and it is their page")
# The ampersand is escaped in the attribute, which is what correct HTML looks
# like; the browser resolves it back. Assert the escaped form rather than
# quietly weakening the check to a substring that would also match the old link.
check(("?view=events&amp;event=%d&amp;tab=exhibitors" % EV) in str(body),
      "'See everyone exhibiting' points at the app directory, not the API root")
check("view=events" in str(body),
      "and it names the screen, without which the link lands on Today")
check("gaiahealers.app/?view=events&event=" in str(body).replace("&amp;", "&"),
      "and it is the app host, not the API host")
check('href="https://api.gaiahealers.app">See everyone' not in str(body),
      "the old raw-API target is gone")

st, _ = call("GET", "/v/%d" % HIDDEN)
check(st == 404, "an unlisted stand's page is a 404, not a preview", st)

# Un-publishing takes the page away again, in both places.
call("PUT", "/exhibitors/%d" % LISTED, {"is_published": False}, token=ADMIN)
st, _ = call("GET", "/v/%d" % LISTED)
check(st == 404, "un-listing a stand closes its page immediately", st)
st, rows4 = call("GET", "/public/events/%d/exhibitors" % EV)
check(all(r["id"] != LISTED for r in rows4), "and drops it from the directory in the same breath")

# ── an unpublished EVENT hides the whole directory ──────────────────────────
call("PUT", "/exhibitors/%d" % LISTED, {"is_published": True}, token=ADMIN)
call("PUT", "/events/%d" % EV, {"is_published": False}, token=ADMIN)
st, _ = call("GET", "/public/events/%d/exhibitors" % EV)
check(st == 404, "an unpublished event has no directory at all", st)

# ── cleanup ─────────────────────────────────────────────────────────────────
call("DELETE", "/exhibitors/%d" % LISTED, token=ADMIN)
call("DELETE", "/exhibitors/%d" % HIDDEN, token=ADMIN)
call("DELETE", "/events/%d" % EV, token=ADMIN)
check(sql("SELECT COUNT(*) FROM exhibitors WHERE company_name LIKE 'ZZ %Stand'")[0][0] == 0,
      "the throwaway stands are gone afterwards")
check(sql("SELECT COUNT(*) FROM events WHERE name='ZZ dir test'")[0][0] == 0,
      "and so is the throwaway event")

print("\n%d checks, %d failed" % (checks, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
