# -*- coding: utf-8 -*-
"""REFUND MIRRORING — Gaia follows GHL's money, in both directions.

GHL is the source of truth. When a payment is reversed there, access here has to
follow, and it has to follow for EVERY channel money arrives on.

It did not. A ticket sold on a GHL INVOICE is ledgered under invoice_id, but the
refund path matched on order_id alone — so refunding an invoice sale was a
silent no-op and the buyer kept a valid QR after their money went back. Five
people bought on invoices for Elevate 2026; any refund among them would have
been invisible.

These tests also pin the rule that matters at the door: access is DERIVED from
the payments that are still valid, so refunding an upgrade drops the tier and
keeps the person, rather than deleting them from the event.

Throwaway events and example.invalid people only — nothing real is touched, and
nothing is ever written to GHL.
Run:  python3 /root/event/backend/test_refund_mirror.py
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
        with urllib.request.urlopen(req) as r:
            p = r.read()
            return r.status, json.loads(p or "null")
    except urllib.error.HTTPError as e:
        p = e.read()
        try:
            return e.code, json.loads(p or "null")
        except Exception:
            return e.code, p

def sql(q, a=()):
    c = sqlite3.connect(DB)
    try:
        return c.execute(q, a).fetchall()
    finally:
        c.close()

print("REFUND MIRRORING")

for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ refund%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)

start = datetime.utcnow() + timedelta(days=30)
st, ev = call("POST", "/events", {"name": "ZZ refund mirror",
                                  "start_date": start.isoformat(),
                                  "end_date": (start + timedelta(days=1)).isoformat(),
                                  "location": "Test", "timezone": "UTC"}, ADMIN)
assert st in (200, 201), (st, ev)
EV = ev["id"]

def ticket(name, code, rank):
    st, tt = call("POST", "/events/%d/ticket-types" % EV,
                  {"name": name, "code": code}, ADMIN)
    assert st in (200, 201), (st, tt)
    # upgrade_rank is what makes one tier higher than another; it has no create
    # field, so set it directly on this throwaway event's rows.
    c = sqlite3.connect(DB)
    try:
        c.execute("UPDATE ticket_types SET upgrade_rank=? WHERE id=?", (rank, tt["id"]))
        c.commit()
    finally:
        c.close()
    return tt["id"]

BASE_TT = ticket("ZZ General", "zz-price-base", 1)
UP_TT = ticket("ZZ Speaker", "zz-price-up", 5)

def mapping(product_id, tt_id, is_upgrade):
    """A product only becomes event access once a human maps it — including here."""
    c = sqlite3.connect(DB)
    try:
        c.execute("INSERT INTO ticket_mappings (event_id, provider, external_product_id,"
                  " ticket_type_id, is_upgrade, label, is_active, entitlement_type)"
                  " VALUES (?,?,?,?,?,?,1,?)",
                  (EV, "ghl", product_id, tt_id, 1 if is_upgrade else 0,
                   "ZZ test mapping", "EVENT_TICKET"))
        c.commit()
    finally:
        c.close()

mapping("zz-prod-base", BASE_TT, False)
mapping("zz-prod-up", UP_TT, True)

def status_of(email):
    rows = sql("SELECT registration_status FROM attendees WHERE event_id=? AND lower(email)=?",
               (EV, email))
    return rows[0][0] if rows else None

def tier_of(email):
    rows = sql("SELECT ticket_type_id FROM attendees WHERE event_id=? AND lower(email)=?",
               (EV, email))
    return rows[0][0] if rows else None

BLOCKED = ("refunded", "cancelled", "revoked")

# ── 1. the channel that was broken: a ticket bought on an INVOICE ─────────
E_INV = "zz-refund-invoice@example.invalid"
INV = "inv-zz-refund-1"
st, rec = call("POST", "/identity/reconcile-invoice", {
    "event_id": EV, "email": E_INV, "invoice_id": INV, "ticket_type_id": BASE_TT,
    "product_id": "zz-prod-base", "amount": 99.0, "quantity": 1, "status": "paid",
    "first_name": "Ines", "last_name": "Invoice"}, SVC)
check(st == 200 and rec.get("ok"), "an invoice sale creates an attendee", (st, rec))
check(status_of(E_INV) not in BLOCKED, "and they start out with valid access", status_of(E_INV))

st, ref = call("POST", "/identity/refund-ticket", {
    "event_id": EV, "email": E_INV, "invoice_id": INV,
    "amount": 99.0, "amount_refunded": 99.0, "reason": "test"}, SVC)
check(st == 200 and ref.get("matched") is True,
      "refunding an INVOICE sale finds the buyer", (st, ref))
check(ref.get("changed") is True,
      "the refund actually changes something (this silently did nothing before)", ref)
check(status_of(E_INV) in BLOCKED,
      "and the invoice buyer's access is revoked, mirroring GHL", status_of(E_INV))

st, ref2 = call("POST", "/identity/refund-ticket", {
    "event_id": EV, "email": E_INV, "invoice_id": INV,
    "amount": 99.0, "amount_refunded": 99.0}, SVC)
check(st == 200 and ref2.get("changed") is False,
      "a redelivered invoice refund is idempotent", ref2)

# ── 2. the order channel keeps working exactly as it did ──────────────────
E_ORD = "zz-refund-order@example.invalid"
ORD = "ord-zz-refund-1"
call("POST", "/identity/reconcile-attendee", {
    "event_id": EV, "email": E_ORD, "ticket_type_id": BASE_TT, "order_id": ORD,
    "first_name": "Otto", "last_name": "Order"}, SVC)
st, ref = call("POST", "/identity/refund-ticket", {
    "event_id": EV, "email": E_ORD, "order_id": ORD,
    "amount": 99.0, "amount_refunded": 99.0}, SVC)
check(st == 200 and ref.get("matched") is True and status_of(E_ORD) in BLOCKED,
      "an ORDER refund still revokes access, unchanged by this fix", (ref, status_of(E_ORD)))

# ── 3. access is derived from what is still paid for ──────────────────────
E_UP = "zz-refund-upgrade@example.invalid"
O_BASE, O_UP = "ord-zz-base-2", "ord-zz-up-2"
call("POST", "/identity/reconcile-attendee", {
    "event_id": EV, "email": E_UP, "ticket_type_id": BASE_TT, "order_id": O_BASE,
    "first_name": "Uma", "last_name": "Upgrade"}, SVC)
call("POST", "/identity/reconcile-attendee", {
    "event_id": EV, "email": E_UP, "ticket_type_id": UP_TT, "order_id": O_UP,
    "is_upgrade": True}, SVC)
check(tier_of(E_UP) == UP_TT, "buying an upgrade lifts the tier", tier_of(E_UP))

st, ref = call("POST", "/identity/refund-ticket", {
    "event_id": EV, "email": E_UP, "order_id": O_UP,
    "amount": 299.0, "amount_refunded": 299.0}, SVC)
check(status_of(E_UP) not in BLOCKED,
      "refunding an UPGRADE keeps the person in the event", status_of(E_UP))
check(tier_of(E_UP) == BASE_TT,
      "and drops them to the tier they have still paid for", tier_of(E_UP))

st, ref = call("POST", "/identity/refund-ticket", {
    "event_id": EV, "email": E_UP, "order_id": O_BASE,
    "amount": 99.0, "amount_refunded": 99.0}, SVC)
check(status_of(E_UP) in BLOCKED,
      "refunding the base as well, with nothing paid left, revokes access", status_of(E_UP))

# ── 3b. the same derivation, for a ticket bought on an INVOICE ────────────
# This is the sharp end of the invoice_id bug. Without ledger matching, an
# invoice refund falls through to the legacy path and invalidates the whole
# ticket -- so refunding an invoice UPGRADE threw the person out of the event
# instead of dropping them one tier.
E_IUP = "zz-refund-invoice-upgrade@example.invalid"
I_BASE, I_UP = "inv-zz-base-4", "inv-zz-up-4"
call("POST", "/identity/reconcile-invoice", {
    "event_id": EV, "email": E_IUP, "invoice_id": I_BASE, "ticket_type_id": BASE_TT,
    "product_id": "zz-prod-base", "amount": 99.0, "quantity": 1, "status": "paid",
    "first_name": "Iris", "last_name": "Both"}, SVC)
call("POST", "/identity/reconcile-invoice", {
    "event_id": EV, "email": E_IUP, "invoice_id": I_UP, "ticket_type_id": UP_TT,
    "product_id": "zz-prod-up", "amount": 299.0, "quantity": 1, "status": "paid",
    "is_upgrade": True}, SVC)
check(tier_of(E_IUP) == UP_TT, "an invoice upgrade lifts the tier", tier_of(E_IUP))

st, ref = call("POST", "/identity/refund-ticket", {
    "event_id": EV, "email": E_IUP, "invoice_id": I_UP,
    "amount": 299.0, "amount_refunded": 299.0}, SVC)
check(status_of(E_IUP) not in BLOCKED,
      "refunding an INVOICE upgrade does not throw the person out of the event",
      status_of(E_IUP))
check(tier_of(E_IUP) == BASE_TT,
      "it drops them to the base tier their invoice still covers", tier_of(E_IUP))

# ── 4. a partial refund is recorded, not enforced ─────────────────────────
E_PART = "zz-refund-partial@example.invalid"
O_PART = "ord-zz-part-3"
call("POST", "/identity/reconcile-attendee", {
    "event_id": EV, "email": E_PART, "ticket_type_id": BASE_TT, "order_id": O_PART,
    "first_name": "Pia", "last_name": "Partial"}, SVC)
st, ref = call("POST", "/identity/refund-ticket", {
    "event_id": EV, "email": E_PART, "order_id": O_PART,
    "amount": 99.0, "amount_refunded": 20.0}, SVC)
check(ref.get("partial") is True and status_of(E_PART) not in BLOCKED,
      "a PARTIAL refund is recorded but does not revoke the ticket", (ref, status_of(E_PART)))

# ── 4b. a refund for something that is NOT a ticket ───────────────────────
# Sponsorships, Bio-Well kits and courses get refunded too, and they share the
# buyer's email address. A refund keyed on the PERSON would revoke the event
# seat they never asked to give up; keyed on the money reference it is a no-op.
E_SPON = "zz-refund-sponsor@example.invalid"
O_TICKET = "ord-zz-ticket-5"
call("POST", "/identity/reconcile-attendee", {
    "event_id": EV, "email": E_SPON, "ticket_type_id": BASE_TT, "order_id": O_TICKET,
    "first_name": "Sam", "last_name": "Sponsor"}, SVC)
blocked_before = sql("SELECT COUNT(*) FROM attendees WHERE registration_status IN "
                     "('refunded','cancelled','revoked')")[0][0]
st, ref = call("POST", "/identity/refund-ticket", {
    "order_id": "ord-zz-sponsorship-not-a-ticket",
    "amount": 3500.0, "amount_refunded": 3500.0, "actor": "mirror"}, SVC)
check(ref.get("matched") is False,
      "a refund for a reference Gaia never ledgered matches NOBODY", ref)
check(status_of(E_SPON) not in BLOCKED,
      "refunding a non-ticket purchase leaves that buyer's event seat alone",
      (ref, status_of(E_SPON)))
check(tier_of(E_SPON) == BASE_TT,
      "and does not disturb their tier", tier_of(E_SPON))
# The narrow version of this check passed while a real attendee was being
# revoked: the reconciler passes no email, the lookup ran unfiltered, and the
# refund landed on whoever was first in the table. Count the whole table.
blocked_after = sql("SELECT COUNT(*) FROM attendees WHERE registration_status IN "
                    "('refunded','cancelled','revoked')")[0][0]
check(blocked_after == blocked_before,
      "and revokes nobody ELSE anywhere in the event either",
      (blocked_before, blocked_after))

# ── 5. a reference nobody recognises must never guess ─────────────────────
st, ref = call("POST", "/identity/refund-ticket", {
    "event_id": EV, "email": "zz-nobody@example.invalid",
    "invoice_id": "inv-does-not-exist", "amount": 1.0, "amount_refunded": 1.0}, SVC)
check(st == 200 and ref.get("matched") is False,
      "an unknown refund reference is a harmless no-op, never a guess", (st, ref))

# ── 6. nothing leaked into a real event ───────────────────────────────────
stray = sql("SELECT COUNT(*) FROM attendees WHERE email LIKE 'zz-refund-%' AND event_id != ?", (EV,))
check(stray[0][0] == 0, "no test attendee landed outside the throwaway event", stray)

c = sqlite3.connect(DB)
c.execute("DELETE FROM ticket_mappings WHERE event_id=?", (EV,)); c.commit(); c.close()
call("DELETE", "/events/%d" % EV, token=ADMIN)
maps_left = sql("SELECT COUNT(*) FROM ticket_mappings WHERE event_id=?", (EV,))
check(maps_left[0][0] == 0, "the throwaway mappings are gone too", maps_left)
left = sql("SELECT COUNT(*) FROM attendees WHERE email LIKE 'zz-refund-%'")
check(left[0][0] == 0, "the throwaway event and its people are gone afterwards", left)

print("\n%d checks, %d failed" % (24, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
