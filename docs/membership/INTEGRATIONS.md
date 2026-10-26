# Membership 2.0: real integrations (Phase 4)

**Status, 26 Oct 2026: prepared, nothing activated.** No Stripe, GHL, PayPal
or partner call has been made for this phase. Every tool added here defaults
to a dry run, and every live step below needs the owner's approval first.

This page covers four integrations: Stripe Billing, GHL (CRM, tags, custom
fields, course access), PayPal (legacy, observe only) and Gaia Practitioners.
It also covers the Customer Portal and plan-change decision. For each
integration it lists:
- who owns which data;
- the flows;
- failure modes and recovery;
- idempotency keys;
- what is built and tested;
- the credentials and approvals needed;
- the activation checklist;
- rollback.

Related pages:
- [STRIPE-SANDBOX-ACCESS.md](STRIPE-SANDBOX-ACCESS.md): key permissions, account choice, webhook delivery.
- [STANDARD-PILOT-RUNBOOK.md](STANDARD-PILOT-RUNBOOK.md): the first real 15-request sandbox run.
- [PRODUCTION-DATABASE-PLAN.md](PRODUCTION-DATABASE-PLAN.md).
- [CONTROL-CENTER.md](CONTROL-CENTER.md).
- [PARTNER-INTEGRATION-REQUEST.md](PARTNER-INTEGRATION-REQUEST.md).
- `membership-service/README.md`.

**Ground rules that hold for every integration**
- Launch flag: production default is **OFF**. A deploy never activates anything; only an approved stage change does.
- Paid-API rule (AGENTS.md): every script that can call a provider has a hard request cap, defaults to a dry run, and is listed in the guarded-script table.
- Gaia never cancels, pauses or edits a GHL or PayPal subscription, price, tag outside `gaia-m:`, or course grant in code. Staff do those by hand.
- Livemode is refused everywhere (`allowLivemode` / `allowLive` are false in all code). Going live is a reviewed code change plus an approval, never a configuration change.

---

## 1. Stripe Billing (new Membership 2.0 tiers and coin packs)

### 1.1 Data ownership (system of record)

| Data | System of record | Gaia's copy |
|---|---|---|
| Plans, plan versions, prices (amount, interval), benefits, monthly coins | **Gaia** (`plans`, `plan_versions`, `plan_version_prices`; immutable once published) | Stripe Product `gaia_plan_<key>` + Price with lookup key `gaia_<plan>_v<version>_<interval>_<currency>`; ids in `provider_price_refs` |
| Card / payment method data | **Stripe** (never touches Gaia) | none |
| Subscription billing state (status, period start/end, cancel_at, trial end) | **Stripe** | `subscriptions` row, updated only by verified webhooks (older events never overwrite newer) |
| Invoices, charges, refunds, disputes | **Stripe** | append-only `payment_ledger` (one row per object and entry type) |
| Entitlements (access) | **Gaia** (`entitlements.js`, from the subscription state) | none in Stripe |
| Coin wallet (granted / purchased / legacy buckets) | **Gaia** (`coins.js`) | Stripe only knows the coin-pack payment |
| Person ↔ Stripe customer link | **Gaia** (`person_identities`, platform `stripe`, kind `customer`) | `metadata.gaia_person_id` on the customer |

### 1.2 Flows

**New subscription (Checkout)**
1. The member picks a tier in the app. `/api/membership2/*` sends it to the internal API.
2. `createCheckoutSession` runs the duplicate-billing guard first (`billing-guard.js`: a live legacy GHL membership, another Gaia tier, or anything unknown returns a status, and Stripe is not called).
3. The launch flag check runs next (`newBillingAllowed`).
4. Then `ensureProductAndPrice` (0 requests once the price is recorded), `ensureCustomer`, and Checkout Session create, with metadata `gaia_person_id`, `gaia_plan_version_id` and `gaia_plan_version_price_id`.
5. The member pays on Stripe's hosted page.
6. Stripe sends `customer.subscription.created`, then `invoice.paid`.
7. `ingest.js` verifies the signature (5-minute tolerance), stores the event once and returns 200.
8. `processor.js` processes events in provider order. It creates the subscription, books the charge in `payment_ledger`, and the allowance job grants the monthly coins.

**Renewal:** `invoice.paid` creates a ledger row and updates the period through `customer.subscription.updated`.

**Failed renewal:**
1. `invoice.payment_failed` puts the subscription in `past_due`. Access continues until the configurable grace end.
2. Stripe Smart Retries handles the dunning.
3. If the retries fail, `customer.subscription.deleted` ends access.

**Cancel (click-to-cancel):**
1. `cancelAtPeriodEnd` sets `cancel_at_period_end=true`. The member keeps access until the date that is shown.
2. At the period end Stripe sends `customer.subscription.deleted`.

