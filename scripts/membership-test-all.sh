#!/usr/bin/env bash
# Membership 2.0: run every test suite once, against a throwaway Postgres, and
# write a machine-readable summary.
#
#   scripts/membership-test-all.sh [--branches] [--view-ref REF] [--logs DIR] SUMMARY.json
#
# What it does:
#   1. starts postgres:16-alpine (`--pull=never`: the image must already be local)
#      on a free 127.0.0.1 port, data in tmpfs, random password, removed on exit;
#   2. membership-service: `npm ci --offline` + `npm test` (serial, real Postgres);
#   3. staging-proxy:      `npm ci --offline` + `npm test`;
#   4. frontend:           `node --test tests/*.test.cjs` (repo root);
#   5. with --branches: the same three suites on REF (default
#      origin/feat/membership2-view) in a temporary `git worktree`, removed afterwards;
#   6. writes SUMMARY.json: [{suite, ref, commit, pass, fail, skipped, todo, tests,
#      durationMs, exitCode, log}] plus an overall `ok`.
#
# Network: loopback only. No `docker pull`, no `git fetch`, `npm ci --offline`
# (packages from the local npm cache). Every node process, child processes
# included, loads scripts/membership-test-offline.mjs through NODE_OPTIONS:
# a non-loopback name or address fails as ENOTFOUND, under the suites' own
# network denies. GAIA_LIVE_TESTS is unset, so the proxy's live checks skip.
# Fetch the view branch yourself first if you want it current.
#
# Exit: 0 all suites passed, 1 a suite failed, 2 usage / setup error.
set -Eeuo pipefail

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

BRANCHES=0
VIEW_REF=origin/feat/membership2-view
SUMMARY=""
LOGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --branches) BRANCHES=1 ;;
    --view-ref) VIEW_REF=${2:?}; shift ;;
    --logs) LOGS=${2:?}; shift ;;
    --summary) SUMMARY=${2:?}; shift ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) [ -z "$SUMMARY" ] || usage; SUMMARY=$1 ;;
  esac
  shift
done
[ -n "$SUMMARY" ] || usage

REPO=$(cd "$(dirname "$0")/.." && pwd)
command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }
command -v node >/dev/null || { echo "node is required" >&2; exit 2; }
docker image inspect postgres:16-alpine >/dev/null 2>&1 || { echo "postgres:16-alpine is not present locally (this script never pulls)" >&2; exit 2; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/m2-test-all.XXXXXX")
[ -n "$LOGS" ] || LOGS="$WORK/logs"
mkdir -p "$LOGS"
RESULTS="$WORK/results.tsv"
: > "$RESULTS"
NAME="gaia-m2-testall-$$-$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
VIEW_WT=""

cleanup() {
  local rc=$?
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ -n "$VIEW_WT" ] && [ -d "$VIEW_WT" ]; then
    git -C "$REPO" worktree remove --force "$VIEW_WT" >/dev/null 2>&1 || rm -rf "$VIEW_WT"
    git -C "$REPO" worktree prune >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK/results.tsv" "$WORK/view"
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# A free loopback port and a random password (never printed).
PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')
PW=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')

echo "== postgres:16-alpine on 127.0.0.1:$PORT (container $NAME)"
docker run -d --rm --pull=never --name "$NAME" -p "127.0.0.1:$PORT:5432" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=membership_test -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=membership_test \
  postgres:16-alpine >/dev/null
# -h 127.0.0.1: the image's init-time server listens on the unix socket only, so TCP ready = the real server.
i=0
until docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U membership_test -d membership_test 2>/dev/null; do
  i=$((i + 1)); [ $i -le 120 ] || { echo "postgres did not start" >&2; exit 2; }; sleep 0.5
done
export MEMBERSHIP_TEST_DATABASE_URL="postgres://membership_test:$PW@127.0.0.1:$PORT/membership_test"
unset GAIA_LIVE_TESTS CI
DENY="$REPO/scripts/membership-test-offline.mjs"

# run_suite <suite> <ref-label> <dir> <deny-file> <cmd...>
run_suite() {
  local suite=$1 ref=$2 dir=$3 deny=$4; shift 4
  local log="$LOGS/${suite//[:\/]/_}.log" t0 t1 rc commit
  commit=$(git -C "$dir" rev-parse HEAD)
  if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no 2>/dev/null)" ]; then commit="$commit+dirty"; fi
  echo "== $suite ($ref @ ${commit:0:12})"
  t0=$(date +%s%3N)
  set +e
  ( cd "$dir" && NODE_OPTIONS="--import=$deny" "$@" ) >"$log" 2>&1
  rc=$?
  set -e
  t1=$(date +%s%3N)
  # TAP (non-TTY default) "# pass N" or spec "ℹ pass N"; the last value wins.
  num() { grep -E "^(# |ℹ )$1 [0-9]+$" "$log" | tail -1 | grep -oE '[0-9]+$' || echo 0; }
  local tests pass fail skipped todo
  tests=$(num tests); pass=$(num pass); fail=$(num fail); skipped=$(num skipped); todo=$(num todo)
  # A suite that crashed before reporting counts as failed.
  if [ "$rc" -ne 0 ] && [ "$fail" -eq 0 ]; then fail=1; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$suite" "$ref" "$commit" "$pass" "$fail" "$skipped" "$todo" "$tests" "$((t1 - t0))" "$rc" "$log" >>"$RESULTS"
  printf '   pass %s  fail %s  skipped %s  (%s ms, exit %s)\n' "$pass" "$fail" "$skipped" "$((t1 - t0))" "$rc"
}

