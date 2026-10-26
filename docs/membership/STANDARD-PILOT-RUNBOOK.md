# First real sandbox run: one Gaia Standard membership (Stripe TEST mode, staging)

The runs in this document are real: the Stripe test-mode API, real Stripe webhooks, and the real staging database. No fakes are involved. Test mode moves no money. **Nothing here runs until the owner approves it.**

## Budget: 14 of 25 Stripe API requests (ledger-enforced)

Ledger: `/root/.config/gaia-stripe-sandbox-budget.json`, budget 25. Each step reserves its full count before sending anything. The reservation is never refunded, and the budget cannot be raised. Automatic retries are off, so no request is sent that wasn't counted.

| Step | Stripe requests | What |
|---|---|---|
| `listener` | 3 (reserve) | the Stripe CLI's own calls (webhook session); booked before the CLI starts |
| `start` | 6 | product check, product create, price lookup, price create (first run only), customer create, Checkout Session create |
| (payment) | 0 API | the tester pays on Stripe's hosted page with `4242 4242 4242 4242`, any future date, any CVC |
| `verify` | 4 | reconciliation: one page each of invoices, charges, refunds, disputes |
| `cancel` | 1 | cancel the test subscription |
| **Total** | **14** | **11 left in the budget for one retry of a failed step, after diagnosis** |

`node src/cli/staging-standard-pilot.js plan` prints these counts from the live staging state. It sends nothing. Ran 26 Oct 2026: 14, fits.

## Minimum restricted key (`rk_test_…`) for this scenario

| Resource | Access | Used by |
|---|---|---|
| Products | Write | product check + create |
| Prices | Write | price lookup + create |
| Customers | Write | customer create |
| Checkout Sessions | Write | session create |
| Subscriptions | Write | cancel |
| Invoices | Read | reconciliation |
| Charges | Read | reconciliation (refunds and disputes expand their charge) |
| Refunds | Read | reconciliation |
| Disputes | Read | reconciliation |
| Webhook / CLI access for `stripe listen` | see below | the listener |

Not needed for this scenario: PaymentIntents, PaymentMethods, Test clocks and Events (the full 14-scenario plan needs them later).

**`stripe listen` with a restricted key.** Stripe's docs say the CLI accepts any key via `--api-key` or `STRIPE_API_KEY`, but they don't name the permission `listen` needs. The order to try:

1. Run the same `rk_test_` with the listener. A missing permission fails immediately (inside the 3 reserved requests).
2. If that is refused, run `stripe login` inside the container. The owner approves it in the browser, and Stripe creates the CLI's own **restricted** keys (90-day). No full secret key is required.
3. A full `sk_test_` key only if both fail, after approval.

## Stripe CLI without installing anything on the server

Use the official Docker image as a throwaway container. Nothing is installed on the host and no volume is mounted. The key comes from the existing 0600 env file, and the container is removed on exit. **Pulling the image needs approval:** it comes from Docker Hub `stripe/stripe-cli`, pinned to a release tag and recorded by digest when pulled.

```bash
# 1. print the webhook signing secret for this listener (put it into STRIPE_TEST_WEBHOOK_SECRET in the staging env file)
docker run --rm --network host --env-file <(grep '^STRIPE_TEST_SECRET_KEY=' /root/.config/gaia-membership-staging.env | sed 's/^STRIPE_TEST_SECRET_KEY=/STRIPE_API_KEY=/') \
  stripe/stripe-cli:<pinned-tag> listen --print-secret
# 2. forward events to the loopback receiver
docker run --rm --name gaia-stripe-cli --network host --env-file <(…same…) stripe/stripe-cli:<pinned-tag> listen \
  --forward-to http://127.0.0.1:8791/v1/webhooks/stripe \
  --events customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed
# afterwards: docker rmi stripe/stripe-cli:<pinned-tag>
```

`--network host` is only so the container can reach the loopback receiver. The receiver binds 127.0.0.1, uses the staging database only, refuses live events, and verifies every signature.

## Steps (each needs the owner's go)

0. Put `STRIPE_TEST_SECRET_KEY` into `/root/.config/gaia-membership-staging.env`. If the legacy mirror is older than 36 h (`plan` shows its age), refresh it with the read-only legacy import (about 20 GHL GETs). The duplicate-billing guard refuses otherwise.
1. `node src/cli/staging-standard-pilot.js listener --run`, which books the 3. Then start the CLI container (above). Put the printed `whsec_` into `STRIPE_TEST_WEBHOOK_SECRET` and start the receiver: `node src/cli/staging-webhook-server.js`.
2. `node src/cli/staging-standard-pilot.js start --run`. It:
   - seeds the plan catalog (database only);
   - creates the fictional member (`pilot-standard-<stamp>@example.invalid`);
   - checks the guard;
   - prints the **Checkout URL**.
3. The tester opens the URL and pays with `4242 4242 4242 4242`. Stripe sends `customer.subscription.created` and `invoice.paid`. The receiver verifies, stores and processes them, and the membership becomes active in staging.
4. `node src/cli/staging-standard-pilot.js verify --run`. Pass criteria:
   - the membership is active on Standard;
   - exactly one $47.00 USD charge is in the payment ledger;
   - 500 coins are granted (by the monthly allowance job);
   - Standard entitlements are on and Professional-only ones are off;
   - reconciliation shows 0 mismatches.
5. `node src/cli/staging-standard-pilot.js cancel --run`. The `customer.subscription.deleted` webhook then ends it in staging.
6. Stop the CLI container and the receiver, and remove the image.

All steps print ids and statuses only. The member's email and the keys are never printed.

## Off-site decrypt-and-restore test (for the private-key holder)

The server only holds the public backup key. That is deliberate, and nobody should send the private key anywhere. On the key holder's own machine:

1. Download one staging dump from R2, under `…/membership-staging/membership-staging-<stamp>.dump.gpg` (the same remote as the production backups).
2. `gpg -d membership-staging-<stamp>.dump.gpg > m.dump`. This needs the backup private key, which never leaves that machine.
3. `docker run --rm -d --name restore-test -e POSTGRES_PASSWORD=x -p 127.0.0.1:55999:5432 postgres:16-alpine`
4. `pg_restore --no-owner --no-privileges -h 127.0.0.1 -p 55999 -U postgres -d postgres m.dump` (password `x`).
5. Check and report back:
   - `select count(*) from membership.legacy_memberships` = 34 (as of 26 Oct);
   - `select count(*) from membership.wallet_mismatches()` = 0;
   - `select string_agg(id, ',' order by id) from public.membership_schema_migrations` lists 0001–0008.
6. `docker rm -f restore-test` and delete `m.dump`.

On 26 Oct the same dump format was restored and verified on the server, before encryption. Only this decryption step remains untested.
