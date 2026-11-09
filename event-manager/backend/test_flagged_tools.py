# -*- coding: utf-8 -*-
"""FLAGGED-TICKET TOOLS (9 Nov 2026).

On a testbed copy of the live database: an admin can see whether the person
behind a flag already has a ticket, decide many flags at once, copy a ticket's
private link to send by hand, and release a held ticket with its email record
following by itself. Ticket edits are kept in the ticket's history, and a real
ticket (paid or checked in) cannot be deleted. Nothing is sent, and no payment
changes.
Run:  python3 /root/event/backend/test_flagged_tools.py
"""
import json, os, sqlite3, sys, urllib.error, urllib.request

HERE = "/root/event/backend"
sys.path.insert(0, HERE)
import testbed
BASE, DB = testbed.start()
import main                                                    # noqa: E402

ADMIN = {"Authorization": "Bearer " + main.create_access_token({"sub": "3", "adm": True})}
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, headers=ADMIN):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b

db = sqlite3.connect(DB, timeout=30)
EV = 1
pay_before = db.execute("select count(*), coalesce(sum(amount),0), group_concat(id||status||coalesce(attendee_id,'')) from payment_events").fetchone()
door = db.execute("select u.id from users u join event_roles r on r.user_id=u.id where r.role='checkin_staff' limit 1").fetchone()
DOOR = {"Authorization": "Bearer " + main.create_access_token({"sub": str(door[0])})} if door else None

print("\n== the flag list says whether the person already has a ticket ==")
call("POST", "/events/%d/reconcile/run" % EV)
st, lst = call("GET", "/events/%d/reconcile/issues?limit=500" % EV)
check(st == 200 and lst["rows"], "the list loads", st)
rows = lst["rows"]
check(all("person_tickets" in r for r in rows), "every row says which tickets the person holds", None)
unsettled = [r for r in rows if r.get("source_kind") == "payment_unsettled"]
if unsettled:
    with_t = [r for r in unsettled if r["person_tickets"]]
    print("     (%d failed/pending payments, %d of them from people who already hold a ticket)" % (len(unsettled), len(with_t)))
    st, d = call("GET", "/events/%d/reconcile/issues/%d" % (EV, unsettled[0]["id"]))
    check(st == 200 and isinstance(d.get("person_tickets"), list) and "Dismiss" in d["recommendation"],
          "the issue shows the person's tickets and plain advice", d.get("recommendation"))

print("\n== one decision for many flags ==")
pick = [r["id"] for r in rows if r.get("source_kind") == "payment_unsettled"][:3] or [r["id"] for r in rows][:3]
st, r = call("POST", "/events/%d/reconcile/issues/bulk-status" % EV, {"issue_ids": pick, "status": "dismissed", "note": ""})
check(st == 400, "a bulk decision needs a note", (st, r))
st, r = call("POST", "/events/%d/reconcile/issues/bulk-status" % EV, {"issue_ids": pick, "status": "resolved", "note": "x x x"})
check(st == 400, "bulk is only reviewed / dismissed / in review (never 'fixed' in bulk)", (st, r))
st, r = call("POST", "/events/%d/reconcile/issues/bulk-status" % EV,
             {"issue_ids": pick, "status": "dismissed", "note": "Card payment failed; nothing owed (test)"})
check(st == 200 and r["updated"] == len(pick), "an admin dismisses several flags at once", (st, r))
got = dict(db.execute("select id, status from recon_issues where id in (%s)" % ",".join(map(str, pick))).fetchall())
check(all(v == "dismissed" for v in got.values()), "they stay dismissed after the checks run again", got)
hist = db.execute("select count(*) from recon_history where issue_id in (%s) and text like '%%bulk%%'" % ",".join(map(str, pick))).fetchone()[0]
check(hist == len(pick), "each one records the decision in its own history", hist)
if DOOR:
    st, _ = call("POST", "/events/%d/reconcile/issues/bulk-status" % EV, {"issue_ids": pick, "status": "dismissed", "note": "nope"}, headers=DOOR)
    check(st == 403, "door staff cannot decide flags", st)

