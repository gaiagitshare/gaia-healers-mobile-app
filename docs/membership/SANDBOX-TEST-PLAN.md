# Membership provider adapters — sandbox test plan

**Status: NOT RUN. Nothing in this plan may be executed until the approvals in §1
are given in writing.** Everything below has already been exercised offline
against loopback fakes (`membership-service/test/providers-*.test.js`, 43 tests);
this plan is the first contact with real provider sandboxes.

Scope: `membership-service/src/providers/` — Stripe test-mode adapter, GHL
mirror, Gaia Practitioners adapter (contract proposed, not confirmed).

## 1. Who must approve, before anything runs

| Step | Approver | What they approve |
|---|---|---|
| Stripe test mode (§3 A–J) | Babak (owner) | test-mode account access, a **test** restricted key, the request caps in §5 |
| GHL sandbox (§3 K) | Babak + GHL admin | a **sandbox sub-account or test location** (never the live location), a token scoped to contacts only, the custom-field ids |
| Partner sandbox (§3 L–M) | Babak + Gaia Practitioners | the partner confirms the contract (`partner-api.openapi.yaml`) and issues a sandbox host + service token + webhook secret |
| Any repeat run or larger volume | Babak, in advance | AGENTS.md: state planned requests, why, and the cap |

Live mode is out of scope: the Stripe client refuses `sk_live_` / `rk_live_`
keys unless `allowLive: true` is passed, and nothing passes it.

## 2. Prerequisites

- **Stripe**: test-mode access to the Gaia Stripe account (topology question P-Q2
  answered); a test restricted key (`rk_test_…`) and a test webhook secret
  (`whsec_…`). The exact per-scenario permissions, the account decision, where
  the secrets go and the webhook delivery options are in
  [`STRIPE-SANDBOX-ACCESS.md`](STRIPE-SANDBOX-ACCESS.md). Stripe CLI for
  `stripe trigger` / `stripe listen` / `stripe events resend` (test mode only).
- **Database**: a throwaway Postgres (`scripts/test-db.sh up`), migrated, catalog
  seeded (`seedCatalog`); one coin pack set `active` for scenario I only.
- **GHL**: sandbox location id, contacts-scoped token, the five `gaia_membership_*`
  custom fields created by a GHL admin and their ids mapped in `fieldIds`.
- **Partner**: sandbox base URL (https), service token, webhook secret, and a
  sandbox practitioner with ≥2 subscriptions and a coin history spanning ≥2 pages.
- Secrets are injected at run time and never committed, logged or printed.
- Stripe runner: `membership-service/src/cli/stripe-sandbox.js` automates, Stripe side only
  (max requests per scenario, cleanup included):

  | id | covers | max requests |
  |---|---|---|
  | A | initial payment (subscription, 4242) | 8 |
  | B | declined card | 3 |
  | E | refunds (partial, duplicate request, rest) | 6 |
  | H | cancel-at-period-end flag | 9 |
  | I | coin pack one-time charge (no invoice) | 3 |
  | J | reconciliation fetch over the run | 4 |
  | CHECKOUT | hosted checkout session created with Gaia metadata, then expired (paying it needs a browser) | 8 |
  | RENEW | test clock: one period later the renewal invoice is paid | 16 |
  | DUNNING | row D: test clock, `pm_card_chargeCustomerFail` renewal fails → `past_due` → paid with a good card → `active` | 20 |
  | CANCEL_END | test clock: past the period end the subscription is `canceled`, no renewal invoice | 17 |
  | CANCEL_NOW | immediate cancellation | 9 |
  | CHANGE_UP | upgrade: invoice preview, `always_invoice` + `pending_if_incomplete` charged the previewed amount; then a failing card leaves the update pending (item keeps its price) | 17 |
  | CHANGE_DOWN | downgrade at the period end on a test clock: subscription schedule, no proration; the renewal bills the lower price | 20 |
  | CHANGE_SWITCH | monthly → annual scheduled at the period end, then released ("Keep my current plan"): nothing invoiced | 14 |
  | 3DS | row C, Stripe side: `pm_card_authenticationRequired` → subscription `incomplete` | 8 |
  | EVENTS | row G helper: one page (≤ 20) of event ids/types to pick for a resend | 1 |

  Dry run by default, test keys only, hard cap 25 requests per run at the fetch layer
  (`src/providers/request-cap.js`, same contract as `paid-call-guard.mjs`), at most 3 scenarios
  per run (DUNNING runs alone), cleanup of its own objects (test clocks are deleted, which removes
  their customers). Webhook-driven ledger checks need a delivery path and
  `src/cli/staging-webhook-server.js` (STRIPE-SANDBOX-ACCESS.md §5). Still manual: the 3DS browser
  challenge (C), disputes (F), resends (G, via Dashboard or `stripe events resend`), K–N.

## 3. Scenarios (mapped to spec §15 QA gates)

