# Production membership database: deployment plan (existing server)

**Status:** plan only. Nothing here is created or activated until the owner approves it in writing. It mirrors the staging setup that has been running since 26 Oct 2026.

## Shape

| | Staging (running) | Production (planned) |
|---|---|---|
| Container | `gaia-membership-staging-db`, postgres:16-alpine | `gaia-membership-db`, same image, pinned by digest |
| Network | `127.0.0.1:55500` only | `127.0.0.1:55510` only, no public port, no nginx route |
| Limits | 512 MB, 1 CPU, 40 connections | 1 GB, 1 CPU, 60 connections (recheck against usage after the pilot) |
| Storage | docker volume `gaia-membership-staging-data` | docker volume `gaia-membership-data` |
| Credentials | `/root/.config/gaia-membership-staging.env` (0600) | `/root/.config/gaia-membership.env` (0600). Different passwords and file, never shared with staging |
| Roles | `staging_admin` (migrations), `membership_app` (data only) | `membership_admin` (migrations only, used by hand), `membership_app` (DML only), optional `membership_readonly` for reports |
| Backup | nightly encrypted dump (GPG to the backup key) to local + R2, verified | same script, plus WAL archiving for point-in-time recovery (`archive_command` to R2), keep 30 days |
| Monitoring | `gaia-membership-staging-health.timer` (15 min) | same checks, with alerts wired into the Control Center System Alerts |

## Host capacity (checked 26 Oct 2026)

- 4 vCPU, 7.8 GB RAM (about 5.6 GB available), disk 73% used (20 GB free).
- The membership data is small: staging is 9 MB with the full legacy mirror. Expect under 1 GB in year one.
- **Disk is the constraint.** Before production, free or add disk so usage stays under 75%. The health check warns at 85%.

## Order of activation (each step needs owner approval)

1. Create the container, roles and credentials. Run `migrate up` as `membership_admin`. Data roles get grants only.
2. Point the backup script at production. Run it once, then restore-test into a temporary database (the same procedure as staging, below). Enable the timer.
3. Seed the catalog: plan versions for the four tiers. No customers, no legacy import yet.
4. Run the legacy import (read-only, capped) and review the list with the owner.
5. Connect the proxy to the internal API, read-only first (entitlement checks in shadow mode, compared with the current resolver, no user-visible change).
6. Turn on billing paths only after the Stripe sandbox sign-off and the live billing decisions.

## Restore procedure (tested on staging 26 Oct 2026)

1. Get the encrypted dump: local copy or R2 `…/membership-staging/` (production: `…/membership/`).
2. **The server cannot decrypt.** Only the public key is on the server, so the key holder decrypts on their own machine: `gpg -d membership-<stamp>.dump.gpg > m.dump`.
3. `createdb <temp>` and `pg_restore --no-owner --no-privileges -d <temp> m.dump`.
4. Check:
   - row counts per table equal the source;
   - `select count(*) from membership.wallet_mismatches()` = 0;
   - migrations listed;
   - triggers present;
   - append-only enforced.
5. Promote by repointing `MEMBERSHIP_DATABASE_URL`, or keep it for inspection, then drop it.

## Not done here

- No production database was created.
- No credentials were generated.
- No timer was installed.
- No proxy wiring was done.
