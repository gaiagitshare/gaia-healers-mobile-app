"""The ticket email, as customers will see it (order level, one email per order).

Rendered by our application, not a GHL template; delivered through GHL
Conversations email from the Gaia Healers location, which sends as
"Gaia Healers" <reply@mg.gaiahealers.com> (LC Email / Mailgun, verified on a
delivered system email 3 Nov 2026). Replies thread back into GHL.
"""
import html
from datetime import datetime

SENDER_DISPLAY = 'Gaia Healers <reply@mg.gaiahealers.com>'
# Event artwork, served from the app's static site (gaiahealers.app). Previews may
# point this at local copies; the text below each image says the same thing, so a
# mail client that blocks images loses nothing.
ASSET_BASE = 'https://gaiahealers.app/assets/email/'

G = '#2f5d1f'
INK = '#182414'
MUTED = '#53604d'
LINE = '#dce6d7'


def esc(v):
    return html.escape(str(v or ''), quote=True)


def _dates(event):
    start = datetime.fromisoformat(event['start_date'].replace('Z', '+00:00'))
    end = datetime.fromisoformat(event['end_date'].replace('Z', '+00:00'))
    return '%s %d–%d, %d' % (start.strftime('%B'), start.day, end.day, end.year)


def _ticket_card(n, qty, t):
    cat = t.get('current_pass') or t['purchased_category']
    holder = t.get('name') or ''
    who = esc(holder) if holder else 'Guest ticket — name can be added at the door'
    includes = ('<p style="font-size:13px;line-height:1.5;color:%s;margin:0 0 12px">%s</p>'
                % (MUTED, esc(t.get('pass_includes')))) if t.get('pass_includes') else ''
    note = ''
    if t.get('reissued'):
        note = ('<p style="margin:10px 0 0;padding:8px 10px;background:#fff7e0;border-radius:8px;'
                'font-size:13px;color:#6b4e00">This ticket replaces an earlier one. Only this QR code '
                'is valid; the previous code no longer works.</p>')
    return (
        '<table role="presentation" width="100%" style="border:1px solid ' + LINE + ';border-radius:12px;'
        'margin:0 0 18px;border-collapse:separate"><tr><td style="padding:18px;text-align:center">'
        '<p style="color:' + G + ';font-size:12px;letter-spacing:1px;margin:0 0 6px">TICKET %d OF %d &nbsp;&middot;&nbsp; NO. %s</p>'
        % (n, qty, esc(t['ticket_id'])) +
        '<p style="font-size:19px;font-weight:bold;margin:0 0 4px">%s</p>' % esc(cat) +
        '<p style="font-size:14px;color:%s;margin:0 0 10px">%s</p>' % (MUTED, who) +
        '<a href="%s" style="display:inline-block"><img src="%s" width="210" height="210" '
        'style="display:block;margin:6px auto;max-width:100%%;height:auto;border:0" '
        'alt="Entry QR code for ticket %s"></a>' % (esc(t['link']), esc(t['qr_url']), esc(t['ticket_id'])) +
        '<p style="font-family:monospace;font-size:13px;letter-spacing:1px;margin:6px 0 10px;color:%s">%s</p>'
        % (MUTED, esc(t['qr'])) + includes +
        '<a href="%s" style="display:inline-block;background:#75ab3c;color:#0c1906;padding:12px 20px;'
        'border-radius:8px;text-decoration:none;font-weight:bold;margin:4px">View ticket</a>' % esc(t['link']) +
        '<a href="%s" style="display:inline-block;border:1px solid #75ab3c;color:%s;padding:11px 18px;'
        'border-radius:8px;text-decoration:none;font-weight:bold;margin:4px">Save QR image</a>' % (esc(t['qr_url']), G) +
        note + '</td></tr></table>')


