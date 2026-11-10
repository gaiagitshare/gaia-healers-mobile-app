# -*- coding: utf-8 -*-
"""Email Center records, kept in the shared delivery history file.

Everything here is additive: new tables created if missing, nothing in the
existing tables rewritten. It lives next to order_ticket_delivery on purpose:
the claim that stops a ticket email being sent twice is in that file, and the
review that allows a send has to be read in the same place.

  ec_reviews            one row per booking: its review state and the exact
                        fingerprint of what was reviewed/approved
  ec_review_log         append-only: every review action, by whom, when
  ec_batches            a sending run started from the Email Center
  ec_batch_items        what each run was asked to send and what happened
  ec_exhibitor_emails   per stand and kind (setup | scanner): current state
  ec_exhibitor_attempts append-only: every exhibitor email attempt
  ec_attention          Needs Attention: who owns an item, and its status

No import of the Event Manager here: the automatic sender's timer imports this
module to poll exhibitor email statuses, and must stay light.
"""
import json
from datetime import datetime, timedelta, timezone

from . import state as st

REVIEW_STATES = ("pending_review", "verified", "approved", "held", "needs_correction")
RECHECK_HOURS = 72          # keep asking GHL about a delivered email this long (opens/clicks)
RECHECK_MINUTES = 30        # ... at most this often


def now():
    return datetime.now(timezone.utc).isoformat()


def ensure(db):
    db.execute('''create table if not exists ec_reviews(event_id integer, booking_key text, state text, fingerprint text,
        reviewed_by text, reviewed_at text, approved_by text, approved_at text, note text, updated_at text,
        primary key(event_id, booking_key))''')
    db.execute('''create table if not exists ec_review_log(id integer primary key autoincrement, event_id integer, booking_key text,
        at text, actor text, action text, from_state text, to_state text, fingerprint text, note text)''')
    db.execute('''create table if not exists ec_batches(id integer primary key autoincrement, event_id integer, kind text,
        created_by text, created_at text, state text, template_sha text, confirm_token text, counts text,
        runner text, heartbeat_at text, finished_at text, paused_by text, note text)''')
    db.execute('''create table if not exists ec_batch_items(id integer primary key autoincrement, batch_id integer, item_key text,
        state text default 'queued', result text, updated_at text)''')
    db.execute('''create table if not exists ec_exhibitor_emails(event_id integer, exhibitor_id integer, kind text, state text,
        recipient text, contact_id text, attempt_count integer default 0, message_id text, result text, provider_status text,
        provider_checked_at text, link_url text, link_expires_at text, sent_by text, sent_at text, updated_at text,
        primary key(event_id, exhibitor_id, kind))''')
    db.execute('''create table if not exists ec_exhibitor_attempts(id integer primary key autoincrement, event_id integer,
        exhibitor_id integer, kind text, recipient text, state text, message_id text, result text, reason text, at text, actor text)''')
    db.execute('''create table if not exists ec_exhibitor_contacts(event_id integer, exhibitor_id integer, email text,
        status text, contact_id text, checked_at text, checked_by text, created_contact integer default 0,
        primary key(event_id, exhibitor_id))''')
    db.execute('''create table if not exists ec_attention(event_id integer, item_key text, status text, assigned_to text, note text,
        updated_by text, updated_at text, primary key(event_id, item_key))''')


# -- reviews -----------------------------------------------------------------
def reviews(db, event_id):
    out = {}
    for r in db.execute('select booking_key,state,fingerprint,reviewed_by,reviewed_at,approved_by,approved_at,note,updated_at '
                        'from ec_reviews where event_id=?', (event_id,)):
        out[r[0]] = {"state": r[1], "fingerprint": r[2], "reviewed_by": r[3], "reviewed_at": r[4],
                     "approved_by": r[5], "approved_at": r[6], "note": r[7], "updated_at": r[8]}
    return out


