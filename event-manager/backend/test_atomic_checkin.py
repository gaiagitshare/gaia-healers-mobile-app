"""Atomic ticket admission using a fresh isolated SQLite database, no live APIs.

Run: python3 test_atomic_checkin.py
"""
import concurrent.futures
from datetime import datetime, timedelta
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import uuid

WORK = tempfile.TemporaryDirectory(prefix="gaia-atomic-")
os.environ["DATABASE_URL"] = "sqlite:///" + str(Path(WORK.name) / "tickets.db")
os.environ["EVENT_AUTO_SYNC_URLS"] = ""
sys.path.insert(0, str(Path(__file__).resolve().parent))
import main
import models
import schemas
from database import SessionLocal


class AtomicEntryTests(unittest.TestCase):
    def setUp(self):
        self.db = SessionLocal()
        event = models.Event(name="Atomic ticket fixture", start_date=datetime.utcnow()-timedelta(days=1),
                             end_date=datetime.utcnow()+timedelta(days=1), timezone="UTC", is_active=True)
        tt = models.TicketType(event_id=None, code="ATOMIC", name="VIP", is_vip=True,
                              grants_conference=True, grants_workshops=True, upgrade_rank=4)
        admin = models.User(email="fixture-"+uuid.uuid4().hex+"@example.invalid", is_admin=True, hashed_password="fixture")
        self.db.add_all([event, tt, admin]); self.db.flush(); tt.event_id=event.id
        self.event_id=event.id; self.user_id=admin.id; self.tt_id=tt.id
        self.db.commit()
        self.original=main._authorize_decision

    def tearDown(self):
        main._authorize_decision=self.original
        self.db.close()

    def ticket(self, status="registered"):
        import uuid
        a=models.Attendee(event_id=self.event_id, email="same-buyer@example.invalid",
                          first_name="", last_name="", ticket_type_id=self.tt_id,
                          custom_data={}, registration_status=status,
                          qr_code="ATT-"+uuid.uuid4().hex[:12].upper(),is_checked_in=False)
        self.db.add(a);self.db.commit();self.db.refresh(a);return a.id,a.qr_code

    def call(self, route, qr, event=None):
        db=SessionLocal()
        try:
            user=db.get(models.User,self.user_id)
            if route=="authorize":
                r=main.authorize_scan(event or self.event_id,schemas.AuthorizeRequest(qr_code=qr,access_type="EVENT_ENTRY"),db,user)
                return r["granted"],r.get("checked_in_now",False),r.get("reason","")
            req=schemas.CheckInRequest(qr_code=qr)
            r=(main.check_in_for_event(event or self.event_id,req,db,user) if route=="event"
               else main.check_in(req,db,user))
            return r.success,None,r.message
        finally:db.close()

    def race(self, routes, qr):
        barrier=threading.Barrier(len(routes));local=threading.local();original=self.original
        def decision(*args,**kwargs):
            result=original(*args,**kwargs)
            if not getattr(local,"waited",False):
                local.waited=True;barrier.wait(timeout=10)
            return result
        main._authorize_decision=decision
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(routes)) as pool:
            return list(pool.map(lambda route:self.call(route,qr),routes))

    def test_all_routes_share_one_initial_claim(self):
        for routes in [("event","event"),("global","global"),("authorize","authorize"),
                       ("event","authorize"),("global","authorize")]:
            aid,qr=self.ticket();results=self.race(routes,qr)
            self.assertEqual(sum(r[0] for r in results),1,results)
            self.assertIn("already checked in",next(r[2] for r in results if not r[0]))
            main._authorize_decision=self.original
            self.db.expire_all();self.assertTrue(self.db.get(models.Attendee,aid).is_checked_in)
            logs=self.db.query(models.ScanLog).filter_by(attendee_id=aid).all()
            self.assertEqual(len(logs),2);self.assertEqual(sum(x.result=="GRANTED" for x in logs),1)

    def test_reentry_preserves_original_timestamp(self):
        event=self.db.get(models.Event,self.event_id);event.allow_reentry=True;self.db.commit()
        aid,qr=self.ticket();results=self.race(("authorize","authorize"),qr)
        self.assertTrue(all(r[0] for r in results));self.assertEqual(sum(r[1] for r in results),1)
        main._authorize_decision=self.original;self.db.expire_all();stamp=self.db.get(models.Attendee,aid).checked_in_at
        self.assertTrue(self.call("global",qr)[0]);self.db.expire_all()
        self.assertEqual(self.db.get(models.Attendee,aid).checked_in_at,stamp)

    def test_five_tickets_for_one_email_remain_independent(self):
        tickets=[self.ticket() for _ in range(5)]
        self.assertEqual(len({q for _,q in tickets}),5)
        self.assertTrue(all(self.call("event",q)[0] for _,q in tickets))
        self.assertFalse(self.call("event",tickets[0][1])[0])
        self.assertEqual(self.db.query(models.Attendee).filter_by(event_id=self.event_id).count(),5)

    def test_revoked_refunded_cancelled_and_wrong_event_are_denied(self):
        for status in ["revoked","refunded","cancelled"]:
            _,qr=self.ticket(status);self.assertFalse(self.call("event",qr)[0])
        _,qr=self.ticket()
        other=models.Event(name="Other",start_date=datetime.utcnow(),end_date=datetime.utcnow()+timedelta(days=1))
        self.db.add(other);self.db.commit();self.assertFalse(self.call("event",qr,other.id)[0])

    def test_revocation_between_decision_and_claim_cannot_admit(self):
        aid,qr=self.ticket();a=self.db.get(models.Attendee,aid);event=self.db.get(models.Event,self.event_id)
        decision=self.original(self.db,a,event,"EVENT_ENTRY");self.assertTrue(decision["granted"])
        with SessionLocal() as writer:
            writer.get(models.Attendee,aid).registration_status="revoked";writer.commit()
        decision,claimed=main._claim_initial_entry(self.db,a,event,decision)
        self.assertFalse(claimed);self.assertFalse(decision["granted"]);self.db.rollback()

    def test_claim_and_audit_rollback_together(self):
        aid,_=self.ticket();a=self.db.get(models.Attendee,aid);event=self.db.get(models.Event,self.event_id)
        decision=self.original(self.db,a,event,"EVENT_ENTRY")
        _,claimed=main._claim_initial_entry(self.db,a,event,decision);self.assertTrue(claimed)
        self.db.add(models.ScanLog(event_id=self.event_id,attendee_id=aid,result="GRANTED"));self.db.rollback()
        self.db.expire_all();self.assertFalse(self.db.get(models.Attendee,aid).is_checked_in)
        self.assertEqual(self.db.query(models.ScanLog).filter_by(attendee_id=aid).count(),0)