**Immediate cancel and refund (Control Center, two-person rule):**
- `cancelNow` and `refundPayment`: the refund is booked by the `refund.*` and `charge.refunded` webhooks.
- A coin-pack refund claws back the purchased coins (shortfall review).

**Coin pack:**
1. A one-time Checkout runs. `payment_intent.succeeded` credits the coins.
2. Coin packs are **drafts** until the owner approves their prices.

**Migration from legacy:**
1. Offer, then accept, then a Checkout with a trial that lasts until the legacy membership is paid through, plus the sweetener (currently off).
2. Staff cancel GHL by hand, then run `confirmLegacyCancelled`.
3. `pendingLegacyCancellations()` alerts before billing starts.

**Daily reconciliation** (`reconcile-daily.js`, not scheduled):
- It lists the previous day's invoices, charges, refunds and disputes (8 requests).
- It compares them with `payment_ledger` and the coin-pack ledger.
- Each mismatch becomes one open alert.

### 1.3 Failure modes, detection, recovery

| Failure | Detected by | Recovery |
|---|---|---|
| Bad / missing signature, wrong secret | `ingest.js` returns 400; Stripe Dashboard shows failed deliveries | Fix the secret (rotation supports several secrets). Stripe retries a failed delivery for up to 3 days. |
| Duplicate delivery or resend | unique event id in `webhook_events` | stored once, acknowledged (`duplicate: true`) |
| Out-of-order events | `provider_state_at` comparison | an older state never overwrites a newer one; a dependent event that arrives first throws `RetryLater` and is retried |
| Handler error (database, bug) | event `failed`, `attempts` incremented | exponential backoff, up to 8 attempts, then `dead` (the Control Center shows dead letters); `replay()` after the fix |
| Business-rule refusal (for example an illegal transition) | event goes `dead` at once | the money is always booked first; a human decides; `replay()` |
| Unknown price (not a Gaia membership price) | handler returns `ignored` | not mapped by amount or name, ever; this is expected for GHL's own objects in a shared account |
| Live-mode event on a test endpoint | refused at ingest | none needed |
| Webhook endpoint down for a long time | Stripe Dashboard failed deliveries; daily reconciliation finds ledger gaps | resend from the Dashboard / `stripe events resend`; reconciliation alerts |
| Stripe API 429 / 5xx at checkout | `http.js` bounded retries (3, honours `Stripe-Should-Retry`) | the same idempotency key is reused, so a retry never duplicates anything |
| Price in Stripe differs from the plan version | `ensureProductAndPrice` raises `CONFLICT` | never edited; a new plan version gets a new Price |
| Member has a live legacy membership | the billing guard returns `migration_required` / `review_required` | the migration flow; Stripe is not called |
| Legacy mirror older than 36 h | the billing guard returns `review_required` | rerun the read-only legacy import |
| Partial outage between Stripe success and the local write | the webhook is the truth; the local row comes from the event | nothing to do; reconciliation shows any gap |

### 1.4 Idempotency keys (every Stripe POST carries one; never random)

| Operation | Key |
|---|---|
| Customer | `gaia-customer-<person id>` |
| Product | `gaia-product-<plan key>` (also a fixed product id `gaia_plan_<key>`) |
| Price | `gaia-price-<plan version price id>` (plus lookup-key adoption, which accepts only an exact match) |
| Subscription Checkout | `gaia-checkout-<caller request key>` |
| Coin-pack Checkout | `gaia-coinpack-<caller request key>` |
| Cancel at period end | `gaia-cancel-<subscription id>` or the caller's key |
| Migration billing hold | `gaia-billing-hold-<offer id>-<new start>` |
| Control Center refund | `gaia-admin-refund-<admin request id>` |
| Setup: webhook endpoint | `gaia-setup-webhook-<sha256 of the parameters>` (plus a lookup of existing endpoints by URL) |
| Setup: portal configuration | `gaia-setup-portal-<sha256 of the parameters>` (plus a lookup by `metadata.gaia_config`) |
| Incoming webhooks | the Stripe event id, unique in `webhook_events` |

Stripe forgets idempotency keys after about 24 h. For that reason every
create is also preceded by a lookup (product by id, price by lookup key,
endpoint by URL, portal configuration by metadata).

### 1.5 Built and tested (loopback fakes and local Postgres only)

