# -*- coding: utf-8 -*-
"""WEBHOOK AND MIRROR MUST AGREE.

Two paths deliver the same sale: the webhook, seconds after GHL takes the money,
and the hourly mirror, which re-reads GHL and catches whatever the webhook
missed. If they disagree, Gaia's state depends on whether a network call
happened to succeed -- which is not a state anyone can reason about.

So the property under test is convergence: whichever path runs, and however many
times, the resulting attendee, tier, ledger and figures are identical.

This drives the real reconcile endpoints (the same ones both paths call) rather
than mocking them. Throwaway events and example.invalid people only; GHL is
never contacted and never written to.
Run:  python3 /root/event/backend/test_webhook_equivalence.py
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

def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
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

def write(q, a=()):
    c = sqlite3.connect(DB)
    try:
        c.execute(q, a); c.commit()
    finally:
        c.close()

print("WEBHOOK / MIRROR EQUIVALENCE")

for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ equiv%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)

def make_event(tag):
    start = datetime.utcnow() + timedelta(days=45)
    st, ev = call("POST", "/events", {"name": "ZZ equiv %s" % tag,
                                      "start_date": start.isoformat(),
                                      "end_date": (start + timedelta(days=1)).isoformat(),
                                      "location": "Test", "timezone": "UTC"}, ADMIN)
    assert st in (200, 201), (st, ev)
    return ev["id"]

# Two identical events: one fed as if by the webhook, one as if by the mirror.
EV_W, EV_M = make_event("webhook"), make_event("mirror")

def setup(ev):
    ids = {}
    for name, code, rank in (("ZZ Base", "zz-eq-base", 1), ("ZZ Upper", "zz-eq-up", 5)):
        st, tt = call("POST", "/events/%d/ticket-types" % ev, {"name": name, "code": code}, ADMIN)
        assert st in (200, 201), (st, tt)
        write("UPDATE ticket_types SET upgrade_rank=? WHERE id=?", (rank, tt["id"]))
        ids[name] = tt["id"]
    for pid, tt, up in (("zz-eq-p-base", ids["ZZ Base"], 0), ("zz-eq-p-up", ids["ZZ Upper"], 1)):
        write("INSERT INTO ticket_mappings (event_id, provider, external_product_id,"
              " ticket_type_id, is_upgrade, label, is_active, entitlement_type)"
              " VALUES (?,?,?,?,?,?,1,?)", (ev, "ghl", pid, tt, up, "ZZ", "EVENT_TICKET"))
    return ids

TT_W, TT_M = setup(EV_W), setup(EV_M)

T0 = "2026-06-01T10:00:00"
def plus(m):
    return (datetime.fromisoformat(T0) + timedelta(minutes=m)).isoformat()

def order(ev, tt, email, pid, ref, up=False, qty=1, amount=99.0, at=T0):
    return call("POST", "/identity/reconcile-attendee", {
        "event_id": ev, "email": email, "ticket_type_id": tt, "product_id": pid,
        "order_id": ref, "is_upgrade": up, "quantity": qty, "amount": amount,
        "purchased_at": at, "first_name": "Eq", "last_name": "Tester"}, SVC)

def invoice(ev, email, pid, ref, qty=1, amount=99.0, at=T0):
    return call("POST", "/identity/reconcile-invoice", {
        "event_id": ev, "email": email, "invoice_id": ref, "product_id": pid,
        "amount": amount, "quantity": qty, "status": "paid",
        "first_name": "Eq", "last_name": "Tester", "issued_at": at}, SVC)

def metrics(ev):
    st, m = call("GET", "/events/%d/ticket-metrics" % ev, token=ADMIN)
    assert st == 200, (st, m)
    return m

def shape(ev):
    """Everything that should be identical, with the event id stripped out."""
    rows = sql("SELECT email, ticket_type_id, registration_status, custom_data"
               " FROM attendees WHERE event_id=? ORDER BY email", (ev,))
    out = []
    for email, tt, status, cd in rows:
        d = json.loads(cd or "{}")
        ents = sorted([
            {"ref": str(e.get("order_id") or e.get("invoice_id") or "")[2:],
             "upgrade": bool(e.get("is_upgrade")), "status": e.get("status"),
             "qty": e.get("quantity"), "amount": e.get("amount"),
             "product": e.get("product_id"), "at": e.get("purchased_at")}
            for e in (d.get("entitlements") or [])], key=lambda x: str(x["ref"]))
        # Tier ids differ between the two events; compare the RANK instead.
        rank = sql("SELECT upgrade_rank FROM ticket_types WHERE id=?", (tt,)) if tt else [(None,)]
        out.append({"email": email, "rank": rank[0][0] if rank else None,
                    "status": status, "entitlements": ents,
                    "refunded": sorted(x[2:] for x in (d.get("refunded_order_ids") or []))})
    return out

# The identical sequence of events, delivered to each event by "its" path.
SEQ = [
    ("order",   "zz-eq-a@example.invalid", "base", "zz-eq-r1", False, 1, 99.0,  T0),
    ("order",   "zz-eq-a@example.invalid", "up",   "zz-eq-r2", True,  1, 200.0, plus(30)),
    ("order",   "zz-eq-b@example.invalid", "base", "zz-eq-r3", False, 3, 297.0, T0),
    ("invoice", "zz-eq-c@example.invalid", "base", "zz-eq-r4", False, 1, 99.0,  T0),
    ("invoice", "zz-eq-c@example.invalid", "up",   "zz-eq-r5", False, 1, 200.0, plus(60)),
    ("order",   "zz-eq-d@example.invalid", "base", "zz-eq-r6", False, 1, 99.0,  T0),
    ("order",   "zz-eq-d@example.invalid", "base", "zz-eq-r7", False, 1, 99.0,  plus(4)),
    ("order",   "zz-eq-e@example.invalid", "base", "zz-eq-r8", False, 1, 99.0,  T0),
    ("order",   "zz-eq-e@example.invalid", "base", "zz-eq-r9", False, 1, 99.0,  plus(60 * 24 * 4)),
]

def deliver(ev, tts, seq, prefix=""):
    for kind, email, tier, ref, up, qty, amt, at in seq:
        ref = prefix + ref          # GHL references are globally unique
        pid = "zz-eq-p-base" if tier == "base" else "zz-eq-p-up"
        tt = tts["ZZ Base"] if tier == "base" else tts["ZZ Upper"]
        if kind == "invoice":
            invoice(ev, email, pid, ref, qty=qty, amount=amt, at=at)
        else:
            order(ev, tt, email, pid, ref, up=up, qty=qty, amount=amt, at=at)

# Webhook: each sale arrives once, in order.
deliver(EV_W, TT_W, SEQ, "w-")

# Mirror: the same sales, re-read in a sweep, with the duplicate deliveries a
# retrying webhook and an overlapping window actually produce.
deliver(EV_M, TT_M, SEQ, "m-")
deliver(EV_M, TT_M, SEQ, "m-")
deliver(EV_M, TT_M, SEQ[:4], "m-")

mw, mm = metrics(EV_W), metrics(EV_M)
check(mw["people"] == mm["people"], "the same people, whichever path delivered them",
      (mw["people"], mm["people"]))
check(mw["seats"] == mm["seats"], "the same assigned and unassigned seats",
      (mw["seats"], mm["seats"]))
check(mw["payments"] == mm["payments"], "the same purchase / upgrade / repeat split",
      (mw["payments"], mm["payments"]))
check(mw["money"] == mm["money"], "the same money", (mw["money"], mm["money"]))
check(shape(EV_W) == shape(EV_M), "and an identical ledger, attendee for attendee")

check(mm["payments"]["upgrade_payments"] == 2,
      "replaying three times did not multiply the upgrades", mm["payments"])
check(mm["seats"]["unassigned_paid_seats"] == mw["seats"]["unassigned_paid_seats"],
      "nor the unassigned seats", (mw["seats"], mm["seats"]))

# A refund arriving on either path converges too.
for ev in (EV_W, EV_M):
    call("POST", "/identity/refund-ticket",
         {"event_id": ev, "invoice_id": ("w-" if ev == EV_W else "m-") + "zz-eq-r5",
          "amount": 200.0, "amount_refunded": 200.0}, SVC)
# the mirror redelivering a refund it already sent
call("POST", "/identity/refund-ticket",
     {"event_id": EV_M, "invoice_id": "m-zz-eq-r5",
      "amount": 200.0, "amount_refunded": 200.0}, SVC)
_w, _m = shape(EV_W), shape(EV_M)
if _w != _m:
    for a, b in zip(_w, _m):
        if a != b:
            print("      DIFF w:", json.dumps(a)[:400])
            print("      DIFF m:", json.dumps(b)[:400])
check(_w == _m,
      "a refund delivered twice on one path still matches the other")
check(metrics(EV_W)["money"] == metrics(EV_M)["money"],
      "including the refunded money", (metrics(EV_W)["money"], metrics(EV_M)["money"]))

for ev in (EV_W, EV_M):
    write("DELETE FROM ticket_mappings WHERE event_id=?", (ev,))
    call("DELETE", "/events/%d" % ev, token=ADMIN)
left = sql("SELECT COUNT(*) FROM attendees WHERE email LIKE 'zz-eq-%'")
check(left[0][0] == 0, "the throwaway events and their people are gone afterwards", left)

print("\n%d checks, %d failed" % (10, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
