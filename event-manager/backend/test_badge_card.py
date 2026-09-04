# -*- coding: utf-8 -*-
"""BADGE CARD — one printed QR, two uses, one identity.

Proves, against the running service:
  1. every attendee row carries a public token, and one person = one token
     across events (the 2025 and 2026 rows of a returning attendee agree)
  2. the scanner resolves the raw ATT code, the bare token and the printed
     URL to the SAME attendee, and still refuses another event's badge
  3. an unknown token is refused and logged, exactly like an unknown code
  4. the public card is a 404 until claimed, never leaks email/phone unless
     switched on, and the vCard carries only opted-in fields
  5. the thermal label renders at the roll size and encodes the printed URL
  6. undo check-in reverses the flag and leaves an UNDO audit row
  7. a print attempt is recorded once per attempt id and never touches check-in

Run:  python3 /root/event/backend/test_badge_card.py
"""
import json, urllib.request, urllib.error, sqlite3, sys, io, uuid, re

env = {}
for line in open("/root/event/backend/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
SVC = env["IDENTITY_SERVICE_TOKEN"]
BASE = "http://127.0.0.1:8002"
DB = "/root/event/backend/event.db"
EVENT = 1

def call(method, path, body=None, token=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            b = r.read()
            return r.status, (b if raw else json.loads(b or "null")), {k.lower(): v for k, v in r.headers.items()}
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, json.loads(b or "null"), {k.lower(): v for k, v in e.headers.items()}
        except Exception: return e.code, b, dict(e.headers)

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + str(extra))))
    if not cond: fails += 1

print("BADGE CARD")
c = sqlite3.connect(DB)

# 1 ── tokens everywhere, one per person
total, with_tok = c.execute("SELECT count(*), count(public_token) FROM attendees").fetchone()
check(total == with_tok and total > 0, "every attendee row carries a public token", (total, with_tok))
bad = c.execute("SELECT count(*) FROM attendees WHERE public_token NOT GLOB '[A-Z2-9][A-Z2-9][A-Z2-9][A-Z2-9][A-Z2-9][A-Z2-9][A-Z2-9][A-Z2-9]'").fetchone()[0]
check(bad == 0, "tokens use only the unambiguous alphabet (no 0/O/1/I)", bad)
# a person at both events must have ONE token
pairs = c.execute("""SELECT lower(a.email), a.public_token, b.public_token FROM attendees a
                     JOIN attendees b ON lower(a.email)=lower(b.email) AND a.event_id=1 AND b.event_id=2""").fetchall()
disagree = [p for p in pairs if p[1] != p[2]]
check(len(pairs) > 0 and not disagree, "returning attendees (2025+2026) share one token across events",
      "%d pairs, %d disagree" % (len(pairs), len(disagree)))
# token must never be shared by two DIFFERENT people (same event, different email)
# Two rows may share a token only when they are provably the same person:
# same email, or the same GHL contact id (an email change between years).
import json as _json
by_tok = {}
for rid, em, acq, cd, tok in c.execute("SELECT id, lower(email), acq_contact_id, custom_data, public_token FROM attendees"):
    try: cid = (_json.loads(cd) if cd else {}).get("contact_id")
    except Exception: cid = None
    by_tok.setdefault(tok, []).append((em, str(acq or cid or "")))
shared = []
for tok, rows in by_tok.items():
    emails = {r[0] for r in rows}; contacts = {r[1] for r in rows if r[1]}
    if len(emails) > 1 and len(contacts) != 1:
        shared.append((tok, sorted(emails)))
check(not shared, "no token is shared by two different people (email or contact id must agree)", shared[:3])

# 2 ── scanner: three inputs, one attendee
qr, tok, aid, was_in = c.execute(
    "SELECT qr_code, public_token, id, is_checked_in FROM attendees WHERE event_id=? AND is_checked_in=0 ORDER BY id LIMIT 1", (EVENT,)).fetchone()
url = "HTTPS://API.GAIAHEALERS.APP/C/" + tok
results = {}
for label, payload in (("raw", qr), ("token", tok.lower()), ("url", url), ("card-host", "HTTPS://CARD.GAIAHEALERS.APP/" + tok), ("card-host-c", "https://card.gaiahealers.app/c/%s" % tok.lower()), ("url-lower-vcf", "api.gaiahealers.app/c/%s.vcf" % tok.lower())):
    st, d, _ = call("POST", "/events/%d/authorize" % EVENT, {"qr_code": payload, "access_type": "CONFERENCE"}, ADMIN)
    results[label] = (st, d.get("attendee_id"), d.get("qr_code"))
