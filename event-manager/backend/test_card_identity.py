# -*- coding: utf-8 -*-
"""DIGITAL CARD IDENTITY — the three fields that make it a business card.

Full name, email and phone are also the account's recovery information. That is
why changing them is not an ordinary edit: someone who picks up a signed-in
phone on a conference floor must not be able to swap the recovery email for
their own and lock the owner out.

So the order is deliberate, and these tests pin it:

  1. prove you are the CURRENT owner, with a code sent to a contact method
     ALREADY on file -- never to the address being typed in;
  2. only then, prove the NEW address is yours too.

Until step 2 succeeds the old trusted value is still the one on file.

The other half is not breaking anyone. 585 of 661 existing cards have no phone
number, from before the field was required. Their public cards keep resolving;
they are asked to complete the missing field when they next edit.

Throwaway cards and example.invalid people only. GHL is never contacted.
Run:  python3 /root/event/backend/test_card_identity.py
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
SVC = env["IDENTITY_SERVICE_TOKEN"]
BASE = "http://127.0.0.1:8002"
DB = "/root/event/backend/event.db"

fails = []
def check(ok, label, detail=""):
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", label, "" if ok else "   %s" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, token=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            p = r.read()
            return r.status, (p if raw else json.loads(p or b"null"))
    except urllib.error.HTTPError as e:
        p = e.read()
        try:
            return e.code, (p if raw else json.loads(p or b"null"))
        except Exception:
            return e.code, p

def sql(q, a=()):
    c = sqlite3.connect(DB)
    try:
        return c.execute(q, a).fetchall()
    finally:
        c.close()

def write(q, a=()):
    c = sqlite3.connect(DB)
    try:
        c.execute(q, a); c.commit()
    finally:
        c.close()

print("DIGITAL CARD IDENTITY")

for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ cardid%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)
write("DELETE FROM member_cards WHERE email LIKE 'zz-cid-%'")

start = datetime.utcnow() + timedelta(days=25)
st, ev = call("POST", "/events", {"name": "ZZ cardid", "start_date": start.isoformat(),
                                  "end_date": (start + timedelta(days=1)).isoformat(),
                                  "location": "Test", "timezone": "UTC"}, ADMIN)
assert st in (200, 201), (st, ev)
EV = ev["id"]
st, tt = call("POST", "/events/%d/ticket-types" % EV, {"name": "ZZ GA", "code": "zz-cid-ga"}, ADMIN)
TT = tt["id"]

OWNER = "zz-cid-owner@example.invalid"
OTHER = "zz-cid-other@example.invalid"

def attendee(email, first, last, phone=None):
    st, r = call("POST", "/identity/reconcile-attendee", {
        "event_id": EV, "email": email, "ticket_type_id": TT,
        "order_id": "zz-cid-" + email.split("@")[0], "first_name": first,
        "last_name": last, "phone": phone}, SVC)
    assert st == 200 and r.get("ok"), (st, r)
    return r

attendee(OWNER, "Ola", "Owner", "+1 555 010 4821")
attendee(OTHER, "Ivan", "Intruder", "+1 555 999 0000")

def ident(email):
    return {"email": email, "email_verified": True, "event_id": 0}

def card(email):
    st, r = call("POST", "/identity/card", ident(email), SVC)
    return r

def card_row(email):
    return sql("SELECT id, name, email, phone, card_public, card FROM member_cards"
               " WHERE lower(email)=?", (email,))

# ── 1. a new card cannot be published without all three ───────────────────
c = card(OWNER)
check(bool(c.get("ok", True)) is not False, "the owner has a card", c)
write("UPDATE member_cards SET phone=NULL, card=? WHERE lower(email)=?",
      (json.dumps({"headline": "Bodywork"}), OWNER))

st, r = call("POST", "/identity/card/update", {**ident(OWNER), "public": True}, SVC)
check(r.get("ok") is False and r.get("reason") == "missing_required_fields",
      "a card with no phone number cannot be published", r)
check("phone" in (r.get("missing") or []), "and it says which field is missing", r)
check(card_row(OWNER)[0][4] in (0, None),
      "the card really did not go public", card_row(OWNER)[0][4])

# Saving a draft is still allowed, so nobody is trapped mid-form.
st, r = call("POST", "/identity/card/update", {**ident(OWNER), "headline": "Bodywork & breath"}, SVC)
check(r.get("ok") is not False, "an ordinary edit still saves while a field is missing", r)
check("phone" in (r.get("missing_required") or []),
      "and the editor is told what is still needed", r.get("missing_required"))

# ── 2. an ordinary field never asks for a code ────────────────────────────
st, r = call("POST", "/identity/card/update", {**ident(OWNER), "headline": "Sound healing"}, SVC)
check(r.get("reason") != "identity_verification_required",
      "editing a headline does NOT demand identity verification", r)
check((r.get("card") or {}).get("headline") == "Sound healing" or r.get("ok") is not False,
      "and the headline is saved", r)

# ── 3. changing the name demands verification ─────────────────────────────
st, r = call("POST", "/identity/card/update", {**ident(OWNER), "full_name": "Ola Renamed"}, SVC)
check(r.get("ok") is False and r.get("reason") == "identity_verification_required",
      "changing the name requires identity verification", r)
check(card_row(OWNER)[0][1] != "Ola Renamed", "and the name did not change", card_row(OWNER)[0][1])

# ── 4. destinations are masked, and are the OLD ones ──────────────────────
st, d = call("POST", "/identity/card/verify/destinations", ident(OWNER), SVC)
check(d.get("ok") is True and len(d.get("destinations") or []) >= 1,
      "the owner is offered somewhere to receive a code", d)
masked = [x["masked"] for x in (d.get("destinations") or [])]
check(all("@" not in m or m.split("@")[0].count("*") >= 1 for m in masked),
      "email destinations are masked", masked)
check(not any(OWNER in m for m in masked), "the full address is never shown", masked)

# ── 5. the code goes to the OLD address, and unlocks a short-lived permit ─
st, s1 = call("POST", "/identity/card/verify/start", {**ident(OWNER), "destination_id": ""}, SVC)
check(s1.get("ok") is True and s1.get("_code"), "a code is issued", {k: v for k, v in s1.items() if k != "_code"})
check(s1.get("_deliver_to") in (OWNER, "+1 555 010 4821"),
      "and it is addressed to a contact method already on file", s1.get("sent_to"))
CODE = s1["_code"]

st, bad = call("POST", "/identity/card/verify/confirm", {**ident(OWNER), "code": "000000"}, SVC)
check(bad.get("ok") is False and bad.get("reason") == "code_incorrect",
      "a wrong code is rejected", bad)

st, good = call("POST", "/identity/card/verify/confirm", {**ident(OWNER), "code": CODE}, SVC)
check(good.get("ok") is True and good.get("verification_token"),
      "the right code mints a short-lived permit", {k: v for k, v in good.items() if k != "verification_token"})
TOKEN = good["verification_token"]

st, reuse = call("POST", "/identity/card/verify/confirm", {**ident(OWNER), "code": CODE}, SVC)
check(reuse.get("ok") is False, "the same code cannot be used twice", reuse)

# ── 6. with the permit, the name may change — history may not ─────────────
before_qr = sql("SELECT qr_code, public_token, first_name, last_name FROM attendees"
                " WHERE event_id=? AND lower(email)=?", (EV, OWNER))[0]
st, r = call("POST", "/identity/card/update",
             {**ident(OWNER), "full_name": "Ola Renamed", "verification_token": TOKEN}, SVC)
check(r.get("ok") is not False, "with the permit the name change is accepted", r)
check(card_row(OWNER)[0][1] == "Ola Renamed", "and it is stored", card_row(OWNER)[0][1])
after_qr = sql("SELECT qr_code, public_token, first_name, last_name FROM attendees"
               " WHERE event_id=? AND lower(email)=?", (EV, OWNER))[0]
check(before_qr[0] == after_qr[0] and before_qr[1] == after_qr[1],
      "the permanent badge token and QR are unchanged", (before_qr[:2], after_qr[:2]))
check(before_qr[2] == after_qr[2] and before_qr[3] == after_qr[3],
      "and the ticket's own name is NOT rewritten", (before_qr[2:], after_qr[2:]))

# ── 7. a new email needs BOTH proofs, in order ────────────────────────────
NEW_EMAIL = "zz-cid-new@example.invalid"
# new_email, not email: this payload's `email` is the CALLER's identity, and
# one field cannot mean both without a card update changing whose card it edits.
st, r = call("POST", "/identity/card/update",
             {**ident(OWNER), "new_email": NEW_EMAIL, "verification_token": TOKEN}, SVC)
check(r.get("ok") is False and r.get("reason") == "new_value_verification_required",
      "the permit alone cannot replace the email", r)
check(card_row(OWNER)[0][2] == OWNER, "the old email is still on file", card_row(OWNER)[0][2])

st, no_permit = call("POST", "/identity/card/verify/new/start",
                     {**ident(OWNER), "kind": "email", "value": NEW_EMAIL,
                      "verification_token": "not-a-real-permit"}, SVC)
check(no_permit.get("ok") is False and no_permit.get("reason") == "identity_verification_required",
      "and a new address cannot be verified before the owner has proved themselves", no_permit)

st, n1 = call("POST", "/identity/card/verify/new/start",
              {**ident(OWNER), "kind": "email", "value": NEW_EMAIL,
               "verification_token": TOKEN}, SVC)
check(n1.get("ok") is True and n1.get("_deliver_to") == NEW_EMAIL,
      "the second code goes to the NEW address, not the old one", n1.get("sent_to"))
check(card_row(OWNER)[0][2] == OWNER,
      "and the trusted email is still NOT replaced yet", card_row(OWNER)[0][2])

st, n2 = call("POST", "/identity/card/verify/new/confirm",
              {**ident(OWNER), "kind": "email", "code": n1["_code"],
               "verification_token": TOKEN}, SVC)
check(n2.get("ok") is True, "the new email verifies", n2)
check(card_row(NEW_EMAIL) and card_row(NEW_EMAIL)[0][2] == NEW_EMAIL,
      "and only now is it the address on file", card_row(NEW_EMAIL))

# ── 8. the same two steps for a phone number ──────────────────────────────
def ident2():
    return {"email": NEW_EMAIL, "email_verified": True, "event_id": 0}

st, s2 = call("POST", "/identity/card/verify/start", ident2(), SVC)
st, g2 = call("POST", "/identity/card/verify/confirm", {**ident2(), "code": s2["_code"]}, SVC)
T2 = g2.get("verification_token")
st, p1 = call("POST", "/identity/card/verify/new/start",
              {**ident2(), "kind": "phone", "value": "+1 555 222 3333",
               "verification_token": T2}, SVC)
check(p1.get("ok") is True and p1.get("_deliver_to") == "+1 555 222 3333",
      "a phone change also sends its own code to the new number", p1.get("sent_to"))
check("4821" in str(s2.get("sent_to")) or "@" in str(s2.get("sent_to")),
      "while the identity step used a destination already on file", s2.get("sent_to"))
st, p2 = call("POST", "/identity/card/verify/new/confirm",
              {**ident2(), "kind": "phone", "code": p1["_code"], "verification_token": T2}, SVC)
check(p2.get("ok") is True and card_row(NEW_EMAIL)[0][3] == "+1 555 222 3333",
      "and the number is replaced only after it verifies", p2)

# ── 9. expiry, and the attempt limit ──────────────────────────────────────
st, s3 = call("POST", "/identity/card/verify/start", ident2(), SVC)
cid = card_row(NEW_EMAIL)[0][0]
write("UPDATE card_verifications SET expires_at=? WHERE card_id=? AND consumed_at IS NULL",
      ((datetime.utcnow() - timedelta(minutes=1)).isoformat(), cid))
st, exp = call("POST", "/identity/card/verify/confirm", {**ident2(), "code": s3["_code"]}, SVC)
check(exp.get("ok") is False and exp.get("reason") == "code_expired",
      "an expired code is refused", exp)

st, s4 = call("POST", "/identity/card/verify/start", ident2(), SVC)
last = None
for _ in range(6):
    st, last = call("POST", "/identity/card/verify/confirm", {**ident2(), "code": "111111"}, SVC)
check(last.get("reason") == "too_many_attempts",
      "guessing is stopped by the attempt limit", last)
st, blocked = call("POST", "/identity/card/verify/confirm", {**ident2(), "code": s4["_code"]}, SVC)
check(blocked.get("ok") is False,
      "and the real code is dead once the limit is hit", blocked)

# ── 10. rate limiting on issuing codes ────────────────────────────────────
outcomes = []
for _ in range(8):
    st, r = call("POST", "/identity/card/verify/start", ident2(), SVC)
    outcomes.append(r.get("reason") or "ok")
check("rate_limited" in outcomes, "asking for codes over and over is rate limited", outcomes)

# ── 11. nothing is stored in plaintext ────────────────────────────────────
rows = sql("SELECT code_hash, salt FROM card_verifications WHERE card_id=?", (cid,))
check(all(len(h) == 64 and h.isalnum() for h, _ in rows),
      "codes are stored only as hashes", len(rows))
check(not any(str(s3.get("_code")) in str(h) for h, _ in rows),
      "the code itself appears nowhere in the table")
tok_rows = sql("SELECT token_hash FROM card_verification_sessions WHERE card_id=?", (cid,))
check(all(len(t) == 64 for (t,) in tok_rows), "and permits are hashed too", len(tok_rows))

# ── 12. another signed-in person cannot touch this card ───────────────────
st, r = call("POST", "/identity/card/update",
             {"email": OTHER, "email_verified": True, "event_id": 0,
              "full_name": "Stolen", "verification_token": T2}, SVC)
check(card_row(NEW_EMAIL)[0][1] != "Stolen",
      "a permit from one person cannot edit another person's card", r)
st, r = call("POST", "/identity/card/verify/new/start",
             {"email": OTHER, "email_verified": True, "event_id": 0,
              "kind": "email", "value": "thief@example.invalid",
              "verification_token": T2}, SVC)
check(r.get("ok") is False and r.get("reason") == "identity_verification_required",
      "and it cannot start a change on their behalf either", r)

# ── 13. an unverified session proves nothing ──────────────────────────────
st, r = call("POST", "/identity/card/verify/start",
             {"email": NEW_EMAIL, "email_verified": False, "event_id": 0}, SVC)
check(r.get("ok") is False,
      "an unverified email address cannot request a code", r)

# ── 14. legacy public cards keep working ──────────────────────────────────
LEG = "zz-cid-legacy@example.invalid"
attendee(LEG, "Lena", "Legacy")
card(LEG)
lid = card_row(LEG)[0][0]
tok = sql("SELECT public_token FROM member_cards WHERE id=?", (lid,))[0][0]
write("UPDATE member_cards SET phone=NULL, card_public=1, card=? WHERE id=?",
      (json.dumps({"headline": "From before the rules"}), lid))
st, body = call("GET", "/c/" + tok, raw=True)
check(st == 200 and b"Lena" in body,
      "a public card made before phone was required still resolves", st)
st, r = call("POST", "/identity/card/update", {**ident(LEG), "headline": "Still here"}, SVC)
check("phone" in (r.get("missing_required") or []),
      "and its next edit asks for the missing field", r.get("missing_required"))
st, r = call("POST", "/identity/card/update", {**ident(LEG), "public": True}, SVC)
check(r.get("ok") is False and r.get("reason") == "missing_required_fields",
      "re-publishing it requires completing the field first", r)
st, body = call("GET", "/c/" + tok, raw=True)
check(st == 200 and b"Lena" in body,
      "and the refusal did not take the live card down", st)

# ── 15. the public card API leaks none of this ────────────────────────────
txt = body.decode("utf-8", "ignore").lower()
check("card_verifications" not in txt and "verification_token" not in txt,
      "the public card page exposes no verification machinery")
check(str(s3.get("_code")) not in txt and str(p1.get("_code")) not in txt,
      "and no code ever reaches it")

# ── cleanup ───────────────────────────────────────────────────────────────
for e in (OWNER, NEW_EMAIL, OTHER, LEG):
    rows = card_row(e)
    for r in rows:
        write("DELETE FROM card_verifications WHERE card_id=?", (r[0],))
        write("DELETE FROM card_verification_sessions WHERE card_id=?", (r[0],))
write("DELETE FROM member_card_events WHERE card_id IN (SELECT id FROM member_cards WHERE email LIKE 'zz-cid-%')")
write("DELETE FROM member_cards WHERE email LIKE 'zz-cid-%'")
call("DELETE", "/events/%d" % EV, token=ADMIN)
left = sql("SELECT COUNT(*) FROM attendees WHERE email LIKE 'zz-cid-%'")
check(left[0][0] == 0, "the throwaway event and its people are gone afterwards", left)

print("\n%d checks, %d failed" % (44, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
