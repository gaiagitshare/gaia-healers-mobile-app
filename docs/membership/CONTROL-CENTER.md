# Membership 2.0 in the Control Center: design and API contract

Status: Phase 3 design, 2026-10-26. Default-off, additive, staging first. Nothing here
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
  password_scrypt, totp_secret_enc (AES-GCM with `MEMBERSHIP_OPERATOR_KEY`), status active|disabled,
  failed_logins, locked_until, created_by, created_at, last_login_at).
- `operator_sessions` (token_sha256 PK, operator_id, created_at, last_seen_at, expires_at, revoked_at, ip_hash, ua_hash).
- `admin_action_requests` (id, action, params jsonb, reason, requested_by, required_role,
  status pending|approved|rejected|cancelled|expired|executed|failed, decided_by, decided_at,
  decision_note, executed_at, result jsonb, idempotency_key unique, expires_at);
  CHECK decided_by <> requested_by.
- `person_notes` (id, person_id, operator_id, body, created_at) append-only.
- `api_clients` scope CHECK adds `admin:operate` (the proxy's admin client).

## 4. Internal API (membership service, loopback, client scope `admin:operate`)

Operator auth is header-based: the proxy forwards `X-Operator-Session: <opaque token>`.
All responses `{ ok, ... }`; errors `{ ok:false, code, message }` with codes
`AUTH_REQUIRED` 401, `FORBIDDEN` 403 (body has `requiredRole`), `NOT_FOUND`, `INVALID_INPUT`,
`CONFLICT`, `PROVIDER_UNAVAILABLE` 503, `RATE_LIMITED` 429.

| Method + path | Role | Body / query → result |
|---|---|---|
| POST `/v1/admin/login` | — | `{email,password,totp}` → `{session, operator:{id,email,displayName,role}, expiresAt}`; 5 failures lock 15 min; same error for every failure (`invalid_login`) |
| POST `/v1/admin/logout` | any | revokes the session |
| GET `/v1/admin/me` | any | `{operator, permissions:[action keys], idleExpiresAt}` |
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
| GET `/v1/admin/health` | viewer | db ok, migrations version, webhook backlog, oldest pending job, mirror age, stripe connected (bool) |
| GET `/v1/admin/launch` | viewer | launch state + history + pilot list |
| POST `/v1/admin/actions` | per action | `{action, params, reason, requestId}` → direct actions: `{status:'executed', result}`; dual: `{status:'pending', request}` |
| GET `/v1/admin/requests?status=pending` | viewer | requests (+ `canApprove` for the caller) |
| POST `/v1/admin/requests/:id/approve` | per action | `{note}` → executes → `{status:'executed'|'failed'|'approved_not_executed', result}` |
| POST `/v1/admin/requests/:id/reject` | per action | `{note}` |
| POST `/v1/admin/requests/:id/cancel` | requester | — |

Action keys (`action`): `note.add`, `offer.create {personId, legacyMembershipId, targetPlanKey, interval}`,
`offer.withdraw {offerId}`, `legacy.confirm_cancelled {offerId, evidence}`,
`subscription.cancel_period_end {subscriptionId}`, `subscription.cancel_now {subscriptionId}`,
`coins.credit {personId, coins}`, `refund_review.resolve {reviewId, resolution}`,
`payment.refund {ledgerId, amountCents}`, `migration.authorize_exception {offerId}`,
`pilot.add {personId}`, `pilot.remove {personId}`, `launch.set {stage, limitedCap?, approvalRef?}`.
`requestId` (8–64 `[A-Za-z0-9_-]`) is the idempotency key: a replay returns the first result.

## 5. Proxy gateway: `/api/admin/membership2/*`

- OFF unless `MEMBERSHIP2_ADMIN=on` plus the same loopback `MEMBERSHIP_SERVICE_URL` and a
  dedicated `MEMBERSHIP_ADMIN_SERVICE_TOKEN` (`admin:operate` only). Off = every path 404.
- Requires the existing Control Center admin cookie **and** the operator cookie
  `gaia_operator` (HttpOnly, Secure, SameSite=Strict, Path=/api/admin/membership2).
- Writes: JSON only, Origin must be the Control Center origin, login rate-limited per IP.
- Paths mirror the internal API 1:1 under `/api/admin/membership2/` (e.g. `POST /api/admin/membership2/login`,
  `GET /api/admin/membership2/persons/:id`). Login sets the cookie and never returns the token to JS.
- `GET /api/admin/membership2/status` (admin cookie only) → `{enabled:true, signedIn:bool}`; the UI probes it.

## 6. Control Center UI

A "Membership 2.0" section in `admin/gadmin.js`, shown only when the probe answers 200.
Operator sign-in (email, password, 6-digit code), then: Overview · Members (search → person
detail with tabs) · Payments · Coins · Legacy & migration · Requests (approve/reject; own
requests show "waiting for a second approver") · Reconciliation · Audit · Health · Launch.
Action buttons appear only for permitted actions (from `/me.permissions`); every action opens a
dialog with the consequence in plain words and a required reason. Money is shown as $ with the
coin equivalent. Branding: "Gaia Healers Control Center".
