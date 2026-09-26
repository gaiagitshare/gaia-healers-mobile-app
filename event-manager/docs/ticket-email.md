# The "Your ticket" e-mail

Paste `ticket-email.html` into GHL as a Custom HTML / Source block.
`ticket-email.preview.html` is the same thing with the merge fields filled in.

**Subject:** Your ticket for Elevate 2026 — November 20–22, Orlando
**Preview text:** Your entry code is inside. Nothing to print.

## Why this exists

Nobody who bought a ticket has ever been sent one. GHL sends a payment receipt
and (for three quarters of buyers) a registration confirmation with the dates —
neither contains a code, a link or anything scannable. This is the first thing
that puts an actual ticket in someone's hand.

## Before you send

1. **Import three fields into GHL.** Admin panel → the event → Attendees →
   Export CSV. Import these as contact custom fields, with exactly these names:

   | Field | What it holds |
   |---|---|
   | `gaia_badge_token` | the code on their badge — drives the QR and the link |
   | `gaia_pass` | e.g. `Friday Exhibit Hall — Friday 20 November only` |
   | `gaia_pass_includes` | e.g. `Includes the exhibit hall on Friday 20 November.` |

   `gaia_pass` and `gaia_pass_includes` are computed from the same three flags
   the door scanner enforces — conference, workshop, VIP — plus the days, so
   the e-mail can never promise more access than the scanner will give.
2. **Send only to contacts where that field is set.** If it is empty the QR will
   not load and the button lands on "ticket not found".
3. **Check the hotel block.** The link uses group code `GRP_GAIA26` and dates
   19–22 Nov 2026. The old confirmation e-mail has been sending people to
   **2025** dates under a different group code since May. Confirm with Rosen
   Shingle Creek that `GRP_GAIA26` is live, or delete that one paragraph.
4. **Send it to yourself first**, on a phone, with images turned off as well as
   on. The code is printed as text under the QR precisely so a blocked image
   does not leave somebody with nothing.

## What each link does

| In the e-mail | Goes to |
|---|---|
| the QR image | `api.gaiahealers.app/t/<token>.png` — the same code the door scanner reads |
| **Open my ticket** | `api.gaiahealers.app/ticket/<token>` — the whole ticket as a page |

## What each pass says

| Pass | 2026 holders | The line they see |
|---|---|---|
| General Admission | 256 | Includes the exhibit hall on all three days. |
| General Admission + Conference | 67 | …on all three days and all conference sessions. |
| Friday Exhibit Hall | 13 | Includes the exhibit hall on Friday 20 November. |
| Volunteer / Staff | 9 | …all three days, all conference sessions and the workshops. |
| VIP Pass | 2 | …all three days, all conference sessions, the workshops and the VIP areas. |
| Sunday Exhibit Hall | 1 | Includes the exhibit hall on Sunday 22 November. |
| Gaia Guest | 1 | …on all three days and all conference sessions. |

Plain General Admission does **not** include the conference sessions. 256
people hold it, and until now nothing told them.

The ticket page needs no sign-in and no app. It shows the name, the pass, the
code, the dates and the venue, and prints cleanly. If someone who only came in
2025 opens an old link, it says so rather than presenting a finished conference
as a live ticket.

**It gets better on its own:** the moment a wallet store is switched on, an
"Add to my phone" button appears on that page for everyone who kept the e-mail.
No re-send.

## Who has not heard from you

Of 339 paid attendees for 2026:

- **251** got the registration confirmation
- **68** got a payment receipt and nothing else
- **20** have had no e-mail at all

The gap is worst among recent buyers: of the 60 people who bought since
20 August, only 7 got the confirmation. Those same buyers also arrive in the
database with no GHL contact id, which points at the order workflow rather than
at the mail itself. **Fix the workflow before you send**, or every ticket sold
between now and November falls into the same hole.

Send the 20 who have heard nothing a personal note, not a broadcast. They paid
months ago and have had silence.