COLLAB = (
    '<img src="{ASSET}elevate-2026-two-exhibit-halls-v2.jpg" width="556" style="display:block;width:100%;max-width:556px;height:auto;'
    'border:0;border-radius:12px;margin:6px 0 10px" alt="One ticket. Two exhibit halls. Your Gaia Healers ticket includes '
    'complimentary access to the Health &amp; Healing Expo exhibit hall. Health &amp; Healing Expo by Documenting Hope, '
    'November 21&ndash;22, 2026; Gaia Healers ELEVATE, November 20&ndash;22, 2026. Rosen Shingle Creek, Orlando, Florida. '
    'Access to specific conference sessions and workshops requires a separate ticket.">'
    '<table role="presentation" width="100%" style="margin:0 0 22px;background:#16290f;border-radius:14px">'
    '<tr><td style="padding:22px 20px;text-align:center;color:#f1f7ec">'
    '<p style="margin:0 0 6px;font-size:12px;letter-spacing:3px;color:#b9e08f">GAIA HEALERS ELEVATE &nbsp;&times;&nbsp; HEALTH &amp; HEALING EXPO</p>'
    '<p style="margin:0 0 10px;font-size:24px;font-weight:bold;letter-spacing:1px">ONE TICKET. TWO EXHIBIT HALLS.</p>'
    '<p style="margin:0 0 10px;font-size:15px;line-height:1.55">Your ticket includes complimentary access to the '
    'exhibition halls of both <strong>Gaia Healers ELEVATE</strong> (November 20&ndash;22) and the '
    '<strong>Health &amp; Healing Expo by Documenting Hope</strong> (November 21&ndash;22), both at Rosen Shingle Creek.</p>'
    '<p style="margin:0;font-size:13px;line-height:1.5;color:#cfe3c0">Exhibition access only. Conference sessions '
    'and workshops at either event require the appropriate ticket for that session.{DAYPASS}</p>'
    '</td></tr></table>')

HOTEL = (
    '<table role="presentation" width="100%" style="margin:0 0 22px;border:1px solid ' + LINE + ';border-radius:12px">'
    '<tr><td style="padding:18px 18px 10px">'
    '<p style="margin:0 0 4px;font-size:12px;letter-spacing:2px;color:' + G + '">FOR HOTEL GUESTS AT ROSEN SHINGLE CREEK</p>'
    '<p style="margin:0 0 12px;font-size:13px;color:' + MUTED + '">These benefits are for guests staying at the hotel. '
    'They are not automatic benefits for every attendee; the hotel applies them under its own terms.</p>'
    '<table role="presentation" width="100%" style="font-size:14px;line-height:1.45;border-collapse:collapse">'
    '<tr><td style="padding:8px 0;border-top:1px solid ' + LINE + ';width:34%;vertical-align:top"><strong>Spa</strong></td>'
    '<td style="padding:8px 0;border-top:1px solid ' + LINE + '">20% discount, subject to availability. Request it when booking.</td></tr>'
    '<tr><td style="padding:8px 0;border-top:1px solid ' + LINE + ';vertical-align:top"><strong>Dining</strong></td>'
    '<td style="padding:8px 0;border-top:1px solid ' + LINE + '">15% at Caf&eacute; Osceola, A Land Remembered, Cala Bella, '
    'Tobias, Mi Casa and Banrai Sushi. Mention Gaia Healers ELEVATE before ordering. Not available at 18 Monroe, '
    'the pool bar, boba bar or coffee shop. It cannot be applied afterwards or charged automatically to a room.</td></tr>'
    '<tr><td style="padding:8px 0;border-top:1px solid ' + LINE + ';vertical-align:top"><strong>Overnight self-parking</strong></td>'
    '<td style="padding:8px 0;border-top:1px solid ' + LINE + '">50% discount for overnight hotel guests. '
    'Day guests pay the regular parking rate.</td></tr>'
    '</table>'
    # The 2026 group-rate booking link exactly as published on the official Elevate page.
    '<p style="margin:12px 0 4px;font-size:14px"><a href="https://be.synxis.com/?adult=1&amp;arrive=2026-11-19&amp;chain=10237&amp;child=0'
    '&amp;config=ORLRS&amp;currency=USD&amp;depart=2026-11-23&amp;group=GRP_GAIA26&amp;hotel=69867&amp;level=hotel&amp;locale=en-US'
    '&amp;productcurrency=USD&amp;rooms=1&amp;theme=ORLRS" style="color:' + G + ';font-weight:bold">Book a room at the Gaia group rate</a>'
    ' <span style="color:' + MUTED + '">(group code GRP_GAIA26; rooms are limited)</span></p>'
    '</td></tr></table>')


