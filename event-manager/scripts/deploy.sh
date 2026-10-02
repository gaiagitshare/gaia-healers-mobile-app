#!/usr/bin/env bash
#
# Build, test, ship, and RECORD the Event Manager.
#
# The last step is why this exists. /root/event is a git repository with no
# remote, so committing here keeps no copy anywhere: on 1 October the running
# backend was 717 lines ahead of GitHub and this VPS held the only copy of the
# difference, which had to be reconstructed by hand into a sync PR. Deploying and
# recording came apart because they were two separate acts and only one of them
# was in anybody's habit. Now they are one command.
#
# Usage:
#   scripts/deploy.sh                 test, build, ship, record
#   scripts/deploy.sh --fast          skip the suites — for the event floor only
#   scripts/deploy.sh --no-mirror     ship without touching GitHub
#   scripts/deploy.sh --dry-run       say what it would do, change nothing
#   scripts/deploy.sh --mirror-only   record what is already live, ship nothing
#
set -euo pipefail

EVENT_DIR=/root/event
BACKEND="$EVENT_DIR/backend"
FRONTEND="$EVENT_DIR/frontend"
WEBROOT=/var/www/event
SERVICE=gaia-event-manager.service
MIRROR=/root/gaia-healers-mobile-app-1
MIRROR_SUB=event-manager
TOKEN_FILE=/root/.gh-token
BACKUP_DIR="$EVENT_DIR/_backups"

FAST=0 MIRROR_ON=1 DRY=0 MIRROR_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --fast)      FAST=1 ;;
    --no-mirror) MIRROR_ON=0 ;;
    --dry-run)   DRY=1 ;;
    --mirror-only) MIRROR_ONLY=1; FAST=1 ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '   \033[33mwarn\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mSTOPPED\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '   would run: %s\n' "$*"; else "$@"; fi; }

[ "$(id -u)" = 0 ] || die "run as root; the service and the web root need it"
[ -d "$BACKEND" ] || die "no backend at $BACKEND"

if [ "$MIRROR_ONLY" = 1 ]; then
  say "Recording only — nothing will be built, shipped or restarted"
fi

# ── 1. the suites ──────────────────────────────────────────────────────────
# The gate, not a formality: these read a copy of the live database, and that is
# what has caught the bugs that mattered — a duplicate-payment report that had
# gone blind, two upgrades on sale that removed access somebody had paid for, a
# booking the door could not see. An empty fixture would have passed all three,
# which is also why they cannot run in CI.
if [ "$FAST" = 1 ]; then
  [ "$MIRROR_ONLY" = 1 ] || warn "SKIPPING the test suites (--fast). Only do this with a queue in front of you."
  TEST_NOTE=" [--fast: suites not run]"
else
  say "Running the suites (about 12 minutes; they run one at a time on purpose,"
  echo "   because two suites rebinding the ORM at once report failures neither has alone)"
  FAILED=""
  PASSED=0
  if [ "$DRY" = 1 ]; then
    echo "   would run: $(cd "$BACKEND" && ls test_*.py | wc -l) suites"
  else
    cd "$BACKEND"
    for t in test_*.py; do
      if timeout 600 python3 "$t" >"/tmp/deploy-${t%.py}.log" 2>&1; then
        PASSED=$((PASSED + 1))
      else
        FAILED="$FAILED $t"
      fi
    done
    if [ -n "$FAILED" ]; then
      printf '\n'
      for t in $FAILED; do
        echo "   FAILED: $t   (/tmp/deploy-${t%.py}.log)"
        grep -E "^  FAIL |^FAILED" "/tmp/deploy-${t%.py}.log" | head -3 | sed 's/^/      /'
      done
      die "$(echo "$FAILED" | wc -w) suite(s) failed. Nothing was deployed."
    fi
    ok "$PASSED suites green"
  fi
  TEST_NOTE=""
fi

# ── 2. a copy of the database before anything restarts ─────────────────────
if [ "$MIRROR_ONLY" = 0 ]; then
say "Backing up the database"
STAMP=$(date +%Y%m%d-%H%M%S)
run mkdir -p "$BACKUP_DIR"
run cp "$BACKEND/event.db" "$BACKUP_DIR/event.db.pre-deploy-$STAMP"
ok "$BACKUP_DIR/event.db.pre-deploy-$STAMP"
fi

# ── 3. build the panel ─────────────────────────────────────────────────────
if [ "$MIRROR_ONLY" = 0 ]; then
# CI=false because the repo carries known warnings and react-scripts treats them
# as errors otherwise. A real failure still exits non-zero and stops here.
say "Building the admin panel"
if [ "$DRY" = 1 ]; then
  echo "   would run: CI=false npm run build  (in $FRONTEND)"
else
  cd "$FRONTEND"
  CI=false npm run build >/tmp/deploy-build.log 2>&1 \
    || { tail -25 /tmp/deploy-build.log; die "the panel did not build. Nothing was deployed."; }
  ok "$(grep -oE 'main\.[a-f0-9]+\.js' /tmp/deploy-build.log | head -1)"
fi
fi

# ── 4. ship ────────────────────────────────────────────────────────────────
if [ "$MIRROR_ONLY" = 0 ]; then
say "Shipping"
run rsync -a --delete "$FRONTEND/build/" "$WEBROOT/"
ok "panel -> $WEBROOT"
run systemctl restart "$SERVICE"

