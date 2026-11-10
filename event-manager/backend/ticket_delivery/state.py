# -*- coding: utf-8 -*-
"""The one delivery history every ticket-email sender shares.

data/ticket-delivery.db is the file the bulk sender (order_delivery.py) has
written since the first real delivery on 3 Nov 2026. Same tables, same claim:
one row per (event, order), taken under BEGIN IMMEDIATE before anything is
sent, so two senders -- bulk and automatic, or two runs of either -- can never
both send the same order. Everything added here is additive: new tables and
nullable columns, created if missing, never a rewrite of what is there.

  order_ticket_delivery  current state per order (accepted / unknown / rejected)
                         and, separately, what GHL later reports (provider_status)
  delivery_attempts      append-only history: initial, retry, resend, test
  delivery_control       mode (shadow | live | paused) and the job's heartbeat
  delivery_candidates    every order the automatic sender has looked at, with its
                         classification and reasons -- the review list
  resend_requests        an admin's resend, with the reason, waiting for the job
  delivery_admin_audit   every admin action on any of the above
"""
import json
import os
import sqlite3
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def db_path():
    return os.environ.get("TICKET_DELIVERY_DB") or os.path.join(HERE, "data", "ticket-delivery.db")


def now():
    return datetime.now(timezone.utc).isoformat()


# A message GHL has finished with. Anything else is still worth asking about.
FINAL_PROVIDER = {"delivered", "opened", "clicked", "failed", "bounced", "rejected", "complained", "undelivered", "permanent_fail"}
BAD_PROVIDER = {"failed", "bounced", "rejected", "complained", "undelivered", "permanent_fail"}

MODES = ("shadow", "live", "paused")


