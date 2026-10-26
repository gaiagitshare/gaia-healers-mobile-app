# Stripe sandbox access — exactly what is needed, and why

**Status: nothing has been run against Stripe.** There is no Stripe key on the
server. This page lists what the owner (Babak) has to provide before
`membership-service/src/cli/stripe-sandbox.js --run` or the staging webhook
receiver can be used, and what each item is for. Everything here is **Stripe
test mode**; live mode is out of scope and refused in code (§7).

## 1. Summary — what the owner provides

| # | Item | Form | Where it goes |
|---|---|---|---|
| 1 | Decision: which Stripe account (§4) | owner decision | — |
| 2 | A **test-mode restricted key** with the permissions in §2 | `rk_test_…` (a full `sk_test_…` only if the owner prefers, §2.3) | `STRIPE_TEST_SECRET_KEY` in `/root/.config/gaia-membership-staging.env` |
| 3 | The **test webhook signing secret** | `whsec_…` | `STRIPE_TEST_WEBHOOK_SECRET` in the same file |
| 4 | Decision: webhook delivery path (§5): Stripe CLI, or an HTTPS staging location | owner decision; option (b) also needs approval of an nginx change | — |
| 5 | Approval of each run (AGENTS.md) | in writing, per run | — |

## 2. The restricted key (`rk_test_…`)

Create it in the Stripe Dashboard **in test mode** (Developers → API keys →
Create restricted key). Name it e.g. `gaia-membership-sandbox`. Give it **only**
the permissions below; leave everything else **None**.

### 2.1 Minimal permissions per scenario

W = Write, R = Read. A Write permission includes Read. "expand" means the
runner asks Stripe to embed that object in the response, which needs Read on it.

| Scenario (runner id) | Requests (max, cleanup included) | Permissions |
|---|---|---|
| A subscription paid | 8 | Products W, Prices W, Customers W, PaymentMethods W (attach test card), Subscriptions W, Invoices R (expand) |
| B declined card | 3 | Customers W, PaymentIntents W |
| E refunds | 6 | Customers W, PaymentIntents W, Charges R (expand), Refunds W |
| H cancel at period end (flag only) | 9 | as A |
| I coin pack one-time charge | 3 | Customers W, PaymentIntents W, Charges R (expand) |
| J reconciliation fetch | 4 | Invoices R, Charges R, Refunds R, Disputes R |
| CHECKOUT hosted checkout session | 8 | Products W, Prices W, Customers W, Checkout Sessions W |
| RENEW renewal on a test clock | 16 | as A, plus **Test clocks W** |
| DUNNING failed renewal, retry | 20 | as A, plus Test clocks W, **Invoices W** (`POST /v1/invoices/{id}/pay`) |
| CANCEL_END cancel at period end on a test clock | 17 | as A, plus Test clocks W |
| CANCEL_NOW immediate cancel | 9 | as A |
| CHANGE_UP upgrade (always_invoice, pending_if_incomplete, failing card) | 17 | as A, plus Invoices W (preview) |
| CHANGE_DOWN downgrade at the period end (test clock, schedule) | 20 | as RENEW, plus Subscription schedules W |
| CHANGE_SWITCH interval switch scheduled, then released | 14 | as A, plus Subscription schedules W |
| 3DS authentication required | 8 | as A |
| EVENTS list recent events | 1 | Events R |

### 2.2 The key, all scenarios together

