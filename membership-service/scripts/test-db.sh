#!/bin/sh
# Throwaway PostgreSQL for the membership tests: loopback only, data in tmpfs,
# removed on "down". Never point the tests at a real database.
set -e
NAME=gaia-membership-testdb
PORT=${MEMBERSHIP_TEST_PG_PORT:-55432}
case "$1" in
  up)
    docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:5432" --tmpfs /var/lib/postgresql/data \
      -e POSTGRES_USER=membership_test -e POSTGRES_PASSWORD=membership_test -e POSTGRES_DB=membership_test \
      postgres:16-alpine >/dev/null
    i=0; until docker exec "$NAME" pg_isready -U membership_test -d membership_test >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && exit 1; sleep 0.5; done
    echo "export MEMBERSHIP_TEST_DATABASE_URL=postgres://membership_test:membership_test@127.0.0.1:$PORT/membership_test" ;;
  down) docker rm -f "$NAME" >/dev/null 2>&1 || true ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