if [ "$DRY" = 0 ]; then
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8002/docs || true)
    [ "$code" = "200" ] && break
    sleep 1
  done
  [ "${code:-}" = "200" ] || die "the backend did not come back (/docs returned ${code:-no answer}). Panel is already live; roll back with: git -C $EVENT_DIR revert HEAD && $0 --fast"
  ok "backend answering, service $(systemctl is-active "$SERVICE")"
fi
fi

# ── 5. record it here ──────────────────────────────────────────────────────
say "Recording the deploy"
cd "$EVENT_DIR"
DIRTY=$(git status --porcelain -- backend frontend/src docs 2>/dev/null \
  | grep -E '\.(py|js|jsx|css|html|md|json)$' | grep -vE '__pycache__' || true)
if [ -n "$DIRTY" ]; then
  warn "there are uncommitted changes in /root/event — commit them yourself so the"
  warn "message says what changed; this script will not write that message for you."
  echo "$DIRTY" | head -10 | sed 's/^/      /'
else
  ok "nothing uncommitted here"
fi
LOCAL_SHA=$(git rev-parse --short HEAD)
LOCAL_SUBJ=$(git log -1 --format=%s)
ok "$LOCAL_SHA  $LOCAL_SUBJ"

# ── 6. and record it somewhere that is not this machine ────────────────────
if [ "$MIRROR_ON" = 0 ]; then
  warn "--no-mirror: GitHub will not be told. This box is again the only copy."
  exit 0
fi
[ -d "$MIRROR/.git" ] || die "no mirror checkout at $MIRROR"
[ -r "$TOKEN_FILE" ] || die "no GitHub token at $TOKEN_FILE"

say "Mirroring to GitHub"
cd "$MIRROR"
if [ -n "$(git status --porcelain)" ]; then
  warn "the mirror has uncommitted changes — another session may be working in it."
  git status --short | head -8 | sed 's/^/      /'
  die "left alone rather than committing on top of somebody else's work"
fi

# Credentials go to git through an askpass helper, never on a command line.
# Putting them in `git -c credential.helper=...` leaks the token into `ps`, into
# this script's own dry-run output, and into anybody's shell history -- which is
# exactly how it happened once already.
ASKPASS=$(mktemp /tmp/gh-askpass-XXXXXX)
chmod 700 "$ASKPASS"
cat > "$ASKPASS" <<'ASK'
#!/usr/bin/env bash
case "$1" in
  *Username*) echo "x-access-token" ;;
  *)          cat /root/.gh-token ;;
esac
ASK
trap 'rm -f "$ASKPASS"' EXIT
export GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0

run git fetch origin --quiet
run git checkout -q main
run git pull -q --ff-only origin main

# Only real sources, chosen by what a filename ENDS in. This repository carries
# ~65 editor backups with names like main.py.precoursehard.20260828-212842 and
# models.py.presep.20260828-135820: excluding them by listing the suffixes people
# have used is a losing game, because the next one will have a new suffix. A file
# is a source if it ends in a source extension, and a dated backup never does.
SOURCE_RE='\.(py|js|jsx|css|html|md|json|txt|svg|png|ico|woff2?|sh)$'
if [ "$DRY" = 0 ]; then
  cd "$EVENT_DIR"
  FILES=$(git ls-files -- backend frontend/src frontend/public docs scripts \
    | grep -E "$SOURCE_RE" | grep -vE '__pycache__' || true)
  [ -n "$FILES" ] || die "found no source files to mirror, which cannot be right"
  COUNT=0
  for f in $FILES; do
    dest="$MIRROR/$MIRROR_SUB/$f"
    mkdir -p "$(dirname "$dest")"
    if ! cmp -s "$EVENT_DIR/$f" "$dest" 2>/dev/null; then
      cp "$EVENT_DIR/$f" "$dest"
      COUNT=$((COUNT + 1))
    fi
  done
  ok "$COUNT file(s) differed and were copied"

  cd "$MIRROR"
  git add -A "$MIRROR_SUB"
  if git diff --cached --quiet; then
    ok "GitHub already matches what is running — nothing to push"
    exit 0
  fi
  git diff --cached --stat | tail -5 | sed 's/^/      /'
  git commit -q -F - <<MSG
Event Manager: $LOCAL_SUBJ

Mirrored by scripts/deploy.sh from /root/event $LOCAL_SHA, which has no remote of
its own. This is the deployed state of the Event Manager, recorded at the moment
it went live rather than reconstructed afterwards.$TEST_NOTE

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
  # Fast-forward only. If main has moved under us, keep the commit on a branch
  # and say so: a deploy script must never be the thing that rewrites shared
  # history, and another session works in this repository.
  if git push --quiet origin main 2>/dev/null; then
    ok "pushed to main: $(git rev-parse --short HEAD)"
  else
    BR="sync/deploy-$STAMP"
    git branch -q "$BR"
    git push --quiet -u origin "$BR"
    git reset -q --hard origin/main
    warn "main had moved, so this is on branch $BR instead of main."
    warn "open a PR: https://github.com/gaiagitshare/gaia-healers-mobile-app/compare/$BR?expand=1"
  fi
else
  echo "   would copy changed sources into $MIRROR/$MIRROR_SUB and push to main"
fi

say "Done"
