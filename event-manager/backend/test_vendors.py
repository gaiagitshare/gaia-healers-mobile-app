# -*- coding: utf-8 -*-
"""VENDORS — what a stand bought, and what a stand may do.

This lived in a spreadsheet: a free-text payment column and a green highlight.
Fine for planning; it cannot be the thing that decides who may scan attendees on
the day. So the money moved here, and two things that were tangled got pulled
apart:

  in the directory  -- attendees can find them
  can scan badges   -- their lead-retrieval link works

A booth and lead retrieval are separate purchases. Neither switch implies the
other, and paying for one has never meant getting the other.

The directory carries no commercial detail at all -- not the package, not what
they paid, not their scanner token -- and carries contact details only for a
stand that asked for it, because several of these addresses are somebody's
personal mailbox.

Throwaway event only.
Run:  python3 /root/event/backend/test_vendors.py
"""
import json, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime, timedelta

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
def check(ok, label, detail=""):
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
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        p = e.read()
        try:
            return e.code, json.loads(p or b"null")
        except Exception:
            return e.code, p

def sql(q, a=()):
    c = sqlite3.connect(DB)
    try:
        return c.execute(q, a).fetchall()
    finally:
        c.close()

print("VENDORS")

for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ vend%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)

start = datetime.utcnow()
st, ev = call("POST", "/events", {"name": "ZZ vend", "start_date": start.isoformat(),
                                  "end_date": (start + timedelta(days=1)).isoformat(),
                                  "location": "Test", "timezone": "UTC",
                                  "is_published": True}, ADMIN)
EV = ev["id"]
call("PUT", "/events/%d" % EV, {"is_published": True}, ADMIN)

st, v = call("POST", "/exhibitors", {
    "event_id": EV, "company_name": "ZZ Sound Co", "contact_email": "stand@example.invalid",
    "contact_phone": "+14075550300", "website": "https://example.invalid",
    "booth_number": "12", "package": "The Connector $5000",
    "payment_status": "partial", "amount_due": 5000, "amount_paid": 2500,
    "payment_note": "$2500 Paid - $2500 remaining balance"}, ADMIN)
check(st in (200, 201) and v.get("id"), "a vendor can be created with what they bought", (st, v))
VID = v["id"]

# ── 1. the commercial detail is admin-only ────────────────────────────────
st, rows = call("GET", "/events/%d/exhibitors" % EV, token=ADMIN)
mine = [r for r in rows if r["id"] == VID][0]
check(mine["amount_due"] == 5000 and mine["amount_paid"] == 2500 and mine["payment_status"] == "partial",
      "admin sees booked, paid and status", mine)
check(mine["payment_note"] == "$2500 Paid - $2500 remaining balance",
      "and the original wording is kept verbatim, not just the parsed number")

# ── 2. added by hand vs imported in bulk — two different intentions ───────
# Somebody typing a vendor into this screen wants attendees to find them, so a
# manual add goes into the directory. A bulk import of a planning sheet is not
# that: it is 23 rows nobody has looked at yet, and publishing them would put a
# spreadsheet in front of attendees. The import leaves every one switched off.
check(mine["is_published"] is True,
      "a vendor added BY HAND goes into the directory", mine["is_published"])
check(mine["can_scan_leads"] is False,
      "but never gets a scanner by being created — that is sold separately",
      mine["can_scan_leads"])
call("PUT", "/exhibitors/%d" % VID, {"is_published": False}, ADMIN)
st, pub = call("GET", "/public/events/%d/exhibitors" % EV)
check(st == 200 and not any(p["company_name"] == "ZZ Sound Co" for p in pub),
      "and taking them out removes them from the public directory", pub)

# ── 3. the two switches are independent ───────────────────────────────────
call("PUT", "/exhibitors/%d" % VID, {"is_published": True}, ADMIN)
st, rows = call("GET", "/events/%d/exhibitors" % EV, token=ADMIN)
mine = [r for r in rows if r["id"] == VID][0]
check(mine["is_published"] is True and mine["can_scan_leads"] is False,
      "putting them in the directory does NOT hand them a working scanner", mine)
call("PUT", "/exhibitors/%d" % VID, {"can_scan_leads": True}, ADMIN)
st, rows = call("GET", "/events/%d/exhibitors" % EV, token=ADMIN)
mine = [r for r in rows if r["id"] == VID][0]
check(mine["can_scan_leads"] is True, "scanning is granted separately", mine)

