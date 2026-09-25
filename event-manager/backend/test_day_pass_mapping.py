# -*- coding: utf-8 -*-
"""Every Elevate day pass must be mapped, or a paid ticket vanishes.

The bug this exists to stop happening again:

Three Exhibit Hall day passes were created in GHL together on 3 Sep 2026 --
Friday, Saturday and Sunday. Only Friday was mapped to a Gaia ticket type. So
when someone paid $102.82 for the Sunday pass through the same funnel and the
same cart as a Friday buyer two minutes earlier, the mirror had nothing to map
it to. It filed the sale under "Not an event product" and moved on. The money
settled, the buyer had a receipt, and Gaia had no attendee, no ticket and no QR
for them. Nothing errored. The only trace was a row in unmapped_sales.

A missing mapping is invisible by construction: the sale is not counted as an
event sale, so no "paid but missing" alarm can fire for it. The guard therefore
has to come at it from the product side -- every day pass the event sells must
resolve to a ticket type -- and from the payment side -- no settled Elevate
payment may be left without an attendee.

Read-only. Touches no GHL data, creates no attendees, and is safe to run at any
time against production.

Run:  python3 /root/event/backend/test_day_pass_mapping.py
"""
import sqlite3
import sys

DB = "/root/event/backend/event.db"
EVENT_ID = 1

# The three day passes, as GHL holds them. Product ids are stable; the day each
# one admits comes from the product's own description in GHL, not from its name.
DAY_PASSES = {
    "6a98deb3e5e0de29ff9d7c3d": ("Friday",   "2026-11-20", "FRI-EXH"),
    "6a98df6d324935c27b758cec": ("Saturday", "2026-11-21", "SAT-EXH"),
    "6a98dfa2973de9c5b870949f": ("Sunday",   "2026-11-22", "SUN-EXH"),
}

fails = []


def check(label, cond, detail=""):
    print("  %-62s %s" % (label, "ok" if cond else "FAIL"))
    if not cond:
        fails.append("%s%s" % (label, (" -- " + detail) if detail else ""))


con = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
con.row_factory = sqlite3.Row
c = con.cursor()

print("== 1) every day pass is mapped to a single-day ticket type ==")
for pid, (day, valid_day, code) in sorted(DAY_PASSES.items(), key=lambda x: x[1][1]):
    row = c.execute(
        """select m.id mid, m.is_active, m.entitlement_type, t.id tid, t.code, t.name, t.valid_day,
                  t.grants_conference, t.grants_workshops, t.is_vip
             from ticket_mappings m join ticket_types t on t.id = m.ticket_type_id
            where m.event_id = ? and m.external_product_id = ?""",
        (EVENT_ID, pid)).fetchone()
    check("%s pass (%s) has a mapping" % (day, pid[:8]), row is not None, "no ticket_mapping row")
    if not row:
        continue
    check("  %s mapping is active" % day, bool(row["is_active"]))
    check("  %s is an EVENT_TICKET, not an upgrade/add-on" % day,
          row["entitlement_type"] == "EVENT_TICKET", str(row["entitlement_type"]))
    check("  %s ticket type code is %s" % (day, code), row["code"] == code, str(row["code"]))
    check("  %s admits only %s" % (day, valid_day), row["valid_day"] == valid_day, str(row["valid_day"]))
    # An exhibit-hall day pass is exhibit hall only. If one of these ever starts
    # granting the conference, a $97 ticket silently becomes a $650 one.
    check("  %s grants no conference access" % day, not row["grants_conference"])
    check("  %s grants no workshop access" % day, not row["grants_workshops"])
    check("  %s is not a VIP tier" % day, not row["is_vip"])

print()
print("== 2) no settled Elevate payment is left without an attendee ==")
orphans = c.execute(
    """select id, buyer_email, amount, occurred_at, product_names
         from payment_events
        where event_id = ? and status = 'paid' and attendee_id is null""",
    (EVENT_ID,)).fetchall()
