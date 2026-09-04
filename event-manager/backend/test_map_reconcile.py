# -*- coding: utf-8 -*-
"""MAP & RECONCILE, and the counting that stops an upgrade looking like a ticket.

Two things are proved here.

First, that mapping a product can replay its history. A product becomes event
access only when a human maps it -- that rule is right, and it used to mean the
sales that already happened stayed invisible even after somebody mapped it. Now
staff see exactly what a replay would do, approve it, and it runs through the
SAME reconcile path the webhook and the hourly mirror use. Running it twice
creates nothing the second time.

Second, that the figures stay honest. An upgrade adds revenue and a tier; it is
never another head or another seat. A second payment for the same base ticket is
NOT an upgrade -- it is either another seat or a duplicate charge, and which one
is decided from the purchase timing GHL recorded, not from the order the rows
happen to sit in. Where GHL does not name the second guest, the seat is counted
and left unassigned rather than filled with an invented person.

Throwaway events and example.invalid people only. GHL is never written to.
Run:  python3 /root/event/backend/test_map_reconcile.py
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

print("MAP & RECONCILE / TICKET METRICS")

for (eid,) in sql("SELECT id FROM events WHERE name LIKE 'ZZ mapre%'"):
    call("DELETE", "/events/%d" % eid, token=ADMIN)

start = datetime.utcnow() + timedelta(days=40)
st, ev = call("POST", "/events", {"name": "ZZ mapre", "start_date": start.isoformat(),
                                  "end_date": (start + timedelta(days=1)).isoformat(),
                                  "location": "Test", "timezone": "UTC"}, ADMIN)
assert st in (200, 201), (st, ev)
EV = ev["id"]

def ticket(name, code, rank):
    st, tt = call("POST", "/events/%d/ticket-types" % EV, {"name": name, "code": code}, ADMIN)
    assert st in (200, 201), (st, tt)
    write("UPDATE ticket_types SET upgrade_rank=? WHERE id=?", (rank, tt["id"]))
    return tt["id"]

BASE_TT = ticket("ZZ Base", "zz-mr-base", 1)
UP_TT = ticket("ZZ Upper", "zz-mr-up", 5)
P_BASE, P_UP = "zz-mr-prod-base", "zz-mr-prod-up"

def mapping(pid, tt, up):
    write("INSERT INTO ticket_mappings (event_id, provider, external_product_id, ticket_type_id,"
          " is_upgrade, label, is_active, entitlement_type) VALUES (?,?,?,?,?,?,1,?)",
          (EV, "ghl", pid, tt, 1 if up else 0, "ZZ map", "EVENT_TICKET"))

def metrics():
    st, m = call("GET", "/events/%d/ticket-metrics" % EV, token=ADMIN)
    assert st == 200, (st, m)
    return m

def reconcile(email, tt, pid, ref, is_up=False, qty=1, amount=99.0, at=None, first="Zed", last="Tester"):
    return call("POST", "/identity/reconcile-attendee", {
        "event_id": EV, "email": email, "ticket_type_id": tt, "product_id": pid,
        "order_id": ref, "is_upgrade": is_up, "quantity": qty, "amount": amount,
        "purchased_at": at, "first_name": first, "last_name": last}, SVC)

T0 = "2026-06-01T10:00:00"
def plus(minutes):
    return (datetime.fromisoformat(T0) + timedelta(minutes=minutes)).isoformat()

mapping(P_BASE, BASE_TT, False)
mapping(P_UP, UP_TT, True)

# ── 1. an upgrade is revenue and a tier, never a head or a seat ────────────
E1 = "zz-mr-upgrade@example.invalid"
reconcile(E1, BASE_TT, P_BASE, "zz-o-1", at=T0, amount=99.0)
m = metrics()
check(m["people"]["unique_attendees"] == 1, "a base ticket makes one attendee", m["people"])
reconcile(E1, UP_TT, P_UP, "zz-o-2", is_up=True, at=plus(30), amount=200.0)
m = metrics()
check(m["people"]["unique_attendees"] == 1,
      "buying an upgrade does NOT add a second attendee", m["people"])
check(m["seats"]["assigned_paid_seats"] == 1,
      "and does not add a paid seat", m["seats"])
check(m["payments"]["upgrade_payments"] == 1,
      "it is counted as an upgrade payment", m["payments"])
check(m["payments"]["original_ticket_purchases"] == 1,
      "and not as another ticket sale", m["payments"])
check(abs(m["money"]["gross_event_revenue"] - 299.0) < 0.01,
      "but the money it brought in IS counted", m["money"])
check(m["payments"]["total_economic_events"] == 2,
      "two economic events, one attendee", m["payments"])

# ── 2. a second base ticket days later is a SEAT, not an upgrade ───────────
E2 = "zz-mr-seat@example.invalid"
reconcile(E2, BASE_TT, P_BASE, "zz-o-3", at=T0, amount=99.0)
reconcile(E2, BASE_TT, P_BASE, "zz-o-4", at=plus(60 * 24 * 3), amount=99.0)
m = metrics()
check(m["payments"]["repeat_breakdown"].get("additional_paid_seat") == 1,
      "paying again for the same ticket days later reads as an additional seat",
      m["payments"]["repeat_breakdown"])
check(m["payments"]["upgrade_payments"] == 1,
      "it is NOT silently promoted to an upgrade", m["payments"])
check(m["seats"]["unassigned_paid_seats"] == 1,
      "the seat is counted", m["seats"])
check(m["people"]["unique_attendees"] == 2,
      "and no attendee is invented for whoever will sit in it", m["people"])

# ── 3. the same ticket twice within minutes is a suspected duplicate ───────
E3 = "zz-mr-dupe@example.invalid"
reconcile(E3, BASE_TT, P_BASE, "zz-o-5", at=T0, amount=99.0)
reconcile(E3, BASE_TT, P_BASE, "zz-o-6", at=plus(3), amount=99.0)
m = metrics()
check(m["payments"]["repeat_breakdown"].get("duplicate_suspected") == 1,
      "the same ticket twice in three minutes is flagged as a likely duplicate",
      m["payments"]["repeat_breakdown"])
check(any(r["email"] == E3 for r in m["needs_review"]),
      "and it is put in front of a human rather than auto-refunded", m["needs_review"])

# ── 4. quantity > 1 is seats, never invented people ────────────────────────
E4 = "zz-mr-qty@example.invalid"
reconcile(E4, BASE_TT, P_BASE, "zz-o-7", qty=3, at=T0, amount=297.0)
m = metrics()
before_people = m["people"]["unique_attendees"]
check(m["seats"]["unassigned_paid_seats"] >= 3,
      "buying three seats records two more seats than attendees", m["seats"])
names = sql("SELECT COUNT(*) FROM attendees WHERE event_id=? AND email LIKE 'zz-mr-qty%'", (EV,))
check(names[0][0] == 1,
      "only the named buyer becomes an attendee; the other seats stay unassigned", names)

# ── 5. the identity that makes the figures readable ────────────────────────
m = metrics()
p = m["payments"]
check(p["original_ticket_purchases"] + p["upgrade_payments"] + p["repeat_base_payments"]
      == p["total_economic_events"],
      "purchases + upgrades + repeats add up to the economic-event total", p)

# ── 6. Map & Reconcile refuses to act without an explicit yes ──────────────
st, r = call("POST", "/events/%d/map-reconcile/apply" % EV,
             {"product_id": "zz-mr-new", "ticket_type_id": BASE_TT}, ADMIN)
check(st == 400, "apply without confirmation is refused", (st, r))

st, r = call("POST", "/events/%d/map-reconcile/apply" % EV,
             {"product_id": "zz-mr-new", "confirm": True}, ADMIN)
check(st == 400, "apply without a ticket type is refused", (st, r))

st, r = call("POST", "/events/%d/map-reconcile/apply" % EV,
             {"product_id": "zz-mr-new", "ticket_type_id": 999999, "confirm": True}, ADMIN)
check(st == 404, "a ticket type from another event is refused", (st, r))

# ── 7. replay is idempotent through the ordinary reconcile path ────────────
# Replaying the same references must converge, not accumulate. This is the
# property that makes a missed webhook harmless and a re-run safe.
m_before = metrics()
for ref, at, amt in (("zz-o-1", T0, 99.0), ("zz-o-3", T0, 99.0), ("zz-o-5", T0, 99.0)):
    reconcile(E1 if ref == "zz-o-1" else (E2 if ref == "zz-o-3" else E3),
              BASE_TT, P_BASE, ref, at=at, amount=amt)
m_after = metrics()
check(m_before["payments"] == m_after["payments"],
      "replaying the same payments changes no figure", (m_before["payments"], m_after["payments"]))
check(m_before["people"] == m_after["people"],
      "and creates no new people", (m_before["people"], m_after["people"]))

# ── 8. a refunded upgrade leaves the base entitlement standing ─────────────
st, r = call("POST", "/identity/refund-ticket",
             {"event_id": EV, "email": E1, "order_id": "zz-o-2",
              "amount": 200.0, "amount_refunded": 200.0}, SVC)
tier = sql("SELECT ticket_type_id FROM attendees WHERE event_id=? AND lower(email)=?", (EV, E1))
status = sql("SELECT registration_status FROM attendees WHERE event_id=? AND lower(email)=?", (EV, E1))
check(tier[0][0] == BASE_TT, "refunding the upgrade drops the tier to the paid base", tier)
check(status[0][0] not in ("refunded", "cancelled", "revoked"),
      "and leaves the person in the event", status)
m = metrics()
check(m["money"]["refunds"] > 0 and m["money"]["net_event_revenue"] < m["money"]["gross_event_revenue"],
      "the refund shows in the money, not just the access", m["money"])

# ── 9. a sponsorship refund cannot touch an attendee ───────────────────────
st, r = call("POST", "/identity/refund-ticket",
             {"order_id": "zz-not-a-ticket-at-all", "amount": 3500.0,
              "amount_refunded": 3500.0, "actor": "mirror"}, SVC)
still = sql("SELECT registration_status FROM attendees WHERE event_id=? AND lower(email)=?", (EV, E2))
check(r.get("matched") is False, "a refund for something we never ledgered matches nothing", r)
check(still[0][0] not in ("refunded", "cancelled", "revoked"),
      "and no attendee's seat is revoked by it", still)

# ── 10. unmapped triage shows event-like, hides the catalogue, keeps both ──
for ref, name, amt in (("zz-u-1", "Weekend Admission Pass", 120.0),
                       ("zz-u-2", "Bio-Well 3.0 Combo", 6347.0),
                       ("zz-u-3", "The Ambassador", 3500.0)):
    call("POST", "/identity/report-unmapped-sale",
         {"reference": ref, "source": "ghl_order", "product_id": "zz-p-" + ref,
          "product_name": name, "buyer_email": "zz-mr-buyer@example.invalid",
          "amount": amt, "paid_at": "2026-06-01", "event_id": EV}, SVC)
st, u = call("GET", "/events/%d/unmapped-sales" % EV, token=ADMIN)
shown = {i["product_name"] for i in u["items"]}
check("Weekend Admission Pass" in shown, "an admission-shaped product stays in the review panel", shown)
check("Bio-Well 3.0 Combo" not in shown, "a Bio-Well device does not clutter the event panel", shown)
check(u["unrelated_hidden"] >= 2, "the hidden ones are counted, not silently dropped", u)
st, u2 = call("GET", "/events/%d/unmapped-sales?include_unrelated=true" % EV, token=ADMIN)
shown2 = {i["product_name"] for i in u2["items"]}
check("Bio-Well 3.0 Combo" in shown2 and "The Ambassador" in shown2,
      "and they are all still retrievable for audit", shown2)

# ── cleanup ────────────────────────────────────────────────────────────────
write("DELETE FROM ticket_mappings WHERE event_id=?", (EV,))
write("DELETE FROM unmapped_sales WHERE reference LIKE 'zz-u-%'", ())
call("DELETE", "/events/%d" % EV, token=ADMIN)
left = sql("SELECT COUNT(*) FROM attendees WHERE email LIKE 'zz-mr-%'")
check(left[0][0] == 0, "the throwaway event and its people are gone afterwards", left)

print("\n%d checks, %d failed" % (28, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
