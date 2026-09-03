# Badge identity — what the printed QR is, and what it is not

Shipped 2026-09-03. This is the contract the door, the app, the Admin and the
public card all rely on. Change it deliberately or not at all.

## Two identities, one person

| | `attendee.qr_code` — `ATT-XXXXXXXXXXXX` | `attendee.public_token` — `7K2MXPQ4` |
|---|---|---|
| **Represents** | one **event ticket** (this person, this event) | the **person** — their Gaia networking identity |
| **Scope** | event-specific; a new event = a new `ATT-` code | reused across events for the same human |
| **Lives** | Admin, scanner, the app's ticket sheet, exhibitor lead scan | the printed sticker QR, the public card URL |
| **Contains** | nothing (random hex) | nothing (random, alphabet `A-Z 2-9` minus `0 O 1 I`) |
| **Public?** | never — only behind an authenticated or token-guarded route | yes, by design — it is printed on a badge |
| **Rotates?** | never (badge permanence guarantee, tested) | only on the owner's request; a rotation means a reprint |

The printed QR encodes `HTTPS://CARD.GAIAHEALERS.APP/<TOKEN>` (uppercase so the
QR uses alphanumeric mode: version 2, 25 modules — measured, not estimated).

## How the two meet

`badge_card.parse_scan()` in the Event Manager is the **only** place both
representations are understood. Every scanner path calls it:

```
scanned text ──▶ parse_scan ──▶ ("qr", ATT-…)      ──▶ attendee where qr_code = … AND event_id = this door
                              └─▶ ("token", XXXXXXXX) ─▶ attendee where public_token = … AND event_id = this door
```

Then the *same* authorisation runs: lifecycle gate, venue-local date window,
anti-passback, zone entitlement. A 2025-only badge scanned at the 2026 door is
refused ("not valid for this event") exactly as a 2025 `ATT-` code would be.
The response always reports the canonical `ATT-` code, never the token.

Because the token names the person, resolving it **requires the event**. The
legacy global `/checkin` (no event) accepts a token only when the person holds
exactly one row in a live event; anything ambiguous is refused, never guessed.

## Why person-level, and what that implies

- A returning attendee's card, connections and "opened N times" persist from
  Elevate 2025 into 2026 and beyond. Their badge URL is theirs, not the event's.
- One person = one token even when their email changed between years (the
  link is the GHL contact id). Verified: 631 people across 653 rows; 21
  returning attendees carry one token each; 3 of them changed email.
- The **card page** shows the person's *latest* event and the *most recently
  edited* card among their rows. Editing from any year's ticket updates the
  one public card.
- The **ticket** stays event-specific: access, check-in and the door decision
  are always about one event's row.

If the product ever needs a badge-specific alias (e.g. printing a code that
should die with the event), that is a *third* field, not a change to either of
these.

## What the public card may show

Before claim: first + last name, the event, *Claim your card*, *Connect in the
Gaia app*. After claim, only what the owner switched on: photo, company, title,
city, bio, interests, website, Instagram, LinkedIn, WhatsApp — and email /
phone **only** behind their own explicit switches (default off).

Never on the card, in its HTML, its vCard or its URL: ticket tier or
entitlement, order or payment data, GHL contact id, attendee id, `ATT-` code,
email or phone unless switched on.

## The sticker

40 × 50 mm portrait: full name on top (one line, wrapping to two and shrinking
for long names; the surname is never cut before the given names are), one
large QR beneath (≈ 32.7 mm, 9 printer dots per module at 203 dpi), nothing
else. The coloured card already says ATTENDEE / VIP / EXHIBITOR / SPEAKER.

Printed host: `card.gaiahealers.app` (DNS pending). The token does not change
when the host does; **do not print production badges until the host is live**
and `CARD_PUBLIC_BASE` in the Event Manager `.env` points at it.
