# Event Manager — deploy and rollback

Production runs on the VPS at `80.241.220.129`. From 2026-09-04 the source of
truth is **this repository**, not the server.

> **Stop editing `/root/event` directly.** The flow is
> `branch → change → tests → PR → merge → deploy`. Editing production first is
> how the previous drift happened, and on an event day it leaves nobody able to
> answer "what changed?" or "how do I undo it?".

## What runs where

| Piece | On the VPS | Served at |
|---|---|---|
| FastAPI backend | `/root/event/backend`, `gaia-event-manager.service`, uvicorn on `127.0.0.1:8002` | `/event-api/*` |
| Event Manager SPA | built from `/root/event/frontend`, deployed to `/var/www/event` | `/event/` |
| Admin shell | `admin/` in this repo → `/var/www/gaia-admin` | `/admin/` |
| Gaia proxy | `/root/gaia-staging-proxy`, `gaia-staging-proxy.service` | `api.gaiahealers.app` |

Python 3.12.3, system interpreter (no virtualenv). Node/CRA for the frontend.

## Runtime state that is NOT in Git, and must not be

`backend/.env` (JWT signing key, identity service token, VAPID), `event.db` and
its backups, `_backups/`, `backend/uploads/` (attendee photos — personal data),
`vapid_private.pem`, logs and pids, `node_modules/`, `frontend/build/`,
`__pycache__/`.

Losing the VPS means restoring those from backup, not from Git. Keep taking
`event.db` snapshots.

## Deploy

```bash
# 1. On the VPS, note where you are coming from — this is your rollback point.
cd /root/gaia-healers-mobile-app && git rev-parse --short HEAD

# 2. Fetch the merged code.
git fetch origin && git checkout main && git pull

# 3. Backend: copy source, keep runtime files untouched.
rsync -a --delete \
  --exclude '.env' --exclude '*.db' --exclude '*.db.*' \
  --exclude 'uploads/' --exclude '__pycache__/' --exclude '*.log*' --exclude '*.pid' \
  event-manager/backend/ /root/event/backend/
systemctl restart gaia-event-manager && sleep 5 && systemctl is-active gaia-event-manager

# 4. Backend tests, against the running service.
cd /root/event/backend && for t in test_badge_card test_card_permanence \
  test_walkin_lifecycle test_walkin_reconcile test_door_lifecycle \
  test_qr_permanence test_ledger_integrity; do python3 $t.py | tail -1; done

# 5. Frontend: sync source, rebuild, publish.
rsync -a --delete --exclude 'node_modules/' --exclude 'build/' \
  event-manager/frontend/src/ /root/event/frontend/src/
cd /root/event/frontend && CI=false npm run build
rsync -a --delete build/ /var/www/event/

# 6. Admin shell (only when admin/ changed).
cp admin/gadmin.js admin/gadmin.css /var/www/gaia-admin/ && chown www-data:www-data /var/www/gaia-admin/*

# 7. Proxy (only when staging-proxy/ changed).
rsync -a --exclude '.env' --exclude 'node_modules/' --exclude 'data/' \
  staging-proxy/ /root/gaia-staging-proxy/
systemctl restart gaia-staging-proxy
```

## Rollback

The database is never rolled back by this procedure — only code.

```bash
cd /root/gaia-healers-mobile-app
git checkout <last-known-good-sha>          # e.g. the tag below
# then repeat deploy steps 3, 5 (and 6/7 if those changed)
```

If a migration has already added columns, rolling the code back is still safe:
every column added by this system is additive and nullable, and older code
ignores columns it does not know about. **Rolling back the database is a
separate, deliberate act** — restore from `/root/event/backend/event.db.pre-*`
or `_backups/`, and only with the owner's say-so.

Fastest possible door recovery, if the Admin shell is the problem: staff use
`https://api.gaiahealers.app/event/` directly. It is the same application.

## Production baseline

Tagged `event-manager-baseline-2026-09-04`. At that tag the checked-in source
was byte-identical to the running VPS source (`diff -r` across all 72 files:
zero differences), and the deployed SPA bundle was `main.4cb931c6.js`.

## Architecture