def render(order):
    tickets = order['tickets']
    qty = order['quantity']
    if qty != len(tickets) or qty != len({t['ticket_id'] for t in tickets}) or qty != len({t['qr'] for t in tickets}):
        raise ValueError('Order quantity, individual tickets and QR credentials must be equal')
    many = qty > 1
    name = order.get('buyer_name') or 'there'
    lead = ('Your %d tickets are ready. Each ticket below has its own QR code: one QR code admits one person.' % qty
            if many else 'Your ticket is ready. Show the QR code below at the entrance.')
    cards = ''.join(_ticket_card(n, qty, t) for n, t in enumerate(tickets, 1))
    forward = ('<li>Buying for family or friends? Forward them their ticket, or give them the printed code. '
               'Each code admits one person.</li>') if many else ''
    body = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Gaia Healers ELEVATE 2026 tickets</title></head>'
        '<body style="margin:0;padding:0;background:#edf3e8;color:' + INK + ';font-family:Arial,Helvetica,sans-serif">'
        '<table role="presentation" width="100%"><tr><td align="center" style="padding:20px 10px">'
        '<table role="presentation" width="600" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px"><tr><td style="padding:26px 22px">'
        '<img src="' + ASSET_BASE + 'elevate-2026-header.jpg" width="420" style="display:block;width:100%;max-width:420px;'
        'height:auto;border:0;border-radius:12px;margin:0 auto 18px" alt="Gaia Healers ELEVATE, Integrative and Holistic '
        'Wellness Conference, November 20&ndash;22, 2026">'
        '<p style="color:' + G + ';font-size:12px;letter-spacing:3px;font-weight:bold;margin:0 0 6px">'
        + ('YOUR OFFICIAL TICKETS' if many else 'YOUR OFFICIAL TICKET') + '</p>'
        '<p style="font-size:26px;font-weight:bold;line-height:1.2;margin:0 0 6px">GAIA HEALERS ELEVATE 2026</p>'
        '<p style="font-size:15px;line-height:1.5;margin:0 0 18px;color:' + MUTED + '"><strong style="color:' + INK + '">'
        + esc(_dates(order['event'])) + '</strong><br>Rosen Shingle Creek, Orlando, Florida</p>'
        '<p style="margin:0 0 8px">Hello ' + esc(name) + ',</p>'
        '<p style="line-height:1.55;margin:0 0 8px">' + lead + ' No account, login or activation is needed.</p>'
        '<p style="line-height:1.5;margin:0 0 8px;padding:10px 12px;background:#f3f7ef;border-radius:8px;font-size:14px">'
        'This is your official ticket. It replaces the earlier registration emails; if anything differs, this email is correct.</p>'
        '<p style="font-size:13px;color:' + MUTED + ';margin:0 0 18px">Order ' + esc(order['order_id'])
        + ' &nbsp;&middot;&nbsp; %d %s</p>' % (qty, 'tickets' if many else 'ticket')
        + cards + COLLAB.replace('{ASSET}', ASSET_BASE).replace('{DAYPASS}', (' One-day passes are valid on their day only; the Health &amp; Healing Expo hall is open November 21&ndash;22.'
                              if any(' only' in str(t.get('current_pass') or '') for t in tickets) else '')) +
        '<p style="font-size:17px;font-weight:bold;margin:0 0 6px">At the entrance</p>'
        '<ul style="margin:0 0 20px;padding-left:20px;line-height:1.6;font-size:14px">'
        "<li>Show each person's QR code on a phone, or bring it printed (open <em>View ticket</em> and use your browser's Print).</li>"
        '<li>Save a screenshot before you travel in case the venue Wi-Fi is slow.</li>' + forward +
        '<li>Name badges are printed at the registration desk.</li>'
        '<li>Your pass includes exactly what is listed on it. Exhibition-hall access does not include conference sessions or workshops; those need the appropriate ticket.</li></ul>'
        + HOTEL +
        '<p style="font-size:14px;line-height:1.55;margin:0 0 4px">Questions, or need a ticket resent? '
        'Email <a href="mailto:support@gaiahealers.com" style="color:' + G + '">support@gaiahealers.com</a> '
        'or reply to this email.</p>'
        '<p style="margin:16px 0 0">We look forward to welcoming you,<br><strong>Gaia Healers</strong></p>'
        '</td></tr></table></td></tr></table></body></html>')
    subject = 'Your official Gaia Healers ELEVATE 2026 %s — order %s' % ('ticket' if qty == 1 else 'tickets (%d)' % qty, order['order_id'])
    return {'subject': subject, 'html': body, 'from': SENDER_DISPLAY}
