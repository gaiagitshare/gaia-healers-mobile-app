# Which conference does this sale belong to?

GHL reuses product ids and funnels from one year to the next. The same `$99
General Admission` product that sold Elevate 2025 tickets went on selling
Elevate 2026 tickets, under the same immutable id. So the product id alone
cannot answer the question in the title — **the product plus the purchase date
can**, and nothing else in the data does.

## The rule

Each row in `ticket_mappings` carries `valid_from` and `valid_until`. A mapping
grants its ticket only for sales dated inside its own window:

| mapping | product | event | valid_from | valid_until |
|---|---|---|---|---|
| 13 | `68755fe7…` | Elevate 2026 | 2026-01-01 | — |

A sale of `68755fe7…` dated `2025-09-14` therefore does **not** belong to
Elevate 2026, however familiar the product looks.

Two deliberate exceptions:

* **A sale with no date is admitted.** Absent evidence is not evidence of a
  2025 sale, and refusing it would drop real ticket-holders on the floor.
* **A mapping with no window declared claims everything**, exactly as it did
  before windows existed. Declaring a window is opt-in; adding the columns did
  not silently change any mapping's reach.

## Where it is enforced

At `_assert_sale_in_window()` in `main.py`, called from the **one door every
caller comes through**:

* `POST /identity/reconcile-attendee` — the order path (hourly mirror, Map &
  Reconcile)
* `POST /identity/reconcile-invoice` — the invoice path
* `POST /webhooks/registration` — the live path, via `_mapping_covers()`

and again in `_pe_upsert()`, so the Payments screen attributes a payment to the
same event the ticket path would.

An out-of-window sale is refused with **409** and a message naming the year it
does belong to, so the caller can route it rather than guess:

```
Sale dated 2025-09-14 is outside the sales window for product 68755fe7… on
'Gaia Healers Elevate Conference 2026'; it falls in event 2's window
```

`event-mirror.mjs` counts those as `out_of_window`, not as errors. A backfill
reaching back far enough **will** meet last year's sales, and a healthy
recovery run should not look broken.

## Why this is written down

The `valid_from` column has existed since the 2025/2026 cycles were untangled.
It was never read.

The column was in the database but was never declared on the `TicketMapping`
SQLAlchemy model, so `getattr(mapping, "valid_from", None)` returned `None` for
every mapping, and `_mapping_covers()` cheerfully returned `True` for
everything. The webhook's check had never once fired. The reconciler — which
the hourly mirror and Map & Reconcile both call — did not check at all.

None of that was visible for as long as the mirror only ever looked back a few
hours, because a short window never reaches last year's sales. It stopped being
invisible the moment a backfill ran with `--since-days=400`: **311 people who
bought a 2025 ticket were admitted to the 2026 conference**, each with a QR
code. Nothing was checked in, nothing was printed, and the rows were removed —
along with 5 entitlements the same run had appended to 4 genuine 2026
attendees who had also attended in 2025.

The incident is not the point. A recovery run after an outage would have done
the same thing, on a day when somebody was relying on the numbers.

## Guarding it

`test_event_year_isolation.py` sells one product id to two conferences a year
apart and asserts, from both sides, that each sale lands in its own year — that
the boundary is exact to the day, that the invoice channel is guarded too, and
that the two exceptions above still hold.

`test_ledger_integrity.py` independently asserts that no GHL order id ever
spans two events, which is what caught the entitlement residue.
