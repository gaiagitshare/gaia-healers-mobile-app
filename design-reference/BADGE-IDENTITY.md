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

## The sticker (approved 2026-09-03)

40 × 50 mm portrait: full name on top (one line, wrapping to two and shrinking
for long names; the surname is never cut before the given names are), one
large QR beneath (≈ 32.7 mm, 9 printer dots per module at 203 dpi), nothing
else. The coloured card already says ATTENDEE / VIP / EXHIBITOR / SPEAKER.

**Placement on the 70 × 100 mm card:** top edge **12 mm** down from the card's
top (clear of the lanyard clip), horizontally centred in the 56 mm area to the
left of the vertical tier word (i.e. left edge at 8 mm). Same position on all
four card designs; it never touches the tier word or the ELEVATE lockup.

**Stock:** the design target is a genuine 40 × 50 NIIMBOT roll. If that cannot
be sourced, the closest compatible **portrait** roll is **40 × 60 mm**
(NIIMBOT, 125/roll, B1/B21/B3S) — the layout is not changed for it; the
extra 10 mm becomes air around the QR. The layout is never switched to
landscape because stock is easier to find.

Printed host: **`card.gaiahealers.app` — live since 2026-09-03** (Let's Encrypt,
auto-renewed). `CARD_PUBLIC_BASE=https://card.gaiahealers.app` is set in the
Event Manager `.env`; both `card.gaiahealers.app/<token>` and `/c/<token>`
resolve, and `api.gaiahealers.app/c/<token>` remains as a fallback. The token
never changes when a host does.


---

## Permanence (2026-09-04)

The card is a **`member_cards`** row keyed on the person — GHL contact id **plus
the name on the ticket**, or the verified email. It is not owned by an event, and
nothing it needs lives on an attendee row:

- **Archive** an event → card unaffected.
- **Delete** an event → attendee rows go, card and token stay, and the event
  stays in the card's history, because attending it still happened.
- **Delete every event the person ever attended** → the card still resolves,
  still renders, still edits. Proved by `test_card_permanence.py`.

`attendees.public_token` remains as a denormalised copy so the door resolves a
scan exactly as before. `member_cards` carries its own `name`, `email` and
`phone` snapshot so the contact switches keep working with no ticket left.

**A CRM contact id alone never merges two people.** Households and couples share
one GHL contact; before this was fixed, two different people behind one contact
were issued the *same* badge token and therefore the same card. The identity key
is now `contact_id + normalised name`, or the email on its own.

`member_card_events` is the participation history: event label and role only,
written from genuine attendee records and never deleted.

Deleting an event now also removes `networking_profiles`, `saved_sessions`,
`connections`, `feedback` and `push_subscriptions` for its attendees — no
orphaned personal rows. The member card is deliberately NOT in that cascade.

**Label roll:** the default is **40 × 60 mm**, a roll NIIMBOT actually sells
(the printer needs its own RFID stock; unbranded rolls print blank). The
40 × 50 design target is unchanged and still selectable — the layout is
identical, name over the same 32.7 mm QR.


## Card identity fields, and changing them

**Digital card, in one line:** full name, email and phone are required to
publish; changing any of them takes two proofs — first that you are the current
owner, then that the new address is yours — and neither the badge token, the QR,
nor the ticket record changes when the card's name does.

**Full name, email and phone are mandatory to publish.** A card without all
three is not a business card. Saving a draft is never blocked — only publishing
is — so nobody is trapped half-way through the form.

**Legacy cards keep working.** 585 of 661 cards predate the phone field. A card
already public stays public and stays resolvable at its printed URL; the gap is
reported to the editor as `missing_required` and must be filled before that card
is published again. A refusal never takes a live card down.

### Changing name, email or phone takes two proofs

These three are also the account's recovery information. Someone who picks up a
signed-in phone at a conference must not be able to swap the recovery email for
their own and lock the owner out. So:

1. **Prove you are the current owner.** A code goes to a contact method
   *already on file* — never to the address being typed in. Destinations are
   shown masked (`b***@gmail.com`, `••• ••• 4821`); the full value is never
   returned. Success mints a **15-minute permit**, not a standing right.
2. **Prove the new address is yours.** A second code goes to the *new* email or
   phone. **The trusted value is not replaced until this succeeds.**

`full_name` is written through `/identity/card/update` with the permit. Email
and phone are not writable there at all — they are named `new_email`/`new_phone`
on that payload purely so a client trying the shortcut gets pointed at the
two-step flow. (The payload's own `email` is the *caller's identity*; one field
meaning both "who I am" and "who I want to become" would let a card update
silently change which account it was editing.)

### What the codes guarantee

Six digits, 10-minute expiry, single-use, 5 attempts, 5 requests per hour per
person per purpose, and issuing a new code kills the previous one. Only a
salted SHA-256 is stored — a copy of the table completes no verification. Codes
never reach a log and never cross the public card API.

**A public badge token is never enough.** Every verification route requires a
real Gaia session and returns 401 to an anonymous caller or a bare token. A
permit belongs to one card: it cannot edit or start a change on anybody else's.

### What a name change does not do

The card's display name is the person's to choose. Editing it **does not rewrite
the attendee or ticket record**, and the permanent badge token and QR do not
change — the sticker in someone's drawer keeps working.

### Delivery

Codes go out over the same transactional channel the sign-in magic link already
uses (a GHL conversations email to the contact). **No SMS channel is
configured**, so a phone destination for step 1 returns
`sms_delivery_unavailable` rather than pretending a code was sent. Step 2 for a
phone number needs that channel before it can be used in production.


## One QR, two jobs — and a card that wakes up

Every attendee has a permanent token and a card **from the moment their ticket
lands**, months before the event. All 292 for Elevate 2026 already do. The QR
resolves the whole time; there is nothing to generate later and nothing to
reissue.

Until they check in the card is **dormant**, and the page says so — *"Card not
active yet. It switches on when Jane checks in at the event."* An empty profile
reads as broken; "not yet" reads as correct.

**Checking in activates it.** The same scan opens the door and switches the card
on, because it is the same QR either way — no second step at a busy desk, no
second code to print.

Activation publishes **once**, guarded by `activated_at` rather than
`card_public`. Somebody who later switches their card off has decided something,
and walking past a scanner again must not quietly undo it. The page then says
*"Card is private"* — a different state from dormant, and it says which.

`test_card_activation.py` pins all of it.

### Getting the QR to people before the day

It is the same token either way, so this is a delivery choice, not an
architecture one:

- **The printed badge at the door** — the guaranteed path, works with no email,
  no phone and no signal. This is the one to rely on.
- **Signing in to the app** — *You → My badge card* shows it, already.
- **Emailing it ahead** — possible over the same transactional channel the
  sign-in link uses. Worth doing for the queue it saves, but it is 290 outbound
  emails and should be sent deliberately, not as a side effect of a deploy.
