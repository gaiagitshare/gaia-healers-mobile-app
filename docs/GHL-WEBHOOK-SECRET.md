# Dedicated GHL webhook secrets — rollout

**Why.** `GHL_WORKFLOW_WEBHOOK_SECRET` and `GHL_BACKFILL_SECRET` are unset in
production, so the GHL workflow routes authenticate with `COURSES_SYNC_SECRET`.
One secret opens several webhook families (audit 2026-10-26, S5). This change
lets each family have its own secret, with a dated window to move GHL over.

**Nothing changes until you configure it.** With the variables unset, the old
fallback works exactly as before.

## Rules

| `GHL_WORKFLOW_WEBHOOK_SECRET` | `..._TRANSITION_UNTIL` | accepted on the workflow routes |
|---|---|---|
| unset | — | `COURSES_SYNC_SECRET` (today) |
| set | in the future | the new secret **or** `COURSES_SYNC_SECRET` |
| set | past, unset or not a date | the new secret only |

Backfill follows the same pattern with `GHL_BACKFILL_SECRET` and
`GHL_BACKFILL_SECRET_TRANSITION_UNTIL`; its fallback is whatever the workflow
routes accept. The date is checked on every request, so expiry needs no
restart. A secret shorter than 32 characters is ignored (and logged at start).

`POST /api/courses/sync` (the daily course-catalogue workflow) is **not**
affected: it keeps using `COURSES_SYNC_SECRET`.

## Routes and GHL workflows covered

| family | route | header | who calls it |
|---|---|---|---|
| workflow | `POST /api/webhooks/ghl/member-access` | `X-Webhook-Secret` (or `X-Sync-Secret`) | GHL workflows: **Offer Access Granted**, **Offer Access Removed**, **Group Access Granted**, **Group Access Revoked**, the two `gaia-community-*` mirror-tag workflows, and any explicit membership workflow (see `docs/GHL-MEMBER-ACCESS-SYNC.md`). Also the proxy itself when `/api/academy/webhook` forwards a grant — that uses the configured value automatically. |
| workflow | `GET /api/entitlement-review` | `X-Webhook-Secret` or `?secret=` | operator/diagnostic read |
| backfill | `POST /api/webhooks/ghl/member-backfill` | `X-Backfill-Secret` (or `X-Webhook-Secret`) | server-side import scripts only |

A request with a valid Ed25519 `X-GHL-Signature` on member-access does not use
the secret at all and is not counted below.

## Rollout

1. **Generate** a secret on the server (never paste it into chat or a ticket):
   `openssl rand -hex 32`
2. **Set it** in `/root/gaia-staging-proxy/.env`, with a transition date about
   two weeks out:
   ```
   GHL_WORKFLOW_WEBHOOK_SECRET=<the new value>
   GHL_WORKFLOW_WEBHOOK_SECRET_TRANSITION_UNTIL=2026-11-15T00:00:00Z
   ```
   Optionally do the same for `GHL_BACKFILL_SECRET` /
   `GHL_BACKFILL_SECRET_TRANSITION_UNTIL` with a second, different value.
3. **Restart** the proxy service. Both secrets now work.
4. **Update GHL.** In each workflow listed above, open the Webhook action and
   replace the `X-Webhook-Secret` header value with the new secret. Save and
   publish. Update any backfill script's `X-Backfill-Secret` too.
5. **Watch the counter.** `GET /api/entitlement-review` (with the new secret in
   `X-Webhook-Secret`) returns `secret_auth`:
   ```json
   "secret_auth": {
     "workflow": { "dedicatedConfigured": true, "transitionOpen": true,
       "fallbackAccepted": true, "transitionUntil": "...",
       "dedicated": 41, "fallback": 3, "lastDedicatedAt": "...", "lastFallbackAt": "...",
       "byRoute": { "member-access": { "dedicated": 40, "fallback": 3, ... } } },
     "backfill": { ... }
   }
   ```
   The same counters are in `data/webhook-telemetry.json` under `secret_auth`.
   Counts and timestamps only — never a secret. When `lastFallbackAt` stops
   moving (no fallback use for several days while workflows keep firing),
   every workflow has switched.
6. **Let the window expire.** After `..._TRANSITION_UNTIL` passes,
   `COURSES_SYNC_SECRET` no longer opens these routes. If something still used
   it, member-access telemetry shows `rejected_auth` and the admin health page
   reports `auth_failure`. You can also shorten the window by editing the date
   and restarting.

## Rollback

Unset (or comment out) `GHL_WORKFLOW_WEBHOOK_SECRET` (and/or
`GHL_BACKFILL_SECRET`) and restart. Behaviour returns to today's fallback on
`COURSES_SYNC_SECRET`. To keep the new secret but reopen the old one, set
`..._TRANSITION_UNTIL` to a future date and restart.

Note: once GHL workflows send the new secret, unsetting it makes those
workflows fail until their headers are changed back to `COURSES_SYNC_SECRET`.
Prefer reopening the window over unsetting once step 4 has started.