One Event Manager. `/admin/ → Events` embeds `/event/` in an iframe. Never build
event features in the Admin shell — see
[`design-reference/EVENT-ADMIN-ARCHITECTURE.md`](../design-reference/EVENT-ADMIN-ARCHITECTURE.md),
enforced by `tests/event-admin-boundary.test.cjs`.

## Payment channels the reconciler reads

Tickets do not only arrive as GHL **orders**. A ticket sold on a GHL **invoice**
is a different object with its own id, and until 2026-09-04 the reconciler read
orders only — which is how five paying customers ended up with no attendee, no
badge and no QR.

| Channel | Endpoint | Ledger key |
|---|---|---|
| completed order | `POST /identity/reconcile-attendee` | `order_id` |
| **paid invoice** | `POST /identity/reconcile-invoice` | `invoice_id` |
| unmapped paid product | `POST /identity/report-unmapped-sale` | surfaced for review only |

The **webhook branches on `transaction.entityType`**. It previously fetched every
`entityId` as an order, so an invoice-backed payment 404'd, produced no products
and was filed as an unmapped sale — which is how five paying customers ended up
with no attendee, no badge and no QR. Both branches now also carry the product
id, line quantity, amount and GHL's own timestamp, so the ledger can be counted
later without guessing.

No order id is ever invented for an invoice sale. A transaction is the *payment
representation* of an order or invoice, never a third purchase — count orders
and invoices, never the transaction total.

**A product becomes event access only when a human maps it.** An unmapped paid
product is recorded and shown in Admin as *Unmapped event sales — review
required*; nothing is created from a product's name, however event-like it
sounds. This exists because four people bought a day pass created that morning
and it went unnoticed until an audit.

## Source of truth, in one place

**GHL is authoritative.** Gaia mirrors it and never writes payment, ticket,
entitlement or attribution changes back. Every reconciliation path issues GET
requests to GHL only; the sole write target is the Event Manager.

| | |
|---|---|
| **Webhook** | the fast path — a sale is reconciled seconds after GHL takes the money |
| **Hourly mirror** | the recovery path — re-reads GHL and converges Gaia on it, so an undelivered webhook leaves no silent gap |
| **Map & Reconcile** | a human maps a product, reviews the impact, and replays that product's history through the same reconcile functions |

A product becomes event access only when a person maps it. Nothing is created
from a product's name, however event-like it sounds.

## Installing the hourly mirror

The unit files are tracked in `event-manager/systemd/`, so the timer is part of
the repository rather than something configured by hand on one server:

```bash
cp event-manager/systemd/gaia-event-mirror.service event-manager/systemd/gaia-event-mirror.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now gaia-event-mirror.timer
systemctl list-timers gaia-event-mirror.timer --no-pager
```

The script it runs is `staging-proxy/event-mirror.mjs`, deployed with the rest
of the proxy. To check it, or to see what it would do without writing anything:

```bash
journalctl -u gaia-event-mirror.service -n 20 --no-pager -o cat
```

```bash
node /root/gaia-staging-proxy/event-mirror.mjs --since-days=30 --dry-run
```

## Known unrelated debt

15 membership tests in `staging-proxy/test/` fail against a membership-event
pipeline `memberAccessWebhook` does not implement. Pre-existing, unrelated to
the event work, and deliberately not "fixed" — see issue #75. Do not implement
membership semantics merely to turn them green.

## Two ways a payment reaches Gaia

**The webhook is the fast path.** `POST /api/webhooks/ghl-payment` on the proxy
reconciles a sale within seconds of GHL taking the money.

**The mirror is the recovery path.** `gaia-event-mirror.timer` runs
`staging-proxy/event-mirror.mjs` hourly, re-reads the last 14 days from GHL and
makes Gaia converge on it — completed orders, paid invoices, refunds, and
products nobody has mapped. It is **read-only against GHL**: it issues GET
requests only and writes exclusively to the Event Manager.

It exists because an undelivered webhook leaves no trace at all. On its first
real run it saw 83 orders, found all 83 already reconciled, and created nothing
— which is the result to expect. A run that starts creating attendees means
webhooks are being missed, and the log line says so:

```bash
journalctl -u gaia-event-mirror.service -n 20 --no-pager -o cat
```

```bash
node /root/gaia-staging-proxy/event-mirror.mjs --since-days=30 --dry-run
```

Two rules it must keep:

- It scopes mappings to `EVENT_TICKET` / `EVENT_UPGRADE`, exactly as the webhook
  does, so a membership or course product can never mint a seat.
- **Refunds are keyed on the money reference, never on the buyer's email.**
  Sponsorships and Bio-Well kits get refunded too and share an address; matching
  by person would revoke an event seat nobody refunded. A refund Gaia never
  ledgered is a clean no-op. `test_refund_mirror.py` pins this.

### Refunds follow the payment that is still valid

Access is derived from the entitlement ledger, not switched off wholesale:
refunding an upgrade drops the tier and keeps the person; refunding everything
revokes. A ticket bought on an invoice is ledgered under `invoice_id`, so
`/identity/refund-ticket` accepts `invoice_id` alongside `order_id` — before
2026-09-04 it matched `order_id` only, which made an invoice refund fall through
to a legacy path that was neither idempotent nor tier-aware, and an invoice
*upgrade* refund threw the person out of the event entirely.

## Map & Reconcile

Mapping a product used to do nothing for the sales that had already happened.
Four people bought a day pass created that morning, and even once somebody
mapped it their payments stayed unrepresented.

Now: Attendees → *Unmapped event sales* → **Map & Reconcile**. Staff pick the
Gaia ticket type, see the impact, and only then approve. The preview shows the
product name, its immutable id, the ticket type, successful historical payments,
seats represented, how many Gaia already holds, how many would be created, and
what is excluded as pending or refunded.

The replay calls the same `reconcile_attendee` / `reconcile_invoice` functions
the webhook and the mirror call — not a parallel implementation — so a replayed
sale and a live one cannot end up in different states. It is idempotent (keyed on
the payment reference), audited in `map_reconcile_runs` with the preview staff
were shown, and matched on the product id alone. The Event Manager holds no GHL
credentials, so it reads sales through the proxy's `/api/event/ghl-sales`, which
is GET-only and caches line items in `data/ghl-line-items.json`.

## Counting: never one number called "purchases"

`GET /events/{id}/ticket-metrics`. The identity that holds it together:

    original ticket purchases + repeat base payments + upgrade payments
      = total economic events

An **upgrade** adds revenue and a tier. It is never a head and never a seat. A
**second payment for the same base product is not an upgrade** — it is another
seat or a duplicate charge, decided from the purchase timestamp GHL recorded:
minutes apart with the same amount reads as a suspected duplicate, days apart as
an additional paid seat, anything between is left for a person. Where GHL does
not name the second guest the seat is counted as **unassigned**, never filled
with an invented attendee. Same for `quantity > 1`.

Whether a mapped product is an upgrade is a **Gaia** mapping attribute, not GHL
data. Two products were mapped as base tickets when the evidence said otherwise
(Full Speaker Access was never a first purchase for any of its 33 buyers, One Day
Speaker Upgrade for 1 of 26), which made 59 tier changes look like 59 extra
tickets sold.

## Unmapped sales: triage, not deletion

Gaia Healers sells Bio-Well devices, Healeex systems, CRM subscriptions,
sponsorships and calendar bookings through the same GHL location. Those are real
sales that are simply not this event's, and 80 of them sitting in an event alert
trains staff to ignore the alert. `unmapped_sales.relevance` sorts them; the
panel shows `event_like` and counts the rest. **Nothing is deleted** —
`?include_unrelated=true` returns everything. Triage decides what is *shown* and
never what is *granted*: a product still becomes access only when a human maps it.

## Vendors

**Admin → Vendors** holds the whole board — 52 stands across eight stages, not
just the ones who paid. The sheet keeps prospects, maybes and refusals in the
same list separated by a heading, and that is the right shape: a maybe becomes
confirmed the day they pay, and carrying it across means nobody re-types a
vendor on conversion. Promoting one is a single field.

