# -*- coding: utf-8 -*-
"""VOLUNTEER INVITATIONS WHEN SENDING IS ON (7 Nov 2026), with a FAKE mailer:
no network call and no email can leave a test. The preview says who can be
emailed and why not; the admin confirms the exact number; statuses move
not sent -> sent -> opened their page; a new link restarts it; resend works.
Run:  python3 /root/event/backend/test_volunteer_invites.py
"""
import json, os, secrets, sqlite3, sys, urllib.error, urllib.request
HERE = "/root/event/backend"
sys.path.insert(0, HERE)
os.environ["VOLUNTEER_INVITES_FAKE"] = "1"
os.environ["VOLUNTEER_INVITES_ENABLED"] = "1"
import testbed
BASE, DB = testbed.start()
import main                                                    # noqa: E402
ADMIN = {"Authorization": "Bearer " + main.create_access_token({"sub": "1", "adm": True})}
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)
def call(m, p, b=None, h=ADMIN):
    req = urllib.request.Request(BASE + p, data=json.dumps(b).encode() if b is not None else None, method=m, headers=dict({"Content-Type": "application/json"}, **(h or {})))
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, json.loads(t)
        except Exception: return e.code, t
db = sqlite3.connect(DB, timeout=30)
T = secrets.token_hex(3)
call("GET", "/events/1/volunteers/overview")
def add(n, email, approve=True):
    st, r = call("POST", "/events/1/volunteers", {"first_name": n, "last_name": "Inv", "email": email, "phone": "5551112222"})
    assert st == 200, r
    return r["id"], r["token"]
ok_id, ok_tok = add("Ok", "zz-ok-%s@example.invalid" % T)
nog, _ = add("Nog", "zz-nog-%s@not-in-ghl.invalid" % T)
dnd, _ = add("Dnd", "zz-dnd-%s@dnd.invalid" % T)
noe, _ = add("Noe", None)
st, pv = call("POST", "/events/1/volunteers/invite-preview", {"volunteer_ids": [ok_id, nog, dnd, noe]})
why = {r["id"]: r["reason"] for r in pv["recipients"]}
check(pv["sending_enabled"] and pv["can_send"] == 1, "preview: one of four can be emailed", pv)
check("not found in GHL" in why[nog] and "do not disturb" in why[dnd] and "no email" in why[noe], "and says why not for the others", why)
st, r = call("POST", "/events/1/volunteers/invite", {"volunteer_ids": [ok_id, nog, dnd, noe], "confirm_count": 4})
check(st == 409, "sending refuses a count that does not match the preview", st)
st, r = call("POST", "/events/1/volunteers/invite", {"volunteer_ids": [ok_id, nog, dnd, noe], "confirm_count": 1})
check(st == 200 and r["sent"] == 1, "sending the reviewed list sends exactly one", r)
check(db.execute("select invite_status from volunteers where id=?", (ok_id,)).fetchone()[0] == "sent", "status: sent", None)
st, r = call("POST", "/events/1/volunteers/invite-preview", {"volunteer_ids": [ok_id]})
check(r["can_send"] == 0 and "Resend" in r["recipients"][0]["reason"], "a second plain send is refused: use Resend", r)
st, r = call("POST", "/events/1/volunteers/invite", {"volunteer_ids": [ok_id], "confirm_count": 1, "resend": True})
check(st == 200 and r["sent"] == 1, "Resend works", r)
call("GET", "/volunteer/%s" % ok_tok, h={})
check(db.execute("select invite_status from volunteers where id=?", (ok_id,)).fetchone()[0] == "accepted", "opening the page marks it accepted", None)
st, r = call("PATCH", "/events/1/volunteers/%d" % ok_id, {"new_link": True})
row = db.execute("select invite_status, token from volunteers where id=?", (ok_id,)).fetchone()
check(row[0] == "not_sent" and row[1] != ok_tok and call("GET", "/volunteer/%s" % ok_tok, h={})[0] == 404, "a new link kills the old one and restarts the invitation", row)
st, r = call("POST", "/events/1/volunteers/invite-status-refresh")
check(st == 200, "status refresh runs", (st, r))
pend = db.execute("insert into volunteers(event_id, first_name, last_name, email, status, token, source) values(1,'Pen','D','zz-pen-%s@example.invalid','pending','%s','join_form')" % (T, "p" * 32)).lastrowid
db.commit()
st, r = call("POST", "/events/1/volunteers/invite-preview", {"volunteer_ids": [pend]})
check(r["can_send"] == 0 and "not approved" in r["recipients"][0]["reason"], "a pending registration is never invited", r)
print("\n%d check(s) failed" % len(fails) if fails else "\nALL CHECKS PASSED")
sys.exit(1 if fails else 0)
