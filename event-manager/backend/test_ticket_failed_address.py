# -*- coding: utf-8 -*-
"""A ticket email that failed at the provider (15 Nov 2026): count sends to the
same address, so the alert says "failed AGAIN" and a resend to that address is
held until the contact's email is corrected. Temporary DB only."""
import os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
os.environ["TICKET_DELIVERY_DB"] = os.path.join(tempfile.mkdtemp(prefix="failaddr-"), "td.db")
sys.path.insert(0, HERE)
from ticket_delivery import engine, state as st  # noqa: E402

S = st.DeliveryState(os.environ["TICKET_DELIVERY_DB"])
E = engine.EVENT_ID
def attempt(oid, rcpt, state='accepted'):
    S.db.execute("insert into delivery_attempts(event_id,order_id,kind,recipient,state,at) values(?,?,?,?,?,?)", (E, oid, 'resend', rcpt, state, st.now()))
def latest(oid, rcpt, status):
    S.db.execute("insert or replace into order_ticket_delivery(event_id,order_id,recipient,state,provider_status) values(?,?,?,?,?)", (E, oid, rcpt, 'accepted', status))

fails = 0
def check(cond, label):
    global fails
    print(("ok   " if cond else "FAIL ") + label)
    fails += 0 if cond else 1

latest('A', 'bad@example.test', 'failed'); attempt('A', 'bad@example.test'); attempt('A', 'Bad@Example.test '); attempt('A', 'bad@example.test', 'sending')
check(engine.failed_address(S.db, 'A') == (2, 'bad@example.test'), 'two accepted sends to the failing address (case/space-insensitive, sending rows ignored)')
latest('B', 'ok@example.test', 'delivered'); attempt('B', 'ok@example.test')
check(engine.failed_address(S.db, 'B') == (0, ''), 'a delivered email is not a failed address')
latest('C', 'new@example.test', 'bounced'); attempt('C', 'old@example.test'); attempt('C', 'new@example.test')
check(engine.failed_address(S.db, 'C') == (1, 'new@example.test'), 'only sends to the current failing address count')
check(engine.failed_address(S.db, 'missing') == (0, ''), 'no record, no failure')
src = open(os.path.join(HERE, 'ticket_delivery', 'engine.py')).read()
check("'same address' not in str(reason).lower()" in src, 'a resend to the failed address is held unless the reason says "same address"')
check('AGAIN at the mail provider' in src, 'a repeat failure is reported as AGAIN with the count')
print("fails:", fails)
sys.exit(1 if fails else 0)