class OverrideAndUndoTests(AtomicEntryTests):
    """3 Nov 2026: every path that sets or clears a check-in uses one atomic update."""

    def override(self, aid, user_id=None):
        db=SessionLocal()
        try:
            user=db.get(models.User,user_id or self.user_id)
            r=main.override_admit(self.event_id,aid,schemas.OverrideAdmit(reason="queue fixture",access_type="EVENT_ENTRY"),db,user)
            return True,r.get("checked_in_now",False),r.get("reason","")
        finally:db.close()

    def undo(self, aid):
        db=SessionLocal()
        try:
            user=db.get(models.User,self.user_id)
            r=main.undo_checkin(self.event_id,aid,schemas.UndoCheckIn(reason="mis-scan fixture"),db,user)
            return r["already"]
        finally:db.close()

    def race_calls(self, fns):
        barrier=threading.Barrier(len(fns));local=threading.local();original=self.original
        def decision(*args,**kwargs):
            result=original(*args,**kwargs)
            if not getattr(local,"waited",False):
                local.waited=True
                try:barrier.wait(timeout=10)
                except threading.BrokenBarrierError:pass
            return result
        main._authorize_decision=decision
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(fns)) as pool:
                return list(pool.map(lambda f:f(),fns))
        finally:main._authorize_decision=self.original

    def test_two_overrides_record_one_first_entry(self):
        aid,qr=self.ticket()
        r=self.race_calls([lambda:self.override(aid),lambda:self.override(aid)])
        self.assertEqual(sum(1 for x in r if x[1]),1,r)
        db=SessionLocal();a=db.get(models.Attendee,aid)
        self.assertTrue(a.is_checked_in)
        self.assertEqual(db.query(models.ScanLog).filter_by(attendee_id=aid,result="OVERRIDE").count(),2,"both overrides stay on record")
        db.close()

    def test_override_and_scan_at_the_same_moment_admit_once(self):
        aid,qr=self.ticket()
        r=self.race_calls([lambda:self.override(aid),lambda:self.call("authorize",qr)])
        firsts=(1 if r[0][1] else 0)+(1 if r[1][1] else 0)
        self.assertEqual(firsts,1,r)

    def test_undo_twice_records_one_undo_and_keeps_the_original_time(self):
        aid,qr=self.ticket();self.call("authorize",qr)
        db=SessionLocal();was=db.get(models.Attendee,aid).checked_in_at;db.close()
        r=self.race_calls([lambda:self.undo(aid),lambda:self.undo(aid)])
        self.assertEqual(sorted(r),[False,True],r)
        db=SessionLocal();a=db.get(models.Attendee,aid)
        self.assertFalse(a.is_checked_in)
        self.assertEqual(db.query(models.ScanLog).filter_by(attendee_id=aid,result="UNDO").count(),1)
        life=[e for e in (a.custom_data or {}).get("lifecycle",[]) if e.get("action")=="checkin_undone"]
        self.assertEqual(len(life),1);self.assertEqual(life[0].get("was"),was.isoformat())
        db.close()

    def test_door_staff_cannot_override_a_refunded_ticket(self):
        aid,qr=self.ticket(status="refunded")
        db=SessionLocal()
        staff=models.User(email="door-"+uuid.uuid4().hex+"@example.invalid",is_admin=False,hashed_password="fixture")
        db.add(staff);db.flush()
        db.add(models.EventRole(event_id=self.event_id,user_id=staff.id,role="checkin_staff"));db.commit();sid=staff.id;db.close()
        with self.assertRaises(main.HTTPException) as e:self.override(aid,user_id=sid)
        self.assertEqual(e.exception.status_code,403)
        ok,first,_=self.override(aid)
        self.assertTrue(ok and first,"an organiser/admin can still let them in, on the record")

if __name__=="__main__":
    try:unittest.main(verbosity=2)
    finally:WORK.cleanup()
