# -*- coding: utf-8 -*-
"""PROFILE ACTIVATION (9 Nov 2026), on a testbed copy with synthetic people only.

Badge -> 6-digit code -> password -> signed in to the EXISTING Gaia identity.
Covers: new activation, returning person, guest seat on the buyer's mailbox,
shared GHL contact, help-desk code (who/when recorded, code never kept),
password reset, repeated badge scans, wrong / expired / reused codes, lockout,
unauthorised callers, and that tickets, the door and badge printing are
unchanged by any of it.
Run:  ./stage-run.sh python3 test_profile_activation.py   (or from /root/event/backend)
"""
import json, os, secrets, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime, timedelta

HERE = "/root/event/backend"
sys.path.insert(0, HERE)
os.environ["ALLOW_SCAN_TIME_OVERRIDE"] = "1"     # date override for the door check (copy only)
import testbed
BASE, DB = testbed.start()
import main, models    # noqa: E402

env = {}
for line in open(HERE + "/.env"):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
SVC = {"Authorization": "Bearer " + env["IDENTITY_SERVICE_TOKEN"]}
ADMIN = {"Authorization": "Bearer " + main.create_access_token({"sub": "1", "adm": True})}
fails = []


def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)


def call(method, path, body=None, headers=ADMIN, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read()
            if raw:
                return r.status, b
            try: return r.status, json.loads(b.decode() or "null")
            except Exception: return r.status, b
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b


def svc(path, body):
    return call("POST", path, body, headers=SVC)[1]


db = sqlite3.connect(DB, timeout=30)
EV, TAG = 1, secrets.token_hex(3)
call("POST", "/events/%d/door-test-mode" % EV, {"enabled": False})
event_day = db.execute("select date(start_date) from events where id=?", (EV,)).fetchone()[0]


def ticket(who, email=None, contact=None, **extra):
    body = dict({"event_id": EV, "email": email or "zz-%s-%s@example.invalid" % (who, TAG), "first_name": "Zz",
                 "last_name": "%s%s" % (who, TAG), "ticket_type_id": 7}, **extra)
    st, a = call("POST", "/attendees", body)
    assert st == 200, (st, a)
    if contact:
        cd = json.loads(db.execute("select custom_data from attendees where id=?", (a["id"],)).fetchone()[0] or "{}")
        cd["contact_id"] = contact
        db.execute("update attendees set custom_data=? where id=?", (json.dumps(cd), a["id"]))
        db.execute("update member_cards set contact_id=? where public_token=?", (contact, a["public_token"]))
        db.commit()
        assert db.execute("select contact_id from member_cards where public_token=?", (a["public_token"],)).fetchone()[0] == contact
    return a


def row(aid):
    return db.execute("select qr_code, public_token, is_checked_in, custom_data from attendees where id=?", (aid,)).fetchone()


def codes_for(token):
    return db.execute("select count(*) from card_verifications v join member_cards c on c.id=v.card_id "
                      "where c.public_token=?", (token,)).fetchone()[0]


# ── 1. new activation ───────────────────────────────────────────────────────
print("\n== new activation (badge -> code -> password) ==")
a = ticket("new")
TOK = a["public_token"]
before = row(a["id"])
st, label_before = call("GET", "/events/%d/attendees/%d/badge-label.png" % (EV, a["id"]), raw=True)
r = svc("/identity/activate/start", {"token": TOK})
check(r.get("ok") and r.get("has_password") is False and not r.get("desk_only"), "badge scan: profile found, no password yet", r)
check("code" not in r and codes_for(TOK) == 0, "looking at the badge page issues no code")
check(r.get("email_masked", "").startswith("z•••@"), "email shown masked only", r.get("email_masked"))
r = svc("/identity/activate/start", {"token": TOK.lower(), "send_code": True})
code = r.get("code")
check(bool(code) and len(code) == 6 and code.isdigit(), "asking sends a 6-digit code (to the proxy only)")
check(r.get("deliver_to", {}).get("email") == a["email"].lower(), "delivered to the email already on the profile")
stored = db.execute("select * from card_verifications order by id desc limit 1").fetchone()
check(code not in json.dumps([str(x) for x in stored]), "the code is not stored in plain text")
r = svc("/identity/activate/verify", {"token": TOK, "code": "000000" if code != "000000" else "111111"})
check(r.get("ok") is False and r.get("reason") == "code_incorrect", "wrong code refused", r)
r = svc("/identity/activate/complete", {"token": TOK, "permit": "made-up", "password": "long enough pw"})
check(r.get("ok") is False, "no password without a real permit", r)
r = svc("/identity/activate/verify", {"token": TOK, "code": code})
permit = r.get("permit")
check(r.get("ok") and permit, "right code gives a short-lived permit", r)
r = svc("/identity/activate/verify", {"token": TOK, "code": code})
check(r.get("ok") is False, "the same code cannot be used twice", r)
st, r = call("POST", "/identity/activate/complete", {"token": TOK, "permit": permit, "password": "short"}, headers=SVC)
check(st == 400, "fewer than 8 characters refused", (st, r))
r = svc("/identity/activate/complete", {"token": TOK, "permit": permit, "password": "eight ch"})
check(r.get("ok") and r.get("identity", {}).get("email") == a["email"].lower(), "8 characters, no other rules: saved", r)
check(r.get("identity", {}).get("card_token") == TOK, "identity is the same profile")
r = svc("/identity/activate/complete", {"token": TOK, "permit": permit, "password": "another pw 1"})
check(r.get("ok") is False, "the permit is spent once the password is saved", r)
h = db.execute("select password_hash, set_via from member_credentials c join member_cards m on m.id=c.card_id "
               "where m.public_token=?", (TOK,)).fetchone()
check(h and h[0].startswith("$2") and "eight ch" not in h[0], "stored as a bcrypt hash", h and h[0][:4])
after = row(a["id"])
check(after[0] == before[0] and after[1] == before[1], "ticket QR and badge code unchanged by activation")
check(after[2] == before[2], "activation does not check anyone in")

# ── 2. returning person ─────────────────────────────────────────────────────
print("\n== existing member signs in ==")
r = svc("/identity/activate/start", {"token": TOK, "send_code": True})
check(r.get("has_password") and "code" not in r, "second badge scan: offered sign-in, no code sent", r)
check(svc("/identity/activate/login", {"token": TOK, "password": "eight ch"}).get("ok"), "badge + password signs in")
check(svc("/identity/password/login", {"email": a["email"].upper(), "password": "eight ch"}).get("ok"), "email + password signs in")
r = svc("/identity/password/login", {"email": a["email"], "password": "wrong one"})
check(r.get("ok") is False and r.get("reason") == "wrong_email_or_password", "wrong password: generic refusal", r)
r = svc("/identity/password/login", {"email": "nobody-%s@example.invalid" % TAG, "password": "eight ch"})
check(r.get("reason") == "wrong_email_or_password", "unknown email: the same refusal", r)
for _ in range(5):
    svc("/identity/activate/login", {"token": TOK, "password": "bad guess"})
r = svc("/identity/activate/login", {"token": TOK, "password": "eight ch"})
check(r.get("ok") is False and r.get("reason") == "locked", "5 wrong tries lock it for 15 minutes, even the right one", r)
db.execute("update member_credentials set locked_until=? where card_id=(select id from member_cards where public_token=?)",
           ((datetime.utcnow() - timedelta(minutes=1)).isoformat(" "), TOK)); db.commit()
check(svc("/identity/activate/login", {"token": TOK, "password": "eight ch"}).get("ok"), "after the lock passes, the right password works")

# ── 3. repeated scans, wrong and expired codes ──────────────────────────────
print("\n== repeated scans, wrong and expired codes ==")
b = ticket("rpt")
for _ in range(10):
    svc("/identity/activate/start", {"token": b["public_token"]})
check(codes_for(b["public_token"]) == 0, "10 badge scans: no codes issued")
got = [svc("/identity/activate/start", {"token": b["public_token"], "send_code": True}) for _ in range(6)]
check(all(g.get("code") for g in got[:5]) and got[5].get("reason") == "too_many_codes", "at most 5 codes an hour", [g.get("reason") for g in got])
first, last = got[0].get("code"), got[4].get("code")
if first != last:
    r = svc("/identity/activate/verify", {"token": b["public_token"], "code": first})
    check(r.get("ok") is False, "an older code stops working when a new one is sent", r)
db.execute("update card_verifications set expires_at=? where card_id=(select id from member_cards where public_token=?) "
           "and consumed_at is null", ((datetime.utcnow() - timedelta(minutes=1)).isoformat(" "), b["public_token"])); db.commit()
r = svc("/identity/activate/verify", {"token": b["public_token"], "code": last})
check(r.get("ok") is False and r.get("reason") in ("code_expired", "no_code_outstanding"), "an expired code is refused", r)
c = ticket("brute")
code = svc("/identity/activate/start", {"token": c["public_token"], "send_code": True}).get("code")
wrong = "%06d" % ((int(code) + 1) % 1000000)
for _ in range(5):
    svc("/identity/activate/verify", {"token": c["public_token"], "code": wrong})
r = svc("/identity/activate/verify", {"token": c["public_token"], "code": code})
check(r.get("ok") is False, "after 5 wrong tries even the right code is refused", r)
r = svc("/identity/activate/start", {"token": "NOTREAL9", "send_code": True})
check(r.get("ok") is False and r.get("reason") == "unknown_badge", "unknown badge", r)
r = svc("/identity/activate/start", {"token": "x' or 1=1 --", "send_code": True})
check(r.get("reason") == "unknown_badge", "malformed badge code", r)

# ── 4. guest with the purchaser's email, shared contact ─────────────────────
print("\n== guest seat on the buyer's mailbox / shared GHL contact ==")
buyer_mail = "zz-buyer-%s@example.invalid" % TAG
buyer = ticket("buyer", email=buyer_mail, contact="zz-contact-%s" % TAG)
guest = ticket("guest", email=buyer_mail.replace("@", "+seat2@"), contact="zz-contact-%s" % TAG)
r = svc("/identity/activate/start", {"token": guest["public_token"], "send_code": True})
check(r.get("desk_only") and "code" not in r, "guest seat: never emailed (it would reach the buyer) - help desk instead", r)
st, d = call("POST", "/events/%d/attendees/%d/activation-code" % (EV, guest["id"]))
check(st == 200 and len(d.get("code", "")) == 6, "help desk issues the guest a code", (st, d))
p = svc("/identity/activate/verify", {"token": guest["public_token"], "code": d.get("code")}).get("permit")
r = svc("/identity/activate/complete", {"token": guest["public_token"], "permit": p, "password": "guest pass", "via": "desk_code"})
ident = r.get("identity", {})
check(r.get("ok") and ident.get("contact_id") == "", "guest signs in WITHOUT the buyer's GHL contact", ident)
check(ident.get("ghl_lookup") is False, "and the proxy is told not to look the seat address up in GHL", ident)
check(ident.get("card_token") == guest["public_token"] and ident.get("card_token") != buyer["public_token"], "guest keeps their own profile")
code = svc("/identity/activate/start", {"token": buyer["public_token"], "send_code": True}).get("code")
p = svc("/identity/activate/verify", {"token": buyer["public_token"], "code": code}).get("permit")
ident = svc("/identity/activate/complete", {"token": buyer["public_token"], "permit": p, "password": "buyer pass"}).get("identity", {})
check(ident.get("contact_id") == "", "buyer on a contact shared with a guest: no contact id either (no merge on shared contact)", ident)
check(svc("/identity/password/login", {"email": buyer_mail, "password": "guest pass"}).get("ok") is False,
      "the guest's password does not open the buyer's profile")
solo = ticket("solo", contact="zz-solo-%s" % TAG)
code = svc("/identity/activate/start", {"token": solo["public_token"], "send_code": True}).get("code")
p = svc("/identity/activate/verify", {"token": solo["public_token"], "code": code}).get("permit")
ident = svc("/identity/activate/complete", {"token": solo["public_token"], "permit": p, "password": "solo pass"}).get("identity", {})
check(ident.get("contact_id") == "zz-solo-%s" % TAG, "a contact that is theirs alone is kept (GHL association preserved)", ident)

# ── 5. help desk ─────────────────────────────────────────────────────────────
print("\n== help-desk code ==")
e = ticket("desk")
st, d = call("POST", "/events/%d/attendees/%d/activation-code" % (EV, e["id"]))
check(st == 200 and d.get("minutes") == 10, "desk code issued, 10 minutes", (st, d))
cd = row(e["id"])[3] or ""
check("activation_code_issued" in cd, "ticket history records the desk code")
check(d.get("code") not in cd, "the history never contains the code")
rec = [x for x in json.loads(cd).get("lifecycle", []) if x.get("action") == "activation_code_issued"]
check(bool(rec) and rec[-1].get("actor") and rec[-1].get("ts"), "who and when are recorded", rec[-1:] )
r = svc("/identity/activate/verify", {"token": e["public_token"], "code": d.get("code")})
check(r.get("ok"), "desk code works on the badge page", r)
st, _ = call("POST", "/events/%d/attendees/%d/activation-code" % (EV, e["id"]), headers={})
check(st in (401, 403), "no staff sign-in: refused", st)
sess = __import__("database").SessionLocal()
nobody = models.User(email="zz-nocap-%s@gaiahealers.test" % TAG, full_name="No Cap", hashed_password="x", is_admin=False)
sess.add(nobody); sess.commit()
st, _ = call("POST", "/events/%d/attendees/%d/activation-code" % (EV, e["id"]),
             headers={"Authorization": "Bearer " + main.create_access_token({"sub": str(nobody.id)})})
check(st == 403, "signed-in user without door rights: refused", st)
sess.close()

# ── 6. password reset ───────────────────────────────────────────────────────
print("\n== password reset ==")
r = svc("/identity/password/forgot", {"email": "nobody-%s@example.invalid" % TAG})
check(r.get("ok") and "code" not in r, "unknown address: same ok, nothing issued", r)
r = svc("/identity/password/forgot", {"email": a["email"]})
rc = r.get("code")
check(bool(rc), "known address: a reset code to the profile email")
r = svc("/identity/password/reset", {"email": a["email"], "code": "%06d" % ((int(rc) + 1) % 1000000), "password": "brand new pw"})
check(r.get("ok") is False, "wrong reset code refused", r)
r = svc("/identity/password/reset", {"email": a["email"], "code": rc, "password": "brand new pw"})
check(r.get("ok"), "right reset code sets the new password", r)
check(svc("/identity/password/login", {"email": a["email"], "password": "eight ch"}).get("ok") is False, "old password no longer works")
check(svc("/identity/password/login", {"email": a["email"], "password": "brand new pw"}).get("ok"), "new password works")
r = svc("/identity/password/forgot", {"email": guest["email"]})
check("code" not in r, "a guest seat's reset is never emailed to the buyer's mailbox", r)

# ── 7. unauthorised callers ─────────────────────────────────────────────────
print("\n== unauthorised callers ==")
for path in ("/identity/activate/start", "/identity/activate/verify", "/identity/activate/complete",
             "/identity/activate/login", "/identity/password/login", "/identity/password/forgot", "/identity/password/reset"):
    st1, _ = call("POST", path, {"token": TOK, "email": a["email"]}, headers={})
    st2, _ = call("POST", path, {"token": TOK, "email": a["email"]}, headers={"Authorization": "Bearer not-the-token"})
    st3, _ = call("POST", path, {"token": TOK, "email": a["email"]}, headers=ADMIN)
    check(st1 in (401, 403) and st2 in (401, 403) and st3 in (401, 403), "%s: service token only" % path, (st1, st2, st3))

# ── 8. door, tickets and printing unaffected ────────────────────────────────
print("\n== door, tickets and printing unchanged ==")
r = call("POST", "/events/%d/authorize" % EV, {"qr_code": a["qr_code"], "access_type": "EVENT_ENTRY", "at": event_day,
                                                "scan_id": secrets.token_hex(12)})[1]
check(r.get("result") == "GRANTED", "the ticket QR still admits as before", (r.get("result"), r.get("reason")))
r = call("POST", "/events/%d/authorize" % EV, {"qr_code": TOK, "access_type": "EVENT_ENTRY", "at": event_day,
                                                "scan_id": secrets.token_hex(12)})[1]
check(r.get("result") in ("LIMITED", "GRANTED"), "the badge code at the door behaves as before", (r.get("result"), r.get("reason")))
st, label_after = call("GET", "/events/%d/attendees/%d/badge-label.png" % (EV, a["id"]), raw=True)
check(st == 200 and label_after == label_before, "badge label prints byte-for-byte the same after activation", (st, len(label_after or b""), len(label_before or b"")))
st, page = call("GET", "/c/" + TOK, headers={}, raw=True)
check(st == 200 and b"activate.html?card=" + TOK.encode() in page, "badge page links to activation by badge code only")
check(b"ATT-" not in page and a["qr_code"].encode() not in page, "badge page never shows the ticket entry code")
check(b"Open my Gaia Healers profile" in page and b"d.owner" in page, "badge page offers its signed-in owner a link to their event profile (decided in the owner's browser only)")
src = open(os.path.join(HERE, "member_auth.py")).read()
check("print(" not in src and "logger" not in src and "logging" not in src, "activation code never logs")

testbed.stop() if hasattr(testbed, "stop") else None
print("\n%s  (%d failed)" % ("ALL PASS" if not fails else "FAILURES", len(fails)))
sys.exit(1 if fails else 0)