# ── 4. the directory carries no commercial detail ─────────────────────────
st, pub = call("GET", "/public/events/%d/exhibitors" % EV)
entry = [p for p in pub if p["company_name"] == "ZZ Sound Co"][0]
check(entry.get("website") == "https://example.invalid" and entry.get("booth_number") == "12",
      "the directory shows what an attendee needs", entry)
leaked = [k for k in ("package", "amount_due", "amount_paid", "payment_status",
                      "payment_note", "access_token", "can_scan_leads") if k in entry]
check(not leaked, "and never what they paid, or their scanner token", leaked)
raw = json.dumps(pub)
check("5000" not in raw and "2500" not in raw, "no amount appears anywhere in the response")

# ── 5. contact details are the stand's own call ───────────────────────────
check(entry.get("contact_email") is None and entry.get("contact_phone") is None,
      "contact details are withheld by default", entry)
call("PUT", "/exhibitors/%d" % VID, {"show_contact_publicly": True}, ADMIN)
st, pub = call("GET", "/public/events/%d/exhibitors" % EV)
entry = [p for p in pub if p["company_name"] == "ZZ Sound Co"][0]
check(entry.get("contact_email") == "stand@example.invalid" and entry.get("contact_phone") == "+14075550300",
      "and appear once the stand asks for them to", entry)
call("PUT", "/exhibitors/%d" % VID, {"show_contact_publicly": False}, ADMIN)
st, pub = call("GET", "/public/events/%d/exhibitors" % EV)
entry = [p for p in pub if p["company_name"] == "ZZ Sound Co"][0]
check(entry.get("contact_email") is None, "switching it back off withholds them again")

# ── 6. taking them out of the directory is immediate ──────────────────────
call("PUT", "/exhibitors/%d" % VID, {"is_published": False}, ADMIN)
st, pub = call("GET", "/public/events/%d/exhibitors" % EV)
check(not any(p["company_name"] == "ZZ Sound Co" for p in pub),
      "unpublishing removes them from the directory at once")

# ── 7. the real import landed ─────────────────────────────────────────────
real = sql("SELECT COUNT(*), SUM(amount_due), SUM(amount_paid) FROM exhibitors "
           "WHERE event_id=1 AND stage='confirmed'")[0]
check(real[0] == 23, "the 23 confirmed exhibitors are in the system", real[0])
check(int(real[1] or 0) == 111000 and int(real[2] or 0) == 94500,
      "with the booked and collected totals from the sheet", real)
live = sql("SELECT COUNT(*) FROM exhibitors WHERE event_id=1 AND (is_published=1 OR can_scan_leads=1)")[0][0]
check(live == 0, "and none of them is published or scanning until somebody decides", live)

# ── 8. the setup link lets a stand write its own listing ──────────────────
st, link = call("POST", "/exhibitors/%d/activation-link" % VID, None, ADMIN)
check(st == 200 and link.get("url", "").startswith("http"), "an organiser can mint a setup link", link)
T = link["url"].rsplit("/", 1)[-1]
check(len(T) > 20, "the token is long enough not to be guessed", len(T))

st, page = call("GET", "/vendor-setup/%s" % T)
check(st == 200 and page.get("company_name") == "ZZ Sound Co",
      "the stand can open it with no login — the link IS the credential", page)

st, saved = call("POST", "/vendor-setup/%s" % T,
                 {"description": "Sound beds and tuning forks.",
                  "website": "zzsound.example", "publish": True})
check(st == 200 and saved.get("is_published") is True and saved.get("activated") is True,
      "finishing the form publishes them", saved)
st, rows = call("GET", "/events/%d/exhibitors" % EV, token=ADMIN)
mine = [r for r in rows if r["id"] == VID][0]
check(mine["website"] == "https://zzsound.example",
      "a bare domain is stored as a real URL", mine["website"])

# ── 9. what the stand may NOT touch ───────────────────────────────────────
st, _ = call("POST", "/vendor-setup/%s" % T,
             {"description": "still theirs",
              "can_scan_leads": True, "is_published": True,
              "amount_paid": 999999, "payment_status": "paid",
              "package": "Title Sponsor", "booth_number": "1"})
