# -*- coding: utf-8 -*-
"""A volunteer's own shifts as a calendar, and the schedule reminder email
(17 Nov 2026: "send a reminder about their schedule, and on their iPhone make
sure they can add it to their calendar").

The calendar is a feed, not a file: the email links to it with webcal://, so
an iPhone offers to SUBSCRIBE, and a shift moved or cancelled later moves or
disappears in their calendar by itself. Google Calendar subscribes to the same
address. Only CONFIRMED shifts are in it -- a request the team has not
confirmed is not a shift yet.

Times are the event's own wall clock (Orlando), as the team typed them; the
feed carries them as UTC so every phone shows them right wherever it is.
"""
import html as _html
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

try:
    from zoneinfo import ZoneInfo
except ImportError:                                   # pragma: no cover
    ZoneInfo = None

PUBLIC_API = "https://api.gaiahealers.app/event-api"
PUBLIC_APP = "https://api.gaiahealers.app/event"
VENUE = "Rosen Shingle Creek, 9939 Universal Blvd, Orlando, FL 32819"


def _utc(day, hhmm, tz):
    local = datetime.strptime("%s %s" % (day, hhmm), "%Y-%m-%d %H:%M")
    if ZoneInfo is not None:
        local = local.replace(tzinfo=ZoneInfo(tz or "America/New_York"))
    else:                                             # pragma: no cover
        local = local.replace(tzinfo=timezone(timedelta(hours=-5)))
    return local.astimezone(timezone.utc)


def _esc(s):
    return (str(s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
            .replace("\r\n", "\\n").replace("\n", "\\n"))


def _fold(line):
    out, b = [], line.encode("utf-8")
    while len(b) > 74:
        cut = 74
        while (b[cut] & 0xC0) == 0x80:                # never split a UTF-8 character
            cut -= 1
        out.append(b[:cut].decode("utf-8")); b = b[cut:]
    out.append(b.decode("utf-8"))
    return "\r\n ".join(out)


def feed_urls(token):
    https = "%s/volunteer/%s/calendar.ics" % (PUBLIC_API, token)
    webcal = "webcal://" + https.split("://", 1)[1]
    google = "https://calendar.google.com/calendar/render?cid=" + quote(webcal, safe="")
    return {"https": https, "webcal": webcal, "google": google, "portal": "%s/volunteer/%s" % (PUBLIC_APP, token)}


def ics(volunteer, items, event_name, tz):
    """items: [(booking_id, shift)] -- confirmed shifts only."""
    name = event_name or "Gaia Healers ELEVATE 2026"
    portal = feed_urls(volunteer.token)["portal"]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Gaia Healers//Volunteer shifts//EN", "CALSCALE:GREGORIAN",
         "METHOD:PUBLISH", "X-WR-CALNAME:" + _esc("My volunteer shifts — " + name),
         "X-WR-TIMEZONE:" + (tz or "America/New_York"), "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
         "X-PUBLISHED-TTL:PT1H"]
    for bid, s in items:
        start, end = _utc(s.day, s.start_time, tz), _utc(s.day, s.end_time, tz)
        if end <= start:
            end += timedelta(days=1)
        where = ", ".join(x for x in (s.location, VENUE) if x)
        desc = "Volunteer shift: %s%s.\n%s\nYour volunteer page (schedule, changes, team): %s" % (
            s.role, " (lead)" if s.lead_role else "", (s.description or "").strip(), portal)
        L += ["BEGIN:VEVENT", "UID:volunteer-booking-%d@gaiahealers.app" % bid, "DTSTAMP:" + stamp,
              "DTSTART:" + start.strftime("%Y%m%dT%H%M%SZ"), "DTEND:" + end.strftime("%Y%m%dT%H%M%SZ"),
              "SUMMARY:" + _esc("Volunteer: %s — %s" % (s.role, name)), "LOCATION:" + _esc(where),
              "DESCRIPTION:" + _esc(desc), "URL:" + portal, "STATUS:CONFIRMED", "TRANSP:OPAQUE",
              "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + _esc("Volunteer shift in 1 hour: " + s.role),
              "TRIGGER:-PT1H", "END:VALARM", "END:VEVENT"]
    L.append("END:VCALENDAR")
    return "\r\n".join(_fold(x) for x in L) + "\r\n"


def _day(d):
    return datetime.strptime(d, "%Y-%m-%d").strftime("%A %-d %B")


def _t(hhmm):
    h, m = [int(x) for x in hhmm.split(":")]
    return "%d:%02d %s" % ((h % 12) or 12, m, "am" if h < 12 else "pm")


