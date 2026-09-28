# -*- coding: utf-8 -*-
"""THE VENDOR SETUP LINK — a stand writing its own listing.

A setup link is a capability URL: whoever holds it can edit exactly one
stand's description, and nothing else in the event. That boundary is the whole
security model, so it is what is pinned hardest here -- a stand must not be
able to move its own booth, mark itself paid, grant itself the lead scanner,
or touch another stand at all.

The rest is the flow itself: the page renders for a stand with a logo and for
one without, a tagline and a logo save the instant they are chosen (so closing
the tab does not lose them), photos and the catalogue save one at a time, and
publishing is a deliberate act rather than a side effect of typing.

Creates its own throwaway stand and deletes it again. No real exhibitor is
touched, and no real setup link is minted or retired.

Run:  python3 /root/event/backend/test_vendor_setup.py
"""
import hashlib, io, json, secrets, sqlite3, sys, warnings
warnings.filterwarnings("ignore", category=DeprecationWarning)
from datetime import datetime, timedelta
import requests

BASE = "https://api.gaiahealers.app"
DB = "/root/event/backend/event.db"
API_ROOT = BASE + "/event-api/vendor-setup/"

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "   %r" % (detail,)))
    if not ok:
        fails.append(label)

def token_hash(tok):
    return hashlib.sha256(("vendor:%s" % tok).encode("utf-8")).hexdigest()

db = sqlite3.connect(DB, timeout=30)
db.isolation_level = None
COLS = [d[1] for d in db.execute("pragma table_info(exhibitors)").fetchall()]

def make_stand(name, logo=None):
    now = datetime.utcnow()
    db.execute("""insert into exhibitors
        (event_id, company_name, booth_number, contact_email, category, description,
         logo_url, is_published, can_scan_leads, payment_status, stage,
         show_contact_publicly, created_at, setup_token_hash, setup_sent_at, setup_expires_at)
        values (1, ?, 'ZZ-TEST', 'zz@example.invalid', 'Testing', 'throwaway',
                ?, 0, 0, 'unpaid', 'other', 0, ?, ?, ?, ?)""",
        (name, logo, now.isoformat(), None, now.isoformat(), (now + timedelta(days=1)).isoformat()))
    eid = db.execute("select last_insert_rowid()").fetchone()[0]
    tok = secrets.token_urlsafe(24)
    db.execute("update exhibitors set setup_token_hash=? where id=?", (token_hash(tok), eid))
    return eid, tok

def row(eid):
    return dict(zip(COLS, db.execute("select * from exhibitors where id=?", (eid,)).fetchone()))

A_ID, A_TOK = make_stand("ZZ SELFTEST A")
B_ID, B_TOK = make_stand("ZZ SELFTEST B", logo="https://example.invalid/logo.png")
A, B = API_ROOT + A_TOK, API_ROOT + B_TOK

PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x08\x00\x00\x00\x08\x08\x02\x00\x00\x00"
       b"\x4b\x6d\x29\xdc\x00\x00\x00\x16IDAT\x18\x57\x63\xf8\xcf\xc0\xf0\x9f\x81\x81\x01\x1a"
       b"\x8c\x8c\x0c\x00\x2a\xc3\x03\x01\x3c\x7b\x5d\x86\x00\x00\x00\x00IEND\xaeB`\x82")