ids = {v[1] for v in results.values()}
check(all(v[0] == 200 for v in results.values()) and ids == {aid}, "raw code, bare token and printed URL resolve to the SAME attendee", results)
check(all(v[2] == qr for v in results.values()), "every form reports the canonical ATT code, never the token", results)
still = c.execute("SELECT is_checked_in FROM attendees WHERE id=?", (aid,)).fetchone()[0]
check(not still, "a CONFERENCE zone scan did not check anyone in (unchanged behaviour)")
# other event's badge is refused here
other_tok = c.execute("SELECT public_token FROM attendees WHERE event_id=2 AND public_token NOT IN (SELECT public_token FROM attendees WHERE event_id=1) LIMIT 1").fetchone()[0]
st, d, _ = call("POST", "/events/%d/authorize" % EVENT, {"qr_code": "https://api.gaiahealers.app/c/" + other_tok}, ADMIN)
check(st == 200 and d.get("result") == "DENIED" and "not valid for this event" in (d.get("reason") or ""), "a 2025-only badge URL is refused at the 2026 door", d)

# 3 ── unknown token: refused AND logged
st, d, _ = call("POST", "/events/%d/authorize" % EVENT, {"qr_code": "https://api.gaiahealers.app/c/ZZZZZZZ2"}, ADMIN)
logged = c.execute("SELECT count(*) FROM scan_logs WHERE qr_code LIKE '%ZZZZZZZ2%' AND result='DENIED'").fetchone()[0]
check(st == 200 and d.get("result") == "DENIED" and logged >= 1, "an unknown token is DENIED and written to the scan log", (st, d.get("result"), logged))

# 4 ── public card
st, body, hdr = call("GET", "/c/" + tok, raw=True)
check(st == 200 and b"Sign in to set up your card" in body and b"@" not in body.split(b"<body")[1].split(b"gaiahealers.app")[0], "unclaimed card renders the claim state and no email", st)
st, body, _ = call("GET", "/c/" + tok + ".vcf", raw=True)
check(st == 404, "no vCard until the card is public", st)
st, body, _ = call("GET", "/c/NOTATOKEN", raw=True)
check(st == 404, "a bad token is a 404 page", st)
# claim it through the identity route (service token), then look again
email = c.execute("SELECT email FROM attendees WHERE id=?", (aid,)).fetchone()[0]
ident = {"email": email, "email_verified": True, "event_id": EVENT}
st, d, _ = call("POST", "/identity/card", ident, SVC)
check(st == 200 and d.get("ok") and d.get("token") == tok and d.get("public") is False, "owner sees their own token and printed URL", d if st != 200 else d.get("token"))
st, d, _ = call("POST", "/identity/card/update", dict(ident, public=True, company="Test Co", title="Founder", city="Orlando",
                                                       website="example.com", instagram="@gaia.test", whatsapp="+1 (407) 555-0100",
                                                       show_email=False, show_phone=False, bio="Testing the card", tags="Reiki, Sound"), SVC)
check(st == 200 and d.get("public") is True and (d.get("fields") or {}).get("website") == "https://example.com" and (d.get("fields") or {}).get("instagram") == "gaia.test", "owner can publish and fields are sanitised", (st, d))
st, body, _ = call("GET", "/c/" + tok.lower(), raw=True)
check(st == 200 and b"Test Co" in body and b"Save contact" in body and email.encode() not in body, "public card shows opted-in fields and NOT the email (switch off)", st)
st, body, _ = call("GET", "/c/" + tok + ".vcf", raw=True)
check(st == 200 and isinstance(body, bytes) and b"ORG:Test Co" in body and b"EMAIL" not in body and b"14075550100" in body, "vCard carries company/whatsapp and no email", (st, body if not isinstance(body, bytes) else body[:200]))
st, d, _ = call("POST", "/identity/card/update", dict(ident, show_email=True), SVC)
st, body, _ = call("GET", "/c/" + tok + ".vcf", raw=True)
check(st == 200 and ("EMAIL;TYPE=INTERNET:" + email).encode() in body, "email appears ONLY after the owner switches it on")
# restore: unpublish and clear what the test wrote
call("POST", "/identity/card/update", dict(ident, public=False, show_email=False, company="", title="", city="", website="", instagram="", whatsapp="", bio="", tags=[]), SVC)
st, body, _ = call("GET", "/c/" + tok + ".vcf", raw=True)
check(st == 404, "unpublishing hides the vCard again", st)