def set_review(db, event_id, key, to_state, actor, fingerprint, note=""):
    """Record one review action atomically, with its log row."""
    db.execute("begin immediate")
    try:
        r = db.execute('select state,reviewed_by,reviewed_at,approved_by,approved_at from ec_reviews where event_id=? and booking_key=?',
                       (event_id, key)).fetchone()
        prev = r[0] if r else "pending_review"
        reviewed_by, reviewed_at, approved_by, approved_at = (r[1], r[2], r[3], r[4]) if r else (None, None, None, None)
        t = now()
        if to_state in ("verified", "approved"):
            reviewed_by, reviewed_at = actor, t
        if to_state == "approved":
            approved_by, approved_at = actor, t
        elif to_state != "approved":
            approved_by, approved_at = None, None
        db.execute('''insert into ec_reviews(event_id,booking_key,state,fingerprint,reviewed_by,reviewed_at,approved_by,approved_at,note,updated_at)
                      values(?,?,?,?,?,?,?,?,?,?) on conflict(event_id,booking_key) do update set state=excluded.state,
                      fingerprint=excluded.fingerprint,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,
                      approved_by=excluded.approved_by,approved_at=excluded.approved_at,note=excluded.note,updated_at=excluded.updated_at''',
                   (event_id, key, to_state, fingerprint, reviewed_by, reviewed_at, approved_by, approved_at, note or "", t))
        log(db, event_id, key, actor, to_state, prev, to_state, fingerprint, note)
        db.execute("commit")
    except Exception:
        db.execute("rollback")
        raise
    return prev


def log(db, event_id, key, actor, action, from_state=None, to_state=None, fingerprint=None, note=""):
    db.execute('insert into ec_review_log(event_id,booking_key,at,actor,action,from_state,to_state,fingerprint,note) values(?,?,?,?,?,?,?,?,?)',
               (event_id, key, now(), actor, action, from_state, to_state, fingerprint, note or ""))


def review_log(db, event_id, key):
    return [{"at": r[0], "actor": r[1], "action": r[2], "from": r[3], "to": r[4], "note": r[5]}
            for r in db.execute('select at,actor,action,from_state,to_state,note from ec_review_log where event_id=? and booking_key=? order by id',
                                (event_id, key))]


# -- exhibitor emails --------------------------------------------------------
def exhibitor_rows(db, event_id):
    out = {}
    for r in db.execute('select exhibitor_id,kind,state,recipient,attempt_count,message_id,result,provider_status,provider_checked_at,'
                        'link_expires_at,sent_by,sent_at,updated_at from ec_exhibitor_emails where event_id=?', (event_id,)):
        out[(r[0], r[1])] = {"state": r[2], "recipient": r[3], "attempts": r[4], "message_id": r[5], "result": r[6],
                             "provider_status": r[7], "provider_checked_at": r[8], "link_expires_at": r[9],
                             "sent_by": r[10], "sent_at": r[11], "updated_at": r[12]}
    return out


def exhibitor_claim(db, event_id, exhibitor_id, kind, recipient, actor, resend_reason=None, retry_failed=False):
    """True = this caller may send now. Same rules as the ticket claim: a first
    send, a retry of a definite rejection, or a reasoned resend of an accepted
    email. Never while one is 'sending' or its outcome is 'unknown'."""
    db.execute("begin immediate")
    try:
        r = db.execute('select state from ec_exhibitor_emails where event_id=? and exhibitor_id=? and kind=?',
                       (event_id, exhibitor_id, kind)).fetchone()
        kind_of = "initial"
        if r and r[0] not in (None, "", "manual", "prepared"):
            if r[0] == "rejected" and (retry_failed or resend_reason):
                kind_of = "retry"
            elif r[0] == "accepted" and resend_reason:
                kind_of = "resend"
            else:
                db.execute("commit")
                return None
        t = now()
        db.execute('''insert into ec_exhibitor_emails(event_id,exhibitor_id,kind,state,recipient,attempt_count,updated_at)
                      values(?,?,?,?,?,1,?) on conflict(event_id,exhibitor_id,kind) do update set state='sending',
                      recipient=excluded.recipient,attempt_count=coalesce(attempt_count,0)+1,updated_at=excluded.updated_at''',
                   (event_id, exhibitor_id, kind, "sending", recipient, t))
        db.execute('insert into ec_exhibitor_attempts(event_id,exhibitor_id,kind,recipient,state,message_id,result,reason,at,actor) values(?,?,?,?,?,?,?,?,?,?)',
                   (event_id, exhibitor_id, kind, recipient, "sending", "", "", resend_reason or "", t, actor))
        db.execute("commit")
        return kind_of
    except Exception:
        db.execute("rollback")
        raise


