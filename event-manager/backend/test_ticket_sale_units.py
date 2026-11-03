import unittest
from ticket_sale_units import plan_paid_units

class PurchaseUnitTests(unittest.TestCase):
    def order(self,id="o1",**kw):return dict(id=id,source="ghl_order",status="completed",payment_status="paid",live_mode=True,**kw)
    def line(self,id="l1",q=1,tt=8,role="BASE"):return dict(id=id,quantity=q,event_id=1,ticket_type_id=tt,role=role)
    def tx(self,id="tx1",order="o1",status="succeeded",refund=0):return dict(id=id,order_id=order,status=status,amount_refunded=refund)
    def test_five_tickets_one_order_same_buyer(self):
        r=plan_paid_units(self.order(),[self.line(q=5)],[self.tx()]);self.assertEqual(len(set(r['units'])),5);self.assertEqual(r['holds'],[])
    def test_three_today_two_tomorrow_preserved(self):
        a=plan_paid_units(self.order(),[self.line(q=3)],[self.tx()]);b=plan_paid_units(self.order('o2'),[self.line(q=2)],[self.tx('tx2','o2')]);self.assertEqual(len(set(a['units']+b['units'])),5)
    def test_failed_then_success_is_one_ticket(self):
        r=plan_paid_units(self.order(),[self.line()],[self.tx('failed',status='failed'),self.tx()]);self.assertEqual(len(r['units']),1);self.assertEqual(r['holds'],[])
    def test_failed_order_then_separate_successful_order(self):
        failed=self.order();failed.update(status='pending',payment_status='unpaid')
        a=plan_paid_units(failed,[self.line()],[self.tx(status='failed')]);b=plan_paid_units(self.order('o2'),[self.line()],[self.tx('tx2','o2')]);self.assertEqual(len(a['units']+b['units']),1)
    def test_replayed_webhook_is_not_another_ticket(self):
        r=plan_paid_units(self.order(),[self.line(),self.line()],[self.tx(),self.tx()]);self.assertEqual(len(r['units']),1);self.assertEqual(r['holds'],[])
    def test_two_successful_charges_one_order_need_review_not_extra_ticket(self):
        r=plan_paid_units(self.order(),[self.line()],[self.tx(),self.tx('tx2')]);self.assertEqual(len(r['units']),1);self.assertIn('multiple_successful_charges_one_order_review',r['holds'])
    def test_different_categories_same_order_are_distinct_units(self):
        r=plan_paid_units(self.order(),[self.line('ga',tt=8),self.line('vip',tt=4)],[self.tx()]);self.assertEqual({u.ticket_type_id for u in r['units']},{4,8})
    def test_upgrades_and_addons_do_not_mint_extra_tickets(self):
        r=plan_paid_units(self.order(),[self.line(),self.line('upgrade',role='UPGRADE'),self.line('addon',role='ADDON')],[self.tx()]);self.assertEqual(len(r['units']),1)
    def test_refund_does_not_guess_revoked_quantity(self):
        r=plan_paid_units(self.order(),[self.line(q=5)],[self.tx(status='partially_refunded',refund=20)]);self.assertEqual(len(r['units']),5);self.assertIn('refund_ticket_allocation_requires_documented_rule',r['holds'])
    def test_unconfirmed_and_malformed_sources_are_held(self):
        r=plan_paid_units(self.order(),[self.line(q=1.5)],[]);self.assertFalse(r['units']);self.assertIn('invalid_or_missing_line_quantity',r['holds']);self.assertIn('no_successful_payment_confirmation',r['holds'])
if __name__=='__main__':unittest.main(verbosity=2)