print("THE VENDOR SETUP LINK")
try:
    # ── the page it lands on ───────────────────────────────────────────────
    html = requests.get(BASE + "/vendor/" + A_TOK, timeout=25).text
    check('name="tagline"' in html, "the form asks for a tagline")
    check('id="lgf"' in html and 'id="lgb"' in html, "and offers a logo upload")
    check('id="phb"' in html, "photos can be added")
    check('id="prb"' in html, "and a catalogue")
    check("booth_number" not in html and "can_scan_leads" not in html and "payment_status" not in html,
          "the page never exposes booth, scanner or payment")
    check("<span>No logo</span>" in html and "Choose a logo" in html,
          "a stand with no logo is invited to pick one")
    withlogo = requests.get(BASE + "/vendor/" + B_TOK, timeout=25).text
    check("Change logo" in withlogo and 'class="logobox" id="lgp"><img' in withlogo,
          "and a stand that has one sees it")

    # ── reading and writing its own words ──────────────────────────────────
    r = requests.get(A, timeout=25)
    check(r.status_code == 200, "GET returns the stand's own record", r.status_code)
    check("can_scan_leads" not in json.dumps(r.json() if r.ok else {}),
          "which does not carry the scanner flag")

    check(requests.post(A, json={"tagline": "Six or seven words"}, timeout=25).ok, "a tagline saves")
    check(row(A_ID)["tagline"] == "Six or seven words", "and lands on the row", row(A_ID)["tagline"])
    check(not row(A_ID)["is_published"], "saving a field alone does NOT publish the stand")
    check(row(A_ID)["activated_at"] is None, "nor count as activating it")

    up = requests.post(A + "/images", files={"file": ("l.png", io.BytesIO(PNG), "image/png")}, timeout=30)
    check(up.ok and up.json().get("url"), "an image uploads", (up.status_code, up.text[:100]))
    url = up.json()["url"]
    check(requests.post(A, json={"logo_url": url}, timeout=25).ok, "the logo saves on its own")
    check(row(A_ID)["logo_url"] == url, "and lands on the row")
    served = requests.get(BASE + url if url.startswith("/") else url, timeout=25)
    check(served.ok and served.headers.get("content-type", "").startswith("image/"),
          "and the file is actually served back", served.status_code)

    up2 = requests.post(A + "/images", files={"file": ("p.png", io.BytesIO(PNG), "image/png")}, timeout=30)
    ph = requests.post(A + "/photos", json={"url": up2.json()["url"]}, timeout=25)
    check(ph.ok, "a photo is added", (ph.status_code, ph.text[:100]))
    pid = ph.json().get("id")
    check(any(p.get("id") == pid for p in requests.get(A + "/media", timeout=25).json().get("photos", [])),
          "and shows up in the media list")
    check(requests.post(A + "/products", json={"name": "Thing", "description": "Not real."}, timeout=25).ok,
          "a catalogue item is added")

    # ── the boundary ───────────────────────────────────────────────────────
    before = row(A_ID)
    requests.post(A, json={"booth_number": "Z9", "can_scan_leads": True, "payment_status": "paid",
                           "package": "Platinum", "amount_paid": 9999, "amount_due": 0,
                           "is_published": True, "event_id": 2}, timeout=25)
    after = row(A_ID)
    for field in ("booth_number", "can_scan_leads", "payment_status", "package",
                  "amount_paid", "amount_due", "is_published", "event_id"):
        check(after[field] == before[field], "a stand cannot set its own %s" % field,
              (before[field], after[field]))

    # ── and cannot reach the stand next door ───────────────────────────────
    other = requests.get(B, timeout=25)
    check(other.ok and other.json().get("company_name") == "ZZ SELFTEST B",
          "another link resolves to a DIFFERENT stand")
    x = requests.delete(B + "/photos/%s" % pid, timeout=25)
    check(x.status_code == 404, "and deleting this stand's photo through it is a flat 404", x.status_code)
    check(any(p.get("id") == pid for p in requests.get(A + "/media", timeout=25).json().get("photos", [])),
          "the photo is still there")

    # ── tokens that are not tokens ─────────────────────────────────────────
    check(requests.get(BASE + "/vendor/" + "z" * 30, timeout=25).status_code == 404, "an unknown token is refused")
    check(requests.post(API_ROOT + "z" * 30, json={"tagline": "x"}, timeout=25).status_code == 404,
          "and cannot be written through either")
    check(requests.get(BASE + "/vendor/short", timeout=25).status_code == 404, "a too-short token is refused")

    # ── an expired link is dead, not merely unwelcoming ────────────────────
    db.execute("update exhibitors set setup_expires_at=? where id=?",
               ((datetime.utcnow() - timedelta(days=1)).isoformat(), A_ID))
    check(requests.get(BASE + "/vendor/" + A_TOK, timeout=25).status_code == 404, "an expired link stops opening")
    check(requests.post(A, json={"tagline": "after expiry"}, timeout=25).status_code == 404,
          "and stops writing")
    check(row(A_ID)["tagline"] == "Six or seven words", "so the last good value stands")
    db.execute("update exhibitors set setup_expires_at=? where id=?",
               ((datetime.utcnow() + timedelta(days=1)).isoformat(), A_ID))

    # ── publishing is the deliberate act ───────────────────────────────────
    check(requests.post(A, json={"publish": True}, timeout=25).ok, "finishing the form publishes the stand")
    check(row(A_ID)["is_published"] == 1, "the stand is now in the directory")
    check(row(A_ID)["activated_at"] is not None, "and the activation is stamped")
finally:
    for eid in (A_ID, B_ID):
        db.execute("delete from exhibitor_photos where exhibitor_id=?", (eid,))
        db.execute("delete from exhibitor_products where exhibitor_id=?", (eid,))
        db.execute("delete from exhibitors where id=?", (eid,))
    left = db.execute("select count(*) from exhibitors where company_name like 'ZZ SELFTEST%'").fetchone()[0]
    db.close()
    print("\n(throwaway stands removed: %d left behind)" % left)

total = 40
print("\n%d checks, %d failed" % (total, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