def exhibitor_finish(db, event_id, exhibitor_id, kind, state, actor, message_id="", result="", contact_id="", reason=""):
    t = now()
    db.execute('''update ec_exhibitor_emails set state=?,message_id=?,result=?,contact_id=?,provider_status=null,provider_checked_at=null,
                  sent_by=?,sent_at=? where event_id=? and exhibitor_id=? and kind=?''',
               (state, message_id, result, contact_id, actor, t, event_id, exhibitor_id, kind))
    rec = db.execute('select recipient from ec_exhibitor_emails where event_id=? and exhibitor_id=? and kind=?',
                     (event_id, exhibitor_id, kind)).fetchone()
    db.execute('insert into ec_exhibitor_attempts(event_id,exhibitor_id,kind,recipient,state,message_id,result,reason,at,actor) values(?,?,?,?,?,?,?,?,?,?)',
               (event_id, exhibitor_id, kind, rec[0] if rec else "", state, message_id, result, reason, t, actor))


def exhibitor_manual(db, event_id, exhibitor_id, kind, recipient, actor, note):
    """'Sent it myself': recorded honestly, delivery unknown."""
    t = now()
    db.execute('''insert into ec_exhibitor_emails(event_id,exhibitor_id,kind,state,recipient,attempt_count,result,sent_by,sent_at,updated_at)
                  values(?,?,?,'manual',?,1,?,?,?,?) on conflict(event_id,exhibitor_id,kind) do update set
                  state=case when state in ('accepted','sending','unknown') then state else 'manual' end,
                  attempt_count=coalesce(attempt_count,0)+1,result=excluded.result,sent_by=excluded.sent_by,
                  sent_at=excluded.sent_at,updated_at=excluded.updated_at''',
               (event_id, exhibitor_id, kind, recipient, "Sent manually by an administrator; delivery not tracked", actor, t, t))
    db.execute('insert into ec_exhibitor_attempts(event_id,exhibitor_id,kind,recipient,state,message_id,result,reason,at,actor) values(?,?,?,?,?,?,?,?,?,?)',
               (event_id, exhibitor_id, kind, recipient, "manual", "", "Sent manually; delivery not tracked", note or "", t, actor))


def exhibitor_link(db, event_id, exhibitor_id):
    """The setup link this Email Center last minted, while it is still valid."""
    r = db.execute("select link_url,link_expires_at from ec_exhibitor_emails where event_id=? and exhibitor_id=? and kind='setup'",
                   (event_id, exhibitor_id)).fetchone()
    if r and r[0] and r[1] and r[1] > now():
        return r[0], r[1]
    return None, None


def store_link(db, event_id, exhibitor_id, url, expires_at):
    t = now()
    db.execute('''insert into ec_exhibitor_emails(event_id,exhibitor_id,kind,state,link_url,link_expires_at,updated_at)
                  values(?,?,'setup','prepared',?,?,?) on conflict(event_id,exhibitor_id,kind) do update set
                  link_url=excluded.link_url,link_expires_at=excluded.link_expires_at,updated_at=excluded.updated_at''',
               (event_id, exhibitor_id, url, expires_at, t))


def exhibitor_history(db, event_id, exhibitor_id=None):
    q = 'select id,exhibitor_id,kind,recipient,state,message_id,result,reason,at,actor from ec_exhibitor_attempts where event_id=?'
    args = [event_id]
    if exhibitor_id is not None:
        q += ' and exhibitor_id=?'
        args.append(exhibitor_id)
    return [{"id": r[0], "exhibitor_id": r[1], "kind": r[2], "recipient": r[3], "state": r[4], "message_id": r[5],
             "result": r[6], "reason": r[7], "at": r[8], "actor": r[9]} for r in db.execute(q + ' order by id', args)]


