# -*- coding: utf-8 -*-
"""Controlled live check of the activation code email — ONE email, to ONE staff
address Babak has named. Dry run unless --send is given.

    python3 tools/activation_live_check.py --email staff@gaiahealers.com            # dry run: what would happen
    python3 tools/activation_live_check.py --email staff@gaiahealers.com --send     # sends exactly one code

What it does with --send: one POST to the live proxy's /api/activate/start for
that person's own badge, exactly as their phone would after scanning it. The
proxy emails the code through GHL to that profile's own contact. Nothing else
is called; no password is set (the staff member finishes on their phone or
ignores the email — the code expires in 10 minutes and is single use).

Refuses unless: the address has exactly one Gaia Healers profile (member
card), it is not a guest seat (+seatN), the profile has no password yet, and
no more than 1 send is requested. Prints no code and no personal data besides
the address the operator typed.
"""
import argparse, json, re, sqlite3, sys, urllib.request

DB = "/root/event/backend/event.db"
PROXY = "https://api.gaiahealers.app"
MAX_SENDS = 1

ap = argparse.ArgumentParser()
ap.add_argument("--email", required=True)
ap.add_argument("--send", action="store_true", help="actually send ONE code (needs Babak's approval)")
a = ap.parse_args()
email = a.email.strip().lower()

db = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
cards = db.execute("select id, public_token, contact_id from member_cards where lower(email)=?", (email,)).fetchall()
if len(cards) != 1:
    sys.exit("REFUSED: %d profiles have this email (need exactly 1)." % len(cards))
card_id, token, contact = cards[0]
if re.search(r"\+seat\d+@", email):
    sys.exit("REFUSED: guest seat address (would reach the buyer).")
try:
    has_pw = db.execute("select count(*) from member_credentials where card_id=?", (card_id,)).fetchone()[0] > 0
except sqlite3.OperationalError:
    has_pw = False      # table not created yet = feature not deployed
if has_pw:
    sys.exit("REFUSED: this profile already has a password; pick a staff member who has not activated.")
print("profile found: badge code on file, GHL contact on file: %s, password: none" % ("yes" if contact else "NO"))
print("would POST %s/api/activate/start {token, send_code: true}  -> 1 email via GHL to the profile's own contact" % PROXY)
if not a.send:
    print("DRY RUN — nothing sent. Add --send once Babak approves this exact address.")
    sys.exit(0)
sent = 0
if sent >= MAX_SENDS:
    sys.exit("cap reached")
req = urllib.request.Request(PROXY + "/api/activate/start", method="POST",
                             data=json.dumps({"token": token, "send_code": True}).encode(),
                             headers={"Content-Type": "application/json", "Origin": "https://gaiahealers.app"})
sent += 1
with urllib.request.urlopen(req, timeout=30) as r:
    d = json.loads(r.read().decode() or "{}")
print("result: code_sent=%s desk_only=%s error=%s" % (d.get("code_sent"), d.get("desk_only"), d.get("error") or "-"))
print("Now: the staff member checks their inbox (and spam) for 'Your Gaia Healers code', then scans their badge"
      " and finishes on their phone, or ignores it (expires in 10 minutes).")