- Adapter, webhook pipeline, handlers, daily and coin-pack reconciliation, duplicate-billing guard, migration offers, launch flags, Control Center refund and cancel: see `membership-service/README.md` and the MASTER-PLAN Phase 1 rows.
- **New:** `src/providers/stripe/setup.js` and `src/cli/stripe-setup.js` plan the account setup:
  - the catalog from the published plan versions;
  - the webhook endpoint with the exact event list of `src/stripe/handlers.js`, 14 events;
  - the Customer Portal configuration.

  Tested in `test/providers-stripe-setup.test.js`:
  - the dry run sends nothing;
  - every `--run` refusal;
  - create, then adopt with no second POST;
  - conflicts are reported and never edited;
  - the webhook secret goes only to a 0600 file;
  - the catalog run against the database records 6 price refs, and a re-run plans 0 requests.
- Not yet proven against real Stripe: everything. The first real run is the 15-request Standard pilot (STANDARD-PILOT-RUNBOOK.md).

**Setup plan at default settings (dry run output):**

```
catalog: 6 prices, 3 products -> 21 requests (max)
  gaia_plan_standard      gaia_standard_v1_month_usd       4700 USD/month
  gaia_plan_standard      gaia_standard_v1_year_usd       47000 USD/year
  gaia_plan_professional  gaia_professional_v1_month_usd   9700 USD/month
  gaia_plan_professional  gaia_professional_v1_year_usd   97000 USD/year
  gaia_plan_inner_circle  gaia_inner_circle_v1_month_usd  29700 USD/month
  gaia_plan_inner_circle  gaia_inner_circle_v1_year_usd  297000 USD/year
webhook: 2 requests (list + create), events:
  customer.subscription.created, .updated, .deleted, .paused, .resumed,
  invoice.paid, invoice.payment_failed, payment_intent.succeeded,
  charge.refunded, refund.created, refund.updated, charge.refund.updated,
  charge.dispute.created, charge.dispute.closed
portal: 2 requests (list + create)
total: 25 (upper bound; retries off)
```

`--run` refuses unless all of these hold:
- the key is a test key;
- `--max-requests` is given and is at least the plan;
- the budget ledger has room for the whole plan, which is reserved before the first request.

The default ledger is the same 25-request ledger as the pilot. After the pilot
(15) only 10 remain, so the setup runs either section by section (`--only`) or
with a **new ledger** approved by the owner. Note that the pilot's `start` step
already creates the Standard monthly product and price on its own (4 of its 6
requests). If the pilot runs first, the catalog section plans 3 fewer requests
for that price.

### 1.6 Credentials and approvals

| Item | Supplied by | Needed for |
|---|---|---|
| Account decision: GHL's account test mode, a Sandbox in it, or a separate account | owner | everything (STRIPE-SANDBOX-ACCESS.md §4) |
| `rk_test_…` restricted key | owner (Dashboard) | runs. For setup add **Webhook Endpoints: Write** and **Customer portal: Write** to the §2 list; Products and Prices Write are already there |
| `EXPECTED_STRIPE_ACCOUNT_ID` (`acct_…`, not a secret) | owner | the pilot account check |
| Webhook delivery path: Stripe CLI, or an HTTPS staging location (nginx change) | owner, plus an nginx approval for the HTTPS option | real webhooks |
| `whsec_…` signing secret | produced by the CLI or by `stripe-setup.js --secret-file` | the receiver |
| Privacy policy, terms of service and return URLs (https) | owner (no such pages exist in the app yet) | the portal configuration |
| Approval of each run, with its request count | owner, in writing | every `--run` |
| Live mode: key, live webhook, `allowLivemode` code change | owner, after the sandbox sign-off and the GO / NO-GO | production |

### 1.7 Activation checklist

| # | Step | Needs approval |
|---|---|---|
| S1 | Owner decides the Stripe account (§1.6) | **yes** (decision) |
| S2 | Owner creates the `rk_test_` key, puts it and `EXPECTED_STRIPE_ACCOUNT_ID` into the staging env file | **yes** |
| S3 | `stripe-setup.js` dry run on the staging database: review the catalog, events and portal | no (sends nothing) |
| S4 | Owner approves the image pull and the 15-request Standard pilot (runbook) | **yes** |
| S5 | Run the pilot: whoami, start, pay, verify, cancel | covered by S4 |
| S6 | `stripe-setup.js --only catalog --run --max-requests N` for the remaining prices (N from the dry run: 18 after the pilot, 21 without it) | **yes** (budget: a new ledger) |
| S7 | Choose the webhook path; for HTTPS, approve the nginx location; then `--only webhook --webhook-url … --secret-file <new> --run --max-requests 2` | **yes** (nginx and run) |
| S8 | Owner gives the privacy, terms and return URLs; `--only portal --run --max-requests 2` | **yes** |
| S9 | Full sandbox scenarios (14; budget above 25) | **yes** (budget) |
| S10 | Install the daily reconciliation timer (README) once a production database exists | **yes** |
| S11 | Live: the reviewed code change for livemode, live key, live catalog sync, live webhook, flag stage `INTERNAL_PILOT` | **yes** (GO / NO-GO) |