check("paid event payments with no attendee = 0", len(orphans) == 0,
      "; ".join("pe=%s %s" % (r["id"], r["buyer_email"]) for r in orphans[:5]))

# The Sunday bug hid here: classified not_event, so query (2) could never see it.
stranded = c.execute(
    """select id, buyer_email, amount, product_names
         from payment_events
        where status = 'paid' and recon_state = 'not_event'
          and (""" + " or ".join("product_ids like ?" for _ in DAY_PASSES) + ")",
    tuple("%%%s%%" % p for p in DAY_PASSES)).fetchall()
check("no paid day-pass sale is still classified not_event", len(stranded) == 0,
      "; ".join("pe=%s %s" % (r["id"], r["buyer_email"]) for r in stranded[:5]))

print()
print("== 3) a payment that did not settle never holds a ticket ==")
ghosts = c.execute(
    """select p.id, p.status, p.buyer_email, p.attendee_id
         from payment_events p
        where p.event_id = ? and p.status in ('pending', 'failed')
          and p.attendee_id is not null
          and not exists (select 1 from payment_events q
                           where q.attendee_id = p.attendee_id and q.status = 'paid')""",
    (EVENT_ID,)).fetchall()
# A pending or failed row MAY point at an attendee -- that is how a buyer's
# earlier attempt stays visible next to the payment that worked. What must never
# happen is an attendee who exists on the strength of an attempt alone.
check("no attendee exists solely on a pending/failed payment", len(ghosts) == 0,
      "; ".join("pe=%s %s" % (r["id"], r["buyer_email"]) for r in ghosts[:5]))

print()
print("== 4) every ticket is a real, complete ticket ==")
n = lambda q: c.execute(q, (EVENT_ID,)).fetchone()[0]
check("no attendee is missing a QR code",
      n("select count(*) from attendees where event_id=? and (qr_code is null or qr_code='')") == 0)
check("no attendee is missing a ticket type",
      n("select count(*) from attendees where event_id=? and ticket_type_id is null") == 0)
# Money is the usual reason to hold a ticket, and it is not the only one: the
# volunteers working the floor and the guests of the house have badges and paid
# nothing. What must never happen is a ticket with neither -- no payment AND no
# recorded reason -- because that is a ticket nobody can account for.
check("no attendee lacks a settled payment without a reason on the record",
      n("""select count(*) from attendees a where a.event_id=? and not exists
             (select 1 from payment_events p where p.attendee_id=a.id and p.status='paid')
           and coalesce(a.attendance_type,'paid') not in
               ('complimentary','staff','speaker','exhibitor')""") == 0,
      "; ".join("%s %s" % (r[0], r[1]) for r in c.execute(
          """select coalesce(first_name,'')||' '||coalesce(last_name,''), coalesce(attendance_type,'paid')
               from attendees a where a.event_id=? and not exists
                 (select 1 from payment_events p where p.attendee_id=a.id and p.status='paid')
               and coalesce(a.attendance_type,'paid') not in
                   ('complimentary','staff','speaker','exhibitor') limit 5""", (EVENT_ID,)).fetchall()))
check("and every unpaid badge says what it is",
      n("""select count(*) from attendees a where a.event_id=?
             and coalesce(a.attendance_type,'paid') in ('complimentary','staff','speaker','exhibitor')
             and (a.ticket_type_id is null)""") == 0)
check("no duplicate QR codes anywhere",
      c.execute("select count(*) from (select qr_code from attendees group by 1 having count(*)>1)").fetchone()[0] == 0)
check("no duplicate attendee email within the event",
      n("select count(*) from (select lower(email) from attendees where event_id=? group by 1 having count(*)>1)") == 0)

print()
if fails:
    print("FAILED (%d):" % len(fails))
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("all day-pass mapping and ticket-integrity checks passed")