st, rows = call("GET", "/events/%d/exhibitors" % EV, token=ADMIN)
mine = [r for r in rows if r["id"] == VID][0]
check(mine["can_scan_leads"] is True,
      "the scanner grant is whatever the ORGANISER set, untouched", mine["can_scan_leads"])
check(mine["amount_paid"] == 2500 and mine["payment_status"] == "partial",
      "they cannot mark themselves paid", (mine["amount_paid"], mine["payment_status"]))
check(mine["package"] == "The Connector $5000" and mine["booth_number"] == "12",
      "nor change their package or booth", (mine["package"], mine["booth_number"]))
check(mine["description"] == "still theirs", "but their own words did save")

# ── 10. a new link retires the old one ────────────────────────────────────
st, link2 = call("POST", "/exhibitors/%d/activation-link" % VID, None, ADMIN)
T2 = link2["url"].rsplit("/", 1)[-1]
check(T2 != T, "a fresh link is a different token")
st, _ = call("GET", "/vendor-setup/%s" % T)
check(st == 404, "and the previous one stops working")
st, _ = call("GET", "/vendor-setup/%s" % T2)
check(st == 200, "while the new one works")

# ── 11. the setup link is NOT the scanner token ───────────────────────────
scan_token = mine["access_token"]
check(T2 != scan_token and T != scan_token,
      "a setup link and a lead-scanner token are different secrets", )
st, _ = call("GET", "/vendor-setup/%s" % scan_token)
check(st == 404,
      "so a forwarded setup email cannot be swapped for a lead list, or the reverse")

# ── 12. the pipeline: prospects live beside the confirmed stands ──────────
# The sheet keeps maybes and refusals in the same list, separated by a heading.
# That is the right shape, because a maybe becomes confirmed the day they pay --
# but only a confirmed stand should ever reach the attendee directory.
counts = dict(sql("SELECT stage, COUNT(*) FROM exhibitors WHERE event_id=1 GROUP BY stage"))
check(sum(counts.values()) == 52, "the whole vendor board is in the system", counts)
check(counts.get("confirmed") == 23, "23 of them are confirmed", counts.get("confirmed"))
check(counts.get("not_aligned", 0) > 0 and counts.get("next_year", 0) > 0,
      "including the ones deliberately not invited, and next year's", counts)

money = sql("SELECT SUM(amount_due), SUM(amount_paid) FROM exhibitors "
            "WHERE event_id=1 AND stage='confirmed'")[0]
check(int(money[0]) == 111000 and int(money[1]) == 94500,
      "the money belongs to the confirmed stands", money)
pipeline_money = sql("SELECT COALESCE(SUM(amount_due),0) FROM exhibitors "
                     "WHERE event_id=1 AND stage!='confirmed'")[0][0]
check(int(pipeline_money) == 0,
      "a prospect has booked nothing, so it adds nothing to the total", pipeline_money)

live = sql("SELECT COUNT(*) FROM exhibitors WHERE event_id=1 "
           "AND stage!='confirmed' AND (is_published=1 OR can_scan_leads=1)")[0][0]
check(live == 0, "and no prospect is published or scanning", live)

# ── 13. promoting a prospect is one field ─────────────────────────────────
st, p2 = call("POST", "/exhibitors", {
    "event_id": EV, "company_name": "ZZ Maybe Co", "contact_email": "maybe@example.invalid",
    "stage": "unsure"}, ADMIN)
PID = p2["id"]
check(p2.get("stage") == "unsure", "a prospect can be created at its stage", p2.get("stage"))
st, up = call("PUT", "/exhibitors/%d" % PID,
              {"stage": "confirmed", "payment_status": "paid",
               "amount_due": 3500, "amount_paid": 3500}, ADMIN)
check(up.get("stage") == "confirmed" and up.get("payment_status") == "paid",
      "and moves to confirmed when they pay, without being re-typed", up)
check(up.get("is_published") is True and up.get("can_scan_leads") is False,
      "paying does not by itself hand them a scanner", up)
call("DELETE", "/exhibitors/%d" % PID, token=ADMIN)