### 1.8 Rollback

- **Instant:** set the launch flag to `OFF` (`src/cli/launch.js`, or the Control Center `launch.set`). New Checkouts return `not_available`, and nothing is sent to Stripe. Existing subscriptions keep billing in Stripe, and their webhooks keep being recorded.
- **Webhook endpoint:** disable it in the Dashboard. Events queue at Stripe for up to 3 days, and a resend fills the gap after a re-enable.
- **Catalog:** archive Products and Prices in the Dashboard. Never delete a Price that a subscription uses. The `provider_price_refs` rows stay, and a new plan version gets new Prices.
- **Portal:** delete or deactivate the configuration. Without a portal session the app shows no billing management, and nothing else depends on it.
- **Test data:** `stripe-sandbox.js` cleans up after itself. The pilot member is fictional.
- **Live members, if ever:** cancel at period end from the Control Center (two-person rule). Never bulk-delete subscriptions.

---

## 2. GHL (CRM, tags, custom fields, course access)

### 2.1 Data ownership

| Data | System of record | Notes |
|---|---|---|
| Contacts (name, email, marketing tags) | **GHL** | Gaia links one contact per person (`person_identities` ghl/contact); duplicates are reported, never merged |
| Legacy Silver / Gold / Diamond billing (subscriptions, transactions) | **GHL** (Stripe or PayPal behind it) | read-only mirror `legacy_memberships` (34 rows on staging, 26 Oct) |
| `gaia-m:` tags and the five `gaia_membership_*` fields | **Gaia** (one-way mirror of the entitlement evaluation) | nothing read back from GHL changes Gaia state |
| `ahc-*` and every other tag | **GHL / the existing proxy** | never added or removed by Membership 2.0 |
| Course offers, community groups (granting and revoking) | **GHL executes**, triggered by `gaia-m:benefit:*` tags | `ghl_expected_grants` plus the mirror webhooks confirm it; a confirmation is evidence, never entitlement truth |
| Workflows | **GHL admin** | code never edits a workflow |
| Today's member access (the existing app) | **staging-proxy/membership** (resolver and ledger) | unchanged; Membership 2.0 does not read or write it |

### 2.2 Flows

**Legacy import (read-only, built and run):**
1. `legacy-reader.js` GETs `/payments/subscriptions`, `/payments/transactions` and `/products/{id}/price`, with a hard page cap.
2. One pass upserts `legacy_memberships`. An incomplete pass writes nothing.
3. Tiers are mapped **by price id only**.
4. The rules flag `stale_suspected` and the review reasons.

**Membership state to GHL (`sync.js`, built, never run against GHL):**
1. Evaluate the entitlements, then compute `desiredGhlState`.
2. Find the contact: the linked identity first, otherwise an exact email search. Several matches are a dead letter.
3. Write the fields first, then add the new tags.
4. Remove the old `gaia-m:` tags only once GHL has confirmed the new grants.

**Course access:**
1. A `gaia-m:benefit:<key>` tag is added.
2. A GHL workflow grants the offer, or adds the contact to the group.
3. The mirror webhook posts back, and `recordGrantConfirmation` runs.
4. `findUnconfirmedGrants` alerts on any expectation that GHL never confirmed.

**Drift:** `reconcile.js` compares the desired tags with the contact's tags. It is report-only by default; `apply` re-syncs.

### 2.3 What the GHL admin must create (exact spec)

Generated by `node src/cli/ghl-setup-report.js --spec` (from code, so it cannot drift).

**Custom fields (contact):**
- The resolver matches by key, `contact.<key>`. Create each field with the name below and check that GHL shows exactly that key.
- Create each field **once**. A duplicated key is reported and left unmapped, so nothing is written to it.

| Key | Name | Type | Values written |
|---|---|---|---|
| `gaia_membership_tier` | Gaia Membership Tier | Single line text | `none`, `free`, `standard`, `professional`, `inner_circle` |
| `gaia_membership_status` | Gaia Membership Status | Dropdown (single) | `none`, `trialing`, `active`, `past_due` |
| `gaia_membership_access_until` | Gaia Membership Access Until | Date | `YYYY-MM-DD` or empty |
| `gaia_membership_plans` | Gaia Membership Plans | Single line text | comma-separated plan keys, or empty |
| `gaia_membership_cancel_scheduled` | Gaia Membership Cancel Scheduled | Dropdown (single) | `yes`, `no` |

