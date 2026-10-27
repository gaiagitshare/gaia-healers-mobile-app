# Drill (b): launch rollback to OFF on staging, 26 Oct 2026

**Result: PASS.** The drill ran twice. Run 2 captured the HTTP codes.

- **Scope:** the staging DB launch state only.
- **Tool:** `membership-service/src/cli/launch.js`, run from the staging checkout with the staging env file. The environment ceiling was INTERNAL_PILOT, the same as the staging API unit.
- **Requests:** go through the staging proxy at `127.0.0.1:8797`, using a fixture member who is on the staging pilot list (`fixture-no-membership`).
- **No Stripe, no GHL.** Stripe is not connected on staging, so a permitted checkout stops at `PROVIDER_UNAVAILABLE`.

## Timings (run 2, UTC)

| Time | Step | Result |
|---|---|---|
| 15:08:22.157 | `launch.js show` | stored INTERNAL_PILOT, ceiling INTERNAL_PILOT, **effective INTERNAL_PILOT**, pilot members 1 |
| 15:08:22.284 | pilot `POST /api/membership2/checkout` | **503** `PROVIDER_UNAVAILABLE` (allowed, billing not connected), 0.09 s |
| 15:08:22.599 | `launch.js set --stage OFF --reason "…" --actor phase5-drill` | `INTERNAL_PILOT → OFF`, **296 ms** CLI round trip |
| 15:08:22.668 | pilot checkout | **200** `{ok:false, status:"not_available", reason:"membership2_off"}`, 0.03 s, **69 ms after the CLI returned**. Takes effect on the next request; no restart, no cache |
| 15:08:22.742 | member-view probe `GET /api/membership2/plans` | **200** (the probe still answers, so the view stays reachable and shows "Not open yet") |
| 15:08:23.310 | `launch.js set --stage INTERNAL_PILOT --reason "…"` | `OFF → INTERNAL_PILOT`, 540 ms |
| 15:08:23.379 | pilot checkout | **503** `PROVIDER_UNAVAILABLE` again (restored) |
| 15:08:23.427 | probe | 200 |

**Total time spent at OFF:** 0.7 s. **Rollback to OFF, end to end:** under 0.4 s.

## Run 1 (15:08:05–15:08:07)

Run 1 showed the same sequence. It also recorded:
- `/me availability` at OFF: `{stage:"OFF", newMembership:false, newMembershipReason:"membership2_off", coinPacks:false}`;
- after the restore: `{stage:"INTERNAL_PILOT", newMembership:true, newMembershipReason:"pilot_member"}`;
- the staging app `home.html?view=membership` answering 200 at OFF.

## Audit trail

`launch_history` has four new append-only rows by `phase5-drill`, each with its reason: INTERNAL_PILOT>OFF and OFF>INTERNAL_PILOT, twice. `audit_logs` has a matching `launch.stage` row for each.

## Staging after the drill

Launch is stored as INTERNAL_PILOT and is effective INTERNAL_PILOT. The pilot list is unchanged (1 member).

## Notes

- A stage change needs no deploy and no restart. The production runbook step "set OFF" is the same command against the production DB, run with the production env.
- Going above INTERNAL_PILOT needs `--approval <GO ref>`. Going back to OFF never does, so the rollback is never blocked by paperwork.