def render_reminder(first_name, shifts, urls, event_name):
    """-> (subject, html). shifts: [shift] in time order."""
    e = _html.escape
    name = event_name or "Gaia Healers ELEVATE 2026"
    subject = "Your volunteer schedule — %s" % name
    rows, last = [], None
    for s in shifts:
        if s.day != last:
            rows.append('<tr><td colspan="2" style="padding:14px 0 4px;font-weight:bold;color:#2f5d3a">%s</td></tr>' % e(_day(s.day)))
            last = s.day
        rows.append('<tr><td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top">%s – %s</td>'
                    '<td style="padding:4px 0">%s%s<br><span style="color:#666;font-size:13px">%s</span></td></tr>'
                    % (e(_t(s.start_time)), e(_t(s.end_time)), e(s.role), " <b>(lead)</b>" if s.lead_role else "",
                       e(s.location or "")))
    btn = ('<a href="%s" style="display:inline-block;background:#2f5d3a;color:#fff;padding:13px 22px;border-radius:8px;'
           'text-decoration:none;font-weight:bold;margin:4px 0">%s</a>')
    body = """<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1d2a1f">
<h2 style="color:#2f5d3a">Hi %s, here is your volunteer schedule</h2>
<p>Thank you for volunteering at <b>%s</b>, November 20&ndash;22, 2026 at Rosen Shingle Creek, Orlando. These are your confirmed shifts:</p>
<table role="presentation" style="border-collapse:collapse;font-size:15px;line-height:1.4">%s</table>
<p style="margin:22px 0 6px"><b>Add your shifts to your calendar</b></p>
<p style="margin:0 0 6px">%s</p>
<p style="font-size:13px;color:#555;margin:0 0 4px">On an iPhone or Mac, tap the button and choose <b>Subscribe</b>. Your shifts appear in Calendar with a reminder an hour before each one, and they update by themselves if anything changes.</p>
<p style="font-size:13px;color:#555;margin:0 0 18px">Using Google Calendar? <a href="%s" style="color:#2f5d3a">Add them to Google Calendar</a>.</p>
<p style="margin:0 0 6px">%s</p>
<p style="font-size:13px;color:#555">Your volunteer page shows the full schedule, who is on each shift with you, and any updates from the team. The links are personal to you; please do not forward this email.</p>
<p>Please arrive about 10 minutes before each shift and check in at the registration desk.</p>
<p>With gratitude,<br>The Gaia Healers volunteer team</p></div>""" % (
        e(first_name or "there"), e(name), "".join(rows), btn % (e(urls["webcal"], quote=True), "Add my shifts to my calendar"),
        e(urls["google"], quote=True), btn % (e(urls["portal"], quote=True), "Open my volunteer page"))
    return subject, body


def render_day_reminder(first_name, day, shifts, urls, event_name):
    """The day-before reminder: tomorrow's shifts only. -> (subject, html)."""
    e = _html.escape
    name = event_name or "Gaia Healers ELEVATE 2026"
    when = _day(day)
    subject = "Tomorrow: your volunteer shift%s — %s" % ("s" if len(shifts) > 1 else "", when)
    rows = "".join(
        '<tr><td style="padding:6px 14px 6px 0;white-space:nowrap;vertical-align:top;font-weight:bold">%s – %s</td>'
        '<td style="padding:6px 0">%s%s<br><span style="color:#666;font-size:13px">%s</span></td></tr>'
        % (e(_t(s.start_time)), e(_t(s.end_time)), e(s.role), " <b>(lead)</b>" if s.lead_role else "", e(s.location or ""))
        for s in shifts)
    btn = ('<a href="%s" style="display:inline-block;background:#2f5d3a;color:#fff;padding:13px 22px;border-radius:8px;'
           'text-decoration:none;font-weight:bold;margin:4px 0">%s</a>')
    body = """<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1d2a1f">
<h2 style="color:#2f5d3a">Hi %s, see you tomorrow!</h2>
<p>A friendly reminder of your volunteer shift%s at <b>%s</b> tomorrow, <b>%s</b>, at Rosen Shingle Creek, Orlando:</p>
<table role="presentation" style="border-collapse:collapse;font-size:15px;line-height:1.4">%s</table>
<p>Please arrive about 10 minutes early and check in at the registration desk.</p>
<p style="margin:18px 0 6px">%s</p>
<p style="font-size:13px;color:#555;margin:0 0 4px">Not in your calendar yet? On an iPhone, tap the button and choose <b>Subscribe</b>: all your shifts appear with a reminder an hour before each. Google Calendar? <a href="%s" style="color:#2f5d3a">Add them there</a>.</p>
<p style="margin:14px 0 6px">%s</p>
<p style="font-size:13px;color:#555">Can't make it? Please let the team know as soon as possible through your volunteer page or by replying to this email. The links are personal to you; please do not forward this email.</p>
<p>With gratitude,<br>The Gaia Healers volunteer team</p></div>""" % (
        e(first_name or "there"), "s" if len(shifts) > 1 else "", e(name), e(when), rows,
        btn % (e(urls["webcal"], quote=True), "Add my shifts to my calendar"), e(urls["google"], quote=True),
        btn % (e(urls["portal"], quote=True), "Open my volunteer page"))
    return subject, body