**Tags Membership 2.0 may write.** All are under `gaia-m:` and lowercase. Nothing else is ever sent.
- `gaia-m:tier:<none|free|standard|professional|inner_circle>`
- `gaia-m:status:<none|trialing|active|past_due>`
- `gaia-m:plan:<plan>`
- `gaia-m:cancel-scheduled`
- `gaia-m:benefit:<key>` for the community, courses, certification, listing, support, perk and crm benefits. Software modules and discounts are deliberately not mirrored. The full list is in the `--spec` output.
- `gaia-m:legacy:<silver|gold|diamond>`, only while GHL reports a mapped legacy subscription live. An unknown status **holds** the tag: it is neither added nor removed.

**Workflow changes (made by the GHL admin, never by code):**

| Id | Change | When |
|---|---|---|
| W1 | For each benefit backed by a course offer: "Tag added `gaia-m:benefit:<key>`" grants the offer; "Tag removed" revokes it | before `BENEFIT_GRANTS` is filled |
| W2 | The same for community groups: add to / remove from the group | before `BENEFIT_GRANTS` is filled |
| W3 | Keep the "Course Access Granted/Removed Mirror" webhooks; add a mirror for group access | with W1/W2 |
| W4 | No workflow may act on `gaia-m:tier:none` or `gaia-m:status:none`: every legacy member carries them. Trigger only on `benefit:*` and `legacy:*` | always |
| W5 | Leave the `ahc-*` grant workflows and the legacy payment workflows unchanged; retire one tier at a time, only after its replacement is confirmed for every member of that tier | later, owner approval per tier |
| W6 | Send the offer and group ids (not secrets) to the developer; they go into `BENEFIT_GRANTS` by a reviewed change | after W1/W2 |

**Offer ids:** the benefit-to-offer map (`BENEFIT_GRANTS`) is empty on purpose. The GHL admin decides which existing offers and groups correspond to `courses.core`, `community.*` and the certification benefits.

### 2.4 Dry-run diff report (read-only)

`node src/cli/ghl-setup-report.js` (with `MEMBERSHIP_DATABASE_URL`, loopback only):
- It reads the **existing read-only legacy import** in the database and runs the same `desiredGhlState` / `diffGhlState` code as the sync.
- The baseline is "no `gaia-m:` tags and no field values in GHL yet". Membership 2.0 has never written to GHL, so every planned change is an addition.
- No GHL token is read and no GHL client exists in that path; a test checks this.
- Contact ids are masked unless `--show-ids` is passed. `--json` gives machine-readable output.
- It reports, per contact:
  - the tags to add and the tags held;
  - the field values;
  - notes for unmapped (unclassified), PayPal, stale-suspected and needs-review rows.
- Totals: contacts, legacy-tagged, held, unclassified live, live PayPal, ended, needs review, and the counts per tag and per field value.

Before the first real write, one approved read-only fetch of the affected contacts replaces the baseline with their current tags.

### 2.5 Failure modes

| Failure | Detected by | Recovery |
|---|---|---|
| Field missing or duplicated in GHL | `field-ids.js` reports `missing` / `duplicates`; those fields are skipped (`unmappedFields`) | the GHL admin fixes the field; the next run writes it |
| Several contacts for one email or person | `duplicate_contacts` dead letter | staff merge in GHL or link the right contact; never guessed |
| Contact deleted or merged (re-keyed) | `contact_missing` dead letter; the legacy rule `contact_rekeyed` (sticky review) | relink |
| GHL error after some writes | `partial_apply` dead letter | the next run recomputes from the current tags and resumes; a later success resolves the dead letter |
| Workflow did not fire (no grant) | `findUnconfirmedGrants` alert; old tags are not removed while grants are pending | fix the workflow; resync |
| Mirror webhook without contactId (15% of deliveries historically) | the confirmation cannot be matched; the expectation stays pending, then alerts | check by hand; fix the merge field in the workflow |
| Tag drift (someone edits tags by hand) | `reconcile.js` report | `mode: 'apply'` re-sync for the drifted people |
| Legacy reader incomplete (cap or error) | `legacy_reader_runs.complete = false`; nothing written | rerun; the guard turns `review_required` after 36 h |
| Rate limit / 5xx | `http.js` bounded retries | dead letter after the retries |

**Idempotency:** GHL has no idempotency keys. The sync is **state-based** instead: each run diffs the desired state against the contact's current tags and fields. Adding a tag that is present, or setting a field to its current value, sends nothing. Expected grants are superseded per contact and target.

### 2.6 Credentials and approvals

| Item | Supplied by | For |
|---|---|---|
| Read-only location token (payments subscriptions and transactions, products and prices, contacts read, custom fields read) | owner / GHL admin; the read path already exists for the legacy import | legacy reader on a schedule, the contact fetch for the real diff |
| Write-scoped token (contacts write: tags, custom field values) | owner / GHL admin | the sync, only after the steps below |
| The five fields, W1–W6, offer and group ids | GHL admin | grants |
| Approval of the first live sync, with a batch size (≤ 200 is the code cap) and a request estimate | owner | first write |

