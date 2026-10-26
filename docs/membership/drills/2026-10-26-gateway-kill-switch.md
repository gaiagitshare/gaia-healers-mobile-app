# Drill (c): gateway kill switches on staging, 26 Oct 2026

**Result: PASS.** Both `MEMBERSHIP2_GATEWAY` and `MEMBERSHIP2_ADMIN` were turned off and back on, on the staging proxy only.

- **Unit:** `gaia-membership-staging-proxy` (loopback `127.0.0.1:8797`) and nothing else. The production `gaia-staging-proxy` unit was not touched.
- **Config was never printed.** The env file was not edited.

## Mechanism (reusable for production)

The unit loads its env from one `EnvironmentFile`. Systemd applies `EnvironmentFile` after `Environment=`, so a drop-in `Environment=MEMBERSHIP2_GATEWAY=off` would **lose** to the file. The drill used a drop-in that adds a **second** `EnvironmentFile`. Later files override earlier ones.

```ini
# /etc/systemd/system/gaia-membership-staging-proxy.service.d/phase5-killswitch.conf  (temporary)
[Service]
EnvironmentFile=/root/.config/gaia-m2-phase5-killswitch.env   # 0600, one line: MEMBERSHIP2_GATEWAY=off (or MEMBERSHIP2_ADMIN=off)
```

The switch is `systemctl daemon-reload && systemctl restart gaia-membership-staging-proxy`. To restore: remove the drop-in and the file, then daemon-reload and restart. The check afterwards was `systemctl show -p DropInPaths` (empty) and `-p EnvironmentFiles` (only the original file).

## Member gateway (MEMBERSHIP2_GATEWAY)

| Time (UTC) | Step | Result |
|---|---|---|
| 15:11:34.8 | baseline | `/plans` 200; `/me` 401 and `/checkout` 401 (no session) |
| 15:11:35.8 | drop-in on + restart | restart 34 ms; proxy answering after **275 ms** |
| 15:11:35.9 | `GET /plans`, `GET /me`, `POST /checkout` | **404, 404, 404** (`{"ok":false,"error":"Not found"}`, the same body production gives) |
| ≈15:11:40 | staging app `home.html?view=membership` (headless Chromium, every non-loopback host blocked, visitor) | `GaiaMembership2.available()` false; `#m2-root` empty and not visible; `#m2-entry-store` and `#m2-entry-you` hidden; only one membership2 request (the probe, 404); 0 page errors. **The area is hidden** |
| ≈15:11:50 | Control Center (member gateway still off) (console sign-in) | Membership 2.0 nav item present; probe 200. The admin gateway is independent |
| 15:12:11.9 | drop-in removed + restart | restart 69 ms; answering after 433 ms |
| 15:12:12.1 | verify | `/plans` 200; app probe 200; `#m2-root` rendered (6 sections); the Store entry is hidden and the You entry is shown, as in the baseline |

## Admin gateway (MEMBERSHIP2_ADMIN)

| Time (UTC) | Step | Result |
|---|---|---|
| 15:12:40.9 | drop-in on (`MEMBERSHIP2_ADMIN=off`) + restart | restart 52 ms; answering after **268 ms** |
| 15:12:41.0 | signed-in console, `GET /api/admin/membership2/{status,me,overview,persons}` | **404 ×4** `{"ok":false,"reason":"unknown_admin_route"}` |
| 15:12:41.1 | signed out, `GET …/status`; `POST …/login` | **404**, **404** (the same unknown-admin-route body) |
| 15:12:41.2 | member gateway | still on: `/plans` 200 |
| ≈15:12:50 | Control Center (console signed in) | **no Membership 2.0 nav item**; one probe request: 404. The rest of the console was unchanged |
| 15:12:58.1 | drop-in and override file removed + restart | restart 40 ms; answering after 269 ms |
| 15:12:58.3 | verify | signed-in `…/status` 200; `/plans` 200; Control Center nav item back (probe 200); app view back |

**Each switch takes under 0.5 s** from the restart to the first answer. A restart drops in-flight requests only. Member fixture sessions and operator sessions survived it (both are stored, not in memory).

## Staging after the drill

- No drop-in left (`DropInPaths` is empty).
- The override file was deleted.
- Both gateways are on.
- All four staging services are active.
- Launch is unchanged (INTERNAL_PILOT).

## Finding (documentation)

On **production** today, a signed-out `GET /api/admin/membership2/status` answers **401** `admin_auth_required`. Production runs the old admin router, which checks the sign-in before the route, so any unknown admin path gives 401 to a signed-out caller. With the new code, the staging proxy answers **404** whether or not the caller is signed in. The Control Center UI hides the area on both 401 and 404 (`tests/control-center-membership2.test.cjs`), so neither leaks anything. CONTROL-CENTER.md §5 describes only the new behaviour.
