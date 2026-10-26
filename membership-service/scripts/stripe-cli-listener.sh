#!/bin/bash
# Stripe CLI listener for the STAGING sandbox, in a throwaway isolated container.
#   validate   - check the exact flags with an image already on this host (sends nothing anywhere) and prove
#                that the Stripe image is never pulled implicitly
#   start      - (needs the approved, already-pulled image) run `stripe listen`, capture the webhook secret
#                into the staging env file WITHOUT printing it, forward events to the loopback receiver
#   stop       - stop the container (it removes itself: --rm)
#   remove-image - delete the image afterwards
# Nothing is installed on the host. The key is read from the 0600 staging env file and handed to the
# container as STRIPE_API_KEY through an anonymous pipe (never on the command line, never printed).
set -euo pipefail
IMAGE=${STRIPE_CLI_IMAGE:-stripe/stripe-cli:v1.53.1}           # pinned release (7 Oct 2026); never :latest
ENVF=/root/.config/gaia-membership-staging.env
NAME=gaia-stripe-cli
FORWARD=http://127.0.0.1:8791/v1/webhooks/stripe
EVENTS=customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed
ISOLATION=(--rm --network host --pull=never --read-only --tmpfs /tmp:rw,size=16m --tmpfs /root:rw,size=4m
           --cap-drop ALL --security-opt no-new-privileges --memory 128m --pids-limit 64 --label gaia.purpose=stripe-cli-staging)
case "$IMAGE" in *:latest|*:) echo "REFUSED: pin a release tag" >&2; exit 2;; esac
key_env() { grep '^STRIPE_TEST_SECRET_KEY=' "$ENVF" | sed 's/^STRIPE_TEST_SECRET_KEY=/STRIPE_API_KEY=/'; }

case "${1:-}" in
  validate)
    docker run "${ISOLATION[@]}" --name ${NAME}-validate --entrypoint sh postgres:16-alpine -c \
      'touch /x 2>/dev/null && echo "rootfs WRITABLE (bad)" || echo "rootfs read-only: ok"; touch /tmp/t && echo "tmpfs /tmp: ok"; [ -z "$(ls /run/secrets 2>/dev/null)" ] && echo "no host mounts: ok"; grep -q "CapEff:\s*0000000000000000" /proc/self/status && echo "capabilities dropped: ok"'
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then echo "image $IMAGE is present"; else
      docker run "${ISOLATION[@]}" --name ${NAME}-nopull "$IMAGE" version >/dev/null 2>&1 && echo "UNEXPECTED: ran without image" || echo "image $IMAGE absent and --pull=never refused to fetch it: ok (pull only after approval)"; fi
    grep -q '^STRIPE_TEST_SECRET_KEY=rk_test_\|^STRIPE_TEST_SECRET_KEY=sk_test_' "$ENVF" && echo "test key present in env file" || echo "test key NOT yet in env file"
    ;;
  start)
    grep -q '^STRIPE_TEST_SECRET_KEY=[rs]k_test_' "$ENVF" || { echo "REFUSED: no test-mode key in $ENVF" >&2; exit 2; }
    docker image inspect "$IMAGE" >/dev/null || { echo "REFUSED: image not pulled (pull it only after approval)" >&2; exit 2; }
    docker run -d "${ISOLATION[@]}" --name $NAME --env-file <(key_env) "$IMAGE" listen --forward-to "$FORWARD" --events "$EVENTS" >/dev/null
    for i in $(seq 30); do docker logs $NAME 2>&1 | grep -q 'whsec_' && break; sleep 1; done
    SECRET=$(docker logs $NAME 2>&1 | grep -o 'whsec_[A-Za-z0-9]*' | head -1)
    [ -n "$SECRET" ] || { echo "listener did not report a webhook secret; logs (secrets masked):" >&2; docker logs $NAME 2>&1 | sed -E 's/(whsec|sk|rk)_[A-Za-z0-9_]+/\1_***/g' | tail -5 >&2; docker stop $NAME >/dev/null; exit 1; }
    umask 077; grep -v '^STRIPE_TEST_WEBHOOK_SECRET=' "$ENVF" > "$ENVF.tmp"; echo "STRIPE_TEST_WEBHOOK_SECRET=$SECRET" >> "$ENVF.tmp"; mv "$ENVF.tmp" "$ENVF"; chmod 600 "$ENVF"
    echo "listener running ($NAME); webhook secret written to the staging env file (not shown); forwarding to $FORWARD"
    ;;
  stop) docker stop $NAME >/dev/null 2>&1 && echo "listener stopped" || echo "listener not running" ;;
  remove-image) docker rmi "$IMAGE" ;;
  *) echo "usage: $0 validate|start|stop|remove-image" >&2; exit 2 ;;
esac
