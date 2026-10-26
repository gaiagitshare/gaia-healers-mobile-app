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
| §9 schema, migrations | `migrations/0001_foundation.sql`, `src/migrate.js` | up/down/up clean; an edited applied migration is refused; advisory-locked |
| §3 tiers | `src/catalog.js`, `src/plans.js` | Free $0; Standard $47/$470; Professional $97/$970; Inner Circle $297/$2,970; 0/500/2,000/4,000 coins; Inner Circle includes every Professional benefit; "Gaia Recommended" badge is Inner Circle only |
| §10, §11 immutable versions | `plans.js` + DB triggers | a published version, its prices and benefits cannot change or be deleted; a price change is a new version; existing subscribers keep theirs; legacy versions are never sold, only imported |
| §10, §17 lifecycle | `src/subscriptions.js` | incomplete → no access; past_due → access until a configurable grace end; terminal states; full event history; older provider state never overwrites newer; click-to-cancel shows the exact end date |
| §16 entitlements | `src/entitlements.js` | union across plans and grants, each benefit once (max, never sum); revocations immediate |
| §4, §9 coins | `src/coins.js` | buckets granted / purchased / legacy; spend order granted → purchased → legacy; monthly reset is a ledger event; idempotency keys (replay returns the first result, a reused key for another request is CONFLICT); 80 concurrent debits never overdraw; hold → capture/release so a failed AI job nets zero; balances always equal transaction sums (`wallet_mismatches()`) |
| §9 payment ledger | `payment_ledger` | append-only, signed integer cents, one row per provider object and entry type |
| §10 webhooks | `src/stripe/*` | Stripe v1 signatures over the raw body, 5-minute tolerance, secret rotation; stored before processing; duplicates stored once; live-mode refused; async processing with retries, backoff, dead-letter and replay; out-of-order safe; unknown prices ignored, never mapped by amount |
| identity | `src/identity.js` | one external id → one person; linking an id owned by someone else is CONFLICT, never a silent re-key |
| partner | `src/partner/*` | contract validators; balances must equal their history; purchases need a payment ref; carry-over split purchased vs legacy; unconfigured adapter fails closed |
| audit | `audit_logs` | append-only; every service write records actor and action |

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
