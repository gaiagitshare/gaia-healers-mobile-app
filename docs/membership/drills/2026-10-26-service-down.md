# Drill (d): membership API down on staging, 26 Oct 2026

**Result: PASS.** The API was down for **6.8 s** (the limit was 60 s).

- **Unit:** `gaia-membership-staging-api` only, stopped and started. The staging proxy, web and admin units, and the database, stayed up.
- **Lock:** the drill ran under the staging lock, after another session had updated staging to migration 0012 and the newer code.
- **Timing:** the drill ran between health-timer runs, so the 15-minute health check never saw the unit down.

## Timings (UTC)

| Time | Step | Result |
|---|---|---|
| 15:19:44.120 | baseline `GET /api/membership2/plans` (visitor) | 200 |
| 15:19:44.263 | baseline `GET /me` (pilot fixture session) | 200 |
| 15:19:44.377 | `systemctl stop gaia-membership-staging-api` | stopped in 63 ms; `inactive` |
| 15:19:44.432 | `GET /plans` | **503** `PROVIDER_UNAVAILABLE` in **6 ms** (connection refused, no hang) |
| 15:19:44.478 | `GET /me` | **503** `PROVIDER_UNAVAILABLE` in 4 ms |
| 15:19:44.516 | `POST /checkout` | **503** `PROVIDER_UNAVAILABLE` in 4 ms. Nothing written |
| 15:19:44.572 | `GET /api/admin/membership2/status` (signed out) | 401 `admin_auth_required`. The console check comes first, so this request never reaches the service |
| 15:19:44–50 | staging app `home.html?view=membership` (headless Chromium, non-loopback blocked) | probe 503, then `available()` false, `#m2-root` empty and hidden, both entry cards hidden, 0 page errors. **The app falls back to its safe state:** the Membership 2.0 area disappears (the landing screen itself was not captured; `normalizeView` maps `?view=membership` to Store › Membership, as covered by the VIEW test) |
| ≈15:19:50.3 | `systemctl start gaia-membership-staging-api` | — |
| 15:19:51.067 | first `GET /plans` 200 through the gateway | healthy **746 ms** after the start. **Total downtime 6 770 ms** |
| 15:19:51.1–.2 | `/plans` 200, `/me` 200, checkout 503 `PROVIDER_UNAVAILABLE` ("billing is not connected", the normal staging answer) | back to normal |
| 15:19:51.265 | API `GET /v1/health` direct | 200 |

The "silent service" case (it accepts the connection but never answers) cannot be shown safely on staging. It is covered on local Postgres by `membership-service/test/e2e-parallel-flows.test.js` › membership service down…: the gateway answers 503 after its fixed 8 s timeout and never hangs.

## Staging after the drill

- All four staging units are active.
- Launch is INTERNAL_PILOT.
- Both gateways are on: `/plans` 200; admin status 401 when signed out.
- No drop-ins.

## Findings

1. **Same code for two causes.** The member gateway answers a service outage with `PROVIDER_UNAVAILABLE` (`staging-proxy/membership2-gateway.js`, lines 60–61 and 89). Checkout without Stripe uses the same code. The member view maps that code to "Billing isn't connected in this environment… nothing has been charged". On a real outage the wording is wrong, although it stays safe and the money statement stays true. Suggestion: a distinct `message`/`reason` (`service_unavailable`), with the generic "temporarily unavailable" copy for it.
2. **8 s bound.** The gateway timeout is fixed at 8 s (`membership2-gateway.js` line 57) for every route. A hung service makes each member request wait 8 s. That is acceptable as a hard bound, but a shorter one for the GET routes (2–3 s) would be friendlier.
3. With the probe failing, a signed-in member sees no error at all: the area just disappears. That is the designed fail-closed behaviour. The view's own "Your membership couldn't load" state appears only when `/plans` works and `/me` fails.