### 2.7 Activation checklist

| # | Step | Needs approval |
|---|---|---|
| G1 | `ghl-setup-report.js --spec` handed to the GHL admin | no |
| G2 | `ghl-setup-report.js` dry-run diff on the staging mirror, reviewed with the owner | no (database read only) |
| G3 | GHL admin creates the five fields | **yes** (GHL change by the admin) |
| G4 | GHL admin builds W1–W3, keeps W4/W5; sends the ids (W6) | **yes** |
| G5 | `BENEFIT_GRANTS` filled by a reviewed PR | **yes** (PR review) |
| G6 | One approved read-only fetch of the field definitions and the pilot contacts (field-id resolve and real tags) | **yes** (small, counted) |
| G7 | First live sync for **pilot members only** (fictional or staff contacts), then confirm the grants arrived | **yes** |
| G8 | Legacy reader on a schedule (read-only) | **yes** |
| G9 | Wider sync with the launch stage | **yes** (GO / NO-GO) |
| G10 | Retire `ahc-*` grants, one tier at a time | **yes**, per tier |

### 2.8 Rollback

- Stop the sync: it is not scheduled, so stop running it. Set the launch flag to `OFF`.
- To undo tags, remove the `gaia-m:` tags in GHL (bulk action by tag). The W1/W2 "tag removed" workflows then revoke the offers they granted, so do this only for tags whose access should actually end. To keep access, disable W1/W2 first, then remove the tags.
- The fields are informational; clearing them changes no access unless a workflow uses them (W4 forbids that for access).
- `ahc-*` grants were never touched, so legacy access is unaffected throughout.

---

## 3. PayPal (legacy only, observe only)

**There is no PayPal integration, and none is planned.**
- PayPal appears only as the payment provider behind some legacy GHL subscriptions (`I-…` billing agreements).
- Gaia sees them only through the GHL read-only mirror (`payment_provider = 'paypal'`).
- No PayPal API key exists, no code calls PayPal, and nothing ever changes a PayPal subscription.
- PayPal mandates cannot be moved to Stripe. A member migrates only by checking out again, with the trial until paid-through, and staff then cancel the PayPal one by hand.

**What stays unchanged until classified**
- **Flagged PayPal subscriptions:** live-reported PayPal rows without a recent payment carry `stale_suspected` / `paypal_no_recent_payment`.
  - This is a **review flag only**: the row stays live, the `gaia-m:legacy:<tier>` tag is still written while GHL reports it live, and the duplicate-billing guard treats the person as possibly paying, so they get `review_required`, never a second subscription.
  - Nothing cancels or ends the row; only a GHL-reported end clears it.
- **The five "CRM" subscriptions:** the live "Gaia Healers CRM" / Next Level subscriptions (Stripe and PayPal) do not carry a mapped tier price id.
  - They are `unmapped`: no tier, no legacy tag, no migration offer, and `review_required` at checkout.
  - They stay exactly as they are until the owner classifies them (decision N-6).

**Classification worksheet.** One row per flagged or unmapped subscription. Use `ghl-setup-report.js --json`, or `legacyReport()`, as the source; contact ids stay internal.

| Column | Meaning |
|---|---|
| `external_subscription_id` | GHL subscription id (PayPal `I-…` or Stripe `sub_…`) |
| `contact_ref` | masked contact id (full id only in the private copy) |
| `payment_provider` | paypal / stripe / manual |
| `product_name` / `external_price_id` | as GHL reports them |
| `amount` / `interval` | as reported |
| `reported_status` | verbatim GHL status |
| `last_payment_at` | newest successful payment Gaia saw |
| `paid_through_estimate` | last payment + one interval |
| `flags` | stale_suspected, review reasons |
| `verified_in_paypal` | yes / no, date, by whom (someone with PayPal access checks the agreement is really still billing) |
| `classification` | `silver` / `gold` / `diamond` legacy tier, `crm_legacy` (its own legacy plan), `practitioner_software`, `out_of_scope`, or `ended` |
| `target_plan_on_migration` | the Membership 2.0 tier offered, if any |
| `action` | none / offer migration / staff cancel in GHL (manual) / contact member |
| `decided_by`, `decided_at`, `note` | owner sign-off |

A classified row changes only through a reviewed change: a legacy price id added to `legacy-config.js`, or a legacy plan version created from the real terms. A classification never directly ends a subscription.

**Activation:** none. Steps P1–P2 need people, not code:
- P1: someone with PayPal access verifies the flagged agreements (**yes**, owner arranges);
- P2: the owner classifies each row (**yes**).

**Rollback:** not applicable; nothing is changed.

---

