"""Door payment history uses exact ticket/order links, never buyer-email joins."""
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

WORK=tempfile.TemporaryDirectory(prefix='gaia-door-history-')
os.environ['DATABASE_URL']='sqlite:///'+str(Path(WORK.name)/'history.db')
os.environ['EVENT_AUTO_SYNC_URLS']=''
sys.path.insert(0,str(Path(__file__).resolve().parent))
import main
import models
from database import SessionLocal

class PaymentHistoryTests(unittest.TestCase):
    def setUp(self):
        self.db=SessionLocal()
        self.event=models.Event(name='Fixture event',start_date=datetime(2026,11,20),end_date=datetime(2026,11,22))
        self.db.add(self.event);self.db.flush()
        self.ticket=models.Attendee(event_id=self.event.id,email='buyer@example.invalid',qr_code='ATT-'+uuid.uuid4().hex[:12].upper(),registration_status='registered',custom_data={'entitlements':[{'order_id':'order-linked'}]})
        self.db.add(self.ticket);self.db.commit()
    def tearDown(self):self.db.close()
    def pay(self,status,minutes=0,**kw):
        fields=dict(event_id=self.event.id,attendee_id=self.ticket.id,ghl_entity_id='order-linked',ghl_transaction_id='tx-'+uuid.uuid4().hex,status=status,amount=99,currency='usd',provider='stripe',occurred_at=datetime(2026,11,1,12)+timedelta(minutes=minutes),buyer_name='Private name',buyer_email='private@example.invalid',buyer_phone='private-phone')
        fields.update(kw);p=models.PaymentEvent(**fields);self.db.add(p);self.db.commit();return p
    def test_failed_pending_paid_are_chronological_without_changing_access_or_totals(self):
        self.pay('paid',2);self.pay('failed',0);self.pay('pending',1)
        before=self.ticket.registration_status;h=main._payment_history_for_ticket(self.db,self.ticket)
        self.assertEqual([p['status'] for p in h['items']],['failed','pending','paid'])
        self.assertEqual(h['counts']['failed'],1);self.assertEqual(h['counts']['paid'],1)
        self.assertEqual(main._money_for(self.db,self.ticket)['total'],99)
        self.assertEqual(self.ticket.registration_status,before);self.assertFalse(self.ticket.is_checked_in)
    def test_failed_attempt_without_attendee_follows_exact_order(self):
        self.pay('failed',attendee_id=None)
        h=main._payment_history_for_ticket(self.db,self.ticket)
        self.assertEqual(len(h['items']),1);self.assertEqual(h['items'][0]['association'],'linked_order')
    def test_same_email_other_order_and_other_event_are_excluded(self):
        self.pay('failed',attendee_id=None,ghl_entity_id='another-order',buyer_email=self.ticket.email)
        self.pay('paid',event_id=self.event.id+100)
        self.assertEqual(main._payment_history_for_ticket(self.db,self.ticket)['items'],[])
    def test_rebuilt_seat_uses_payment_assignment_not_fictitious_guest_email(self):
        self.ticket.custom_data={'source':'rebuilt_seat'};self.db.commit()
        self.pay('paid',ghl_entity_id='rebuilt-order');self.pay('failed',attendee_id=None,ghl_entity_id='rebuilt-order')
        h=main._payment_history_for_ticket(self.db,self.ticket)
        self.assertEqual(len(h['items']),2)
    def test_invoice_refunds_private_data_and_unknown_timestamp(self):
        self.ticket.custom_data={'entitlements':[{'invoice_id':'invoice-1'}]};self.db.commit()
        p=self.pay('partially_refunded',attendee_id=None,ghl_entity_id='invoice-1',amount_refunded=20,occurred_at=None)
        h=main._payment_history_for_ticket(self.db,self.ticket);item=h['items'][0]
        self.assertIsNone(item['at']);self.assertEqual(item['amount_refunded'],20)
        encoded=json.dumps(h);self.assertNotIn('private@example.invalid',encoded);self.assertNotIn('Private name',encoded);self.assertNotIn('private-phone',encoded);self.assertNotIn(p.ghl_transaction_id,encoded)
    def test_empty_and_unknown_status_are_explicit(self):
        self.assertEqual(main._payment_history_for_ticket(self.db,self.ticket)['items'],[])
        self.pay('declined',occurred_at=None)
        self.assertEqual(main._payment_history_for_ticket(self.db,self.ticket)['counts']['declined'],1)

if __name__=='__main__':
    try:unittest.main(verbosity=2)
    finally:WORK.cleanup()
