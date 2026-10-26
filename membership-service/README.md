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

## Architecture C: legacy GHL memberships (CRM-only GHL)

Legacy Silver / Gold / Diamond stay billed by GHL (Stripe and PayPal behind GHL)
until a member chooses to migrate; new tiers are sold through direct Stripe
Billing. GHL is the CRM: Gaia writes `gaia-m:` tags and GHL workflows grant or
revoke course offers and community groups from them. All of it is mock-tested
against loopback fakes; nothing calls the live GHL.

| Module | Guarantees (tested) |
|---|---|
| `providers/ghl/legacy-config.js` | GHL price ids per legacy tier (shape of `staging-proxy/membership/config.js`); tier ONLY by price id: mapped / unmapped / ambiguous; status classes live / ended / unknown |
| `providers/ghl/legacy-reader.js` | GET-only reader (`/payments/subscriptions`, `/payments/transactions`, `/products/{id}/price`; any other method or path refused before a request); offset pagination with a hard page cap; one pass upserts `legacy_memberships`: verbatim `reported_status`, provider, amount, interval, `last_payment_at` (newest successful, not fully refunded), `paid_through_estimate`, `person_id` via `person_identities` (ghl, contact); `last_seen_at` = pass time on a COMPLETE pass only; an incomplete pass (cap or error) writes nothing; rows never deleted; `checkLegacyConfig()` reports configured price ids GHL no longer lists |
| `providers/ghl/legacy-rules.js` | `stale_suspected` after interval + grace (configurable) without a successful payment: a review flag only, never canceled / inactive / ended, never an access change; review reasons: `unknown_status`, `unmapped_price`, `ambiguous_price`, `missing_contact`, `contact_rekeyed`, `multiple_live_legacy`, `stale_suspected`, `paypal_no_recent_payment`, `unknown_provider`, `not_seen_in_complete_pass` (re-key and not-seen are sticky until a human marks the row reviewed) |
| `providers/ghl/legacy-report.js` | read-only report: counts by tier, provider, status, mapping; review list; stale suspects; freshness |
| `providers/ghl/desired-state.js`, `sync.js` | `gaia-m:legacy:<tier>` while GHL reports a mapped legacy subscription live (never `gaia-m:tier:*`); an unknown status HOLDS the tag; only `gaia-m:` tags are ever sent (`ahc-*` untouched); order: fields, remove old tags, add new; a half-applied change is a `partial_apply` dead letter and the next run resumes from the contact's current tags |
| `providers/ghl/field-ids.js` | the five `gaia_membership_*` field ids resolved by key (`GET /locations/{id}/customFields`), TTL cache, missing and duplicate keys reported, never created |
| `providers/ghl/grants.js` | entitlement key -> `{ type: offer|community, ghlId, viaTag }` (versioned, empty until GHL admin setup); expected grants recorded on tag changes; `recordGrantConfirmation()` from the Course Access mirror webhooks; `findUnconfirmedGrants()` alerts once per unconfirmed expectation |
| `providers/ghl/reconcile.js` | desired `gaia-m:` tags vs tags on linked contacts: missing / extra, foreign tags counted and ignored; report-only by default, `mode: 'apply'` re-syncs drifted people |

Migration `0005_ghl_legacy_sync.sql` adds `legacy_reader_runs` (append-only),
`ghl_expected_grants`, and the `partial_apply` dead-letter reason.

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
| Legacy GHL reader on a schedule | a token scoped to read payments; first live pass within the 40-GET budget and owner sign-off |
| GHL benefit grants (`BENEFIT_GRANTS`) | GHL admin creates the 5 `gaia_membership_*` fields, the free offers / groups and the tag-triggered Grant/Revoke workflows, and the ahc-* grants are retired per tier |
| Device-buyer 6-month Standard promotion | modelled as a `promotion` trial; the existing funnel promises (terms shown at purchase) must be listed first |
