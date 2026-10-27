# First real sandbox run: one Gaia Standard membership (Stripe TEST mode, staging)

No fakes. Fictional staging member only. Test-mode credentials only. Production billing, GHL, customer records and the Event Manager are not touched.

The runs in this document are real: the Stripe test-mode API, real Stripe webhooks, and the real staging database. No fakes are involved. Test mode moves no money. **Nothing here runs until the owner approves it.**

## Budget: 12 application requests (ledger-enforced) + 3 booked for the Stripe CLI = 15 of 25

**Application calls.** The ledger guarantees these. Each step reserves its full count before sending anything, its cap equals that count at the fetch layer, and automatic retries are off.

| Step | Stripe API requests | What |
|---|---|---|
| `whoami` | 1 | `GET /v1/account`: the key's account must equal `EXPECTED_STRIPE_ACCOUNT_ID` |
| `start` | 6 | product check, product create, price lookup, price create (first run), customer create, Checkout Session create |
| payment | 0 | the tester pays on Stripe's hosted page (browser, not our key) |
| webhooks | 0 | the receiver, processor, handlers and coin/entitlement jobs make **no** Stripe calls (checked in code: no Stripe client in that path) |
| `verify` | 4 | reconciliation: one page each of invoices, charges, refunds, disputes |
| `cancel` | 1 | `cancel_at_period_end=true` on the subscription |
| `status` | 0 | database only |
| **Application total** | **12** | |

**Stripe CLI calls.** These are outside the application, and the ledger **cannot** enforce them. When `stripe listen` starts it authenticates and opens a webhook session: about 1–2 HTTPS requests, plus one long-lived websocket. Events arriving over the websocket are not API requests. A network drop can make it reconnect, which adds session requests our code cannot cap. They are booked as a **reserve of 3** (`listener` step) for accounting. Keep the listener short-lived: start it right before `start` and stop it right after `cancel`. Stripe Dashboard → Developers → Logs shows every request the key made, so the owner can audit the real count afterwards.

## Minimum restricted key (`rk_test_…`) for this scenario

- **Write:** Products, Prices, Customers, Checkout Sessions, Subscriptions.
- **Read:** Invoices, Charges, Refunds, Disputes.
- **Account details (Read)**, for `whoami`. If the Dashboard offers no such permission for restricted keys, `whoami` fails cleanly (1 request). `start` then checks the created price id against `EXPECTED_STRIPE_ACCOUNT_FRAGMENT` before any customer or checkout exists.
- The `stripe listen` permission is not documented. Try this key first; if it is refused, run `stripe login` inside the container (the CLI's own restricted key). A full `sk_test_` key only if both fail, after approval.

## Correct Gaia Stripe account

- The owner puts the account id shown in the Stripe Dashboard (Settings → Business → Account details, `acct_…`; not a secret) into the staging env file as `EXPECTED_STRIPE_ACCOUNT_ID`.
- `whoami` refuses to continue on a mismatch, and `start` refuses until `whoami` has passed.
- **Same account as GHL?** All live GHL tier prices share one account-specific id fragment. If the owner decides the sandbox must be the GHL-connected account, also set `EXPECTED_STRIPE_ACCOUNT_FRAGMENT` (ask me for the value; it is not a secret). The first created price must then carry it, or the run stops before any customer or checkout.

## Cancellation = our entitlement policy

`cancel` sets **cancel at period end** (spec §15, click-to-cancel). The member keeps Standard access until the paid period ends, and the step prints that exact date. Stripe then sends `customer.subscription.updated` with `cancel_at`. At the period end Stripe ends the subscription (`customer.subscription.deleted`): access stops, no renewal is billed, and the next allowance run expires the granted coins. Nothing is charged after the cancel.

## Stripe CLI: throwaway, isolated container (validated 26 Oct, image NOT pulled)

`membership-service/scripts/stripe-cli-listener.sh`, pinned to `stripe/stripe-cli:v1.53.1` (released 7 Oct 2026; newer releases are under 2 weeks old):
- `--pull=never`, so it never fetches by itself;
- read-only root filesystem, tmpfs for scratch, all capabilities dropped, `no-new-privileges`, 128 MB, 64 processes;
- no host mounts; `--rm`;
- host networking only to reach the loopback receiver;
- the key comes from the 0600 env file through an anonymous pipe;
- the webhook secret is written into the env file and never printed.

`validate` proved all of this with a local image, and proved the Stripe image is not fetched implicitly.

## Exact commands (no credentials shown; run only after approval)

```bash
cd /root/gaia-membership-staging-src/membership-service
# 0. owner adds to /root/.config/gaia-membership-staging.env:  STRIPE_TEST_SECRET_KEY=rk_test_…  EXPECTED_STRIPE_ACCOUNT_ID=acct_…
P='node src/cli/staging-standard-pilot.js'; E='set -a; . /root/.config/gaia-membership-staging.env; set +a'
bash -c "$E; $P plan"                                     # sends nothing; prints the counts, budget left, account settings
# 1. listener (after approval to pull):
docker pull stripe/stripe-cli:v1.53.1 && docker image inspect stripe/stripe-cli:v1.53.1 --format '{{index .RepoDigests 0}}'   # record the digest
bash -c "$E; $P listener --run"                           # books the 3-request CLI reserve
scripts/stripe-cli-listener.sh start                      # captures the webhook secret into the env file (not shown)
bash -c "$E; nohup node src/cli/staging-webhook-server.js >/var/log/gaia-staging-webhooks.log 2>&1 &"   # loopback receiver, staging DB only
# 2. account check and checkout
bash -c "$E; $P whoami --run"                             # 1 request; must match EXPECTED_STRIPE_ACCOUNT_ID
bash -c "$E; $P start --run"                              # 6 requests; prints the Checkout URL
#    tester: open the URL, pay with 4242 4242 4242 4242, any future expiry, any CVC
bash -c "$E; $P status"                                   # 0 requests; wait until the subscription shows active
# 3. verify and cancel
bash -c "$E; $P verify --run"                             # 4 requests; activation, $47 charge, 500 coins, entitlements, 0 mismatches
bash -c "$E; $P cancel --run"                             # 1 request; cancel at period end, access-end date printed
bash -c "$E; $P status"                                   # cancel date set, access still on
# 4. tear down
scripts/stripe-cli-listener.sh stop; pkill -f staging-webhook-server.js; scripts/stripe-cli-listener.sh remove-image
```

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
