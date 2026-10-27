# Membership 2.0 rollback runbook

Use the lightest step that solves the problem, and stop there. Each step is safe on its own; the
order matters only when you go further down the list. Findings from the Phase 5 drills
(docs/membership/drills/) are folded in.

| # | Step | Effect | Time measured on staging |
|---|---|---|---|
| 1 | **Launch flag OFF**: `node src/cli/launch.js set --stage OFF --reason "..." --actor <name>` | no new checkout or coin purchase anywhere; existing subscriptions, access and coins unchanged; the member view still loads | ~0.3 s, effective on the next request |
| 2 | **Member gateway off** (`MEMBERSHIP2_GATEWAY` not `on`) | every `/api/membership2/*` path answers 404; the app hides the Membership area | ~0.3 s after the proxy restart |
| 3 | **Admin gateway off** (`MEMBERSHIP2_ADMIN` not `on`) | the Control Center Membership 2.0 area disappears; the rest of the console is unchanged | ~0.3 s after the proxy restart |
| 4 | **Code back** to the previous release (proxy rollback per the security-batch runbook; membership service checkout) | previous behaviour | minutes |
| 5 | **Migrations down**, newest first, **only together with step 4** | schema back | seconds |

## Notes that change how you do it

- **Kill switch (steps 2–3): use an `EnvironmentFile=` override, not `Environment=`.** The unit's own
  env file is read after `Environment=` lines, so a drop-in `Environment=MEMBERSHIP2_GATEWAY=off`
  does not win. Add a second `EnvironmentFile=` in a drop-in (it is read last) containing the `off`
  value, `systemctl daemon-reload`, restart, then verify with one GET that the path answers 404.
  Remove the drop-in to restore.
- **The launch CLI reads the ceiling from its own shell.** `launch.js show` warns when
  `MEMBERSHIP2_STAGE_CEILING` is not set there; the API's effective stage comes from its unit
  environment. Check the effective stage through the API/gateway, not the CLI line alone.
- **Code and schema roll back together.** Current code writes `audit_logs.reason` (from 0012); after
  0012 down it fails. Never run migrations down under the current code: do step 4 first, then 5.
- **0010 / 0011 down are refused while any API client (even a revoked one) still holds the
  `member:*` or `admin:operate` scopes.** This fails safely and atomically. First remove those
  scopes from the `api_clients` rows (or delete the revoked clients), then migrate down.
- **0009 down drops the launch history and the pilot list** and comes back at OFF (fails closed).
  Export both first (`SELECT * FROM launch_history`, `SELECT * FROM pilot_members`) so the pilot list
  can be rebuilt.
- **Ledgers are append-only.** Rolling back never deletes payments, coin transactions or audit
  rows; data written by Membership 2.0 stays and is reconciled, not erased.
- **Never** touch GHL or PayPal subscriptions as part of a rollback: they were never changed by
  Membership 2.0 (legacy is read-only).

## After any rollback

1. Verify: `/api/membership2/plans` answers as expected (404 when off); the Control Center loads; the
   Event Manager and door devices work.
2. Run daily reconciliation in dry-run mode and check for open alerts.
3. Record what was done, when and why (the launch history keeps step 1 automatically).