| Resource (Dashboard name) | Level | Needed by |
|---|---|---|
| Customers | Write | every scenario except J and EVENTS (create, delete in cleanup) |
| Products | Write | subscription scenarios, CHECKOUT (create, archive in cleanup) |
| Prices | Write | as Products |
| PaymentMethods | Write | attaching test cards (`pm_card_visa`, `pm_card_chargeCustomerFail`, `pm_card_authenticationRequired`) |
| Subscriptions | Write | create, update (cancel flag, card, price change), delete (CANCEL_NOW) |
| Subscription schedules | Write | CHANGE_DOWN, CHANGE_SWITCH (create from the subscription, set phases, release); the app's period-end plan changes |
| Checkout Sessions | Write | CHECKOUT (create, expire) |
| PaymentIntents | **Write** | B, E, I create and confirm one-time payments |
| Invoices | **Write** | DUNNING retries the open invoice; CHANGE_UP and the app's upgrade preview call `POST /v1/invoices/create_preview` |
| Charges | Read | E, I (expand), J |
| Refunds | Write | E; J reads them |
| Disputes | Read | J |
| Events | Read | EVENTS |
| Test clocks | Write | RENEW, DUNNING, CANCEL_END, CHANGE_DOWN (create, advance, poll, delete) |

Differences from the first draft of this list, so nobody is surprised:
PaymentIntents must be **Write**, not Read (B, E and I create payment intents);
Invoices must be **Write** for DUNNING; Disputes **Read** is needed by J.
If the owner prefers not to grant Invoices Write, DUNNING stops after checking
`past_due` (its last two checks fail) and everything else still works.

Stripe groups some permissions differently in the Dashboard from time to time.
If a request is refused for a missing permission, the runner prints
`status=403 provider_code=…` for that step and stops the scenario; add exactly
that permission, nothing broader.

### 2.3 A full `sk_test_…` key instead

Acceptable only if the owner prefers it (fewer permission round-trips). It works
with the same code. Downside: it can do anything in test mode, including
deleting test data that GHL or other tests rely on if the account is shared (§4).
Never a live key, of either kind.

## 3. The test webhook signing secret (`whsec_…`)

Needed only for the webhook path (ledger, subscription rows, entitlements), not
for the runner's Stripe-side checks. Which secret depends on §5:

- **Option (a), Stripe CLI:** `stripe listen` prints a `whsec_…` when it starts;
  it is stable for that CLI login. Use that one.
- **Option (b), HTTPS endpoint:** create a webhook endpoint **in test mode**
  (Developers → Webhooks) pointing at the staging URL; its "Signing secret"
  is the value.

Events to subscribe to (what `src/stripe/handlers.js` handles):
`customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`,
`invoice.paid`, `invoice.payment_failed`, `payment_intent.succeeded`,
`charge.refunded`, `refund.created`, `refund.updated`, `charge.refund.updated`,
`charge.dispute.created`, `charge.dispute.closed`. Anything else is stored and
marked `ignored`.

## 4. Which Stripe account — owner decision

