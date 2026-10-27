# Production isolation evidence, 26 Oct 2026, 15:00–15:02 UTC

**Result: PASS.** Production does not run Membership 2.0 and was not changed.

All checks were read-only:
- no unit, nginx, Event Manager, device, printer or account change;
- two GETs to the production proxy on its loopback port;
- one more GET to show what an unknown admin path answers;
- variable **names** only, never values.

| # | Check | Command (shape) | Result |
|---|---|---|---|
| 1 | Production proxy active | `systemctl is-active gaia-staging-proxy` | `active` |
| 2 | Member gateway not served | one `GET http://127.0.0.1:<prod port>/api/membership2/plans` | **404** `{"ok":false,"error":"Not found"}` |
| 3 | Admin gateway not served | one `GET …/api/admin/membership2/status` (signed out) | **401** `{"ok":false,"reason":"admin_auth_required"}`. This is the production admin router's answer to **any** admin path when signed out: an extra `GET /api/admin/phase5-no-such-route` gives the same 401. No Membership 2.0 code answers it. The Control Center hides the area on 401 as well as on 404 |
| 4 | No `MEMBERSHIP2_*` in the unit environment | `systemctl show -p Environment gaia-staging-proxy \| grep -oE 'MEMBERSHIP2?_[A-Z0-9_]*='` | **0 names** |
| 5 | No `MEMBERSHIP*` in the unit's EnvironmentFile | `grep -oE '^MEMBERSHIP[A-Z0-9_]*' <env file>` (names only) | **0 names** |
| 6 | No `MEMBERSHIP*` in the running process | `/proc/<MainPID>/environ`, names only | **0 names** |
| 7 | No gateway code on the production proxy | `ls <prod proxy>/membership2-gateway.js membership2-admin-gateway.js` | both **absent** |
| 8 | No Membership 2.0 file in the admin shell | `ls /var/www/gaia-admin/gadmin-membership2.js` | **absent**. The directory holds `gadmin.css`, `gadmin.js`, `gaia-mark.svg` and `index.html` |
| 9 | Event Manager still active | `systemctl list-units` | `gaia-event-manager.service active running` |

## Context

- The staging stack runs beside production on loopback only, as its own units:
  - `gaia-membership-staging-api` (8792);
  - `gaia-membership-staging-proxy` (8797);
  - `gaia-membership-staging-web` (8798);
  - `gaia-membership-staging-admin` (8799).
  
  Every Phase 5 drill touched only these units and the staging DB container.
- `gaia-membership-reconcile.timer` runs every 5 minutes. It is the **current production** membership refresh from GHL (`membership-reconcile.mjs` in the production proxy), not Membership 2.0. The drills did not touch it.
- Code-level isolation is tested in every runner pass (TEST-MATRIX rows PI-07 to PI-09):
  - both gateways are 404 without their env;
  - the launch ceiling defaults to OFF;
  - the Event Manager / admin-shell boundary is unchanged.