Test cards are Stripe's documented test numbers. Each scenario records: Stripe
object ids, webhook event ids, resulting `subscriptions` / `subscription_events` /
`payment_ledger` rows, and the entitlement evaluation.

| # | §15 gate | Steps | Expected result |
|---|---|---|---|
| A | Initial payment success | `ensureProductAndPrice(standard/month)` → `createCheckoutSession` → pay with `4242…` | one price ref (livemode=false); session metadata has `gaia_person_id` + `gaia_plan_version_id`; after webhooks: subscription `active`, one `invoice/charge` ledger row 4700, entitlements = Standard |
| B | Initial payment failure | checkout with `4000 0000 0000 0002` (declined) | no subscription access (`incomplete` or none); no ledger charge; no entitlements |
| C | 3DS | checkout with `4000 0025 0000 3155`, complete then (second run) abandon the challenge | completed → as A; abandoned → `incomplete`, then `expired`; never access before payment |
| D | Retry / dunning | test clock: subscription on `4000 0000 0000 0341`, advance past renewal | `invoice.payment_failed` → `past_due` with `grace_until`; access until grace end, none after; recovery payment → `active` |
| E | Refund | refund A's charge in the dashboard (partial, then rest) | one `refund` ledger row per refund id, negative amounts; duplicates write nothing |
| F | Dispute | pay with `4000 0000 0000 0259` | `dispute` row (negative); on win, a `dispute_reversal` row |
| G | Duplicate & out-of-order webhooks | `stripe events resend` the A events twice, then replay an older `customer.subscription.updated` after a newer one | one `webhook_events` row per event id; older state ignored (`stale`); ledger unchanged |
| H | Cancel | `cancelPreview` → `cancelAtPeriodEnd` | Stripe `cancel_at_period_end=true`; local `cancel_at` = the previewed date; access until then; GHL shows `cancel-scheduled` |
| I | Coin pack purchase | activate one pack → `createCoinPackCheckout` → pay | one-time session with `gaia_coin_package_key` / `gaia_coins` metadata. **Known gap:** no webhook handler credits coins or records the standalone charge yet, so reconciliation must report `missing_in_ledger` for it — that is the expected alert until the handler exists |
| J | Reconciliation zero-diff | after A–H, `reconcileStripe` over the run window | `mismatch_count = 0` (except the I gap), `complete = true`, a `reconciliation_runs` row; then delete one ledger row in the throwaway DB → exactly one `missing_in_ledger`, alert fired |
| K | GHL sync, duplicates, dead letter | (1) member with one sandbox contact → `syncPersonToGhl`; (2) two sandbox contacts sharing one email; (3) revoke the token mid-run | (1) only `gaia-m:` tags and the five fields change, foreign tags intact; (2) `duplicate_contacts` dead letter, neither contact written or merged; (3) bounded retries then `provider_unavailable` dead letter; a later success resolves it. No GHL payment/subscription route is ever called (client refuses them) |
| L | Partner read | adapter calls for the sandbox practitioner | every response passes `contract.js`; coin history across pages sums to the balance; carry-over split computed, **nothing migrated** |
| M | Partner webhooks | partner sends one of each event type, one duplicate, one with a stale timestamp, one bad signature | stored once each; stale and bad signature → 400; nothing acts on them (no handlers yet) |
| N | Cross-tenant isolation | two persons A, B: (1) B's Stripe customer id in A's checkout webhook; (2) GHL contact already linked to A found by B's email; (3) partner returns a subscription for another practitioner id; (4) a practitioner-owned plan price | (1) identity CONFLICT, never re-keyed; (2) `identity_conflict` dead letter, nothing written; (3) rejected at the boundary; (4) `ensureProductAndPrice` refuses (FORBIDDEN, D5) |

## 4. Exit criteria

All rows above as expected; `wallet_mismatches()` empty; no `webhook_events`
row left `failed`/`dead` except deliberate ones; one reconciliation run with
zero unexplained mismatches; the run log lists every request made.

## 5. Request caps per run (hard limits, enforced by the runner)

| Provider | Scenarios | Max requests per run |
|---|---|---|
| Stripe test mode (API calls by our code) | A–J | **40** (≈ 3 per checkout × 6, cancel 1, reconciliation ≤ 8, setup ≤ 10) |
| Stripe CLI triggers / resends | D, G | **10** |
| GHL sandbox | K | **25** (≈ 4–6 per sync × 4 syncs) |
| Partner sandbox | L, M | **15** reads; webhooks are sent by the partner, ≤ 6 |

One run per approval. A run that would exceed a cap refuses before sending; the
cap is never raised automatically. Stripe test mode and the sandboxes are not
billed, but the caps still apply (AGENTS.md rule 9: no uncontrolled loops).

## 6. Not in this plan

Live keys, real customers, creating products in live mode, migrating customers or
coins, changing legacy pricing or any existing GHL subscription.