## 4. Gaia Practitioners (partner)

### 4.1 Contract status: proposed, not confirmed

- Shapes: [partner-api.openapi.yaml](partner-api.openapi.yaml) and [PARTNER-INTEGRATION-REQUEST.md](PARTNER-INTEGRATION-REQUEST.md).
- Code: `src/providers/practitioners/adapter.js` (`CONTRACT_STATUS = 'proposed-not-confirmed'`), `webhooks.js`, and `src/partner/contract.js` (the validators).
- The default adapter is `unavailableAdapter`, which fails closed with `PROVIDER_UNAVAILABLE`.
- Read-only: GET only, service token, bounded cursor pagination, every response validated.

### 4.2 Data ownership

| Data | System of record |
|---|---|
| Practitioner accounts, status, their ~30 paid subscriptions and billing | **Partner** (merchant of record to be confirmed) |
| Practitioner coin balances and history | **Partner**, until a carry-over is approved (N-4) |
| Module entitlements for partner-billed subscriptions | **Partner** |
| Entitlements for Gaia-billed tiers | **Gaia** (`GET /v1/me/entitlements` offered to the partner) |
| Account link (practitioner ↔ person) | **Gaia** `person_identities` (`gaia_practitioners` / `practitioner_account`), from the existing OAuth link |

### 4.3 Flows (proposed)

1. Read the practitioner, then their subscriptions, coins (balance plus full history) and entitlements, all through the service token.
2. Signed webhooks (`subscription.updated`, `coins.changed`, `practitioner.status_changed`) are verified like Stripe's: HMAC over the raw body, 5-minute tolerance, unique event id.
3. They are stored, then processed by `processPending(provider: 'partner')`. An event triggers a fresh read; it is never taken as the truth itself.
4. Before any migration, a sandbox or anonymised export proves that each balance equals the sum of its history and splits purchased from granted coins.

### 4.4 What the partner must confirm

1. Merchant of record, processor/account, and who handles refunds, disputes and chargebacks.
2. The stable account id, multiple accounts per person, and the meaning of `pending`.
3. Coin model: where balances live, whether there is a full ledger, whether balances can go negative, and how failed jobs are refunded.
4. The module list, prices and access rules.
5. The endpoints, envelope (`{ data, next_cursor }`), field names, enums (`status`, `billing_owner`, coin `source`) and units (integer cents, integer coins, ISO-8601 UTC).
6. The webhook signature scheme (`Gaia-Partner-Signature: t=…,v1=…`), event ids, retries, or polling instead.
7. Rate limits, the sandbox base URL, how the service token is issued and rotated.
8. A sandbox or anonymised export for the carry-over check.

### 4.5 Contract-test checklist (run against their sandbox once it exists)

Run with a sandbox token, a request cap of at most 5 per run, fictional accounts only, and output limited to shapes and counts. Add the runner to the AGENTS.md table before the first run.

| # | Check | Pass when |
|---|---|---|
| C1 | `GET /v1/practitioners/{id}` for a known sandbox id | passes `validatePractitionerIdentity`; status in the enum |
| C2 | unknown id | 404 with an error envelope, not 200/empty |
| C3 | missing or invalid token | 401; no data |
| C4 | subscriptions list | each item passes `validateSubscription`; cents integer; `billing_owner` in enum |
| C5 | pagination | `next_cursor` advances and ends with `null`; a repeated cursor is refused by the adapter |
| C6 | coins | `validateCoinLedger`: balance equals the sum of the transactions; every purchase has a `payment_ref` |
| C7 | entitlements | each item passes `validateModuleEntitlement` |
| C8 | write methods | POST/PUT/DELETE refused (the adapter never sends them; the partner returns 405) |
| C9 | webhook signature | a delivered sandbox event verifies; a tampered body, a stale timestamp and a wrong secret are each refused |
| C10 | webhook duplicate | same event id delivered twice, stored once |
| C11 | webhook event types | only the three types; an unknown type gets a 400 |
| C12 | rate limit | the 429 response carries `Retry-After`; the adapter's bounded retry respects it |
| C13 | export | carry-over classification runs: purchased vs granted totals reported, no mismatches |
| C14 | partner OpenAPI | the served spec (if any) matches `partner-api.openapi.yaml` (`providers-openapi.test.js` shapes) |

### 4.6 Credentials, activation, rollback

| # | Step | Needs approval |
|---|---|---|
| R1 | Partner answers §4.4; the contract is updated, and `CONTRACT_STATUS` changes by a reviewed PR | **yes** (both owners) |
| R2 | Partner issues a sandbox base URL and service token (stored in the staging env file, never printed) | **yes** (partner) |
| R3 | Contract tests C1–C14 against the sandbox, capped | **yes** (per run) |
| R4 | Sandbox export, carry-over rule N-4 decided | **yes** (both owners) |
| R5 | Configure the HTTP adapter in staging (read-only) | **yes** |
| R6 | Production token and webhooks | **yes** (GO / NO-GO) |

