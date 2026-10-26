# Gaia Healers Membership 2.0: master implementation plan

Gaia Healers Membership 2.0 is being built **in parallel** with production. GHL, Stripe-via-GHL, PayPal, legacy memberships, customer access and the Event Manager keep running unchanged. Activation happens only after a formal **GO / NO-GO**, through the server-enforced launch flag (production default **OFF**).

**Status key:**
- **DONE**: merged-ready PR with tests.
- **IN PROGRESS**: work under way.
- **BLOCKED**: waiting on an external dependency.
- **NEEDS APPROVAL**: waiting on an owner decision.
- **TODO**: not started.

Last updated: 26 Oct 2026.

**Membership PR stack (merge in this order):**
1. #291 foundation
2. #293 internal API + jobs
3. #296 coin packs
4. #295 provider adapters + legacy GHL adapter
5. #298 duplicate-billing guard + migration
6. #299 reconciliation + sandbox runner
7. #300 sandbox lifecycle + webhook receiver
8. #301 safeguards + grant-first + pilot
9. #302 refund reviews, budget ledger, real Standard runner
10. #303 launch flags
11. member gateway (this PR, stacked on #303)

**Separate PRs:** security batch #286–#290, #292, #294 (awaiting deployment approval); #297 GHL webhook secret; #304 branding.

## Phase 1: Backend completion

| Feature | Component | Status | PR | Tests | Evidence / dependencies |
|---|---|---|---|---|---|
| Schema + migrations 0001–0009 (reversible, checksummed) | membership-service/migrations | DONE | #291–#303 | migrations.test | applied on staging 0001–0008; 0009 with #303 |
| Plans + immutable versions (4 tiers, monthly/annual) | plans.js, catalog.js | DONE | #291 | plans, review-regressions | |
| Subscription lifecycle, grace, period bounds | subscriptions.js | DONE | #291 | subscriptions, stripe-webhooks | |
| Entitlements + tenant isolation | entitlements.js, DB trigger | DONE | #291 | entitlements, plans | |
| Coin wallet: buckets, holds, idempotency, no negatives | coins.js | DONE | #291 #293 | coins, api | concurrency test (80 parallel) |
| Internal API (authz, scopes, tenants, audit) | api/server.js, clients.js | DONE | #293 | api | |
| Monthly allowance, stale holds, grace jobs | jobs/ | DONE | #293 | jobs | not scheduled (pre-GO) |
| Coin packs: credit, refund clawback, shortfall review | handlers.js, coins.js | DONE | #296 #302 | coin-packs | |
| Stripe webhooks: signatures, replay, order, dead-letter | stripe/ | DONE | #291 | stripe-webhooks, review-regressions | |
| Stripe Billing adapter: customer, product/price, checkout, cancel | providers/stripe | DONE | #295 | providers-stripe | loopback-tested only until sandbox |
| Daily + coin-pack reconciliation | providers/stripe | DONE | #299 | daily/coinpack reconcile | |
| Duplicate-billing guard (GHL/PayPal/Stripe, any tier) | billing-guard.js | DONE | #298 | billing-migration | |
| Migration offers, verified cancellation, billing gate, sweetener off | migration-offers.js | DONE | #298 #301 | billing-migration, e2e-pilot | |
| Launch flags OFF/PILOT/LIMITED/ALL | launch.js | DONE | #303 | launch-flags | |
| **Real Stripe sandbox validation (Standard $47)** | cli/staging-standard-pilot.js | **BLOCKED / NEEDS APPROVAL** | #302 #303 | runner `plan` ran (15 of 25) | needs `rk_test_` key, `EXPECTED_STRIPE_ACCOUNT_ID`, approval to pull `stripe/stripe-cli:v1.53.1` and run |
| Full sandbox scenarios (14) | cli/stripe-sandbox.js | NEEDS APPROVAL | #300 | 177+ offline | budget increase above 25 needed |
| Staging DB, encrypted off-site backups, monitoring | ops (server) | DONE | n/a | restore test passed 26 Oct | |
| Off-site decrypt-and-restore | key holder | NEEDS APPROVAL | runbook | n/a | private-key holder runs it; key never on the server |

## Phase 2: Customer experience (reuse app shell, auth, design system)

Existing assets to reuse:
- home.html view routing (`data-screen`, gaia-ui.js `showView`);
- the Store › Membership tab (gaia-member.js `membershipCards`, `renderStore`);
- the You screen (`GaiaMembershipUI`);
- the session (`/api/auth/session`, `requireSessionMember`);
- `.g-card` / `.g-btn` / `.g-tabs` and `GaiaNotice`.

| Feature | Component | Status | Dependencies |
|---|---|---|---|
| Member gateway `/api/membership2/*` (session → person, flag-gated, origin-checked; OFF by default) | staging-proxy/membership2-gateway.js + membership-service api/member-routes.js | **DONE** (PR gateway) | real gateway + API + Postgres tests; proxy boot test (404 when off) |
| Staging app stack (staging proxy instance + staging webhook receiver + internal API on loopback) | ops (`/root/audits/membership-staging-stack.md`) | **DONE** 2026-10-26 (API 8792, proxy 8797, app 8798; loopback, fixtures only, no GHL/Stripe) | gateway |
| Plan comparison (4 tiers, monthly/annual) | app, Membership view (`gaia-membership2.js`) | **DONE** (PR view #306) | gateway |
| Checkout (monthly/annual) | app → Stripe Checkout | UI DONE (#306); real redirect waits for the sandbox key | gateway, sandbox |
| Membership dashboard (plan, status, renewal date, access) | app | UI DONE (#306); a live plan not yet shown on staging (no subscriptions) | gateway |
| Coin balance + transaction history | app + member route | **DONE** (#305 + #306) | gateway |
| Coin-pack purchase | app → Stripe Checkout | UI shows "coming soon" until packs exist | pack prices approval (packs are drafts) |
| Upgrade / downgrade | Stripe subscription update + app | TODO | proration decision |
| Billing history + invoices | payment_ledger + Stripe hosted invoice links | history DONE (#306); invoice links with the portal | |
| Payment methods | Stripe Customer Portal session (recommended; card data never touches Gaia Healers) | TODO | portal configuration in Stripe |
| Cancellation (period end, date shown) | adapter `cancelAtPeriodEnd` | **DONE** (UI #306; staging proof needs a subscription) | |
| Legacy status + controlled migration | billing-guard + migration-offers | **DONE** (UI #306, accept proven on staging) | migration targets per tier (decision) |
| Billing support + error handling | app | TODO | support contact decision |

## Phase 3: Administration and finance (Control Center)

| Feature | Status | Dependencies |
|---|---|---|
| Membership 2.0 area in the Control Center (members, subscriptions, plans, payments, invoices, coins, refunds, migrations, reconciliation, audit, system health) | TODO | gateway `/api/admin/membership2/*` |
| Role-based permissions + financial authorization (two roles at least: support, finance) | NEEDS APPROVAL | individual admin identities: the shared admin password must be replaced or supplemented (audit S6) |
| Audit history view | backend DONE (append-only audit_logs), UI TODO | |
| Launch-flag control (view; changes need approval reference) | backend + CLI DONE, UI TODO | |

## Phase 4: Real integrations

| Integration | Status | Notes |
|---|---|---|
| Stripe Billing | adapter DONE; sandbox BLOCKED | account/key decision |
| GHL (CRM, tags, course access) | adapter DONE; legacy import **real, read-only** DONE (34 rows); writes NEED APPROVAL | GHL admin: 5 custom fields, tag workflows, offer ids |
| PayPal (legacy only) | observed through GHL (mirror) DONE; never changed | no direct PayPal API planned |
| Gaia Practitioners | adapter on proposed contract DONE; BLOCKED | partner confirmation and sandbox |
| Data ownership / failure / recovery docs | partial (README, runbooks) | consolidated doc TODO |

## Phase 5: Parallel testing

| Area | Automated | Real |
|---|---|---|
| Tiers × intervals, lifecycle, coins, webhooks, legacy, migration, security | 190 tests (local Postgres; Stripe and GHL loopback) | sandbox pending approval |
| Backup restore | staging restore DONE | off-site decrypt pending key holder |
| Launch + rollback | flag tests DONE; security-batch rollback rehearsal DONE | staging launch drill TODO |
| Manual test plan | TODO | |

## Phase 6: Launch preparation

| Item | Status |
|---|---|
| Server-enforced flags, production OFF, deploy never activates | DONE (#303) |
| Technical readiness report | TODO (end of build) |
| Management presentation + GO / NO-GO record | TODO |

## Phase 7: Brand consistency (whole site)

| Item | Status |
|---|---|
| Audit + classification of "Gaia" occurrences, replacements (English only: no translation files exist) | DONE (#304), owner decisions listed in the PR |
| Automated guard test against regressions | DONE (#304 tests/brand-consistency.test.cjs) |
| Before/after evidence in the readiness report | DONE (#304 docs/BRANDING-AUDIT.md, 12 screenshots) |

## Decisions and access outstanding

1. Stripe: test key (`rk_test_`), account id, approval to pull the CLI image and run the 15-request Standard pilot.
2. Budget above 25 requests for the full sandbox scenarios.
3. Coin-pack prices (packs are drafts; the spec says "indicative").
4. Proration rule for upgrades and downgrades.
5. Migration target per legacy tier; who handles GHL cancellations.
6. Admin roles (support / finance) and individual admin accounts.
7. Partner (Gaia Practitioners) contract and sandbox.
8. GHL admin setup (fields, workflows, offer ids).
9. Security batch deployment approval.
