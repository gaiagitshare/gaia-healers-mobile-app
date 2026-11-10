"""Exhibitor emails (Email Center, 10 Nov 2026): profile setup, scanner access.

Two separate emails, tracked separately. Same look and the same sender as the
ticket email (GHL Conversations, "Gaia Healers"). Plain, short, phone-first.
The scanner link is a stand's key to its leads: the email says so.
"""
from .ticket_email import ASSET_BASE, G, INK, MUTED, esc

SUBJECTS = {
    "setup": "Set up your stand profile — Gaia Healers ELEVATE 2026",
    "scanner": "Your badge scanner for the stand — Gaia Healers ELEVATE 2026",
    "reminder": "Reminder: set up your stand profile — Gaia Healers ELEVATE 2026",
}


def _frame(title, inner):
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title></head>'
        '<body style="margin:0;padding:0;background:#edf3e8;color:' + INK + ';font-family:Arial,Helvetica,sans-serif">'
        '<table role="presentation" width="100%"><tr><td align="center" style="padding:20px 10px">'
        '<table role="presentation" width="600" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px"><tr><td style="padding:26px 22px">'
        '<img src="' + ASSET_BASE + 'elevate-2026-header.jpg" width="420" style="display:block;width:100%;max-width:420px;'
        'height:auto;border:0;border-radius:12px;margin:0 auto 18px" alt="Gaia Healers ELEVATE 2026, November 20&ndash;22, 2026">'
        + inner +
        '<p style="font-size:14px;line-height:1.55;margin:18px 0 4px">Questions? Email '
        '<a href="mailto:support@gaiahealers.com" style="color:' + G + '">support@gaiahealers.com</a> or reply to this email.</p>'
        '<p style="margin:16px 0 0">See you in Orlando,<br><strong>Gaia Healers</strong></p>'
        '</td></tr></table></td></tr></table></body></html>')


def _button(url, label):
    return ('<p style="margin:16px 0"><a href="' + esc(url) + '" style="display:inline-block;background:' + G
            + ';color:#ffffff;padding:13px 20px;border-radius:8px;text-decoration:none;font-weight:bold">' + esc(label) + '</a></p>'
            '<p style="font-size:12px;color:' + MUTED + ';word-break:break-all;margin:0 0 12px">If the button does not work, open: '
            + esc(url) + '</p>')


def _head(ex):
    booth = ('Booth ' + esc(ex.get("booth_number"))) if ex.get("booth_number") else 'Your stand'
    hello = esc(ex.get("contact_name") or ex.get("company_name") or "there")
    return ('<p style="color:' + G + ';font-size:12px;letter-spacing:3px;font-weight:bold;margin:0 0 6px">EXHIBITOR</p>'
            '<p style="font-size:24px;font-weight:bold;line-height:1.2;margin:0 0 4px">' + esc(ex.get("company_name") or "") + '</p>'
            '<p style="font-size:15px;color:' + MUTED + ';margin:0 0 16px"><strong style="color:' + INK + '">' + booth
            + '</strong> &middot; November 20&ndash;22, 2026 &middot; Rosen Shingle Creek, Orlando, Florida</p>'
            '<p style="margin:0 0 8px">Hello ' + hello + ',</p>')


def render_setup(ex, url, expires_text=""):
    inner = (_head(ex)
             + '<p style="line-height:1.55;margin:0 0 8px">Your stand is listed in the Gaia Healers event app, on the '
               'floor map and in the exhibitor directory. Please add your logo, a short description, your products and '
               'photos so attendees can find you before and during the event.</p>'
             + _button(url, "Set up my stand profile")
             + '<ul style="margin:0 0 8px;padding-left:20px;line-height:1.6;font-size:14px">'
               '<li>No account or password is needed. The link opens your stand\'s own page.</li>'
               '<li>Your changes appear in the app as soon as you save.</li>'
               '<li>Your stand name and booth number are set by the organisers; reply to this email to change them.</li>'
             + ('<li>This link works until ' + esc(expires_text) + '.</li>' if expires_text else '')
             + '</ul>')
    return {"subject": SUBJECTS["setup"], "html": _frame(SUBJECTS["setup"], inner)}


def render_scanner(ex, url):
    inner = (_head(ex)
             + '<p style="line-height:1.55;margin:0 0 8px">Here is your stand\'s badge scanner. Scan a visitor\'s badge and '
               'their name, email, phone, company and job title are saved to your stand\'s lead list, with room for '
               'notes and a 1&ndash;5 rating. You can download your leads as a spreadsheet at any time.</p>'
             + _button(url, "Open my stand scanner")
             + '<p style="font-size:17px;font-weight:bold;margin:14px 0 6px">How to scan</p>'
               '<ol style="margin:0 0 10px;padding-left:20px;line-height:1.6;font-size:14px">'
               '<li>Open the link on your phone in Safari (iPhone) or Chrome (Android).</li>'
               '<li>Tap <strong>Scan a badge</strong> and allow the camera.</li>'
               '<li>Point the camera at the QR code on the visitor\'s name badge.</li>'
               '<li>Add a note or rating if you like. Each visitor is saved once, however often you scan them.</li>'
               '<li>Tip: use <em>Add to Home Screen</em> so the scanner is one tap away all weekend.</li></ol>'
               '<p style="line-height:1.5;margin:0 0 8px;padding:10px 12px;background:#fff6e5;border-radius:8px;font-size:14px">'
               '<strong>Keep this link private.</strong> Anyone with it can see your stand\'s leads. Share it only with '
               'your own stand staff; if it is ever shared by mistake, reply and we will replace it.</p>')
    return {"subject": SUBJECTS["scanner"], "html": _frame(SUBJECTS["scanner"], inner)}


def render_reminder(ex, url, expires_text=""):
    """A friendly nudge carrying the SAME setup link as the first email."""
    inner = (_head(ex)
             + '<p style="line-height:1.55;margin:0 0 8px">A quick reminder: your stand page in the Gaia Healers event app '
               'is still waiting for your logo, description and products. It takes about five minutes, and attendees are '
               'already browsing the exhibitor directory before the event.</p>'
             + _button(url, "Set up my stand profile")
             + '<ul style="margin:0 0 8px;padding-left:20px;line-height:1.6;font-size:14px">'
               '<li>This is the same link as in our earlier email. No account or password is needed.</li>'
             + ('<li>The link works until ' + esc(expires_text) + '.</li>' if expires_text else '')
             + '<li>Already done? Thank you, and please ignore this email.</li></ul>')
    return {"subject": SUBJECTS["reminder"], "html": _frame(SUBJECTS["reminder"], inner)}