# run_all <prefix> <ref-label> <root>
run_all() {
  local prefix=$1 ref=$2 root=$3
  local deny=$DENY
  ( cd "$root/membership-service" && npm ci --offline --no-audit --no-fund --loglevel=error >"$LOGS/${prefix}npm-membership.log" 2>&1 ) \
    || { echo "npm ci (membership-service) failed; see $LOGS/${prefix}npm-membership.log" >&2; exit 2; }
  run_suite "${prefix}membership-service" "$ref" "$root/membership-service" "$deny" npm test --silent
  ( cd "$root/staging-proxy" && npm ci --offline --no-audit --no-fund --loglevel=error >"$LOGS/${prefix}npm-proxy.log" 2>&1 ) \
    || { echo "npm ci (staging-proxy) failed; see $LOGS/${prefix}npm-proxy.log" >&2; exit 2; }
  run_suite "${prefix}staging-proxy" "$ref" "$root/staging-proxy" "$deny" npm test --silent
  # shellcheck disable=SC2086
  run_suite "${prefix}frontend" "$ref" "$root" "$deny" bash -c 'node --test tests/*.test.cjs'
}

HEAD_REF=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
run_all "" "$HEAD_REF" "$REPO"

if [ "$BRANCHES" -eq 1 ]; then
  git -C "$REPO" rev-parse --verify --quiet "$VIEW_REF^{commit}" >/dev/null || { echo "ref $VIEW_REF not found (fetch it first; this script never fetches)" >&2; exit 2; }
  VIEW_WT="$WORK/view"
  git -C "$REPO" worktree add --detach "$VIEW_WT" "$VIEW_REF" >/dev/null 2>&1
  run_all "view:" "$VIEW_REF" "$VIEW_WT"
fi

mkdir -p "$(dirname "$SUMMARY")"
node - "$RESULTS" "$SUMMARY" <<'NODE'
const fs = require('fs');
const [file, out] = process.argv.slice(2);
const suites = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
  const [suite, ref, commit, pass, fail, skipped, todo, tests, durationMs, exitCode, log] = l.split('\t');
  return { suite, ref, commit, pass: +pass, fail: +fail, skipped: +skipped, todo: +todo, tests: +tests, durationMs: +durationMs, exitCode: +exitCode, log };
});
const total = suites.reduce((a, s) => ({ pass: a.pass + s.pass, fail: a.fail + s.fail, skipped: a.skipped + s.skipped }), { pass: 0, fail: 0, skipped: 0 });
const doc = { generatedAt: new Date().toISOString(), ok: suites.every((s) => s.exitCode === 0 && s.fail === 0), total, suites };
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`== summary: ${out}  ok=${doc.ok}  pass ${total.pass}  fail ${total.fail}  skipped ${total.skipped}`);
process.exitCode = doc.ok ? 0 : 1;
NODE
