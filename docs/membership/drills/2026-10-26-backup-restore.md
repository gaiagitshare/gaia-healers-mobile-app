# Drill (a): staging backup and restore, 26 Oct 2026

**Result: PASS.** The off-site decrypt step is **BLOCKED (A4)**. Only the private-key holder can run it, on their own machine.

- **Scope:** the staging membership database only (container `gaia-membership-staging-db`, loopback). Production has no membership database.
- **Lock:** `gaia-membership-staging.lock` was held for the whole drill and released afterwards.

## Steps and results

| # | Step (UTC) | Result |
|---|---|---|
| 1 | 15:06:32. Baseline: the four staging services are active; launch is INTERNAL_PILOT (1 pilot member); migrations 0001–0011 | recorded |
| 2 | 15:06:37. `systemctl start gaia-membership-staging-backup.service` (the nightly unit, run once by hand) | `Result=success`, exit 0, **2.1 s**. Journal: `off-site: verified (35788 bytes)`, `backup membership-staging-20261026T150639Z.dump.gpg (35788 bytes)` |
| 3 | The new local file | mode 0600, 35 788 bytes. It is a public-key-encrypted packet plus an AEAD-encrypted data packet (`gpg --list-packets`, no decryption). **The backup keyring holds no secret key**, so the server cannot decrypt its own backups. This is by design. |
| 4 | 15:06:45. Restore. The local `.gpg` cannot be decrypted on the server, so the restore used a plaintext `pg_dump -Fc` taken inside the container at the same moment, with the same command the backup unit runs before it encrypts. That dump was restored into the temporary database `p5_restore_drill_20261026` with `pg_restore --no-owner --no-privileges` | exit 0. Dump and restore took **2.7 s** |
| 5 | Row counts compared for every table: 37 `membership.*` tables plus `public.membership_schema_migrations` | **38 of 38 equal** (table below) |
| 6 | Integrity checks on both databases | `wallet_mismatches()` = 0 on both. Migrations 0001–0011 on both. 13 triggers and 6 functions on both. On the restored copy, `UPDATE audit_logs` is refused (append-only) |
| 7 | Clean-up: `dropdb p5_restore_drill_20261026`, and the plaintext dump deleted inside the container | no `p5_%` database is left. The container's `/tmp` is empty |

## Row counts (live = restored)

| Table | Rows | | Table | Rows |
|---|---|---|---|---|
| admin_action_requests | 6 | | migration_offers | 1 |
| api_clients | 2 | | operator_sessions | 6 |
| audit_logs | 68 | | operators | 3 |
| coin_action_prices | 0 | | payment_ledger | 1 |
| coin_operations | 4 | | person_identities | 6 |
| coin_packages | 3 | | person_notes | 0 |
| coin_quotes | 0 | | persons | 3 |
| coin_refund_reviews | 0 | | pilot_members | 1 |
| coin_transactions | 4 | | plan_version_entitlements | 74 |
| coin_wallets | 1 | | plan_version_prices | 7 |
| entitlement_definitions | 31 | | plan_versions | 4 |
| entitlement_grants | 0 | | plans | 4 |
| ghl_expected_grants | 0 | | provider_price_refs | 0 |
| ghl_sync_dead_letters | 0 | | reconciliation_alerts | 0 |
| launch_history | 1 | | reconciliation_daily_runs | 0 |
| launch_state | 1 | | reconciliation_runs | 0 |
| legacy_memberships | 35 | | subscription_events | 0 |
| legacy_reader_runs | 2 | | subscriptions | 0 |
| | | | webhook_events | 0 |
| | | | public.membership_schema_migrations | 11 |

There are 35 legacy rows: the 34 mirrored GHL rows plus the one fixture row from the member-view staging run.

## Still open

- **Off-site decrypt-and-restore: BLOCKED (A4).** The key holder runs the procedure in STANDARD-PILOT-RUNBOOK.md ("Off-site decrypt-and-restore test") on the 15:06:39 object or a later one. The private key is never requested and never comes to the server.
- **Gap.** The restore proves the dump format and the restore procedure. It does not prove that this exact encrypted file decrypts, and nobody can prove that on the server. A4 closes it.

## Staging after the drill

Unchanged: same services active, launch INTERNAL_PILOT, both gateways on. The only addition is one more encrypted backup file in the local backup directory and off-site; the unit keeps 7.
