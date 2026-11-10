# -*- coding: utf-8 -*-
"""Automatic official-ticket email for new ELEVATE purchases.

Runs every 2 minutes (gaia-ticket-autodeliver.timer). Each cycle:

  1. mode: paused -> nothing at all. shadow -> classify and record "would send",
     send nothing to any customer. live -> send GREEN orders (needs the template
     fingerprint approved with `--approve-live`).
  2. delivery status: asks GHL what happened to messages it accepted
     (delivered / bounced / failed), for every sender's messages.
  3. admin resends: pending requests from the dashboard, each with a reason.
  4. new paid orders: first seen after the cutoff (orders before it belong to
     the bulk send) and paid at least 3 minutes ago. Each is classified; only
     GREEN may send, and only through the shared claim in state.py.
  5. alerts: new held orders, failures and bounces -> one internal email to the
     admin alert contact. Never to a customer.

GREEN means every one of these held at the moment of the check:
  * every mirrored payment for the order is paid, live, nothing refunded, and the
    live GHL order is completed/paid with only succeeded, unrefunded transactions;
  * exactly one active ticket is linked, with its own QR code and link, and the
    QR image decodes to that ticket and the ticket page opens;
  * the order is one seat of a mapped ticket product (not an upgrade, not
    several seats) and the ticket holds the category that product maps to;
  * the buyer has no other paid order for this event, and that ticket has not
    already been emailed under another order;
  * the GHL contact's email is valid, is the email the order was placed with,
    is the ticket's email, and is not do-not-disturb.
Anything else is YELLOW (a person decides) or RED (must not be sent), with the
reason, and shows in the admin dashboard. Nothing here writes to GHL, payments
or tickets.
"""
import hashlib
import html
import io
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from . import state as st
from . import ticket_email

HERE = st.HERE
EVENT_ID = int(os.environ.get("TICKET_DELIVERY_EVENT_ID", "1"))
SETTLE_MINUTES = 3
LIVE_CAP_PER_RUN = 20
LIVE_CAP_PER_DAY = 200
RECHECK_HELD_MINUTES = 30
STATUS_EVERY_MINUTES = 5
GHL_READ_CAP = 300
STATUS_PER_RUN = 200      # 10 Nov 2026: a 341-email run is re-checked within a few runs
# Set in the timer's unit file for the shadow period. While it is set nothing can
# reach a customer from this job: not a GREEN order, not a resend -- whatever the
# mode in the database says. Only the internal alert contact can be emailed.
HARD_SHADOW = os.environ.get('TICKET_AUTODELIVER_SHADOW_ONLY') == '1'
PUBLIC = "https://api.gaiahealers.app"
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
BLOCKED = {"revoked", "cancelled", "canceled", "refunded"}


def template_sha():
    return hashlib.sha256(open(ticket_email.__file__, 'rb').read()).hexdigest()


