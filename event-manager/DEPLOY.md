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

### Single-day passes

`ticket_types.valid_day` (nullable, `YYYY-MM-DD`, venue-local) limits a base
pass to one calendar day; the door refuses it on any other. NULL means valid for
the whole event, which is every tier that existed before this — so adding it
changed nothing for them.
