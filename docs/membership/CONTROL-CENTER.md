# Membership 2.0 in the Control Center: design and API contract

Status: Phase 3 built and verified on staging; owner decisions of 2026-10-26 applied (§1b). Default-off, additive, staging first. Nothing here
changes the existing Control Center, its shared password, Event Manager devices,
printer pairings, staff sessions or customer accounts.

## 1. Decisions taken (owner can overrule)

| Topic | Decision | Why |
|---|---|---|
| Who is an operator | Individual **operator accounts** in the membership database, created by the owner with a CLI (never self sign-up). | Every financial action needs a named person (audit S6). |
| Sign-in | Email + password (scrypt) + **mandatory TOTP** (authenticator app). Sessions 8 h idle-capped at 30 min, revocable, stored hashed. | Works without email delivery (staging has no GHL); no shared secret. |
| Relation to today's Control Center | The shared-password console stays as is. The Membership 2.0 area needs the **operator sign-in in addition** (two cookies). | Zero change for current staff and devices. |
| Roles | `viewer` < `support` < `finance` < `owner` (each includes the ones before). | Smallest set that separates "help a member" from "move money". |
| Two-person rule | Actions marked **dual** create a *request*; a **different** operator with the required role approves, and only then it executes. Requests expire after 72 h. | Financial authorization without trusting one account. |
| Reasons | Every write needs a written reason (≥ 10 chars). Every write and every approval is in `audit_logs` with the operator id. | |
| Payments | Stripe refunds and immediate cancellations go through the Stripe adapter; with no Stripe client the request executes to `PROVIDER_UNAVAILABLE` and stays `approved_not_executed` (never faked). | No mock money. |
| Legacy (GHL/PayPal) | Read-only. No action here changes a GHL or PayPal subscription. | Standing rule. |

## 1b. Owner decisions, 2026-10-26 (implemented)

