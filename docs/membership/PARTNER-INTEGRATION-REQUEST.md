# Integration request to Gaia Practitioners

**From:** Gaia Healers. **Purpose:** the Gaia membership service needs to read the
practitioner subscription and coin data your platform owns. We will not write to
your database, replace your coin system, or charge your customers. Shapes are
proposals; please correct anything that does not match your system. The code
that checks these shapes is `membership-service/src/partner/contract.js`.

## 1. Questions we need answered (no data yet)

1. **Billing ownership.** Who is the merchant of record for the ~30 paid practitioner subscriptions today? Which processor and account do you use (your own Stripe account? Connect?), and who handles refunds, disputes and chargebacks?
2. **Coin model.** Where do balances live? Is there a transaction ledger? How are coins bought, granted (sign-up, promotional, compensation) and spent? Can balances go negative? How are failed AI jobs refunded?
3. **Identity.** What is the stable account id? Can one practitioner have several accounts? How is a `pending` account different from `active`?
4. **Modules.** Which modules exist (Scan Analysis, Chakras, Auriculo, …), at what prices, and how is access decided?
5. **Events.** Can you send signed webhooks on changes, or should we poll?

## 2. Read-only API we propose (service token, server to server, rate-limited)

| Endpoint | Returns |
|---|---|
| `GET /v1/practitioners/{id}` | `practitioner_account_id`, `status` (active / pending / suspended / closed), `email`, `gaia_contact_id` if known |
| `GET /v1/practitioners/{id}/subscriptions` | per subscription: `subscription_id`, `plan_code`, `status`, `price_cents`, `currency`, `interval`, `current_period_end`, `billing_owner` (partner / gaia / none), `billing_provider`, `modules[]` |
| `GET /v1/practitioners/{id}/coins` | `balance { coins, as_of }` plus the **full transaction history**: `transaction_id`, `delta_coins`, `source` (purchase / grant / promotion / compensation / refund / adjustment / spend), `payment_ref` for purchases, `created_at` |
| `GET /v1/practitioners/{id}/entitlements` | active module entitlements and their source |
| Webhook (signed, with event id + timestamp) | `subscription.updated`, `coins.changed`, `practitioner.status_changed` |

Pagination with cursors; ISO-8601 UTC timestamps; integer cents and integer coins.

## 3. Before any migration: a sandbox export

A one-off **sandbox / anonymised export** in the shapes above (or your native
format) so we can verify:
- every balance equals the sum of its transactions;
- which coins were purchased (backed by a payment) vs granted — this decides the
  1:1 carry-over rule (spec §11; owner decision N-4);
- overlap between your $47 / $97 subscribers and Gaia Healers Silver members.

No production balances or subscriptions are migrated until both owners approve
the export and the carry-over rule.

## 4. What we provide in return

- An entitlement API (`GET /v1/me/entitlements`) your platform can call to decide
  access for Gaia-billed tiers.
- An atomic, idempotent coin debit API (quote → hold → capture / release) if and
  when coins move to the Gaia wallet. Until then your coin system stays authoritative.