| stage | |
|---|---|
| `confirmed` | 23 — $111,000 booked, $94,500 collected, $16,500 outstanding |
| `waiting` / `unsure` | 8 in conversation |
| `other` / `product_sponsor` | 10 — our own tables, and product-only sponsors |
| `next_year` / `not_attending` / `not_aligned` | 11 kept for the record |

Money is the **confirmed** stands only. A prospect has booked nothing, and
rolling them in would make "booked" a number nobody could act on.

> **The scripts are tracked; the data they read is not.** `import_vendors.py`
> and `enrich_vendors.py` expect `vendors_all.json` / `enrich.json` beside them,
> and those carry vendor contact details — the source of truth for that is the
> planning sheet, not this repository. `scrape_vendor_sites.py` regenerates the
> enrichment from the companies' own websites, and the sheet export regenerates
> the rest. `event-manager/import/*.json` is gitignored so a careless
> `git add -A` cannot sweep them in.

The importer is `event-manager/import/import_vendors.py`, idempotent on
(event, company name), and it leaves every stand **unpublished with scanning
off** — a spreadsheet is planning, not a decision. Only `confirmed` should ever
be published; the UI groups by stage so a "not aligned" stand is never one stray
click from the attendee directory.

Two switches per stand, deliberately separate, because a booth and lead
retrieval are separate purchases:

| | |
|---|---|
| **In the directory** | attendees can find them in the app |
| **Can scan badges** | their lead-retrieval link actually works |

Neither implies the other. Adding a vendor by hand publishes them (someone
typing a stand in wants it found); the bulk import does not.

The public directory carries **no commercial detail at all** — not the package,
not what they paid, not their scanner token — and carries contact details only
for a stand that asked for it, because several of these addresses are somebody's
personal mailbox.

### Booth and tables are live

Both are editable per stand in **Admin → Vendors**, and every surface reads the
same row: the attendee directory, the stand's own page, and the admin list all
change the moment you save. There is no publish step and no sync — floor plans
move, and re-typing a booth number in three places means one of them is wrong on
the day.

A booth is a **label, not a quantity**: `#7 & #8` and `Foyar 6&7` are real
values here. The sheet stored some of them in a numeric cell, which is how
`27.0` reached the page; the importer strips that now, and a test fails if any
booth label is left as a float.

### What attendees see

The app's **Exhibit hall → Vendor directory** lists every published stand with
its logo, booth number and what it does. A row opens that stand's own page
(`/v/<id>`) rather than firing the attendee straight out to a company website —
the stand page carries the booth number and how to reach them, and a link out
loses both, along with the person.

Nothing commercial crosses: no package, no amounts, no scanner token. Verified
by `test_vendors.py`.

### Paid, and allowed to scan

They are separate switches because they are separate purchases, but they should
normally agree. The Vendors screen reconciles them: it offers to grant scanning
to every settled stand in one action, and **warns in the other direction** —
a stand that can scan but has not paid is named, because that is the one you
want to find before the doors open, not after.

### The stand's own screen — and why the blur is real

`/event/scan/<access_token>` is what a booth runs on a phone. It shows the
people they have met, and below that the rest of the event as **blurred
placeholder rows**.

The blur is over nothing, and that is the security model rather than a styling
choice. `GET /scan/roster/<token>` returns a **count** — no names, no emails, no
ids. For the 292-person event the whole payload is **169 bytes**.

> Blurring a real list in CSS would be theatre: the browser would be holding
> every name, and devtools would show them. Encrypting it would be the same
> theatre with extra steps, because a client that can decrypt is a client that
> holds the key. The only thing that actually withholds data is not sending it.

A person becomes visible exactly once — when they hand over their badge and the
server, having checked this stand is granted `can_scan_leads` at all, records the
exchange. Even then the response is consent-filtered per field, and consent is
snapshotted **at the moment of the scan**, so agreeing later does not
retroactively hand over an exchange that already happened.

A stand with no grant gets a 404 from the roster — the same answer an invented
token gets, so a probe learns nothing either way.

### The public stand page

`/v/<exhibitor_id>`, published stands only. Logo, tagline, description, booth,
and whatever public contact the company itself publishes. Eight of the logos are
white artwork taken from the event site, which is dark, so `logo_on_dark` is
measured once at import and the tile follows — otherwise those eight are
invisible on a white background.