| Option | For | Against |
|---|---|---|
| **The account GHL already uses**, test mode | the real account's settings are exercised (Smart Retries / dunning schedule, customer emails, tax, branding, customer portal); the eventual go-live account; no new account to manage | GHL's own test-mode objects and test webhooks share the environment: our test events may reach GHL's test webhook endpoints and theirs reach ours; J and the daily reconciliation will list GHL's test objects too (noise, not harm); whoever creates the key needs Dashboard access to an account that also holds live money |
| **A Stripe Sandbox** in the same account (Stripe's isolated test environments) | isolated from GHL's test mode; still under the same business; keys look the same (`sk_test_`/`rk_test_`), so no code change | settings are copied at creation, not shared, so dunning/email settings may differ from the real account; still needs Dashboard access to the account |
| **A separate Stripe account** | full isolation; can be given to a developer without access to the live business | proves nothing about the real account's settings; products, prices and webhook endpoints must be set up again for go-live |

Recommendation for the owner to weigh: a Sandbox in the GHL account, if Stripe
offers Sandboxes on it; otherwise the GHL account's test mode, with the webhook
endpoint subscribed only to the events in §3.

## 5. Webhook delivery to staging

Stripe cannot reach `127.0.0.1`. The receiver
`membership-service/src/cli/staging-webhook-server.js` listens on
`127.0.0.1:8791` (`--port`, or `STAGING_WEBHOOK_PORT`) at `/v1/webhooks/stripe`.

**(a) Stripe CLI (no server change; recommended first):**

```sh
stripe login                      # pairs the CLI with the account in test mode (browser, an account member)
stripe listen --forward-to http://127.0.0.1:8791/v1/webhooks/stripe \
  --events customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed,payment_intent.succeeded,charge.refunded,refund.created,refund.updated
# put the printed whsec_… into STRIPE_TEST_WEBHOOK_SECRET, then start the receiver
```

The CLI holds its own credential from `stripe login`; it does not need the
restricted key. Only test-mode events are forwarded unless `--live` is passed,
which must never be used here.

**(b) HTTPS staging endpoint (needs owner approval before any nginx change):**
an nginx location such as `https://api.gaiahealers.app/membership-staging/`
proxied to `127.0.0.1:8791`, registered as a **test-mode** webhook endpoint in
Stripe. Required for Dashboard "Resend" and for testing real Stripe retries.
Nothing in this change touches nginx.

**Starting the receiver** (the env file already holds `MEMBERSHIP_DATABASE_URL`
for the staging database; never print the file):

```sh
cd membership-service
( set -a; . /root/.config/gaia-membership-staging.env; set +a; \
  node src/cli/staging-webhook-server.js --batch 10 --interval-ms 5000 )
```

It refuses to start if the database host is not loopback or the secret is not a
`whsec_…` / looks live; it verifies every signature (5-minute tolerance), stores
each event once, refuses livemode events, and processes at most one batch
(≤ 50, default 10) per interval. It calls no external API.

## 6. Webhook retries, duplicates and out-of-order delivery

The runner cannot make Stripe retry. To exercise plan row G:

1. Run a scenario (e.g. `A` or `RENEW`) with the receiver and a delivery path up.
2. `node src/cli/stripe-sandbox.js --scenario EVENTS --run` (1 request) prints
   the last 20 event ids and types.
3. Resend:
   - **Dashboard:** Developers → Events → the event → "Resend" (needs option (b)).
   - **CLI:** `stripe events resend <evt_id> --webhook-endpoint <we_…>` (option (b)).
     With option (a) only, a resend may not reach the CLI session; use (b) or
     `stripe trigger <event>` for a fresh event.
4. Expected: a duplicate is stored once (`{ duplicate: true }`); resending an
   older `customer.subscription.updated` after a newer one is ignored as stale;
   the ledger does not change.

Plan §5 caps Stripe CLI triggers / resends at 10 per run.

## 7. Safety in code

- `stripe-sandbox.js` refuses any `STRIPE_TEST_SECRET_KEY` that is not
  `sk_test_…`/`rk_test_…` (live keys included), even for a dry run; there is no
  live flag. The client (`providers/stripe/client.js`) refuses live keys and
  rejects any live-mode object returned to a test client.
- Hard cap **25 requests per run**, cleanup and retries included, counted at the
  fetch layer (`providers/request-cap.js`). A plan above it is refused before
  anything is sent; the request past it throws. Planned counts are upper bounds
  (test-clock scenarios include up to 5 status polls). The cap is raised only by
  `--max-requests N` for one run, after approval.
- At most 3 scenarios per run; dry run is the default; only fictional
  `@example.invalid` customers; output has ids and statuses only.
- Cleanup removes what the run created: customers deleted, **test clocks
  deleted (with their customers and subscriptions)**, prices and products
  archived; anything left is listed by id.
- The receiver: loopback bind, loopback database only, `whsec_` only, livemode
  events refused.

## 8. Where the secrets live

Append to `/root/.config/gaia-membership-staging.env` (mode 0600, root; it
already holds the staging database settings):

```
STRIPE_TEST_SECRET_KEY=rk_test_…
STRIPE_TEST_WEBHOOK_SECRET=whsec_…
```

Never print, commit or paste this file. The code only reads the environment
variables; nothing reads the file directly.
