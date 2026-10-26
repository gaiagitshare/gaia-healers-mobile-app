# Gaia Healers Membership 2.0: parallel-system test matrix (Phase 5)

Status as of **26 Oct 2026**. Membership 2.0 is built next to production. GHL, Stripe-via-GHL, PayPal, legacy memberships, customer access and the Event Manager keep running unchanged. This matrix lists every area and scenario, says how each one is proven, and gives its current status.

**Run everything:** `scripts/membership-test-all.sh [--branches] <summary.json>`. This uses a throwaway loopback Postgres and makes no network calls beyond loopback. The latest run is in [drills/2026-10-26-test-run.md](drills/2026-10-26-test-run.md).

## Legend

**Test references**
- `MS` = `membership-service/test/`
- `SP` = `staging-proxy/test/`
- `FE` = `tests/` (frontend, `node --test tests/*.test.cjs`)
- `VIEW` = `tests/membership2-view.test.cjs`, the member view (#306). It has been in this stack since the restack (85c10f3) and runs in the frontend suite. `--branches` still runs the view branch on its own.

**Environments**
- **LPG**: local throwaway Postgres (the runner). Stripe and GHL are loopback fakes or not connected.
- **UNIT**: no database.
- **STG**: the staging stack on loopback. API 8792, proxy 8797, app 8798, Control Center 8799, staging DB. Fixture members only.
- **SBX**: Stripe sandbox (test mode).
- **GHL**: live GHL.

**Status**
- **PASS**: proven by a test or a drill on the date shown.
- **FAIL**
- **BLOCKED**: waiting on the named approval (see the [approvals](#approvals-that-unblock-rows) list).
- **TODO**: not built yet or not proven yet.

**Evidence**
- `run`: [drills/2026-10-26-test-run.md](drills/2026-10-26-test-run.md)
- `cc-ev`: [control-center-evidence/](control-center-evidence/)
- `view-ev`: `docs/membership/view-evidence/` on #306
- Drill files are in [drills/](drills/).

## Approvals that unblock rows

| Key | Approval or dependency (owner) | Unblocks |
|---|---|---|
| **A1** | Stripe sandbox: an `rk_test_` key and `EXPECTED_STRIPE_ACCOUNT_ID` in the staging env, plus approval to pull `stripe/stripe-cli:v1.53.1` and run the 15-request Standard pilot ([STANDARD-PILOT-RUNBOOK.md](STANDARD-PILOT-RUNBOOK.md)) | the real checkout redirect, renewal, cancellation and webhooks on staging |
| **A2** | A budget above 25 Stripe test-mode requests for the full sandbox scenarios (`cli/stripe-sandbox.js`) | renewals, dunning, 3DS, plan change and refunds against real Stripe |
| **A3** | GHL admin setup (5 `gaia_membership_*` fields, tag workflows, offer ids) and approval for GHL writes | real tags, course grants and the CRM sync |
| **A4** | The backup private-key holder runs the off-site decrypt-and-restore on their own machine. The key never comes to the server. | the off-site recovery proof |
| **A5** | Coin-pack prices (packs are drafts) | real coin-pack checkout |
| **A6** | ~~The proration rule~~ decided 26 Oct (INTEGRATIONS.md); the change-plan API is not built yet | (CP-CHG-01 is now TODO) |
| **A7** | Approval to deploy the security batch (#286–#290, #292, #294) | the live CSRF, rate-limit and session hardening on production |
| **A9** | Gaia Practitioners: partner contract confirmation and a sandbox | PERM-PART-02 |

## Customer portal (member view)

| ID | Scenario | Expected result | Automated test / procedure | Env | Status | Evidence |
|---|---|---|---|---|---|---|
| CP-PLAN-01 | Plans are public; other routes need a session | `GET /plans` 200 with 4 tiers at the decided prices and coins; `/me` 401 | MS member-gateway › plans are public; everything else needs the member session | LPG | PASS | run |
| CP-PLAN-02 | Catalogue values come from the API only | no prices, coins or tier names in the view source | VIEW › no hard-coded prices…; › no tier names or tier logic…; SP membership-frontend-guard (APP_FILES) | UNIT | PASS | run |
| CP-PLAN-03 | Monthly/annual toggle, "N months free" derived from the API | yearly prices shown, figure computed from `prices` | manual: staging app `?view=membership`, screenshots 01–03 | STG | PASS (26 Oct) | view-ev |
| CP-PLAN-04 | Catalogue rules (4 tiers, immutable versions, legacy never sold) | see the tests | MS plans › all 4 tests | LPG | PASS | run |
| CP-CHK-01 | Pilot member starts checkout, Stripe not connected | 503 `PROVIDER_UNAVAILABLE`; the same requestId gives the same answer; no Stripe customer created | MS e2e-parallel-flows › pilot member reaches the billing step…; MS member-gateway › coin and billing history… | LPG | PASS | run |
| CP-CHK-02 | Pilot member on staging sees "Billing isn't connected" | real POST answers 503; Try again re-sends the same requestId | manual: staging screenshots 06/07 | STG | PASS (26 Oct) | view-ev |
| CP-CHK-03 | Non-pilot member at INTERNAL_PILOT | `/me availability.newMembership=false` (`pilot_only`); checkout 200 `not_available`/`pilot_only`; the view sends no POST | MS e2e-parallel-flows › non-pilot member at INTERNAL_PILOT…; staging screenshot 04 | LPG, STG | PASS | run, view-ev |
| CP-CHK-04 | Real checkout redirect to Stripe and return `?checkout=done` | Stripe Checkout URL (https), return toast, subscription active | `cli/staging-standard-pilot.js start/verify` | SBX | BLOCKED (A1) | |
| CP-CHK-05 | Every write sends a requestId and keeps it for a retry | one `postJson()`, `m2-` + UUID, same id after a 5xx | VIEW › every write is a JSON POST with credentials and a requestId… | UNIT | PASS | run |
| CP-CHK-06 | Return URLs only on allowed origins (no open redirect) | `INVALID_INPUT` for other origins | MS providers-stripe › checkout session carries Gaia metadata…; `member-routes.js checkReturnUrl` | LPG | PASS | run |
| CP-DASH-01 | Signed-in member: account created once, overview with availability | one person; contact and email linked once | MS member-gateway › signed-in member: account is created once… | LPG | PASS | run |
| CP-DASH-02 | Dashboard with a live plan (status, renewal date, access) | plan card from `/me membership[]` | manual on staging after A1 (staging has no subscriptions) | STG/SBX | BLOCKED (A1) | |
| CP-COIN-01 | Coin balance and history | `/me wallet`, `/me/coins` items with net per bucket | MS member-gateway › coin and billing history…; staging screenshot 01 | LPG, STG | PASS | run, view-ev |
| CP-PACK-01 | No active packs: "Coin packs are coming soon" | `coinPacks: []` | MS member-gateway › plans are public…; staging screenshot 01 | LPG, STG | PASS | run, view-ev |
| CP-PACK-02 | Coin-pack checkout | Stripe one-time payment with coin metadata | MS providers-stripe › coin pack checkout…; real run needs prices | SBX | BLOCKED (A5, A1) | |
| CP-BILL-01 | Billing history; no card fields | `/me/billing` items; "managed securely by Stripe" note | MS member-gateway › coin and billing history…; VIEW › no card-entry fields… | LPG, UNIT | PASS | run |
| CP-BILL-02 | Invoices and payment methods (Customer Portal) | portal link | not built | | TODO (portal approval) | |
| CP-CAN-01 | Cancel at period end with the exact date | preview shows `accessEndsAt`; access kept until then | MS subscriptions › click-to-cancel shows the exact access-end date…; MS providers-stripe › cancelAtPeriodEnd… | LPG | PASS | run |
| CP-CAN-02 | A member can only touch their own subscription | someone else's id is 404 | MS member-gateway › coin and billing history, and a member can only touch their own subscription | LPG | PASS | run |
| CP-CAN-03 | Real cancellation on staging | `cancel_at` from Stripe, banner | `staging-standard-pilot.js cancel` | SBX | BLOCKED (A1) | |
| CP-LEG-01 | A legacy Silver member sees no buy button and gets `migration_required` | `legacy[]` state `active`; checkout `migration_required` at every stage, pilot or not; Stripe never reached | MS e2e-parallel-flows › legacy Silver member…; MS member-gateway › legacy members are shown their legacy membership…; VIEW › legacy members never get a buy button…; staging screenshot 08 | LPG, STG | PASS | run, view-ev |
| CP-LEG-02 | Legacy row under review | state `under_review`; checkout `review_required` | MS e2e-parallel-flows › legacy member under review… | LPG | PASS | run |
| CP-LEG-03 | Accept a migration offer, then continue to checkout | accept 200 `accepted`; checkout 503 without Stripe | staging screenshot 09 | STG | PASS (26 Oct) | view-ev |
| CP-ERR-01 | Plain-language copy for every server answer | every status has copy | VIEW › every server answer has plain-language copy | UNIT | PASS | run |
| CP-ERR-02 | Membership service down | gateway 503 `PROVIDER_UNAVAILABLE` within 2 s (refused) or within the 8 s bound (silent); the app shows its error state | MS e2e-parallel-flows › membership service down…; drill (d) | LPG, STG | PASS | run, [service-down](drills/2026-10-26-service-down.md) |
| CP-ERR-03 | Visitor (no session) | plans and a Sign in prompt, no 401 noise | manual staging run (26 Oct) | STG | PASS (26 Oct) | view-ev |
| CP-OFF-01 | Gateway OFF: every `/api/membership2/*` is 404 | falls through; the service is never touched | MS member-gateway › gateway OFF…; SP membership2-gateway-off › every membership2 path is a plain 404… | LPG, UNIT | PASS | run |
| CP-OFF-02 | Gateway OFF: the app hides the area | `?view=membership` lands on Store; entry slots hidden; only the probe request | VIEW › hidden unless the feature probe succeeds…; drill (c) | UNIT, STG | PASS | run, [kill-switch](drills/2026-10-26-gateway-kill-switch.md) |
| CP-OFF-03 | The view adds no assistant prompt tokens | not in `GaiaAssistGuide.screens` | VIEW › the view is not in the assistant screen map… | UNIT | PASS | run |
| CP-A11Y-01 | Accessibility basics | live region, labelled sections, focus, `aria-pressed` | VIEW › accessibility basics… | UNIT | PASS | run |
| CP-CHG-01 | Upgrade or downgrade | upgrade `always_invoice` + `pending_if_incomplete`, the higher tier only after payment; downgrades at period end, no refund (owner decision 26 Oct) | not built (the view explains that Support handles it) | | TODO (implement the decided rule) | INTEGRATIONS.md |

## Administration (Control Center)

| ID | Scenario | Expected result | Automated test / procedure | Env | Status | Evidence |
|---|---|---|---|---|---|---|
| AD-OP-01 | Operators are created by the owner only (CLI), audited | create, disable, set-role, reset-totp audited; sessions revoked on a change | MS admin › operator management (CLI functions)… | LPG | PASS | run |
| AD-SIGN-01 | Crypto primitives | RFC 6238 vector, scrypt, AES-GCM bound to the operator id | MS admin › crypto primitives… | UNIT/LPG | PASS | run |
| AD-SIGN-02 | TOTP window and replay | ±1 step; a used step is never accepted again | MS admin › TOTP window… | LPG | PASS | run |
| AD-SIGN-03 | Uniform failure | every failure is `invalid_login` | MS admin › sign-in: uniform invalid_login…; FE control-center-membership2 › sign-in: generic error… | LPG, UNIT | PASS | run |
| AD-LOCK-01 | Lockout | 5 failures lock 15 min; the UI shows the lockout on 429 | MS admin › sign-in…lockout…; FE control-center-membership2 › sign-in: generic error on failure, lockout on 429 | LPG | PASS | run |
| AD-SESS-01 | Session limits | 30 min idle, 8 h absolute, logout revokes, a disabled operator is signed out | MS admin › sessions… | LPG | PASS | run |
| AD-PWD-01 | First-login password change required | restricted session until changed; `password_change_required`; still audited and rate-limited | MS admin-phase3 › initial password must be changed…; › login: the session of an operator who must change the password…; MS admin-gateway › first sign-in through the gateway…; FE control-center-membership2 › first sign-in: a must-change-password session… | LPG, UNIT | PASS | run, cc-ev |
| AD-RBAC-01 | Every action × every role matches the contract | matrix in CONTROL-CENTER.md §2 | MS admin › RBAC: every action, every role… | LPG | PASS | run |
| AD-RBAC-02 | Admin routes need an `admin:operate` client | member clients refused | MS admin › the admin routes need an admin:operate client… | LPG | PASS | run |
| AD-RBAC-03 | The UI draws only permitted actions; launch is read-only unless owner | | FE control-center-membership2 › only actions in /me.permissions are drawn; › launch is read-only unless owner… | UNIT | PASS | run |
| AD-DUAL-01 | Two-person rule | self-approval and the wrong role refused; a second operator executes exactly once | MS admin › two-person rule: self-approval refused…; MS admin-gateway › dual approval end to end through the gateway… | LPG | PASS | run |
| AD-DUAL-02 | Expiry and disabled people | 72 h expiry; a disabled approver is refused; a disabled requester's pending requests are cancelled | MS admin › two-person rule: expiry after 72 h… | LPG | PASS | run |
| AD-DUAL-03 | The UI shows own requests as waiting | | FE control-center-membership2 › own requests wait for a second approver… | UNIT | PASS | run |
| AD-EXEC-01 | Direct action, replay | executes once; a replay returns the first result; the audit names the operator | MS admin › direct actions: support goodwill <= 500 executes once… | LPG | PASS | run |
| AD-EXEC-02 | Stripe actions without Stripe | `approved_not_executed`/`PROVIDER_UNAVAILABLE`, never faked, never re-executed | MS admin › Stripe actions without Stripe…; FE control-center-membership2 › PROVIDER_UNAVAILABLE (503) is a final answer… | LPG, UNIT | PASS | run |
| AD-EXEC-03 | Stripe actions with a test-mode client | refund and immediate cancel call the adapter once | MS admin › Stripe actions with a (test-mode) Stripe client… (fake) | LPG | PASS | run |
| AD-EXEC-04 | Real refund or immediate cancel against Stripe | refund booked by the webhook | staging after A1 | SBX | BLOCKED (A1) | |
| AD-EXEC-06 | Explicit execute / retry | approve is not execute; explicit retry only; replay returns the first result; executed is final (409); no background retry | MS admin-phase3 › execute / retry… | LPG | PASS | run |
| AD-EXEC-05 | UI retry semantics | a network error or 5xx reuses the requestId; a 4xx starts a new one | FE control-center-membership2 › network error and 5xx reuse the same requestId and body… | UNIT | PASS | run |
| AD-AUD-01 | Audit is append-only; every write is audited | UPDATE/DELETE refused | MS migrations › ledgers and the audit log are append-only; MS admin › direct actions… | LPG | PASS | run |
| AD-AUD-02 | Every admin audit row carries its reason; read models name people, not ids | | MS admin-phase3 › every admin audit row carries its reason…; FE control-center-membership2 › names, not ids… | LPG, UNIT | PASS | run |
| AD-READ-01 | Read models are bounded and paginated; health and overview answer | limit ≤ 200, cursors | MS admin › read models are bounded and paginated… | LPG | PASS | run |
| AD-LAUNCH-01 | Launch above INTERNAL_PILOT from the Control Center | owner requests, a second owner approves, the ceiling still caps it | MS admin › launch stage above INTERNAL_PILOT… | LPG | PASS | run |
| AD-GW-01 | Admin gateway OFF | every `/api/admin/membership2*` path is 404, signed in or not | SP membership2-admin-gateway-off; MS admin-gateway › admin gateway OFF…; drill (c) | UNIT, STG | PASS | run, [kill-switch](drills/2026-10-26-gateway-kill-switch.md) |
| AD-GW-02 | Admin gateway ON | console sign-in **and** operator cookie; status probe; token never in the body | SP membership2-admin-gateway-on (2 tests); MS admin-gateway › status probe, login cookie… | UNIT, LPG | PASS | run |
| AD-UI-01 | Probe-gated area | probe 404/401/network error hides it; nothing else requested | FE control-center-membership2 › probe 404 → hidden…; › probe 401… | UNIT | PASS | run |
| AD-UI-03 | Environment banner, money-source badges, accessible sidebar | the banner comes from the server; nothing is guessed | FE control-center-membership2 › STAGING / TEST MODE banner…; › money source badges…; › sidebar: real buttons… | UNIT | PASS | run |
| AD-UI-02 | Staging Control Center walkthrough | sign-in, overview, requests, launch | staging run (26 Oct) | STG | PASS (26 Oct) | cc-ev |

## Payments

| ID | Scenario | Expected result | Automated test / procedure | Env | Status | Evidence |
|---|---|---|---|---|---|---|
| PAY-CHK-01 | Checkout session content | Gaia metadata; legacy, duplicate-plan and bad input refused | MS providers-stripe › checkout session carries Gaia metadata… | LPG | PASS | run |
| PAY-CHK-02 | Customer, product and price creation | idempotent, `livemode=false`, never edited | MS providers-stripe › ensureCustomer…; › ensureProductAndPrice… (2) | LPG | PASS | run |
| PAY-CHK-03 | Standard $47 end to end on the sandbox | active, $47 charge, 500 coins, entitlements, 0 mismatches | `staging-standard-pilot.js` (15 requests) | SBX | BLOCKED (A1) | |
| PAY-KEY-01 | Live keys refused; the request cap holds | | MS providers-stripe › live keys are refused…; MS providers-stripe-sandbox › request cap… (2), › live keys and every non-test key are refused… | LPG | PASS | run |
| PAY-REN-01 | Renewal | a new paid invoice; coins granted once per cycle | MS providers-stripe-sandbox-lifecycle › RENEW… (fake); MS jobs › monthly allowance… | LPG | PASS (fake) | run |
| PAY-REN-02 | Real renewal (test clock) | | `stripe-sandbox.js --scenario RENEW` (16 requests) | SBX | BLOCKED (A1, A2) | |
| PAY-DUN-01 | Dunning: failed payment, past_due, recovered | access until the grace end; recovered is active | MS providers-stripe-sandbox-lifecycle › DUNNING… (fake); MS stripe-webhooks › subscription lifecycle…; MS entitlements › tier entitlements, grace… | LPG | PASS (fake) | run |
| PAY-DUN-02 | Real dunning | | `--scenario DUNNING` (20 requests) | SBX | BLOCKED (A1, A2) | |
| PAY-REF-01 | Refunds booked once from `refund.*` events | succeeded refunds only, once | MS review-regressions › refunds: refund.* events book succeeded refunds only, once | LPG | PASS | run |
| PAY-DIS-01 | Disputes | the ledger books the dispute | MS stripe-webhooks › subscription lifecycle from Stripe events: …disputed | LPG | PASS | run |
| PAY-DIS-02 | Real dispute | | not in the sandbox scenario list | SBX | BLOCKED (A1, A2) | |
| PAY-3DS-01 | 3DS / incomplete | `incomplete` gives no access; the invoice stays open | MS providers-stripe-sandbox-lifecycle › 3DS… (fake); MS review-regressions › a declined first payment leaves the subscription incomplete… | LPG | PASS (fake) | run |
| PAY-3DS-02 | Real 3DS | | `--scenario 3DS` (8 requests) | SBX | BLOCKED (A1, A2) | |
| PAY-WH-01 | Webhook signatures | valid, tampered, wrong secret, stale, malformed, rotated | MS stripe-webhooks › signature… | LPG | PASS | run |
| PAY-WH-02 | Duplicates stored once; live mode refused | | MS stripe-webhooks › duplicates are stored once…; MS staging-webhook-server › receiver… | LPG | PASS | run |
| PAY-WH-03 | Staging receiver configuration | loopback DB only, `whsec_` only, never prints secrets, bounded batches | MS staging-webhook-server (all 6) | LPG | PASS | run |
| PAY-WH-04 | Real webhooks through the Stripe CLI listener | | runbook step 1 | SBX | BLOCKED (A1) | |
| PAY-REPLAY-01 | Replays and out-of-order deliveries | change nothing twice | MS stripe-webhooks › replays and out-of-order deliveries…; MS review-regressions › same-second terminal events… | LPG | PASS | run |
| PAY-ORD-01 | Order: an invoice before its subscription; an older state never overwrites a newer one | retried then applied | MS stripe-webhooks › an invoice that arrives before its subscription…; MS subscriptions › an older provider state never overwrites… | LPG | PASS | run |
| PAY-ORD-02 | Poison events and unknown prices | dead after max attempts; never mapped by amount | MS stripe-webhooks › unknown prices are ignored… | LPG | PASS | run |
| PAY-REC-01 | Daily reconciliation | zero diff when clean, alerts once, overlap, incomplete fetch, cap | MS providers-stripe-daily-reconcile (all 8); MS providers-stripe › reconciliation… (3) | LPG | PASS | run |
| PAY-REC-02 | Coin-pack reconciliation | | MS providers-stripe-coinpack-reconcile (all 6) | LPG | PASS | run |
| PAY-REC-03 | Real reconciliation run | 8 requests | `reconcile-daily.js --run` | SBX | BLOCKED (A1) | |
| PAY-SETUP-01 | Stripe setup planner (`stripe-setup` CLI): webhook event list, portal settings, catalogue plan, refusals, adopt-not-edit, never live | dry run by default; secret to a 0600 file, never printed; conflicts reported, never edited | MS providers-stripe-setup (all 9, fake) | LPG | PASS (fake) | run |
| PAY-SETUP-02 | Real Stripe setup run (products, prices, webhook, portal) | | `stripe-setup --run` with a test key and a ledger budget | SBX | BLOCKED (A1) | |
| PAY-HTTP-01 | HTTP client: bounded retries, no leaked bodies | | MS providers-http (all 6); MS providers-stripe › 5xx retries reuse the same idempotency key… | LPG | PASS | run |
| PAY-MISC-01 | Edge cases from the review | see the tests | MS review-regressions › an invoice paid after cancellation…; › invoices of non-Gaia Stripe subscriptions…; › first seen past_due…; › upgrade on the Stripe item…; › active subscription whose renewal never arrived… | LPG | PASS | run |
| PAY-SBX-01 | Sandbox runner safety | dry run by default; scenario limits; budget ledger; cleanup only of its own objects | MS providers-stripe-sandbox (all 10); MS providers-stripe-sandbox-lifecycle (all 12, fake) | LPG | PASS | run |

## Coins

| ID | Scenario | Expected result | Automated test / procedure | Env | Status | Evidence |
|---|---|---|---|---|---|---|
| COIN-GRANT-01 | Monthly allowance | once per cycle; the largest plan wins; annual plans grant monthly; a lapse expires leftovers | MS coins › monthly allowance resets…; MS jobs › monthly allowance…; MS jobs › cycle dates clamp… | LPG | PASS | run |
| COIN-GOOD-01 | Goodwill ≤ 500 (support) and > 500 (finance + second finance, max 10 000) | direct vs dual | MS admin › direct actions: support goodwill <= 500…; MS admin › RBAC… | LPG | PASS | run |
| COIN-GOOD-02 | Goodwill is its own bucket: never clawed back, spent after granted and before purchased; the 500 boundary is exact | | MS admin-phase3 › goodwill is its own bucket…; › the 500-coin support limit holds exactly at the boundary; FE control-center-membership2 › goodwill shows as its own wallet bucket | LPG, UNIT | PASS | run |
| COIN-BUY-01 | Coin pack credited once, even when replayed | | MS coin-packs › a paid coin pack credits purchased coins… | LPG | PASS | run |
| COIN-BUY-02 | Only Gaia packs at the package price | | MS coin-packs › only Gaia packs at the package price… | LPG | PASS | run |
| COIN-HOLD-01 | Quote, hold, capture | price set server-side; no double charge; idempotent | MS api › quote -> hold -> capture…; MS coins › quote shows the dollar equivalent | LPG | PASS | run |
| COIN-HOLD-02 | A failed AI job costs nothing; stale holds released | | MS api › a failed AI job costs nothing…; MS coins › a failed AI job nets zero…; MS jobs › stale holds are released…; MS review-regressions › replaying a released hold is refused… | LPG | PASS | run |
| COIN-SPEND-01 | Spend order, insufficient coins, idempotency keys | granted → purchased → legacy | MS coins › spend order…; › insufficient coins charge nothing… | LPG | PASS | run |
| COIN-REF-01 | Refund clawback pro rata, never below zero; a shortfall goes to review | | MS coin-packs › a refund takes back unspent coins pro rata… | LPG | PASS | run |
| COIN-EXP-01 | Granted coins expire with their cycle | no revival by refunds or late grants | MS coins › a refund after the allowance reset…; MS review-regressions › granted coins do not outlive their cycle… | LPG | PASS | run |
| COIN-CONC-01 | Concurrency | 80 parallel debits never overdraw; each key charges once | MS coins › concurrent debits never overdraw… | LPG | PASS | run |

## Legacy memberships (GHL / PayPal, architecture C)

| ID | Scenario | Expected result | Automated test / procedure | Env | Status | Evidence |
|---|---|---|---|---|---|---|
| LEG-MIR-01 | Mirror freshness | an empty or >36 h old mirror gives `review_required` for everyone | MS billing-migration › without a loaded, recent legacy mirror…; MS member-gateway › signed-in member… (`legacy_mirror_not_loaded`) | LPG | PASS | run |
| LEG-MIR-02 | Legacy reader is GET-only, paged, capped | | MS providers-ghl-legacy (all 12) | LPG | PASS | run |
| LEG-MIR-03 | Real read-only legacy import | 34 rows mirrored | done earlier (Phase 4) | GHL | PASS (earlier) | MASTER-PLAN Phase 4 |
| LEG-MIR-04 | Legacy reader on a schedule | | not scheduled | GHL | BLOCKED (A3: a read-scoped token and owner sign-off) | |
| LEG-GRD-01 | Duplicate-billing guard: any tier, any provider | `migration_required`; Stripe never called | MS billing-migration › a live GHL membership of ANY tier blocks…; MS e2e-parallel-flows › legacy Silver member… | LPG | PASS | run |
| LEG-GRD-02 | Gaia-side duplicates | `already_subscribed` / `change_plan_required` | MS billing-migration › Gaia-side duplicates… | LPG | PASS | run |
| LEG-REV-01 | Under review: unknown, ambiguous or unmapped rows | `review_required`, never treated as inactive | MS billing-migration › unknown or ambiguous legacy memberships require review…; MS e2e-parallel-flows › legacy member under review… | LPG | PASS | run |
| LEG-MIG-01 | Migration with verified cancellation | billing only after paid-through; completion only after the cancellation is verified | MS billing-migration › legacy -> new tier…; MS e2e-pilot › B. legacy Silver member migrates to Professional… | LPG | PASS | run |
| LEG-MIG-02 | Offers refused for under-review, ended or unknown paid-through | | MS billing-migration › migration offers are refused… | LPG | PASS | run |
| LEG-MIG-03 | Billing gate and urgent alert | an ambiguous row keeps billing held; double charging raises an urgent alert | MS billing-migration › billing gate… | LPG | PASS | run |
| LEG-MIG-04 | Authorized exception | a named admin and a reason; anything less refused | MS billing-migration › authorized exception… | LPG | PASS | run |
| LEG-SWT-01 | The incentive (sweetener) stays disabled | off by default; offers cannot override it | MS billing-migration › sweetener is a policy, off by default… | LPG | PASS | run |
| LEG-GHL-01 | GHL tag sync: `gaia-m:` only, never `ahc-*`, grant before revoke | | MS providers-ghl-tags (all 11); MS providers-ghl (all 10) | LPG | PASS (fakes) | run |
| LEG-GHL-03 | GHL setup spec and a dry-run diff from the legacy mirror | 5 allowlisted fields; `gaia-m:` tags only, no `ahc-*`; no GHL client on the report path; writes nothing | MS providers-ghl-setup (all 5) | LPG | PASS | run |
| LEG-GHL-02 | Real GHL writes (tags, fields, course grants) | | not run | GHL | BLOCKED (A3) | |
| LEG-CUR-01 | The current production membership keeps working (resolver, GHL sync, ordering, webhooks, fixtures, admin API) | unchanged | SP membership-contract (31), membership-pipeline (23), membership-admin-api (21), membership-events (20), membership-ordering (17), membership-ghl-adapter (17), membership-admin-ops (14), membership-product-registry (14), membership-integration (11), membership-webhook-auth (9), membership-fixture-gate (8), membership-fixture-enabled (8), membership-security-rules (6), membership-public-catalogue, membership-frontend-guard | UNIT | PASS | run |

## Permissions and tenant isolation

| ID | Scenario | Expected result | Automated test / procedure | Env | Status | Evidence |
|---|---|---|---|---|---|---|
| PERM-SCOPE-01 | Client authentication and scopes | | MS api › authentication and scopes; MS api › bad input is rejected cleanly | LPG | PASS | run |
| PERM-TEN-01 | A practitioner client sees only its own members and plans | others NOT_FOUND; denials audited | MS api › tenant isolation…; MS plans › tenant isolation of benefits… | LPG | PASS | run |
| PERM-ENT-01 | Entitlements: union, max not sum, grace, grants | | MS entitlements (2); MS review-regressions › false and zero benefit values… | LPG | PASS | run |
| PERM-ID-01 | Identity: one external id = one person; no silent re-key | | MS identity (all 4); MS api › subscription status, entitlement checks and identity resolution | LPG | PASS | run |
| PERM-OWN-01 | A member reaches only their own data | | MS member-gateway › …a member can only touch their own subscription | LPG | PASS | run |
| PERM-PART-01 | Partner adapter fails closed; contract validated | | MS partner-contract (4); MS providers-practitioners (5); MS providers-openapi (5) | LPG | PASS | run |
| PERM-PART-02 | Real partner sandbox | | not run | partner | BLOCKED (A9) | |

## Launch flags

| ID | Scenario | Expected result | Automated test / procedure | Env | Status | Evidence |
|---|---|---|---|---|---|---|
| LF-OFF-01 | A fresh DB is OFF; nobody can buy | `membership2_off` | MS launch-flags › a fresh database is OFF…; MS member-gateway › …launch OFF means no checkout | LPG | PASS | run |
| LF-OFF-02 | Rollback drill: OFF from INTERNAL_PILOT on staging, then back | checkout refused with `membership2_off`, the probe still answers, back to INTERNAL_PILOT | drill (b) | STG | PASS | [launch-rollback](drills/2026-10-26-launch-rollback.md) |
| LF-PIL-01 | INTERNAL_PILOT: pilot list only | pilot `pilot_member`; others `pilot_only` | MS launch-flags › stages…; MS e2e-parallel-flows › non-pilot…, › pilot member… | LPG | PASS | run |
| LF-LIM-01 | LIMITED: cap counted on new non-pilot customers | `limited_cap_reached` | MS launch-flags › stages…; MS e2e-parallel-flows › launch ceiling… (cap 0) | LPG | PASS | run |
| LF-ALL-01 | ALL: every new customer; legacy members always go to migration | `new_customer`; `legacy_member_use_migration` | MS launch-flags › stages…; MS e2e-parallel-flows › legacy Silver member…, › launch ceiling… | LPG | PASS | run |
| LF-CEIL-01 | The env ceiling caps the stored stage (unit) | unset or junk = OFF | MS launch-flags › ceiling: unset or junk means OFF; › a fresh database is OFF… | LPG | PASS | run |
| LF-CEIL-02 | The env ceiling overrides the DB stage end to end (gateway + API + DB) | DB ALL: ceiling INTERNAL_PILOT → `pilot_only`; OFF, unset or junk → `membership2_off`; LIMITED → cap | MS e2e-parallel-flows › launch ceiling env overrides the DB stage end to end | LPG | PASS | run |
| LF-APPR-01 | Approval reference above INTERNAL_PILOT; reason; admin only; history append-only; even direct SQL needs the reference | | MS launch-flags › changes need an admin, a reason…; MS admin › launch stage above INTERNAL_PILOT… | LPG | PASS | run |
| LF-FAIL-01 | An unreadable state fails closed | effective OFF | MS launch-flags › fails closed…; MS migrations-rollback-launch › 0009+ roll back… (tables gone = OFF) | LPG | PASS | run |
| LF-GO-01 | Production GO / NO-GO and first stage change | | not before the GO record | prod | TODO (Phase 6) | |

## Security

| ID | Scenario | Expected result | Automated test / procedure | Env | Status | Evidence |
|---|---|---|---|---|---|---|
| SEC-CSRF-01 | Admin writes: JSON and the Control Center origin only | other origins or content types refused | MS admin-gateway › writes: JSON only, Control Center origin only…; SP membership2-admin-gateway-on › ON: admin cookie required… | LPG, UNIT | PASS | run |
| SEC-CSRF-02 | Member writes: JSON body, requestId format | | MS member-gateway › signed-in member… (`INVALID_INPUT` without a requestId); gateway `body()` content type check | LPG | PASS | run |
| SEC-CSRF-03 | Production CSRF hardening (security batch) | | PR #288 tests; runbook | prod | BLOCKED (A7) | |
| SEC-RL-01 | Operator login rate limit per IP | 429 `RATE_LIMITED` after 10 / 15 min | MS admin-gateway › writes… login is rate-limited per IP | LPG | PASS | run |
| SEC-RL-02 | A spoofed X-Forwarded-For / CF-Connecting-IP cannot reset the operator sign-in limit | | SP membership2-admin-gateway-ip › a spoofed X-Forwarded-For… | UNIT | PASS | run |
| SEC-SESS-01 | Operator sessions expire; console sign-in still required | | MS admin › sessions…; FE control-center-membership2 › AUTH_REQUIRED mid-session…; › a console 401… | LPG, UNIT | PASS | run |
| SEC-SEC-01 | No secrets in the frontend; the operator token never reaches JS | | FE control-center-membership2 › it only talks to the same-origin gateway, and holds no secret; MS admin-gateway › status probe, login cookie (token never in the body)… | UNIT, LPG | PASS | run |
| SEC-SEC-02 | CLIs and runners never print keys or URLs | | MS staging-webhook-server › the CLI refuses…never prints…; MS providers-stripe-daily-reconcile › CLI --run…key never printed; FE membership-test-runner › runner: postgres is never pulled… | LPG | PASS | run |
| SEC-ESC-01 | API text rendered as text, never markup | no markup sinks, storage or eval | FE control-center-membership2 › API text is rendered as text…; › the file uses no markup sinks… | UNIT | PASS | run |
| SEC-NET-01 | Tests cannot reach the network | provider tests loopback only; proxy suite deny-by-default; the runner is loopback only | MS providers-guard (3); SP network-deny (10); FE membership-test-runner › preload… | UNIT | PASS | run |
| SEC-PAID-01 | Paid-API rule enforced in code | | SP paid-call-guard (13) | UNIT | PASS | run |
| SEC-GW-01 | Gateways fail closed on config | off unless on; loopback service; a real token | MS member-gateway › gateway config fails closed…; MS admin-gateway › admin gateway config fails closed… | UNIT | PASS | run |

## Production isolation

| ID | Scenario | Expected result | Automated test / procedure | Env | Status | Evidence |
|---|---|---|---|---|---|---|
| PI-01 | Production proxy is untouched and active | `systemctl is-active gaia-staging-proxy` = active | read-only check | prod | PASS | [isolation](drills/2026-10-26-production-isolation.md) |
| PI-02 | Production answers 404 for `/api/membership2/plans` | 404 | one GET | prod | PASS | isolation |
| PI-03 | Production `/api/admin/membership2/status` is not served | not 200 (the UI probe hides on 404/401) | one GET: 401 `admin_auth_required`, the same as any unknown admin path when signed out | prod | PASS | isolation |
| PI-04 | No `MEMBERSHIP2_*` variables in the production proxy env | 0 names (unit Environment, EnvironmentFile, running process) | names only, never values | prod | PASS | isolation |
| PI-05 | No Membership 2.0 code on the production proxy or admin shell | no `membership2-*gateway.js`; no `/var/www/gaia-admin/gadmin-membership2.js` | `ls` | prod | PASS | isolation |
| PI-06 | Event Manager still active | `gaia-event-manager` active | `systemctl is-active` | prod | PASS | isolation |
| PI-07 | Gateways off by default in code | no env means 404 everywhere | SP membership2-gateway-off; SP membership2-admin-gateway-off; MS … config fails closed (2) | UNIT | PASS | run |
| PI-08 | A deploy never activates billing | ceiling defaults to OFF | MS launch-flags › …a deployment without the ceiling never activates billing | LPG | PASS | run |
| PI-09 | The Event Manager / admin-shell boundary is unchanged | | FE event-admin-boundary (7) | UNIT | PASS | run |

## Recovery

| ID | Scenario | Expected result | Automated test / procedure | Env | Status | Evidence |
|---|---|---|---|---|---|---|
| REC-01 | Staging backup unit runs | verified dump, GPG-encrypted, local copy, off-site upload verified | drill (a): `gaia-membership-staging-backup.service` | STG | PASS | [backup-restore](drills/2026-10-26-backup-restore.md) |
| REC-02 | Restore into a temporary DB; row counts equal live | per-table counts equal; wallet mismatches 0; migrations listed; temp DB dropped | drill (a) | STG | PASS | backup-restore |
| REC-03 | Off-site encrypted copy decrypts and restores | | key holder on their own machine ([STANDARD-PILOT-RUNBOOK.md](STANDARD-PILOT-RUNBOOK.md), off-site section) | off-host | BLOCKED (A4) | |
| REC-04 | Production DB backup and PITR | | not created ([PRODUCTION-DATABASE-PLAN.md](PRODUCTION-DATABASE-PLAN.md)) | prod | TODO (owner approval of the production DB) | |

## Rollback

| ID | Scenario | Expected result | Automated test / procedure | Env | Status | Evidence |
|---|---|---|---|---|---|---|
| RB-MIG-01 | All migrations down and up on an empty DB; edited migrations refused | | MS migrations › migrations apply, roll back and re-apply cleanly; › an applied migration that is edited… | LPG | PASS | run |
| RB-MIG-02 | 0009+ down/up on a DB with data | 0001–0008 data untouched; launch back at OFF; pilot list empty (rebuild by hand) | MS migrations-rollback-launch › 0009+ roll back and re-apply… | LPG | PASS | run |
| RB-MIG-03 | 0011, 0010, 0009 one step at a time | | MS migrations-rollback-launch › each of 0011, 0010, 0009… | LPG | PASS | run |
| RB-MIG-04 | 0011/0010 down while clients still hold the newer scopes | refused atomically (even for a revoked client); the runbook strips the scopes first; code is rolled back with the schema (findings 1–2) | MS migrations-rollback-launch › 0011 / 0010 down are refused atomically… | LPG | PASS (finding: runbook step needed) | run |
| RB-FLAG-01 | Launch back to OFF on staging | instant; checkout `membership2_off` | drill (b) | STG | PASS | launch-rollback |
| RB-GW-01 | Member gateway kill switch on staging | 404; app hides the area; restore works | drill (c) | STG | PASS | kill-switch |
| RB-GW-02 | Admin gateway kill switch on staging | 404; Control Center hides the area; restore works | drill (c) | STG | PASS | kill-switch |
| RB-SVC-01 | Membership API down on staging | gateway 503 fast; app error state; restart healthy | drill (d) | STG | PASS | service-down |
| RB-PROXY-01 | Proxy file rollback via the security-batch runbook | `security-batch-deploy.sh rollback <backup> proxy` restores exact files | rehearsal 26 Oct (`SECBATCH_REHEARSAL=1`, apply ×3 / rollback ×3, `cmp` to live) | rehearsal | PASS (rehearsal) | security-batch runbook (ops, off-repo) |
| RB-PROXY-02 | Proxy rollback live on production | | only with the batch deployment | prod | BLOCKED (A7) | |

## Branding

| ID | Scenario | Expected result | Automated test / procedure | Env | Status | Evidence |
|---|---|---|---|---|---|---|
| BR-01 | Customer copy says "Gaia Healers" in the member view | | VIEW › customer copy says "Gaia Healers"… | UNIT | PASS | run |
| BR-02 | Control Center branding and the billing-off sentence | | FE control-center-membership2 › branding and the billing-off sentence are exact | UNIT | PASS | run |
| BR-03 | Whole-site guard against bare "Gaia" | | `tests/brand-consistency.test.cjs` on #304 (4 pass, run at 062daf9 on 26 Oct; not in this stack) | UNIT | PASS (on #304) | #304 |
| BR-04 | Owner wording decisions from #304 | | owner | | TODO (owner) | #304 |

## Findings from Phase 5 (26 Oct 2026)

1. **0010 / 0011 rollback refused while api_clients hold the newer scopes** (`migrations/0010_member_scopes.sql` and `0011_operators.sql`, the `-- down` sections). The down sections re-add the tighter `api_clients_scopes_check`. On any DB with the proxy's member client or the admin client, a revoked one included (staging has 2), the down fails. It fails atomically and safely, but it does fail.
   - **Runbook step:** strip `member:*` / `admin:operate` from those rows, or delete them, before rolling back. Test: RB-MIG-04.
   - The applied files are checksummed, so they cannot be edited now. A later migration could make the down tolerant instead.
2. **Code and schema roll back together.** After `0012` down, the current code fails on every audited write: `audit.js` writes `audit_logs.reason`, which 0012 adds. The rollback test hit this on the restacked stack. The runbook order is therefore: **flag OFF → gateways off → code back to the matching commit → migrations down**, never migrations alone.
3. **Rolling back 0009 loses the launch history and the pilot list.** Re-applying it starts at OFF, which fails closed. The pilot list must then be rebuilt by hand. Test: RB-MIG-02.
4. **`launch.js show` reports the wrong ceiling** (`src/cli/launch.js` line 21: `launchState(pool)` reads `process.env`). The staging CLI env file has no `MEMBERSHIP2_STAGE_CEILING`; the API unit sets it in `Environment=`. So `show` prints "ceiling OFF, EFFECTIVE OFF" while the API is effectively INTERNAL_PILOT.
   - Suggestion: print both, with a warning when the ceiling is unset, or read the ceiling from the API's health.
5. **A service outage and "billing not connected" share one answer** (`staging-proxy/membership2-gateway.js` lines 60–61 and 89 use `PROVIDER_UNAVAILABLE`). The member view's copy for that code says "Billing isn't connected in this environment…". See [drill (d)](drills/2026-10-26-service-down.md).
6. **The gateway timeout is fixed at 8 s** on every route (`membership2-gateway.js` line 57). It is bounded, but long for GETs.
7. **A kill switch cannot be a drop-in `Environment=`.** Systemd applies `EnvironmentFile=` after it, so the env file wins. Use a second `EnvironmentFile` in a drop-in instead ([drill (c)](drills/2026-10-26-gateway-kill-switch.md)). This matters for the production runbook.
8. **Docs are out of date:**
   - [MEMBERSHIP-VIEW.md](MEMBERSHIP-VIEW.md), "Known API ordering point", says checkout answers `PROVIDER_UNAVAILABLE` before the guard and the gate. The current code (`needStripe()` is now a lazy stub) answers the guard and the gate first. CP-LEG-01 and CP-CHK-03 prove it.
   - CONTROL-CENTER.md §5 describes the new 404 behaviour only. Production's old router answers 401 to a signed-out caller (PI-03).
9. **Backups are never test-decrypted on the server.** The restore drill restores a fresh plaintext dump. Decrypting the encrypted artifact is A4 (key holder only). This is by design.

## Totals (26 Oct 2026)

| Status | Rows |
|---|---|
| PASS | 146 |
| FAIL | 0 |
| BLOCKED | 19 |
| TODO | 5 |
| **All** | 170 |

`PASS (fake)` means proven against loopback fakes only. The same scenario against real Stripe has its own BLOCKED row.

## Test inventory: every test mapped to a row

Generated from the test sources on 26 Oct 2026. Counts per suite come from the runner.
- The **staging-proxy** suite has 100 files. Only the files that concern membership are listed here. The rest (assistant, academy, onboarding, practitioners and so on) are general regression. They count in the runner totals, and must stay green for any proxy change.
- The other **frontend** files are general regression too.

### membership-service (`MS`, real Postgres)

| File | Test | Row(s) |
|---|---|---|
| admin-gateway | admin gateway config fails closed: off unless on, loopback only, a real admin client token | SEC-GW-01 |
| admin-gateway | admin gateway OFF: falls through, nothing reaches the service | AD-GW-01 |
| admin-gateway | status probe, login cookie (token never in the body), admin cookie + operator cookie required | AD-GW-02, SEC-SEC-01 |
| admin-gateway | writes: JSON only, Control Center origin only; login is rate-limited per IP | SEC-CSRF-01, SEC-RL-01 |
| admin-gateway | dual approval end to end through the gateway: request, refused self-approval, second operator executes | AD-DUAL-01 |
| admin-gateway | first sign-in through the gateway: restricted until the password is changed; /password needs the operator cookie and the origin | AD-PWD-01 |
| admin-phase3 | goodwill is its own bucket: never clawed back by a refund, spent after granted and before purchased, shown separately | COIN-GOOD-02, COIN-GOOD-01 |
| admin-phase3 | the 500-coin support limit holds exactly at the boundary | COIN-GOOD-02, COIN-GOOD-01 |
| admin-phase3 | initial password must be changed: restricted session until POST /v1/admin/password succeeds | AD-PWD-01 |
| admin-phase3 | execute / retry: approve is not execute; explicit retry only; replay returns the first result; executed is final (409); no background retry | AD-EXEC-06 |
| admin-phase3 | every admin audit row carries its reason; read models name people and operators; environment and money source | AD-AUD-02 |
| admin-phase3 | login: the session of an operator who must change the password is still fully audited and rate-limited by the account lock | AD-PWD-01 |
| admin | crypto primitives: RFC 6238 vector, scrypt verify, AES-GCM bound to the operator id | AD-SIGN-01 |
| admin | TOTP window: +-1 step accepted, 2 steps refused, a used step never accepted again | AD-SIGN-02 |
| admin | sign-in: uniform invalid_login, lockout after 5 failures for 15 min, sessions hashed | AD-SIGN-03, AD-LOCK-01 |
| admin | sessions: 30 min idle limit, 8 h absolute limit, logout revokes, disabled operator is signed out | AD-SESS-01, SEC-SESS-01 |
| admin | the admin routes need an admin:operate client; member clients cannot reach them | AD-RBAC-02 |
| admin | RBAC: every action, every role, matches the contract matrix | AD-RBAC-01, COIN-GOOD-01 |
| admin | direct actions: support goodwill <= 500 executes once; replay returns the first result; audit names the operator | AD-EXEC-01, COIN-GOOD-01, AD-AUD-01 |
| admin | two-person rule: self-approval refused, wrong role refused, a second operator approves and it executes exactly once | AD-DUAL-01 |
| admin | two-person rule: expiry after 72 h, disabled approver, disabled requester cancels pending requests | AD-DUAL-02 |
| admin | Stripe actions without Stripe: approved_not_executed with PROVIDER_UNAVAILABLE, never faked, never re-executed | AD-EXEC-02 |
| admin | Stripe actions with a (test-mode) Stripe client: refund and immediate cancel call the adapter once | AD-EXEC-03 |
| admin | launch stage above INTERNAL_PILOT: owner requests, a second owner approves; the env ceiling still caps it; pilot list | AD-LAUNCH-01, LF-APPR-01 |
| admin | read models are bounded and paginated; health and overview answer | AD-READ-01 |
| admin | operator management (CLI functions): audited, sessions revoked on role change and TOTP reset | AD-SIGN-02 |
| api | authentication and scopes | PERM-SCOPE-01 |
| api | subscription status, entitlement checks and identity resolution | PERM-ID-01 |
| api | tenant isolation: a practitioner client sees only its own members and plans | PERM-TEN-01 |
| api | quote -> hold -> capture: price is server-side, no double charge, idempotent | COIN-HOLD-01 |
| api | a failed AI job costs nothing; insufficient coins and expired quotes are refused; only the holder settles | COIN-HOLD-01 |
| api | bad input is rejected cleanly | PERM-SCOPE-01 |
| billing-migration | a live GHL membership of ANY tier blocks a new Stripe subscription: migration_required, Stripe never called | LEG-GRD-01 |
| billing-migration | unknown or ambiguous legacy memberships require review, never treated as inactive | LEG-REV-01 |
| billing-migration | without a loaded, recent legacy mirror nobody can be told "nothing paid elsewhere" | LEG-MIR-01 |
| billing-migration | Gaia-side duplicates: same plan is already_subscribed, another tier is a plan change, never a second subscription | LEG-GRD-02 |
| billing-migration | legacy -> new tier: offer, accept, billing only after paid-through (no sweetener by default), completion only when the cancellation is verified | LEG-MIG-01 |
| billing-migration | migration offers are refused for anything under review, ended, or with an unknown paid-through date | LEG-MIG-02 |
| billing-migration | sweetener is a policy, off by default; offers cannot override it | LEG-SWT-01 |
| billing-migration | authorized exception: a named admin and a written reason complete the migration; anything less is refused | LEG-MIG-04 |
| billing-migration | billing gate: an ambiguous legacy membership keeps billing held; a subscription already charging raises an urgent alert | LEG-MIG-03 |
| coin-packs | a paid coin pack credits purchased coins and books the charge once, even when replayed | COIN-BUY-01 |
| coin-packs | only Gaia packs at the package price are credited; other payments are ignored | COIN-BUY-02 |
| coin-packs | a refund takes back unspent coins pro rata and never goes below zero | COIN-REF-01 |
| coins | quote shows the dollar equivalent | COIN-HOLD-01 |
| coins | monthly allowance resets as a ledger event and is idempotent per cycle | COIN-GRANT-01 |
| coins | spend order is granted, then purchased, then legacy; purchased coins survive resets | COIN-SPEND-01 |
| coins | insufficient coins charge nothing; an idempotency key cannot be reused for another request | COIN-SPEND-01 |
| coins | concurrent debits never overdraw and each key charges once | COIN-CONC-01 |
| coins | a failed AI job nets zero; captured jobs can be refunded once; stale holds are released | COIN-HOLD-02 |
| coins | a refund after the allowance reset does not revive expired granted coins | COIN-GRANT-01 |
| e2e-parallel-flows | legacy Silver member: shown as legacy, no new-membership path, checkout answers migration_required (any stage, pilot or not), nothing reaches Stripe | CP-LEG-01, LEG-GRD-01, LF-ALL-01 |
| e2e-parallel-flows | legacy member under review (unknown GHL status): shown under_review, checkout review_required, never treated as inactive | CP-LEG-02, LEG-REV-01 |
| e2e-parallel-flows | pilot member reaches the billing step: 503 PROVIDER_UNAVAILABLE, and the same requestId answers the same way | CP-CHK-01, LF-PIL-01 |
| e2e-parallel-flows | non-pilot member at INTERNAL_PILOT: availability false (pilot_only), checkout not_available pilot_only, no Stripe | CP-CHK-03, LF-PIL-01 |
| e2e-parallel-flows | launch ceiling env overrides the DB stage end to end (DB says ALL_NEW_CUSTOMERS) | LF-CEIL-02, LF-LIM-01, LF-ALL-01 |
| e2e-parallel-flows | membership service down: the gateway answers 503 PROVIDER_UNAVAILABLE quickly (refused port) and within its 8 s bound (silent service) | CP-ERR-02, RB-SVC-01 |
| e2e-pilot | A. new member: signup to cancellation, every step through the real services | PAY-CHK-01, CP-CAN-01 (end-to-end, loopback Stripe fake) |
| e2e-pilot | B. legacy Silver member migrates to Professional without double billing or losing access | LEG-MIG-01 |
| entitlements | holding two plans never duplicates a benefit; numbers take the max, not the sum | PERM-ENT-01 |
| entitlements | tier entitlements, grace, incomplete payments and manual grants | PERM-ENT-01 |
| identity | one external id maps to one person, even under concurrent first sight | PERM-ID-01 |
| identity | a Practitioners account already linked to someone else is a CONFLICT, never a silent re-key | PERM-ID-01 |
| identity | emails are normalized; bad references are rejected | PERM-ID-01 |
| identity | concurrent links of the same identity to the same person all succeed (no false conflict) | PERM-ID-01 |
| jobs | cycle dates clamp to short months and never precede the anchor | COIN-GRANT-01, PAY-REN-01 |
| jobs | monthly allowance: once per cycle, largest plan wins, annual plans grant monthly, lapse expires leftovers | COIN-GRANT-01, PAY-REN-01 |
| jobs | grace and scheduled ends: Gaia-owned subscriptions are closed, provider-owned ones only counted | PAY-DUN-01 |
| jobs | stale holds are released by the cleanup job | COIN-HOLD-02 |
| launch-flags | ceiling: unset or junk means OFF | LF-CEIL-01 |
| launch-flags | a fresh database is OFF; nobody can start new billing; the env ceiling caps the stored stage | LF-CEIL-01 |
| launch-flags | changes need an admin, a reason, and above INTERNAL_PILOT the GO approval reference; history is append-only | LF-APPR-01 |
| launch-flags | stages: pilot-only, limited cap counted on new non-pilot customers, legacy members always routed to migration | LF-PIL-01, LF-LIM-01, LF-ALL-01 |
| launch-flags | fails closed when the state cannot be read | LF-FAIL-01 |
| member-gateway | gateway config fails closed: off unless explicitly on, loopback service only, a real client token | SEC-GW-01 |
| member-gateway | gateway OFF: every /api/membership2 path falls through (404), nothing reaches the service | CP-OFF-01, PI-07 |
| member-gateway | plans are public; everything else needs the member session | CP-PLAN-01, CP-PACK-01 |
| member-gateway | signed-in member: account is created once, overview shows availability; launch OFF means no checkout | CP-OFF-01, PI-07 |
| member-gateway | legacy members are shown their legacy membership and never offered a second subscription | CP-LEG-01 |
| member-gateway | coin and billing history, and a member can only touch their own subscription | CP-COIN-01, CP-BILL-01, CP-CHK-01, CP-CAN-02, PERM-OWN-01 |
| migrations-rollback-launch | 0009+ roll back and re-apply on a database with data; earlier data untouched; launch comes back OFF | RB-MIG-02, LF-FAIL-01 |
| migrations-rollback-launch | each of 0011, 0010, 0009 rolls back and re-applies on its own (one step at a time) | RB-MIG-03 |
| migrations-rollback-launch | 0011 / 0010 down are refused atomically while a client still holds admin:operate / member:* scopes, even when revoked | RB-MIG-04 |
| migrations | migrations apply, roll back and re-apply cleanly | RB-MIG-01 |
| migrations | an applied migration that is edited afterwards is refused | RB-MIG-01 |
| migrations | ledgers and the audit log are append-only | AD-AUD-01 |
| partner-contract | with no partner configured, every call fails closed | PERM-PART-01 |
| partner-contract | carry-over: purchased only where a payment backs it; the rest is legacy (N-4 open) | PERM-PART-01 |
| partner-contract | a balance that does not match its history, or a purchase without a payment, is rejected | PERM-PART-01 |
| partner-contract | mock adapter serves validated fixtures; module entitlements come from live subscriptions only | PERM-PART-01 |
| plans | the v2.5 catalogue: four tiers at the decided prices and coin allowances | CP-PLAN-04 |
| plans | published versions are immutable; a price change is a new version and grandfathers subscribers | CP-PLAN-04 |
| plans | legacy versions are only assigned by an explicit legacy import | CP-PLAN-04 |
| plans | tenant isolation of benefits: practitioner plans grant only their own practice.* keys | PERM-TEN-01 |
| providers-ghl-legacy | legacy reader is GET-only and limited to three billing read routes | LEG-MIR-02 |
| providers-ghl-legacy | tier maps ONLY by price id: mapped, unmapped, ambiguous | LEG-MIR-02 |
| providers-ghl-legacy | status is classified, never rewritten; unknown strings are unknown | LEG-MIR-02 |
| providers-ghl-legacy | paid-through and stale: interval + grace, calendar arithmetic, review only | LEG-MIR-02 |
| providers-ghl-legacy | review merge: sticky reasons, reviewed rows stay reviewed until a NEW reason | LEG-MIR-02 |
| providers-ghl-legacy | a pass mirrors subscriptions: mapping, provider, amount, interval, last payment, person link, review reasons | LEG-MIR-02 |
| providers-ghl-legacy | ambiguous price ids are review items, never a tier | LEG-MIR-02 |
| providers-ghl-legacy | stale detection NEVER marks anything canceled, inactive or ended and never changes access | LEG-MIR-02 |
| providers-ghl-legacy | contact re-key, disappearing subscriptions, never delete; reviewed rows stay reviewed | LEG-MIR-02 |
| providers-ghl-legacy | pagination has a hard page cap; an incomplete pass or an error writes nothing and keeps last_seen_at | LEG-MIR-02 |
| providers-ghl-legacy | read-only legacy report: counts by tier, provider and status; review list; stale suspects; freshness | LEG-MIR-02 |
| providers-ghl-legacy | config drift check: configured price ids that GHL no longer lists are reported | LEG-MIR-02 |
| providers-ghl-setup | spec: exactly the five allowlisted fields; every listed value passes the field check | LEG-GHL-03 |
| providers-ghl-setup | spec: every tag is gaia-m: and lowercase; legacy tags only for silver/gold/diamond; no ahc-* | LEG-GHL-03 |
| providers-ghl-setup | the report path has no GHL client and no network transport | LEG-GHL-03 |
| providers-ghl-setup | --spec needs no database; the diff refuses a non-loopback database | LEG-GHL-03 |
| providers-ghl-setup | dry-run diff from the legacy mirror: legacy tags for live mapped rows, hold for unknown, nothing for unmapped / ended; writes nothing | LEG-GHL-03 |
| providers-ghl-tags | legacy tiers become gaia-m:legacy:<tier> only; unknown status is held, never removed | LEG-GHL-01 |
| providers-ghl-tags | custom fields are resolved BY KEY; missing and duplicate keys are reported, never created | LEG-GHL-01 |
| providers-ghl-tags | benefit map: validated, gaia-m: viaTag only, expectations follow tag changes | LEG-GHL-01 |
| providers-ghl-tags | drift: missing and extra Gaia tags; foreign tags only counted | LEG-GHL-01 |
| providers-ghl-tags | sync never adds or removes a non-gaia-m: tag, across legacy and tier changes (ahc-* Gold tags included) | LEG-GHL-01 |
| providers-ghl-tags | grant new -> confirm -> revoke old: fields, add new, then remove old; idempotent; one tier at the end | LEG-GHL-01 |
| providers-ghl-tags | old access is revoked only after GHL confirms the new grant | LEG-GHL-01 |
| providers-ghl-tags | partial failure: access is never lost; dead letter partial_apply; a re-run resumes and resolves it | LEG-GHL-01 |
| providers-ghl-tags | sync with discovered field ids writes only to resolved fields | LEG-GHL-01 |
| providers-ghl-tags | expected grants: recorded on tag changes, confirmed by the mirror, unconfirmed ones alert once | LEG-GHL-01 |
| providers-ghl-tags | workflow reconciliation: report-only by default; apply mode fixes drift on the fake | LEG-GHL-01 |
| providers-ghl | desired state: highest tier wins, each benefit once, deterministic order | LEG-GHL-01 |
| providers-ghl | desired state: no paid access -> tier none; past grace or incomplete grants nothing | LEG-GHL-01 |
| providers-ghl | no wellness data can reach GHL: extra input is ignored and fields are allowlisted | LEG-GHL-01 |
| providers-ghl | diff only touches tags under the Gaia prefix; foreign tags and fields are never removed | LEG-GHL-01 |
| providers-ghl | the GHL client is structurally read-only towards billing | LEG-GHL-01 |
| providers-ghl | email search keeps EXACT matches only (main or additional email), never fuzzy hits | LEG-GHL-01 |
| providers-ghl | sync: finds the contact by email, links it, writes prefixed tags + allowlisted fields, keeps foreign tags | LEG-GHL-01 |
| providers-ghl | sync: several contacts for one email are reported as a dead letter, never merged or guessed | LEG-GHL-01 |
| providers-ghl | sync: GHL down -> bounded retries -> dead letter; a later success resolves it | LEG-GHL-01 |
| providers-ghl | sync: deleted contact, identity conflict, no contact, and the batch cap | LEG-GHL-01 |
| providers-guard | network deny: fetch, DNS and raw sockets to any non-loopback host are refused | SEC-NET-01 |
| providers-guard | every provider test file installs the network deny before anything else | SEC-NET-01 |
| providers-guard | provider adapters never read the environment, never default to global fetch, never enable live mode | SEC-NET-01 |
| providers-http | fetch must be injected: no client can be built on an implicit network | PAY-HTTP-01 |
| providers-http | 429 and 5xx are retried with bounded backoff, then PROVIDER_UNAVAILABLE | PAY-HTTP-01 |
| providers-http | a transient failure recovers; Retry-After is honoured but capped | PAY-HTTP-01 |
| providers-http | 4xx is not retried and maps to a standard code; bodies never leak into errors | PAY-HTTP-01 |
| providers-http | connection refused is retried then PROVIDER_UNAVAILABLE | PAY-HTTP-01 |
| providers-http | backoff never exceeds the cap | PAY-HTTP-01 |
| providers-openapi | the OpenAPI document parses and is 3.1 with every proposed endpoint | PERM-PART-01 |
| providers-openapi | required fields: validators and OpenAPI schemas agree | PERM-PART-01 |
| providers-openapi | enums agree | PERM-PART-01 |
| providers-openapi | conditional rule documented and enforced: a purchase must name its payment | PERM-PART-01 |
| providers-openapi | page envelopes require next_cursor (null on the last page), like the adapter | PERM-PART-01 |
| providers-practitioners | marked proposed; same interface as the mock adapter; reads validated, paged data | PERM-PART-01 |
| providers-practitioners | invalid partner payloads are rejected at the boundary | PERM-PART-01 |
| providers-practitioners | pagination is bounded: repeated cursor, page cap, missing envelope, balance drift between pages | PERM-PART-01 |
| providers-practitioners | auth failure, 404 and outage map to standard errors; config is validated | PERM-PART-01 |
| providers-practitioners | partner webhooks: HMAC + timestamp verified, event id deduped, data validated, stored for async processing | PERM-PART-01 |
| providers-stripe-coinpack-reconcile | coin-pack charges (no invoice) match their ledger rows | PAY-REC-02 |
| providers-stripe-coinpack-reconcile | a refunded coin pack matches its refund rows (partial and full) | PAY-REC-02 |
| providers-stripe-coinpack-reconcile | a Stripe charge with no ledger row is reported; a ledger row missing in Stripe only when the fetch is complete | PAY-REC-02 |
| providers-stripe-coinpack-reconcile | coin-pack amount and currency mismatches are reported | PAY-REC-02 |
| providers-stripe-coinpack-reconcile | coin totals: every Stripe purchase operation has exactly one ledger charge row, and vice versa (SQL check) | PAY-REC-02 |
| providers-stripe-coinpack-reconcile | the daily job includes the coin check: a purchase without its ledger charge row alerts once | PAY-REC-02 |
| providers-stripe-daily-reconcile | plan: previous UTC day plus a backward overlap; only finished days; request count = 4 lists x pages | PAY-REC-01 |
| providers-stripe-daily-reconcile | daily run: clean day exits 0; a mismatch alerts once; re-running the day stores a new run without a duplicate alert | PAY-REC-01 |
| providers-stripe-daily-reconcile | a failed alert() is not lost: the next run re-sends it | PAY-REC-01 |
| providers-stripe-daily-reconcile | overlap: an object created before the day is matched; a ledger row in the overlap is not judged missing in Stripe | PAY-REC-01 |
| providers-stripe-daily-reconcile | incomplete fetch (page cap reached) exits non-zero with an incomplete_fetch alert | PAY-REC-01 |
| providers-stripe-daily-reconcile | hard cap: a plan above the cap is refused before any request; a retry that would pass the cap throws and records nothing | PAY-REC-01 |
| providers-stripe-daily-reconcile | CLI: dry run is the default and sends nothing; live keys refused without --allow-live; above-cap plans refused | PAY-REC-01 |
| providers-stripe-daily-reconcile | CLI --run: exit 0 on a clean day, 1 on a mismatch; counts printed, key never printed | PAY-REC-01, SEC-SEC-02 |
| providers-stripe-sandbox-lifecycle | every scenario fits the cap on its own; the cap is still 25 | PAY-SBX-01 |
| providers-stripe-sandbox-lifecycle | dry run of every lifecycle scenario: plan printed with counts, nothing sent | PAY-SBX-01 |
| providers-stripe-sandbox-lifecycle | combinations above the cap are refused before sending (DUNNING cannot share a run) | PAY-DUN-01 |
| providers-stripe-sandbox-lifecycle | <scenario>: passes against the fake, within its plan and the cap, and leaves nothing behind | PAY-SBX-01 |
| providers-stripe-sandbox-lifecycle | RENEW: customer on the clock, one advance, one poll, a new paid invoice; cleanup deletes the clock, not the customer | PAY-REN-01 |
| providers-stripe-sandbox-lifecycle | DUNNING: failing card, past_due with an attempted open invoice, retry with the good card, active again | PAY-DUN-01 |
| providers-stripe-sandbox-lifecycle | CANCEL_END: canceled after the period end, no renewal invoice | PAY-SBX-01 |
| providers-stripe-sandbox-lifecycle | CHANGE: proration_behavior=none on both changes, no proration recorded, no new invoice | PAY-SBX-01 |
| providers-stripe-sandbox-lifecycle | 3DS: allow_incomplete, the subscription is incomplete and its invoice open | PAY-3DS-01 |
| providers-stripe-sandbox-lifecycle | EVENTS: one GET of at most 20, ids and types only | PAY-SBX-01 |
| providers-stripe-sandbox-lifecycle | a clock that never becomes ready: bounded polls, scenario fails, the cap holds, leftovers listed | PAY-SBX-01 |
| providers-stripe-sandbox-lifecycle | the worst case is exactly the plan: slow clocks use every planned poll and never exceed the plan | PAY-SBX-01 |
| providers-stripe-sandbox | request cap: the request that would exceed the cap throws before it is sent; a plan above the cap is refused | PAY-KEY-01, PAY-SBX-01 |
| providers-stripe-sandbox | request cap: http.js never retries a cap refusal (no backoff loop behind the cap) | PAY-KEY-01, PAY-SBX-01 |
| providers-stripe-sandbox | dry run is the default: planned requests per scenario are printed and nothing is sent | PAY-SBX-01 |
| providers-stripe-sandbox | live keys and every non-test key are refused, in dry run and in a real run; the key is never printed | PAY-KEY-01, PAY-SBX-01 |
| providers-stripe-sandbox | scenario selection: required, at most 3, manual ones refused, a plan above the cap refused before sending | PAY-SBX-01 |
| providers-stripe-sandbox | a full run: exact request count, Stripe-side expectations, cleanup of only what the run created, ids and statuses only | PAY-SBX-01 |
| providers-stripe-sandbox | J lists the charges and refunds made earlier in the same run | PAY-SBX-01 |
| providers-stripe-sandbox | the cap holds mid-run: a retry consumes budget, the request past the cap throws, leftovers are listed by id | PAY-SBX-01 |
| providers-stripe-sandbox | the runner refuses to reach the network: real Stripe is unreachable from tests | PAY-SBX-01 |
| providers-stripe-sandbox | total budget across runs: the planned smoke test fits 25; one more run is refused before sending; crashes stay counted | PAY-SBX-01 |
| providers-stripe-setup | the webhook event list is exactly the pipeline handler table | PAY-SETUP-01 |
| providers-stripe-setup | plan: seed catalog = 3 paid tiers x 2 intervals; 3 requests per price + 1 per product; webhook 2; portal 2 | PAY-SETUP-01 |
| providers-stripe-setup | portal configuration: card update, invoices, cancel at period end ON; plan switching and profile edits OFF | PAY-SETUP-01 |
| providers-stripe-setup | dry run is the default: sends nothing, prints the plan, the events and the count | PAY-SETUP-01 |
| providers-stripe-setup | --run refusals: no or live key, no --max-requests, too small a cap, no ledger budget, no secret file, missing URLs | PAY-SETUP-01 |
| providers-stripe-setup | --run webhook + portal: creates both once, secret to a 0600 file and never printed; second run adopts, sends no POST | PAY-SETUP-01 |
| providers-stripe-setup | --run conflicts are reported, never edited: other events on the same URL, a portal that allows plan switching | PAY-SETUP-01 |
| providers-stripe-setup | --run catalog from the database: 3 products, 6 prices with lookup keys, refs recorded; a re-run plans 0 catalog requests | PAY-SETUP-01 |
| providers-stripe-setup | the CLI never enables live mode and has no live flag | PAY-SETUP-01 |
| providers-stripe | live keys are refused unless allowLive is passed explicitly; junk keys are refused | PAY-KEY-01 |
| providers-stripe | form encoding matches Stripe bracket notation | PAY-CHK-02 |
| providers-stripe | every POST needs an idempotency key; a reused key with other params is CONFLICT | PAY-CHK-02 |
| providers-stripe | a live-mode object returned to a test client is refused | PAY-KEY-01 |
| providers-stripe | 5xx retries reuse the same idempotency key; Stripe-Should-Retry:false stops retries | PAY-HTTP-01 |
| providers-stripe | ensureCustomer creates once, links the identity, and is idempotent under concurrency | PAY-CHK-02 |
| providers-stripe | ensureProductAndPrice: one product per plan, one price per version price, livemode=false, never edited | PAY-CHK-02 |
| providers-stripe | ensureProductAndPrice adopts an exactly matching price found by lookup key, refuses a mismatching one | PAY-CHK-02 |
| providers-stripe | checkout session carries Gaia metadata; legacy, duplicate-plan and bad-input cases are refused | PAY-CHK-01, CP-CHK-06 |
| providers-stripe | coin pack checkout: draft packs are not sold; an active pack is a one-time payment with coin metadata | CP-PACK-02 |
| providers-stripe | cancelAtPeriodEnd sets cancel_at_period_end on Stripe and schedules the same end locally | CP-CAN-01 |
| providers-stripe | reconciliation: zero diff when the ledger matches; every kind of mismatch is reported; foreign objects skipped | PAY-REC-01 |
| providers-stripe | reconcileStripe pages through the fake API, records the run, alerts only on mismatch | PAY-REC-01 |
| providers-stripe | reconciliation fetch failure is PROVIDER_UNAVAILABLE and records nothing | PAY-REC-01 |
| review-regressions | a declined first payment leaves the subscription incomplete, not dead-lettered | PAY-3DS-01 |
| review-regressions | an invoice paid after cancellation is still booked | PAY-MISC-01 |
| review-regressions | same-second terminal events and replays of them are no-ops without duplicate history | PAY-REPLAY-01 |
| review-regressions | invoices of non-Gaia Stripe subscriptions are ignored, not retried | PAY-MISC-01 |
| review-regressions | a subscription first seen past_due is recorded as past_due | PAY-MISC-01 |
| review-regressions | an upgrade on the Stripe item moves the subscription to the new plan | PAY-MISC-01 |
| review-regressions | refunds: refund.* events book succeeded refunds only, once | PAY-REF-01 |
| review-regressions | granted coins do not outlive their cycle (release, refund, late or out-of-order grants) | COIN-EXP-01 |
| review-regressions | replaying a released hold is refused, so a retried job is never free | COIN-HOLD-02 |
| review-regressions | false and zero benefit values are not entitlements; merging is symmetric | PERM-ENT-01 |
| review-regressions | a price cannot be added to a version while it is being published | CP-PLAN-04 |
| review-regressions | an active subscription whose renewal never arrived loses access after the leeway | PAY-MISC-01 |
| staging-webhook-server | database URL: loopback only, including ?host= overrides | PAY-WH-03 |
| staging-webhook-server | webhook secret: whsec_ only; live-looking secrets and API keys refused | PAY-WH-03 |
| staging-webhook-server | the CLI refuses to start on a bad configuration, binds nothing, and never prints the secret or URL | PAY-WH-03, SEC-SEC-02 |
| staging-webhook-server | receiver: loopback bind, signatures verified, events stored once, live and oversized refused | PAY-WH-02, PAY-WH-03 |
| staging-webhook-server | processing: one bounded batch per tick, never two at once | PAY-WH-03 |
| staging-webhook-server | the real interval drives processing (minimum interval) | PAY-WH-03 |
| stripe-webhooks | signature: valid, tampered, wrong secret, stale timestamp, malformed, rotated secret | PAY-WH-01 |
| stripe-webhooks | duplicates are stored once; live-mode events are refused | PAY-WH-02 |
| stripe-webhooks | subscription lifecycle from Stripe events: paid, failed, recovered, refunded, disputed | PAY-DUN-01, PAY-DIS-01 |
| stripe-webhooks | replays and out-of-order deliveries change nothing twice | PAY-REPLAY-01 |
| stripe-webhooks | an invoice that arrives before its subscription is retried, then applied | PAY-ORD-01 |
| stripe-webhooks | unknown prices are ignored (never mapped by amount); poison events go dead after max attempts | PAY-ORD-02 |
| subscriptions | lifecycle rules (pure) | PAY-DUN-01 |
| subscriptions | a subscription moves through its lifecycle with full history | PAY-DUN-01 |
| subscriptions | an older provider state never overwrites a newer one (out-of-order webhooks) | PAY-ORD-01 |
| subscriptions | click-to-cancel shows the exact access-end date and keeps access until then | CP-CAN-01 |

### staging-proxy (`SP`), Membership 2.0 and guard files

| File | Test | Row(s) |
|---|---|---|
| membership2-admin-gateway-ip | a spoofed X-Forwarded-For / CF-Connecting-IP does not reset the operator sign-in limit | SEC-RL-02 |
| membership2-admin-gateway-off | every admin membership2 path is a plain 404 while the admin gateway is off (signed out and signed in) | AD-GW-01, PI-07 |
| membership2-admin-gateway-on | ON: admin cookie required; status probe; writes need the Control Center origin and JSON | AD-GW-02, SEC-SEC-01 |
| membership2-admin-gateway-on | ON: the Event Manager bearer (how production signs in) is accepted exactly like the admin cookie; operator cookie still required | AD-GW-02 |
| membership2-gateway-off | every membership2 path is a plain 404 while the gateway is off | CP-OFF-01, PI-07 |
| network-deny | a fetch to a model provider fails at name resolution | SEC-NET-01 |
| network-deny | so does a WebSocket to the Qwen realtime host | SEC-NET-01 |
| network-deny | and the OpenAI-shaped hosts: Groq, OpenRouter, OpenAI, ElevenLabs | SEC-NET-01 |
| network-deny | a host nobody has listed yet is blocked too -- the rule is deny by default | SEC-NET-01 |
| network-deny | local servers still work, by address and by name | SEC-NET-01 |
| network-deny | our own public hosts are allowed, because the live-env checks use them | SEC-NET-01 |
| network-deny | the preload switches the usage log off unless a test names a file | SEC-NET-01 |
| network-deny | npm test loads the preload, and CI runs npm test | SEC-NET-01 |
| network-deny | every test that boots the server or the relay also redirects the usage log itself | SEC-NET-01 |
| network-deny | under node --test, the default log path is off even without the preload | SEC-NET-01 |
| paid-call-guard | above the default cap of 5, the run is refused before anything is sent | SEC-PAID-01 |
| paid-call-guard | the refusal says what approval needs: count, tokens, cost, reason | SEC-PAID-01 |
| paid-call-guard | an unknown cost is called out as a reason to stop and ask | SEC-PAID-01 |
| paid-call-guard | estimates are presented as a floor, because failed calls can still bill | SEC-PAID-01 |
| paid-call-guard | --dry-run sends nothing, even within the cap | SEC-PAID-01 |
| paid-call-guard | a run that miscounted its plan still cannot spend past the cap | SEC-PAID-01 |
| paid-call-guard | an approved larger cap is honoured exactly, and not exceeded | SEC-PAID-01 |
| paid-call-guard | local calls (the test server itself) are not counted | SEC-PAID-01 |
| paid-call-guard | the guard never raises its own cap | SEC-PAID-01 |
| paid-call-guard | every script that can reach a paid API installs the guard | SEC-PAID-01 |
| paid-call-guard | scripts that open a paid WebSocket count it before connecting | SEC-PAID-01 |
| paid-call-guard | the project rule itself is in the repository, not only in somebody's memory | SEC-PAID-01 |
| paid-call-guard | the copies of the rule are identical, so they cannot drift apart | SEC-PAID-01 |

### frontend (`FE`), Membership 2.0 and boundary files

| File | Test | Row(s) |
|---|---|---|
| control-center-membership2 | the file uses no markup sinks, no storage and no eval | SEC-ESC-01 |
| control-center-membership2 | it only talks to the same-origin gateway, and holds no secret | SEC-SEC-01 |
| control-center-membership2 | index.html loads the area before gadmin.js; the gadmin.js hook is small and probe-gated | AD-UI-01 |
| control-center-membership2 | branding and the billing-off sentence are exact | BR-02 |
| control-center-membership2 | probe 404 → hidden, and no other request is ever made | AD-UI-01 |
| control-center-membership2 | probe 401 (no admin session) or network error → hidden | AD-UI-01 |
| control-center-membership2 | probe 200 not signed in → the operator sign-in, with email, password and 6-digit code | AD-UI-01 |
| control-center-membership2 | sign-in: generic error on failure, lockout on 429 | AD-SIGN-03, AD-LOCK-01 |
| control-center-membership2 | a console 401 (admin_auth_required) goes to the console sign-in, not the operator one | AD-SIGN-03, AD-LOCK-01 |
| control-center-membership2 | a note is its own reason: no separate reason field, 10 characters minimum | AD-UI-01 |
| control-center-membership2 | AUTH_REQUIRED mid-session returns to sign-in and says why | AD-SIGN-03, AD-LOCK-01 |
| control-center-membership2 | only actions in /me.permissions are drawn | AD-RBAC-03 |
| control-center-membership2 | launch is read-only unless owner, even if a permission key slipped through | AD-RBAC-03 |
| control-center-membership2 | own requests wait for a second approver; others show requester and reason | AD-DUAL-03 |
| control-center-membership2 | every action dialog states the consequence, and needs a 10-character reason | AD-UI-01 |
| control-center-membership2 | network error and 5xx reuse the same requestId and body; a 4xx starts a new one | AD-EXEC-05 |
| control-center-membership2 | outcome wording: pending, billing-off, forbidden | AD-UI-01 |
| control-center-membership2 | PROVIDER_UNAVAILABLE (503) is a final answer, not a retry | AD-EXEC-02 |
| control-center-membership2 | API text is rendered as text, never as markup | SEC-ESC-01 |
| control-center-membership2 | money and coins format | AD-UI-01 |
| control-center-membership2 | first sign-in: a must-change-password session sees only the password screen; the change is checked before sending | AD-PWD-01 |
| control-center-membership2 | STAGING / TEST MODE banner comes from the server: shown unless production with live Stripe | AD-UI-03 |
| control-center-membership2 | money source badges are labels for the server-side source, never guessed | AD-UI-03 |
| control-center-membership2 | names, not ids: requests show the member email; audit shows operator names, entity labels and the reason column | AD-AUD-02 |
| control-center-membership2 | goodwill shows as its own wallet bucket | COIN-GOOD-02 |
| control-center-membership2 | sidebar: real buttons with aria-current; "live from GHL" is not claimed for Membership 2.0 | AD-UI-03 |
| membership-test-runner | runner: postgres is never pulled, bound to loopback only, data in tmpfs, random password | SEC-SEC-02, SEC-NET-01 |
| membership-test-runner | runner: the container and the temporary worktree are removed on every exit (trap) | SEC-SEC-02, SEC-NET-01 |
| membership-test-runner | runner: nothing reaches the network beyond loopback (offline npm, no fetch, no pull, preload on every node) | SEC-NET-01 |
| membership-test-runner | runner: summary has suite, pass, fail, skipped, duration and commit per suite | SEC-SEC-02, SEC-NET-01 |
| membership-test-runner | preload: a public name does not resolve, a literal public IP is refused, loopback still works | SEC-NET-01 |
| event-admin-boundary | the Admin shell embeds the real Event Manager rather than reimplementing it | PI-09 |
| event-admin-boundary | no Event Admin capability is reimplemented in the general Admin shell | PI-09 |
| event-admin-boundary | the Admin shell writes nothing to the event domain | PI-09 |
| event-admin-boundary | event data reaching the shell is server-joined, not fetched from the event API | PI-09 |
| event-admin-boundary | the Admin shell only reaches the event backend for sign-in | PI-09 |
| event-admin-boundary | event data in the shell is displayed, never computed or written | PI-09 |
| event-admin-boundary | the architecture is written down where a developer will find it | PI-09 |

### member view (`VIEW`, `tests/membership2-view.test.cjs`)

| File | Test | Row(s) |
|---|---|---|
| membership2-view | no hard-coded prices, coin amounts or "months free" figures | CP-PLAN-02 |
| membership2-view | no tier names or tier logic: plans, labels and benefits come from the API | CP-PLAN-02 |
| membership2-view | every write is a JSON POST with credentials and a requestId reused on retry | CP-CHK-05 |
| membership2-view | hidden unless the feature probe succeeds; production routing falls back to the Store | CP-OFF-02 |
| membership2-view | the view is not in the assistant screen map (no prompt tokens added) | CP-OFF-03 |
| membership2-view | customer copy says "Gaia Healers", never a bare "Gaia" | BR-01 |
| membership2-view | no card-entry fields; payment details stay with Stripe | CP-BILL-01 |
| membership2-view | every server answer has plain-language copy | CP-ERR-01 |
| membership2-view | legacy members never get a buy button; return states toast and refresh | CP-LEG-01 |
| membership2-view | accessibility basics: live region, labelled sections, focusable notice, pressed toggle | CP-A11Y-01 |

### staging-proxy: current production membership (file level, row LEG-CUR-01)

| File | Tests |
|---|---|
| membership-admin-api.test.js | 21 |
| membership-admin-ops.test.js | 14 |
| membership-contract.test.js | 31 |
| membership-events.test.js | 20 |
| membership-fixture-enabled.test.js | 8 |
| membership-fixture-gate.test.js | 8 |
| membership-frontend-guard.test.js | table-driven |
| membership-ghl-adapter.test.js | 17 |
| membership-integration.test.js | 11 |
| membership-ordering.test.js | 17 |
| membership-pipeline.test.js | 23 |
| membership-product-registry.test.js | 14 |
| membership-public-catalogue.test.js | table-driven |
| membership-security-rules.test.js | 6 |
| membership-webhook-auth.test.js | 9 |