### Two kinds of vendor contact

| | |
|---|---|
| `public_email` / `public_phone` / `address` | read off the company's **own website** — already published by them, so the directory shows it without asking |
| `contact_email` / `contact_phone` | whoever **booked the booth**, frequently a personal mobile — internal, and shown only if that person opts in |

The directory prefers the public one wherever it exists. Publishing the booking
contact by default would mean handing out somebody's private number to anyone
who opens the app.

`import/scrape_vendor_sites.py` reads only what a site actually shows —
`mailto:`, `tel:`, a postal address, the meta description — and writes nothing
it had to guess, because a directory entry with a wrong phone number is worse
than one with none. `import/enrich_vendors.py` applies it and **never overwrites
something a human already wrote**. Logos come from the event site's own
exhibitor wall.

Two vendors publish the same address they booked with (Hair By Mermaid, Medi Air
Purifier) — that is a one-person business, not a copied field, and
`test_vendors.py` names them so a *new* match fails the suite.

Coverage after the first pass: 15 of 33 have a logo and a description; four
sites block automated reading entirely (ASEA, Quantum Sound Therapy, Pulse PEMF,
Approvd). That is what the setup link is for.

### Vendor self-setup

**Setup link** mints a URL the organiser sends however they actually reach that
vendor. The stand opens `/vendor/<token>`, writes its own description, website
and logo, and publishing itself puts it in the directory.

It is **not** their scanner token, and that is the point: one writes a paragraph,
the other reads the people who walked up to their booth. A forwarded setup email
must not become a lead list. Only a hash is stored, links last 21 days, and
issuing a new one retires the previous.

The payload has no `package`, `amount_paid`, `booth_number` or `can_scan_leads`
field at all — leaving them out is a stronger guarantee than checking for them.

`test_vendors.py` covers the lot, including that a stand cannot mark itself paid
or grant itself a scanner.

## Rehearsing the door before opening day

A ticket is not valid outside its event's calendar window, and that gate is not
negotiable — it is what stops last year's badge opening this year's door. But
staff have to practise check-in and test the printer *before* the event, not in
front of a queue, and there was no way to do that at all.

Check-In shows a banner whenever the event has not started. **Start rehearsal**
waives the calendar window for that one event, and nothing else: another event's
badge, a refunded ticket, a single-day pass on the wrong day and a second scan of
the same badge are all refused exactly as they would be on the day. Every scan
is written to the history prefixed `REHEARSAL —`, so it can never be read as real
attendance. Turn it off before the event; **Clear** empties the practice scans.

`test_door_rehearsal.py` pins the whole boundary.

> **The bug this uncovered.** The anti-passback check read
> `event.custom_fields.get("allow_reentry")`, but that column is a *list* of
> registration-form fields on every real event. Nothing had ever reached the
> line, because the calendar gate returns first on every day that is not an
> event day — so the first scan to get that far would have been **the first scan
> of the real event**, and it would have been a 500 at the door. Rehearsal is
> what found it.
>
> A second one: `POST /events/{id}/ticket-types` accepted `valid_day` and never
> stored it, so a single-day pass created through the UI silently became valid
> for the whole event. The live Friday Pass was set directly in the database and
> was never affected.

### The typed code on the label

The badge prints the 8-character code under the QR. Check-In accepts it typed by
hand, and a camera that will not focus — scratched sticker, cracked lens, bad
light — is the likeliest failure at a busy door. Printing it turns a dead end
into four seconds of typing.

It sits **clear of the QR's quiet zone**, not tucked inside it. That margin is
what lets a scanner find the code at all; saving two millimetres by writing in
it would trade the thing that works for the thing that helps when it does not.
On a roll too short to carry both, the code is dropped and the QR keeps its
size. Verified decoding on two independent engines, clean and blurred, at every
roll size.

### Single-day passes

`ticket_types.valid_day` (nullable, `YYYY-MM-DD`, venue-local) limits a base
pass to one calendar day; the door refuses it on any other. NULL means valid for
the whole event, which is every tier that existed before this — so adding it
changed nothing for them.