class DeliveryState:
    def __init__(self, path=None):
        path = path or db_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.db = sqlite3.connect(path, timeout=30, isolation_level=None)
        self.db.execute("pragma journal_mode=wal")
        self.db.execute('''create table if not exists order_ticket_delivery(event_id integer, order_id text, manifest_sha text, recipient text, state text, attempt_count integer default 0, message_id text, result text, updated_at text, primary key(event_id,order_id))''')
        cols = {r[1] for r in self.db.execute('pragma table_info(order_ticket_delivery)')}
        for col in ('provider_status', 'provider_checked_at', 'ticket_ids'):
            if col not in cols:
                self.db.execute('alter table order_ticket_delivery add column %s text' % col)
        self.db.execute('''create table if not exists delivery_attempts(id integer primary key autoincrement, event_id integer, order_id text, kind text, recipient text, manifest_sha text, ticket_ids text, state text, message_id text, result text, reason text, at text)''')
        cols = {r[1] for r in self.db.execute('pragma table_info(delivery_attempts)')}
        if 'actor' not in cols:
            # NULL = the bulk sender, which predates this column.
            self.db.execute('alter table delivery_attempts add column actor text')
        self.db.execute('''create table if not exists delivery_control(key text primary key, value text, updated_at text, updated_by text)''')
        self.db.execute('''create table if not exists delivery_candidates(event_id integer, order_id text, source text, first_seen text, paid_at text, last_checked text,
            classification text, reasons text, recipient text, buyer_name text, ticket_ids text, categories text,
            shadow_would_send_at text, alerted_key text, updated_at text, primary key(event_id,order_id))''')
        self.db.execute('''create table if not exists resend_requests(id integer primary key autoincrement, event_id integer, order_id text, reason text,
            requested_by text, requested_at text, state text default 'pending', result text, processed_at text)''')
        self.db.execute('''create table if not exists delivery_admin_audit(id integer primary key autoincrement, at text, actor text, action text,
            event_id integer, order_id text, reason text, detail text)''')
        self.actor = None

    # -- control ---------------------------------------------------------------
    def get(self, key, default=None):
        r = self.db.execute('select value from delivery_control where key=?', (key,)).fetchone()
        return r[0] if r else default

    def put(self, key, value, by='system'):
        self.db.execute('insert into delivery_control(key,value,updated_at,updated_by) values(?,?,?,?) '
                        'on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
                        (key, value, now(), by))

    def mode(self):
        # Nothing configured means shadow: a fresh install can never send by itself.
        m = self.get('mode', 'shadow')
        return m if m in MODES else 'paused'

    def audit(self, actor, action, event_id=None, order_id=None, reason='', detail=None):
        self.db.execute('insert into delivery_admin_audit(at,actor,action,event_id,order_id,reason,detail) values(?,?,?,?,?,?,?)',
                        (now(), actor, action, event_id, order_id, reason or '', json.dumps(detail) if detail is not None else None))

    # -- the claim (identical rules to order_delivery.DeliveryState) ----------
    def _log(self, order, kind, state, manifest_sha, message_id='', result='', reason=''):
        self.db.execute('insert into delivery_attempts(event_id,order_id,kind,recipient,manifest_sha,ticket_ids,state,message_id,result,reason,at,actor) values(?,?,?,?,?,?,?,?,?,?,?,?)',
                        (order['event']['id'], order['order_id'], kind, order['recipient'], manifest_sha,
                         ';'.join(str(t['ticket_id']) for t in order['tickets']), state, message_id, result, reason, now(), self.actor))

    def delivered(self, event_id, order_id):
        return self.db.execute('select state from order_ticket_delivery where event_id=? and order_id=?', (event_id, order_id)).fetchone()

    def claim(self, order, manifest_sha, retry_rejected=False, resend_reason=None, allow_changed=False):
        """True = this caller may send now. Without resend_reason only a first
        send (or an explicitly allowed retry of a DEFINITE rejection) is possible.
        A resend applies only to an accepted/delivered order, never to an
        'unknown' or 'sending' one, whose outcome must be looked at first."""
        self.db.execute('begin immediate')
        try:
            key = (order['event']['id'], order['order_id'])
            r = self.db.execute('select state,recipient,manifest_sha from order_ticket_delivery where event_id=? and order_id=?', key).fetchone()
            kind = 'initial'
            if r:
                # allow_changed (Email Center): a DEFINITE rejection may be retried to a
                # corrected address once the booking was reviewed and approved again.
                if r[0] == 'rejected' and retry_rejected and (allow_changed or (r[1] == order['recipient'] and r[2] == manifest_sha)):
                    kind = 'retry'
                elif resend_reason and r[0] in ('accepted', 'delivered'):
                    kind = 'resend'
                else:
                    self.db.execute('commit')
                    return False
            self.db.execute('''insert into order_ticket_delivery(event_id,order_id,manifest_sha,recipient,state,attempt_count,message_id,result,updated_at,ticket_ids) values(?,?,?,?,?,1,null,null,?,?) on conflict(event_id,order_id) do update set state='sending',attempt_count=attempt_count+1,updated_at=excluded.updated_at,recipient=excluded.recipient,manifest_sha=excluded.manifest_sha''',
                            (*key, manifest_sha, order['recipient'], 'sending', now(), ';'.join(str(t['ticket_id']) for t in order['tickets'])))
            self._log(order, kind, 'sending', manifest_sha, reason=resend_reason or '')
            self.db.execute('commit')
            self._kind = kind
            self._reason = resend_reason or ''
            return True
        except Exception:
            self.db.execute('rollback')
            raise

    def finish(self, order, status, message_id='', result=''):
        self.db.execute('update order_ticket_delivery set state=?,message_id=?,result=?,updated_at=?,provider_status=null,provider_checked_at=null where event_id=? and order_id=?',
                        (status, message_id, result, now(), order['event']['id'], order['order_id']))
        r = self.db.execute('select manifest_sha from order_ticket_delivery where event_id=? and order_id=?', (order['event']['id'], order['order_id'])).fetchone()
        self._log(order, getattr(self, '_kind', 'initial'), status, r[0] if r else '', message_id, result, getattr(self, '_reason', ''))

    def set_provider_status(self, event_id, order_id, status):
        self.db.execute('update order_ticket_delivery set provider_status=?,provider_checked_at=? where event_id=? and order_id=?',
                        (status, now(), event_id, order_id))

    def close(self):
        self.db.close()


def deliver(order, state, manifest_sha, validate, transport, render, retry_rejected=False, resend_reason=None, allow_changed=False):
    """Validate -> claim -> send -> record. Same contract as order_delivery.deliver."""
    payload = render(order)
    valid, why = validate(order)
    if not valid:
        return {'order_id': order['order_id'], 'state': 'held', 'reason': why}
    if not state.claim(order, manifest_sha, retry_rejected, resend_reason, allow_changed):
        return {'order_id': order['order_id'], 'state': 'skipped_existing_delivery'}
    try:
        result = transport(order, payload)
    except Exception:
        state.finish(order, 'unknown', result='Ambiguous transport outcome; inspect provider before retry')
        return {'order_id': order['order_id'], 'state': 'unknown'}
    if result.get('ok') and result.get('messageId'):
        state.finish(order, 'accepted', result['messageId'], 'Provider accepted; delivery not yet confirmed')
        return {'order_id': order['order_id'], 'state': 'accepted', 'message_id': result['messageId']}
    status = 'rejected' if result.get('definitely_rejected') else 'unknown'
    state.finish(order, status, result=str(result.get('reason') or 'No message acknowledgement')[:200])
    return {'order_id': order['order_id'], 'state': status}