# ── 14. two kinds of contact, and only one is anybody's to publish ────────
# The website details a company already publishes need no permission. The sheet
# contact is whoever booked the booth -- frequently a personal mobile -- and
# publishing that would be handing out somebody's private number.
st, v3 = call("POST", "/exhibitors", {
    "event_id": EV, "company_name": "ZZ Two Contacts",
    "contact_email": "booker-private@example.invalid", "contact_phone": "+14075550999",
    "public_email": "hello@zztwo.example", "public_phone": "+18005550100",
    "address": "1 Test Way, Orlando, FL 32801",
    "tagline": "A tagline from their own site",
    "description": "What they do.", "stage": "confirmed"}, ADMIN)
V3 = v3["id"]
call("PUT", "/exhibitors/%d" % V3, {"is_published": True}, ADMIN)
st, pub = call("GET", "/public/events/%d/exhibitors" % EV)
e3 = [p for p in pub if p["company_name"] == "ZZ Two Contacts"][0]
check(e3.get("contact_email") == "hello@zztwo.example",
      "the directory shows the PUBLIC email from their website", e3)
check(e3.get("contact_phone") == "+18005550100",
      "and the public switchboard, not the booker's mobile", e3)
raw = json.dumps(pub)
check("booker-private@example.invalid" not in raw and "4075550999" not in raw,
      "the booking contact never reaches the directory, even switched off")
check(e3.get("tagline") == "A tagline from their own site" and e3.get("address"),
      "tagline and address carry across", e3)

# Even when the organiser opts the booking contact in, the public one wins:
# it is the number the company actually answers.
call("PUT", "/exhibitors/%d" % V3, {"show_contact_publicly": True}, ADMIN)
st, pub = call("GET", "/public/events/%d/exhibitors" % EV)
e3 = [p for p in pub if p["company_name"] == "ZZ Two Contacts"][0]
check(e3.get("contact_email") == "hello@zztwo.example",
      "opting in does not replace the public email with the private one", e3)

# With no public detail on file, the opt-in is what the sheet contact needs.
call("PUT", "/exhibitors/%d" % V3, {"public_email": None, "public_phone": None}, ADMIN)
st, pub = call("GET", "/public/events/%d/exhibitors" % EV)
e3 = [p for p in pub if p["company_name"] == "ZZ Two Contacts"][0]
check(e3.get("contact_email") == "booker-private@example.invalid",
      "with nothing public on file, an explicit opt-in still works", e3)
call("PUT", "/exhibitors/%d" % V3, {"show_contact_publicly": False}, ADMIN)
st, pub = call("GET", "/public/events/%d/exhibitors" % EV)
e3 = [p for p in pub if p["company_name"] == "ZZ Two Contacts"][0]
check(e3.get("contact_email") is None, "and switching it off withholds it again")
call("DELETE", "/exhibitors/%d" % V3, token=ADMIN)

# ── 15. the real listings were filled from public sources ─────────────────
enriched = sql("SELECT COUNT(*) FROM exhibitors WHERE event_id=1 "
               "AND logo_url IS NOT NULL AND description IS NOT NULL AND description != ''")[0][0]
check(enriched >= 14, "most confirmed stands have a logo and a description", enriched)
# A public address that happens to equal the sheet contact is not a leak: for a
# one-person business the address on its website IS the address that booked the
# booth. What would be a leak is copying the sheet across without checking, so
# the two known matches are named here — both were read off the company's own
# site independently, and any NEW match means somebody took a shortcut.
SAME_ON_PURPOSE = {"Hair By Mermaid", "Medi Air Purifier"}
same = {r[0] for r in sql("SELECT company_name FROM exhibitors WHERE event_id=1 "
                          "AND public_email IS NOT NULL AND public_email = contact_email")}
check(same == SAME_ON_PURPOSE,
      "the only public addresses matching a sheet contact are the two that genuinely publish it",
      same - SAME_ON_PURPOSE)
mismatch = sql("SELECT COUNT(*) FROM exhibitors WHERE event_id=1 "
               "AND public_phone IS NOT NULL AND public_phone = contact_phone")[0][0]
check(mismatch == 0, "and no sheet phone number was copied into the public field", mismatch)

# ── cleanup ───────────────────────────────────────────────────────────────
call("DELETE", "/exhibitors/%d" % VID, token=ADMIN)
call("DELETE", "/events/%d" % EV, token=ADMIN)
check(sql("SELECT COUNT(*) FROM exhibitors WHERE company_name='ZZ Sound Co'")[0][0] == 0,
      "the throwaway vendor is gone afterwards")

print("\n%d checks, %d failed" % (52, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