| # | Decision | How it is enforced |
|---|---|---|
| D1 | **Goodwill coins never expire and are kept apart from the monthly granted coins.** | Own bucket `goodwill` (`coin_wallets.goodwill_balance`, migration 0012). A payment refund never takes it back (`clawbackPurchased` reads only `purchased`); allowance resets and lapses touch only `granted`. Shown separately in the wallet: `/v1/admin/persons/:id`, `/v1/admin/coins` totals, the Control Center, and the member view's `/overview` wallet (`wallet.goodwill`). |
| D1a | **Spend order: granted → goodwill → purchased → legacy.** This is a default the owner can change (`SPEND_ORDER` in `src/coins.js`; no migration needed). | `walletView` returns `spendOrder`. |
| D1b | Existing staging goodwill credits (200, 1500, 50, 600 coins on fixture persons, booked before 0012) **stay where they were booked, in `purchased`**: the ledgers are append-only and are not rewritten. They are still identifiable as goodwill (operation reason `goodwill_credit`). New credits go to `goodwill`. | — |
| D2 | **Operators change their initial password at first sign-in.** | `operators.must_change_password` (set by `create` and by the CLI `reset-password`; every operator existing at migration 0012 starts with it set). Until changed, sign-in gives a restricted session: only `POST /v1/admin/password`, `GET /v1/admin/me`, `POST /v1/admin/logout`; everything else is 403 `reason:'password_change_required'`. |
| D3 | **Refund (or any action) execution / retry only by an explicit action.** | `POST /v1/admin/requests/:id/execute` (finance or above, and at least the request's approver role; a reason and a requestId). Never automatic, never on start-up or a timer. Each attempt is one `admin_action_attempts` row; an executed request never executes again (row lock + unique partial index). Default (owner can change): the requester of a dual request cannot execute it. **Retries close 72 h after the approval** (after submission for a direct action; owner decision 2026-10-26): a later attempt is 409 CONFLICT, audited as `admin.denied` / `retry_window_closed`, no attempt row is written and the request must be made again. Request views carry `retryUntil`. |
| D4 | **Sign-in limits unchanged; trusted client IP.** | The gateway keys its limit on `deps.clientIp` = `adminRouter.clientIp`. **Merge order: security PR #287 (trusted client IP, `staging-proxy/client-ip.js`) first, then this branch** — with #287 the helper ignores `X-Forwarded-For` / `CF-Connecting-IP` and trusts `X-Real-IP` only from loopback, so the operator sign-in limit cannot be reset by rotating headers (`staging-proxy/test/membership2-admin-gateway-ip.test.js`, skipped until #287 is in, proven by a trial merge). |
| D5 | **No real operator accounts** until the owner approves the operator list. Only the three fictional staging operators exist. | Operators exist only via the owner's CLI. |
| D6 | Migration exceptions need an owner approver; the 500-coin direct support limit stays. | `migration.authorize_exception` dual (owner); `coins.credit` > 500 needs finance + a second finance approver (tests at 500 / 501). |
| — | "Gaia Recommended" (the directory badge in `catalog.js`) is an intentional programme name and stays as it is. Customer-facing Stripe names read "Gaia Healers …" (`Gaia Healers <plan>`, `Gaia Healers coins: N`); metadata keys such as `gaia_plan_key` are technical and unchanged. | — |

## 2. Permission matrix

| Action | Min role | Dual (second approver role) |
|---|---|---|
| Read anything in the area (members, person detail, plans, payments, coins, legacy, offers, reconciliation, refund reviews, dead letters, audit, health, launch state) | viewer | — |
| Add a note to a person | support | — |
| Create / withdraw a migration offer | support | — |
| Confirm a legacy cancellation (with evidence text) | support | — |
| Cancel a subscription **at period end** | support | — |
| Goodwill coin credit ≤ 500 coins | support | — |
| Goodwill coin credit > 500 coins (max 10 000) | finance | dual (finance) |
| Resolve a coin refund review | finance | — |
| Execute again a failed / approved-but-not-executed request (`/requests/:id/execute`) | finance, and at least the request's approver role | — (the approval already exists; the requester of a dual request may not execute it) |
| Refund a payment (full or partial, Stripe) | finance | dual (finance) |
| Cancel a subscription **immediately** | finance | dual (finance) |
| Authorize a migration exception | finance | dual (owner) |
| Add / remove a pilot member | owner | — |
| Change the launch stage to INTERNAL_PILOT or OFF | owner | — |
| Change the launch stage above INTERNAL_PILOT (approval ref required) | owner | dual (owner) |
| Create / disable an operator, change a role, reset TOTP | owner (CLI only in this phase) | — |

Rules: an operator can never approve their own request; a disabled operator's pending
requests are cancelled; the env ceiling (`MEMBERSHIP2_STAGE_CEILING`) still caps any stage.

## 3. Data (migration 0011_operators.sql)

- `operators` (id uuid, email unique lower, display_name, role CHECK in the 4 roles,
  password_scrypt, totp_secret_enc (AES-GCM with `MEMBERSHIP_OPERATOR_KEY`, bound to the operator id), status active|disabled,
  failed_logins, locked_until, created_by, created_at, last_login_at; also `totp_last_step` (a code is never accepted twice),
  `updated_at`, `disabled_at`).
- `operator_sessions` (token_sha256 PK, operator_id, created_at, last_seen_at, expires_at, revoked_at, ip_hash, ua_hash).
- `admin_action_requests` (id, action, params jsonb, reason, requested_by, required_role,
  status pending|approved|rejected|cancelled|expired|executed|failed, decided_by, decided_at,
  decision_note, executed_at, result jsonb, idempotency_key unique, expires_at; also `dual`, `created_at`,
  `decision_key` unique (the approver's optional requestId));
  CHECK decided_by <> requested_by. Direct actions are rows too (dual=false), so every write has one replayable record.
  "approved_not_executed" is stored as status `approved` with `result.outcome = 'approved_not_executed'`; the API shows it as that status.
- `person_notes` (id, person_id, operator_id, body, created_at) append-only.
- `api_clients` scope CHECK adds `admin:operate` (the proxy's admin client).

Migration 0012_admin_phase3_decisions.sql:
- `coin_wallets.goodwill_balance` and balance type `goodwill` in `coin_transactions` (`wallet_mismatches()` covers it).
- `operators.must_change_password` (default true; true for every operator that existed), `operators.password_changed_at`.
- `audit_logs.reason` (text ≤ 4000): the written reason on the row itself.
- `admin_action_attempts` (id, request_id, attempt_no, kind initial|retry, attempt_key UNIQUE (`initial:<request id>` or
  `<operator id>:<requestId>`), executed_by, reason, outcome running|executed|failed|not_executed|abandoned, result, started_at,
  finished_at); UNIQUE (request_id, attempt_no); at most one `running` and one `executed` attempt per request (partial unique
  indexes); never deleted, updated once (running → outcome) by trigger. A `running` attempt older than 15 min (process died) is
  closed `abandoned` by the next explicit execute, never re-used.

## 4. Internal API (membership service, loopback, client scope `admin:operate`)

Operator auth is header-based: the proxy forwards `X-Operator-Session: <opaque token>`.
All responses `{ ok, ... }`; errors `{ ok:false, code, message }` (plus `requiredRole` on FORBIDDEN,
`error:'invalid_login'` on a failed sign-in, `request:{id,status}` when a direct action failed) with codes
`AUTH_REQUIRED` 401, `FORBIDDEN` 403 (body has `requiredRole`), `NOT_FOUND`, `INVALID_INPUT`,
`CONFLICT`, `PROVIDER_UNAVAILABLE` 503, `RATE_LIMITED` 429.

| Method + path | Role | Body / query → result |
|---|---|---|
| POST `/v1/admin/login` | — | `{email,password,totp}` → `{session, operator:{id,email,displayName,role,mustChangePassword}, expiresAt}`; 5 failures lock 15 min; same error for every failure (`invalid_login`) |
| GET `/v1/admin/environment` | — (admin client only, no operator) | `{environment: staging\|production\|unset (MEMBERSHIP_ENV), stripeMode: none\|test\|live}` |
| POST `/v1/admin/logout` | any | revokes the session |
| GET `/v1/admin/me` | any (also restricted) | `{operator, mustChangePassword, permissions:[action keys] ([] while restricted), idleExpiresAt, expiresAt, environment, stripeMode}` |
| POST `/v1/admin/password` | any (also restricted) | `{currentPassword, newPassword}` → `{changed:true}`; new password 12–200 characters, not equal to the current one, scrypt; clears `must_change_password`, revokes the operator's other sessions; a wrong current password counts as a failed sign-in (5 → locked, sessions revoked) |
| GET `/v1/admin/overview` | viewer | counts: members by plan/status, MRR cents (Gaia-owned only), coins outstanding, open refund reviews, open alerts, pending requests, legacy by state, launch state, last reconciliation |
| GET `/v1/admin/persons?q=&limit=&cursor=` | viewer | search by email / contact id / person id → `{items:[{personId, emails, contactIds, plan, status, legacy:[tier], coins}] , next}` |
| GET `/v1/admin/persons/:id` | viewer | identities, subscriptions (+events), entitlements, wallet + last 50 coin tx, payments, legacy rows, offers, pilot flag, notes, last 50 audit rows |
| POST `/v1/admin/persons/:id/notes` | support | `{body}` |
| GET `/v1/admin/plans` | viewer | plans, versions, prices, provider refs, coin packs (incl. drafts) |
| GET `/v1/admin/payments?from=&to=&type=&limit=&cursor=` | viewer | payment_ledger rows |
| GET `/v1/admin/coins?limit=&cursor=` | viewer | coin transactions + wallet totals |
| GET `/v1/admin/legacy?state=&limit=` | viewer | legacy mirror rows + freshness |
| GET `/v1/admin/migration-offers?status=` | viewer | offers |
| GET `/v1/admin/reconciliation` | viewer | last 30 daily runs + open alerts |
| GET `/v1/admin/refund-reviews?status=open` | viewer | coin refund reviews |
| GET `/v1/admin/dead-letters` | viewer | ghl_sync_dead_letters + webhook events failed |
| GET `/v1/admin/audit?entityType=&entityId=&actorId=&limit=&cursor=` | viewer | audit_logs |
| GET `/v1/admin/health` | viewer | db ok, migrations version, webhook backlog, oldest pending job, mirror age, stripe connected (bool), `environment`, `stripeMode` |
| GET `/v1/admin/launch` | viewer | launch state + history + pilot list |
| POST `/v1/admin/actions` | per action | `{action, params, reason, requestId}` → direct actions: `{status:'executed', result}`; dual: `{status:'pending', request}` |
| GET `/v1/admin/requests?status=pending\|retryable\|approved_not_executed\|<stored status>` | viewer | requests (+ `canApprove`, `canExecute` for the caller; `subject`, `attempts`, `lastAttempt`, `money`) |
| POST `/v1/admin/requests/:id/approve` | per action | `{note, requestId?}` (note ≥ 10 characters: the decision's reason) → approval recorded, then attempt 1 → `{status:'executed'\|'failed'\|'approved_not_executed', result}` |
| POST `/v1/admin/requests/:id/reject` | per action | `{note, requestId?}` (note ≥ 10 characters) |
| POST `/v1/admin/requests/:id/cancel` | requester | `{note?}` |
| POST `/v1/admin/requests/:id/execute` | finance+ (≥ approver role) | `{reason, requestId}` → `{status, result, attempt:{attemptNo}}`; only for `failed` or `approved_not_executed`; replaying the requestId returns that attempt's outcome; an executed request is 409 `CONFLICT`; pending / rejected / cancelled / expired are 409 |

Action keys (`action`): `note.add`, `offer.create {personId, legacyMembershipId, targetPlanKey, interval}`,
`offer.withdraw {offerId}`, `legacy.confirm_cancelled {offerId, evidence}`,
`subscription.cancel_period_end {subscriptionId}`, `subscription.cancel_now {subscriptionId}`,
`coins.credit {personId, coins}`, `refund_review.resolve {reviewId, resolution}`,
`payment.refund {ledgerId, amountCents}`, `migration.authorize_exception {offerId}`,
`pilot.add {personId}`, `pilot.remove {personId}`, `launch.set {stage, limitedCap?, approvalRef?}`.
`requestId` (8–64 `[A-Za-z0-9_-]`) is the idempotency key: a replay returns the first result.

Clarifications (backend, 2026-10-26):
- `requestId` is scoped to the operator; the same requestId with a different action, params or reason is `CONFLICT`.
- Every write needs `reason` ≥ 10 characters. **Exception: `note.add`** (via `/actions` or `/persons/:id/notes`):
  the note body is the reason, so a note must be ≥ 10 characters; `params: {personId, body}`.
- approve / reject accept `{note?, requestId?}`; `requestId` (same format) makes the decision idempotent for that
  approver (a replay returns the first outcome; reusing it for another request is `CONFLICT`).
- approve answers `ok:true` with `status` = `executed` | `failed` (with `result.code`) | `approved_not_executed`.
  A request is executed at most once; a failed or not-executed request is never retried automatically.
- A direct action that fails answers its error code (e.g. `PROVIDER_UNAVAILABLE` 503 for a Stripe action without
  Stripe) and is recorded as `failed` (or approved_not_executed); its replay returns the same error.
- Login: every failure (unknown email, wrong password, wrong / reused code, locked, disabled) is 401 `AUTH_REQUIRED`
  with `error:'invalid_login'`. TOTP is RFC 6238 SHA-1, 30 s, 6 digits, ±1 step.
- `GET /v1/admin/me` also returns `expiresAt` (absolute). Read models take `limit` (default 50, max 200) and
  return `next` (opaque cursor) where the contract lists `cursor`.
- Goodwill coins (`coins.credit`) go to the **goodwill** bucket as an `adjustment` (never expire, not a Stripe purchase,
  never clawed back by a payment refund). Before migration 0012 they were booked in `purchased` and stay there (D1b).
- Approve and reject need a written `note` (≥ 10 characters); it is the decision's reason in the audit log.
- Every audit row written while an action is requested, decided, executed or retried carries `reason` (the request's reason,
  the decision note, or the retry's reason), including the domain rows the action writes (coins, launch stage, pilot list,
  offers, subscriptions). Denials carry the reason that was submitted. Expiry: `expired: no decision within 72 hours`.
- Names, not ids, in the read models: requests carry `requestedBy` / `decidedBy` display names and `subject`
  `{personId, email, contactId}` (the member the action is about, resolved from personId, subscriptionId, ledgerId, offerId or
  reviewId); audit rows carry `actor_name` (operator display name), `entity_label` (a person's email, an operator's name) and
  `reason`; payments, coins, refund reviews, offers, legacy rows and the pilot list carry `person_email` / `person_contact_id`;
  launch history `changed_by_name`, pilot list `added_by_name`, coin rows `actor_name`, notes `operator_name`.
- Where money came from, decided from the record only: payment rows have `source` = `stripe_confirmed` (provider stripe, written
  by a verified Stripe webhook — `webhook_event_id` set — for a Stripe object id) or `test_fixture` (anything else);
  coin `purchase` rows have `source` = `stripe_confirmed` when a webhook-written Stripe ledger row points at the operation,
  else `test_fixture` (grants and goodwill are not money: `null`); refund requests have `money` = `stripe_confirmed` (the Stripe
  API answered with a `re_…` id), `not_executed` (billing not connected / not executed), or `pending`.
- Every execution of a Stripe action uses the same Stripe idempotency key (`gaia-admin-refund-<request id>`), so even a retry
  after an unknown outcome cannot refund twice at Stripe.
- `payment.refund` needs a Stripe `charge` ledger row (`charge` or `invoice` object) and amountCents ≤ the charge;
  the refund is booked in `payment_ledger` by the refund webhook, not by the action.

## 5. Proxy gateway: `/api/admin/membership2/*`

- OFF unless `MEMBERSHIP2_ADMIN=on` plus the same loopback `MEMBERSHIP_SERVICE_URL` and a
  dedicated `MEMBERSHIP_ADMIN_SERVICE_TOKEN` (`admin:operate` only). Off = every path 404.
- Requires the existing Control Center sign-in — exactly what `admin-router.js` accepts (`consoleAuthed`: the
  `gaia_admin` cookie **or** the Event Manager bearer used by production) — **and** the operator cookie
  `gaia_operator` (HttpOnly, Secure, SameSite=Strict, Path=/api/admin/membership2).
- Writes: JSON only; Origin (else Referer) must be the proxy's own origin, `PROXY_PUBLIC_URL`, `ALLOWED_ORIGINS`,
  or `MEMBERSHIP2_ADMIN_ORIGINS` (comma-separated; staging: `http://127.0.0.1:8799`). Login and password change: 10 attempts per
  IP per 15 min (together) → 429 `RATE_LIMITED`. The IP is `adminRouter.clientIp`; **merge PR #287 (trusted client IP) before
  this branch** so that it no longer reads `X-Forwarded-For` / `CF-Connecting-IP` (D4).
- Off = every `/api/admin/membership2*` path answers the normal unknown-admin-route 404 (`{ok:false, reason:'unknown_admin_route'}`), signed in or not.
- Without a valid console sign-in: 401 `AUTH_REQUIRED` (`reason:'admin_auth_required'`); without the operator cookie: 401 `AUTH_REQUIRED`.
- Paths mirror the internal API 1:1 under `/api/admin/membership2/` (e.g. `POST /api/admin/membership2/login`,
  `GET /api/admin/membership2/persons/:id`). Login sets the cookie and never returns the token to JS.
- `GET /api/admin/membership2/status` (admin cookie only) → `{enabled:true, signedIn:bool, mustChangePassword:bool,
  environment, stripeMode}` (environment / stripeMode from the service, `unknown` if it cannot be reached); the UI probes it.
- `POST /api/admin/membership2/password` `{currentPassword, newPassword}` → the service's `/v1/admin/password` (operator cookie required).

## 6. Control Center UI

A "Membership 2.0" section in `admin/gadmin.js`, shown only when the probe answers 200.
Operator sign-in (email, password, 6-digit code), then: Overview · Members (search → person
detail with tabs) · Payments · Coins · Legacy & migration · Requests (approve/reject; own
requests show "waiting for a second approver") · Reconciliation · Audit · Health · Launch.
Action buttons appear only for permitted actions (from `/me.permissions`); every action opens a
dialog with the consequence in plain words and a required reason. Money is shown as $ with the
coin equivalent. Branding: "Gaia Healers Control Center".

Phase 3 polish (2026-10-26):
- First sign-in / reset password: a "Choose your own password" screen (current, new ≥ 12, repeat) instead of the area.
- STAGING / TEST MODE banner in the console shell whenever the server's `environment` is not `production` or `stripeMode`
  is not `live` (from `/status`, refreshed by `/me` and `/health`). The member Membership view gets a smaller banner in its
  own PR (#306).
- Members, operators and reasons are shown by name (email, else contact id; display name) wherever ids were shown: request
  cards, audit (with a Reason column from `audit_logs.reason`), launch history, pilot list, notes, payments, coins.
- Badges on money: "Stripe-confirmed", "Test fixture", "Not executed (billing not connected)" — from the server's `source` /
  `money` fields, never inferred in the browser.
- Requests screen: a second list "Approved but not executed, or failed" with "Execute again" (reason dialog) for operators
  allowed to run it, attempts and the last attempt's outcome.
- Wallet shows goodwill as its own bucket and the spend order.
- Sidebar: every item is a real `<button>` (Tab, Enter, Space), visible focus ring, `aria-current="page"` on the current
  section; mouse behaviour unchanged. The sidebar footer keeps "live from GHL" for the console sections that really read GHL
  (Contacts, Membership) and reads "Membership 2.0 database" while the Membership 2.0 area is open.