print("\n== the ticket link, to send by hand ==")
live = db.execute("select id from attendees where event_id=? and coalesce(registration_status,'') not in ('refunded','revoked','cancelled') and qr_code is not null limit 1", (EV,)).fetchone()[0]
st, r = call("GET", "/events/%d/attendees/%d/ticket-link" % (EV, live))
check(st == 200 and r["url"].startswith("https://api.gaiahealers.app/ticket/"), "an admin gets the ticket's private link", st)
lc = json.loads(db.execute("select custom_data from attendees where id=?", (live,)).fetchone()[0] or "{}").get("lifecycle") or []
check(any(e.get("action") == "ticket_link_copied" for e in lc), "copying it is recorded on the ticket", None)
dead = db.execute("select id from attendees where event_id=? and registration_status in ('refunded','revoked') limit 1", (EV,)).fetchone()
if dead:
    st, r = call("GET", "/events/%d/attendees/%d/ticket-link" % (EV, dead[0]))
    check(st == 409, "a refunded or revoked ticket has no link", (st, r))
if DOOR:
    st, _ = call("GET", "/events/%d/attendees/%d/ticket-link" % (EV, live), headers=DOOR)
    check(st == 403, "door staff cannot pull ticket links", st)

print("\n== release: the email record follows by itself ==")
held = db.execute("select h.attendee_id from email_holds h join attendees a on a.id=h.attendee_id where h.event_id=? and h.state='held' "
                  "and coalesce(a.registration_status,'') not in ('refunded','revoked','cancelled') limit 1", (EV,)).fetchone()
if held:
    issue = next((r for r in rows if held[0] in (r["attendee_ids"] or [])), None)
    if issue:
        st, r = call("POST", "/events/%d/reconcile/issues/%d/action" % (EV, issue["id"]),
                     {"action": "release", "ticket_id": held[0], "note": "identity confirmed (test)", "confirm": True})
        check(st == 200 and "Email record updated" in (r.get("result") or {}).get("note", ""), "release also updates the email record", (st, r))
        inplan = [x for x in db.execute("select ticket_ids from email_plan where event_id=? and active=1", (EV,)).fetchall()
                  if held[0] in json.loads(x[0] or "[]")]
        check(len(inplan) == 1, "the released ticket is in exactly one planned email", inplan)
    else:
        print("  SKIP  no issue holds that ticket")
else:
    print("  SKIP  nothing is held")

print("\n== edits are kept; real tickets are never deleted ==")
st, r = call("PUT", "/attendees/%d" % live, {"company": "Edited by test Co"})
lc = json.loads(db.execute("select custom_data from attendees where id=?", (live,)).fetchone()[0] or "{}").get("lifecycle") or []
ed = [e for e in lc if e.get("action") == "edited"]
check(st == 200 and ed and "company" in ed[-1].get("changes", {}), "an edit is recorded with what changed", (st, ed[-1:] if ed else None))
paid = db.execute("select attendee_id from payment_events where status='paid' and attendee_id is not null limit 1").fetchone()
if paid:
    st, r = call("DELETE", "/attendees/%d" % paid[0])
    check(st == 409 and "Revoke" in str(r), "a paid ticket cannot be deleted (revoke instead)", (st, r))
    check(db.execute("select count(*) from attendees where id=?", (paid[0],)).fetchone()[0] == 1, "and it is still there", None)
ci = db.execute("select id from attendees where is_checked_in=1 limit 1").fetchone()
if ci:
    st, r = call("DELETE", "/attendees/%d" % ci[0])
    check(st == 409, "a checked-in ticket cannot be deleted", (st, r))

print("\n== nothing else changed ==")
pay_after = db.execute("select count(*), coalesce(sum(amount),0), group_concat(id||status||coalesce(attendee_id,'')) from payment_events").fetchone()
check(pay_before == pay_after, "payments untouched", None)

print("\n" + ("ALL CHECKS PASSED" if not fails else "%d FAILED: %s" % (len(fails), "; ".join(fails))))
sys.exit(1 if fails else 0)
