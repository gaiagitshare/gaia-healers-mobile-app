# Gaia Healers Membership 2.0 — customer view (preview)

`home.html?view=membership`, rendered by `gaia-membership2.js` + `gaia-membership2.css`.
Built on the member gateway `/api/membership2/*` (PR #305). Not deployed.

## Rule

The view **renders** what the API says and decides nothing. No plan names,
prices, coin amounts, tier rules or "months free" figures are in the source
(`tests/membership2-view.test.cjs`, and the file is now in the frontend guard's
`APP_FILES` in `staging-proxy/test/membership-frontend-guard.test.js`).

## Feature probe and reachability

- On load the module calls `GET /api/membership2/plans`. Only a 200 with a
  `plans` array makes the view available (`window.GaiaMembership2.available()`).
- Before that, or when it fails (gateway OFF = 404, as production answers
  today), `#m2-root` stays empty, both entry slots (`#m2-entry-store`,
  `#m2-entry-you`) stay `hidden` and empty, and `gaia-ui.js normalizeView`
  maps `?view=membership` to `store` with the Membership tab.
- Once the probe succeeds, a "Gaia Healers Membership 2.0 — preview" card
  appears under Store › Membership and on the You screen. Each follows the
  visibility of its host panel. Neither panel changes otherwise.
- The view is **not** added to `GaiaAssistGuide.screens`. That map is also the
  assistant's app map, so leaving it out adds **0 tokens** to each assistant
  turn, and the production prompt does not change while the view cannot be
  reached. While the view is open, the assistant's page hint says `store`
  (the home of Membership). Voice `navigate` cannot open the view.

## API mapping

| UI section | API |
|---|---|
| Plan comparison (Monthly / Annual toggle, coins, benefits, current plan) | `GET /plans` → `plans[].{name,rank,monthlyCoins,prices,benefits[].label}`; current plan = the `/me membership[]` row with `hasAccess` |
| Annual price, "N months free", per-month equivalent | computed from `prices.year` and `prices.month` (`round((12·month − year) / month)`) |
| Choose plan | `POST /checkout {planKey, interval, requestId}` → `location.assign(url)` (https only) |
| My membership | `GET /me` `membership[]` (status, plan, interval, renewal `current_period_end`, `cancel_at` banner, trial end) and `access[]` (labels from the plan benefits) |
| Coins | `/me` `wallet.{granted,goodwill,purchased,legacy,total}.{coins,usd}`, `spendOrder`, `nextGrantAt`; goodwill is its own tile ("never expire") when the API sends it, and the spend order is listed in its words; history `GET /me/coins` `items[]` (net = sum of `byBalance`) |
| Coin packs | `/plans` `coinPacks[]` → `POST /coins/checkout {packKey, requestId}`; empty → "Coin packs are coming soon." |
| Change plan | "Change plan" points at the plan list. With a live plan, each card offers "Switch to {plan}" (or "Switch to annual / monthly billing" on the current plan) for the selected interval → `POST /subscriptions/:id/change-preview {planKey, interval}` → `GaiaNotice.confirm` in plain words from the answer: `timing=after_payment`: "You'll be charged {amountDueNowCents} today and get {plan} right after payment"; `period_end`: "Your plan changes to {plan} on {effectiveAt}; you keep {current} until then" → `POST /subscriptions/:id/change {planKey, interval, prorationDate, requestId}` → outcome `scheduled` / `processing` / `payment_required` notice + refresh. The view never decides upgrade vs downgrade. |
| Pending change | `/me membership[].pendingChange`: `scheduled` → "Plan change scheduled" banner + **Keep my current plan** (`POST /subscriptions/:id/change/cancel {requestId}`); `pending_payment` with `paymentRequired` → "Payment required" banner + Complete payment (https `paymentUrl` only); otherwise "on its way". Change buttons are hidden while a change is pending. |
| Environment | `/plans` `environment` + `stripeMode`: anything except `production` with `live` shows a small "STAGING / TEST MODE" marker above the title. |
| Billing history | `GET /me/billing` `items[]` (date, what, type, amount). Invoices and payment methods: "managed securely by Stripe" note only. No card form. |
| Cancellation | `POST /subscriptions/:id/cancel-preview` → `GaiaNotice.confirm` with the exact `accessEndsAt` → `POST /subscriptions/:id/cancel {requestId}` → banner + refresh |
| Legacy membership | `/me legacy[]` with state `active`/`under_review`: tier, "billed through your existing plan", paid-through date. No buy buttons ("Your account team can move you"). |
| Migration offers | `/me migrationOffers[]`: `offered` → Accept (`POST /migration/:id/accept`); `accepted`/`checkout_started` → Continue to checkout (`POST /migration/:id/checkout {requestId}`) |
| Return from Stripe | `?checkout=done|cancelled|coins|migrated` → toast + notice, data reload, parameter removed |

Every write uses one `postJson()`: a JSON body, `credentials: 'include'`, and a
`requestId` (`m2-` + `crypto.randomUUID()`, `[A-Za-z0-9_-]`, ≤ 64 chars). The
id is kept per action. A network failure or a 5xx keeps it, so **Try again**
sends the same id and the server's idempotency key does the rest. Any other
answer ends the action.

`/me` is called only after the shell reports a signed-in session (`gaia:auth`).
A visitor sees the plans, a Sign in prompt and no 401s.

## States and copy

| Server answer | Member sees |
|---|---|
| `availability.newMembership === false` (`pilot_only`, `migration_not_open`, `membership2_off`, `limited_cap_reached`) | "Not open yet" (also a hint above the plans). No POST is sent. |
| `legacy_member_use_migration` / `migration_required` | "You already have a Gaia Healers {Tier} membership, billed through your existing plan. Your Gaia Healers account team can move you…" |
| `review_required` | "A quick check first… Nothing has been charged." |
| `change_plan_required`, `existing_customer` | "Change your plan below" (points at the plan list) |
| `change_pending` | "A plan change is already waiting" |
| `not_changeable` (`cancel_scheduled` / other) | "Your cancellation is scheduled" / "This plan can't be changed right now" |
| `preview_expired` | "Please check the amount again" |
| `no_pending_change`, `not_cancellable` | "Nothing to cancel" / "This change is waiting for payment" |
| `SERVICE_UNAVAILABLE` (gateway: the membership service is unreachable, timed out or failed) | "Membership is temporarily unavailable" + Try again + support (never the billing message) |
| `already_subscribed` | "You already have this plan" |
| `PROVIDER_UNAVAILABLE` | "Billing isn't connected in this environment. Checkout is temporarily unavailable, so nothing has been charged." + Try again + Contact Gaia Healers Support |
| 401 | "Please sign in" + Sign in |
| network / other 5xx | error notice + Try again + Contact Gaia Healers Support (`https://gaiahealers.com/pages/contact-us`, the link the app already uses) |
| `/me` fails to load | "Your membership couldn't load" + Try again + support |

Accessibility: every action is a `<button>` with a text or `aria-label`. There
is a polite live region. Action notices take focus (`tabindex=-1`). Sections
are labelled by their headings, and the interval toggle uses `aria-pressed`.
`:focus-visible` rings come from the g-* tokens. The layout is one column at
390 px, 2 at ≥ 700 px and 4 plans at ≥ 1100 px.

## Real-staging evidence (`docs/membership/view-evidence/`)

Run on 2026-10-26 against the staging app (`127.0.0.1:8798`), the staging
proxy (`127.0.0.1:8797`, gateway ON) and the staging membership API and DB.
The browser was Playwright Chromium with every non-loopback host blocked.
Fixture sessions came from `/api/dev/fixture-session`.

| File | Shows |
|---|---|
| `01-free-dashboard-plans-monthly-1280.png` | fixture-free, full page: dashboard ("no plan yet"), 4 plans monthly, coins, "coming soon" packs, billing + Stripe note |
| `02-plans-annual-1280.png` | Annual toggle: yearly prices, per-month equivalent, "2 months free" derived from the API |
| `03-plans-annual-390.png` | Annual plans on mobile |
| `04-free-not-open-yet-1280.png` | fixture-free clicks Choose Standard → "Not open yet" (INTERNAL_PILOT, not a pilot member; no POST sent) |
| `05-free-dashboard-390.png` | Top of the view on mobile, free member |
| `06-pilot-billing-not-connected-1280.png` | fixture-no-membership, added to the staging pilot list → real `POST /checkout` → 503 `PROVIDER_UNAVAILABLE` → "Billing isn't connected in this environment"; Try again re-sent the **same** requestId |
| `07-pilot-billing-not-connected-390.png` | Same on mobile |
| `08-legacy-member-1280.png` | fixture-silver-monthly with a fixture legacy row (Silver, paid through) + an open migration offer: no buy buttons, "billed through your existing plan", Accept offer |
| `09-legacy-accept-then-checkout-390.png` | Accept (real 200 `accepted`) → Continue to checkout (real 503 `PROVIDER_UNAVAILABLE`) → notice |
| `10-store-entry-390.png` | Entry card under Store › Membership (probe succeeded); a click opens the view |

Also checked in the same run (no screenshot):
- **Gateway OFF.** Every `/api/membership2/*` was answered with the proxy's off-state 404 (the live production proxy answers 404 to `/api/membership2/plans` today). `?view=membership` landed on Store with the Membership tab open. Both entry slots stayed hidden and empty, `#m2-root` stayed empty, and the only membership2 request was the probe.
- A visitor (no session) sees the plans and a Sign in prompt, with no membership2 401s.
- **Console.** No page errors. The only membership2 console lines are the browser's "Failed to load resource" for the four intentional 503 `PROVIDER_UNAVAILABLE` answers. The other lines are this staging stack's existing 503s (`/api/member/*`, `/api/wellness/*`, `/api/academy/manifest`: no GHL on staging).
- **The one stub.** `GET /api/assist/onboarding` was answered `{state:'complete'}` in the browser. The onboarding gate reads GHL, which staging has no access to, so without the stub every signed-in fixture stops at "Let's reconnect". No membership call was stubbed.
- `staging-proxy/assist-guide.js` was missing from the staging web root. The sync excludes `staging-proxy/`, so `gaia-ui.js` could not boot there. It was copied into `web/staging-proxy/` on staging only.

Staging data created for the run (fixtures only):
- the pilot member: fixture-no-membership's person, actor `staging-view-test`
- `legacy_memberships` row `fixture-sub-legacy-silver` for contact `fixture-silver-monthly`. Its `last_seen_at` equals the existing mirror maximum, so the mirror-freshness check did not change. The 34 mirrored rows were not touched.
- one `migration_offers` row (Standard monthly, `offered_by staging-view-test`), which the run left `accepted`.

## Pending owner decisions

1. **Coin pack prices.** `coinPacks` is empty, so the view says "Coin packs are coming soon". Packs appear without a code change once they are active.
2. **Plan changes and proration.** Decided 2026-10-26 and built (upgrade after payment, downgrade / interval switch at the period end). Copy review of the confirm and banner wording is still open.
3. **Stripe Customer Portal.** Invoices and payment methods only show a "managed securely by Stripe" note. A portal link is one button once it is approved.
4. **Copy review.** The "Preview" kicker and the "Not open yet" / "account team can move you" wording.

## Tests

- `tests/membership2-view.test.cjs` (13 static contracts; plan change, goodwill and the staging marker added 2026-10-26). It checks: no prices or tier logic; one POST path that always sends a requestId and keeps it for a retry; hidden until the probe succeeds; not in the assistant screen map; "Gaia Healers" copy; no card fields; copy for every server status; legacy members get no buy buttons; accessibility hooks.
- `staging-proxy/test/membership-frontend-guard.test.js`: `gaia-membership2.js` was added to `APP_FILES`, so the no-tier-regex / no-tier-test guards cover it.
- `staging-proxy/test/member-readings-ai-boundary.test.js`: the `pageContext` pattern was updated for the one added line that reports `membership` as `store`. The assertion is otherwise the same: only the screen and an item id are sent. On a mismatch, node's assert diffs the whole of `gaia-ui.js`, which looked like a hang rather than a failure.
