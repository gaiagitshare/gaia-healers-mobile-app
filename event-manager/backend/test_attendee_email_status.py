"""TICKET EMAIL STATUS IN THE ATTENDEE LIST -- 13 Nov 2026.

Each row of the admin attendee list says whether that ticket's email went out
and what became of it, in Email Center's own words, from the same delivery
history. Runs on throwaway copies of both databases; nothing is sent.

Run:  python3 test_attendee_email_status.py
"""
import os, shutil, sqlite3, sys, tempfile, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
WORK = tempfile.mkdtemp(prefix="mailcol-test-")
DBF = os.path.join(WORK, "event.db")
TDF = os.path.join(WORK, "ticket-delivery.db")
shutil.copy(os.path.join(HERE, "event.db"), DBF)
_src = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "data", "ticket-delivery.db"), uri=True)
_dst = sqlite3.connect(TDF)
_src.backup(_dst)
_dst.execute("update delivery_control set value='off' where key in "
             "('email_center_ticket_sending','email_center_exhibitor_sending')")
_dst.commit(); _dst.close(); _src.close()
os.environ["DATABASE_URL"] = "sqlite:///" + DBF
os.environ["TICKET_DELIVERY_DB"] = TDF

import main as M                                              # noqa: E402
import database, models, email_center as EC                   # noqa: E402

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

db = database.SessionLocal()
EV = 1
TAG = uuid.uuid4().hex[:6]
GA = next(t for t in db.query(models.TicketType).filter(models.TicketType.event_id == EV).all()
          if t.name == "General Admission")

def person(first, kind="paid", source="ghl_order", status="registered"):
    a = models.Attendee(event_id=EV, email="zz-%s-%s@example.invalid" % (first.lower(), TAG), first_name=first,
                        last_name="Zz" + TAG, ticket_type_id=GA.id, registration_status=status, attendance_type=kind,
                        registration_source=source, qr_code="ATT-ZZ%s" % uuid.uuid4().hex[:10].upper(),
                        custom_data={"source": "test"})
    db.add(a); db.commit()
    return a

def delivery(order, ticket, state, provider=None, at="2026-11-12T22:00:00+00:00"):
    c = sqlite3.connect(TDF)
    c.execute("insert into order_ticket_delivery (event_id,order_id,manifest_sha,recipient,state,attempt_count,"
              "updated_at,provider_status,ticket_ids) values (?,?,?,?,?,?,?,?,?)",
              (EV, order, "x", "to-%s@example.invalid" % TAG, state, 1, at, provider, str(ticket)))
    c.commit(); c.close()

print("\n== One status per ticket, in Email Center's words")
opened = person("Opened"); delivery("zz-o-" + TAG, opened.id, "accepted", "opened")
deliv = person("Deliv");   delivery("zz-d-" + TAG, deliv.id, "accepted", "delivered")
sent = person("Sent");     delivery("zz-s-" + TAG, sent.id, "accepted", None)
refused = person("Refused"); delivery("zz-r-" + TAG, refused.id, "rejected")
deferred = person("Deferred"); delivery("zz-f-" + TAG, deferred.id, "accepted", "failed")
twice = person("Twice")
delivery("zz-t1-" + TAG, twice.id, "accepted", "failed", at="2026-11-12T10:00:00+00:00")
delivery("zz-t2-" + TAG, twice.id, "accepted", "delivered", at="2026-11-13T10:00:00+00:00")
waiting = person("Waiting")
crew = person("Crew", kind="staff", source="admin")
stand = person("Stand", kind="exhibitor", source="admin"); delivery("ticket:%d" % 0 + TAG, stand.id, "accepted", "opened")
gone = person("Gone", status="cancelled")

rows = M.get_attendees(event_id=EV, db=db, current_user=db.query(models.User).filter(models.User.is_admin == True).first())  # noqa: E712
by = {a.id: a for a in rows}
st = lambda a: (by[a.id].ticket_email or {}).get("status")
check(st(opened) == "opened", "Opened email: opened")
check(st(deliv) == "delivered", "Delivered email: delivered")
check(st(sent) == "accepted", "GHL took it, no news yet: accepted (shown as Sent)")
check(st(refused) == "failed", "GHL refused it: failed")
check(st(deferred) == "failed", "Receiving server failed it: failed")
check(st(twice) == "delivered", "Sent twice: the latest email counts")
check(st(waiting) == "not_sent", "Paid ticket with no email yet: not sent")
check(by[crew.id].ticket_email is None, "Crew badge: no ticket email at all, not 'not sent'")
check(st(stand) == "opened", "Stand staff sent by hand: their real status")
check(by[gone.id].ticket_email is None, "Cancelled ticket: not counted as waiting")
check((by[opened.id].ticket_email or {}).get("to") == "to-%s@example.invalid" % TAG
      and (by[opened.id].ticket_email or {}).get("at"), "Says where and when it went")

print("\n== The same answer Email Center gives")
everyone = [a for a in rows if a.event_id == EV]
mine = EC.attendee_email_status(db, EV, everyone)
mism = []
for b in EC.bookings(db, EV, fresh=True)["bookings"]:
    for u in b.get("units", []):
        for tid in u.get("ticket_ids", []):
            m = (mine.get(tid) or {}).get("status")
            if m not in (u["delivery"], "held") and not (m is None and u["delivery"] == "not_sent"):
                mism.append((tid, m, u["delivery"]))
check(not mism, "Every ticket matches the Tickets tab", mism[:5])

print("\n== The list still loads when the delivery history cannot be read")
os.environ["TICKET_DELIVERY_DB"] = os.path.join(WORK, "missing", "nowhere.db")
try:
    rows2 = M.get_attendees(event_id=EV, db=db, current_user=db.query(models.User).filter(models.User.is_admin == True).first())  # noqa: E712
    check(len(rows2) == len(rows), "List loads, column left empty")
except Exception as exc:                                       # noqa: BLE001
    check(False, "List loads, column left empty", exc)
os.environ["TICKET_DELIVERY_DB"] = TDF

shutil.rmtree(WORK, ignore_errors=True)
print("\n%d failure(s)" % len(fails))
for f in fails:
    print("   - " + f)
sys.exit(1 if fails else 0)
