# Gaia membership service — foundation (Milestone C)

The backend foundation for Membership Specification v2.5. **Not wired to
production**: no production database exists, nothing imports this package,
no real payment, coin, GHL or partner call is made. Everything runs against a
throwaway local PostgreSQL with fixtures.

## Run the tests

```bash
cd membership-service
npm ci
eval "$(npm run -s testdb:up)"     # Docker postgres:16-alpine, loopback only, data in tmpfs
npm test
npm run testdb:down
```

The tests drop and recreate the `membership` schema, so `test/_db.js` refuses any
database that is not on a loopback host with "test" in its name. CI runs the same
suite against a Postgres service container (`.github/workflows/membership-service-ci.yml`).

## What is here

| Spec v2.5 | Module | Guarantees (tested) |
|---|---|---|
| §9 schema, migrations | `migrations/0001_foundation.sql`, `src/migrate.js` | up/down/up clean; an applied migration whose up or down section is edited is refused; advisory-locked |
| §3 tiers | `src/catalog.js`, `src/plans.js` | Free $0; Standard $47/$470; Professional $97/$970; Inner Circle $297/$2,970; 0/500/2,000/4,000 coins; Inner Circle includes every Professional benefit; "Gaia Recommended" badge is Inner Circle only |
| §10, §11 immutable versions | `plans.js` + DB triggers | a published version, its prices and benefits cannot change or be deleted (also under a concurrent publish); a price change is a new version; existing subscribers keep theirs; legacy versions are never sold, only imported |
| §10, §17 lifecycle | `src/subscriptions.js` | incomplete → no access; past_due → access until a configurable grace end; an `active` row past its period end loses access after 3 days; terminal states; full event history; older provider state never overwrites newer; repeated or same-second events are no-ops; click-to-cancel shows the exact end date |
| §16 entitlements | `src/entitlements.js` + DB trigger | union across plans and grants, each benefit once (max, never sum; false/0 grant nothing); revocations immediate; **tenant isolation**: a practitioner plan can grant only that practitioner's `practice.*` benefits, never Gaia's |
| §4, §9 coins | `src/coins.js` | buckets granted / purchased / legacy; spend order granted → purchased → legacy; monthly reset is a ledger event; idempotency keys (replay returns the first result, a reused key for another request is CONFLICT); 80 concurrent debits never overdraw; hold → capture/release so a failed AI job nets zero (a released hold cannot be replayed as a charge); granted coins never come back into a later cycle and allowances only move forward; balances always equal transaction sums (`wallet_mismatches()`) |
| §9 payment ledger | `payment_ledger` | append-only, signed integer cents, one row per provider object and entry type |
| §10 webhooks | `src/stripe/*` | Stripe v1 signatures over the raw body, 5-minute tolerance, secret rotation; stored before processing; duplicates stored once; live-mode refused; async processing in provider order with retries, backoff, dead-letter (business-rule refusals dead at once) and replay (never while processing); money always booked even when a status change is refused; plan changes followed; succeeded refunds only; unknown prices and their invoices ignored, never mapped by amount |
| identity | `src/identity.js` | one external id → one person; linking an id owned by someone else is CONFLICT, never a silent re-key |
| partner | `src/partner/*` | contract validators; balances must equal their history; purchases need a payment ref; carry-over split purchased vs legacy; unconfigured adapter fails closed |
| audit | `audit_logs` | append-only; plan, subscription, identity and coin writes record actor and action (the API layer in Milestone D passes the calling client) |

Every item above has a test; `test/review-regressions.test.js` covers the scenarios found in the independent review of this PR.

## Internal API (Milestone D)

`src/api/server.js` — service-to-service HTTP API, **not started anywhere**. Each
caller is an `api_clients` row (token stored as SHA-256, scopes, optional
practitioner tenant). Coin amounts are never sent by callers: they quote an
action priced server-side (`coin_action_prices`), then hold against the quote.

| Route | Scope | Notes |
|---|---|---|
| `GET /v1/identities/resolve` | identity:read | platform clients only |
| `GET /v1/persons/:id/subscriptions` | subscriptions:read | with `hasAccess` |
| `GET /v1/persons/:id/entitlements[?key=]` | entitlements:read | tenant clients see only their plans' benefits |
| `GET /v1/persons/:id/wallet` | wallet:read | both balances, $ equivalents, next grant date |
| `POST /v1/coins/quotes` | coins:quote | single-use, 10 min |
| `POST /v1/coins/holds` (+ `Idempotency-Key`) | coins:debit | double-click → one hold |
| `POST /v1/coins/holds/:op/capture` / `release` | coins:debit | only the client that held; failed job → release → nothing charged |

Tenant clients (a practitioner integration) get read scopes only (DB CHECK), see
a person only via a subscription to their own plans, and get NOT_FOUND
otherwise; denials are audited. Every write is audited with the calling client
and a request id.

Jobs (`src/jobs/`, one bounded pass via `node src/cli/jobs.js`, not scheduled):
monthly allowance (once per cycle, largest plan wins, annual plans grant
monthly, leftovers expire on lapse), stale-hold release, and grace / trial /
scheduled-cancel closing for Gaia-owned subscriptions (provider-owned ones are
only counted; the provider stays the billing truth).

## Reused, not rebuilt

- **The existing consumer membership** (`staging-proxy/membership/`: ledger,
  resolver, GHL sync, Free/Silver/Gold/Diamond) stays the authority for today's
  members. Nothing here reads or writes it. Legacy subscriptions enter this
  database only through a later, approved import as `legacy_import`
  subscriptions on legacy plan versions.
- **Practitioner OAuth and member links** (`practitioners-oauth.js`,
  `member-link.js`) remain how accounts are connected; their account ids map
  into `person_identities` (`gaia_practitioners` / `practitioner_account`).
- **AI cost controls** (`assist-guard.js` `allowSpend`, `assist-usage.js`)
  are where a coin quote + `holdDebit` will sit (Milestone D/E).
- **Backups**: the nightly encrypted backup must add a `pg_dump` of this
  database before it holds anything real (gate below).

## Not activated, and the gate for each

| Capability | Blocked until |
|---|---|
| Any production database | owner approves hosting (on this VPS vs managed) and the backup job includes it |
| Stripe Billing, products, checkout | Stripe account access + topology confirmed (P-Q2); test-mode keys first |
| Live webhooks (`allowLivemode`) | the above, plus a sandbox end-to-end pass |
| Practitioner-owned plans (Connect) | merchant of record decided (D5) |
| GHL paid subaccounts | GHL usage-billing model decided (D6) |
| Partner data / coin carry-over | partner confirms the contract (`docs/membership/PARTNER-INTEGRATION-REQUEST.md`) and N-4 (provenance rule) |
| Legacy subscriber import | D7 / N-6 classification; legacy versions created from real terms |
| Device-buyer 6-month Standard promotion | modelled as a `promotion` trial; the existing funnel promises (terms shown at purchase) must be listed first |