# 4b ── ownership: the session identity, never the URL, decides who may edit
st, own, _ = call("POST", "/identity/card/owner", dict(ident, token=tok), SVC)
check(st == 200 and own.get("owner") is True and own.get("event_id") == EVENT, "the ticket holder is recognised as the badge owner", own)
st, own2, _ = call("POST", "/identity/card/owner", dict(ident, token=other_tok), SVC)
check(st == 200 and own2.get("owner") is False and "event_id" not in own2, "someone else's badge token is NOT theirs, and nothing else is revealed", own2)
st, own3, _ = call("POST", "/identity/card/owner", {"email": email, "email_verified": False, "event_id": EVENT, "token": tok}, SVC)
check(st == 200 and own3.get("owner") is False, "an UNVERIFIED email cannot claim a badge", own3)
st, body, _ = call("GET", "/c/" + tok, raw=True)
check(st == 200 and b"data-claim-link" in body and b"Sign in to set up your card" in body and b"/api/card/owner" in body, "unclaimed page offers sign-in-to-set-up and asks the proxy who is looking", st)
st, d, hdr = call("GET", "/events/%d/attendees/search?q=%s" % (EVENT, urllib.request.quote(email)), token=ADMIN)
check(st == 200 and d and d[0].get("card_state") in ("unclaimed", "private", "public") and (d[0].get("card_url") or "").endswith("/" + tok), "Admin rows carry the badge card link and its state", (d[0].get("card_state"), d[0].get("card_url")) if d else d)

# 5 ── label
st, png, hdr = call("GET", "/events/%d/attendees/%d/badge-label.png" % (EVENT, aid), token=ADMIN, raw=True)
from PIL import Image
im = Image.open(io.BytesIO(png))
import badge_card as _bc2
_w, _h = _bc2.LABEL_SIZES[_bc2.DEFAULT_LABEL]
_exact = (round(_w * 203 / 25.4), round(_h * 203 / 25.4))
check(st == 200 and im.size == _exact and im.mode == "1",
      "the default label is a 1-bit PNG at exactly 203 dpi (%s mm -> %dx%d dots)" % (_bc2.DEFAULT_LABEL, _exact[0], _exact[1]),
      (st, im.size, im.mode, _exact))
check(_bc2.LABEL_STOCKED.get(_bc2.DEFAULT_LABEL) is True,
      "the default roll is one NIIMBOT actually sells (an unbranded roll prints blank)", _bc2.DEFAULT_LABEL)
for _name, (_lw, _lh) in _bc2.LABEL_SIZES.items():
    _png, _meta = _bc2.render_label("Ada", "Lovelace", tok, width_mm=_lw, height_mm=_lh)
    _im = Image.open(io.BytesIO(_png))
    _want = (round(_lw * 203 / 25.4), round(_lh * 203 / 25.4))
    check(_im.size == _want and _im.mode == "1", "roll %s renders dot-exact for the printer" % _name, (_im.size, _want))
import badge_card as _bc
expected = _bc.printed_payload(tok)
check(hdr.get("x-label-payload", "") == expected and expected.startswith("HTTPS://CARD.GAIAHEALERS.APP/"), "label encodes the UPPERCASE printed URL on the card host", (hdr.get("x-label-payload"), expected))
st, _, _ = call("GET", "/events/%d/attendees/%d/badge-label.png?size=99x99" % (EVENT, aid), token=ADMIN, raw=True)
check(st == 400, "an unsupported roll size is refused", st)