Rollback: switch back to `unavailableAdapter` (removing the configuration is enough; it fails closed). Disable the webhook at the partner. No partner data is ever written, so there is nothing to undo there.

---

## 5. Cross-integration: Customer Portal and plan changes

**Portal: prepared, not created.** `stripe-setup.js --only portal` plans one configuration:

| Feature | Setting | Why |
|---|---|---|
| Payment method update | ON | card data never touches Gaia |
| Invoice history | ON | hosted invoices and receipts |
| Cancel | ON, **at period end** | matches click-to-cancel and the access-until rule |
| Customer details update | OFF | email and name are Gaia identity data; changing them in Stripe would desync |
| Plan switching (`subscription_update`) | **OFF** | until the proration decision below |

Nothing in the app creates portal sessions yet. That step (`POST /v1/billing_portal/sessions` with the configuration id, behind the launch flag) is a later change.

## 6. Owner decision: proration on upgrade and downgrade

**DECIDED 2026-10-26 (owner): the recommendation below is adopted.** Upgrades use `always_invoice` with `pending_if_incomplete`, and the higher tier is granted only after payment. Downgrades and annual/monthly switches happen at period end, with no proration and no refund. Not implemented yet; plan switching stays off until it is built and tested.

Today the code always uses `proration_behavior: 'none'` (the sandbox CHANGE scenario and migration holds). The portal keeps plan switching off.

| Option | What the member sees | For | Against |
|---|---|---|---|
| `none` | The new price applies from the next renewal. No charge or credit now. | simplest; no surprise invoices; matches the current code | an upgrade gives the higher tier's access immediately for the old price until renewal (up to 11 months on annual); a downgrade keeps the higher price until renewal |
| `create_prorations` | The difference is added to the **next** invoice (credit for unused time, charge for the new plan's remainder) | fair; no extra charge mid-cycle | access is granted before payment; the next invoice is larger and confusing; a failed next invoice must be handled |
| `always_invoice` | The prorated difference is **invoiced and charged immediately** | pay before access; clean audit trail per change; fewest grant-before-payment risks | a mid-cycle charge can fail (3DS, decline) and needs a "payment required" state; small charges and receipts |

**Recommendation (adopted 2026-10-26):**
- **Upgrades:** `always_invoice`, with `payment_behavior=pending_if_incomplete`, so the higher tier (and its coins) is granted only after the prorated charge succeeds.
- **Downgrades:** take effect **at period end**, with no refund and no proration. A subscription schedule, or a Gaia-side scheduled change, switches the price at renewal, and the member keeps the paid tier until then.
- **Annual ↔ monthly switches:** handled as a downgrade, at period end.

This needs a small adapter change and the CHANGE sandbox scenario re-run before the portal's plan switching is turned on. Until the owner decides, plan switching stays off and changes go through support.

## 7. Activation summary (which approval unlocks what)

| Approval | Unlocks |
|---|---|
| Stripe account decision, `rk_test_` key, account id | S3 dry run against real data; prerequisite for every Stripe step |
| Image pull + 15-request pilot | S4–S5: first real Stripe test-mode proof |
| New Stripe request budget (ledger) | S6 catalog, S9 full scenarios |
| Webhook path (+ nginx for HTTPS) | S7 permanent test webhook endpoint |
| Privacy, terms and return URLs | S8 portal configuration |
| Proration rule | plan switching in the portal and app (§6) |
| GHL admin setup (fields, W1–W6, ids) | G3–G5 |
| GHL read fetch, then pilot sync | G6–G7 |
| PayPal verification, classification | the flagged PayPal and CRM rows can be offered migration or closed |
| Partner contract + sandbox | R1–R5 |
| GO / NO-GO | live mode for any of the above |

## 8. Open owner decisions (Phase 4)

1. Stripe account (GHL's test mode, a Sandbox, or a separate account) and the key.
2. Webhook delivery path for staging (CLI only, or an HTTPS location with an nginx change).
3. New Stripe request budget for setup and the full scenarios (the current ledger is 25, with 15 booked for the pilot).
4. Privacy policy, terms of service and portal return URLs (the pages do not exist yet).
5. Proration rule (§6).
6. Which GHL offers and groups implement which benefits; who performs the GHL admin setup.
7. Classification of the flagged PayPal subscriptions and the five CRM subscriptions (N-6).
8. Partner contract answers and carry-over rule (N-4).
9. Whether customers may edit their email and name in the portal (currently off).
10. Whether the portal collects a cancellation reason (currently off).