# -- provider status ---------------------------------------------------------
def due_for_status(table_state, provider_status, provider_checked_at, sent_at, t0=None):
    """Should GHL be asked again about this message?

    Not yet final: every few minutes. Delivered or opened: GHL keeps only the
    latest status, so a later open/click overwrites it -- keep asking for three
    days, at most every half hour. Failed, bounced, clicked: final."""
    t0 = t0 or datetime.now(timezone.utc)
    if table_state != "accepted":
        return False
    p = (provider_status or "").lower()
    checked = _ts(provider_checked_at)
    if p in st.BAD_PROVIDER or p == "clicked":
        return False
    if p in ("delivered", "opened", "read"):
        sent = _ts(sent_at)
        if sent and t0 - sent > timedelta(hours=RECHECK_HOURS):
            return False
        return not checked or t0 - checked > timedelta(minutes=RECHECK_MINUTES)
    return not checked or t0 - checked > timedelta(minutes=2)


def _ts(s):
    if not s:
        return None
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def poll_exhibitors(db, status_of, limit=50):
    """Ask GHL about accepted exhibitor emails. status_of(message_id) -> str."""
    n = 0
    rows = db.execute("select event_id,exhibitor_id,kind,state,message_id,provider_status,provider_checked_at,sent_at "
                      "from ec_exhibitor_emails where state='accepted' and coalesce(message_id,'')!=''").fetchall()
    for ev, ex, kind, s, mid, p, chk, sent in rows:
        if n >= limit:
            break
        if not due_for_status(s, p, chk, sent):
            continue
        status = status_of(mid)
        db.execute('update ec_exhibitor_emails set provider_status=?,provider_checked_at=? where event_id=? and exhibitor_id=? and kind=?',
                   (status, now(), ev, ex, kind))
        n += 1
    return n


def poll_tickets(db, status_of, limit=100):
    """Ask GHL about accepted ticket emails (every sender's)."""
    n = 0
    rows = db.execute("select event_id,order_id,state,message_id,provider_status,provider_checked_at,updated_at "
                      "from order_ticket_delivery where state='accepted' and coalesce(message_id,'')!=''").fetchall()
    for ev, oid, s, mid, p, chk, sent in rows:
        if n >= limit:
            break
        if not due_for_status(s, p, chk, sent):
            continue
        status = status_of(mid)
        db.execute('update order_ticket_delivery set provider_status=?,provider_checked_at=? where event_id=? and order_id=?',
                   (status, now(), ev, oid))
        n += 1
    return n


def counts_json(d):
    return json.dumps(d, sort_keys=True)


# -- exhibitor GHL contact checks (read-only lookups, remembered) -------------
def contact_checks(db, event_id):
    return {r[0]: {"email": r[1], "status": r[2], "contact_id": r[3], "checked_at": r[4], "checked_by": r[5], "created": bool(r[6])}
            for r in db.execute("select exhibitor_id,email,status,contact_id,checked_at,checked_by,created_contact "
                                "from ec_exhibitor_contacts where event_id=?", (event_id,))}


def save_contact_check(db, event_id, exhibitor_id, email, status, contact_id, actor, created=False):
    db.execute("""insert into ec_exhibitor_contacts(event_id,exhibitor_id,email,status,contact_id,checked_at,checked_by,created_contact)
                  values(?,?,?,?,?,?,?,?) on conflict(event_id,exhibitor_id) do update set email=excluded.email,status=excluded.status,
                  contact_id=excluded.contact_id,checked_at=excluded.checked_at,checked_by=excluded.checked_by,
                  created_contact=max(created_contact,excluded.created_contact)""",
               (event_id, exhibitor_id, email, status, contact_id, now(), actor, 1 if created else 0))