def _utc(s):
    if not s:
        return None
    s = str(s).replace('Z', '+00:00').replace(' ', 'T')
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# The outside world. Production wiring below; tests pass their own.
# ---------------------------------------------------------------------------
class Live:
    """GHL reads, the send route, the ticket's public QR/page, the alert contact.
    Credentials come from the proxy's environment file and are never printed."""

    def __init__(self):
        from dotenv import dotenv_values
        self.cfg = dict(dotenv_values('/root/gaia-staging-proxy/.env'))
        em = dict(dotenv_values(os.path.join(HERE, '.env')))
        self.em_token = em.get('IDENTITY_SERVICE_TOKEN') or self.cfg.get('IDENTITY_SERVICE_TOKEN')
        self.reads = 0
        qr = os.environ.get('GAIA_QRDEPS', '/opt/gaia-qrdeps')
        if os.path.isdir(qr) and qr not in sys.path:
            sys.path.insert(0, qr)

    def ghl(self, path):
        self.reads += 1
        if self.reads > GHL_READ_CAP:
            raise RuntimeError('GHL read cap for this run reached')
        base = (self.cfg.get('GHL_API_BASE_URL') or 'https://services.leadconnectorhq.com').rstrip('/')
        req = urllib.request.Request(base + path, headers={'Authorization': 'Bearer ' + self.cfg['GHL_API_TOKEN'], 'Version': '2021-07-28',
                                                           'Accept': 'application/json', 'User-Agent': 'Gaia-ticket-autodeliver'})
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.load(r)

    @property
    def location(self):
        return self.cfg['GHL_LOCATION_ID']

    def send(self, contact_id, payload):
        if HARD_SHADOW and contact_id != self.alert_contact():
            raise RuntimeError('shadow-only: refusing to email anyone but the alert contact')
        req = urllib.request.Request('http://127.0.0.1:8787/api/event/notify', data=json.dumps({'contactId': contact_id, **payload}).encode(),
                                     headers={'Authorization': 'Bearer ' + self.cfg['IDENTITY_SERVICE_TOKEN'], 'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=35) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            try:
                d = json.load(e)
            except Exception:
                d = {}
            return {'ok': False, 'reason': d.get('reason', 'gateway_error'),
                    'definitely_rejected': e.code in (400, 401, 403, 422) or d.get('reason') == 'scope_required'}

    def alert_contact(self):
        return (self.cfg.get('ALERT_CONTACT_ID') or '').strip()

    def fetch(self, url):
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Gaia-ticket-autodeliver'}), timeout=20) as r:
            return r.status, r.read()

    def decode_qr(self, png):
        import zxingcpp
        from PIL import Image
        img = Image.open(io.BytesIO(png)).convert('RGB')
        if img.width < 300:
            img = img.resize((img.width * 4, img.height * 4))
        return [r.text for r in zxingcpp.read_barcodes(img)]

    def pass_texts(self, ticket_ids):
        req = urllib.request.Request('http://127.0.0.1:8002/internal/ticket-delivery/tickets?ids=' + ','.join(map(str, ticket_ids)),
                                     headers={'Authorization': 'Bearer ' + (self.em_token or '')})
        with urllib.request.urlopen(req, timeout=20) as r:
            return {int(k): v for k, v in json.load(r).items()}


# ---------------------------------------------------------------------------
# What the Event Manager knows (read-only)
# ---------------------------------------------------------------------------
def ticket_link_code(qr_code):
    """The private ticket-link code, computed with the Event Manager's secret."""
    from dotenv import dotenv_values
    sys.path.insert(0, HERE) if HERE not in sys.path else None
    import ticket_links
    secret = os.environ.get('SECRET_KEY') or dict(dotenv_values(os.path.join(HERE, '.env'))).get('SECRET_KEY')
    return ticket_links.link_code(qr_code, secret)


def em_connect(path=None):
    path = path or os.environ.get('TICKET_DELIVERY_EVENT_DB') or os.path.join(HERE, 'event.db')
    c = sqlite3.connect('file:%s?mode=ro' % path, uri=True, timeout=30)
    c.row_factory = sqlite3.Row
    return c


def new_paid_orders(em, cutoff, settle_before):
    """Orders with a paid payment first seen after the cutoff, settled long enough."""
    rows = em.execute('''select ghl_entity_id oid, min(first_seen_at) fs, min(occurred_at) paid_at, max(ghl_entity_type) kind from payment_events
                         where event_id=? and status='paid' and ghl_entity_id is not null
                         group by ghl_entity_id having min(first_seen_at) >= ?''', (EVENT_ID, cutoff)).fetchall()
    out = []
    for r in rows:
        # Settled = paid at least SETTLE_MINUTES ago (the payment time, or when we
        # first heard of it if GHL gave none).
        seen = _utc(r['paid_at']) or _utc(r['fs'])
        out.append({'order_id': r['oid'], 'kind': r['kind'], 'first_seen': r['fs'], 'paid_at': r['paid_at'], 'settled': bool(seen and seen <= settle_before)})
    return out


def em_facts(em, order_id):
    pays = [dict(r) for r in em.execute('select * from payment_events where event_id=? and ghl_entity_id=?', (EVENT_ID, order_id))]
    ids = {p['attendee_id'] for p in pays if p['attendee_id']}
    for r in em.execute("select id from attendees where event_id=? and (acq_order_id=? or json_extract(custom_data,'$.order_id')=?)", (EVENT_ID, order_id, order_id)):
        ids.add(r['id'])
    tickets = [dict(em.execute('select * from attendees where id=?', (i,)).fetchone()) for i in sorted(ids)]
    for t in tickets:
        t['cd'] = json.loads(t.get('custom_data') or '{}')
    other = []
    for t in tickets:
        other += [r[0] for r in em.execute("select distinct ghl_entity_id from payment_events where event_id=? and attendee_id=? and status='paid' and ghl_entity_id!=?",
                                           (EVENT_ID, t['id'], order_id))]
    maps = [dict(r) for r in em.execute('select * from ticket_mappings where event_id=? and coalesce(is_active,1)=1', (EVENT_ID,))]
    types = {r['id']: dict(r) for r in em.execute('select * from ticket_types where event_id=?', (EVENT_ID,))}
    event = dict(em.execute('select * from events where id=?', (EVENT_ID,)).fetchone())
    return {'payments': pays, 'tickets': tickets, 'other_orders': sorted(set(other)), 'mappings': maps, 'types': types, 'event': event}


def _mapping_for(maps, product_id, name, at):
    cands = [m for m in maps if m['external_product_id'] == product_id]
    if at:
        def inside(m):
            lo, hi = _utc(m.get('valid_from')), _utc(m.get('valid_until'))
            return (not lo or at >= lo) and (not hi or at <= hi)
        cands = [m for m in cands if inside(m)]
    named = [m for m in cands if m.get('product_name_match') and m['product_name_match'].upper() in (name or '').upper()]
    return (named or [m for m in cands if not m.get('product_name_match')] or [None])[0]


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------
def classify(order_id, em, world, state, allow_delivered=False):
    """-> (classification, reasons, order_or_None, info). Read-only everywhere."""
    f = em_facts(em, order_id)
    red, yellow = [], []
    info = {'buyer_name': '', 'recipient': '', 'ticket_ids': '', 'categories': ''}
    pays = f['payments']
    if any(p.get('ghl_entity_type') == 'invoice' for p in pays):
        return 'YELLOW', ['invoice_payment_manual_review'], None, info
    if not pays:
        return 'RED', ['no_payment_on_file'], None, info
    if any(p['status'] != 'paid' or (p.get('amount_refunded') or 0) > 0 for p in pays):
        red.append('payment_refunded_or_not_paid')
    if any(p.get('live_mode') in (0, False) for p in pays):
        red.append('test_mode_payment')

    # Live GHL: the order, its transactions, the buyer.
    try:
        o = world.ghl('/payments/orders/%s?altId=%s&altType=location' % (order_id, world.location))
        o = o.get('order', o)
        tx = world.ghl('/payments/transactions?altId=%s&altType=location&entityId=%s&limit=50' % (world.location, order_id)).get('data', [])
    except Exception as e:
        return 'YELLOW', ['ghl_unreachable:%s' % type(e).__name__], None, info
    if o.get('status') != 'completed' or o.get('paymentStatus') != 'paid' or o.get('liveMode') is not True:
        red.append('ghl_order_not_paid_live')
    if not tx or any(t.get('status') != 'succeeded' or t.get('amountRefunded') or t.get('liveMode') is not True for t in tx):
        red.append('ghl_transactions_not_clean')
    paid_at = _utc(o.get('createdAt'))
    contact_id = o.get('contactId') or (pays[0].get('contact_id'))
    # A transferred ticket goes to its current holder, never to the buyer: the
    # order's contact is whoever paid. One holder address, one GHL contact, or held.
    holder = None
    if len(f['tickets']) == 1 and f['tickets'][0]['cd'].get('transfers'):
        holder = (f['tickets'][0].get('email') or '').strip().lower()
        try:
            found = world.ghl('/contacts/?locationId=%s&query=%s&limit=10' % (world.location, urllib.parse.quote(holder))).get('contacts', [])
        except Exception as e:
            return 'YELLOW', ['ghl_contact_unreachable:%s' % type(e).__name__], None, info
        exact = [x for x in found if (x.get('email') or '').strip().lower() == holder]
        if len(exact) != 1:
            return 'YELLOW', ['transferred_holder_has_no_single_ghl_contact'], None, info
        contact_id = exact[0]['id']
    try:
        c = world.ghl('/contacts/%s' % contact_id).get('contact', {})
    except Exception as e:
        return 'YELLOW', ['ghl_contact_unreachable:%s' % type(e).__name__], None, info
    recipient = (c.get('email') or '').strip().lower()
    placed_with = ((o.get('contactSnapshot') or {}).get('email') or '').strip().lower()
    info['recipient'] = recipient
    info['buyer_name'] = ' '.join(x for x in [c.get('firstName') or '', c.get('lastName') or ''] if x).strip() or (o.get('contactName') or '')
    if not EMAIL_RE.match(recipient):
        yellow.append('no_valid_email')
    elif placed_with and placed_with != recipient and holder is None:
        yellow.append('buyer_email_changed_since_purchase')
    if c.get('dnd') or ((c.get('dndSettings') or {}).get('Email') or {}).get('status') == 'active':
        red.append('email_do_not_disturb')

    # What was bought.
    seats, upgrades, unmapped, expected = 0, 0, [], set()
    for it in o.get('items', []):
        pid = (it.get('product') or {}).get('_id') or it.get('productId')
        m = _mapping_for(f['mappings'], pid, it.get('name'), paid_at)
        if not m:
            unmapped.append(it.get('name') or pid)
            continue
        if m.get('is_upgrade') or (m.get('entitlement_type') or 'EVENT_TICKET') != 'EVENT_TICKET':
            upgrades += 1
            continue
        seats += int(it.get('qty') or 1)
        expected.add(m['ticket_type_id'])
    info['categories'] = '; '.join(sorted({f['types'].get(t, {}).get('name', str(t)) for t in expected}))
    if unmapped:
        red.append('product_not_mapped_to_a_ticket')
    if upgrades:
        yellow.append('upgrade_order')
    if seats > 1:
        yellow.append('several_seats_in_one_order')
    if seats == 0 and not upgrades and not unmapped:
        red.append('no_ticket_product_in_order')

    # The ticket.
    tickets = f['tickets']
    info['ticket_ids'] = ';'.join(str(t['id']) for t in tickets)
    if not tickets:
        red.append('no_ticket_issued')
    elif len(tickets) > 1:
        yellow.append('several_tickets_linked')
    order = None
    if len(tickets) == 1:
        a = tickets[0]
        if (a.get('registration_status') or 'active').lower() in BLOCKED:
            red.append('ticket_not_active')
        if not a.get('qr_code') or not a.get('public_token'):
            red.append('ticket_has_no_qr_or_link')
        pinned = a['cd'].get('admin_tier')
        if expected and a['ticket_type_id'] not in expected and pinned != a['ticket_type_id']:
            yellow.append('ticket_category_differs_from_purchase')
        if (a.get('email') or '').strip().lower() != recipient:
            yellow.append('ticket_email_differs_from_buyer')
        if f['other_orders']:
            yellow.append('buyer_has_other_paid_orders')
        r = state.db.execute("select order_id from order_ticket_delivery where event_id=? and order_id!=? and state in ('accepted','delivered','sending','unknown') and (';'||ticket_ids||';') like ?",
                             (EVENT_ID, order_id, '%;' + str(a['id']) + ';%')).fetchone()
        if r:
            yellow.append('ticket_already_emailed_with_another_order')
        if not red and a.get('qr_code') and a.get('public_token'):
            # Private ticket link (9 Nov 2026): keyed by the ticket's own entry
            # code, never by the public badge/card code.
            _code = ticket_link_code(a['qr_code'])
            link, qr_url = PUBLIC + '/ticket/' + _code, PUBLIC + '/t/' + _code + '.png'
            try:
                s1, png = world.fetch(qr_url)
                s2, page = world.fetch(link)
                if s1 != 200 or a['qr_code'] not in world.decode_qr(png):
                    red.append('qr_image_does_not_decode_to_ticket')
                if s2 != 200 or a['qr_code'] not in html.unescape(page.decode('utf-8', 'replace')):
                    red.append('ticket_link_does_not_open')
            except Exception as e:
                yellow.append('qr_or_link_check_failed:%s' % type(e).__name__)
            texts = {}
            try:
                texts = world.pass_texts([a['id']]).get(a['id']) or {}
            except Exception as e:
                yellow.append('pass_text_unavailable:%s' % type(e).__name__)
            name = '' if a['cd'].get('needs_name_check') else ' '.join(x for x in [a.get('first_name') or '', a.get('last_name') or ''] if x).strip()
            tt = f['types'].get(a['ticket_type_id'], {})
            ev = f['event']
            order = {'order_id': order_id, 'source': 'ghl_order', 'contact_id': contact_id, 'recipient': recipient,
                     'buyer_name': info['buyer_name'], 'quantity': 1,
                     'event': {k: (str(ev[k]) if ev.get(k) is not None else None) for k in ('id', 'name', 'start_date', 'end_date', 'timezone', 'location')},
                     'tickets': [{'ticket_id': a['id'], 'name': name, 'qr': a['qr_code'], 'token': a['public_token'], 'link': link, 'qr_url': qr_url,
                                  'purchased_category': tt.get('name') or '', 'ticket_type_id': a['ticket_type_id'],
                                  'current_pass': texts.get('current_pass') or tt.get('name') or '', 'pass_includes': texts.get('pass_includes') or ''}]}
            order['event']['id'] = EVENT_ID

    done = state.delivered(EVENT_ID, order_id)
    if done and not allow_delivered:
        yellow.append('already_has_a_delivery_record')
    if red:
        return 'RED', sorted(set(red + yellow)), None, info
    if yellow or order is None:
        return 'YELLOW', sorted(set(yellow)) or ['not_ready'], None, info
    return 'GREEN', [], order, info


# ---------------------------------------------------------------------------
# One cycle
# ---------------------------------------------------------------------------
def run_cycle(world, state, em, clock=None, log=print):
    clock = clock or (lambda: datetime.now(timezone.utc))
    t0 = clock()
    mode = state.mode()
    summary = {'at': t0.isoformat(), 'mode': mode, 'checked': 0, 'green': 0, 'yellow': 0, 'red': 0, 'sent': 0,
               'shadow_would_send': 0, 'status_checked': 0, 'resends': 0, 'alerts': 0, 'errors': []}
    state.actor = 'auto'
    if mode == 'paused':
        state.put('last_run', json.dumps(summary))
        log(json.dumps(summary))
        return summary
    alerts = []
    live_ok = mode == 'live' and state.get('approved_template_sha') == template_sha() and not HARD_SHADOW
    summary['shadow_only_lock'] = HARD_SHADOW
    if mode == 'live' and not live_ok:
        summary['errors'].append('live mode but the template is not the approved one; nothing sent')
        if state.get('unapproved_template_alerted') != template_sha():
            state.put('unapproved_template_alerted', template_sha())
            alerts.append('Automatic ticket email is set to LIVE, but the email template changed since it was approved. Nothing was sent. Approve the new template or pause.')

    # 2. Delivery status, for every sender's accepted messages -- the ticket
    # emails and (Email Center, 10 Nov 2026) the exhibitor emails. GHL keeps
    # one status per message and a later open or click replaces "delivered",
    # so a delivered email is asked about again for a few days (ec_store).
    from . import ec_store
    ec_store.ensure(state.db)
    bad = []

    def _status(mid, _bad=bad):
        status = provider_status(world, mid)
        summary['status_checked'] += 1
        if status in st.BAD_PROVIDER:
            _bad.append((mid, status))
        return status
    before = {r[0]: r[1] for r in state.db.execute("select message_id,order_id from order_ticket_delivery where state='accepted'")}
    try:
        ec_store.poll_tickets(state.db, _status, limit=STATUS_PER_RUN)
        ec_store.poll_exhibitors(state.db, _status, limit=STATUS_PER_RUN // 4)
    except RuntimeError as e:          # the run's GHL read cap: the rest wait for the next run
        summary['errors'].append(str(e))
    for mid, status in bad:
        if mid in before:
            alerts.append('Ticket email for order %s was %s by the mail provider. Check the address and resend from the Email Center.' % (before[mid], status.upper()))

    # 3. Admin resends (a person asked, with a reason). Not while paused, and
    # not under the shadow-only lock: they wait, visibly, in the dashboard.
    pending_resends = [] if HARD_SHADOW else state.db.execute("select id,order_id,reason,requested_by from resend_requests where state='pending' and event_id=? order by id", (EVENT_ID,)).fetchall()
    for rid, oid, reason, who in pending_resends:
        cls, why, order, _ = classify(oid, em, world, state, allow_delivered=True)
        if cls != 'GREEN':
            state.db.execute("update resend_requests set state='refused',result=?,processed_at=? where id=?", ('Not sent: ' + ', '.join(why), st.now(), rid))
            alerts.append('Resend for order %s was NOT sent: %s.' % (oid, ', '.join(why)))
            continue
        state.actor = who if str(who).startswith('admin:') else 'admin:%s' % who
        res = st.deliver(order, state, template_sha(), lambda o: (True, ''), lambda o, p: world.send(o['contact_id'], p), ticket_email.render,
                         resend_reason='%s (requested by %s)' % (reason, who))
        state.actor = 'auto'
        ok = res['state'] == 'accepted'
        state.db.execute("update resend_requests set state=?,result=?,processed_at=? where id=?", ('sent' if ok else 'failed', json.dumps(res), st.now(), rid))
        summary['resends'] += 1
        if not ok:
            alerts.append('Resend for order %s did not go through (%s).' % (oid, res['state']))

    # 4. New paid orders.
    cutoff = state.get('auto_cutoff')
    if not cutoff:
        summary['errors'].append('no auto_cutoff set; new-order discovery skipped')
    else:
        settle_before = t0 - timedelta(minutes=SETTLE_MINUTES)
        sent_today = state.db.execute("select count(*) from delivery_attempts where actor='auto' and kind='initial' and state='sending' and at>=?",
                                      (t0.replace(hour=0, minute=0, second=0, microsecond=0).isoformat(),)).fetchone()[0]
        for cand in new_paid_orders(em, cutoff, settle_before):
            oid = cand['order_id']
            if not cand['settled']:
                continue
            if state.delivered(EVENT_ID, oid):
                continue
            prev = state.db.execute('select classification,reasons,last_checked,alerted_key from delivery_candidates where event_id=? and order_id=?', (EVENT_ID, oid)).fetchone()
            if prev and prev[0] in ('YELLOW', 'RED') and prev[2] and prev[2] > (t0 - timedelta(minutes=RECHECK_HELD_MINUTES)).isoformat():
                continue
            if prev and prev[0] == 'GREEN' and mode == 'shadow':
                continue  # already recorded as "would send"; nothing new to learn every 2 minutes
            try:
                cls, why, order, info = classify(oid, em, world, state)
            except Exception as e:
                summary['errors'].append('%s: %s' % (oid, type(e).__name__))
                continue
            summary['checked'] += 1
            summary[cls.lower()] += 1
            state.db.execute('''insert into delivery_candidates(event_id,order_id,source,first_seen,paid_at,last_checked,classification,reasons,recipient,buyer_name,ticket_ids,categories,updated_at)
                                values(?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(event_id,order_id) do update set last_checked=excluded.last_checked,classification=excluded.classification,
                                reasons=excluded.reasons,recipient=excluded.recipient,buyer_name=excluded.buyer_name,ticket_ids=excluded.ticket_ids,categories=excluded.categories,updated_at=excluded.updated_at''',
                             (EVENT_ID, oid, 'auto', cand['first_seen'], cand['paid_at'], t0.isoformat(), cls, ';'.join(why), info['recipient'], info['buyer_name'],
                              info['ticket_ids'], info['categories'], t0.isoformat()))
            key = cls + ':' + ';'.join(why)
            if cls != 'GREEN' and (not prev or prev[3] != key):
                alerts.append('Order %s (ticket %s) is HELD, not emailed: %s.' % (oid, info['ticket_ids'] or 'none', ', '.join(why)))
                state.db.execute('update delivery_candidates set alerted_key=? where event_id=? and order_id=?', (key, EVENT_ID, oid))
            if cls != 'GREEN':
                continue
            if mode == 'shadow' or not live_ok:
                state.db.execute('update delivery_candidates set shadow_would_send_at=coalesce(shadow_would_send_at,?) where event_id=? and order_id=?', (t0.isoformat(), EVENT_ID, oid))
                summary['shadow_would_send'] += 1
                continue
            if summary['sent'] >= LIVE_CAP_PER_RUN or sent_today >= LIVE_CAP_PER_DAY:
                summary['errors'].append('send cap reached; %s waits for the next run' % oid)
                continue
            if state.mode() != 'live':  # paused mid-run
                break
            res = st.deliver(order, state, template_sha(), lambda o: (True, ''), lambda o, p: world.send(o['contact_id'], p), ticket_email.render)
            log(json.dumps(res))
            if res['state'] == 'accepted':
                summary['sent'] += 1
                sent_today += 1
            elif res['state'] != 'skipped_existing_delivery':
                alerts.append('Ticket email for order %s was not accepted (%s). Automatic sending stops for this run.' % (oid, res['state']))
                break

    # 5. One alert email for everything new this cycle. Internal only.
    if alerts:
        summary['alerts'] = len(alerts)
        cid = world.alert_contact()
        if cid:
            body = ''.join('<p>%s</p>' % html.escape(a) for a in alerts) + \
                   '<p>Mode: <b>%s</b>. Dashboard: Event Manager &rarr; ELEVATE 2026 &rarr; Ticket Emails.</p>' % mode
            try:
                world.send(cid, {'subject': '[Gaia Tickets] %d item(s) need attention' % len(alerts), 'html': body})
            except Exception as e:
                summary['errors'].append('alert not sent: %s' % type(e).__name__)
    state.put('last_run', json.dumps(summary))
    log(json.dumps(summary))
    return summary


def provider_status(world, message_id):
    """What GHL reports for a message it accepted. The send route returns the
    EMAIL message id, which the email endpoint answers directly."""
    try:
        e = world.ghl('/conversations/messages/email/' + message_id).get('emailMessage', {})
        if e.get('status'):
            return str(e['status']).lower()
    except Exception:
        pass
    try:
        j = world.ghl('/conversations/messages/' + message_id)
        m = j.get('message', j)
        return str(m.get('status') or 'unknown').lower()
    except Exception as e:
        return 'check_failed:' + type(e).__name__