# 6 ── undo check-in
st, d, _ = call("POST", "/events/%d/authorize" % EVENT, {"qr_code": url, "access_type": "EVENT_ENTRY"}, ADMIN)
now_in = c.execute("SELECT is_checked_in FROM attendees WHERE id=?", (aid,)).fetchone()[0]
entry_ok = d.get("result") in ("GRANTED", "DENIED")   # date window may deny before the event
if d.get("result") == "GRANTED":
    check(now_in == 1, "EVENT_ENTRY via the printed URL checks the person in")
    st, u, _ = call("POST", "/events/%d/attendees/%d/undo-checkin" % (EVENT, aid), {"reason": "test: wrong person"}, ADMIN)
    back = c.execute("SELECT is_checked_in FROM attendees WHERE id=?", (aid,)).fetchone()[0]
    undo_log = c.execute("SELECT count(*) FROM scan_logs WHERE attendee_id=? AND result='UNDO'", (aid,)).fetchone()[0]
    check(st == 200 and back == 0 and undo_log >= 1, "undo reverses the check-in and leaves an UNDO audit row", (st, back, undo_log))
else:
    print("  SKIP  entry check-in/undo (door closed today: %s)" % d.get("reason"))
    st, u, _ = call("POST", "/events/%d/attendees/%d/undo-checkin" % (EVENT, aid), {"reason": "test: nothing to undo"}, ADMIN)
    check(st == 200 and u.get("already") is True, "undo on someone not checked in is a no-op, not an error", u)
st, u, _ = call("POST", "/events/%d/attendees/%d/undo-checkin" % (EVENT, aid), {"reason": "x"}, ADMIN)
check(st == 400, "undo without a real reason is refused", st)

# 7 ── print record, idempotent, independent of check-in
before_in = c.execute("SELECT is_checked_in, badge_print_count FROM attendees WHERE id=?", (aid,)).fetchone()
att_id = str(uuid.uuid4())
st, p1, _ = call("POST", "/events/%d/attendees/%d/badge-print" % (EVENT, aid), {"result": "printed", "station": "test-desk", "client_attempt_id": att_id}, ADMIN)
st2, p2, _ = call("POST", "/events/%d/attendees/%d/badge-print" % (EVENT, aid), {"result": "printed", "station": "test-desk", "client_attempt_id": att_id}, ADMIN)
after = c.execute("SELECT is_checked_in, badge_print_count, badge_last_result FROM attendees WHERE id=?", (aid,)).fetchone()
check(st == 200 and st2 == 200 and p2.get("already") is True and after[1] == (before_in[1] or 0) + 1, "same attempt id recorded once; print count +1", (p1.get("already"), p2.get("already"), before_in, after))
check(after[0] == before_in[0], "printing did not change check-in state")
st, p3, _ = call("POST", "/events/%d/attendees/%d/badge-print" % (EVENT, aid), {"result": "failed", "station": "test-desk", "error": "printer offline"}, ADMIN)
after2 = c.execute("SELECT badge_print_count, badge_last_result, badge_last_error FROM attendees WHERE id=?", (aid,)).fetchone()
check(after2[0] == after[1] and after2[1] == "failed" and after2[2] == "printer offline", "a failed attempt is recorded without bumping the count", after2)
logs = c.execute("SELECT count(*) FROM badge_print_logs WHERE attendee_id=?", (aid,)).fetchone()[0]
check(logs >= 2, "every attempt is in badge_print_logs", logs)
# tidy the test's own print rows
c.execute("DELETE FROM badge_print_logs WHERE attendee_id=? AND station='test-desk'", (aid,))
c.execute("UPDATE attendees SET badge_print_count=?, badge_last_result=NULL, badge_last_error=NULL, badge_last_station=NULL, badge_printed_at=NULL WHERE id=?", (before_in[1] or 0, aid))
c.commit()

# 8 ── search at the door
for q, want in (("(407) 285-2639", True), ("orourke nicole", True), ("e", True)):
    st, d, hdr = call("GET", "/events/%d/attendees/search?q=%s" % (EVENT, urllib.request.quote(q)), token=ADMIN)
    if q == "e":
        check(st == 200 and len(d) == 50 and hdr.get("x-search-truncated") == "1", "a huge result set says it was cut off", hdr.get("x-search-truncated"))
    else:
        check(st == 200 and len(d) >= 1, "search finds '%s'" % q, len(d))

print()
print("ALL CHECKS PASSED" if not fails else "%d CHECK(S) FAILED" % fails)
sys.exit(1 if fails else 0)
