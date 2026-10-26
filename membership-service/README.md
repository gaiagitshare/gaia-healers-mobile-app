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
## Control Center: operators, roles, two-person rule (Phase 3)

Contract: `docs/membership/CONTROL-CENTER.md`. Migration `0011_operators.sql` adds `operators`,
`operator_sessions`, `admin_action_requests`, `person_notes` (append-only) and the `admin:operate` client scope.

| Module | Guarantees (tested) |
|---|---|
| `src/operators.js` | scrypt passwords (constant-time compare; an unknown email still costs one scrypt); RFC 6238 TOTP (±1 step, a step never accepted twice); TOTP secret AES-256-GCM encrypted with `MEMBERSHIP_OPERATOR_KEY` (32 bytes base64, bound to the operator id); sessions stored as SHA-256, 8 h absolute, 30 min idle; 5 failures lock 15 min; every failure is the same `invalid_login`; disable / role change / TOTP reset revoke sessions; disable cancels the operator's pending requests |
| `src/admin-actions.js` | permission matrix for the 13 action keys; every write is one `admin_action_requests` row keyed by the operator's `requestId` (replay = first result); reason ≥ 10 chars; dual actions: requester ≠ approver (also a DB CHECK), approver role checked, 72 h expiry, one conditional UPDATE so a request executes at most once, failures recorded; Stripe actions without Stripe end `approved_not_executed` (`PROVIDER_UNAVAILABLE`) |
| `src/api/admin-routes.js` | `/v1/admin/*` for an `admin:operate` platform client + `X-Operator-Session`; read models bounded (limit ≤ 200) with keyset cursors; no payloads or secrets in responses or logs |
| `providers/stripe/adapter.js` `refundPayment`, `cancelNow` | test mode only (the client refuses live keys); refund idempotency key `gaia-admin-refund-<request id>`; the refund is booked by the webhook |
| `staging-proxy/membership2-admin-gateway.js` | OFF unless `MEMBERSHIP2_ADMIN=on` + loopback `MEMBERSHIP_SERVICE_URL` + `MEMBERSHIP_ADMIN_SERVICE_TOKEN`; console sign-in (cookie or Event bearer, the admin router's own check) **and** the `gaia_operator` cookie; JSON + origin on writes (`MEMBERSHIP2_ADMIN_ORIGINS`); login rate-limited per IP; the operator token never reaches JavaScript |

Operators (owner only; `MEMBERSHIP_DATABASE_URL` + `MEMBERSHIP_OPERATOR_KEY`):

```bash
node src/cli/operators.js create --email a@example.invalid --name "A" --role support --actor <owner> [--secrets-file <new 0600 file>]
node src/cli/operators.js list|disable|set-role|reset-totp --operator <email|id> [--role r] --actor <owner>
```

`create` and `reset-totp` show the initial password / otpauth URI **once**. The API server reads
`MEMBERSHIP_OPERATOR_KEY` from its environment; without it, operator sign-in answers `PROVIDER_UNAVAILABLE`.

## Duplicate-billing guard and legacy migration (architecture C)

Legacy Silver / Gold / Diamond memberships stay billed by GHL (Stripe or PayPal
behind it) until a member chooses to move. `legacy_memberships` is a read-only
mirror of what GHL reports (filled by the legacy reader in `providers/ghl/`).

- `src/billing-guard.js` `checkoutEligibility()` runs before every new Stripe
  subscription checkout and returns a status, never a side effect:
  `ok`, `already_subscribed`, `change_plan_required` (another Gaia tier),
  `migration_required` (a live GHL membership of any tier),
  or `review_required` (unmapped or ambiguous price, unknown status, no recent
  payment, a needs-review flag, or a legacy mirror that is empty or older than 36 h).
  Unknown is never treated as inactive; only a GHL-reported end clears a row.
  Stripe is not called when the answer is not `ok`.
- `src/migration-offers.js`: offer → accept → `createMigrationCheckoutSession`
  (a trial until the legacy membership is paid through, plus 2 months free;
  an unknown paid-through date means review, never a guess) → Stripe reports the
  subscription (linked by metadata) → staff cancel GHL **by hand** and
  `confirmLegacyCancelled`. `pendingLegacyCancellations()` alerts before the new
  subscription starts billing, and urgently once both could be charging.
  Code never cancels, pauses or edits a GHL / PayPal subscription, price, tag or
  course access.
## Daily reconciliation and the Stripe sandbox runner (not scheduled, not run)

Both scripts can call Stripe, so both carry a hard request cap
(`src/providers/request-cap.js`: the plan is checked against the cap before the
first request and refused above it, never trimmed; the request that would
exceed the cap throws at the fetch layer, retries included). Both default to a
dry run.

| script | default plan | cap | notes |
|---|---|---|---|
| `src/cli/reconcile-daily.js` | 8 requests (4 lists x 2 pages) | 8 (`--max-requests`) | previous UTC day + 6 h backward overlap; `--run` to execute; `STRIPE_RECONCILE_KEY` (test key; live refused unless `--allow-live`), `MEMBERSHIP_DATABASE_URL`; exit 0 clean, 1 mismatches or incomplete fetch, 2 refused, 3 failed |
| `src/cli/stripe-sandbox.js` | per scenario (max, cleanup included): A 8, B 3, E 6, H 9, I 3, J 4, CHECKOUT 8, RENEW 16, DUNNING 20, CANCEL_END 17, CANCEL_NOW 9, CHANGE 12, 3DS 8, EVENTS 1 | 25 per run (`--max-requests`) | Stripe **test mode only** (`STRIPE_TEST_SECRET_KEY` = `sk_test_`/`rk_test_`, anything else refused); `--scenario A[,E,I]` required, at most 3; `--run` to execute; fictional `@example.invalid` customers; deletes its customers and archives its prices/products; prints ids and statuses only ; deletes its test clocks (test-clock scenarios include up to 5 status polls in their count). Credentials and permissions: `docs/membership/STRIPE-SANDBOX-ACCESS.md` |
| `src/cli/staging-webhook-server.js` | 0 Stripe requests (receives only) | processing batch 1..50 (default 10) per interval (default 5 s) | staging Stripe webhook receiver: binds 127.0.0.1 only; refuses a non-loopback `MEMBERSHIP_DATABASE_URL` and a `STRIPE_TEST_WEBHOOK_SECRET` that is not `whsec_…` or looks live; verifies via `ingest.js` (livemode refused), processes with `processPending`; fed by `stripe listen --forward-to` or an approved HTTPS staging location |
| `src/cli/stripe-setup.js` | dry run (0); `--run`: catalog 3 per missing price + 1 per product, webhook 2, portal 2 (25 max) | `--max-requests` required with `--run`, cap = plan, ledger-reserved | plans / ensures the Stripe catalog from the published plan versions, the test webhook endpoint (exactly the 14 handled events) and the Customer Portal (card update, invoices, cancel at period end; plan switching off). Never edits an existing object; the webhook secret goes only to a new 0600 `--secret-file`. See `docs/membership/INTEGRATIONS.md` |
| `src/cli/ghl-setup-report.js` | 0 (no network at all) | n/a | GHL admin spec (5 fields, tags, workflow changes) and a dry-run diff of what Membership 2.0 would write, from the read-only legacy mirror in the database |

**Daily job** (`src/providers/stripe/daily-reconcile.js`): fetches Stripe objects
created from `dayStart - overlap` to `dayEnd`, compares them with
`payment_ledger` (`reconcile.js`), and runs the coin-pack check
`membership.coin_purchase_ledger_mismatches(dayStart, dayEnd)` (migration 0006:
every Stripe `purchase` coin operation has exactly one ledger charge row for the
same charge, and every ledger charge row points at exactly one purchase).
"Missing in Stripe" is judged only for ledger rows dated inside the day and only
when every page was fetched. Every run is a new append-only
`reconciliation_runs` + `reconciliation_daily_runs` row; each mismatch is one
open `reconciliation_alerts` row, so a re-run (or the next day's overlap) bumps
`seen_count` instead of alerting again. `alert()` is pluggable (the CLI writes
one `ALERT {…}` line to stderr: ids, kinds and amounts only) and an alert is
marked notified only after `alert()` returns, so a failed alert is re-sent by
the next run. A person closes an alert with `resolveReconciliationAlert`; if
the mismatch comes back it opens a new one.

**Proposed timer: NOT installed.** Install it only after the owner approves a
production database and a Stripe key. If approved, it would look like this:

```ini
# /etc/systemd/system/gaia-membership-reconcile.service
[Unit]
Description=Gaia membership: daily Stripe reconciliation (previous UTC day)
[Service]
Type=oneshot
WorkingDirectory=/opt/gaia/membership-service
EnvironmentFile=/etc/gaia/membership-reconcile.env   # STRIPE_RECONCILE_KEY, MEMBERSHIP_DATABASE_URL (root-only, 0600)
ExecStart=/usr/bin/node src/cli/reconcile-daily.js --run
# no Restart=: a failed run waits for the next day (exit 1/2/3 shows as failed in systemctl)

# /etc/systemd/system/gaia-membership-reconcile.timer
[Unit]
Description=Daily Stripe reconciliation at 03:15 UTC
[Timer]
OnCalendar=*-*-* 03:15:00 UTC
Persistent=true
RandomizedDelaySec=300
[Install]
WantedBy=timers.target
```

One run a day, at most 8 Stripe requests (the cap), no retry loop beyond
`http.js`'s bounded retries, which count against the same cap.

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
